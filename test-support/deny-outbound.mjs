// Preload before test modules: no real TCP/TLS/UDP, DNS, fetch or child commands.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const deny = () => { throw new Error('offline tests deny outbound I/O and child commands'); };
net.Socket.prototype.connect = deny;
tls.connect = deny;
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
