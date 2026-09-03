#!/usr/bin/env bash
# Browser end-to-end run: a fresh chain, a real deploy, the real Next.js site, and the user flows
# driven through it in Chromium (web/e2e/browserFlow.mjs).
#
#   npm run e2e:browser
#
# Owns everything it starts and stops all of it on exit, success or failure. Nothing tracked and
# nothing a developer owns is written: the deployment record deploy.sh leaves in deployments/ is
# copied into a temporary directory straight away and the site is pointed at the copy through
# SHAPES_DEPLOYMENT_FILE, so a concurrent chain of the developer's own can overwrite the original
# without affecting this run.
#
# Environment:
#   E2E_CHAIN_PORT   anvil port (default 8590)
#   E2E_SITE_PORT    Next port (default 3190)
#   E2E_OUT_DIR      screenshot directory (default web/e2e/out)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

CHAIN_PORT="${E2E_CHAIN_PORT:-8590}"
SITE_PORT="${E2E_SITE_PORT:-3190}"
RPC="http://127.0.0.1:${CHAIN_PORT}"
BASE_URL="http://127.0.0.1:${SITE_PORT}"
OUT_DIR="${E2E_OUT_DIR:-$REPO_ROOT/web/e2e/out}"
WORK="$(mktemp -d)"
DEPLOYMENT="$WORK/deployment.json"
# Canonical Multicall3, which the site's batched reads use (preview/src/site/data.ts). Etched onto
# the fresh chain the same way script/fork-dev.sh does it.
MULTICALL3="0xcA11bde05977b3631167028862bE2a173976CA11"

ANVIL_PID=""
SITE_PID=""
cleanup() {
  [ -n "$SITE_PID" ] && kill "$SITE_PID" 2>/dev/null || true
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# A leftover chain or server on either port would be silently reused and produce failures that
# look like app bugs (a deploy against the wrong chain, a site serving the wrong deployment).
for port in "$CHAIN_PORT" "$SITE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "refusing: something is already listening on port $port" >&2
    exit 1
  fi
done

say "Building contracts"
forge build

say "Starting anvil on $RPC"
anvil --port "$CHAIN_PORT" --chain-id 31337 --gas-limit 5000000000 >"$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 100); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil never came up" >&2; cat "$WORK/anvil.log" >&2; exit 1; }
cast rpc anvil_setCode "$MULTICALL3" "$(cat "$REPO_ROOT/script/multicall3-runtime.hex")" --rpc-url "$RPC" >/dev/null

say "Deploying (script/deploy.sh anvil)"
RPC_URL="$RPC" script/deploy.sh anvil
cp "$REPO_ROOT/deployments/31337.json" "$DEPLOYMENT"

say "Building the site against $DEPLOYMENT"
SHAPES_DEPLOYMENT_FILE="$DEPLOYMENT" npm run build --workspace web

say "Serving the site on $BASE_URL"
SHAPES_DEPLOYMENT_FILE="$DEPLOYMENT" npm run start --workspace web -- --port "$SITE_PORT" --hostname 127.0.0.1 \
  >"$WORK/next.log" 2>&1 &
SITE_PID=$!
for _ in $(seq 1 150); do
  curl -fs -o /dev/null "$BASE_URL" && break
  sleep 0.4
done
curl -fsS -o /dev/null "$BASE_URL" || { echo "the site never came up" >&2; cat "$WORK/next.log" >&2; exit 1; }

say "Walking the flows in Chromium"
E2E_BASE_URL="$BASE_URL" \
E2E_RPC_URL="$RPC" \
E2E_DEPLOYMENT_FILE="$DEPLOYMENT" \
E2E_OUT_DIR="$OUT_DIR" \
  node web/e2e/browserFlow.mjs
