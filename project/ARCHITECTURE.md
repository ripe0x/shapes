# Architecture

The permanent reference for how the Shapes system is put together and why. Contract roles, where
each behaviour lives, the delegatecall library pattern and its trust model, discovery, the reserve
invariant, and the measured runtime sizes.

## 1. System model

Shapes wraps ETH into unique ERC-721 tokens at nine fixed denominations. A token holds an exact
amount of ETH; burning it returns exactly that amount. Compose, decompose and split restructure
tokens without moving ETH. `burnBacking` sends an apex token's backing to an unspendable address.

One contract is the protocol: `Shapes`. It owns the reserve, the token, the state machine and
every protocol fact. Everything else is presentation or an independent application.

```
                     Shapes  (the token: reserve, state machine, every protocol fact)
                       |
     +-----------------+------------------+---------------------+
     |                 |                  |                     |
 ShapeRenderer   ShapeCollection    RecompositionOps         AdminOps
 (tokenURI art)  (contractURI)      (delegatecall library)   (delegatecall library)
                                          |
                                    ComposeCompute
                                    GeometrySampling
                                    InkGenes

 ShapeAuctionHouse  (independent application, registered as the `market` pointer)
```

`ShapeAuctionHouse` calls `Shapes`; `Shapes` never calls it. It holds no role on the token.

## 2. Contract roles

| Contract | Role | Replaceable |
| --- | --- | --- |
| `Shapes` | The token. Reserve custody, minting, redemption, recomposition, every protocol view. | No |
| `ShapeRenderer` | Onchain artwork and token metadata. Read only by `tokenURI`. | By admin until `lockPresentation` |
| `ShapeCollection` | Collection-level metadata, and the token name prefix, shared description and owner-token description `tokenURI` and `contractURI` read back. | By admin until `lockPresentation` |
| `ShapeAuctionHouse` | English auction with bids denominated in Shape cards. Pulls tokens from bidders; holds no authority over `Shapes`. | Not wired in; discovered through the `market` pointer |

Libraries linked into `Shapes` at deploy time, with no setter anywhere:

| Library | Role |
| --- | --- |
| `RecompositionOps` | The compose, decompose and split state machine, and the previews of compose and split. |
| `AdminOps` | Every configuration write path on `Shapes`: fee, renderer, collection, pointers, artist attestation. |
| `ComposeCompute` | Compose module sampling and ink gene assignment in one call. |
| `GeometrySampling` | The compose and split module-sampling procedures. |
| `InkGenes` | Ink gene assignment. |

`CopyValidation` is linked the same way, into `ShapeCollection` rather than `Shapes`.

Libraries whose code inlines into their callers (`internal` only, no linked address):
`Denominations`, `ShapeMath`, `EIP712Signature`, `ModuleCodec`, `GrammarV1Modules`, `Round03Rand`,
`FixedPoint`.

## 3. Everything reachable from the token address

An integrator holding only the `Shapes` address can read every protocol fact and simulate every
recomposition. There is no periphery read contract, no second address to discover, and no function
reachable only through a library.

Protocol actions: `mint`, `mintTo`, `mintBatch`, `mintBatchTo`, `redeem`, `redeemTo`,
`redeemBatch`, `redeemBatchTo`, `burn`, `compose`, `composeMany`, `decompose`, `decomposeTo`,
`decomposeMany`, `decomposeManyTo`, `split`, `splitTo`, `burnBacking`, `withdrawFees`,
`attestArtist`.

Per-token views: `exists`, `backingOf`, `valueOf`, `isBlackShape`, `denomIndexOf`, `seedOf`,
`originCountOf`, `inkGeneOf`, `modulesOf`, `formationOf`, `isComplete`, `shapeState`,
`composeDepth`, `composeRecordAt`, `splitOriginOf`, `positionOf`, `tokenURI`, `unicodeCard`.

Token-id render views: `svg`, `metadataJSON`, `geometryOf`, `effectiveModulesOf`, `moduleAt`.
Each assembles the token's state the way `tokenURI` does, through one shared helper, and forwards
to `renderer()`. They save an integrator the two-step of reading the token's fields and calling the
renderer with them, and they select the sampled or the seed-based renderer path for the caller.
`modulesOf` returns only the materialized bytes a token stores; `effectiveModulesOf` returns the
module glyph sequence for every token.

Simulation: `previewCompose`, `previewSplit`. Both run the same structural validation and the
same sampling code the mutators run, over any live inputs, and check no ownership.

Collection views: `redeemableBacking`, `burnedBacking`, `blackShapeCount`, `totalSupply`,
`totalMinted`, `owner`, `ownerToken`, `admin`, `artist`, `mintFee`, `mintStart`, `pendingFees`,
`feesOwedTo`, `feeRecipient`, `renderer`, `collection`, `presentationLocked`, `positions`,
`market`, `contractURI`.

The metadata copy is one hop out: `IShapeCollection.tokenNamePrefix`,
`IShapeCollection.description` and `IShapeCollection.ownerTokenDescription` live on the address
`collection()` returns. `tokenURI` reads them back and passes the renderer the owner-token
description for whichever Shape currently carries collection ownership and the shared description
for every other token. `contractURI` forwards to `IShapeCollection.contractURI`, which reads
`IShapeCollection.description` and the token's ERC-721 `name()` itself.

Ladder views: `unit`, `denominationCount`, `denominationAt`, `isSupportedDenomination`.

The grid is still the renderer's fact, not the token's: `geometryOf` reads
`IShapeGeometry.cardGeometry` on `renderer()` for the token's own state rather than storing or
recomputing a grid. `IShapeGeometry` remains the entrypoint for a grid at an arbitrary amount, with
no token involved.

## 4. The delegatecall library pattern

`Shapes` exceeds the EIP-170 24,576-byte runtime limit if every body it needs lives in its own
runtime. Bodies that do not need the ERC-721 internals live in public libraries instead. A public
library function is reached with `DELEGATECALL`, so it executes in the token's storage and emits
its events from the token's address. The token passes a storage pointer to the struct the library
is allowed to write.

A linked library runs through `DELEGATECALL` in the token's storage context, so the pointer it
receives is a source-structure convention, not an EVM-enforced boundary. `RecompositionOps` and
`AdminOps` are part of the trusted implementation. The structure below is what the reserve
invariant and the access control rely on:

1. **Authorization runs in `Shapes`.** Every access check runs before it delegates. `AdminOps` has
   no `onlyAdmin`, because the caller applied it. `attestArtist` is ungated on both sides: its gate
   is the EIP-712 signature check inside `AdminOps.attestArtist` against the immutable `artist`
   address `Shapes` passes in, so anyone may relay the artist's signature and no one can forge one.
2. **ERC-721 writes stay in the token.** Minting, burning and every ownership check execute in the
   token's own runtime.
3. **ETH movement stays in the token.** `Shapes` holds every payable entrypoint and is the only
   caller of `_sendEth`.
4. **Each library receives the storage it writes.** `RecompositionOps` receives `_store`, which
   holds token and recomposition state. `AdminOps` receives one narrow struct per field group it
   writes.
5. **The link is fixed at deploy.** `forge` writes each library's address into `Shapes`'s bytecode.
   There is no setter, so a call cannot be redirected after deployment.
6. **The ABI does not mention libraries.** Every action and view is an external function on the
   token with its own name, arguments and NatSpec. Library function names match the token function
   whose body they hold, so verified source reads straight through.

Only `Shapes` declares the storage. The libraries declare the struct types and receive pointers.

A direct `CALL` to a library at its own address cannot reach the token. Two things stop it, and
either alone is sufficient. First, solc emits call protection into a public library that has any
non-view, non-pure external function: the runtime compares `address(this)` with the library address
written into its own code at deployment and reverts when they match, which is the direct-call case.
Every mutator in `RecompositionOps` and `AdminOps` reverts this way, measured in
`test/LibraryIsolation.t.sol`. Second, a storage-pointer argument resolves against the account
executing the code. Under `DELEGATECALL` that is the token; under a direct `CALL` it is the library's
own storage account, which no contract reads, so a write that got through would land where nothing
looks. The `public view` and `public pure` functions carry no guard, because they cannot write.

What goes in a library: the state machine, and the reads that reassemble what it records. A view
that is one storage lookup, such as `splitOriginOf`, stays on the token, where a reader following
the function lands on its body.

## 5. Storage ownership

`ShapeTypes.sol` declares every shared type: the formation enum, the storage structs, and the view
structs the ABI returns.

`ShapeStore` is the one struct `RecompositionOps` writes:

```
shapes           per-token seed, denomination index, origin count, Black flag, ink gene
modules          per-token materialized module bytes, empty for seed-derived geometry
composeStack     per-survivor LIFO stack of reversible compose records
splitRecords     append-only, one entry per split operation
splitOriginRef   per-child reference into splitRecords
totalSupply      live token count
totalMinted      the id counter
```

Declared and written by `Shapes`: `redeemableBacking`, `burnedBacking`, `blackShapeCount`, the
per-recipient owed-fees mapping and its running total (`pendingFees()`), the owner token id and
the admin address. `AdminOps` receives narrow pointers to the four groups it writes: the fee
config, the presentation config (`renderer`, `collection`, the lock), the artist attestation and
the pointer group.

The owner token id is written by `Shapes`, which moves collection ownership.

## 6. Recomposition: where each step runs

Each mutator keeps its ownership gate, its ERC-721 writes and its event order in the token. The
library holds the snapshotting, the accumulation, the sampling and the state writes.

`compose(survivorId, burnIds)`

1. `Shapes` gates the survivor, then rejects a repeated id
   (`RecompositionOps.requireDistinctComposeInputs`).
2. `Shapes` loops the inputs: rejects a self-burn, gates ownership and liveness, moves the owner
   token if this input held it, burns the token, emits `ShapeAbsorbed`.
3. `RecompositionOps.compose` snapshots each input into the survivor's compose record, accumulates
   the donor pool, computes the new denomination, ink gene and sampled modules, writes the
   survivor, and emits `Composed`, `InkGene`, `ModulesSampled` and `MetadataUpdate`.

`split(tokenId, outDenoms)`

1. `Shapes` gates ownership and liveness and burns the parent, then moves the owner token to the
   first child's id if the parent held it, and emits `OwnerTokenMoved`. The id is known before the
   split runs, because the children take the next `outDenoms.length` ids; a later output-sum
   mismatch reverts the whole call, so the pointer cannot be left on an unminted id.
2. `RecompositionOps.split` validates the output sum, records the split, allocates origins, samples
   each child's modules, writes the children, and emits `Split`, `InkGene`,
   `ShapeFragmentCreated` and `ModulesSampled`.
3. `Shapes` safe-mints the children last, after every write.

`decompose(survivorId)`

1. `Shapes` gates ownership and liveness.
2. `RecompositionOps.decompose` pops the survivor's top record, restores the survivor, rewrites
   every burned input's state, and emits `Decomposed`, `InkGene`, `ShapeRevived`, `ModulesSampled`
   and `MetadataUpdate`. It returns the restored ids and whether the record carried the owner token.
3. `Shapes` safe-mints the restored inputs, then moves the owner token, so no receiver callback can
   observe `ownerToken()` pointing at an id that does not yet exist.

Emitted logs, their contents and their order are the same as before this refactor.

## 7. Previews cannot drift from execution

`previewCompose` and `previewSplit` are functions on the token whose bodies sit in
`RecompositionOps`, beside the mutators they predict. They read the same `ShapeStore`, call the
same `ComposeCompute` and `GeometrySampling` deployments through the same link, and share the
validation helpers with `compose` and `split`. There is no second contract, no second link and no
duplicated validation, so the class of bug where a preview contract is deployed against different
library code cannot occur.

Neither preview takes an account and neither checks ownership. Each still applies every
structural gate its mutator applies, in the same order and with the same errors: both inputs live
and not Black, no repeated compose input, a non-empty compose burn set, at least two split outputs,
the split sum matching the parent's backing, and the composed or split total landing on the
denomination ladder. Simulate the mutating call to learn whether a given account may execute it.

A repeated id in `burnIds` is rejected by `requireDistinctComposeInputs` in both paths, with the same
`DuplicateComposeInput` error. It sorts a memory copy of the ids and rejects adjacent equals, so it
is O(n log n) and identical on both sides.

## 8. Discovery

`supportsInterface` advertises exactly what the token implements:

| Interface | Meaning |
| --- | --- |
| `IShapes` | The whole token surface. |
| `IAdminControl` | The admin role and its bounded authority. |
| `IShapeValue` | Backing, denominations and redemption. |
| `IShapeRecomposition` | Compose, decompose, split, burnBacking. |
| `IShapeProvenance` | Seed, origins, ink gene, formation, child seeds. |
| `IERC721Value` | Draft ERC-8060 value-bearing ERC-721. |
| `IERC2981` | Royalty, permanently zero. |
| ERC-4906 (`0x49064906`) | Metadata update events. |
| `IERC721`, `IERC721Metadata`, `IERC165` | Standard. |

Two administered pointers name related contracts without granting them anything:

| Pointer | Target must support | Read by |
| --- | --- | --- |
| `positions` (0) | `IShapePositionResolver` | `Shapes.positionOf` |
| `market` (1) | `IShapeAuctionHouse` | Clients, for discovery. Never called by the token. |

`setPointer(uint8,address)` requires a nonzero target to answer ERC-165 for the interface its
reader uses. `lockPointer(uint8)` freezes one pointer permanently, including at zero. No token or
reserve operation reads either pointer. `Deploy.s.sol` sets `market` to the deployed auction house
and asserts both pointers afterwards.

`positionOf` staticcalls the positions target with 50,000 gas and returns zero on revert, on
out-of-gas, on a return that is not 32 bytes, and on a word with dirty high bits. The target is
untrusted; its only power is to mislead a caller of this view.

## 9. Using Shapes from another contract

Probe first, then call:

```solidity
IShapes shapes = IShapes(shapesAddress);
require(shapes.supportsInterface(type(IShapes).interfaceId));
```

Narrower probes for narrower needs: `type(IShapeValue).interfaceId` if all you need is backing and
redemption, `type(IShapeRecomposition).interfaceId` for the mutators,
`type(IShapeProvenance).interfaceId` for seeds and origins, `type(IERC721Value).interfaceId` for
the draft ERC-8060 `valueOf`/`burn` pair.

- **What is a token worth.** `backingOf(tokenId)` or `valueOf(tokenId)`, both in wei. Zero for a
  Black Shape. Reverts for an id that does not exist; `exists(tokenId)` never reverts.
- **Take the ETH.** `redeem(tokenId)` pays the caller; `redeemTo(tokenId, recipient)` pays a chosen
  address; the `redeemBatch` pair does several at once and returns the total. Only the current
  owner may redeem. An approved operator must take ownership first.
- **Mint.** `mint(amountWei)` with `msg.value == amountWei + mintFee()`. `isSupportedDenomination`
  tells you whether an amount is on the ladder before you send it. `mintStart()` is when public
  minting opens.
- **Restructure.** `compose(survivorId, burnIds)`, `split(tokenId, outDenoms)`,
  `decompose(survivorId)`. All require the caller to own every token involved and none to be Black.
  No ETH moves. Simulate first with `previewCompose(survivorId, burnIds)` and
  `previewSplit(tokenId, outDenoms)`, which apply the same structural rules without writing.
- **Read everything about one token in one call.** `shapeState(tokenId)`.
- **Provenance.** `composeDepth(survivorId)` then `composeRecordAt(survivorId, depth)` for what a
  `decompose` would restore; `splitOriginOf(childId)` for the split that created a token.
- **Receiving a Shape.** `Shapes` refuses to be a token's owner, so a contract that takes custody
  must be prepared to redeem or transfer it back. During a `safeTransferFrom`, the receiver may
  redeem the token from inside its own `onERC721Received`; do not assume the token still exists
  after that callback returns.
- **Ownership and admin.** `owner()` is the holder of the owner token and carries no authority.
  `admin()` configures presentation and fees and can never reach backing, redemption or token
  ownership. Neither is required for anything above.

Every error names a condition the caller can act on: `UnsupportedDenomination`, `IncorrectPayment`,
`NotShapeOwner`, `TokenIsBlack`, `DuplicateComposeInput`, `CannotComposeWithSelf`,
`NoComposeInputs`, `SplitSumMismatch`, `SplitTooFewOutputs`, `NoComposeRecord`, `NotApexComplete`,
`NotASplitChild`, `ComposeRecordOutOfRange`, `MintNotOpen`, `SelfCustodyRejected`.

## 10. The reserve invariant

```
address(this).balance >= redeemableBacking() + pendingFees()
```

Equality holds in normal use. ETH forced into the contract outside its payable entrypoints is not
withdrawable by anyone.

- Minting adds backing to `redeemableBacking` and the flat fee to the current `feeRecipient`'s own
  owed balance, counted in `pendingFees()`. Fees never enter backing.
- Redeeming and burning subtract exactly the token's backing and pay it out.
- Compose, decompose and split move no ETH and leave `redeemableBacking` untouched by construction:
  the summed backing of the tokens involved is unchanged.
- `burnBacking` moves an apex token's backing out of `redeemableBacking`, adds it to `burnedBacking`,
  and sends that ETH to `0x...dEaD`.
- `withdrawFees(recipient)` pays only `recipient`'s own owed balance, which is never part of the
  reserve. `setFeeRecipient` writes only where future fees accrue and moves no owed balance, so a
  recipient change cannot reach what an earlier recipient is owed.

No pause, no upgrade path, no recovery function and no admin path reaches the reserve.

`burnedBacking` is cumulative and monotonic: that ETH has left the contract. `blackShapeCount` is
the count of Black Shapes alive now, so it decreases when a Black Shape is burned for zero. The two
answer different questions and are not two views of one number.

CEI holds in every mutator: state is written before any external call, and the receiver-callback
loops in `split` and `decompose` run after every write.

## 11. Decisions taken here

Recorded so a reader does not have to reconstruct them from the code.

**`lockPresentation` freezes the renderer, the collection and the metadata copy.** One lock over
everything the name covers. `setRenderer`, `setCollection` and `ShapeCollection.setMetadataCopy`
all revert `PresentationIsLocked` after it; the collection reads the lock back from `Shapes` rather
than holding one of its own. Separate locks would be separate facts to reason about, and the copy
is read from the same metadata document as the two contracts it freezes with.

**The metadata copy lives on the collection (D-41).** Presentation state sits with the presentation
contracts: `ShapeCollection` stores the token name prefix, the shared description and the
owner-token description, validates all three with `CopyValidation`, and gates `setMetadataCopy` on
the admin and lock it reads live from
the `Shapes` it is constructed with. The token holds no copy storage and no second admin role. Two
consequences. The collection takes the token's address at construction, so `Shapes`'s constructor
has no collection parameter and deployment fills the pointer with `setCollection` before anything
else runs; `tokenURI` and `contractURI` revert `CollectionNotSet` while it is zero. And a copy edit
is two transactions, because the collection cannot emit ERC-4906 from the token's address:
`collection.setMetadataCopy`, then `shapes.refreshMetadata`.

**The admin address and the owner token stay on the token.** The libraries hold every other write
path, but `transferAdmin`, `renounceAdmin` and every owner-token move execute in `Shapes`'s own
runtime. Moving them would make a library able to hand over the admin role or move collection
ownership, which is worth more than the roughly 250 bytes it would recover.

**`blackShapeCount` counts what its name says.** It is the number of Black Shapes alive now, so
burning one for zero lowers it. `burnedBacking` stays cumulative and monotonic, because that ETH has
already left the contract. The two answer different questions.

**A pointer must answer the interface its reader calls.** A market target must support
`IShapeAuctionHouse`, a positions target `IShapePositionResolver`. A live contract of the wrong kind
is refused rather than stored and silently useless. Zero always clears.

**The duplicate-input check runs on both sides.** `requireDistinctComposeInputs` sorts a memory copy of `burnIds`
and rejects adjacent equals, in `compose` and in `previewCompose` alike. Before, the mutator relied
on `_burn` reverting on the second occurrence and reported `ERC721NonexistentToken`, while the
preview reported `DuplicateComposeInput`. Now both report `DuplicateComposeInput`, and the check is
one function.

**Previews answer for the tokens, not for a caller.** `previewCompose` and `previewSplit` take
no account and check no ownership, so a marketplace or an aggregator can render the outcome of a
recomposition over tokens it does not hold. Whether a given account may execute it is a separate
question, answered by simulating the mutating call.

**Grid geometry is not on the token.** `gridForAmount` and `modulesForAmount` are gone;
`IShapeGeometry.cardGeometry` on `renderer()` already returned columns, rows and module count. The
value ladder is the token's fact, the grid is the renderer's.

## 12. Measured runtime sizes

`forge build --sizes`, `optimizer_runs = 20`, `via_ir = true`. EIP-170 limit 24,576.

| Contract | Before | Default | Testnet | Margin (default) |
| --- | --- | --- | --- | --- |
| `Shapes` | 23,795 | 20,342 | 20,325 | 4,234 |
| `ShapeLens` | 10,826 | deleted | deleted | |
| `RecompositionOps` | new | 12,246 | 12,228 | |
| `AdminOps` | 3,747 | 2,848 | 2,847 | |
| `ShapeRenderer` | 23,442 | 23,442 | 23,441 | 1,134 |
| `ShapeAuctionHouse` | 7,916 | 8,015 | 8,006 | 16,561 |
| `ShapeCollection` | 4,077 | 5,882 | 5,875 | 18,694 |
| `GeometrySampling` | 4,714 | 4,714 | 4,714 | |
| `ComposeCompute` | 1,258 | 1,258 | 1,258 | |
| `EIP712Signature` | 1,006 | 1,006 | 1,006 | |
| `CopyValidation` | 852 | 852 | 852 | |
| `InkGenes` | 729 | 729 | 729 | |

`Shapes` carries more surface than before and is 3,418 bytes smaller. The spikes that sized the
moves, measured on the pre-refactor source: stubbing the compose, split and decompose bodies
recovered 6,910 bytes; stubbing the renderer, collection, pointer and admin-transfer write paths
recovered 1,310. The views and previews added back about 2,690.

`IShapes` is `0x2ba22587`, pinned in `test/ContractOwnership.t.sol`.
