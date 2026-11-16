#!/usr/bin/env bash
# Clinical Audit Syria — quick start (development / single-server)
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "→ Installing dependencies…"
  npm install --omit=dev
fi

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

export PORT="${PORT:-8080}"
export HTTPS_PORT="${HTTPS_PORT:-8443}"

echo "→ Starting Clinical Audit Syria on http://0.0.0.0:${PORT} (HTTPS :${HTTPS_PORT})"
exec node server.js
