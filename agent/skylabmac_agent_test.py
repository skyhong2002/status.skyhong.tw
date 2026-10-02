import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from gateway_telemetry import (
    codex_credential,
    due,
    gateway_report,
    listener_target,
    mask_account,
    parse_gateway_config,
    summarize_rate_limits,
)
from skylabmac_agent import (
    bamboo_discord_status,
    http_probe,
    launchd_status,
    load_launchd_job_state,
    save_launchd_job_state,
)


class BambooDiscordStatusTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.cron_path = Path(self.directory.name) / "jobs.json"
        self.state_path = Path(self.directory.name) / "state.json"
        self.now = datetime(2026, 7, 16, 15, 10, tzinfo=timezone.utc)

    def tearDown(self):
        self.directory.cleanup()

    def write_fixture(self, last_run_at, last_status="ok", enabled=True):
        self.cron_path.write_text(json.dumps({"jobs": [{
            "script": "discord_channel_watcher.py",
            "enabled": enabled,
            "state": "scheduled" if enabled else "paused",
            "last_run_at": last_run_at,
            "last_status": last_status,
            "last_error": None,
        }]}), encoding="utf-8")
        self.state_path.write_text("{}", encoding="utf-8")
        timestamp = self.now.timestamp() - 60
        os.utime(self.state_path, (timestamp, timestamp))

    def test_recent_successful_cron_is_healthy(self):
        self.write_fixture((self.now - timedelta(minutes=10)).isoformat())
        result = bamboo_discord_status(self.cron_path, self.state_path, self.now)
        self.assertTrue(result["up"])
        self.assertEqual(result["kind"], "Hermes cron")

    def test_stale_cron_is_unhealthy(self):
        self.write_fixture((self.now - timedelta(minutes=21)).isoformat())
        result = bamboo_discord_status(self.cron_path, self.state_path, self.now)
        self.assertFalse(result["up"])
        self.assertIn("Cron stale", result["detail"])

    def test_missing_cron_is_unhealthy(self):
        result = bamboo_discord_status(self.cron_path, self.state_path, self.now)
        self.assertFalse(result["up"])
        self.assertEqual(result["detail"], "Cron job not found")


class HttpProbeTest(unittest.TestCase):
    def serve(self, status):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(status)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}/healthz"

    def test_200_is_up(self):
        up, detail = http_probe(self.serve(200))
        self.assertTrue(up)
        self.assertIn("200", detail)

    def test_401_still_up(self):
        # An auth challenge proves the API process is serving requests.
        up, detail = http_probe(self.serve(401))
        self.assertTrue(up)
        self.assertIn("401", detail)

    def test_connection_refused_is_down(self):
        # Port 1 is reserved and never listening.
        up, detail = http_probe("http://127.0.0.1:1/healthz", timeout=1)
        self.assertFalse(up)
        self.assertIn("Not serving", detail)


class LaunchdStatusTest(unittest.TestCase):
    def test_failed_scheduled_job_stays_down_while_retry_runs(self):
        up, detail = launchd_status(
            "example.job",
            {"example.job": (1234, None)},
            scheduled=True,
            previous_status=1,
        )
        self.assertFalse(up)
        self.assertEqual(detail, "Retry running · previous exit 1")

    def test_successful_scheduled_job_can_report_running(self):
        up, detail = launchd_status(
            "example.job",
            {"example.job": (1234, None)},
            scheduled=True,
            previous_status=0,
        )
        self.assertTrue(up)
        self.assertEqual(detail, "Running · PID 1234")

    def test_launchd_job_state_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            save_launchd_job_state({"example.job": 1}, path)
            self.assertEqual(load_launchd_job_state(path), {"example.job": 1})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class GatewayReportTest(unittest.TestCase):
    def test_parses_alias_block_and_revision_from_gateway_config(self):
        text = """# oauth-model-alias:
#   codex:
#     - name: "gpt-5"
#       alias: "g5"
api-keys:
  - "k"  # status

# Managed by ai-gateway/apply.py, policy revision 2026-10-02
oauth-model-alias:
  codex:
    - name: "gpt-6-luna"
      alias: "sky-fast"
    - name: "gpt-6.1-sol"
      alias: "sky-quality"
other: true
"""
        self.assertEqual(parse_gateway_config(text), {
            "revision": "2026-10-02",
            "aliases": {"sky-fast": "gpt-6-luna", "sky-quality": "gpt-6.1-sol"},
        })

    def test_credential_summary_masks_the_account_and_drops_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "codex-abc-ops@example.com-pro.json").write_text(json.dumps({
                "access_token": "secret-a", "refresh_token": "secret-r", "email": "ops@example.com",
                "account_id": "acct-1", "disabled": False,
                "expired": "2026-10-12T19:42:20+08:00", "last_refresh": "2026-10-02T19:42:20+08:00",
            }))
            summary, identity = codex_credential(Path(directory))
        self.assertEqual(summary["account"], "o••@example.com")
        self.assertEqual(summary["plan"], "pro")
        self.assertEqual(summary["accessExpiresAt"], "2026-10-12T11:42:20Z")
        self.assertTrue(summary["present"] and summary["refreshable"])
        self.assertNotIn("secret", json.dumps(summary))
        self.assertEqual(identity["accountId"], "acct-1")
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(codex_credential(Path(directory)), ({"present": False}, None))

    def test_rate_limit_windows_and_account_match(self):
        now = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
        rate_limits = {
            "accountId": "acct-1", "ordinaryUsageAllowed": True,
            "rateLimitsByLimitId": {"codex": {
                "primary": {"usedPercent": 62, "windowDurationMins": 10080, "resetsAt": 1791054021},
                "secondary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1790960000},
                "planType": "pro", "rateLimitReachedType": None,
            }},
        }
        usage = summarize_rate_limits(rate_limits, {}, {"accountId": "acct-1"}, now)
        self.assertTrue(usage["ok"])
        self.assertTrue(usage["accountMatches"])
        self.assertFalse(usage["limitReached"])
        self.assertEqual([w["id"] for w in usage["windows"]], ["primary", "secondary"])
        self.assertEqual(usage["windows"][0]["resetsAt"], "2026-10-03T19:00:21Z")
        other = summarize_rate_limits(rate_limits, {}, {"accountId": "acct-2"}, now)
        self.assertFalse(other["accountMatches"])
        self.assertFalse(summarize_rate_limits({"rateLimits": {}}, {}, None, now)["ok"])

    def test_inference_is_due_only_after_its_interval(self):
        now = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
        self.assertTrue(due(None, 1800, now))
        self.assertFalse(due({"checkedAt": "2026-10-02T11:45:00Z"}, 1800, now))
        self.assertTrue(due({"checkedAt": "2026-10-02T11:29:59Z"}, 1800, now))
        self.assertEqual(mask_account("ops@example.com"), "o••@example.com")

    def test_remote_host_report_uses_its_own_listener_config_and_credential(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def reply(self, body):
                seen.append((self.command, self.path, self.headers.get("Authorization")))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_GET(self):
                self.reply({"data": [{"id": "sky-fast"}, {"id": "sky-quality"}, {"id": "gpt-6-luna"}]})

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.reply({"model": "gpt-6-luna"})

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory, "config.yaml")
            config.write_text('# Managed by ai-gateway/apply.py, policy revision 2026-10-02\noauth-model-alias:\n  codex:\n'
                              '    - name: "gpt-6-luna"\n      alias: "sky-fast"\n    - name: "gpt-6.1-sol"\n      alias: "sky-quality"\n')
            Path(directory, "codex-abc-ops@example.com-pro.json").write_text(json.dumps({"refresh_token": "r", "email": "ops@example.com"}))
            report = gateway_report(state_path=Path(directory, "state.json"), key="k",
                                    base_url=f"http://127.0.0.1:{server.server_port}/v1", config_path=config,
                                    auth_dir=directory, policy_path=None, read_usage=False)
        self.assertEqual(report["local"]["aliasesListed"], {"sky-fast": True, "sky-quality": True})
        self.assertEqual(report["local"]["target"], f"127.0.0.1:{server.server_port}")
        self.assertEqual(report["config"]["revision"], "2026-10-02")
        self.assertEqual(report["credential"]["account"], "o••@example.com")
        self.assertEqual(report["inference"]["model"], "gpt-6-luna")
        self.assertNotIn("usage", report)
        self.assertNotIn("policy", report)
        self.assertEqual([s[:2] for s in seen], [("GET", "/v1/models"), ("POST", "/v1/chat/completions")])
        self.assertTrue(all(s[2] == "Bearer k" for s in seen))
        self.assertNotIn("ops@example.com", json.dumps(report))
        self.assertIsNone(listener_target("not a url"))


if __name__ == "__main__":
    unittest.main()
