# Handoff

Live continuity doc for the Director session. Read `project/STATE.md` first, then this file for the active packet and exact blockers.

Session: mainnet-readiness execution, 2026-08-28.
Branch: `codex/netlify-node-pin` in canonical clone `/Users/dd/CascadeProjects/shapes-clean`, based on merged main `9990f45` (PR #16).

## Current outcome

- PR #5 merged as `7f92f1b`. Final core views are `exists` and live-only `denomIndexOf`; `absorbedBy` remains rejected. `IShapes` is `0xb5ac96e9`, `IShapeValue` is `0xd07d718a`.
- PR #8 merged as `2f858ff` with the consolidated P1 packet. PR #9 fixed its merged-main Foundry prank setup as `376bb7b`; exact-main GitHub CI is green and the full local contract suite passes 451/451.
- The core contract is unchanged by this packet. Fresh size gates remain Shapes 24,235 bytes default (341-byte EIP-170 margin) and 24,214 bytes testnet (362-byte margin).
- Full default and testnet suites each pass 451 tests with 4 fork-only skips. Preview has 59 passing tests; web lint/build and indexer zero-audit/codegen/typecheck/Anvil smoke pass. The root npm audit has 9 moderate and 0 high/critical findings after scoped overrides; Medusa passes 10/10 reserve/lifecycle checks and 34,350 calls in the Director rerun.
- Codex Security scan `af61993b-3d85-4142-984b-19343d4697ae` sealed against exact range `7f92f1b..5d1c37e`: three low findings, all outside core. The final packet fixes each with tested indexer timeout/resource bounds and passive embedded-only OG artwork. It also fixes the fetched-main deploy gate, RPC credential redaction, both-ladder fixture/parity CI, collision-free Medusa extraction, root-lock renderer triggers and an isolated indexer CI job.
- PR #8's hosted `changed paths`, contracts, renderer parity, indexer, site and Medusa jobs all pass. The contract job completed its deeper CI profile in 12m12s.
- D-32 reschedules GitHub issue #7 as P2 pre-mainnet renderer-audit work, after the current P1/Sepolia release and before any renderer expansion. Only a behavior-preserving `_moduleSvg` helper extraction is approved. `_glyph` remains a documented lookup-table complexity exception. Current ShapeRenderer baselines are 22,699 bytes default and 22,698 bytes testnet; unchanged TypeScript fixtures, frozen-legacy differential parity, pinned size and one-/25-module gas evidence are mandatory.
- Exact `376bb7b` is live on Sepolia at Shapes `0xbB6F8b4560E0cc15de233E00848104b66FD88B39`; creation transaction/release hash is `0x23e53908314594e3bd53d4fa9d83cccb700eb03ea452f1395231a3c3dfaf40fe`, from block 11582031. All postflight reads pass and all ten sources are verified. The one-time artist attestation mined as `0xaa9f422c51688d6debf1b8da6b82c518d74185a977e701b9afba07200776a2e7` at block 11586702; stored hash and signature readback pass.
- PR #16 merged as `9990f45`. Production remained on the old deployment because Netlify's new Node 24/npm 11 default re-resolved optional RainbowKit/Coinbase peers and failed on unused x402 imports. GitHub and local builds use Node 22.19.0/npm 10.9.3 and pass. The current fix pins Netlify to that tested toolchain; verify a successful production deploy and live `deployment.json` before declaring cutover complete.
- Issue #6 is deferred under D-33 to P4 and a real consumer. Do not add `decomposeInto` or a generic position resolver without separate product decisions.

## Decisions and evidence

- D-07: keep ink constants unchanged for Sepolia. The exact seed-preserving retained-Dense heuristic reaches Solid 100 after 40,064 dust mints on average (95% CI 39,972–40,156), about 4.01 ETH mainnet-scale fees, with 100.07 ETH mean peak retained backing. This is not a global optimum; mainnet immutable values are reconfirmed at P2.
- D-08: direct 10k actions are impossible on L1, but the hierarchical apex path is valid. Direct compose is 1.134B gas; direct split/decompose exceed 30M. The exact 3,333-call ladder tree reaches the apex, with a 985,862-gas worst individual rung. UI must not promise direct fan-in/fan-out or an unmeasured batch size. W-2 is rejected.
- D-09: adopt Medusa 1.5.1 in CI with a checksum-pinned binary; defer Halmos because its AST build exceeded the three-minute/~2.1 GB spike budget before symbolic execution.
- D-10: optional indexer path is implemented and keeps Shapes authoritative. Freshness, chain, uniqueness and exact live count are checked; each page has an 8-second abort, 256 KiB body cap, 500-item cap, unique cursor and totalSupply-derived page/item ceiling. All displayed fields are current chain reads; every failure falls back to raw RPC. A 1,203-id fixture cuts reads from 1,218 to 18. Ponder's vulnerable pins are replaced by smoke-tested overrides, and the isolated install audits at zero.
- D-12/W-1/W-4/W-5/W-6/D-21: implemented. Browser and OG share independent RPC fallbacks; Black Shapes remain visible with invalid mutators hidden; provenance rollups no longer impersonate token #0; CI is path-filtered/cached and includes site/Medusa jobs; portless is adopted; direct unused x402 packages are removed.
- D-11: CLOSED. Rainbow does not support testnets, so the attempted Rainbow-to-Sepolia acceptance test was invalid and is removed as a gate. Keep the conventional RainbowKit `getDefaultConfig` integration and standard inventory; every namespace, storage, mainnet-bootstrap and switching workaround remains removed. The deterministic Sepolia config and transaction-initiation tests cover this packet. Rainbow is tested only when the eventual site targets mainnet.

## Deployment configuration

- Sepolia deployer/admin/artist/Shape #0 owner: `0xCB43078C32423F5348Cab5885911C3B5faE217F9` via Foundry account `ripe0x`.
- Sepolia future mint-fee recipient: `0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4`; it is code-free. Fee is exactly 100 bps.
- Deploy only from fetched, clean, exact `main`. Never deploy from this branch. `script/deploy-sepolia.sh` fetches `origin/main` immediately before enforcing branch/commit/cleanliness, then checks chain, ladder, payout, fee, complete wiring, Shape #0 state, unsigned artist state, receipts and Etherscan source visibility. Its portable summary records a credential-free public RPC, never the operational provider URL.
- The Etherscan key supplied in chat is not persisted. Inject it only into the deployment process. The user enters the Foundry keystore password interactively; never write it to a file.
- The exact mined release hash is `0x23e53908314594e3bd53d4fa9d83cccb700eb03ea452f1395231a3c3dfaf40fe`. The one-time signature now lives directly in Shapes and cannot be replaced.
- The old live deployment in `web/public/deployment.json` is immutable and incompatible. A prior throwaway rehearsal at Shapes `0xc840be03f6824165954213136927828b10b1a1a1`, creation tx `0x0529271c4cc71449429a094d6b2fcb2225ee926360d86712b0c96901d4bf8330`, uses the superseded child-attribution architecture. Never sign, relabel or adopt it.

## Remaining gates, in order

1. Merge the Netlify Node/npm pin, then confirm production `deployment.json` reads the new contracts.
2. With the fresh address/fromBlock, provision the indexer only after explicit Railway/Postgres spending authorization and an archive Sepolia RPC are supplied. Verify `/health`, `/ready`, `/status`, `/graphql`, then publish `indexerUrl`.
3. Run and record a live Sepolia auction with a second signer, then close the P1 evidence gate.
4. Implement issue #7 as the first P2 contract change, with independent review and all D-32 parity/size/gas/complexity evidence, before the D-16 external-audit snapshot.

## Standing directives

- Never broadcast mainnet without explicit approval for each transaction.
- Commit as `ripe0x <109935398+ripe0x@users.noreply.github.com>`; verify before every push from a fresh clone.
- Never commit or push from `/Users/dd/CascadeProjects/shapes`; it has pre-rewrite history.
- `ripe0x/shapes-archive` stays private forever. Never push anything to or from it.
- Never infer approval to change fundamental functionality, contract semantics, public ABI or a PR's architecture. Surface the concern and obtain explicit user confirmation.
- D-05 mainnet admin/Shape #0 custody, fee recipient and lock/renounce timing remains a P2 user decision. Sepolia choices do not resolve it.
