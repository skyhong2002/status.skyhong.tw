import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewaySnapshot, maskAccount, migrateGatewayReports, parseGatewayHosts, probeGateway, sanitizeGatewayReport, windowLabel } from './gateway.mjs';
import { countIncidents, renderMetrics } from './observability.mjs';
import { buildReadinessSnapshot } from './health.mjs';

const now = Date.parse('2026-10-02T12:00:00Z');
const minutesAgo = (minutes) => new Date(now - minutes * 60_000).toISOString();

function rawReport(overrides = {}) {
  return {
    checkedAt: minutesAgo(0),
    local: { up: true, statusCode: 200, latencyMs: 4, detail: '23 models listed', aliasesListed: { 'sky-fast': true, 'sky-quality': true } },
    policy: { revision: '2026-10-02', aliases: { 'sky-fast': 'gpt-6-luna', 'sky-quality': 'gpt-6.1-sol' } },
    config: { revision: '2026-10-02', aliases: { 'sky-fast': 'gpt-6-luna', 'sky-quality': 'gpt-6.1-sol' } },
    credential: { present: true, disabled: false, refreshable: true, account: 'ops@example.com', plan: 'pro',
      accessExpiresAt: '2026-10-12T11:42:20Z', lastRefreshAt: '2026-10-02T11:42:20Z', access_token: 'secret' },
    inference: { checkedAt: minutesAgo(10), ok: true, statusCode: 200, alias: 'sky-fast', model: 'gpt-6-luna', latencyMs: 1500, detail: 'OK' },
    usage: { checkedAt: minutesAgo(2), ok: true, plan: 'pro', accountMatches: true, limitReached: false,
      windows: [{ id: 'primary', usedPercent: 62, windowMinutes: 10080, resetsAt: '2026-10-04T05:00:21Z' }] },
    ...overrides,
  };
}

const listing = { up: true, latencyMs: 30, detail: 'ok', models: ['sky-fast', 'sky-quality', 'gpt-5.6-sol'] };
const skyMini = parseGatewayHosts('', 'http://100.71.224.62:8318/v1');

function snapshot({ report = rawReport(), receivedAt = minutesAgo(0), probe = listing } = {}) {
  return buildGatewaySnapshot({ hosts: skyMini, probes: { 'sky-mini': probe }, probeConfigured: true,
    reports: { skylabmac: { receivedAt, report: sanitizeGatewayReport(report) } }, now });
}

// Check ids without the host prefix, e.g. 'gateway:sky-mini:probe' -> 'probe'.
const failing = (snap) => snap.checks.filter((check) => !check.up).map((check) => check.id.replace(/^gateway:sky-mini:/, ''));

test('a healthy gateway reports every check up and publishes no secrets', () => {
  const snap = snapshot();
  assert.deepEqual(failing(snap), []);
  assert.equal(snap.revision, '2026-10-02');
  assert.deepEqual(snap.hosts[0].aliases.map((a) => [a.alias, a.model, a.listed]), [['sky-fast', 'gpt-6-luna', true], ['sky-quality', 'gpt-6.1-sol', true]]);
  assert.equal(snap.hosts[0].credential.account, 'o••@example.com');
  assert.equal(snap.usage.windows[0].label, 'Weekly window');
  const published = JSON.stringify(snap);
  assert.doesNotMatch(published, /secret|ops@example\.com|gpt-5\.6-sol/);
});

test('raises incidents for a down listener, a missing alias, and config drift', () => {
  assert.deepEqual(failing(snapshot({ probe: { up: false, detail: 'Timed out', models: [] } })), ['probe']);
  assert.deepEqual(failing(snapshot({ probe: { up: true, models: ['sky-fast'] } })), ['alias:sky-quality']);
  const drift = rawReport({ config: { revision: '2026-09-01', aliases: { 'sky-fast': 'gpt-5.6-luna', 'sky-quality': 'gpt-6.1-sol' } } });
  const snap = snapshot({ report: drift });
  assert.deepEqual(failing(snap), ['alias:sky-fast']);
  assert.equal(snap.hosts[0].configRevisionMatches, false);
  assert.match(snap.hosts[0].aliases[0].detail, /maps to gpt-5\.6-luna/);
});

test('flags an invalid credential and a wrong resolved model', () => {
  const missing = rawReport({ credential: { present: false } });
  assert.ok(failing(snapshot({ report: missing })).includes('credential'));
  const expired = rawReport({ credential: { ...rawReport().credential, accessExpiresAt: minutesAgo(120) } });
  assert.ok(failing(snapshot({ report: expired })).includes('credential'));
  const rejected = rawReport({ inference: { ...rawReport().inference, ok: false, statusCode: 401, detail: 'HTTP 401' } });
  assert.deepEqual(failing(snapshot({ report: rejected })), ['credential', 'inference']);
  const wrongModel = rawReport({ inference: { ...rawReport().inference, model: 'gpt-5.6-luna' } });
  assert.deepEqual(failing(snapshot({ report: wrongModel })), ['inference']);
});

test('stale telemetry collapses into one incident instead of a storm', () => {
  const snap = snapshot({ receivedAt: minutesAgo(10) });
  assert.deepEqual(failing(snap), ['telemetry']);
  assert.equal(snap.hosts[0].listeners.length, 1);
  const staleUsage = rawReport({ usage: { ...rawReport().usage, checkedAt: minutesAgo(30) } });
  assert.deepEqual(failing(snapshot({ report: staleUsage })), ['gateway:quota-telemetry']);
  const oldInference = rawReport({ inference: { ...rawReport().inference, ok: false, checkedAt: minutesAgo(200) } });
  assert.deepEqual(failing(snapshot({ report: oldInference })), []);
});

test('usage at or above 90% or a reached limit is an incident', () => {
  const high = rawReport({ usage: { ...rawReport().usage, windows: [
    { id: 'primary', usedPercent: 91, windowMinutes: 10080 }, { id: 'secondary', usedPercent: 20, windowMinutes: 300 }] } });
  assert.deepEqual(failing(snapshot({ report: high })), ['gateway:quota:primary']);
  const reached = rawReport({ usage: { ...rawReport().usage, limitReached: true } });
  assert.deepEqual(failing(snapshot({ report: reached })), ['gateway:quota:primary']);
  const otherAccount = rawReport({ usage: { ...rawReport().usage, accountMatches: false } });
  assert.deepEqual(failing(snapshot({ report: otherAccount })), ['gateway:quota-account']);
});

test('gateway incidents count toward the badge and metrics but never readiness', () => {
  const gateway = snapshot({ probe: { up: false, detail: 'Unreachable', models: [] } });
  const state = { checkedAt: minutesAgo(0), targets: [], services: [], heartbeats: [], agents: {}, gateway };
  assert.equal(countIncidents(state), 1);
  const metrics = renderMetrics(state);
  assert.match(metrics, /sky_up\{kind="gateway",id="gateway:sky-mini:probe",name="AI gateway · sky-mini · tailnet listener"\} 0/);
  assert.match(metrics, /sky_gateway_quota_used_percent\{window="primary",minutes="10080"\} 62/);
  assert.equal(buildReadinessSnapshot({ state, intervalMs: 60_000 }, now).ok, true);
});

test('without a probe key or an agent report the section is absent', () => {
  assert.equal(buildGatewaySnapshot({ hosts: skyMini, probeConfigured: false, reports: {}, now }), null);
  const agentOnly = buildGatewaySnapshot({ hosts: skyMini, probeConfigured: false,
    reports: { skylabmac: { receivedAt: minutesAgo(0), report: sanitizeGatewayReport(rawReport()) } }, now });
  assert.deepEqual(agentOnly.hosts[0].listeners.map((l) => l.id), ['local']);
  assert.deepEqual(failing(agentOnly), []);
});

const fleet = parseGatewayHosts(JSON.stringify([
  { name: 'sky-mini', url: 'http://100.71.224.62:8318/v1', agent: 'skylabmac', probeName: 'Tailnet listener', route: 'skyhong.tw → sky-mini :8318' },
  { name: 'skyhong-blog', url: 'http://172.17.0.1:8317/v1', agent: 'vps', probeName: 'Docker bridge listener' },
  { name: 'skyhong-sm', enabled: false, note: 'Waiting for the Codex login' },
  { name: 'bad name!' },
]));
// The VPS agent has no policy file and no codex CLI: it reports its own listener, config and credential only.
const vpsReport = (overrides = {}) => {
  const { policy, usage, ...rest } = rawReport();
  return { ...rest, local: { ...rest.local, target: '172.17.0.1:8317' }, ...overrides };
};

function fleetSnapshot({ probes = {}, reports = {} } = {}) {
  return buildGatewaySnapshot({ hosts: fleet, probeConfigured: true, now,
    probes: { 'sky-mini': listing, 'skyhong-blog': listing, ...probes },
    reports: Object.fromEntries(Object.entries({
      skylabmac: { receivedAt: minutesAgo(0), report: rawReport() },
      vps: { receivedAt: minutesAgo(0), report: vpsReport() },
      ...reports,
    }).map(([id, entry]) => [id, { ...entry, report: sanitizeGatewayReport(entry.report) }])) });
}
const failingIds = (snap) => snap.checks.filter((check) => !check.up).map((check) => check.id);

test('every enabled host gets its own checks; usage is shown once; disabled hosts never alert', () => {
  const snap = fleetSnapshot();
  assert.deepEqual(failingIds(snap), []);
  assert.deepEqual(snap.hosts.map((h) => [h.name, h.enabled]), [['sky-mini', true], ['skyhong-blog', true], ['skyhong-sm', false]]);
  const blog = snap.hosts[1];
  assert.deepEqual(blog.listeners.map((l) => [l.name, l.source]), [['Docker bridge listener', 'status → skyhong-blog'], ['Local listener', 'skyhong-blog → 172.17.0.1:8317']]);
  assert.deepEqual(blog.aliases.map((a) => [a.alias, a.model, a.up]), [['sky-fast', 'gpt-6-luna', true], ['sky-quality', 'gpt-6.1-sol', true]]);
  assert.equal(blog.configRevisionMatches, true);
  assert.deepEqual(snap.hosts[2].checks, []);
  assert.equal(snap.hosts[2].note, 'Waiting for the Codex login');
  assert.equal(snap.checks.filter((c) => c.id.startsWith('gateway:quota-telemetry')).length, 1);
  assert.ok(snap.checks.some((c) => c.id === 'gateway:skyhong-blog:credential'));
  assert.ok(!snap.checks.some((c) => c.id.startsWith('gateway:skyhong-sm')));
});

test('a failure on one host is attributed to that host only', () => {
  assert.deepEqual(failingIds(fleetSnapshot({ probes: { 'skyhong-blog': { up: false, detail: 'Unreachable', models: [] } } })), ['gateway:skyhong-blog:probe']);
  const expired = vpsReport({ credential: { present: false } });
  assert.deepEqual(failingIds(fleetSnapshot({ reports: { vps: { receivedAt: minutesAgo(0), report: expired } } })), ['gateway:skyhong-blog:credential']);
  const drift = vpsReport({ config: { revision: '2026-09-01', aliases: { 'sky-fast': 'gpt-5.6-luna', 'sky-quality': 'gpt-6.1-sol' } } });
  const snap = fleetSnapshot({ reports: { vps: { receivedAt: minutesAgo(0), report: drift } } });
  assert.deepEqual(failingIds(snap), ['gateway:skyhong-blog:alias:sky-fast']);
  assert.equal(snap.hosts[1].configRevisionMatches, false);
  // A silent VPS agent is one incident; the backend probe keeps covering its listener.
  assert.deepEqual(failingIds(fleetSnapshot({ reports: { vps: { receivedAt: minutesAgo(10), report: vpsReport() } } })), ['gateway:skyhong-blog:telemetry']);
  // A silent sky-mini agent does not add a second, usage-telemetry incident.
  assert.deepEqual(failingIds(fleetSnapshot({ reports: { skylabmac: { receivedAt: minutesAgo(10), report: rawReport() } } })), ['gateway:sky-mini:telemetry']);
});

test('host config parsing falls back to the legacy single gateway and drops invalid entries', () => {
  assert.deepEqual(fleet.map((h) => h.name), ['sky-mini', 'skyhong-blog', 'skyhong-sm']);
  assert.deepEqual(skyMini.map((h) => [h.name, h.url, h.agent]), [['sky-mini', 'http://100.71.224.62:8318/v1', 'skylabmac']]);
  assert.equal(parseGatewayHosts('[{"name":"x","url":"file:///etc/passwd"}]')[0].url, null);
  const legacy = { receivedAt: minutesAgo(1), report: rawReport() };
  assert.deepEqual(Object.keys(migrateGatewayReports(legacy)), ['skylabmac']);
  assert.deepEqual(Object.keys(migrateGatewayReports({ skylabmac: legacy, vps: legacy })), ['skylabmac', 'vps']);
});

test('probeGateway lists models with the bearer key and reports failures', async () => {
  let seen;
  const ok = await probeGateway({ baseUrl: 'http://gw/v1/', apiKey: 'k', fetchImpl: async (url, init) => {
    seen = [url, init.headers.authorization];
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'sky-fast' }, { id: 'sky-quality' }] }) };
  } });
  assert.deepEqual(seen, ['http://gw/v1/models', 'Bearer k']);
  assert.deepEqual([ok.up, ok.models], [true, ['sky-fast', 'sky-quality']]);
  const denied = await probeGateway({ baseUrl: 'http://gw/v1', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual([denied.up, denied.detail], [false, 'HTTP 401']);
  const down = await probeGateway({ baseUrl: 'http://gw/v1', apiKey: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual([down.up, down.detail], [false, 'Unreachable']);
});

test('helpers mask accounts and label windows', () => {
  assert.equal(maskAccount('ops@example.com'), 'o••@example.com');
  assert.equal(maskAccount(42), null);
  assert.equal(windowLabel(300), '5-hour window');
  assert.equal(windowLabel(10080), 'Weekly window');
});
