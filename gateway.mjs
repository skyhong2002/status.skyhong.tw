// AI gateway monitoring. The dashboard probes the gateway's tailnet listener itself and
// merges a report from the sky-mini agent (local listener, model policy, Codex credential,
// and subscription usage windows). Only sanitized fields ever reach the public snapshot.

export const QUOTA_WARN_PERCENT = 90;
const REPORT_STALE_MS = 3 * 60_000; // the agent reports every 60 s
const USAGE_STALE_MS = 20 * 60_000; // the agent re-reads usage every 5 min
const INFERENCE_STALE_MS = 90 * 60_000; // the agent runs one tiny inference every 30 min

export async function probeGateway({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 8_000 }) {
  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return { checkedAt, up: false, statusCode: response.status, latencyMs, detail: `HTTP ${response.status}`, models: [] };
    const body = await response.json();
    const models = (Array.isArray(body?.data) ? body.data : []).map((model) => String(model?.id || '')).filter(Boolean);
    return { checkedAt, up: true, statusCode: response.status, latencyMs, detail: `${models.length} models listed`, models };
  } catch (error) {
    const detail = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Timed out' : 'Unreachable';
    return { checkedAt, up: false, statusCode: null, latencyMs: Date.now() - startedAt, detail, models: [] };
  }
}

const str = (value, max = 120) => (typeof value === 'string' ? value.slice(0, max) : null);
const num = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => (Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : null);
const iso = (value) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const status = (value) => (Number.isInteger(value) && value >= 100 && value <= 599 ? value : null);

export function maskAccount(value) {
  const text = str(value, 200);
  if (!text) return null;
  const [local, domain] = text.split('@');
  if (!domain) return `${text.slice(0, 1)}••`;
  return `${local.slice(0, 1)}••@${domain}`;
}

function aliasMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20)
    .filter(([alias, model]) => typeof alias === 'string' && typeof model === 'string')
    .map(([alias, model]) => [alias.slice(0, 60), model.slice(0, 80)]));
}

// Validate the agent's gateway block. Anything unexpected is dropped rather than echoed.
export function sanitizeGatewayReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const local = raw.local || {};
  const credential = raw.credential || {};
  const inference = raw.inference || null;
  const usage = raw.usage || null;
  return {
    checkedAt: iso(raw.checkedAt),
    local: {
      up: local.up === true, statusCode: status(local.statusCode), latencyMs: num(local.latencyMs, 0, 60_000),
      detail: str(local.detail, 160) || '',
      aliasesListed: Object.fromEntries(Object.entries(local.aliasesListed || {}).slice(0, 20).map(([alias, listed]) => [String(alias).slice(0, 60), listed === true])),
    },
    policy: { revision: str(raw.policy?.revision, 40), aliases: aliasMap(raw.policy?.aliases) },
    config: { revision: str(raw.config?.revision, 40), aliases: aliasMap(raw.config?.aliases) },
    credential: {
      present: credential.present === true, disabled: credential.disabled === true, refreshable: credential.refreshable === true,
      account: maskAccount(credential.account), plan: str(credential.plan, 30),
      accessExpiresAt: iso(credential.accessExpiresAt), lastRefreshAt: iso(credential.lastRefreshAt),
    },
    inference: inference && typeof inference === 'object' ? {
      checkedAt: iso(inference.checkedAt), ok: inference.ok === true, statusCode: status(inference.statusCode),
      alias: str(inference.alias, 60), model: str(inference.model, 80), latencyMs: num(inference.latencyMs, 0, 600_000),
      detail: str(inference.detail, 160) || '',
    } : null,
    usage: usage && typeof usage === 'object' ? {
      checkedAt: iso(usage.checkedAt), ok: usage.ok === true, detail: str(usage.detail, 160) || '',
      plan: str(usage.plan, 30), accountMatches: typeof usage.accountMatches === 'boolean' ? usage.accountMatches : null,
      limitReached: usage.limitReached === true,
      windows: (Array.isArray(usage.windows) ? usage.windows : []).slice(0, 4).map((window) => ({
        id: str(window?.id, 30) || 'window', usedPercent: num(window?.usedPercent, 0, 100),
        windowMinutes: num(window?.windowMinutes, 0, 525_600), resetsAt: iso(window?.resetsAt),
      })).filter((window) => window.usedPercent != null),
    } : null,
  };
}

export function windowLabel(minutes) {
  if (minutes === 10_080) return 'Weekly window';
  if (minutes && minutes % 1_440 === 0) return `${minutes / 1_440}-day window`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return minutes ? `${minutes}-minute window` : 'Usage window';
}

const age = (at, now) => now - Date.parse(at || '');
const fresh = (at, now, limit) => { const ms = age(at, now); return Number.isFinite(ms) && ms <= limit; };

// Build the public snapshot. `checks` is the single list of pass/fail items that feeds
// alerts, the incident count, metrics, and the dashboard's attention list.
export function buildGatewaySnapshot({ probe, probeConfigured, report, receivedAt, now = Date.now() }) {
  if (!probeConfigured && !report) return null;
  const reportFresh = Boolean(report) && fresh(receivedAt, now, REPORT_STALE_MS);
  const policy = report?.policy || { revision: null, aliases: {} };
  const checks = [];
  const listeners = [];

  if (probeConfigured) {
    const tailnet = { id: 'tailnet', name: 'Tailnet listener', source: 'skyhong.tw → sky-mini :8318',
      up: Boolean(probe?.up), latencyMs: probe?.latencyMs ?? null, detail: probe?.detail || 'Not checked yet' };
    listeners.push(tailnet);
    checks.push({ id: 'gateway:tailnet', name: 'AI gateway · tailnet listener', up: tailnet.up, detail: tailnet.detail });
  }
  if (reportFresh) {
    const local = { id: 'local', name: 'Local listener', source: 'sky-mini → 127.0.0.1:8317',
      up: report.local.up, latencyMs: report.local.latencyMs, detail: report.local.detail };
    listeners.push(local);
    checks.push({ id: 'gateway:local', name: 'AI gateway · local listener', up: local.up, detail: local.detail });
  }

  const listed = probeConfigured && probe?.up ? new Set(probe.models) : null;
  const aliases = Object.entries(policy.aliases).map(([alias, model]) => {
    const isListed = listed ? listed.has(alias) : reportFresh && report.local.up ? report.local.aliasesListed[alias] === true : null;
    const configModel = report?.config?.aliases?.[alias] ?? null;
    const configMatches = report ? configModel === model : null;
    let detail = `→ ${model}`;
    if (isListed === false) detail = 'Not listed by the gateway';
    else if (configMatches === false) detail = configModel ? `Gateway maps to ${configModel}; policy says ${model}` : 'Missing from gateway config';
    const up = isListed !== false && configMatches !== false;
    if (isListed !== null || configMatches !== null) checks.push({ id: `gateway:alias:${alias}`, name: `AI gateway · ${alias} alias`, up, detail });
    return { alias, model, listed: isListed, configMatches, up, detail };
  });
  const configRevisionMatches = report?.config?.revision && policy.revision ? report.config.revision === policy.revision : null;

  let credential = null;
  if (report) {
    const c = report.credential;
    const accessExpired = Number.isFinite(Date.parse(c.accessExpiresAt || '')) && Date.parse(c.accessExpiresAt) < now;
    const inferenceAuthFailed = report.inference && !report.inference.ok && [401, 403].includes(report.inference.statusCode);
    let detail = c.lastRefreshAt ? `Refreshed ${c.lastRefreshAt}` : 'Credential present';
    if (!c.present) detail = 'No Codex OAuth credential on the gateway';
    else if (c.disabled) detail = 'Credential is disabled';
    else if (!c.refreshable) detail = 'Credential has no refresh token';
    else if (accessExpired) detail = 'Access token expired and was not refreshed';
    else if (inferenceAuthFailed) detail = `Upstream rejected the credential (HTTP ${report.inference.statusCode})`;
    const up = c.present && !c.disabled && c.refreshable && !accessExpired && !inferenceAuthFailed;
    credential = { up, account: c.account, plan: c.plan, lastRefreshAt: c.lastRefreshAt, accessExpiresAt: c.accessExpiresAt, detail };
    if (reportFresh) checks.push({ id: 'gateway:credential', name: 'AI gateway · Codex credential', up, detail });
  }

  let inference = null;
  if (report?.inference?.checkedAt) {
    const i = report.inference;
    const expected = i.alias ? policy.aliases[i.alias] : null;
    const resolvedMatches = !i.ok || !expected || !i.model || i.model === expected;
    const up = i.ok && resolvedMatches;
    const detail = !i.ok ? (i.detail || 'Inference failed') : !resolvedMatches ? `${i.alias} answered as ${i.model}; policy says ${expected}` : `${i.alias} → ${i.model}`;
    const isFresh = fresh(i.checkedAt, now, INFERENCE_STALE_MS);
    inference = { up, fresh: isFresh, checkedAt: i.checkedAt, alias: i.alias, model: i.model, latencyMs: i.latencyMs, detail };
    if (reportFresh && isFresh) checks.push({ id: 'gateway:inference', name: 'AI gateway · inference probe', up, detail });
  }

  let usage = null;
  if (report) {
    const u = report.usage;
    const usageFresh = reportFresh && Boolean(u?.ok) && fresh(u.checkedAt, now, USAGE_STALE_MS);
    const windows = (u?.windows || []).map((window) => ({ ...window, label: windowLabel(window.windowMinutes), up: window.usedPercent < QUOTA_WARN_PERCENT }));
    usage = { fresh: usageFresh, checkedAt: u?.checkedAt || null, plan: u?.plan || null, accountMatches: u?.accountMatches ?? null, limitReached: Boolean(u?.limitReached), windows };
    const staleDetail = !reportFresh ? 'sky-mini agent has not reported' : !u?.checkedAt ? (u?.detail || 'Usage not read yet') : !u.ok ? (u.detail || 'Usage read failed') : `Last read ${u.checkedAt}`;
    checks.push({ id: 'gateway:quota-telemetry', name: 'AI gateway · subscription usage telemetry', up: usageFresh, detail: usageFresh ? `Read ${u.checkedAt}` : staleDetail });
    if (usageFresh) {
      if (u.accountMatches === false) checks.push({ id: 'gateway:quota-account', name: 'AI gateway · usage account', up: false, detail: 'Usage was read for a different account than the gateway credential' });
      for (const window of windows) {
        const resets = window.resetsAt ? ` · resets ${window.resetsAt}` : '';
        checks.push({ id: `gateway:quota:${window.id}`, name: `AI gateway · ${window.label.toLowerCase()}`, up: window.up && !u.limitReached, detail: `${window.usedPercent}% used${resets}` });
      }
    }
  }

  return {
    configured: true,
    revision: policy.revision,
    configRevisionMatches,
    reportReceivedAt: receivedAt || null,
    reportFresh,
    listeners,
    aliases,
    credential,
    inference,
    usage,
    checks,
  };
}
