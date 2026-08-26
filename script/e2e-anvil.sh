#!/usr/bin/env bash
# End-to-end check against a local Anvil chain: deploy, mint every denomination, read the
# onchain metadata, transfer, redeem, confirm the ETH returned is exactly the ETH wrapped, then
# run a full auction: open, bid, settle, and both pulls.
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
fail() { echo "  FAIL: $*" >&2; exit 1; }
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
# GAS may be raised per call: the auction's ETH bid path mints a card set inside the bid and
# needs more than the default.
send_wait() {
  local hash
  hash=$(cast send --gas-limit "${GAS:-600000}" "$@" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['transactionHash'])")
  for _ in $(seq 1 100); do
    cast receipt "$hash" --rpc-url "$RPC" >/dev/null 2>&1 && { echo "$hash"; return 0; }
  done
  echo "  FAIL: tx $hash was not mined" >&2; exit 1
}

say "Deploying"
OUT=$(forge script script/DeployShapes.s.sol --rpc-url "$RPC" --private-key "$PK0" --broadcast 2>&1) \
  || { echo "$OUT" >&2; fail "deployment reverted"; }
SHAPES=$(echo "$OUT" | grep -oE 'Shapes\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}') \
  || { echo "$OUT" >&2; fail "no Shapes address in the deploy output"; }
RENDERER=$(echo "$OUT" | grep -oE 'ShapeRenderer\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
HOUSE=$(echo "$OUT" | grep -oE 'AuctionHouse\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
echo "  Shapes        $SHAPES"
echo "  ShapeRenderer $RENDERER"
echo "  AuctionHouse  $HOUSE"

say "Signing the deployment as artist"
RELEASE_HASH=$(cast keccak "shapes-e2e-release")
DIGEST=$(cast call "$SHAPES" "artistAttestationDigest(bytes32)(bytes32)" "$RELEASE_HASH" --rpc-url "$RPC")
SIGNATURE=$(cast wallet sign --no-hash "$DIGEST" --private-key "$PK0")
send_wait "$SHAPES" "attestArtist(bytes32,bytes)" "$RELEASE_HASH" "$SIGNATURE" \
  --private-key "$PK0" --rpc-url "$RPC" >/dev/null
[ "$(cast call "$SHAPES" "artistReleaseHash()(bytes32)" --rpc-url "$RPC")" = "$RELEASE_HASH" ] \
  || fail "artist release hash mismatch"
[ "$(cast call "$SHAPES" "artistSignature()(bytes)" --rpc-url "$RPC")" = "$SIGNATURE" ] \
  || fail "artist signature was not stored"
echo "  ok: artist signature stored and bound to this deployment"

say "Rejecting a plain ETH transfer"
if cast send "$SHAPES" --value 1ether --private-key "$PK0" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "  FAIL: direct transfer was accepted"; exit 1
else
  echo "  ok: reverted"
fi

say "Rejecting an unsupported denomination (2 ETH)"
if cast send "$SHAPES" "mint(uint256)" 2000000000000000000 \
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
  send_wait "$SHAPES" "mint(uint256)" "$d" \
    --value "$(big "$d + $d*$FEE_BPS//10000")wei" --private-key "$PK0" --rpc-url "$RPC" >/dev/null
  printf '  minted %s wei\n' "$d"
done

TOTAL=$(cast call "$SHAPES" "redeemableBacking()(uint256)" --rpc-url "$RPC")
BAL=$(cast balance "$SHAPES" --rpc-url "$RPC")
echo "  redeemableBacking $TOTAL"
echo "  contract balance  $BAL"
[ "${TOTAL%% *}" = "$BAL" ] && echo "  ok: balance == redeemableBacking" || { echo "  FAIL"; exit 1; }

# Backed Shape #0 is minted at deploy. The nine public mints are therefore ids 1..9 in
# denomination order, so 1 ETH (the fifth denomination) is token 5.
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
# Shape #0 plus every public mint except the 1 ETH one, which was already redeemed above.
REST=""
for t in 0 1 2 3 4 5 6 7 8 9; do [ "$t" = "$ETH1_ID" ] && continue; REST="$REST,$t"; done
REST="[${REST#,}]"
send_wait "$SHAPES" "redeemBatch(uint256[])" "$REST" \
  --private-key "$PK0" --rpc-url "$RPC" >/dev/null
FINAL_BACKING=$(cast call "$SHAPES" "redeemableBacking()(uint256)" --rpc-url "$RPC")
FINAL_BAL=$(cast balance "$SHAPES" --rpc-url "$RPC")
echo "  redeemableBacking $FINAL_BACKING"
echo "  contract balance  $FINAL_BAL"
[ "${FINAL_BACKING%% *}" = "0" ] && [ "$FINAL_BAL" = "0" ] \
  && echo "  ok: reserve fully unwound" || { echo "  FAIL"; exit 1; }

# ---------------------------------------------------------------------------------------------
# The auction house. Mints its own lot, so nothing here depends on what the redemption left.
# ---------------------------------------------------------------------------------------------

say "Opening an auction"
send_wait "$SHAPES" "mint(uint256)" 100000000000000000 \
  --value "$(big "100000000000000000 + 100000000000000000*$FEE_BPS//10000")wei" \
  --private-key "$PK0" --rpc-url "$RPC" >/dev/null
LOT=$(($(cast call "$SHAPES" "totalMinted()(uint256)" --rpc-url "$RPC" | awk '{print $1}') - 1))
send_wait "$SHAPES" "setApprovalForAll(address,bool)" "$HOUSE" true \
  --private-key "$PK0" --rpc-url "$RPC" >/dev/null
# createAuction(nft, tokenId, duration, reserveUnits, minIncrementBps, extensionWindow)
send_wait "$HOUSE" "createAuction(address,uint256,uint64,uint64,uint16,uint32)" \
  "$SHAPES" "$LOT" 86400 1 500 900 --private-key "$PK0" --rpc-url "$RPC" >/dev/null
[ "$(cast call "$SHAPES" "ownerOf(uint256)(address)" "$LOT" --rpc-url "$RPC")" = "$HOUSE" ] \
  && echo "  ok: lot $LOT escrowed" || fail "lot was not escrowed"
[ "$(cast call "$HOUSE" "hasAuctionFor(address,uint256)(bool)" "$SHAPES" "$LOT" --rpc-url "$RPC")" = "true" ] \
  && echo "  ok: indexed against its collection" || fail "lot is not indexed"

say "Bidding 1 ETH through the ETH path"
# The bidder brings no Shapes; the house mints the minimal card set and charges the mint fee on top.
GAS=3000000 send_wait "$HOUSE" "bid(uint256,uint256[],uint256)" 0 "[]" 1000000000000000000 \
  --value "$(big "1000000000000000000 + 1000000000000000000*$FEE_BPS//10000")wei" \
  --private-key "$PK1" --rpc-url "$RPC" >/dev/null
UNITS=$(cast call "$HOUSE" "bidUnits(uint256,address)(uint64)" 0 "$ADDR1" --rpc-url "$RPC" | awk '{print $1}')
[ "$UNITS" = "100" ] && echo "  ok: 100 units escrowed (1 ETH)" || fail "bid units were $UNITS, expected 100"

say "The seller cannot bid its own lot"
if cast send "$HOUSE" "bid(uint256,uint256[],uint256)" 0 "[]" 2000000000000000000 \
     --value "$(big "2000000000000000000 + 2000000000000000000*$FEE_BPS//10000")wei" \
     --private-key "$PK0" --rpc-url "$RPC" >/dev/null 2>&1; then
  fail "the seller bid its own auction"
else
  echo "  ok: reverted"
fi

say "Settling"
cast rpc anvil_increaseTime 90000 --rpc-url "$RPC" >/dev/null
cast rpc anvil_mine 1 --rpc-url "$RPC" >/dev/null
send_wait "$HOUSE" "settle(uint256)" 0 --private-key "$PK0" --rpc-url "$RPC" >/dev/null
# Settlement records the outcome and moves nothing, so a lot that cannot be transferred cannot
# hold the outcome, the seller's proceeds, or a losing bidder's escrow hostage.
[ "$(cast call "$SHAPES" "ownerOf(uint256)(address)" "$LOT" --rpc-url "$RPC")" = "$HOUSE" ] \
  && echo "  ok: settlement delivered nothing; the lot is still escrowed" \
  || fail "settlement moved the lot"

say "The seller cannot take a lot that sold"
if cast send "$HOUSE" "claimLot(uint256)" 0 --private-key "$PK0" --rpc-url "$RPC" >/dev/null 2>&1; then
  fail "the seller claimed a sold lot"
else
  echo "  ok: reverted"
fi

say "The winner pulls the lot, the seller pulls the bid"
send_wait "$HOUSE" "claimLot(uint256)" 0 --private-key "$PK1" --rpc-url "$RPC" >/dev/null
[ "$(cast call "$SHAPES" "ownerOf(uint256)(address)" "$LOT" --rpc-url "$RPC")" = "$ADDR1" ] \
  && echo "  ok: lot delivered to the winner" || fail "the winner did not receive the lot"
[ "$(cast call "$HOUSE" "hasAuctionFor(address,uint256)(bool)" "$SHAPES" "$LOT" --rpc-url "$RPC")" = "false" ] \
  && echo "  ok: the token index cleared, so it can be listed again" || fail "index was not cleared"

send_wait "$HOUSE" "claimProceeds(uint256)" 0 --private-key "$PK0" --rpc-url "$RPC" >/dev/null
HOUSE_SHAPES=$(cast call "$SHAPES" "balanceOf(address)(uint256)" "$HOUSE" --rpc-url "$RPC" | awk '{print $1}')
HOUSE_ETH=$(cast balance "$HOUSE" --rpc-url "$RPC")
echo "  house holds $HOUSE_SHAPES Shapes and $HOUSE_ETH wei"
[ "$HOUSE_SHAPES" = "0" ] && [ "$HOUSE_ETH" = "0" ] \
  && echo "  ok: the house drained completely" || fail "the house retained something"

say "All end-to-end checks passed."
