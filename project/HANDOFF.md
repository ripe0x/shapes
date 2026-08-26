# Handoff

Live continuity doc for the Director session. A fresh session picks up here: read project/*.md (STATE.md first), then this file for what was mid-flight. Updated at every significant step, not just session end.

Session: resumed Director session, 2026-08-26.
Branch: `codex/artist-attribution` in canonical clone `/Users/dd/CascadeProjects/shapes-clean`; implementation through `30cafec`, draft PR #4 open.

## Done this session

- Canonical docs created (project/), committed 8eb0235 and updated through 6b4b87f.
- All at-risk uncommitted work preserved: preserve/surface-port (ce4c7e4), preserve/renderer-wip (074fc30), preserve/split-gas-measure (95cdc28), audit artifacts on claude/shapes-security-audit-fa49c8 (6480f1c).
- Audit triage: findings were historical (base 4e6b3d8 predates main's fix wave a0ff0af..d2f2e59); stop condition raised and lifted same day; W-3 confirmed all 23 PoC scenarios already covered by existing passing regressions.
- Chain-1 deploy guard landed (f7fd92b): scripts revert on mainnet while ladder is testnet-scaled.
- Doc truth pass landed (8c30e51).

## In flight

- D-26 is implemented and pushed in draft PR #4. `artist()` permanently records the deployer; Shapes creates a bound `ShapesArtistAttribution` child whose one-time EIP-712 signature binds chain, child, Shapes, artist and release hash. It grants no authority or economics, stores no statement, and does not change the one-step admin transfer selected by the user.
- The direct-core implementation was measured first and rejected at 25,611 runtime bytes, 1,035 over EIP-170. The adopted child design leaves Shapes at 24,289 bytes with 287 bytes of margin; the child is 3,028 bytes. `IShapes` is pinned at `0xca355cbe`.
- Attribution security coverage includes independent domain/type/message reconstruction, wrong signer/hash/chain rejection, cross-deployment replay rejection, one-time storage, EIP-7702 delegated-EOA ECDSA, conventional ERC-1271, and a valid empty ERC-1271 signature. The final full suite is 438 passed, 0 failed, 4 fork-only skipped. An independent review accepts the branch as a draft.
- PR #4 MUST NOT MERGE before the fresh Sepolia deployment and site metadata change land atomically. The new site reads are intentionally incompatible with the retired Sepolia address in `web/public/deployment.json`; no fallback was added because the user confirmed Sepolia will be redeployed. Netlify auto-deploys main, so merging early would break the live site.
- No Sepolia transaction has been broadcast. The `releaseHash` definition is the Shapes deployment transaction hash, whose value exists only after deployment. `ETHERSCAN_API_KEY` is still unset in the Director environment. The new Sepolia-only signing script prints and simulates the exact digest, requires two confirmations, waits for receipt, and performs postflight reads.
- Final deploy preflight found and fixed two wrapper gaps before broadcast: it now forces `FOUNDRY_PROFILE=testnet` and explicitly verifies the attribution child created internally by Shapes. A live-chain, non-broadcast simulation succeeded with the intended 1% fee, deployer as fee recipient/admin/Shape #0 owner/artist, no optional seed mints, exact lens equivalence, 21,338,708 estimated gas, and 0.044936689863109904 Sepolia ETH estimated total cost. The deployer holds 0.733598914153560663 Sepolia ETH.
- P0 gate PASSED. PR #1 merged green as `5eec83d`; PR #2 merged green as `7fca2b2`; corrective PR #3 merged as `bf5ae6b`. The intended `owner()` API is restored, and P1 entry now waits only for a fresh Sepolia deployment/readback.
- Independent review found stale status contradictions in STATE/DECISIONS/RISKS/HANDOFF; corrected in the resumed session. Executable PR diff received an independent accept verdict.
- PR #1's last standalone tip `41a36b3` was fully green: contracts, renderer parity, Netlify deploy preview, header rules, and redirect rules passed; the pages-changed check correctly skipped. Two later main commits (`ef228f0`, `1020730`) implemented build-time ladder selection and made PR #1 conflict in DeployShapes/DeploySepolia. The Director merged current main into the PR branch and selected main's stronger profile-aware guards. Re-run the combined checks before merge.
- Incident: the Director raised an ERC-173 concern, then treated a general “go” as approval to replace PR #2's `owner()` API with `titleHolder()`. The user did not approve that product/ABI change. DIRECTOR.md now explicitly forbids changing fundamental behavior or ABI on inferred approval.
- Correction restored and merged in PR #3 as `bf5ae6b`: `owner()` is the Shape #0 holder; `titleHolder()`/`IContractTitle` are removed; the separate `admin()` role and all unrelated PR #2 fixes remain. Active contract, scripts, preview ABI, tests, and product docs are reconciled. Historical incident references are explicitly labeled.
- Verification: Shapes runtime 24,131 bytes with a 445-byte EIP-170 margin; 428 contract tests pass, 0 fail, 4 fork-only skip; 27 testnet-profile ownership/token/ladder tests pass; 39 preview tests and TypeScript pass; independent behavior review accepts; security diff scan `704e538c-4db4-4ce3-b255-fd523cc47b35` has zero reportable findings.
- Correction to the review record: D-25/R18 were invented blockers. The expected custom `IShapes` interface-id change has no compatibility impact because the restored architecture has never been deployed, no legacy external consumer exists, and repository production code does not probe that id. No dual-id code is warranted.
- Combined local verification after current-main reconciliation: docs selector check, preview typecheck/stream verification/500-per-denomination collision sweep/fixture freshness, web lint/build, `forge fmt --check`, `forge build --sizes`, and full `forge test` pass. Result: 454 passed, 0 failed, 4 fork-only skipped; Shapes EIP-170 margin 145 bytes. The sweep exposed and this branch fixed an existing rotation-accounting bug that produced negative percentages after the vocabulary expanded; it now counts every active rotatable primitive and asserts totals.
- Open user decision: D-05 (mainnet admin/Shape #0 custody, immutable fee recipient, and lock/renounce timing, needed by P2).

## Next

- Obtain the exact user-approved `releaseHash` definition/value and an available `ETHERSCAN_API_KEY`; then deploy and verify the full suite to Sepolia, run the guarded artist attestation, replace every address/fromBlock in `web/public/deployment.json`, rerun live site/CI checks, and only then make PR #4 mergeable. W-1, D-12, and W-4 remain separate P1 packets; D-08 remains the first experiment.

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
