const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = (value) => new Intl.NumberFormat().format(Number(value || 0));
const HOUR = 3_600_000;
const BINS = 48;
const LIST_LIMIT = 8;

// ---------- theme ----------
const theme = {
  key: 'sky-status-theme',
  resolve() {
    const stored = localStorage.getItem(this.key);
    return stored === 'light' || stored === 'dark' ? stored : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  },
  apply(value) { document.documentElement.dataset.theme = value; },
  toggle() {
    const next = this.resolve() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(this.key, next);
    this.apply(next);
  },
};
theme.apply(theme.resolve());
$('theme-toggle').addEventListener('click', () => theme.toggle());

// ---------- helpers ----------
function freshness(receivedAt) {
  return receivedAt && Date.now() - new Date(receivedAt).getTime() < 180_000;
}

function remoteItems(agents) {
  return Object.entries(agents || {}).filter(([id]) => id !== 'omni-probe').flatMap(([id, agent]) => (agent.items || []).map((item) => ({
    ...item,
    id: `${id}:${item.id}`,
    host: agent.host || id,
    fresh: Boolean(freshness(agent.receivedAt)),
    receivedAt: agent.receivedAt,
    up: Boolean(freshness(agent.receivedAt) && item.up),
    detail: freshness(agent.receivedAt) ? item.detail : `Agent has not checked in · last report ${ago(agent.receivedAt)}`,
  })));
}

function pct(value) {
  if (value == null) return '—';
  return `${value.toFixed(value >= 99.995 ? 0 : 2)}%`;
}

function ago(at) {
  const ms = Date.now() - Date.parse(at || '');
  if (!Number.isFinite(ms)) return 'never';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function until(at) {
  const ms = Date.parse(at || '') - Date.now();
  if (!Number.isFinite(ms)) return '';
  const hours = Math.max(0, ms / HOUR);
  return hours >= 24 ? `in ${Math.floor(hours / 24)} d ${Math.round(hours % 24)} h` : hours >= 1 ? `in ${hours.toFixed(1)} h` : `in ${Math.round(hours * 60)} min`;
}

const timeFormat = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const localTimes = (text) => String(text || '').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (stamp) => new Date(stamp).toLocaleString());

function pill(cls, label) {
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function stateClass(up) {
  return up === null ? 'off' : up ? '' : 'down';
}

// Toggle state survives a re-render: remember which <details> and "show more" lists are open.
const openDetails = new Set();
const expandedLists = new Set();
document.addEventListener('toggle', (event) => {
  if (event.target.tagName === 'DETAILS' && event.target.id) event.target.open ? openDetails.add(event.target.id) : openDetails.delete(event.target.id);
}, true);
document.addEventListener('click', (event) => {
  const button = event.target.closest('button.more');
  if (!button) return;
  const list = button.closest('.list');
  expandedLists.add(list.id);
  list.querySelectorAll('.row.hidden-row').forEach((row) => row.classList.remove('hidden-row'));
  button.remove();
});

function renderList(id, rows, emptyText) {
  const list = $(id);
  if (!rows.length) { list.innerHTML = `<div class="empty">${esc(emptyText)}</div>`; return; }
  const collapsed = !expandedLists.has(id) && rows.length > LIST_LIMIT + 2;
  const html = rows.map((row, index) => collapsed && index >= LIST_LIMIT ? row.replace('class="row', 'class="row hidden-row') : row).join('');
  list.innerHTML = html + (collapsed ? `<button class="more" type="button">Show ${rows.length - LIST_LIMIT} more</button>` : '');
}

// ---------- 24h history bars ----------
function historyFor(id, history) {
  const entry = history?.[id];
  if (!entry) return { bars: new Array(BINS).fill('empty'), uptime: null };
  const bars = entry.bars.split('').map((state) => state === '2' ? 'down' : state === '1' ? 'up' : 'empty');
  return { bars, uptime: entry.uptime };
}

function barsHtml(bars, now) {
  const start = now - 24 * HOUR;
  const width = (24 * HOUR) / BINS;
  return `<div class="bars" aria-label="24 hour status history">${bars.map((status, index) => {
    const from = new Date(start + index * width);
    const to = new Date(start + (index + 1) * width);
    const label = status === 'up' ? 'All checks passed' : status === 'down' ? 'At least one check failed' : 'No data';
    return `<i class="${status}" title="${timeFormat.format(from)}–${timeFormat.format(to)} · ${label}"></i>`;
  }).join('')}</div>`;
}

// ---------- products ----------
function statusLabel(target) {
  if (!target.up) return { cls: 'down', text: target.id.startsWith('omni-') && !target.statusCode ? 'Probe unreachable' : 'Unavailable' };
  if (target.degraded) return { cls: 'warn', text: 'Degraded' };
  return { cls: '', text: 'Operational' };
}

function slaSummary(target, data) {
  const history = historyFor(target.id, data.history24h);
  const day = history.uptime === null ? '—' : pct(history.uptime);
  const windows = (data.uptime || {})[target.id] || {};
  const preferred = windows.d30?.uptime != null ? windows.d30 : windows.d7;
  const long = preferred?.uptime != null ? pct(preferred.uptime) : null;
  const label = preferred?.complete ? `${preferred.windowDays} d` : `${preferred?.observedDays || 0} d observed`;
  const windowTip = (window) => window?.uptime == null ? '—' : `${pct(window.uptime)} (${window.observedDays || 0}/${window.windowDays || 0} d observed)`;
  const tip = `24 h ${day} · 7 d ${windowTip(windows.d7)} · 30 d ${windowTip(windows.d30)} · 90 d ${windowTip(windows.d90)}`;
  return { bars: history.bars, value: long || day, label: long ? label : '24 h', tip };
}

function monitorRow(target, data, now, nested = false) {
  const sla = slaSummary(target, data);
  const label = statusLabel(target);
  const sub = target.degraded && target.degradedReason
    ? target.degradedReason
    : target.statusCode ? `HTTP ${target.statusCode} · ${target.detail || 'OK'}` : (target.detail || '—');
  return `<article class="monitor${nested ? ' nested' : ''}">
    <div class="monitor-name"><a href="${esc(target.url)}" rel="noopener">${esc(target.name)}</a><span title="${esc(sub)}">${esc(sub)}</span></div>
    ${barsHtml(sla.bars, now)}
    <div class="metric latency"><strong>${number(target.latencyMs)} ms</strong><span>response</span></div>
    <div class="metric uptime" title="${esc(sla.tip)}"><strong>${esc(sla.value)}</strong><span>${esc(sla.label)}</span></div>
    ${pill(label.cls, label.text)}
  </article>`;
}

function renderProducts(data, now) {
  const isOmni = (target) => target.id.startsWith('omni-');
  const targets = data.targets.filter((target) => !isOmni(target));
  const groups = [...new Set(targets.map((target) => target.group || 'Other'))];
  $('product-list').innerHTML = groups.map((group) => {
    const members = targets.filter((target) => (target.group || 'Other') === group);
    const healthy = members.filter((target) => target.up && !target.degraded).length;
    const title = groups.length > 1 ? `<div class="group-title"><span>${esc(group)}</span><b>${healthy}/${members.length} operational</b></div>` : '';
    return title + members.map((target) => monitorRow(target, data, now)).join('');
  }).join('') || '<div class="empty">No public targets configured.</div>';

  const omni = data.targets.filter(isOmni);
  const unreachable = omni.filter((target) => !target.up && !target.statusCode).length;
  const healthy = omni.filter((target) => target.up && !target.degraded).length;
  const allHealthy = omni.length > 0 && healthy === omni.length;
  const status = allHealthy ? 'Operational' : unreachable === omni.length ? 'Probe unreachable' : 'Needs attention';
  const bars = omni.length ? historyFor(omni[0].id, data.history24h).bars.map((_, index) => {
    const states = omni.map((target) => historyFor(target.id, data.history24h).bars[index]);
    return states.includes('down') ? 'down' : states.includes('up') ? 'up' : 'empty';
  }) : new Array(BINS).fill('empty');
  const notices = [
    unreachable ? '<p class="notice">監控主機無法連到部分端點；這不等於已確認服務本身故障。</p>' : '',
    data.omniNetworkPath && !data.omniNetworkPath.up ? '<p class="notice">skyhong.tw → 國網的公開路徑仍無法連線；上述服務狀態由 skyhong.tw 經專用 SSH 通道直接檢查。</p>' : '',
  ].join('');
  $('omni-list').innerHTML = omni.length ? `<article class="monitor">
      <div class="monitor-name"><a href="https://omni.observe.tw/" rel="noopener">OmniObserve</a><span>${healthy}/${omni.length} checks healthy across production, development and infrastructure</span></div>
      ${barsHtml(bars, now)}
      <div class="metric latency"><strong>${healthy}/${omni.length}</strong><span>endpoints</span></div>
      <div class="metric uptime"><strong>${number(Math.round(omni.reduce((sum, target) => sum + (target.latencyMs || 0), 0) / omni.length))} ms</strong><span>avg response</span></div>
      ${pill(allHealthy ? '' : 'down', status)}
    </article>
    <details id="omni-details" ${openDetails.has('omni-details') ? 'open' : ''}>
      <summary class="details-toggle">Environment details · ${omni.length} endpoints</summary>
      ${notices}
      ${omni.map((target) => monitorRow(target, data, now, true)).join('')}
    </details>` : '<div class="empty">No OmniObserve probes configured.</div>';
}

// ---------- generic rows ----------
function meterHtml(detail) {
  const match = /(\d{1,3})%\s*used/.exec(detail || '');
  if (!match) return '';
  const value = Math.min(100, Number(match[1]));
  const level = value >= 90 ? 'bad' : value >= 75 ? 'warn' : '';
  return `<i class="meter" title="${value}% used"><b class="${level}" style="width:${value}%"></b></i>`;
}

function row(name, sub, up, label, options = {}) {
  const tag = options.tag ? `<em class="tag">${esc(options.tag)}</em>` : '';
  return `<div class="row"><div><strong>${esc(name)}</strong><span title="${esc(sub)}">${tag}${esc(sub)}</span></div><div class="row-right">${options.meter || ''}${pill(stateClass(up), label)}</div></div>`;
}

function setCount(id, up, total) {
  const element = $(id);
  element.textContent = `${up}/${total}`;
  element.classList.toggle('bad', up < total);
}

function renderInfrastructure(data, remote) {
  const services = [...data.services].sort((a, b) => Number(a.up) - Number(b.up) || a.name.localeCompare(b.name));
  renderList('docker-list', services.map((item) => row(item.name, item.detail, item.up, item.up ? 'Running' : 'Down', { tag: item.kind === 'Swarm service' ? 'swarm' : 'container' })), 'No Docker data.');
  const hosts = [...new Set(remote.map((item) => item.host))];
  const rows = hosts.flatMap((host) => {
    const items = remote.filter((item) => item.host === host).sort((a, b) => Number(a.up) - Number(b.up));
    const healthy = items.filter((item) => item.up).length;
    return [
      `<div class="group-title"><span>${esc(host)}</span><b>${healthy}/${items.length}</b></div>`,
      ...items.map((item) => row(item.name, item.detail, item.up, item.up ? 'Running' : 'Down', { tag: item.kind === 'Host metric' ? 'host' : null, meter: item.kind === 'Host metric' ? meterHtml(item.detail) : '' })),
    ];
  });
  renderList('remote-list', rows, 'No remote agent data.');
  setCount('docker-total', services.filter((item) => item.up).length, services.length);
  setCount('remote-total', remote.filter((item) => item.up).length, remote.length);
}

function expiryRow(name, sub, days, known, warnDays, scaleDays) {
  const danger = Math.ceil(warnDays / 3);
  const level = !known ? 'unknown' : days <= danger ? 'bad' : days <= warnDays ? 'warn' : '';
  const meter = known ? `<i class="meter" title="${days} days remaining"><b class="${level}" style="width:${Math.max(3, Math.min(100, (days / scaleDays) * 100))}%"></b></i>` : '';
  return `<div class="row"><div><strong>${esc(name)}</strong><span title="${esc(sub)}">${esc(sub)}</span></div><div class="row-right">${meter}<b class="days ${level}">${known ? `${number(days)} d` : 'n/a'}</b></div></div>`;
}

function renderCertificates(data) {
  const certWarn = data.thresholds?.certWarnDays ?? 21;
  const domainWarn = data.thresholds?.domainWarnDays ?? 30;
  const byUrgency = (a, b) => (a.ok && a.daysRemaining != null ? a.daysRemaining : Infinity) - (b.ok && b.daysRemaining != null ? b.daysRemaining : Infinity);
  const certs = [...(data.certificates || [])].sort(byUrgency);
  const domains = [...(data.domains || [])].sort(byUrgency);
  renderList('cert-list', certs.map((c) => expiryRow(
    c.host,
    c.ok ? `${c.issuer || 'certificate'} · until ${c.validTo || ''}` : (c.error || 'check failed'),
    c.daysRemaining, c.ok && c.daysRemaining != null, certWarn, 90,
  )), 'No certificate data yet.');
  renderList('domain-list', domains.map((d) => expiryRow(
    d.domain,
    d.ok ? `expires ${d.expiryDate || ''}` : (d.supported === false ? 'expiry not published' : (d.error || 'check failed')),
    d.daysRemaining, d.ok && d.daysRemaining != null, domainWarn, 365,
  )), 'No domain data yet.');
  setCount('cert-total', certs.filter((c) => c.ok && c.daysRemaining != null && c.daysRemaining > certWarn).length, certs.length);
  setCount('domain-total', domains.filter((d) => d.ok && d.daysRemaining != null && d.daysRemaining > domainWarn).length, domains.length);
}

function renderJobs(data) {
  const jobs = data.heartbeats || [];
  const deliveries = Object.entries(data.alertDelivery || {}).map(([id, status]) => {
    const success = Date.parse(status?.lastSuccessAt || '');
    const failure = Date.parse(status?.lastFailureAt || '');
    const up = Boolean(status?.configured && Number.isFinite(success) && (!Number.isFinite(failure) || success >= failure));
    const detail = !status?.configured ? 'Webhook not configured'
      : status.lastError ? `Last attempt failed · ${status.lastError}`
        : status.lastSuccessAt ? `Verified ${new Date(status.lastSuccessAt).toLocaleString()}` : 'Delivery not verified';
    return { id, name: id === 'incident' ? 'Incident alerts' : `${id} alerts`, up, detail };
  });
  $('jobs').hidden = jobs.length === 0 && deliveries.length === 0;
  renderList('jobs-list', jobs.map((job) => row(job.name, job.detail, job.up, job.up ? 'On time' : 'Late', { tag: job.periodSeconds ? `every ${job.periodSeconds >= 3600 ? `${Math.round(job.periodSeconds / 3600)} h` : `${Math.round(job.periodSeconds / 60)} min`}` : null })), 'No heartbeats configured.');
  renderList('delivery-list', deliveries.map((delivery) => row(delivery.name, delivery.detail, delivery.up, delivery.up ? 'Verified' : 'Unverified', { tag: 'Discord webhook' })), 'No alert delivery data.');
  setCount('jobs-total', jobs.filter((job) => job.up).length, jobs.length);
  setCount('delivery-total', deliveries.filter((delivery) => delivery.up).length, deliveries.length);
}

// ---------- gateway ----------
function gatewayHostPanel(host, history) {
  const up = host.enabled ? host.checks.filter((check) => check.up).length : 0;
  const total = host.enabled ? host.checks.length : 0;
  const rows = [];
  if (!host.enabled) {
    rows.push(row('Not monitored', host.note || 'Disabled in hosts.json', null, 'Off'));
  } else {
    for (const listener of host.listeners) {
      const uptime = listener.id === 'probe' ? historyFor(`gateway:${host.name}:probe`, history).uptime : null;
      const latency = listener.up && listener.latencyMs != null ? ` · ${number(listener.latencyMs)} ms` : ` · ${listener.detail}`;
      rows.push(row(listener.name, `${listener.source}${latency}${uptime == null ? '' : ` · ${pct(uptime)} over 24 h`}`, listener.up, listener.up ? 'Serving' : 'Down', { tag: 'listener' }));
    }
    for (const alias of host.aliases) {
      const label = alias.up ? 'Mapped' : alias.listed === false ? 'Missing' : 'Drift';
      rows.push(row(alias.alias, alias.detail, alias.listed === null && alias.configMatches === null ? null : alias.up, label, { tag: 'alias' }));
    }
    for (const account of host.accounts?.list || []) {
      const state = !host.reportFresh || !host.accounts.fresh ? null : account.up;
      const badge = state === null ? 'Stale' : !account.up ? (account.loginRejected ? 'Re-login' : 'Expired') : account.remainingPercent === 0 ? 'Used up' : 'Valid';
      rows.push(row(account.label, account.detail, state, badge, { tag: account.mirror === 'peer' ? 'mirror' : 'login' }));
    }
    if (host.credential) {
      const credential = host.credential;
      const plan = credential.plan ? `ChatGPT ${credential.plan[0].toUpperCase()}${credential.plan.slice(1)}` : 'Codex OAuth';
      const sub = credential.up ? `${plan} · ${credential.account || 'account hidden'} · refreshed ${ago(credential.lastRefreshAt)}` : credential.detail;
      rows.push(row('Codex credential', sub, host.reportFresh ? credential.up : null, !host.reportFresh ? 'Stale' : credential.up ? 'Valid' : 'Invalid'));
    }
    if (host.inference) {
      const inference = host.inference;
      const timing = inference.latencyMs != null ? ` · ${(inference.latencyMs / 1000).toFixed(1)} s` : '';
      rows.push(row('Inference probe', `${inference.detail}${inference.up ? timing : ''} · ${ago(inference.checkedAt)} · every 30 min`, inference.fresh ? inference.up : null, !inference.fresh ? 'Stale' : inference.up ? 'Answered' : 'Failed'));
    }
    if (host.agent && !host.reportFresh) {
      rows.push(row('Host telemetry', host.reportReceivedAt ? `${host.agent} agent last reported ${ago(host.reportReceivedAt)}` : `${host.agent} agent has not reported`, false, 'Stale'));
    }
  }
  const kicker = !host.enabled ? 'Gateway host · off' : host.configRevisionMatches === false ? 'Gateway host · config drift' : 'Gateway host';
  const note = host.note ? `<span class="panel-note">${esc(host.note)}</span>` : '';
  return `<article class="panel"><div class="panel-head"><div><span class="kicker">${esc(kicker)}</span><h3>${esc(host.name)}</h3>${note}</div><strong class="panel-count ${host.enabled && up < total ? 'bad' : ''}">${host.enabled ? `${up}/${total}` : 'Off'}</strong></div><div class="list">${rows.join('') || '<div class="empty">No gateway data yet.</div>'}</div></article>`;
}

function renderGateway(data) {
  const gateway = data.gateway;
  $('ai-gateway').hidden = !gateway;
  if (!gateway) return;
  const live = gateway.hosts.filter((host) => host.enabled).length;
  $('gateway-policy').textContent = `${gateway.revision ? `Policy ${gateway.revision}` : 'Policy unknown'} · ${live} ${live === 1 ? 'host' : 'hosts'} · one gateway per host`;
  $('gateway-hosts').innerHTML = gateway.hosts.map((host) => gatewayHostPanel(host, data.history24h)).join('');

  const usage = gateway.usage;
  if (usage?.plan) $('gateway-plan').textContent = `ChatGPT ${usage.plan[0].toUpperCase()}${usage.plan.slice(1)} · Codex`;
  const windows = usage?.windows || [];
  $('gateway-usage-total').textContent = windows.length ? `${Math.max(...windows.map((window) => window.usedPercent))}% used` : '–';
  const bars = windows.map((window) => {
    const level = window.usedPercent >= 90 ? 'danger' : window.usedPercent >= 70 ? 'warn' : '';
    const resets = window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${until(window.resetsAt)}` : '';
    return `<div class="pool"><div class="pool-head"><strong>${esc(window.label)}</strong><b>${window.usedPercent}% used</b></div><div class="pool-track"><div class="pool-fill ${level}" style="width:${Math.min(100, window.usedPercent)}%"></div></div><div class="pool-foot"><span>${100 - window.usedPercent}% remaining</span><span>${esc(resets)}</span></div></div>`;
  }).join('');
  const source = usage?.checkedAt ? `Read ${ago(usage.checkedAt)} via the codex app-server, without spending quota.` : 'Usage has not been read yet.';
  const note = `<p class="gateway-note ${usage?.fresh ? '' : 'stale'}">${esc(usage?.fresh ? source : `Telemetry stale · ${source}`)}${usage?.limitReached ? ' Rate limit reached.' : ''}</p>`;
  $('gateway-usage').innerHTML = `${bars || '<div class="empty">No usage windows reported.</div>'}${note}`;
}

// ---------- attention & hero ----------
const alertIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';

function renderAttention(data, remote) {
  const certWarn = data.thresholds?.certWarnDays ?? 21;
  const domainWarn = data.thresholds?.domainWarnDays ?? 30;
  const omniFailed = data.targets.filter((item) => item.id.startsWith('omni-') && !item.up);
  const issues = [
    ...data.targets.filter((item) => !item.up && !item.id.startsWith('omni-')).map((item) => ({ name: item.name, detail: item.statusCode ? `HTTP ${item.statusCode} · ${item.detail}` : item.detail, href: '#products' })),
    ...(omniFailed.length ? [{ name: 'OmniObserve', detail: `${omniFailed.length} checks failed through the private SSH tunnel.${omniFailed.every((item) => !item.statusCode) ? ' No HTTP response received; service health is not confirmed.' : ''}`, href: '#omniobserve' }] : []),
    ...data.targets.filter((item) => item.up && item.degraded).map((item) => ({ name: item.name, detail: item.degradedReason || 'Degraded', level: 'warn', href: '#products' })),
    ...data.services.filter((item) => !item.up).map((item) => ({ name: item.name, detail: item.detail, href: '#infrastructure' })),
    ...remoteIssues(remote),
    ...(data.heartbeats || []).filter((job) => !job.up).map((job) => ({ name: job.name, detail: job.detail, href: '#jobs' })),
    ...(data.certificates || []).filter((c) => c.ok && c.daysRemaining != null && c.daysRemaining <= certWarn).map((c) => ({ name: `${c.host} · TLS certificate`, detail: `Expires in ${c.daysRemaining} days`, level: 'warn', href: '#certificates' })),
    ...(data.domains || []).filter((d) => d.ok && d.daysRemaining != null && d.daysRemaining <= domainWarn).map((d) => ({ name: `${d.domain} · domain registration`, detail: `Expires in ${d.daysRemaining} days`, level: 'warn', href: '#certificates' })),
    ...(data.gateway?.checks || []).filter((check) => !check.up).map((check) => ({ name: check.name, detail: localTimes(check.detail), href: '#ai-gateway' })),
    ...Object.entries(data.alertDelivery || {}).filter(([, status]) => {
      const success = Date.parse(status?.lastSuccessAt || '');
      const failure = Date.parse(status?.lastFailureAt || '');
      return !status?.configured || !Number.isFinite(success) || (Number.isFinite(failure) && failure > success);
    }).map(([id, status]) => ({ name: `${id === 'incident' ? 'Incident' : id} alert delivery`, detail: status?.lastError || (status?.configured ? 'Delivery has not been verified' : 'Webhook not configured'), level: 'warn', href: '#jobs' })),
  ];
  $('attention-section').hidden = issues.length === 0;
  $('attention-count').textContent = `${issues.length} active`;
  $('attention').innerHTML = issues.map((issue) => `<div class="alert ${issue.level || ''}">${alertIcon}<div><strong>${esc(issue.name)}</strong><span>${esc(issue.detail || 'Needs review')}</span></div><a href="${esc(issue.href || '#')}">View →</a></div>`).join('');
  return issues;
}

// A silent agent is one incident, not one per item it used to report.
function remoteIssues(remote) {
  const issues = [];
  for (const host of [...new Set(remote.map((item) => item.host))]) {
    const items = remote.filter((item) => item.host === host);
    if (items.length && items.every((item) => !item.fresh)) {
      issues.push({ name: `${host} · agent offline`, detail: `No report for ${ago(items[0].receivedAt)}; ${items.length} monitored items unknown`, href: '#infrastructure' });
      continue;
    }
    issues.push(...items.filter((item) => !item.up).map((item) => ({ name: `${host} · ${item.name}`, detail: item.detail, href: '#infrastructure' })));
  }
  return issues;
}

function tile(id, up, total) {
  $(`summary-${id}`).innerHTML = total ? `${up}<small> / ${total}</small>` : '–';
  const meter = $(`meter-${id}`);
  const ratio = total ? up / total : 0;
  meter.style.width = `${total ? Math.max(2, ratio * 100) : 0}%`;
  meter.className = ratio === 1 ? '' : ratio >= 0.8 ? 'warn' : 'bad';
}

let lastCheckedAt = null;
function renderClock() {
  if (!lastCheckedAt) return;
  const age = Date.now() - Date.parse(lastCheckedAt);
  const dot = $('last-check').querySelector('.live-dot');
  dot.classList.toggle('stale', age > 3 * 60_000);
  $('last-check').lastChild.textContent = `Updated ${ago(lastCheckedAt)}`;
}

function renderGlobal(data, remote, issues) {
  const hero = $('global-state');
  const gatewayChecks = data.gateway?.checks || [];
  const healthy = issues.length === 0;
  hero.classList.remove('degraded', 'maintenance', 'offline');
  if (data.maintenance) {
    hero.classList.add('maintenance');
    $('global-title').textContent = 'Scheduled maintenance in progress';
    $('global-detail').textContent = data.maintenance.reason || 'Alerts are paused during this maintenance window.';
    document.title = 'Maintenance · Sky Status';
  } else {
    hero.classList.toggle('degraded', !healthy);
    $('global-title').textContent = healthy ? 'All systems operational' : `${issues.length} ${issues.length === 1 ? 'item needs' : 'items need'} attention`;
    $('global-detail').textContent = healthy ? 'Every monitored product, runtime, job and gateway is responding normally.' : 'Open items are listed below; everything else is responding normally.';
    document.title = healthy ? 'All systems operational · Sky Status' : `${issues.length} attention ${issues.length === 1 ? 'item' : 'items'} · Sky Status`;
  }
  $('state-time').textContent = `Last check ${new Date(data.checkedAt).toLocaleString()}`;
  lastCheckedAt = data.checkedAt;
  renderClock();
  tile('public', data.targets.filter((item) => item.up).length, data.targets.length);
  tile('docker', data.services.filter((item) => item.up).length, data.services.length);
  tile('remote', remote.filter((item) => item.up).length, remote.length);
  tile('gateway', gatewayChecks.filter((check) => check.up).length, gatewayChecks.length);
}

// ---------- nav highlight ----------
const navLinks = [...document.querySelectorAll('.site-nav a')];
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`));
  }
}, { rootMargin: '-30% 0px -60% 0px' });
navLinks.forEach((link) => { const section = document.querySelector(link.getAttribute('href')); if (section) observer.observe(section); });

// ---------- load ----------
async function load() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Status API returned ${response.status}`);
  const data = await response.json();
  const now = Date.now();
  const remote = remoteItems(data.agents);
  renderProducts(data, now);
  renderInfrastructure(data, remote);
  renderJobs(data);
  renderCertificates(data);
  renderGateway(data);
  const issues = renderAttention(data, remote);
  renderGlobal(data, remote, issues);
  $('last-check').querySelector('.live-dot').classList.remove('offline');
}

function offline() {
  const hero = $('global-state');
  if (!lastCheckedAt) {
    hero.classList.add('offline');
    $('global-title').textContent = 'Status data unavailable';
    $('global-detail').textContent = 'The dashboard could not retrieve the latest snapshot. It will retry every minute.';
  }
  $('last-check').querySelector('.live-dot').classList.add('offline');
}

load().catch(offline);
setInterval(() => load().catch(offline), 60_000);
setInterval(renderClock, 15_000);
