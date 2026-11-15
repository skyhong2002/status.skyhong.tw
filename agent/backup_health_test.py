import copy
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
import backup_health as b

NOW = datetime(2026, 11, 16, tzinfo=timezone.utc)


def fixture():
    stamp = NOW.isoformat()
    return (dict(schema_version=1, observed_at=stamp, healthy=True, checks={k: True for k in b.CHECKS}),
            dict(observed_at=stamp, backup_cadence='weekly', backup_scope='source-a-nas',
                 backup_max_age_hours=204, freshness_grace_hours=36,
                 usb_b_role='excluded-quarantined-not-a-backup', usb_b_data_integrity_verified=False))


class BackupHealthTests(unittest.TestCase):
    def test_all_canonical_failures_remain_down_and_no_private_text_escapes(self):
        health, cadence = fixture()
        for key in b.CHECKS:
            failed = copy.deepcopy(health)
            failed['checks'][key] = False
            failed['healthy'] = False
            up, detail = b.root_health(failed, cadence, NOW)
            self.assertFalse(up)
            self.assertIn(b.LABELS[key], detail)
            self.assertIn('B excluded, not a backup', detail)
            self.assertLessEqual(len(detail), 200)
        health['healthy'] = False
        with self.assertRaises(ValueError):
            b.root_health(health, cadence, NOW)

    def test_stale_future_unknown_unpaired_or_malformed_evidence_fails_closed(self):
        health, cadence = fixture()
        self.assertTrue(b.root_health(health, cadence, NOW)[0])
        self.assertFalse(b.root_health(health, cadence, NOW + timedelta(seconds=7201))[0])
        for mutate in [lambda h, c: h.update(observed_at=(NOW + timedelta(seconds=1)).isoformat()),
                       lambda h, c: c.update(backup_scope='legacy-all'),
                       lambda h, c: c.update(backup_cadence='unknown'),
                       lambda h, c: c.update(usb_b_data_integrity_verified=True),
                       lambda h, c: c.update(observed_at=(NOW - timedelta(seconds=1)).isoformat()),
                       lambda h, c: h['checks'].update(daily_backups='true')]:
            h, c = fixture()
            mutate(h, c)
            with self.assertRaises((ValueError, TypeError)):
                b.root_health(h, c, NOW)
        with patch.object(b, 'metadata', side_effect=FileNotFoundError):
            self.assertFalse(b.root_item(NOW)['up'])

    def test_user_never_treats_running_or_fresh_legacy_nas_as_integrated(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            service = dict(ActiveState='activating')
            self.assertIn('incomplete', b.user_backup_status(service, True, now=NOW, directory=directory)[1])
            service['ActiveState'] = 'inactive'
            self.assertFalse(b.user_backup_status(service, True, now=NOW, directory=directory)[0])
            path = directory / 'tag_observe-test.manifest.json'
            receipt = dict(database='tag_observe', status='verified', restore={'status': 'passed'}, finished_at=NOW.isoformat(), error='PRIVATE SQL secret')
            for status, stamp, expected in [('verified', NOW, 'fresh'), ('failed', NOW, 'failed/incomplete'),
                    ('restoring', NOW, 'failed/incomplete'), ('verified', NOW-timedelta(hours=205), 'stale'),
                    ('verified', NOW+timedelta(seconds=1), 'invalid')]:
                receipt.update(status=status, finished_at=stamp.isoformat())
                path.write_text(json.dumps(receipt))
                up, detail = b.user_backup_status(service, True, now=NOW, directory=directory)
                self.assertFalse(up)
                self.assertIn(expected, detail)
                self.assertNotIn('PRIVATE', detail)
                self.assertIn('A+NAS integration unverified', detail)

    def test_observer_reason_allowlist_excludes_private_response_strings(self):
        raw = json.dumps(dict(healthy=False, reasons=['backup_reliability', 'backup_run_private-id', 'SQL secret']))
        detail = b.observer_detail(503, raw)
        self.assertIn('backup_reliability', detail)
        self.assertIn('legacy receipt freshness (30h)', detail)
        self.assertNotIn('private-id', detail)
        self.assertNotIn('SQL', detail)
        self.assertIn('unknown', b.observer_detail(503, 'private log'))
        valid = dict(healthy=True, reasons=[], sample_age_seconds=1)
        self.assertTrue(b.observer_up(200, json.dumps(valid)))
        for raw in ['bad', '{}', json.dumps({**valid, 'sample_age_seconds': 151}),
                    json.dumps({**valid, 'healthy': False}), json.dumps({**valid, 'reasons': ['backup_reliability']})]:
            self.assertFalse(b.observer_up(200, raw))
        self.assertFalse(b.observer_up(503, json.dumps(valid)))
