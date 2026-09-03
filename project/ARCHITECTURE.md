# Architecture

The permanent reference for how the Shapes system is put together and why. Contract roles, where
each behaviour lives, the delegatecall library pattern and its trust model, discovery, the reserve
invariant, and the measured runtime sizes.

## 1. System model

Shapes wraps ETH into unique ERC-721 tokens at nine fixed denominations. A token holds an exact
amount of ETH; burning it returns exactly that amount. Compose, decompose and split restructure
tokens without moving ETH. Sacrifice sends an apex token's backing to an unspendable address.

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
| `ShapeCollection` | Collection-level metadata. Read only by `contractURI`. | By admin until `lockPresentation` |
| `ShapeAuctionHouse` | English auction with bids denominated in Shape cards. Pulls tokens from bidders; holds no authority over `Shapes`. | Not wired in; discovered through the `market` pointer |

Libraries linked into `Shapes` at deploy time, with no setter anywhere:

| Library | Role |
| --- | --- |
| `RecompositionOps` | The compose, decompose and split state machine, and the previews of compose and split. |
| `AdminOps` | Every configuration write path: fee, metadata copy, renderer, collection, pointers, artist attestation. |
| `ComposeCompute` | Compose module sampling and ink gene assignment in one call. |
| `GeometrySampling` | The compose and split module-sampling procedures. |
| `InkGenes` | Ink gene assignment. |

Libraries whose code inlines into their callers (`internal` only, no linked address):
`Denominations`, `ShapeMath`, `CopyValidation`, `EIP712Signature`, `ModuleCodec`,
`GrammarV1Modules`, `Round03Rand`, `FixedPoint`.

## 3. Everything reachable from the token address

An integrator holding only the `Shapes` address can read every protocol fact and simulate every
recomposition. There is no periphery read contract, no second address to discover, and no function
reachable only through a library.

Protocol actions: `mint`, `mintTo`, `mintBatch`, `mintBatchTo`, `redeem`, `redeemTo`,
`redeemBatch`, `redeemBatchTo`, `burn`, `compose`, `composeMany`, `decompose`, `decomposeTo`,
`decomposeMany`, `decomposeManyTo`, `split`, `splitTo`, `sacrifice`, `withdrawFees`,
`attestArtist`.

Per-token views: `exists`, `backingOf`, `valueOf`, `isBlack`, `denomIndexOf`, `seedOf`,
`originCountOf`, `inkGeneOf`, `modulesOf`, `formationOf`, `isComplete`, `shapeState`,
`composeDepth`, `composeRecordAt`, `splitOriginOf`, `positionOf`, `tokenURI`, `unicodeCard`.

Simulation: `previewCompose`, `previewSplit`. Both take the account whose ownership is being
assumed, and run the same validation and the same sampling code the mutators run.

Collection views: `redeemableBacking`, `burnedBacking`, `blackShapeCount`, `totalSupply`,
`totalMinted`, `owner`, `ownerToken`, `admin`, `artist`, `mintFee`, `mintStart`, `pendingFees`,
`feeRecipient`, `renderer`, `collection`, `presentationLocked`, `positions`, `market`,
`contractURI`, `tokenNamePrefix`, `description`.

Ladder views: `unit`, `denominationCount`, `denominationAt`, `isSupportedDenomination`.

Grid geometry is not on the token. `IShapeGeometry.cardGeometry` on `renderer()` returns columns,
rows and module count for an amount. The rule is: the value ladder is a property of the token, the
grid is a property of the renderer.

## 4. The delegatecall library pattern

`Shapes` exceeds the EIP-170 24,576-byte runtime limit if every body it needs lives in its own
runtime. Bodies that do not need the ERC-721 internals live in public libraries instead. A public
library function is reached with `DELEGATECALL`, so it executes in the token's storage and emits
its events from the token's address. The token passes a storage pointer to the struct the library
is allowed to write.

Rules that make this safe, all enforced by construction:

1. **A library holds no authority.** Every access check runs in `Shapes` before it delegates.
   `AdminOps` has no `onlyAdmin`; the caller applied it.
2. **A library never writes ERC-721 state.** Minting, burning and every ownership check execute in
   the token's own runtime. A library cannot move a token.
3. **A library never moves ETH.** Only `Shapes` has a payable entrypoint and only `Shapes` calls
   `_sendEth`.
4. **A library reaches only the storage it is handed.** Each takes a pointer to one struct;
   `AdminOps` takes narrower structs still, one per field group it writes.
5. **The link is fixed at deploy.** `forge` writes each library's address into `Shapes`'s bytecode.
   There is no setter, so a call cannot be redirected after deployment.
6. **The ABI does not mention libraries.** Every action and view is an external function on the
   token with its own name, arguments and NatSpec. Library function names match the token function
   whose body they hold, so verified source reads straight through.

Only `Shapes` declares the storage. The libraries declare the struct types and receive pointers.

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

Held by `Shapes` alone, outside any library's reach: `redeemableBacking`, `burnedBacking`,
`blackShapeCount`, `pendingFees`, the owner token id, the admin address, `renderer`, `collection`
and `presentationLocked`. `AdminOps` receives narrow pointers to the fee, copy, attestation and
pointer groups it writes and nothing else.

The owner token id is written only by `Shapes`. No library can move collection ownership.

## 6. Recomposition: where each step runs

Each mutator keeps its ownership gate, its ERC-721 writes and its event order in the token. The
library holds the snapshotting, the accumulation, the sampling and the state writes.

`compose(survivorId, burnIds)`

1. `Shapes` rejects a repeated id (`RecompositionOps.requireDistinct`), then gates the survivor.
2. `Shapes` loops the inputs: rejects a self-burn, gates ownership and liveness, moves the owner
   token if this input carried it, burns the token, emits `ShapeAbsorbed`.
3. `RecompositionOps.compose` snapshots each input into the survivor's compose record, accumulates
   the donor pool, computes the new denomination, ink gene and sampled modules, writes the
   survivor, and emits `Composed`, `InkGene`, `ModulesSampled` and `MetadataUpdate`.

`split(tokenId, outDenoms)`

1. `Shapes` gates ownership and liveness and burns the parent.
2. `RecompositionOps.split` validates the output sum, records the split, allocates origins, samples
   each child's modules, writes the children, moves the owner token to the first child if the
   parent carried it, and emits `Split`, `InkGene`, `ShapeFragmentCreated` and `ModulesSampled`.
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

`account` is an explicit argument. A preview applies the same ownership and liveness gate the
mutator applies to `msg.sender`, so a preview that would revert for a caller reverts for that
caller in the preview too.

A repeated id in `burnIds` is rejected by `requireDistinct` in both paths, with the same
`DuplicateComposeInput` error. It sorts a memory copy of the ids and rejects adjacent equals, so it
is O(n log n) and identical on both sides.

## 8. Discovery

`supportsInterface` advertises exactly what the token implements:

| Interface | Meaning |
| --- | --- |
| `IShapes` | The whole token surface. |
| `IAdminControl` | The admin role and its bounded authority. |
| `IShapeValue` | Backing, denominations and redemption. |
| `IShapeRecomposition` | Compose, decompose, split, sacrifice. |
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
  No ETH moves. Simulate first with `previewCompose(account, survivorId, burnIds)` and
  `previewSplit(account, tokenId, outDenoms)`, which apply the same rules without writing.
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

- Minting adds backing to `redeemableBacking` and the flat fee to `pendingFees`. Fees never enter
  backing.
- Redeeming and burning subtract exactly the token's backing and pay it out.
- Compose, decompose and split move no ETH and leave `redeemableBacking` untouched by construction:
  the summed backing of the tokens involved is unchanged.
- `sacrifice` moves an apex token's backing out of `redeemableBacking`, adds it to `burnedBacking`,
  and sends that ETH to `0x...dEaD`.
- `withdrawFees` pays only `pendingFees`, which is never part of the reserve.

No pause, no upgrade path, no recovery function and no admin path reaches the reserve.

`burnedBacking` is cumulative and monotonic: that ETH has left the contract. `blackShapeCount` is
the count of Black Shapes alive now, so it decreases when a Black Shape is burned for zero. The two
answer different questions and are not two views of one number.

CEI holds in every mutator: state is written before any external call, and the receiver-callback
loops in `split` and `decompose` run after every write.

## 11. Measured runtime sizes

Measured with `forge build --sizes`, `optimizer_runs = 20`, `via_ir = true`. EIP-170 limit 24,576.

Before this refactor, default profile:

| Contract | Runtime | Margin |
| --- | --- | --- |
| `Shapes` | 23,795 | 781 |
| `ShapeLens` | 10,826 | 13,750 |
| `ShapeRenderer` | 23,442 | 1,134 |

Spikes that sized the moves, on the same source:

| Bodies removed from `Shapes` | Runtime | Recovered |
| --- | --- | --- |
| `_compose`, `_splitTo`, `_decomposeTo` and their helpers | 16,885 | 6,910 |
| the renderer, collection, pointer and admin-transfer write paths | 22,485 | 1,310 |

Final measured sizes are recorded in section 12 of this file and in `foundry.toml`.

## 12. Measured result

See the table kept current here after each size-affecting change.

| Contract | Default | Testnet | Margin (default) |
| --- | --- | --- | --- |
| `Shapes` | (recorded at P5) | | |
</invoke>
