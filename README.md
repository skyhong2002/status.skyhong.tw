# status.skyhong.tw

A public operations dashboard for services hosted on `skyhong.tw`.

It checks configured public endpoints, reads Docker task state through a narrowly scoped read-only socket proxy, and retains a rolling 24-hour availability history. The dashboard is intentionally public, while credentials and API keys remain server-side and are never returned to the browser.

The public interface uses a Kener-inspired status banner, monitor grouping, and segmented uptime history, with a compact infrastructure treatment informed by Gatus. See `THIRD_PARTY_NOTICES.md` for attribution and license details.

## Add a product

Set `STATUS_TARGETS_JSON` in the deployment `.env` to an array of objects with `id`, `name`, `group`, and `url`. HTTP 2xx and 3xx responses are healthy by default. A target can set `acceptedStatuses` for an expected authentication or edge-protection response such as Cloudflare's 403 challenge.

A target can also assert on the response body and latency: `keyword` marks the check down unless the body contains that text, `keywordAbsent` marks it down if the body contains that text, and `latencyThresholdMs` marks the target *degraded* (still up, shown amber) when a response is slower than the threshold. A request that fails to connect is additionally probed with a DNS lookup so a resolution failure is reported distinctly from an unreachable host.

## Certificate and domain expiry

Every HTTPS target's TLS certificate is inspected on a schedule (`CERT_CHECK_INTERVAL_HOURS`, default 6) and its registrable domain's registration expiry is looked up — over RDAP for generic TLDs, and over WHOIS (`whois.twnic.net.tw`) for `.tw` domains, which are not served by RDAP. A certificate within `CERT_WARN_DAYS` (default 21) or a domain within `DOMAIN_WARN_DAYS` (default 30) of expiry is surfaced on the dashboard and sent as an incident alert. A failed or unsupported expiry lookup is shown as unknown and never raised as an incident, so a WHOIS timeout cannot produce a false alert.

## OpenAI organization usage

The server reads `OPENAI_ADMIN_KEY` from the deployment `.env`. Use a dedicated Admin key restricted to the `Usage` read permission. The key is excluded from Git and the Docker build context, is never returned by the API, and is never embedded in browser JavaScript.

The collector runs hourly and re-fetches 48 hourly buckets. Results are upserted into `/data/usage.sqlite` by bucket, project, API key, model, and service tier, so delayed usage replaces the earlier snapshot instead of being counted twice. Costs are collected from the separate organization costs endpoint.

The interface labels the quota view `預估免費池使用量` because the Usage API reports observed tokens, not an official remaining-free-token field. Usage reported with an incentivized service tier is assigned to the high or mini pool from its model family; a reported non-incentivized tier is treated as possible billing traffic. Eligible-model patterns remain a fallback for records without service-tier data. Pool limits, fallback model patterns, project labels, and key-to-service labels are deployment settings. Possible billing traffic is shown in the usage table but does not count as a service incident.

Set `DISCORD_WEBHOOK_URL` to enable deduplicated alerts at 70%, 85%, and 95% for each pool. No webhook means the dashboard still shows the thresholds without sending messages.

## Incident alerts

Set `DISCORD_ALERT_WEBHOOK_URL` to receive a Discord message whenever a monitored item goes down or recovers. This covers every public target, Docker service, remote agent item, and the OpenAI collector's own health. If the alert webhook is unset it falls back to `DISCORD_WEBHOOK_URL`; if neither is set, no alerts are sent.

An item must fail `ALERT_FAILURE_THRESHOLD` consecutive checks (default 2) before a down alert fires, which suppresses single-check flapping. Each incident sends exactly one down message and one recovery message; the recovery note includes how long the item was down. Incident state is persisted to `/data/alerts.json`, so a restart neither loses an open incident nor re-sends an alert that already went out. A webhook that fails to deliver is retried on the next cycle rather than being marked as sent.

These outage alerts are independent of the OpenAI free-pool threshold alerts, so the two can target different channels.

## Heartbeats (dead-man's switch)

Scheduled jobs — cron entries, n8n workflows, backups — report liveness by pinging the dashboard instead of being probed. Configure `HEARTBEATS_JSON` as an array of `{ id, name, periodSeconds, graceSeconds }` and have each job call `GET`/`POST` `/api/heartbeat/<id>` on its schedule, authenticated with `HEARTBEAT_TOKEN` (falls back to `AGENT_INGEST_TOKEN`) via `?token=` or an `Authorization: Bearer` header:

```
curl -fsS "https://status.skyhong.tw/api/heartbeat/nightly-backup?token=$HEARTBEAT_TOKEN"
```

If a ping does not arrive within `periodSeconds + graceSeconds`, the heartbeat is marked late, surfaced on the dashboard, and sent as an incident alert. This generalizes the bespoke Bamboo watcher freshness check to any job.

Set `EXTERNAL_HEARTBEAT_URL` to have the dashboard ping an outside service (such as a Healthchecks.io check) after every successful refresh — so if the dashboard itself dies, that external service raises the alarm. This closes the "who watches the watcher" gap.

## Deployment

The Compose stack joins `dokploy-network` and uses Dokploy's existing Traefik middleware and Let's Encrypt resolver. It runs in `/home/ubuntu/apps/sky-status-dashboard` on the host.

## SkyLabMac agent

`agent/skylabmac_agent.py` is a standard-library-only LaunchAgent. It sends a signed summary of selected macOS processes to the dashboard once a minute. Its token is stored only in `~/.config/sky-status-agent.json` with mode `600`; it does not open any listening port on SkyLabMac.
