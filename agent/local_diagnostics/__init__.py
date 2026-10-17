"""Allowlisted local diagnostics; no agent, gateway or network-client imports."""
from . import bamboo, colima


BAMBOO_DETAILS = {
    "ok": "Recorded success within 36h",
    "disabled": "Disabled explicitly · attention; no job run requested",
    "drift_skip": "Drift skip · review job pin; keep spend guard enabled",
    "blocked_config": "Blocked configuration · attention",
    "job_error": "Last job run failed · attention",
    "delivery_error": "Reminder delivery failed · attention",
    "dispatch_error": "Reminder dispatch failed · attention",
    "stale_success": "Stale recorded success · older than 36h",
    "no_recorded_success": "Unknown · no recorded success",
    "invalid_last_run": "Unknown · invalid completion timestamp",
    "future_last_run": "Unknown · future completion timestamp",
    "invalid_enabled_state": "Unknown · invalid enabled state",
    "invalid_age_limit": "Unknown · invalid age limit",
    "invalid_store": "Unknown · invalid job store",
    "missing_or_duplicate_job": "Unknown · job missing or duplicated",
    "store_too_large": "Unknown · job store exceeds size limit",
    "store_unreadable": "Unknown · job store unreadable",
}
COLIMA_DETAILS = {
    "healthy": "Colima engine available · bamboo-rsshub running and Docker healthcheck healthy",
    "unexpected_docker_endpoint": "Unknown · Colima context does not match the required local Unix socket",
    "unknown_engine_version": "Unknown · invalid engine response",
    "engine_unavailable": "Unknown · local context or Colima engine unavailable",
    "container_unavailable": "Unknown · bamboo-rsshub inspect unavailable",
    "unexpected_inspect_schema": "Unknown · invalid container response",
    "container_not_running": "Attention · bamboo-rsshub container not running",
    "healthcheck_unconfigured": "Attention · bamboo-rsshub Docker healthcheck unconfigured",
    "unhealthy": "Attention · bamboo-rsshub Docker healthcheck unhealthy",
    "starting": "Unknown · bamboo-rsshub Docker healthcheck starting",
    "unknown_health": "Unknown · unrecognized Docker healthcheck state",
}


def _item(identifier, name, kind, check, details, success):
    # A fault in either diagnostic must not block the other or the existing agent.
    # Render only owned strings, never arbitrary state/error fields from sources.
    try:
        evidence, _ = check()
        state = evidence.get("state")
        detail = details.get(state, "Unknown · diagnostic evidence invalid")
        if state == "drift_skip" and evidence.get("repeat_notification_suppressed") is True:
            detail += " · repeat notification suppressed (silent)"
        up = state == success
    except Exception:
        state, up, detail = None, False, "Unknown · diagnostic evidence unavailable"
    item = {"id": identifier, "name": name, "kind": kind, "up": up, "detail": detail}
    code = 0 if up else (2 if state not in details or detail.startswith("Unknown") else 1)
    return item, code


def diagnostic_report(now=None):
    """Read only the Bamboo job store, Colima context metadata and local socket."""
    job, job_code = _item(
        "bamboo-daily-reminder", "Bamboo daily reminder", "Hermes cron diagnostic",
        lambda: bamboo.read_status(now=now), BAMBOO_DETAILS, "ok",
    )
    dependency, dependency_code = _item(
        "colima-bamboo-rsshub", "Colima → Bamboo RSSHub", "Local Docker dependency",
        colima.inspect_dependency, COLIMA_DETAILS, "healthy",
    )
    return {"items": [job, dependency]}, max(job_code, dependency_code)


def diagnostic_items():
    """The existing boolean wire schema represents disabled/unknown as attention."""
    return diagnostic_report()[0]["items"]
