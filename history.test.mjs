import test from 'node:test';
import assert from 'node:assert/strict';
import { recordHistory, pruneHistory, summarizeHistory, HISTORY_BINS } from './history.mjs';

const HOUR = 3_600_000;

test('recordHistory keeps only the last 24 hours per monitor', () => {
  const now = Date.now();
  const history = { web: [{ t: now - 25 * HOUR, up: true }, { t: now - HOUR, up: false }] };
  recordHistory(history, [{ id: 'web', up: true }, { id: 'api', up: false }], now);
  assert.deepEqual(history.web.map((point) => point.up), [false, true]);
  assert.deepEqual(history.api, [{ t: now, up: false }]);
});

test('pruneHistory removes monitors with no recent points', () => {
  const now = Date.now();
  const history = { stale: [{ t: now - 30 * HOUR, up: true }], live: [{ t: now - HOUR, up: true }] };
  pruneHistory(history, now);
  assert.deepEqual(Object.keys(history), ['live']);
});

test('summarizeHistory bins points into a compact 48-slot string with uptime', () => {
  const now = Date.now();
  const history = {
    web: [
      { t: now - 23.5 * HOUR, up: true },
      { t: now - 12 * HOUR, up: true },
      { t: now - 12 * HOUR + 60_000, up: false },
      { t: now - 1_000, up: true },
    ],
    old: [{ t: now - 48 * HOUR, up: true }],
  };
  const summary = summarizeHistory(history, now);
  assert.equal(summary.old, undefined);
  assert.equal(summary.web.bars.length, HISTORY_BINS);
  assert.equal(summary.web.bars[1], '1');
  assert.equal(summary.web.bars[24], '2');
  assert.equal(summary.web.bars[47], '1');
  assert.equal(summary.web.bars[10], '0');
  assert.equal(summary.web.checks, 4);
  assert.equal(summary.web.uptime, 75);
});
