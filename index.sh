#!/usr/bin/env sh
# Big Pickle launcher — Linux/macOS entrypoint
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it (https://nodejs.org) and re-run."
  exit 1
fi
exec node index.js "$@"