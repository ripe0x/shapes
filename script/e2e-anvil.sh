#!/usr/bin/env bash
# End-to-end check against a local Anvil chain: deploy, mint every denomination, read the
# onchain metadata, transfer, redeem, and confirm the ETH returned is exactly the ETH wrapped.
#
#   anvil &                       # in another shell
#   ./script/e2e-anvil.sh
set -euo pipefail

RPC=${RPC:-http://127.0.0.1:8545}
# Anvil's first two default accounts.
PK0=${PK0:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
ADDR0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ADDR1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
FEE_BPS=100 # 1% of backing, per token

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# bash integers are 64-bit signed; Shape denominations are not.
big() { python3 -c "import sys;print(eval(sys.argv[1]))" "$1"; }

# cast send returns before its transaction is reliably mined on this toolchain, so tightly
# sequenced sends race and silently drop. Submit, then block on the receipt so only one tx is ever
# in flight. Echoes the mined tx hash.
#
# --gas-limit is explicit because bare eth_estimateGas under-estimates every nonReentrant function:
# the reentrancy guard's SSTORE reset earns a gas refund that is only credited at the end of the
# transaction, so the estimate (which nets out the refund) is a touch below the gas the execution
# actually needs mid-flight, and the tx reverts out of gas at the guard cleanup. Wallets add a
# buffer for exactly this; scripts and programmatic callers must too.
send_wait() {
  local hash
  hash=$(cast send --gas-limit 600000 "$@" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")
  for _ in $(seq 1 100); do
    cast receipt "$hash" --rpc-url "$RPC" >/dev/null 2>&1 && { echo "$hash"; return 0; }
  done
  echo "  FAIL: tx $hash was not mined" >&2; exit 1
}

say "Deploying"
OUT=$(forge script script/DeployShapes.s.sol --rpc-url "$RPC" --private-key "$PK0" --broadcast 2>&1)
SHAPES=$(echo "$OUT" | grep -oE 'Shapes\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
RENDERER=$(echo "$OUT" | grep -oE 'ShapeRenderer\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
echo "  Shapes        $SHAPES"
echo "  ShapeRenderer $RENDERER"

say "Rejecting a plain ETH transfer"
if cast send "$SHAPES" --value 1ether --private-key "$PK0" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "  FAIL: direct transfer was accepted"; exit 1
else
  echo "  ok: reverted"
fi

say "Rejecting an unsupported denomination (2 ETH)"
if cast send "$SHAPES" "mint(uint256,address)" 2000000000000000000 "$ADDR0" \
     --value "$(big "2000000000000000000 + 2000000000000000000*$FEE_BPS//10000")wei" --private-key "$PK0" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "  FAIL: 2 ETH was accepted"; exit 1
else
  echo "  ok: reverted"
fi

say "Minting all nine denominations"
DENOMS=(10000000000000000 50000000000000000 100000000000000000 500000000000000000 \
        1000000000000000000 5000000000000000000 10000000000000000000 50000000000000000000 \
        100000000000000000000)
for d in "${DENOMS[@]}"; do
  send_wait "$SHAPES" "mint(uint256,address)" "$d" "$ADDR0" \
    --value "$(big "$d + $d*$FEE_BPS//10000")wei" --private-key "$PK0" --rpc-url "$RPC" >/dev/null
  printf '  minted %s wei\n' "$d"
done

TOTAL=$(cast call "$SHAPES" "redeemableBacking()(uint256)" --rpc-url "$RPC")
BAL=$(cast balance "$SHAPES" --rpc-url "$RPC")
echo "  redeemableBacking $TOTAL"
echo "  contract balance  $BAL"
[ "${TOTAL%% *}" = "$BAL" ] && echo "  ok: balance == redeemableBacking" || { echo "  FAIL"; exit 1; }

# Tokens are minted 1..9 in denomination order, so 1 ETH (the fifth denomination) is token 5.
ETH1_ID=5

say "Reading fully onchain metadata for token $ETH1_ID (1 ETH)"
URI=$(cast call "$SHAPES" "tokenURI(uint256)(string)" "$ETH1_ID" --rpc-url "$RPC")
JSON=$(echo "$URI" | sed -E 's/^"?data:application\/json;base64,//; s/"$//' | base64 -d 2>/dev/null)
echo "$JSON" | head -c 120; echo " ..."
echo "$JSON" | grep -q '"trait_type":"Ink"' && echo "  ok: Ink trait present" || { echo "  FAIL: no Ink trait in metadata"; exit 1; }

say "Transferring token $ETH1_ID to a second account"
send_wait "$SHAPES" "transferFrom(address,address,uint256)" "$ADDR0" "$ADDR1" "$ETH1_ID" \
  --private-key "$PK0" --rpc-url "$RPC" >/dev/null
cast call "$SHAPES" "ownerOf(uint256)(address)" "$ETH1_ID" --rpc-url "$RPC"

say "Original owner can no longer redeem it"
if cast send "$SHAPES" "redeem(uint256)" "$ETH1_ID" --private-key "$PK0" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "  FAIL: non-owner redeemed"; exit 1
else
  echo "  ok: reverted"
fi

say "New owner redeems and receives exactly 1 ETH"
PK1=${PK1:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}
BEFORE=$(cast balance "$ADDR1" --rpc-url "$RPC")
HASH=$(send_wait "$SHAPES" "redeem(uint256)" "$ETH1_ID" --private-key "$PK1" --rpc-url "$RPC")
RECEIPT=$(cast receipt "$HASH" --rpc-url "$RPC" --json)
GAS_USED=$(echo "$RECEIPT" | python3 -c "import json,sys;print(int(json.load(sys.stdin)['gasUsed'],16))")
GAS_PRICE=$(echo "$RECEIPT" | python3 -c "import json,sys;print(int(json.load(sys.stdin)['effectiveGasPrice'],16))")
AFTER=$(cast balance "$ADDR1" --rpc-url "$RPC")
# credit back the gas the redeemer spent, so the delta is the payout alone
DELTA=$(big "$AFTER - $BEFORE + $GAS_USED * $GAS_PRICE")
echo "  received $DELTA wei"
[ "$DELTA" = "1000000000000000000" ] && echo "  ok: exactly the wrapped amount" || { echo "  FAIL"; exit 1; }

say "Redeeming the rest"
# Every token except the 1 ETH one, which was already redeemed above.
REST=""
for t in 1 2 3 4 5 6 7 8 9; do [ "$t" = "$ETH1_ID" ] && continue; REST="$REST,$t"; done
REST="[${REST#,}]"
send_wait "$SHAPES" "redeemBatch(uint256[])" "$REST" \
  --private-key "$PK0" --rpc-url "$RPC" >/dev/null
FINAL_BACKING=$(cast call "$SHAPES" "redeemableBacking()(uint256)" --rpc-url "$RPC")
FINAL_BAL=$(cast balance "$SHAPES" --rpc-url "$RPC")
echo "  redeemableBacking $FINAL_BACKING"
echo "  contract balance  $FINAL_BAL"
[ "${FINAL_BACKING%% *}" = "0" ] && [ "$FINAL_BAL" = "0" ] \
  && echo "  ok: reserve fully unwound" || { echo "  FAIL"; exit 1; }

say "All end-to-end checks passed."
