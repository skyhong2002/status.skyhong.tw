#!/usr/bin/env python3
"""Read-only local visibility for Bamboo's daily social reminder, without Hermes imports.

Exit 0: recent recorded success or explicitly disabled. Exit 1: attention.
Exit 2: unknown/input failure. Never print job prompts, destinations or raw errors.
"""
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path

JOB_ID = "c808402728f9"
JOBS_PATH = Path("/Users/skyhong/.hermes/profiles/bamboo/cron/jobs.json")
DRIFT_MARKERS = ("[drift_skip]", "[drift_skip:silent]")


def result(state, code, **fields):
    return {"job_id": JOB_ID, "state": state, **fields}, code


def inspect_job(document, now, max_age_hours=36):
    if not math.isfinite(max_age_hours) or max_age_hours <= 0:
        return result("invalid_age_limit", 2)
    jobs = document.get("jobs") if isinstance(document, dict) else document
    if not isinstance(jobs, list) or any(not isinstance(j, dict) for j in jobs):
        return result("invalid_store", 2)
    matches = [j for j in jobs if j.get("id") == JOB_ID]
    if len(matches) != 1:
        return result("missing_or_duplicate_job", 2)
    job = matches[0]
    enabled = job.get("enabled", True)
    if not isinstance(enabled, bool):
        return result("invalid_enabled_state", 2)
    if not enabled:
        return result("disabled", 0)
    error = job.get("last_error")
    error = error if isinstance(error, str) else ""
    if any(marker in error for marker in DRIFT_MARKERS):
        return result("drift_skip", 1,
                      repeat_notification_suppressed="[drift_skip:silent]" in error,
                      action="Review this job's model/provider pin; keep the spend guard enabled.")
    status = job.get("last_status")
    if status == "blocked_config":
        return result("blocked_config", 1)
    if status == "error":
        return result("job_error", 1)
    if status != "ok":
        return result("no_recorded_success", 2)
    if job.get("last_error"):
        return result("job_error", 1)
    # A successful agent run may still have failed to deliver its reminder.
    if job.get("last_delivery_error"):
        return result("delivery_error", 1)
    if job.get("last_fire_error"):
        return result("dispatch_error", 1)
    try:
        # Python 3.9 does not accept the UTC Z suffix directly.
        stamp = datetime.fromisoformat(job["last_run_at"].replace("Z", "+00:00"))
        if stamp.tzinfo is None or stamp.utcoffset() is None:
            raise ValueError("timezone required")
        age = now - stamp
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return result("invalid_last_run", 2)
    if age < -timedelta(minutes=5):
        return result("future_last_run", 2)
    if age.total_seconds() / 3600 > max_age_hours:
        return result("stale_success", 1, last_run_at=stamp.isoformat())
    return result("ok", 0, last_run_at=stamp.isoformat())


def read_status(path=JOBS_PATH, now=None, max_age_hours=36):
    now = now or datetime.now(timezone.utc)
    try:
        # Bound input; no output/history/session files are opened.
        with path.open("rb") as handle:
            raw = handle.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            return result("store_too_large", 2)
        document = json.loads(raw)
    except (OSError, ValueError, UnicodeError, RecursionError):
        return result("store_unreadable", 2)
    return inspect_job(document, now, max_age_hours)
