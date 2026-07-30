import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthSnapshot, deliveryUsable } from './health.mjs';

const now = Date.parse('2026-07-30T12:00:00Z');

function healthyState() {
  return {
    checkedAt: '2026-07-30T11:59:30Z',
    services: [{ name: 'status', up: true }],
    aiUsage: [{ connected: true, lastSyncAt: '2026-07-30T11:55:00Z' }],
    alertDelivery: {
      incident: { configured: true, lastSuccessAt: '2026-07-30T11:00:00Z', lastFailureAt: null },
      usage: { configured: true, lastSuccessAt: '2026-07-30T11:30:00Z', lastFailureAt: '2026-07-30T11:00:00Z' },
    },
    errors: [],
  };
}

test('deep health passes with fresh collectors and usable webhooks', () => {
  const health = buildHealthSnapshot({
    state: healthyState(), intervalMs: 60_000, dockerConfigured: true,
    usageConfigured: true, usageSyncIntervalMs: 600_000,
  }, now);
  assert.equal(health.ok, true);
  assert.equal(Object.values(health.checks).every(Boolean), true);
});

test('deep health fails on stale refresh or a newer delivery failure', () => {
  const state = healthyState();
  state.checkedAt = '2026-07-30T11:50:00Z';
  state.alertDelivery.incident.lastFailureAt = '2026-07-30T11:45:00Z';
  const health = buildHealthSnapshot({
    state, intervalMs: 60_000, dockerConfigured: true,
    usageConfigured: true, usageSyncIntervalMs: 600_000,
  }, now);
  assert.equal(health.ok, false);
  assert.equal(health.checks.refreshFresh, false);
  assert.equal(health.checks.incidentWebhookUsable, false);
});

test('configured webhook without a recorded attempt is initially usable', () => {
  assert.equal(deliveryUsable({ configured: true }), true);
  assert.equal(deliveryUsable({ configured: false }), false);
});
