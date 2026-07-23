#!/usr/bin/env bash
# Reports VPS host metrics (disk, memory, load) to the status dashboard as a
# remote agent named "vps". Run once a minute from cron. Requires curl.
#
#   AGENT_INGEST_TOKEN=... STATUS_ENDPOINT=https://status.skyhong.tw \
#     /home/ubuntu/apps/sky-status-dashboard/agent/vps_host_reporter.sh
set -euo pipefail

ENDPOINT="${STATUS_ENDPOINT:-https://status.skyhong.tw}"
if [ -z "${AGENT_INGEST_TOKEN:-}" ]; then
  ENV_FILE="${STATUS_ENV_FILE:-$(dirname "$0")/../.env}"
  [ -f "$ENV_FILE" ] && AGENT_INGEST_TOKEN=$(grep -E '^AGENT_INGEST_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
fi
TOKEN="${AGENT_INGEST_TOKEN:?AGENT_INGEST_TOKEN required}"
DISK_WARN="${DISK_WARN_PERCENT:-90}"
MEM_WARN="${MEM_WARN_PERCENT:-92}"

read -r disk_pct disk_used disk_total < <(df -Ph / | awk 'NR==2{gsub("%","",$5); print $5, $3, $2}')
read -r mem_pct mem_used mem_total < <(free -m | awk '/Mem:/{printf "%d %d %d", $3*100/$2, $3, $2}')
load1=$(awk '{print $1}' /proc/loadavg)
cores=$(nproc)

bool() { [ "$1" -lt "$2" ] && echo true || echo false; }
disk_up=$(bool "$disk_pct" "$DISK_WARN")
mem_up=$(bool "$mem_pct" "$MEM_WARN")
load_up=$(awk -v l="$load1" -v c="$cores" 'BEGIN{print (l < c*2) ? "true" : "false"}')

payload=$(cat <<JSON
{"host":"$(hostname)","items":[
 {"id":"disk-root","name":"Disk /","kind":"Host metric","up":$disk_up,"detail":"${disk_pct}% used · ${disk_used}/${disk_total}"},
 {"id":"memory","name":"Memory","kind":"Host metric","up":$mem_up,"detail":"${mem_pct}% used · ${mem_used}/${mem_total} MB"},
 {"id":"load","name":"Load average","kind":"Host metric","up":$load_up,"detail":"${load1} over ${cores} cores"}
]}
JSON
)

curl -fsS -X POST "${ENDPOINT%/}/api/agents/vps" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$payload" > /dev/null
