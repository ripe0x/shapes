# Roadmap

Evidence-based phases. No phase-N+1 implementation before phase N's gate passes. Stop conditions halt the phase and force a Director review.

## P0 Stabilize (current)

Objective: nothing valuable is uncommitted, nothing dangerous is undecided-by-accident, docs match reality.

Deliverables:
- Surface port committed to a preservation branch (no architecture decision implied) (D-04 step 1).
- Security-audit worktree contents landed on a branch; every finding dispositioned in DECISIONS.md (D-02).
- Renderer WIP in the surface worktree reviewed and landed or explicitly discarded (D-03).
- Mainnet deploy guard: deploy script refuses chain 1 while UNIT != 0.01 ether (D-01 interim).
- Doc truth pass merged (D-06).
- Worktree/branch hygiene: stale worktrees pruned, `_to_delete/` cleared with user approval, branch list triaged.

Acceptance: `git status` clean in every worktree or WIP explicitly owned; all P0 decision ids resolved or downgraded with rationale; CI green on main.

Evidence gate: STATE.md updated to show zero at-risk uncommitted work; audit findings table complete.

Stop conditions: an audit finding of high severity (stop and fix before anything else merges); loss or corruption of the Surface port files.

## P1 Testnet hardening

Objective: the Sepolia system behaves like the mainnet system will, under instrumentation.

Deliverables:
- RPC fallback transport in the site (D-12); WalletConnect decision executed (D-11).
- Indexer hosted and integrated behind the site data interface on Sepolia (D-10).
- Gas-ceiling experiment recorded per entrypoint (D-08).
- Ink-gene tuning experiment recorded; constants confirmed or changed (D-07).
- Formal-verification spike done; chosen tool wired into CI or rejection recorded (D-09).
- Live Sepolia auctions run and observed (D-13 evidence gathering).

Acceptance: each deliverable has an EXPERIMENT record with evidence; CI includes any new invariant tooling; site survives primary-RPC blackhole in a verified test.

Evidence gate: all "requires simulation" and "requires prototype" decisions resolved in DECISIONS.md.

Stop conditions: gas ceiling makes a core feature (compose path to apex) infeasible on mainnet — architecture review before proceeding; parity break between TS and Solidity renderers.

## P2 Pre-mainnet

Objective: everything irreversible is decided, reviewed, and rehearsed.

Deliverables:
- Architecture decision: standalone vs Surface-hosted (D-04 final). If Surface-hosted, a full sub-roadmap replaces P3 below.
- Mainnet ladder restored across Denominations.sol, denominations.ts, fixtures; full parity chain green (D-01 final).
- External security audit completed; findings closed or accepted with rationale (D-16, D-17 folded in).
- Legal review completed (D-15).
- Key ceremony plan: owner structure, feeRecipient, lock/renounce timing (D-05).
- Deploy rehearsal: full deploy + seed + lens-probe dry run on a mainnet fork, then Sepolia at mainnet scale if warranted.

Acceptance: signed merge checklist for the release commit; audit report on file; rehearsal transcript recorded.

Evidence gate: every Immediate/security/legal decision id closed. User explicitly signs off on immutable values.

Stop conditions: audit finds high-severity issue (fix, re-audit delta); legal review raises a blocking characterization.

## P3 Mainnet launch

Objective: deploy once, correctly.

Deliverables: mainnet deploy (each broadcast individually user-confirmed per standing mainnet protocol), contract verification, deployment.json + indexer mainnet config, site cutover, post-deploy invariant spot-checks, lens behavioral probe against live addresses.

Acceptance: post-flight reads match intended config (ladder, feeBps, feeRecipient, owner); site serves mainnet; indexer synced.

Evidence gate: launch report in STATE.md with all addresses and verification links.

Stop conditions: any pre-flight read mismatch — no broadcast; any post-deploy divergence — halt cutover, assess.

## P4 Post-launch operation

Objective: keep it healthy; grow by evidence.

Deliverables: monitoring (reserve invariant watch, RPC health, indexer lag), doc upkeep, deferred-decision revisits (D-18..D-22) on observed need, lock/renounce execution per D-05 plan.

Acceptance: ongoing; session protocol in SYSTEM.md governs.

Stop conditions: reserve invariant observation anomaly — immediate incident review (contract is immutable; response is communication and analysis, not intervention).
