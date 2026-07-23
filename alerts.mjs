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
  const file = join(dataDir, 'alerts.json');
  let state = {};
  try {
    const loaded = JSON.parse(await readFile(file, 'utf8'));
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) state = loaded;
  } catch {}

  async function save() {
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(state), 'utf8');
    await rename(`${file}.tmp`, file);
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
          const payload = { embeds: [{
            title: `🟢 ${item.name}`,
            description: `**Recovered** · was down for ${humanDuration(now - (record.downSince ?? now))}${item.detail ? ` · ${item.detail}` : ''}`,
            color: 0x30A46C,
            timestamp,
          }] };
          try {
            if (await send(payload)) {
              record.alerted = false;
              record.downSince = null;
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
            }
          } catch {}
        }
      }
      state[item.id] = record;
    }
    await save();
  }

  return { evaluate };
}
