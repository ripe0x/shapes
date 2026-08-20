#!/usr/bin/env bash
# Boot a local Anvil, deploy Shapes onto it, and write the addresses where the preview
# frontend's chain tester reads them. Then hold the chain open.
#
# Shapes reads no external contract, so a plain local chain is all the frontend needs, and it
# avoids the mainnet-state hazards a fork drags in (EIP-7702 delegations on the default
# accounts, inherited nonces). Mainnet-fork behaviour is covered separately by test/Fork.t.sol.
# Set FORK_URL to fork mainnet anyway.
#
#   ./script/fork-dev.sh                 # start it
#   cd preview && npm run dev            # in another shell
#   open http://localhost:5173/chain.html
#
# Ctrl-C stops the chain. The deployment file is regenerated on every run.
#
# To mint from a browser wallet (MetaMask), seed your own address so it has ETH:
#
#   SEED_WALLETS=0xYourAddress ./script/fork-dev.sh
#
# Each listed address is funded with SEED_ETH ether. Point MetaMask at the local RPC and chain
# id printed below and connect that account.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Empty by default: a plain local chain. Set FORK_URL to a mainnet RPC to fork instead.
FORK_URL=${FORK_URL:-}
PORT=${PORT:-8545}
# Anvil's default chain id, which browser wallets already have configured for localhost:8545.
# Caveat: a wallet keys networks by chain id, so another local node also on 31337 (a second
# anvil, a Hardhat chain) can silently receive transactions meant for this one. Override with
# CHAIN_ID when running more than one local chain.
CHAIN_ID=${CHAIN_ID:-31337}
RPC="http://127.0.0.1:${PORT}"
# Anvil's first default account. Public, well-known, test-only.
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYMENT_FILE="$REPO_ROOT/preview/public/deployment.json"
# Comma-separated addresses to fund for browser-wallet use, and how much each gets.
# Defaults to the dev browser wallet so the UI is usable immediately after spin-up.
SEED_WALLETS=${SEED_WALLETS:-0xCB43078C32423F5348Cab5885911C3B5faE217F9}
SEED_ETH=${SEED_ETH:-1000}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --gas-limit (finite, high): the simulation builds a genuine apex Complete (10,000 x 0.01
# minted then composed into one 100 ETH token, so it can be sacrificed). That single mint
# batch and its compose each burn far past a mainnet block's gas, which is fine on a local
# dev chain used only for browsing. Normal txs are unaffected.
if [ -n "$FORK_URL" ]; then
  say "Starting mainnet-forked Anvil on $RPC (fork: $FORK_URL, chain $CHAIN_ID)"
  anvil --fork-url "$FORK_URL" --chain-id "$CHAIN_ID" --port "$PORT" --gas-limit 500000000 >/tmp/shapes-anvil.log 2>&1 &
else
  say "Starting local Anvil on $RPC (chain $CHAIN_ID)"
  anvil --chain-id "$CHAIN_ID" --port "$PORT" --gas-limit 500000000 >/tmp/shapes-anvil.log 2>&1 &
fi
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

# Wait for the RPC to answer.
for _ in $(seq 1 50); do
  if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil never came up; see /tmp/shapes-anvil.log"; exit 1; }

say "Deploying Shapes"
# The deploy script only defaults the fee recipient to the deployer on chain id 31337; on any
# other chain it requires SHAPES_FEE_RECIPIENT to be set explicitly. Pass a clean empty EOA
# (also the right choice on a fork, where account 0 carries an EIP-7702 delegation the script's
# no-contract-fee-recipient guard would reject).
FEE_RECIPIENT=0x0000000000000000000000000000000000000FEE
OUT=$(SHAPES_FEE_RECIPIENT="$FEE_RECIPIENT" \
  forge script script/DeployShapes.s.sol --rpc-url "$RPC" --private-key "$PK0" --broadcast 2>&1)
SHAPES=$(echo "$OUT" | grep -oE 'Shapes\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
RENDERER=$(echo "$OUT" | grep -oE 'ShapeRenderer\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
COLLECTION=$(echo "$OUT" | grep -oE 'ShapeCollection\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
HOUSE=$(echo "$OUT" | grep -oE 'AuctionHouse\s+0x[0-9a-fA-F]{40}' | tail -1 | grep -oE '0x[0-9a-fA-F]{40}')
FEE_BPS=$(cast call "$SHAPES" "feeBps()(uint256)" --rpc-url "$RPC" | awk '{print $1}')

[ -n "$SHAPES" ] && [ -n "$RENDERER" ] || { echo "could not parse deployed addresses"; echo "$OUT"; exit 1; }

if [ -n "$SEED_WALLETS" ]; then
  say "Seeding wallets with $SEED_ETH ETH each"
  SEED_HEX=$(cast to-hex "$(cast to-wei "$SEED_ETH" ether)")
  IFS=',' read -ra ADDRS <<<"$SEED_WALLETS"
  for a in "${ADDRS[@]}"; do
    a=$(echo "$a" | tr -d '[:space:]')
    [ -n "$a" ] || continue
    cast rpc anvil_setBalance "$a" "$SEED_HEX" --rpc-url "$RPC" >/dev/null
    # No-op on a plain chain; when forking, strips any inherited EIP-7702 delegation so
    # _safeMint sees a plain EOA.
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
  "collection": "$COLLECTION",
  "auctionHouse": "$HOUSE",
  "feeBps": "$FEE_BPS"
}
JSON

say "Ready"
echo "  Shapes        $SHAPES"
echo "  ShapeRenderer $RENDERER"
echo "  ShapeCollection $COLLECTION"
echo "  AuctionHouse  $HOUSE"
echo "  fee (bps)     $FEE_BPS"
echo "  wrote         $DEPLOYMENT_FILE"
echo
echo "  cd preview && npm run dev, then open http://localhost:5173/chain.html"
echo "  Ctrl-C to stop the chain."

wait $ANVIL_PID
