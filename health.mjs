function deliveryUsable(status) {
  if (!status?.configured) return false;
  const success = Date.parse(status.lastSuccessAt || '');
  const failure = Date.parse(status.lastFailureAt || '');
  return !Number.isFinite(failure) || (Number.isFinite(success) && success >= failure);
}

export function buildHealthSnapshot(options, now = Date.now()) {
  const { state, intervalMs, dockerConfigured, usageConfigured, usageSyncIntervalMs } = options;
  const checkedAt = Date.parse(state.checkedAt || '');
  const ai = state.aiUsage?.[0];
  const aiSyncedAt = Date.parse(ai?.lastSyncAt || '');
  const errors = state.errors || [];
  const checks = {
    refreshFresh: Number.isFinite(checkedAt) && now - checkedAt <= intervalMs * 3,
    collectorErrors: errors.length === 0,
    dockerConnected: !dockerConfigured || ((state.services || []).length > 0 && !errors.some((error) => error.startsWith('Docker'))),
    openaiConnected: !usageConfigured || (ai?.connected !== false && Number.isFinite(aiSyncedAt) && now - aiSyncedAt <= usageSyncIntervalMs * 3),
    incidentWebhookUsable: deliveryUsable(state.alertDelivery?.incident),
    usageWebhookUsable: !usageConfigured || deliveryUsable(state.alertDelivery?.usage),
  };
  return { ok: Object.values(checks).every(Boolean), checkedAt: state.checkedAt, checks };
}

export { deliveryUsable };
