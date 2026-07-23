import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function humanDuration(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

function discordSender(webhookUrl) {
  return async (payload) => {
    if (!webhookUrl) return false;
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(payload),
      });
      return response.ok || response.status === 204;
    } catch {
      return false;
    }
  };
}

export async function createAlerter(options = {}) {
  const webhookUrl = options.webhookUrl ?? process.env.DISCORD_ALERT_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL ?? '';
  const failureThreshold = Math.max(1, Number(options.failureThreshold ?? process.env.ALERT_FAILURE_THRESHOLD ?? 2));
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? './data';
  const send = options.send ?? discordSender(webhookUrl);
  const maxIncidents = Math.max(1, Number(options.maxIncidents ?? 200));
  const file = join(dataDir, 'alerts.json');
  const incidentsFile = join(dataDir, 'incidents.json');
  let state = {};
  let incidents = [];
  try {
    const loaded = JSON.parse(await readFile(file, 'utf8'));
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) state = loaded;
  } catch {}
  try {
    const loaded = JSON.parse(await readFile(incidentsFile, 'utf8'));
    if (Array.isArray(loaded)) incidents = loaded.slice(0, maxIncidents);
  } catch {}

  async function writeAtomic(target, value) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${target}.tmp`, JSON.stringify(value), 'utf8');
    await rename(`${target}.tmp`, target);
  }

  async function save() {
    await writeAtomic(file, state);
  }

  function logIncident(event) {
    incidents.unshift(event);
    incidents = incidents.slice(0, maxIncidents);
    return writeAtomic(incidentsFile, incidents).catch(() => {});
  }

  async function evaluate(items) {
    for (const item of items) {
      const record = state[item.id] || { failCount: 0, alerted: false, downSince: null };
      record.name = item.name;
      record.detail = item.detail;
      if (item.up) {
        record.failCount = 0;
        if (record.alerted) {
          const now = Date.now();
          const timestamp = new Date(now).toISOString();
          const downFor = humanDuration(now - (record.downSince ?? now));
          const payload = { embeds: [{
            title: `🟢 ${item.name}`,
            description: `**Recovered** · was down for ${downFor}${item.detail ? ` · ${item.detail}` : ''}`,
            color: 0x30A46C,
            timestamp,
          }] };
          try {
            if (await send(payload)) {
              record.alerted = false;
              record.downSince = null;
              await logIncident({ at: timestamp, id: item.id, name: item.name, type: 'recovery', detail: `Recovered after ${downFor}` });
            }
          } catch {}
        }
      } else {
        record.failCount += 1;
        if (record.failCount >= failureThreshold && !record.alerted) {
          const now = Date.now();
          const payload = { embeds: [{
            title: `🔴 ${item.name}`,
            description: `**DOWN** · ${item.detail || 'No detail'}`,
            color: 0xE5484D,
            timestamp: new Date(now).toISOString(),
          }] };
          try {
            if (await send(payload)) {
              record.alerted = true;
              record.downSince = now;
              await logIncident({ at: new Date(now).toISOString(), id: item.id, name: item.name, type: 'down', detail: item.detail || 'No detail' });
            }
          } catch {}
        }
      }
      state[item.id] = record;
    }
    await save();
  }

  function recentIncidents(limit = 50) {
    return incidents.slice(0, Math.max(0, limit));
  }

  return { evaluate, recentIncidents };
}
