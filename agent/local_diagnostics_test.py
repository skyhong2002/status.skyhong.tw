"""Fixture-only regressions for the vendored reviewed diagnostics."""
import copy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import local_diagnostics
from local_diagnostics import bamboo, colima, diagnostic_report
from local_diagnostics.__main__ import main as diagnostic_main
from skylabmac_agent import WATCHES, collect_service_items

NOW = datetime(2026, 10, 18, 4, tzinfo=timezone.utc)


@unittest.skipUnless(hasattr(sys.modules["__main__"], "deny_io"), "requires guarded runner")
class OfflineBoundaryTest(unittest.TestCase):
    def test_startup_guards_prevent_real_io_and_entrypoints(self):
        with self.assertRaisesRegex(RuntimeError, "deny sockets"):
            socket.socket()
        with self.assertRaisesRegex(RuntimeError, "deny sockets"):
            socket.getaddrinfo("fixture.invalid", 443)
        with self.assertRaisesRegex(RuntimeError, "deny sockets"):
            subprocess.run(["never-executed"])
        with self.assertRaisesRegex(RuntimeError, "production data"):
            bamboo.JOBS_PATH.read_bytes()
        import skylabmac_agent
        with self.assertRaisesRegex(AssertionError, "forbid agent main"):
            skylabmac_agent.main()
        with self.assertRaisesRegex(AssertionError, "gateway telemetry"):
            skylabmac_agent.gateway_report()
        import gateway_telemetry
        for call in (gateway_telemetry.gateway_client_key, gateway_telemetry.gateway_request,
                     gateway_telemetry.read_codex_rate_limits):
            with self.subTest(call=call), self.assertRaisesRegex(AssertionError, "gateway telemetry"):
                call()
        with self.assertRaisesRegex(RuntimeError, "production data"):
            gateway_telemetry.gateway_report()


class BambooJobTest(unittest.TestCase):
    def job(self, **updates):
        return {"id": bamboo.JOB_ID, "enabled": True, "last_status": "ok",
                "last_run_at": NOW.isoformat(), **updates}

    def check(self, job, state, code):
        before = copy.deepcopy(job)
        output, actual = bamboo.inspect_job({"jobs": [job]}, NOW)
        self.assertEqual(job, before, "read-only inspection must preserve stored job")
        self.assertEqual((output["state"], actual), (state, code))
        return output

    def test_first_and_silent_drift_remain_visible_without_error_content(self):
        for marker in bamboo.DRIFT_MARKERS:
            with self.subTest(marker=marker):
                job = self.job(last_status="error", drift_alerted=True,
                               last_error=marker + " fixture-private-error-content",
                               prompt="fixture-private-prompt", deliver="fixture-private-destination",
                               api_key="fixture-private-key")
                output = self.check(job, "drift_skip", 1)
                self.assertEqual(output["repeat_notification_suppressed"], ":silent" in marker)
                self.assertNotIn("fixture-private", json.dumps(output))

    def test_healed_job_is_ok(self):
        self.check(self.job(), "ok", 0)

    def test_stale_success(self):
        self.check(self.job(last_run_at=(NOW - timedelta(hours=37)).isoformat()), "stale_success", 1)

    def test_explicit_disabled_is_not_forced_to_run(self):
        self.check(self.job(enabled=False, last_error="[drift_skip:silent]"), "disabled", 0)

    def test_errors_dispatch_and_delivery(self):
        for fields, state in [({"last_status": "error"}, "job_error"),
                              ({"last_status": "blocked_config"}, "blocked_config"),
                              ({"last_fire_error": {"detail": "private"}}, "dispatch_error"),
                              ({"last_delivery_error": "private"}, "delivery_error")]:
            self.check(self.job(**fields), state, 1)

    def test_bad_timestamps_and_statuses_are_unknown(self):
        for fields, state in [({"last_run_at": "2026-10-18T01:00:00"}, "invalid_last_run"),
                              ({"last_run_at": "private-invalid"}, "invalid_last_run"),
                              ({"last_run_at": None}, "invalid_last_run"),
                              ({"last_run_at": (NOW + timedelta(hours=1)).isoformat()}, "future_last_run"),
                              ({"last_status": "not-yet-run"}, "no_recorded_success"),
                              ({"enabled": "false"}, "invalid_enabled_state")]:
            self.check(self.job(**fields), state, 2)

    def test_store_shapes_missing_duplicates_and_invalid_age(self):
        for document in [None, {}, {"jobs": {}}, {"jobs": [None]}, [self.job(), self.job()]]:
            self.assertEqual(bamboo.inspect_job(document, NOW)[1], 2)
        self.assertEqual(bamboo.inspect_job([self.job()], NOW)[1], 0)
        for age in [float("nan"), float("inf"), 0, -1]:
            self.assertEqual(bamboo.inspect_job([self.job()], NOW, age)[1], 2)

    def test_file_is_not_modified_and_no_hermes_import_needed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "jobs.json"
            raw = json.dumps({"jobs": [self.job(last_status="error", last_error="[drift_skip:silent]")]})
            path.write_text(raw)
            self.assertEqual(bamboo.read_status(path, NOW)[1], 1)
            self.assertEqual(path.read_text(), raw)
            path.write_text("not-json fixture-private")
            output, code = bamboo.read_status(path, NOW)
            self.assertEqual((output["state"], code), ("store_unreadable", 2))
            path.unlink()
            self.assertEqual(bamboo.read_status(path, NOW)[1], 2)


class BambooAdditionalTest(unittest.TestCase):
    job = BambooJobTest.job
    check = BambooJobTest.check

    def test_python39_z_suffix_boundary_and_clock_skew(self):
        self.check(self.job(last_run_at="2026-10-18T04:00:00Z"), "ok", 0)
        self.check(self.job(last_run_at=(NOW - timedelta(hours=36)).isoformat()), "ok", 0)
        self.check(self.job(last_run_at=(NOW + timedelta(minutes=5)).isoformat()), "ok", 0)
        self.check(self.job(last_run_at=(NOW + timedelta(minutes=5, seconds=1)).isoformat()),
                   "future_last_run", 2)
        self.check(self.job(last_run_at=42), "invalid_last_run", 2)
        self.check(self.job(last_error="fixture-private"), "job_error", 1)
        self.check(self.job(last_error={"private": "error"}), "job_error", 1)

    def test_store_size_and_recursive_json_are_bounded(self):
        for raw, states in [(b"x" * (16 * 1024 * 1024 + 1), {"store_too_large"}),
                            # JSON recursion thresholds differ between Python versions.
                            (b"[" * 2000 + b"]" * 2000, {"store_unreadable", "invalid_store"})]:
            with patch.object(Path, "open") as opened:
                opened.return_value.__enter__.return_value.read.return_value = raw
                output, code = bamboo.read_status(Path("fixture"), NOW)
                self.assertIn(output["state"], states)
                self.assertEqual(code, 2)
                opened.return_value.__enter__.return_value.read.assert_called_once_with(16 * 1024 * 1024 + 1)


class ColimaDependencyTest(unittest.TestCase):
    def setUp(self):
        self.context = patch.object(colima, "context_endpoint", return_value="unix://" + colima.EXPECTED_SOCKET)
        self.endpoint = self.context.start()
        self.addCleanup(self.context.stop)

    def runner(self, version="29.fixture", state=None, fail_at=None, raw=None, returncode=0):
        self.calls = []
        values = [version, state if state is not None else {"status": "running", "health": "healthy"}]

        def run(arguments):
            index = len(self.calls)
            self.calls.append(arguments)
            if fail_at == index:
                raise subprocess.TimeoutExpired("docker", 8, output="fixture-private-output")
            return subprocess.CompletedProcess(arguments, returncode,
                                               raw if raw is not None else json.dumps(values[index]),
                                               "fixture-private-error")
        return run

    def test_exact_socket_pinned_and_only_read_only_operations(self):
        payload, code = colima.inspect_dependency(self.runner())
        self.assertEqual((payload["state"], code), ("healthy", 0))
        self.endpoint.assert_called_once_with()
        host = ["--host", "unix://" + colima.EXPECTED_SOCKET]
        self.assertEqual(self.calls[0], host + ["info", "--format", "{{json .ServerVersion}}"])
        self.assertEqual(self.calls[1][:6], host + ["container", "inspect", "bamboo-rsshub", "--format"])
        self.assertNotIn("Log", self.calls[1][-1])

    def test_other_endpoints_are_refused_before_engine_access(self):
        for endpoint in ["ssh://private", "tcp://private:2376", "unix:///tmp/other.sock", None, {}]:
            with self.subTest(endpoint=endpoint):
                self.endpoint.return_value = endpoint
                payload, code = colima.inspect_dependency(self.runner())
                self.assertEqual((payload["state"], code), ("unexpected_docker_endpoint", 2))
                self.assertEqual(self.calls, [])

    def test_errors_timeouts_malformed_responses_are_sanitized(self):
        for index, state in [(0, "engine_unavailable"), (1, "container_unavailable")]:
            payload, code = colima.inspect_dependency(self.runner(fail_at=index))
            self.assertEqual((payload["state"], code), (state, 2))
            self.assertNotIn("private", json.dumps(payload))
        for kwargs in [{"raw": "private-invalid"}, {"returncode": 1}]:
            payload, code = colima.inspect_dependency(self.runner(**kwargs))
            self.assertEqual((payload["state"], code), ("engine_unavailable", 2))
        for error in [OSError("private"), UnicodeError("private"), RecursionError("private")]:
            self.endpoint.side_effect = error
            self.assertEqual(colima.inspect_dependency(self.runner())[0]["state"], "engine_unavailable")

    def test_container_states_and_schema(self):
        for state, expected, code in [
            ({"status": "running", "health": "healthy", "error": "private"}, "healthy", 0),
            ({"status": "exited", "health": None}, "container_not_running", 1),
            ({"status": "running", "health": None}, "healthcheck_unconfigured", 1),
            ({"status": "running", "health": "starting"}, "starting", 2),
            ({"status": "running", "health": "unhealthy"}, "unhealthy", 1),
            ({"status": "running", "health": "private"}, "unknown_health", 2),
            ({"status": "running", "health": {"private": 42}}, "unknown_health", 2),
            ([], "unexpected_inspect_schema", 2), ({}, "unexpected_inspect_schema", 2),
            ({"status": "running"}, "unexpected_inspect_schema", 2),
            ({"status": ["private"], "health": None}, "unexpected_inspect_schema", 2),
        ]:
            with self.subTest(state=state):
                payload, actual = colima.inspect_dependency(self.runner(state=state))
                self.assertEqual((payload["state"], actual), (expected, code))
                self.assertNotIn("private", json.dumps(payload))
        self.assertEqual(colima.inspect_dependency(self.runner(version=None))[0]["state"], "unknown_engine_version")

    def test_context_metadata_allowlist_and_size_limit(self):
        # Call the original function, which setUp replaced with a mock.
        self.context.stop()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meta.json"
            data = {"Name": "colima", "Endpoints": {"docker": {"Host": "unix://" + colima.EXPECTED_SOCKET}}}
            path.write_text(json.dumps(data))
            self.assertEqual(colima.context_endpoint(path), "unix://" + colima.EXPECTED_SOCKET)
            for data in [{"Name": "other"}, [], None]:
                path.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    colima.context_endpoint(path)
            path.write_bytes(b"x" * (64 * 1024 + 1))
            with self.assertRaises(ValueError):
                colima.context_endpoint(path)

    def test_subprocess_timeout_empty_config_and_environment_isolation(self):
        malicious_env = {"DOCKER_HOST": "tcp://private", "DOCKER_CONTEXT": "private",
                         "DOCKER_CONFIG": "/private", "DOCKER_TLS_VERIFY": "1",
                         "DOCKER_API_VERSION": "private", "HTTP_PROXY": "private"}
        paths = []

        def observe(command, **kwargs):
            self.assertEqual(command[0], colima.DOCKER_BINARY)
            self.assertEqual(command[1], "--config")
            config = Path(command[2])
            paths.append(config)
            self.assertEqual(list(config.iterdir()), [])
            self.assertEqual(kwargs["env"], {"PATH": os.defpath, "HOME": str(config)})
            self.assertEqual(kwargs["timeout"], 8)
            self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
            self.assertTrue(kwargs["capture_output"])
            self.assertTrue(kwargs["text"])
            self.assertFalse(kwargs["check"])
            return subprocess.CompletedProcess(command, 0, '"fixture"', "private")

        with patch.dict(os.environ, malicious_env), patch.object(colima.subprocess, "run", side_effect=observe):
            colima._run(["--host", "unix://" + colima.EXPECTED_SOCKET, "info"])
        self.assertTrue(all(not path.exists() for path in paths))


class DiagnosticOrchestrationTest(unittest.TestCase):
    def report(self, job_state="ok", dependency_state="healthy", **extra):
        with patch.object(bamboo, "read_status", return_value=({"state": job_state, **extra}, 0)), \
             patch.object(colima, "inspect_dependency", return_value=({"state": dependency_state, **extra}, 0)):
            return diagnostic_report(NOW)

    def test_only_recorded_success_and_healthy_are_up(self):
        report, code = self.report()
        self.assertEqual(code, 0)
        self.assertTrue(all(item["up"] for item in report["items"]))
        for state in local_diagnostics.BAMBOO_DETAILS:
            report, code = self.report(job_state=state)
            self.assertIs(report["items"][0]["up"], state == "ok")
            self.assertEqual(code == 0, state == "ok")
        for state in local_diagnostics.COLIMA_DETAILS:
            report, code = self.report(dependency_state=state)
            self.assertIs(report["items"][1]["up"], state == "healthy")
            self.assertEqual(code == 0, state == "healthy")

    def test_disabled_is_labeled_attention_and_unknown_is_not_green(self):
        report, code = self.report(job_state="disabled")
        self.assertEqual(code, 1)
        self.assertIn("Disabled", report["items"][0]["detail"])
        report, code = self.report(job_state="private-unexpected", dependency_state="starting")
        self.assertEqual(code, 2)
        self.assertTrue(all(not item["up"] for item in report["items"]))
        self.assertNotIn("private", json.dumps(report))

    def test_silent_drift_and_all_arbitrary_fields_are_sanitized(self):
        report, code = self.report(job_state="drift_skip", repeat_notification_suppressed=True,
                                  last_error="private-error", prompt="private-prompt", deliver="private-dest",
                                  model="private-model", provider="private-provider", last_run_at="private-stamp")
        self.assertEqual(code, 1)
        self.assertIn("silent", report["items"][0]["detail"])
        self.assertIn("spend guard", report["items"][0]["detail"])
        self.assertNotIn("private", json.dumps(report))
        for item in report["items"]:
            self.assertEqual(set(item), {"id", "name", "kind", "up", "detail"})
            self.assertLessEqual(len(item["detail"]), 200)

    def test_failures_are_independent_and_sanitized(self):
        for bad in [RuntimeError("private-error"), TypeError("private-schema")]:
            with patch.object(bamboo, "read_status", side_effect=bad), \
                 patch.object(colima, "inspect_dependency", return_value=({"state": "healthy"}, 0)):
                report, code = diagnostic_report()
                self.assertEqual(code, 2)
                self.assertFalse(report["items"][0]["up"])
                self.assertTrue(report["items"][1]["up"])
                self.assertNotIn("private", json.dumps(report))

    def test_existing_watches_http_readiness_and_heartbeat_are_preserved(self):
        diagnostics = self.report(job_state="drift_skip")[0]["items"]
        watcher = {"id": "bamboo-discord", "up": True}
        with patch("skylabmac_agent.diagnostic_items", return_value=diagnostics), \
             patch("skylabmac_agent.bamboo_discord_status", return_value=watcher), \
             patch("skylabmac_agent.http_probe", return_value=(True, "Ready · HTTP 200")), \
             patch("skylabmac_agent.scheduled_job_status", return_value=(True, "Scheduled")):
            items, heartbeat = collect_service_items("", "", {}, {})
        self.assertEqual([item["id"] for item in items[:len(WATCHES)]], [watch[1] for watch in WATCHES])
        self.assertIs(heartbeat, watcher)
        self.assertTrue(next(item for item in items if item["id"] == "bamboo-rsshub")["up"])
        self.assertEqual(items[-2:], diagnostics)

    def test_cli_uses_only_diagnostic_report_and_has_no_overrides(self):
        report, _ = self.report(job_state="disabled")
        with patch("local_diagnostics.__main__.diagnostic_report", return_value=(report, 1)) as check, \
             patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(diagnostic_main([]), 1)
            self.assertEqual(json.loads(output.getvalue()), report)
            check.assert_called_once_with()
        with patch("local_diagnostics.__main__.diagnostic_report") as check, \
             patch("sys.stderr", new_callable=io.StringIO):
            for args in [["--jobs-file", "private"], ["--context", "private"], ["--config", "private"]]:
                with self.assertRaises(SystemExit):
                    diagnostic_main(args)
            check.assert_not_called()
