import './deny-outbound.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import childProcess from 'node:child_process';

test('startup guard denies TCP, TLS, UDP, DNS, fetch and child commands', async () => {
  const denied = /offline tests deny/;
  assert.throws(() => net.connect({host: '127.0.0.1', port: 1}), denied);
  assert.throws(() => tls.connect({host: 'fixture.invalid', port: 443}), denied);
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
