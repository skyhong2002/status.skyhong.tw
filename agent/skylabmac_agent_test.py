import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from skylabmac_agent import bamboo_discord_status, http_probe


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


if __name__ == "__main__":
    unittest.main()
