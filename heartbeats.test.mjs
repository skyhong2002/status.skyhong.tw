import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeartbeats, heartbeatStatus } from './heartbeats.mjs';

function temporaryDataDir() {
  return mkdtempSync(join(tmpdir(), 'status-heartbeats-'));
}

const entry = { id: 'job', name: 'Job', periodSeconds: 60, graceSeconds: 30 };

test('reports heartbeat status across its deadline', () => {
  const now = 1_000_000;
  assert.deepEqual(heartbeatStatus(entry, null, now), { up: false, detail: 'No ping received yet' });
  assert.equal(heartbeatStatus(entry, now - 90_000, now).up, true);
  const late = heartbeatStatus(entry, now - 90_001, now);
  assert.equal(late.up, false);
  assert.match(late.detail, /Late/);
});

test('records configured heartbeats and persists their last ping', async () => {
  const dataDir = temporaryDataDir();
  const heartbeats = await createHeartbeats({ dataDir, config: [entry] });

  assert.equal(heartbeats.has('job'), true);
  assert.equal(heartbeats.has('nope'), false);
  assert.equal(await heartbeats.record('nope'), false);
  assert.equal(await heartbeats.record('job'), true);
  assert.equal(heartbeats.items()[0].up, true);

  const restarted = await createHeartbeats({ dataDir, config: [entry] });
  assert.equal(restarted.items()[0].up, true);
});
