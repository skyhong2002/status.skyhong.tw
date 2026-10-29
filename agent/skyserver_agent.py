#!/usr/bin/env python3
"""Report sky-server's Docker services and systemd jobs to the status dashboard.

Runs once a minute from the user sky-status-agent.timer. Docker group access
is required; only the root-owned Chumei completion artifact is read via sudo.
Configuration comes from the private user EnvironmentFile:

    STATUS_ENDPOINT=https://status.skyhong.tw
    AGENT_INGEST_TOKEN=...
"""

import fnmatch
import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

AGENT_ID = "sky-server"
JOB_STATE_PATH = Path(os.environ.get("STATE_DIRECTORY", str(Path.home() / ".local/state/sky-status-agent"))) / "systemd-jobs.json"
COMMAND_TIMEOUT_SECONDS = 20
CHUMEI_PIPELINE_STATE_PATH = Path("/srv/chumei/state/pipeline.json")
# The pipeline runs every three hours; allow an hour for a delayed/long run.
CHUMEI_PIPELINE_MAX_AGE_SECONDS = 4 * 60 * 60

# Long-running services: (monitor id, display name, container name).
CONTAINERS = [
    ("chumei-auth", "Chumei auth server", "chumei-auth"),
    ("chumei-bot-line", "Chumei LINE bot", "chumei-bot-line"),
    ("chumei-bot-telegram", "Chumei Telegram bot", "chumei-bot-telegram"),
    ("chumei-mcp", "Chumei MCP server", "chumei-mcp"),
    ("chumei-push", "Chumei push server", "chumei-push"),
]
# Scheduled jobs: (monitor id, display name, unit name without suffix). Each has
# a <unit>.timer that starts a oneshot <unit>.service.
TIMERS = [
    ("chumei-pipeline", "Chumei pipeline", "chumei-pipeline"),
    ("chumei-push-drip", "Chumei push drip", "chumei-push-drip"),
    ("chumei-submissions", "Chumei submissions sync", "chumei-submissions"),
    ("chumei-telegram-publish", "Chumei Telegram publisher", "chumei-telegram"),
    ("harmonica-pipeline", "Harmonica pipeline", "harmonica-pipeline"),
    ("harmonica-social-fast", "Harmonica social-fast", "harmonica-social-fast"),
    ("harmonica-submission-intake", "Harmonica submission intake", "harmonica-submission-intake"),
    ("harmonica-calendar", "Harmonica calendar sync", "harmonica-calendar-maintenance"),
    ("mayor2026-pipeline", "Mayor2026 pipeline", "mayor2026-pipeline"),
]
# Match deployment-generated container names without pinning Swarm task IDs.
CONTAINER_PATTERNS = [
    ("chumei-web", "chumei-prod-*-web-1"), ("myzilla", "myzilla"),
    *[("urtube-" + role, "urtube-*-" + role + "-1") for role in
      ("app", "ingest", "worker", "backup", "matching-worker", "matching-compare", "matching-compute")],
    ("ai-gateway-ha", "ai-gateway-ha"),
    ("harmonica-web", "harmonica-w2-*-web-1"),
    ("chumei-preview", "mini-w1-chumei-preview-*-web-1"),
    ("harmonica-preview", "mini-w1-harmonica-preview-*-web-1"),
    ("mayor2026-web", "mini-w1-mayor2026-*-web-1"),
    ("rsshub-public", "mini-w1-rsshub-*-rsshub-1"),
    ("rsshub-frontend", "mini-w1-rsshub-*-frontend-1"),
    *[(name, name) for name in ("tag-db", "tag-redis", "tag-adminer", "tag-alloy", "tag-loki", "blog-observe-redis", "dokploy-traefik")],
    ("dokploy", "dokploy.1.*"), ("dokploy-postgres", "dokploy-postgres.1.*"),
]
USER_TIMERS = [(name, name, name) for name in (
    "tag-availability-monitor", "tag-backup", "tag-legacy-continuous",
    "tag-legacy-nearline", "tag-legacy-quarantine", "tag-nearline-check-2h",
    "tag-vocabulary-export", "tag-vocabulary-fast", "tag-vocabulary-reconcile",
    "blog-observe-active-favicons", "myzilla-digest", "myzilla-health-monitor",
    "reporter-health-monitor", "infovore-health-monitor")]
# Disabled tag-nearline-index has intentionally never been scheduled.
USER_SERVICES = [name + ".service" for name in (
    "tag-analysis", "tag-web", "tag-worker", "tag-nearline-operations",
    "tag-telegram-artifacts-preview", "blog-observe-edge", "blog-observe-worker",
    "blog-observe-gateway@blue", "blog-observe-gateway@green",
    "blog-observe-web@blue", "blog-observe-web@green",
    "traffic-observe-web", "traffic-observe-worker", "host-observer", "weblog-cloudflared")]
SYSTEM_SERVICES = ["cloudflared-sky-server.service"]
HTTP_CHECKS = [
    ("tag-http", "http://127.0.0.1:18130/", None, (200,)),
    ("site-http", "http://127.0.0.1:18150/", None, (200,)),
    ("weblog-http", "http://127.0.0.1:18160/", None, (200,)),
    ("blog-http", "http://127.0.0.1:18172/", None, (200, 308)),
    ("traffic-http", "http://127.0.0.1:18150/", "traffic.observe.tw", (308,)),
    ("urtube-http", "http://127.0.0.1/healthz", "urtube.observe.tw", (200,)),
    ("rsshub-http", "http://127.0.0.1/healthz", "rss.observe.tw", (200,)),
    ("myzilla-http", "http://127.0.0.1/health", "myzilla.observe.tw", (200,)),
    ("host-observer-http", "http://127.0.0.1:19120/health", None, (200,)),
]

class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def http_items():
    opener = urllib.request.build_opener(NoRedirects())
    items = []
    for identifier, url, host, accepted in HTTP_CHECKS:
        request = urllib.request.Request(url, headers={"Host": host} if host else {})
        try:
            with opener.open(request, timeout=5) as response:
                code = response.status
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
        except (OSError, urllib.error.URLError):
            code = 0
        items.append(dict(id=identifier, name=identifier, kind="HTTP endpoint",
                          up=code in accepted, detail=f"HTTP {code}" if code else "Endpoint unavailable"))
    return items


def extra_items(docker_output, system_output, user_output, job_state):
    states = parse_docker_states(docker_output)
    items = []
    for identifier, pattern in CONTAINER_PATTERNS:
        matches = [name for name in states if fnmatch.fnmatchcase(name, pattern)]
        results = [container_status(name, states) for name in matches]
        items.append(dict(id=identifier, name=identifier, kind="Docker container",
                          up=bool(matches) and all(up for up, _ in results),
                          detail="; ".join(sorted(set(detail for _, detail in results))) if matches else "Container not found"))
    system = parse_systemctl_show(system_output)
    user = parse_systemctl_show(user_output)
    for unit in SYSTEM_SERVICES + USER_SERVICES:
        properties = (system if unit in SYSTEM_SERVICES else user).get(unit, {})
        up = properties.get("LoadState") == "loaded" and properties.get("ActiveState") == "active"
        items.append(dict(id=unit, name=unit, kind="systemd service", up=up,
                          detail=properties.get("ActiveState", "Unit missing")))
    for identifier, name, unit in USER_TIMERS:
        up, detail = timer_job_status(unit, user, job_state.get("user:" + unit))
        service = user.get(unit + ".service", {})
        if service.get("ActiveState") in ("inactive", "failed") and service.get("Result"):
            job_state["user:" + unit] = service["Result"]
        items.append(dict(id=identifier, name=name, kind="Scheduled job", up=up, detail=detail))
    return items


SYSTEMD_PROPERTIES = "Id,LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainExitTimestampMonotonic"


def command_output(command):
    try:
        return subprocess.run(command, text=True, capture_output=True, check=False,
                              timeout=COMMAND_TIMEOUT_SECONDS).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def parse_docker_states(output):
    """Map container name -> State object from `docker inspect` lines of `name<TAB>json`."""
    states = {}
    for line in output.splitlines():
        name, sep, state = line.partition("\t")
        if not sep:
            continue
        try:
            parsed = json.loads(state)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            states[name.lstrip("/")] = parsed
    return states


def container_status(container, states):
    """A service container must be running and, when it has a healthcheck, healthy."""
    state = states.get(container)
    if state is None:
        return False, "Container not found"
    status = state.get("Status") or "unknown"
    if status != "running":
        if status == "exited":
            return False, f"Container exited {state.get('ExitCode')}"
        return False, f"Container {status}"
    health = (state.get("Health") or {}).get("Status")
    if health in (None, "healthy"):
        return True, "Running" + (" · healthy" if health else "")
    return False, f"Running but {health}"


def parse_systemctl_show(output):
    """Map unit Id -> properties from `systemctl show` (blank-line separated blocks)."""
    units = {}
    for block in output.split("\n\n"):
        properties = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        if properties.get("Id"):
            units[properties["Id"]] = properties
    return units


def timer_job_status(unit, units, previous_result=None):
    """A scheduled job is healthy while its timer is active and its last run succeeded.

    A job that has never run is healthy (its first trigger is pending). A failed
    run stays down while a retry is running, mirroring the launchd job policy.
    """
    timer = units.get(f"{unit}.timer", {})
    service = units.get(f"{unit}.service", {})
    if timer.get("LoadState") != "loaded" or service.get("LoadState") != "loaded":
        return False, "Timer not installed"
    if timer.get("ActiveState") != "active":
        return False, f"Timer {timer.get('ActiveState') or 'unknown'}"
    if service.get("ActiveState") in ("activating", "active", "reloading"):
        if previous_result not in (None, "success"):
            return False, f"Retry running · previous result {previous_result}"
        return True, "Running"
    result = service.get("Result") or "unknown"
    if service.get("ActiveState") == "failed" or result != "success":
        return False, f"Last run failed · {result}, exit {service.get('ExecMainStatus', '?')}"
    if service.get("ExecMainExitTimestampMonotonic", "0") in ("", "0"):
        return True, "Scheduled · not run yet"
    return True, "Scheduled · last run ok"


def chumei_pipeline_freshness(path=CHUMEI_PIPELINE_STATE_PATH,
                              max_age_seconds=CHUMEI_PIPELINE_MAX_AGE_SECONDS, now=None):
    """Read the pipeline's completed publish result, never log/file mtime.

    Chumei writes last_run and last_results after its steps complete. Partial
    fetch failures are intentionally tolerated by the producer; build (and the
    legacy telegram step, when present) determine its successful exit status.
    """
    now = now or datetime.now(timezone.utc)
    try:
        try:
            raw = Path(path).read_text(encoding="utf-8")
        except PermissionError:
            if Path(path) != CHUMEI_PIPELINE_STATE_PATH:
                raise
            raw = command_output(["sudo", "-n", "/usr/bin/cat", str(CHUMEI_PIPELINE_STATE_PATH)])
        data = json.loads(raw)
        results = data["last_results"]
        if not isinstance(results, dict):
            raise ValueError("missing results")
        if results.get("build") is not True or results.get("telegram", True) is not True:
            return False, "Last completed pipeline did not publish successfully"
        completed = datetime.fromisoformat(data["last_run"].replace("Z", "+00:00"))
        if completed.tzinfo is None:
            raise ValueError("missing timezone")
        age = (now - completed).total_seconds()
        if age < -60:
            return False, "Pipeline completion time is in the future"
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False, "Pipeline completion evidence missing or invalid"
    minutes = int(max(0, age) // 60)
    if age > max_age_seconds:
        return False, f"Pipeline stale · last successful publish {minutes}m ago"
    return True, f"Last successful publish {minutes}m ago"


def scheduled_job_status(identifier, unit, units, previous_result=None):
    up, detail = timer_job_status(unit, units, previous_result=previous_result)
    if up and identifier == "chumei-pipeline":
        # Only Chumei records an attributable, durable last-success artifact.
        fresh, evidence = chumei_pipeline_freshness()
        return fresh, f"{detail} · {evidence}"
    return up, detail


def load_job_state(path=JOB_STATE_PATH):
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(loaded, dict):
        return {}
    return {str(unit): result for unit, result in loaded.items() if isinstance(result, str)}


def save_job_state(state, path=JOB_STATE_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def collect_items(docker_output, systemd_output, job_state):
    """Compose report items; records each finished job's result into job_state."""
    states = parse_docker_states(docker_output)
    units = parse_systemctl_show(systemd_output)
    items = []
    for identifier, name, container in CONTAINERS:
        up, detail = container_status(container, states)
        items.append({"id": identifier, "name": name, "kind": "Docker container", "up": up, "detail": detail})
    for identifier, name, unit in TIMERS:
        up, detail = scheduled_job_status(identifier, unit, units, previous_result=job_state.get(unit))
        service = units.get(f"{unit}.service", {})
        if service.get("ActiveState") in ("inactive", "failed") and service.get("Result"):
            job_state[unit] = service["Result"]
        items.append({"id": identifier, "name": name, "kind": "Scheduled job", "up": up, "detail": detail})
    return items


def main():
    endpoint = os.environ.get("STATUS_ENDPOINT", "https://status.skyhong.tw")
    token = os.environ.get("AGENT_INGEST_TOKEN")
    if not token:
        print("status-agent config error: AGENT_INGEST_TOKEN required", file=sys.stderr)
        return 1

    names = command_output(["docker", "ps", "-a", "--format", "{{.Names}}"]).splitlines()
    selected = [name for name in names if name in {c for _, _, c in CONTAINERS}
                or any(fnmatch.fnmatchcase(name, pattern) for _, pattern in CONTAINER_PATTERNS)]
    docker_output = command_output(
        ["docker", "inspect", "--format", "{{.Name}}\t{{json .State}}", *selected]) if selected else ""
    units = [f"{unit}.{suffix}" for _, _, unit in TIMERS for suffix in ("timer", "service")]
    systemd_output = command_output(["systemctl", "show", f"--property={SYSTEMD_PROPERTIES}", *units, *SYSTEM_SERVICES])
    job_state = load_job_state()
    items = collect_items(docker_output, systemd_output, job_state)
    user_units = [f"{unit}.{suffix}" for _, _, unit in USER_TIMERS for suffix in ("timer", "service")]
    user_output = command_output(["systemctl", "--user", "show", f"--property={SYSTEMD_PROPERTIES}", *user_units, *USER_SERVICES])
    items.extend(extra_items(docker_output, systemd_output, user_output, job_state))
    items.extend(http_items())
    save_job_state(job_state)

    body = json.dumps({"host": socket.gethostname(), "items": items}).encode("utf-8")
    request = urllib.request.Request(
        f"{endpoint.rstrip('/')}/api/agents/{AGENT_ID}",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise RuntimeError(f"dashboard returned {response.status}")
    except (urllib.error.URLError, RuntimeError) as error:
        print(f"status-agent report failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
