#!/usr/bin/env python3
"""Report selected SkyLabMac service states to the public status dashboard."""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from gateway_telemetry import gateway_report
from local_diagnostics import diagnostic_items


class NoReadinessRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Evaluate the health endpoint's own response, never a login/fallback page.
        return None


# A private opener leaves report ingestion, heartbeats, and gateway HTTP unchanged.
READINESS_HTTP_OPENER = urllib.request.build_opener(NoReadinessRedirects())

CONFIG_PATH = os.path.expanduser("~/.config/sky-status-agent.json")
# Cloudflare Browser Integrity Check rejects urllib's default User-Agent (error 1010).
USER_AGENT = f"sky-status-agent/1.0 (+{socket.gethostname()})"
LAUNCHD_JOB_STATE_PATH = Path(os.path.expanduser("~/.config/sky-status-launchd-jobs.json"))
BAMBOO_CRON_PATH = Path("/Users/skyhong/.hermes/profiles/bamboo/cron/jobs.json")
BAMBOO_WATCHER_STATE_PATH = Path("/Users/skyhong/.hermes/profiles/bamboo/state/discord-watcher/state.json")
WATCHER_MAX_AGE_SECONDS = 20 * 60
API_PROBE_TIMEOUT_SECONDS = 5
WATCHES = [
    ("process", "caddy", "Caddy", "/usr/local/sbin/caddy run"),
    # The API is served by `localplaud run` (combined poll+serve) on this host, so a
    # `localplaud serve` process grep never matches. Probe the health endpoint instead —
    # that verifies the API is actually serving requests, not just that a process exists.
    ("http", "localplaud-api", "LocalPlaud API", "http://127.0.0.1:8080/healthz"),
    ("process", "localplaud-worker", "LocalPlaud worker", "localplaud run"),
    ("process", "bamboo-gateway", "Bamboo gateway", "hermes_cli.main --profile bamboo gateway run"),
    ("cron", "bamboo-discord", "Bamboo Discord watcher", None),
    ("process", "token-tracker", "TokenTrackerBar", "tracker.js serve --port 7680"),
    # RSSHub runs in Docker under Colima, so this probe also proves the Docker VM is up.
    ("http", "bamboo-rsshub", "Bamboo RSSHub", "http://127.0.0.1:1200/healthz"),
    ("launchd", "claude-rc-localplaud", "Claude remote-control · localplaud", "com.gwenyth.claude-remote-control.localplaud"),
    ("launchd", "claude-rc-youtube-board", "Claude remote-control · youtube-board", "com.gwenyth.claude-remote-control.youtube-board"),
    ("launchd", "website-agent", "Harmonica website agent", "club.nycu.harmonica.website-agent"),
    ("launchd", "website-hermes", "Harmonica website gateway", "club.nycu.harmonica.website-hermes"),
    ("launchd", "hermes-dashboard", "Hermes dashboard UI", "local.hermes.dashboard-ui"),
]


def command_output(command):
    return subprocess.run(command, text=True, capture_output=True, check=False).stdout


def host_metrics(disk_warn=90, mem_warn=92):
    """Best-effort macOS host metrics: disk, load average, and memory."""
    items = []
    try:
        usage = shutil.disk_usage("/")
        pct = round(usage.used / usage.total * 100)
        items.append({"id": "disk-root", "name": "Disk /", "kind": "Host metric", "up": pct < disk_warn,
                      "detail": f"{pct}% used · {usage.used / 1024**3:.0f}G/{usage.total / 1024**3:.0f}G"})
    except OSError:
        pass
    try:
        load1 = os.getloadavg()[0]
        cores = os.cpu_count() or 1
        items.append({"id": "load", "name": "Load average", "kind": "Host metric", "up": load1 < cores * 2,
                      "detail": f"{load1:.2f} over {cores} cores"})
    except (OSError, ValueError):
        pass
    try:
        total = int(command_output(["sysctl", "-n", "hw.memsize"]).strip())
        page_size = 4096
        stats = {}
        for line in command_output(["vm_stat"]).splitlines():
            match = re.search(r"page size of (\d+)", line)
            if match:
                page_size = int(match.group(1))
            key, sep, value = line.partition(":")
            if sep and value.strip().rstrip(".").isdigit():
                stats[key.strip()] = int(value.strip().rstrip("."))
        available = (stats.get("Pages free", 0) + stats.get("Pages inactive", 0) + stats.get("Pages speculative", 0)) * page_size
        pct = round((1 - available / total) * 100)
        items.append({"id": "memory", "name": "Memory", "kind": "Host metric", "up": pct < mem_warn,
                      "detail": f"{pct}% used · {(total - available) / 1024**3:.1f}G/{total / 1024**3:.1f}G"})
    except (OSError, ValueError, ZeroDivisionError):
        pass
    return items


def http_probe(url, timeout=API_PROBE_TIMEOUT_SECONDS, *, accepted_statuses=(200,)):
    """Check readiness, defaulting to HTTP 200.

    Receiving an HTTP response proves liveness, but does not imply readiness.
    An endpoint that intentionally challenges anonymous requests may explicitly
    accept 401/403. Redirects are evaluated without following them; server errors
    always fail readiness.
    """
    def result(code):
        ready = code < 500 and code in accepted_statuses
        return ready, f"{'Ready' if ready else 'Responding but not ready'} · HTTP {code}"

    try:
        with READINESS_HTTP_OPENER.open(url, timeout=timeout) as response:
            return result(response.status)
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        return result(code)
    except (urllib.error.URLError, OSError) as error:
        reason = getattr(error, "reason", error)
        return False, f"Not serving · {reason}"


def http_status_policy(config):
    """Validate endpoint-specific readiness overrides before probing anything."""
    policies = config.get("http_accepted_statuses", {})
    if not isinstance(policies, dict):
        raise ValueError("http_accepted_statuses must be an object")
    http_ids = {identifier for kind, identifier, _, _ in WATCHES if kind == "http"}
    for identifier, statuses in policies.items():
        if identifier not in http_ids:
            raise ValueError("http_accepted_statuses contains an unknown HTTP monitor")
        if not isinstance(statuses, list) or not statuses or any(
            type(code) is not int or not 200 <= code < 500 for code in statuses
        ):
            raise ValueError("HTTP accepted statuses must be a nonempty list of 200–499 codes")
    return policies


def parse_launchctl(listing):
    """Map launchd label -> (pid or None, last exit status or None)."""
    jobs = {}
    for line in listing.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or parts[2] == "Label":
            continue
        pid_text, status_text, label = parts
        pid = int(pid_text) if pid_text.strip().lstrip("-").isdigit() and pid_text.strip() != "-" else None
        try:
            status = int(status_text)
        except ValueError:
            status = None
        jobs[label.strip()] = (pid, status)
    return jobs


def load_launchd_job_state(path=LAUNCHD_JOB_STATE_PATH):
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(loaded, dict):
        return {}
    return {str(label): status for label, status in loaded.items() if isinstance(status, int)}


def save_launchd_job_state(state, path=LAUNCHD_JOB_STATE_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def launchd_status(label, jobs, scheduled=False, previous_status=None):
    """A KeepAlive daemon must be running; a scheduled job is healthy while idle
    as long as its last run exited cleanly."""
    if label not in jobs:
        return False, "Not loaded in launchd"
    pid, status = jobs[label]
    if pid is not None:
        if scheduled and previous_status not in (0, None):
            return False, f"Retry running · previous exit {previous_status}"
        return True, f"Running · PID {pid}"
    if status is not None and status < 0:
        return False, f"Killed by signal {-status}"
    if status not in (0, None):
        return False, f"Last run exited {status}"
    if scheduled:
        return True, "Scheduled · last run ok"
    return False, "Loaded but not running"


def bamboo_discord_status(cron_path=BAMBOO_CRON_PATH, state_path=BAMBOO_WATCHER_STATE_PATH, now=None):
    now = now or datetime.now(timezone.utc)
    try:
        jobs = json.loads(cron_path.read_text(encoding="utf-8")).get("jobs", [])
        job = next((entry for entry in jobs if entry.get("script") == "discord_channel_watcher.py"), None)
    except (OSError, json.JSONDecodeError):
        job = None
    if not job:
        return {"id": "bamboo-discord", "name": "Bamboo Discord watcher", "kind": "Hermes cron", "up": False, "detail": "Cron job not found"}

    try:
        last_run = datetime.fromisoformat(str(job.get("last_run_at", "")).replace("Z", "+00:00"))
        if last_run.tzinfo is None:
            last_run = last_run.replace(tzinfo=timezone.utc)
        run_age = max(0, (now - last_run.astimezone(timezone.utc)).total_seconds())
    except (TypeError, ValueError):
        run_age = float("inf")
    try:
        state_age = max(0, now.timestamp() - state_path.stat().st_mtime)
    except OSError:
        state_age = float("inf")

    enabled = job.get("enabled") is True and job.get("state") == "scheduled"
    successful = job.get("last_status") == "ok" and not job.get("last_error")
    fresh = run_age <= WATCHER_MAX_AGE_SECONDS and state_age <= WATCHER_MAX_AGE_SECONDS
    healthy = enabled and successful and fresh
    if not enabled:
        detail = "Cron job disabled or unscheduled"
    elif not successful:
        detail = f"Last run failed: {job.get('last_error') or job.get('last_status') or 'unknown'}"
    elif run_age > WATCHER_MAX_AGE_SECONDS:
        detail = f"Cron stale · last run {int(run_age // 60)}m ago"
    elif state_age > WATCHER_MAX_AGE_SECONDS:
        detail = f"Watcher state stale · {int(state_age // 60)}m old"
    else:
        detail = f"Cron healthy · last run {int(run_age // 60)}m ago"
    return {"id": "bamboo-discord", "name": "Bamboo Discord watcher", "kind": "Hermes cron", "up": healthy, "detail": detail}


def collect_service_items(processes, launchd, launchd_job_state, status_policy):
    """Compose service items independently of config, telemetry and delivery."""
    launchd_jobs = parse_launchctl(launchd)
    items = []
    bamboo_status = None
    for watch_type, identifier, name, pattern in WATCHES:
        if watch_type == "cron":
            bamboo_status = bamboo_discord_status()
            items.append(bamboo_status)
            continue
        if watch_type == "http":
            up, detail = http_probe(pattern, accepted_statuses=status_policy.get(identifier, (200,)))
            items.append({"id": identifier, "name": name, "kind": "HTTP endpoint", "up": up, "detail": detail})
            continue
        if watch_type in ("launchd", "launchd-job"):
            scheduled = watch_type == "launchd-job"
            pid, status = launchd_jobs.get(pattern, (None, None))
            previous_status = launchd_job_state.get(pattern)
            if scheduled and pid is None and status is not None:
                launchd_job_state[pattern] = status
            up, detail = launchd_status(pattern, launchd_jobs, scheduled=scheduled, previous_status=previous_status)
            kind = "Scheduled job" if scheduled else "LaunchAgent"
            items.append({"id": identifier, "name": name, "kind": kind, "up": up, "detail": detail})
            continue
        present = pattern in processes or pattern in launchd
        detail = "Process detected" if pattern in processes else ("LaunchAgent loaded" if pattern in launchd else "Process not found")
        items.append({"id": identifier, "name": name, "kind": "Process", "up": present, "detail": detail})

    items.extend(diagnostic_items())
    return items, bamboo_status


def main():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as config_file:
            config = json.load(config_file)
        status_policy = http_status_policy(config)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f"status-agent config error: {error}", file=sys.stderr)
        return 1

    processes = command_output(["ps", "-axo", "pid=,args="])
    launchd = command_output(["launchctl", "list"])
    launchd_job_state = load_launchd_job_state()
    items, bamboo_status = collect_service_items(processes, launchd, launchd_job_state, status_policy)
    items.extend(host_metrics())
    save_launchd_job_state(launchd_job_state)

    payload = {"host": socket.gethostname(), "items": items}
    if config.get("gateway", True):
        try:
            payload["gateway"] = gateway_report()
        except Exception as error:  # gateway telemetry must never block the process report
            print(f"status-agent gateway report failed: {error}", file=sys.stderr)
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{config['endpoint'].rstrip('/')}/api/agents/skylabmac",
        data=body,
        headers={"Authorization": f"Bearer {config['token']}", "Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise RuntimeError(f"dashboard returned {response.status}")
    except (urllib.error.URLError, RuntimeError) as error:
        print(f"status-agent report failed: {error}", file=sys.stderr)
        return 1

    if bamboo_status and bamboo_status["up"] and config.get("heartbeat_token"):
        heartbeat = urllib.request.Request(
            f"{config['endpoint'].rstrip('/')}/api/heartbeat/bamboo-discord-watcher",
            headers={"Authorization": f"Bearer {config['heartbeat_token']}", "User-Agent": USER_AGENT},
            method="POST",
        )
        try:
            with urllib.request.urlopen(heartbeat, timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError(f"heartbeat returned {response.status}")
        except (urllib.error.URLError, RuntimeError) as error:
            print(f"status-agent heartbeat failed: {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
