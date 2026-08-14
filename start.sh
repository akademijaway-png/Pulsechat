#!/usr/bin/env bash
# PulseChat — one-command local run.
#   ./start.sh
# then open http://localhost:3000 in your browser (or on your phone via your
# machine's LAN IP). Two accounts are pre-made: alice / bob @pulsechat.test,
# password secret123. Or click "Create account".
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (one time)…"
  npm install --omit=dev
fi

echo ""
echo "  ⚡ PulseChat starting → http://localhost:3000"
echo "  New here? Tap \"Create account\" on the login screen (30 seconds)."
echo "  Stop with Ctrl+C"
echo ""
exec node server/index.js
