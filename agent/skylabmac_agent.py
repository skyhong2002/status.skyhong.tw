#!/usr/bin/env python3
"""Report selected SkyLabMac process states to the private status dashboard."""

import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request

CONFIG_PATH = os.path.expanduser("~/.config/sky-status-agent.json")
WATCHES = [
    ("caddy", "Caddy", "/usr/local/sbin/caddy run"),
    ("localplaud-api", "LocalPlaud API", "localplaud serve"),
    ("localplaud-worker", "LocalPlaud worker", "localplaud run"),
    ("bamboo-gateway", "Bamboo gateway", "hermes_cli.main --profile bamboo gateway run"),
    ("bamboo-discord", "Bamboo Discord watcher", "discord_channel_watcher.py"),
    ("token-tracker", "TokenTrackerBar", "tracker.js serve --port 7680"),
    ("nycu-haix-runner", "NYCU-HAIX runner", "actions.runner.nycu-haix-omniobserve.sky-mac-mini"),
]


def command_output(command):
    return subprocess.run(command, text=True, capture_output=True, check=False).stdout


def main():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as config_file:
            config = json.load(config_file)
    except (OSError, json.JSONDecodeError) as error:
        print(f"status-agent config error: {error}", file=sys.stderr)
        return 1

    processes = command_output(["ps", "-axo", "pid=,args="])
    launchd = command_output(["launchctl", "list"])
    items = []
    for identifier, name, pattern in WATCHES:
        present = pattern in processes or pattern in launchd
        detail = "Process detected" if pattern in processes else ("LaunchAgent loaded" if pattern in launchd else "Process not found")
        items.append({"id": identifier, "name": name, "kind": "Process", "up": present, "detail": detail})

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
