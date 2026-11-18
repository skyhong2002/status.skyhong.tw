import test from 'node:test';
import assert from 'node:assert/strict';
import { skyServerBackupHeartbeat, responsePolicy, responderIncidents } from './backup-policy.mjs';
import { configureSkyServerBackup } from './scripts/configure_skyserver_backup.mjs';
import { heartbeatStatus } from './heartbeats.mjs';

test('weekly success event deadline is exactly 204h, independent of reliability', () => {
  const now = 1e12, deadline = 204 * 3600_000;
  assert.equal(heartbeatStatus(skyServerBackupHeartbeat, now - deadline, now).up, true);
  assert.equal(heartbeatStatus(skyServerBackupHeartbeat, now - deadline - 1, now).up, false);
  assert.equal(heartbeatStatus(skyServerBackupHeartbeat, now + 1, now).up, false);
  assert.equal(heartbeatStatus(skyServerBackupHeartbeat, 'bad', now).up, false);
});

test('targeted production config preserves every other host and unrelated setting', () => {
  const other = { id: 'nas-backup-sky-mini', periodSeconds: 86400, graceSeconds: 21600 };
  const entries = [other, { id: 'nas-backup-sky-server', periodSeconds: 86400 }];
  for (const raw of [JSON.stringify(entries), JSON.stringify(JSON.stringify(entries)), `'${JSON.stringify(entries)}'`]) {
    const text = `TOKEN=private-placeholder\nHEARTBEATS_JSON=${raw}\nOTHER=preserve\n`;
    const updated = configureSkyServerBackup(text);
    const value = JSON.parse(updated.split('\n')[1].slice("HEARTBEATS_JSON='".length, -1));
    assert.deepEqual(value[0], other);
    assert.deepEqual(value[1], skyServerBackupHeartbeat);
    assert.equal(updated.split('\n')[0], text.split('\n')[0]);
    assert.equal(configureSkyServerBackup(updated), updated);
  }
  assert.throws(() => configureSkyServerBackup('HEARTBEATS_JSON=[]'));
});

test('backup incidents require report-only gated review while unrelated incidents retain policy', () => {
  for (const id of ['remote:sky-server:backup-reliability', 'remote:sky-server:tag-backup',
    'remote:sky-server:host-observer-http', 'remote:sky-server:host-observer.service',
    'heartbeat:nas-backup-sky-server', 'heartbeat:nas-backup-verify-sky-server']) {
    assert.equal(responsePolicy(id).automaticRemediationAllowed, false);
    assert.equal(responsePolicy(id).action, 'report-only');
  }
  assert.equal(responsePolicy('heartbeat:nas-backup-sky-mini'), null);
  assert.equal(responsePolicy('target:skyhong-tw'), null);
  const incident = { id: 'remote:sky-server:backup-reliability', confirmed: true, alerted: true, failingSince: 'original' };
  const other = { id: 'target:skyhong-tw', confirmed: true };
  const result = responderIncidents([incident, other]);
  assert.deepEqual(result.active, [other]);
  assert.deepEqual(result.reportOnly[0], { ...incident, responsePolicy: responsePolicy(incident.id) });
});
