#!/usr/bin/env bash
# Prints (never runs) the one-time `fly apps create` and `fly volumes create` commands
# for an indexer environment, reading the app name, region and mount name from its
# fly.<name>.toml. Run once per environment, by hand, before the first
# `indexer/deploy.sh <name>`. Never touches an existing Fly app or volume.
#
# Usage:
#   indexer/bootstrap.sh <mainnet>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  mainnet) ;;
  *)
    echo "usage: indexer/bootstrap.sh <mainnet>" >&2
    exit 1
    ;;
esac

TOML="indexer/fly.${ENV_NAME}.toml"
[[ -f "$TOML" ]] || { echo "missing $TOML" >&2; exit 1; }

APP=$(awk -F'"' '/^app[[:space:]]*=/ {print $2; exit}' "$TOML")
REGION=$(awk -F'"' '/^primary_region[[:space:]]*=/ {print $2; exit}' "$TOML")
VOLUME=$(awk -F'"' '/^[[:space:]]*source[[:space:]]*=/ {print $2; exit}' "$TOML")
[[ -n "$APP" && -n "$REGION" && -n "$VOLUME" ]] || {
  echo "could not read app/primary_region/mount source from $TOML" >&2
  exit 1
}

# 1 GB matches the embedded PGlite volumes already provisioned for this indexer; bump
# --size if a chain's history outgrows it (`fly volumes extend`, not a fresh volume).
cat <<CMDS
# One-time setup for $ENV_NAME ($APP). Run these yourself, then use indexer/deploy.sh.
fly apps create $APP
fly volumes create $VOLUME --app $APP --region $REGION --size 1
CMDS
