#!/usr/bin/env bash
# Deploy Clinical Audit Syria on a public VPS with nginx + Let's Encrypt + systemd.
# Usage: sudo bash deploy/setup-vps.sh <domain> <email>
#   e.g. sudo bash deploy/setup-vps.sh app.clinicalaudit-syria.org you@example.com
set -euo pipefail
DOMAIN="${1:?domain required}"
EMAIL="${2:?email required for certbot}"
APP_DIR="/opt/clinicalaudit-syria"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)."; exit 1; }

echo "==> Installing packages"
apt-get update -y
apt-get install -y nodejs npm nginx certbot python3-certbot-nginx rsync

echo "==> Copying app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --exclude node_modules --exclude .git "$SRC/" "$APP_DIR/"

echo "==> Installing dependencies"
cd "$APP_DIR"
npm install --omit=dev

echo "==> Preparing .env (edit secrets after)"
[ -f .env ] || cp .env.example .env
sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" .env

echo "==> Installing systemd unit"
sed "s#/opt/clinicalaudit-syria#$APP_DIR#g" deploy/clinicalaudit.service > /etc/systemd/system/clinicalaudit.service
systemctl daemon-reload
systemctl enable --now clinicalaudit

echo "==> Configuring nginx"
sed "s#server_name _;#server_name $DOMAIN;#" deploy/nginx.conf > /etc/nginx/sites-available/clinicalaudit
ln -sf /etc/nginx/sites-available/clinicalaudit /etc/nginx/sites-enabled/clinicalaudit
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Issuing TLS certificate"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || true

echo "==> Done: https://$DOMAIN"
