import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from skylabmac_agent import bamboo_discord_status


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


if __name__ == "__main__":
    unittest.main()
