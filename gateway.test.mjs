import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewaySnapshot, maskAccount, migrateGatewayReports, parseGatewayHosts, probeGateway, sanitizeGatewayReport, windowLabel } from './gateway.mjs';
import { countIncidents, renderMetrics } from './observability.mjs';
import { buildReadinessSnapshot } from './health.mjs';
import { createAlerter } from './alerts.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.deepEqual(failing(snapshot({ probe: { up: true, models: ['sky-fast', 'gpt-6.1-sol'] } })), ['alias:sky-quality']);
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

test('a real account match recovers an incident and allows a later mismatch to alert', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gateway-usage-recovery-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sends = [];
  const alerter = await createAlerter({ dataDir, failureThreshold: 1,
    send: async (payload) => { sends.push(payload); return true; } });
  for (const accountMatches of [false, true, false]) {
    const snap = snapshot({ report: rawReport({ usage: { ...rawReport().usage, accountMatches } }) });
    await alerter.evaluate(snap.checks.filter((check) => check.id === 'gateway:quota-account'));
  }
  assert.deepEqual(sends.map((payload) => payload.embeds[0].title.slice(0, 2)), ['🔴', '🟢', '🔴']);
  const unknown = snapshot({ report: rawReport({ usage: { ...rawReport().usage, accountMatches: null } }) });
  assert.equal(unknown.checks.some((check) => check.id === 'gateway:quota-account'), false);
  const stale = snapshot({ report: rawReport({ usage: { ...rawReport().usage, checkedAt: minutesAgo(30) } }) });
  assert.equal(stale.checks.some((check) => check.id === 'gateway:quota-account'), false);
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

test('a model paused after upstream errors is one fleet-wide check that waits before alerting', () => {
  const paused = { up: true, latencyMs: 30, detail: 'ok', models: ['sky-fast', 'gpt-6-luna'] };
  const snap = fleetSnapshot({ probes: { 'sky-mini': paused, 'skyhong-blog': paused } });
  assert.deepEqual(failingIds(snap), ['gateway:upstream:gpt-6.1-sol']);
  const check = snap.checks.find((c) => c.id === 'gateway:upstream:gpt-6.1-sol');
  assert.equal(check.detail, 'Paused after upstream errors on sky-mini, skyhong-blog');
  assert.equal(check.alertAfterMs, 15 * 60_000);
  const quality = snap.hosts[0].aliases[1];
  assert.deepEqual([quality.paused, quality.up, quality.detail], [true, false, 'gpt-6.1-sol paused after upstream errors']);
  // Config drift on a paused model is still this host's problem.
  const drift = vpsReport({ config: { revision: '2026-10-02', aliases: { 'sky-fast': 'gpt-6-luna', 'sky-quality': 'gpt-5.6-sol' } } });
  assert.deepEqual(failingIds(fleetSnapshot({ probes: { 'sky-mini': paused, 'skyhong-blog': paused }, reports: { vps: { receivedAt: minutesAgo(0), report: drift } } })),
    ['gateway:skyhong-blog:alias:sky-quality', 'gateway:upstream:gpt-6.1-sol']);
  assert.equal(fleetSnapshot().checks.find((c) => c.id === 'gateway:upstream:gpt-6.1-sol').up, true);
});

const accountsBlock = (accounts, checkedAt = minutesAgo(1)) => ({ checkedAt, accounts: accounts.map((a, i) => ({
  id: `abcdef0${i}`, provider: 'codex', account: 'o••@example.com', remainingPercent: 50, priority: 100, mirror: null, ...a })) });

test('account logins: a rejected login alerts once, on the host that owns it', () => {
  const rejected = { loginRejected: true, remainingPercent: 0, priority: -100, error: 'login rejected (HTTP 401); re-login required' };
  const snap = fleetSnapshot({ reports: {
    skylabmac: { receivedAt: minutesAgo(0), report: rawReport({ accounts: accountsBlock([rejected, { provider: 'claude' }]) }) },
    // The peer's mirror of the same dead login is rejected too, but the peer only reports mirror freshness.
    vps: { receivedAt: minutesAgo(0), report: vpsReport({ accounts: accountsBlock([{ ...rejected, mirror: 'peer' }, { provider: 'claude', mirror: 'peer' }]) }) },
  } });
  assert.deepEqual(failingIds(snap), ['gateway:sky-mini:login:abcdef00']);
  const check = snap.checks.find((c) => c.id === 'gateway:sky-mini:login:abcdef00');
  assert.equal(check.name, 'AI gateway · sky-mini · Codex · o••@example.com login');
  assert.match(check.detail, /HTTP 401.*OAuth 登入/);
  assert.equal(snap.checks.find((c) => c.id === 'gateway:skyhong-blog:mirrors').detail, '2 mirrors current');
  assert.match(snap.hosts[1].accounts.list[0].detail, /^Mirrors sky-mini's login, which the upstream rejects \(HTTP 401\)/);
  // Hosts that report account logins drop the legacy single-credential check.
  assert.ok(!snap.checks.some((c) => c.id.endsWith(':credential')));
});

test('account logins: used-up quota never alerts; expired mirrors and a stalled policy do', () => {
  const exhausted = rawReport({ accounts: accountsBlock([{ remainingPercent: 0, priority: -100 }]) });
  const snap = snapshot({ report: exhausted });
  assert.deepEqual(failing(snap), []);
  assert.match(snap.hosts[0].accounts.list[0].detail, /used up/);
  const t3 = rawReport({ accounts: accountsBlock([{ mirror: 't3', mirrorExpired: true }]) });
  assert.deepEqual(failing(snapshot({ report: t3 })), ['login:abcdef00']);
  const peer = vpsReport({ accounts: accountsBlock([{ mirror: 'peer', mirrorExpired: true, provider: 'claude' }]) });
  const fleetSnap = fleetSnapshot({ reports: { vps: { receivedAt: minutesAgo(0), report: peer } } });
  assert.deepEqual(failingIds(fleetSnap), ['gateway:skyhong-blog:mirrors']);
  assert.match(fleetSnap.checks.find((c) => c.id === 'gateway:skyhong-blog:mirrors').detail, /^Claude · o••@example\.com: mirror expired/);
  // A stopped account_failover.py is one incident; its stale per-account state is not re-judged.
  const stale = rawReport({ accounts: accountsBlock([{ loginRejected: true }], minutesAgo(30)) });
  assert.deepEqual(failing(snapshot({ report: stale })), ['account-policy']);
});

test('account logins: unexpected fields are dropped and addresses stay masked', () => {
  const raw = rawReport({ accounts: { checkedAt: minutesAgo(1), accounts: [
    { id: 'abcdef00', provider: 'codex', account: 'ops@example.com', mirror: 'evil', token: 'secret' },
    { id: '../x', provider: 'codex' }, { id: 'abcdef01', provider: 'gemini' }] } });
  const list = sanitizeGatewayReport(raw).accounts.list;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].account, list[0].mirror, 'token' in list[0]], ['o••@example.com', null, false]);
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
