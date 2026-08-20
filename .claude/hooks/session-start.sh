#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Installs the Foundry toolchain (forge / cast / anvil) so the Solidity test and
# invariant suite — including the security regressions in test/ExploitAttempts.t.sol —
# can build and run in a remote session, then warms the build cache.
#
# The Solidity dependencies (forge-std, openzeppelin-contracts) are already vendored
# under lib/, so only the forge binary itself needs installing. This mirrors how CI
# provisions Foundry (foundry-rs/foundry-toolchain in .github/workflows/ci.yml).
#
# Synchronous by design: the session waits until forge is ready, so Claude never tries
# to run tests before the toolchain exists. Idempotent and non-interactive.
set -euo pipefail

# Only run in the remote (web) environment; a local machine already has its own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

FOUNDRY_DIR="${FOUNDRY_DIR:-$HOME/.foundry}"
export FOUNDRY_DIR
export PATH="$FOUNDRY_DIR/bin:$PATH"

# Persist forge on PATH for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$FOUNDRY_DIR/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# Install Foundry only if it is not already on PATH (the container caches after the
# first run, so subsequent sessions skip straight to the build).
if ! command -v forge >/dev/null 2>&1; then
  echo "[session-start] installing Foundry toolchain..."
  if ! curl -fL --connect-timeout 20 https://foundry.paradigm.xyz | bash; then
    echo "[session-start] ERROR: could not reach the Foundry installer (https://foundry.paradigm.xyz)." >&2
    echo "[session-start] The environment's network policy is likely blocking GitHub / paradigm.xyz." >&2
    echo "[session-start] Fix: pick a network policy that allows those hosts, or pre-install Foundry" >&2
    echo "[session-start] in the environment's base image so this hook finds it already on PATH." >&2
    exit 1
  fi
  "$FOUNDRY_DIR/bin/foundryup"
else
  echo "[session-start] Foundry already installed: $(forge --version)"
fi

# Warm the build so the first `forge test` isn't paying for a cold compile.
echo "[session-start] building contracts..."
forge build

echo "[session-start] ready. Run the suite with: forge test"
