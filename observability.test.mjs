import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMetrics, renderBadge, renderFeed, countIncidents } from './observability.mjs';

const state = {
  targets: [
    { id: 'a', name: 'A', up: true, latencyMs: 120 },
    { id: 'b', name: 'B', up: false, latencyMs: 0 },
    { id: 'c', name: 'C', up: true, degraded: true, latencyMs: 5000 },
  ],
  services: [{ name: 'svc', up: true }],
  heartbeats: [{ id: 'job', name: 'Job', up: false }],
  certificates: [{ host: 'a.tw', ok: true, daysRemaining: 5 }, { host: 'b.tw', ok: true, daysRemaining: 60 }],
  domains: [{ domain: 'a.tw', ok: true, daysRemaining: 200 }],
  agents: {},
  uptime: { a: { d7: { uptime: 100 }, d30: { uptime: 99.5 }, d90: { uptime: 98 } } },
  thresholds: { certWarnDays: 21, domainWarnDays: 30 },
};

test('counts incidents across all monitored kinds', () => {
  // b down, c degraded, job heartbeat down, a.tw cert 5<=21 => 4
  assert.equal(countIncidents(state, state.thresholds), 4);
});

test('renders Prometheus exposition with escaped labels and expected metrics', () => {
  const out = renderMetrics(state);
  assert.match(out, /sky_up\{kind="target",id="a",name="A"\} 1/);
  assert.match(out, /sky_up\{kind="target",id="b",name="B"\} 0/);
  assert.match(out, /sky_target_latency_ms\{id="a"\} 120/);
  assert.match(out, /sky_certificate_days_remaining\{host="a.tw"\} 5/);
  assert.match(out, /sky_domain_days_remaining\{domain="a.tw"\} 200/);
  assert.match(out, /sky_uptime_ratio\{id="a",window="30d"\} 0\.995000/);
  assert.match(out, /sky_incidents_total\{\} 4/);
  assert.match(out, /# TYPE sky_up gauge/);
});

test('badge reflects operational vs incident state', () => {
  assert.match(renderBadge(0), /operational/);
  assert.match(renderBadge(0), /#30A46C/);
  assert.match(renderBadge(3), /3 incidents/);
  assert.match(renderBadge(1), /1 incident</);
  assert.match(renderBadge(2), /#E5484D/);
});

test('feed renders incidents as RSS items with escaping', () => {
  const feed = renderFeed([
    { at: '2026-07-24T00:00:00Z', id: 'x', name: 'X & Y', type: 'down', detail: 'boom <tag>' },
    { at: '2026-07-24T01:00:00Z', id: 'x', name: 'X & Y', type: 'recovery', detail: 'ok' },
  ], 'https://status.skyhong.tw');
  assert.match(feed, /<rss version="2.0">/);
  assert.match(feed, /X &amp; Y — Down/);
  assert.match(feed, /boom &lt;tag&gt;/);
  assert.match(feed, /X &amp; Y — Recovered/);
});
