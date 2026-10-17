import io
import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from gateway_telemetry import (
    account_health,
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
    chumei_pipeline_freshness,
    http_probe,
    http_status_policy,
    launchd_status,
    load_launchd_job_state,
    collect_service_items,
    save_launchd_job_state,
    scheduled_job_status,
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
    url = "http://fixture.invalid/healthz"

    def probe(self, status, **kwargs):
        with patch("skylabmac_agent.READINESS_HTTP_OPENER.open") as urlopen:
            if status >= 400:
                urlopen.side_effect = urllib.error.HTTPError(self.url, status, "fixture", {}, io.BytesIO(b"{}"))
            else:
                urlopen.return_value.__enter__.return_value.status = status
            return http_probe(self.url, **kwargs)

    def test_200_is_up(self):
        up, detail = self.probe(200)
        self.assertTrue(up)
        self.assertEqual(detail, "Ready · HTTP 200")

    def test_liveness_does_not_imply_readiness(self):
        for status in (204, 401, 403, 404, 429, 500, 503):
            with self.subTest(status=status):
                up, detail = self.probe(status)
                self.assertFalse(up)
                self.assertEqual(detail, f"Responding but not ready · HTTP {status}")

    def test_auth_challenge_requires_explicit_endpoint_policy(self):
        for status in (401, 403):
            with self.subTest(status=status):
                up, detail = self.probe(status, accepted_statuses=(200, status))
                self.assertTrue(up)
                self.assertIn(str(status), detail)

    def test_server_errors_cannot_be_accepted_as_ready(self):
        self.assertFalse(self.probe(503, accepted_statuses=(200, 503))[0])

    def test_connection_refused_is_down(self):
        with patch("skylabmac_agent.READINESS_HTTP_OPENER.open",
                   side_effect=urllib.error.URLError("connection refused")):
            up, detail = http_probe(self.url, timeout=1)
        self.assertFalse(up)
        self.assertIn("Not serving", detail)

    def test_timeout_is_down(self):
        with patch("skylabmac_agent.READINESS_HTTP_OPENER.open", side_effect=TimeoutError("timed out")):
            self.assertFalse(http_probe(self.url)[0])

    def redirect_fixture(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                self.send_response(self.server.redirect_status if self.path == "/healthz" else 200)
                if self.path == "/healthz":
                    self.send_header("Location", "/login")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, seen, f"http://127.0.0.1:{server.server_port}/healthz"

    def test_redirect_to_login_is_not_healthy_by_default_and_is_not_followed(self):
        server, seen, url = self.redirect_fixture()
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                server.redirect_status = status
                seen.clear()
                up, detail = http_probe(url)
                self.assertFalse(up)
                self.assertEqual(detail, f"Responding but not ready · HTTP {status}")
                self.assertEqual(seen, ["/healthz"])

    def test_explicit_redirect_policy_accepts_original_status_without_following(self):
        server, seen, url = self.redirect_fixture()
        server.redirect_status = 302
        up, detail = http_probe(url, accepted_statuses=(302,))
        self.assertTrue(up)
        self.assertEqual(detail, "Ready · HTTP 302")
        self.assertEqual(seen, ["/healthz"])

    def test_other_http_clients_keep_normal_redirect_behavior(self):
        server, seen, url = self.redirect_fixture()
        server.redirect_status = 302
        with urllib.request.urlopen(url, timeout=2) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(seen, ["/healthz", "/login"])


class HttpStatusPolicyTest(unittest.TestCase):
    def test_absent_policy_uses_readiness_default(self):
        self.assertEqual(http_status_policy({}), {})

    def test_override_is_specific_to_an_http_monitor(self):
        policies = {"localplaud-api": [200, 401]}
        self.assertEqual(http_status_policy({"http_accepted_statuses": policies}), policies)

    def test_invalid_policy_fails_closed(self):
        for policies in ([], {"typo": [200]}, {"caddy": [200]},
                         {"localplaud-api": []}, {"localplaud-api": "200"},
                         {"localplaud-api": [True]}, {"localplaud-api": ["401"]},
                         {"localplaud-api": [503]}):
            with self.subTest(policies=policies), self.assertRaises(ValueError):
                http_status_policy({"http_accepted_statuses": policies})


class ChumeiPipelineFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "pipeline.json"
        self.now = datetime(2026, 10, 18, 0, 0, tzinfo=timezone.utc)

    def write(self, age_minutes=10, results=None, completed=None):
        self.path.write_text(json.dumps({
            "last_run": completed or (self.now - timedelta(minutes=age_minutes)).isoformat(),
            "last_results": results if results is not None else {"extract": True, "build": True},
        }), encoding="utf-8")

    def check(self):
        return chumei_pipeline_freshness(self.path, now=self.now)

    def test_successful_publish_is_fresh_until_deadline(self):
        self.write(age_minutes=240)
        self.assertTrue(self.check()[0])

    def test_stale_success_is_down_even_when_file_was_just_written(self):
        self.write(age_minutes=241)
        up, detail = self.check()
        self.assertFalse(up)
        self.assertIn("Pipeline stale", detail)

    def test_failed_publish_is_not_a_success_heartbeat(self):
        for results in ({"build": False}, {"build": True, "telegram": False}, {}):
            with self.subTest(results=results):
                self.write(results=results)
                self.assertFalse(self.check()[0])

    def test_optional_fetch_failure_does_not_override_producer_success(self):
        self.write(results={"facebook": False, "extract": True, "build": True})
        self.assertTrue(self.check()[0])

    def test_missing_or_malformed_evidence_is_not_healthy(self):
        self.assertFalse(self.check()[0])
        for content in ("{", "null", "[]", '{"last_results": true}',
                        '{"last_results": {"build": true}, "last_run": 42}'):
            with self.subTest(content=content):
                self.path.write_text(content, encoding="utf-8")
                self.assertFalse(self.check()[0])

    def test_timezone_required_and_future_timestamp_rejected(self):
        self.write(completed="2026-10-18T00:00:00")
        self.assertFalse(self.check()[0])
        self.write(age_minutes=-5)
        self.assertFalse(self.check()[0])

    def test_utc_z_and_small_clock_skew_are_supported(self):
        self.write(completed="2026-10-18T00:00:30Z")
        self.assertTrue(self.check()[0])


class AgentReportCompatibilityTest(unittest.TestCase):
    def test_endpoint_policy_and_item_wire_shape(self):
        # Call orchestration only: no main/config, telemetry, reporting or heartbeat.
        watches = [
            ("http", "localplaud-api", "LocalPlaud API", "http://local.invalid/healthz"),
            ("http", "bamboo-rsshub", "Bamboo RSSHub", "http://rss.invalid/healthz"),
            ("launchd-job", "chumei-pipeline", "Chumei pipeline", "chumei.job"),
        ]
        diagnostics = [{"id": "fixture-diagnostic", "name": "Diagnostic", "kind": "Local",
                        "up": False, "detail": "Unknown"}]
        with patch("skylabmac_agent.WATCHES", watches), \
             patch("skylabmac_agent.diagnostic_items", return_value=diagnostics) as local, \
             patch("skylabmac_agent.chumei_pipeline_freshness", return_value=(False, "Pipeline stale")), \
             patch("skylabmac_agent.http_probe", return_value=(True, "Ready · HTTP 200")) as probe:
            items, heartbeat_status = collect_service_items(
                "", "-\t0\tchumei.job\n", {}, {"localplaud-api": [200, 401]},
            )
        self.assertIsNone(heartbeat_status)
        local.assert_called_once_with()
        self.assertEqual(probe.call_args_list[0].kwargs["accepted_statuses"], [200, 401])
        self.assertEqual(probe.call_args_list[1].kwargs["accepted_statuses"], (200,))
        for item in items:
            self.assertEqual(set(item), {"id", "name", "kind", "up", "detail"})
        self.assertTrue(items[1]["up"])
        self.assertFalse(items[2]["up"])
        self.assertEqual(items[2]["id"], "chumei-pipeline")
        self.assertEqual(items[-1], diagnostics[0])


class LaunchdStatusTest(unittest.TestCase):
    def test_idle_success_requires_fresh_chumei_publish(self):
        with patch("skylabmac_agent.chumei_pipeline_freshness", return_value=(False, "Pipeline stale")):
            up, detail = scheduled_job_status("chumei-pipeline", "job", {"job": (None, 0)})
        self.assertFalse(up)
        self.assertIn("Pipeline stale", detail)

    def test_running_job_does_not_hide_stale_publish(self):
        with patch("skylabmac_agent.chumei_pipeline_freshness", return_value=(False, "Pipeline stale")):
            self.assertFalse(scheduled_job_status("chumei-pipeline", "job", {"job": (123, 0)})[0])

    def test_fresh_artifact_cannot_hide_launchd_failure(self):
        with patch("skylabmac_agent.chumei_pipeline_freshness") as freshness:
            self.assertFalse(scheduled_job_status("chumei-pipeline", "job", {"job": (None, 1)})[0])
            freshness.assert_not_called()

    def test_unattributable_jobs_keep_existing_status_semantics(self):
        with patch("skylabmac_agent.chumei_pipeline_freshness") as freshness:
            self.assertEqual(scheduled_job_status("harmonica-social-fast", "job", {"job": (None, 0)}),
                             (True, "Scheduled · last run ok"))
            freshness.assert_not_called()

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

    def test_account_health_masks_accounts_and_keeps_login_state(self):
        state = {"checked_at": 1791820000, "pools": {
            "codex": {"gpt@nycu.one": {"priority": -100, "quota": {"remaining_percent": 0}, "mirror": None,
                                       "login_rejected": True, "error": "login rejected (HTTP 401); re-login required"}},
            "claude": {"gpt@nycu.one": {"priority": 100, "quota": {"remaining_percent": 72}, "mirror": "peer"}}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "account-failover.json")
            path.write_text(json.dumps(state))
            health = account_health(path)
            self.assertIsNone(account_health(Path(directory, "absent.json")))
        codex, claude = health["accounts"]
        self.assertEqual(health["checkedAt"], "2026-10-12T15:46:40Z")
        self.assertTrue(codex["loginRejected"])
        self.assertEqual((claude["mirror"], claude["remainingPercent"]), ("peer", 72))
        self.assertNotEqual(codex["id"], claude["id"], "the same address in two pools is two accounts")
        self.assertNotIn("gpt@nycu.one", json.dumps(health))

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
                                    auth_dir=directory, policy_path=None, accounts_path=Path(directory, "absent.json"),
                                    read_usage=False)
        self.assertNotIn("accounts", report)
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
