# State

Single source of truth for current project status. Status lines inside spec documents (SHAPES_V2_SPEC.md "pre-implementation", ZERO_AUCTION_DRAFT.md "no code written", README's "not deployed" table) are historical and superseded by this file.

Last updated: 2026-08-25 (Director setup session).

## Phase

Current phase: P0 Stabilize (see `project/ROADMAP.md`). Gate not yet passed.

STOP CONDITION ACTIVE (2026-08-25): audit finding H-1 (High, CONFIRMED) — ShapeAuctionHouse settlement can permanently lock a winner's escrowed bid. Per ROADMAP P0 stop condition, no other contract work merges until H-1 has a Director-reviewed fix spec and remediation. H-2 (High) pending accept-after-reconcile (likely a doc overclaim vs the charter's accepted-grinding stance). Full triage in DECISIONS D-02.

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
- Docs: extensive but with stale status lines and a stale ladder in WEBSITE_DESIGN_PROMPT.md (lists 25 ETH rung); `web/README.md` is create-next-app boilerplate; README repo map missing 14 files. Cleanup tracked as D-06.

## Uncommitted work at risk

- `.claude/worktrees/shapes-surface-protocol-df87db`: the entire Surface-protocol port exists ONLY as untracked files here — `src/surface/` (ISurface, ShapesMinter, ShapesSurfaceRenderer, ILineage, LineageStore) and `test/surface/ShapesOnSurface.t.sol` (mainnet-fork tested against the live SurfaceFactory). Committed nowhere; the `shapes-on-surface` branch itself contains only ink prototypes and is fully merged into main. One `git clean` destroys the port. Same worktree also has uncommitted modifications to the parity-critical pair (`preview/src/canonical/render.ts` + `src/ShapeRenderer.sol`) and `test/fixtures/fixtures.json`, on a base 97 commits behind main. Tracked as R2 / D-03 / D-04.
- RESOLVED 2026-08-25: Surface port committed to branch preserve/surface-port (commit ce4c7e4, 6 files, renderer WIP left untouched). R2 closed.
- RESOLVED 2026-08-25: audit artifacts committed to branch claude/shapes-security-audit-fa49c8 (commit 6480f1c); triaged in D-02. Two Highs confirmed (H-1 must-fix, H-2 reconcile).
- RESOLVED 2026-08-25: gasmeasure test committed to branch preserve/split-gas-measure (commit 95cdc28).
- Still at risk: renderer WIP (render.ts + ShapeRenderer.sol + fixtures) in shapes-surface-protocol-df87db remains uncommitted on a stale base. D-03 open.
- Stash on main: one trivial .gitignore change (3 lines). Low risk.
- ~45 local branches, 13 worktrees. Hygiene pass tracked in P0.

## Known unknowns

- Netlify runtime env vars (dashboard-side, not visible in repo).
- `@x402/*` dependencies in `web/package.json`: unused in code, purpose unknown (D-21).
- Whether ink-gene constants shipped at strawman values without the Monte Carlo pass INK_GENES_DRAFT.md §8 calls for (D-07).
- `ShapeAuctionHouse.createAuction` `minIncrementBps` has no explicit bound beyond uint16 (D-17).
- ShapeLens linked-library addresses are not bound on-chain to Shapes'; only DeployLens.s.sol's behavioral probe guards divergence (R5).
