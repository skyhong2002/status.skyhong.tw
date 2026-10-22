import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlerter, humanDuration } from './alerts.mjs';

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), 'status-alerts-'));
}

test('alerts after the threshold, recovers, and can alert again', async () => {
  const sends = [];
  const alerter = await createAlerter({
    dataDir: temporaryDataDir(), failureThreshold: 2,
    send: async (payload) => { sends.push(payload); return true; },
  });
  const down = { id: 'site', name: 'Site', up: false, detail: 'Timed out' };

  await alerter.evaluate([down]);
  assert.equal(sends.length, 0);
  await alerter.evaluate([down]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].embeds[0].title.startsWith('🔴'), true);

  await alerter.evaluate([down]);
  assert.equal(sends.length, 1);

  await alerter.evaluate([{ ...down, up: true, detail: 'HTTP 200' }]);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].embeds[0].title.startsWith('🟢'), true);

  await alerter.evaluate([down]);
  await alerter.evaluate([down]);
  assert.equal(sends.length, 3);
  assert.equal(sends[2].embeds[0].title.startsWith('🔴'), true);
});

test('holds the alert for a check that asks to wait, then reports the whole outage', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T08:00:00Z') });
  const sends = [];
  const alerter = await createAlerter({
    dataDir: temporaryDataDir(), failureThreshold: 2,
    send: async (payload) => { sends.push(payload); return true; },
  });
  const paused = { id: 'upstream', name: 'Upstream', up: false, detail: 'Paused', alertAfterMs: 15 * 60_000 };

  // A pause that clears within the window never alerts.
  for (let minute = 0; minute < 10; minute += 1) { await alerter.evaluate([paused]); t.mock.timers.tick(60_000); }
  await alerter.evaluate([{ ...paused, up: true }]);
  assert.equal(sends.length, 0);

  for (let minute = 0; minute < 15; minute += 1) { await alerter.evaluate([paused]); t.mock.timers.tick(60_000); }
  assert.equal(sends.length, 0);
  await alerter.evaluate([paused]);
  assert.equal(sends.length, 1);
  t.mock.timers.tick(5 * 60_000);
  await alerter.evaluate([{ ...paused, up: true, detail: 'Served' }]);
  assert.match(sends[1].embeds[0].description, /was down for 20m/);
});

test('loads alerted state and sends recovery after restart', async () => {
  const dataDir = temporaryDataDir();
  const initial = await createAlerter({ dataDir, failureThreshold: 2, send: async () => true });
  const item = { id: 'worker', name: 'Worker', up: false, detail: 'Stopped' };
  await initial.evaluate([item]);
  await initial.evaluate([item]);

  const sends = [];
  const restarted = await createAlerter({
    dataDir, failureThreshold: 2,
    send: async (payload) => { sends.push(payload); return true; },
  });
  await restarted.evaluate([{ ...item, up: true, detail: 'Running' }]);

  assert.equal(sends.length, 1);
  assert.equal(sends[0].embeds[0].title.startsWith('🟢'), true);
});

test('retries a failed down alert', async () => {
  let attempts = 0;
  const alerter = await createAlerter({
    dataDir: temporaryDataDir(), failureThreshold: 1,
    send: async () => { attempts += 1; return false; },
  });
  const item = { id: 'api', name: 'API', up: false, detail: 'Unavailable' };

  await alerter.evaluate([item]);
  await alerter.evaluate([item]);
  assert.equal(attempts, 2);
  assert.equal(alerter.deliveryStatus().configured, true);
  assert.equal(Boolean(alerter.deliveryStatus().lastFailureAt), true);
  assert.match(alerter.deliveryStatus().lastError, /unsuccessful/);
});

test('records successful test delivery telemetry', async () => {
  const alerter = await createAlerter({ dataDir: temporaryDataDir(), send: async () => true });
  assert.equal(await alerter.testDelivery(), true);
  const status = alerter.deliveryStatus();
  assert.equal(status.configured, true);
  assert.equal(Boolean(status.lastAttemptAt), true);
  assert.equal(status.lastSuccessAt, status.lastAttemptAt);
  assert.equal(status.lastError, null);
});

test('formats compact human durations', () => {
  assert.equal(humanDuration(45_000), '45s');
  assert.equal(humanDuration(12 * 60 * 1000), '12m');
  assert.equal(humanDuration((3 * 3600 + 5 * 60) * 1000), '3h 5m');
  assert.equal(humanDuration((2 * 86_400 + 4 * 3600) * 1000), '2d 4h');
  assert.equal(humanDuration(3 * 3600 * 1000), '3h');
  assert.equal(humanDuration(2 * 86_400 * 1000), '2d');
});

test('reports failing items as active incidents, confirmed once they would page', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T00:00:00Z') });
  let deliver = false;
  const alerter = await createAlerter({
    dataDir: temporaryDataDir(), failureThreshold: 2,
    send: async () => deliver,
  });
  const site = { id: 'site', name: 'Site', up: false, detail: 'Timed out' };
  const slow = { id: 'slow', name: 'Slow', up: false, detail: 'Paused', alertAfterMs: 10 * 60_000 };
  const fine = { id: 'fine', name: 'Fine', up: true, detail: 'OK' };

  await alerter.evaluate([site, slow, fine]);
  let active = alerter.activeIncidents([site, slow, fine]);
  assert.deepEqual(active.map((item) => [item.id, item.confirmed]), [['site', false], ['slow', false]]);
  assert.equal(active[0].failingSince, '2026-10-20T00:00:00.000Z');

  // Confirmed even when the webhook fails, so a responder does not depend on Discord.
  t.mock.timers.tick(60_000);
  await alerter.evaluate([site, slow, fine]);
  active = alerter.activeIncidents([site, slow, fine]);
  assert.deepEqual(active.map((item) => [item.id, item.confirmed, item.alerted]), [['site', true, false], ['slow', false, false]]);

  t.mock.timers.tick(10 * 60_000);
  deliver = true;
  await alerter.evaluate([site, slow, fine]);
  active = alerter.activeIncidents([site, slow, fine]);
  assert.deepEqual(active.map((item) => [item.id, item.confirmed, item.alerted, item.failCount]), [['site', true, true, 3], ['slow', true, true, 3]]);

  await alerter.evaluate([{ ...site, up: true }, slow, fine]);
  assert.deepEqual(alerter.activeIncidents([{ ...site, up: true }, slow, fine]).map((item) => item.id), ['slow']);
});
