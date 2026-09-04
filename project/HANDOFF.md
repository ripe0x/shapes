# Handoff

Live continuity doc for the Director session. Read `project/STATE.md` first, then this file for the active packet and exact blockers.

Session: flat-fee release Sepolia/site cutover, 2026-09-02.
Deployed source: exact clean `origin/main` at `eb9e8834553f199a4c94e7ba307686c8bd0d64e8`, carrying code-bearing audit target `1054db2455f7d6d3542a422130262bc872c34464`.

## Current outcome

- Exact clean `eb9e8834553f199a4c94e7ba307686c8bd0d64e8` is live on Sepolia from block 11616988: Shapes `0xb142c4b09c24d639d8c154c93a539cbc09566152`, renderer `0xd9c3278d1277cef31b54e98a43db4243ada05610`, collection `0x8c5203d5cd480f7e0b266a2f6d27f0ed9919e8e1`, lens `0x259e90f875b7b975c09f05e5972f359ee0a3fa84`, auction house `0x351b7c9637c6abc1982be95f87961aff2f38647a`. Shapes creation transaction: `0xeb47218282fe64db1124b8369c5f54056fb23391e14b1dd2decfb8079a4cfdec`.
- Every creation receipt and independent code, wiring, role, reserve, ladder, flat-fee, Shape #0, empty-pointer and zero-auction postflight passed. All eleven contracts/libraries are Etherscan-verified. Shape #0 remains with the deployer; no auction was created. Artist release hash/signature remain intentionally empty pending a separate irreversible ceremony.
- Fly version 3 is live on isolated schema `shapes_sepolia_v3`. Health/ready are 200; status was one block behind Sepolia at 11619404 and GraphQL reported exactly backed Shape #0 with the correct owner.
- PR #48 merged current deployment metadata into `main`. PR #49 synchronized `main` into production branch `launch`; PR #50 fixed the explicit hybrid build mode. Netlify deploy `6a980da5e9b3a10007115012` serves the launch page at `/` and the Sepolia app at `/mint`; deployment metadata, token, management, My Shapes, auction, OG and playground routes all return 200.
- Default, testnet and deeper CI Foundry profiles each have 462 passing tests plus 4 expected fork skips; all 4 fork tests pass against live Ethereum; Medusa passes 10/10 properties across 44,411 calls; the full Anvil lifecycle passes; 128 preview tests and preview/web builds pass. Shapes is 24,362/24,341 bytes with 214/235 bytes of margin; ShapeLens is 9,885/9,867; ShapeRenderer is 23,331/23,330; ShapeAuctionHouse is 7,939/7,930. `IShapes` is `0x86cf5406`.
- P1 PASSED 2026-08-31. `audits/AUDIT_PROMPT_v6.md` is the authoritative flat-fee audit brief, pinned to `1054db2455f7d6d3542a422130262bc872c34464`. Independent audit, qualified legal review, R25 product signoff and D-05 mainnet ceremony decisions remain open. No mainnet broadcast is authorized.

### Superseded 2026-09-01 snapshot

The entries below are retained as historical continuity and do not describe the current deployment.

- PR #46 merged D-35/D-36 as exact mainnet candidate `1054db2455f7d6d3542a422130262bc872c34464`: token #0 identity plus an immutable 0.001 ETH fee per mainnet Shape and 0.00001 ETH per testnet Shape, including one fee per auction-bid card created. Default, testnet and deeper CI Foundry profiles each have 462 passing tests plus 4 expected fork skips, and all 4 fork tests pass against live Ethereum; Medusa passes 10/10 properties across 44,411 calls; the full Anvil lifecycle passes; 127 preview tests and preview/web builds pass. Shapes is 24,362/24,341 bytes with 214/235 bytes of margin; ShapeLens is 9,885/9,867; ShapeRenderer is 23,331/23,330; ShapeAuctionHouse is 7,939/7,930. `IShapes` is `0x86cf5406`. R25 flags the intended but material cheap-high-tier-reroll economics. The merged release is not deployed; current Sepolia still uses 100 bps and cannot validate this ABI.
- Current Sepolia auction house `0x38445aced30590910e087672FEEa269284F03379` now holds Shape #0 in launch auction #0. Approval `0xafd08c0864d94aa210f0c3f0a30b8da0ba1be5d94ee61882edafe7aa414feb74` and creation `0xd86702d4845a1233ae7420a94e3764d237a27e2d4a536eaa1d2bb9948a133cfb` succeeded. Terms are no reserve, 5% increment, 24 hours from first bid and 15-minute extension. No bid has landed. The local site displays it after correcting the auction-house address casing; production needs that metadata fix merged and published.
- P1 PASSED 2026-08-31. D-13's earlier live Sepolia auction completed two bids, anti-sniping extension, settlement, winner delivery and seller proceeds; final escrow/index checks were empty and the Fly indexer matched the chain head.
- D-34 merged in PR #39 (`8d8c2b2`): explicit `positions()` and `market()` getters start empty/unlocked, may be changed, cleared or independently locked forever by admin, and have no authority over Shapes. `ShapeLens.positionOf` queries only the positions target with a 50,000-gas cap and converts external failure or malformed data to zero. The market is discovery-only and is never called.
- Release-fork corrections merged in PR #40. Exact release commit `dba4dbfe93df64cc72052c3eab70289070e301d9` passes 459 tests with 4 RPC-only skips in each Foundry profile, all 4 mainnet-fork rehearsal tests, 115 preview tests, all hosted CI and both deployment dry runs.
- Exact sizes are Shapes 24,474/24,453 bytes, ShapeLens 9,885/9,867 bytes, ShapeRenderer 23,138/23,137 bytes and PointerOps 605 bytes for default/testnet where applicable. The Shapes margin is only 102/123 bytes.
- Exact `dba4dbf` is live on Sepolia at Shapes `0x8172B86708c67D93ab6e666798B7073463371e13`, from block 11613113. The actual Shapes creation transaction is `0x6c162a8b0392e052108912a10b60eedcd7aed4d665032583f5f4724da5dc8d9`. Every receipt and independent wiring, role, reserve, ladder, Shape #0 and empty-pointer postflight passed.
- All eight newly deployed sources and all eleven deployed contracts/libraries are verified on Etherscan. PointerOps, Shapes and ShapeLens also have exact Sourcify creation/runtime matches. The retry required no redeploy, wallet signature or transaction.
- Fly deployment version 2 is live on isolated schema `shapes_sepolia_v2`, preserving the old schema. Health/ready are 200; status and GraphQL matched the RPC exactly at block 11613213 and report only backed Shape #0 with the correct owner.
- PR #41 merged as `b646ae5`; Netlify published that exact production commit. `https://shapes.ripe.wtf/deployment.json` serves the new deployment, and homepage, Play, Shape #0 and its OG image all return HTTP 200.
- Codex Security scan `af61993b-3d85-4142-984b-19343d4697ae` sealed against exact range `7f92f1b..5d1c37e`: three low findings, all outside core. The final packet fixes each with tested indexer timeout/resource bounds and passive embedded-only OG artwork. It also fixes the fetched-main deploy gate, RPC credential redaction, both-ladder fixture/parity CI, collision-free Medusa extraction, root-lock renderer triggers and an isolated indexer CI job.
- PR #8's hosted `changed paths`, contracts, renderer parity, indexer, site and Medusa jobs all pass. The contract job completed its deeper CI profile in 12m12s.
- D-32's GitHub issue #7 implementation merged through PR #36 as `1d6e4b0`. The behavior-only `_moduleSvg` extraction is byte-identical against unchanged TypeScript fixtures and the frozen Solidity oracle; normalized dispatch/helper complexity is 10/3 maximum; ShapeRenderer runtime is 23,138/23,137 bytes default/testnet, 47 bytes below baseline; and worst pinned gas growth is 0.0104%. `_glyph` remains unchanged as the documented lookup-table exception. Evidence: `project/experiments/EXP-004-renderer-module-refactor.md`.
- `audits/AUDIT_PROMPT_v5.md` is historical. `audits/AUDIT_PROMPT_v6.md` is the authoritative flat-fee brief, pinned to exact merged commit `1054db2455f7d6d3542a422130262bc872c34464`. The independent audit itself remains open.
- Issue #6 is deferred under D-33 to P4 and a real consumer. Do not add `decomposeInto`, a generic registry, more core pointers or application logic without separate product decisions.
- PR #20 merged as `f92d019`. The Sepolia indexer is live at `https://shapes-indexer.fly.dev` on one IAD Fly machine with embedded PGlite and encrypted 1 GB volume `vol_vz8xke1po70oz5qv`. Health, readiness, status and GraphQL readback passed; Shape #0 indexed with exact testnet backing and the checkpoint was one block behind Sepolia.
- PR #22 merged as `769efe0`; production serves `indexerUrl: https://shapes-indexer.fly.dev`. PR #23 (`99b79eb`) added the guarded D-13 path; PR #34 (`6bf5164`) made its close step resumable after the bidder exhausted Sepolia gas. Both PR #34 CI gates passed.

## Decisions and evidence

- D-07/D-36: keep ink constants unchanged for Sepolia. The exact seed-preserving retained-Dense heuristic reaches Solid 100 after 40,064 dust mints on average (95% CI 39,972–40,156), now 40.064 ETH under the flat mainnet fee, with 100.07 ETH mean peak retained backing. Direct 100 ETH visual rerolls cost only 0.001 ETH each, so this experiment measures provenance construction, not cheapest artwork selection.
- D-08: direct 10k actions are impossible on L1, but the hierarchical apex path is valid. Direct compose is 1.134B gas; direct split/decompose exceed 30M. The exact 3,333-call ladder tree reaches the apex, with a 985,862-gas worst individual rung. UI must not promise direct fan-in/fan-out or an unmeasured batch size. W-2 is rejected.
- D-09: adopt Medusa 1.5.1 in CI with a checksum-pinned binary; defer Halmos because its AST build exceeded the three-minute/~2.1 GB spike budget before symbolic execution.
- D-10: RESOLVED. The optional indexer path keeps Shapes authoritative. Freshness, chain, uniqueness and exact live count are checked; each page has an 8-second abort, 256 KiB body cap, 500-item cap, unique cursor and totalSupply-derived page/item ceiling. All displayed fields are current chain reads; every failure falls back to raw RPC. A 1,203-id fixture cuts reads from 1,218 to 18. The isolated install audits at zero, and the Fly/PGlite service passed live Sepolia activation.
- D-12/W-1/W-4/W-5/W-6/D-21: implemented. Browser and OG share independent RPC fallbacks; Black Shapes remain visible with invalid mutators hidden; provenance rollups no longer impersonate token #0; CI is path-filtered/cached and includes site/Medusa jobs; portless is adopted; direct unused x402 packages are removed.
- D-11: CLOSED. Rainbow does not support testnets, so the attempted Rainbow-to-Sepolia acceptance test was invalid and is removed as a gate. Keep the conventional RainbowKit `getDefaultConfig` integration and standard inventory; every namespace, storage, mainnet-bootstrap and switching workaround remains removed. The deterministic Sepolia config and transaction-initiation tests cover this packet. Rainbow is tested only when the eventual site targets mainnet.
- D-13: RESOLVED. Auction #0 moved from a 1-unit first bid to a 2-unit second bid; the end time moved from 1787980404 to 1787980416. Settlement `0x2855bd12ea9b27fb323cf1d69680f33a6de1aa49274806244211e0cacb19a893`, lot claim `0xc45fcca9e901eb3e7204b4095afad78520a0f3a514f38b93dcc7c1cbead5ea84`, and proceeds claim `0xe6749f28f05486193c43a2ab8cfe4eb522d0111a2e5df34a83ecc76ea7c6f4f0` succeeded. Winner owns Shape #1; seller owns Shapes #2/#3; house ETH, house Shapes, winner bid units and the active lot index are all zero/empty. The indexer reported the same owners at chain head 11608016.

## Deployment configuration

- Sepolia deployer/admin/artist and Shape #0 holder: `0xCB43078C32423F5348Cab5885911C3B5faE217F9` via Foundry account `ripe0x`.
- Sepolia future mint-fee recipient: `0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4`; it is code-free. The current deployment reads exactly 10000000000000 wei per Shape.
- Deploy only from fetched, clean, exact `main`. Never deploy from this branch. `script/deploy.sh sepolia` fetches `origin/main` immediately before enforcing branch/commit/cleanliness, then checks chain, ladder, payout, fee, complete wiring, Shape #0 state, unsigned artist state, receipts and Etherscan source visibility. Its portable summary records a credential-free public RPC, never the operational provider URL. `script/deploy.sh` is the one wrapper for anvil, Sepolia and mainnet alike, driven by `script/env/<name>.env`; the standalone Sepolia script and wrapper it replaces are removed (D-38).
- The Etherscan key supplied in chat is not persisted. Inject it only into the deployment process. The user enters the Foundry keystore password interactively; never write it to a file.
- The exact mined Shapes creation transaction is `0xeb47218282fe64db1124b8369c5f54056fb23391e14b1dd2decfb8079a4cfdec`. The release hash and artist signature remain empty until the separate one-time ceremony; never treat the creation transaction as signed before that ceremony succeeds.
- Older Sepolia deployments remain immutable historical systems. Never sign, relabel or adopt them as the current release.

## Remaining gates, in order

1. Send `audits/AUDIT_PROMPT_v6.md` to an independent auditor, close or explicitly accept every finding, and obtain explicit R25 product signoff.
2. Obtain D-15 qualified legal review and record the result.
3. Resolve D-05's mainnet admin, fee-recipient, Shape #0 custody, artist-signing and per-pointer lock/renounce decisions. No mainnet broadcast is authorized.

## Standing directives

- Never broadcast mainnet without explicit approval for each transaction.
- Commit as `ripe0x <109935398+ripe0x@users.noreply.github.com>`; verify before every push from a fresh clone.
- Never commit or push from `/Users/dd/CascadeProjects/shapes`; it has pre-rewrite history.
- `ripe0x/shapes-archive` stays private forever. Never push anything to or from it.
- Never infer approval to change fundamental functionality, contract semantics, public ABI or a PR's architecture. Surface the concern and obtain explicit user confirmation.
- D-05 mainnet admin/Shape #0 custody, fee recipient and lock/renounce timing remains a P2 user decision. Sepolia choices do not resolve it.
