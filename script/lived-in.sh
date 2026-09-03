#!/usr/bin/env bash
# One command for a fully lived-in local Shapes chain: boots (or reuses) a dev chain, deploys the
# contracts, then seeds weeks of dated activity across 30 wallets exercising every entrypoint of
# Shapes and ShapeAuctionHouse, with a curated set of presents sent to the browsing
# wallet at the end.
#
#   ./script/lived-in.sh
#
# Honors the same env vars as fork-dev.sh: FORK_URL, CHAIN_ID, PORT, SEED_WALLETS, SEED_ETH.
# DAYS and SIM_SEED (see preview/scripts/simulateHistory.ts) control the simulation itself.
#
# Leaves the chain running in the foreground afterward, exactly like fork-dev.sh: Ctrl-C stops
# it. If an RPC is already answering on $PORT, that chain (and its existing deployment) is reused
# instead of booting a new one, and this script exits after seeding rather than holding it open.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT=${PORT:-8545}
RPC="http://127.0.0.1:${PORT}"
DEPLOYMENT_FILE="$REPO_ROOT/preview/public/deployment.json"
LOCAL_DEPLOYMENT_FILE="$REPO_ROOT/web/public/deployment.local.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

FORK_PID=""
if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  say "Reusing the chain already answering on $RPC"
else
  say "Booting a fresh chain via script/fork-dev.sh"
  ./script/fork-dev.sh &
  FORK_PID=$!
  trap 'kill $FORK_PID 2>/dev/null || true' EXIT INT TERM

  for _ in $(seq 1 100); do
    [ -f "$DEPLOYMENT_FILE" ] && break
    sleep 0.2
  done
  [ -f "$DEPLOYMENT_FILE" ] || { echo "deployment.json never appeared; see /tmp/shapes-anvil.log"; exit 1; }
  # fork-dev.sh writes the file only after the RPC is already up and the deploy has landed, so
  # its presence is enough; no separate RPC-readiness wait is needed here.
fi

say "Seeding roughly six weeks of lived-in activity (preview/scripts/simulateHistory.ts)"
(cd preview && npm run simulate:history)
# Seeding runs on automine so it finishes in minutes. Afterward the chain mines a block every 12s
# like mainnet, so block timestamps track wall time and auction clocks read correctly in the site.
cast rpc evm_setIntervalMining 12 --rpc-url "$RPC" >/dev/null

mkdir -p "$(dirname "$LOCAL_DEPLOYMENT_FILE")"
cp "$DEPLOYMENT_FILE" "$LOCAL_DEPLOYMENT_FILE"

read -r CHAIN_ID SHAPES RENDERER COLLECTION HOUSE FROM_BLOCK <<<"$(python3 -c "
import json
d = json.load(open('$DEPLOYMENT_FILE'))
print(d['chainId'], d['shapes'], d['renderer'], d.get('collection', '?'), d.get('auctionHouse', '?'), d.get('fromBlock', 0))
")"

say "Ready"
echo "  RPC             $RPC"
echo "  chain id        $CHAIN_ID"
echo "  Shapes          $SHAPES"
echo "  ShapeRenderer   $RENDERER"
echo "  ShapeCollection $COLLECTION"
echo "  AuctionHouse    $HOUSE"
echo "  wrote           $LOCAL_DEPLOYMENT_FILE"
echo
echo "  The presents sent to the browsing wallet are listed above, in simulateHistory's own output."
echo
echo "  Start the site:"
echo "    cd web && portless               # https://shapes.localhost"
echo "    cd web && npm run dev            # http://localhost:3000"
echo
echo "  Start the indexer (optional):"
echo "    cd indexer && PONDER_RPC_URL=$RPC PONDER_CHAIN_ID=$CHAIN_ID \\"
echo "      SHAPES_ADDRESS=$SHAPES SHAPES_START_BLOCK=$FROM_BLOCK SHAPES_LADDER=mainnet npm run dev"

if [ -n "$FORK_PID" ]; then
  say "Chain running (PID $FORK_PID). Ctrl-C to stop it."
  wait "$FORK_PID"
else
  say "Chain left running in whatever process started it on $RPC."
fi
