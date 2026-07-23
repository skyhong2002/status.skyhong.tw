import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function jsonEnv(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function formatAge(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function heartbeatStatus(entry, lastPingAt, now) {
  if (!lastPingAt) return { up: false, detail: 'No ping received yet' };
  const ageMs = now - lastPingAt;
  const deadlineMs = (entry.periodSeconds + (entry.graceSeconds || 0)) * 1000;
  if (ageMs <= deadlineMs) return { up: true, detail: `Last ping ${formatAge(ageMs)} ago` };
  return { up: false, detail: `Late · last ping ${formatAge(ageMs)} ago` };
}

export async function createHeartbeats(options = {}) {
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? './data';
  const parsed = jsonEnv(options.config ?? process.env.HEARTBEATS_JSON, []);
  const config = (Array.isArray(parsed) ? parsed : [])
    .filter((entry) => entry && typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.id)
      && typeof entry.name === 'string' && entry.name.trim()
      && typeof entry.periodSeconds === 'number' && Number.isFinite(entry.periodSeconds) && entry.periodSeconds > 0)
    .map((entry) => ({ ...entry, graceSeconds: typeof entry.graceSeconds === 'number' ? entry.graceSeconds : 0 }));
  const configured = new Map(config.map((entry) => [entry.id, entry]));
  const file = join(dataDir, 'heartbeats.json');
  let pings = {};
  try {
    const loaded = JSON.parse(await readFile(file, 'utf8'));
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) pings = loaded;
  } catch {}

  async function save() {
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(pings), 'utf8');
    await rename(`${file}.tmp`, file);
  }

  async function record(id) {
    if (!configured.has(id)) return false;
    pings[id] = Date.now();
    await save();
    return true;
  }

  function items() {
    const now = Date.now();
    return config.map((entry) => ({
      id: entry.id, name: entry.name, kind: 'Heartbeat',
      periodSeconds: entry.periodSeconds, ...heartbeatStatus(entry, pings[entry.id], now),
    }));
  }

  return { record, items, has: (id) => configured.has(id) };
}
