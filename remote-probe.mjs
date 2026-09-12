export function remoteProbe(target, agents, now = Date.now()) {
  const agent = agents[target.probeAgent];
  const age = now - Date.parse(agent?.receivedAt || '');
  const item = agent?.items?.find((entry) => entry.id === target.id);
  const fresh = Number.isFinite(age) && age >= 0 && age < 180000;
  const up = fresh && item?.up === true && item?.statusCode === 200;
  return { ...target, up, statusCode: fresh ? item?.statusCode || null : null,
    latencyMs: fresh ? item?.latencyMs || 0 : 0,
    detail: !fresh ? 'SkyLabMac probe stale or missing' : item?.detail || 'Probe result missing',
    probeSource: 'SkyLabMac', receivedAt: agent?.receivedAt || null,
    degraded: false, degradedReason: null };
}
