// AI gateway monitoring. Every production host runs its own gateway (see ai-gateway's
// hosts.json). For each enabled host the dashboard lists models on the listener it can reach
// and merges the report of the agent running on that host (local listener, alias mapping in
// its config, Codex credential, inference probe). The subscription usage windows belong to
// the account, so they are shown once, from whichever agent reads them (sky-mini).
// Only sanitized fields ever reach the public snapshot.

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
      detail: str(local.detail, 160) || '', target: str(local.target, 80),
      aliasesListed: Object.fromEntries(Object.entries(local.aliasesListed || {}).slice(0, 20).map(([alias, listed]) => [String(alias).slice(0, 60), listed === true])),
    },
    policy: raw.policy ? { revision: str(raw.policy.revision, 40), aliases: aliasMap(raw.policy.aliases) } : null,
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

const hostName = (value) => (typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,62}$/i.test(value) ? value : null);

// Parse AI_GATEWAYS_JSON: [{ name, url?, agent?, probeName?, route?, enabled?, note? }].
// `url` is the listener as this dashboard reaches it; `agent` is the remote agent id whose
// report carries that host's gateway block. Without the variable, fall back to the single
// sky-mini gateway behind AI_GATEWAY_URL.
export function parseGatewayHosts(json, legacyUrl = '') {
  let parsed = null;
  try { parsed = json ? JSON.parse(json) : null; } catch { parsed = null; }
  if (!Array.isArray(parsed)) {
    return [{ name: 'sky-mini', url: legacyUrl || null, agent: 'skylabmac', probeName: 'Tailnet listener', route: 'skyhong.tw → sky-mini :8318', enabled: true, note: null }];
  }
  return parsed.slice(0, 20).map((host) => ({
    name: hostName(host?.name),
    url: typeof host?.url === 'string' && /^https?:\/\//.test(host.url) ? host.url : null,
    agent: typeof host?.agent === 'string' && /^[a-z0-9-]{1,64}$/i.test(host.agent) ? host.agent : null,
    probeName: str(host?.probeName, 60) || 'Listener',
    route: str(host?.route, 120),
    enabled: host?.enabled !== false,
    note: str(host?.note, 200),
  })).filter((host) => host.name);
}

export function windowLabel(minutes) {
  if (minutes === 10_080) return 'Weekly window';
  if (minutes && minutes % 1_440 === 0) return `${minutes / 1_440}-day window`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return minutes ? `${minutes}-minute window` : 'Usage window';
}

const age = (at, now) => now - Date.parse(at || '');
const fresh = (at, now, limit) => { const ms = age(at, now); return Number.isFinite(ms) && ms <= limit; };

// Build the public snapshot. Each host carries its own `checks`; the top-level `checks` is the
// single flat list of pass/fail items that feeds alerts, the incident count, metrics, and the
// dashboard's attention list. Disabled hosts are listed but never produce a check.
export function buildGatewaySnapshot({ hosts, probes = {}, probeConfigured, reports = {}, now = Date.now() }) {
  const enabled = hosts.filter((host) => host.enabled);
  const hasReport = enabled.some((host) => reports[host.agent]?.report);
  if (!(probeConfigured && enabled.some((host) => host.url)) && !hasReport) return null;
  const isFresh = (entry) => Boolean(entry?.report) && fresh(entry.receivedAt, now, REPORT_STALE_MS);

  // The policy and the usage windows come from whichever agent reads them (sky-mini's has
  // model-policy.json and the codex CLI); prefer the most recent report.
  const byRecency = Object.values(reports).filter((entry) => entry?.report)
    .sort((a, b) => (Date.parse(b.receivedAt || '') || 0) - (Date.parse(a.receivedAt || '') || 0));
  const policy = byRecency.find((entry) => entry.report.policy?.revision)?.report.policy || { revision: null, aliases: {} };
  const usageEntry = byRecency.find((entry) => entry.report.usage);

  const snapshotHosts = hosts.map((host) => host.enabled
    ? hostSnapshot({ host, probe: probes[host.name], probeConfigured: probeConfigured && Boolean(host.url), entry: reports[host.agent], reportFresh: isFresh(reports[host.agent]), policy, now })
    : { name: host.name, enabled: false, note: host.note, listeners: [], aliases: [], credential: null, inference: null, checks: [] });

  const checks = snapshotHosts.flatMap((host) => host.checks);
  let usage = null;
  if (usageEntry) {
    const u = usageEntry.report.usage;
    const sourceFresh = isFresh(usageEntry);
    const usageFresh = sourceFresh && Boolean(u?.ok) && fresh(u.checkedAt, now, USAGE_STALE_MS);
    const windows = (u?.windows || []).map((window) => ({ ...window, label: windowLabel(window.windowMinutes), up: window.usedPercent < QUOTA_WARN_PERCENT }));
    usage = { fresh: usageFresh, checkedAt: u?.checkedAt || null, plan: u?.plan || null, accountMatches: u?.accountMatches ?? null, limitReached: Boolean(u?.limitReached), windows };
    // A silent agent is already one incident (its host's telemetry check); don't add a second.
    if (sourceFresh) {
      const detail = usageFresh ? `Read ${u.checkedAt}` : !u?.checkedAt ? (u?.detail || 'Usage not read yet') : !u.ok ? (u.detail || 'Usage read failed') : `Last read ${u.checkedAt}`;
      checks.push({ id: 'gateway:quota-telemetry', name: 'AI gateway · subscription usage telemetry', up: usageFresh, detail });
    }
    if (usageFresh) {
      if (u.accountMatches === false) checks.push({ id: 'gateway:quota-account', name: 'AI gateway · usage account', up: false, detail: 'Usage was read for a different account than the gateway credential' });
      for (const window of windows) {
        const resets = window.resetsAt ? ` · resets ${window.resetsAt}` : '';
        checks.push({ id: `gateway:quota:${window.id}`, name: `AI gateway · ${window.label.toLowerCase()}`, up: window.up && !u.limitReached, detail: `${window.usedPercent}% used${resets}` });
      }
    }
  }

  return { configured: true, revision: policy.revision, hosts: snapshotHosts, usage, checks };
}

function hostSnapshot({ host, probe, probeConfigured, entry, reportFresh, policy, now }) {
  const report = entry?.report || null;
  const prefix = `gateway:${host.name}`;
  const label = (what) => `AI gateway · ${host.name} · ${what}`;
  const checks = [];
  const listeners = [];

  if (probeConfigured) {
    const listener = { id: 'probe', name: host.probeName, source: host.route || `status → ${host.name}`,
      up: Boolean(probe?.up), latencyMs: probe?.latencyMs ?? null, detail: probe?.detail || 'Not checked yet' };
    listeners.push(listener);
    checks.push({ id: `${prefix}:probe`, name: label(host.probeName.toLowerCase()), up: listener.up, detail: listener.detail });
  }
  if (host.agent) {
    const detail = reportFresh ? `Reported ${entry.receivedAt}` : report ? `${host.agent} agent last reported ${entry.receivedAt}` : `${host.agent} agent has not reported gateway telemetry`;
    checks.push({ id: `${prefix}:telemetry`, name: label('host telemetry'), up: reportFresh, detail });
  }
  if (reportFresh) {
    const local = { id: 'local', name: 'Local listener', source: `${host.name} → ${report.local.target || 'local'}`,
      up: report.local.up, latencyMs: report.local.latencyMs, detail: report.local.detail };
    listeners.push(local);
    checks.push({ id: `${prefix}:local`, name: label('local listener'), up: local.up, detail: local.detail });
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
    if (isListed !== null || configMatches !== null) checks.push({ id: `${prefix}:alias:${alias}`, name: label(`${alias} alias`), up, detail });
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
    if (reportFresh) checks.push({ id: `${prefix}:credential`, name: label('Codex credential'), up, detail });
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
    if (reportFresh && isFresh) checks.push({ id: `${prefix}:inference`, name: label('inference probe'), up, detail });
  }

  return {
    name: host.name, enabled: true, note: host.note, agent: host.agent,
    reportReceivedAt: entry?.receivedAt || null, reportFresh, configRevisionMatches,
    listeners, aliases, credential, inference, checks,
  };
}

// Earlier releases stored one report as { receivedAt, report }; that was sky-mini's agent.
export function migrateGatewayReports(stored) {
  if (!stored || typeof stored !== 'object') return {};
  if (stored.report && typeof stored.report === 'object') return { skylabmac: stored };
  return stored;
}
