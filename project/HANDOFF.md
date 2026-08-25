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
- P0 gate blocked solely on R15 (CI billing-dead since 2026-08-08). RESOLUTION TRACK CHOSEN (user, 2026-08-25): take the repo public — free Actions minutes solve billing, and public was the plan anyway. SCRUB EXECUTED 2026-08-25: inventory clean of secrets; prose depersonalized (commit 99afeb8 new-hash); full-history rewrite done and verified (census = ripe0x only, zero identity hits in messages/blobs, all refs). Rewritten mirror lives in session scratchpad (shapes-rewritten.git) — if gone, reproduce in under a minute: fresh `git clone --mirror --no-local` of the local repo, then `git filter-repo --force --mailmap <mailmap> --replace-message <repl> --replace-text <repl>` where mailmap maps the personal email to ripe0x noreply and repl rewrites the Co-authored-by trailer name, the personal email, the account-name string, and the one wallet-comment phrase; verify census + grep before push. Hash translation table: project/HASHMAP.md. Original plan for reference: (1) inventory; (2) git-filter-repo mailmap rewrite of author+committer to ripe0x noreply plus message/blob scrub per findings; (3) push rewritten history to a BRAND-NEW GitHub repo (never force-push the scrub over the old one — GitHub keeps orphaned commits fetchable by SHA on the old repo's network); archive old private repo, delete when confident; (4) re-pin commit hashes recorded in project/ docs (map old->new), re-link Netlify git-CD to the new repo, re-point local clones; (5) secrets/identity verify on the new repo before flipping public; (6) land W-4 CI cost fixes. User reviews inventory findings before any rewrite executes.
- Open user decisions: D-23 (title-auction product line on claude/contract-title — pursue/park/kill), D-05 (mainnet keys/fee, needed by P2).

## Next after hygiene

- P0 gate check, then P1 per ROADMAP.md: W-1 (Black Shape site UI + node.more rollup rendering bug live on main's TokenView), D-12 RPC fallback transport, D-10 indexer prototype, D-08 gas ceilings, D-07 ink tuning.

## Go-public cutover: EXECUTED 2026-08-25

- Old repo renamed ripe0x/shapes-archive (PRIVATE — must stay private forever; its object store carries the pre-scrub identity). Local checkout's origin re-pointed at the archive so an accidental push cannot recontaminate the clean repo.
- New ripe0x/shapes created, rewritten mirror pushed, server pruned to the canonical 10 branches (filter-repo had promoted stale remote-tracking refs to branches; 30 extra refs deleted, codex checkpoint refs and stash included).
- Attribution verified via API: all commits author as ripe0x (merge committers web-flow). Flipped PUBLIC. CI triggered via PR #1 (director branch -> main) and RUNNING — first run since 2026-08-08. R15 resolution in progress.
- REMAINING: (a) CI conclusion on PR #1 -> then land W-4 cost fixes; (b) user re-links Netlify git-CD to the new repo (dashboard); (c) local migration: fresh clone of the clean repo replaces the old-history checkout + worktrees (old checkout's origin points at the archive meanwhile); (d) delete shapes-archive when confident.

## Standing user directives (this session)

- Director owns plan and judgment calls; not just executor. Token discipline: load-bearing reading and tricky wiring inline; breadth work delegated in parallel to cheaper models, conclusions only kept in context.
- Commit author must be ripe0x <109935398+ripe0x@users.noreply.github.com>; verify before push.
- Keep this handoff current so a new session can resume without loss.

## Post-cutover verification (2026-08-25)

- Wallet-key sweep of the public repo, all branch tips + full history: CLEAN. Only anvil's canonical dev keys (accounts 0-7, universal test mnemonic) in e2e/fork-dev/simulate scripts, vendored library constants, multicall3 runtime bytecode, and fixture seeds. No .env ever committed beyond indexer/.env.example (placeholders).
- Incident: first push from this fresh clone used global gitconfig (gmail author) — the fresh-clone footgun. Amended to ripe0x noreply and force-pushed within a minute (d400c8d); orphaned object held only handoff text. Fresh clones of this repo MUST set local user.name/user.email to ripe0x noreply before committing.
