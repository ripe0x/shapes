#!/usr/bin/env bash
# Deploy the full Shapes suite to Sepolia AND verify every contract on Etherscan in one step, so
# verification is never a forgotten follow-up. Verification runs inline via forge's --verify
# (constructor args are taken from the broadcast automatically); the [etherscan] block in
# foundry.toml maps sepolia to $ETHERSCAN_API_KEY.
#
# Requires:
#   ETHERSCAN_API_KEY   Etherscan v2 key (one key covers Sepolia).
#   the `ripe0x` foundry keystore (you are prompted for its password).
#   jq                   reads the broadcast artifact for child verification.
#
# Optional env:
#   SEPOLIA_RPC_URL     defaults to the publicnode endpoint.
#   DEPLOYER            sender address; defaults to the ripe0x keystore address.
#   SEED_ETH            "true" to also mint the seed spread (deploy-only by default, since the
#                       in-script seed can trip forge's gas estimation; seed from the UI instead).
#
# Usage:
#   ETHERSCAN_API_KEY=... script/deploy-sepolia.sh
set -euo pipefail

: "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY (Etherscan v2 key)}"
command -v jq >/dev/null || { echo "jq is required to verify the attribution child" >&2; exit 1; }
RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
SENDER="${DEPLOYER:-0xCB43078C32423F5348Cab5885911C3B5faE217F9}"
PAYOUT="0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4"

FOUNDRY_PROFILE=testnet SEED_ETH="${SEED_ETH:-false}" forge script script/DeploySepolia.s.sol \
  --rpc-url "$RPC" \
  --account ripe0x \
  --sender "$SENDER" \
  --broadcast \
  --verify

# Shapes creates the attribution child inside its constructor, so it is not a top-level script
# deployment for Foundry to verify automatically. Resolve it from the freshly deployed Shapes,
# verify it explicitly, then repeat the immutable binding checks against Sepolia.
BROADCAST_FILE="broadcast/DeploySepolia.s.sol/11155111/run-latest.json"
SHAPES=$(jq -r '.transactions[] | select(.contractName == "Shapes") | .contractAddress' "$BROADCAST_FILE" | tail -1)
SHAPES_TX=$(jq -r '.transactions[] | select(.contractName == "Shapes") | .hash' "$BROADCAST_FILE" | tail -1)

[[ "$SHAPES" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "could not resolve Shapes from $BROADCAST_FILE" >&2; exit 1; }
[[ "$SHAPES_TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "could not resolve Shapes transaction" >&2; exit 1; }

ARTIST=$(cast call "$SHAPES" "artist()(address)" --rpc-url "$RPC")
ATTRIBUTION=$(cast call "$SHAPES" "artistAttribution()(address)" --rpc-url "$RPC")
CONSTRUCTOR_ARGS=$(cast abi-encode "constructor(address)" "$ARTIST")

FOUNDRY_PROFILE=testnet forge verify-contract "$ATTRIBUTION" \
  src/ShapesArtistAttribution.sol:ShapesArtistAttribution \
  --chain sepolia \
  --rpc-url "$RPC" \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args "$CONSTRUCTOR_ARGS" \
  --creation-transaction-hash "$SHAPES_TX" \
  --watch

[ "$(cast call "$ATTRIBUTION" "shapes()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')" \
    = "$(printf '%s' "$SHAPES" | tr '[:upper:]' '[:lower:]')" ] \
  || { echo "artist attribution points at another Shapes" >&2; exit 1; }
[ "$(cast call "$ATTRIBUTION" "artist()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')" \
    = "$(printf '%s' "$ARTIST" | tr '[:upper:]' '[:lower:]')" ] \
  || { echo "artist attribution artist mismatch" >&2; exit 1; }
[ "$(cast call "$ATTRIBUTION" "attested()(bool)" --rpc-url "$RPC")" = "false" ] \
  || { echo "artist attribution unexpectedly signed during deployment" >&2; exit 1; }
[ "$(cast call "$SHAPES" "admin()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')" \
    = "$(printf '%s' "$SENDER" | tr '[:upper:]' '[:lower:]')" ] \
  || { echo "admin is not the deployer" >&2; exit 1; }
[ "$(cast call "$SHAPES" "feeRecipient()(address)" --rpc-url "$RPC" | tr '[:upper:]' '[:lower:]')" \
    = "$(printf '%s' "$PAYOUT" | tr '[:upper:]' '[:lower:]')" ] \
  || { echo "fee recipient mismatch" >&2; exit 1; }

echo "Fresh Sepolia deployment verified"
echo "  Shapes             $SHAPES"
echo "  deployment tx      $SHAPES_TX"
echo "  artist             $ARTIST"
echo "  artist attribution $ATTRIBUTION"
echo "  admin              $SENDER"
echo "  fee recipient      $PAYOUT"
