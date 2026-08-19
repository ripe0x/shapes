#!/usr/bin/env bash
# Deploy Shapes + ShapeRenderer to Sepolia AND verify both on Etherscan, in one step, so
# verification is never a forgotten follow-up. Verification runs inline via forge's --verify
# (constructor args are taken from the broadcast automatically); the [etherscan] block in
# foundry.toml maps sepolia to $ETHERSCAN_API_KEY.
#
# Requires:
#   ETHERSCAN_API_KEY   Etherscan v2 key (one key covers Sepolia).
#   the `ripe0x` foundry keystore (you are prompted for its password).
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
RPC="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
SENDER="${DEPLOYER:-0xCB43078C32423F5348Cab5885911C3B5faE217F9}"

SEED_ETH="${SEED_ETH:-false}" forge script script/DeploySepolia.s.sol \
  --rpc-url "$RPC" \
  --account ripe0x \
  --sender "$SENDER" \
  --broadcast \
  --verify
