# State

Single source of truth for current project status. Status lines inside spec documents (SHAPES_V2_SPEC.md "pre-implementation", ZERO_AUCTION_DRAFT.md "no code written", README's "not deployed" table) are historical and superseded by this file.

Last updated: 2026-08-25 (resumed Director session).

## Phase

Current phase: P0 Stabilize complete, awaiting user review and merge of PR #1 before P1 opens (see `project/ROADMAP.md`).

P0 GATE PASSED 2026-08-25: all acceptance items met — at-risk work preserved or landed, audit findings dispositioned, hygiene complete, docs truthful, and GitHub Actions green on the clean public repo (first green run since 2026-08-08; renderer job fixed for the workspace lockfile move). P1 opens when PR #1 (director branch) merges to main after user review. The current PR tip must be green before merge; its Netlify preview failed because the site config was nested under `web/` while Netlify invoked a nonexistent root build script. The reviewed fix moves `netlify.toml` to the repository root with `base = "web"`; remote verification is pending.

Historical note — STOP CONDITION LIFTED (2026-08-25, same day raised): the landed audit's base commit 4e6b3d8 (2026-08-19) is 43 commits behind main; main already closed the findings (a0ff0af both Highs + 3 Lows, da1fa53 L-1, dabf2ad L-3, e20a1b3 M-2/L-2/L-4/I-6, 383be38 H-2 doc correction, 2167dc7, d2f2e59). Verified in current source: settlement is pull-based via claimLot (lot revert blocks only its own delivery), bid() has SellerCannotBid. The initial triage misread the audit checkout as current main. Residue tracked in D-02: M-1 gas asymmetry feeds D-08; PoC suite worth porting to main as regression tests.

## Deployments

- Mainnet: none. `foundry.toml` has no chain-1 rpc/etherscan entries. `indexer/.env.example` marks mainnet TODO.
- Sepolia: live, at 1/100 TESTNET SCALE. `web/public/deployment.json`: shapes `0x57443FDbfA5BA02156977B5dEB53814f50a580ac`, renderer `0xFF7775e67DD329b09cd1deC30a6bE09ab0728bD2`, collection `0x483D0925C462a224a8D62EFB8143079609B12C77`, lens `0xb1Ec83FCE774BE8F00B83F41f1BD56C94111cA2f`, auctionHouse `0xa46E2ACe3Bb397640B6666D99fAB5198Bd859136`, feeBps 100, fromBlock 11565510.
- LADDER WARNING: `src/lib/Denominations.sol` on main currently carries the scaled ladder (UNIT = 0.0001 ether, 0.0001..1 ETH). The mainnet ladder (UNIT = 0.01 ether, 0.01..100 ETH) MUST be restored before any mainnet deploy, in lockstep with `preview/src/canonical/denominations.ts` and the parity fixtures. Tracked as risk R1 and decision D-01.

## Components

- Contracts (`src/`): complete v2 system. Shapes core (1343 lines, sole ETH custodian) + ShapeRenderer + ShapeLens (EIP-170 spillover periphery) + ShapeCollection + ShapeAuctionHouse/ShapeCardEscrow. Five externally linked libraries (ComposeCompute, ContractCollectorOps, CopyValidation, GeometrySampling, InkGenes). No proxy, no factory. Vendored OpenZeppelin (not a submodule; upstream patches do not auto-propagate).
- Tests: ~430 test functions across 20 files, stateful invariants, fuzz (512 runs default / 4096 CI), renderer parity + differential suites, fork tests (mint/transfer/redeem only) gated on MAINNET_RPC_URL. Coverage ~96.75% line / 90.95% branch per x-ray. No Echidna/Medusa/Halmos.
- Site (`web/`): Next.js 15 on Netlify (git auto-deploy from main, verified 2026-08-25). Imports all UI/chain logic from `preview/src` via `@shared` alias so the site cannot drift from the contract renderer. Reads chain directly via multicall against the free publicnode Sepolia RPC; no indexer wired in, no RPC fallback, injected wallets only (WalletConnect projectId is a placeholder).
- Preview (`preview/`): canonical TS renderer + parity/fixture/sweep/simulation tooling. `preview/scripts/inkTuning.ts` exists (ink-gene tuning harness).
- Indexer (`indexer/`): Ponder, self-contained, builds token + lineage_edge tables. Built but not deployed and not consumed by the site.
- Docs: canonical status and operating docs live in `project/`; the D-06 truth pass updated the root status lines, ladder, repo map, deployment table, and `web/README.md`.

## Stabilization record

- RESOLVED 2026-08-25: Surface port committed to branch preserve/surface-port (commit ce4c7e4, 6 files), then deliberately rejected under D-04 and the preservation branch deleted with user approval. R2 closed.
- RESOLVED 2026-08-25: audit artifacts committed to branch claude/shapes-security-audit-fa49c8 (commit 6480f1c); triaged in D-02. Two Highs confirmed (H-1 must-fix, H-2 reconcile).
- RESOLVED 2026-08-25: gasmeasure test committed to branch preserve/split-gas-measure (commit 95cdc28).
- RESOLVED 2026-08-25: renderer WIP preserved on preserve/renderer-wip (074fc30); superseded vs novel triage in D-03; novel bits queued as W-1/W-2. The superseded stray indexer draft was deleted during hygiene.
- Hygiene pass COMPLETE 2026-08-25: worktrees down to main checkout + director worktree + 3 codex worktrees (left alone); ~45 local branches down to 10, all with a reason (main, director, 2 preserve/*, audit record, codex checked-out, and 4 UNIQUE: contract-title, docs-truth-and-size-gate, jovial-goodall, portless-local-setup — queued as D-23/W-4/W-5/W-6); _to_delete/ and stray indexer/ draft deleted by user (classifier blocks bulk deletion for the agent). Triage evidence: 17 branches proven superseded via empty diffs against landed squash merges.
- R15 RESOLVED via go-public cutover: repo public at github.com/ripe0x/shapes, Actions free, CI green (contracts + renderer parity) on PR #1. W-4 cost fixes remain queued for P1.
- D-01 final branch-layout decision deferred to P2 entry; interim chain-1 guard landed (f7fd92b).
- D-06 doc truth pass landed (8c30e51): README deployment table and repo map current, spec status lines point here, ladder corrected in WEBSITE_DESIGN_PROMPT.md, web/README rewritten.
- The old checkout's trivial `.gitignore` stash remains low risk and is not part of the canonical clone.

## Known unknowns

- Netlify runtime env vars (dashboard-side, not visible in repo).
- `@x402/*` dependencies in `web/package.json`: unused in code, purpose unknown (D-21).
- Whether ink-gene constants shipped at strawman values without the Monte Carlo pass INK_GENES_DRAFT.md §8 calls for (D-07).
- `ShapeAuctionHouse.createAuction` `minIncrementBps` has no explicit bound beyond uint16 (D-17).
- ShapeLens linked-library addresses are not bound on-chain to Shapes'; only DeployLens.s.sol's behavioral probe guards divergence (R5).
