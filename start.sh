#!/usr/bin/env sh
# Mizan — build (first run) and start the server for this computer and the local network.
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
[ -f apps/web/dist/index.html ] && [ -f apps/server/dist/main.js ] || npm run build
npm start
