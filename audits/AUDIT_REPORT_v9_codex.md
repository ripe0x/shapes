# Shapes architecture release audit (Codex, v9)

**Target:** repository `ripe0x/shapes`, detached at commit `34d2c3b`, branch target `claude/contracts-page`.

**Bottom line:** I found no Critical, High, or Medium issue affecting reserve solvency, redemption, token ownership, mint authorization, or auction custody; two Low presentation/fee-operability findings remain.

## Scope and evidence

The audit followed `project/ARCHITECTURE.md`, then the requested source order. The working tree was checked out to `34d2c3b` before source review. `src/` was not changed. The retained attack attempts are under `test/audit/`.

| Check | Result |
|---|---|
| `forge build --sizes` | Pass. `Shapes` runtime is 22,460 bytes, with 2,116 bytes of EIP-170 margin. |
| Foundry default and `testnet` profiles | 669 passed, 0 failed, 4 skipped without a fork RPC, in each profile. |
| Mainnet fork | 4/4 `Fork` tests passed against `https://ethereum-rpc.publicnode.com`. |
| Medusa | 14 assertion/property tests passed, including all three `MedusaReserveHarness` properties. |
| Anvil deploy and lifecycle | Contract lifecycle passed. The first indexer run could not bind the requested local port 42069 because it was already occupied; rerunning on free port 42070 passed the indexer checks and completed. |

The build also prints a Solar diagnostic at `src/Shapes.sol:1203`; the standard Solc build succeeds, and the diagnostic did not reproduce as a runtime or test failure.

## Findings table

| ID | Severity | Title | path:line | One-line impact |
|---|---|---|---|---|
| SHAPES-01 | Low | Presentation lock trusts hostile renderer and collection behavior | `src/lib/AdminOps.sol:79`, `src/lib/AdminOps.sol:90`, `src/lib/AdminOps.sol:125` | Admin can permanently lock a renderer that makes metadata views revert, or a bound collection whose metadata copy remains mutable after the lock. |
| SHAPES-02 | Low | Fees owed to a non-payable recipient can be permanently stranded | `src/Shapes.sol:443`, `src/Shapes.sol:471`, `src/lib/AdminOps.sol:143` | A fee recipient that cannot accept ETH accumulates an owed balance that has no recovery destination and can never be withdrawn. |

No exploit was found that drains reserve ETH, redeems a token twice, creates unbacked value, bypasses `mintStart`, transfers the owner token into permanent protocol custody, or grants the auction house Shapes authority.

## SHAPES-01: Presentation lock trusts hostile renderer and collection behavior

**Description.** `setRenderer` accepts any contract with code that reports both `IShapeRenderer` and `IShapeGeometry` through ERC-165, and `setCollection` accepts any contract with code that reports `IShapeCollection` and returns the current Shapes address from `shapes()` (`src/lib/AdminOps.sol:79`, `src/lib/AdminOps.sol:90`, `src/lib/AdminOps.sol:101`, `src/lib/AdminOps.sol:112`). `lockPresentation` checks only that a collection is set, then permanently sets the lock (`src/lib/AdminOps.sol:125`). It does not call representative renderer or collection methods before making the pointers immutable.

After locking, `tokenURI`, `svg`, `geometryOf`, `moduleAt`, and related views continue to dispatch to the frozen renderer (`src/Shapes.sol:988`, `src/Shapes.sol:1034`, `src/Shapes.sol:1056`, `src/Shapes.sol:1143`). A renderer can therefore pass installation checks and then revert or return pathological output forever. A foreign collection can also claim the correct Shapes address while omitting the canonical collection's live lock check. The canonical `ShapeCollection` does check the live admin and `presentationLocked()` before writing its copy (`src/ShapeCollection.sol:116`, `src/ShapeCollection.sol:121`), but the interface gate does not require a collection to implement that behavior.

**Exact reproduction.** The retained tests are:

`test/audit/V9FeesAndPresentation.t.sol:V9FeesAndPresentationTest.test_Attempt10_HostileRendererCanBeInstalledAndLocked`, `test/audit/V9FeesAndPresentation.t.sol:V9FeesAndPresentationTest.test_Attempt10_LockDoesNotFreezeCopyInsideAForeignCollection`, `test/audit/V9FeesAndPresentation.t.sol:V9FeesAndPresentationTest.test_Attempt10_CollectionMustNameThisToken`, `test/audit/PresentationLockOrdering.t.sol:PresentationLockOrderingTest.test_RevertingRendererBricksMetadataOnlyAndIsPermanentOnceLocked`, and `test/audit/PresentationLockOrdering.t.sol:PresentationLockOrderingTest.test_LockFreezesBothPointersAndTheCopy`.

The first test installs an ERC-165-compliant renderer whose real calls revert, locks it, and confirms the presentation calls remain broken while redemption still returns exact backing. The second installs an ERC-165-compliant collection bound to this Shapes instance, locks presentation, edits its own copy after the lock, and confirms the token metadata changes. The matching-address test confirms a collection bound to another Shapes instance is rejected.

**Impact.** This is a permanent denial of the presentation surface or a violation of the claimed metadata freeze. It does not change backing, redemption, accounting, or token ownership. The required admin action is the trigger, so severity is Low.

**Recommended fix.** At lock time, exercise representative renderer and collection reads and revert if they fail or return unacceptable data. If the metadata-copy freeze is intended to be a protocol guarantee rather than a trust assumption, restrict the collection to the canonical implementation or require a verifiable lock-aware behavior; ERC-165 and `shapes()` alone are insufficient.

**Compatibility.** A behavioral change at `lockPresentation`; a canonical-implementation restriction could change accepted deployments. No ABI or storage-layout change is required for validation-only checks. A new collection capability or recovery mechanism would change ABI, but is not necessary for the minimal fix.

**Status (owner, 2026-09-03):** accepted. Same residual as S-3 and V9-1: admin trust before locking. A lock-time probe cannot make the freeze a guarantee because a target can pass the probe and misbehave later.

## SHAPES-02: Fees owed to a non-payable recipient can be permanently stranded

**Description.** Minting credits the configured recipient's mapping entry and the global running total (`src/Shapes.sol:438`, `src/Shapes.sol:443`). `withdrawFees(recipient)` reads and zeroes only that recipient's balance, then sends ETH to the same address (`src/Shapes.sol:471`, `src/Shapes.sol:472`, `src/Shapes.sol:475`, `src/Shapes.sol:477`). A failed send reverts the entire transaction through `_sendEth` (`src/Shapes.sol:587`, `src/Shapes.sol:590`). `setFeeRecipient` only redirects future accrual and deliberately leaves the prior mapping entry untouched (`src/lib/AdminOps.sol:138`, `src/lib/AdminOps.sol:143`).

Consequently, if the admin selects a non-payable contract, or a previously payable recipient later becomes unable to receive ETH, its accrued balance remains counted in `pendingFees()` but no call can successfully deliver it. The deployment script explicitly warns that a reverting contract recipient permanently strands its own accrued fees (`script/Deploy.s.sol:133`, `script/Deploy.s.sol:134`).

**Exact reproduction.** The retained tests are:

`test/audit/FeeAccounting.t.sol:FeeAccountingTest.test_RevertingRecipientBlocksOnlyItsOwnWithdrawal`, `test/audit/FeeAccounting.t.sol:FeeAccountingTest.test_RecipientWithoutAPayableReceiveBlocksOnlyItself`, `test/audit/FeeAccounting.t.sol:FeeAccountingTest.test_WithdrawFeesIsPermissionlessButNotSelfDirected`, and `test/audit/FeeAccounting.t.sol:FeeAccountingTest.test_EachRecipientWithdrawsExactlyItsOwnShare`.

`test/audit/V9FeesAndPresentation.t.sol:V9FeesAndPresentationTest.test_Attempt5_PerRecipientFeesSumToPendingFees`, `test/audit/V9FeesAndPresentation.t.sol:V9FeesAndPresentationTest.test_Attempt5_ARevertingRecipientBlocksOnlyItself`, and `test/audit/V9FeesAndPresentation.t.sol:V9FeesAndPresentationTest.test_Finding_ARevertingRecipientsBalanceIsPermanentlyStranded` document the full sequence: accrue to the reverting address, repoint future fees, show the old balance remains, and show repeated withdrawal attempts revert while another recipient remains withdrawable.

**Impact.** The affected recipient permanently loses access to its accrued fee ETH. Other recipients, minting, and the reserve invariant remain operational. This is a configuration-dependent loss of protocol fee funds, not user backing, so severity is Low.

**Recommended fix.** Add a recipient-authorized destination override, for example a function that permits `msg.sender == recipient` to withdraw that recipient's balance to a supplied payable address. Keep the existing self-directed function for compatibility and retain effects-before-interactions. Alternatively, document permanent stranding as an intentional consequence of recipient configuration.

**Compatibility.** The recovery function adds ABI and changes behavior by adding a recovery path. It requires no storage-layout change. A documentation-only decision changes neither ABI nor storage nor runtime behavior.

**Status (owner, 2026-09-03):** accepted as is (D-44). The deploy path proves the recipient accepts plain ETH by simulation instead of requiring an EOA; the mainnet recipient is the 0xSplits wallet `0xD4ba7cA95f3983514DDa317C4428CDb8F59c7e72`, verified by `test/Fork.t.sol` on a mainnet fork.

## Properties verified

Evidence combines the retained audit tests, existing Foundry tests and invariants, fork execution, Medusa, Anvil lifecycle traces, and direct source reasoning. A passing test is treated as evidence of the exercised case, not as a proof of all possible calldata.

### Reserve and ETH

**Reserve solvency.** Verified by Medusa `property_reserve_equals_redeemable_backing`, `property_reserve_is_solvent`, `property_owner_token_tracks_its_holder`, `test/audit/ForcedEth.t.sol:ForcedEthTest.test_SelfdestructedEthIsCountedNowhereAndIsUnwithdrawable`, and the reserve invariants. Mint credits backing and fees separately at `src/Shapes.sol:434` through `src/Shapes.sol:445`; forced ETH is surplus because direct deposits revert at `src/Shapes.sol:1215` through `src/Shapes.sol:1224`. Caveat: the invariant is necessarily sampled over reachable sequences.

**Redemption ordering and reentrancy.** Verified by `ShapesTest.test_FailedPayoutRevertsEntireRedemption`, `ShapesTest.test_ReentrantRedeemIsBlocked`, `ShapesTest.test_ReentrantRedeemBatchIsBlocked`, and receiver attack tests. Token state is deleted and burned before the ETH call at `src/Shapes.sol:582` through `src/Shapes.sol:590`; redeemable backing is decremented before the send at `src/Shapes.sol:523` through `src/Shapes.sol:531`.

**`burnBacking`.** Verified by `ForcedEthTest.test_BurnBackingIgnoresTheSurplus`, the black-shape tests, and source review. It marks Black and moves exactly the apex amount from redeemable to cumulative burned accounting before sending to the fixed address at `src/Shapes.sol:794` through `src/Shapes.sol:813`; Black redemption is rejected at `src/Shapes.sol:569` through `src/Shapes.sol:574`.

**Per-recipient fee accounting.** Verified by every test in `test/audit/FeeAccounting.t.sol`, especially `test_FeesAndReserveAreDisjointAcrossEveryPath`, `test_SetFeeRecipientCannotRedirectAlreadyAccruedFees`, `test_EachRecipientWithdrawsExactlyItsOwnShare`, and `test_RevertingRecipientBlocksOnlyItsOwnWithdrawal`. The mapping and running total are updated together at `src/Shapes.sol:442` through `src/Shapes.sol:445`; withdrawal zeroes only the selected entry at `src/Shapes.sol:471` through `src/Shapes.sol:477`. The permanent-stranding operability issue is SHAPES-02.

**Recomposition backing conservation.** Verified by `ExploitAttemptsTest.test_ReshapeMarathonNeverReturnsMoreThanDeposited`, recomposition invariants, `V9RecordsAndAuctionTest.test_Attempt4_MaximalBatchesRoundTrip`, and source review. Compose does not adjust ETH accounting, and split keeps the parent backing represented by children (`src/Shapes.sol:596` through `src/Shapes.sol:599`, `src/lib/RecompositionOps.sol:320` through `src/lib/RecompositionOps.sol:356`).

### Recomposition

**Compose burns inputs, keeps the survivor, and records undo state.** Verified by the compose tests, `DecomposeTest.test_RoundTripRestoresOriginalIdsSeedsAndState`, and `V9RecordsAndAuctionTest.test_Attempt4_MaximalBatchesRoundTrip`. Ownership/liveness gates precede burns at `src/Shapes.sol:641` through `src/Shapes.sol:660`; snapshots and survivor writes are in `src/lib/RecompositionOps.sol:137` through `src/lib/RecompositionOps.sol:205`.

**Decompose restores ids and unwinds LIFO.** Verified by `DecomposeTest.test_StackedComposesUnwindNewestFirst`, `DecomposeTest.test_NestedDecomposeUnwindsBottomUp`, `DecomposeTest.test_ReusedIdsDoNotCollideWithFreshMints`, `V9InvariantReplayTest.test_Replay_StaysCleanAfterTheHandlerFix`, and the maximal-batch audit tests. The top record is selected, inputs are restored, then the record is popped at `src/lib/RecompositionOps.sol:225` through `src/lib/RecompositionOps.sol:261`.

**Split sums denominations and preserves provenance.** Verified by the split, provenance, heterogeneous, and crafted-record tests, including `ProvenanceTest.test_SplitOriginOfReconstructionMatchesStoredChildModules` and `V9RecordsAndAuctionTest.test_Attempt4_SplitProvenanceSurvivesRecomposition`. The sum is checked before child allocation and each child receives a reference at `src/lib/RecompositionOps.sol:320` through `src/lib/RecompositionOps.sol:356`.

**Owner token uniqueness and callback ordering.** Verified by `ReceiverReentrancyDecomposeSplitTest.test_DecomposeToCallbackCannotReenterOrDesyncOwnerToken`, `ReceiverReentrancyDecomposeSplitTest.test_SplitToCallbackCannotReenterOrDesyncOwnerToken`, `V9RecordsAndAuctionTest.test_Attempt9_OwnerTokenAsTheLot`, and Medusa's owner-token property. Decompose safe-mints every restored id before moving the pointer at `src/Shapes.sol:773` through `src/Shapes.sol:785`; split sets the future first child before the child safe-mint loop at `src/Shapes.sol:694` through `src/Shapes.sol:708`. The guard is reentrancy, and the whole transaction reverts on a callback failure.

**Previews.** Verified by `ComposabilityTest.test_PreviewsAnswerWithoutTheOwnershipGate`, `ComposabilityTest.test_PreviewComposeRejectsWhatComposeRejects`, `ComposabilityTest.test_PreviewSplitRejectsWhatSplitRejects`, `SamplingTest.test_PreviewComposeModulesMatchExecution`, and `HeterogeneousTest.test_PreviewSplitMatchesGrammarBranchOnRecordlessParentAndRecordBranchOnStackedRecord`. The previews intentionally omit ownership, while sharing liveness, duplicate, denomination, allocation, and sampling rules at `src/lib/RecompositionOps.sol:444` through `src/lib/RecompositionOps.sol:502` and `src/lib/RecompositionOps.sol:510` through `src/lib/RecompositionOps.sol:545`. A preview can therefore succeed for a token held by another account, as specified, but the corresponding mutation still fails its caller ownership gate.

**Narrowing casts.** `originCount` and child indexes are bounded by denomination capacity and the exhaustion assertion in `src/lib/ShapeMath.sol:59` through `src/lib/ShapeMath.sol:76`; split output count is at most 10,000 units because each output is at least one unit (`src/lib/RecompositionOps.sol:320` through `src/lib/RecompositionOps.sol:323`). `uint96` token ids and `uint64` split-record indexes rely on gas/economic reachability, explicitly documented at `src/ShapeTypes.sol:35` through `src/ShapeTypes.sol:38` and `src/ShapeTypes.sol:75` through `src/ShapeTypes.sol:78`, and used at `src/lib/RecompositionOps.sol:168`, `src/lib/RecompositionOps.sol:331`, and `src/lib/RecompositionOps.sol:356`. This is a practical mainnet bound, not a mathematical upper-bound invariant.

### Views and presentation

**Token-id views exist-check and read-only behavior.** Verified by `V9ViewsAndLibrariesTest.test_EveryTokenIdViewRequiresTheTokenToExist`, `V9ViewsAndLibrariesTest.test_TokenIdViewsWriteNothing`, and `ShapeRendererTest.test_RenderViewsRevertForABurnedId`. Shared render inputs call `_requireOwned` at `src/Shapes.sol:966` through `src/Shapes.sol:977`; direct state views also check existence, for example `src/Shapes.sol:825` through `src/Shapes.sol:842`. `tokenURI` can still revert if the configured collection or renderer misbehaves, which is the presentation issue in SHAPES-01, not a backing issue.

**Effective-module parity.** Verified by `V9ViewsAndLibrariesTest.test_EffectiveModulesMatchWhatTheRendererDraws`, `ShapeRendererTest.test_RenderViewsEqualTheRendererOnBothGeometrySources`, `SamplingTest.test_OriginalMintsAreNeverMaterialized`, and materialized compose/split tests. `effectiveModulesOf` uses the same linked sampling helper at `src/Shapes.sol:1048` through `src/Shapes.sol:1053`; renderer calls select stored modules or grammar-derived modules through `src/Shapes.sol:989` through `src/Shapes.sol:995` and `src/Shapes.sol:1069` through `src/Shapes.sol:1075`.

**Renderer gate and stability.** The gate correctly requires code and both advertised interfaces at `src/lib/AdminOps.sol:79` through `src/lib/AdminOps.sol:85`, verified by `V9ViewsAndLibrariesTest.test_SetRendererRequiresBothRendererAndGeometryInterfaces`. There is no protocol guarantee that an installed renderer continues answering correctly, or that its geometry agrees with its rendering; the hostile compliant case is SHAPES-01.

**Collection gate and live lock.** Verified by `PresentationLockOrderingTest.test_SetCollectionRejectsACollectionBoundToADifferentShapes`, `PresentationLockOrderingTest.test_CopyGateReadsTheLockLiveAndTheAdminLive`, and `V9FeesAndPresentationTest.test_Attempt10_CollectionMustNameThisToken`. The gate checks `IShapeCollection` and `shapes() == address(this)` at `src/lib/AdminOps.sol:88` through `src/lib/AdminOps.sol:97`; the canonical collection reads the live token lock on every write at `src/ShapeCollection.sol:116` through `src/ShapeCollection.sol:130`. A non-canonical collection can lie about that behavior, as reported in SHAPES-01.

### Minting

**`mintStart` coverage.** Verified by `MintStartBoundaryTest.test_OneSecondBeforeStartEveryMintPathRefuses`, `MintStartBoundaryTest.test_AtExactlyTheStartMintingOpens`, `MintStartBoundaryTest.test_EscrowEthBidCannotMintBeforeStart`, `MintStartBoundaryTest.test_CardOnlyBidWorksBeforeStartAndCreatesNothing`, and `MintStartBoundaryTest.test_NoRecompositionPathCreatesATokenBeforeStart`. The gate is the first stateful check in `_mintBatch` at `src/Shapes.sol:406` through `src/Shapes.sol:412`; escrow ETH minting reaches `mintBatchTo` at `src/ShapeCardEscrow.sol:87` through `src/ShapeCardEscrow.sol:101`.

**Genesis exception.** Verified by `MintStartBoundaryTest.test_TokenZeroIsTheOnlyPreStartToken` and `MintStartTest.test_ConstructorMintsGenesisRegardlessOfFutureStart`. Constructor token #0 is initialized and minted at `src/Shapes.sol:212` through `src/Shapes.sol:248`; public minting starts from the next counter.

**Seeds.** Verified by `HardeningTest.test_SeedsRemainDistinctWithinAndAcrossBatches`, `HardeningTest.test_SeedIsIndependentOfMinterAndRecipient`, and `HardeningTest.test_SeedIsIndependentOfQuantity`. The source explicitly treats seeds as grindable and non-economic at `src/Shapes.sol:415` through `src/Shapes.sol:422`; no authorization or redemption rule depends on unpredictability.

**Fee cap.** Verified by `FeeAccountingTest.test_MintFeeCapCannotBeExceededByAnyPath`, constructor fee tests, and admin fee tests. The constructor applies the cap at `src/Shapes.sol:219` through `src/Shapes.sol:222`; AdminOps applies it at `src/lib/AdminOps.sol:152` through `src/lib/AdminOps.sol:157`.

### Authority

**Admin-only authority.** Verified by `V9AuthorityAndCustodyTest.test_OwnerTokenGrantsNoAuthority`, `ContractOwnershipTest.test_OwnerHasNoAdminPermissions`, and `ContractOwnershipTest.test_AdminTransfersIndependentlyOfOwnership`. Privileged entrypoints use `onlyAdmin` before delegation, for example `src/Shapes.sol:297` through `src/Shapes.sol:325`; owner-token holder state is separate from `_admin`.

**Presentation lock.** Verified for the canonical implementation by `PresentationLockOrderingTest.test_LockFreezesBothPointersAndTheCopy` and `ShapeRendererTest.test_CopyFreezesWithPresentation`. The pointer and lock state are frozen by `src/lib/AdminOps.sol:101` through `src/lib/AdminOps.sol:129`; the arbitrary-target limitation is SHAPES-01.

**Pointers and position reads.** Verified by all `HostilePositionsTargetTest` cases and pointer lock tests. Nonzero targets require code and the relevant ERC-165 interface at `src/lib/AdminOps.sol:162` through `src/lib/AdminOps.sol:200`; `positionOf` uses a 50,000-gas staticcall, exact 32-byte return validation, and dirty-high-bit rejection at `src/Shapes.sol:1077` through `src/Shapes.sol:1094`. A compliant target may still return a false position, but it cannot write through the staticcall.

**Artist attestation.** Verified by `V9ViewsAndLibrariesTest.test_ArtistDigestIsBoundToTheTokenNotTheLibrary`, `V9AuthorityAndCustodyTest.test_ArtistAttestationIsOneShotAndBound`, and signature tests. The digest binds chain id, contract, artist, and release hash at `src/lib/EIP712Signature.sol:19` through `src/lib/EIP712Signature.sol:25`; canonical ECDSA is attempted before ERC-1271 at `src/lib/EIP712Signature.sol:28` through `src/lib/EIP712Signature.sol:36`. Storage is one-shot at `src/lib/AdminOps.sol:214` through `src/lib/AdminOps.sol:225`.

**Permissionless attestation relay.** Verified by the artist relay tests and source review. `attestArtist` is intentionally ungated and reaches `AdminOps.attestArtist`; the stored hash can only pass the artist-bound digest and signature check at `src/lib/AdminOps.sol:206` through `src/lib/AdminOps.sol:224`.

### Reentrancy and callbacks

**Guarded protocol entrypoints.** Mint, redemption, fee withdrawal, and recomposition entrypoints use `nonReentrant`, including mint at `src/Shapes.sol:360` through `src/Shapes.sol:387`, redemption at `src/Shapes.sol:487` through `src/Shapes.sol:515`, and recomposition at `src/Shapes.sol:600` through `src/Shapes.sol:749`. The audit receiver tests cover decompose and split callbacks.

**External-call inventory.** `_safeMint` invokes receiver callbacks after state writes at `src/Shapes.sol:459` through `src/Shapes.sol:465`, redemption and fee payouts use `_sendEth` at `src/Shapes.sol:587` through `src/Shapes.sol:592`, and `positionOf` calls an untrusted resolver under bounded `staticcall` at `src/Shapes.sol:1080` through `src/Shapes.sol:1094`. Auction lot transfers are plain `transferFrom` at `src/ShapeAuctionHouse.sol:127` through `src/ShapeAuctionHouse.sol:131` and claim transfers at `src/ShapeAuctionHouse.sol:224` through `src/ShapeAuctionHouse.sol:227`; escrow card transfers are at `src/ShapeCardEscrow.sol:62` through `src/ShapeCardEscrow.sol:70` and `src/ShapeCardEscrow.sol:130` through `src/ShapeCardEscrow.sol:141`.

**Safe-transfer redemption.** Verified by receiver tests and `ShapesTest.test_ReentrantRedeemIsBlocked`. ERC-721 receiver callbacks can observe committed accounting and may redeem the received token if they own it, but the receiver cannot reenter guarded mint, redemption, fee, or recomposition paths to extract extra value.

**Self-custody.** Verified by `V9AuthorityAndCustodyTest.test_SelfCustodyIsRefusedEverywhere`, `ReceiverReentrancyDecomposeSplitTest.test_CallbackCannotPushAChildIntoShapesCustody`, and token-zero tests. `_update` rejects `to == address(this)` for plain transfers, safe transfers, and minting paths at `src/Shapes.sol:1193` through `src/Shapes.sol:1200`.

### Auction house and escrow

**No Shapes authority.** Verified by `AuctionSecurityTest`, `AuctionHouseArbitraryLotTest`, and the auction audit tests. The house is an independent ERC-721 application; its create path stores auction state and transfers the lot at `src/ShapeAuctionHouse.sol:80` through `src/ShapeAuctionHouse.sol:132`, with no admin, renderer, fee, or reserve write capability.

**Card and ETH bids.** Verified by `AuctionHouseTest.test_EthBidMintsTheMinimalCardSet`, `AuctionHouseTest.test_ACombinedCardsAndEthBidEscrowsBoth`, `AuctionInvariantTest.invariant_HouseHoldingsAreAccounted`, `AuctionInvariantTest.invariant_HouseHoldsNoEther`, and the mint-start audit tests. Card value comes from `backingOf` and Black cards are rejected at `src/ShapeCardEscrow.sol:56` through `src/ShapeCardEscrow.sol:70`; ETH-backed cards use the guarded Shapes mint path at `src/ShapeCardEscrow.sol:75` through `src/ShapeCardEscrow.sol:102`.

**Pull settlement and failed recipients.** Verified by `AuctionSecurityTest.test_H02_SettlementCannotBeBlockedByTheLot`, `AuctionSecurityTest.test_L1_ABidCannotBeRecordedOnAnAuctionCancelledMidCall`, and auction path tests. Settlement only records the close at `src/ShapeAuctionHouse.sol:203` through `src/ShapeAuctionHouse.sol:209`; lot and escrow state are marked or cleared before transfers at `src/ShapeAuctionHouse.sol:216` through `src/ShapeAuctionHouse.sol:227` and `src/ShapeCardEscrow.sol:128` through `src/ShapeCardEscrow.sol:141`.

**Owner-token lot.** Verified by `V9RecordsAndAuctionTest.test_Attempt9_OwnerTokenAsTheLot`, `AuctionPathsTest.test_OwnerTokenAsTheLotMovesOwnerAndNothingElse`, and `AuctionPathsTest.test_RedeemingAWonOwnerTokenEndsOwnershipCleanly`. Escrow changes `owner()` only because it changes the ERC-721 holder; it grants the house no Shapes authority.

### Presentation

**Renderer purity.** Verified by renderer purity/determinism tests and source review. `ShapeRenderer` implements its interfaces with pure rendering and ERC-165 functions at `src/ShapeRenderer.sol:30` and `src/ShapeRenderer.sol:503`; it has no admin, setters, or mutable state. A hostile installed renderer remains the SHAPES-01 presentation risk.

**Metadata safety.** Verified by `ShapeRendererTest.test_CopyRejectsJsonBreakingBytes`, `ShapeRendererTest.test_CopyRejectsOverlongValues`, `ShapeRendererTest.test_CopyRejectsMalformedUtf8`, `ShapeRendererTest.test_CopyAcceptsValidUtf8`, and token URI tests. The canonical collection validates all three strings before storage at `src/ShapeCollection.sol:124` through `src/ShapeCollection.sol:130`, and collection/token URI construction is at `src/ShapeCollection.sol:143` through `src/ShapeCollection.sol:160` and `src/Shapes.sol:1143` through `src/Shapes.sol:1176`.

## Decompose round trip

`DecomposeTest.test_RoundTripRestoresOriginalIdsSeedsAndState`, `SamplingTest.test_DecomposeRestoresModulesBitExactly_SingleLevel`, `SamplingTest.test_DecomposeRestoresModulesBitExactly_Stacked`, `ProvenanceTest.test_ComposeRecordAtReconstructionMatchesLiveModules`, `ProvenanceTest.test_ComposeRecordAtReconstructionMatchesLiveModules_MaterializedSurvivorDonor`, and the owner-token receiver tests cover ownership, denomination, seed, ink gene, materialized modules, compose depth, and owner-token movement. The record stores the survivor snapshot and every input snapshot at `src/lib/RecompositionOps.sol:136` through `src/lib/RecompositionOps.sol:174`; decompose restores those fields and ids at `src/lib/RecompositionOps.sol:232` through `src/lib/RecompositionOps.sol:261`, then Shapes restores ERC-721 ownership and the owner pointer at `src/Shapes.sol:778` through `src/Shapes.sol:785`. Caveat: the tests cover the reachable record shapes and maximal practical batches; the storage widths retain the economic bounds described above.

## Storage layout and linked libraries

`forge inspect Shapes storage-layout --json` reports the current touched groups as `_store` slot 6, `redeemableBacking` slot 13, `burnedBacking` slot 14, `blackShapeCount` slot 15, `_feeConfig` slot 16, `_feesOwed` slot 18, `_totalFeesOwed` slot 19, `_artistAttestation` slot 20, `_presentation` slot 22, `_pointers` slot 24, `_admin` slot 26, and `_ownerToken` slot 27. The current fee mapping plus running total is declared and used by `src/Shapes.sol:105` through `src/Shapes.sol:112` and `src/Shapes.sol:442` through `src/Shapes.sol:445`. No deployment in this snapshot uses an older layout for those fields, and the direct-call tests pin the current slots.

**RecompositionOps isolation.** `LibraryDirectCallTest.test_EveryRecompositionOpsEntryAtItsOwnAddressLeavesShapesUntouched` and `LibraryDirectCallTest.test_LibraryCodeAtAnotherAddressWritesThatAccountNotShapes` call every public storage-pointer entry with crafted slot arguments. Direct calls to the deployed library are protected by Solidity's library call guard; the test covers the public mutators and view entries.

**AdminOps isolation.** `LibraryDirectCallTest.test_EveryAdminOpsEntryAtItsOwnAddressLeavesShapesUntouched` covers configuration, pointer, and attestation entries with crafted storage slots. The library receives only narrow pointers from Shapes, as shown by the delegate calls at `src/Shapes.sol:298` through `src/Shapes.sol:343`.

**GeometrySampling isolation.** `LibraryDirectCallTest.test_PureLinkedLibrariesCannotReachShapes` and `LibraryDirectCallTest.test_PureEntryIsDispatchedByADirectCall` call its public pure functions directly. `GeometrySampling` has no storage pointer and its functions are pure, as declared at `src/lib/GeometrySampling.sol:8` through `src/lib/GeometrySampling.sol:23`; it cannot read or write Shapes storage. Direct calls are therefore valid computations with no protocol-state effect.

## Trust model

The table lists every `Shapes` entrypoint that delegates to a linked library. "Gate" is the check before delegation, except for intentionally permissionless attestation and read-only/pure computations.

| Shapes entrypoint(s) | Gate before delegate | Reached library function |
|---|---|---|
| `setFeeRecipient` | `onlyAdmin` | `AdminOps.setFeeRecipient` |
| `setMintFee` | `onlyAdmin` | `AdminOps.setMintFee` |
| `setRenderer` | `onlyAdmin` | `AdminOps.setRenderer` |
| `setCollection` | `onlyAdmin` | `AdminOps.setCollection` |
| `lockPresentation` | `onlyAdmin` | `AdminOps.lockPresentation` |
| `setPointer` | `onlyAdmin` | `AdminOps.setPointer` |
| `lockPointer` | `onlyAdmin` | `AdminOps.lockPointer` |
| `attestArtist` | No caller gate by design; valid one-shot artist-bound EIP-712/ERC-1271 signature inside the library | `AdminOps.attestArtist`, then `EIP712Signature.artistDigest` and `EIP712Signature.isValidNow` |
| `compose`, `composeMany` | `nonReentrant`; survivor ownership/liveness, distinct inputs, and each input ownership/liveness | `RecompositionOps.requireLiveOwner`, `requireDistinctComposeInputs`, `requireComposeInput`, then `RecompositionOps.compose` |
| `split`, `splitTo` | `nonReentrant`; caller ownership/liveness and at least two outputs; output-sum validation is inside the atomic delegate call after provisional burn/pointer effects | `RecompositionOps.split`, with `ShapeMath` and `GeometrySampling` helpers |
| `decompose`, `decomposeTo`, `decomposeMany`, `decomposeManyTo` | `nonReentrant`; caller owns each live survivor before each delegate | `RecompositionOps.decompose` |
| `composeRecordAt` | Read-only record bounds in the library | `RecompositionOps.composeRecordAt` |
| `shapeState` | `_requireOwned` | `RecompositionOps.shapeState` |
| `previewCompose` | Read-only structural/liveness checks; intentionally no ownership check | `RecompositionOps.previewCompose` |
| `previewSplit` | Read-only structural/liveness/sum/allocation checks; intentionally no ownership check | `RecompositionOps.previewSplit` |
| `effectiveModulesOf` | Token existence check; sampling library itself is pure | `GeometrySampling.effectiveModulesOf` |
| `artistAttestationDigest` | None; read-only digest | linked `EIP712Signature.artistDigest` |

The library bodies were audited as token code because `DELEGATECALL` executes them in Shapes storage. `RecompositionOps` writes only the `ShapeStore` pointer it receives, `AdminOps` writes only the narrow configuration pointers it receives, and neither library directly writes ERC-721 ownership, admin, reserve, or owner-token state. Shapes performs those writes around the delegate calls. `GeometrySampling` takes no storage pointer and is pure.

No missing authorization check or unauthorized post-write path was found. Split performs its output-sum validation after provisional burn and owner-pointer effects, but a failure reverts the complete transaction, so those effects cannot persist. There is no library setter, proxy, or CREATE2 redirection path; linked addresses are fixed in deployed bytecode as documented at `project/ARCHITECTURE.md:105` through `project/ARCHITECTURE.md:120`.

## Not exploitable, worth knowing

**Forced ETH is inert surplus.** `selfdestruct` or a block reward can increase the contract balance without changing `redeemableBacking()` or `pendingFees()`. No protocol function can withdraw that surplus, and `burnBacking` sends only the apex backing amount. This is covered by `ForcedEthTest.test_SelfdestructedEthIsCountedNowhereAndIsUnwithdrawable` and `ForcedEthTest.test_CoinbaseStyleCreditIsAlsoStranded`.

**A reverting fee recipient blocks only its own withdrawal, but its balance is not recoverable.** Per-recipient accounting prevents cross-recipient blocking and preserves the reserve invariant. The permanent loss of that recipient's fee balance is separately reported as SHAPES-02.

**Seeds are grindable.** A minter can advance the ordinal and search visual traits, as the source states at `src/Shapes.sol:420` through `src/Shapes.sol:422`. This is safe because seeds do not influence backing, authority, or redemption amount.

**Positions can lie but cannot write.** A compliant positions target may return an incorrect address. Reverts, out-of-gas, malformed ABI, and dirty high bits become zero, and `staticcall` prevents state writes. The pointer has no implementation in this phase, as recorded in the project decisions.

**A broken locked presentation surface does not brick custody.** A hostile renderer can make metadata calls fail, but reserve reads, transfers, redemption, and accounting remain reachable. This limits SHAPES-01 to Low severity.

**The auction house is custody, not authority.** Escrowing the owner token makes `owner()` point to the house for the auction's lifetime, but `owner()` is not an authorization role. Settlement and delivery remain pull-based.

**Split and revived ids use different allocation rules.** Split children always receive fresh monotonic ids, while decompose revives recorded ids. The tests cover both and the `totalMinted` counter prevents collisions; the narrow integer widths are documented practical gas bounds, not ETH-backed limits.

## Appendix: style and release observations

The ERC-721 symbol in this snapshot is `SHAPE` at `src/Shapes.sol:214`. This is an externally visible metadata value, not a custody or authorization vulnerability.

The standard Solc build succeeds despite the Solar diagnostic at `src/Shapes.sol:1203`. The diagnostic should be tracked as a toolchain compatibility matter if Solar is part of the release pipeline, but it was not a Solidity compiler failure in this audit.
