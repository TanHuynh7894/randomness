#!/usr/bin/env bash
# Local dashboard: starts a chain, deploys everything, seeds some history, then keeps rolling so the page stays live.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8603}"
DASHBOARD_PORT="${DASHBOARD_PORT:-5173}"
RPC_URL="http://127.0.0.1:$PORT"
# Public anvil test accounts. Never use these anywhere else.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ALICE=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
BOB=0x90F79bf6EB2c4f870365E785982E1f101E93b906
export ORACLE_TX_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
ORACLE_OPERATOR=$(cast wallet address "$ORACLE_TX_KEY")
export ORACLE_OPERATOR ORACLE_FEE=10000000000000000
export RPC_URL POLL_MS=500
BOND=100000000000000000

cleanup() { kill ${VITE_PID:-} ${TRAFFIC_PID:-} ${NODE_PID:-} ${ANVIL_PID:-} 2>/dev/null || true; }
trap cleanup EXIT

# FORK=fuji runs on a local copy of Fuji: same chain ID and state, free dev accounts, nothing sent to Fuji itself.
FORK_ARGS=()
if [ "${FORK:-}" = fuji ]; then FORK_ARGS=(--fork-url "${FUJI_RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"); fi
# Mines on every transaction while seeding, so the seed takes seconds. Interval mining starts before the node does.
anvil --port "$PORT" --silent ${FORK_ARGS[@]+"${FORK_ARGS[@]}"} &
ANVIL_PID=$!
until cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; do sleep 0.1; done
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")

(cd node && [ -d node_modules ] || npm ci --silent)
(cd dashboard && [ -d node_modules ] || npm ci --silent)
eval "$(cd node && npx tsx src/keygen.ts | sed 's/^/export /')"

deployer() { cast send --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" "$@" >/dev/null; }
as() { local who=$1; shift; cast send --rpc-url "$RPC_URL" --unlocked --from "$who" "$@" >/dev/null; }

OUTPUT=$(forge script script/DeployOracle.s.sol --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast 2>&1)
ORACLE_ADDRESS=$(echo "$OUTPUT" | sed -n 's/.*ORACLE_ADDRESS=//p' | head -1)
export ORACLE_ADDRESS
DICE=$(echo "$OUTPUT" | sed -n 's/.*DICE_ADDRESS=//p' | head -1)
BEACON=$(forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast 2>&1 \
  | sed -n 's/.*RandomnessBeacon: *//p' | head -1)
echo "oracle $ORACLE_ADDRESS"
echo "dice   $DICE"
echo "beacon $BEACON"

# A roll nobody answered: it goes past the 256-block window and is refunded.
deployer --value "$ORACLE_FEE" "$DICE" 'roll()'
cast rpc --rpc-url "$RPC_URL" anvil_mine 0x101 >/dev/null
deployer "$DICE" 'refund(uint256)' 1

secret() { cast to-uint256 "$1"; }
commitment() { # round, participant, secret number
  cast keccak "$(cast abi-encode 'f(uint256,address,uint256,address,bytes32)' "$CHAIN_ID" "$BEACON" "$1" "$2" "$(secret "$3")")"
}
create_round() { deployer "$BEACON" 'createRound(uint64,uint64,uint256,uint32)' "$1" "$2" "$BOND" 2; }
commit() { as "$2" --value "$BOND" "$BEACON" 'commit(uint256,bytes32)' "$1" "$(commitment "$1" "$2" "$3")"; }
reveal() { as "$2" "$BEACON" 'reveal(uint256,bytes32)' "$1" "$(secret "$3")"; }
finalize() { deployer "$BEACON" 'finalize(uint256)' "$1"; }
jump() { cast rpc --rpc-url "$RPC_URL" evm_increaseTime "$1" >/dev/null; cast rpc --rpc-url "$RPC_URL" evm_mine >/dev/null; }

# Round 0: everyone reveals. Round 1: Bob withholds. Round 2: too few people.
for round in 0 1 2; do create_round 60 60; done
commit 0 "$ALICE" 1; commit 0 "$BOB" 2
commit 1 "$ALICE" 3; commit 1 "$BOB" 4
commit 2 "$ALICE" 5
jump 61
reveal 0 "$ALICE" 1; reveal 0 "$BOB" 2
reveal 1 "$ALICE" 3
reveal 2 "$ALICE" 5
finalize 0; finalize 2
jump 61
finalize 1
# Round 3 is in its reveal phase and round 4 in its commit phase while you watch.
create_round 30 1800
commit 3 "$ALICE" 6; commit 3 "$BOB" 7
jump 31
reveal 3 "$ALICE" 6
create_round 1800 1800
commit 4 "$BOB" 8

for _ in 1 2 3 4 5 6 7 8; do deployer --value "$ORACLE_FEE" "$DICE" 'roll()'; done

cast rpc --rpc-url "$RPC_URL" evm_setIntervalMining 1 >/dev/null
(cd node && exec npx tsx src/main.ts) &
NODE_PID=$!

(
  while sleep $((RANDOM % 6 + 3)); do deployer --value "$ORACLE_FEE" "$DICE" 'roll()' || true; done
) &
TRAFFIC_PID=$!

(
  cd dashboard
  VITE_LOCAL_FORK=$([ -n "${FORK:-}" ] && echo 1 || echo 0) VITE_RPC_URL="$RPC_URL" VITE_ORACLE_ADDRESS="$ORACLE_ADDRESS" VITE_DICE_ADDRESS="$DICE" VITE_BEACON_ADDRESS="$BEACON" \
    exec node_modules/.bin/vite --port "$DASHBOARD_PORT" --strictPort
) &
VITE_PID=$!
wait "$VITE_PID"
