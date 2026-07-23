import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DAY_MS = 86_400_000;
const RETAIN_DAYS = 90;

// Long-term availability via per-day aggregates: one row per monitor per day,
// so 90-day SLA costs a few thousand rows instead of millions of raw points.
export async function createUptimeStore(options = {}) {
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? './data';
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'uptime.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS uptime_daily (
      id TEXT NOT NULL, day INTEGER NOT NULL,
      up INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      latency_sum INTEGER NOT NULL DEFAULT 0, latency_n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, day)
    );
  `);
  const upsert = db.prepare(`
    INSERT INTO uptime_daily (id, day, up, total, latency_sum, latency_n) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(id, day) DO UPDATE SET
      up = up + excluded.up, total = total + 1,
      latency_sum = latency_sum + excluded.latency_sum, latency_n = latency_n + excluded.latency_n
  `);
  const windowStmt = db.prepare('SELECT COALESCE(SUM(up),0) up, COALESCE(SUM(total),0) total, COALESCE(SUM(latency_sum),0) ls, COALESCE(SUM(latency_n),0) ln FROM uptime_daily WHERE id = ? AND day >= ?');

  function today() {
    return Math.floor(Date.now() / DAY_MS);
  }

  function record(items) {
    const day = today();
    db.exec('BEGIN');
    try {
      for (const item of items) {
        if (!item || !item.id) continue;
        const hasLatency = Number.isFinite(item.latencyMs);
        upsert.run(item.id, day, item.up ? 1 : 0, hasLatency ? Math.round(item.latencyMs) : 0, hasLatency ? 1 : 0);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    db.prepare('DELETE FROM uptime_daily WHERE day < ?').run(day - RETAIN_DAYS);
  }

  function windowFor(id, days) {
    const row = windowStmt.get(id, today() - (days - 1));
    if (!row.total) return null;
    return { uptime: (row.up / row.total) * 100, avgLatency: row.ln ? row.ls / row.ln : null };
  }

  function summary(ids) {
    const result = {};
    for (const id of ids) {
      result[id] = {
        d7: windowFor(id, 7),
        d30: windowFor(id, 30),
        d90: windowFor(id, 90),
      };
    }
    return result;
  }

  return { record, summary, windowFor };
}
