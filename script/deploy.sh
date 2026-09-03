#!/usr/bin/env bash
# One deploy path for anvil, Sepolia and mainnet. The environment is a values file
# (script/env/<name>.env), never a separate script: every guard and every step below runs
# identically regardless of target, gated only by the values that file sets.
#
# Usage:
#   script/deploy.sh <anvil|sepolia|mainnet>
#
# Overrides:
#   SEPOLIA_RPC_URL / MAINNET_RPC_URL / RPC_URL   RPC endpoint, overrides the env file default.
#   FOUNDRY_PROFILE                               forge profile, overrides the env file default.
#   KEYSTORE_PASSWORD_FILE                        read the keystore password from this file
#                                                  (chmod 600) instead of an interactive prompt.
#                                                  The password never appears in argv.
#   DEPLOYER_PRIVATE_KEY                           anvil target only: use this key instead of
#                                                  anvil's well-known default account 0 key.
#   SHAPES_FEE_RECIPIENT / SHAPES_MINT_FEE_WEI     forwarded to Deploy.s.sol; must agree with a
#                                                  nonempty FEE_RECIPIENT / MINT_FEE_WEI in the
#                                                  env file if one is set there.
#   MINT_START_DELAY                               seconds from the post-compile clock to the
#                                                 mint start; resolved after forge build.
#   MINT_START                                     overrides the env file's MINT_START (a
#                                                  rehearsal sets this a few minutes ahead).
#   DRY_RUN=1                                     simulate only: the REQUIRE_MAIN git guards
#                                                  (branch, fetched origin/main, clean tree, no
#                                                  untracked files) still run, but a failure only
#                                                  warns instead of exiting, since a real run would
#                                                  refuse. Every other guard still hard-fails. Only
#                                                  the wallet and --broadcast are skipped, and the
#                                                  run stops after the simulation. Nothing is
#                                                  written.
#   RESUME_BROADCAST=1                            continue a broadcast that stopped part way: forge
#                                                  re-sends the unsent transactions from the saved
#                                                  broadcast file with their recorded nonces, then
#                                                  the post-broadcast phase runs as usual.
#   RESUME=1                                      skip `forge script --broadcast` entirely and run
#                                                  only the post-broadcast phase (verification when
#                                                  VERIFY=true, on-chain readback, deployments/
#                                                  record) against the existing broadcast file for
#                                                  this chain. For recording a deployment whose
#                                                  broadcast already succeeded on chain but whose
#                                                  wrapper run didn't reach the recording step (e.g.
#                                                  forge's inline verification failed and aborted
#                                                  the wrapper before it got there). The REQUIRE_MAIN
#                                                  git guards still run, but, like DRY_RUN, only
#                                                  warn: nothing is broadcast from this worktree's
#                                                  commit, so the exact-commit invariant that guards
#                                                  a real broadcast doesn't apply to resuming one
#                                                  that already happened elsewhere.
#   VERIFY=true|false                             overrides the env file's VERIFY value. Lets a
#                                                  resumed run skip verification (and the
#                                                  ETHERSCAN_API_KEY requirement) without editing
#                                                  the env file.
#   BROADCAST_FILE                                path to the forge broadcast file to read for the
#                                                  post-broadcast phase, overriding the default
#                                                  broadcast/Deploy.s.sol/<chainId>/run-latest.json.
#                                                  For resuming from a broadcast produced by a
#                                                  different checkout.
#   LIST_OWNER_TOKEN=1                            opt in to listing the owner token (#0) in the
#                                                  auction house right after the readback, using
#                                                  AUCTION_DURATION, AUCTION_RESERVE_UNITS,
#                                                  AUCTION_MIN_INCREMENT_BPS and
#                                                  AUCTION_EXTENSION_WINDOW from the env file
#                                                  (86400s, 0, 500bps, 900s by default).
#                                                  createAuction only escrows the lot and opens the
#                                                  listing; the clock starts on the first bid.
#                                                  Allowed under RESUME too, and skips rather than
#                                                  refuses when the owner token is already listed.
#                                                  DRY_RUN=1 prints what would be listed and lists
#                                                  nothing. Records auctionId in
#                                                  deployments/<chainId>.json.
#   ATTEST_ARTIST=1                               opt in to signing and submitting the one-time
#                                                  artist attestation after the readback/listing
#                                                  steps. The release hash defaults to the Shapes
#                                                  creation transaction hash; SHAPES_RELEASE_HASH
#                                                  overrides it (must be an exact bytes32, and a
#                                                  mismatch against the creation tx prints a loud
#                                                  warning). The signer must be artist() on the
#                                                  deployed Shapes. A keystore env always prompts
#                                                  to retype the release hash before signing;
#                                                  ATTEST_CONFIRM=<hash> skips that prompt, but
#                                                  only for the anvil target, so e2e runs can be
#                                                  non-interactive. Idempotent: if
#                                                  artistReleaseHash() is already nonzero the step
#                                                  is skipped rather than refused, so RESUME can
#                                                  revisit an already-attested chain. DRY_RUN=1
#                                                  prints what would be signed and submits nothing.
#   ALLOW_BRANCH_DEPLOY=1                         opt in to deploying from a feature branch
#                                                  instead of main, for a target whose env file
#                                                  sets BRANCH_DEPLOY_ALLOWED=true (anvil and
#                                                  sepolia; never mainnet). Without the env file's
#                                                  opt-in, refuses outright, DRY_RUN included. With
#                                                  it, replaces the REQUIRE_MAIN "must run from
#                                                  main" and "local main is not the fetched
#                                                  origin/main commit" guards with the same check
#                                                  against the current branch: HEAD must equal the
#                                                  fetched origin/<branch> commit. The dirty-tree
#                                                  and untracked-file guards are unaffected. Records
#                                                  the deployed commit and branch in
#                                                  deployments/<chainId>.json regardless of this
#                                                  flag.
set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  anvil | sepolia | mainnet) ;;
  *)
    echo "usage: script/deploy.sh <anvil|sepolia|mainnet>" >&2
    exit 1
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="script/env/${ENV_NAME}.env"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

DRY_RUN="${DRY_RUN:-0}"
RESUME="${RESUME:-0}"
ATTEST_ARTIST="${ATTEST_ARTIST:-0}"
# Captured before sourcing the env file, which unconditionally sets VERIFY: a caller-exported
# VERIFY wins over the env file's value.
VERIFY_OVERRIDE="${VERIFY-}"
# A shell-provided MINT_START (a rehearsal setting it a few minutes ahead) must survive the env
# file's own MINT_START assignment below, so it is snapshotted before sourcing.
MINT_START_OVERRIDE="${MINT_START:-}"
# Same pattern for LIST_OWNER_TOKEN: a shell export wins over whatever the env file sets.
LIST_OWNER_TOKEN_OVERRIDE="${LIST_OWNER_TOKEN-}"
# Same pattern for ALLOW_BRANCH_DEPLOY: it is a shell opt-in, not something the env file sets.
ALLOW_BRANCH_DEPLOY_OVERRIDE="${ALLOW_BRANCH_DEPLOY-}"

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

[ -z "$VERIFY_OVERRIDE" ] || VERIFY="$VERIFY_OVERRIDE"
[ -z "$MINT_START_OVERRIDE" ] || MINT_START="$MINT_START_OVERRIDE"
[ -z "$LIST_OWNER_TOKEN_OVERRIDE" ] || LIST_OWNER_TOKEN="$LIST_OWNER_TOKEN_OVERRIDE"
# Opt-in, post-broadcast listing of the owner token (#0) in the auction house. Terms fall back to
# these defaults if the env file leaves them blank.
LIST_OWNER_TOKEN="${LIST_OWNER_TOKEN:-0}"
AUCTION_DURATION="${AUCTION_DURATION:-86400}"
AUCTION_RESERVE_UNITS="${AUCTION_RESERVE_UNITS:-0}"
AUCTION_MIN_INCREMENT_BPS="${AUCTION_MIN_INCREMENT_BPS:-500}"
AUCTION_EXTENSION_WINDOW="${AUCTION_EXTENSION_WINDOW:-900}"
[ -z "$ALLOW_BRANCH_DEPLOY_OVERRIDE" ] || ALLOW_BRANCH_DEPLOY="$ALLOW_BRANCH_DEPLOY_OVERRIDE"
ALLOW_BRANCH_DEPLOY="${ALLOW_BRANCH_DEPLOY:-0}"
BRANCH_DEPLOY_ALLOWED="${BRANCH_DEPLOY_ALLOWED:-false}"

# Mainnet's env file ships with the deployer, fee recipient and fee left blank until D-05
# (project/DECISIONS.md) is resolved. Refuse before touching any RPC, dry run included.
if [ "$ENV_NAME" = "mainnet" ]; then
  for var in DEPLOYER FEE_RECIPIENT MINT_FEE_WEI; do
    [ -n "${!var:-}" ] || {
      echo "refusing: $ENV_FILE has no $var set. Resolve D-05 (project/DECISIONS.md) and fill in the mainnet env file first." >&2
      exit 1
    }
  done
fi

case "$ENV_NAME" in
  sepolia) RPC="${SEPOLIA_RPC_URL:-${RPC_URL:-$RPC_DEFAULT}}" ;;
  mainnet) RPC="${MAINNET_RPC_URL:-${RPC_URL:-$RPC_DEFAULT}}" ;;
  anvil) RPC="${RPC_URL:-$RPC_DEFAULT}" ;;
esac
[ -n "$RPC" ] || { echo "refusing: no RPC URL configured for $ENV_NAME" >&2; exit 1; }
FOUNDRY_PROFILE="${FOUNDRY_PROFILE:-$FOUNDRY_PROFILE_DEFAULT}"
# Exported once: every forge/solc invocation below (deploy, inspect, verify-contract) must compile
# against the same profile the broadcast used, or their bytecode won't line up with what's on chain.
export FOUNDRY_PROFILE
BROADCAST_FILE="${BROADCAST_FILE:-broadcast/Deploy.s.sol/${CHAIN_ID}/run-latest.json}"

echo "== deploy.sh $ENV_NAME =="
echo "  rpc      $RPC"
echo "  profile  $FOUNDRY_PROFILE"
echo "  dry run  $DRY_RUN"
echo "  resume   $RESUME"
echo "  list owner token  $LIST_OWNER_TOKEN"
echo "  attest artist     $ATTEST_ARTIST"
echo "  allow branch deploy  $ALLOW_BRANCH_DEPLOY"

# Deploy.s.sol reads SHAPES_MINT_FEE_WEI / SHAPES_FEE_RECIPIENT; the env file's own names
# (MINT_FEE_WEI / FEE_RECIPIENT) are the reviewed values for this target. A caller-supplied
# override is allowed only if it agrees with them.
if [ -n "${MINT_FEE_WEI:-}" ]; then
  if [ -n "${SHAPES_MINT_FEE_WEI:-}" ] && [ "$SHAPES_MINT_FEE_WEI" != "$MINT_FEE_WEI" ]; then
    echo "refusing: SHAPES_MINT_FEE_WEI=$SHAPES_MINT_FEE_WEI overrides the reviewed $ENV_NAME fee ($MINT_FEE_WEI)" >&2
    exit 1
  fi
  export SHAPES_MINT_FEE_WEI="$MINT_FEE_WEI"
fi
if [ -n "${FEE_RECIPIENT:-}" ]; then
  if [ -n "${SHAPES_FEE_RECIPIENT:-}" ] && [ "$SHAPES_FEE_RECIPIENT" != "$FEE_RECIPIENT" ]; then
    echo "refusing: SHAPES_FEE_RECIPIENT=$SHAPES_FEE_RECIPIENT overrides the reviewed $ENV_NAME payout ($FEE_RECIPIENT)" >&2
    exit 1
  fi
  export SHAPES_FEE_RECIPIENT="$FEE_RECIPIENT"
fi
[ -z "${MINT_START:-}" ] || export SHAPES_MINT_START="$MINT_START"
# Otherwise FEE_RECIPIENT is empty by design (anvil): pass through whatever the caller already
# exported as SHAPES_FEE_RECIPIENT (fork-dev.sh does this), or leave it unset so Deploy.s.sol
# defaults to the deployer on chain id 31337. MINT_START works the same way: the shell override
# snapshotted above wins, otherwise the env file's own value (or its blank default) applies.

# --- guards: identical code path for every target, switched only by the env file's values ------

ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$ACTUAL_CHAIN_ID" = "$CHAIN_ID" ] \
  || { echo "refusing: $RPC reports chain id $ACTUAL_CHAIN_ID, expected $CHAIN_ID" >&2; exit 1; }
echo "  ok: chain id $ACTUAL_CHAIN_ID"

DEPLOY_BRANCH="$(git branch --show-current)"
DEPLOY_COMMIT="$(git rev-parse HEAD)"

if [ "$REQUIRE_MAIN" = "true" ]; then
  # A real broadcast refuses on any failure here. Under DRY_RUN=1 or RESUME=1 the same checks
  # still run, but a failure only warns what a real broadcast would refuse: DRY_RUN broadcasts
  # nothing, and RESUME's broadcast already happened (elsewhere, possibly from a different
  # checkout): the exact-commit invariant guards a new broadcast, not a resumed readback of one
  # that already landed on chain.
  git_guard_fail() {
    if [ "$DRY_RUN" = "1" ] || [ "$RESUME" = "1" ]; then
      echo "  warn: a new broadcast would refuse: $1" >&2
    else
      echo "refusing: $1" >&2
      exit 1
    fi
  }

  if [ "$ALLOW_BRANCH_DEPLOY" = "1" ]; then
    # A rehearsal from a feature branch. Refuses outright, DRY_RUN included, on any target whose
    # env file hasn't opted in (mainnet never does): this is a caller asking for an exception, not
    # a normal run, so a missing opt-in is refused rather than warned.
    [ "$BRANCH_DEPLOY_ALLOWED" = "true" ] \
      || { echo "refusing: branch deploys are not allowed for this target" >&2; exit 1; }
    git fetch --quiet origin "$DEPLOY_BRANCH"
    [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$DEPLOY_BRANCH")" ] \
      || git_guard_fail "local $DEPLOY_BRANCH is not the fetched origin/$DEPLOY_BRANCH commit"
  else
    [ "$DEPLOY_BRANCH" = "main" ] \
      || git_guard_fail "deployments must run from main"
    git fetch --quiet origin main
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
      || git_guard_fail "local main is not the fetched origin/main commit"
  fi
  git diff --quiet && git diff --cached --quiet \
    || git_guard_fail "tracked files are dirty; deployment commit is not exact"
  # deployments/ is written by a previous deploy, not an input to this one; untracked files
  # there don't make the deployment commit inexact.
  [ -z "$(git ls-files --others --exclude-standard -- . ':!deployments')" ] \
    || git_guard_fail "untracked files exist; deployment commit is not exact"
  [ "$DRY_RUN" = "1" ] || [ "$RESUME" = "1" ] || echo "  ok: clean, exact, fetched $DEPLOY_BRANCH"
fi

# Behavioral guard, not a code-length check: a contract (a 0xSplits wallet, for example) can
# accept plain ETH as reliably as an EOA, and code-length only rules out contracts, not a
# reverting EOA-shaped proxy. Simulates the transfer `withdrawFees` would make; no flag bypasses
# it. Needs a funded `--from` to simulate against: DEPLOYER, sourced from the env file for
# sepolia and mainnet, or anvil's well-known default account 0.
if [ -n "${FEE_RECIPIENT:-}" ]; then
  FEE_RECIPIENT_FROM="${DEPLOYER:-}"
  if [ "$ENV_NAME" = "anvil" ] && [ -z "$FEE_RECIPIENT_FROM" ]; then
    FEE_RECIPIENT_FROM="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  fi
  [ -n "$FEE_RECIPIENT_FROM" ] \
    || { echo "refusing: no DEPLOYER set in $ENV_FILE to simulate the fee recipient transfer from" >&2; exit 1; }
  if FEE_RECIPIENT_CALL_ERR=$(cast call "$FEE_RECIPIENT" --value 1 --from "$FEE_RECIPIENT_FROM" --rpc-url "$RPC" 2>&1); then
    FEE_RECIPIENT_KIND="EOA"
    [ "$(cast code "$FEE_RECIPIENT" --rpc-url "$RPC")" = "0x" ] || FEE_RECIPIENT_KIND="contract"
    echo "  ok: fee recipient accepts plain ETH ($FEE_RECIPIENT_KIND)"
  elif echo "$FEE_RECIPIENT_CALL_ERR" | grep -qi "insufficient funds"; then
    # The simulation's `--from` has no balance on this chain, not a rejection by the recipient.
    # Only DRY_RUN downgrades this to a warning; a real broadcast still refuses.
    if [ "$DRY_RUN" = "1" ]; then
      echo "  warn: cannot verify fee recipient accepts plain ETH: $FEE_RECIPIENT_FROM is unfunded on $ENV_NAME" >&2
    else
      echo "refusing: cannot verify fee recipient accepts plain ETH: fund $FEE_RECIPIENT_FROM on $ENV_NAME (or set DEPLOYER to a funded address) and retry" >&2
      exit 1
    fi
  else
    echo "refusing: fee recipient $FEE_RECIPIENT rejects plain ETH" >&2
    exit 1
  fi
fi

if [ "$VERIFY" = "true" ] && [ "$DRY_RUN" != "1" ]; then
  : "${ETHERSCAN_API_KEY:?VERIFY=true for $ENV_NAME requires ETHERSCAN_API_KEY}"
  echo "  ok: ETHERSCAN_API_KEY set"
fi

# --- wallet -------------------------------------------------------------------------------------
# Resolved even for RESUME=1: nothing here signs anything (that only happens if WALLET_ARGS is
# later passed to a broadcasting forge invocation), but the readback phase needs EFFECTIVE_DEPLOYER
# regardless of whether this run broadcasts.

WALLET_ARGS=()
if [ "$DRY_RUN" != "1" ]; then
  case "$WALLET" in
    anvil)
      DEPLOY_PK="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
      WALLET_ARGS=(--private-key "$DEPLOY_PK")
      EFFECTIVE_DEPLOYER="$(cast wallet address --private-key "$DEPLOY_PK")"
      ;;
    keystore)
      KEYSTORE_PATH="$HOME/.foundry/keystores/${KEYSTORE_ACCOUNT}"
      if [ -n "${KEYSTORE_PASSWORD_FILE:-}" ]; then
        [ -r "$KEYSTORE_PASSWORD_FILE" ] \
          || { echo "refusing: KEYSTORE_PASSWORD_FILE is not readable" >&2; exit 1; }
        WALLET_ARGS=(--keystore "$KEYSTORE_PATH" --password-file "$KEYSTORE_PASSWORD_FILE")
      else
        WALLET_ARGS=(--account "$KEYSTORE_ACCOUNT")
      fi
      EFFECTIVE_DEPLOYER="${DEPLOYER:?}"
      ;;
    *)
      echo "refusing: unknown WALLET=$WALLET in $ENV_FILE" >&2
      exit 1
      ;;
  esac
fi

# --- run ----------------------------------------------------------------------------------------
# Inline `--verify` is never used: forge aborts the whole invocation (and this wrapper, under
# set -e) on the first verification failure, before broadcast confirmations are even read back or
# deployments/<chainId>.json is written. Verification runs as its own step below instead, after a
# real broadcast or under RESUME, where a failure is recorded and the run continues.

# A relative mint start is resolved after the compile, not at command start: a cold via_ir build
# takes minutes, so "now + N" computed earlier would already be in the past when the broadcast
# lands. Pad MINT_START_DELAY for the broadcast itself (sequential transactions, ~12 s blocks).
if [ -n "${MINT_START_DELAY:-}" ]; then
  # The env file may set MINT_START=0 (open at deploy); only a real absolute value conflicts.
  if [ -n "${MINT_START:-}" ] && [ "$MINT_START" != "0" ]; then
    echo "set MINT_START or MINT_START_DELAY, not both" >&2; exit 1
  fi
  say "Compiling before resolving the relative mint start"
  forge build >/dev/null
  MINT_START=$(( $(date +%s) + MINT_START_DELAY ))
  export SHAPES_MINT_START="$MINT_START"
  echo "  mint start   $MINT_START (now + ${MINT_START_DELAY}s)"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN=1: simulating only, nothing will be broadcast or written"
  if [ "$LIST_OWNER_TOKEN" = "1" ]; then
    echo "  would list: owner token (#0), duration ${AUCTION_DURATION}s, reserve $AUCTION_RESERVE_UNITS units, min increment ${AUCTION_MIN_INCREMENT_BPS}bps, extension window ${AUCTION_EXTENSION_WINDOW}s"
  fi
  if [ "$ATTEST_ARTIST" = "1" ]; then
    echo "  would attest: sign and submit the artist attestation once broadcast, release hash defaulting to the Shapes creation tx (override with SHAPES_RELEASE_HASH)"
  fi
  forge script script/Deploy.s.sol --tc Deploy --rpc-url "$RPC"
  echo "dry run complete for $ENV_NAME"
  exit 0
fi

if [ "$RESUME" = "1" ]; then
  echo "RESUME=1: skipping broadcast, resuming post-broadcast steps from $BROADCAST_FILE"
  [ -f "$BROADCAST_FILE" ] \
    || { echo "refusing: RESUME=1 but no broadcast file at $BROADCAST_FILE" >&2; exit 1; }
else
  FORGE_ARGS=(script script/Deploy.s.sol --tc Deploy --rpc-url "$RPC" "${WALLET_ARGS[@]}")
  [ -n "${DEPLOYER:-}" ] && FORGE_ARGS+=(--sender "$DEPLOYER")
  # --slow sends one transaction at a time and waits for its receipt. A node accepts a single
  # pending transaction from an EIP-7702 delegated account and rejects the rest as gapped nonces.
  FORGE_ARGS+=(--broadcast --slow)
  # RESUME_BROADCAST=1 re-sends the unsent transactions of the saved broadcast file with their
  # recorded nonces, so a run that stopped part way continues at the same predicted addresses.
  [ "${RESUME_BROADCAST:-0}" = "1" ] && FORGE_ARGS+=(--resume)
  forge "${FORGE_ARGS[@]}"
fi

# --- postflight: resolve what actually got deployed, read it back on chain ---------------------

[ -f "$BROADCAST_FILE" ] || { echo "no broadcast file at $BROADCAST_FILE" >&2; exit 1; }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Mirrors e2e-anvil.sh's send_wait: cast send returns before the transaction is reliably mined on
# this toolchain, so poll for the receipt before the next sequenced send races it. --gas-limit
# sidesteps the estimator's under-estimate on a nonReentrant-guarded function (its gas refund is
# credited only at the end of the transaction, after the estimate is taken). Uses the wallet
# resolved above, so it only runs where WALLET_ARGS is meaningful (never under DRY_RUN).
send_wait() {
  local hash
  hash=$(cast send --gas-limit 600000 --rpc-url "$RPC" "${WALLET_ARGS[@]}" "$@" --json | jq -r '.transactionHash')
  for _ in $(seq 1 100); do
    cast receipt "$hash" --rpc-url "$RPC" >/dev/null 2>&1 && { echo "$hash"; return 0; }
  done
  echo "tx $hash was not mined" >&2
  exit 1
}

contract_address() {
  jq -r --arg name "$1" \
    '.transactions[] | select(.contractName == $name and .transactionType == "CREATE") | .contractAddress' \
    "$BROADCAST_FILE" | tail -1 | tr '[:upper:]' '[:lower:]'
}

require_address() {
  local label="$1" address="$2"
  [[ "$address" =~ ^0x[0-9a-fA-F]{40}$ ]] \
    || { echo "could not resolve $label from $BROADCAST_FILE" >&2; exit 1; }
  [ "$(cast code "$address" --rpc-url "$RPC")" != "0x" ] \
    || { echo "$label has no deployed code at $address" >&2; exit 1; }
}

require_address_read() {
  local label="$1" actual="$2" expected="$3"
  [ "$(lower "$actual")" = "$(lower "$expected")" ] \
    || { echo "$label mismatch: expected $expected, got $actual" >&2; exit 1; }
}

require_uint_read() {
  local label="$1" actual="$2" expected="$3"
  [ "${actual%% *}" = "$expected" ] \
    || { echo "$label mismatch: expected $expected, got $actual" >&2; exit 1; }
}

RENDERER=$(contract_address ShapeRenderer)
COLLECTION=$(contract_address ShapeCollection)
SHAPES=$(contract_address Shapes)
HOUSE=$(contract_address ShapeAuctionHouse)

require_address ShapeRenderer "$RENDERER"
require_address ShapeCollection "$COLLECTION"
require_address Shapes "$SHAPES"
require_address ShapeAuctionHouse "$HOUSE"

# Linked libraries are deployed before the script run and recorded separately by Foundry.
while IFS=: read -r source contract address; do
  [ -n "$address" ] || continue
  require_address "$contract" "$address"
done < <(jq -r '.libraries[]? // empty' "$BROADCAST_FILE")

# --- verify: forge verify-contract per contract and library, profile- and library-aware ---------
# A failure here is recorded, not fatal: the readback and the deployments/<chainId>.json record
# below always run regardless, and the run only reports failure (after writing the record) at the
# very end. --libraries carries the full set to every call; a contract or library that doesn't
# reference a given library ignores the extra flag.

VERIFY_FAILURES=()

if [ "$VERIFY" = "true" ]; then
  echo "Verifying contracts on Etherscan"

  LIB_FLAGS=()
  while IFS= read -r lib; do
    [ -n "$lib" ] || continue
    LIB_FLAGS+=(--libraries "$lib")
  done < <(jq -r '.libraries[]? // empty' "$BROADCAST_FILE")

  verify_one() {
    local fq_name="$1" bare_name="$2" address="$3"
    local ctor_types ctor_args=()
    ctor_types=$(forge inspect "$bare_name" abi --json 2>/dev/null \
      | jq -r '[.[] | select(.type=="constructor") | .inputs[].type] | join(",")')
    if [ -n "$ctor_types" ]; then
      local vals=()
      while IFS= read -r v; do vals+=("$v"); done < <(jq -r --arg name "$bare_name" \
        '.transactions[] | select(.transactionType=="CREATE" and .contractName==$name) | .arguments[]? // empty' \
        "$BROADCAST_FILE")
      ctor_args=(--constructor-args "$(cast abi-encode "constructor($ctor_types)" "${vals[@]}")")
    fi
    echo "  verifying $bare_name $address"
    if forge verify-contract "$address" "$fq_name" --chain "$CHAIN_ID" \
        --etherscan-api-key "$ETHERSCAN_API_KEY" "${LIB_FLAGS[@]}" "${ctor_args[@]}" --watch; then
      echo "  ok: verified $bare_name $address"
    else
      echo "  FAILED to verify $bare_name $address" >&2
      local retry="FOUNDRY_PROFILE=$FOUNDRY_PROFILE forge verify-contract $address $fq_name --chain $CHAIN_ID --etherscan-api-key \$ETHERSCAN_API_KEY ${LIB_FLAGS[*]} ${ctor_args[*]:-} --watch"
      VERIFY_FAILURES+=("$bare_name $address :: $retry")
    fi
  }

  verify_one src/ShapeRenderer.sol:ShapeRenderer ShapeRenderer "$RENDERER"
  verify_one src/ShapeCollection.sol:ShapeCollection ShapeCollection "$COLLECTION"
  verify_one src/Shapes.sol:Shapes Shapes "$SHAPES"
  verify_one src/ShapeAuctionHouse.sol:ShapeAuctionHouse ShapeAuctionHouse "$HOUSE"

  while IFS=: read -r source contract address; do
    [ -n "$address" ] || continue
    verify_one "${source}:${contract}" "$contract" "$address"
  done < <(jq -r '.libraries[]? // empty' "$BROADCAST_FILE")
fi

# --- readback: always runs, verification failures above notwithstanding -------------------------

# Foundry may broadcast independent CREATE transactions in a different order from the simulated
# `transactions` array. Resolve the creation hash from the mined receipt whose contract address
# is the actual Shapes address; pairing `contractName` with `.hash` can select another deployment.
SHAPES_TX=$(jq -r --arg shapes "$SHAPES" \
  '.receipts[] | select(.contractAddress != null) | select((.contractAddress | ascii_downcase) == ($shapes | ascii_downcase)) | .transactionHash' \
  "$BROADCAST_FILE" | tail -1)
[[ "$SHAPES_TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "could not resolve Shapes transaction" >&2; exit 1; }
SHAPES_RECEIPT=$(cast receipt "$SHAPES_TX" --rpc-url "$RPC" --json)
[ "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.status')" = "0x1" ] \
  || { echo "Shapes creation transaction did not succeed" >&2; exit 1; }
[ "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.contractAddress' | tr '[:upper:]' '[:lower:]')" \
    = "$(lower "$SHAPES")" ] \
  || { echo "Shapes creation transaction created another address" >&2; exit 1; }
FROM_BLOCK=$(cast to-dec "$(printf '%s' "$SHAPES_RECEIPT" | jq -r '.blockNumber')")

require_address_read admin "$(cast call "$SHAPES" 'admin()(address)' --rpc-url "$RPC")" "$EFFECTIVE_DEPLOYER"
require_address_read artist "$(cast call "$SHAPES" 'artist()(address)' --rpc-url "$RPC")" "$EFFECTIVE_DEPLOYER"
# Shapes.owner() and ownerOf(0) both track whoever holds the owner token, which a fresh broadcast
# always mints to the deployer. RESUME may be revisiting a chain where a previous RESUME +
# LIST_OWNER_TOKEN=1 run already escrowed it into the auction house, moving both, so it only logs;
# the owner-token listing step below does its own ownership checks.
if [ "$RESUME" = "1" ]; then
  echo "  owner           $(cast call "$SHAPES" 'owner()(address)' --rpc-url "$RPC")"
  echo "  Shape #0 owner  $(cast call "$SHAPES" 'ownerOf(uint256)(address)' 0 --rpc-url "$RPC")"
else
  require_address_read owner "$(cast call "$SHAPES" 'owner()(address)' --rpc-url "$RPC")" "$EFFECTIVE_DEPLOYER"
  require_address_read 'Shape #0 owner' \
    "$(cast call "$SHAPES" 'ownerOf(uint256)(address)' 0 --rpc-url "$RPC")" "$EFFECTIVE_DEPLOYER"
fi
[ -z "${FEE_RECIPIENT:-}" ] || require_address_read 'fee recipient' \
  "$(cast call "$SHAPES" 'feeRecipient()(address)' --rpc-url "$RPC")" "$FEE_RECIPIENT"
require_address_read renderer "$(cast call "$SHAPES" 'renderer()(address)' --rpc-url "$RPC")" "$RENDERER"
require_address_read collection "$(cast call "$SHAPES" 'collection()(address)' --rpc-url "$RPC")" "$COLLECTION"
require_address_read 'collection renderer' \
  "$(cast call "$COLLECTION" 'renderer()(address)' --rpc-url "$RPC")" "$RENDERER"
require_address_read 'collection token' \
  "$(cast call "$COLLECTION" 'shapes()(address)' --rpc-url "$RPC")" "$SHAPES"

# The metadata copy lives on the collection; the token reads it back for tokenURI/contractURI.
TOKEN_NAME_PREFIX=$(cast call "$COLLECTION" 'tokenNamePrefix()(string)' --rpc-url "$RPC")
COLLECTION_DESCRIPTION=$(cast call "$COLLECTION" 'description()(string)' --rpc-url "$RPC")
OWNER_TOKEN_DESCRIPTION=$(cast call "$COLLECTION" 'ownerTokenDescription()(string)' --rpc-url "$RPC")
echo "  name prefix  $TOKEN_NAME_PREFIX"
echo "  description  ${COLLECTION_DESCRIPTION:0:72}..."
echo "  owner descr  ${OWNER_TOKEN_DESCRIPTION:0:72}..."
[ "$TOKEN_NAME_PREFIX" = '"Shape "' ] \
  || { echo "unexpected token name prefix $TOKEN_NAME_PREFIX" >&2; exit 1; }
[ "${#COLLECTION_DESCRIPTION}" -gt 100 ] \
  || { echo "collection description is empty" >&2; exit 1; }
[ "${#OWNER_TOKEN_DESCRIPTION}" -gt 100 ] \
  || { echo "owner token description is empty" >&2; exit 1; }
require_address_read 'auction-house target' "$(cast call "$HOUSE" 'shapes()(address)' --rpc-url "$RPC")" "$SHAPES"

MINT_FEE_ONCHAIN=$(cast call "$SHAPES" 'mintFee()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
[ -z "${MINT_FEE_WEI:-}" ] || require_uint_read 'mint fee' "$MINT_FEE_ONCHAIN" "$MINT_FEE_WEI"
MINT_START_ONCHAIN=$(cast call "$SHAPES" 'mintStart()(uint64)' --rpc-url "$RPC" | awk '{print $1}')
echo "  mint start   $MINT_START_ONCHAIN"
[ -z "${MINT_START:-}" ] || require_uint_read 'mint start' "$MINT_START_ONCHAIN" "$MINT_START"
require_uint_read 'denomination count' "$(cast call "$SHAPES" 'denominationCount()(uint8)' --rpc-url "$RPC")" 9
require_uint_read 'Shape #0 denomination' \
  "$(cast call "$SHAPES" 'denomIndexOf(uint256)(uint8)' 0 --rpc-url "$RPC")" 0
require_uint_read 'owner token' "$(cast call "$SHAPES" 'ownerToken()(uint256)' --rpc-url "$RPC")" 0
# A fresh broadcast has listed nothing yet, so this must read 0. RESUME may be revisiting a chain
# where a previous RESUME + LIST_OWNER_TOKEN=1 run already listed the owner token, so it only logs.
if [ "$RESUME" = "1" ]; then
  echo "  auction count   $(cast call "$HOUSE" 'auctionCount()(uint256)' --rpc-url "$RPC" | awk '{print $1}')"
else
  require_uint_read 'auction count' "$(cast call "$HOUSE" 'auctionCount()(uint256)' --rpc-url "$RPC")" 0
fi

ZERO_HASH="0x0000000000000000000000000000000000000000000000000000000000000000"
ARTIST_RELEASE_HASH_ONCHAIN=$(cast call "$SHAPES" 'artistReleaseHash()(bytes32)' --rpc-url "$RPC")
# A fresh broadcast has attested nothing yet, so this must read zero. RESUME may be revisiting a
# chain where a previous RESUME + ATTEST_ARTIST=1 run already signed it, so it only logs; the
# attestation step below does its own zero check before signing anything.
if [ "$RESUME" = "1" ]; then
  echo "  artist release hash  $ARTIST_RELEASE_HASH_ONCHAIN"
else
  [ "$ARTIST_RELEASE_HASH_ONCHAIN" = "$ZERO_HASH" ] \
    || { echo "artist attribution unexpectedly signed during deployment" >&2; exit 1; }
  [ "$(cast call "$SHAPES" 'artistSignature()(bytes)' --rpc-url "$RPC")" = "0x" ] \
    || { echo "artist signature unexpectedly populated during deployment" >&2; exit 1; }
fi
[ "$(cast call "$SHAPES" 'exists(uint256)(bool)' 0 --rpc-url "$RPC")" = "true" ] \
  || { echo "Shape #0 is not live" >&2; exit 1; }
# The two discovery pointers. The market names the auction house the deploy just registered;
# positions starts empty because no positions contract exists. Neither is locked.
POSITIONS=$(cast call "$SHAPES" 'positions()(address,bool)' --rpc-url "$RPC")
MARKET=$(cast call "$SHAPES" 'market()(address,bool)' --rpc-url "$RPC")
echo "  positions    $POSITIONS" | tr '\n' ' '; echo
echo "  market       $MARKET" | tr '\n' ' '; echo
[ "$POSITIONS" = $'0x0000000000000000000000000000000000000000\nfalse' ] \
  || { echo "positions pointer did not start empty and unlocked" >&2; exit 1; }
# `cast call` returns a checksummed address; `contract_address` lowercases. Compare on one case.
[ "$(echo "$MARKET" | tr '[:upper:]' '[:lower:]')" = "$HOUSE"$'\nfalse' ] \
  || { echo "market pointer does not name the deployed auction house, unlocked" >&2; exit 1; }

echo "  ok: onchain readback matches the deploy"

# --- optional: list the owner token (#0) in the auction house -----------------------------------
# A post-broadcast wrapper step, not part of Deploy.s.sol: createAuction only escrows the lot and
# opens the listing, the clock starts on the first bid (endTime stays 0 until then). Allowed under
# RESUME too, since it lists the token that already exists on chain rather than anything from this
# broadcast.

AUCTION_ID=""
if [ "$LIST_OWNER_TOKEN" = "1" ]; then
  HAS_AUCTION=$(cast call "$HOUSE" 'hasAuctionFor(address,uint256)(bool)' "$SHAPES" 0 --rpc-url "$RPC")
  OWNER_TOKEN_HOLDER=$(cast call "$SHAPES" 'ownerOf(uint256)(address)' 0 --rpc-url "$RPC")

  if [ "$HAS_AUCTION" = "true" ]; then
    [ "$RESUME" = "1" ] \
      || { echo "refusing: owner token already has an auction on a supposedly fresh deploy" >&2; exit 1; }
    echo "  skip: owner token is already listed"
  elif [ "$RESUME" = "1" ] && [ "$(lower "$OWNER_TOKEN_HOLDER")" != "$(lower "$EFFECTIVE_DEPLOYER")" ]; then
    echo "  skip: owner token is held by $OWNER_TOKEN_HOLDER, not the deployer; not listing" >&2
  else
    [ "$(cast call "$SHAPES" 'ownerToken()(uint256)' --rpc-url "$RPC")" = "0" ] \
      || { echo "refusing: ownerToken() is not 0" >&2; exit 1; }
    require_address_read 'owner token holder' "$OWNER_TOKEN_HOLDER" "$EFFECTIVE_DEPLOYER"

    echo "Listing the owner token (#0) in the auction house"
    echo "  duration            ${AUCTION_DURATION}s"
    echo "  reserve units       $AUCTION_RESERVE_UNITS"
    echo "  min increment bps   $AUCTION_MIN_INCREMENT_BPS"
    echo "  extension window    ${AUCTION_EXTENSION_WINDOW}s"

    send_wait "$SHAPES" 'approve(address,uint256)' "$HOUSE" 0 >/dev/null
    send_wait "$HOUSE" 'createAuction(address,uint256,uint64,uint64,uint16,uint32)' \
      "$SHAPES" 0 "$AUCTION_DURATION" "$AUCTION_RESERVE_UNITS" "$AUCTION_MIN_INCREMENT_BPS" \
      "$AUCTION_EXTENSION_WINDOW" >/dev/null

    HAS_AUCTION=$(cast call "$HOUSE" 'hasAuctionFor(address,uint256)(bool)' "$SHAPES" 0 --rpc-url "$RPC")
    [ "$HAS_AUCTION" = "true" ] || { echo "owner token listing did not take effect" >&2; exit 1; }
  fi

  if [ "$HAS_AUCTION" = "true" ]; then
    AUCTION_INFO=$(cast call "$HOUSE" 'getAuctionFor(address,uint256)(bool,uint256)' "$SHAPES" 0 --rpc-url "$RPC")
    AUCTION_ID=$(printf '%s' "$AUCTION_INFO" | tail -1 | awk '{print $1}')
    require_address_read 'Shape #0 owner' "$(cast call "$SHAPES" 'ownerOf(uint256)(address)' 0 --rpc-url "$RPC")" "$HOUSE"
    AUCTION_STRUCT=$(cast call "$HOUSE" \
      "auctions(uint256)(address,address,uint256,uint64,uint64,uint32,uint16,uint64,uint64,address,bool,bool)" \
      "$AUCTION_ID" --rpc-url "$RPC")
    AUCTION_END_TIME=$(printf '%s' "$AUCTION_STRUCT" | sed -n '4p' | awk '{print $1}')
    [ "$AUCTION_END_TIME" = "0" ] \
      || { echo "auction $AUCTION_ID has a nonzero endTime ($AUCTION_END_TIME)" >&2; exit 1; }
    echo "  ok: owner token listed as auction $AUCTION_ID (endTime $AUCTION_END_TIME, still waiting on a first bid)"
  fi
fi

# --- optional: sign and submit the one-time artist attestation ----------------------------------
# A post-broadcast wrapper step, not part of Deploy.s.sol. Mirrors the retired
# attest-artist-sepolia.sh (same digest, confirmation and postflight-readback safeguards) but works
# for every env through the wallet already resolved above. Never issue a second valid signature for
# a competing hash: anyone holding an older valid signature can win the one-time slot.

if [ "$ATTEST_ARTIST" = "1" ]; then
  if [ "$ARTIST_RELEASE_HASH_ONCHAIN" != "$ZERO_HASH" ]; then
    echo "  skip: artist attestation already signed ($ARTIST_RELEASE_HASH_ONCHAIN)"
  else
    RELEASE_HASH="$SHAPES_TX"
    if [ -n "${SHAPES_RELEASE_HASH:-}" ]; then
      [[ "$SHAPES_RELEASE_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]] \
        || { echo "refusing: SHAPES_RELEASE_HASH must be an exact bytes32 hex value" >&2; exit 1; }
      RELEASE_HASH="$SHAPES_RELEASE_HASH"
      [ "$(lower "$SHAPES_RELEASE_HASH")" = "$(lower "$SHAPES_TX")" ] \
        || echo "  WARNING: SHAPES_RELEASE_HASH ($SHAPES_RELEASE_HASH) overrides the Shapes creation tx ($SHAPES_TX)" >&2
    fi

    ATTEST_ARTIST_ADDRESS=$(cast call "$SHAPES" 'artist()(address)' --rpc-url "$RPC")
    ATTEST_SIGNER=$(cast wallet address "${WALLET_ARGS[@]}")
    [ "$(lower "$ATTEST_SIGNER")" = "$(lower "$ATTEST_ARTIST_ADDRESS")" ] \
      || { echo "refusing: signer $ATTEST_SIGNER is not artist() ($ATTEST_ARTIST_ADDRESS)" >&2; exit 1; }
    DIGEST=$(cast call "$SHAPES" 'artistAttestationDigest(bytes32)(bytes32)' "$RELEASE_HASH" --rpc-url "$RPC")

    echo "Artist attestation for $ENV_NAME"
    echo "  chain id       $ACTUAL_CHAIN_ID"
    echo "  Shapes         $SHAPES"
    echo "  artist         $ATTEST_ARTIST_ADDRESS"
    echo "  release hash   $RELEASE_HASH"
    echo "  EIP-712 digest $DIGEST"
    echo
    echo "This signature is permanent once submitted. Confirm the release-hash preimage separately."

    if [ "$WALLET" = "anvil" ] && [ -n "${ATTEST_CONFIRM:-}" ]; then
      [ "$ATTEST_CONFIRM" = "$RELEASE_HASH" ] \
        || { echo "refusing: ATTEST_CONFIRM did not match the release hash" >&2; exit 1; }
    else
      read -r -p "Type the exact release hash to sign: " CONFIRM_HASH
      [ "$CONFIRM_HASH" = "$RELEASE_HASH" ] \
        || { echo "refusing: release hash confirmation did not match" >&2; exit 1; }
    fi

    ATTEST_SIGNATURE=$(cast wallet sign "${WALLET_ARGS[@]}" --no-hash "$DIGEST")

    # Simulate the exact call before broadcasting. The artist may be an EIP-7702 delegated EOA;
    # the attribution library checks its ECDSA key before falling back to ERC-1271.
    cast call "$SHAPES" "attestArtist(bytes32,bytes)" "$RELEASE_HASH" "$ATTEST_SIGNATURE" \
      --from "$ATTEST_ARTIST_ADDRESS" --rpc-url "$RPC" >/dev/null

    ATTEST_TX=$(send_wait "$SHAPES" 'attestArtist(bytes32,bytes)' "$RELEASE_HASH" "$ATTEST_SIGNATURE")
    echo "  transaction    $ATTEST_TX"

    ARTIST_RELEASE_HASH_ONCHAIN=$(cast call "$SHAPES" 'artistReleaseHash()(bytes32)' --rpc-url "$RPC")
    [ "$(lower "$ARTIST_RELEASE_HASH_ONCHAIN")" = "$(lower "$RELEASE_HASH")" ] \
      || { echo "postflight release hash mismatch" >&2; exit 1; }
    [ "$(cast call "$SHAPES" 'artistSignature()(bytes)' --rpc-url "$RPC")" = "$ATTEST_SIGNATURE" ] \
      || { echo "postflight artist signature mismatch" >&2; exit 1; }
    echo "  ok: artist attestation stored and read back ($ARTIST_RELEASE_HASH_ONCHAIN)"
  fi
fi

# --- record the deployment: same key set and order as web/public/deployment.json, so cutover ----
# is a plain file copy. Always written, verification failures above notwithstanding.

mkdir -p deployments
DEPLOYMENT_FILE="deployments/${CHAIN_ID}.json"

# The linked libraries, keyed by contract name. The broadcast records each as
# "<source>:<Contract>:<address>"; the site's /contracts page reads this map to place an address
# beside each library, and shows a missing one as not recorded.
LIBRARIES_JSON=$(jq -r '[.libraries[]? // empty] | map(split(":")) | map({key: .[1], value: (.[2] | ascii_downcase)}) | from_entries' \
  "$BROADCAST_FILE")

ARTIST_RELEASE_HASH_RECORD=""
[ "$ARTIST_RELEASE_HASH_ONCHAIN" = "$ZERO_HASH" ] || ARTIST_RELEASE_HASH_RECORD="$ARTIST_RELEASE_HASH_ONCHAIN"
jq -n \
  --arg rpc "$RPC" \
  --arg indexerUrl "${INDEXER_URL:-}" \
  --argjson chainId "$CHAIN_ID" \
  --arg shapes "$SHAPES" \
  --arg renderer "$RENDERER" \
  --arg collection "$COLLECTION" \
  --arg auctionHouse "$HOUSE" \
  --arg mintFeeWei "$MINT_FEE_ONCHAIN" \
  --arg mintStart "$MINT_START_ONCHAIN" \
  --argjson libraries "$LIBRARIES_JSON" \
  --argjson fromBlock "$FROM_BLOCK" \
  --arg auctionId "$AUCTION_ID" \
  --arg artistReleaseHash "$ARTIST_RELEASE_HASH_RECORD" \
  --arg commit "$DEPLOY_COMMIT" \
  --arg branch "$DEPLOY_BRANCH" \
  '{rpc:$rpc,indexerUrl:$indexerUrl,chainId:$chainId,shapes:$shapes,renderer:$renderer,collection:$collection,auctionHouse:$auctionHouse,mintFeeWei:$mintFeeWei,mintStart:$mintStart,libraries:$libraries,fromBlock:$fromBlock,auctionId:(if $auctionId == "" then null else $auctionId end),artistReleaseHash:(if $artistReleaseHash == "" then null else $artistReleaseHash end),commit:$commit,branch:$branch}' \
  >"$DEPLOYMENT_FILE"

echo
echo "Deployed to $ENV_NAME (chain $CHAIN_ID)"
echo "  Shapes          $SHAPES"
echo "  ShapeRenderer   $RENDERER"
echo "  ShapeCollection $COLLECTION"
echo "  AuctionHouse    $HOUSE"
echo "  deployment tx   $SHAPES_TX"
echo "  from block      $FROM_BLOCK"
echo "  auction id      ${AUCTION_ID:-none}"
echo "  artist attest   ${ARTIST_RELEASE_HASH_RECORD:-none}"
echo "  admin           $EFFECTIVE_DEPLOYER"
echo "  commit          $DEPLOY_COMMIT"
echo "  branch          $DEPLOY_BRANCH"
echo "  wrote           $DEPLOYMENT_FILE"

if [ "${#VERIFY_FAILURES[@]}" -gt 0 ]; then
  echo
  echo "verification failed for ${#VERIFY_FAILURES[@]} of the deployed contracts/libraries:" >&2
  for f in "${VERIFY_FAILURES[@]}"; do
    echo "  ${f%% :: *}" >&2
    echo "    retry: ${f#* :: }" >&2
  done
  exit 1
fi
