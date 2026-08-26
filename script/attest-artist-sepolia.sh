#!/usr/bin/env bash
# Submit the deployer's one-time artist signature after a fresh Sepolia deployment.
# The caller supplies the exact release hash. Never create multiple valid signatures for
# competing hashes: anyone holding an older valid signature can win the one-time slot.
set -euo pipefail

: "${SEPOLIA_RPC_URL:=https://ethereum-sepolia-rpc.publicnode.com}"
: "${SHAPES_ADDRESS:?set SHAPES_ADDRESS to the freshly deployed Shapes contract}"
: "${SHAPES_RELEASE_HASH:?set SHAPES_RELEASE_HASH to the exact bytes32 approved by the artist}"
: "${ARTIST_ACCOUNT:=ripe0x}"

if [[ ! "$SHAPES_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "SHAPES_ADDRESS must be a 20-byte hex address" >&2
  exit 1
fi
if [[ ! "$SHAPES_RELEASE_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "SHAPES_RELEASE_HASH must be an exact bytes32 hex value" >&2
  exit 1
fi

CHAIN_ID=$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")
if [ "$CHAIN_ID" != "11155111" ]; then
  echo "refusing artist attestation on chain $CHAIN_ID; this script is Sepolia-only" >&2
  exit 1
fi

ARTIST=$(cast call "$SHAPES_ADDRESS" "artist()(address)" --rpc-url "$SEPOLIA_RPC_URL")
ATTRIBUTION=$(cast call "$SHAPES_ADDRESS" "artistAttribution()(address)" --rpc-url "$SEPOLIA_RPC_URL")
BOUND_SHAPES=$(cast call "$ATTRIBUTION" "shapes()(address)" --rpc-url "$SEPOLIA_RPC_URL")
BOUND_ARTIST=$(cast call "$ATTRIBUTION" "artist()(address)" --rpc-url "$SEPOLIA_RPC_URL")
ATTESTED=$(cast call "$ATTRIBUTION" "attested()(bool)" --rpc-url "$SEPOLIA_RPC_URL")

BOUND_SHAPES_LOWER=$(printf '%s' "$BOUND_SHAPES" | tr '[:upper:]' '[:lower:]')
SHAPES_ADDRESS_LOWER=$(printf '%s' "$SHAPES_ADDRESS" | tr '[:upper:]' '[:lower:]')
BOUND_ARTIST_LOWER=$(printf '%s' "$BOUND_ARTIST" | tr '[:upper:]' '[:lower:]')
ARTIST_LOWER=$(printf '%s' "$ARTIST" | tr '[:upper:]' '[:lower:]')

[ "$BOUND_SHAPES_LOWER" = "$SHAPES_ADDRESS_LOWER" ] || { echo "attribution points at another Shapes" >&2; exit 1; }
[ "$BOUND_ARTIST_LOWER" = "$ARTIST_LOWER" ] || { echo "attribution artist mismatch" >&2; exit 1; }
[ "$ATTESTED" = "false" ] || { echo "artist attribution is already signed" >&2; exit 1; }

DIGEST=$(cast call "$ATTRIBUTION" "attestationDigest(bytes32)(bytes32)" \
  "$SHAPES_RELEASE_HASH" --rpc-url "$SEPOLIA_RPC_URL")

echo "One-time Sepolia artist attestation"
echo "  chain id       $CHAIN_ID"
echo "  Shapes         $SHAPES_ADDRESS"
echo "  attribution    $ATTRIBUTION"
echo "  artist         $ARTIST"
echo "  release hash   $SHAPES_RELEASE_HASH"
echo "  EIP-712 digest $DIGEST"
echo
echo "This signature is permanent once submitted. Confirm the release-hash preimage separately."
read -r -p "Type the exact release hash to sign: " CONFIRM_HASH
[ "$CONFIRM_HASH" = "$SHAPES_RELEASE_HASH" ] || { echo "release hash confirmation did not match" >&2; exit 1; }

SIGNATURE=$(cast wallet sign --account "$ARTIST_ACCOUNT" --no-hash "$DIGEST")

# Simulate the exact call before broadcasting. The account may be an EIP-7702 delegated EOA;
# the attribution contract checks its ECDSA key before falling back to ERC-1271.
cast call "$ATTRIBUTION" "attest(bytes32,bytes)" "$SHAPES_RELEASE_HASH" "$SIGNATURE" \
  --from "$ARTIST" --rpc-url "$SEPOLIA_RPC_URL" >/dev/null

read -r -p "Type SIGN to broadcast the irreversible Sepolia attestation: " CONFIRM_SEND
[ "$CONFIRM_SEND" = "SIGN" ] || { echo "not submitted"; exit 1; }

TX_JSON=$(cast send "$ATTRIBUTION" "attest(bytes32,bytes)" "$SHAPES_RELEASE_HASH" "$SIGNATURE" \
  --account "$ARTIST_ACCOUNT" --rpc-url "$SEPOLIA_RPC_URL" --json)
TX_HASH=$(printf '%s' "$TX_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])")
cast receipt "$TX_HASH" --confirmations 1 --rpc-url "$SEPOLIA_RPC_URL" >/dev/null
echo "  transaction    $TX_HASH"

[ "$(cast call "$ATTRIBUTION" "attested()(bool)" --rpc-url "$SEPOLIA_RPC_URL")" = "true" ] \
  || { echo "postflight attested read failed" >&2; exit 1; }
STORED_HASH=$(cast call "$ATTRIBUTION" "releaseHash()(bytes32)" --rpc-url "$SEPOLIA_RPC_URL")
STORED_HASH_LOWER=$(printf '%s' "$STORED_HASH" | tr '[:upper:]' '[:lower:]')
RELEASE_HASH_LOWER=$(printf '%s' "$SHAPES_RELEASE_HASH" | tr '[:upper:]' '[:lower:]')
[ "$STORED_HASH_LOWER" = "$RELEASE_HASH_LOWER" ] \
  || { echo "postflight release hash mismatch" >&2; exit 1; }

echo "Artist attestation stored and read back successfully."
