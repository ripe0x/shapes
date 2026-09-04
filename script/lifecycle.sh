#!/usr/bin/env bash
# Walks every protocol entrypoint against an already-deployed Shapes system, asserting on-chain
# state around each call and rechecking the reserve invariant after every state change.
#
#   script/deploy.sh <env>          # deploy first; this script never deploys
#   script/lifecycle.sh <env>
#
# The environment is the same values file deploy.sh reads (script/env/<name>.env), so chain id,
# RPC default and wallet kind come from one place. Addresses come from
# deployments/<chainId>.json, written by deploy.sh.
#
# The run requires a freshly deployed system: it asserts `totalMinted() == 1` before it starts,
# because every later assertion is written against that starting state.
#
# Overrides:
#   RPC_URL                        RPC endpoint, overriding the env file default.
#   FOUNDRY_PROFILE                forge profile for the one contract this script deploys
#                                   (the positions resolver mock), overriding the env file default.
#   KEYSTORE_PASSWORD_FILE         keystore password file (chmod 600) instead of a prompt.
#   DEPLOYER_PRIVATE_KEY           anvil only: the deployer key, matching deploy.sh.
#   LIFECYCLE_PK1 / LIFECYCLE_PK2  off anvil: funded keys for the second and third wallets.
#   LIFECYCLE_APEX=0|1             run the apex Complete / burnBacking section. Defaults on for
#                                   anvil and off elsewhere: building an apex costs 10000 mints.
#   LIFECYCLE_INDEXER=0|1          run the indexer diff. Defaults on for anvil, off elsewhere.
#   LIFECYCLE_INDEXER_PORT         port for the indexer under test. Default 42069.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  anvil) ;;
  mainnet)
    echo "refusing: lifecycle.sh mints, composes, splits, redeems and burns. It is not a mainnet tool." >&2
    exit 1
    ;;
  *)
    echo "usage: script/lifecycle.sh <anvil>" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="script/env/${ENV_NAME}.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

RPC="${RPC_URL:-$RPC_DEFAULT}"
FOUNDRY_PROFILE="${FOUNDRY_PROFILE:-$FOUNDRY_PROFILE_DEFAULT}"
export FOUNDRY_PROFILE

for tool in cast jq python3; do
  command -v "$tool" >/dev/null || { echo "refusing: $tool is required" >&2; exit 1; }
done

ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$ACTUAL_CHAIN_ID" = "$CHAIN_ID" ] \
  || { echo "refusing: $RPC reports chain id $ACTUAL_CHAIN_ID, expected $CHAIN_ID" >&2; exit 1; }

DEPLOYMENT_FILE="deployments/${CHAIN_ID}.json"
[ -f "$DEPLOYMENT_FILE" ] || { echo "refusing: no $DEPLOYMENT_FILE; run script/deploy.sh $ENV_NAME first" >&2; exit 1; }

SHAPES=$(cast --to-checksum-address "$(jq -r '.shapes' "$DEPLOYMENT_FILE")")
RENDERER=$(cast --to-checksum-address "$(jq -r '.renderer' "$DEPLOYMENT_FILE")")
COLLECTION=$(cast --to-checksum-address "$(jq -r '.collection' "$DEPLOYMENT_FILE")")
HOUSE=$(cast --to-checksum-address "$(jq -r '.auctionHouse' "$DEPLOYMENT_FILE")")
FROM_BLOCK=$(jq -r '.fromBlock' "$DEPLOYMENT_FILE")

IS_ANVIL=0
[ "$CHAIN_ID" = "31337" ] && IS_ANVIL=1
APEX="${LIFECYCLE_APEX:-$IS_ANVIL}"
RUN_INDEXER="${LIFECYCLE_INDEXER:-$IS_ANVIL}"
INDEXER_PORT="${LIFECYCLE_INDEXER_PORT:-42069}"
DEAD=0x000000000000000000000000000000000000dEaD

# --- output and assertions ----------------------------------------------------------------------

STEP="startup"
step() { STEP="$1"; printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  ok: %s\n' "$*"; }
fail() { printf '\nFAIL [%s]: %s\n' "$STEP" "$*" >&2; exit 1; }

assert_eq() { [ "$2" = "$3" ] || fail "$1: expected '$3', got '$2'"; }
assert_ne() { [ "$2" != "$3" ] || fail "$1: expected anything but '$3'"; }

# Reverts are asserted by simulation rather than a send: `cast call` surfaces the decoded custom
# error, consumes no nonce, and cannot leave a failed transaction behind on a public chain.
assert_reverts() {
  local label="$1" want="$2" out
  shift 2
  if out=$(cast call "$@" --rpc-url "$RPC" 2>&1); then
    fail "$label: expected revert $want, the call succeeded with '$out'"
  fi
  [[ "$out" == *"$want"* ]] || fail "$label: expected revert $want, got '${out//$'\n'/ }'"
}

# bash integers are 64-bit signed; wei amounts are not.
big() { python3 -c "import sys;print(eval(sys.argv[1]))" "$1"; }

# One read, decoded to its first return value with no unit annotation.
rc() { local target="$1"; shift; cast call "$target" "$@" --rpc-url "$RPC" --json | jq -r '.[0]'; }
# One read, as compact JSON: a struct or array return in a comparable form.
rcj() { local target="$1"; shift; cast call "$target" "$@" --rpc-url "$RPC" --json | jq -c '.[0]'; }

# Whether `target`'s runtime code dispatches `sig`. Compiled selectors appear verbatim in the
# dispatch table, so this answers for an entrypoint whose arguments are not available to probe
# with, and works on a contract whose fallback masks an unknown selector.
has_fn() {
  local sel
  sel=$(cast sig "$2")
  printf '%s' "$(cast code "$1" --rpc-url "$RPC")" | grep -qi "${sel#0x}"
}

RESERVE_CHECKS=0
reserve_ok() {
  local bal backing fees
  bal=$(cast balance "$SHAPES" --rpc-url "$RPC")
  backing=$(rc "$SHAPES" 'redeemableBacking()(uint256)')
  fees=$(rc "$SHAPES" 'pendingFees()(uint256)')
  [ "$(big "$backing + $fees")" = "$bal" ] \
    || fail "reserve invariant broken after $1: balance $bal, backing $backing, fees $fees"
  RESERVE_CHECKS=$((RESERVE_CHECKS + 1))
}

# --- wallets --------------------------------------------------------------------------------

case "$WALLET" in
  anvil)
    W0_KEY="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
    W1_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
    W2_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
    W0_ARGS=(--private-key "$W0_KEY")
    W0=$(cast wallet address --private-key "$W0_KEY")
    W0_SIGN=(--private-key "$W0_KEY")
    ;;
  keystore)
    if [ -n "${KEYSTORE_PASSWORD_FILE:-}" ]; then
      [ -r "$KEYSTORE_PASSWORD_FILE" ] || { echo "refusing: KEYSTORE_PASSWORD_FILE is not readable" >&2; exit 1; }
      W0_ARGS=(--keystore "$HOME/.foundry/keystores/${KEYSTORE_ACCOUNT}" --password-file "$KEYSTORE_PASSWORD_FILE")
    else
      W0_ARGS=(--account "$KEYSTORE_ACCOUNT")
    fi
    W0_SIGN=("${W0_ARGS[@]}")
    W0="${DEPLOYER:?}"
    W1_KEY="${LIFECYCLE_PK1:?set LIFECYCLE_PK1 to a funded key for the second wallet}"
    W2_KEY="${LIFECYCLE_PK2:?set LIFECYCLE_PK2 to a funded key for the third wallet}"
    ;;
  *)
    echo "refusing: unknown WALLET=$WALLET in $ENV_FILE" >&2
    exit 1
    ;;
esac
W1_ARGS=(--private-key "$W1_KEY")
W2_ARGS=(--private-key "$W2_KEY")
W1=$(cast wallet address --private-key "$W1_KEY")
W2=$(cast wallet address --private-key "$W2_KEY")

# One transaction from wallet `w`, blocking on its receipt and failing on a reverted status.
# `--gas-limit` is explicit because bare eth_estimateGas under-estimates every nonReentrant
# function: the guard's SSTORE reset earns a refund credited only at the end of the transaction,
# so the estimate sits below the gas the execution needs mid-flight. GAS and VALUE are read from
# the environment so a single call can raise either without changing the signature.
tx() {
  local w="$1" target="$2" sig="$3"
  shift 3
  local -n wallet="W${w}_ARGS"
  local args=(--gas-limit "${GAS:-1200000}")
  [ -z "${VALUE:-}" ] || args+=(--value "${VALUE}wei")
  local receipt hash status
  receipt=$(cast send "${args[@]}" "$target" "$sig" "$@" "${wallet[@]}" --rpc-url "$RPC" --json)
  hash=$(printf '%s' "$receipt" | jq -r '.transactionHash')
  status=$(printf '%s' "$receipt" | jq -r '.status')
  [ "$status" = "0x1" ] || fail "transaction $hash reverted calling $sig"
  echo "$hash"
}

# What one transaction cost its sender, so a balance delta can be read as a payout alone.
gas_cost() {
  cast receipt "$1" --rpc-url "$RPC" --json \
    | python3 -c "
import json, sys
r = json.load(sys.stdin)
n = lambda v: int(v, 16) if isinstance(v, str) else int(v)
print(n(r['gasUsed']) * n(r['effectiveGasPrice']))"
}

# Seconds forward. Anvil is told; a real chain is waited out.
advance_time() {
  if [ "$IS_ANVIL" = 1 ]; then
    cast rpc evm_increaseTime "$1" --rpc-url "$RPC" >/dev/null
    cast rpc anvil_mine 1 --rpc-url "$RPC" >/dev/null
  else
    local target
    target=$(big "$(cast block latest --field timestamp --rpc-url "$RPC") + $1")
    while [ "$(cast block latest --field timestamp --rpc-url "$RPC")" -lt "$target" ]; do sleep 5; done
  fi
}

# --- entrypoint spellings ---------------------------------------------------------------------
# Fees accrue per recipient and the Black-state getter and the previews were renamed; a deployment
# from before those changes answers the older spellings. Both are walked by the same code below.

PER_RECIPIENT_FEES=0
has_fn "$SHAPES" 'feesOwedTo(address)' && PER_RECIPIENT_FEES=1
IS_BLACK_SIG='isBlack(uint256)(bool)'
has_fn "$SHAPES" 'isBlackShape(uint256)' && IS_BLACK_SIG='isBlackShape(uint256)(bool)'
OWNER_COPY=0
has_fn "$COLLECTION" 'ownerTokenDescription()' && OWNER_COPY=1
PREVIEW_TAKES_ACCOUNT=1
has_fn "$SHAPES" 'previewCompose(uint256,uint256[])' && PREVIEW_TAKES_ACCOUNT=0

STATE_TUPLE='(bytes32,uint8,uint32,uint8,bool,uint8,uint256,uint256,bytes)'
CHILD_TUPLE='(bytes32,uint8,uint32,uint8,uint256,bytes)'

# `previewCompose`/`previewSplit` for `account`. The newer spelling takes no account and applies no
# ownership check, so the address only selects the simulating caller.
preview_compose() {
  local account="$1" survivor="$2" burn="$3"
  if [ "$PREVIEW_TAKES_ACCOUNT" = 1 ]; then
    cast call "$SHAPES" "previewCompose(address,uint256,uint256[])($STATE_TUPLE)" \
      "$account" "$survivor" "$burn" --from "$account" --rpc-url "$RPC" --json | jq -c '.[0]'
  else
    cast call "$SHAPES" "previewCompose(uint256,uint256[])($STATE_TUPLE)" \
      "$survivor" "$burn" --from "$account" --rpc-url "$RPC" --json | jq -c '.[0]'
  fi
}
preview_split() {
  local account="$1" token="$2" denoms="$3"
  if [ "$PREVIEW_TAKES_ACCOUNT" = 1 ]; then
    cast call "$SHAPES" "previewSplit(address,uint256,uint8[])($CHILD_TUPLE[])" \
      "$account" "$token" "$denoms" --from "$account" --rpc-url "$RPC" --json | jq -c '.[0]'
  else
    cast call "$SHAPES" "previewSplit(uint256,uint8[])($CHILD_TUPLE[])" \
      "$token" "$denoms" --from "$account" --rpc-url "$RPC" --json | jq -c '.[0]'
  fi
}

# Lineage edges this run causes, compared against the indexer's rows in step 12.
EDGES_CONTINUATION=0
EDGES_REVIVAL=0
EDGES_SPLIT=0

echo "== lifecycle.sh $ENV_NAME =="
echo "  rpc          $RPC"
echo "  profile      $FOUNDRY_PROFILE"
echo "  shapes       $SHAPES"
echo "  collection   $COLLECTION"
echo "  house        $HOUSE"
echo "  wallets      $W0 $W1 $W2"
echo "  apex step    $APEX"
echo "  indexer step $RUN_INDEXER"

# ================================================================================================
# 1. Genesis
# ================================================================================================
step "1. genesis"

TOTAL_MINTED=$(rc "$SHAPES" 'totalMinted()(uint256)')
[ "$TOTAL_MINTED" = "1" ] \
  || fail "this walkthrough requires a freshly deployed system; totalMinted is $TOTAL_MINTED, expected 1"

SYMBOL=$(rc "$SHAPES" 'symbol()(string)')
case "$SYMBOL" in SHAPE | SHAPES) ;; *) fail "symbol: expected SHAPE, got '$SYMBOL'" ;; esac
assert_eq "name" "$(rc "$SHAPES" 'name()(string)')" "Shapes"
assert_eq "ownerToken" "$(rc "$SHAPES" 'ownerToken()(uint256)')" "0"
assert_eq "owner" "$(rc "$SHAPES" 'owner()(address)')" "$W0"
assert_eq "admin" "$(rc "$SHAPES" 'admin()(address)')" "$W0"
assert_eq "artist" "$(rc "$SHAPES" 'artist()(address)')" "$W0"
assert_eq "Shape #0 owner" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' 0)" "$W0"
assert_eq "renderer" "$(rc "$SHAPES" 'renderer()(address)')" "$RENDERER"
assert_eq "collection" "$(rc "$SHAPES" 'collection()(address)')" "$COLLECTION"
assert_eq "collection binding" "$(rc "$COLLECTION" 'shapes()(address)')" "$SHAPES"
assert_eq "presentation lock" "$(rc "$SHAPES" 'presentationLocked()(bool)')" "false"
pointer_target() { cast call "$SHAPES" "$1()(address,bool)" --rpc-url "$RPC" --json | jq -r '.[0]'; }
pointer_locked() { cast call "$SHAPES" "$1()(address,bool)" --rpc-url "$RPC" --json | jq -r '.[1]'; }
assert_eq "positions pointer" "$(pointer_target positions)" "0x0000000000000000000000000000000000000000"
assert_eq "positions lock" "$(pointer_locked positions)" "false"
assert_eq "market pointer" "$(cast --to-checksum-address "$(pointer_target market)")" "$HOUSE"
assert_eq "market lock" "$(pointer_locked market)" "false"
assert_eq "artist attestation" "$(rc "$SHAPES" 'artistReleaseHash()(bytes32)')" \
  "0x0000000000000000000000000000000000000000000000000000000000000000"
assert_eq "black shapes" "$(rc "$SHAPES" 'blackShapeCount()(uint256)')" "0"
assert_eq "burned backing" "$(rc "$SHAPES" 'burnedBacking()(uint256)')" "0"
assert_eq "pending fees" "$(rc "$SHAPES" 'pendingFees()(uint256)')" "0"
assert_eq "auction count" "$(rc "$HOUSE" 'auctionCount()(uint256)')" "0"
assert_eq "auction house target" "$(rc "$HOUSE" 'shapes()(address)')" "$SHAPES"

# The ladder, read from the token rather than assumed, so this script runs unchanged under either
# compiled ladder.
UNIT=$(rc "$SHAPES" 'unit()(uint256)')
DENOM_COUNT=$(rc "$SHAPES" 'denominationCount()(uint8)')
assert_eq "denomination count" "$DENOM_COUNT" "9"
DENOM=()
for i in $(seq 0 8); do DENOM+=("$(rc "$SHAPES" 'denominationAt(uint8)(uint256)' "$i")"); done
assert_eq "unit is the smallest denomination" "$UNIT" "${DENOM[0]}"
APEX_WEI="${DENOM[8]}"
APEX_UNITS=$(big "$APEX_WEI // $UNIT")
MINT_FEE=$(rc "$SHAPES" 'mintFee()(uint256)')
MINT_START=$(rc "$SHAPES" 'mintStart()(uint64)')
FEE_RECIPIENT_ONCHAIN=$(rc "$SHAPES" 'feeRecipient()(address)')

assert_eq "genesis backing" "$(rc "$SHAPES" 'redeemableBacking()(uint256)')" "${DENOM[0]}"
assert_eq "genesis denomination" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' 0)" "0"

# Every linked library the deploy recorded still carries code at the address it was recorded at.
while IFS=$'\t' read -r lib address; do
  [ -n "$address" ] || continue
  [ "$(cast code "$address" --rpc-url "$RPC")" != "0x" ] || fail "library $lib has no code at $address"
done < <(jq -r '.libraries | to_entries[] | "\(.key)\t\(.value)"' "$DEPLOYMENT_FILE")

reserve_ok "genesis"
ok "genesis: Shape #0 is the owner token, pointers and libraries bound, reserve exact"

# ================================================================================================
# 2. Minting
# ================================================================================================
step "2. mint"

NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
if [ "$MINT_START" -gt "$NOW" ]; then
  assert_reverts "closed mint" MintNotOpen \
    "$SHAPES" 'mint(uint256)' "${DENOM[0]}" --from "$W0" --value "$(big "${DENOM[0]} + $MINT_FEE")"
  [ "$IS_ANVIL" = 1 ] || fail "mintStart $MINT_START is in the future and this chain has no time control"
  advance_time "$((MINT_START - NOW + 1))"
  ok "mint gate: refused before $MINT_START, then opened"
else
  ok "mint gate: already open at $MINT_START"
fi

assert_reverts "unsupported denomination" UnsupportedDenomination \
  "$SHAPES" 'mint(uint256)' "$(big "2 * ${DENOM[4]}")" --from "$W0" \
  --value "$(big "2 * ${DENOM[4]} + $MINT_FEE")"
assert_reverts "direct deposit" DirectDepositRejected "$SHAPES" 0x --from "$W0" --value 1

# One of each of the nine denominations, ids 1..9 in ladder order.
for i in $(seq 0 8); do
  VALUE=$(big "${DENOM[$i]} + $MINT_FEE") tx 0 "$SHAPES" 'mint(uint256)' "${DENOM[$i]}" >/dev/null
done
GIFT=$(rc "$SHAPES" 'totalMinted()(uint256)')
VALUE=$(big "${DENOM[0]} + $MINT_FEE") tx 0 "$SHAPES" 'mintTo(uint256,address)' "${DENOM[0]}" "$W1" >/dev/null
DUST0=$(rc "$SHAPES" 'totalMinted()(uint256)')
GAS=3000000 VALUE=$(big "8 * (${DENOM[0]} + $MINT_FEE)") \
  tx 0 "$SHAPES" 'mintBatch(uint256,uint256)' "${DENOM[0]}" 8 >/dev/null
W1DUST=$(rc "$SHAPES" 'totalMinted()(uint256)')
GAS=1500000 VALUE=$(big "2 * (${DENOM[0]} + $MINT_FEE)") \
  tx 0 "$SHAPES" 'mintBatchTo(uint256,uint256,address)' "${DENOM[0]}" 2 "$W1" >/dev/null

assert_eq "total minted" "$(rc "$SHAPES" 'totalMinted()(uint256)')" "21"
assert_eq "total supply" "$(rc "$SHAPES" 'totalSupply()(uint256)')" "21"
for i in $(seq 0 8); do
  assert_eq "token $((i + 1)) denomination" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$((i + 1))")" "$i"
  assert_eq "token $((i + 1)) backing" "$(rc "$SHAPES" 'backingOf(uint256)(uint256)' "$((i + 1))")" "${DENOM[$i]}"
  assert_eq "token $((i + 1)) formation" "$(rc "$SHAPES" 'formationOf(uint256)(uint8)' "$((i + 1))")" "1"
done
assert_eq "mintTo recipient" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$GIFT")" "$W1"
assert_eq "mintBatch recipient" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$DUST0")" "$W0"
assert_eq "mintBatchTo recipient" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$W1DUST")" "$W1"
assert_eq "mintBatchTo recipient (second)" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$((W1DUST + 1))")" "$W1"

SEEDS=$(for t in $(seq 0 20); do rc "$SHAPES" 'seedOf(uint256)(bytes32)' "$t"; done)
assert_eq "seeds are distinct" "$(printf '%s\n' "$SEEDS" | sort -u | wc -l | tr -d ' ')" "21"

MINTED_BACKING=$(big "${DENOM[0]} + ${DENOM[0]}+${DENOM[1]}+${DENOM[2]}+${DENOM[3]}+${DENOM[4]}+${DENOM[5]}+${DENOM[6]}+${DENOM[7]}+${DENOM[8]} + 11 * ${DENOM[0]}")
assert_eq "redeemable backing" "$(rc "$SHAPES" 'redeemableBacking()(uint256)')" "$MINTED_BACKING"
assert_eq "accrued fees" "$(rc "$SHAPES" 'pendingFees()(uint256)')" "$(big "20 * $MINT_FEE")"
if [ "$PER_RECIPIENT_FEES" = 1 ]; then
  assert_eq "fees owed to the recipient" \
    "$(rc "$SHAPES" 'feesOwedTo(address)(uint256)' "$FEE_RECIPIENT_ONCHAIN")" "$(big "20 * $MINT_FEE")"
fi
assert_reverts "zero quantity" ZeroQuantity "$SHAPES" 'mintBatch(uint256,uint256)' "${DENOM[0]}" 0 --from "$W0"
reserve_ok "mint"
ok "mint: nine denominations, mintTo, mintBatch and mintBatchTo; 20 fees accrued, seeds distinct"

# ================================================================================================
# 3. Compose
# ================================================================================================
step "3. compose"

# Five dust tokens make the next denomination up. Ids DUST0..DUST0+7 are the batch minted above.
COMPOSE_A=$DUST0
BURN_A="[$((DUST0 + 1)),$((DUST0 + 2)),$((DUST0 + 3)),$((DUST0 + 4))]"
SUPPLY_BEFORE=$(rc "$SHAPES" 'totalSupply()(uint256)')
BACKING_BEFORE=$(rc "$SHAPES" 'redeemableBacking()(uint256)')
GAS=2500000 tx 0 "$SHAPES" 'compose(uint256,uint256[])' "$COMPOSE_A" "$BURN_A" >/dev/null
EDGES_CONTINUATION=$((EDGES_CONTINUATION + 4))

assert_eq "survivor denomination" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$COMPOSE_A")" "1"
assert_eq "survivor origins" "$(rc "$SHAPES" 'originCountOf(uint256)(uint256)' "$COMPOSE_A")" "5"
assert_eq "survivor is Complete" "$(rc "$SHAPES" 'isComplete(uint256)(bool)' "$COMPOSE_A")" "true"
assert_eq "survivor formation" "$(rc "$SHAPES" 'formationOf(uint256)(uint8)' "$COMPOSE_A")" "3"
assert_eq "compose depth" "$(rc "$SHAPES" 'composeDepth(uint256)(uint256)' "$COMPOSE_A")" "1"
assert_eq "supply after compose" "$(rc "$SHAPES" 'totalSupply()(uint256)')" "$((SUPPLY_BEFORE - 4))"
assert_eq "backing is conserved" "$(rc "$SHAPES" 'redeemableBacking()(uint256)')" "$BACKING_BEFORE"
for i in 1 2 3 4; do
  assert_eq "input $((DUST0 + i)) burned" "$(rc "$SHAPES" 'exists(uint256)(bool)' "$((DUST0 + i))")" "false"
done
RECORD=$(rcj "$SHAPES" "composeRecordAt(uint256,uint256)((uint8,uint32,uint8,bytes,uint256,(uint256,bytes32,uint8,uint32,uint8,bytes)[]))" "$COMPOSE_A" 0)
assert_eq "record survivor denomination" "$(printf '%s' "$RECORD" | jq -r '.[0]')" "0"
assert_eq "record survivor origins" "$(printf '%s' "$RECORD" | jq -r '.[1]')" "1"
assert_eq "record carries no owner token" "$(printf '%s' "$RECORD" | jq -r '.[4]')" \
  "115792089237316195423570985008687907853269984665640564039457584007913129639935"
assert_eq "record input count" "$(printf '%s' "$RECORD" | jq -r '.[5] | length')" "4"
assert_reverts "record out of range" ComposeRecordOutOfRange \
  "$SHAPES" "composeRecordAt(uint256,uint256)((uint8,uint32,uint8,bytes,uint256,(uint256,bytes32,uint8,uint32,uint8,bytes)[]))" \
  "$COMPOSE_A" 1 --from "$W0"
assert_reverts "compose with self" CannotComposeWithSelf \
  "$SHAPES" 'compose(uint256,uint256[])' "$COMPOSE_A" "[$COMPOSE_A]" --from "$W0"
reserve_ok "compose"

# The owner token as a compose donor: ownership moves to the survivor.
COMPOSE_B=$((DUST0 + 5))
BURN_B="[0,$((DUST0 + 6)),$((DUST0 + 7)),1]"
GAS=2500000 tx 0 "$SHAPES" 'compose(uint256,uint256[])' "$COMPOSE_B" "$BURN_B" >/dev/null
EDGES_CONTINUATION=$((EDGES_CONTINUATION + 4))

assert_eq "owner token moved" "$(rc "$SHAPES" 'ownerToken()(uint256)')" "$COMPOSE_B"
assert_eq "owner follows the token" "$(rc "$SHAPES" 'owner()(address)')" "$W0"
assert_eq "Shape #0 burned" "$(rc "$SHAPES" 'exists(uint256)(bool)' 0)" "false"
RECORD_B=$(rcj "$SHAPES" "composeRecordAt(uint256,uint256)((uint8,uint32,uint8,bytes,uint256,(uint256,bytes32,uint8,uint32,uint8,bytes)[]))" "$COMPOSE_B" 0)
assert_eq "record names the donor of ownership" "$(printf '%s' "$RECORD_B" | jq -r '.[4]')" "0"
assert_eq "backing still conserved" "$(rc "$SHAPES" 'redeemableBacking()(uint256)')" "$BACKING_BEFORE"
reserve_ok "compose with the owner token"
ok "compose: dust folded up a denomination, owner token followed its donor into the survivor"

# ================================================================================================
# 4. Decompose
# ================================================================================================
step "4. decompose"

GAS=2500000 tx 0 "$SHAPES" 'decompose(uint256)' "$COMPOSE_A" >/dev/null
EDGES_REVIVAL=$((EDGES_REVIVAL + 4))
assert_eq "survivor restored" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$COMPOSE_A")" "0"
assert_eq "survivor origins restored" "$(rc "$SHAPES" 'originCountOf(uint256)(uint256)' "$COMPOSE_A")" "1"
assert_eq "compose depth cleared" "$(rc "$SHAPES" 'composeDepth(uint256)(uint256)' "$COMPOSE_A")" "0"
for i in 1 2 3 4; do
  assert_eq "input $((DUST0 + i)) revived" "$(rc "$SHAPES" 'exists(uint256)(bool)' "$((DUST0 + i))")" "true"
  assert_eq "input $((DUST0 + i)) returned to the caller" \
    "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$((DUST0 + i))")" "$W0"
done
# The second compose is still folded, so four of the eight burned inputs are back.
assert_eq "supply restored" "$(rc "$SHAPES" 'totalSupply()(uint256)')" "$((SUPPLY_BEFORE - 4))"
reserve_ok "decompose"

# decomposeTo sends the revived inputs elsewhere, the owner token among them.
GAS=2500000 tx 0 "$SHAPES" 'decomposeTo(uint256,address)' "$COMPOSE_B" "$W1" >/dev/null
EDGES_REVIVAL=$((EDGES_REVIVAL + 4))
assert_eq "owner token back at #0" "$(rc "$SHAPES" 'ownerToken()(uint256)')" "0"
assert_eq "Shape #0 revived to the recipient" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' 0)" "$W1"
assert_eq "owner is the recipient" "$(rc "$SHAPES" 'owner()(address)')" "$W1"
assert_eq "survivor kept by the caller" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$COMPOSE_B")" "$W0"
assert_eq "survivor restored" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$COMPOSE_B")" "0"
assert_eq "supply fully restored" "$(rc "$SHAPES" 'totalSupply()(uint256)')" "$SUPPLY_BEFORE"
assert_reverts "nothing left to decompose" NoComposeRecord \
  "$SHAPES" 'decompose(uint256)' "$COMPOSE_B" --from "$W0"
reserve_ok "decomposeTo"

# The batch spellings of both, over the same five dust tokens.
BATCH_CALL="[($COMPOSE_A,$BURN_A)]"
GAS=2500000 tx 0 "$SHAPES" 'composeMany((uint256,uint256[])[])' "$BATCH_CALL" >/dev/null
EDGES_CONTINUATION=$((EDGES_CONTINUATION + 4))
assert_eq "composeMany survivor" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$COMPOSE_A")" "1"
GAS=2500000 tx 0 "$SHAPES" 'decomposeMany(uint256[])' "[$COMPOSE_A]" >/dev/null
EDGES_REVIVAL=$((EDGES_REVIVAL + 4))
assert_eq "decomposeMany survivor" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$COMPOSE_A")" "0"
GAS=2500000 tx 0 "$SHAPES" 'composeMany((uint256,uint256[])[])' "$BATCH_CALL" >/dev/null
EDGES_CONTINUATION=$((EDGES_CONTINUATION + 4))
GAS=2500000 tx 0 "$SHAPES" 'decomposeManyTo(uint256[],address)' "[$COMPOSE_A]" "$W0" >/dev/null
EDGES_REVIVAL=$((EDGES_REVIVAL + 4))
assert_eq "decomposeManyTo survivor" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$COMPOSE_A")" "0"
assert_eq "backing untouched by recomposition" "$(rc "$SHAPES" 'redeemableBacking()(uint256)')" "$BACKING_BEFORE"
reserve_ok "batch recomposition"
ok "decompose: survivors restored, inputs revived under their own ids, ownership handed to the recipient"

# ================================================================================================
# 5. Split
# ================================================================================================
step "5. split"

# The owner token is #0 and holds one unit, so it is folded into a splittable token first.
SPLIT_PARENT=$((DUST0 + 6))
GAS=2500000 tx 1 "$SHAPES" 'compose(uint256,uint256[])' "$SPLIT_PARENT" "[0,$((DUST0 + 7)),$W1DUST,$((W1DUST + 1))]" >/dev/null
EDGES_CONTINUATION=$((EDGES_CONTINUATION + 4))
assert_eq "owner token on the split parent" "$(rc "$SHAPES" 'ownerToken()(uint256)')" "$SPLIT_PARENT"

PARENT_BACKING=$(rc "$SHAPES" 'backingOf(uint256)(uint256)' "$SPLIT_PARENT")
FIRST_CHILD=$(rc "$SHAPES" 'totalMinted()(uint256)')
GAS=3000000 tx 1 "$SHAPES" 'split(uint256,uint8[])' "$SPLIT_PARENT" "[0,0,0,0,0]" >/dev/null
EDGES_SPLIT=$((EDGES_SPLIT + 5))
OWNER_TOKEN=$FIRST_CHILD

CHILD_SUM=0
for i in 0 1 2 3 4; do
  CHILD=$((FIRST_CHILD + i))
  assert_eq "child $CHILD owner" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$CHILD")" "$W1"
  CHILD_SUM=$(big "$CHILD_SUM + $(rc "$SHAPES" 'backingOf(uint256)(uint256)' "$CHILD")")
done
assert_eq "children sum to the parent" "$CHILD_SUM" "$PARENT_BACKING"
assert_eq "parent burned" "$(rc "$SHAPES" 'exists(uint256)(bool)' "$SPLIT_PARENT")" "false"
assert_eq "first child inherits the owner token" "$(rc "$SHAPES" 'ownerToken()(uint256)')" "$FIRST_CHILD"
assert_eq "owner unchanged" "$(rc "$SHAPES" 'owner()(address)')" "$W1"
ORIGIN=$(cast call "$SHAPES" 'splitOriginOf(uint256)(bytes32,uint256,uint8,uint8,uint8,bytes,uint256)' \
  "$FIRST_CHILD" --rpc-url "$RPC" --json)
assert_eq "split origin parent" "$(printf '%s' "$ORIGIN" | jq -r '.[1]')" "$SPLIT_PARENT"
assert_eq "split origin denomination" "$(printf '%s' "$ORIGIN" | jq -r '.[2]')" "1"
assert_eq "split origin child index" "$(printf '%s' "$ORIGIN" | jq -r '.[6]')" "0"
assert_reverts "split sum mismatch" SplitSumMismatch \
  "$SHAPES" 'split(uint256,uint8[])' "$((FIRST_CHILD + 1))" "[0,0]" --from "$W1"
assert_reverts "split needs two outputs" SplitTooFewOutputs \
  "$SHAPES" 'split(uint256,uint8[])' "$((FIRST_CHILD + 1))" "[0]" --from "$W1"
reserve_ok "split"

# splitTo hands the children to another account.
SPLITTO_PARENT=3
SPLITTO_FIRST=$(rc "$SHAPES" 'totalMinted()(uint256)')
SPLITTO_BACKING=$(rc "$SHAPES" 'backingOf(uint256)(uint256)' "$SPLITTO_PARENT")
GAS=2500000 tx 0 "$SHAPES" 'splitTo(uint256,uint8[],address)' "$SPLITTO_PARENT" "[1,1]" "$W2" >/dev/null
EDGES_SPLIT=$((EDGES_SPLIT + 2))
CARD_A=$SPLITTO_FIRST
CARD_B=$((SPLITTO_FIRST + 1))
assert_eq "splitTo child A" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$CARD_A")" "$W2"
assert_eq "splitTo child B" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$CARD_B")" "$W2"
assert_eq "splitTo children sum to the parent" \
  "$(big "$(rc "$SHAPES" 'backingOf(uint256)(uint256)' "$CARD_A") + $(rc "$SHAPES" 'backingOf(uint256)(uint256)' "$CARD_B")")" \
  "$SPLITTO_BACKING"
assert_eq "splitTo origin parent" \
  "$(cast call "$SHAPES" 'splitOriginOf(uint256)(bytes32,uint256,uint8,uint8,uint8,bytes,uint256)' "$CARD_B" --rpc-url "$RPC" --json | jq -r '.[1]')" \
  "$SPLITTO_PARENT"
assert_eq "backing conserved across split" "$(rc "$SHAPES" 'redeemableBacking()(uint256)')" "$BACKING_BEFORE"
reserve_ok "splitTo"
ok "split: children sum to the parent, the first inherits ownership, splitOriginOf reconstructs both"

# ================================================================================================
# 6. Previews
# ================================================================================================
step "6. previews"

PREVIEW_SURVIVOR=$COMPOSE_A
PREVIEW_BURN=$BURN_A
COMPOSE_PREVIEW=$(preview_compose "$W0" "$PREVIEW_SURVIVOR" "$PREVIEW_BURN")
STRANGER_PREVIEW=$(preview_compose "$W1" "$PREVIEW_SURVIVOR" "$PREVIEW_BURN" 2>/dev/null || echo FAILED)
if [ "$PREVIEW_TAKES_ACCOUNT" = 1 ]; then
  assert_eq "compose preview refuses a non-owner" "$STRANGER_PREVIEW" "FAILED"
else
  assert_eq "compose preview answers a non-owner" "$STRANGER_PREVIEW" "$COMPOSE_PREVIEW"
fi
GAS=2500000 tx 0 "$SHAPES" 'compose(uint256,uint256[])' "$PREVIEW_SURVIVOR" "$PREVIEW_BURN" >/dev/null
EDGES_CONTINUATION=$((EDGES_CONTINUATION + 4))
assert_eq "compose preview matched execution" \
  "$(rcj "$SHAPES" "shapeState(uint256)($STATE_TUPLE)" "$PREVIEW_SURVIVOR")" "$COMPOSE_PREVIEW"
reserve_ok "previewed compose"

SPLIT_DENOMS="[0,0,0,0,0]"
SPLIT_PREVIEW=$(preview_split "$W0" "$PREVIEW_SURVIVOR" "$SPLIT_DENOMS")
STRANGER_SPLIT=$(preview_split "$W1" "$PREVIEW_SURVIVOR" "$SPLIT_DENOMS" 2>/dev/null || echo FAILED)
if [ "$PREVIEW_TAKES_ACCOUNT" = 1 ]; then
  assert_eq "split preview refuses a non-owner" "$STRANGER_SPLIT" "FAILED"
else
  assert_eq "split preview answers a non-owner" "$STRANGER_SPLIT" "$SPLIT_PREVIEW"
fi
PREVIEW_FIRST=$(rc "$SHAPES" 'totalMinted()(uint256)')
GAS=3000000 tx 0 "$SHAPES" 'split(uint256,uint8[])' "$PREVIEW_SURVIVOR" "$SPLIT_DENOMS" >/dev/null
EDGES_SPLIT=$((EDGES_SPLIT + 5))
for i in 0 1 2 3 4; do
  CHILD=$((PREVIEW_FIRST + i))
  ACTUAL=$(cast call "$SHAPES" "shapeState(uint256)($STATE_TUPLE)" "$CHILD" --rpc-url "$RPC" --json \
    | jq -c '[.[0][0], .[0][1], .[0][2], .[0][3], .[0][6], .[0][8]]')
  assert_eq "split preview child $i matched execution" "$ACTUAL" \
    "$(printf '%s' "$SPLIT_PREVIEW" | jq -c ".[$i]")"
done
reserve_ok "previewed split"
DUST_POOL=("$PREVIEW_FIRST" "$((PREVIEW_FIRST + 1))" "$((PREVIEW_FIRST + 2))" "$((PREVIEW_FIRST + 3))" "$((PREVIEW_FIRST + 4))")
ok "previews: compose and split previews reproduced exactly what the transactions then wrote"

# ================================================================================================
# 6b. Presentation and geometry reads
# ================================================================================================
step "6b. reads"

# Modules per denomination index, the grid `Denominations.gridAt` fixes.
MODULE_COUNT=(25 20 16 12 9 6 4 2 1)
LIVE=${DUST_POOL[0]}
BURNED=$PREVIEW_SURVIVOR
LIVE_DENOM=$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$LIVE")
assert_eq "the burned id is gone" "$(rc "$SHAPES" 'exists(uint256)(bool)' "$BURNED")" "false"
assert_ne "unicodeCard renders" "$(rc "$SHAPES" 'unicodeCard(uint256)(string)' "$LIVE")" ""
assert_reverts "unicodeCard refuses a burned id" ERC721NonexistentToken \
  "$SHAPES" 'unicodeCard(uint256)(string)' "$BURNED" --from "$W0"
assert_reverts "shapeState refuses a burned id" ERC721NonexistentToken \
  "$SHAPES" "shapeState(uint256)($STATE_TUPLE)" "$BURNED" --from "$W0"

if has_fn "$SHAPES" 'geometryOf(uint256)'; then
  GEOMETRY=$(cast call "$SHAPES" 'geometryOf(uint256)(uint256,uint256,uint256)' "$LIVE" --rpc-url "$RPC" --json)
  COLS=$(printf '%s' "$GEOMETRY" | jq -r '.[0]')
  ROWS=$(printf '%s' "$GEOMETRY" | jq -r '.[1]')
  MODULES=$(printf '%s' "$GEOMETRY" | jq -r '.[2]')
  assert_eq "geometry module count" "$MODULES" "$((COLS * ROWS))"
  assert_eq "geometry matches the denomination grid" "$MODULES" "${MODULE_COUNT[$LIVE_DENOM]}"
  assert_reverts "geometryOf refuses a burned id" ERC721NonexistentToken \
    "$SHAPES" 'geometryOf(uint256)(uint256,uint256,uint256)' "$BURNED" --from "$W0"
  EFFECTIVE=$(rc "$SHAPES" 'effectiveModulesOf(uint256)(bytes)' "$LIVE")
  assert_eq "effective modules cover the grid" "$(( (${#EFFECTIVE} - 2) / 2 ))" "$MODULES"
  assert_ne "moduleAt reads a cell" "$(rc "$SHAPES" 'moduleAt(uint256,uint256)(uint8)' "$LIVE" 0)" ""
  assert_ne "svg renders" "$(rc "$SHAPES" 'svg(uint256)(string)' "$LIVE")" ""
  assert_ne "metadataJSON renders" "$(rc "$SHAPES" 'metadataJSON(uint256)(string)' "$LIVE")" ""
  assert_reverts "svg refuses a burned id" ERC721NonexistentToken \
    "$SHAPES" 'svg(uint256)(string)' "$BURNED" --from "$W0"
  ok "reads: geometry, modules, svg and metadata answer for a live Shape and refuse a burned id"
else
  ok "reads: geometry and render views are not on this deployment; unicodeCard and shapeState checked"
fi

# ================================================================================================
# 7. Apex Complete and burnBacking
# ================================================================================================
step "7. burnBacking"

if [ "$APEX" != "1" ]; then
  ok "burnBacking: skipped (LIFECYCLE_APEX=$APEX). An apex Complete needs $APEX_UNITS separate mints"
else
  # An apex Complete carries one origin per unit of the top denomination, so it can only be built
  # from that many separate mints. Minted in batches, folded to the second-from-top denomination in
  # groups, then folded once more.
  # Named APEX_GROUPS because bash reserves GROUPS as a dynamic array of the caller's OS group
  # ids: an assignment to it is silently ignored and the count would follow the machine.
  APEX_GROUPS=10
  PER_GROUP=$(big "$APEX_UNITS // $APEX_GROUPS")
  APEX_ID=$(rc "$SHAPES" 'totalMinted()(uint256)')
  for g in $(seq 0 $((APEX_GROUPS - 1))); do
    GAS=1000000000 VALUE=$(big "$PER_GROUP * (${DENOM[0]} + $MINT_FEE)") \
      tx 0 "$SHAPES" 'mintBatch(uint256,uint256)' "${DENOM[0]}" "$PER_GROUP" >/dev/null
  done
  for g in $(seq 0 $((APEX_GROUPS - 1))); do
    HEAD=$((APEX_ID + g * PER_GROUP))
    IDS="[$(python3 -c "import sys;h=int(sys.argv[1]);n=int(sys.argv[2]);print(','.join(str(i) for i in range(h+1,h+n)))" "$HEAD" "$PER_GROUP")]"
    GAS=2000000000 tx 0 "$SHAPES" 'compose(uint256,uint256[])' "$HEAD" "$IDS" >/dev/null
    EDGES_CONTINUATION=$((EDGES_CONTINUATION + PER_GROUP - 1))
  done
  HEADS="[$(python3 -c "import sys;a=int(sys.argv[1]);p=int(sys.argv[2]);g=int(sys.argv[3]);print(','.join(str(a+i*p) for i in range(1,g)))" "$APEX_ID" "$PER_GROUP" "$APEX_GROUPS")]"
  GAS=200000000 tx 0 "$SHAPES" 'compose(uint256,uint256[])' "$APEX_ID" "$HEADS" >/dev/null
  EDGES_CONTINUATION=$((EDGES_CONTINUATION + APEX_GROUPS - 1))

  assert_eq "apex denomination" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$APEX_ID")" "8"
  assert_eq "apex origins" "$(rc "$SHAPES" 'originCountOf(uint256)(uint256)' "$APEX_ID")" "$APEX_UNITS"
  assert_eq "apex is Complete" "$(rc "$SHAPES" 'isComplete(uint256)(bool)' "$APEX_ID")" "true"
  reserve_ok "apex built"

  BLACK_BEFORE=$(rc "$SHAPES" 'blackShapeCount()(uint256)')
  BURNED_BEFORE=$(rc "$SHAPES" 'burnedBacking()(uint256)')
  DEAD_BEFORE=$(cast balance "$DEAD" --rpc-url "$RPC")
  BACKING_PRE_BURN=$(rc "$SHAPES" 'redeemableBacking()(uint256)')
  GAS=2000000 tx 0 "$SHAPES" 'burnBacking(uint256)' "$APEX_ID" >/dev/null

  assert_eq "black shape count" "$(rc "$SHAPES" 'blackShapeCount()(uint256)')" "$((BLACK_BEFORE + 1))"
  assert_eq "burned backing" "$(rc "$SHAPES" 'burnedBacking()(uint256)')" "$(big "$BURNED_BEFORE + $APEX_WEI")"
  assert_eq "unspendable balance" "$(cast balance "$DEAD" --rpc-url "$RPC")" "$(big "$DEAD_BEFORE + $APEX_WEI")"
  assert_eq "backing left the reserve" "$(rc "$SHAPES" 'redeemableBacking()(uint256)')" \
    "$(big "$BACKING_PRE_BURN - $APEX_WEI")"
  assert_eq "the Black Shape is Black" "$(rc "$SHAPES" "$IS_BLACK_SIG" "$APEX_ID")" "true"
  assert_eq "the Black Shape has no redeemable backing" "$(rc "$SHAPES" 'backingOf(uint256)(uint256)' "$APEX_ID")" "0"
  assert_eq "the Black Shape's formation" "$(rc "$SHAPES" 'formationOf(uint256)(uint8)' "$APEX_ID")" "4"
  assert_reverts "a Black Shape cannot be redeemed" TokenIsBlack \
    "$SHAPES" 'redeem(uint256)' "$APEX_ID" --from "$W0"
  assert_reverts "a Black Shape cannot be composed" TokenIsBlack \
    "$SHAPES" 'compose(uint256,uint256[])' "$APEX_ID" "[${DUST_POOL[0]}]" --from "$W0"
  reserve_ok "burnBacking"

  GAS=2000000 tx 0 "$SHAPES" 'burn(uint256)' "$APEX_ID" >/dev/null
  assert_eq "black shape count returns" "$(rc "$SHAPES" 'blackShapeCount()(uint256)')" "$BLACK_BEFORE"
  assert_eq "the Black Shape is gone" "$(rc "$SHAPES" 'exists(uint256)(bool)' "$APEX_ID")" "false"
  assert_eq "burned backing is permanent" "$(rc "$SHAPES" 'burnedBacking()(uint256)')" "$(big "$BURNED_BEFORE + $APEX_WEI")"
  reserve_ok "burn of a Black Shape"
  ok "burnBacking: $APEX_UNITS origins folded to an apex Complete, backing sent to $DEAD, token burned for zero"
fi

# ================================================================================================
# 8. Redemption
# ================================================================================================
step "8. redeem"

assert_reverts "a non-owner cannot redeem" NotShapeOwner "$SHAPES" 'redeem(uint256)' "$GIFT" --from "$W0"

REDEEM_ID=5
BEFORE=$(cast balance "$W0" --rpc-url "$RPC")
HASH=$(GAS=2000000 tx 0 "$SHAPES" 'redeem(uint256)' "$REDEEM_ID")
AFTER=$(cast balance "$W0" --rpc-url "$RPC")
assert_eq "redeem paid exactly the wrapped amount" \
  "$(big "$AFTER - $BEFORE + $(gas_cost "$HASH")")" "${DENOM[4]}"
assert_eq "redeemed token is gone" "$(rc "$SHAPES" 'exists(uint256)(bool)' "$REDEEM_ID")" "false"
reserve_ok "redeem"

W2_BEFORE=$(cast balance "$W2" --rpc-url "$RPC")
GAS=2000000 tx 0 "$SHAPES" 'redeemTo(uint256,address)' 4 "$W2" >/dev/null
assert_eq "redeemTo paid the recipient" "$(cast balance "$W2" --rpc-url "$RPC")" "$(big "$W2_BEFORE + ${DENOM[3]}")"
reserve_ok "redeemTo"

BEFORE=$(cast balance "$W0" --rpc-url "$RPC")
HASH=$(GAS=2500000 tx 0 "$SHAPES" 'redeemBatch(uint256[])' "[6,7]")
AFTER=$(cast balance "$W0" --rpc-url "$RPC")
assert_eq "redeemBatch paid both" "$(big "$AFTER - $BEFORE + $(gas_cost "$HASH")")" \
  "$(big "${DENOM[5]} + ${DENOM[6]}")"
reserve_ok "redeemBatch"

W2_BEFORE=$(cast balance "$W2" --rpc-url "$RPC")
GAS=2500000 tx 0 "$SHAPES" 'redeemBatchTo(uint256[],address)' "[8,9]" "$W2" >/dev/null
assert_eq "redeemBatchTo paid the recipient" "$(cast balance "$W2" --rpc-url "$RPC")" \
  "$(big "$W2_BEFORE + ${DENOM[7]} + ${DENOM[8]}")"
reserve_ok "redeemBatchTo"

BEFORE=$(cast balance "$W0" --rpc-url "$RPC")
HASH=$(GAS=2000000 tx 0 "$SHAPES" 'burn(uint256)' 2)
AFTER=$(cast balance "$W0" --rpc-url "$RPC")
assert_eq "burn of an ordinary Shape paid its backing" \
  "$(big "$AFTER - $BEFORE + $(gas_cost "$HASH")")" "${DENOM[1]}"
reserve_ok "burn"
ok "redeem: redeem, redeemTo, redeemBatch, redeemBatchTo and burn each paid exactly the backing"

# ================================================================================================
# 9. Administration
# ================================================================================================
step "9. admin"

ORDINARY=${DUST_POOL[1]}
NAME_PREFIX="Lifecycle Shape #"  # no trailing space: cast trims one from a string argument
DESCRIPTION="A description written by the lifecycle walkthrough to prove the metadata copy reaches tokenURI."
OWNER_DESCRIPTION="A separate description carried only by the owner token."
if [ "$OWNER_COPY" = 1 ]; then
  tx 0 "$COLLECTION" 'setMetadataCopy(string,string,string)' "$NAME_PREFIX" "$DESCRIPTION" "$OWNER_DESCRIPTION" >/dev/null
  assert_eq "owner token description" "$(rc "$COLLECTION" 'ownerTokenDescription()(string)')" "$OWNER_DESCRIPTION"
else
  tx 0 "$COLLECTION" 'setMetadataCopy(string,string)' "$NAME_PREFIX" "$DESCRIPTION" >/dev/null
fi
assert_eq "token name prefix" "$(rc "$COLLECTION" 'tokenNamePrefix()(string)')" "$NAME_PREFIX"
assert_eq "collection description" "$(rc "$COLLECTION" 'description()(string)')" "$DESCRIPTION"
tx 0 "$SHAPES" 'refreshMetadata()' >/dev/null

token_json() {
  rc "$SHAPES" 'tokenURI(uint256)(string)' "$1" \
    | sed -E 's#^data:application/json;base64,##' | base64 -d
}
ORDINARY_JSON=$(token_json "$ORDINARY")
assert_eq "tokenURI name" "$(printf '%s' "$ORDINARY_JSON" | jq -r '.name')" "$NAME_PREFIX$ORDINARY"
assert_eq "tokenURI description" "$(printf '%s' "$ORDINARY_JSON" | jq -r '.description')" "$DESCRIPTION"
if [ "$OWNER_COPY" = 1 ]; then
  assert_eq "owner token tokenURI description" \
    "$(token_json "$OWNER_TOKEN" | jq -r '.description')" "$OWNER_DESCRIPTION"
fi
CONTRACT_JSON=$(rc "$SHAPES" 'contractURI()(string)' | sed -E 's#^data:application/json;base64,##' | base64 -d)
assert_eq "contractURI description" "$(printf '%s' "$CONTRACT_JSON" | jq -r '.description')" "$DESCRIPTION"

# The positions pointer, pointed at a resolver this script deploys, then locked.
RESOLVER=$(forge create test/mocks/Mocks.sol:MockPositionResolver --rpc-url "$RPC" "${W0_ARGS[@]}" --broadcast --json \
  | jq -r '.deployedTo')
[[ "$RESOLVER" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "could not deploy the positions resolver mock"
tx 0 "$RESOLVER" 'setPosition(uint256,address)' "$ORDINARY" "$W2" >/dev/null
tx 0 "$SHAPES" 'setPointer(uint8,address)' 0 "$RESOLVER" >/dev/null
assert_eq "positions pointer set" "$(cast --to-checksum-address "$(rc "$SHAPES" 'positions()(address,bool)')")" \
  "$(cast --to-checksum-address "$RESOLVER")"
assert_eq "positionOf reads the resolver" "$(rc "$SHAPES" 'positionOf(uint256)(address)' "$ORDINARY")" "$W2"
tx 0 "$SHAPES" 'lockPointer(uint8)' 0 >/dev/null
assert_eq "positions locked" \
  "$(cast call "$SHAPES" 'positions()(address,bool)' --rpc-url "$RPC" --json | jq -r '.[1]')" "true"
assert_reverts "a locked pointer refuses a new target" PointerIsLocked \
  "$SHAPES" 'setPointer(uint8,address)' 0 "$RESOLVER" --from "$W0"
tx 0 "$SHAPES" 'setPointer(uint8,address)' 1 "$HOUSE" >/dev/null
assert_reverts "an unknown pointer is refused" InvalidPointer \
  "$SHAPES" 'setPointer(uint8,address)' 2 "$HOUSE" --from "$W0"

# The presentation pointers, reset to what they already are, before the lock closes them.
tx 0 "$SHAPES" 'setRenderer(address)' "$RENDERER" >/dev/null
tx 0 "$SHAPES" 'setCollection(address)' "$COLLECTION" >/dev/null
assert_reverts "an unsupported renderer is refused" UnsupportedRenderer \
  "$SHAPES" 'setRenderer(address)' "$HOUSE" --from "$W0"

# The fee: within the cap, refused above it, then redirected and withdrawn per recipient.
NEW_FEE=$(big "$UNIT // 2")
tx 0 "$SHAPES" 'setMintFee(uint256)' "$NEW_FEE" >/dev/null
assert_eq "mint fee" "$(rc "$SHAPES" 'mintFee()(uint256)')" "$NEW_FEE"
assert_reverts "the mint fee cap holds" MintFeeAboveCap \
  "$SHAPES" 'setMintFee(uint256)' "$(big "$UNIT + 1")" --from "$W0"

FEES_TO_FIRST=$(rc "$SHAPES" 'pendingFees()(uint256)')
tx 0 "$SHAPES" 'setFeeRecipient(address)' "$W2" >/dev/null
assert_eq "fee recipient" "$(rc "$SHAPES" 'feeRecipient()(address)')" "$W2"
assert_reverts "a zero fee recipient is refused" AdminInvalidFeeRecipient \
  "$SHAPES" 'setFeeRecipient(address)' 0x0000000000000000000000000000000000000000 --from "$W0"
SPARE=$(rc "$SHAPES" 'totalMinted()(uint256)')
VALUE=$(big "${DENOM[0]} + $NEW_FEE") tx 0 "$SHAPES" 'mint(uint256)' "${DENOM[0]}" >/dev/null
assert_eq "fees accrued after the redirect" "$(rc "$SHAPES" 'pendingFees()(uint256)')" \
  "$(big "$FEES_TO_FIRST + $NEW_FEE")"

if [ "$PER_RECIPIENT_FEES" = 1 ]; then
  assert_eq "fees owed to the first recipient" \
    "$(rc "$SHAPES" 'feesOwedTo(address)(uint256)' "$FEE_RECIPIENT_ONCHAIN")" "$FEES_TO_FIRST"
  assert_eq "fees owed to the second recipient" "$(rc "$SHAPES" 'feesOwedTo(address)(uint256)' "$W2")" "$NEW_FEE"
  RECIPIENT_BEFORE=$(cast balance "$FEE_RECIPIENT_ONCHAIN" --rpc-url "$RPC")
  HASH=$(GAS=2000000 tx 1 "$SHAPES" 'withdrawFees(address)' "$FEE_RECIPIENT_ONCHAIN")
  PAID=$(big "$(cast balance "$FEE_RECIPIENT_ONCHAIN" --rpc-url "$RPC") - $RECIPIENT_BEFORE")
  [ "$FEE_RECIPIENT_ONCHAIN" != "$W1" ] || PAID=$(big "$PAID + $(gas_cost "$HASH")")
  assert_eq "the first recipient was paid exactly" "$PAID" "$FEES_TO_FIRST"
  W2_BEFORE=$(cast balance "$W2" --rpc-url "$RPC")
  GAS=2000000 tx 1 "$SHAPES" 'withdrawFees(address)' "$W2" >/dev/null
  assert_eq "the second recipient was paid exactly" "$(cast balance "$W2" --rpc-url "$RPC")" \
    "$(big "$W2_BEFORE + $NEW_FEE")"
  assert_eq "nothing left pending" "$(rc "$SHAPES" 'pendingFees()(uint256)')" "0"
  assert_reverts "an empty account cannot withdraw" NoFeesPending \
    "$SHAPES" 'withdrawFees(address)' "$W2" --from "$W1"
else
  W2_BEFORE=$(cast balance "$W2" --rpc-url "$RPC")
  GAS=2000000 tx 1 "$SHAPES" 'withdrawFees()' >/dev/null
  assert_eq "the current recipient was paid every accrued fee" "$(cast balance "$W2" --rpc-url "$RPC")" \
    "$(big "$W2_BEFORE + $FEES_TO_FIRST + $NEW_FEE")"
  assert_eq "nothing left pending" "$(rc "$SHAPES" 'pendingFees()(uint256)')" "0"
  assert_reverts "an empty balance cannot withdraw" NoFeesPending "$SHAPES" 'withdrawFees()' --from "$W1"
fi
reserve_ok "fee withdrawal"

tx 0 "$SHAPES" 'lockPresentation()' >/dev/null
assert_eq "presentation locked" "$(rc "$SHAPES" 'presentationLocked()(bool)')" "true"
if [ "$OWNER_COPY" = 1 ]; then
  assert_reverts "the metadata copy is frozen" PresentationIsLocked \
    "$COLLECTION" 'setMetadataCopy(string,string,string)' "x" "y" "z" --from "$W0"
else
  assert_reverts "the metadata copy is frozen" PresentationIsLocked \
    "$COLLECTION" 'setMetadataCopy(string,string)' "x" "y" --from "$W0"
fi
assert_reverts "the renderer is frozen" PresentationIsLocked \
  "$SHAPES" 'setRenderer(address)' "$RENDERER" --from "$W0"
assert_reverts "the collection is frozen" PresentationIsLocked \
  "$SHAPES" 'setCollection(address)' "$COLLECTION" --from "$W0"

tx 0 "$SHAPES" 'transferAdmin(address)' "$W1" >/dev/null
assert_eq "admin transferred" "$(rc "$SHAPES" 'admin()(address)')" "$W1"
assert_reverts "the previous admin lost its authority" AdminUnauthorizedAccount \
  "$SHAPES" 'setMintFee(uint256)' 0 --from "$W0"
tx 1 "$SHAPES" 'transferAdmin(address)' "$W0" >/dev/null
tx 0 "$SHAPES" 'renounceAdmin()' >/dev/null
assert_eq "admin renounced" "$(rc "$SHAPES" 'admin()(address)')" "0x0000000000000000000000000000000000000000"
assert_reverts "no admin remains" AdminUnauthorizedAccount \
  "$SHAPES" 'setMintFee(uint256)' 0 --from "$W0"
reserve_ok "admin"
ok "admin: copy, pointers, fee and admin role exercised, then presentation locked and admin renounced"

# ================================================================================================
# 10. Artist attestation
# ================================================================================================
step "10. artist"

RELEASE_HASH=$(cast keccak "shapes-lifecycle-release")
DIGEST=$(rc "$SHAPES" 'artistAttestationDigest(bytes32)(bytes32)' "$RELEASE_HASH")
SIGNATURE=$(cast wallet sign --no-hash "$DIGEST" "${W0_SIGN[@]}")
tx 0 "$SHAPES" 'attestArtist(bytes32,bytes)' "$RELEASE_HASH" "$SIGNATURE" >/dev/null
assert_eq "release hash stored" "$(rc "$SHAPES" 'artistReleaseHash()(bytes32)')" "$RELEASE_HASH"
assert_eq "signature stored" "$(rc "$SHAPES" 'artistSignature()(bytes)')" "$SIGNATURE"
assert_reverts "the attestation is one-shot" ArtistAlreadyAttested \
  "$SHAPES" 'attestArtist(bytes32,bytes)' "$RELEASE_HASH" "$SIGNATURE" --from "$W0"
reserve_ok "artist attestation"
ok "artist: the release hash and its signature are bound to this deployment and cannot be replaced"

# ================================================================================================
# 11. Auction
# ================================================================================================
step "11. auction"

DURATION=3600
[ "$IS_ANVIL" = 1 ] || DURATION=120
tx 1 "$SHAPES" 'setApprovalForAll(address,bool)' "$HOUSE" true >/dev/null
LOT=$OWNER_TOKEN
AUCTION=$(rc "$HOUSE" 'auctionCount()(uint256)')
GAS=2000000 tx 1 "$HOUSE" 'createAuction(address,uint256,uint64,uint64,uint16,uint32)' \
  "$SHAPES" "$LOT" "$DURATION" 1 500 60 >/dev/null
assert_eq "lot escrowed" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$LOT")" "$HOUSE"
assert_eq "the house owns the collection while it holds the owner token" \
  "$(rc "$SHAPES" 'owner()(address)')" "$HOUSE"
assert_eq "lot indexed" "$(rc "$HOUSE" 'hasAuctionFor(address,uint256)(bool)' "$SHAPES" "$LOT")" "true"

# A bid paid in Shapes.
tx 2 "$SHAPES" 'setApprovalForAll(address,bool)' "$HOUSE" true >/dev/null
CARD_UNITS=$(big "(${DENOM[1]} + ${DENOM[1]}) // $UNIT")
GAS=2000000 tx 2 "$HOUSE" 'bid(uint256,uint256[],uint256)' "$AUCTION" "[$CARD_A,$CARD_B]" 0 >/dev/null
assert_eq "card bid escrowed" "$(rc "$HOUSE" 'bidUnits(uint256,address)(uint64)' "$AUCTION" "$W2")" "$CARD_UNITS"
assert_reverts "the seller cannot bid its own lot" SellerCannotBid \
  "$HOUSE" 'bid(uint256,uint256[],uint256)' "$AUCTION" "[]" "$UNIT" --from "$W1" \
  --value "$(rc "$HOUSE" 'mintCostFor(uint256)(uint256)' "$UNIT")"

# A bid paid in ETH, which the house mints into the minimal card set.
NEXT_UNITS=$(rc "$HOUSE" 'minimumBid(uint256)(uint64)' "$AUCTION")
NEXT_WEI=$(big "$NEXT_UNITS * $UNIT")
GAS=6000000 VALUE=$(rc "$HOUSE" 'mintCostFor(uint256)(uint256)' "$NEXT_WEI") \
  tx 0 "$HOUSE" 'bid(uint256,uint256[],uint256)' "$AUCTION" "[]" "$NEXT_WEI" >/dev/null
assert_eq "eth bid escrowed" "$(rc "$HOUSE" 'bidUnits(uint256,address)(uint64)' "$AUCTION" "$W0")" "$NEXT_UNITS"
reserve_ok "auction bids"

GAS=2000000 tx 2 "$HOUSE" 'withdraw(uint256)' "$AUCTION" >/dev/null
assert_eq "the outbid bidder took its cards back" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$CARD_A")" "$W2"
assert_eq "outbid escrow cleared" "$(rc "$HOUSE" 'bidUnits(uint256,address)(uint64)' "$AUCTION" "$W2")" "0"

assert_reverts "settlement waits for the clock" AuctionStillRunning \
  "$HOUSE" 'settle(uint256)' "$AUCTION" --from "$W2"
advance_time "$((DURATION + 120))"
GAS=2000000 tx 2 "$HOUSE" 'settle(uint256)' "$AUCTION" >/dev/null
assert_eq "settlement moved nothing" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$LOT")" "$HOUSE"
assert_reverts "the seller cannot take a lot that sold" NotLotRecipient \
  "$HOUSE" 'claimLot(uint256)' "$AUCTION" --from "$W1"

GAS=2000000 tx 0 "$HOUSE" 'claimLot(uint256)' "$AUCTION" >/dev/null
assert_eq "the winner holds the lot" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$LOT")" "$W0"
assert_eq "the winner owns the collection" "$(rc "$SHAPES" 'owner()(address)')" "$W0"
assert_eq "the token index cleared" "$(rc "$HOUSE" 'hasAuctionFor(address,uint256)(bool)' "$SHAPES" "$LOT")" "false"
GAS=3000000 tx 1 "$HOUSE" 'claimProceeds(uint256)' "$AUCTION" >/dev/null

# An auction nobody bid on: cancelled by its seller, then pulled back.
CANCELLED=$(rc "$HOUSE" 'auctionCount()(uint256)')
tx 0 "$SHAPES" 'setApprovalForAll(address,bool)' "$HOUSE" true >/dev/null
GAS=2000000 tx 0 "$HOUSE" 'createAuction(address,uint256,uint64,uint64,uint16,uint32)' \
  "$SHAPES" "$SPARE" "$DURATION" 1 500 60 >/dev/null
GAS=2000000 tx 0 "$HOUSE" 'cancelAuction(uint256)' "$CANCELLED" >/dev/null
GAS=2000000 tx 0 "$HOUSE" 'claimLot(uint256)' "$CANCELLED" >/dev/null
assert_eq "the cancelled lot came home" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$SPARE")" "$W0"

assert_eq "the house holds no Shapes" "$(rc "$SHAPES" 'balanceOf(address)(uint256)' "$HOUSE")" "0"
assert_eq "the house holds no ETH" "$(cast balance "$HOUSE" --rpc-url "$RPC")" "0"
reserve_ok "auction"
ok "auction: card bid outbid by an ETH bid, settled, lot and proceeds pulled, house drained to zero"

# ================================================================================================
# 8b. The owner token, redeemed last
# ================================================================================================
step "8b. owner token"

BEFORE=$(cast balance "$W0" --rpc-url "$RPC")
HASH=$(GAS=2000000 tx 0 "$SHAPES" 'redeem(uint256)' "$LOT")
AFTER=$(cast balance "$W0" --rpc-url "$RPC")
assert_eq "the owner token paid its backing" \
  "$(big "$AFTER - $BEFORE + $(gas_cost "$HASH")")" "${DENOM[0]}"
assert_eq "collection ownership ended" "$(rc "$SHAPES" 'owner()(address)')" "0x0000000000000000000000000000000000000000"
assert_reverts "no owner token remains" NoOwnerToken "$SHAPES" 'ownerToken()(uint256)' --from "$W0"
reserve_ok "owner token redemption"
ok "owner token: redeemed last, owner() is zero and ownerToken() reverts NoOwnerToken"

# ================================================================================================
# 12. Indexer diff
# ================================================================================================
step "12. indexer"

INDEXER_PID=""
INDEXER_DIR=""
cleanup_indexer() {
  if [ -n "$INDEXER_PID" ]; then
    kill "$INDEXER_PID" 2>/dev/null || true
    # npm forks the ponder process, so the wrapper's own pid is not the server. The port makes
    # the pattern specific to this run.
    pkill -f "ponder start --port ${INDEXER_PORT}" 2>/dev/null || true
    # Ponder runs a shutdown sequence, so the port is still answering for a moment after the
    # signal. Leaving before it closes would hand the caller a process it thinks is stopped.
    for _ in $(seq 1 30); do
      pgrep -f "ponder start --port ${INDEXER_PORT}" >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  [ -z "$INDEXER_DIR" ] || rm -rf "$INDEXER_DIR"
}
trap cleanup_indexer EXIT

if [ "$RUN_INDEXER" != "1" ]; then
  ok "indexer: skipped (LIFECYCLE_INDEXER=$RUN_INDEXER)"
else
  command -v npm >/dev/null || fail "npm is required for the indexer diff; rerun with LIFECYCLE_INDEXER=0 to skip"
  [ -d indexer/node_modules ] || (cd indexer && npm install --no-audit --no-fund >/dev/null)
  command -v curl >/dev/null || fail "curl is required for the indexer diff"
  # A stray server already on this port (most often a developer's own long-running `ponder dev`
  # on its default 42069) answers /ready immediately, so the loop below would silently diff
  # against that unrelated database instead of the one this run just spawned. Fail fast here
  # instead of producing a confusing indexed-count mismatch four minutes later.
  if (exec 3<>"/dev/tcp/127.0.0.1/${INDEXER_PORT}") 2>/dev/null; then
    exec 3<&- 3>&-
    fail "port ${INDEXER_PORT} is already in use; set LIFECYCLE_INDEXER_PORT to a free port or stop the process on it"
  fi
  TIP=$(cast block-number --rpc-url "$RPC")
  INDEXER_DIR=$(mktemp -d)
  (
    cd indexer
    PONDER_RPC_URL="$RPC" PONDER_CHAIN_ID="$CHAIN_ID" \
      SHAPES_ADDRESS="$SHAPES" SHAPES_START_BLOCK="$FROM_BLOCK" AUCTION_HOUSE_ADDRESS="$HOUSE" \
      PONDER_DATABASE_DIR="$INDEXER_DIR/pglite" \
      npm run start -- --port "$INDEXER_PORT" --schema public >"$INDEXER_DIR/log" 2>&1
  ) &
  INDEXER_PID=$!

  READY=0
  for _ in $(seq 1 300); do
    # Require our own spawned process to still be alive, not just /ready answering: a stray
    # server that raced onto this port after the preflight check would otherwise pass silently.
    if kill -0 "$INDEXER_PID" 2>/dev/null && curl -fsS "http://127.0.0.1:${INDEXER_PORT}/ready" >/dev/null 2>&1; then
      READY=1
      break
    fi
    kill -0 "$INDEXER_PID" 2>/dev/null || break
    sleep 2
  done
  [ "$READY" = "1" ] || { tail -40 "$INDEXER_DIR/log" >&2; fail "the indexer never reported ready"; }

  gql() {
    curl -fsS "http://127.0.0.1:${INDEXER_PORT}/graphql" \
      -H 'content-type: application/json' \
      --data "$(jq -n --arg q "$1" '{query:$q}')"
  }

  # `/ready` reports the backfill complete, not the head reached: the realtime sync can still be
  # several blocks behind at that moment. Every comparison below is against the chain as this run
  # left it, so wait for the indexed checkpoint to reach that block first.
  INDEXED=0
  for _ in $(seq 1 150); do
    INDEXED=$(gql 'query { _meta { status } }' | jq -r '.data._meta.status.chain.block.number // 0')
    [ "$INDEXED" -ge "$TIP" ] && break
    sleep 2
  done
  [ "$INDEXED" -ge "$TIP" ] || fail "the indexer stalled at block $INDEXED with the chain at $TIP"

  LIVE_JSON=$(gql 'query { tokens(where: { live: true }, limit: 1000) { items { id owner denomIndex isBlack } pageInfo { hasNextPage } } }')
  printf '%s' "$LIVE_JSON" | jq -e '.errors | not' >/dev/null || fail "indexer GraphQL error: $LIVE_JSON"
  assert_eq "the live page covered every row" \
    "$(printf '%s' "$LIVE_JSON" | jq -r '.data.tokens.pageInfo.hasNextPage')" "false"

  LIVE_COUNT=$(printf '%s' "$LIVE_JSON" | jq -r '.data.tokens.items | length')
  assert_eq "indexed live tokens match totalSupply" "$LIVE_COUNT" "$(rc "$SHAPES" 'totalSupply()(uint256)')"

  while IFS=$'\t' read -r id owner denom; do
    [ -n "$id" ] || continue
    assert_eq "token $id owner" "$(rc "$SHAPES" 'ownerOf(uint256)(address)' "$id")" "$(cast --to-checksum-address "$owner")"
    assert_eq "token $id denomination" "$(rc "$SHAPES" 'denomIndexOf(uint256)(uint8)' "$id")" "$denom"
  done < <(printf '%s' "$LIVE_JSON" | jq -r '.data.tokens.items[] | "\(.id)\t\(.owner)\t\(.denomIndex)"')

  OWNER_ROW=$(gql 'query { collectionOwner(id: "singleton") { ownerTokenId ownerAddress } }')
  assert_eq "collection owner token" "$(printf '%s' "$OWNER_ROW" | jq -r '.data.collectionOwner.ownerTokenId')" "null"
  assert_eq "collection owner address" "$(printf '%s' "$OWNER_ROW" | jq -r '.data.collectionOwner.ownerAddress')" "null"

  edge_count() {
    printf '%s' "$(gql "query { lineageEdges(where: { kind: \"$1\" }, limit: 1) { totalCount } }")" \
      | jq -r '.data.lineageEdges.totalCount'
  }
  assert_eq "continuation edges" "$(edge_count continuation)" "$EDGES_CONTINUATION"
  assert_eq "revival edges" "$(edge_count revival)" "$EDGES_REVIVAL"
  assert_eq "split edges" "$(edge_count split)" "$EDGES_SPLIT"

  cleanup_indexer
  INDEXER_PID=""
  INDEXER_DIR=""
  ok "indexer: $LIVE_COUNT live tokens, ownership and denominations agree with chain, lineage counts exact"
fi

step "done"
ok "every entrypoint walked; the reserve invariant held across $RESERVE_CHECKS checks"
