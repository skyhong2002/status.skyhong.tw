import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewaySnapshot, maskAccount, probeGateway, sanitizeGatewayReport, windowLabel } from './gateway.mjs';
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

function snapshot({ report = rawReport(), receivedAt = minutesAgo(0), probe = { up: true, latencyMs: 30, detail: 'ok', models: ['sky-fast', 'sky-quality', 'gpt-5.6-sol'] } } = {}) {
  return buildGatewaySnapshot({ probe, probeConfigured: true, report: sanitizeGatewayReport(report), receivedAt, now });
}

const failing = (snap) => snap.checks.filter((check) => !check.up).map((check) => check.id);

test('a healthy gateway reports every check up and publishes no secrets', () => {
  const snap = snapshot();
  assert.deepEqual(failing(snap), []);
  assert.equal(snap.revision, '2026-10-02');
  assert.deepEqual(snap.aliases.map((a) => [a.alias, a.model, a.listed]), [['sky-fast', 'gpt-6-luna', true], ['sky-quality', 'gpt-6.1-sol', true]]);
  assert.equal(snap.credential.account, 'o••@example.com');
  assert.equal(snap.usage.windows[0].label, 'Weekly window');
  const published = JSON.stringify(snap);
  assert.doesNotMatch(published, /secret|ops@example\.com|gpt-5\.6-sol/);
});

test('raises incidents for a down listener, a missing alias, and config drift', () => {
  assert.deepEqual(failing(snapshot({ probe: { up: false, detail: 'Timed out', models: [] } })), ['gateway:tailnet']);
  assert.deepEqual(failing(snapshot({ probe: { up: true, models: ['sky-fast'] } })), ['gateway:alias:sky-quality']);
  const drift = rawReport({ config: { revision: '2026-09-01', aliases: { 'sky-fast': 'gpt-5.6-luna', 'sky-quality': 'gpt-6.1-sol' } } });
  const snap = snapshot({ report: drift });
  assert.deepEqual(failing(snap), ['gateway:alias:sky-fast']);
  assert.equal(snap.configRevisionMatches, false);
  assert.match(snap.aliases[0].detail, /maps to gpt-5\.6-luna/);
});

test('flags an invalid credential and a wrong resolved model', () => {
  const missing = rawReport({ credential: { present: false } });
  assert.ok(failing(snapshot({ report: missing })).includes('gateway:credential'));
  const expired = rawReport({ credential: { ...rawReport().credential, accessExpiresAt: minutesAgo(120) } });
  assert.ok(failing(snapshot({ report: expired })).includes('gateway:credential'));
  const rejected = rawReport({ inference: { ...rawReport().inference, ok: false, statusCode: 401, detail: 'HTTP 401' } });
  assert.deepEqual(failing(snapshot({ report: rejected })), ['gateway:credential', 'gateway:inference']);
  const wrongModel = rawReport({ inference: { ...rawReport().inference, model: 'gpt-5.6-luna' } });
  assert.deepEqual(failing(snapshot({ report: wrongModel })), ['gateway:inference']);
});

test('stale telemetry collapses into one incident instead of a storm', () => {
  const snap = snapshot({ receivedAt: minutesAgo(10) });
  assert.deepEqual(failing(snap), ['gateway:quota-telemetry']);
  assert.equal(snap.listeners.length, 1);
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
  assert.match(metrics, /sky_up\{kind="gateway",id="gateway:tailnet",name="AI gateway · tailnet listener"\} 0/);
  assert.match(metrics, /sky_gateway_quota_used_percent\{window="primary",minutes="10080"\} 62/);
  assert.equal(buildReadinessSnapshot({ state, intervalMs: 60_000 }, now).ok, true);
});

test('without a probe key or an agent report the section is absent', () => {
  assert.equal(buildGatewaySnapshot({ probe: null, probeConfigured: false, report: null, now }), null);
  const agentOnly = buildGatewaySnapshot({ probe: null, probeConfigured: false, report: sanitizeGatewayReport(rawReport()), receivedAt: minutesAgo(0), now });
  assert.deepEqual(agentOnly.listeners.map((l) => l.id), ['local']);
  assert.deepEqual(failing(agentOnly), []);
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
