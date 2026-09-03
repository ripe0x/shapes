#!/usr/bin/env bash
# One deploy path for anvil, Sepolia and mainnet. The environment is a values file
# (script/env/<name>.env), never a separate script: every guard and every step below runs
# identically regardless of target, gated only by the values that file sets.
#
# Usage:
#   script/deploy.sh <anvil|sepolia|mainnet>
#
# Overrides:
#   SEPOLIA_RPC_URL / MAINNET_RPC_URL / RPC_URL   RPC endpoint, overrides the env file default.
#   FOUNDRY_PROFILE                               forge profile, overrides the env file default.
#   KEYSTORE_PASSWORD_FILE                        read the keystore password from this file
#                                                  (chmod 600) instead of an interactive prompt.
#                                                  The password never appears in argv.
#   DEPLOYER_PRIVATE_KEY                           anvil target only: use this key instead of
#                                                  anvil's well-known default account 0 key.
#   SHAPES_FEE_RECIPIENT / SHAPES_MINT_FEE_WEI     forwarded to Deploy.s.sol; must agree with a
#                                                  nonempty FEE_RECIPIENT / MINT_FEE_WEI in the
#                                                  env file if one is set there.
#   MINT_START_DELAY                               seconds from the post-compile clock to the
#                                                 mint start; resolved after forge build.
#   MINT_START                                     overrides the env file's MINT_START (a
#                                                  rehearsal sets this a few minutes ahead).
#   ALLOW_BRANCH_DEPLOY=1                         testnets only: deploy a pushed branch instead
#                                                 of main (mainnet always requires main).
#   DRY_RUN=1                                     simulate only: the REQUIRE_MAIN git guards
#                                                  (branch, fetched origin/main, clean tree, no
#                                                  untracked files) still run, but a failure only
#                                                  warns instead of exiting, since a real run would
#                                                  refuse. Every other guard still hard-fails. Only
#                                                  the wallet and --broadcast are skipped, and the
#                                                  run stops after the simulation. Nothing is
#                                                  written.
#   RESUME=1                                      skip `forge script --broadcast` entirely and run
#                                                  only the post-broadcast phase (verification when
#                                                  VERIFY=true, on-chain readback, deployments/
#                                                  record) against the existing broadcast file for
#                                                  this chain. For recording a deployment whose
#                                                  broadcast already succeeded on chain but whose
#                                                  wrapper run didn't reach the recording step (e.g.
#                                                  forge's inline verification failed and aborted
#                                                  the wrapper before it got there). The REQUIRE_MAIN
#                                                  git guards still run, but, like DRY_RUN, only
#                                                  warn: nothing is broadcast from this worktree's
#                                                  commit, so the exact-commit invariant that guards
#                                                  a real broadcast doesn't apply to resuming one
#                                                  that already happened elsewhere.
#   VERIFY=true|false                             overrides the env file's VERIFY value. Lets a
#                                                  resumed run skip verification (and the
#                                                  ETHERSCAN_API_KEY requirement) without editing
#                                                  the env file.
#   BROADCAST_FILE                                path to the forge broadcast file to read for the
#                                                  post-broadcast phase, overriding the default
#                                                  broadcast/Deploy.s.sol/<chainId>/run-latest.json.
#                                                  For resuming from a broadcast produced by a
#                                                  different checkout.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  anvil | sepolia | mainnet) ;;
  *)
    echo "usage: script/deploy.sh <anvil|sepolia|mainnet>" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="script/env/${ENV_NAME}.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

DRY_RUN="${DRY_RUN:-0}"
RESUME="${RESUME:-0}"
# Captured before sourcing the env file, which unconditionally sets VERIFY: a caller-exported
# VERIFY wins over the env file's value.
VERIFY_OVERRIDE="${VERIFY-}"
# A shell-provided MINT_START (a rehearsal setting it a few minutes ahead) must survive the env
# file's own MINT_START assignment below, so it is snapshotted before sourcing.
MINT_START_OVERRIDE="${MINT_START:-}"

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

[ -z "$VERIFY_OVERRIDE" ] || VERIFY="$VERIFY_OVERRIDE"
[ -z "$MINT_START_OVERRIDE" ] || MINT_START="$MINT_START_OVERRIDE"

# Mainnet's env file ships with the deployer, fee recipient and fee left blank until D-05
# (project/DECISIONS.md) is resolved. Refuse before touching any RPC, dry run included.
if [ "$ENV_NAME" = "mainnet" ]; then
  for var in DEPLOYER FEE_RECIPIENT MINT_FEE_WEI; do
    [ -n "${!var:-}" ] || {
      echo "refusing: $ENV_FILE has no $var set. Resolve D-05 (project/DECISIONS.md) and fill in the mainnet env file first." >&2
      exit 1
    }
  done
fi

case "$ENV_NAME" in
  sepolia) RPC="${SEPOLIA_RPC_URL:-${RPC_URL:-$RPC_DEFAULT}}" ;;
  mainnet) RPC="${MAINNET_RPC_URL:-${RPC_URL:-$RPC_DEFAULT}}" ;;
  anvil) RPC="${RPC_URL:-$RPC_DEFAULT}" ;;
esac
[ -n "$RPC" ] || { echo "refusing: no RPC URL configured for $ENV_NAME" >&2; exit 1; }
FOUNDRY_PROFILE="${FOUNDRY_PROFILE:-$FOUNDRY_PROFILE_DEFAULT}"
# Exported once: every forge/solc invocation below (deploy, inspect, verify-contract) must compile
# against the same profile the broadcast used, or their bytecode won't line up with what's on chain.
export FOUNDRY_PROFILE
BROADCAST_FILE="${BROADCAST_FILE:-broadcast/Deploy.s.sol/${CHAIN_ID}/run-latest.json}"

echo "== deploy.sh $ENV_NAME =="
echo "  rpc      $RPC"
echo "  profile  $FOUNDRY_PROFILE"
echo "  dry run  $DRY_RUN"
echo "  resume   $RESUME"

# Deploy.s.sol reads SHAPES_MINT_FEE_WEI / SHAPES_FEE_RECIPIENT; the env file's own names
# (MINT_FEE_WEI / FEE_RECIPIENT) are the reviewed values for this target. A caller-supplied
# override is allowed only if it agrees with them.
if [ -n "${MINT_FEE_WEI:-}" ]; then
  if [ -n "${SHAPES_MINT_FEE_WEI:-}" ] && [ "$SHAPES_MINT_FEE_WEI" != "$MINT_FEE_WEI" ]; then
    echo "refusing: SHAPES_MINT_FEE_WEI=$SHAPES_MINT_FEE_WEI overrides the reviewed $ENV_NAME fee ($MINT_FEE_WEI)" >&2
    exit 1
  fi
  export SHAPES_MINT_FEE_WEI="$MINT_FEE_WEI"
fi
if [ -n "${FEE_RECIPIENT:-}" ]; then
  if [ -n "${SHAPES_FEE_RECIPIENT:-}" ] && [ "$SHAPES_FEE_RECIPIENT" != "$FEE_RECIPIENT" ]; then
    echo "refusing: SHAPES_FEE_RECIPIENT=$SHAPES_FEE_RECIPIENT overrides the reviewed $ENV_NAME payout ($FEE_RECIPIENT)" >&2
    exit 1
  fi
  export SHAPES_FEE_RECIPIENT="$FEE_RECIPIENT"
fi
[ -z "${MINT_START:-}" ] || export SHAPES_MINT_START="$MINT_START"
# Otherwise FEE_RECIPIENT is empty by design (anvil): pass through whatever the caller already
# exported as SHAPES_FEE_RECIPIENT (fork-dev.sh does this), or leave it unset so Deploy.s.sol
# defaults to the deployer on chain id 31337. MINT_START works the same way: the shell override
# snapshotted above wins, otherwise the env file's own value (or its blank default) applies.

# --- guards: identical code path for every target, switched only by the env file's values ------

ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$ACTUAL_CHAIN_ID" = "$CHAIN_ID" ] \
  || { echo "refusing: $RPC reports chain id $ACTUAL_CHAIN_ID, expected $CHAIN_ID" >&2; exit 1; }
echo "  ok: chain id $ACTUAL_CHAIN_ID"

if [ "$REQUIRE_MAIN" = "true" ]; then
  # A real broadcast refuses on any failure here. Under DRY_RUN=1 or RESUME=1 the same checks
  # still run, but a failure only warns what a real broadcast would refuse: DRY_RUN broadcasts
  # nothing, and RESUME's broadcast already happened (elsewhere, possibly from a different
  # checkout): the exact-commit invariant guards a new broadcast, not a resumed readback of one
  # that already landed on chain.
  git_guard_fail() {
    if [ "$DRY_RUN" = "1" ] || [ "$RESUME" = "1" ]; then
      echo "  warn: a new broadcast would refuse: $1" >&2
    else
      echo "refusing: $1" >&2
      exit 1
    fi
  }

  # Mainnet deploys only from main. A testnet rehearsal may deploy a pushed branch when the
  # caller sets ALLOW_BRANCH_DEPLOY=1; the commit must still equal the fetched remote branch.
  BRANCH="$(git branch --show-current)"
  if [ "${ALLOW_BRANCH_DEPLOY:-0}" = "1" ] && [ "$CHAIN_ID" != "1" ] && [ -n "$BRANCH" ]; then
    echo "  branch deploy allowed on chain $CHAIN_ID: $BRANCH"
  else
    [ "$BRANCH" = "main" ] || git_guard_fail "deployments must run from main (ALLOW_BRANCH_DEPLOY=1 permits a pushed branch on testnets)"
    BRANCH="main"
  fi
  git fetch --quiet origin "$BRANCH"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] \
    || git_guard_fail "local $BRANCH is not the fetched origin/$BRANCH commit"
  git diff --quiet && git diff --cached --quiet \
    || git_guard_fail "tracked files are dirty; deployment commit is not exact"
  # deployments/ is written by a previous deploy, not an input to this one; untracked files
  # there don't make the deployment commit inexact.
  [ -z "$(git ls-files --others --exclude-standard -- . ':!deployments')" ] \
    || git_guard_fail "untracked files exist; deployment commit is not exact"
  [ "$DRY_RUN" = "1" ] || [ "$RESUME" = "1" ] || echo "  ok: clean, exact, fetched $BRANCH"
fi

if [ "${FEE_RECIPIENT_MUST_BE_EOA:-false}" = "true" ]; then
  [ "$(cast code "$FEE_RECIPIENT" --rpc-url "$RPC")" = "0x" ] \
    || { echo "refusing: fee recipient $FEE_RECIPIENT has code" >&2; exit 1; }
  echo "  ok: fee recipient is an EOA"
fi

if [ "$VERIFY" = "true" ] && [ "$DRY_RUN" != "1" ]; then
  : "${ETHERSCAN_API_KEY:?VERIFY=true for $ENV_NAME requires ETHERSCAN_API_KEY}"
  echo "  ok: ETHERSCAN_API_KEY set"
fi

# --- wallet -------------------------------------------------------------------------------------
# Resolved even for RESUME=1: nothing here signs anything (that only happens if WALLET_ARGS is
# later passed to a broadcasting forge invocation), but the readback phase needs EFFECTIVE_DEPLOYER
# regardless of whether this run broadcasts.

WALLET_ARGS=()
if [ "$DRY_RUN" != "1" ]; then
  case "$WALLET" in
    anvil)
      DEPLOY_PK="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
      WALLET_ARGS=(--private-key "$DEPLOY_PK")
      EFFECTIVE_DEPLOYER="$(cast wallet address --private-key "$DEPLOY_PK")"
      ;;
    keystore)
      KEYSTORE_PATH="$HOME/.foundry/keystores/${KEYSTORE_ACCOUNT}"
      if [ -n "${KEYSTORE_PASSWORD_FILE:-}" ]; then
        [ -r "$KEYSTORE_PASSWORD_FILE" ] \
          || { echo "refusing: KEYSTORE_PASSWORD_FILE is not readable" >&2; exit 1; }
        WALLET_ARGS=(--keystore "$KEYSTORE_PATH" --password-file "$KEYSTORE_PASSWORD_FILE")
      else
        WALLET_ARGS=(--account "$KEYSTORE_ACCOUNT")
      fi
      EFFECTIVE_DEPLOYER="${DEPLOYER:?}"
      ;;
    *)
      echo "refusing: unknown WALLET=$WALLET in $ENV_FILE" >&2
      exit 1
      ;;
  esac
fi

# --- run ----------------------------------------------------------------------------------------
# Inline `--verify` is never used: forge aborts the whole invocation (and this wrapper, under
# set -e) on the first verification failure, before broadcast confirmations are even read back or
# deployments/<chainId>.json is written. Verification runs as its own step below instead, after a
# real broadcast or under RESUME, where a failure is recorded and the run continues.

# A relative mint start is resolved after the compile, not at command start: a cold via_ir build
# takes minutes, so "now + N" computed earlier would already be in the past when the broadcast
# lands. Pad MINT_START_DELAY for the broadcast itself (sequential transactions, ~12 s blocks).
if [ -n "${MINT_START_DELAY:-}" ]; then
  # The env file may set MINT_START=0 (open at deploy); only a real absolute value conflicts.
  if [ -n "${MINT_START:-}" ] && [ "$MINT_START" != "0" ]; then
    echo "set MINT_START or MINT_START_DELAY, not both" >&2; exit 1
  fi
  say "Compiling before resolving the relative mint start"
  forge build >/dev/null
  MINT_START=$(( $(date +%s) + MINT_START_DELAY ))
  export SHAPES_MINT_START="$MINT_START"
  echo "  mint start   $MINT_START (now + ${MINT_START_DELAY}s)"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN=1: simulating only, nothing will be broadcast or written"
  forge script script/Deploy.s.sol --rpc-url "$RPC"
  echo "dry run complete for $ENV_NAME"
  exit 0
fi

if [ "$RESUME" = "1" ]; then
  echo "RESUME=1: skipping broadcast, resuming post-broadcast steps from $BROADCAST_FILE"
  [ -f "$BROADCAST_FILE" ] \
    || { echo "refusing: RESUME=1 but no broadcast file at $BROADCAST_FILE" >&2; exit 1; }
else
  FORGE_ARGS=(script script/Deploy.s.sol --rpc-url "$RPC" "${WALLET_ARGS[@]}")
  [ -n "${DEPLOYER:-}" ] && FORGE_ARGS+=(--sender "$DEPLOYER")
  FORGE_ARGS+=(--broadcast)
  forge "${FORGE_ARGS[@]}"
fi

# --- postflight: resolve what actually got deployed, read it back on chain ---------------------

[ -f "$BROADCAST_FILE" ] || { echo "no broadcast file at $BROADCAST_FILE" >&2; exit 1; }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

contract_address() {
  jq -r --arg name "$1" \
    '.transactions[] | select(.contractName == $name and .transactionType == "CREATE") | .contractAddress' \
    "$BROADCAST_FILE" | tail -1 | tr '[:upper:]' '[:lower:]'
}

require_address() {
  local label="$1" address="$2"
  [[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] \
    || { echo "could not resolve $label from $BROADCAST_FILE" >&2; exit 1; }
  [ "$(cast code "$address" --rpc-url "$RPC")" != "0x" ] \
    || { echo "$label has no deployed code at $address" >&2; exit 1; }
}

require_address_read() {
  local label="$1" actual="$2" expected="$3"
  [ "$(lower "$actual")" = "$(lower "$expected")" ] \
    || { echo "$label mismatch: expected $expected, got $actual" >&2; exit 1; }
}

require_uint_read() {
  local label="$1" actual="$2" expected="$3"
  [ "${actual%% *}" = "$expected" ] \
    || { echo "$label mismatch: expected $expected, got $actual" >&2; exit 1; }
}

RENDERER=$(contract_address ShapeRenderer)
COLLECTION=$(contract_address ShapeCollection)
SHAPES=$(contract_address Shapes)
HOUSE=$(contract_address ShapeAuctionHouse)

require_address ShapeRenderer "$RENDERER"
require_address ShapeCollection "$COLLECTION"
require_address Shapes "$SHAPES"
require_address ShapeAuctionHouse "$HOUSE"

# Linked libraries are deployed before the script run and recorded separately by Foundry.
while IFS=: read -r source contract address; do
  [ -n "$address" ] || continue
  require_address "$contract" "$address"
done < <(jq -r '.libraries[]? // empty' "$BROADCAST_FILE")

# --- verify: forge verify-contract per contract and library, profile- and library-aware ---------
# A failure here is recorded, not fatal: the readback and the deployments/<chainId>.json record
# below always run regardless, and the run only reports failure (after writing the record) at the
# very end. --libraries carries the full set to every call; a contract or library that doesn't
# reference a given library ignores the extra flag.

VERIFY_FAILURES=()

if [ "$VERIFY" = "true" ]; then
  echo "Verifying contracts on Etherscan"

  LIB_FLAGS=()
  while IFS= read -r lib; do
    [ -n "$lib" ] || continue
    LIB_FLAGS+=(--libraries "$lib")
  done < <(jq -r '.libraries[]? // empty' "$BROADCAST_FILE")

  verify_one() {
    local fq_name="$1" bare_name="$2" address="$3"
    local ctor_types ctor_args=()
    ctor_types=$(forge inspect "$bare_name" abi --json 2>/dev/null \
      | jq -r '[.[] | select(.type=="constructor") | .inputs[].type] | join(",")')
    if [ -n "$ctor_types" ]; then
      local vals=()
      while IFS= read -r v; do vals+=("$v"); done < <(jq -r --arg name "$bare_name" \
        '.transactions[] | select(.transactionType=="CREATE" and .contractName==$name) | .arguments[]? // empty' \
        "$BROADCAST_FILE")
      ctor_args=(--constructor-args "$(cast abi-encode "constructor($ctor_types)" "${vals[@]}")")
    fi
    echo "  verifying $bare_name $address"
    if forge verify-contract "$address" "$fq_name" --chain "$CHAIN_ID" \
        --etherscan-api-key "$ETHERSCAN_API_KEY" "${LIB_FLAGS[@]}" "${ctor_args[@]}" --watch; then
      echo "  ok: verified $bare_name $address"
    else
      echo "  FAILED to verify $bare_name $address" >&2
      local retry="FOUNDRY_PROFILE=$FOUNDRY_PROFILE forge verify-contract $address $fq_name --chain $CHAIN_ID --etherscan-api-key \$ETHERSCAN_API_KEY ${LIB_FLAGS[*]} ${ctor_args[*]:-} --watch"
      VERIFY_FAILURES+=("$bare_name $address :: $retry")
    fi
  }

  verify_one src/ShapeRenderer.sol:ShapeRenderer ShapeRenderer "$RENDERER"
  verify_one src/ShapeCollection.sol:ShapeCollection ShapeCollection "$COLLECTION"
  verify_one src/Shapes.sol:Shapes Shapes "$SHAPES"
  verify_one src/ShapeAuctionHouse.sol:ShapeAuctionHouse ShapeAuctionHouse "$HOUSE"

  while IFS=: read -r source contract address; do
    [ -n "$address" ] || continue
    verify_one "${source}:${contract}" "$contract" "$address"
  done < <(jq -r '.libraries[]? // empty' "$BROADCAST_FILE")
fi

# --- readback: always runs, verification failures above notwithstanding -------------------------

# Foundry may broadcast independent CREATE transactions in a different order from the simulated
# `transactions` array. Resolve the creation hash from the mined receipt whose contract address
# is the actual Shapes address; pairing `contractName` with `.hash` can select another deployment.
SHAPES_TX=$(jq -r --arg shapes "$SHAPES" \
  '.receipts[] | select(.contractAddress != null) | select((.contractAddress | ascii_downcase) == ($shapes | ascii_downcase)) | .transactionHash' \
  "$BROADCAST_FILE" | tail -1)
[[ "$SHAPES_TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "could not resolve Shapes transaction" >&2; exit 1; }
SHAPES_RECEIPT=$(cast receipt "$SHAPES_TX" --rpc-url "$RPC" --json)
[ "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.status')" = "0x1" ] \
  || { echo "Shapes creation transaction did not succeed" >&2; exit 1; }
[ "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.contractAddress' | tr '[:upper:]' '[:lower:]')" \
    = "$(lower "$SHAPES")" ] \
  || { echo "Shapes creation transaction created another address" >&2; exit 1; }
FROM_BLOCK=$(cast to-dec "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.blockNumber')")

require_address_read admin "$(cast call "$SHAPES" 'admin()(address)' --rpc-url "$RPC")" "$EFFECTIVE_DEPLOYER"
require_address_read artist "$(cast call "$SHAPES" 'artist()(address)' --rpc-url "$RPC")" "$EFFECTIVE_DEPLOYER"
require_address_read owner "$(cast call "$SHAPES" 'owner()(address)' --rpc-url "$RPC")" "$EFFECTIVE_DEPLOYER"
require_address_read 'Shape #0 owner' \
  "$(cast call "$SHAPES" 'ownerOf(uint256)(address)' 0 --rpc-url "$RPC")" "$EFFECTIVE_DEPLOYER"
[ -z "${FEE_RECIPIENT:-}" ] || require_address_read 'fee recipient' \
  "$(cast call "$SHAPES" 'feeRecipient()(address)' --rpc-url "$RPC")" "$FEE_RECIPIENT"
require_address_read renderer "$(cast call "$SHAPES" 'renderer()(address)' --rpc-url "$RPC")" "$RENDERER"
require_address_read collection "$(cast call "$SHAPES" 'collection()(address)' --rpc-url "$RPC")" "$COLLECTION"
require_address_read 'collection renderer' \
  "$(cast call "$COLLECTION" 'renderer()(address)' --rpc-url "$RPC")" "$RENDERER"
require_address_read 'auction-house target' "$(cast call "$HOUSE" 'shapes()(address)' --rpc-url "$RPC")" "$SHAPES"

MINT_FEE_ONCHAIN=$(cast call "$SHAPES" 'mintFee()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
[ -z "${MINT_FEE_WEI:-}" ] || require_uint_read 'mint fee' "$MINT_FEE_ONCHAIN" "$MINT_FEE_WEI"
MINT_START_ONCHAIN=$(cast call "$SHAPES" 'mintStart()(uint64)' --rpc-url "$RPC" | awk '{print $1}')
echo "  mint start   $MINT_START_ONCHAIN"
[ -z "${MINT_START:-}" ] || require_uint_read 'mint start' "$MINT_START_ONCHAIN" "$MINT_START"
require_uint_read 'denomination count' "$(cast call "$SHAPES" 'denominationCount()(uint8)' --rpc-url "$RPC")" 9
require_uint_read 'Shape #0 denomination' \
  "$(cast call "$SHAPES" 'denomIndexOf(uint256)(uint8)' 0 --rpc-url "$RPC")" 0
require_uint_read 'owner token' "$(cast call "$SHAPES" 'ownerToken()(uint256)' --rpc-url "$RPC")" 0
require_uint_read 'auction count' "$(cast call "$HOUSE" 'auctionCount()(uint256)' --rpc-url "$RPC")" 0

[ "$(cast call "$SHAPES" 'artistReleaseHash()(bytes32)' --rpc-url "$RPC")" \
    = "0x0000000000000000000000000000000000000000000000000000000000000000" ] \
  || { echo "artist attribution unexpectedly signed during deployment" >&2; exit 1; }
[ "$(cast call "$SHAPES" 'artistSignature()(bytes)' --rpc-url "$RPC")" = "0x" ] \
  || { echo "artist signature unexpectedly populated during deployment" >&2; exit 1; }
[ "$(cast call "$SHAPES" 'exists(uint256)(bool)' 0 --rpc-url "$RPC")" = "true" ] \
  || { echo "Shape #0 is not live" >&2; exit 1; }
# The two discovery pointers. The market names the auction house the deploy just registered;
# positions starts empty because no positions contract exists. Neither is locked.
POSITIONS=$(cast call "$SHAPES" 'positions()(address,bool)' --rpc-url "$RPC")
MARKET=$(cast call "$SHAPES" 'market()(address,bool)' --rpc-url "$RPC")
echo "  positions    $POSITIONS" | tr '\n' ' '; echo
echo "  market       $MARKET" | tr '\n' ' '; echo
[ "$POSITIONS" = $'0x0000000000000000000000000000000000000000\nfalse' ] \
  || { echo "positions pointer did not start empty and unlocked" >&2; exit 1; }
# `cast call` returns a checksummed address; `contract_address` lowercases. Compare on one case.
[ "$(echo "$MARKET" | tr '[:upper:]' '[:lower:]')" = "$HOUSE"$'\nfalse' ] \
  || { echo "market pointer does not name the deployed auction house, unlocked" >&2; exit 1; }

echo "  ok: onchain readback matches the deploy"

# --- record the deployment: same key set and order as web/public/deployment.json, so cutover ----
# is a plain file copy. Always written, verification failures above notwithstanding.

mkdir -p deployments
DEPLOYMENT_FILE="deployments/${CHAIN_ID}.json"
jq -n \
  --arg rpc "$RPC" \
  --arg indexerUrl "${INDEXER_URL:-}" \
  --argjson chainId "$CHAIN_ID" \
  --arg shapes "$SHAPES" \
  --arg renderer "$RENDERER" \
  --arg collection "$COLLECTION" \
  --arg auctionHouse "$HOUSE" \
  --arg mintFeeWei "$MINT_FEE_ONCHAIN" \
  --arg mintStart "$MINT_START_ONCHAIN" \
  --argjson fromBlock "$FROM_BLOCK" \
  '{rpc:$rpc,indexerUrl:$indexerUrl,chainId:$chainId,shapes:$shapes,renderer:$renderer,collection:$collection,auctionHouse:$auctionHouse,mintFeeWei:$mintFeeWei,mintStart:$mintStart,fromBlock:$fromBlock}' \
  >"$DEPLOYMENT_FILE"

echo
echo "Deployed to $ENV_NAME (chain $CHAIN_ID)"
echo "  Shapes          $SHAPES"
echo "  ShapeRenderer   $RENDERER"
echo "  ShapeCollection $COLLECTION"
echo "  AuctionHouse    $HOUSE"
echo "  deployment tx   $SHAPES_TX"
echo "  from block      $FROM_BLOCK"
echo "  admin           $EFFECTIVE_DEPLOYER"
echo "  wrote           $DEPLOYMENT_FILE"

if [ "${#VERIFY_FAILURES[@]}" -gt 0 ]; then
  echo
  echo "verification failed for ${#VERIFY_FAILURES[@]} of the deployed contracts/libraries:" >&2
  for f in "${VERIFY_FAILURES[@]}"; do
    echo "  ${f%% :: *}" >&2
    echo "    retry: ${f#* :: }" >&2
  done
  exit 1
fi
