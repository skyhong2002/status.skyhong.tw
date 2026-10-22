import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

from gateway_telemetry import codex_usage_identities, gateway_report, summarize_rate_limits


class GatewayUsageIdentityTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 22, 14, 0, tzinfo=timezone.utc)

    def test_usage_matches_enabled_t3_mirror_instead_of_first_legacy_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Path(root, "codex-legacy.json").write_text(json.dumps({
                "type": "codex", "refresh_token": "legacy-secret",
                "account_id": "legacy-account", "email": "legacy@example.com",
            }))
            Path(root, "t3-synced-login.json").write_text(json.dumps({
                "type": "codex", "access_token": "mirror-secret", "t3_sync_source": "fixture",
                "account_id": "mirrored-account", "email": "mirror@example.com",
                "expired": "2026-10-22T15:00:00Z", "disabled": False,
            }))
            limits = {"accountId": "mirrored-account", "rateLimits": {
                "primary": {"usedPercent": 32, "windowDurationMins": 300},
            }}
            identities = codex_usage_identities(root, self.now)
            self.assertEqual(len(identities), 2)
            self.assertNotIn("secret", json.dumps(identities))
            usage = summarize_rate_limits(limits, {}, identities, self.now)
            self.assertTrue(usage["accountMatches"])
            self.assertEqual(usage["windows"][0]["usedPercent"], 32)
            limits["accountId"] = "unregistered-account"
            self.assertFalse(summarize_rate_limits(limits, {}, identities, self.now)["accountMatches"])
            limits["accountId"] = "mirrored-account"
            state = root / "state.json"
            state.write_text(json.dumps({"inference": {"checkedAt": "2026-10-22T14:00:00Z", "ok": True}}))
            with patch("gateway_telemetry.gateway_request", return_value=(200, {"data": []}, 1, None)), \
                 patch("gateway_telemetry.read_codex_rate_limits", return_value=(limits, {})):
                report = gateway_report(self.now, state, key="fixture-key", auth_dir=root,
                                        config_path=root / "absent", policy_path=None, accounts_path=root / "absent")
            self.assertTrue(report["usage"]["accountMatches"])
            for private in ["mirror-secret", "legacy-secret", "mirrored-account", "legacy-account", "mirror@example.com"]:
                self.assertNotIn(private, json.dumps(report))

    def test_usage_rejects_disabled_withdrawn_expired_and_wrong_provider_logins(self):
        base = {"type": "codex", "access_token": "fixture", "account_id": "acct",
                "email": "ops@example.com", "expired": "2026-10-22T15:00:00Z"}
        invalid = [{"disabled": True}, {"mirror_withdrawn": True}, {"mirror_expired": True},
                   {"t3_sync_expired": True}, {"expired": "2026-10-22T14:00:00Z"},
                   {"expired": "invalid"}, {"expired": "2026-10-22T15:00:00"},
                   {"expired": None}, {"access_token": None}, {"type": "claude"}]
        limits = {"accountId": "acct", "rateLimits": {"primary": {"usedPercent": 10}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "codex-login.json")
            for override in invalid:
                with self.subTest(override=override):
                    path.write_text(json.dumps({**base, **override}))
                    identities = codex_usage_identities(directory, self.now)
                    self.assertEqual(identities, [])
                    self.assertFalse(summarize_rate_limits(limits, {}, identities, self.now)["accountMatches"])
            path.write_text("[]")
            self.assertEqual(codex_usage_identities(directory, self.now), [])
            path.write_text("{invalid")
            self.assertEqual(codex_usage_identities(directory, self.now), [])
            path.write_text(json.dumps({**base, "expired": "2026-10-21T14:00:00Z", "refresh_token": "renewable"}))
            self.assertEqual(len(codex_usage_identities(directory, self.now)), 1)

    def test_usage_account_id_mismatch_cannot_be_hidden_by_matching_email(self):
        limits = {"accountId": "different-workspace", "rateLimits": {"primary": {"usedPercent": 10}}}
        account = {"account": {"email": "ops@example.com"}}
        identities = [{"accountId": "expected-workspace", "email": "ops@example.com"},
                      {"email": "ops@example.com"}]
        self.assertFalse(summarize_rate_limits(limits, account, identities, self.now)["accountMatches"])


if __name__ == "__main__":
    unittest.main()
