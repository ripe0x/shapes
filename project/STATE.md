# State

Single source of truth for current project status. Status lines inside spec documents (SHAPES_V2_SPEC.md "pre-implementation", ZERO_AUCTION_DRAFT.md "no code written", README's "not deployed" table) are historical and superseded by this file.

Last updated: 2026-10-10 (P4 mainnet Packs website release complete; P3 Shapes mainnet launch complete).

## Current website change

Objective: release ShapePacks on `shapes.ripe.wtf/packs` using mainnet Shapes
`0x6fe9193276bf7abcbee44ab7afd717d637d6faf0`, ShapePacks
`0xf21514b090da7df4390803497d6ae673801e5ca7`, and renderer
`0xaf1c899baacc0fe8cfba0c6cf2624a018a393def`. The production build must be mainnet only.
The local Sepolia preview retains D-52's Sepolia contracts. The separate
`shapes-sepolia.netlify.app` environment still selects Sepolia, but its published commit
`e5039c1` predates Packs and `/packs` returns 404. Its subsequent builds were skipped by
Netlify as having no content change. D-53 authorizes mainnet publication; the earlier
Sepolia no-publication rule was not changed for that separate site.

Phase: P4 website release complete. PR #140 merged to `main` as
`28a4c23a4cd4305f4661cc81e9ce8bef00845f1a` on 2026-10-10.
The site selects Packs contracts from the Shapes chain, uses the matching public RPC fallback
and wallet chain, and guards the production
hostname against a Sepolia build. No additional Packs-specific Netlify variable is required.
The production Netlify site has `SHAPES_LADDER=mainnet`, `SHAPES_SITE_MODE=app`,
`NEXT_PUBLIC_SITE_URL=https://shapes.ripe.wtf`, the mainnet deployment record by default,
indexer URL/token, and a WalletConnect project ID in the relevant contexts. The separate
Sepolia site's production context selects `deployment.sepolia` and `SHAPES_LADDER=testnet`.
The configured mainnet indexer is `shapes-indexer-mainnet-b.fly.dev/graphql`; its health endpoint
answered 200 on 2026-10-10. The previous documented `shapes-indexer-mainnet.fly.dev` endpoint
also answered 200, but is not the current Netlify upstream.

At Ethereum block 26164549, read-only PublicNode calls found code at all three supplied
mainnet addresses, confirmed both Pack pointers, 0 minted packs, the 0.03 ETH creation floor,
9 denominations, 0.001 ETH Shapes mint fee, and a 12-card preview limit. `eth_call` succeeded
for exact-quote creation and approval, and rejected empty-source merging as specified. No
signed transaction was sent. Successful mainnet merge or exit simulation needs live packs.
The prior Sepolia deployment and merge UI passed read-only tests; its historical evidence and
product decisions remain in D-46 through D-52. Sepolia now has 6 minted packs, including 3
live packs held by the test account. Read-only `eth_call` passed open, redeem, unseal, and a
successful merge; its browser check exercised live merge preflight with signing blocked. The
mainnet local browser check passed with raw-RPC fallback because the private indexer token is
absent locally. Neither check sent a transaction.
Both Netlify PR previews passed read-only browser checks. Reown returns 403 for the temporary
mainnet deploy-preview hostname because it is not on the WalletConnect origin allowlist; the
production `shapes.ripe.wtf` hostname emitted no WalletConnect or allowlist errors in a separate
read-only browser check. Preview tests ignore only this known external response.
Focused preview tests, web/preview TypeScript checks, and changed-file lint passed. The single
mainnet Netlify production-profile build and production-build browser rehearsal passed on the
frozen candidate. Independent read-only review found no concrete defect; see
`project/reviews/packs-mainnet-fcccca3.md`. The live production indexer proxy returned chain 1
data through its configured server-side token on 2026-10-10.

PR #140 passed its site, browser end-to-end, renderer parity, and changed-path CI checks.
Netlify published production deploy `6acaac7567d508000818434f` from the merge commit on
2026-10-10. The live `https://shapes.ripe.wtf/packs` page passed the read-only mainnet
browser check, including contract reads, denomination images, desktop and mobile layout;
it reported no wallet-origin errors. The live indexer proxy returned HTTP 200. No on-chain
transaction was sent.
Mainnet still has 0 minted packs, so a successful mainnet merge or exit remains untested
until a user signs a real pack transaction.

On 2026-10-10, a user reported “Transaction creation failed” while creating a mainnet pack.
The public admin address `0xcb43078c32423f5348cab5885911c3b5fae217f9` held
0.016307083507946864 ETH at read time, below the smallest pack's exact 0.033 ETH payment
before gas. A read-only create simulation from that address reproduced the text and exposed
`OutOfFunds` in the nested RPC error; a funded account's simulation succeeded. This proves
the failure for that public address, not which wallet the user connected. PR #143 merged the
payment balance check, the `OutOfFunds` explanation, and canonical mainnet wallet metadata
as `c284c4f913cf382dc4c810214b14a78b98a9d8aa`. Focused tests, the mainnet production
build, read-only browser checks, independent review, and all required PR checks passed.
Netlify published deploy `6acb001b5b5dbd00089cf030` from that merge. On the live site, a
read-only browser using the underfunded admin address showed the exact balance shortfall
before any wallet send; the general Packs browser smoke test also passed. No transaction
was signed or sent.

Next gate: monitor the first user-signed mainnet pack lifecycle and verify its indexer record,
ownership, merge, and exit against transaction receipts. Preserve the unrelated untracked
`indexer/deployments.json` in the primary checkout.

## Phase

Current phase: P3 mainnet launch, COMPLETE. Mainnet deploy ran 2026-09-03 from clean `origin/main` commit `a0a180b`. Every P2 gate closed first: `AUDIT_REPORT_v8_claude.md` and `AUDIT_REPORT_v8_codex.md` (independent security review, `AUDIT_PROMPT_v8.md`), `AUDIT_REPORT_v9_claude.md` and `AUDIT_REPORT_v9_codex.md` (`AUDIT_PROMPT_v9.md`), the diff-focused review `project/reviews/diff-review-7f6ccb5-2bc389a.md`, and the fuzz/invariant/Slither campaign `project/reviews/fuzz-campaign-1c2cfd9.md`. Every finding across all four was fixed or accepted with rationale (D-43, D-44). D-05 recorded the mainnet ceremony values.

### Mainnet launch report (P3 evidence gate)

Deployed 2026-09-03 from `main` commit `a0a180b`. Addresses and library links are the current record in `deployments/1.json`:

- Shapes `0x6fe9193276bf7abcbee44ab7afd717d637d6faf0`
- ShapeRenderer `0xe9ac8d910767d8efc71bf4f2cb5d7ef4c4f69295`
- ShapeCollection `0x9d1bd0c348900d5c6bce28148f2adc68f73c8af3`
- ShapeAuctionHouse `0x90b79dbf4f301c239983ee37e6a466132e1532df`, registered as the `market` pointer
- Libraries: AdminOps `0xde64667e15ff3999f6fa0bcf9930c1653e361597`, ComposeCompute `0xfbf7f6e9552f93d2dbd86e30b3b0637be5d520ea`, CopyValidation `0xede9393cf5bd8037b9d4a15c2d864f97f98a9da7`, EIP712Signature `0x48208746f35222a751e5fe286a8942bfceaf0906`, GeometrySampling `0x991e1352b0f6131748f36d8d45f756d55ee930d3`, InkGenes `0x34a7a97b92288b3f804f416b3b15214fb85e4200`, RecompositionOps `0x94f63d2bcbcd6a3980bebbbe71de498e57f200f2`
- `mintFee` 1,000,000,000,000,000 wei (0.001 ETH per Shape), `feeRecipient` the 0xSplits wallet `0xD4ba7cA95f3983514DDa317C4428CDb8F59c7e72` (accepts plain ETH; proven by the deploy guard and `test/Fork.t.sol`)
- `mintStart` `1788462000` (2026-09-03, 15:00 ET)
- Owner token #0 listed in auction `0`
- Artist attestation recorded: `artistReleaseHash` `0xca51273fc507fd7c2ff85d5813660b59de876c714a866a5a229079a5e7ca24dc`
- `fromBlock` 25898721

The deployer signs through an EIP-7702 delegated account, so `script/deploy.sh` broadcasts mainnet with `--slow` (one pending transaction at a time; a delegated account's node rejects gapped nonces) and supports `RESUME_BROADCAST=1` to continue a broadcast that stops partway.

The site (`shapes.ripe.wtf`) and the mainnet indexer (`shapes-indexer-mainnet.fly.dev`) are cut over to this record; see Deployments and Components below.

P1 PASSED 2026-08-31 after the guarded two-signer Sepolia auction completed and independent receipt, state and indexer checks closed D-13. PR #46 merged D-35/D-36 as code-bearing mainnet candidate `1054db2455f7d6d3542a422130262bc872c34464`; exact clean `origin/main` commit `eb9e8834553f199a4c94e7ba307686c8bd0d64e8` deployed that runtime to Sepolia on 2026-09-02. D-33 still defers issue #6 to P4 until a real consumer exists.

D-37 (issue #56) replaces the #0-only ownership reading with an owner token that follows lineage through compose, decompose and split, adds `ownerToken()` and `OwnerTokenMoved`, and ends collection ownership permanently on redeem/burn. The prerequisite byte-recovery pass extracted `attestArtist`/`setMetadataCopy`/`setFeeRecipient`/`setMintFee` into one delegatecalled `AdminOps` library (twelve deployed sources instead of eleven) and lowered `optimizer_runs` to 20. Measured on the merged tree: Shapes 23,606/23,586 bytes default/testnet (970/990 bytes of EIP-170 margin), ShapeRenderer 23,437/23,436, ShapeLens 10,826/10,808, ShapeAuctionHouse unchanged at 7,939/7,930; `IShapes` is `0x86df37ba`. Default and testnet profiles each pass 508 tests with 4 expected fork skips. PR #58 merged D-37 into `main` as `c583c76`, which `AUDIT_PROMPT_v7.md` pins as its fixed target; independent audit of that commit remains open, and it is not yet deployed to Sepolia or mainnet.

D-38 (branch `claude/post-deploy-56`, pending merge) unifies deploy tooling for every environment: `script/Deploy.s.sol` replaces `script/DeployShapes.s.sol` and `script/DeploySepolia.s.sol`, and `script/deploy.sh <anvil|sepolia|mainnet>` replaces `script/deploy-sepolia.sh`, both driven by chain id and by `script/env/<name>.env` rather than separate per-environment scripts. Verified on that branch: 508/508 tests pass under both Foundry profiles, the 4 mainnet fork tests pass via a public RPC, the Anvil deploy plus `script/e2e-anvil.sh` pass end to end, a Sepolia `DRY_RUN=1` passes its guards and simulation, and a mainnet `DRY_RUN=1` correctly refuses on the still-empty `script/env/mainnet.env`. The Sepolia redeploy of the `c583c76` owner-token release has not happened yet; when it runs, it uses `script/deploy.sh sepolia`, not the removed standalone script.

D-39 (branch `claude/mint-start`, pending merge) adds an immutable constructor-set `mintStart`: `_mintBatch` reverts `MintNotOpen()` on `mint`, `mintTo`, `mintBatch`, `mintBatchTo` and the ETH-backed auction bids that mint through `mintBatchTo`, while `block.timestamp < mintStart`. The constructor mint of Shape #0 is unconditional, so its transfer, auction listing and redemption work before the start; no admin path can change `mintStart`. Mainnet's `script/env/mainnet.env` sets `MINT_START=1788796800` (2026-09-03 12:00 ET); Sepolia's `MINT_START` is left empty for a rehearsal override. `IShapes` is `0xa381713f`; Shapes runtime is 23,796/23,776 bytes default/testnet (780/800 bytes of EIP-170 margin); default and testnet profiles each pass 517 tests. The Sepolia deployment of 2026-09-02 at Shapes `0x7a84128ef0a09f8f7f72398e06c44d2f490b9b35` is superseded and unverified; the next Sepolia deploy carries both this gate and the contract-owner naming change.

Merged P2 candidate `1054db2`: D-35 gave token #0 the fixed metadata name `Shapes Collection Owner` and the `Collection Owner: true` attribute (superseded by D-37 and the contract-owner naming: `Shape N, Contract Owner` with a value-only `Contract Owner` attribute). D-36 replaces the immutable 1% fee with a flat 0.001 ETH per mainnet Shape and 0.00001 ETH per testnet Shape; auction ETH bids pay per card created. Default, testnet and deeper CI Foundry profiles each pass 462 tests with 4 expected fork skips, and all 4 fork tests pass against live Ethereum; Medusa passes 10/10 properties across 44,411 calls; the full Anvil lifecycle passes; all 128 preview tests and preview/web builds pass. Shapes is 24,362/24,341 bytes with 214/235 bytes of EIP-170 margin; ShapeLens is 9,885/9,867; ShapeRenderer is 23,331/23,330; ShapeAuctionHouse is 7,939/7,930. `IShapes` is `0x86cf5406`. The flat-fee release is merged, deployed to Sepolia and connected to the live indexer/site. Its cheaper direct high-tier artwork rerolls remain tracked as R25 and require explicit audit/mainnet signoff.

P0 GATE PASSED 2026-08-25. PR #1 merged as `5eec83d`; PR #2 merged as `7fca2b2`; corrective PR #3 merged as `bf5ae6b`; PR #4 merged as `c34aea3`; PR #5 merged as `7f92f1b`; P1 hardening PR #8 merged as `2f858ff`; merged-main correction PR #9 merged as `376bb7b`. The adopted architecture is backed Shape #0 as transferable collectible ownership, exposed through `owner()`, with a separate bounded `admin()`. Admin controls presentation/discovery and may redirect future mint fees, but cannot change the fee amount or touch backing, redemption, accrued funds or token ownership. During PR #2 review the Director replaced `owner()` with `titleHolder()` without explicit user approval; PR #3 fully reverted that substitution before deployment. The fresh Sepolia deployment, readback and direct artist attestation are complete.

PR #2's unrelated fixes remain accepted. D-27 permits admin redirection of only future mint fees; D-36 supersedes its percentage amount with immutable flat `mintFee`. D-28's immutable attribution remains powerless. On the local candidate, `IAdminControl` is `0xe135adbe`, `IShapes` is `0x86cf5406`, and `IShapeValue` remains `0xd07d718a`. D-25/R18 remain invalidated because no mainnet deployment or legacy consumer exposes this pre-mainnet ABI.

Historical note — STOP CONDITION LIFTED (2026-08-25, same day raised): the landed audit's base commit 4e6b3d8 (2026-08-19) is 43 commits behind main; main already closed the findings (a0ff0af both Highs + 3 Lows, da1fa53 L-1, dabf2ad L-3, e20a1b3 M-2/L-2/L-4/I-6, 383be38 H-2 doc correction, 2167dc7, d2f2e59). Verified in current source: settlement is pull-based via claimLot (lot revert blocks only its own delivery), bid() has SellerCannotBid. The initial triage misread the audit checkout as current main. Residue tracked in D-02: M-1 gas asymmetry feeds D-08; PoC suite worth porting to main as regression tests.

## Deployments

- Mainnet: live. Deployed 2026-09-03 from `main` commit `a0a180b`; full addresses and library links are recorded in `deployments/1.json` and repeated in the launch report above. `fromBlock` 25898721.
- Mainnet indexer: `https://shapes-indexer-mainnet.fly.dev`, Fly app `shapes-indexer-mainnet`, schema `shapes_mainnet_v3`. The Fly machine is running and passing its `/health` check.
- D-36 deployment status: complete on Sepolia. The live contract reads `mintFee = 10000000000000` wei (0.00001 ETH) per testnet Shape, and the production app constructs transactions from that onchain value.
- Sepolia (current): Shapes `0x6c2f9c00f44fbbf141dd166979903004b80d5f99`, renderer `0x7025fc7e13ca24505d471e193e2e2a54e960a1b2`, collection `0x9f08626a5ae483b498ea81800f395222639334e7`, auctionHouse `0xf3f72672330f827549e57f71520b9de145c86435` (registered as `market`), RecompositionOps `0x8802c64b7b6ccd660f6a5a69413b6ba7751f1da1`, AdminOps `0xbe5755dd6be5a4d41d62c28d53e987ae2467044e`, from block 11628203, mint fee 10000000000000 wei, `mintStart` `1788458965`, deployed from commit `b337028` on branch `claude/contracts-page`. Owner token 0 in auction `0`; artist attested. Record: `deployments/11155111.json`. The Fly indexer for this deployment is stopped (state `stopped` on `fly status -a shapes-indexer`); the Sepolia site runs on its raw-RPC fallback with no indexer.
- Sepolia (superseded, 2026-09-03, D-40 architecture release): deployed from branch `claude/architecture` through `script/deploy.sh sepolia` with `ALLOW_BRANCH_DEPLOY=1` and `MINT_START_DELAY=120`; `mintStart()` reads `1788431012`. Shapes `0x5e742dc6c91b7090de9642ca54d68a1422d1fb24`, renderer `0xbc80c7027d8dfdfc22b2af35b0d220cb259088aa`, collection `0xd96d64ebabaa0e946867b26e88882eeaefb3fe38`, auctionHouse `0x2564ed7269db94b42066069efbfcac8517210769` (registered as the `market` pointer), RecompositionOps `0x352394b1caf0cde75d4d0e53d8d6658e50f8679b`, AdminOps `0x074024c645e933e607dccdfd78af813ed96e1377`, from block 11625974, mint fee 10000000000000 wei; owner token 0 held by the deployer. Etherscan and Sourcify exact matches. Listing of #0 and the artist attestation run through `RESUME=1 LIST_OWNER_TOKEN=1 ATTEST_ARTIST=1`. Indexer schema `shapes_sepolia_v5`. Earlier deployments (`0x8542...3bf5` from main on 2026-09-03, `0xd4e7...21b8`, `0x7a84...9b35`, `0xb142...6152`) are also superseded.
- Sepolia: exact clean source `eb9e8834553f199a4c94e7ba307686c8bd0d64e8`, carrying code-bearing candidate `1054db2455f7d6d3542a422130262bc872c34464`, is live at 1/100 TESTNET SCALE from block 11616988. Shapes `0xb142c4b09c24d639d8c154c93a539cbc09566152`, renderer `0xd9c3278d1277cef31b54e98a43db4243ada05610`, collection `0x8c5203d5cd480f7e0b266a2f6d27f0ed9919e8e1`, lens `0x259e90f875b7b975c09f05e5972f359ee0a3fa84`, auctionHouse `0x351b7c9637c6abc1982be95f87961aff2f38647a`. Actual Shapes creation transaction: `0xeb47218282fe64db1124b8369c5f54056fb23391e14b1dd2decfb8079a4cfdec`. All five creation receipts succeeded, and all eleven contracts/libraries are Etherscan-verified. Admin, artist, owner and Shape #0 holder are `0xCB43078C32423F5348Cab5885911C3B5faE217F9`; future mint fees route to code-free `0x41c3BD8A36f8fE9Bb77900ca02400b32BB35A6A4`. Shape #0 retains exactly 100,000,000,000,000 wei backing, total contract ETH matches redeemable backing, positions/market are zero and unlocked, and auction count is zero. The artist release hash/signature intentionally remain empty until a separately approved irreversible ceremony.
- Sepolia indexer: `https://shapes-indexer.fly.dev`, Fly app `shapes-indexer`, schema `shapes_sepolia_v8` (`indexer/fly.sepolia.toml`). The Fly machine's state is `stopped`. The Sepolia site falls back to raw RPC and shows no indexer-backed history while it is down.
- Sites: `shapes.ripe.wtf` and `shapes-sepolia.netlify.app` are two isolated Netlify projects, both building `web/` from `main` in `app` mode (`netlify.toml`, `web/README.md`). `shapes.ripe.wtf` reads the bundled `public/deployment.json` (mainnet ladder) and is live with the mint panel, gallery, auction and manage routes at their normal paths. `shapes-sepolia.netlify.app` sets `NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia` and `SHAPES_LADDER=testnet` and reads `deployments/11155111.json`. The `launch` branch and `landing` site mode that served the pre-mainnet countdown are retired from production; `landing` remains a build mode.

### Historical Sepolia evidence

The snapshots below remain for provenance only. Any use of “current” in them refers to the superseded deployment recorded at that time, not the release above.
- Sepolia: exact release `dba4dbfe93df64cc72052c3eab70289070e301d9` is live at 1/100 TESTNET SCALE. Shapes `0x8172B86708c67D93ab6e666798B7073463371e13`, renderer `0x327A40949922E35F622cf18131AcD03973F0C8D0`, collection `0xBFD7C6AF44D0b7A37d38a53276eF98F5d816fdc0`, lens `0x28FdBd01b0292EDdF7A9b12B378DFBE3a7b4dfa5`, auctionHouse `0x38445aced30590910e087672FEEa269284F03379`, feeBps 100, fromBlock 11613113. Actual Shapes creation transaction: `0x6c162a8b0392e052108912a10b60eedcd7aed4d665032583f5f4724da5dc8d9`. All receipts succeeded. Admin, artist and owner are `0xCB43078C32423F5348Cab5885911C3B5faE217F9`; Shape #0 began there and is now escrowed in the auction house. Future mint fees route to code-free `0x41c3BD8A36f8E9Bb77900ca02400b32BB35A6A4`. Shape #0 retains exactly 100,000,000,000,000 wei backing in Shapes, and positions/market are both zero and unlocked. All eight newly deployed sources and all eleven deployed contracts/libraries are verified on Etherscan; PointerOps, Shapes and ShapeLens also have exact Sourcify creation/runtime matches. The artist release hash/signature intentionally remain empty until the separate irreversible ceremony.
- Sepolia indexer: `https://shapes-indexer.fly.dev`, Fly app `shapes-indexer` in IAD. One shared-CPU machine uses encrypted 1 GB volume `vol_vz8xke1po70oz5qv` with embedded PGlite at `/data/pglite`; snapshots retain five days. Deployment version 2 uses isolated schema `shapes_sepolia_v2`, preserving the old indexed history. After the launch listing, `/status` reached block 11615531 and GraphQL reported Shape #0 owned by the current auction house with unchanged 100,000,000,000,000 wei backing. PublicNode is the working RPC fallback when Tenderly's free endpoint rate-limits.
- Sepolia site: PR #41 merged as `b646ae5` and Netlify published that exact production commit. Its auction-house address has invalid mixed-case checksum casing, so Viem rejects the auction read and the hosted auction page remains empty until the local metadata correction is merged and published. The corrected local site reads the active auction successfully.
- Current Sepolia launch auction #0: Shape #0 was approved in transaction `0xafd08c0864d94aa210f0c3f0a30b8da0ba1be5d94ee61882edafe7aa414feb74` and listed in transaction `0xd86702d4845a1233ae7420a94e3764d237a27e2d4a536eaa1d2bb9948a133cfb` at block 11615519. The house now owns the lot. It has no reserve, a 5% minimum increment, a 24-hour clock starting with the first bid and a 15-minute extension window. No bid has landed, so `endTime` remains zero; `settled` and `lotClaimed` are false.
- Historical P1 rehearsal auction #0 on the superseded house `0x603C745cBFCC76ad47E1eCf6b875abC995959801`: D-13 lifecycle complete. Creation `0x8e170cab9516dfeba723f5149139e21c8b803f3ab0c665083d31c83b9888bdf9`; bids `0x8dfbd9f31ac94450b52797aeeae00f374cec1b5f6cfb34a398ee7d4464374c07` and `0x6c0a433e3c4a0d00971a52d797d20a1399a7f43399e34455f4618fbc5efda657`; settlement `0x2855bd12ea9b27fb323cf1d69680f33a6de1aa49274806244211e0cacb19a893`, lot claim `0xc45fcca9e901eb3e7204b4095afad78520a0f3a514f38b93dcc7c1cbead5ea84`, and proceeds claim `0xe6749f28f05486193c43a2ab8cfe4eb522d0111a2e5df34a83ecc76ea7c6f4f0` all succeeded.
- Sepolia rehearsal: Shapes `0xc840be03f6824165954213136927828b10b1a1a1`, actual creation transaction `0x0529271c4cc71449429a094d6b2fcb2225ee926360d86712b0c96901d4bf8330`. It uses the superseded D-26 child architecture, was never adopted into deployment metadata, and must not be signed or used as the P1 deployment.
- D-28 deploy preflight and broadcast: the exact-main non-broadcast simulation passed, then the same deterministic addresses were broadcast successfully. Independent postflight resolved the Shapes transaction by receipt contract address, confirmed status `0x1`, the complete wiring, nine-denomination testnet ladder, 1% fee, code-free payout, deployer roles, backed/live Shape #0, empty resolver and zero auctions. Foundry initially reported 5/6 verification because `EIP712Signature` lagged; a verification-only retry succeeded, and Etherscan now exposes source for all ten deployments.
- Ladder selection: current main defaults to the mainnet ladder and selects the 100x-smaller ladder only with `FOUNDRY_PROFILE=testnet`; the TS side uses the paired `SHAPES_LADDER=testnet` build setting and ladder-specific fixtures. Deploy scripts assert the expected compiled ladder before broadcast. D-01 and R1 are closed. The older immutable Sepolia deployments remain historical and are not relabeled.

## Components

- Contracts (`src/`): D-40 architecture. Shapes (sole ETH custodian, every protocol action, view and preview) + ShapeRenderer + ShapeCollection + ShapeAuctionHouse/ShapeCardEscrow, with shared types in ShapeTypes.sol. Seven externally linked libraries (RecompositionOps, AdminOps, ComposeCompute, CopyValidation, EIP712Signature, GeometrySampling, InkGenes). RecompositionOps holds the compose/decompose/split state machine and the previews over one ShapeStore pointer; AdminOps holds every configuration write. Neither writes ERC-721 state, moves ETH, or touches the owner token or the admin address; each linked address is immutable. No proxy, no factory. See project/ARCHITECTURE.md. Vendored OpenZeppelin is not a submodule, so upstream patches do not auto-propagate.
- Tests: current source passes 669 contract tests under each default and testnet profile, 0 failed, 5 RPC-only fork skips (674 total), plus 258 preview tests (`npm --prefix preview test`). Default/testnet runtime (`forge build --sizes`): Shapes 22,460/22,443 (2,116/2,133 bytes of EIP-170 margin), RecompositionOps 12,146/12,128, AdminOps 3,119/3,118, ShapeRenderer 23,256/23,255, ShapeAuctionHouse 8,015/8,006, ShapeCollection 6,753/6,746. Coverage recipe (`--ir-minimum`, required because coverage builds without the optimizer; the standard `--skip`/`--no-match-test` set for legacy renderer, diff-oracle and gas-ceiling tests) is documented in README.md under "Running the tests". No `additional_compiler_profiles` recipe exists in `foundry.toml` or repo history; the `--ir-minimum` recipe is the current one.
- Site (`web/`): Next.js on Netlify, two isolated projects both building `main` in `app` mode. `shapes.ripe.wtf` reads the bundled mainnet `public/deployment.json` (the app home with the mint panel at `/`, gallery, auction, manage, contracts). `shapes-sepolia.netlify.app` sets `NEXT_PUBLIC_SHAPES_DEPLOYMENT=deployment.sepolia` and `SHAPES_LADDER=testnet` to read `public/deployment.sepolia.json` instead. The pre-mainnet `launch` branch and `landing` site mode (countdown at `/`, playground at `/play`, app routes blocked) are retired from production; `landing` remains a build mode. Unset `SHAPES_SITE_MODE` means `app`. The site imports all UI/chain logic from `preview/src` via `@shared`. Browser and OG clients share optional-primary plus independent public RPC fallbacks; the server OG route accepts only bounded, passive embedded SVG from token metadata. Data comes from the indexer first (token state, history, bids, provenance); chain reads are for header totals, the connected wallet's own recent actions, and stale rows; the History section hides when the indexer is unavailable. Names resolve through `@1001-digital/ethereum-names` (ENS, GNS, WNS), cached.
- Preview (`preview/`): canonical TS renderer + parity/fixture/sweep/simulation tooling. `preview/scripts/inkTuning.ts` exists (ink-gene tuning harness).
- Indexer (`indexer/`): Ponder 0.17.8, self-contained, builds token + lineage-edge state including compose depth and recipient-correct split/decompose ownership. The optional site boundary accepts only matching-chain checkpoints no more than two blocks behind, aborts each page after 8 seconds, caps each body at 256 KiB, and bounds pages/items/cursors against current `totalSupply`; every violation falls back to raw RPC. Tested transitive overrides bring the isolated install to zero npm advisories. PR #20 deploys the Sepolia service to Fly as one machine with embedded PGlite on an encrypted 1 GB volume, matching the proven architecture used by the user's recent projects and avoiding a separate database service. One Fly app per chain shares one deploy path: `indexer/fly.sepolia.toml` (app `shapes-indexer`, schema `shapes_sepolia_v8`, machine state `stopped`) and `indexer/fly.mainnet.toml` (app `shapes-indexer-mainnet`, schema `shapes_mainnet_v3`, deployed and running with `activity` and `escrowed_card` tables added), driven by `indexer/deploy.sh <env>` and `indexer/bootstrap.sh <env>`. Bump `DATABASE_SCHEMA` in the toml on a schema or contract change rather than reusing one for a different address.
- Docs: canonical status and operating docs live in `project/`; the D-06 truth pass updated the root status lines, ladder, repo map, deployment table, and `web/README.md`.

## Stabilization record

- RESOLVED 2026-08-25: Surface port committed to branch preserve/surface-port (commit ce4c7e4, 6 files), then deliberately rejected under D-04 and the preservation branch deleted with user approval. R2 closed.
- RESOLVED 2026-08-25: audit artifacts committed to branch claude/shapes-security-audit-fa49c8 (commit 6480f1c); triaged in D-02. Two Highs confirmed (H-1 must-fix, H-2 reconcile).
- RESOLVED 2026-08-25: gasmeasure test committed to branch preserve/split-gas-measure (commit 95cdc28).
- RESOLVED 2026-08-25: renderer WIP preserved on preserve/renderer-wip (074fc30); superseded vs novel triage in D-03; novel bits queued as W-1/W-2. The superseded stray indexer draft was deleted during hygiene.
- Hygiene pass COMPLETE 2026-08-25: worktrees down to main checkout + director worktree + 3 codex worktrees (left alone); ~45 local branches down to 10, all with a reason (main, director, 2 preserve/*, audit record, codex checked-out, and 4 UNIQUE: contract-title, docs-truth-and-size-gate, jovial-goodall, portless-local-setup — queued as D-23/W-4/W-5/W-6); _to_delete/ and stray indexer/ draft deleted by user (classifier blocks bulk deletion for the agent). Triage evidence: 17 branches proven superseded via empty diffs against landed squash merges.
- R15 RESOLVED via go-public cutover and W-4: repo public at github.com/ripe0x/shapes; CI now has cancellation, path filters, Foundry caches, explicit site validation and Medusa reserve lifecycle coverage.
- D-01 RESOLVED on main by `ef228f0` + `1020730`: the mainnet ladder is the default build, the testnet ladder is selected by an isolated Foundry profile, parity fixtures are ladder-specific, and deploy scripts assert the compiled ladder before broadcast.
- D-06 doc truth pass landed (8c30e51): README deployment table and repo map current, spec status lines point here, ladder corrected in WEBSITE_DESIGN_PROMPT.md, web/README rewritten.
- The old checkout's trivial `.gitignore` stash remains low risk and is not part of the canonical clone.

## Known unknowns

- Root frontend dependencies retain 9 moderate and 0 high/critical npm advisories after Vite and scoped transitive overrides. The maintained standard inventory now selects MetaMask, so the residual connector dependency risk is explicit; npm's supported fix requires a Wagmi 3 migration. The isolated indexer audits at zero (R21).
- `ShapeAuctionHouse.createAuction` `minIncrementBps` has no explicit bound beyond uint16 (D-17).
