# status.skyhong.tw

A public operations dashboard for services hosted on `skyhong.tw`.

It checks configured public endpoints, reads Docker task state through a narrowly scoped read-only socket proxy, and retains a rolling 24-hour availability history. The dashboard is intentionally public, while credentials and API keys remain server-side and are never returned to the browser.

The public interface uses a Kener-inspired status banner, monitor grouping, and segmented uptime history, with a compact infrastructure treatment informed by Gatus. See `THIRD_PARTY_NOTICES.md` for attribution and license details.

## Add a product

Set `STATUS_TARGETS_JSON` in the deployment `.env` to an array of objects with `id`, `name`, `group`, and `url`. HTTP 2xx and 3xx responses are healthy by default. A target can set `checkUrl` when the visitor URL differs from a dedicated health endpoint, or `acceptedStatuses` for an expected authentication or edge-protection response such as Cloudflare's 403 challenge.

A target can also assert on the response body and latency: `keyword` marks the check down unless the body contains that text, `keywordAbsent` marks it down if the body contains that text, and `latencyThresholdMs` marks the target *degraded* (still up, shown amber) when a response is slower than the threshold. A request that fails to connect is additionally probed with a DNS lookup so a resolution failure is reported distinctly from an unreachable host.

## Certificate and domain expiry

Every HTTPS target's TLS certificate is inspected on a schedule (`CERT_CHECK_INTERVAL_HOURS`, default 6) and its registrable domain's registration expiry is looked up — over RDAP for generic TLDs, and over WHOIS (`whois.twnic.net.tw`) for `.tw` domains, which are not served by RDAP. A certificate within `CERT_WARN_DAYS` (default 21) or a domain within `DOMAIN_WARN_DAYS` (default 30) of expiry is surfaced on the dashboard and sent as an incident alert. A failed or unsupported expiry lookup is shown as unknown and never raised as an incident, so a WHOIS timeout cannot produce a false alert.

## AI gateway

Every production host runs its own OpenAI-compatible gateway (CLIProxyAPI; see `~/Projects/ai-gateway` and its `hosts.json`), so a host failure only affects the projects on that host. `AI_GATEWAYS_JSON` lists them in the same order: `name`, `url` (the listener as this container reaches it), `agent` (the remote agent that reports the host's gateway block), display labels `probeName` and `route`, and `enabled: false` plus a `note` for a host that is installed but not live yet. Disabled hosts are shown as off and never alert. Without the variable, the dashboard watches only sky-mini through `AI_GATEWAY_URL`. Each enabled host gets its own panel in the `AI gateway` section, fed by two sources:

- The backend lists models on each host's listener every check — sky-mini over the tailnet (`100.71.224.62:8318`), skyhong-blog on the Docker bridge (`172.17.0.1:8317`, opened to containers by the host's `ai-gateway-firewall.service`) — authenticated with the `status` client key in `AI_GATEWAY_KEY`, which every gateway accepts. Probes are skipped when the key is unset. Listing models spends no quota.
- An agent on the host adds a `gateway` block to its report, built by `agent/gateway_telemetry.py`: the local listener, the alias mapping and policy revision `apply.py` wrote into that host's config, a token-free summary of its Codex OAuth credential, and every 30 minutes one tiny `sky-fast` request to confirm the alias answers with the policy model. On sky-mini the SkyLabMac agent also sends `model-policy.json` and the subscription usage windows read from `codex app-server` (`account/rateLimits/read`, every 5 minutes, no model turn); usage belongs to the account, so it is shown once. Its cache lives in `~/.config/sky-status-gateway.json`; set `"gateway": false` in the agent config to disable the block. On skyhong-blog, `agent/vps_host_reporter.sh` runs the module with the dashboard's own `AI_GATEWAY_KEY` from the adjacent `.env` and attaches the block whenever `~/.config/cliproxyapi/config.yaml` exists.

The server re-validates each block, masks the account address, and publishes only the sanitized snapshot. Each check — per host the probed and local listener, each alias against the policy, the credential, the inference probe and the host telemetry itself; once for the account, usage telemetry freshness and each usage window at or above 90% — is an ordinary incident item (`gateway:<host>:<check>`, or `gateway:quota…`): it alerts, counts toward the badge and `sky_incidents_total`, and is exported as `sky_up{kind="gateway"}` alongside `sky_gateway_quota_used_percent`. When a host's agent stops reporting, its agent-fed checks collapse into a single `host telemetry` incident. Gateway incidents never affect `/readyz`.

To add a host: enable it in `ai-gateway/hosts.json`, add it to `AI_GATEWAYS_JSON` in the host `.env` (a reachable `url`, and an `agent` that runs `gateway_telemetry.py` there), and restart the dashboard.

## Long-term availability

Alongside the rolling 24-hour history, each check is folded into per-day uptime and latency aggregates in `/data/uptime.sqlite`, retained for 90 days. The dashboard shows the actual observed-day coverage until enough data exists for a complete 7-, 30-, or 90-day window, so a new deployment does not present partial history as a full SLA period.

## Incident alerts

Set `DISCORD_ALERT_WEBHOOK_URL` to receive a Discord message whenever a monitored item goes down or recovers. This covers every public target, Docker service, remote agent item, heartbeat, certificate and domain expiry, and AI gateway check. If the alert webhook is unset it falls back to `DISCORD_WEBHOOK_URL`; if neither is set, no alerts are sent.

An item must fail `ALERT_FAILURE_THRESHOLD` consecutive checks (default 2) before a down alert fires, which suppresses single-check flapping. Each incident sends exactly one down message and one recovery message; the recovery note includes how long the item was down. Incident state is persisted to `/data/alerts.json`, so a restart neither loses an open incident nor re-sends an alert that already went out. A webhook that fails to deliver is retried on the next cycle rather than being marked as sent. Delivery attempts, successes, and failures are persisted and exposed through the public status API and Prometheus metrics. An authenticated `POST /api/alerts/test` checks the Discord webhook end to end.

## Heartbeats (dead-man's switch)

Scheduled jobs — cron entries, n8n workflows, backups — report liveness by pinging the dashboard instead of being probed. Configure `HEARTBEATS_JSON` as an array of `{ id, name, periodSeconds, graceSeconds }` and have each job call `GET`/`POST` `/api/heartbeat/<id>` on its schedule, authenticated with `HEARTBEAT_TOKEN` (falls back to `AGENT_INGEST_TOKEN`) via `?token=` or an `Authorization: Bearer` header:

```
curl -fsS "https://status.skyhong.tw/api/heartbeat/nightly-backup?token=$HEARTBEAT_TOKEN"
```

If a ping does not arrive within `periodSeconds + graceSeconds`, the heartbeat is marked late, surfaced on the dashboard, and sent as an incident alert. This generalizes the bespoke Bamboo watcher freshness check to any job.

The included `External status watchdog` GitHub Actions workflow probes the `/readyz` endpoint every five minutes, deduplicates failures with a GitHub Issue, and sends Discord down/recovery messages. This remains independent when the VPS or dashboard is unavailable. `EXTERNAL_HEARTBEAT_URL` remains available as an optional second dead-man service.

The production heartbeat set covers the VPS reporter, Bamboo Discord watcher, n8n scheduler, and the daily status-data backup. `agent/status_data_backup.sh` uses SQLite's online backup API, archives the JSON state, retains 14 days, and records its heartbeat only after the archive completes.

## Metrics, badge, and feed

- `GET /metrics` — Prometheus exposition of per-monitor availability (`sky_up`), response time, certificate and domain days-remaining, rolling uptime ratios, and the active incident count, for scraping into Grafana or Alertmanager.
- `GET /badge.svg` — an embeddable SVG badge that reads operational or shows the active incident count.
- `GET /feed.xml` — an RSS feed of down and recovery events, backed by an incident log in `/data/incidents.json`.
- `GET /readyz` — dashboard readiness based on a fresh monitoring loop. Docker routing and the external watchdog use this endpoint so a Docker collector, AI gateway, or notification failure cannot block agent reports and heartbeats.
- `GET /healthz` — detailed dependency health covering refresh freshness, Docker, and the incident Discord webhook. Dependency failures remain visible here and in incident alerts. `GET /livez` remains the process-only liveness endpoint.

Set `MAINTENANCE_JSON` to an array of `{ start, end, reason }` ISO windows to pause alerts and show a maintenance banner during planned work. The agent ingest and heartbeat endpoints are rate limited per client IP.

## Deployment

The Compose stack joins `dokploy-network` and uses Dokploy's existing Traefik middleware and Let's Encrypt resolver. It runs in `/home/ubuntu/apps/sky-status-dashboard` on the host.

Before deployment, back up `.env`, then run `node scripts/configure_production_env.mjs .env .env.example` to apply the checked-in target/heartbeat configuration and generate a dedicated heartbeat token when absent. The script replaces `STATUS_TARGETS_JSON` and `HEARTBEATS_JSON` wholesale, so only run it when `.env.example` matches production; for any other change, edit the host `.env` directly.

The application runs as UID/GID 1000 with all capabilities dropped, a read-only root filesystem, a writable `/data` volume, and a small temporary filesystem. Security headers include HSTS, CSP, frame denial, and a restrictive permissions policy.

## SkyLabMac agent

`agent/skylabmac_agent.py` is a standard-library-only LaunchAgent. It sends a summary of selected macOS processes to the dashboard once a minute, along with host metrics — root disk usage, load average, and memory pressure — each flagged when it crosses a threshold. It authenticates with a bearer token stored only in `~/.config/sky-status-agent.json` with mode `600`; it does not open any listening port on SkyLabMac.

`agent/vps_host_reporter.sh` does the same for the Linux VPS: run it once a minute from cron and it posts disk, memory, and load to the dashboard as the `vps` remote agent, plus the local AI gateway block described above. It reads `AGENT_INGEST_TOKEN` from the environment or from the adjacent deployment `.env`. Load is considered down only when both the 1-minute and 5-minute averages exceed `LOAD_WARN_PER_CORE` (default 2) times the CPU count, so a brief spike does not create an incident.

Standalone Docker containers are additionally inspected for restart count and OOM-kills, so a crash-looping or out-of-memory container is reported as down instead of appearing to run.

## OmniObserve private monitoring tunnel

The IIC VM initiates an SSH connection to skyhong.tw:22. It exposes only a Unix
socket at /var/lib/omni-monitor-tunnel/socket/origin.sock on skyhong.tw, forwarding
to the VM's own 127.0.0.1:443. No new public TCP port is opened. The dashboard
bind-mounts the directory (not the socket inode) and joins group 986 to connect.
HTTPS requests preserve the original hostname/SNI and validate certificates.

The dedicated key only authenticates from 140.110.146.224. SSH shell/exec/SFTP,
PTY, agent/X11 forwarding and TUN are disabled. Remote Unix forwarding is enabled.
In this OpenSSH version AllowTcpForwarding=no also prevents the Unix listener
through a shared permission check. Therefore the configuration enables remote
forwarding but uses PermitListen=none to deny all TCP listener requests; live
negative tests verified command and TCP forwarding requests fail. See
https://github.com/openssh/openssh-portable/blob/V_9_6_P1/session.c and channels.c.

The client pins the server host key, runs without privileges and uses keepalives,
ExitOnForwardFailure and Docker restart. The socket is mode 0660, in a private
directory. A forced SSH disconnect recovered automatically in 4.7 seconds;
wrong-certificate requests failed validation and all 14 endpoints returned 200.

IIC Dokploy Compose: 7B7WV1k8Z5_5PRhTLL-2c (omni-monitor-tunnel-lkblfa).
Public recovery templates are under infra/omni-tunnel/. Supply the private key
through TUNNEL_PRIVATE_KEY_B64 in Dokploy; never commit key material.

The status page explicitly labels the source as skyhong.tw via private SSH.
Direct public routing from skyhong.tw to IIC is still tested and disclosed in
expanded details, but is not an active incident when the selected monitoring
transport is healthy. This verifies origin health, not global public reachability.
The temporary SkyLabMac HTTP probe is disabled; its ordinary process agent remains.
The retired standalone uptime containers are removed, with their data volume retained.
