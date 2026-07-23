import test from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil, evaluateBody, expiryFromRdap, expiryFromWhois, resolveHost } from './probes.mjs';

test('calculates whole days until a date', () => {
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const futureDays = daysUntil(future);
  assert.equal(futureDays >= 9 && futureDays <= 10, true);
  assert.equal(daysUntil(new Date(Date.now() - 86_400_000).toISOString()) < 0, true);
  assert.equal(daysUntil('not-a-date'), null);
});

test('checks required body text', () => {
  assert.deepEqual(evaluateBody('service is healthy', { keyword: 'healthy' }), { ok: true });
  const result = evaluateBody('service is healthy', { keyword: 'ready' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ready/);
});

test('checks forbidden body text', () => {
  assert.equal(evaluateBody('database error', { keywordAbsent: 'error' }).ok, false);
  assert.deepEqual(evaluateBody('service is healthy', { keywordAbsent: 'error' }), { ok: true });
});

test('extracts expiration dates from RDAP events', () => {
  const payload = {
    events: [
      { eventAction: 'registration', eventDate: '2000-01-01T00:00:00Z' },
      { eventAction: 'expiration', eventDate: '2030-05-01T00:00:00Z' },
    ],
  };
  assert.equal(expiryFromRdap(payload), '2030-05-01T00:00:00Z');
  assert.equal(expiryFromRdap({ events: [{ eventAction: 'registration', eventDate: '2000-01-01T00:00:00Z' }] }), null);
});

test('extracts expiration dates from WHOIS records', () => {
  const twnic = 'Domain Name: observe.tw\n   Domain Status: clientTransferProhibited\n   Record expires on 2027-06-18 16:33:14 (UTC+8)\n   Record created on 2026-06-18 16:33:14 (UTC+8)\n';
  assert.equal(expiryFromWhois(twnic), '2027-06-18');
  assert.equal(expiryFromWhois('Registry Expiry Date: 2029-09-01T00:00:00Z'), '2029-09-01T00:00:00Z');
  assert.equal(expiryFromWhois('no expiry here'), null);
});

test('resolves localhost', async () => {
  const result = await resolveHost('localhost');
  assert.equal(result.ok, true);
});
