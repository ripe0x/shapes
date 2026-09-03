#!/usr/bin/env bash
# Run the Medusa reserve/lifecycle campaign from the committed config.
#
# Two crytic-compile quirks in Medusa 1.5.1 make a direct `medusa fuzz --config
# project/experiments/medusa-reserve.json` unreliable:
#   1. The crytic-compile adapter treats the config file's directory as the project root, so the
#      config must sit at the repo root.
#   2. crytic-compile runs as a subprocess whose cwd can differ from the shell that invoked
#      medusa. A relative `platformConfig.target` is then resolved against the wrong directory and
#      `Path(project_root).samefile(target)` raises FileNotFoundError. An absolute target avoids it.
#
# The committed config keeps a repo-relative target so it stays portable. This script rewrites it
# to an absolute path into a temporary root-level medusa.json and removes that file on exit.
# Extra arguments are passed through to `medusa fuzz`.
#
#   ./script/medusa.sh
#   ./script/medusa.sh --timeout 120 --test-limit 20000
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CONFIG=project/experiments/medusa-reserve.json
RUN_CONFIG=medusa.json

if [ -e "$RUN_CONFIG" ]; then
  echo "$RUN_CONFIG already exists at repo root; remove it first" >&2
  exit 1
fi
trap 'rm -f "$RUN_CONFIG"' EXIT

jq --arg root "$PWD" '.compilation.platformConfig.target |= ($root + "/" + .)' "$CONFIG" > "$RUN_CONFIG"
medusa fuzz --config "$RUN_CONFIG" "$@"
