#!/bin/bash
set -e

# Your private instance repo (this dir) + your clone of the public Daemon framework
DAEMON_FRAMEWORK="${HOME}/Projects/daemon"
DAEMON_DATA="$(cd "$(dirname "$0")" && pwd)"

echo "Running DeployGate (TTL + location + credential checks)..."
bun "$DAEMON_DATA/DeployGate.ts"

echo "Deploying daemon..."
cp "$DAEMON_DATA/daemon-data.json" "$DAEMON_FRAMEWORK/cms/public/daemon-data.json"
cd "$DAEMON_FRAMEWORK" && bun run build
bunx wrangler deploy

# Never leave personal data in the public framework working dir
rm -f "$DAEMON_FRAMEWORK/cms/public/daemon-data.json"

echo "Deploy complete."
