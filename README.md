# status.skyhong.tw

A private operations dashboard for services hosted on `skyhong.tw`.

It checks configured public endpoints, reads Docker task state through a narrowly scoped read-only socket proxy, and retains a rolling 24-hour availability history. The dashboard is protected with HTTP Basic Auth and never exposes credentials or API keys to the browser.

## Add a product

Set `STATUS_TARGETS_JSON` in the deployment `.env` to an array of objects with `id`, `name`, `group`, and `url`. HTTP 2xx and 3xx responses are healthy by default. A target can set `acceptedStatuses` for an expected authentication or edge-protection response such as Cloudflare's 403 challenge.

## OpenAI organization usage

The server reads `OPENAI_ADMIN_KEY` from the deployment `.env`. Use a dedicated Admin key restricted to the `Usage` read permission. The key is excluded from Git and the Docker build context, is never returned by the API, and is never embedded in browser JavaScript.

The collector runs hourly and re-fetches 48 hourly buckets. Results are upserted into `/data/usage.sqlite` by bucket, project, API key, model, and service tier, so delayed usage replaces the earlier snapshot instead of being counted twice. Costs are collected from the separate organization costs endpoint.

The interface labels the quota view `預估免費池使用量` because the Usage API reports observed tokens, not an official remaining-free-token field. Pool limits, eligible model patterns, project labels, and key-to-service labels are deployment settings. Models outside both configured pools are marked as possible billing traffic.

Set `DISCORD_WEBHOOK_URL` to enable deduplicated alerts at 70%, 85%, and 95% for each pool. No webhook means the dashboard still shows the thresholds without sending messages.

## Deployment

The Compose stack joins `dokploy-network` and uses Dokploy's existing Traefik middleware and Let's Encrypt resolver. It runs in `/home/ubuntu/apps/sky-status-dashboard` on the host.

## SkyLabMac agent

`agent/skylabmac_agent.py` is a standard-library-only LaunchAgent. It sends a signed summary of selected macOS processes to the dashboard once a minute. Its token is stored only in `~/.config/sky-status-agent.json` with mode `600`; it does not open any listening port on SkyLabMac.
