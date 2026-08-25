# Handoff

Live continuity doc for the Director session. A fresh session picks up here: read project/*.md (STATE.md first), then this file for what was mid-flight. Updated at every significant step, not just session end.

Session: resumed Director session, 2026-08-25.
Branch: claude/project-director-setup-886e07 in canonical clone `/Users/dd/CascadeProjects/shapes-clean`, tracking origin.

## Done this session

- Canonical docs created (project/), committed 8eb0235 and updated through 6b4b87f.
- All at-risk uncommitted work preserved: preserve/surface-port (ce4c7e4), preserve/renderer-wip (074fc30), preserve/split-gas-measure (95cdc28), audit artifacts on claude/shapes-security-audit-fa49c8 (6480f1c).
- Audit triage: findings were historical (base 4e6b3d8 predates main's fix wave a0ff0af..d2f2e59); stop condition raised and lifted same day; W-3 confirmed all 23 PoC scenarios already covered by existing passing regressions.
- Chain-1 deploy guard landed (f7fd92b): scripts revert on mainnet while ladder is testnet-scaled.
- Doc truth pass landed (8c30e51).

## In flight

- P0 gate PASSED. PR #1 is mergeable and awaits user review/merge; P1 does not open before that merge.
- Independent review found stale status contradictions in STATE/DECISIONS/RISKS/HANDOFF; corrected in the resumed session. Executable PR diff received an independent accept verdict.
- PR #1 implementation tip `c543df2` is fully green: contracts, renderer parity, Netlify deploy preview, header rules, and redirect rules passed; the pages-changed check correctly skipped. Root cause of the prior Netlify failure was the invisible nested config: the linked site checks out the repository root, but `netlify.toml` lived under `web/`. The reviewed fix moved it to root with `base = "web"`; local Netlify build and remote preview both pass. The separate FlatCompat fix also passes web lint/build.
- Open user decisions: D-23 (title-auction product line on claude/contract-title — pursue/park/kill), D-05 (mainnet keys/fee, needed by P2).

## Next

- User reviews and merges PR #1. Then dispatch W-1, D-12, and W-4 as separate P1 packets, with D-08 as the first experiment.

## Go-public cutover: EXECUTED 2026-08-25

- Old repo renamed ripe0x/shapes-archive (PRIVATE — must stay private forever; its object store carries the pre-scrub identity). Local checkout's origin re-pointed at the archive so an accidental push cannot recontaminate the clean repo.
- New ripe0x/shapes created, rewritten mirror pushed, server pruned to the canonical 10 branches (filter-repo had promoted stale remote-tracking refs to branches; 30 extra refs deleted, codex checkpoint refs and stash included).
- Attribution verified via API: all commits author as ripe0x (merge committers web-flow). Flipped PUBLIC. GitHub Actions resumed and passed both jobs on PR #1; R15 closed.
- Canonical local migration is complete at `/Users/dd/CascadeProjects/shapes-clean`. The archive remains private permanently for its pre-scrub history and merged-PR discussions. Netlify is connected to the new public repo; its repository-root build configuration is verified on PR #1.

## Standing user directives (this session)

- Director owns plan and judgment calls; not just executor. Token discipline: load-bearing reading and tricky wiring inline; breadth work delegated in parallel to cheaper models, conclusions only kept in context.
- Commit author must be ripe0x <109935398+ripe0x@users.noreply.github.com>; verify before push.
- Keep this handoff current so a new session can resume without loss.

## Post-cutover verification (2026-08-25)

- Wallet-key sweep of the public repo, all branch tips + full history: CLEAN. Only anvil's canonical dev keys (accounts 0-7, universal test mnemonic) in e2e/fork-dev/simulate scripts, vendored library constants, multicall3 runtime bytecode, and fixture seeds. No .env ever committed beyond indexer/.env.example (placeholders).
- Incident: first push from this fresh clone used global gitconfig (gmail author) — the fresh-clone footgun. Amended to ripe0x noreply and force-pushed within a minute (d400c8d); orphaned object held only handoff text. Fresh clones of this repo MUST set local user.name/user.email to ripe0x noreply before committing.

## Issue/PR migration check (2026-08-25)

Archive has zero open issues and zero open PRs; all 41 historical PRs merged. Nothing to migrate. The merged PRs' discussion threads exist ONLY on shapes-archive — recommendation accepted into plan: KEEP shapes-archive as a permanent private archive rather than deleting it.
