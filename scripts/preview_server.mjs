#!/usr/bin/env node
// Local design preview: serves public/ with a fabricated /api/status snapshot.
// It never imports server.mjs, so nothing is probed and no alert can be sent.
//
//   node scripts/preview_server.mjs [port]
//   open http://127.0.0.1:4317/?scenario=operational|degraded|outage|incident|nodata|maintenance|offline
//
// The page itself does not know about `scenario`; the server picks the fixture from the
// Referer of the /api/status request, falling back to `operational`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { localizeIndex, preferredLanguage } from '../seo.mjs';

const port = Number(process.argv[2] || process.env.PORT || 4317);
const root = new URL('../public/', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const HOUR = 3_600_000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const TARGETS = [
  ['skyhong-tw', 'skyhong.tw', 'Products', 'https://skyhong.tw', 182],
  ['youtube-board-tw', 'youtube.board.tw', 'Products', 'https://youtube.board.tw', 241],
  ['harmonica-observe', 'harmonica.observe.tw', 'Products', 'https://harmonica.observe.tw', 310],
  ['youtube-observe', 'youtube.observe.tw', 'Products', 'https://youtube.observe.tw', 655],
  ['plaud-skyhong', 'plaud.observe.tw', 'Products', 'https://plaud.observe.tw', 128],
  ['mayor2026-observe', 'mayor2026.observe.tw', 'Products', 'https://mayor2026.observe.tw', 402],
  ['infovore', 'Infovore', 'Products', 'https://infovore.skyhong.tw', 512],
  ['urtube-observe', 'urtube.observe.tw', 'Products', 'https://urtube.observe.tw', 96],
  ['n8n', 'n8n automations', 'Operations', 'https://n8n.skyhong.tw', 74],
  ['urtube-jobs', 'URtube worker & backup', 'Operations', 'https://urtube.observe.tw', 88],
  ['freshrss', 'FreshRSS', 'Operations', 'https://rss.skyhong.tw', 143],
];

function bars(pattern = {}) {
  // pattern: { emptyBefore, downAt: [indices], downFrom }
  return Array.from({ length: 48 }, (_, index) => {
    if (pattern.emptyBefore != null && index < pattern.emptyBefore) return '0';
    if (pattern.downFrom != null && index >= pattern.downFrom) return '2';
    if (pattern.downAt?.includes(index)) return '2';
    return '1';
  }).join('');
}

function base() {
  const targets = TARGETS.map(([id, name, group, url, latencyMs]) => ({ id, name, group, url, up: true, degraded: false, statusCode: 200, detail: 'OK', latencyMs }));
  const history24h = Object.fromEntries(targets.map((target, index) => [target.id, { bars: bars(index === 3 ? { downAt: [17] } : {}), uptime: index === 3 ? 99.65 : 100, checks: 1440 }]));
  const uptime = Object.fromEntries(targets.map((target, index) => [target.id, {
    d7: { uptime: index === 3 ? 99.81 : 100, observedDays: 7, windowDays: 7, complete: true },
    d30: { uptime: index === 3 ? 99.93 : index === 6 ? 99.71 : 100, observedDays: 30, windowDays: 30, complete: true },
    d90: { uptime: 99.98, observedDays: 61, windowDays: 90, complete: false },
  }]));
  const services = [
    ['sky-status-dashboard', 'Swarm service', '1/1 replicas running'],
    ['dokploy', 'Swarm service', '1/1 replicas running'],
    ['dokploy-traefik', 'Swarm service', '1/1 replicas running'],
    ['dokploy-postgres', 'Swarm service', '1/1 replicas running'],
    ['dokploy-redis', 'Swarm service', '1/1 replicas running'],
    ['n8n', 'Container', 'running · healthy · up 6 days'],
    ['n8n-postgres', 'Container', 'running · healthy · up 6 days'],
    ['freshrss', 'Container', 'running · up 12 days'],
    ['urtube-api', 'Container', 'running · healthy · up 2 days'],
    ['urtube-worker', 'Container', 'running · up 2 days'],
    ['infovore-web', 'Container', 'running · healthy · up 4 days'],
    ['plaud-api', 'Container', 'running · healthy · up 9 days'],
  ].map(([name, kind, detail]) => ({ id: `svc-${name}`, name, kind, detail, up: true }));
  const agents = {
    skylabmac: { host: 'SkyLabMac', receivedAt: iso(-40_000), items: [
      { id: 'disk', name: 'Root disk', kind: 'Host metric', up: true, detail: '41% used · 287 GB free' },
      { id: 'memory', name: 'Memory pressure', kind: 'Host metric', up: true, detail: 'normal · 63% used' },
      { id: 'load', name: 'Load average', kind: 'Host metric', up: true, detail: '1.8 / 2.1 / 2.0 on 10 cores' },
      { id: 'cliproxy', name: 'CLIProxyAPI', kind: 'Process', up: true, detail: 'pid 812 · up 3 days' },
      { id: 'haproxy', name: 'HAProxy ingress', kind: 'Process', up: true, detail: 'pid 790 · up 3 days' },
    ] },
    vps: { host: 'skyhong-blog', receivedAt: iso(-25_000), items: [
      { id: 'disk', name: 'Root disk', kind: 'Host metric', up: true, detail: '58% used · 33 GB free' },
      { id: 'memory', name: 'Memory', kind: 'Host metric', up: true, detail: '47% used' },
      { id: 'load', name: 'Load average', kind: 'Host metric', up: true, detail: '0.4 / 0.5 / 0.5 on 4 cores' },
    ] },
  };
  const heartbeats = [
    ['VPS host reporter', 60, 'Last ping 32 s ago'],
    ['Bamboo Discord watcher', 120, 'Last ping 1 min ago'],
    ['n8n scheduler', 300, 'Last ping 3 min ago'],
    ['Status data backup', 86400, 'Last ping 7 h ago'],
  ].map(([name, periodSeconds, detail]) => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, periodSeconds, detail, up: true }));
  const certificates = TARGETS.slice(0, 9).map(([, name], index) => ({ host: name.includes('.') ? name : `${name.toLowerCase()}.skyhong.tw`, ok: true, issuer: index % 3 ? "Let's Encrypt R11" : 'Google Trust Services WE1', validTo: new Date(Date.now() + (40 + index * 6) * 24 * HOUR).toISOString().slice(0, 10), daysRemaining: 40 + index * 6 }));
  const domains = [
    { domain: 'skyhong.tw', ok: true, expiryDate: '2027-08-14', daysRemaining: 274 },
    { domain: 'observe.tw', ok: true, expiryDate: '2027-03-02', daysRemaining: 109 },
    { domain: 'board.tw', ok: true, expiryDate: '2027-05-21', daysRemaining: 189 },
  ];
  const hostChecks = (name, latency) => [
    { id: 'probe', name: 'Tailnet listener', source: `status → ${name}`, up: true, latencyMs: latency },
    { id: 'local', name: 'Local listener', source: 'reported by host agent', up: true, latencyMs: 3 },
  ];
  const aliases = [
    { alias: 'sky-fast', detail: 'gpt-5.4-mini · policy r42', up: true, listed: true, configMatches: true },
    { alias: 'sky-smart', detail: 'gpt-5.5 · policy r42', up: true, listed: true, configMatches: true },
  ];
  const gateway = {
    revision: 'r42',
    hosts: ['sky-mini', 'skyhong-blog'].map((name, index) => ({
      name, enabled: true, agent: index ? 'vps' : 'skylabmac', reportFresh: true, reportReceivedAt: iso(-30_000), configRevisionMatches: true,
      listeners: hostChecks(name, index ? 41 : 18), aliases,
      accounts: { fresh: true, list: [
        { label: 'Codex · s***@gmail.com', detail: index ? 'mirror of sky-mini · 72% remaining' : 'priority 1 · 72% remaining', up: true, remainingPercent: 72, mirror: index ? 'peer' : null },
        { label: 'Codex · w***@skyhong.tw', detail: index ? 'mirror of sky-mini · 100% remaining' : 'priority 2 · 100% remaining', up: true, remainingPercent: 100, mirror: index ? 'peer' : null },
      ] },
      inference: { detail: 'sky-fast answered with gpt-5.4-mini', up: true, latencyMs: 1400, checkedAt: iso(-11 * 60_000), fresh: true },
      checks: Array.from({ length: 7 }, () => ({ up: true })),
    })),
    checks: Array.from({ length: 16 }, (_, index) => ({ id: `gateway:check-${index}`, name: `gateway check ${index}`, up: true, detail: 'ok' })),
    usage: { plan: 'pro', fresh: true, checkedAt: iso(-2 * 60_000), limitReached: false, windows: [
      { label: '5-hour window', windowMinutes: 300, usedPercent: 23, resetsAt: iso(2.4 * HOUR) },
      { label: 'Weekly window', windowMinutes: 10080, usedPercent: 41, resetsAt: iso(3.2 * 24 * HOUR) },
    ] },
  };
  return {
    checkedAt: iso(-20_000), targets, services, certificates, domains, heartbeats, agents, gateway,
    alertDelivery: { incident: { configured: true, lastSuccessAt: iso(-26 * HOUR), lastFailureAt: null, lastError: null } },
    errors: [], history24h, uptime, maintenance: null, thresholds: { certWarnDays: 21, domainWarnDays: 30 },
  };
}

const scenarios = {
  operational: base,
  degraded() {
    const data = base();
    const youtube = data.targets.find((target) => target.id === 'youtube-observe');
    Object.assign(youtube, { degraded: true, degradedReason: 'Slow response · 6.8 s exceeds the 5 s threshold', latencyMs: 6812 });
    const infovore = data.targets.find((target) => target.id === 'infovore');
    Object.assign(infovore, { degraded: true, degradedReason: 'Slow response · 5.4 s exceeds the 5 s threshold', latencyMs: 5410 });
    data.certificates[2] = { ...data.certificates[2], daysRemaining: 12, validTo: new Date(Date.now() + 12 * 24 * HOUR).toISOString().slice(0, 10) };
    data.gateway.usage.windows[0].usedPercent = 78;
    return data;
  },
  outage() {
    const data = base();
    const plaud = data.targets.find((target) => target.id === 'plaud-skyhong');
    Object.assign(plaud, { up: false, statusCode: 502, detail: 'Bad Gateway', latencyMs: 2210 });
    data.history24h['plaud-skyhong'] = { bars: bars({ downFrom: 44 }), uptime: 91.67, checks: 1440 };
    data.services.find((service) => service.name === 'plaud-api').up = false;
    data.history24h['svc-plaud-api'] = { bars: bars({ downFrom: 44 }), uptime: 91.67, checks: 1440 };
    data.history24h['n8n-scheduler'] = { bars: bars({ downFrom: 47 }), uptime: 99, checks: 1440 };
    data.services.find((service) => service.name === 'plaud-api').detail = 'restarting · exit 137 · OOM-killed 3 times';
    data.heartbeats[2] = { ...data.heartbeats[2], up: false, detail: 'Late · last ping 19 min ago (expected every 5 min)' };
    return data;
  },
  incident() {
    const data = base();
    for (const id of ['skyhong-tw', 'youtube-board-tw', 'harmonica-observe', 'mayor2026-observe', 'freshrss']) {
      Object.assign(data.targets.find((target) => target.id === id), { up: false, statusCode: null, detail: 'connect ETIMEDOUT · host unreachable', latencyMs: 12_000 });
      data.history24h[id] = { bars: bars({ downFrom: 45, downAt: [30] }), uptime: 91.4, checks: 1440 };
    }
    for (const service of data.services.filter((item) => item.kind === 'Swarm service' && item.name.startsWith('dokploy-traefik'))) Object.assign(service, { up: false, detail: '0/1 replicas · task failed: port 443 already in use' });
    data.history24h['svc-dokploy-traefik'] = { bars: bars({ downFrom: 45 }), uptime: 93.1, checks: 1440 };
    data.agents.vps.receivedAt = iso(-14 * 60_000);
    const blog = data.gateway.hosts[1];
    blog.listeners[0] = { ...blog.listeners[0], up: false, latencyMs: null, detail: 'connect ECONNREFUSED' };
    blog.reportFresh = false;
    blog.reportReceivedAt = iso(-14 * 60_000);
    data.gateway.checks[3] = { id: 'gateway:skyhong-blog:probe', name: 'skyhong-blog · Tailnet peer listener', up: false, detail: 'connect ECONNREFUSED 100.81.220.33:8321' };
    data.gateway.checks[4] = { id: 'gateway:skyhong-blog:telemetry', name: 'skyhong-blog · host telemetry', up: false, detail: `vps agent last reported ${iso(-14 * 60_000)}` };
    data.alertDelivery.incident = { configured: true, lastSuccessAt: iso(-26 * HOUR), lastFailureAt: iso(-60_000), lastError: 'Discord returned 429 Too Many Requests' };
    return data;
  },
  maintenance() {
    const data = scenarios.outage();
    data.maintenance = { start: iso(-0.5 * HOUR), end: iso(1.5 * HOUR), reason: 'Upgrading Docker Engine on the VPS; services may restart.' };
    return data;
  },
  nodata() {
    // Fresh deployment: first refresh has not finished, nothing has been recorded yet.
    return { checkedAt: null, targets: [], services: [], certificates: [], domains: [], heartbeats: [], agents: {}, gateway: null, alertDelivery: {}, errors: [], history24h: {}, uptime: {}, maintenance: null, thresholds: { certWarnDays: 21, domainWarnDays: 30 } };
  },
};

function scenarioFor(request) {
  const referer = request.headers.referer || '';
  try { return new URL(referer).searchParams.get('scenario') || 'operational'; } catch { return 'operational'; }
}

const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'";

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/status') {
    const name = scenarioFor(request);
    if (name === 'offline') { response.writeHead(503, { 'content-type': 'text/plain' }); return response.end('unavailable'); }
    const data = (scenarios[name] || scenarios.operational)();
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return response.end(JSON.stringify(data));
  }
  if (url.pathname === '/') {
    const lang = preferredLanguage(request.headers['accept-language']);
    const html = localizeIndex(await readFile(new URL('index.html', root), 'utf8'), lang);
    response.writeHead(200, { 'content-type': types['.html'], 'cache-control': 'no-store', 'content-security-policy': csp, vary: 'Accept-Language', 'content-language': lang });
    return response.end(html);
  }
  const file = url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(file)) { response.writeHead(404); return response.end('Not found'); }
  try {
    const body = await readFile(new URL(file, root));
    const type = types[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': csp });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`preview on http://127.0.0.1:${port}/?scenario=operational`));
