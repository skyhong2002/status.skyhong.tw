# status.skyhong.tw

A private operations dashboard for services hosted on `skyhong.tw`.

It checks configured public endpoints, reads Docker task state through a narrowly scoped read-only socket proxy, and retains a rolling 24-hour availability history. The dashboard is protected with HTTP Basic Auth and never exposes credentials or API keys to the browser.

## Add a product

Set `STATUS_TARGETS_JSON` in the deployment `.env` to an array of objects with `id`, `name`, `group`, and `url`. A response below HTTP 500 is considered reachable; a target can specify `acceptedStatuses` when it needs stricter checks.

## AI usage

`AI_USAGE_SOURCES_JSON` supports OpenAI organization usage collection. It requires an organization admin key and is intentionally optional: service health continues to work without billing credentials. Do not put keys in client-side code or commit `.env`.

## Deployment

The Compose stack joins `dokploy-network` and uses Dokploy's existing Traefik middleware and Let's Encrypt resolver. It runs in `/home/ubuntu/apps/sky-status-dashboard` on the host.

## SkyLabMac agent

`agent/skylabmac_agent.py` is a standard-library-only LaunchAgent. It sends a signed summary of selected macOS processes to the dashboard once a minute. Its token is stored only in `~/.config/sky-status-agent.json` with mode `600`; it does not open any listening port on SkyLabMac.
