function deliveryUsable(status) {
  if (!status?.configured) return false;
  const success = Date.parse(status.lastSuccessAt || '');
  const failure = Date.parse(status.lastFailureAt || '');
  return !Number.isFinite(failure) || (Number.isFinite(success) && success >= failure);
}

export function buildHealthSnapshot(options, now = Date.now()) {
  const { state, intervalMs, dockerConfigured } = options;
  const checkedAt = Date.parse(state.checkedAt || '');
  const errors = state.errors || [];
  const checks = {
    refreshFresh: Number.isFinite(checkedAt) && now - checkedAt <= intervalMs * 3,
    collectorErrors: errors.length === 0,
    dockerConnected: !dockerConfigured || ((state.services || []).length > 0 && !errors.some((error) => error.startsWith('Docker'))),
    incidentWebhookUsable: deliveryUsable(state.alertDelivery?.incident),
  };
  return { ok: Object.values(checks).every(Boolean), checkedAt: state.checkedAt, checks };
}

// Routing must remain available to receive reports when a monitored dependency fails.
export function buildReadinessSnapshot({ state, intervalMs }, now = Date.now()) {
  const checkedAt = Date.parse(state.checkedAt || '');
  const checks = {
    refreshFresh: Number.isFinite(checkedAt) && now - checkedAt <= intervalMs * 3,
  };
  return { ok: checks.refreshFresh, checkedAt: state.checkedAt, checks };
}

export { deliveryUsable };
