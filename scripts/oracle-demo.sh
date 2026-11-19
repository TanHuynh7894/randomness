#!/usr/bin/env bash
# Local demo: starts a chain, deploys the oracle and the dice, runs the node and rolls.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8601}"
RPC_URL="http://127.0.0.1:$PORT"
# Public anvil test accounts. Never use these anywhere else.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export ORACLE_TX_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
export ORACLE_OPERATOR=$(cast wallet address "$ORACLE_TX_KEY")
export ORACLE_FEE=10000000000000000
export RPC_URL POLL_MS=300

cleanup() { kill ${NODE_PID:-} ${ANVIL_PID:-} 2>/dev/null || true; }
trap cleanup EXIT

anvil --port "$PORT" --block-time 1 --silent &
ANVIL_PID=$!
until cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; do sleep 0.1; done

(cd node && [ -d node_modules ] || npm ci --silent)
eval "$(cd node && npx tsx src/keygen.ts | sed 's/^/export /')"

OUTPUT=$(forge script script/DeployOracle.s.sol --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast 2>&1)
export ORACLE_ADDRESS=$(echo "$OUTPUT" | sed -n 's/.*ORACLE_ADDRESS=//p' | head -1)
DICE=$(echo "$OUTPUT" | sed -n 's/.*DICE_ADDRESS=//p' | head -1)
echo "oracle $ORACLE_ADDRESS"
echo "dice   $DICE"

(cd node && exec npx tsx src/main.ts) &
NODE_PID=$!

for i in 1 2 3; do
  cast send --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --value "$ORACLE_FEE" "$DICE" 'roll()' >/dev/null
  ID=$(cast call --rpc-url "$RPC_URL" "$ORACLE_ADDRESS" 'requestCount()(uint256)')
  echo "roll $i: request $ID sent"
  for _ in $(seq 1 60); do
    RESULT=$(cast call --rpc-url "$RPC_URL" "$DICE" 'rolls(uint256)(address,uint8,bool)' "$ID" | sed -n 2p)
    [ "$RESULT" != "0" ] && break
    sleep 0.5
  done
  [ "$RESULT" != "0" ] || { echo "no answer for request $ID"; exit 1; }
  echo "roll $i: result $RESULT"
done
