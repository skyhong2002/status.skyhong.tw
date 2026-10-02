const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = (value) => new Intl.NumberFormat().format(Number(value || 0));

function freshness(receivedAt) {
  return receivedAt && Date.now() - new Date(receivedAt).getTime() < 180_000;
}

function remoteItems(agents) {
  return Object.entries(agents || {}).filter(([id]) => id !== 'omni-probe').flatMap(([id, agent]) => (agent.items || []).map((item) => ({
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
  if (!target.up) return { cls: 'down', text: target.id.startsWith('omni-') && !target.statusCode ? 'Probe unreachable' : 'Unavailable' };
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
  const preferred = windows.d30?.uptime != null ? windows.d30 : windows.d7;
  const long = preferred?.uptime != null ? pct(preferred.uptime) : null;
  const label = preferred?.complete ? `${preferred.windowDays}d` : `${preferred?.observedDays || 0}d observed`;
  const value = long ? `${long} · ${label}` : `${day} · 24h`;
  const windowTip = (window) => window?.uptime == null ? '—' : `${pct(window.uptime)} (${window.observedDays || 0}/${window.windowDays || 0}d observed)`;
  const tip = `24h ${day} · 7d ${windowTip(windows.d7)} · 30d ${windowTip(windows.d30)} · 90d ${windowTip(windows.d90)}`;
  return { bars: history.bars, value, tip };
}

function renderProducts(data) {
  const renderRows = (targets) => targets.map((target) => {
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
  const isOmni = (target) => target.id.startsWith('omni-');
  $('product-list').innerHTML = renderRows(data.targets.filter((target) => !isOmni(target)));
  const omni = data.targets.filter(isOmni);
  const unreachable = omni.filter((target) => !target.up && !target.statusCode).length;
  const healthy = omni.filter((target) => target.up && !target.degraded).length;
  const expanded = $('omni-details')?.open || false;
  const status = healthy === omni.length ? 'Operational' : unreachable === omni.length ? 'Probe unreachable' : 'Needs attention';
  $('omni-list').innerHTML = `<article class="monitor-row"><div class="monitor-top"><div class="monitor-name"><a href="https://omni.observe.tw/">OmniObserve</a><span>${healthy}/${omni.length} checks healthy · probe: skyhong.tw via private SSH</span></div><span class="status-label ${healthy === omni.length ? '' : 'down'}">${status}</span><div class="monitor-metrics"><strong>${healthy}/${omni.length}</strong><span>endpoints</span></div></div><details id="omni-details" ${expanded ? 'open' : ''}><summary style="cursor:pointer;margin-top:12px">Environment details (${omni.length})</summary>${unreachable ? '<p>監控主機無法連到部分端點；這不等於已確認服務本身故障。</p>' : ''}${data.omniNetworkPath && !data.omniNetworkPath.up ? '<p>skyhong.tw → 國網的路徑仍無法連線；上述服務狀態由 skyhong.tw 經專用 SSH 通道直接檢查。</p>' : ''}${renderRows(omni)}</details></article>`;
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

function ago(at) {
  const ms = Date.now() - Date.parse(at || '');
  if (!Number.isFinite(ms)) return 'never';
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function until(at) {
  const ms = Date.parse(at || '') - Date.now();
  if (!Number.isFinite(ms)) return '';
  const hours = Math.max(0, ms / 3_600_000);
  return hours >= 24 ? `in ${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h` : hours >= 1 ? `in ${hours.toFixed(1)}h` : `in ${Math.round(hours * 60)}m`;
}

const localTimes = (text) => String(text || '').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (stamp) => new Date(stamp).toLocaleString());

function stateRow(name, sub, up, label) {
  const cls = up === null ? 'unknown' : up ? '' : 'down';
  return `<div class="runtime-item"><div><strong>${esc(name)}</strong><span>${esc(sub)}</span></div><b class="runtime-state ${cls}">${esc(label)}</b></div>`;
}

function gatewayHostPanel(host, history) {
  if (!host.enabled) {
    const rows = stateRow('Not monitored', host.note || 'Disabled in hosts.json', null, 'Off');
    return `<article class="runtime-panel"><div class="panel-heading"><div><span class="panel-kicker">Gateway host</span><h3>${esc(host.name)}</h3></div><strong>Off</strong></div><div class="runtime-list">${rows}</div></article>`;
  }
  const rows = [];
  for (const listener of host.listeners) {
    const uptime = listener.id === 'probe' ? historyFor(`gateway:${host.name}:probe`, history).uptime : null;
    const latency = listener.up && listener.latencyMs != null ? ` · ${number(listener.latencyMs)} ms` : ` · ${listener.detail}`;
    rows.push(stateRow(listener.name, `${listener.source}${latency}${uptime == null ? '' : ` · ${pct(uptime)} 24h`}`, listener.up, listener.up ? 'Serving' : 'Down'));
  }
  for (const alias of host.aliases) {
    const label = alias.up ? 'Mapped' : alias.listed === false ? 'Missing' : 'Drift';
    rows.push(stateRow(alias.alias, alias.detail, alias.listed === null && alias.configMatches === null ? null : alias.up, label));
  }
  const credential = host.credential;
  if (credential) {
    const plan = credential.plan ? `ChatGPT ${credential.plan[0].toUpperCase()}${credential.plan.slice(1)}` : 'Codex OAuth';
    const sub = credential.up ? `${plan} · ${credential.account || 'account hidden'} · refreshed ${ago(credential.lastRefreshAt)}` : credential.detail;
    rows.push(stateRow('Codex credential', sub, host.reportFresh ? credential.up : null, !host.reportFresh ? 'Stale' : credential.up ? 'Valid' : 'Invalid'));
  }
  const inference = host.inference;
  if (inference) {
    const timing = inference.latencyMs != null ? ` · ${(inference.latencyMs / 1000).toFixed(1)} s` : '';
    rows.push(stateRow('Inference probe', `${inference.detail}${inference.up ? timing : ''} · ${ago(inference.checkedAt)} · every 30 min`, inference.fresh ? inference.up : null, !inference.fresh ? 'Stale' : inference.up ? 'Answered' : 'Failed'));
  }
  if (host.agent && !host.reportFresh) {
    rows.push(stateRow('Host telemetry', host.reportReceivedAt ? `${host.agent} agent last reported ${ago(host.reportReceivedAt)}` : `${host.agent} agent has not reported`, false, 'Stale'));
  }
  const kicker = host.configRevisionMatches === false ? 'Gateway host · config on another revision' : 'Gateway host';
  return `<article class="runtime-panel"><div class="panel-heading"><div><span class="panel-kicker">${esc(kicker)}</span><h3>${esc(host.name)}</h3></div><strong>${host.checks.filter((check) => check.up).length}/${host.checks.length}</strong></div><div class="runtime-list">${rows.join('') || '<div class="empty">No gateway data yet.</div>'}</div></article>`;
}

function renderGateway(data) {
  const gateway = data.gateway;
  $('ai-gateway').hidden = !gateway;
  if (!gateway) return;
  const live = gateway.hosts.filter((host) => host.enabled).length;
  $('gateway-policy').textContent = `${gateway.revision ? `Policy ${gateway.revision}` : 'Policy unknown'} · ${live} ${live === 1 ? 'host' : 'hosts'}`;
  $('gateway-hosts').innerHTML = gateway.hosts.map((host) => gatewayHostPanel(host, data.history)).join('');

  const usage = gateway.usage;
  if (usage?.plan) $('gateway-plan').textContent = `ChatGPT ${usage.plan[0].toUpperCase()}${usage.plan.slice(1)} · Codex`;
  const windows = usage?.windows || [];
  $('gateway-usage-total').textContent = windows.length ? `${Math.max(...windows.map((window) => window.usedPercent))}%` : '-';
  const bars = windows.map((window) => {
    const level = window.usedPercent >= 90 ? 'danger' : window.usedPercent >= 70 ? 'warn' : '';
    const resets = window.resetsAt ? `resets ${new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${until(window.resetsAt)}` : '';
    return `<div class="pool"><div class="pool-head"><strong>${esc(window.label)}</strong><b>${window.usedPercent}% used</b></div><div class="pool-track"><div class="pool-fill ${level}" style="width:${Math.min(100, window.usedPercent)}%"></div></div><div class="pool-foot"><span>${100 - window.usedPercent}% remaining</span><span>${esc(resets)}</span></div></div>`;
  }).join('');
  const source = usage?.checkedAt ? `Read ${ago(usage.checkedAt)} via codex app-server, without spending quota.` : 'Usage has not been read yet.';
  const note = `<p class="gateway-note ${usage?.fresh ? '' : 'stale'}">${esc(usage?.fresh ? source : `Telemetry stale · ${source}`)}${usage?.limitReached ? ' Rate limit reached.' : ''}</p>`;
  $('gateway-usage').innerHTML = `${bars || '<div class="empty">No usage windows reported.</div>'}${note}`;
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
    return { id, name: id === 'incident' ? 'Incident alerts' : `${id} alerts`, kind: 'Discord webhook', up, detail };
  });
  $('jobs').hidden = jobs.length === 0 && deliveries.length === 0;
  $('jobs-list').innerHTML = jobs.map((job) => runtimeRow(job)).join('');
  $('jobs-total').textContent = `${jobs.filter((job) => job.up).length}/${jobs.length}`;
  $('delivery-list').innerHTML = deliveries.length ? deliveries.map((delivery) => runtimeRow(delivery)).join('') : '<div class="empty">No alert delivery data.</div>';
  $('delivery-total').textContent = `${deliveries.filter((delivery) => delivery.up).length}/${deliveries.length}`;
}

function renderAttention(data, remote) {
  const certWarn = data.thresholds?.certWarnDays ?? 21;
  const domainWarn = data.thresholds?.domainWarnDays ?? 30;
  const issues = [
    ...data.targets.filter((item) => !item.up && !item.id.startsWith('omni-')).map((item) => ({ name: item.name, detail: item.statusCode ? `HTTP ${item.statusCode} · ${item.detail}` : item.detail })),
    ...(() => { const failed = data.targets.filter((item) => item.id.startsWith('omni-') && !item.up); return failed.length ? [{name: 'OmniObserve', detail: `${failed.length} checks failed through private SSH; expand OmniObserve for details. ${failed.every((item) => !item.statusCode) ? 'No HTTP response received; service health is not confirmed.' : ''}`}]: []; })(),
    ...data.targets.filter((item) => item.up && item.degraded).map((item) => ({ name: item.name, detail: item.degradedReason || 'Degraded' })),
    ...data.services.filter((item) => !item.up),
    ...remote.filter((item) => !item.up),
    ...(data.heartbeats || []).filter((job) => !job.up).map((job) => ({ name: job.name, detail: job.detail })),
    ...(data.certificates || []).filter((c) => c.ok && c.daysRemaining != null && c.daysRemaining <= certWarn).map((c) => ({ name: `${c.host} · TLS certificate`, detail: `Expires in ${c.daysRemaining} days` })),
    ...(data.domains || []).filter((d) => d.ok && d.daysRemaining != null && d.daysRemaining <= domainWarn).map((d) => ({ name: `${d.domain} · domain registration`, detail: `Expires in ${d.daysRemaining} days` })),
    ...(data.gateway?.checks || []).filter((check) => !check.up).map((check) => ({ name: check.name, detail: localTimes(check.detail) })),
    ...Object.entries(data.alertDelivery || {}).filter(([, status]) => {
      const success = Date.parse(status?.lastSuccessAt || '');
      const failure = Date.parse(status?.lastFailureAt || '');
      return !status?.configured || !Number.isFinite(success) || (Number.isFinite(failure) && failure > success);
    }).map(([id, status]) => ({ name: `${id === 'incident' ? 'Incident' : id} alert delivery`, detail: status?.lastError || (status?.configured ? 'Delivery has not been verified' : 'Webhook not configured') })),
  ];
  $('attention-section').hidden = issues.length === 0;
  $('attention-count').textContent = `${issues.length} active`;
  $('attention').innerHTML = issues.map((issue) => `<div class="incident"><i></i><div><strong>${esc(issue.name)}</strong><span>${esc(issue.detail || 'Needs review')}</span></div><b>Review</b></div>`).join('');
  return issues;
}

function gatewaySummary(gateway) {
  const checks = gateway?.checks || [];
  return checks.length ? `${checks.filter((check) => check.up).length} / ${checks.length}` : '-';
}

function renderGlobal(data, remote, issues) {
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
    $('summary-gateway').textContent = gatewaySummary(data.gateway);
    return;
  }
  $('global-state').classList.remove('maintenance');
  $('global-state').classList.toggle('degraded', !healthy);
  $('global-title').textContent = healthy ? 'All systems operational' : `${issues.length} ${issues.length === 1 ? 'item needs' : 'items need'} attention`;
  $('global-detail').textContent = healthy ? 'All monitored products and runtimes are responding normally.' : 'Current attention items and degraded checks are listed below.';
  $('state-time').textContent = new Date(data.checkedAt).toLocaleString();
  $('last-check').textContent = `Updated ${new Date(data.checkedAt).toLocaleTimeString()}`;
  $('summary-public').textContent = `${data.targets.filter((item) => item.up).length} / ${data.targets.length}`;
  $('summary-docker').textContent = `${data.services.filter((item) => item.up).length} / ${data.services.length}`;
  $('summary-remote').textContent = `${remote.filter((item) => item.up).length} / ${remote.length}`;
  $('summary-gateway').textContent = gatewaySummary(data.gateway);
  document.title = healthy ? 'All systems operational · Sky Status' : `${issues.length} attention ${issues.length === 1 ? 'item' : 'items'} · Sky Status`;
}

async function load() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Status API returned ${response.status}`);
  const data = await response.json();
  const remote = remoteItems(data.agents);
  renderProducts(data);
  renderInfrastructure(data, remote);
  renderJobs(data);
  renderCertificates(data);
  renderGateway(data);
  const issues = renderAttention(data, remote);
  renderGlobal(data, remote, issues);
}

load().catch(() => {
  $('global-state').classList.add('degraded');
  $('global-title').textContent = 'Status data unavailable';
  $('global-detail').textContent = 'The dashboard could not retrieve the latest snapshot.';
});
setInterval(() => load().catch(() => {}), 60_000);
