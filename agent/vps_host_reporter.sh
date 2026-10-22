#!/usr/bin/env bash
# Reports VPS host metrics (disk, memory, load) to the status dashboard as a
# remote agent named "vps". Run once a minute from cron. Requires curl.
# When this host runs an AI gateway (CLIProxyAPI config at GATEWAY_CONFIG), it
# also attaches a gateway block from gateway_telemetry.py (needs python3), using
# the dashboard's own AI_GATEWAY_KEY from the adjacent .env.
#
#   AGENT_INGEST_TOKEN=... STATUS_ENDPOINT=https://status.skyhong.tw \
#     /home/ubuntu/apps/sky-status-dashboard/agent/vps_host_reporter.sh
set -euo pipefail

ENDPOINT="${STATUS_ENDPOINT:-https://status.skyhong.tw}"
ENV_FILE="${STATUS_ENV_FILE:-$(dirname "$0")/../.env}"
if [ -z "${AGENT_INGEST_TOKEN:-}" ]; then
  [ -f "$ENV_FILE" ] && AGENT_INGEST_TOKEN=$(grep -E '^AGENT_INGEST_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
fi
if [ -z "${HEARTBEAT_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
  HEARTBEAT_TOKEN=$(grep -E '^HEARTBEAT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
fi
if [ -z "${AI_GATEWAY_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  AI_GATEWAY_KEY=$(grep -E '^AI_GATEWAY_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)
fi
TOKEN="${AGENT_INGEST_TOKEN:?AGENT_INGEST_TOKEN required}"
GATEWAY_CONFIG="${GATEWAY_CONFIG:-$HOME/.config/cliproxyapi/config.yaml}"
GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://172.17.0.1:8317/v1}"
DISK_WARN="${DISK_WARN_PERCENT:-90}"
MEM_WARN="${MEM_WARN_PERCENT:-92}"
LOAD_WARN_PER_CORE="${LOAD_WARN_PER_CORE:-2}"

read -r disk_pct disk_used disk_total < <(df -Ph / | awk 'NR==2{gsub("%","",$5); print $5, $3, $2}')
read -r mem_pct mem_used mem_total < <(free -m | awk '/Mem:/{printf "%d %d %d\n", $3*100/$2, $3, $2}')
read -r load1 load5 _ < /proc/loadavg
cores=$(nproc)

bool() { [ "$1" -lt "$2" ] && echo true || echo false; }
disk_up=$(bool "$disk_pct" "$DISK_WARN")
mem_up=$(bool "$mem_pct" "$MEM_WARN")
# A one-minute spike is normal on a small VPS. Alert only when both the 1m and
# 5m averages exceed the per-core threshold, which represents sustained queueing.
load_up=$(awk -v l1="$load1" -v l5="$load5" -v c="$cores" -v m="$LOAD_WARN_PER_CORE" \
  'BEGIN{print (l1 < c*m || l5 < c*m) ? "true" : "false"}')

# Information only: leave the existing disk health/incident identity unchanged.
# The path parameter allows isolated fixtures; production always uses the fixed flag.
reboot_flag_detail() {
  local flag="$1" stamp now modified days
  if [ ! -e "$flag" ] && [ ! -L "$flag" ]; then
    # Bash existence tests also fail on EACCES. Only an accessible parent lets
    # us treat this as absence; normal parent aliases such as /var/run are valid.
    if [ ! -d "${flag%/*}" ] || [ ! -r "${flag%/*}" ] || [ ! -x "${flag%/*}" ]; then
      printf '; reboot flag unknown'
      return 0
    fi
    return 0
  fi
  if stamp=$(LC_ALL=C timeout 2s stat --format='%F:%Y' -- "$flag" 2>/dev/null) \
      && [[ "$stamp" =~ ^regular(\ empty)?\ file:([0-9]{1,12})$ ]]; then
    modified=$((10#${BASH_REMATCH[2]}))
    if now=$(timeout 2s date +%s 2>/dev/null) && [[ "$now" =~ ^[0-9]{1,12}$ ]]; then
      now=$((10#$now))
      if (( modified >= 946684800 && modified <= now )); then
        days=$(((now - modified) / 86400))
        if (( days > 36500 )); then
          printf '; reboot flag present (36500+d old)'
        else
          printf '; reboot flag present (%sd old)' "$days"
        fi
        return 0
      fi
    fi
  fi
  printf '; reboot flag unknown'
}
reboot_info=$(reboot_flag_detail /var/run/reboot-required) || reboot_info='; reboot flag unknown'

# Gateway telemetry is optional and must never block the host report.
gateway=""
if [ -f "$GATEWAY_CONFIG" ] && [ -n "${AI_GATEWAY_KEY:-}" ] && command -v python3 > /dev/null; then
  gateway=$(AI_GATEWAY_KEY="$AI_GATEWAY_KEY" timeout 90 python3 "$(dirname "$0")/gateway_telemetry.py" \
    --base-url "$GATEWAY_BASE_URL" --config "$GATEWAY_CONFIG" --state "$HOME/.cache/sky-status-gateway.json" \
    2>> "${GATEWAY_LOG:-/dev/null}") || gateway=""
fi
gateway_field=""
[ -n "$gateway" ] && gateway_field=",\"gateway\":$gateway"

payload=$(cat <<JSON
{"host":"$(hostname)","items":[
 {"id":"disk-root","name":"Disk /","kind":"Host metric","up":$disk_up,"detail":"${disk_pct}% used · ${disk_used}/${disk_total}${reboot_info}"},
 {"id":"memory","name":"Memory","kind":"Host metric","up":$mem_up,"detail":"${mem_pct}% used · ${mem_used}/${mem_total} MB"},
 {"id":"load","name":"Load average","kind":"Host metric","up":$load_up,"detail":"1m ${load1} · 5m ${load5} over ${cores} cores"}
]${gateway_field}}
JSON
)

curl -fsS -X POST "${ENDPOINT%/}/api/agents/vps" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$payload" > /dev/null

if [ -n "${HEARTBEAT_TOKEN:-}" ]; then
  curl -fsS -X POST "${ENDPOINT%/}/api/heartbeat/vps-host-reporter" \
    -H "Authorization: Bearer $HEARTBEAT_TOKEN" > /dev/null
fi
