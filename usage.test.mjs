import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonEnv, matchesModel, poolForUsage, zonedDayStart } from './usage.mjs';

test('parses configuration without throwing on invalid JSON', () => {
  assert.deepEqual(jsonEnv('["gpt-5-mini"]', []), ['gpt-5-mini']);
  assert.deepEqual(jsonEnv('not-json', ['fallback']), ['fallback']);
});

test('matches exact, prefix, and contains model patterns', () => {
  assert.equal(matchesModel('gpt-5.4-mini-2026-03-17', ['*mini*']), true);
  assert.equal(matchesModel('gpt-5.4-2026-03-17', ['gpt-5.4-*']), true);
  assert.equal(matchesModel('gpt-4o', ['gpt-5.4-*']), false);
});

test('uses the reported service tier before model configuration', () => {
  const highModels = [];
  const miniModels = ['*mini*', '*nano*'];
  assert.equal(poolForUsage('gpt-5.4-2026-03-05', 'incentivized-tier', highModels, miniModels), 'high');
  assert.equal(poolForUsage('gpt-5.4-mini-2026-03-17', 'incentivized-tier', highModels, miniModels), 'mini');
  assert.equal(poolForUsage('gpt-5.4-2026-03-05', 'default', ['gpt-5.4-*'], miniModels), 'billable');
});

test('falls back to configured model patterns without a service tier', () => {
  assert.equal(poolForUsage('gpt-5.4-2026-03-05', '', ['gpt-5.4-*'], ['*mini*']), 'high');
  assert.equal(poolForUsage('unknown-model', '', ['gpt-5.4-*'], ['*mini*']), 'billable');
});

test('finds midnight in the configured reporting timezone', () => {
  const start = zonedDayStart(new Date('2026-07-16T10:00:00Z'), 'Asia/Taipei');
  assert.equal(new Date(start * 1000).toISOString(), '2026-07-15T16:00:00.000Z');
});
