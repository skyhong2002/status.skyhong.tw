#!/usr/bin/env python3
"""Run fixture regressions with connections/processes denied before test imports.

Four legacy tests that open loopback HTTP fixtures (including gateway_report)
are explicitly skipped. No agent main, telemetry, real job or Docker CLI runs.
"""
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def deny_io(event, args):
    if event in {"socket.__new__", "socket.connect", "socket.getaddrinfo", "socket.gethostbyname",
                 "subprocess.Popen", "os.system", "os.posix_spawn", "os.exec", "os.fork"}:
        raise RuntimeError("offline tests deny sockets, DNS and subprocesses")
    if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
        path = os.fsdecode(args[0])
        # Deny real local diagnostic/agent/gateway sources as well as outbound I/O.
        forbidden = ("/Users/skyhong/.config", "/Users/skyhong/.hermes", "/Users/skyhong/.docker",
                     "/Users/skyhong/.colima", "/Users/skyhong/.cli-proxy-api",
                     "/Users/skyhong/Projects", "/opt/homebrew/etc/cliproxyapi.conf")
        resolved = os.path.abspath(path)
        if any(resolved == root or resolved.startswith(root + os.sep) for root in forbidden):
            raise RuntimeError("offline tests deny production data reads")


# Install before importing any tests or application modules.
sys.addaudithook(deny_io)

import unittest
from unittest.mock import patch

import gateway_telemetry
import skylabmac_agent
import skylabmac_agent_test


def forbidden_call(*args, **kwargs):
    raise AssertionError("offline tests forbid agent main and gateway telemetry")


NETWORK_FIXTURES = (
    "test_redirect_to_login_is_not_healthy_by_default_and_is_not_followed",
    "test_explicit_redirect_policy_accepts_original_status_without_following",
    "test_other_http_clients_keep_normal_redirect_behavior",
)
for name in NETWORK_FIXTURES:
    method = getattr(skylabmac_agent_test.HttpProbeTest, name)
    setattr(skylabmac_agent_test.HttpProbeTest, name, unittest.skip("requires loopback socket; denied here")(method))
name = "test_remote_host_report_uses_its_own_listener_config_and_credential"
method = getattr(skylabmac_agent_test.GatewayReportTest, name)
setattr(skylabmac_agent_test.GatewayReportTest, name, unittest.skip("gateway_report is excluded from local diagnostics validation")(method))

with patch.object(skylabmac_agent, "main", forbidden_call), \
     patch.object(skylabmac_agent, "gateway_report", forbidden_call), \
     patch.object(gateway_telemetry, "gateway_report", forbidden_call), \
     patch.object(skylabmac_agent_test, "gateway_report", forbidden_call):
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern="*_test.py")
    outcome = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if outcome.wasSuccessful() else 1)
