import assert from 'node:assert/strict';
import test from 'node:test';
import { containerStatus, runningProjects } from './docker.mjs';

const container = (name, state, project, status = state === 'running' ? 'Up 2 hours' : 'Exited (0) 6 days ago') => ({
  Id: `${name}-id`, Names: [`/${name}`], State: state, Status: status,
  Labels: project ? { 'com.docker.compose.project': project } : {},
});
const inspect = (exitCode, policy, extra = {}) => ({ RestartCount: 0, State: { ExitCode: exitCode, OOMKilled: false, Restarting: false, ...extra }, HostConfig: { RestartPolicy: { Name: policy } } });

test('a clean exit without a restart policy is a deliberate stop', () => {
  const item = containerStatus(container('test-db', 'exited', 'rewrite'), inspect(0, 'no'), new Set());
  assert.equal(item.up, true);
  assert.equal(item.stopped, true);
  assert.equal(item.detail, 'Stopped · Exited (0) 6 days ago');
});

test('a clean exit in a fully stopped Compose project is a deliberate stop', () => {
  const containers = [container('old-web', 'exited', 'old'), container('old-db', 'exited', 'old')];
  const item = containerStatus(containers[0], inspect(0, 'unless-stopped'), runningProjects(containers));
  assert.equal(item.stopped, true);
});

test('a clean exit while the rest of its project still runs is down', () => {
  const containers = [container('app-web', 'exited', 'app'), container('app-db', 'running', 'app')];
  const item = containerStatus(containers[0], inspect(0, 'unless-stopped'), runningProjects(containers));
  assert.equal(item.up, false);
  assert.equal(item.stopped, undefined);
});

test('crashes, OOM kills and unknown exit codes stay down', () => {
  assert.equal(containerStatus(container('crash', 'exited', null, 'Exited (1) 1 minute ago'), inspect(1, 'no'), new Set()).up, false);
  assert.equal(containerStatus(container('oom', 'exited', null), inspect(0, 'no', { OOMKilled: true }), new Set()).up, false);
  assert.equal(containerStatus(container('lost', 'exited', null), null, new Set()).up, false);
});

test('running containers keep their health and restart details', () => {
  assert.equal(containerStatus(container('web', 'running', 'app'), inspect(0, 'always'), new Set(['app'])).up, true);
  const sick = containerStatus(container('web', 'running', 'app', 'Up 1 hour (unhealthy)'), { ...inspect(0, 'always'), RestartCount: 3 }, new Set(['app']));
  assert.equal(sick.up, false);
  assert.equal(sick.detail, 'Up 1 hour (unhealthy) · 3 restarts');
});
