#!/usr/bin/env bash
# Deploy the full Shapes suite to Sepolia AND verify every contract on Etherscan in one step, so
# verification is never a forgotten follow-up. Verification runs inline via forge's --verify
# (constructor args are taken from the broadcast automatically); the [etherscan] block in
# foundry.toml maps sepolia to $ETHERSCAN_API_KEY.
#
# Requires:
#   ETHERSCAN_API_KEY   Etherscan v2 key (one key covers Sepolia).
#   the `ripe0x` foundry keystore (you are prompted for its password).
#   jq                   reads the broadcast artifact and mined receipts.
#
# Optional env:
#   SEPOLIA_RPC_URL     defaults to the publicnode endpoint.
#   DEPLOYER            sender address; defaults to the ripe0x keystore address.
#   KEYSTORE_PASSWORD_FILE  read the keystore password from this chmod-600 file instead of a
#                           prompt. The password is never placed in the process arguments.
#   SEED_ETH            "true" to also mint the seed spread (deploy-only by default, since the
#                       in-script seed can trip forge's gas estimation; seed from the UI instead).
#
# Usage:
#   ETHERSCAN_API_KEY=... script/deploy-sepolia.sh
set -euo pipefail

: "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY (Etherscan v2 key)}"
command -v jq >/dev/null || { echo "jq is required to inspect the deployment" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required to confirm Etherscan verification" >&2; exit 1; }
PUBLIC_RPC="https://ethereum-sepolia-rpc.publicnode.com"
RPC="${SEPOLIA_RPC_URL:-$PUBLIC_RPC}"
SENDER="${DEPLOYER:-0xCB43078C32423F5348Cab5885911C3B5faE217F9}"
PAYOUT="0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4"
SEED="${SEED_ETH:-false}"
MINT_FEE="${SHAPES_MINT_FEE_WEI:-10000000000000}"
WALLET_ARGS=(--account ripe0x)
if [ -n "${KEYSTORE_PASSWORD_FILE:-}" ]; then
  [ -r "$KEYSTORE_PASSWORD_FILE" ] \
    || { echo "KEYSTORE_PASSWORD_FILE is not readable" >&2; exit 1; }
  WALLET_ARGS=(--keystore "$HOME/.foundry/keystores/ripe0x" --password-file "$KEYSTORE_PASSWORD_FILE")
fi

[ "$MINT_FEE" = "10000000000000" ] \
  || { echo "Sepolia fee must remain 0.00001 ETH per Shape" >&2; exit 1; }
[ "$(cast chain-id --rpc-url "$RPC")" = "11155111" ] \
  || { echo "refusing deployment: RPC is not Sepolia" >&2; exit 1; }
[ "$(cast code "$PAYOUT" --rpc-url "$RPC")" = "0x" ] \
  || { echo "approved fee recipient unexpectedly has code" >&2; exit 1; }

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
[ "$(git -C "$REPO_ROOT" branch --show-current)" = "main" ] \
  || { echo "deployments must run from the main branch" >&2; exit 1; }
git -C "$REPO_ROOT" fetch --quiet origin main
[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$(git -C "$REPO_ROOT" rev-parse origin/main)" ] \
  || { echo "local main is not the fetched origin/main commit" >&2; exit 1; }
git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet \
  || { echo "tracked files are dirty; deployment commit is not exact" >&2; exit 1; }
[ -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ] \
  || { echo "untracked files exist; deployment commit is not exact" >&2; exit 1; }

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

wait_for_verification() {
  local label="$1" address="$2" response source
  for _ in $(seq 1 8); do
    response=$(curl -fsS --get 'https://api.etherscan.io/v2/api' \
      --data-urlencode 'chainid=11155111' \
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

FOUNDRY_PROFILE=testnet SHAPES_MINT_FEE_WEI="$MINT_FEE" SEED_ETH="$SEED" \
  forge script script/DeploySepolia.s.sol \
  --rpc-url "$RPC" \
  "${WALLET_ARGS[@]}" \
  --sender "$SENDER" \
  --broadcast \
  --verify

# Resolve the freshly deployed Shapes address and its actual mined creation transaction.
BROADCAST_FILE="broadcast/DeploySepolia.s.sol/11155111/run-latest.json"
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
# `transactions` array. Resolve the creation hash from the mined receipt whose contract address is
# the actual Shapes address; pairing `contractName` with `.hash` can select another deployment.
SHAPES_TX=$(jq -r --arg shapes "$SHAPES" \
  '.receipts[] | select((.contractAddress | ascii_downcase) == ($shapes | ascii_downcase)) | .transactionHash' \
  "$BROADCAST_FILE" | tail -1)
[[ "$SHAPES_TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "could not resolve Shapes transaction" >&2; exit 1; }
SHAPES_RECEIPT=$(cast receipt "$SHAPES_TX" --rpc-url "$RPC" --json)
[ "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.status')" = "0x1" ] \
  || { echo "Shapes creation transaction did not succeed" >&2; exit 1; }
[ "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.contractAddress' | tr '[:upper:]' '[:lower:]')" \
    = "$(printf '%s' "$SHAPES" | tr '[:upper:]' '[:lower:]')" ] \
  || { echo "Shapes creation transaction created another address" >&2; exit 1; }
FROM_BLOCK=$(cast to-dec "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.blockNumber')")

ARTIST=$(cast call "$SHAPES" "artist()(address)" --rpc-url "$RPC")
[ "$(cast chain-id --rpc-url "$RPC")" = "11155111" ] \
  || { echo "postflight RPC is not Sepolia" >&2; exit 1; }
[ "$(cast call "$SHAPES" "artistReleaseHash()(bytes32)" --rpc-url "$RPC")" \
    = "0x0000000000000000000000000000000000000000000000000000000000000000" ] \
  || { echo "artist attribution unexpectedly signed during deployment" >&2; exit 1; }
[ "$(cast call "$SHAPES" "artistSignature()(bytes)" --rpc-url "$RPC")" = "0x" ] \
  || { echo "artist signature unexpectedly populated during deployment" >&2; exit 1; }
require_address_read admin "$(cast call "$SHAPES" 'admin()(address)' --rpc-url "$RPC")" "$SENDER"
require_address_read artist "$ARTIST" "$SENDER"
require_address_read owner "$(cast call "$SHAPES" 'owner()(address)' --rpc-url "$RPC")" "$SENDER"
require_address_read 'Shape #0 owner' "$(cast call "$SHAPES" 'ownerOf(uint256)(address)' 0 --rpc-url "$RPC")" "$SENDER"
require_address_read 'fee recipient' "$(cast call "$SHAPES" 'feeRecipient()(address)' --rpc-url "$RPC")" "$PAYOUT"
require_address_read renderer "$(cast call "$SHAPES" 'renderer()(address)' --rpc-url "$RPC")" "$RENDERER"
require_address_read collection "$(cast call "$SHAPES" 'collection()(address)' --rpc-url "$RPC")" "$COLLECTION"
require_address_read 'collection renderer' "$(cast call "$COLLECTION" 'renderer()(address)' --rpc-url "$RPC")" "$RENDERER"
require_address_read 'lens target' "$(cast call "$LENS" 'shapes()(address)' --rpc-url "$RPC")" "$SHAPES"
require_address_read 'auction-house target' "$(cast call "$HOUSE" 'shapes()(address)' --rpc-url "$RPC")" "$SHAPES"

require_uint_read 'mint fee' "$(cast call "$SHAPES" 'mintFee()(uint256)' --rpc-url "$RPC")" 10000000000000
require_uint_read 'denomination count' "$(cast call "$SHAPES" 'denominationCount()(uint8)' --rpc-url "$RPC")" 9
require_uint_read 'testnet minimum denomination' \
  "$(cast call "$SHAPES" 'denominationAt(uint8)(uint256)' 0 --rpc-url "$RPC")" 100000000000000
require_uint_read 'Shape #0 denomination' "$(cast call "$SHAPES" 'denomIndexOf(uint256)(uint8)' 0 --rpc-url "$RPC")" 0
require_uint_read 'Shape #0 backing' \
  "$(cast call "$SHAPES" 'backingOf(uint256)(uint256)' 0 --rpc-url "$RPC")" 100000000000000
EXPECTED_AUCTIONS=0
[ "$SEED" = "true" ] && EXPECTED_AUCTIONS=1
require_uint_read 'auction count' \
  "$(cast call "$HOUSE" 'auctionCount()(uint256)' --rpc-url "$RPC")" "$EXPECTED_AUCTIONS"
[ "$(cast call "$LENS" 'exists(uint256)(bool)' 0 --rpc-url "$RPC")" = "true" ] \
  || { echo "Shape #0 is not live" >&2; exit 1; }
POSITIONS=$(cast call "$SHAPES" 'positions()(address,bool)' --rpc-url "$RPC")
MARKET=$(cast call "$SHAPES" 'market()(address,bool)' --rpc-url "$RPC")
[ "$POSITIONS" = $'0x0000000000000000000000000000000000000000\nfalse' ] \
  || { echo "positions pointer did not start empty and unlocked" >&2; exit 1; }
[ "$MARKET" = $'0x0000000000000000000000000000000000000000\nfalse' ] \
  || { echo "market pointer did not start empty and unlocked" >&2; exit 1; }

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

SUMMARY_FILE="broadcast/DeploySepolia.s.sol/11155111/deployment-summary.json"
jq -n \
  --arg rpc "$PUBLIC_RPC" \
  --argjson chainId 11155111 \
  --arg renderer "$RENDERER" \
  --arg collection "$COLLECTION" \
  --arg shapes "$SHAPES" \
  --arg lens "$LENS" \
  --arg auctionHouse "$HOUSE" \
  --arg deploymentTx "$SHAPES_TX" \
  --argjson fromBlock "$FROM_BLOCK" \
  --arg mintFeeWei "10000000000000" \
  '{rpc:$rpc,chainId:$chainId,renderer:$renderer,collection:$collection,shapes:$shapes,lens:$lens,auctionHouse:$auctionHouse,deploymentTx:$deploymentTx,mintFeeWei:$mintFeeWei,fromBlock:$fromBlock}' \
  > "$SUMMARY_FILE"

echo "Fresh Sepolia deployment verified"
echo "  ShapeRenderer      $RENDERER"
echo "  ShapeCollection    $COLLECTION"
echo "  Shapes             $SHAPES"
echo "  ShapeLens          $LENS"
echo "  AuctionHouse       $HOUSE"
echo "  deployment tx      $SHAPES_TX"
echo "  from block         $FROM_BLOCK"
echo "  artist             $ARTIST"
echo "  artist signature   unsigned"
echo "  admin              $SENDER"
echo "  fee recipient      $PAYOUT"
echo "  summary            $SUMMARY_FILE"
