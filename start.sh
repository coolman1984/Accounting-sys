#!/usr/bin/env sh
# Mizan — build and start the server for this computer and the local network.
# It builds on every start, so code pulled since the last run is never served from an old build.
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
npm run build
npm start
