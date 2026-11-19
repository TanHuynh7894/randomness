#!/usr/bin/env bash
# Runs the oracle node against the Fuji deployment written to .env by fuji-deploy.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${FUJI_ORACLE:?run ./scripts/fuji-deploy.sh first}"
export RPC_URL="${RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"
export ORACLE_ADDRESS="$FUJI_ORACLE" ORACLE_TX_KEY="${ORACLE_TX_KEY:-$FUJI_KEY}"
cd node && exec npx tsx src/main.ts
