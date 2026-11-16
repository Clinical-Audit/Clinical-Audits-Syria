#!/usr/bin/env bash
# Permanent free HTTPS domain via Serveo: https://clinical-audit-syria.serveo.net
# Prereq: register this machine's SSH key once at the URL printed by:
#   ssh -R clinical-audit-syria:80:localhost:3000 serveo.net
set -euo pipefail
PORT="${PORT:-3000}"
NAME="${SERVEO_NAME:-clinical-audit-syria}"

echo "==> Opening Serveo tunnel: https://${NAME}.serveo.net -> localhost:${PORT}"
echo "    (Keep this process running, or run it under systemd/tmux.)"
exec ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  -R "${NAME}:80:localhost:${PORT}" serveo.net
