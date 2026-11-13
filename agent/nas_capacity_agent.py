#!/usr/bin/env python3
"""Report the NAS backup share's free space to the status dashboard.

The NAS (ggss-nas) once filled its thin pool, and Samba then turned the backup
share read-only. That broke every nearline write (tag.observe.tw #28). This
agent pages before that happens again: it posts one item that goes down when
free space on the share falls below NAS_FREE_MIN_GIB.

It runs once a minute from the user nas-capacity-agent.timer on sky-server, as
the user that owns the rclone config. The dashboard marks an agent stale after
three missed intervals, so it reports every minute but measures the NAS at most
every MEASURE_INTERVAL_SECONDS. Configuration comes from the private user
EnvironmentFile shared with the sky-server agent:

    STATUS_ENDPOINT=https://status.skyhong.tw
    AGENT_INGEST_TOKEN=...
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

AGENT_ID = "sky-server-nas"
USER_AGENT = f"sky-status-agent/1.0 (+{socket.gethostname()})"
GIB = 1024 ** 3
RCLONE = os.environ.get("RCLONE", "/home/deck/.local/bin/rclone")
RCLONE_CONFIG = os.environ.get("RCLONE_CONFIG", "/home/deck/.config/nas-backup/rclone.conf")
# Every share sits on the same volume, so any of them reports the same free space.
NAS_REMOTE = os.environ.get("NAS_REMOTE", "nas:Archive")
MEASURE_INTERVAL_SECONDS = 600
STATE_PATH = Path(os.environ.get("STATE_DIRECTORY", str(Path.home() / ".local/state/nas-capacity-agent"))) / "about.json"


def free_min_bytes():
    return int(float(os.environ.get("NAS_FREE_MIN_GIB", "150")) * GIB)


def measure(run=subprocess.run):
    """Return rclone's {'total','used','free'} for the share, or raise."""
    result = run([RCLONE, "--config", RCLONE_CONFIG, "about", NAS_REMOTE, "--json"],
                 capture_output=True, text=True, timeout=60, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"rclone about exited {result.returncode}")
    about = json.loads(result.stdout)
    if not isinstance(about.get("free"), int) or not isinstance(about.get("total"), int):
        raise RuntimeError("rclone about returned no free/total")
    return about


def cached_measure(now, path=STATE_PATH, measure=measure):
    """Reuse a recent successful measurement; never cache a failure."""
    try:
        cached = json.loads(path.read_text())
        if 0 <= now - cached["measuredAt"] < MEASURE_INTERVAL_SECONDS:
            return cached["about"], cached["measuredAt"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    about = measure()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".partial")
    temporary.write_text(json.dumps({"measuredAt": now, "about": about}))
    temporary.replace(path)
    return about, now


def capacity_item(about, minimum):
    free, total = about["free"], about["total"]
    detail = f"{free / GIB:.1f} GiB free of {total / GIB:.0f} GiB (alert below {minimum / GIB:.0f} GiB)"
    return {"id": "nas-free-space", "name": "NAS free space", "kind": "Storage",
            "up": free >= minimum, "detail": detail}


def collect_items(now=None, measure_fn=None):
    now = time.time() if now is None else now
    try:
        about, _ = cached_measure(now, measure=measure_fn or measure)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        return [{"id": "nas-free-space", "name": "NAS free space", "kind": "Storage",
                 "up": False, "detail": f"NAS capacity unavailable: {error}"[:200]}]
    return [capacity_item(about, free_min_bytes())]


def main():
    endpoint = os.environ.get("STATUS_ENDPOINT", "https://status.skyhong.tw")
    token = os.environ.get("AGENT_INGEST_TOKEN")
    if not token:
        print("AGENT_INGEST_TOKEN is not set", file=sys.stderr)
        return 2
    body = json.dumps({"host": socket.gethostname() + " NAS", "items": collect_items()}).encode("utf-8")
    request = urllib.request.Request(
        f"{endpoint.rstrip('/')}/api/agents/{AGENT_ID}", data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise RuntimeError(f"dashboard returned {response.status}")
    except (urllib.error.URLError, RuntimeError) as error:
        print(f"nas-capacity report failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
