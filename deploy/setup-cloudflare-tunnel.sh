#!/usr/bin/env bash
# Permanent HTTPS domain via a named Cloudflare Tunnel.
# Usage: bash deploy/setup-cloudflare-tunnel.sh <root-domain> <public-hostname> [local-port]
#   e.g. bash deploy/setup-cloudflare-tunnel.sh clinicalaudit-syria.org app.clinicalaudit-syria.org 3000
# Prereq: `cloudflared tunnel login` (one-time browser login) and the root domain on Cloudflare.
set -euo pipefail
ROOT="${1:?root domain required, e.g. clinicalaudit-syria.org}"
HOST="${2:?public hostname required, e.g. app.clinicalaudit-syria.org}"
PORT="${3:-3000}"
NAME="clinical-audit-syria"

command -v cloudflared >/dev/null || { echo "cloudflared not installed"; exit 1; }
[ -f "$HOME/.cloudflared/cert.pem" ] || { echo "Run 'cloudflared tunnel login' first."; exit 1; }

echo "==> Creating tunnel: $NAME"
cloudflared tunnel create "$NAME" 2>/dev/null || echo "(tunnel may already exist)"

TID=$(cloudflared tunnel list --output json | python3 -c "import sys,json;print([t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'][0])")
echo "==> Tunnel id: $TID"

echo "==> Routing DNS: $HOST -> $NAME"
cloudflared tunnel route dns "$NAME" "$HOST" || true

mkdir -p "$HOME/.cloudflared"
cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: $TID
credentials-file: $HOME/.cloudflared/$TID.json
ingress:
  - hostname: $HOST
    service: http://localhost:$PORT
  - service: http_status:404
EOF

echo "==> Installing as systemd service"
sudo cloudflared service install 2>/dev/null || cloudflared service install 2>/dev/null || true
sudo systemctl enable --now cloudflared 2>/dev/null || true

echo "==> Done. Public URL: https://$HOST"
echo "    Set PUBLIC_URL=https://$HOST in .env and restart the app."
