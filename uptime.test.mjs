import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUptimeStore } from './uptime.mjs';

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), 'status-uptime-'));
}

test('aggregates uptime and latency across a window', async () => {
  const store = await createUptimeStore({ dataDir: temporaryDataDir() });
  store.record([{ id: 'a', up: true, latencyMs: 100 }, { id: 'b', up: false }]);
  store.record([{ id: 'a', up: true, latencyMs: 200 }, { id: 'b', up: true }]);
  store.record([{ id: 'a', up: false, latencyMs: 300 }]);

  const a = store.windowFor('a', 7);
  assert.equal(a.uptime, (2 / 3) * 100);
  assert.equal(a.avgLatency, 200); // (100+200+300)/3

  const b = store.windowFor('b', 7);
  assert.equal(b.uptime, 50);
  assert.equal(b.avgLatency, null); // no latency samples
});

test('returns null for an unknown monitor', async () => {
  const store = await createUptimeStore({ dataDir: temporaryDataDir() });
  assert.equal(store.windowFor('missing', 30), null);
});

test('summary reports all requested windows', async () => {
  const store = await createUptimeStore({ dataDir: temporaryDataDir() });
  store.record([{ id: 'x', up: true, latencyMs: 50 }]);
  const summary = store.summary(['x']);
  assert.equal(summary.x.d7.uptime, 100);
  assert.equal(summary.x.d30.uptime, 100);
  assert.equal(summary.x.d90.uptime, 100);
});

test('persists aggregates across reopen', async () => {
  const dataDir = temporaryDataDir();
  const first = await createUptimeStore({ dataDir });
  first.record([{ id: 'p', up: true }]);
  const second = await createUptimeStore({ dataDir });
  second.record([{ id: 'p', up: false }]);
  assert.equal(second.windowFor('p', 7).uptime, 50);
});
