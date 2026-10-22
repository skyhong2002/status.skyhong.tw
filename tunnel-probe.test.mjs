import test from 'node:test';
import assert from 'node:assert/strict';
import { withMissingSocketFixture } from './test-support/deny-outbound.mjs';
import { describeTunnelError, tunnelTransportDetail, fetchThroughSocket } from './tunnel-probe.mjs';

test('distinguishes a refused tunnel from a missing socket', () => {
  assert.equal(describeTunnelError({ code: 'ECONNREFUSED' }), 'Private SSH tunnel has no listener (ECONNREFUSED)');
  assert.equal(describeTunnelError({ code: 'ENOENT' }), 'Private SSH tunnel socket missing (ENOENT)');
});

test('classifies socket permissions and wrapped connection errors', () => {
  for (const code of ['EACCES', 'EPERM']) assert.match(describeTunnelError({ code }), /permission denied/);
  assert.match(describeTunnelError({ cause: { code: 'ECONNREFUSED' } }), /no listener/);
  for (const code of ['ECONNRESET', 'EPIPE']) assert.match(describeTunnelError({ code }), /closed before HTTPS response/);
});

test('classifies abort, timeout and certificate failures without disabling validation', () => {
  for (const error of [{ name: 'AbortError' }, { name: 'TimeoutError' }, { code: 'ETIMEDOUT' }]) {
    assert.equal(describeTunnelError(error), 'Private SSH tunnel timed out');
  }
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) {
    assert.equal(describeTunnelError({ code }), `Private SSH tunnel TLS validation failed (${code})`);
  }
});

test('does not publish arbitrary error codes, messages, URLs or inherited properties', () => {
  for (const error of [null, {}, { message: 'private-test-message', code: 'untrusted-test-code' }, { code: 'toString' }]) {
    assert.equal(describeTunnelError(error), 'Private SSH tunnel unavailable');
  }
});

test('transport summary deduplicates shared failures and ignores unrelated monitors', () => {
  const reason = describeTunnelError({ code: 'ECONNREFUSED' });
  const detail = tunnelTransportDetail([
    { id: 'omni-main-web', up: false, detail: reason },
    { id: 'omni-main-api', up: false, detail: reason },
    { id: 'other', up: false, detail: 'unrelated' },
  ]);
  assert.equal(detail, `Active monitor transport: private SSH tunnel · ${reason}`);
  assert.equal(tunnelTransportDetail([{ id: 'omni-main-web', up: true }]), 'Active monitor transport: private SSH tunnel');
});

test('real missing socket errors classify without depending on DNS', async () => {
  await withMissingSocketFixture(async (socketPath) => {
    await assert.rejects(fetchThroughSocket('https://fixture.invalid/',
      socketPath, AbortSignal.timeout(1000)), (error) => {
      assert.equal(error.code, 'ENOENT');
      assert.equal(describeTunnelError(error), 'Private SSH tunnel socket missing (ENOENT)');
      return true;
    });
  });
});
