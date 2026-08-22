# X-Ray Report

> Shapes | 3,066 nSLOC (in-scope contracts/libraries; 3,583 including 517 nSLOC of interfaces) | `2167dc7` (`HEAD`, detached from `main`) | Foundry | 22/08/26

---

## 1. Protocol Overview

**What it does:** Shapes is an ERC721 that wraps an exact amount of ETH at one of nine fixed denominations (0.01–100 ETH); burning the token returns exactly that ETH to its owner.

- **Users**: Anyone can mint (permissionless, pays backing + a 1% fee) and hold, transfer or redeem a Shape like any NFT. An `Owner` (transferable `Ownable`) administers three value-inert configuration domains. An `Auction Seller`/`Bidder` uses a separate `ShapeAuctionHouse` that prices bids in Shape cards.
- **Core flow**: `mint` (ETH in, token out) and `redeem`/`burn` (token in, exact ETH out) are the whole economic surface; `compose`/`split`/`decompose` reshape tokens without moving ETH.
- **Key mechanism**: A fixed reserve invariant — `address(this).balance >= redeemableBacking()` — with no admin path that can reach it. No oracle, no market pricing: value is denomination-fixed, not price-discovered.
- **Token model**: One ERC721 collection (`Shapes`). No fungible token, no governance token, no LP token. `ShapeAuctionHouse` mints/holds Shapes as bid collateral but issues nothing of its own.
- **Admin model**: A single transferable `Owner` controls presentation (renderer + collection metadata, one-way lockable), an optional position-discovery resolver (independently one-way lockable, may lock at zero), and an optional "contract collector" provenance pointer (independently one-way lockable). None of these three domains can touch ETH, backing, redemption or token ownership.

For a visual overview of the protocol's architecture, see the [architecture diagram](architecture.svg).

### Contracts in Scope

| Subsystem | Key Contracts | nSLOC | Role |
|-----------|---------------|------:|------|
| Core token & reserve | `Shapes` | 848 | ERC721 wrapping exact ETH; mint/redeem/compose/split/sacrifice; sole custodian of the reserve |
| Read periphery | `ShapeLens` | 286 | Stateless preview/state reads, split out to keep `Shapes` under the EIP-170 limit |
| Renderer | `ShapeRenderer` | 1,053 | Fully onchain SVG + metadata; seed-based (grammar v1) and materialized-byte (grammar v2) geometry |
| Collection metadata | `ShapeCollection` | 94 | Contract-level metadata + seeded/animated preview cards, no token involved |
| Auction | `ShapeAuctionHouse`, `ShapeCardEscrow` | 270 | English auction for any ERC-721, bids denominated in and settled with Shape cards |
| Linked libraries | `ComposeCompute`, `ContractCollectorOps`, `CopyValidation`, `GeometrySampling`, `InkGenes` | 304 | Externally linked (5 separate deployments); consensus-critical compose/split sampling and ink-gene logic |
| Internal libraries | `Denominations`, `FixedPoint`, `Round03Rand`, `ModuleCodec`, `GrammarV1Modules` | 211 | Inlined pure math/encoding helpers, not separately deployed |

`Shapes`'s runtime bytecode carries **135 bytes of EIP-170 headroom** at the currently committed build settings (`forge build --sizes`, measured directly against this tree — the `foundry.toml` comment citing "~174B at last measurement" is stale relative to this measurement).

### How It Fits Together

**The core trick:** an ERC721 stores only a denomination index and a seed; `backingOf` derives the redeemable ETH from the index against a fixed, immutable ladder, so an out-of-ladder backing value is unrepresentable in storage.

### Mint → Redeem

```
User.mint(amountWei) [payable]
  └─ Shapes._mintBatch()
       ├─ Denominations.indexOf(amountWei)        — reverts on any non-ladder amount
       ├─ InkGenes.geneAtMint(seed, denomIndex)    — external library call, linked
       ├─ redeemableBacking += backing             — *the reserve-bound write*
       ├─ feeRecipient.call{value: fees}("")        — *forwarded before minting, immutable target*
       └─ _safeMint(to, tokenId)  ×quantity

User.redeem(tokenId)
  └─ Shapes._redeemTo()
       ├─ _burnForRedemption()  — owner check, reads+clears ShapeData & sampled modules, _burn()
       ├─ redeemableBacking -= amountWei            — *decremented before the ETH leaves*
       └─ _sendEth(recipient, amountWei)             — *the only path ETH exits for a live token*
```

### Recomposition (compose)

```
Owner.compose(survivorId, burnIds[])
  └─ Shapes._compose()
       ├─ per burn id: _accumulateBurnDonor()        — accumulates backing, origins, ink-gene pool stats
       ├─ Denominations.requireIndexOf(acc.total)    — *rejects a sum that doesn't land on a denomination*
       ├─ ComposeCompute.composeSampleAndGene()       — external library call: new gene + sampled module bytes
       ├─ s.denomIndex = newIndex                    — *survivor becomes the summed denomination*
       └─ each burnId: delete ShapeData, _burn()      — no ETH moves, no fee charged
```

### Split, and its inverse Decompose

```
Owner.split(tokenId, outDenoms[])
  └─ Shapes._splitTo()
       ├─ _requireSplitSumMatches(parentBacking, outDenoms)  — *conservation guard, Σ children == parent*
       ├─ _allocateSplitOrigins(originCount, outDenoms)       — assert(remaining == 0)
       ├─ delete parent ShapeData, _burn(tokenId)
       └─ per child: GeometrySampling.sampleSplitChild()      — *keyed on the untruncated child index*
                     _safeMint(recipient, newId)

Owner.decompose(survivorId)
  └─ Shapes._decomposeTo()   — pops the LIFO ComposeRecord, restores survivor + re-mints every burned
                                input under its *original* id and seed (totalMinted not advanced)
```

### Auction: bid → settle → claim

```
Bidder.bid(auctionId, cardIds[], ethBackingWei) [payable]
  └─ ShapeAuctionHouse.bid()
       ├─ ShapeCardEscrow._takeBid()
       │    ├─ _takeCards()  — IShapes.backingOf() per card, IERC721(shapes).transferFrom() in
       │    └─ _mintCards()  — IShapes.mintBatchTo{value}()  *reaches the arbitrary feeRecipient*
       └─ if (a.settled) revert            — *re-checked after the external call above (reentrancy fix)*

[auction ends] Anyone.settle(auctionId)     — no external call, cannot be blocked by the lot

Winner.claimLot(auctionId) → IERC721(a.nft).transferFrom(this, winner, tokenId)
Seller.claimProceeds(auctionId) → ShapeCardEscrow._release() → per card: IERC721(shapes).transferFrom()
```

---

## 2. Threat & Trust Model

### Protocol Threat Profile

> Protocol classified as: **Stablecoin-style backing/redemption** (adapted: NFT-denominated, not fungible) with **Escrow/Custody** characteristics (`ShapeAuctionHouse`/`ShapeCardEscrow`)

Shapes matches the Stablecoin profile's core shape — mint against exact collateral, burn for exact collateral, a reserve invariant that must always hold — but with no oracle, no market-set peg and no debt ceiling: backing is fixed by an immutable denomination table, so the entire class of oracle-manipulation and death-spiral threats that dominate real stablecoins does not apply. `ShapeAuctionHouse` adds a second profile: it custodies both an arbitrary third-party NFT and bidders' Shape cards under a pull-only release model, which is the same trust shape as a bridge/escrow holding assets pending a later, permissionless release.

### Actors & Adversary Model

| Actor | Trust Level | Capabilities |
|-------|-------------|--------------|
| Owner | Bounded (value-inert) | Replace renderer/collection (until `lockRenderer`), edit token/collection copy (never locked), set/clear/lock the position resolver, set/lock the contract-collector binding. Every power reaches only presentation or discovery pointers — none can touch ETH, backing, redemption or ownership; all except copy are independently one-way lockable, none are timelocked. |
| Shape Owner (any user) | Untrusted, self-scoped | mint/redeem/compose/split/decompose/sacrifice on tokens they own; cannot affect any other holder's tokens or the reserve beyond their own mint/redeem flow. |
| Fee Recipient | Trusted by construction, immutable | Receives every mint fee; a reverting recipient permanently disables minting (accepted design, SECURITY.md #6). |
| Auction Seller | Untrusted, self-scoped | Lists any ERC721 it owns/is approved for; cannot bid its own auction (G-36/I-8) or affect another auction. |
| Auction Bidder | Untrusted, self-scoped | Escrows Shape cards and/or ETH; can only withdraw its own escrow, never another bidder's. |
| Position Resolver / Collector Token (optional, owner-configured) | Untrusted, gas-capped, fail-safe | Both are pure discovery reads (`positionOf`, `contractCollector`); reverts/out-of-gas/malformed data are swallowed to a default, with zero effect on core state. |
| Auction Lot (arbitrary ERC-721) | Untrusted | Called from exactly two functions (`createAuction`, `claimLot`); per the contract's own NatSpec, a lot that lies about `ownerOf`/`transferFrom` can only harm the bidder who chose to trust it. |

**Adversary Ranking** (adjusted by git evidence — see §6):

1. **Reentrant external-call adversary** (fee recipient, lot NFT, position resolver, collector token) — every value-moving external call target is either attacker-chosen (auction lot) or reaches into arbitrary code (fee forwarding, resolver, collector); the one confirmed historical finding here (fee-recipient reentrancy into `bid`) was fixed in the commit this tree is built from.
2. **Malicious or dishonest auction lot/collection contract** — the only adversary the house's own documentation explicitly declines to fully defend against; bounded to the parties who chose that auction.
3. **Seed/mint-ordinal grinder** — a minter can advance `totalMinted` inside one transaction (mint-then-redeem dust) to select among a small candidate-seed space, most impactful at 50/100 ETH where the composition space is tiny (2,704 / 52 archetypes); accepted design since redemption value never depends on the seed (SPEC.md D3e).
4. **Compromised owner** — broad surface (renderer, collection, copy, resolver, collector) but every power is value-inert by construction; the practical damage ceiling is misleading metadata/artwork until locked, or a wrong discovery pointer.
5. **Griefing via a permanently-reverting counterparty** — a bricked `feeRecipient` disables minting forever (accepted); a reverting redemption recipient only reverts its own transaction, never another holder's.

See [entry-points.md](entry-points.md) for the full permissionless entry point map.

### Trust Boundaries

**Owner → presentation/resolver/collector** — no timelock or multisig enforced at the contract level; every domain is independently one-way lockable and none reaches ETH, backing or ownership. *Git signal: `access_control`-tagged commits touch `Shapes.sol` in 15 of the last 20 commits — elevated churn, but every change is additive validation (renderer/collection code checks, copy validation), not a widening of the owner's reach.*

**Shapes ↔ fee recipient** — immutable, single trust point; a reverting recipient's worst case is a permanent redeem-only mode, never fund loss (SECURITY.md #6).

**ShapeAuctionHouse ↔ arbitrary lot NFT** — fully untrusted; the house verifies code presence, a self-reported ERC165 claim, and a post-transfer `ownerOf` read, none of which bind a collection written to lie about its own state.

**ShapeLens ↔ Shapes' linked libraries** — no on-chain binding ties `ShapeLens`'s own linked library addresses to `Shapes`'s (X-3); a stale or differently-built `ShapeLens` deployment silently diverges with no revert.

### Key Attack Surfaces

- **Sampled-geometry stream indexing (split-child aliasing)** &nbsp;[[I-13](invariants.md#i-13)] — `GeometrySampling.sampleSplitChild:163-166` keys the child stream on the untruncated `childIndex`; this is the fix for a prior every-256-children aliasing bug and is also the newest, least battle-tested consensus-critical code in the repo (landed in the commit this tree is built from). Worth re-deriving the stream construction end-to-end and confirming no other truncation exists in `_childSeed`, `GrammarV1Modules`, or `ModuleCodec`.

- **Fee-recipient reentrancy window in `bid`** &nbsp;[[G-37](invariants.md#g-37), [I-8](invariants.md#i-8), [I-9](invariants.md#i-9)] — `ShapeAuctionHouse.sol:162-167`: `_takeBid` mints cards and forwards the Shapes mint fee to an arbitrary `feeRecipient` before the auction-state writes; `a.settled` is re-checked after that call, but `highestBidder`/`highestUnits`/`endTime` are still written afterward. Worth confirming no other reentrant path (a card's own transfer hooks, or the lot's callback during `claimLot`) can observe the same window.

- **ShapeCardEscrow's push-vs-pull custody boundary** &nbsp;[[G-53](invariants.md#g-53)] — `ShapeCardEscrow.sol:24-26,169-178` accepts a Shape only via a mint-triggered callback (`from == address(0)`); a plain `transferFrom` push is explicitly unrecoverable by design, with no admin recovery path into the house at all. Worth confirming every plausible path that could move a Shape into the house (including any compose/split side effect) is accounted for.

- **Arbitrary auction lot trust boundary** — `ShapeAuctionHouse.sol:74-79,88-105` verifies only code presence, self-reported ERC165, and a post-transfer `ownerOf` check; nothing binds a collection written to answer `ownerOf`/`transferFrom` dishonestly. Worth independently re-verifying that the seller's proceeds path and a losing bidder's escrow (both Shapes-only, per the contract's own claim) are genuinely unreachable from the lot's callback surface.

- **ShapeLens / Shapes linked-library drift** &nbsp;[[X-3](invariants.md#x-3)] — nothing on-chain ties `ShapeLens`'s linked `GeometrySampling`/`ComposeCompute`/`InkGenes` addresses to the ones baked into `Shapes`. Worth confirming the deploy script links both from one build artifact, and that no integrator treats a `ShapeLens` preview as authoritative without checking it was deployed alongside the live `Shapes`.

- **Compose/split conservation under adversarial input ordering** &nbsp;[[I-11](invariants.md#i-11), [I-12](invariants.md#i-12), [I-14](invariants.md#i-14)] — `Shapes.sol:687-769` (compose) and `:845-920` (split) are the largest and newest rewritten surfaces in the repo. Worth independently re-deriving that `GeometrySampling.sortDonorsById`'s bottom-up merge sort (`GeometrySampling.sol:62-95`) is stable and order-independent under every burn-count and duplicate-id shape, not only the cases the existing fuzz suite happens to hit.

- **Gas-capped external reads treated as authoritative downstream** — `Shapes.sol:1104-1114`, `ContractCollectorOps.sol:60-75` both fail safely for `Shapes` itself, but any off-chain integrator (site, indexer) that treats `positionOf`/`contractCollector` as more than an unvalidated hint inherits whatever a hostile resolver/collector-token contract chooses to report.

- **Owner-editable metadata copy, never locked** — `Shapes.sol:200-210,289-307` — `setTokenCopy`/`setCollectionCopy` are explicitly not covered by `lockRenderer`; SECURITY.md's own caveat already flags un-escaped HTML in `description`. Worth confirming `CopyValidation.requireJsonSafe`'s UTF-8 walk (`CopyValidation.sol:19-48`) has no bypass that still breaks a downstream JSON/HTML consumer despite passing the `"`/`\`/C0 check.

### Protocol-Type Concerns

**As a Stablecoin-style backing/redemption system:**
- No oracle or price feed exists anywhere in scope — `Denominations.sol` is a fixed, immutable lookup table, so the entire oracle-manipulation attack class is structurally absent, not merely mitigated.
- The "peg" is exact by construction rather than market-maintained, so redemption-run and death-spiral dynamics do not apply the way they do for a market-priced stablecoin; every redemption pays out of a reserve the E-1 economic invariant asserts always covers it.

**As an Escrow/Custody system (`ShapeAuctionHouse`):**
- `MAX_CARDS_PER_BID = 64` (I-7) bounds the `withdraw`/`claimProceeds` transfer loop; SECURITY.md notes a minimal card set never needs more than ~20 below 100 ETH, so 64 is generous headroom rather than a tight bound — worth confirming gas cost at the true worst case (64 non-minimal cards) stays comfortably under typical block limits.

### Temporal Risk Profile

**Deployment & Initialization:**
- No proxy or `initialize()` pattern exists anywhere in scope (see entry-points.md, Initialization) — the standard front-run-the-initializer threat does not apply.
- `feeBps`/`feeRecipient` are immutable and unrecoverable if misconfigured (SECURITY.md caveats #1–#2); `DeployShapes.s.sol` is described as refusing a contract fee recipient without an explicit override, but that script sits outside `src/` and was not read as part of this scope.
- Library linking at deploy time (five externally-linked libraries, independently re-linked into `ShapeLens`) is the one deployment-ordering risk with zero on-chain enforcement — see the linked-library-drift attack surface above.

### Composability & Dependency Risks

**Dependency Risk Map:**

> **Fee Recipient** — via `Shapes._mintBatch` (`Shapes.sol:485-489`)
> - Assumes: can receive a plain ETH transfer without reverting
> - Validates: only that the call succeeds
> - Mutability: Immutable, set once at construction
> - On failure: the whole mint reverts; permanently bricks minting if the recipient always reverts (accepted)

> **Position Resolver** — via `Shapes.positionOf` (`Shapes.sol:1104-1114`)
> - Assumes: nothing — explicitly untrusted
> - Validates: gas-capped at 50,000; any revert/out-of-gas/return swallowed to `address(0)`
> - Mutability: Owner-replaceable until `lockPositionResolver`; may be locked at zero
> - On failure: fails open to `address(0)`, never reverts the caller

> **Contract Collector Token** — via `ContractCollectorOps.ownerOfCapped` (`ContractCollectorOps.sol:66-75`)
> - Assumes: a well-formed `ownerOf(uint256)` return
> - Validates: gas-capped staticcall (100,000); rejects non-32-byte returns and dirty upper bits
> - Mutability: Owner-replaceable until `lockContractCollectorBinding`
> - On failure: resolves to `address(0)`, treated as unset

> **Auction Lot (arbitrary ERC-721)** — via `ShapeAuctionHouse.createAuction`/`claimLot` (`ShapeAuctionHouse.sol:80-131,204-216`)
> - Assumes: honest `ownerOf`/`getApproved`/`isApprovedForAll`/`transferFrom`/ERC165 self-report
> - Validates: code presence, ERC165 claim, post-transfer `ownerOf` check
> - Mutability: Fully arbitrary, seller-chosen
> - On failure: bounded to the parties who chose that auction, per the contract's own design claim

**Token Assumptions:** Shape cards (in-repo ERC721) are the only "token" the auction/escrow paths handle; no ERC20 or third-party fungible token integration exists anywhere in scope, so the fee-on-transfer/rebasing/non-standard-return assumption matrix does not apply.

**Shared State Exposure:** None. Shapes reads no external price feed, pool or shared oracle — the reserve is pure internal ETH accounting (README.md: "Shapes reads no external contract").

---

## 3. Invariants

> ### 📋 Full invariant map: **[invariants.md](invariants.md)**
>
> A dedicated reference file contains the complete invariant analysis — do not look here for the catalog.
>
> - **55 Enforced Guards** (`G-1` … `G-55`) — per-call preconditions with `Check` / `Location` / `Purpose`
> - **15 Single-Contract Invariants** (`I-1` … `I-15`) — Conservation, Bound, StateMachine, Temporal
> - **3 Cross-Contract Invariants** (`X-1` … `X-3`) — caller/callee pairs that cross scope boundaries
> - **2 Economic Invariants** (`E-1` … `E-2`) — higher-order properties deriving from `I-N` + `X-N`
>
> Every inferred block cites a concrete Δ-pair, guard-lift + write-sites, state edge, temporal predicate, or NatSpec quote. The **On-chain=No** block (X-3, the ShapeLens/Shapes linked-library drift) is the high-signal one. Attack-surface bullets above cross-link directly into the relevant blocks.

---

## 4. Documentation Quality

| Aspect | Status | Notes |
|--------|--------|-------|
| README | Present | `README.md` (560 lines) — protocol mechanics, repo map, full local dev/deploy flow |
| NatSpec | ~459 tags | Extensive; nearly every `@dev` block explains *why*, not only *what* |
| Spec/Whitepaper | Present | `SPEC.md` (717 lines, D1–D18 decision log) and `SECURITY.md` (adversarial review), plus `DECOMPOSE_SPEC.md`, `SAMPLING_SPEC.md`, `INK_GENES_IMPL_SPEC.md`, `TRAIT_SPEC.md`, `METADATA.md` |
| Inline Comments | Thorough | Guard predicates are consistently annotated with the invariant or trust boundary they enforce, not restated |

`SECURITY.md` documents an earlier adversarial/AI-audit round (its "Finding 10" — no Critical/High, three Low fixed) *(per spec)*. The task context states a further, more recent internal audit fixed three additional findings in the commit this tree is built from (split-child geometry aliasing, the `bid`/fee-recipient reentrancy gap, and stale `_sampledModules` on redeem) and likewise found no Critical/High — all three fixes were independently confirmed present in the code during this pass (`GeometrySampling.sol:163-166`, `ShapeAuctionHouse.sol:167`, `Shapes.sol:587`), but the audit report itself was not available to read directly.

---

## 5. Test Analysis

| Metric | Value | Source |
|--------|-------|--------|
| Test files | 21 (19 `.t.sol` + 2 helpers) | File scan (always reliable) |
| Test functions | 399 | File scan (always reliable) |
| Line coverage | Unavailable — `forge coverage` fails ("Stack too deep" in `Shapes.sol`) even under `--ir-minimum` | Coverage tool (requires compilation) |
| Branch coverage | Unavailable — same reason | Coverage tool (requires compilation) |

Test *existence* is unaffected by the coverage-tool failure — 399 test functions across 19 dedicated test files were found by file scan regardless of whether `forge coverage` can compile.

### Test Depth

| Category | Count | Contracts Covered |
|----------|-------|-------------------|
| Unit | broad (majority of 399) | Every subsystem — `Shapes.t.sol`, `ShapeRenderer.t.sol`, `Decompose.t.sol`, `Provenance.t.sol`, `TokenIds.t.sol`, `Token0.t.sol`, `InkGenes.t.sol`, `Sampling.t.sol`, `Collection.t.sol`, `ContractCollector.t.sol` |
| Integration | broad | `Composability.t.sol`, `AuctionHouseArbitraryLot.t.sol`, `AuctionSecurity.t.sol` — cross-contract flows |
| Fork | 4 | `Fork.t.sol`, gated on `MAINNET_RPC_URL`, skipped by default (matches the 4 skipped tests reported for this suite) |
| Stateless Fuzz | 34 | Spread across the suite |
| Stateful Fuzz (Foundry invariant) | 16 | `Invariants.t.sol` — reserve solvency under fuzzed mint/transfer/redeem/compose/split sequences |
| Formal Verification (Certora/Halmos/HEVM) | 0 | none detected |

### Gaps

- No Echidna, Medusa, Certora, Halmos or HEVM anywhere in the repo — for a value-custody contract whose highest-value properties are the conservation invariants (I-11 through I-14) and the reserve bound (E-1), a bounded-model-checking pass (Halmos is the lowest-friction addition given the existing Foundry suite) would extend beyond what the current 512-run fuzz / 128-run×64-depth invariant configuration already covers.
- `ShapeAuctionHouse`/`ShapeCardEscrow` is the newest, least fuzz-hardened subsystem by wall-clock age relative to `Shapes`'s core reserve logic, though it does carry dedicated `AuctionHouse.t.sol`/`AuctionSecurity.t.sol`/`AuctionHouseArbitraryLot.t.sol` unit coverage.

---

## 6. Developer & Git History

> Repo shape: normal_dev — 130 commits over a 14-day history (2026-08-08 → 2026-08-22), 42 of which touch source files.

**Analyzed branch:** `HEAD` (detached, matching `origin/main` at `2167dc7`) — all git signals below reflect only commits reachable from this commit.

### Contributors

| Author | Commits | Source Lines Added | % of Source Changes |
|--------|--------:|--------------------|--------------------:|
| ripe0x | 56 | +4,236 | 64.6% |
| dave | 74 | +2,320 | 35.4% |

Two-developer repo; no single contributor exceeds the 90% concentration threshold, and no ghost (1-commit) contributors.

### Review & Process Signals

| Signal | Value | Assessment |
|--------|-------|------------|
| Unique contributors | 2 | Small, two-developer team |
| Merge commits | 13 of 130 (10%) | A PR-based workflow for a subset of changes; many commits land directly to the branch |
| Repo age | 2026-08-08 → 2026-08-22 | 14 days — a young, actively-developed codebase |
| Recent source activity (30d) | 42 commits | Active — effectively the entire history falls inside the 30-day window given the repo's age |
| Test co-change rate | 92.9% | The large majority of source-changing commits also touch test files |

### File Hotspots

| File | Modifications | Note |
|------|-------------:|------|
| `src/Shapes.sol` | 30 | Core reserve + every value-moving entrypoint — highest churn matches highest attack-surface priority |
| `src/interfaces/IShapes.sol` | 24 | Tracks `Shapes.sol`'s interface churn |
| `src/ShapeRenderer.sol` | 17 | Largest file by nSLOC; rendering-only, no value custody |
| `src/interfaces/IShapeRenderer.sol` | 7 | |
| `src/ShapeAuctionHouse.sol` | 7 | Newest subsystem — nearly all churn within the final 48 hours of history |
| `src/interfaces/IShapeCapabilities.sol` | 6 | |
| `src/interfaces/IShapeAuctionHouse.sol` | 5 | |

### Security-Relevant Commits

**Score** = weighted sum of fix-like signals (message keywords, diff patterns, change shape). 10+ warrants a manual diff; all rows below score ≥12.

| SHA | Date | Subject | Score | Key Signal |
|-----|------|---------|------:|------------|
| `a7fb9ed` | 2026-08-20 | Fix-review: make the auction invariants live, split errors, tidy | 16 | removes a runtime guard, spans fund_flows + state_machines, focused (2 files) |
| `a0ff0af` | 2026-08-19 | Audit fixes: close both High findings, three of the five Low | 16 | adds a runtime guard, spans 3 security domains, focused |
| `c784d23` | 2026-08-19 | ShapeAuctionHouse: bids denominated in Shape cards | 15 | tightens access control, large (467 lines) — a feature commit, not a fix, flagged by the same heuristics |
| `808477d` | 2026-08-19 | Add value and position discovery interfaces | 14 | spans 5 security domains — a feature commit |
| `5979de1` | 2026-08-12 | Shapes: restore — reassemble a split's complete child set (dave) | 14 | later fully removed by `db33139` within one week |
| `db33139` | 2026-08-19 | Remove restore: a split is final | 13 | net code removal, loosens access control (−2) |
| `071ce37` | 2026-08-12 | Shapes v2 review fixes: Fragment label, seed-rule tests, type/wording nits | 13 | genuine post-hoc correction |
| `27c080a` | 2026-08-10 | v2 Phase 3: compose and decompose | 13 | feature-phase commit |
| `38e5ea1` | 2026-08-08 | Shapes: ETH-backed ERC721 with a fully onchain renderer | 13 | initial 927-line commit |
| `da1fa53` | 2026-08-20 | Validate copy as well-formed UTF-8, not just JSON-grammar-safe | 12 | genuine post-hoc correction |

Note: the scorer applies the same fix-pattern heuristics to feature and refactor commits (`c784d23`, `808477d`, `27c080a`, `38e5ea1`), which is why several "high-score" rows above are new functionality rather than bug fixes — only `a7fb9ed`, `a0ff0af`, `071ce37` and `da1fa53` read as genuine corrections from their subjects.

### Dangerous Area Evolution

Filtered to in-scope files only — the raw git-security scan's file lists were otherwise dominated by vendored OpenZeppelin files matched on generic keywords (e.g. "oracle_price" matched `ERC4626.sol`, `ERC2981.sol`; "signatures" matched `ECDSA.sol`, `EIP712.sol` — none of which are used or imported by anything in this repo's own scope).

| Security Area | Commits | Key Files (in-scope only) |
|--------------|--------:|-----------|
| fund_flows | 34 | `Shapes.sol`, `ShapeAuctionHouse.sol`, `ShapeCardEscrow.sol`, `IShapeAuctionHouse.sol` |
| access_control | 30 | `Shapes.sol` |
| state_machines | 29 | `ShapeLens.sol`, `IShapeAuctionHouse.sol`, `IShapePositionResolver.sol`, `IShapes.sol` |
| oracle_price* | 34 | `ShapeCardEscrow.sol`, `Shapes.sol`, `IShapeAuctionHouse.sol`, `IShapes.sol` — *keyword match on `backingOf`/`valueOf` naming; no actual price oracle exists in scope* |
| signatures* | 30 | `Shapes.sol` — *keyword match, likely on "seed"/hash terminology; no signature verification exists in scope* |

### Forked Dependencies

| Library | Path | Upstream | Status | Notes |
|---------|------|----------|--------|-------|
| openzeppelin-contracts | `lib/openzeppelin-contracts` | OpenZeppelin | Internalized (not a submodule) | 308 files, multiple pragma floors — expected for OZ's own multi-version-compat file set (older interfaces/mocks); not independently diffed against upstream in this pass |

Internalizing a vendored library means upstream security patches will not auto-propagate; a future release should confirm this checkout matches an OZ v5 tag exactly rather than a manually-touched copy.

### Security Observations

- **Two-developer concentration** — ripe0x (64.6%) + dave (35.4%) = 100% of source-line authorship.
- **Repo is 14 days old with 42 "late" (30-day-window) source commits** — reflects a genuinely young, fast-moving codebase rather than a last-minute pre-audit rewrite.
- **`Shapes.sol`/`IShapes.sol` top both churn and attack-surface priority** — 30+24 modifications against every value-moving entrypoint.
- **The auction subsystem is newest and carries its own internal audit trail** — `e20a1b3`, `a7fb9ed`, `a0ff0af` already closed an M-2/L-2/L-4/I-6 internal round before the commit this tree is built from.
- **Test co-change rate 92.9%, fix-without-test rate 0.0%** — every fix-scored commit in this history also touched tests.
- **Zero TODO/FIXME/HACK/XXX markers anywhere in `src/`.**
- **`openzeppelin-contracts` is internalized, not a submodule** — flagged for upstream-patch-propagation awareness, not diffed against upstream here.

### Cross-Reference Synthesis

- **`Shapes.sol` tops churn AND attack-surface priority** — 30 modifications + every reserve-adjacent entrypoint → the compose/split conservation invariants (I-11..I-14) and the reserve bound (E-1) are the highest-leverage review target by both code size and edit frequency.
- **The newest subsystem carries its own audit trail** — `ShapeAuctionHouse`/`ShapeCardEscrow` landed within the final 48 hours of history and already absorbed one internal audit round fixing the fee-recipient-reentrancy gap (G-37) → worth confirming that fix is complete rather than merely narrowed.
- **`db33139` (removing `restore`) reversed `5979de1` (adding it) within one week**, both scoring ≥13 on the fix-candidate heuristic → a deliberate reduction in surface area ("a split is final"), not churn instability.

---

## X-Ray Verdict

**ADEQUATE** — test coverage is hardened (unit + stateless fuzz + stateful Foundry invariant, zero fix-without-test commits) and documentation is fortified (extensive purpose-oriented NatSpec plus a full spec/decision-log and adversarial-review document), but access control caps the tier: the owner role is a single transferable `Ownable` with no timelock or multisig anywhere in scope.

**Structural facts:**
1. 3,066 nSLOC across 7 in-scope subsystems (3,583 nSLOC including 517 nSLOC of interfaces), 26 source files.
2. Two developers (ripe0x 64.6%, dave 35.4% of source line additions) over a 14-day, 130-commit history with 13 merges.
3. 21 test files / 399 test functions / 34 stateless-fuzz functions / 16 stateful-invariant functions; 0 fix-scored commits shipped without a paired test change.
4. `Shapes`'s runtime bytecode carries 135 bytes of EIP-170 headroom at the currently committed build settings; five libraries (`ComposeCompute`, `ContractCollectorOps`, `CopyValidation`, `GeometrySampling`, `InkGenes`) are externally linked, each a separate deployment.
5. No proxy/upgrade pattern, no oracle/price feed, and no ERC20 integration exist anywhere in scope; the owner role's every power is documented as value-inert (cannot reach ETH, backing, redemption or ownership).
