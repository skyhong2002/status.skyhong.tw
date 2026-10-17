# SkyLabMac health policies

The agent reports the existing `{ host, items, gateway? }` ingest payload. Monitor
IDs and each item's `id`, `name`, `kind`, `up`, and `detail` fields remain the same,
so the dashboard can receive the report without a coordinated server update.

## HTTP readiness

The LocalPlaud and RSSHub `/healthz` checks accept **HTTP 200** by default.
An HTTP response proves that a process answered; HTTP 500/503 still means its
health endpoint is not ready. Connection failures and timeouts also fail.

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
python3 -m unittest discover -s agent -p '*_test.py'
npm test
```

The readiness and completion tests inject HTTP results and temporary artifacts;
the existing gateway tests use local fixture servers. Tests do not run the agent
entry point against real configuration, send production reports, call an
upstream model, or send notifications. CI runs the dashboard suite on Node 22
and the agent suite on Python 3.12. The external watchdog workflow is separate.
