import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const GROUPS = ['project_id', 'api_key_id', 'model', 'service_tier'];
const COST_GROUPS = ['project_id', 'api_key_id', 'line_item'];

function jsonEnv(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function shortId(value, prefix) {
  if (!value) return `Unknown ${prefix}`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function matchesModel(model, patterns) {
  const normalized = String(model || '').toLowerCase();
  return patterns.some((pattern) => {
    const candidate = String(pattern).toLowerCase();
    if (candidate.startsWith('*') && candidate.endsWith('*')) return normalized.includes(candidate.slice(1, -1));
    if (candidate.endsWith('*')) return normalized.startsWith(candidate.slice(0, -1));
    return normalized === candidate;
  });
}

function poolForUsage(model, serviceTier, highModels, miniModels) {
  const normalizedTier = String(serviceTier || '').toLowerCase();
  if (normalizedTier) {
    if (!normalizedTier.includes('incentivized')) return 'billable';
    return matchesModel(model, miniModels) ? 'mini' : 'high';
  }
  if (matchesModel(model, miniModels)) return 'mini';
  if (matchesModel(model, highModels)) return 'high';
  return 'billable';
}

function zonedDayStart(date, timeZone) {
  const wanted = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const target = Date.UTC(wanted.year, wanted.month - 1, wanted.day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += target - represented;
  }
  return Math.floor(guess / 1000);
}

// Fraction of the reporting day still ahead: 1 at local midnight, 0.5 with 12h left, 1/24 with 1h left.
// The free pools reset daily, so this doubles as the even-pace share of each pool that should remain unspent.
function dayRemainingFraction(dayStartSeconds, nowMs = Date.now()) {
  const elapsed = (nowMs / 1000 - dayStartSeconds) / 86_400;
  return Math.min(1, Math.max(0, 1 - elapsed));
}

async function fetchPages(path, params, apiKey) {
  const buckets = [];
  let page;
  do {
    const url = new URL(`https://api.openai.com/v1/${path}`);
    for (const [key, value] of Object.entries(params)) {
      for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(entry));
    }
    if (page) url.searchParams.set('page', page);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `OpenAI ${path} returned ${response.status}`);
    buckets.push(...(payload.data || []));
    page = payload.has_more ? payload.next_page : null;
  } while (page);
  return buckets;
}

export async function createUsageMonitor(options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_ADMIN_KEY;
  if (!apiKey) return null;
  const dataDir = options.dataDir || process.env.DATA_DIR || './data';
  const timeZone = options.timeZone || process.env.OPENAI_USAGE_TIMEZONE || 'Asia/Taipei';
  const highModels = jsonEnv(process.env.OPENAI_FREE_HIGH_MODELS_JSON, []);
  const miniModels = jsonEnv(process.env.OPENAI_FREE_MINI_MODELS_JSON, ['*mini*', '*nano*']);
  const keyLabels = jsonEnv(process.env.OPENAI_KEY_LABELS_JSON, {});
  const projectLabels = jsonEnv(process.env.OPENAI_PROJECT_LABELS_JSON, {});
  const highLimit = Number(process.env.OPENAI_HIGH_POOL_LIMIT || 250_000);
  const miniLimit = Number(process.env.OPENAI_MINI_POOL_LIMIT || 2_500_000);
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'usage.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      bucket_start INTEGER NOT NULL, bucket_end INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '', api_key_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', service_tier TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
      collected_at INTEGER NOT NULL,
      PRIMARY KEY (bucket_start, project_id, api_key_id, model, service_tier)
    );
    CREATE TABLE IF NOT EXISTS cost_snapshots (
      bucket_start INTEGER NOT NULL, bucket_end INTEGER NOT NULL,
      project_id TEXT NOT NULL DEFAULT '', api_key_id TEXT NOT NULL DEFAULT '',
      line_item TEXT NOT NULL DEFAULT '', amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'usd', collected_at INTEGER NOT NULL,
      PRIMARY KEY (bucket_start, project_id, api_key_id, line_item, currency)
    );
    CREATE TABLE IF NOT EXISTS alert_log (
      alert_key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL
    );
  `);

  const upsertUsage = db.prepare(`
    INSERT INTO usage_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket_start, project_id, api_key_id, model, service_tier) DO UPDATE SET
      bucket_end=excluded.bucket_end, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens, cached_input_tokens=excluded.cached_input_tokens,
      requests=excluded.requests, collected_at=excluded.collected_at
  `);
  const upsertCost = db.prepare(`
    INSERT INTO cost_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket_start, project_id, api_key_id, line_item, currency) DO UPDATE SET
      bucket_end=excluded.bucket_end, amount=excluded.amount, collected_at=excluded.collected_at
  `);
  let lastSyncAt = null;
  let lastError = null;

  function poolFor(model, serviceTier) {
    return poolForUsage(model, serviceTier, highModels, miniModels);
  }

  function summary() {
    const today = zonedDayStart(new Date(), timeZone);
    const totals = db.prepare(`SELECT COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output,
      COALESCE(SUM(requests),0) requests FROM usage_snapshots WHERE bucket_start >= ?`).get(today);
    const utcDay = Math.floor(Date.now() / 86_400_000) * 86_400;
    const cost = db.prepare('SELECT COALESCE(SUM(amount),0) amount, COALESCE(MAX(currency),\'usd\') currency FROM cost_snapshots WHERE bucket_start >= ?').get(utcDay);
    const byModel = db.prepare(`SELECT model, service_tier serviceTier, SUM(input_tokens) input, SUM(output_tokens) output, SUM(requests) requests
      FROM usage_snapshots WHERE bucket_start >= ? GROUP BY model, service_tier ORDER BY input + output DESC`).all(today)
      .map((row) => ({ ...row, pool: poolFor(row.model, row.serviceTier), tokens: row.input + row.output }));
    const usedKeys = db.prepare(`SELECT api_key_id id, SUM(input_tokens) input, SUM(output_tokens) output, SUM(requests) requests
      FROM usage_snapshots WHERE bucket_start >= ? GROUP BY api_key_id ORDER BY input + output DESC`).all(today).map((row) => ({ ...row, name: keyLabels[row.id] || shortId(row.id, 'key'), tokens: row.input + row.output }));
    const byKey = [...usedKeys, ...Object.entries(keyLabels).filter(([id]) => !usedKeys.some((row) => row.id === id)).map(([id, name]) => ({ id, name, input: 0, output: 0, requests: 0, tokens: 0 }))];
    const byProject = db.prepare(`SELECT project_id id, SUM(input_tokens) input, SUM(output_tokens) output, SUM(requests) requests
      FROM usage_snapshots WHERE bucket_start >= ? GROUP BY project_id ORDER BY input + output DESC`).all(today).map((row) => ({ ...row, name: projectLabels[row.id] || shortId(row.id, 'project'), tokens: row.input + row.output }));
    const byTier = db.prepare(`SELECT service_tier name, SUM(input_tokens + output_tokens) tokens, SUM(requests) requests
      FROM usage_snapshots WHERE bucket_start >= ? GROUP BY service_tier ORDER BY tokens DESC`).all(today);
    const trendStart = Math.floor(Date.now() / 1000) - 86_400;
    const trend = db.prepare(`SELECT bucket_start start, SUM(input_tokens + output_tokens) tokens, SUM(requests) requests
      FROM usage_snapshots WHERE bucket_start >= ? GROUP BY bucket_start ORDER BY bucket_start`).all(trendStart);
    const used = (pool) => byModel.filter((row) => row.pool === pool).reduce((sum, row) => sum + row.tokens, 0);
    // Share of the reporting day still ahead. The free pools reset at local midnight, so an
    // even-paced day should have this fraction of each pool still unspent.
    const dayRemaining = dayRemainingFraction(today, Date.now());
    const pools = [
      { id: 'high', name: 'High-tier pool', used: used('high'), limit: highLimit },
      { id: 'mini', name: 'Mini / nano pool', used: used('mini'), limit: miniLimit },
    ].map((pool) => ({
      ...pool,
      remaining: Math.max(0, pool.limit - pool.used),
      percent: pool.limit ? (pool.used / pool.limit) * 100 : 0,
      paceRemaining: Math.round(dayRemaining * pool.limit),
    }));
    return {
      id: 'openai', name: 'OpenAI organization', connected: !lastError, detail: lastError || 'Organization Usage API',
      input: totals.input, output: totals.output, requests: totals.requests, cost: cost.amount, currency: cost.currency,
      pools, byModel, byKey, byProject, byTier, trend, timeZone, lastSyncAt,
      dayRemaining, dayRemainingHours: dayRemaining * 24,
      possibleBillable: byModel.filter((row) => row.pool === 'billable'),
    };
  }

  async function sendAlerts() {
    if (!webhookUrl) return;
    const current = summary();
    const day = zonedDayStart(new Date(), timeZone);
    for (const pool of current.pools) {
      for (const threshold of [70, 85, 95]) {
        if (pool.percent < threshold) continue;
        const alertKey = `${day}:${pool.id}:${threshold}`;
        if (db.prepare('SELECT 1 FROM alert_log WHERE alert_key=?').get(alertKey)) continue;
        const response = await fetch(webhookUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ content: `OpenAI estimated free pool alert: ${pool.name} is ${pool.percent.toFixed(1)}% used (${pool.used.toLocaleString()} / ${pool.limit.toLocaleString()} tokens).` }),
        });
        if (response.ok) db.prepare('INSERT INTO alert_log VALUES (?, ?)').run(alertKey, Math.floor(Date.now() / 1000));
      }
    }
  }

  async function sync() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const currentHour = Math.floor(now / 3600) * 3600;
      const usageStart = currentHour - 47 * 3600;
      const costStart = zonedDayStart(new Date(Date.now() - 7 * 86_400_000), timeZone);
      const [usageBuckets, costBuckets] = await Promise.all([
        fetchPages('organization/usage/completions', { start_time: usageStart, end_time: now, bucket_width: '1h', limit: 48, group_by: GROUPS }, apiKey),
        fetchPages('organization/costs', { start_time: costStart, bucket_width: '1d', limit: 9, group_by: COST_GROUPS }, apiKey),
      ]);
      const collectedAt = Math.floor(Date.now() / 1000);
      db.exec('BEGIN');
      try {
        for (const bucket of usageBuckets) for (const item of bucket.results || []) upsertUsage.run(
          bucket.start_time, bucket.end_time, item.project_id || '', item.api_key_id || '', item.model || '', item.service_tier || '',
          item.input_tokens || 0, item.output_tokens || 0, item.input_cached_tokens || 0, item.num_model_requests || 0, collectedAt,
        );
        for (const bucket of costBuckets) for (const item of bucket.results || []) upsertCost.run(
          bucket.start_time, bucket.end_time, item.project_id || '', item.api_key_id || '', item.line_item || '',
          Number(item.amount?.value || 0), item.amount?.currency || 'usd', collectedAt,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      lastSyncAt = new Date().toISOString();
      lastError = null;
      await sendAlerts();
      return summary();
    } catch (error) {
      lastError = String(error.message || error).slice(0, 240);
      return summary();
    }
  }

  return { sync, summary };
}

export { dayRemainingFraction, jsonEnv, matchesModel, poolForUsage, zonedDayStart };
