# External audit brief: Shapes flat-fee pre-mainnet candidate

You are an independent smart-contract security auditor. Audit the fixed repository snapshot below
as code intended to custody real ETH and redeemable ERC-721 assets on Ethereum mainnet. Report
findings; do not change the audited tree.

## Fixed target

```text
repository  https://github.com/ripe0x/shapes
commit      217498564f46667bc8fabce32be0a19c22d7e431
short       2174985
phase       P2 pre-mainnet
```

Audit this exact commit, not a branch tip. Record the full hash and clean status in the report.
`AUDIT_PROMPT_v2.md` through `AUDIT_PROMPT_v5.md` are historical and not authoritative.

```bash
git fetch origin
git checkout 217498564f46667bc8fabce32be0a19c22d7e431
git status --short
git log -1 --oneline
```

## Architecture and trust boundary

`Shapes` is the sole ETH reserve and lifecycle authority. It owns minting, redemption,
recomposition, provenance, ERC-721 ownership, renderer/collection references, future mint-fee
routing, two discovery pointers and one-time artist attestation. It has no proxy or arbitrary
execution layer.

Shape #0 is a normal backed and transferable NFT whose fixed metadata name is
`Shapes Collection Owner` and whose exclusive metadata trait is `Collection Owner: true`.
Holding it conveys no administrative authority. The separate `admin()` role controls only the
documented bounded mutable surfaces.

The release exposes exactly two named canonical discovery pointers, `positions()` and `market()`.
Both begin zero and unlocked; admin may set, clear or permanently lock each independently. A
nonzero target must contain code. Renouncing admin freezes every still-unlocked pointer at its last
value because no caller remains authorized. Canonical means surfaced by Shapes, not exclusive.

The pointers and their targets must remain powerless over Shapes. No core value or token-state
operation may read or call them. `ShapeLens.positionOf` is optional periphery: it reads the current
positions target with a 50,000-gas cap and converts revert, out-of-gas, empty, short or malformed
returns to the zero address. The market target is discovery-only and is never called by Shapes or
ShapeLens.

`PointerOps` is a stateless linked library. Shapes reaches it by delegatecall only through
admin-gated wrappers; the library mutates designated Shapes pointer/lock slots and has no authority
at its own deployed address. Treat storage-slot selection, delegatecall boundaries and linked
address integrity as high-priority review areas.

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

- `src/Shapes.sol`: payable genesis construction, Shape #0, flat-fee mint paths, fee forwarding,
  reserve accounting, redemption, recomposition, provenance, Black terminal state, owner/admin
  separation, renderer/collection references, discovery and artist attestation.
- `src/ShapeAuctionHouse.sol` and `src/ShapeCardEscrow.sol`: lot custody, ETH/card bidding,
  per-card mint-fee quoting/payment, anti-sniping, settlement, pull delivery, escrow accounting and
  reentrancy boundaries.
- `src/ShapeLens.sol`: liveness, state/provenance/preview reads and bounded positions lookup.
- `src/ShapeRenderer.sol` and `src/ShapeCollection.sol`: metadata, bounded rendering,
  replaceability/locking and presentation-only entropy, including Shape #0's special identity.
- The six linked libraries: `ComposeCompute`, `CopyValidation`, `EIP712Signature`,
  `GeometrySampling`, `InkGenes` and `PointerOps`.
- All interfaces under `src/interfaces/`, including ERC-165 capability claims.
- `script/DeployShapes.s.sol`, `script/DeploySepolia.s.sol`, shell guards, seed/evidence scripts and
  release fork tests: immutable configuration, exact value construction, wiring, ladder/profile
  selection and fail-closed checks.

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
8. Shape #0 grants no administrative power. Its special name/trait changes presentation only and
   cannot alter ownership, reserve accounting, auction eligibility or lifecycle behavior.
9. Positions, market, their targets and PointerOps cannot move Shapes or ETH, change backing or
   denomination, block/redirect redemption, affect mint/recomposition, change ownership, execute
   for holders, or enter any core authorization decision.
10. Pointer entries enforce independent lock permanence, authorization, code checks and exact zero
    behavior. Admin renunciation creates no alternate setter or locker.
11. `ShapeLens.positionOf` cannot make any core operation depend on an external target and cannot
    turn hostile return data or gas consumption into uncontrolled failure.
12. Direct artist attestation is deployment-bound, one-time, signature-valid and powerless. The
    payable genesis constructor cannot misaccount backing or charge a public mint fee.
13. Every linked-library address, immutable dependency, interface id, mint fee and denomination
    ladder at deployment matches the intended profile; stale or mixed build inputs fail closed.
14. The auction house and escrow retain no unaccounted ETH or Shapes. Each card and lot has one
    claimant, cannot be claimed twice, and cannot be stranded by another party's receiver behavior.
15. Bids use redeemable backing, advance by a representable whole unit, and cannot charge or lock
    more than accepted. Anti-sniping can extend but never shorten the deadline.
16. Lens and renderer calls cannot mutate value state or become required for redemption. Renderer
    replacement/locking cannot alter ownership, backing, provenance or redemption rights.
17. Solidity rendering remains byte-identical to accepted TypeScript fixtures and the frozen
    legacy oracle.

## Required adversarial review

- Construct concrete call sequences for every suspected value, custody, authorization, replay,
  reentrancy, denial-of-service or accounting issue. Include hostile ERC-721 receivers, contracts
  that are seller and fee recipient, fee-recipient callbacks, forced ETH, unusual admin/owner
  transfers, Shape #0 recomposition and maximum-card escrow paths.
- Trace every payable call and exact-value calculation. Fuzz all denominations and quantities,
  especially batch multiplication and auction amounts that produce one, several or the maximum
  number of cards. Compare quotes, emitted events, recipient balances, reserve deltas and rollback.
- Review every external call and checks-effects-interactions boundary. Treat permanent loss or lock
  of a user's asset as a finding even when global solvency remains intact.
- Trace every core state-changing entrypoint and confirm it never reads or calls positions, market
  or a registered target. Review PointerOps' storage slots against the exact Shapes layout and all
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

- Default, testnet and deeper CI Foundry profiles each pass 462 tests with 4 expected RPC-only
  skips; all 4 release-fork tests pass against a live Ethereum RPC.
- Medusa 1.5.1 passes 10/10 reserve/lifecycle properties across 44,411 calls.
- The local Anvil rehearsal passes deploy, artist attestation, every denomination, exact reserve
  unwind, auction ETH bid, settlement, both claims and zero retained ETH/Shapes.
- All 127 preview tests, preview TypeScript/build, web lint/build, indexer tests/codegen/typecheck,
  documentation selectors and shell syntax pass. Indexer production dependency audit reports zero
  vulnerabilities.
- Renderer verify/sweep and both-ladder fixture regeneration are clean and unchanged.
- Runtime sizes before/after the flat-fee change, default/testnet: Shapes
  24,474/24,453 to 24,362/24,341; ShapeLens unchanged 9,885/9,867; ShapeRenderer unchanged
  23,331/23,330; ShapeAuctionHouse 7,872/7,862 to 7,939/7,930. Shapes retains only 214/235 bytes
  below EIP-170.
- `IShapes` changes from `0xbdf217ea` to `0x86cf5406` before any mainnet deployment.
- The currently live Sepolia release is historical `dba4dbf`, uses 100 bps and does not validate
  this candidate's flat-fee ABI. A fresh Sepolia deployment and lifecycle walkthrough remain
  required after merge.
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

For each finding provide severity, exact file/line at `2174985`, violated property, concrete
sequence with values, impact, smallest safe remediation and a regression test. Separate confirmed
findings from open questions and hardening suggestions. Include methodology, commands run, skipped
coverage, linked-library/storage-layout review, flat-fee and per-card accounting review, and a final
disposition for D-17.

An empty confirmed-findings section is acceptable. Speculation presented as a finding is not.
