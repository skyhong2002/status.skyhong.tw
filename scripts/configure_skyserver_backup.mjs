// Deliberately changes one heartbeat only. Do not replace production arrays
// using .env.example, which may differ from this deployment.
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { skyServerBackupHeartbeat } from '../backup-policy.mjs';

export function configureSkyServerBackup(text) {
  let found = false;
  const updated = text.replace(/^HEARTBEATS_JSON=(.*)$/m, (_, raw) => {
    found = true;
    // Compose supports unquoted JSON, single quotes, or JSON double quoting.
    let parsed = raw.startsWith("'") && raw.endsWith("'") ? JSON.parse(raw.slice(1, -1)) : JSON.parse(raw);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (!Array.isArray(parsed) || parsed.filter(x => x.id === skyServerBackupHeartbeat.id).length !== 1) {
      throw new Error('Expected exactly one existing sky-server backup heartbeat');
    }
    const entries = parsed.map(x => x.id === skyServerBackupHeartbeat.id ? { ...x, ...skyServerBackupHeartbeat } : x);
    return `HEARTBEATS_JSON='${JSON.stringify(entries)}'`;
  });
  if (!found) throw new Error('HEARTBEATS_JSON missing');
  return updated;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node scripts/configure_skyserver_backup.mjs <service.env> (back up first)');
  const before = await readFile(path, 'utf8');
  const mode = (await stat(path)).mode & 0o777;
  await writeFile(`${path}.weekly.tmp`, configureSkyServerBackup(before), { mode, flag: 'wx' });
  await rename(`${path}.weekly.tmp`, path);
  console.log('Updated only sky-server root success heartbeat: weekly +36h (204h deadline).');
}
