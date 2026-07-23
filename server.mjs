import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAlerter } from './alerts.mjs';
import { createHeartbeats } from './heartbeats.mjs';
import { checkCertificate, checkDomainExpiry, evaluateBody, resolveHost } from './probes.mjs';
import { createUptimeStore } from './uptime.mjs';
import { renderMetrics, renderBadge, renderFeed, countIncidents } from './observability.mjs';
import { createUsageMonitor } from './usage.mjs';

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || './data';
const historyFile = join(dataDir, 'history.json');
const agentsFile = join(dataDir, 'agents.json');
const intervalMs = Math.max(15, Number(process.env.CHECK_INTERVAL_SECONDS || 60)) * 1000;
const dockerApiUrl = process.env.DOCKER_API_URL || '';
const certWarnDays = Number(process.env.CERT_WARN_DAYS || 21);
const domainWarnDays = Number(process.env.DOMAIN_WARN_DAYS || 30);
const certIntervalMs = Math.max(1, Number(process.env.CERT_CHECK_INTERVAL_HOURS || 6)) * 3600 * 1000;
const heartbeatToken = process.env.HEARTBEAT_TOKEN || process.env.AGENT_INGEST_TOKEN || '';
const externalHeartbeatUrl = process.env.EXTERNAL_HEARTBEAT_URL || '';
const maintenanceWindows = parseJson(process.env.MAINTENANCE_JSON, []);
const publicOrigin = process.env.PUBLIC_ORIGIN || 'https://status.skyhong.tw';
const maxHistoryPoints = 24 * 60;

function activeMaintenance(now = Date.now()) {
  return (Array.isArray(maintenanceWindows) ? maintenanceWindows : []).find((window) => {
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    return Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end;
  }) || null;
}

const rateHits = new Map();
function rateLimited(key, limit = 120, windowMs = 60_000) {
  const now = Date.now();
  const hits = (rateHits.get(key) || []).filter((t) => t > now - windowMs);
  hits.push(now);
  rateHits.set(key, hits);
  if (rateHits.size > 5_000) for (const [k, v] of rateHits) if (!v.some((t) => t > now - windowMs)) rateHits.delete(k);
  return hits.length > limit;
}

const targets = parseJson(process.env.STATUS_TARGETS_JSON, [
  { id: 'skyhong-tw', name: 'skyhong.tw', group: 'Products', url: 'https://skyhong.tw' },
  { id: 'youtube-board-tw', name: 'youtube.board.tw', group: 'Products', url: 'https://youtube.board.tw', acceptedStatuses: [200, 301, 302, 307, 308, 403] },
  { id: 'harmonica-observe', name: 'harmonica.observe.tw', group: 'Products', url: 'https://harmonica.observe.tw' },
  { id: 'youtube-observe', name: 'youtube.observe.tw', group: 'Products', url: 'https://youtube.observe.tw' },
  { id: 'plaud-skyhong', name: 'plaud.observe.tw', group: 'Products', url: 'https://plaud.observe.tw', acceptedStatuses: [200, 301, 302, 307, 308, 401] },
  { id: 'mayor2026-observe', name: 'mayor2026.observe.tw', group: 'Products', url: 'https://mayor2026.observe.tw' },
  { id: 'infovore', name: 'Infovore', group: 'Products', url: 'https://infovore.skyhong.tw' },
  { id: 'n8n', name: 'n8n automations', group: 'Operations', url: 'https://n8n.skyhong.tw' },
  { id: 'freshrss', name: 'FreshRSS', group: 'Operations', url: 'https://rss.skyhong.tw' },
]);
const state = { checkedAt: null, targets: [], services: [], certificates: [], domains: [], heartbeats: [], agents: {}, aiUsage: [], errors: [], history: {}, uptime: {}, maintenance: null, thresholds: { certWarnDays, domainWarnDays } };
const usageMonitor = await createUsageMonitor({ dataDir });
const alerter = await createAlerter({ dataDir });
const heartbeats = await createHeartbeats({ dataDir });
const uptimeStore = await createUptimeStore({ dataDir });
const publicAssets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8', 'no-store'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8', 'public, max-age=3600'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8', 'public, max-age=3600'],
  ['/status-mark.svg', 'status-mark.svg', 'image/svg+xml', 'public, max-age=86400'],
].map(async ([path, file, contentType, cacheControl]) => [path, {
  body: await readFile(new URL(`./public/${file}`, import.meta.url)), contentType, cacheControl,
}])));

// Fingerprint the cached assets and rewrite the (uncached) index so a deploy reaches
// browsers immediately instead of after the asset max-age expires.
{
  const version = (path) => createHash('sha1').update(publicAssets.get(path).body).digest('hex').slice(0, 8);
  const index = publicAssets.get('/');
  index.body = Buffer.from(index.body.toString('utf8')
    .replace('/styles.css', `/styles.css?v=${version('/styles.css')}`)
    .replace('/app.js', `/app.js?v=${version('/app.js')}`));
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function elapsed(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function checkTarget(target) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs || 12_000);
  try {
    const response = await fetch(target.url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const accepted = target.acceptedStatuses || [];
    let up = accepted.length ? accepted.includes(response.status) : response.status >= 200 && response.status < 400;
    let detail = response.statusText || 'Reachable';
    if (target.keyword || target.keywordAbsent) {
      const body = await response.text();
      const bodyCheck = evaluateBody(body, target);
      if (!bodyCheck.ok) {
        up = false;
        detail = bodyCheck.reason;
      }
    }
    const latencyMs = Date.now() - startedAt;
    let degraded = false;
    let degradedReason = null;
    if (up && target.latencyThresholdMs != null && latencyMs > target.latencyThresholdMs) {
      degraded = true;
      degradedReason = `Slow: ${latencyMs}ms > ${target.latencyThresholdMs}ms`;
    }
    return { ...target, up, statusCode: response.status, latencyMs, detail, degraded, degradedReason };
  } catch (error) {
    let detail = error.name === 'AbortError' ? 'Timed out' : 'Unreachable';
    try {
      const dnsResult = await resolveHost(new URL(target.url).hostname);
      if (!dnsResult.ok) detail = 'DNS resolution failed';
    } catch {}
    return { ...target, up: false, statusCode: null, latencyMs: Date.now() - startedAt, detail, degraded: false, degradedReason: null };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshCertificates() {
  try {
    const hostnames = [...new Set(targets
      .map((target) => new URL(target.url))
      .filter((url) => url.protocol === 'https:')
      .map((url) => url.hostname))];
    const registrableDomains = [...new Set(hostnames.map((hostname) => hostname.split('.').slice(-2).join('.')))];
    const [certificates, domains] = await Promise.all([
      Promise.all(hostnames.map(async (host) => ({ host, ...await checkCertificate(host) }))),
      Promise.all(registrableDomains.map(async (domain) => ({ domain, ...await checkDomainExpiry(domain) }))),
    ]);
    state.certificates = certificates;
    state.domains = domains;
  } catch {}
}

async function dockerRequest(path) {
  if (!dockerApiUrl) return null;
  const response = await fetch(`${dockerApiUrl}${path}`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Docker API returned ${response.status}`);
  return response.json();
}

async function getDockerServices() {
  if (!dockerApiUrl) return [];
  const [services, tasks, containers] = await Promise.all([
    dockerRequest('/services'), dockerRequest('/tasks'), dockerRequest('/containers/json?all=1'),
  ]);
  const swarm = (services || []).map((service) => {
    const relevantTasks = (tasks || []).filter((task) => task.ServiceID === service.ID);
    const activeTasks = relevantTasks.filter((task) => task.DesiredState === 'running');
    const desired = service.Spec?.Mode?.Replicated?.Replicas ?? 1;
    const running = activeTasks.filter((task) => task.Status?.State === 'running').length;
    const failed = activeTasks.filter((task) => ['failed', 'rejected'].includes(task.Status?.State)).length;
    return {
      id: service.ID,
      name: service.Spec?.Name || service.ID.slice(0, 12),
      kind: 'Swarm service',
      up: running >= desired && failed === 0,
      detail: `${running}/${desired} running${failed ? `, ${failed} failed` : ''}`,
    };
  });
  const standalone = await Promise.all((containers || [])
    .filter((container) => !container.Labels?.['com.docker.swarm.service.name'])
    .map(async (container) => {
      const name = container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12);
      let restarts = 0;
      let oomKilled = false;
      let restarting = container.State === 'restarting';
      try {
        const inspect = await dockerRequest(`/containers/${container.Id}/json`);
        restarts = inspect?.RestartCount ?? 0;
        oomKilled = Boolean(inspect?.State?.OOMKilled);
        restarting = Boolean(inspect?.State?.Restarting) || restarting;
      } catch {}
      const unhealthy = Boolean(container.Status?.includes('(unhealthy)'));
      const up = container.State === 'running' && !unhealthy && !restarting && !oomKilled;
      let detail = container.Status || container.State;
      if (oomKilled) detail = `OOMKilled · ${detail}`;
      else if (restarting) detail = `Restarting · ${detail}`;
      if (restarts > 0) detail += ` · ${restarts} restarts`;
      return { id: container.Id, name, kind: 'Container', up, detail };
    }));
  return [...swarm, ...standalone].sort((a, b) => a.name.localeCompare(b.name));
}

async function getAiUsage() {
  return usageMonitor ? [usageMonitor.summary()] : [];
}

async function loadHistory() {
  try { state.history = JSON.parse(await readFile(historyFile, 'utf8')); } catch { state.history = {}; }
  try { state.agents = JSON.parse(await readFile(agentsFile, 'utf8')); } catch { state.agents = {}; }
}

async function saveHistory() {
  await mkdir(dataDir, { recursive: true });
  await saveJson(historyFile, state.history);
}

async function saveJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value), 'utf8');
  await rename(temporary, file);
}

function recordHistory(items) {
  const now = Date.now();
  for (const item of items) {
    const points = state.history[item.id] || [];
    points.push({ t: now, up: item.up });
    state.history[item.id] = points.filter((point) => point.t > now - 24 * 60 * 60 * 1000).slice(-maxHistoryPoints);
  }
}

async function refresh() {
  const errors = [];
  const checkedTargets = await Promise.all(targets.map(checkTarget));
  let services = [];
  try { services = await getDockerServices(); } catch (error) { errors.push('Docker status temporarily unavailable'); }
  let aiUsage = [];
  try { aiUsage = await getAiUsage(); } catch (error) { errors.push('AI usage collection temporarily unavailable'); }
  state.checkedAt = new Date().toISOString();
  state.targets = checkedTargets;
  state.services = services;
  state.aiUsage = aiUsage;
  state.errors = errors;
  const heartbeatItems = heartbeats.items();
  state.heartbeats = heartbeatItems;
  const historyItems = [...checkedTargets, ...services, ...heartbeatItems, ...remoteItems()];
  recordHistory([...checkedTargets, ...services, ...heartbeatItems]);
  try { uptimeStore.record(historyItems); state.uptime = uptimeStore.summary(historyItems.map((item) => item.id)); } catch {}
  const alertItems = [
    ...checkedTargets.map((t) => ({ id: `target:${t.id}`, name: t.name, up: t.up, detail: t.statusCode ? `HTTP ${t.statusCode} · ${t.detail}` : t.detail })),
    ...services.map((s) => ({ id: `runtime:${s.name}`, name: s.name, up: s.up, detail: s.detail })),
    ...remoteItems().map((r) => ({ id: `remote:${r.id}`, name: r.name, up: r.up, detail: r.detail })),
    ...heartbeatItems.map((h) => ({ id: `heartbeat:${h.id}`, name: `${h.name} · heartbeat`, up: h.up, detail: h.detail })),
    // Only alert on a real, known expiry crossing the threshold — never on a check failure/timeout (avoids false incidents).
    ...state.certificates.filter((c) => c.ok && c.daysRemaining != null).map((c) => ({ id: `cert:${c.host}`, name: `${c.host} · TLS certificate`, up: c.daysRemaining > certWarnDays, detail: `valid ${c.daysRemaining}d · ${c.issuer || 'cert'}` })),
    ...state.domains.filter((d) => d.ok && d.daysRemaining != null).map((d) => ({ id: `domain:${d.domain}`, name: `${d.domain} · domain registration`, up: d.daysRemaining > domainWarnDays, detail: `expires in ${d.daysRemaining}d` })),
  ];
  if (aiUsage[0]) alertItems.push({ id: 'openai-sync', name: 'OpenAI usage collection', up: aiUsage[0].connected !== false, detail: aiUsage[0].detail || '' });
  state.maintenance = activeMaintenance();
  if (!state.maintenance) { try { await alerter.evaluate(alertItems); } catch {} }
  await saveHistory();
  if (externalHeartbeatUrl) {
    try { void fetch(externalHeartbeatUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {}); } catch {}
  }
}

function agentAuthorized(request) {
  const token = process.env.AGENT_INGEST_TOKEN;
  return Boolean(token) && request.headers.authorization === `Bearer ${token}`;
}

function remoteItems() {
  const now = Date.now();
  return Object.entries(state.agents).flatMap(([agentId, agent]) => {
    const stale = !agent.receivedAt || now - new Date(agent.receivedAt).getTime() > intervalMs * 3;
    return (agent.items || []).map((item) => ({
      ...item,
      id: `${agentId}:${item.id}`,
      name: `${agent.host || agentId} · ${item.name}`,
      up: stale ? false : Boolean(item.up),
      detail: stale ? 'Agent has not checked in' : item.detail,
      kind: `Remote host${item.kind ? ` · ${item.kind}` : ''}`,
      receivedAt: agent.receivedAt,
    }));
  });
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
    });
    request.on('error', reject);
  });
}

async function ingestAgent(request, response, agentId) {
  if (!agentAuthorized(request)) {
    response.writeHead(401);
    response.end('Invalid agent token');
    return;
  }
  try {
    const payload = await readRequest(request);
    if (!Array.isArray(payload.items) || payload.items.length > 100 || typeof payload.host !== 'string') throw new Error('Invalid agent payload');
    state.agents[agentId] = { host: payload.host.slice(0, 80), receivedAt: new Date().toISOString(), items: payload.items.map((item) => ({
      id: String(item.id || '').slice(0, 80), name: String(item.name || '').slice(0, 120), kind: String(item.kind || 'Process').slice(0, 80),
      up: Boolean(item.up), detail: String(item.detail || '').slice(0, 200),
    })).filter((item) => item.id && item.name) };
    recordHistory(remoteItems());
    await Promise.all([saveHistory(), saveJson(agentsFile, state.agents)]);
    json(response, { ok: true });
  } catch (error) {
    response.writeHead(400);
    response.end('Invalid agent payload');
  }
}

async function pingHeartbeat(request, response, id, url) {
  const authorized = heartbeatToken && (
    request.headers.authorization === `Bearer ${heartbeatToken}` || url.searchParams.get('token') === heartbeatToken
  );
  if (!authorized) {
    response.writeHead(401);
    response.end('Invalid heartbeat token');
    return;
  }
  if (!heartbeats.has(id)) {
    response.writeHead(404);
    response.end('Unknown heartbeat');
    return;
  }
  await heartbeats.record(id);
  json(response, { ok: true });
}

function json(response, body) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function text(response, body, contentType, cacheControl = 'no-store') {
  response.writeHead(200, { 'content-type': contentType, 'cache-control': cacheControl });
  response.end(body);
}

function clientIp(request) {
  return (request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
}

function asset(response, entry) {
  response.writeHead(200, {
    'content-type': entry.contentType,
    'cache-control': entry.cacheControl,
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(entry.body);
}


const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const agentMatch = url.pathname.match(/^\/api\/agents\/([a-z0-9-]{1,64})$/i);
  if (request.method === 'POST' && agentMatch) {
    if (rateLimited(`ingest:${clientIp(request)}`)) { response.writeHead(429); return response.end('Too many requests'); }
    return ingestAgent(request, response, agentMatch[1]);
  }
  const heartbeatMatch = url.pathname.match(/^\/api\/heartbeat\/([A-Za-z0-9_-]{1,64})$/);
  if (['GET', 'POST'].includes(request.method) && heartbeatMatch) {
    if (rateLimited(`heartbeat:${clientIp(request)}`)) { response.writeHead(429); return response.end('Too many requests'); }
    return pingHeartbeat(request, response, heartbeatMatch[1], url);
  }
  if (url.pathname === '/api/status') return json(response, state);
  if (url.pathname === '/healthz') return json(response, { ok: true });
  if (url.pathname === '/metrics') return text(response, renderMetrics(state), 'text/plain; version=0.0.4; charset=utf-8');
  if (url.pathname === '/badge.svg') return text(response, renderBadge(countIncidents(state, state.thresholds)), 'image/svg+xml; charset=utf-8', 'public, max-age=60');
  if (url.pathname === '/feed.xml') return text(response, renderFeed(alerter.recentIncidents(50), publicOrigin), 'application/rss+xml; charset=utf-8', 'public, max-age=60');
  const publicAsset = publicAssets.get(url.pathname);
  if (publicAsset) return asset(response, publicAsset);
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

await loadHistory();
if (usageMonitor) await usageMonitor.sync();
await refresh();
refreshCertificates().catch(() => {});
setInterval(() => refreshCertificates().catch(() => {}), certIntervalMs);
setInterval(() => refresh().catch(() => {}), intervalMs);
if (usageMonitor) setInterval(() => usageMonitor.sync().catch(() => {}), 60 * 60 * 1000);
server.listen(port, '0.0.0.0');

export { checkTarget, parseJson, refreshCertificates };
