#!/usr/bin/env python3
"""AI gateway telemetry for the status dashboard: one host's CLIProxyAPI listener, the alias
mapping apply.py wrote into its config, a token-free summary of its Codex OAuth credential, a
rare tiny inference, and (where the codex CLI lives) the account's subscription usage windows.

Imported by skylabmac_agent.py on sky-mini. On a Linux gateway host, run it directly and it
prints the gateway block as JSON (see vps_host_reporter.sh); the client key comes from the
AI_GATEWAY_KEY environment variable and never appears in argv or the output.
"""

import argparse
import json
import os
import re
import select
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

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


def gateway_request(path, key, body=None, timeout=5, base_url=GATEWAY_BASE_URL):
    """Call the gateway. Returns (status code or None, parsed JSON or None, latency ms, error)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {key}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{base_url}{path}", data=data, headers=headers)
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


def listener_target(base_url):
    """The host:port a listener check went to, without scheme or path (e.g. 127.0.0.1:8317)."""
    match = re.match(r"^\w+://([^/]+)", base_url)
    return match.group(1) if match else None


def gateway_report(now=None, state_path=GATEWAY_STATE_PATH, *, key=None, base_url=GATEWAY_BASE_URL,
                   config_path=GATEWAY_CONFIG_PATH, auth_dir=GATEWAY_AUTH_DIR, policy_path=GATEWAY_POLICY_PATH,
                   read_usage=True):
    """Collect one host's gateway block. Secrets never leave this function.

    The subscription usage windows belong to the account, not the host, so only one host
    (sky-mini, where the codex CLI lives) reads them; others pass read_usage=False.
    """
    now = now or datetime.now(timezone.utc)
    cache = load_gateway_state(state_path)
    key = key if key is not None else gateway_client_key()
    try:
        policy = json.loads(Path(policy_path).read_text(encoding="utf-8")) if policy_path else {}
    except (OSError, json.JSONDecodeError):
        policy = {}
    try:
        config = parse_gateway_config(Path(config_path).read_text(encoding="utf-8"))
    except OSError:
        config = {"revision": None, "aliases": {}}
    # A host without the policy file still reports which aliases it lists; the server compares
    # them against the policy it already has from sky-mini.
    aliases = policy.get("aliases") or config["aliases"]

    if key:
        status, payload, latency, error = gateway_request("/models", key, base_url=base_url)
        listed = {str(item.get("id")) for item in (payload or {}).get("data", []) if isinstance(item, dict)}
        local = {"up": status == 200, "statusCode": status, "latencyMs": latency,
                 "detail": f"{len(listed)} models listed" if status == 200 else (error or "Unreachable"),
                 "aliasesListed": {alias: alias in listed for alias in aliases}}
    else:
        local = {"up": False, "statusCode": None, "latencyMs": 0, "detail": "status client key missing", "aliasesListed": {}}
    local["target"] = listener_target(base_url)

    credential, identity = codex_credential(Path(auth_dir))

    if key and local["up"] and due(cache.get("inference"), GATEWAY_INFERENCE_INTERVAL_SECONDS, now):
        status, payload, latency, error = gateway_request("/chat/completions", key, {
            "model": GATEWAY_INFERENCE_ALIAS, "max_tokens": 8,
            "messages": [{"role": "user", "content": "Reply with OK."}],
        }, timeout=60, base_url=base_url)
        cache["inference"] = {"checkedAt": iso_utc(now), "ok": status == 200, "statusCode": status,
                              "alias": GATEWAY_INFERENCE_ALIAS, "model": (payload or {}).get("model"),
                              "latencyMs": latency, "detail": "Answered" if status == 200 else (error or "Failed")}

    if read_usage and (due(cache.get("usage"), GATEWAY_USAGE_INTERVAL_SECONDS, now) or not (cache.get("usage") or {}).get("ok")):
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
    report = {
        "checkedAt": iso_utc(now),
        "local": local,
        "config": config,
        "credential": credential,
        "inference": cache.get("inference"),
    }
    if policy:
        report["policy"] = {"revision": policy.get("revision"), "aliases": policy.get("aliases") or {}}
    if read_usage:
        report["usage"] = cache.get("usage")
    return report


def main():
    parser = argparse.ArgumentParser(description="Print this host's gateway block as JSON.")
    parser.add_argument("--base-url", default=GATEWAY_BASE_URL)
    parser.add_argument("--config", default=str(GATEWAY_CONFIG_PATH), help="CLIProxyAPI config written by apply.py")
    parser.add_argument("--auth-dir", default=str(GATEWAY_AUTH_DIR))
    parser.add_argument("--state", default=str(GATEWAY_STATE_PATH), help="cache for the inference result")
    args = parser.parse_args()
    report = gateway_report(state_path=Path(os.path.expanduser(args.state)), key=os.environ.get("AI_GATEWAY_KEY", ""),
                            base_url=args.base_url, config_path=os.path.expanduser(args.config),
                            auth_dir=os.path.expanduser(args.auth_dir), policy_path=None, read_usage=False)
    json.dump(report, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
