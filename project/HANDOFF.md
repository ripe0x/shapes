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

- D-04 DECIDED standalone (user, 2026-08-25). preserve/surface-port branch deleted deliberately; decision + rationale recorded in DECISIONS.md.
- Hygiene pass largely executed. Done: TITLE_MARKET_RESEARCH_PROMPT.md committed on claude/contract-title (180037c); 5 clean worktrees removed (beautiful-allen, gasmeasure, scaled, shapes-security-audit, token-0-card-auction); dev-config drift discarded in the 3 drift worktrees (now clean but dirs still present, ignored files block plain remove); inkDemo.ts in _to_delete verified as superseded model-B prototype, safe to delete.
- BLOCKED on permission classifier (bulk deletion): removal of the 3 drift worktree dirs + shapes-surface-protocol-df87db (holds only untracked superseded indexer/ draft with a .env.local) + rm -rf _to_delete (53.6M). Exact commands handed to user as run-blocks; after they run, `git worktree prune` if needed.
- Branch kill-list reported to user, awaiting approval: MERGED group (zero loss) + UNMERGED-ON-ORIGIN group (origin retains). UNMERGED-LOCAL-ONLY (~20 branches, mostly 8-9 day old audit/doc one-offs) needs a judgment triage pass — offered as follow-up. Codex worktrees (~/.codex/worktrees/*) left alone.

## Next after hygiene

- P0 gate check, then P1 per ROADMAP.md: W-1 (Black Shape site UI + node.more rollup rendering bug live on main's TokenView), D-12 RPC fallback transport, D-10 indexer prototype, D-08 gas ceilings, D-07 ink tuning.

## Standing user directives (this session)

- Director owns plan and judgment calls; not just executor. Token discipline: load-bearing reading and tricky wiring inline; breadth work delegated in parallel to cheaper models, conclusions only kept in context.
- Commit author must be ripe0x <109935398+ripe0x@users.noreply.github.com>; verify before push.
- Keep this handoff current so a new session can resume without loss.
