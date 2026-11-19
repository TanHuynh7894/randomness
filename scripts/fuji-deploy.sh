#!/usr/bin/env bash
# Deploys the oracle, the dice example and the beacon to Fuji, then points the dashboard at them.
# Needs .env with the BLS key (npm run keygen in node/) and FUJI_KEY, a wallet holding test AVAX.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC_URL="${RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"
set -a; source .env; set +a
: "${FUJI_KEY:?add FUJI_KEY to .env}" "${ORACLE_BLS_KEY:?run npm run keygen in node/ first}"

FROM=$(cast wallet address "$FUJI_KEY")
[ "$(cast chain-id --rpc-url "$RPC_URL")" = 43113 ] || { echo "RPC is not Fuji"; exit 1; }
echo "deployer $FROM, balance $(cast balance --ether "$FROM" --rpc-url "$RPC_URL") AVAX"

export ORACLE_OPERATOR="${ORACLE_OPERATOR:-$FROM}" ORACLE_FEE="${ORACLE_FEE:-10000000000000000}"
OUT=$(forge script script/DeployOracle.s.sol --rpc-url "$RPC_URL" --private-key "$FUJI_KEY" --broadcast 2>&1)
ORACLE=$(echo "$OUT" | sed -n 's/.*ORACLE_ADDRESS=//p' | head -1)
DICE=$(echo "$OUT" | sed -n 's/.*DICE_ADDRESS=//p' | head -1)
BEACON=$(forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --private-key "$FUJI_KEY" --broadcast 2>&1 \
  | sed -n 's/.*RandomnessBeacon: *//p' | head -1)
[ -n "$ORACLE" ] && [ -n "$DICE" ] && [ -n "$BEACON" ] || { echo "$OUT"; exit 1; }

# Keep the addresses next to the keys, replacing an earlier deployment.
sed -i.bak '/^FUJI_ORACLE=/d; /^FUJI_DICE=/d; /^FUJI_BEACON=/d' .env && rm -f .env.bak
printf 'FUJI_ORACLE=%s\nFUJI_DICE=%s\nFUJI_BEACON=%s\n' "$ORACLE" "$DICE" "$BEACON" >> .env
cat > dashboard/.env.local <<EOF
VITE_RPC_URL=$RPC_URL
VITE_ORACLE_ADDRESS=$ORACLE
VITE_DICE_ADDRESS=$DICE
VITE_BEACON_ADDRESS=$BEACON
EOF

echo "oracle $ORACLE"
echo "dice   $DICE"
echo "beacon $BEACON"
echo "https://testnet.snowtrace.io/address/$ORACLE"
echo "next: ./scripts/fuji-node.sh, then (cd dashboard && npm run dev)"
