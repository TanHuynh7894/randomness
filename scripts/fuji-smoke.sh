#!/usr/bin/env bash
# Checks the contract code against the real Fuji EVM with eth_call. Sends nothing and needs no funds.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC_URL="${RPC_URL:-https://api.avax-test.network/ext/bc/C/rpc}"

forge build --quiet
read -r PK M HX HY SIG < <(python3 - <<'PY'
import json
d = json.load(open("test/fixtures/bls.json"))
v = [x for x in d["vectors"] if x["attempts"] > 0][0]
print("[" + ",".join(d["publicKey"]) + "]", v["message"], v["hx"], v["hy"], "[" + v["sigX"] + "," + v["sigY"] + "]")
PY
)
ARGS=$(cast abi-encode 'c(uint256[4],bytes32,uint256,uint256,uint256[2])' "$PK" "$M" "$HX" "$HY" "$SIG")
CODE=$(forge inspect script/FujiSmoke.sol:FujiSmoke bytecode)
CHAIN=$(cast chain-id --rpc-url "$RPC_URL")
OUT=$(cast call --rpc-url "$RPC_URL" --gas-limit 15000000 --create "$CODE${ARGS#0x}")
[ -n "$OUT" ] && echo "smoke test passed on chain $CHAIN"
