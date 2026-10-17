# SkyLabMac health policies

The agent reports the existing `{ host, items, gateway? }` ingest payload.
Existing monitor IDs and each item's `id`, `name`, `kind`, `up`, and `detail`
fields remain the same,
so the dashboard can receive the report without a coordinated server update.

## HTTP readiness

The LocalPlaud and RSSHub `/healthz` checks accept **HTTP 200** by default.
An HTTP response proves that a process answered; HTTP 500/503 still means its
health endpoint is not ready. Connection failures and timeouts also fail.
Redirects are not followed: a health endpoint's 302 to a login page fails the
default policy even when that login page would return 200. An explicitly accepted
302 is evaluated directly without requesting its destination. This readiness-only
policy does not change redirects for report ingestion, heartbeats, or gateway calls.

If a specific endpoint intentionally uses an authentication challenge as its
expected response, add its monitor ID to the existing private agent config at
`~/.config/sky-status-agent.json`:

```json
{
  "http_accepted_statuses": {
    "localplaud-api": [200, 401]
  }
}
```

Merge this optional key into the existing config; retain its endpoint, token,
and other settings. No override is needed for the current health endpoints.
Overrides are scoped to HTTP monitor IDs, must list integer status codes from
200 through 499, and never make server errors healthy. Invalid policies fail
configuration validation before any probe or report is sent. Accepting an auth
challenge confirms the expected boundary is responding; it does not authenticate
or inspect the protected service. Ordinary process/LaunchAgent checks remain
liveness checks.

## Scheduled-job freshness

Chumei's three-hour pipeline writes `state/pipeline.json` after its steps finish.
Its `last_run` timestamp and `last_results.build` value establish a successful
publish; the legacy `telegram` result, when present, must also succeed. Optional
fetch failures follow the producer's existing exit-status policy and do not turn
a successful publish into a failed run.

The `chumei-pipeline` monitor now requires this successful completion evidence to
be no older than **four hours**, allowing an hour beyond its normal interval.
Missing, malformed, timezone-free, or over 60 seconds future-dated evidence fails the check. A
new file modification time cannot make an old completion fresh. Starting a new
run does not hide stale output, and fresh output cannot hide a launchd failure.
The agent reads the artifact without changing it.

Other scheduled jobs keep their existing launchd exit-status checks without a
freshness policy. Harmonica's full and fast pipelines share a runtime file, and
runtime heartbeats can be overwritten by a running job. Those records are not
treated as proof that each scheduled job last succeeded. This change does not
add or alter OmniObserve monitors.

## Offline validation

```sh
python3 -B agent/run_local_tests.py
npm test
```

The Python runner installs socket/DNS/subprocess and production-data read guards
before importing tests. Tests exercise function orchestration with mocks and
temporary artifacts, never agent `main`, `gateway_report`, reporting or
heartbeats. Four legacy loopback HTTP/gateway integration tests are explicitly
skipped by this runner. Their source remains available, but running unguarded
unittest discovery does not provide these protections. The Node test preload
denies outbound connections, DNS, fetch and child commands before test imports;
the existing localhost lookup test receives a synthetic loopback result.
CI uses these guarded commands on Node 22 / Python 3.12. The local diagnostic
module and runner also support Python 3.9. The external watchdog is separate.

Implementation validation on 2026-10-18: Python 3.9.6 and 3.14.7 each passed
55 tests with four explicit skips (59 discovered); Node 26.8.1 passed all 50
tests. Guard regressions confirm denied connections/processes and production
reads. No live diagnostic command, agent entry point or telemetry was executed.

## Local diagnostic visibility

`agent/local_diagnostics` vendors the reviewed Bamboo `check_job.py` and Colima
`check_dependency.py` logic into the repository. It needs only Python's standard
library and the local Homebrew Docker CLI; there are no scratch imports, Hermes
imports, new services, schedulers or state files. The existing status agent
includes two additional items on its normal report:

- `bamboo-daily-reminder`: job `c808402728f9` only, from
  `/Users/skyhong/.hermes/profiles/bamboo/cron/jobs.json`. Only recorded `ok`
  success within 36 hours is up. Delivery/dispatch errors, contradictory errors,
  stale success, missing/duplicate jobs and invalid evidence are attention.
  Timestamps require a timezone, accept `Z` on Python 3.9 and tolerate at most
  five minutes of future clock skew. Both `[drift_skip]` and
  `[drift_skip:silent]` stay visible as drift skips; the latter explicitly says
  repeat notification is suppressed. This does not clear `drift_alerted`, rerun
  the job, pick a model/provider pin or bypass the spend guard. An owner must
  review the job-specific pin separately. A stored success is scheduler evidence,
  not independent confirmation that a recipient saw the reminder.
- `colima-bamboo-rsshub`: engine availability and Docker container health for
  `bamboo-rsshub`. Only running **and** Docker `healthy` is up. Unconfigured,
  unhealthy and stopped states are labeled attention; starting, unavailable and
  unrecognized evidence are explicitly unknown. This is independent of the
  unchanged `bamboo-rsshub` HTTP readiness check. A healthy dependency does not
  prove upstream scraping/model routes work. RSSHub was reported healthy at
  handoff; this change makes no new live health observation.

The public ingest schema is boolean. Explicitly disabled jobs therefore appear
as `up: false` with **Disabled explicitly** text, and unknown states also stay
`up: false`. There is no fabricated green state or schema expansion. Existing
HTTP policy, Chumei freshness, other monitors and heartbeat eligibility remain
unchanged. The diagnostics themselves do not notify; after rollout their items
participate in the dashboard's existing generic incident handling, so deployment
may produce a new incident for an existing drift/disabled/unknown condition.

Docker access first reads only the named `colima` context metadata at
`~/.docker/contexts/meta/SHA256(colima)/meta.json` for this host's fixed user path.
It must identify `colima` and exactly
`unix:///Users/skyhong/.colima/default/docker.sock`. A missing or different
endpoint fails closed before any engine query. Each query then uses `--host`
with that exact socket, avoiding context-change races and default overrides.
An empty temporary `--config` directory and minimal child environment avoid
loading Docker credentials, plugins selected by client config, proxies or
`DOCKER_*` overrides. The CLI is `/opt/homebrew/bin/docker` (verified available
on the implementation host); a missing binary produces unknown. Queries are
only `info` for a server-version scalar and formatted `inspect` for container
status/health, each with an eight-second subprocess timeout (up to 16 seconds
total). They do not change defaults, start/restart anything, use `exec`, dump
container configuration or expose Docker health logs. Context input is capped
at 64 KiB and the cron store at 16 MiB. JSON, subprocess failures and arbitrary
fields become fixed sanitized messages; no raw errors/history are printed.

For a local read-only diagnostic, run from the repository root:

```sh
python3 -B -m agent.local_diagnostics
```

This command reads only the allowlisted job store, context metadata and local
Docker socket. It accepts no path, endpoint, context or config overrides and
prints sanitized JSON with the same two status items. Exit 0 means both have
positive success/health evidence; 1 means attention (including disabled); 2
means at least one unknown/input failure. It never imports the status agent or
gateway telemetry, loads agent config/tokens, posts ingestion/heartbeat data,
runs a job, sends a notification, or installs anything. Docker creates and
removes only an empty temporary client-config directory. Unit tests inject both
sources; the command was not run against live sources during implementation.

Rollout is deferred. Review and deploy this commit plus the whole
`agent/local_diagnostics/` package together through the existing agent delivery
process; no launchd/schedule or production-config edits are required. Do not
copy an entire worktree over the live checkout: preserve its unrelated dirty
`README.md` and `.env.example`. This implementation did not modify live files,
services, Docker, jobs, providers or remotes. A later owner can run the local
command and confirm both new IDs reach the dashboard through normal reporting.
Rollback removes the two diagnostic items/integration by reverting this commit;
there is no diagnostic persistent state or job mutation to undo. Existing
dashboard incident/history retention still follows its normal policy.
