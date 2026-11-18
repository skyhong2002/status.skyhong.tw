"""Metadata adapter for the existing reporter; never runs backup/health jobs.

Only the canonical hourly health booleans and existing USER receipt metadata
are read. No repository, device, database, log or credential access.
"""
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

HEALTH = Path('/var/lib/nas-backup/observer-reliability.json')
CADENCE = Path('/var/lib/nas-backup/backup-cadence-latest.json')
USER_RECEIPTS = Path('/home/deck/tag-analysis-private/backups')
CHECKS = {'daily_backups', 'full_readback', 'recent_readback', 'database_restore',
          'usb_b', 'historical_copy', 'storage_headroom'}
LABELS = {'daily_backups': 'capture', 'full_readback': 'full readback',
          'recent_readback': 'recent readback', 'database_restore': 'DB restore',
          'usb_b': 'B isolation policy', 'historical_copy': 'history',
          'storage_headroom': 'capacity'}


def metadata(path):
    # Fixed root-owned cadence metadata is private by default. Reuse existing
    # passwordless read access; do not change backup file modes or sudo policy.
    if path.stat().st_size > 65536:
        raise ValueError('oversized metadata')
    try:
        raw = path.read_text()
    except PermissionError:
        if path != CADENCE:
            raise
        raw = subprocess.run(['sudo', '-n', '/usr/bin/cat', str(CADENCE)],
                             check=True, capture_output=True, text=True, timeout=2).stdout
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError('invalid metadata')
    return data


def age_seconds(stamp, now):
    completed = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    if completed.tzinfo is None:
        raise ValueError('timezone required')
    age = (now - completed).total_seconds()
    if age < 0:
        raise ValueError('future evidence')
    return age


def root_health(health, cadence, now):
    if (set(health) != {'schema_version', 'observed_at', 'healthy', 'checks'}
            or type(health['schema_version']) is not int or health['schema_version'] != 1
            or type(health['healthy']) is not bool or not isinstance(health['checks'], dict)
            or set(health['checks']) != CHECKS
            or any(type(v) is not bool for v in health['checks'].values())
            or health['healthy'] != all(health['checks'].values())):
        raise ValueError('invalid canonical health')
    if (cadence.get('backup_cadence') != 'weekly'
            or cadence.get('backup_scope') != 'source-a-nas'
            or cadence.get('backup_max_age_hours') != 204
            or cadence.get('freshness_grace_hours') != 36
            or cadence.get('usb_b_role') != 'excluded-quarantined-not-a-backup'
            or cadence.get('usb_b_data_integrity_verified') is not False):
        raise ValueError('unknown policy')
    if (age_seconds(health['observed_at'], now) > 7200
            or age_seconds(cadence['observed_at'], now) > 7200):
        return False, 'ROOT A+NAS · stale hourly health/policy (>2h); reliability unknown'
    # Pair the two files from one hourly publication, not an old policy with
    # a fresh result. An interrupted publication fails closed.
    if health['observed_at'] != cadence['observed_at']:
        raise ValueError('unpaired policy')
    failed = [LABELS[k] for k in sorted(CHECKS) if not health['checks'][k]]
    status = 'incomplete: ' + ', '.join(failed) if failed else 'canonical checks passed'
    return health['healthy'], f'ROOT A+NAS · {status} · weekly/204h deadline; B excluded, not a backup'


def root_item(now=None):
    try:
        up, detail = root_health(metadata(HEALTH), metadata(CADENCE), now or datetime.now(timezone.utc))
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError):
        up, detail = False, 'ROOT A+NAS · health/policy missing or invalid; reliability unknown · B excluded, not a backup'
    return dict(id='backup-reliability', name='SSD + NAS backup reliability · ROOT',
                kind='Backup health', up=up, detail=detail)


def user_backup_status(service, timer_up, previous_result=None, now=None, directory=USER_RECEIPTS):
    """USER's current tag-only NAS publication cannot prove root A+NAS scope.

    Even a fresh verified USER receipt is explicitly insufficient for A+NAS
    integration. This adapter must be updated when that producer is integrated.
    """
    prefix = 'USER Sun 04:30 Taipei +0–10m · '
    if not timer_up:
        return False, prefix + 'timer/last run failed or unknown; A+NAS integration unverified'
    if service.get('ActiveState') in ('active', 'activating', 'reloading'):
        prior = '; previous failure retained' if previous_result not in (None, 'success') else ''
        return False, prefix + 'run incomplete' + prior + '; A+NAS integration unverified'
    try:
        # Inspect only the latest receipt, never the dump or remote object.
        latest = max(directory.glob('tag_observe-*.manifest.json'))
        data = metadata(latest)
        if data.get('database') != 'tag_observe' or data.get('status') != 'verified' or data.get('restore', {}).get('status') != 'passed':
            return False, prefix + 'latest receipt failed/incomplete; A+NAS integration unverified'
        age = age_seconds(data['finished_at'], now or datetime.now(timezone.utc))
        state = 'NAS receipt stale (>204h)' if age > 204 * 3600 else 'tag-only NAS receipt fresh'
        return False, prefix + state + '; A+NAS integration unverified'
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False, prefix + 'receipt missing/invalid; A+NAS integration unverified'


def observer_detail(code, raw):
    """Use a closed vocabulary; never forward arbitrary local response text."""
    base = f'HTTP {code}' if code else 'Endpoint unavailable'
    try:
        data = json.loads(raw)
        reasons = data['reasons']
        if (type(data['healthy']) is not bool or not isinstance(reasons, list)
                or any(not isinstance(x, str) for x in reasons)):
            raise ValueError('invalid health')
        known = {'backup_reliability', 'stale-collection', 'state-write-failed', 'no-sample', 'reporter', 'infovore', 'myzilla'}
        safe = [x for x in sorted(known) if x in reasons]
        if any(x.startswith('backup_run_') for x in reasons):
            safe.append('legacy receipt freshness (30h)')
        if safe:
            return base + ' · ' + ', '.join(safe)
        if not data['healthy']:
            return base + ' · other local health checks failing'
        return base
    except (ValueError, TypeError, KeyError):
        return base + ' · local health detail unknown'


def observer_up(code, raw):
    try:
        data = json.loads(raw)
        age = data['sample_age_seconds']
        return (code == 200 and data['healthy'] is True and data['reasons'] == []
                and type(age) in (int, float) and 0 <= age <= 150)
    except (ValueError, TypeError, KeyError):
        return False
