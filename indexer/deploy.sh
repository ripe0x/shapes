#!/usr/bin/env bash
# One deploy path for the indexer's Fly apps. The environment is a Fly config file
# (indexer/fly.<name>.toml), never a separate script: the same steps below run for
# every target, gated only by that file's values and by the contract deployment record
# it reads its contract address and start block from.
#
# Usage:
#   indexer/deploy.sh <sepolia|mainnet>
#
# What it does:
#   1. Reads deployments/<chainId>.json at the repo root (chain id taken from the
#      target's fly.<name>.toml) for `.shapes` (contract address) and `.fromBlock`
#      (deploy block). Refuses if that file is missing or `.shapes` is empty — the
#      indexer must never deploy pointed at nothing.
#   2. Refuses if the toml's DATABASE_SCHEMA was already used, per
#      indexer/deployments.json, for a different Shapes address. A schema holds one
#      contract's history; bump DATABASE_SCHEMA in the toml for a new deployment
#      instead of overwriting another one's data.
#   3. Runs `fly deploy --config indexer/fly.<name>.toml -a <app> -e SHAPES_ADDRESS=...
#      -e SHAPES_START_BLOCK=...`. The `-e` overrides are release-scoped env vars, not
#      secrets, so they never touch the toml file (which stays values-only and
#      deployment-address-agnostic for mainnet, and already-correct for the live
#      sepolia deployment).
#   4. On success, records {schema: shapesAddress} into indexer/deployments.json and
#      probes the deployed app's /health and /graphql.
#
# DRY_RUN=1   simulate only: still refuses on a missing deployment record or a schema
#             collision, still runs `fly config validate` if the fly CLI is present,
#             prints the resolved `fly deploy` command and env, but never calls fly.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  sepolia|mainnet) ;;
  *)
    echo "usage: indexer/deploy.sh <sepolia|mainnet>" >&2
    exit 1
    ;;
esac

TOML="indexer/fly.${ENV_NAME}.toml"
[[ -f "$TOML" ]] || { echo "missing $TOML" >&2; exit 1; }

# Values are read straight out of the toml's flat [env] block rather than adding a toml
# parser dependency: every value here is a plain `KEY = "value"` line.
toml_env() {
  awk -F'"' -v key="$1" '$0 ~ "^[[:space:]]*"key"[[:space:]]*=" {print $2; exit}' "$TOML"
}
APP=$(awk -F'"' '/^app[[:space:]]*=/ {print $2; exit}' "$TOML")
CHAIN_ID=$(toml_env PONDER_CHAIN_ID)
SCHEMA=$(toml_env DATABASE_SCHEMA)
[[ -n "$APP" && -n "$CHAIN_ID" && -n "$SCHEMA" ]] || {
  echo "could not read app/PONDER_CHAIN_ID/DATABASE_SCHEMA from $TOML" >&2
  exit 1
}

DEPLOYMENT_RECORD="deployments/${CHAIN_ID}.json"
[[ -f "$DEPLOYMENT_RECORD" ]] || {
  echo "refusing: $DEPLOYMENT_RECORD does not exist yet — deploy the contracts first (script/deploy.sh $ENV_NAME)" >&2
  exit 1
}

SHAPES_ADDRESS=$(jq -r '.shapes // empty' "$DEPLOYMENT_RECORD")
FROM_BLOCK=$(jq -r '.fromBlock // empty' "$DEPLOYMENT_RECORD")
AUCTION_HOUSE=$(jq -r '.auctionHouse // empty' "$DEPLOYMENT_RECORD")
[[ -n "$AUCTION_HOUSE" ]] || { echo "refusing: $DEPLOYMENT_RECORD has no auctionHouse" >&2; exit 1; }
[[ -n "$SHAPES_ADDRESS" ]] || {
  echo "refusing: $DEPLOYMENT_RECORD has no .shapes address" >&2
  exit 1
}
[[ -n "$FROM_BLOCK" ]] || {
  echo "refusing: $DEPLOYMENT_RECORD has no .fromBlock" >&2
  exit 1
}

# Schema -> address ledger, so a DATABASE_SCHEMA bump is required for a new contract
# address instead of silently mixing two deployments' history in one schema.
SCHEMA_LEDGER="indexer/deployments.json"
if [[ -f "$SCHEMA_LEDGER" ]]; then
  PRIOR_ADDRESS=$(jq -r --arg s "$SCHEMA" '.[$s] // empty' "$SCHEMA_LEDGER")
else
  PRIOR_ADDRESS=""
fi
if [[ -n "$PRIOR_ADDRESS" && "$PRIOR_ADDRESS" != "$SHAPES_ADDRESS" ]]; then
  echo "refusing: schema '$SCHEMA' in $TOML was already used for $PRIOR_ADDRESS, not $SHAPES_ADDRESS" >&2
  echo "bump DATABASE_SCHEMA in $TOML for a new deployment" >&2
  exit 1
fi

echo "app:             $APP"
echo "config:          $TOML"
echo "chain id:        $CHAIN_ID"
echo "schema:          $SCHEMA"
echo "shapes address:  $SHAPES_ADDRESS"
echo "from block:      $FROM_BLOCK"
echo "auction house:   $AUCTION_HOUSE"

if command -v fly >/dev/null 2>&1; then
  fly config validate --config "$TOML"
else
  echo "fly CLI not found; skipping config validate" >&2
fi

# fly deploy uses the current directory as the Docker build context, so it must run from
# indexer/: the Dockerfile copies this package's package.json, not the workspace root's.
DEPLOY_CMD=(fly deploy --config "$(basename "$TOML")" -a "$APP"
  -e "SHAPES_ADDRESS=$SHAPES_ADDRESS"
  -e "SHAPES_START_BLOCK=$FROM_BLOCK"
  -e "AUCTION_HOUSE_ADDRESS=$AUCTION_HOUSE")

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "DRY_RUN: would run:"
  printf '  %q' "${DEPLOY_CMD[@]}"; echo
  exit 0
fi

(cd indexer && "${DEPLOY_CMD[@]}")

[[ -f "$SCHEMA_LEDGER" ]] || echo '{}' > "$SCHEMA_LEDGER"
jq --arg s "$SCHEMA" --arg a "$SHAPES_ADDRESS" '.[$s] = $a' "$SCHEMA_LEDGER" > "$SCHEMA_LEDGER.tmp"
mv "$SCHEMA_LEDGER.tmp" "$SCHEMA_LEDGER"

APP_URL="https://${APP}.fly.dev"
echo "app url: $APP_URL"
curl -sf "$APP_URL/health" >/dev/null && echo "/health: ok" || echo "/health: FAILED"
curl -sf -X POST "$APP_URL/graphql" -H 'content-type: application/json' \
  --data '{"query":"{ _meta { status } }"}' && echo || echo "/graphql: FAILED"
