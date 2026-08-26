# Handoff

Live continuity doc for the Director session. A fresh session picks up here: read project/*.md (STATE.md first), then this file for what was mid-flight. Updated at every significant step, not just session end.

Session: resumed Director session, 2026-08-26.
Branch: `main` in canonical clone `/Users/dd/CascadeProjects/shapes-clean`; PR #4 merged as `c34aea3`.

## Done this session

- Canonical docs created (project/), committed 8eb0235 and updated through 6b4b87f.
- All at-risk uncommitted work preserved: preserve/surface-port (ce4c7e4), preserve/renderer-wip (074fc30), preserve/split-gas-measure (95cdc28), audit artifacts on claude/shapes-security-audit-fa49c8 (6480f1c).
- Audit triage: findings were historical (base 4e6b3d8 predates main's fix wave a0ff0af..d2f2e59); stop condition raised and lifted same day; W-3 confirmed all 23 PoC scenarios already covered by existing passing regressions.
- Chain-1 deploy guard landed (f7fd92b): scripts revert on mainnet while ladder is testnet-scaled.
- Doc truth pass landed (8c30e51).

## In flight

- D-27 is explicitly approved and implemented as Charter amendment 2: `admin()` may redirect only future mint fees; `feeBps` remains immutable and admin cannot withdraw ETH, reach backing/redemption, recover accrued fees, or affect token ownership. Renouncing admin freezes the final recipient. Sepolia is pinned to payout `0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4`, with deployer `0xCB43078C32423F5348Cab5885911C3B5faE217F9` as initial admin. The payout is a code-free Sepolia address. `IAdminControl` is `0xe135adbe`.
- D-28 is explicitly approved and supersedes D-26's pre-launch child implementation. `artist()` permanently records the deployer; the one-time EIP-712 release hash and raw signature now live directly in Shapes through `artistReleaseHash`, `artistSignature`, `artistAttestationDigest` and `attestArtist`. A stateless externally linked `EIP712Signature` library contains only digest and EOA/ERC-1271 verification code. It stores no attribution, grants no authority or economics, and the user-selected one-step admin transfer is unchanged.
- The direct design now fits because duplicate metadata was simplified: token and collection metadata share one editable `description`, `setMetadataCopy` updates the token name prefix and shared description together, and `contractURI` uses the immutable ERC-721 collection name. `ShapeCollection` remains separate because exact animated collection art cannot be merged into the 22,699-byte renderer under EIP-170. No collection-art behavior changed.
- D-29 records the future position protocol as a fully escrowed external exchange-option layer. The claim is escrowed, the Shape remains normally transferable, exercise atomically transfers the current Shape to the creator for the claim, and expiry/value mismatch/missing-token rules permit recovery. A gacha may separately custody an offered Shape. Shapes retains only `positionResolver`/`positionOf`: no freeze, wrapper, mutation nonce, claim custody or execution logic was added. Implementation is parked post-launch.
- Verification is green: 441 contract tests pass in each default and testnet profile, 4 fork-only tests skip without `MAINNET_RPC_URL`; 40 preview tests/build and web lint/build pass; selector/docs/format/shell checks pass; and local Anvil end-to-end deployment, direct artist signing, mint/redeem and auction flows pass. Shapes is 24,103 bytes in default (473-byte margin) and 24,082 bytes in testnet (494-byte margin); `EIP712Signature` is 1,009 bytes. `IShapes` is pinned at `0x926c1806`.
- Attribution coverage independently reconstructs the EIP-712 domain/type/message and covers wrong signer/hash/chain, cross-deployment replay, one-time storage, zero-hash rejection, EIP-7702 delegated-EOA ECDSA, conventional ERC-1271, and a valid empty ERC-1271 signature. The digest binds chain id, exact Shapes address, artist and release hash.
- D-30 reverses the branch-first deployment sequence by explicit user direction: releases deploy only from `main`. The site now catches missing `artist()` / `artistReleaseHash()` selectors, preserves the rest of the old Sepolia state load, and renders attribution as unavailable on that deployment. This fallback was verified against all 22 live tokens on the current Sepolia contract. PR #4 merged safely before deployment as `c34aea3`; deploy from `main` and land the new addresses/fromBlock as a small follow-up cutover.
- D-31 pre-deployment surface review accepts `exists(uint256)` and live-only `denomIndexOf(uint256)` as state-owned facts, and rejects `absorbedBy(uint256)` as a gas-heavy, semantically ambiguous reverse index without a current onchain consumer. Expected `IShapes` id after the two accepted selectors is `0xb5ac96e9`; D-25 applies, so there is no dual-id shim. Implementation and default/testnet size evidence are required before Sepolia deployment. Resolver hooks, mutation nonces and aggregate views remain rejected.
- A throwaway Sepolia rehearsal was broadcast before D-28: Shapes `0xc840be03f6824165954213136927828b10b1a1a1`, actual creation transaction `0x0529271c4cc71449429a094d6b2fcb2225ee926360d86712b0c96901d4bf8330`. It uses the superseded child architecture, is not in deployment metadata, and must not be signed or adopted. No D-28 deployment has been broadcast. The deploy wrapper was corrected to resolve the creation transaction from mined receipts rather than Foundry's simulated transaction ordering.
- The fresh D-28 Sepolia non-broadcast rehearsal passed against chain 11155111 after clearing both Foundry artifact caches: 20,494,912 estimated gas, about 0.040097621127374848 Sepolia ETH at the sampled gas price, exact 1% fee, pinned payout, deployer as admin/artist/Shape #0 owner, unsigned direct attribution, and lens equivalence. The simulated addresses are ephemeral and must not enter deployment metadata.
- The `releaseHash` remains the exact Shapes creation transaction hash, whose value exists only after deployment. The user supplied an Etherscan key in chat; it has not been persisted or committed and must be injected only into the deployment process. The Sepolia-only signing script uses the user's Foundry keystore, prints and simulates the exact digest, requires confirmation, waits for receipt, and performs direct Shapes postflight reads.
- P0 gate PASSED. PR #1 merged green as `5eec83d`; PR #2 merged green as `7fca2b2`; corrective PR #3 merged as `bf5ae6b`. The intended `owner()` API is restored, and P1 entry now waits only for a fresh Sepolia deployment/readback.
- Independent review found stale status contradictions in STATE/DECISIONS/RISKS/HANDOFF; corrected in the resumed session. Executable PR diff received an independent accept verdict.
- PR #1's last standalone tip `41a36b3` was fully green: contracts, renderer parity, Netlify deploy preview, header rules, and redirect rules passed; the pages-changed check correctly skipped. Two later main commits (`ef228f0`, `1020730`) implemented build-time ladder selection and made PR #1 conflict in DeployShapes/DeploySepolia. The Director merged current main into the PR branch and selected main's stronger profile-aware guards. Re-run the combined checks before merge.
- Incident: the Director raised an ERC-173 concern, then treated a general “go” as approval to replace PR #2's `owner()` API with `titleHolder()`. The user did not approve that product/ABI change. DIRECTOR.md now explicitly forbids changing fundamental behavior or ABI on inferred approval.
- Correction restored and merged in PR #3 as `bf5ae6b`: `owner()` is the Shape #0 holder; `titleHolder()`/`IContractTitle` are removed; the separate `admin()` role and all unrelated PR #2 fixes remain. Active contract, scripts, preview ABI, tests, and product docs are reconciled. Historical incident references are explicitly labeled.
- Verification: Shapes runtime 24,131 bytes with a 445-byte EIP-170 margin; 428 contract tests pass, 0 fail, 4 fork-only skip; 27 testnet-profile ownership/token/ladder tests pass; 39 preview tests and TypeScript pass; independent behavior review accepts; security diff scan `704e538c-4db4-4ce3-b255-fd523cc47b35` has zero reportable findings.
- Correction to the review record: D-25/R18 were invented blockers. The expected custom `IShapes` interface-id change has no compatibility impact because the restored architecture has never been deployed, no legacy external consumer exists, and repository production code does not probe that id. No dual-id code is warranted.
- Combined local verification after current-main reconciliation: docs selector check, preview typecheck/stream verification/500-per-denomination collision sweep/fixture freshness, web lint/build, `forge fmt --check`, `forge build --sizes`, and full `forge test` pass. Result: 454 passed, 0 failed, 4 fork-only skipped; Shapes EIP-170 margin 145 bytes. The sweep exposed and this branch fixed an existing rotation-accounting bug that produced negative percentages after the vocabulary expanded; it now counts every active rotatable primitive and asserts totals.
- Open user decision: D-05 (mainnet admin/Shape #0 custody, initial fee recipient, and lock/renounce timing, needed by P2). The Sepolia payout/admin choices do not settle mainnet custody.

## Next

- Implement the two D-31 getters in a focused PR from `main`, including lifecycle, ABI-id, capability-interface and EIP-170 evidence. After that PR merges, on explicit deployment go-ahead broadcast the resulting exact `main` suite with the user-supplied Etherscan key kept only in process environment, verify every contract and exact payout/admin/direct-attribution readback, then run the guarded artist attestation using the actual Shapes creation transaction hash. Replace every address/fromBlock in `web/public/deployment.json` through a small follow-up, then rerun live site/CI checks. W-1, D-12, and W-4 remain separate P1 packets; D-08 remains the first experiment.

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
