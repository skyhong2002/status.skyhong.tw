import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUsageMonitor } from './usage.mjs';

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || './data';
const historyFile = join(dataDir, 'history.json');
const agentsFile = join(dataDir, 'agents.json');
const intervalMs = Math.max(15, Number(process.env.CHECK_INTERVAL_SECONDS || 60)) * 1000;
const dockerApiUrl = process.env.DOCKER_API_URL || '';
const maxHistoryPoints = 24 * 60;

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
const state = { checkedAt: null, targets: [], services: [], agents: {}, aiUsage: [], errors: [], history: {} };
const usageMonitor = await createUsageMonitor({ dataDir });
const publicAssets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8', 'no-store'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8', 'public, max-age=3600'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8', 'public, max-age=3600'],
  ['/status-mark.svg', 'status-mark.svg', 'image/svg+xml', 'public, max-age=86400'],
].map(async ([path, file, contentType, cacheControl]) => [path, {
  body: await readFile(new URL(`./public/${file}`, import.meta.url)), contentType, cacheControl,
}])));

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
    const up = accepted.length ? accepted.includes(response.status) : response.status >= 200 && response.status < 400;
    return { ...target, up, statusCode: response.status, latencyMs: Date.now() - startedAt, detail: response.statusText || 'Reachable' };
  } catch (error) {
    return { ...target, up: false, statusCode: null, latencyMs: Date.now() - startedAt, detail: error.name === 'AbortError' ? 'Timed out' : 'Unreachable' };
  } finally {
    clearTimeout(timer);
  }
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
  const standalone = (containers || [])
    .filter((container) => !container.Labels?.['com.docker.swarm.service.name'])
    .map((container) => ({
      id: container.Id,
      name: container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12),
      kind: 'Container',
      up: container.State === 'running' && !container.Status?.includes('(unhealthy)'),
      detail: container.Status || container.State,
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
  recordHistory([...checkedTargets, ...services]);
  await saveHistory();
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

function json(response, body) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
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
  if (request.method === 'POST' && agentMatch) return ingestAgent(request, response, agentMatch[1]);
  if (url.pathname === '/api/status') return json(response, state);
  if (url.pathname === '/healthz') return json(response, { ok: true });
  const publicAsset = publicAssets.get(url.pathname);
  if (publicAsset) return asset(response, publicAsset);
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

await loadHistory();
if (usageMonitor) await usageMonitor.sync();
await refresh();
setInterval(() => refresh().catch(() => {}), intervalMs);
if (usageMonitor) setInterval(() => usageMonitor.sync().catch(() => {}), 60 * 60 * 1000);
server.listen(port, '0.0.0.0');

export { checkTarget, parseJson };
