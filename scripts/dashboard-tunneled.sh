#!/usr/bin/env bash
# scripts/dashboard-tunneled.sh — run the dashboard fronted by an anonymous
# Cloudflare quick tunnel (https://*.trycloudflare.com).
#
# Use when the operator's phone can't reach the laptop's LAN IP — common
# when the laptop has only a CGNAT/Tailscale interface, or when the phone
# is on a different WiFi.
#
# Requires: brew install cloudflared
#
# Notes:
# - The quick-tunnel URL is fresh on every run (anonymous, no Cloudflare
#   account). The QR in the dashboard's Capture modal will encode it.
# - `--config /dev/null --origincert /dev/null` prevents cloudflared from
#   accidentally picking up a pre-existing named-tunnel cred-file in
#   ~/.cloudflared/ — that mix produces 404s from Cloudflare's edge.
# - Ctrl+C kills both the dashboard and the tunnel.

set -euo pipefail

TUNNEL_LOG="$(mktemp -t hr-dashboard-tunnel-XXXXXX.log)"
echo "[tunnel] log: $TUNNEL_LOG" >&2

cloudflared tunnel \
  --no-autoupdate \
  --config /dev/null \
  --origincert /dev/null \
  --url http://localhost:3838 \
  > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

cleanup() {
  echo "[tunnel] stopping (pid=$TUNNEL_PID)" >&2
  kill "$TUNNEL_PID" 2>/dev/null || true
  wait "$TUNNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[tunnel] starting cloudflared (pid=$TUNNEL_PID)…" >&2
DEADLINE=$(( $(date +%s) + 30 ))
PUBLIC_URL=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  PUBLIC_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" | head -1 || true)
  if [ -n "$PUBLIC_URL" ]; then break; fi
  sleep 1
done

if [ -z "$PUBLIC_URL" ]; then
  echo "[tunnel] FAILED to obtain a public URL within 30s. Last log:" >&2
  tail -20 "$TUNNEL_LOG" >&2
  exit 1
fi

echo "" >&2
echo "[tunnel] public URL: $PUBLIC_URL" >&2
echo "[tunnel] (the QR in the dashboard's Capture modal will encode this)" >&2
echo "" >&2

# Cloudflare's edge sometimes takes a few seconds to publish DNS for a
# fresh quick tunnel. Sleep briefly so the first phone visit doesn't 404.
sleep 5

CAPTURE_PUBLIC_URL="$PUBLIC_URL" exec npm run dashboard
