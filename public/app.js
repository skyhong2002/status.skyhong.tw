const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = (value) => new Intl.NumberFormat().format(Number(value || 0));

function freshness(receivedAt) {
  return receivedAt && Date.now() - new Date(receivedAt).getTime() < 180_000;
}

function remoteItems(agents) {
  return Object.entries(agents || {}).flatMap(([id, agent]) => (agent.items || []).map((item) => ({
    ...item,
    id: `${id}:${item.id}`,
    name: item.name,
    host: agent.host || id,
    up: freshness(agent.receivedAt) && item.up,
    detail: freshness(agent.receivedAt) ? item.detail : 'Agent has not checked in',
  })));
}

function historyFor(id, history) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  const points = (history[id] || []).filter((point) => point.t >= start);
  const bins = Array.from({ length: 48 }, () => []);
  for (const point of points) {
    const index = Math.min(47, Math.max(0, Math.floor(((point.t - start) / (now - start)) * 48)));
    bins[index].push(point);
  }
  const bars = bins.map((bin) => !bin.length ? 'empty' : bin.some((point) => !point.up) ? 'down' : 'up');
  const uptime = points.length ? (points.filter((point) => point.up).length / points.length) * 100 : null;
  return { bars, uptime };
}

function statusLabel(target) {
  if (!target.up) return { cls: 'down', text: 'Unavailable' };
  if (target.degraded) return { cls: 'degraded', text: 'Degraded' };
  return { cls: '', text: 'Operational' };
}

function pct(value) {
  if (value == null) return '—';
  return `${value.toFixed(value >= 99.995 ? 0 : 2)}%`;
}

function slaSummary(target, data) {
  const history = historyFor(target.id, data.history);
  const day = history.uptime === null ? '—' : pct(history.uptime);
  const windows = (data.uptime || {})[target.id] || {};
  const long = windows.d30?.uptime != null ? pct(windows.d30.uptime) : (windows.d7?.uptime != null ? pct(windows.d7.uptime) : null);
  const value = long ? `${long} · 30d` : `${day} · 24h`;
  const tip = `24h ${day} · 7d ${pct(windows.d7?.uptime)} · 30d ${pct(windows.d30?.uptime)} · 90d ${pct(windows.d90?.uptime)}`;
  return { bars: history.bars, value, tip };
}

function renderProducts(data) {
  $('product-list').innerHTML = data.targets.map((target) => {
    const sla = slaSummary(target, data);
    const label = statusLabel(target);
    const sub = target.degraded && target.degradedReason
      ? esc(target.degradedReason)
      : `${esc(target.group)} · ${target.statusCode ? `HTTP ${target.statusCode}` : esc(target.detail)}`;
    return `<article class="monitor-row">
      <div class="monitor-top">
        <div class="monitor-name"><a href="${esc(target.url)}">${esc(target.name)}</a><span>${sub}</span></div>
        <span class="status-label ${label.cls}">${label.text}</span>
        <div class="monitor-metrics"><strong>${number(target.latencyMs)} ms</strong><span>response time</span></div>
      </div>
      <div class="uptime-row"><div class="uptime-bars" aria-label="24 hour status history">${sla.bars.map((status) => `<i class="${status}" title="${status}"></i>`).join('')}</div><span class="uptime-value" title="${esc(sla.tip)}">${sla.value}</span></div>
    </article>`;
  }).join('');
}

function expiryRow(name, sub, days, known, warnDays) {
  const danger = Math.ceil(warnDays / 3);
  const level = !known ? 'unknown' : days <= danger ? 'down' : days <= warnDays ? 'warn' : 'ok';
  const right = known ? `${number(days)}d` : 'n/a';
  return `<div class="runtime-item"><div><strong>${esc(name)}</strong><span>${esc(sub)}</span></div><b class="expiry-state ${level}">${right}</b></div>`;
}

function renderCertificates(data) {
  const certWarn = data.thresholds?.certWarnDays ?? 21;
  const domainWarn = data.thresholds?.domainWarnDays ?? 30;
  const certs = data.certificates || [];
  const domains = data.domains || [];
  $('cert-list').innerHTML = certs.length ? certs.map((c) => expiryRow(
    c.host,
    c.ok ? `${c.issuer || 'certificate'} · until ${c.validTo || ''}` : (c.error || 'check failed'),
    c.daysRemaining, c.ok && c.daysRemaining != null, certWarn,
  )).join('') : '<div class="empty">No certificate data yet.</div>';
  $('domain-list').innerHTML = domains.length ? domains.map((d) => expiryRow(
    d.domain,
    d.ok ? `expires ${d.expiryDate || ''}` : (d.supported === false ? 'expiry not published' : (d.error || 'check failed')),
    d.daysRemaining, d.ok && d.daysRemaining != null, domainWarn,
  )).join('') : '<div class="empty">No domain data yet.</div>';
  $('cert-total').textContent = `${certs.filter((c) => c.ok && c.daysRemaining != null && c.daysRemaining > certWarn).length}/${certs.length}`;
  $('domain-total').textContent = `${domains.filter((d) => d.ok && d.daysRemaining != null && d.daysRemaining > domainWarn).length}/${domains.length}`;
}

function runtimeRow(item, remote = false) {
  return `<div class="runtime-item"><div><strong>${esc(item.name)}</strong><span>${esc(remote ? `${item.host} · ${item.detail}` : `${item.kind} · ${item.detail}`)}</span></div><b class="runtime-state ${item.up ? '' : 'down'}">${item.up ? 'Running' : 'Down'}</b></div>`;
}

function renderInfrastructure(data, remote) {
  $('docker-list').innerHTML = data.services.map((item) => runtimeRow(item)).join('');
  $('remote-list').innerHTML = remote.length ? remote.map((item) => runtimeRow(item, true)).join('') : '<div class="empty">No remote agent data.</div>';
  $('docker-total').textContent = `${data.services.filter((item) => item.up).length}/${data.services.length}`;
  $('remote-total').textContent = `${remote.filter((item) => item.up).length}/${remote.length}`;
}

function renderJobs(data) {
  const jobs = data.heartbeats || [];
  $('jobs').hidden = jobs.length === 0;
  if (!jobs.length) return;
  $('jobs-list').innerHTML = jobs.map((job) => runtimeRow(job)).join('');
  $('jobs-total').textContent = `${jobs.filter((job) => job.up).length}/${jobs.length}`;
}

function renderAttention(data, remote, ai) {
  const certWarn = data.thresholds?.certWarnDays ?? 21;
  const domainWarn = data.thresholds?.domainWarnDays ?? 30;
  const issues = [
    ...data.targets.filter((item) => !item.up).map((item) => ({ name: item.name, detail: item.statusCode ? `HTTP ${item.statusCode} · ${item.detail}` : item.detail })),
    ...data.targets.filter((item) => item.up && item.degraded).map((item) => ({ name: item.name, detail: item.degradedReason || 'Degraded' })),
    ...data.services.filter((item) => !item.up),
    ...remote.filter((item) => !item.up),
    ...(data.heartbeats || []).filter((job) => !job.up).map((job) => ({ name: job.name, detail: job.detail })),
    ...(data.certificates || []).filter((c) => c.ok && c.daysRemaining != null && c.daysRemaining <= certWarn).map((c) => ({ name: `${c.host} · TLS certificate`, detail: `Expires in ${c.daysRemaining} days` })),
    ...(data.domains || []).filter((d) => d.ok && d.daysRemaining != null && d.daysRemaining <= domainWarn).map((d) => ({ name: `${d.domain} · domain registration`, detail: `Expires in ${d.daysRemaining} days` })),
    ...(ai && !ai.connected ? [{ name: ai.name, detail: ai.detail }] : []),
    ...(ai?.pools || []).filter((pool) => pool.percent >= 70).map((pool) => ({ name: pool.name, detail: `${pool.percent.toFixed(1)}% of estimated pool used` })),
  ];
  $('attention-section').hidden = issues.length === 0;
  $('attention-count').textContent = `${issues.length} active`;
  $('attention').innerHTML = issues.map((issue) => `<div class="incident"><i></i><div><strong>${esc(issue.name)}</strong><span>${esc(issue.detail || 'Needs review')}</span></div><b>Investigating</b></div>`).join('');
  return issues;
}

function usageTable(headers, rows) {
  return `<table class="usage-table"><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderAi(ai) {
  if (!ai) {
    $('ai-panel').innerHTML = '<div class="empty">OpenAI Usage API is not configured.</div>';
    $('ai-sync').textContent = 'Not connected';
    return;
  }
  $('ai-sync').textContent = ai.lastSyncAt ? `Synced ${new Date(ai.lastSyncAt).toLocaleString()}` : ai.detail;
  const stats = `<div class="ai-stats">
    <div class="ai-stat"><span>Input tokens today</span><strong>${number(ai.input)}</strong></div>
    <div class="ai-stat"><span>Output tokens today</span><strong>${number(ai.output)}</strong></div>
    <div class="ai-stat"><span>Requests today</span><strong>${number(ai.requests)}</strong></div>
    <div class="ai-stat"><span>Cost · UTC day</span><strong>$${Number(ai.cost || 0).toFixed(4)}</strong></div>
  </div>`;
  // The bar's axis is tokens *used*, so the even-pace marker sits at the share of the day already
  // gone: fill left of the line means under budget, fill past it means burning too fast.
  const dayLeft = typeof ai.dayRemaining === 'number' ? ai.dayRemaining : null;
  const hoursLeft = dayLeft === null ? null : dayLeft * 24;
  const paceLabel = hoursLeft === null ? '' : (hoursLeft >= 1 ? `${hoursLeft.toFixed(1)}h` : `${Math.round(hoursLeft * 60)}m`);
  const pools = ai.pools.map((pool) => {
    const level = pool.percent >= 95 ? 'danger' : pool.percent >= 70 ? 'warn' : '';
    const onPace = dayLeft === null ? null : pool.remaining >= pool.paceRemaining;
    const paceUsed = dayLeft === null ? 0 : Math.max(0, pool.limit - pool.paceRemaining);
    const marker = dayLeft === null ? '' : `<i class="pace-line" style="left:${((1 - dayLeft) * 100).toFixed(2)}%" title="${esc(`${paceLabel} left today · at even pace ${number(paceUsed)} would be used by now, leaving ${number(pool.paceRemaining)}`)}"></i>`;
    const paceNote = dayLeft === null ? '' : `<span class="pace-note ${onPace ? '' : 'behind'}">${number(pool.paceRemaining)} at even pace</span>`;
    return `<div class="pool"><div class="pool-head"><strong>${esc(pool.name)}</strong><b>${number(pool.used)} / ${number(pool.limit)} · ${pool.percent.toFixed(1)}%</b></div><div class="pool-track"><div class="pool-fill ${level}" style="width:${Math.min(100, pool.percent)}%"></div>${marker}</div><div class="pool-foot"><span>${number(pool.remaining)} remaining</span>${paceNote}</div></div>`;
  }).join('');
  const trendMax = Math.max(1, ...ai.trend.map((point) => point.tokens));
  const trend = `<span class="subheading">Last 24 hours</span><div class="trend">${ai.trend.map((point) => `<i title="${new Date(point.start * 1000).toLocaleString()}: ${number(point.tokens)} tokens" style="height:${Math.max(3, (point.tokens / trendMax) * 100)}%"></i>`).join('')}</div>`;
  const modelRows = ai.byModel.map((item) => `<tr><td>${esc(item.model || 'Unknown')}</td><td><span class="tag ${item.pool === 'billable' ? 'billable' : ''}">${esc(item.pool === 'billable' ? 'Possible billing' : `${item.pool} pool`)}</span></td><td>${number(item.tokens)}</td></tr>`);
  const keyRows = ai.byKey.map((item) => `<tr><td>${esc(item.name)}</td><td>${number(item.requests)}</td><td>${number(item.tokens)}</td></tr>`);
  const tables = `<span class="subheading">Models</span>${usageTable(['Model', 'Class', 'Tokens'], modelRows)}<span class="subheading" style="margin-top:20px">API keys</span>${usageTable(['Key / service', 'Requests', 'Tokens'], keyRows)}`;
  const legend = dayLeft === null ? '' : `<div class="pace-legend">白線＝照平均步調，今日到現在「應該」用掉的量（還剩 ${esc(paceLabel)}）。填色在白線左邊代表用量還有餘裕，超過白線代表用太快。</div>`;
  $('ai-panel').innerHTML = `${stats}<div class="ai-content"><div><span class="subheading">預估免費池使用量</span>${pools}${legend}${trend}</div><div>${tables}</div></div>`;
}

function renderGlobal(data, remote, ai, issues) {
  const healthy = issues.length === 0;
  if (data.maintenance) {
    $('global-state').classList.remove('degraded');
    $('global-state').classList.add('maintenance');
    $('global-title').textContent = 'Scheduled maintenance in progress';
    $('global-detail').textContent = data.maintenance.reason || 'Alerts are paused during this maintenance window.';
    $('state-time').textContent = new Date(data.checkedAt).toLocaleString();
    $('last-check').textContent = `Updated ${new Date(data.checkedAt).toLocaleTimeString()}`;
    document.title = 'Maintenance · Sky Status';
    $('summary-public').textContent = `${data.targets.filter((item) => item.up).length} / ${data.targets.length}`;
    $('summary-docker').textContent = `${data.services.filter((item) => item.up).length} / ${data.services.length}`;
    $('summary-remote').textContent = `${remote.filter((item) => item.up).length} / ${remote.length}`;
    $('summary-ai').textContent = number(ai?.requests);
    return;
  }
  $('global-state').classList.remove('maintenance');
  $('global-state').classList.toggle('degraded', !healthy);
  $('global-title').textContent = healthy ? 'All systems operational' : `${issues.length} ${issues.length === 1 ? 'system needs' : 'systems need'} attention`;
  $('global-detail').textContent = healthy ? 'All monitored products and runtimes are responding normally.' : 'Current incidents and degraded checks are listed below.';
  $('state-time').textContent = new Date(data.checkedAt).toLocaleString();
  $('last-check').textContent = `Updated ${new Date(data.checkedAt).toLocaleTimeString()}`;
  $('summary-public').textContent = `${data.targets.filter((item) => item.up).length} / ${data.targets.length}`;
  $('summary-docker').textContent = `${data.services.filter((item) => item.up).length} / ${data.services.length}`;
  $('summary-remote').textContent = `${remote.filter((item) => item.up).length} / ${remote.length}`;
  $('summary-ai').textContent = number(ai?.requests);
  document.title = healthy ? 'All systems operational · Sky Status' : `${issues.length} ${issues.length === 1 ? 'incident' : 'incidents'} · Sky Status`;
}

async function load() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Status API returned ${response.status}`);
  const data = await response.json();
  const remote = remoteItems(data.agents);
  const ai = data.aiUsage[0];
  renderProducts(data);
  renderInfrastructure(data, remote);
  renderJobs(data);
  renderCertificates(data);
  renderAi(ai);
  const issues = renderAttention(data, remote, ai);
  renderGlobal(data, remote, ai, issues);
}

load().catch(() => {
  $('global-state').classList.add('degraded');
  $('global-title').textContent = 'Status data unavailable';
  $('global-detail').textContent = 'The dashboard could not retrieve the latest snapshot.';
});
setInterval(() => load().catch(() => {}), 60_000);
