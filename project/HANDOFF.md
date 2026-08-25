# Handoff

Live continuity doc for the Director session. A fresh session picks up here: read project/*.md (STATE.md first), then this file for what was mid-flight. Updated at every significant step, not just session end.

Session: 488d5364-0450-4566-9311-e01372e7a8ad (director setup session, 2026-08-25).
Branch: claude/project-director-setup-886e07 (worktree .claude/worktrees/project-director-setup-886e07). Unpushed.

## Done this session

- Canonical docs created (project/), committed 8eb0235 and updated through 6b4b87f.
- All at-risk uncommitted work preserved: preserve/surface-port (ce4c7e4), preserve/renderer-wip (074fc30), preserve/split-gas-measure (95cdc28), audit artifacts on claude/shapes-security-audit-fa49c8 (6480f1c).
- Audit triage: findings were historical (base 4e6b3d8 predates main's fix wave a0ff0af..d2f2e59); stop condition raised and lifted same day; W-3 confirmed all 23 PoC scenarios already covered by existing passing regressions.
- Chain-1 deploy guard landed (f7fd92b): scripts revert on mainnet while ladder is testnet-scaled.
- Doc truth pass landed (8c30e51).

## In flight

- D-04 DECIDED standalone (user, 2026-08-25). preserve/surface-port deleted deliberately; recorded in DECISIONS.md.
- Hygiene COMPLETE (see STATE.md). 10 local branches remain, each justified. User ran the classifier-blocked deletions themselves.
- P0 gate blocked solely on R15: GitHub Actions billing dead since 2026-08-08, zero CI on 17 days of main pushes. USER ACTION: fix billing in GitHub settings. Then: re-run CI on main tip, land W-4 (CI cost fixes from claude/docs-truth-and-size-gate), declare P0 gate, open P1.
- Open user decisions: D-23 (title-auction product line on claude/contract-title — pursue/park/kill), D-05 (mainnet keys/fee, needed by P2).

## Next after hygiene

- P0 gate check, then P1 per ROADMAP.md: W-1 (Black Shape site UI + node.more rollup rendering bug live on main's TokenView), D-12 RPC fallback transport, D-10 indexer prototype, D-08 gas ceilings, D-07 ink tuning.

## Standing user directives (this session)

- Director owns plan and judgment calls; not just executor. Token discipline: load-bearing reading and tricky wiring inline; breadth work delegated in parallel to cheaper models, conclusions only kept in context.
- Commit author must be ripe0x <109935398+ripe0x@users.noreply.github.com>; verify before push.
- Keep this handoff current so a new session can resume without loss.
