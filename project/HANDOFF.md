# Handoff

Live continuity doc for the Director session. A fresh session picks up here: read project/*.md (STATE.md first), then this file for what was mid-flight. Updated at every significant step, not just session end.

Session: resumed Director session, 2026-08-25.
Branch: main at `7fca2b2` plus the post-merge continuity update in canonical clone `/Users/dd/CascadeProjects/shapes-clean`.

## Done this session

- Canonical docs created (project/), committed 8eb0235 and updated through 6b4b87f.
- All at-risk uncommitted work preserved: preserve/surface-port (ce4c7e4), preserve/renderer-wip (074fc30), preserve/split-gas-measure (95cdc28), audit artifacts on claude/shapes-security-audit-fa49c8 (6480f1c).
- Audit triage: findings were historical (base 4e6b3d8 predates main's fix wave a0ff0af..d2f2e59); stop condition raised and lifted same day; W-3 confirmed all 23 PoC scenarios already covered by existing passing regressions.
- Chain-1 deploy guard landed (f7fd92b): scripts revert on mainnet while ladder is testnet-scaled.
- Doc truth pass landed (8c30e51).

## In flight

- P0 gate PASSED. PR #1 merged green as `5eec83d`; PR #2 merged green as `7fca2b2`. P1 entry is paused only for a fresh Sepolia deployment and post-flight readback of the adopted architecture.
- Independent review found stale status contradictions in STATE/DECISIONS/RISKS/HANDOFF; corrected in the resumed session. Executable PR diff received an independent accept verdict.
- PR #1's last standalone tip `41a36b3` was fully green: contracts, renderer parity, Netlify deploy preview, header rules, and redirect rules passed; the pages-changed check correctly skipped. Two later main commits (`ef228f0`, `1020730`) implemented build-time ladder selection and made PR #1 conflict in DeployShapes/DeploySepolia. The Director merged current main into the PR branch and selected main's stronger profile-aware guards. Re-run the combined checks before merge.
- User approved D-24 with the Director recommendation: backed Shape #0 + separate admin, exposed through `titleHolder()` rather than the ERC-173-conflicting `owner()`. D-23's old non-tokenized title-auction product is superseded; its branch remains untouched as history.
- PR #2 fixes the title selector, preserves legacy `IShapes` ERC-165 discovery, advertises `IAdminControl` and `IContractTitle`, repairs the false-positive seed test, adds valid Shape #0 split and safe-transfer/self-custody coverage, and removes stale collector references. It also fixes genesis-block constructor simulation, genesis-aware Anvil/SeedDemo token IDs, and reconciles Charter principle 5 plus canonical docs.
- PR #2 combined verification is green: 428 contract tests pass with 4 fork-only skips; Shapes has a 451-byte EIP-170 margin; testnet-profile title/token/ladder tests, Sepolia dry-run, fresh-Anvil deploy/reserve unwind/auction, preview tests/typecheck/parity/sweep/fixtures, docs selector check, web lint/build, both GitHub CI jobs, two independent re-reviews, and the security diff scan pass. No reportable security finding remains.
- Combined local verification after current-main reconciliation: docs selector check, preview typecheck/stream verification/500-per-denomination collision sweep/fixture freshness, web lint/build, `forge fmt --check`, `forge build --sizes`, and full `forge test` pass. Result: 454 passed, 0 failed, 4 fork-only skipped; Shapes EIP-170 margin 145 bytes. The sweep exposed and this branch fixed an existing rotation-accounting bug that produced negative percentages after the vocabulary expanded; it now counts every active rotatable primitive and asserts totals.
- Open user decision: D-05 (mainnet admin/title custody, immutable fee recipient, and lock/renounce timing, needed by P2).

## Next

- Perform a fresh Sepolia deploy/readback and replace deployment metadata/fromBlock before opening P1. This is an explicit later deployment step, not performed during the PR #2 merge. W-1, D-12, and W-4 remain separate P1 packets; D-08 remains the first experiment.

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
