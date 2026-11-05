const PROJECT_LABEL = 'com.docker.compose.project';

// Compose projects with at least one running container. A clean exit in a
// project that is otherwise still running is a real failure; a project whose
// containers all stopped was shut down on purpose.
export function runningProjects(containers) {
  const projects = new Set();
  for (const container of containers || []) {
    const project = container.Labels?.[PROJECT_LABEL];
    if (project && container.State === 'running') projects.add(project);
  }
  return projects;
}

// A container that exited cleanly (code 0) was stopped deliberately when it
// either never asked to be restarted or its whole Compose project is down.
// Such leftovers are shown as "Stopped" and never count as an outage.
export function isIntentionallyStopped(container, inspect, liveProjects) {
  if (container.State !== 'exited') return false;
  if (inspect?.State?.ExitCode !== 0 || inspect?.State?.OOMKilled) return false;
  const policy = inspect?.HostConfig?.RestartPolicy?.Name || 'no';
  if (policy === 'no') return true;
  const project = container.Labels?.[PROJECT_LABEL];
  return Boolean(project) && !liveProjects.has(project);
}

export function containerStatus(container, inspect, liveProjects) {
  const name = container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12);
  const restarts = inspect?.RestartCount ?? 0;
  const oomKilled = Boolean(inspect?.State?.OOMKilled);
  const restarting = Boolean(inspect?.State?.Restarting) || container.State === 'restarting';
  const unhealthy = Boolean(container.Status?.includes('(unhealthy)'));
  let detail = container.Status || container.State;
  if (isIntentionallyStopped(container, inspect, liveProjects)) {
    return { id: container.Id, name, kind: 'Container', up: true, stopped: true, detail: `Stopped · ${detail}` };
  }
  const up = container.State === 'running' && !unhealthy && !restarting && !oomKilled;
  if (oomKilled) detail = `OOMKilled · ${detail}`;
  else if (restarting) detail = `Restarting · ${detail}`;
  if (restarts > 0) detail += ` · ${restarts} restarts`;
  return { id: container.Id, name, kind: 'Container', up, detail };
}
