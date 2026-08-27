# Handoff

Live continuity doc for the Director session. Read `project/STATE.md` first, then this file for the active packet and exact blockers.

Session: P1 hardening integration, 2026-08-27.
Branch: `codex/p1-hardening` in canonical clone `/Users/dd/CascadeProjects/shapes-clean`, based on merged main `7f92f1b` (PR #5).

## Current outcome

- PR #5 merged as `7f92f1b`. Final core views are `exists` and live-only `denomIndexOf`; `absorbedBy` remains rejected. `IShapes` is `0xb5ac96e9`, `IShapeValue` is `0xd07d718a`.
- PR #8 is open from `codex/p1-hardening` with the consolidated P1 packet. It includes RPC fallback, Black/provenance UI fixes, bounded optional chain-authoritative indexer reads, CI cost controls, Medusa, gas/ink experiments, portless, dependency cleanup, Next 16 and fetched-exact-main Sepolia deployment postflights.
- The core contract is unchanged by this packet. Fresh size gates remain Shapes 24,235 bytes default (341-byte EIP-170 margin) and 24,214 bytes testnet (362-byte margin).
- Full default and testnet suites each pass 451 tests with 4 fork-only skips. Preview has 56 passing tests; web lint/build and indexer zero-audit/codegen/typecheck/Anvil smoke pass. The root npm audit has 9 moderate and 0 high/critical findings after scoped overrides; Medusa passes 10/10 reserve/lifecycle checks and 34,350 calls in the Director rerun.
- Codex Security scan `af61993b-3d85-4142-984b-19343d4697ae` sealed against exact range `7f92f1b..5d1c37e`: three low findings, all outside core. The final packet fixes each with tested indexer timeout/resource bounds and passive embedded-only OG artwork. It also fixes the fetched-main deploy gate, RPC credential redaction, both-ladder fixture/parity CI, collision-free Medusa extraction, root-lock renderer triggers and an isolated indexer CI job.
- PR #8's hosted `changed paths`, contracts, renderer parity, indexer, site and Medusa jobs all pass. The contract job completed its deeper CI profile in 12m12s.
- D-32 reschedules GitHub issue #7 as P2 pre-mainnet renderer-audit work, after the current P1/Sepolia release and before any renderer expansion. Only a behavior-preserving `_moduleSvg` helper extraction is approved. `_glyph` remains a documented lookup-table complexity exception. Current ShapeRenderer baselines are 22,699 bytes default and 22,698 bytes testnet; unchanged TypeScript fixtures, frozen-legacy differential parity, pinned size and one-/25-module gas evidence are mandatory.

## Decisions and evidence

- D-07: keep ink constants unchanged for Sepolia. The exact seed-preserving retained-Dense heuristic reaches Solid 100 after 40,064 dust mints on average (95% CI 39,972–40,156), about 4.01 ETH mainnet-scale fees, with 100.07 ETH mean peak retained backing. This is not a global optimum; mainnet immutable values are reconfirmed at P2.
- D-08: direct 10k actions are impossible on L1, but the hierarchical apex path is valid. Direct compose is 1.134B gas; direct split/decompose exceed 30M. The exact 3,333-call ladder tree reaches the apex, with a 985,862-gas worst individual rung. UI must not promise direct fan-in/fan-out or an unmeasured batch size. W-2 is rejected.
- D-09: adopt Medusa 1.5.1 in CI with a checksum-pinned binary; defer Halmos because its AST build exceeded the three-minute/~2.1 GB spike budget before symbolic execution.
- D-10: optional indexer path is implemented and keeps Shapes authoritative. Freshness, chain, uniqueness and exact live count are checked; each page has an 8-second abort, 256 KiB body cap, 500-item cap, unique cursor and totalSupply-derived page/item ceiling. All displayed fields are current chain reads; every failure falls back to raw RPC. A 1,203-id fixture cuts reads from 1,218 to 18. Ponder's vulnerable pins are replaced by smoke-tested overrides, and the isolated install audits at zero.
- D-12/W-1/W-4/W-5/W-6/D-21: implemented. Browser and OG share independent RPC fallbacks; Black Shapes remain visible with invalid mutators hidden; provenance rollups no longer impersonate token #0; CI is path-filtered/cached and includes site/Medusa jobs; portless is adopted; direct unused x402 packages are removed.
- D-11: the project-owned public Reown id is configured for Netlify production and preview builds. Live testing found and fixed the QR dependency break and generic-only wallet inventory. The first namespace workaround connected Rainbow on mainnet but could not authorize the Sepolia mint, so it is removed. The current branch requires canonical Sepolia directly in the WalletConnect session and rotates session storage to prevent reuse of the bad mainnet-only pairing. The stable preview remains `https://wallet-options--shapes-onchain.netlify.app`; actual Rainbow reconnection plus Sepolia mint is required before this remediation is accepted.

## Deployment configuration

- Sepolia deployer/admin/artist/Shape #0 owner: `0xCB43078C32423F5348Cab5885911C3B5faE217F9` via Foundry account `ripe0x`.
- Sepolia future mint-fee recipient: `0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4`; it is code-free. Fee is exactly 100 bps.
- Deploy only from fetched, clean, exact `main`. Never deploy from this branch. `script/deploy-sepolia.sh` fetches `origin/main` immediately before enforcing branch/commit/cleanliness, then checks chain, ladder, payout, fee, complete wiring, Shape #0 state, unsigned artist state, receipts and Etherscan source visibility. Its portable summary records a credential-free public RPC, never the operational provider URL.
- The Etherscan key supplied in chat is not persisted. Inject it only into the deployment process. The user enters the Foundry keystore password interactively; never write it to a file.
- After deployment, `releaseHash` is the exact mined Shapes creation transaction hash. Run `script/attest-artist-sepolia.sh` only after address/readback confirmation; the one-time signature lives directly in Shapes.
- The old live deployment in `web/public/deployment.json` is immutable and incompatible. A prior throwaway rehearsal at Shapes `0xc840be03f6824165954213136927828b10b1a1a1`, creation tx `0x0529271c4cc71449429a094d6b2fcb2225ee926360d86712b0c96901d4bf8330`, uses the superseded child-attribution architecture. Never sign, relabel or adopt it.

## Remaining gates, in order

1. Open the refreshed stable preview on the same phone and reconnect Rainbow. It must connect directly on Sepolia and complete a Sepolia mint without an intermediate mainnet connection or switch. This is the acceptance test for D-11.
2. After D-11 passes, merge the already-green PR #8.
3. Fetch exact merged `main`, run non-broadcast rehearsal, then have the user run the interactive Sepolia deploy command. Read back and verify every address/value; submit the one-time artist attestation; update `web/public/deployment.json` in a follow-up cutover.
4. With the fresh address/fromBlock, provision the indexer only after explicit Railway/Postgres spending authorization and an archive Sepolia RPC are supplied. Verify `/health`, `/ready`, `/status`, `/graphql`, then publish `indexerUrl`.
5. Run and record a live Sepolia auction with a second signer, then close the P1 evidence gate.

## Standing directives

- Never broadcast mainnet without explicit approval for each transaction.
- Commit as `ripe0x <109935398+ripe0x@users.noreply.github.com>`; verify before every push from a fresh clone.
- Never commit or push from `/Users/dd/CascadeProjects/shapes`; it has pre-rewrite history.
- `ripe0x/shapes-archive` stays private forever. Never push anything to or from it.
- Never infer approval to change fundamental functionality, contract semantics, public ABI or a PR's architecture. Surface the concern and obtain explicit user confirmation.
- D-05 mainnet admin/Shape #0 custody, fee recipient and lock/renounce timing remains a P2 user decision. Sepolia choices do not resolve it.
