#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

const envPath = process.argv[2] || '.env';
const examplePath = process.argv[3] || '.env.example';

function parse(text) {
  return new Map(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

function replace(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
}

let envText = await readFile(envPath, 'utf8');
const current = parse(envText);
const example = parse(await readFile(examplePath, 'utf8'));

for (const key of ['STATUS_TARGETS_JSON', 'HEARTBEATS_JSON']) {
  const value = example.get(key);
  if (!value) throw new Error(`${key} missing from ${examplePath}`);
  envText = replace(envText, key, value);
  current.set(key, value);
}

if (!current.get('HEARTBEAT_TOKEN')) {
  const token = randomBytes(32).toString('hex');
  envText = replace(envText, 'HEARTBEAT_TOKEN', token);
  current.set('HEARTBEAT_TOKEN', token);
}

if (!current.get('DISCORD_WEBHOOK_URL')) {
  const incidentWebhook = current.get('DISCORD_ALERT_WEBHOOK_URL');
  if (!incidentWebhook) throw new Error('DISCORD_ALERT_WEBHOOK_URL is not configured');
  envText = replace(envText, 'DISCORD_WEBHOOK_URL', incidentWebhook);
  current.set('DISCORD_WEBHOOK_URL', incidentWebhook);
}

const temporary = `${envPath}.tmp`;
await writeFile(temporary, envText, { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, envPath);

console.log(JSON.stringify({
  targetsConfigured: JSON.parse(current.get('STATUS_TARGETS_JSON')).length,
  heartbeatsConfigured: JSON.parse(current.get('HEARTBEATS_JSON')).length,
  heartbeatTokenConfigured: Boolean(current.get('HEARTBEAT_TOKEN')),
  usageWebhookConfigured: Boolean(current.get('DISCORD_WEBHOOK_URL')),
  incidentWebhookConfigured: Boolean(current.get('DISCORD_ALERT_WEBHOOK_URL')),
}));
