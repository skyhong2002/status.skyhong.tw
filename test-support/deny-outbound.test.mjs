import { withMissingSocketFixture } from './deny-outbound.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';

test('startup guard denies TCP, TLS, UDP, DNS, fetch and child commands', async () => {
  const denied = /offline tests deny/;
  assert.throws(() => net.connect({host: '127.0.0.1', port: 1}), denied);
  assert.throws(() => tls.connect({host: 'fixture.invalid', port: 443}), denied);
  assert.throws(() => net.connect({path: '/nonexistent-status-test/origin.sock'}), denied);
  assert.throws(() => tls.connect({path: '/nonexistent-status-test/origin.sock'}), denied);
  const socket = dgram.createSocket('udp4');
  try {
    assert.throws(() => socket.send('fixture', 1, '127.0.0.1'), denied);
  } finally { socket.close(); }
  assert.throws(() => dns.resolve4('fixture.invalid'), denied);
  assert.throws(() => new dns.Resolver().resolve4('fixture.invalid'), denied);
  await assert.rejects(dns.lookup('fixture.invalid'), denied);
  assert.throws(() => fetch('https://fixture.invalid'), denied);
  assert.throws(() => childProcess.spawn('never-executed'), denied);
  assert.deepEqual(await dns.lookup('localhost'), {address: '127.0.0.1', family: 4});
});

test('missing-socket exception is private, absent and limited to fixture lifetime', async () => {
  let fixturePath;
  await withMissingSocketFixture(async (path) => {
    fixturePath = path;
    const denied = /offline tests deny/;
    assert.throws(() => net.connect({host: '127.0.0.1', port: 1}), denied);
    assert.throws(() => tls.connect({host: 'fixture.invalid', port: 443}), denied);
    assert.throws(() => net.connect({path: `${path}.other`}), denied);
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = net.connect({path});
      socket.once('error', reject);
      socket.once('connect', () => { socket.destroy(); resolve(); });
    }), {code: 'ENOENT'});
    writeFileSync(path, 'fixture');
    assert.throws(() => net.connect({path}), denied);
    assert.throws(() => tls.connect({path}), denied);
  });
  assert.throws(() => net.connect({path: fixturePath}), /offline tests deny/);
});
