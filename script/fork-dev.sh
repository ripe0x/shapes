#!/usr/bin/env bash
# Boot a mainnet-forked Anvil, deploy Shapes onto it, and write the addresses where the
# preview frontend's chain tester reads them. Then hold the chain open.
#
# Shapes reads no external contract, so the fork is only there to give a realistic block
# environment and funded accounts. A plain `anvil` would work identically.
#
#   ./script/fork-dev.sh                 # start it
#   cd preview && npm run dev            # in another shell
#   open http://localhost:5173/chain.html
#
# Ctrl-C stops the chain. The deployment file is regenerated on every run.
#
# To use a real browser wallet (MetaMask) instead of the built-in burner key, seed your own
# address so it has ETH to mint with:
#
#   SEED_WALLETS=0xYourAddress ./script/fork-dev.sh
#
# Each listed address is funded with SEED_ETH ether and has any inherited EIP-7702 delegation
# stripped, so ERC721 _safeMint treats it as an EOA. Point MetaMask at the local RPC printed
# below (chain id 31337) and connect that account.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FORK_URL=${FORK_URL:-https://ethereum-rpc.publicnode.com}
PORT=${PORT:-8545}
# A distinctive chain id, not the ubiquitous 31337. A browser wallet keys networks by chain id
# and reuses whatever RPC it already stored for that id, so sharing 31337 with another local
# node (e.g. a second anvil) silently routes transactions to the wrong one. A unique id forces
# the wallet to add this fork's own RPC. Override with CHAIN_ID if it still collides.
CHAIN_ID=${CHAIN_ID:-313370}
RPC="http://127.0.0.1:${PORT}"
# Anvil's first default account. Public, well-known, test-only.
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYMENT_FILE="$REPO_ROOT/preview/public/deployment.json"
# Comma-separated addresses to fund for browser-wallet use, and how much each gets.
SEED_WALLETS=${SEED_WALLETS:-}
SEED_ETH=${SEED_ETH:-1000}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Starting mainnet-forked Anvil on $RPC (fork: $FORK_URL)"
anvil --fork-url "$FORK_URL" --chain-id "$CHAIN_ID" --port "$PORT" >/tmp/shapes-anvil.log 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

# Wait for the RPC to answer.
for _ in $(seq 1 50); do
  if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil never came up; see /tmp/shapes-anvil.log"; exit 1; }

say "Deploying Shapes"
# A clean EOA with no code on mainnet. The deploy script's default (recipient = deployer)
# fails on a mainnet fork: anvil's account 0 carries an EIP-7702 delegation on real mainnet,
# so the script's no-contract-fee-recipient guard rejects it. Pass an empty address instead.
FEE_RECIPIENT=0x0000000000000000000000000000000000000FEE
OUT=$(SHAPES_FEE_RECIPIENT="$FEE_RECIPIENT" \
  forge script script/DeployShapes.s.sol --rpc-url "$RPC" --private-key "$PK0" --broadcast 2>&1)
SHAPES=$(echo "$OUT" | grep -oE 'Shapes\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
RENDERER=$(echo "$OUT" | grep -oE 'ShapeRenderer\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
MINT_FEE=$(cast call "$SHAPES" "mintFee()(uint256)" --rpc-url "$RPC" | awk '{print $1}')

[ -n "$SHAPES" ] && [ -n "$RENDERER" ] || { echo "could not parse deployed addresses"; echo "$OUT"; exit 1; }

if [ -n "$SEED_WALLETS" ]; then
  say "Seeding wallets with $SEED_ETH ETH each"
  SEED_HEX=$(cast to-hex "$(cast to-wei "$SEED_ETH" ether)")
  IFS=',' read -ra ADDRS <<<"$SEED_WALLETS"
  for a in "${ADDRS[@]}"; do
    a=$(echo "$a" | tr -d '[:space:]')
    [ -n "$a" ] || continue
    cast rpc anvil_setBalance "$a" "$SEED_HEX" --rpc-url "$RPC" >/dev/null
    # Strip any EIP-7702 delegation inherited from mainnet so _safeMint sees a plain EOA.
    cast rpc anvil_setCode "$a" 0x --rpc-url "$RPC" >/dev/null
    echo "  $a  ->  $SEED_ETH ETH"
  done
fi

mkdir -p "$(dirname "$DEPLOYMENT_FILE")"
cat >"$DEPLOYMENT_FILE" <<JSON
{
  "rpc": "$RPC",
  "chainId": $CHAIN_ID,
  "shapes": "$SHAPES",
  "renderer": "$RENDERER",
  "mintFee": "$MINT_FEE"
}
JSON

say "Ready"
echo "  Shapes        $SHAPES"
echo "  ShapeRenderer $RENDERER"
echo "  mint fee      $MINT_FEE wei"
echo "  wrote         $DEPLOYMENT_FILE"
echo
echo "  cd preview && npm run dev, then open http://localhost:5173/chain.html"
echo "  Ctrl-C to stop the chain."

wait $ANVIL_PID
