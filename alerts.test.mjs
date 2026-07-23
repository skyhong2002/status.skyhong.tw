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
});

test('formats compact human durations', () => {
  assert.equal(humanDuration(45_000), '45s');
  assert.equal(humanDuration(12 * 60 * 1000), '12m');
  assert.equal(humanDuration((3 * 3600 + 5 * 60) * 1000), '3h 5m');
  assert.equal(humanDuration((2 * 86_400 + 4 * 3600) * 1000), '2d 4h');
  assert.equal(humanDuration(3 * 3600 * 1000), '3h');
  assert.equal(humanDuration(2 * 86_400 * 1000), '2d');
});
