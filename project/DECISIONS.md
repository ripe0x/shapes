# Decisions

Append-only. Two sections: decided (never silently revived if rejected) and open backlog (grouped by what resolves them). Ids are stable.

## Decided (recovered from specs and session history)

- 2026-07: Ladder rung 25 ETH replaced by 0.05 ETH; the x2.5 gap at 10 to 25 broke integer composition (SHAPES_V2_SPEC.md §8).
- 2026-07: Core "Token Path" registry cut for EIP-170 and write-only-no-reader reasons. Must not return as a shared global registry; lineage is per-work at the write authority, global graph only ever a derived read layer.
- 2026-07/08: `seal` mechanism rejected outright (ZERO_AUCTION_DRAFT.md F1). Not a deferral.
- 2026-08: No auction-house protocol fee, structurally excluded (card lattice cannot represent a percentage).
- 2026-08: Renderer and collection deliberately not locked at launch (ZERO_AUCTION_DRAFT.md R14).
- 2026-08: Epoch commit-reveal seeding considered and deliberately not built; grinding accepted because redemption value is seed-independent. Revisitable (D-19).
- 2026-08: Shapes split core/periphery (ShapeLens + externally linked libraries) to stay under EIP-170; lens/library addresses fixed in bytecode, not admin-settable.
- 2026-08-20: Compose/split geometry sampled from input modules, materialized as bytes (SAMPLING_SPEC.md); originals stay seed-derived; GRAMMAR_VERSION 2.
- 2026-08-25: Canonical project docs live in `project/`; STATE.md supersedes status lines in legacy spec docs (this session).
- 2026-08-25: D-04 DECIDED by user: standalone Shapes is the mainnet architecture. The Surface-hosted alternative (pooled Surface clone + ShapesMinter extension owning economics, fork-tested against the live mainnet SurfaceFactory) is REJECTED — do not silently revive. Branch preserve/surface-port deleted deliberately with user approval; the design is documented here and in the port's history (commit ce4c7e4 recorded before deletion). The per-work lineage doctrine that came out of that work stands independently: lineage lives at the write authority, any global graph is a derived read layer, never an authoritative singleton.

## Open backlog

### Immediate (no new information needed, decide and act)

- D-01 Ladder restoration strategy. RESOLVED 2026-08-25 on main by `ef228f0` + `1020730`: default builds carry the 0.01..100 ETH mainnet ladder; `FOUNDRY_PROFILE=testnet` selects an isolated 100x-smaller Solidity ladder/artifact cache; `SHAPES_LADDER=testnet` selects the paired TS ladder and fixtures. DeployShapes rejects the testnet ladder off anvil, DeploySepolia requires it, and the suite asserts the default. This supersedes PR #1's interim chain-id-only guard.
- D-02 Audit-findings triage. RESOLVED 2026-08-25: findings are HISTORICAL, already fixed on main. The audit worktree (landed as commit 6480f1c on claude/shapes-security-audit-fa49c8 for the record) audited commit 4e6b3d8 (2026-08-19), 43 commits behind main. Main's remediation trail: a0ff0af (both Highs + 3 Lows), da1fa53 (L-1 UTF-8 validation), dabf2ad (L-3 resolver gas cap), 383be38 (H-2: corrected seed-grinding claims in docs), e20a1b3 (M-2/L-2/L-4/I-6 + escrow invariants), a7fb9ed (auction invariants live — supersedes the orphaned prank-fix patch), 2167dc7, d2f2e59. Verified in current source: settle records only, lot leaves via pull-based claimLot (revert blocks only its own delivery, retryable), bid() has SellerCannotBid, CopyValidation walks UTF-8. Initial same-day triage wrongly confirmed the findings against the stale checkout — recorded here as a process lesson: verify worker findings against main before acting.
  - Residue kept open: M-1 compose/decompose gas asymmetry (EIP-3529) — no named fix commit found; folded into D-08 gas-ceiling experiment.
  - Residue kept open: port the 23 AuditPoC tests to current main as regression tests (they encode the attack attempts; on fixed code they should assert the guards). Small delegated task, P0/P1 boundary.
  - The audit worktree was fully committed before the completed hygiene pass.
- D-03 Renderer WIP reconciliation. RESOLVED 2026-08-25: WIP preserved verbatim on branch preserve/renderer-wip (commit 074fc30). Per-file investigation verdicts: fill-class fix, fixtures, and history.ts scalability work fully superseded by main's InkGenes rewrite (main's history.ts adds pagination on top); .claude/launch.json config noise. Three novel pieces queued below as W-1/W-2. The superseded stray indexer draft, including its uncommitted `.env.local`, was deleted during the completed hygiene pass and was never committed.

### Queued work (scoped, ready to dispatch)

- W-1 Black Shape site support + ProvTree rollup chip. Main's site skips black tokens entirely, and main has a live latent bug: history.ts emits node.more rollup placeholders that TokenView.tsx renders as bogus cards (DENOMINATIONS[0], #0). Reimplement fresh against current main (the preserved WIP on preserve/renderer-wip is reference only; it predates the SiteToken shape and the blacken->sacrifice rename). P1.
- W-2 10k-apex simulate scenario. Preserved WIP mints 10,000 x 0.01 and composes to an apex, but calls blacken (renamed sacrifice). Main's script/SeedDemo.s.sol already seeds an apex; decide whether simulate.ts needs the scenario too before porting. P1, low priority.
- W-4 Land CI cost fixes from claude/docs-truth-and-size-gate (concurrency-cancel, dorny/paths-filter Foundry-skip, forge out/cache caching — the docs-truth half already landed as a161df9). Actions is restored via the public-repo cutover; these changes remain useful for spend and queue reduction. P1.
- W-5 Land react-dom dev perf-track disarm from claude/jovial-goodall-d5e0cf (bigint-array JSON.stringify crash workaround absent from main's web/app/layout.tsx). P1.
- W-6 Decide fate of claude/portless-local-setup-ae92c8 (portless .localhost dev routing; matches the user's standing portless preference). P1, dev tooling.
- D-23 Title auction product line. RESOLVED 2026-08-25 by the user's D-24 go-ahead: the old non-tokenized `ShapeTitleAuction` exploration is superseded and will not be pursued. Shape #0 is the title token and the ordinary `ShapeAuctionHouse` can auction it without a second title product. The `claude/contract-title` branch remains untouched as historical evidence; do not revive or delete it without an explicit later decision.

- D-24 Shape #0 contract title and separate admin (PR #2). RESOLVED 2026-08-25 by user instruction: adopt the Director recommendation. The constructor atomically mints backed Shape #0 to the deployer; `titleHolder()` follows its ordinary ERC-721 lifecycle and carries no permissions; public minting and the launch-auction lot begin at #1. A separate transferable/renounceable `admin()` controls only value-inert presentation and position discovery. The external collector binding is removed. The ERC-173-conflicting `owner()` selector is not exposed. `IShapes` retains legacy id `0xbdcee955`, while `IAdminControl` and `IContractTitle` are independently advertised. This is Charter amendment 1, reflected in principle 5. Operational consequence: the old Sepolia implementation cannot migrate and must not be relabeled; a fresh deployment is required before P1 evidence work.

- W-3 RESOLVED 2026-08-25, no code needed: every PoC scenario is already covered by an existing regression (AuctionSecurity, AuctionHouse, Shapes, ShapeRenderer, Decompose, Invariants suites) or is a documented accepted residual (H-2 grinding in SECURITY.md §1, M-1 gas asymmetry in DECOMPOSE_SPEC.md "no in-contract cap"). All 23 mapped tests verified passing on current source, invariant suites included. The audit branch stays as historical record only. Note: M-1's D-08 relevance stands — DECOMPOSE_SPEC accepts irreversibility-by-gas atomically, but the mainnet ceiling numbers are still worth measuring.
- D-04 Surface port fate. RESOLVED 2026-08-25: standalone Shapes is the mainnet architecture; the Surface-hosted alternative is rejected. The port was committed first for preservation, then its branch was deliberately deleted with user approval. See the decided entry above; do not revive this architecture fork silently.
- D-05 Mainnet key and fee plan. `feeBps`/`feeRecipient` are immutable; D-24 selects a separate transferable `admin()` while Shape #0 carries the powerless title. Matters: irreversible if wrong; the admin key affects presentation surfaces and lock timing, and title custody is a separate launch decision. Missing: user's multisig vs EOA intent, fee recipient address, initial title recipient, and whether/when to lock renderer or renounce admin. Resolution: user decision, recorded here before P2 gate.
- D-06 Doc truth pass. RESOLVED 2026-08-25: commit 8c30e51 on the director branch. Sepolia addresses recorded in README (with testnet-scale note), repo map completed, four spec status lines now point at project/STATE.md, ladder corrected in WEBSITE_DESIGN_PROMPT.md, web/README rewritten, CI probe comment removed. check-docs.sh green.

### Requires simulation

- D-07 Ink-gene constants. Draft says tune via Monte Carlo (difficulty targets for a Solid 100); impl spec froze strawman values; no evidence a tuning pass ran. Matters: constants are effectively immutable post-mainnet; difficulty economy is a core collectible mechanic. Missing: distribution of outcomes at current constants. Resolution: run `preview/scripts/inkTuning.ts` harness, record an EXPERIMENT with headline targets, confirm or change constants before P2.
- D-08 Gas ceilings at mainnet scale. Deep compose (10k x 0.01 apex) needed a 5B gas limit locally; blacken test needs 90B. Matters: paths that cannot execute within block gas are dead features on mainnet; users must not discover this. Missing: worst-case gas per entrypoint vs 30M block limit, and the practical batching path for building an apex. Resolution: gas-measurement experiment (the gasmeasure worktree's SplitGasMeasure.t.sol is a start) producing a documented ceiling per operation.
- D-09 Formal verification adoption. No Echidna/Medusa/Halmos anywhere; reserve conservation is the crown-jewel invariant of a value-custody contract. Matters: fuzz depth 128 explores a sliver of the compose/split/decompose state space. Missing: cost/benefit of Halmos symbolic runs vs Medusa campaign on the invariant harness. Resolution: timeboxed spike on both against E-1/I-13/I-14, adopt whichever finds traction, wire into CI.

### Requires prototype

- D-10 Indexer integration. Site reads chain directly (chunked multicalls over a free public RPC); Ponder indexer is built but unshipped. Matters: mainnet-scale galleries and lineage histories over raw RPC are slow, rate-limited, and violate the standing indexer-first discipline. Missing: hosting target, and proof the site's data layer can swap sources cleanly. Resolution: prototype on Sepolia — host the indexer, add an indexer-backed data path behind the existing interface in `preview/src/site/data.ts`, measure.
- D-11 Wallet coverage. Injected-only today; WalletConnect projectId is a placeholder. Matters: mobile users cannot mint. Missing: a real WC project id and a test pass. Resolution: prototype with a real project id, verify on mobile.
- D-12 RPC resilience. Single free endpoint (publicnode) for site reads and the OG route, no fallback transport. Matters: single point of failure for the whole site; standing rule requires fallbacks. Missing: nothing conceptual. Resolution: viem `fallback([...])` with two public alternates plus optional paid primary via env; verify failover by blackholing the primary in a preview run.

### Requires live users (Sepolia observation before mainnet answers)

- D-13 Auction parameters in practice. minIncrementBps norms, duration/extension behavior, ETH-bid card-minting UX. Resolution: run real Sepolia auctions, observe, record.
- D-14 Does provenance drive collecting? The composition/origin-density system is a product hypothesis (rational-actor assumptions throughout the specs). Resolution: Sepolia usage plus qualitative feedback; informs how much P3+ effort provenance features deserve.

### Requires legal review

- D-15 Regulatory characterization. An NFT redeemable 1:1 for escrowed ETH with a 1% wrap fee touches money-transmission/deposit-taking questions in some jurisdictions. Matters: existential if wrong, cheap to check early. Missing: qualified counsel's read. Resolution: external legal review before mainnet; Director flags, does not opine.

### Requires security review

- D-16 External audit. Scope: Shapes + 4 linked libraries + lens + auction house/escrow, including the payable genesis constructor, Shape #0 lifecycle, admin/title separation, and capability ABI. Deploy scripts, immutables, and ladder guards stay in scope. Gate for P2->P3. In-repo x-ray and PoCs are inputs, not substitutes.
- D-17 minIncrementBps bound. Seller-supplied uint16, no explicit cap found in createAuction. Matters: probably harmless (seller cannot bid) but unverified against bidder-side edge cases. Resolution: reviewer pass; add a bound or record why none is needed.

### Deferred (explicitly parked, revisit at the phase named)

- D-18 Positions protocol. `positionOf`/`positionResolver` is a seam for an unspecified future protocol. Park until post-launch.
- D-19 Epoch commit-reveal seeding. Rejected residual mitigation; revisit only if grinding becomes an observed problem.
- D-20 Origin-density-ranked auction bids. Needs an ETH/origins exchange rate; any rate is arbitrary. Park.
- D-21 `@x402/*` dependencies. Unused in code. Remove in a hygiene pass unless the user names a purpose.
- D-22 Black-record gene lore (does a Black record the gene it died with). Zero protocol cost, pure lore; decide whenever.
