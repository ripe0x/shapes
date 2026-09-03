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
# Fixed at Anvil's default chain id: Deploy.s.sol only accepts chain id 1, 11155111 or 31337
# (script/Deploy.s.sol), and script/env/anvil.env pins script/deploy.sh anvil to 31337, so no
# other chain id would deploy successfully here.
CHAIN_ID=31337
RPC="http://127.0.0.1:${PORT}"
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
  anvil --fork-url "$FORK_URL" --chain-id "$CHAIN_ID" --port "$PORT" --gas-limit 5000000000 >/tmp/shapes-anvil.log 2>&1 &
else
  say "Starting local Anvil on $RPC (chain $CHAIN_ID)"
  anvil --chain-id "$CHAIN_ID" --port "$PORT" --gas-limit 5000000000 >/tmp/shapes-anvil.log 2>&1 &
fi
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

# Wait for the RPC to answer.
for _ in $(seq 1 50); do
  if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil never came up; see /tmp/shapes-anvil.log"; exit 1; }

# Multicall3 at its canonical address, used by the site's batched reads (preview/src/site/data.ts).
# A plain anvil chain has no predeploys; a mainnet fork already has it, so etch only when absent.
# script/multicall3-runtime.hex is the deployed runtime bytecode from mainnet.
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11
if [ "$(cast code "$MULTICALL3" --rpc-url "$RPC")" = "0x" ]; then
  say "Etching Multicall3"
  cast rpc anvil_setCode "$MULTICALL3" "$(cat "$REPO_ROOT/script/multicall3-runtime.hex")" --rpc-url "$RPC" >/dev/null
fi
say "Deploying Shapes"
# The deploy wrapper only defaults the fee recipient to the deployer on chain id 31337; on any
# other chain it requires FEE_RECIPIENT set in the target env file. Pass a clean empty EOA
# (also the right choice on a fork, where account 0 carries an EIP-7702 delegation the deploy
# script's no-contract-fee-recipient guard would reject).
FEE_RECIPIENT=0x0000000000000000000000000000000000000FEE
RAW_DEPLOYMENT_FILE="$REPO_ROOT/deployments/${CHAIN_ID}.json"
command -v jq >/dev/null || { echo "jq is required to read $RAW_DEPLOYMENT_FILE" >&2; exit 1; }
SHAPES_FEE_RECIPIENT="$FEE_RECIPIENT" RPC_URL="$RPC" ./script/deploy.sh anvil

SHAPES=$(jq -r '.shapes' "$RAW_DEPLOYMENT_FILE")
RENDERER=$(jq -r '.renderer' "$RAW_DEPLOYMENT_FILE")
COLLECTION=$(jq -r '.collection' "$RAW_DEPLOYMENT_FILE")
LENS=$(jq -r '.lens' "$RAW_DEPLOYMENT_FILE")
HOUSE=$(jq -r '.auctionHouse' "$RAW_DEPLOYMENT_FILE")
MINT_FEE=$(jq -r '.mintFeeWei' "$RAW_DEPLOYMENT_FILE")
ARTIST=$(cast call "$SHAPES" "artist()(address)" --rpc-url "$RPC")

[ -n "$SHAPES" ] && [ -n "$RENDERER" ] && [ -n "$LENS" ] || { echo "could not read deployed addresses from $RAW_DEPLOYMENT_FILE"; exit 1; }

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

# deployments/31337.json (written by script/deploy.sh) is the single source of the record shape.
# The preview frontend's file adds only "artist", which the deploy record has no reason to carry.
mkdir -p "$(dirname "$DEPLOYMENT_FILE")"
jq --arg artist "$ARTIST" '. + {artist: $artist}' "$RAW_DEPLOYMENT_FILE" >"$DEPLOYMENT_FILE"

say "Ready"
echo "  Shapes        $SHAPES"
echo "  Artist        $ARTIST"
echo "  ShapeLens     $LENS"
echo "  ShapeRenderer $RENDERER"
echo "  ShapeCollection $COLLECTION"
echo "  AuctionHouse  $HOUSE"
echo "  mint fee (wei) $MINT_FEE"
echo "  wrote         $DEPLOYMENT_FILE"
echo
echo "  cd preview && npm run dev, then open http://localhost:5173/chain.html"
echo "  Ctrl-C to stop the chain."

wait $ANVIL_PID
