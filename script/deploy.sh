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
#   DRY_RUN=1                                     simulate only: the REQUIRE_MAIN git guards
#                                                  (branch, fetched origin/main, clean tree, no
#                                                  untracked files) still run, but a failure only
#                                                  warns instead of exiting, since a real run would
#                                                  refuse. Every other guard still hard-fails. Only
#                                                  the wallet, --broadcast and --verify are skipped,
#                                                  and the run stops after the simulation. Nothing
#                                                  is written.
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

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

DRY_RUN="${DRY_RUN:-0}"

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

echo "== deploy.sh $ENV_NAME =="
echo "  rpc      $RPC"
echo "  profile  $FOUNDRY_PROFILE"
echo "  dry run  $DRY_RUN"

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
# Otherwise FEE_RECIPIENT is empty by design (anvil): pass through whatever the caller already
# exported as SHAPES_FEE_RECIPIENT (fork-dev.sh does this), or leave it unset so Deploy.s.sol
# defaults to the deployer on chain id 31337.

# --- guards: identical code path for every target, switched only by the env file's values ------

ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$ACTUAL_CHAIN_ID" = "$CHAIN_ID" ] \
  || { echo "refusing: $RPC reports chain id $ACTUAL_CHAIN_ID, expected $CHAIN_ID" >&2; exit 1; }
echo "  ok: chain id $ACTUAL_CHAIN_ID"

if [ "$REQUIRE_MAIN" = "true" ]; then
  # A real run refuses on any failure here. Under DRY_RUN=1 the same checks still run, but a
  # failure only warns what a real run would refuse, so the rest of the simulation can proceed.
  git_guard_fail() {
    if [ "$DRY_RUN" = "1" ]; then
      echo "  warn: real run would refuse: $1" >&2
    else
      echo "refusing: $1" >&2
      exit 1
    fi
  }

  [ "$(git branch --show-current)" = "main" ] \
    || git_guard_fail "deployments must run from main"
  git fetch --quiet origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
    || git_guard_fail "local main is not the fetched origin/main commit"
  git diff --quiet && git diff --cached --quiet \
    || git_guard_fail "tracked files are dirty; deployment commit is not exact"
  # deployments/ is written by a previous deploy, not an input to this one; untracked files
  # there don't make the deployment commit inexact.
  [ -z "$(git ls-files --others --exclude-standard -- . ':!deployments')" ] \
    || git_guard_fail "untracked files exist; deployment commit is not exact"
  [ "$DRY_RUN" = "1" ] || echo "  ok: clean, exact, fetched main"
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

FORGE_ARGS=(script script/Deploy.s.sol --rpc-url "$RPC")
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN=1: simulating only, nothing will be broadcast or written"
else
  FORGE_ARGS+=("${WALLET_ARGS[@]}")
  [ -n "${DEPLOYER:-}" ] && FORGE_ARGS+=(--sender "$DEPLOYER")
  FORGE_ARGS+=(--broadcast)
  [ "$VERIFY" = "true" ] && FORGE_ARGS+=(--verify)
fi

FOUNDRY_PROFILE="$FOUNDRY_PROFILE" forge "${FORGE_ARGS[@]}"

if [ "$DRY_RUN" = "1" ]; then
  echo "dry run complete for $ENV_NAME"
  exit 0
fi

# --- postflight: resolve what actually got deployed, read it back on chain ---------------------

BROADCAST_FILE="broadcast/Deploy.s.sol/${CHAIN_ID}/run-latest.json"
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
LENS=$(contract_address ShapeLens)
HOUSE=$(contract_address ShapeAuctionHouse)

require_address ShapeRenderer "$RENDERER"
require_address ShapeCollection "$COLLECTION"
require_address Shapes "$SHAPES"
require_address ShapeLens "$LENS"
require_address ShapeAuctionHouse "$HOUSE"

# Linked libraries are deployed before the script run and recorded separately by Foundry.
while IFS=: read -r source contract address; do
  [ -n "$address" ] || continue
  require_address "$contract" "$address"
done < <(jq -r '.libraries[]? // empty' "$BROADCAST_FILE")

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
require_address_read 'lens target' "$(cast call "$LENS" 'shapes()(address)' --rpc-url "$RPC")" "$SHAPES"
require_address_read 'auction-house target' "$(cast call "$HOUSE" 'shapes()(address)' --rpc-url "$RPC")" "$SHAPES"

MINT_FEE_ONCHAIN=$(cast call "$SHAPES" 'mintFee()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
[ -z "${MINT_FEE_WEI:-}" ] || require_uint_read 'mint fee' "$MINT_FEE_ONCHAIN" "$MINT_FEE_WEI"
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
[ "$(cast call "$LENS" 'exists(uint256)(bool)' 0 --rpc-url "$RPC")" = "true" ] \
  || { echo "Shape #0 is not live" >&2; exit 1; }
POSITIONS=$(cast call "$SHAPES" 'positions()(address,bool)' --rpc-url "$RPC")
MARKET=$(cast call "$SHAPES" 'market()(address,bool)' --rpc-url "$RPC")
[ "$POSITIONS" = $'0x0000000000000000000000000000000000000000\nfalse' ] \
  || { echo "positions pointer did not start empty and unlocked" >&2; exit 1; }
[ "$MARKET" = $'0x0000000000000000000000000000000000000000\nfalse' ] \
  || { echo "market pointer did not start empty and unlocked" >&2; exit 1; }

echo "  ok: onchain readback matches the deploy"

if [ "$VERIFY" = "true" ]; then
  command -v curl >/dev/null || { echo "curl is required to confirm Etherscan verification" >&2; exit 1; }

  wait_for_verification() {
    local label="$1" address="$2" response source
    for _ in $(seq 1 8); do
      response=$(curl -fsS --get 'https://api.etherscan.io/v2/api' \
        --data-urlencode "chainid=$CHAIN_ID" \
        --data-urlencode 'module=contract' \
        --data-urlencode 'action=getsourcecode' \
        --data-urlencode "address=$address" \
        --data-urlencode "apikey=$ETHERSCAN_API_KEY" || true)
      source=$(printf '%s' "$response" | jq -r '.result[0].SourceCode // empty' 2>/dev/null || true)
      if [ -n "$source" ]; then
        echo "  verified source   $label $address"
        return 0
      fi
      sleep 5
    done
    echo "$label source is not visible through Etherscan after 40 seconds: $address" >&2
    return 1
  }

  echo "Confirming verified source on Etherscan"
  wait_for_verification ShapeRenderer "$RENDERER"
  wait_for_verification ShapeCollection "$COLLECTION"
  wait_for_verification Shapes "$SHAPES"
  wait_for_verification ShapeLens "$LENS"
  wait_for_verification ShapeAuctionHouse "$HOUSE"
  while IFS=: read -r source contract address; do
    [ -n "$address" ] || continue
    wait_for_verification "$contract" "$address"
  done < <(jq -r '.libraries[]? // empty' "$BROADCAST_FILE")
fi

# --- record the deployment: same key set and order as web/public/deployment.json, so cutover ----
# is a plain file copy.

mkdir -p deployments
DEPLOYMENT_FILE="deployments/${CHAIN_ID}.json"
jq -n \
  --arg rpc "$RPC" \
  --arg indexerUrl "${INDEXER_URL:-}" \
  --argjson chainId "$CHAIN_ID" \
  --arg shapes "$SHAPES" \
  --arg renderer "$RENDERER" \
  --arg collection "$COLLECTION" \
  --arg lens "$LENS" \
  --arg auctionHouse "$HOUSE" \
  --arg mintFeeWei "$MINT_FEE_ONCHAIN" \
  --argjson fromBlock "$FROM_BLOCK" \
  '{rpc:$rpc,indexerUrl:$indexerUrl,chainId:$chainId,shapes:$shapes,renderer:$renderer,collection:$collection,lens:$lens,auctionHouse:$auctionHouse,mintFeeWei:$mintFeeWei,fromBlock:$fromBlock}' \
  >"$DEPLOYMENT_FILE"

echo
echo "Deployed to $ENV_NAME (chain $CHAIN_ID)"
echo "  Shapes          $SHAPES"
echo "  ShapeRenderer   $RENDERER"
echo "  ShapeCollection $COLLECTION"
echo "  ShapeLens       $LENS"
echo "  AuctionHouse    $HOUSE"
echo "  deployment tx   $SHAPES_TX"
echo "  from block      $FROM_BLOCK"
echo "  admin           $EFFECTIVE_DEPLOYER"
echo "  wrote           $DEPLOYMENT_FILE"
