# External audit brief: Shapes pre-mainnet release

You are an independent smart-contract security auditor. Audit the fixed repository snapshot below
as code intended to custody real ETH and redeemable ERC-721 assets on Ethereum mainnet. Report
findings; do not change the audited tree.

## Fixed target

```text
repository  https://github.com/ripe0x/shapes
commit      dba4dbfe93df64cc72052c3eab70289070e301d9
short       dba4dbf
phase       P2 pre-mainnet
```

Audit this exact commit, not a moving branch tip. Record the full hash and clean status in the
report. `AUDIT_PROMPT_v2.md`, `AUDIT_PROMPT_v3.md` and `AUDIT_PROMPT_v4.md` are historical inputs;
their commits, interfaces, test counts and architecture descriptions are not authoritative.

```bash
git fetch origin
git checkout dba4dbfe93df64cc72052c3eab70289070e301d9
git status --short
git log -1 --oneline
```

## Architecture and trust boundary

`Shapes` is the sole ETH reserve and lifecycle authority. It owns minting, redemption,
recomposition, provenance, ERC-721 ownership, renderer/collection references, future mint-fee
routing, and one-time artist attestation. It has no proxy or arbitrary execution layer.

Two generic-looking alternatives were explicitly rejected. The release instead exposes exactly
two named canonical discovery pointers, `positions()` and `market()`. Both begin zero and unlocked;
admin may set, clear or permanently lock each independently. A nonzero target must contain code.
Renouncing admin freezes every still-unlocked pointer at its last value because no caller remains
authorized. Canonical means surfaced by Shapes, not exclusive.

The pointers and their targets must remain powerless over Shapes. No core value or token-state
operation may read or call them. `ShapeLens.positionOf` is optional periphery: it reads the current
positions target with a 50,000-gas cap and converts revert, out-of-gas, empty, short or malformed
returns to the zero address. The market target is discovery-only and is never called by Shapes or
ShapeLens.

`PointerOps` is a stateless linked library. Shapes reaches it by delegatecall only through
admin-gated wrappers; the library mutates the designated Shapes pointer/lock slots and has no
authority at its own deployed address. Treat storage-slot selection, delegatecall boundaries and
linked-address integrity as high-priority review areas.

## Scope

The Solidity system and release guards are in scope:

- `src/Shapes.sol`: payable genesis construction, Shape #0, mint/redeem, recomposition,
  provenance, Black terminal state, reserve accounting, owner/admin separation, fee routing,
  renderer/collection references, positions/market discovery and artist attestation.
- `src/ShapeAuctionHouse.sol` and `src/ShapeCardEscrow.sol`: lot custody, ETH/card bidding,
  anti-sniping, settlement, pull-based delivery, escrow accounting and reentrancy boundaries.
- `src/ShapeLens.sol`: liveness, state/provenance/preview reads and bounded positions lookup.
- `src/ShapeRenderer.sol` and `src/ShapeCollection.sol`: metadata, bounded rendering,
  replaceability/locking and presentation-only entropy.
- The six externally linked libraries: `ComposeCompute`, `CopyValidation`, `EIP712Signature`,
  `GeometrySampling`, `InkGenes` and `PointerOps`.
- All interfaces under `src/interfaces/`, including ERC-165 capability claims.
- `script/DeployShapes.s.sol`, `script/DeploySepolia.s.sol`, deployment shell guards and release
  fork tests: wiring, immutable configuration, profile/ladder selection and fail-closed checks.

Tests, specifications, prior findings, the TypeScript renderer and fixtures are evidence, not
trusted implementations. The site and indexer are outside value-custody scope except where their
assumptions expose an onchain safety or liveness failure.

## Security properties to falsify

1. Shapes remains solvent: its ETH balance covers every live, non-Black redeemable backing value.
2. Minting is the only operation that increases redeemable backing. Redemption and sacrifice
   reduce it exactly; compose, decompose and split conserve it.
3. No sequence forges origins, exceeds denomination capacity, forges Complete, rerolls ink without
   fresh mint entropy, or escapes the Black terminal state.
4. Every fresh token id is collision-free with every live or decompose-revivable id, including #0.
5. Shape #0 is an ordinary backed, transferable collectible and grants no administrative power.
   Only `admin()` controls the documented bounded mutable surfaces.
6. Positions, market, their targets and PointerOps cannot move Shapes or ETH, change backing or
   denomination, block/redirect redemption, affect mint/recomposition, change ownership, execute
   for holders, or enter any core authorization decision.
7. Pointer entries enforce independent lock permanence, authorization, code checks and exact zero
   behavior. Admin renunciation must create no alternate setter or locker.
8. `ShapeLens.positionOf` cannot make any core operation depend on an external target and cannot
   turn hostile return data or gas consumption into uncontrolled failure.
9. Direct artist attestation is deployment-bound, one-time, signature-valid and powerless. The
   payable genesis constructor cannot misaccount backing or mint fee.
10. Every linked-library address, immutable dependency, interface id and denomination ladder at
    deployment matches the intended release; stale profile/build inputs must fail closed.
11. The auction house and escrow retain no unaccounted ETH or Shapes. Each card and lot has one
    claimant, cannot be claimed twice, and cannot be stranded by another party's receiver behavior.
12. Bids use redeemable backing, advance by a representable whole unit, and cannot charge or lock
    more than accepted. Anti-sniping can extend but never shorten the deadline.
13. Lens and renderer calls cannot mutate value state or become required for redemption. Renderer
    replacement/locking cannot alter ownership, backing, provenance or redemption rights.
14. Solidity rendering remains byte-identical to accepted TypeScript fixtures and the frozen
    legacy oracle. The D-32 helper extraction must not change SVG, metadata, tokenURI, storage,
    geometry, modules or ABI semantics.

## Required adversarial review

- Construct concrete call sequences for every suspected value, custody, authorization, replay,
  reentrancy, denial-of-service or accounting issue. Include hostile ERC-721 receivers, contracts
  that are seller and fee recipient, forced ETH, unusual admin/owner transfers, Shape #0
  recomposition and maximum-card escrow paths.
- Review every external call and checks-effects-interactions boundary. Treat permanent loss or lock
  of a user's asset as a finding even when global solvency remains intact.
- Trace every core state-changing entrypoint and confirm it never reads or calls positions, market
  or a registered target. Review PointerOps' hard-coded storage slots against the exact Shapes
  layout and all inheritance effects.
- Resolve D-17 explicitly: `minIncrementBps` is seller-supplied `uint16` without a separate policy
  cap. Determine whether any value causes overflow, an unrepresentable/deadlocked next bid,
  bidder-side loss, or only a disclosed seller-chosen curve. Recommend a bound only if it closes a
  demonstrated property failure.
- Check liveness at protocol extremes: the 10,000-unit ladder, 25-module renderer, maximum escrow
  cards, deep provenance and every stored/caller-controlled loop.
- Compare interfaces, events, NatSpec, deployment scripts and tests to implementation. Treat each
  assertion as a claim to falsify, not proof.

## Existing evidence, not substitutes for review

- Both default and testnet Foundry profiles pass 459 tests, with 4 expected RPC-only skips each.
- All 4 mainnet-fork release tests pass against a live public Ethereum RPC.
- CI runs the deep contract profile, renderer parity and Medusa reserve-lifecycle campaign.
- ShapeRenderer output is byte-identical to the TypeScript fixtures and frozen Solidity oracle.
- Exact runtime sizes: Shapes 24,474 bytes default and 24,453 testnet, leaving 102/123 bytes under
  EIP-170; ShapeLens 9,885/9,867; ShapeRenderer 23,138/23,137; PointerOps 605.
- Exact source commit `dba4dbf` is deployed on Sepolia at Shapes
  `0x8172B86708c67D93ab6e666798B7073463371e13`, from block 11613113. Its creation transaction is
  `0x6c162a8b0392e052108912a10b60eedcd7aed4d665032583f5f4724da5dc8d9`.
- Sepolia postflight confirms nine testnet denominations, 100 bps fee, backed/live Shape #0, exact
  reserve equality, correct wiring/roles, zero auctions and positions/market both zero/unlocked.
- All eleven Sepolia contracts/libraries expose verified source on Etherscan; PointerOps, Shapes and
  ShapeLens also have exact Sourcify creation/runtime matches.
- An earlier exact-release auction implementation completed the full two-bid Sepolia lifecycle,
  including extension, settlement, claims, empty house and indexer agreement. This proves one
  execution, not absence of other attack paths.
- `SECURITY.md`, `project/DECISIONS.md`, `project/RISKS.md` and the experiment records document
  accepted risks and prior evidence. Re-report an accepted item when its assumptions are false at
  this commit.

## Reproduction commands

```bash
forge build
forge test -vv
FOUNDRY_PROFILE=testnet forge test -vv
FOUNDRY_PROFILE=ci forge test -vv

cd preview
npm ci
npx tsc --noEmit
npm test
```

Run the repository's documented Medusa, renderer-parity, deployment-dry-run and release-fork gates.
State every skipped or unavailable check explicitly.

## Deliverable

For each finding provide severity, exact file/line at `dba4dbf`, violated property, concrete
sequence with values, impact, smallest safe remediation and a regression test. Separate confirmed
findings from open questions and hardening suggestions. Include methodology, commands run, skipped
coverage, linked-library and storage-layout review, and a final disposition for D-17.

An empty confirmed-findings section is acceptable. Speculation presented as a finding is not.
