# Handoff

Live continuity doc for the Director session. Read `project/STATE.md` first, then this file for the active packet and exact blockers.

Session: mainnet-readiness execution, 2026-08-31.
Canonical base: `main` in `/Users/dd/CascadeProjects/shapes-clean`, through PR #34; this D-13 record lands through the normal evidence PR.

## Current outcome

- P1 PASSED 2026-08-31. D-13's live Sepolia auction #0 completed two bids, anti-sniping extension, settlement, winner delivery and seller proceeds; final escrow/index checks are empty and the Fly indexer matched the chain head.
- Current-main `IShapes` is `0x35ed4674` and `IShapeValue` is `0xd07d718a`. Issue #21's size recovery moved `exists`, `positionOf` and pure denomination helpers to ShapeLens; `absorbedBy` remains rejected.
- Exact-main CI passes 441 contract tests with 4 fork-only skips and the Medusa lifecycle job. Fresh sizes are Shapes 24,394/24,373 bytes and ShapeRenderer 23,185/23,184 bytes for default/testnet respectively.
- Current `main` is ahead of the deployed exact-`376bb7b` Sepolia release after PRs #26/#31 sampling and provenance changes. The auction-house path is unchanged, so D-13 remains valid; P2 must revalidate and rehearse the eventual release and must not claim the live Sepolia core is current-main bytecode.
- Codex Security scan `af61993b-3d85-4142-984b-19343d4697ae` sealed against exact range `7f92f1b..5d1c37e`: three low findings, all outside core. The final packet fixes each with tested indexer timeout/resource bounds and passive embedded-only OG artwork. It also fixes the fetched-main deploy gate, RPC credential redaction, both-ladder fixture/parity CI, collision-free Medusa extraction, root-lock renderer triggers and an isolated indexer CI job.
- PR #8's hosted `changed paths`, contracts, renderer parity, indexer, site and Medusa jobs all pass. The contract job completed its deeper CI profile in 12m12s.
- D-32 makes GitHub issue #7 the first P2 pre-mainnet renderer-audit change. Only a behavior-preserving `_moduleSvg` helper extraction is approved. `_glyph` remains a documented lookup-table complexity exception. After the merged issue #21 behavior changes, the refreshed ShapeRenderer baselines are 23,185 bytes default and 23,184 bytes testnet; unchanged current TypeScript fixtures, frozen-legacy differential parity, pinned size and one-/25-module gas evidence are mandatory.
- Exact `376bb7b` is live on Sepolia at Shapes `0xbB6F8b4560E0cc15de233E00848104b66FD88B39`; creation transaction/release hash is `0x23e53908314594e3bd53d4fa9d83cccb700eb03ea452f1395231a3c3dfaf40fe`, from block 11582031. All postflight reads pass and all ten sources are verified. The one-time artist attestation mined as `0xaa9f422c51688d6debf1b8da6b82c518d74185a977e701b9afba07200776a2e7` at block 11586702; stored hash and signature readback pass.
- PR #16 merged as `9990f45`; PR #17 merged as `b7c1451` and pins Netlify to Node 22.19.0/npm 10.9.3 after its Node 24/npm 11 default broke optional RainbowKit/Coinbase dependency resolution. The production build completed successfully. `https://shapes.ripe.wtf/deployment.json` serves Shapes `0xbB6F8b4560E0cc15de233E00848104b66FD88B39`, and the live homepage plus `/og/shape/0` return HTTP 200. The fresh Sepolia site cutover is complete.
- Issue #6 is deferred under D-33 to P4 and a real consumer. Do not add `decomposeInto` or a generic position resolver without separate product decisions.
- PR #20 merged as `f92d019`. The Sepolia indexer is live at `https://shapes-indexer.fly.dev` on one IAD Fly machine with embedded PGlite and encrypted 1 GB volume `vol_vz8xke1po70oz5qv`. Health, readiness, status and GraphQL readback passed; Shape #0 indexed with exact testnet backing and the checkpoint was one block behind Sepolia.
- PR #22 merged as `769efe0`; production serves `indexerUrl: https://shapes-indexer.fly.dev`. PR #23 (`99b79eb`) added the guarded D-13 path; PR #34 (`6bf5164`) made its close step resumable after the bidder exhausted Sepolia gas. Both PR #34 CI gates passed.

## Decisions and evidence

- D-07: keep ink constants unchanged for Sepolia. The exact seed-preserving retained-Dense heuristic reaches Solid 100 after 40,064 dust mints on average (95% CI 39,972–40,156), about 4.01 ETH mainnet-scale fees, with 100.07 ETH mean peak retained backing. This is not a global optimum; mainnet immutable values are reconfirmed at P2.
- D-08: direct 10k actions are impossible on L1, but the hierarchical apex path is valid. Direct compose is 1.134B gas; direct split/decompose exceed 30M. The exact 3,333-call ladder tree reaches the apex, with a 985,862-gas worst individual rung. UI must not promise direct fan-in/fan-out or an unmeasured batch size. W-2 is rejected.
- D-09: adopt Medusa 1.5.1 in CI with a checksum-pinned binary; defer Halmos because its AST build exceeded the three-minute/~2.1 GB spike budget before symbolic execution.
- D-10: RESOLVED. The optional indexer path keeps Shapes authoritative. Freshness, chain, uniqueness and exact live count are checked; each page has an 8-second abort, 256 KiB body cap, 500-item cap, unique cursor and totalSupply-derived page/item ceiling. All displayed fields are current chain reads; every failure falls back to raw RPC. A 1,203-id fixture cuts reads from 1,218 to 18. The isolated install audits at zero, and the Fly/PGlite service passed live Sepolia activation.
- D-12/W-1/W-4/W-5/W-6/D-21: implemented. Browser and OG share independent RPC fallbacks; Black Shapes remain visible with invalid mutators hidden; provenance rollups no longer impersonate token #0; CI is path-filtered/cached and includes site/Medusa jobs; portless is adopted; direct unused x402 packages are removed.
- D-11: CLOSED. Rainbow does not support testnets, so the attempted Rainbow-to-Sepolia acceptance test was invalid and is removed as a gate. Keep the conventional RainbowKit `getDefaultConfig` integration and standard inventory; every namespace, storage, mainnet-bootstrap and switching workaround remains removed. The deterministic Sepolia config and transaction-initiation tests cover this packet. Rainbow is tested only when the eventual site targets mainnet.
- D-13: RESOLVED. Auction #0 moved from a 1-unit first bid to a 2-unit second bid; the end time moved from 1787980404 to 1787980416. Settlement `0x2855bd12ea9b27fb323cf1d69680f33a6de1aa49274806244211e0cacb19a893`, lot claim `0xc45fcca9e901eb3e7204b4095afad78520a0f3a514f38b93dcc7c1cbead5ea84`, and proceeds claim `0xe6749f28f05486193c43a2ab8cfe4eb522d0111a2e5df34a83ecc76ea7c6f4f0` succeeded. Winner owns Shape #1; seller owns Shapes #2/#3; house ETH, house Shapes, winner bid units and the active lot index are all zero/empty. The indexer reported the same owners at chain head 11608016.

## Deployment configuration

- Sepolia deployer/admin/artist/Shape #0 owner: `0xCB43078C32423F5348Cab5885911C3B5faE217F9` via Foundry account `ripe0x`.
- Sepolia future mint-fee recipient: `0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4`; it is code-free. Fee is exactly 100 bps.
- Deploy only from fetched, clean, exact `main`. Never deploy from this branch. `script/deploy-sepolia.sh` fetches `origin/main` immediately before enforcing branch/commit/cleanliness, then checks chain, ladder, payout, fee, complete wiring, Shape #0 state, unsigned artist state, receipts and Etherscan source visibility. Its portable summary records a credential-free public RPC, never the operational provider URL.
- The Etherscan key supplied in chat is not persisted. Inject it only into the deployment process. The user enters the Foundry keystore password interactively; never write it to a file.
- The exact mined release hash is `0x23e53908314594e3bd53d4fa9d83cccb700eb03ea452f1395231a3c3dfaf40fe`. The one-time signature now lives directly in Shapes and cannot be replaced.
- The old live deployment in `web/public/deployment.json` is immutable and incompatible. A prior throwaway rehearsal at Shapes `0xc840be03f6824165954213136927828b10b1a1a1`, creation tx `0x0529271c4cc71449429a094d6b2fcb2225ee926360d86712b0c96901d4bf8330`, uses the superseded child-attribution architecture. Never sign, relabel or adopt it.

## Remaining gates, in order

1. Implement issue #7 as the first P2 contract change, with independent review and all D-32 parity/size/gas/complexity evidence, before the D-16 external-audit snapshot.
2. Complete D-16 external audit and close or explicitly accept every finding.
3. Obtain D-15 qualified legal review and record the result.
4. Resolve D-05's mainnet admin, fee-recipient, Shape #0 custody and lock/renounce decisions, then rehearse the exact release on a mainnet fork. No mainnet broadcast is authorized.

## Standing directives

- Never broadcast mainnet without explicit approval for each transaction.
- Commit as `ripe0x <109935398+ripe0x@users.noreply.github.com>`; verify before every push from a fresh clone.
- Never commit or push from `/Users/dd/CascadeProjects/shapes`; it has pre-rewrite history.
- `ripe0x/shapes-archive` stays private forever. Never push anything to or from it.
- Never infer approval to change fundamental functionality, contract semantics, public ABI or a PR's architecture. Surface the concern and obtain explicit user confirmation.
- D-05 mainnet admin/Shape #0 custody, fee recipient and lock/renounce timing remains a P2 user decision. Sepolia choices do not resolve it.
