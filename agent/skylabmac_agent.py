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

CONFIG_PATH = os.path.expanduser("~/.config/sky-status-agent.json")
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
    ("process", "nycu-haix-runner", "NYCU-HAIX runner", "actions.runner.nycu-haix-omniobserve.sky-mac-mini"),
    # RSSHub runs in Docker under Colima, so this probe also proves the Docker VM is up.
    ("http", "bamboo-rsshub", "Bamboo RSSHub", "http://127.0.0.1:1200/healthz"),
    ("http", "ollama", "Ollama API", "http://127.0.0.1:11434/api/version"),
    ("http", "cliproxyapi", "CLIProxyAPI", "http://127.0.0.1:8317/"),
    ("launchd", "claude-rc-localplaud", "Claude remote-control · localplaud", "com.gwenyth.claude-remote-control.localplaud"),
    ("launchd", "claude-rc-youtube-board", "Claude remote-control · youtube-board", "com.gwenyth.claude-remote-control.youtube-board"),
    ("launchd", "website-agent", "Harmonica website agent", "club.nycu.harmonica.website-agent"),
    ("launchd", "website-hermes", "Harmonica website gateway", "club.nycu.harmonica.website-hermes"),
    ("launchd", "hermes-dashboard", "Hermes dashboard UI", "local.hermes.dashboard-ui"),
    ("launchd", "chumei-bot-line", "Chumei LINE bot", "tw.observe.chumei.bot-line"),
    ("launchd", "chumei-bot-telegram", "Chumei Telegram bot", "tw.observe.chumei.bot-telegram"),
    ("launchd", "chumei-mcp", "Chumei MCP server", "tw.observe.chumei.mcp"),
    ("launchd", "chumei-push", "Chumei push server", "tw.observe.chumei.push"),
    ("launchd-job", "chumei-pipeline", "Chumei pipeline", "tw.observe.chumei.pipeline"),
    ("launchd-job", "chumei-push-drip", "Chumei push drip", "tw.observe.chumei.push-drip"),
    ("launchd-job", "chumei-telegram-publish", "Chumei Telegram publisher", "tw.observe.chumei.telegram"),
    ("launchd-job", "harmonica-pipeline", "Harmonica pipeline", "tw.observe.harmonica.pipeline"),
    ("launchd-job", "harmonica-social-fast", "Harmonica social-fast", "tw.observe.harmonica.social-fast"),
    ("launchd-job", "harmonica-submission-intake", "Harmonica submission intake", "tw.observe.harmonica.submission-intake"),
    ("launchd-job", "harmonica-calendar", "Harmonica calendar sync", "tw.observe.harmonica.calendar-maintenance"),
    ("launchd-job", "mayor2026-pipeline", "Mayor2026 pipeline", "tw.observe.mayor2026.pipeline"),
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


def http_probe(url, timeout=API_PROBE_TIMEOUT_SECONDS):
    """Check a local HTTP endpoint. Any HTTP response means the server is serving;
    an auth challenge (401/403) still proves the process is up. Only connection
    errors or timeouts count as down."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return True, f"Serving · HTTP {response.status}"
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        return True, f"Serving · HTTP {code}"
    except (urllib.error.URLError, OSError) as error:
        reason = getattr(error, "reason", error)
        return False, f"Not serving · {reason}"


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


def launchd_status(label, jobs, scheduled=False):
    """A KeepAlive daemon must be running; a scheduled job is healthy while idle
    as long as its last run exited cleanly."""
    if label not in jobs:
        return False, "Not loaded in launchd"
    pid, status = jobs[label]
    if pid is not None:
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


def main():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as config_file:
            config = json.load(config_file)
    except (OSError, json.JSONDecodeError) as error:
        print(f"status-agent config error: {error}", file=sys.stderr)
        return 1

    processes = command_output(["ps", "-axo", "pid=,args="])
    launchd = command_output(["launchctl", "list"])
    launchd_jobs = parse_launchctl(launchd)
    items = []
    bamboo_status = None
    for watch_type, identifier, name, pattern in WATCHES:
        if watch_type == "cron":
            bamboo_status = bamboo_discord_status()
            items.append(bamboo_status)
            continue
        if watch_type == "http":
            up, detail = http_probe(pattern)
            items.append({"id": identifier, "name": name, "kind": "HTTP endpoint", "up": up, "detail": detail})
            continue
        if watch_type in ("launchd", "launchd-job"):
            scheduled = watch_type == "launchd-job"
            up, detail = launchd_status(pattern, launchd_jobs, scheduled=scheduled)
            kind = "Scheduled job" if scheduled else "LaunchAgent"
            items.append({"id": identifier, "name": name, "kind": kind, "up": up, "detail": detail})
            continue
        present = pattern in processes or pattern in launchd
        detail = "Process detected" if pattern in processes else ("LaunchAgent loaded" if pattern in launchd else "Process not found")
        items.append({"id": identifier, "name": name, "kind": "Process", "up": present, "detail": detail})

    items.extend(host_metrics())

    body = json.dumps({"host": socket.gethostname(), "items": items}).encode("utf-8")
    request = urllib.request.Request(
        f"{config['endpoint'].rstrip('/')}/api/agents/skylabmac",
        data=body,
        headers={"Authorization": f"Bearer {config['token']}", "Content-Type": "application/json"},
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
            headers={"Authorization": f"Bearer {config['heartbeat_token']}"},
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
