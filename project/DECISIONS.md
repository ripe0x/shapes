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

## Open backlog

### Immediate (no new information needed, decide and act)

- D-01 Ladder restoration strategy. Main carries the 1/100 testnet ladder; mainnet needs 0.01..100. Matters: an unnoticed mainnet deploy from this source ships 1/100 backing with immutable config. Missing: nothing; this is branch/process design. Resolution: decide whether main returns to mainnet values with a dedicated sepolia-scaled branch for testnet redeploys, or main stays scaled until P2 with a hard deploy-script guard (script refuses chain 1 when UNIT != 0.01 ether). Director recommendation: put the guard in regardless, decide branch layout at P2 entry.
- D-02 Audit-findings triage. LANDED 2026-08-25 on branch claude/shapes-security-audit-fa49c8 (commit 6480f1c), cut from main at the audited commit 4e6b3d8; all 23 PoC tests pass. Triage complete, dispositions below. The unapplied patch (auction-handler-prank-fix.patch) is orphaned tooling toward I-2 (bringing the auction house under the invariant suite), remediates nothing, does not apply to this tree — do not apply as-is.
  - H-1 (High, CONFIRMED against src/) ShapeAuctionHouse settle/withdraw/claimProceeds: settle flips settled=true in the same call as an untrusted transferFrom with no try/catch; if it reverts nothing persists, and withdraw reverts for the winner while claimProceeds requires settled — no rescue path. A malicious/failing lot recipient can permanently lock a winner's escrowed bid. Disposition: FIX before any other contract work merges (P0 stop condition triggered). Needs a settlement design that isolates the untrusted transfer (pull-claim of lot, or try/catch with a stuck-lot escape) — architecture-level, so Director-reviewed spec before implementation.
  - H-2 (High, CONFIRMED mechanism) Shapes mint entropy uses firstTokenId = totalMinted, advanceable in one tx by mint-dust-then-redeem (backing refunded, only fee spent), defeating one-attempt-per-block grinding resistance. Disposition: RECONCILE, likely ACCEPT. Charter principle 6 and SPEC.md D3e already accept seed grinding because redemption value is seed-independent; the audit frames a "claim" the charter does not actually make. Confirm no code path anywhere makes value/rarity binding on the seed, then record as accepted and fix any doc that overclaims grinding resistance (folds into D-06). If any binding path exists, this escalates to fix.
  - M-1 (Medium) compose/decompose gas asymmetry (~1.29x, EIP-3529): a large compose can fit a 30M block while its matching decompose cannot, stranding reversibility. Disposition: measure under D-08 gas experiment; decide whether to bound compose input size or document the ceiling.
  - M-2 (Medium, CONFIRMED) auction bid() has no seller-address check; seller can shill-bid own auction at gas cost. Disposition: fold into D-17 reviewer pass; likely add a seller!=bidder guard (note ShapeAuctionHouse already has SellerCannotBid elsewhere per contract audit — reconcile whether bid() path is actually unguarded).
  - L-1 (Low, CONFIRMED) _requireJsonSafe passes bytes >=0x80; invalid UTF-8 can enter copy fields. Disposition: decide tighten-vs-accept; downstream JSON/HTML consumers are the risk surface.
  - L-2..L-4, I-1..I-7: catalogued in AUDIT_FINDINGS.md; triage at P1 unless the H-1 fix touches them.
- D-03 Renderer WIP reconciliation. Parity-critical pair (render.ts + ShapeRenderer.sol + fixtures) modified, uncommitted, on a 97-commit-stale base. Matters: silent divergence or loss of work; conflicts compound with age. Missing: what the changes were for (likely ink prototypes per branch history). Resolution: diff review, then rebase-and-land or explicitly discard with a note here.
- D-04 Surface port fate. A complete, fork-tested port of Shapes onto the PND Surface protocol (pooled Surface clone + ShapesMinter owning all economics + lineage store) exists only as untracked files. Matters: this is THE architecture fork — standalone Shapes vs Shapes-as-Surface-extension changes deployment, ownership, renderer wiring, and the auction house's `shapes` immutable. Both cannot be the mainnet product. Missing: product decision on which architecture ships; comparative gas/complexity numbers would help but the choice is strategic. Resolution: commit the port to a branch NOW for preservation (no decision implied), then a dedicated design review session choosing standalone vs Surface-hosted before P2.
- D-05 Mainnet key and fee plan. `feeBps`/`feeRecipient` are immutable; owner is a single transferable EOA-style Ownable. Matters: irreversible if wrong; owner key compromise affects presentation surfaces and lock timing. Missing: user's intent on multisig vs EOA, fee recipient address, whether/when to lock renderer or renounce. Resolution: user decision, recorded here before P2 gate.
- D-06 Doc truth pass. Stale status lines, README deployment table and repo map, 25-ETH ladder in WEBSITE_DESIGN_PROMPT.md, boilerplate web/README, CI probe comment in README. Matters: contradictory docs erode the "understandable months later" goal and can mislead future workers. Missing: nothing. Resolution: one delegated cleanup task pointing every stale status line at STATE.md.

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

- D-16 External audit. Scope: Shapes + 5 linked libraries + lens + auction house/escrow, plus deploy scripts (immutables, ladder guard). Gate for P2->P3. In-repo x-ray and PoCs are inputs, not substitutes.
- D-17 minIncrementBps bound. Seller-supplied uint16, no explicit cap found in createAuction. Matters: probably harmless (seller cannot bid) but unverified against bidder-side edge cases. Resolution: reviewer pass; add a bound or record why none is needed.

### Deferred (explicitly parked, revisit at the phase named)

- D-18 Positions protocol. `positionOf`/`positionResolver` is a seam for an unspecified future protocol. Park until post-launch.
- D-19 Epoch commit-reveal seeding. Rejected residual mitigation; revisit only if grinding becomes an observed problem.
- D-20 Origin-density-ranked auction bids. Needs an ETH/origins exchange rate; any rate is arbitrary. Park.
- D-21 `@x402/*` dependencies. Unused in code. Remove in a hygiene pass unless the user names a purpose.
- D-22 Black-record gene lore (does a Black record the gene it died with). Zero protocol cost, pure lore; decide whenever.
