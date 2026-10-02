#!/usr/bin/env python3
"""Report selected SkyLabMac service states to the public status dashboard."""

import json
import os
import re
import select
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CONFIG_PATH = os.path.expanduser("~/.config/sky-status-agent.json")
LAUNCHD_JOB_STATE_PATH = Path(os.path.expanduser("~/.config/sky-status-launchd-jobs.json"))
BAMBOO_CRON_PATH = Path("/Users/skyhong/.hermes/profiles/bamboo/cron/jobs.json")
BAMBOO_WATCHER_STATE_PATH = Path("/Users/skyhong/.hermes/profiles/bamboo/state/discord-watcher/state.json")
WATCHER_MAX_AGE_SECONDS = 20 * 60
GATEWAY_BASE_URL = "http://127.0.0.1:8317/v1"
GATEWAY_CLIENTS_PATH = Path(os.path.expanduser("~/.config/ai-gateway/clients.env"))
GATEWAY_POLICY_PATH = Path(os.path.expanduser("~/Projects/ai-gateway/model-policy.json"))
GATEWAY_CONFIG_PATH = Path("/opt/homebrew/etc/cliproxyapi.conf")
GATEWAY_AUTH_DIR = Path(os.path.expanduser("~/.cli-proxy-api"))
GATEWAY_STATE_PATH = Path(os.path.expanduser("~/.config/sky-status-gateway.json"))
# Listing models is free; inference spends subscription quota, so keep it rare and tiny.
GATEWAY_INFERENCE_INTERVAL_SECONDS = 30 * 60
GATEWAY_INFERENCE_ALIAS = "sky-fast"
GATEWAY_USAGE_INTERVAL_SECONDS = 5 * 60
CODEX_CANDIDATES = (
    os.path.expanduser("~/.local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
)
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
    ("launchd", "urtube-codex-shim", "URtube Codex shim", "tw.observe.urtube.codex-shim"),
    ("launchd", "chumei-auth", "Chumei auth server", "tw.observe.chumei.auth"),
    # Promo file server is submitted ad-hoc via `launchctl submit` (no plist), so going
    # down after a reboot is exactly what this watch should surface.
    ("launchd", "chumei-promo-files", "Chumei promo file server", "com.chumei.promo-files"),
    ("launchd", "chumei-bot-line", "Chumei LINE bot", "tw.observe.chumei.bot-line"),
    ("launchd", "chumei-bot-telegram", "Chumei Telegram bot", "tw.observe.chumei.bot-telegram"),
    ("launchd", "chumei-mcp", "Chumei MCP server", "tw.observe.chumei.mcp"),
    ("launchd", "chumei-push", "Chumei push server", "tw.observe.chumei.push"),
    ("launchd-job", "chumei-pipeline", "Chumei pipeline", "tw.observe.chumei.pipeline"),
    ("launchd-job", "chumei-push-drip", "Chumei push drip", "tw.observe.chumei.push-drip"),
    ("launchd-job", "chumei-submissions", "Chumei submissions sync", "tw.observe.chumei.submissions"),
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


def iso_utc(moment):
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def gateway_client_key(path=GATEWAY_CLIENTS_PATH, name="status"):
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.strip() == name:
                return value.strip()
    except OSError:
        pass
    return None


def gateway_request(path, key, body=None, timeout=5):
    """Call the local gateway. Returns (status code or None, parsed JSON or None, latency ms, error)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {key}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{GATEWAY_BASE_URL}{path}", data=data, headers=headers)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
            return response.status, payload, round((time.monotonic() - started) * 1000), None
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        return code, None, round((time.monotonic() - started) * 1000), f"HTTP {code}"
    except (urllib.error.URLError, OSError, ValueError) as error:
        return None, None, round((time.monotonic() - started) * 1000), str(getattr(error, "reason", error))[:120]


def parse_gateway_config(text):
    """Read the alias mapping and policy revision that apply.py wrote into the gateway config."""
    revision = None
    aliases = {}
    in_block = False
    pending_name = None
    for line in text.splitlines():
        match = re.search(r"Managed by ai-gateway/apply\.py, policy revision (\S+)", line)
        if match:
            revision = match.group(1)
        if re.match(r"^oauth-model-alias:", line):
            in_block = True
            continue
        if in_block and line and not line[0].isspace() and not line.startswith("#"):
            in_block = False
        if not in_block:
            continue
        name = re.match(r'^\s+-\s+name:\s*"?([^"#\s]+)"?', line)
        if name:
            pending_name = name.group(1)
            continue
        alias = re.match(r'^\s+alias:\s*"?([^"#\s]+)"?', line)
        if alias and pending_name:
            aliases[alias.group(1)] = pending_name
            pending_name = None
    return {"revision": revision, "aliases": aliases}


def mask_account(email):
    if not isinstance(email, str) or not email:
        return None
    local, _, domain = email.partition("@")
    return f"{local[:1]}••@{domain}" if domain else f"{local[:1]}••"


def codex_credential(auth_dir=GATEWAY_AUTH_DIR):
    """Summarize the gateway's Codex OAuth login without exposing any token."""
    files = sorted(auth_dir.glob("codex-*.json"))
    if not files:
        return {"present": False}, None
    try:
        data = json.loads(files[0].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"present": False}, None
    plan = files[0].stem.rsplit("-", 1)[-1] if files[0].stem.count("-") >= 2 else None

    def stamp(value):
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
        return iso_utc(parsed) if parsed.tzinfo else None

    summary = {
        "present": bool(data.get("access_token") or data.get("refresh_token")),
        "disabled": data.get("disabled") is True,
        "refreshable": bool(data.get("refresh_token")),
        "account": mask_account(data.get("email")),
        "plan": plan,
        "accessExpiresAt": stamp(data.get("expired")),
        "lastRefreshAt": stamp(data.get("last_refresh")),
    }
    return summary, {"email": data.get("email"), "accountId": data.get("account_id")}


def codex_executable():
    found = shutil.which("codex")
    if found:
        return found
    return next((path for path in CODEX_CANDIDATES if os.access(path, os.X_OK)), None)


def read_codex_rate_limits(timeout=20):
    """Ask `codex app-server` for the account and its rate-limit windows (no model turn)."""
    executable = codex_executable()
    if executable is None:
        raise RuntimeError("codex CLI not found")
    process = subprocess.Popen([executable, "app-server", "--stdio"], text=True, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=1)
    try:
        messages = (
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"clientInfo": {"name": "sky-status-agent", "version": "1"}, "capabilities": {"experimentalApi": True}}},
            {"jsonrpc": "2.0", "method": "initialized", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "account/read", "params": {}},
        )
        for message in messages:
            process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()
        results = {}
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and len(results) < 2:
            readable, _, _ = select.select([process.stdout], [], [], 0.5)
            if not readable:
                if process.poll() is not None:
                    break
                continue
            line = process.stdout.readline()
            if not line:
                break
            response = json.loads(line)
            if response.get("id") in (2, 3):
                if response.get("error"):
                    raise RuntimeError("app-server returned an error")
                results[response["id"]] = response.get("result") or {}
        if 2 not in results:
            raise RuntimeError("rate limits not returned in time")
        return results[2], results.get(3, {})
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()


def summarize_rate_limits(rate_limits, account, credential_identity, now):
    snapshot = (rate_limits.get("rateLimitsByLimitId") or {}).get("codex") or rate_limits.get("rateLimits") or {}
    windows = []
    for window_id in ("primary", "secondary"):
        window = snapshot.get(window_id)
        if not isinstance(window, dict) or not isinstance(window.get("usedPercent"), (int, float)):
            continue
        resets = window.get("resetsAt")
        windows.append({
            "id": window_id,
            "usedPercent": window["usedPercent"],
            "windowMinutes": window.get("windowDurationMins"),
            "resetsAt": iso_utc(datetime.fromtimestamp(resets, timezone.utc)) if isinstance(resets, (int, float)) else None,
        })
    account_matches = None
    if credential_identity:
        usage_account = rate_limits.get("accountId") or (account.get("workspaceRouting") or {}).get("chatgptAccountId")
        usage_email = (account.get("account") or {}).get("email")
        if credential_identity.get("accountId") and usage_account:
            account_matches = credential_identity["accountId"] == usage_account
        elif credential_identity.get("email") and usage_email:
            account_matches = credential_identity["email"] == usage_email
    if not windows:
        return {"checkedAt": iso_utc(now), "ok": False, "detail": "Usage response had no windows", "windows": []}
    return {
        "checkedAt": iso_utc(now),
        "ok": True,
        "detail": "",
        "plan": snapshot.get("planType") or (account.get("account") or {}).get("planType"),
        "accountMatches": account_matches,
        "limitReached": bool(snapshot.get("rateLimitReachedType")) or rate_limits.get("ordinaryUsageAllowed") is False,
        "windows": windows,
    }


def load_gateway_state(path=GATEWAY_STATE_PATH):
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_gateway_state(state, path=GATEWAY_STATE_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def due(entry, interval, now):
    try:
        last = datetime.fromisoformat(str((entry or {}).get("checkedAt", "")).replace("Z", "+00:00"))
    except ValueError:
        return True
    return (now - last).total_seconds() >= interval


def gateway_report(now=None, state_path=GATEWAY_STATE_PATH):
    """Collect the gateway section of the report. Secrets never leave this function."""
    now = now or datetime.now(timezone.utc)
    cache = load_gateway_state(state_path)
    key = gateway_client_key()
    try:
        policy = json.loads(GATEWAY_POLICY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        policy = {}
    try:
        config = parse_gateway_config(GATEWAY_CONFIG_PATH.read_text(encoding="utf-8"))
    except OSError:
        config = {"revision": None, "aliases": {}}
    aliases = policy.get("aliases") or {}

    if key:
        status, payload, latency, error = gateway_request("/models", key)
        listed = {str(item.get("id")) for item in (payload or {}).get("data", []) if isinstance(item, dict)}
        local = {"up": status == 200, "statusCode": status, "latencyMs": latency,
                 "detail": f"{len(listed)} models listed" if status == 200 else (error or "Unreachable"),
                 "aliasesListed": {alias: alias in listed for alias in aliases}}
    else:
        local = {"up": False, "statusCode": None, "latencyMs": 0, "detail": "status client key missing", "aliasesListed": {}}

    credential, identity = codex_credential()

    if key and local["up"] and due(cache.get("inference"), GATEWAY_INFERENCE_INTERVAL_SECONDS, now):
        status, payload, latency, error = gateway_request("/chat/completions", key, {
            "model": GATEWAY_INFERENCE_ALIAS, "max_tokens": 8,
            "messages": [{"role": "user", "content": "Reply with OK."}],
        }, timeout=60)
        cache["inference"] = {"checkedAt": iso_utc(now), "ok": status == 200, "statusCode": status,
                              "alias": GATEWAY_INFERENCE_ALIAS, "model": (payload or {}).get("model"),
                              "latencyMs": latency, "detail": "Answered" if status == 200 else (error or "Failed")}

    if due(cache.get("usage"), GATEWAY_USAGE_INTERVAL_SECONDS, now) or not (cache.get("usage") or {}).get("ok"):
        try:
            rate_limits, account = read_codex_rate_limits()
            cache["usage"] = summarize_rate_limits(rate_limits, account, identity, now)
        except (OSError, RuntimeError, ValueError) as error:
            previous = cache.get("usage") or {}
            # Keep the last good reading (and its timestamp) so the server can judge staleness.
            cache["usage"] = {**previous, "ok": bool(previous.get("ok")), "detail": f"Usage read failed: {error}"[:150]}
            if not previous.get("ok"):
                cache["usage"]["checkedAt"] = None

    save_gateway_state(cache, state_path)
    return {
        "checkedAt": iso_utc(now),
        "local": local,
        "policy": {"revision": policy.get("revision"), "aliases": aliases},
        "config": config,
        "credential": credential,
        "inference": cache.get("inference"),
        "usage": cache.get("usage"),
    }


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
    launchd_job_state = load_launchd_job_state()
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
            pid, status = launchd_jobs.get(pattern, (None, None))
            previous_status = launchd_job_state.get(pattern)
            if scheduled and pid is None and status is not None:
                launchd_job_state[pattern] = status
            up, detail = launchd_status(
                pattern,
                launchd_jobs,
                scheduled=scheduled,
                previous_status=previous_status,
            )
            kind = "Scheduled job" if scheduled else "LaunchAgent"
            items.append({"id": identifier, "name": name, "kind": kind, "up": up, "detail": detail})
            continue
        present = pattern in processes or pattern in launchd
        detail = "Process detected" if pattern in processes else ("LaunchAgent loaded" if pattern in launchd else "Process not found")
        items.append({"id": identifier, "name": name, "kind": "Process", "up": present, "detail": detail})

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
