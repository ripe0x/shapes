# External audit brief: Shapes owner-token pre-mainnet candidate

You are an independent smart-contract security auditor. Audit the fixed repository snapshot below
as code intended to custody real ETH and redeemable ERC-721 assets on Ethereum mainnet. Report
findings; do not change the audited tree.

## Fixed target

```text
repository  https://github.com/ripe0x/shapes
commit      c583c76 (merge of PR #58 into main, 2026-09-02)
phase       P2 pre-mainnet
```

Audit this exact commit, not a branch tip. Record the full hash and clean status in the report.
`AUDIT_PROMPT_v2.md` through `AUDIT_PROMPT_v6.md` are historical and not authoritative. Deploy
tooling changes (the unified `script/Deploy.s.sol` and `script/deploy.sh`) land in a follow-up
merge from branch `claude/post-deploy-56`, after this pinned commit; the contracts under audit are
unaffected. The immutable `mintStart` gate on public minting lands in a follow-up merge from branch
`claude/mint-start`, also after this pinned commit.

```bash
git fetch origin
git checkout c583c76
git status --short
git log -1 --oneline
```

## Architecture and trust boundary

`Shapes` is the sole ETH reserve and lifecycle authority. It owns minting, redemption,
recomposition, provenance, ERC-721 ownership, renderer/collection references, future mint-fee
routing, two discovery pointers and one-time artist attestation. It has no proxy or arbitrary
execution layer.

One live Shape is the owner token, tracked by `_ownerToken` and exposed by `ownerToken()`; it is
otherwise a normal backed and transferable NFT. It starts as #0 and moves only through `compose`
(a donor moves it to the survivor), `decompose` (restored to that input) and `split` (given to the
first output); `decomposeTo`/`splitTo` make the chosen recipient the collection owner. `owner()`
returns its current holder, or zero once it is redeemed or burned, which ends collection ownership
permanently with no token inheriting and no renounce entrypoint. Its metadata name is the
ordinary token name suffixed with `, Contract Owner` (e.g. `Shape 5, Contract Owner`), and its
exclusive metadata attribute is the value-only `"Contract Owner"` (no `trait_type`).
Holding it conveys no administrative authority. The separate `admin()` role controls only the
documented bounded mutable surfaces.

The release exposes exactly two named canonical discovery pointers, `positions()` and `market()`.
`positions` begins zero; the deploy registers the auction house as `market`. Both begin unlocked;
admin may set, clear or permanently lock each independently. A nonzero target must contain code and
answer ERC-165 for the interface its reader calls. Renouncing admin freezes every still-unlocked
pointer at its last value because no caller remains authorized. Canonical means surfaced by Shapes,
not exclusive.

The pointers and their targets must remain powerless over Shapes. No core value or token-state
operation may read or call them. `Shapes.positionOf` reads the current positions target with a
50,000-gas cap and converts revert, out-of-gas, empty, short or malformed returns to the zero
address. The market target is discovery-only and is never called by Shapes.

`RecompositionOps` and `AdminOps` are stateless linked libraries. Shapes reaches each by
delegatecall; `RecompositionOps` runs the compose, decompose and split state machine and the
previews over one `ShapeStore` pointer, `AdminOps` runs every configuration write behind
admin-gated wrappers, and
neither has authority at its own deployed address. Treat storage-slot selection, delegatecall
boundaries and linked address integrity as high-priority review areas for both.

## Flat-fee change requiring fresh review

The current candidate replaces the prior percentage fee with one immutable flat fee per Shape
created:

- mainnet default: `0.001 ETH` per Shape;
- isolated 1/100 testnet profile: `0.00001 ETH` per Shape;
- direct and batch mints pay one fee per output NFT, independent of denomination;
- an auction ETH bid mints the minimal card representation of its backing and pays one fee for
  every card created;
- `ShapeCardEscrow.mintCostFor(backingWei)` quotes exact backing plus per-card fees;
- card-only bids create no Shape and pay no mint fee;
- Shape #0 is constructor-minted and fee-exempt;
- fees are forwarded immediately and never become redeemable backing.

This deliberately creates different economics across paths. A direct 100 ETH candidate costs a
0.001 ETH fee while temporarily tying up 100 ETH; 10,000 independently minted 0.01 ETH Shapes cost
10 ETH in fees before composition. Review both technical correctness and any exploitable
assumption that previously depended on denomination-proportional fees. Do not report the stated
economic asymmetry itself as a vulnerability unless it violates a documented security property.

## Scope

- `src/Shapes.sol`: payable genesis construction, the owner token and its movement through
  compose/decompose/split, flat-fee mint paths, fee forwarding, reserve accounting, redemption,
  recomposition, provenance, Black terminal state, owner/admin separation, renderer/collection
  references, discovery and artist attestation. The follow-up merge from `claude/mint-start` adds
  the immutable `mintStart` gate on `mint`, `mintTo`, `mintBatch` and `mintBatchTo`; review it for
  admin-free construction, exact boundary behavior at `block.timestamp == mintStart`, and that
  Shape #0's constructor mint remains unconditional.
- `src/ShapeAuctionHouse.sol` and `src/ShapeCardEscrow.sol`: lot custody, ETH/card bidding,
  per-card mint-fee quoting/payment, anti-sniping, settlement, pull delivery, escrow accounting and
  reentrancy boundaries.
- `src/ShapeRenderer.sol` and `src/ShapeCollection.sol`: metadata, bounded rendering,
  replaceability/locking and presentation-only entropy, including the owner token's special
  identity.
- The linked libraries: `RecompositionOps`, `AdminOps`, `ComposeCompute`, `CopyValidation`,
  `EIP712Signature`, `GeometrySampling` and `InkGenes`. `RecompositionOps` holds the compose,
  decompose and split bodies, the previews, and the decoded record reads, over one `ShapeStore`
  storage pointer; `AdminOps` holds every configuration write behind admin-gated wrappers in
  `Shapes.sol`. Review the storage-struct layout each receives and the delegatecall boundary: no
  library may write ERC-721 state, move ETH, or touch the owner token or the admin address.
- All interfaces under `src/interfaces/`, including ERC-165 capability claims.
- `script/Deploy.s.sol`, `script/deploy.sh`, shell guards, seed/evidence scripts and release fork
  tests: immutable configuration, exact value construction, wiring, ladder/profile selection and
  fail-closed checks.

Tests, specifications, prior findings, the TypeScript renderer and fixtures are evidence, not
trusted implementations. The site and indexer are outside value-custody scope except where their
fee/ABI assumptions expose an onchain safety or liveness failure.

## Security properties to falsify

1. Shapes remains solvent: its ETH balance covers every live, non-Black redeemable backing value.
2. Minting is the only operation that increases redeemable backing. Redemption and sacrifice
   reduce it exactly; compose, decompose and split conserve it.
3. Every direct or batch output charges exactly one flat fee. A fee is never counted as backing,
   retained accidentally, charged twice, bypassed, rounded by denomination or redirected from the
   recipient recorded for that mint.
4. Auction ETH bids charge exactly one flat fee per minimal card created. `cardsFor`,
   `mintCostFor` and actual mint execution agree for zero, every unit multiple, every denomination,
   mixed decompositions and maximum accepted amounts. Card-only bids pay no mint fee.
5. Incorrect payment, unsupported denomination, invalid unit multiples, fee-recipient failure and
   reentrancy revert atomically without stranded ETH, cards, partial mints or accounting drift.
6. No sequence forges origins, exceeds denomination capacity, forges Complete, rerolls ink without
   fresh mint entropy, or escapes the Black terminal state.
7. Every fresh token id is collision-free with every live or decompose-revivable id, including #0.
8. The owner token grants no administrative power. Its movement through compose, decompose and
   split, and its permanent end on redeem/burn, changes only the `owner()`/`ownerToken()` signal
   and presentation; it cannot alter reserve accounting, auction eligibility or lifecycle behavior
   of any token. `OwnerTokenMoved` and the compose record's `ownerTokenFrom` match actual movement
   exactly, including nested and nothing-to-restore cases.
9. Positions, market and their targets cannot move Shapes or ETH, change backing or
   denomination, block/redirect redemption, affect mint/recomposition, change ownership, execute
   for holders, or enter any core authorization decision.
10. Pointer entries enforce independent lock permanence, authorization, code checks and exact zero
    behavior. Admin renunciation creates no alternate setter or locker.
11. `Shapes.positionOf` cannot make any core operation depend on an external target and cannot
    turn hostile return data or gas consumption into uncontrolled failure.
12. Direct artist attestation is deployment-bound, one-time, signature-valid and powerless. The
    payable genesis constructor cannot misaccount backing or charge a public mint fee.
13. Every linked-library address, immutable dependency, interface id, mint fee and denomination
    ladder at deployment matches the intended profile; stale or mixed build inputs fail closed.
14. The auction house and escrow retain no unaccounted ETH or Shapes. Each card and lot has one
    claimant, cannot be claimed twice, and cannot be stranded by another party's receiver behavior.
15. Bids use redeemable backing, advance by a representable whole unit, and cannot charge or lock
    more than accepted. Anti-sniping can extend but never shorten the deadline.
16. Renderer and collection calls cannot mutate value state or become required for redemption. Renderer
    replacement/locking cannot alter ownership, backing, provenance or redemption rights.
17. Solidity rendering remains byte-identical to accepted TypeScript fixtures and the frozen
    legacy oracle.

## Required adversarial review

- Construct concrete call sequences for every suspected value, custody, authorization, replay,
  reentrancy, denial-of-service or accounting issue. Include hostile ERC-721 receivers, contracts
  that are seller and fee recipient, fee-recipient callbacks, forced ETH, unusual admin/owner
  transfers, owner-token recomposition and redeem/burn, and maximum-card escrow paths.
- Trace every payable call and exact-value calculation. Fuzz all denominations and quantities,
  especially batch multiplication and auction amounts that produce one, several or the maximum
  number of cards. Compare quotes, emitted events, recipient balances, reserve deltas and rollback.
- Review every external call and checks-effects-interactions boundary. Treat permanent loss or lock
  of a user's asset as a finding even when global solvency remains intact.
- Trace every core state-changing entrypoint and confirm it never reads or calls positions, market
  or a registered target. Review each library's storage-struct layout against the exact Shapes layout and all
  inheritance effects.
- Resolve D-17 explicitly: `minIncrementBps` is seller-supplied `uint16` without a separate policy
  cap. Determine whether any value causes overflow, an unrepresentable/deadlocked next bid,
  bidder-side loss, or only a disclosed seller-chosen curve. Recommend a bound only if it closes a
  demonstrated property failure.
- Check liveness at protocol extremes: the 10,000-unit ladder, 25-module renderer, maximum escrow
  cards, deep provenance and every stored/caller-controlled loop.
- Compare interfaces, events, NatSpec, deployment scripts and tests to implementation. Treat each
  assertion as a claim to falsify, not proof.

## Existing evidence, not substitutes for review

- Default and testnet Foundry profiles each pass 519 tests with 4 expected RPC-only skips.
- Runtime sizes, default/testnet: Shapes 20,370/20,353 bytes (4,206/4,223 bytes of EIP-170 margin);
  RecompositionOps 12,246/12,228; ShapeRenderer 23,442/23,441; ShapeAuctionHouse 8,015/8,006;
  ShapeCollection 4,077/4,070.
- `IShapes` is `0xaaf9b098`.
- This candidate is not yet deployed to Sepolia or mainnet; there is no live-deployment evidence
  for it yet. Re-run Medusa, the Anvil lifecycle rehearsal, preview/web builds and the indexer
  checks against the pinned commit above rather than relying on prior releases' results.
- `SECURITY.md`, `project/DECISIONS.md`, `project/RISKS.md` and experiment records document accepted
  risks and prior evidence. Re-report an accepted item when its assumptions are false here.

## Reproduction commands

```bash
forge build --sizes
forge test -vv
FOUNDRY_PROFILE=testnet forge build --sizes
FOUNDRY_PROFILE=testnet forge test -vv
FOUNDRY_PROFILE=ci forge test -vv
MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --mc ForkTest -vv

cd preview
npm ci
npx tsc --noEmit
npm test
npm run verify
npm run sweep
npm run fixtures
SHAPES_LADDER=testnet npm run fixtures
```

Run the documented Medusa campaign, site/indexer gates, deployment dry run and fixture-diff checks.
State every skipped or unavailable check explicitly.

## Deliverable

For each finding provide severity, exact file/line at the pinned commit above, violated property, concrete
sequence with values, impact, smallest safe remediation and a regression test. Separate confirmed
findings from open questions and hardening suggestions. Include methodology, commands run, skipped
coverage, linked-library/storage-layout review, flat-fee and per-card accounting review, and a final
disposition for D-17.

An empty confirmed-findings section is acceptable. Speculation presented as a finding is not.
