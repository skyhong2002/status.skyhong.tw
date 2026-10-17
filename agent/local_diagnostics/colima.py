"""Read-only Colima -> RSSHub diagnostic, adapted from the reviewed helper.

Read only the named Docker context's metadata, then address the exact local
socket. An empty temporary Docker config avoids loading client credentials or
honoring default contexts. No arbitrary response fields/errors reach output.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

CONTEXT = "colima"
CONTAINER = "bamboo-rsshub"
EXPECTED_SOCKET = "/Users/skyhong/.colima/default/docker.sock"
# Docker's context metadata store keys directories by SHA256(context name).
CONTEXT_METADATA_PATH = (Path("/Users/skyhong/.docker/contexts/meta") /
                         hashlib.sha256(CONTEXT.encode()).hexdigest() / "meta.json")
# Homebrew CLI exists on this host; launchd need not supply an interactive PATH.
DOCKER_BINARY = "/opt/homebrew/bin/docker"
TIMEOUT_SECONDS = 8


def _run(arguments):
    with tempfile.TemporaryDirectory(prefix="status-docker-") as config:
        return subprocess.run(
            [DOCKER_BINARY, "--config", config, *arguments],
            capture_output=True, text=True, timeout=TIMEOUT_SECONDS, check=False,
            stdin=subprocess.DEVNULL,
            # No Docker/context/TLS/API overrides, credential plugins or proxies.
            env={"PATH": os.defpath, "HOME": config},
        )


def context_endpoint(path=CONTEXT_METADATA_PATH):
    with path.open("rb") as handle:
        raw = handle.read(64 * 1024 + 1)
    if len(raw) > 64 * 1024:
        raise ValueError("context metadata too large")
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("Name") != CONTEXT:
        raise ValueError("invalid context metadata")
    endpoints = data.get("Endpoints")
    docker = endpoints.get("docker") if isinstance(endpoints, dict) else None
    return docker.get("Host") if isinstance(docker, dict) else None


def inspect_dependency(run=None):
    run = run or _run

    def output(state, code):
        return {"dependency": "colima/rsshub", "state": state}, code

    def query(arguments):
        response = run(["--host", "unix://" + EXPECTED_SOCKET, *arguments])
        if response.returncode:
            raise ValueError("docker query failed")
        return json.loads(response.stdout)

    try:
        # Never follow a remote, alternate-local or changed default context.
        if context_endpoint() != "unix://" + EXPECTED_SOCKET:
            return output("unexpected_docker_endpoint", 2)
        version = query(["info", "--format", "{{json .ServerVersion}}"])
        if not isinstance(version, str) or not version:
            return output("unknown_engine_version", 2)
    except (OSError, ValueError, UnicodeError, RecursionError, subprocess.SubprocessError):
        return output("engine_unavailable", 2)
    try:
        state = query(["container", "inspect", CONTAINER, "--format",
                       '{"status":{{json .State.Status}},"health":{{if .State.Health}}'
                       '{{json .State.Health.Status}}{{else}}null{{end}}}'])
    except (OSError, ValueError, UnicodeError, RecursionError, subprocess.SubprocessError):
        return output("container_unavailable", 2)
    if not isinstance(state, dict):
        return output("unexpected_inspect_schema", 2)
    status = state.get("status")
    if status in ("created", "restarting", "removing", "paused", "exited", "dead"):
        return output("container_not_running", 1)
    if status != "running" or "health" not in state:
        return output("unexpected_inspect_schema", 2)
    health = state.get("health")
    if health is None:
        return output("healthcheck_unconfigured", 1)
    if health == "healthy":
        return output("healthy", 0)
    if health == "unhealthy":
        return output("unhealthy", 1)
    if health == "starting":
        return output("starting", 2)
    return output("unknown_health", 2)
