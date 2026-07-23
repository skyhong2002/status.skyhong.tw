// Pure renderers for the Prometheus metrics endpoint, the status badge, and the incident RSS feed.

function escapeLabel(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function countIncidents(state, thresholds = {}) {
  const certWarn = thresholds.certWarnDays ?? 21;
  const domainWarn = thresholds.domainWarnDays ?? 30;
  const now = Date.now();
  let count = 0;
  for (const target of state.targets || []) if (!target.up || target.degraded) count += 1;
  for (const service of state.services || []) if (!service.up) count += 1;
  for (const heartbeat of state.heartbeats || []) if (!heartbeat.up) count += 1;
  for (const agent of Object.values(state.agents || {})) {
    const stale = !agent.receivedAt || now - new Date(agent.receivedAt).getTime() > 180_000;
    for (const item of agent.items || []) if (stale || !item.up) count += 1;
  }
  for (const cert of state.certificates || []) if (cert.ok && cert.daysRemaining != null && cert.daysRemaining <= certWarn) count += 1;
  for (const domain of state.domains || []) if (domain.ok && domain.daysRemaining != null && domain.daysRemaining <= domainWarn) count += 1;
  return count;
}

export function renderMetrics(state) {
  const lines = [];
  const gauge = (name, help, rows) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of rows) lines.push(`${name}{${labels}} ${value}`);
  };
  const up = [];
  const latency = [];
  for (const target of state.targets || []) {
    up.push([`kind="target",id="${escapeLabel(target.id)}",name="${escapeLabel(target.name)}"`, target.up ? 1 : 0]);
    if (Number.isFinite(target.latencyMs)) latency.push([`id="${escapeLabel(target.id)}"`, Math.round(target.latencyMs)]);
  }
  for (const service of state.services || []) up.push([`kind="service",id="${escapeLabel(service.name)}",name="${escapeLabel(service.name)}"`, service.up ? 1 : 0]);
  for (const heartbeat of state.heartbeats || []) up.push([`kind="heartbeat",id="${escapeLabel(heartbeat.id)}",name="${escapeLabel(heartbeat.name)}"`, heartbeat.up ? 1 : 0]);
  gauge('sky_up', 'Monitored entity availability (1 up, 0 down)', up);
  gauge('sky_target_latency_ms', 'Last response time in milliseconds', latency);
  gauge('sky_certificate_days_remaining', 'Days until TLS certificate expiry',
    (state.certificates || []).filter((c) => c.ok && c.daysRemaining != null).map((c) => [`host="${escapeLabel(c.host)}"`, c.daysRemaining]));
  gauge('sky_domain_days_remaining', 'Days until domain registration expiry',
    (state.domains || []).filter((d) => d.ok && d.daysRemaining != null).map((d) => [`domain="${escapeLabel(d.domain)}"`, d.daysRemaining]));
  const uptimeRows = [];
  for (const [id, windows] of Object.entries(state.uptime || {})) {
    for (const [key, label] of [['d7', '7d'], ['d30', '30d'], ['d90', '90d']]) {
      if (windows[key]?.uptime != null) uptimeRows.push([`id="${escapeLabel(id)}",window="${label}"`, (windows[key].uptime / 100).toFixed(6)]);
    }
  }
  gauge('sky_uptime_ratio', 'Uptime ratio over a rolling window (0-1)', uptimeRows);
  gauge('sky_incidents_total', 'Current number of active incidents', [['', countIncidents(state, state.thresholds)]]);
  return `${lines.join('\n')}\n`;
}

export function renderBadge(incidentCount) {
  const ok = incidentCount === 0;
  const label = 'status';
  const message = ok ? 'operational' : `${incidentCount} incident${incidentCount === 1 ? '' : 's'}`;
  const color = ok ? '#30A46C' : '#E5484D';
  const msgWidth = 8 + message.length * 6.5;
  const total = 54 + msgWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total.toFixed(0)}" height="20" role="img" aria-label="${label}: ${message}">
  <rect width="54" height="20" fill="#333"/>
  <rect x="54" width="${msgWidth.toFixed(0)}" height="20" fill="${color}"/>
  <g fill="#fff" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="8" y="14">${label}</text>
    <text x="62" y="14">${xmlEscape(message)}</text>
  </g>
</svg>`;
}

export function renderFeed(incidents, origin) {
  const items = (incidents || []).map((incident) => {
    const emoji = incident.type === 'recovery' ? '🟢' : '🔴';
    const kind = incident.type === 'recovery' ? 'Recovered' : 'Down';
    return `    <item>
      <title>${xmlEscape(`${emoji} ${incident.name} — ${kind}`)}</title>
      <description>${xmlEscape(incident.detail || '')}</description>
      <pubDate>${new Date(incident.at).toUTCString()}</pubDate>
      <guid isPermaLink="false">${xmlEscape(`${incident.id}:${incident.at}`)}</guid>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Sky Status incidents</title>
    <link>${xmlEscape(origin)}</link>
    <description>Service down and recovery events</description>
${items}
  </channel>
</rss>`;
}
