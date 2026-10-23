# status.skyhong.tw

A public operations dashboard for services hosted on `skyhong.tw`.

It checks configured public endpoints, reads Docker task state through a narrowly scoped read-only socket proxy, and retains a rolling 24-hour availability history. The dashboard is intentionally public, while credentials and API keys remain server-side and are never returned to the browser.

The public interface uses a Kener-inspired status banner, monitor grouping, and segmented uptime history, with a compact infrastructure treatment informed by Gatus. It follows the system colour scheme and has a manual light/dark toggle. See `THIRD_PARTY_NOTICES.md` for attribution and license details.

## API

- `GET /api/status` — the dashboard snapshot. The 24-hour history is published as `history24h`: per monitor, a 48-character string (one 30-minute bin each; `0` no data, `1` all checks passed, `2` at least one failure) plus the 24-hour uptime percentage and check count. This keeps the payload around 70 KB.
- `GET /api/history` — the raw `{ t, up }` points behind that summary (about 1,440 per monitor), split out because they are several megabytes.
- `GET /api/incidents` — what is failing right now, for automated responders: every currently failing incident item (the same items and IDs that page Discord) with `failingSince`, `failCount`, `confirmed` (failed long enough to page, whether or not the webhook delivered) and `alerted`, plus the 20 most recent down/recovery events, the active maintenance window, and incident delivery status. Sky's private Hermes agent polls it every five minutes to investigate and repair confirmed incidents; see *Automated response* below.

## Add a product

Set `STATUS_TARGETS_JSON` in the deployment `.env` to an array of objects with `id`, `name`, `group`, and `url`. HTTP 2xx and 3xx responses are healthy by default. A target can set `checkUrl` when the visitor URL differs from a dedicated health endpoint, or `acceptedStatuses` for an expected authentication or edge-protection response such as Cloudflare's 403 challenge.

A target can also assert on the response body and latency: `keyword` marks the check down unless the body contains that text, `keywordAbsent` marks it down if the body contains that text, and `latencyThresholdMs` marks the target *degraded* (still up, shown amber) when a response is slower than the threshold. A request that fails to connect is additionally probed with a DNS lookup so a resolution failure is reported distinctly from an unreachable host.

## Certificate and domain expiry

Every HTTPS target's TLS certificate is inspected on a schedule (`CERT_CHECK_INTERVAL_HOURS`, default 6) and its registrable domain's registration expiry is looked up — over RDAP for generic TLDs, and over WHOIS (`whois.twnic.net.tw`) for `.tw` domains, which are not served by RDAP. A certificate within `CERT_WARN_DAYS` (default 21) or a domain within `DOMAIN_WARN_DAYS` (default 30) of expiry is surfaced on the dashboard and sent as an incident alert. A failed or unsupported expiry lookup is shown as unknown and never raised as an incident, so a WHOIS timeout cannot produce a false alert.

## AI gateway

Each production host has a local HA ingress (see `~/Projects/ai-gateway`, `hosts.json`, and `ha.py`). CLIProxyAPI engines on sky-mini and skyhong-blog back one another up; skyhong-sm runs only an ingress that prefers sky-mini and falls back to skyhong-blog. `AI_GATEWAYS_JSON` lists them in the same order: `name`, `url` (the listener as this container reaches it), `agent` (the remote agent that reports the host's gateway block), display labels `probeName` and `route`, and `enabled: false` plus a `note` for a host that is installed but not live yet. Disabled hosts are shown as off and never alert. Without the variable, the dashboard watches only sky-mini through `AI_GATEWAY_URL`. Each enabled host gets its own panel in the `AI gateway` section. Engine hosts have two sources; the ingress-only skyhong-sm has an authenticated listener/catalog probe and no local credential report:

- The backend lists models on each host's listener every check — sky-mini over the tailnet (`100.71.224.62:8318`), skyhong-blog on the Docker bridge (`172.17.0.1:8317`, opened to containers by the host's `ai-gateway-firewall.service`) , plus skyhong-sm's tailnet ingress (`100.85.214.25:8317`) — authenticated with the `status` client key in `AI_GATEWAY_KEY`, which every gateway accepts. Probes are skipped when the key is unset. Listing models spends no quota.
- An agent on the host adds a `gateway` block to its report, built by `agent/gateway_telemetry.py`: the local listener, the alias mapping and policy revision `apply.py` wrote into that host's config, a token-free summary of its Codex OAuth credential, the account logins described below, and every 30 minutes one tiny `sky-fast` request to confirm the alias answers with the policy model. On sky-mini the SkyLabMac agent also sends `model-policy.json` and the subscription usage windows read from `codex app-server` (`account/rateLimits/read`, every 5 minutes, no model turn); usage belongs to the account, so it is shown once. Its cache lives in `~/.config/sky-status-gateway.json`; set `"gateway": false` in the agent config to disable the block. On skyhong-blog, `agent/vps_host_reporter.sh` runs the module with the dashboard's own `AI_GATEWAY_KEY` from the adjacent `.env` and attaches the block whenever `~/.config/cliproxyapi/config.yaml` exists.

The server re-validates each block, masks the account address, and publishes only the sanitized snapshot. Each check — per host the probed and local listener, each alias against the policy, the credential, the inference probe and the host telemetry itself; once for the account, usage telemetry freshness and each usage window at or above 90% — is an ordinary incident item (`gateway:<host>:<check>`, or `gateway:quota…`): it alerts, counts toward the badge and `sky_incidents_total`, and is exported as `sky_up{kind="gateway"}` alongside `sky_gateway_quota_used_percent`. When a host's agent stops reporting, its agent-fed checks collapse into a single `host telemetry` incident. Gateway incidents never affect `/readyz`.

**Account logins.** ai-gateway keeps every account login on sky-mini and runs access mirrors of them on skyhong-blog; `account_failover.py` probes each account every minute and records its state in `~/.config/ai-gateway/account-failover.json`. Each agent attaches that file as an `accounts` block (masked address, a hash id, remaining quota, priority, and whether the upstream rejected the login or a mirror expired — never a token), and the dashboard turns it into:

- `gateway:<host>:login:<id>` — one per account the host owns. Down when the upstream rejects the login (HTTP 401/403, e.g. revoked after a plan change) or a T3 mirror expired. The detail says what to do: log in again in sky-mini's CPAMC → OAuth 登入. It recovers on its own once the new login is probed.
- `gateway:<host>:mirrors` — on a host that runs mirrors. Down only when a mirror expired, i.e. sky-mini stopped delivering tokens; a dead login is already reported by its owner, so it does not alert twice.
- `gateway:<host>:account-policy` — down when `account_failover.py` has not run for 10 minutes.

Used-up quota is shown in each account's row but never alerts: it resumes when the window resets, and the account policy has already moved traffic to the next account. A host that sends this block no longer gets the older single `Codex credential` check.

Usage telemetry reads the CLI's current account and checks its identity against every enabled Codex login in the gateway auth directory, including T3 mirror files with non-legacy names. Non-renewable logins require an unexpired timestamp; disabled or withdrawn mirrors cannot satisfy the match. Account IDs take precedence over email, so a different workspace remains a mismatch. This reading covers that one CLI account; it does not claim usage coverage for every account in the pool.

To add a host: enable it in `ai-gateway/hosts.json`, add it to `AI_GATEWAYS_JSON` in the host `.env` (a reachable `url`, and, for engine hosts, an `agent` that runs `gateway_telemetry.py` there), and restart the dashboard. Ingress-only nodes omit `agent`. Listener and inference probes pass through HA and may be served by a backup; they do not independently prove the local engine is healthy. Per-origin state is available from the HAProxy admin socket on each host.

## Long-term availability

Alongside the rolling 24-hour history, each check is folded into per-day uptime and latency aggregates in `/data/uptime.sqlite`, retained for 90 days. The dashboard shows the actual observed-day coverage until enough data exists for a complete 7-, 30-, or 90-day window, so a new deployment does not present partial history as a full SLA period.

## Incident alerts

Set `DISCORD_ALERT_WEBHOOK_URL` to receive a Discord message whenever a monitored item goes down or recovers. This covers every public target, Docker service, remote agent item, heartbeat, certificate and domain expiry, and AI gateway check. If the alert webhook is unset it falls back to `DISCORD_WEBHOOK_URL`; if neither is set, no alerts are sent.

An item must fail `ALERT_FAILURE_THRESHOLD` consecutive checks (default 2) before a down alert fires, which suppresses single-check flapping. Each incident sends exactly one down message and one recovery message; the recovery note includes how long the item was down. Incident state is persisted to `/data/alerts.json`, so a restart neither loses an open incident nor re-sends an alert that already went out. A webhook that fails to deliver is retried on the next cycle rather than being marked as sent. Delivery attempts, successes, and failures are persisted and exposed through the public status API and Prometheus metrics. An authenticated `POST /api/alerts/test` checks the Discord webhook end to end.

## Automated response

Sky's private Hermes agent (on mint-mbp, repository `skyhong2002/hermes-agent`) watches `GET /api/incidents` every five minutes. When an incident becomes `confirmed`, or the dashboard itself stops answering, it signs in to this VPS over Tailscale with a dedicated key (`hermes@mint-mbp`, restricted to Mint's tailnet address in `~ubuntu/.ssh/authorized_keys`), investigates, applies reversible fixes, and reports to Discord `#ops`. It may also improve this dashboard's coverage; such changes land here as ordinary commits and deployments, following *Deployment* below. Remove that `authorized_keys` line to revoke its access.

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

## Search indexing

Only the dashboard itself, `PUBLIC_ORIGIN/`, is meant for search (`seo.mjs`). It carries `<link rel="canonical">` to that URL, and `GET /sitemap.xml` lists only it; `GET /robots.txt` allows crawling and names the sitemap. Every other response — `/api/*`, metrics, health, feed, badge, assets, token endpoints, 404s — is served with `X-Robots-Tag: noindex`. They are deliberately not disallowed in robots.txt: the page renders from `/api/status`, and the footer links `/metrics`, `/feed.xml`, and `/badge.svg`, so crawlers must be able to fetch them to see the noindex. Adding a page to the sitemap means adding it to `INDEXABLE_PATHS`; never add API, metrics, or private host data. The rollout record, including the n8n noindex change, is in `docs/gsc-20261023.md`.

## Deployment

The Compose stack joins `dokploy-network` and uses Dokploy's existing Traefik middleware and Let's Encrypt resolver. It runs in `/home/ubuntu/apps/sky-status-dashboard` on the host.

Before deployment, back up `.env`, then run `node scripts/configure_production_env.mjs .env .env.example` to apply the checked-in target/heartbeat configuration and generate a dedicated heartbeat token when absent. The script replaces `STATUS_TARGETS_JSON` and `HEARTBEATS_JSON` wholesale, so only run it when `.env.example` matches production; for any other change, edit the host `.env` directly.

Build with the commit baked in: `GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build`. After deployment, check that `version` in `GET /readyz` (also in `/healthz` and `sky_build_info` in `/metrics`) matches that commit; a plain `docker compose up --build` reports `unknown`.

The application runs as UID/GID 1000 with all capabilities dropped, a read-only root filesystem, a writable `/data` volume, and a small temporary filesystem. Security headers include HSTS, CSP, frame denial, and a restrictive permissions policy.

The Compose configuration limits each service's Docker JSON logs to 20 MiB per
file, retaining three files per container. Existing containers keep their current
logging settings until recreated in a normal deployment; pulling this file alone
does not activate rotation. Verify the resulting `HostConfig.LogConfig` after
deployment. This setting does not cap application data or other services' logs.

## SkyLabMac agent

`agent/skylabmac_agent.py` is a standard-library-only LaunchAgent. It sends a summary of selected macOS processes to the dashboard once a minute, along with host metrics — root disk usage, load average, and memory pressure — each flagged when it crosses a threshold. It authenticates with a bearer token stored only in `~/.config/sky-status-agent.json` with mode `600`; it does not open any listening port on SkyLabMac.

`agent/vps_host_reporter.sh` does the same for the Linux VPS: run it once a minute from cron and it posts disk, memory, and load to the dashboard as the `vps` remote agent, plus the local AI gateway block described above. It reads `AGENT_INGEST_TOKEN` from the environment or from the adjacent deployment `.env`. Load is considered down only when both the 1-minute and 5-minute averages exceed `LOAD_WARN_PER_CORE` (default 2) times the CPU count, so a brief spike does not create an incident.

Standalone Docker containers are additionally inspected for restart count and OOM-kills, so a crash-looping or out-of-memory container is reported as down instead of appearing to run.

## OmniObserve IIC retirement and historical tunnel

On **2026-10-22**, the owner confirmed that the OmniObserve IIC host was
intentionally shut down and is **retired**. Production monitoring no longer
includes its 14 `omni-*` targets (main/sky/ej/ethel/jason/em web and API, Jitsi,
and monitoring) or the `omniobserve-backup` heartbeat. There is no enabled IIC
gateway or required live IIC agent. Do not restart IIC or its old tunnel to
repair monitoring.

Remove retired entries only from the production `.env`, after backing it up;
preserve every other target, heartbeat, and environment value. Do not apply
`.env.example` wholesale. Without `omni-main-web`, the server stops both the
direct network-path probe and the synthetic `omni-monitor-path` incident.
The historical `omni-probe` report is already excluded from live agent checks.
Keep old heartbeat pings, alert records, and incident events unchanged: retirement
is not recovery. Archive the JSON state and use SQLite's online backup API before
retirement so history remains available beyond the normal 24-hour/90-day retention.

The following describes the former setup. `infra/omni-tunnel/` remains a
historical recovery template, not an active deployment requirement. The unused
socket directory mount and group membership may remain; they do not start a tunnel.

The IIC VM previously initiated an SSH connection to skyhong.tw:22. It exposed
only a Unix socket at /var/lib/omni-monitor-tunnel/socket/origin.sock on skyhong.tw,
forwarding to the VM's own 127.0.0.1:443. No new public TCP port was opened.
The dashboard used a directory bind mount (not the socket inode) and group 986
to connect. HTTPS requests preserved the original hostname/SNI and validated certificates.

The dedicated key was restricted to 140.110.146.224. SSH shell/exec/SFTP,
PTY, agent/X11 forwarding and TUN were disabled. Remote Unix forwarding was enabled.
In this OpenSSH version AllowTcpForwarding=no also prevents the Unix listener
through a shared permission check. Therefore the historical configuration enabled remote
forwarding but used PermitListen=none to deny all TCP listener requests; live
negative tests verified command and TCP forwarding requests fail. See
https://github.com/openssh/openssh-portable/blob/V_9_6_P1/session.c and channels.c.

The client pinned the server host key, ran without privileges and used keepalives,
ExitOnForwardFailure and Docker restart. The socket had mode 0660, in a private
directory. A forced SSH disconnect recovered automatically in 4.7 seconds;
wrong-certificate requests failed validation and all 14 endpoints returned 200.

Former IIC Dokploy Compose: 7B7WV1k8Z5_5PRhTLL-2c (omni-monitor-tunnel-lkblfa).
Historical recovery templates are under infra/omni-tunnel/. The private key was
supplied through TUNNEL_PRIVATE_KEY_B64 in Dokploy; never commit key material.

Before retirement, the status page labeled the source as skyhong.tw via private SSH.
Direct public routing from skyhong.tw to IIC was also tested and disclosed in
expanded details, but was not an active incident when the selected monitoring
transport was healthy. This verified origin health, not global public reachability.
The temporary SkyLabMac HTTP probe is disabled; its ordinary process agent remains.
The retired standalone uptime containers are removed, with their data volume retained.
