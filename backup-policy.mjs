// A success-only root heartbeat measures event age, never overall reliability.
export const skyServerBackupHeartbeat = Object.freeze({
  id: 'nas-backup-sky-server', name: 'SSD＋NAS 備份 · sky-server（root 成功事件）',
  periodSeconds: 604800, graceSeconds: 129600,
  schedule: 'Sun 05:00 Asia/Taipei +0–10m', successOnly: true,
});

export function responsePolicy(id) {
  if (/^remote:sky-server:(backup-reliability|tag-backup|host-observer-http|host-observer\.service)$/.test(id)
      || /^heartbeat:nas-backup-(?:verify-)?sky-server$/.test(id)) {
    return {
      automaticRemediationAllowed: false, action: 'report-only',
      reason: 'Backup reliability requires gated review in the existing backup workflow. Do not start/retry backup, restore, capacity repair or repository/device operations; do not restart maintenance or waiters. B is quarantined and excluded. Preserve failure history; no synthetic success ping.',
    };
  }
  return null;
}

// Legacy responders consume `active` without reading policy fields. Keep
// restricted incidents in a separate visible queue so they cannot be handed
// to that automatic repair path. Alert evaluation and history are unchanged.
export function responderIncidents(items) {
  const active = [], reportOnly = [];
  for (const item of items) {
    const policy = responsePolicy(item.id);
    if (policy) reportOnly.push({ ...item, responsePolicy: policy });
    else active.push(item);
  }
  return { active, reportOnly };
}
