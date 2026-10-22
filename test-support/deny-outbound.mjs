// Preload before test modules: no real TCP/TLS/UDP, DNS, fetch or child commands.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import childProcess from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const deny = () => { throw new Error('offline tests deny outbound I/O and child commands'); };
const missingSocketFixtures = new Set();
function guardConnect(connect) {
  return function (...args) {
    // Node also passes normalized connect arguments as [options, callback].
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const path = options?.path;
    if (typeof path !== 'string' || !missingSocketFixtures.has(path)) return deny();
    try {
      lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return connect.apply(this, args);
    }
    return deny();
  };
}
net.Socket.prototype.connect = guardConnect(net.Socket.prototype.connect);
tls.connect = guardConnect(tls.connect);

// Only a missing path in a new private directory may reach the OS. Existing
// sockets, arbitrary Unix paths and all TCP/TLS destinations remain denied.
export async function withMissingSocketFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'status-test-'));
  const path = join(directory, 'missing.sock');
  missingSocketFixtures.add(path);
  try {
    return await run(path);
  } finally {
    missingSocketFixtures.delete(path);
    rmSync(directory, { recursive: true, force: true });
  }
}
dgram.Socket.prototype.send = deny;
dgram.Socket.prototype.connect = deny;
for (const api of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(api)) {
    if ((name === 'lookup' || name === 'lookupService' || name.startsWith('resolve') || name === 'reverse') && typeof api[name] === 'function') api[name] = deny;
  }
}
// The existing localhost lookup regression uses a deterministic fixture, no DNS.
dnsPromises.lookup = async (hostname) => {
  if (hostname !== 'localhost') return deny();
  return { address: '127.0.0.1', family: 4 };
};
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) childProcess[name] = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
