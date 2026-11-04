#!/bin/sh
# Reports ggss-nas (QNAP TS-531P) health to the status dashboard as the remote
# agent "ggss-nas". Run once a minute as root from /etc/config/crontab. QTS ships
# BusyBox 1.24 and curl, and this script needs nothing else.
#
# What it checks, and why:
#   - pihole-dns        Pi-hole (192.168.50.2) answers a real DNS query. LAN
#                       clients depend on it, so this is the user-facing check.
#   - pihole-container  The pihole container is running and Docker reports it healthy.
#   - docker            The Container Station dockerd answers. When it is down,
#                       every container on the NAS is down.
#   - pool-usage        Thin pool data usage. Snapshots live in the same pool, so
#                       at ~99% QTS switches the volume to "privileged mode"
#                       (unlink/discard only), even though df still shows free space.
#   - volume-writable   Writes and removes a probe file on the data volume. This
#                       catches privileged/read-only mode directly.
#
# If the NAS or this cron job stops, the dashboard marks every item down after
# 3 missed intervals ("Agent has not checked in").
#
# Config: /share/CACHEDEV1_DATA/.sky-status/env (root-only), containing
#   AGENT_INGEST_TOKEN=...
#   STATUS_ENDPOINT=https://status.skyhong.tw   (optional)

PATH=/share/CACHEDEV1_DATA/.qpkg/container-station/bin:/sbin:/bin:/usr/sbin:/usr/bin:$PATH
BASE="${SKY_STATUS_DIR:-/share/CACHEDEV1_DATA/.sky-status}"
[ -r "$BASE/env" ] && . "$BASE/env"
ENDPOINT="${STATUS_ENDPOINT:-https://status.skyhong.tw}"
TOKEN="${AGENT_INGEST_TOKEN:?AGENT_INGEST_TOKEN required}"
PIHOLE_IP="${PIHOLE_IP:-192.168.50.2}"
DNS_PROBE_NAME="${DNS_PROBE_NAME:-github.com}"
POOL_LV="${POOL_LV:-vg1/tp1}"
POOL_WARN="${POOL_WARN_PERCENT:-90}"
DOCKER_SOCK="${DOCKER_SOCK:-unix:///var/run/docker.sock}"

# QTS busybox 1.24 takes "timeout -t SECS"; Container Station's 1.33 (earlier
# on PATH) takes "timeout SECS". Pin the system one and detect its syntax.
BB=/bin/busybox
if $BB timeout -t 1 true 2>/dev/null; then to() { s=$1; shift; $BB timeout -t "$s" "$@"; }
else to() { s=$1; shift; $BB timeout "$s" "$@"; }; fi

# Never let two runs overlap when a probe hangs.
exec 9>"/tmp/ggss-nas-reporter.lock"
$BB flock -n 9 || exit 0

items=""
add() { # id name kind up detail
  detail=$(printf '%s' "$5" | tr -d '"\\' | tr '\n\t' '  ' | cut -c1-190)
  items="${items}${items:+,}{\"id\":\"$1\",\"name\":\"$2\",\"kind\":\"$3\",\"up\":$4,\"detail\":\"$detail\"}"
}

# Pi-hole DNS: the answer must contain an address for the probe name.
if out=$(to 5 nslookup "$DNS_PROBE_NAME" "$PIHOLE_IP" 2>&1) \
    && printf '%s' "$out" | sed -n "/^Name:/,\$p" | grep -q -E '^Address'; then
  add pihole-dns "Pi-hole DNS" "DNS" true "Resolved $DNS_PROBE_NAME via $PIHOLE_IP"
else
  add pihole-dns "Pi-hole DNS" "DNS" false "No answer for $DNS_PROBE_NAME from $PIHOLE_IP"
fi

# Container Station dockerd, and the pihole container's health.
if to 10 docker -H "$DOCKER_SOCK" version --format '{{.Server.Version}}' >/tmp/ggss-nas-docker.out 2>/dev/null; then
  add docker "Container Station Docker" "Process" true "dockerd $(cat /tmp/ggss-nas-docker.out)"
  health=$(to 10 docker -H "$DOCKER_SOCK" inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' pihole 2>/dev/null)
  case "$health" in
    running/healthy) add pihole-container "Pi-hole container" "Docker" true "Running · healthy" ;;
    "") add pihole-container "Pi-hole container" "Docker" false "Container not found" ;;
    *) add pihole-container "Pi-hole container" "Docker" false "State $health" ;;
  esac
else
  add docker "Container Station Docker" "Process" false "dockerd not answering on $DOCKER_SOCK"
  add pihole-container "Pi-hole container" "Docker" false "Unknown · dockerd down"
fi
rm -f /tmp/ggss-nas-docker.out

# Thin pool usage, which is what actually runs out (volume df does not show it).
pool=$(lvs --noheadings -o data_percent "$POOL_LV" 2>/dev/null | tr -d ' ')
if [ -n "$pool" ]; then
  up=$(awk -v p="$pool" -v w="$POOL_WARN" 'BEGIN{print (p < w) ? "true" : "false"}')
  add pool-usage "Storage pool" "Host metric" "$up" "${pool}% used (warn at ${POOL_WARN}%; QTS locks the volume near 99%)"
else
  add pool-usage "Storage pool" "Host metric" false "Could not read $POOL_LV usage"
fi

# Data volume writability: catches QTS privileged/read-only mode.
probe="$BASE/.write-probe"
if (echo "$$" >"$probe") 2>/dev/null && rm -f "$probe" 2>/dev/null; then
  add volume-writable "Data volume writable" "Host metric" true "Write probe ok"
else
  add volume-writable "Data volume writable" "Host metric" false "Write probe failed · volume read-only or privileged mode"
fi

payload="{\"host\":\"ggss-nas\",\"items\":[${items}]}"
curl -fsS -m 20 -X POST "$ENDPOINT/api/agents/ggss-nas" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -A 'sky-status-agent/ggss-nas' --data "$payload" >/dev/null
