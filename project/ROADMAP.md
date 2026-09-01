# Roadmap

Evidence-based phases. No phase-N+1 implementation before phase N's gate passes. Stop conditions halt the phase and force a Director review.

## P0 Stabilize (gate passed for the reviewed architecture)

Objective: nothing valuable is uncommitted, nothing dangerous is undecided-by-accident, docs match reality.

Deliverables:
- Surface port committed to a preservation branch (no architecture decision implied) (D-04 step 1).
- Security-audit worktree contents landed on a branch; every finding dispositioned in DECISIONS.md (D-02).
- Renderer WIP in the surface worktree reviewed and landed or explicitly discarded (D-03).
- Build-time ladder separation and deploy-time profile assertions for mainnet/testnet (D-01 resolved on main after the original P0 gate).
- Doc truth pass merged (D-06).
- Worktree/branch hygiene: stale worktrees pruned, `_to_delete/` cleared with user approval, branch list triaged.

Acceptance: `git status` clean in every worktree or WIP explicitly owned; all P0 decision ids resolved or downgraded with rationale; CI green on main.

Evidence gate: STATE.md updated to show zero at-risk uncommitted work; audit findings table complete.

Stop conditions: an audit finding of high severity (stop and fix before anything else merges); loss or corruption of the Surface port files.

## P1 entry gate: adopted architecture delta (gate passed)

Objective: land and freshly deploy the D-24 architecture before spending hardening evidence.

Deliverables:
- COMPLETE: PR #1 merged green as `5eec83d`, including build-time ladder separation and the root-lockfile CI fix.
- COMPLETE: D-24 adopted Shape #0 + separate admin with explicit `owner()`; D-23's competing non-tokenized title product is superseded.
- COMPLETE: PR #2 rebased after PR #1, closed every finding in `project/reviews/PR-2.md`, passed full local/remote checks, and merged as `7fca2b2`.
- COMPLETE: corrective PR #3 restored PR #2's intended `owner()` API, removed the unauthorized `titleHolder()` substitution, passed review and CI, and merged as `bf5ae6b`.
- COMPLETE: D-28 supersedes D-26's child implementation before launch. Artist attribution and its one-time cryptographic release signature now live directly in Shapes; only stateless digest/signature-checking code is externally linked. The shared token/collection description simplification creates enough EIP-170 headroom without changing collection artwork. Merged in PR #4 as `c34aea3`.
- COMPLETE: D-27 admin-directed future mint-fee recipient, with immutable `feeBps`, no reserve authority, and exact Sepolia payout/admin post-flight checks. Merged in PR #4 as `c34aea3`.
- RESOLVED ARCHITECTURALLY, PARKED POST-LAUNCH: D-29 defines positions as a fully escrowed external exchange-option protocol. Shapes retains discovery only and gains no freeze, wrapper, custody or execution logic.
- COMPLETE: PR #5 merged as `7f92f1b`. D-31 adds non-reverting `exists` and stored `denomIndexOf`, keeps `absorbedBy` rejected, and passes lifecycle/interface and default/testnet EIP-170 gates.
- COMPLETE: exact merged `main` commit `376bb7b` is live on Sepolia at Shapes `0xbB6F8b4560E0cc15de233E00848104b66FD88B39`; all constructor/wiring/value postflights pass and all ten sources are verified. The one-time artist signature against creation transaction `0x23e53908314594e3bd53d4fa9d83cccb700eb03ea452f1395231a3c3dfaf40fe` mined as `0xaa9f422c51688d6debf1b8da6b82c518d74185a977e701b9afba07200776a2e7` and reads back exactly. PR #16 cut over the address/fromBlock metadata, and PR #17 restored the production Netlify build by pinning its tested Node/npm toolchain. The live site serves the fresh deployment record and Shape #0 image. Never relabel either older immutable deployment.

Acceptance: PR #2 and the D-28 attribution change merged with no waived P1 finding; the Sepolia deployment named in STATE matches the selected ABI and architecture, and its artist attestation verifies directly on Shapes against the recorded release hash.

Evidence gate: combined GitHub/Netlify checks, D-24 entry, PR #2 review closure table, and fresh deployment rehearsal/readback.

Stop conditions: constructor/owner/admin post-flight mismatch; any renderer parity failure.

## P1 Testnet hardening (gate passed 2026-08-31)

Objective: the selected Sepolia system behaves like the mainnet system will, under instrumentation.

Deliverables:
- COMPLETE: shared browser/OG RPC fallback with deterministic blackhole tests (D-12). WalletConnect uses the project-owned id and the conventional RainbowKit configuration. D-11 is closed; Rainbow does not support testnets, so Rainbow-to-Sepolia was an invalid acceptance target and no mobile testnet workaround remains.
- COMPLETE: chain-authoritative optional indexer path, 98.52% fixture read reduction, zero-audit patched Ponder service and deterministic fallback. The Sepolia service is live on one Fly machine with embedded PGlite on an encrypted 1 GB volume; activation health, readiness, GraphQL content and one-block freshness passed (D-10).
- COMPLETE: gas-ceiling experiment recorded per entrypoint; hierarchical apex path accepted and direct 10k actions rejected (D-08).
- COMPLETE FOR SEPOLIA: seed-preserving ink-gene experiment recorded; current constants retained for testnet and explicitly revisited at P2 mainnet signoff (D-07).
- COMPLETE: Medusa adopted in CI; Halmos deferral recorded (D-09).
- COMPLETE: live Sepolia auction #0 exercised two ETH-backed bids, a 12-second anti-sniping deadline extension, settlement, winner lot delivery and seller proceeds. Final house ETH/Shape balances, winning escrow and active lot index are empty; the Fly indexer matched chain ownership at the same head block (D-13).

Acceptance: PASSED. Each deliverable has recorded evidence; CI includes Medusa; the site survives primary-RPC blackhole; the live auction lifecycle and indexer reconciliation pass.

Evidence gate: PASSED 2026-08-31. All P1 simulation/prototype decisions and D-13 are resolved in DECISIONS.md.

Stop conditions: gas ceiling makes a core feature (compose path to apex) infeasible on mainnet — architecture review before proceeding; parity break between TS and Solidity renderers.

## P2 Pre-mainnet

Objective: everything irreversible is decided, reviewed, and rehearsed.

Deliverables:
- COMPLETE: D-34 replaces the specialized resolver with explicit positions and market pointers. Both launch empty/unlocked, lock independently, remain powerless over core state, and preserve the optional lens position read through positions only. PR #39 merged the design; exact release `dba4dbfe93df64cc72052c3eab70289070e301d9` is live on Sepolia with both pointers zero/unlocked and all independent postflights passing.
- Architecture decision: standalone vs Surface-hosted (D-04 final). If Surface-hosted, a full sub-roadmap replaces P3 below.
- COMPLETE FOR CURRENT RELEASE: default mainnet ladder, mainnet fixtures, full parity chain and deploy-profile assertions revalidated (D-01). Exact `dba4dbf` passes both full Foundry profiles and all 4 release tests against a live mainnet fork.
- COMPLETE: renderer audit hardening precedes any module/vocabulary/grammar expansion. PR #36 (`1d6e4b0`) closed issue #7 with a behavior-only `_moduleSvg` extraction that is byte-identical against current TypeScript fixtures and the frozen Solidity oracle, lowers normalized complexity from 16 to 10 with helpers at 3 or lower, reduces runtime by 47 bytes to 23,138/23,137 default/testnet, and keeps worst pinned gas growth to 0.0104% (D-32; EXP-004).
- External security audit completed after issue #7 and D-34, with findings closed or accepted with rationale (D-16, D-17 folded in). `AUDIT_PROMPT_v5.md` is regenerated against exact deployed source `dba4dbf`; selecting the independent auditor and completing the review remain open.
- Legal review completed (D-15).
- Key ceremony plan: admin structure, initial/final fee recipient, Shape #0 custody, artist signing capability, release hash, and lock/renounce timing (D-05).
- COMPLETE FOR CURRENT RELEASE: deployment/lifecycle checks pass against a live mainnet fork; an exact-commit Sepolia deployment at the isolated testnet ladder is live from block 11613113. The isolated-schema Fly indexer and production Netlify site are cut over and chain-validated. The final Etherscan retry remains a release operation, not a contract change; all three pending sources already have exact Sourcify matches.

Acceptance: signed merge checklist for the release commit; audit report on file; rehearsal transcript recorded.

Evidence gate: every Immediate/security/legal decision id closed. User explicitly signs off on immutable values and initial mutable configuration.

Stop conditions: audit finds high-severity issue (fix, re-audit delta); legal review raises a blocking characterization.

## P3 Mainnet launch

Objective: deploy once, correctly.

Deliverables: mainnet deploy (each broadcast individually user-confirmed per standing mainnet protocol), contract verification, deployment.json + indexer mainnet config, site cutover, post-deploy invariant spot-checks, lens behavioral probe against live addresses.

Acceptance: post-flight reads match intended config (ladder, feeBps, feeRecipient, admin, owner, artist and verified artist attestation); site serves mainnet; indexer synced.

Evidence gate: launch report in STATE.md with all addresses and verification links.

Stop conditions: any pre-flight read mismatch — no broadcast; any post-deploy divergence — halt cutover, assess.

## P4 Post-launch operation

Objective: keep it healthy; grow by evidence.

Deliverables: monitoring (reserve invariant watch, RPC health, indexer lag), doc upkeep, deferred-decision revisits (D-18..D-22) on observed need, lock/renounce execution per D-05 plan. Issue #6's `ShapeGrowthEscrow` remains consumer-led P4 periphery and is built only when a concrete protocol requires delegated growth and can fund its separate security review.

Acceptance: ongoing; session protocol in SYSTEM.md governs.

Stop conditions: reserve invariant observation anomaly — immediate incident review (contract is immutable; response is communication and analysis, not intervention).
