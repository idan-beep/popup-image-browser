#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

(sleep 1 && open "http://127.0.0.1:5177") &
exec node server.js
