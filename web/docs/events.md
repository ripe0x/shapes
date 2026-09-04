# Events

Every state change emits enough to rebuild token state from logs alone. This page lists each event, what emits it, and how to combine them.

## Lifecycle

| Event | Emitted by |
| --- | --- |
| `ShapeMinted(uint256 indexed tokenId, address indexed to, uint256 amountWei, bytes32 seed, uint256 originCount)` | Mint only. `originCount` is always 1. Split children and decompose restores do not emit it |
| `ShapeRedeemed(uint256 indexed tokenId, address indexed to, uint256 amountWei, uint256 originCount)` | `redeem*` and `burn`. `amountWei` is 0 when a Black Shape is burned |
| `Composed(uint256 indexed survivorId, uint256[] burnedIds, uint8 denomIndex, uint32 originCount)` | `compose`, `composeMany`, once per compose |
| `ShapeAbsorbed(uint256 indexed survivorId, uint256 indexed burnedId)` | Once per burned input, filterable by either id |
| `Decomposed(uint256 indexed survivorId, uint256[] restoredIds, uint8 survivorDenomIndex, uint32 survivorOriginCount)` | `decompose*`, once per reversal |
| `ShapeRevived(uint256 indexed survivorId, uint256 indexed revivedId)` | Once per restored input |
| `Split(uint256 indexed tokenId, bytes32 indexed parentSeed, uint256[] newIds, uint8[] outDenoms, uint32[] originCounts)` | `split`, `splitTo`, once |
| `ShapeFragmentCreated(uint256 indexed parentId, uint256 indexed childId, bytes32 indexed parentSeed, uint256 childIndex)` | Once per child |
| `BlackShapeCreated(uint256 indexed tokenId, uint256 burnedWei)` | `burnBacking` |
| `InkGene(uint256 indexed tokenId, uint8 gene)` | Every gene assignment: each mint, the compose survivor, the decompose survivor and each restored input, each split child |
| `ModulesSampled(uint256 indexed tokenId, bytes modules)` | Every stored-geometry write: the compose survivor, each split child, the decompose survivor and each restored input. Empty `modules` means seed-derived geometry |
| `OwnerTokenMoved(uint256 indexed fromTokenId, uint256 indexed toTokenId)` | Construction, compose, decompose, split, redeem or burn of the owner token. `type(uint256).max` means no token |
| `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` | ERC-721. From zero on mint, split child and decompose restore; to zero on redeem, burn, compose input and split parent |
| `MetadataUpdate(uint256 tokenId)`, `BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId)` | ERC-4906. Compose and decompose survivors, `burnBacking`; the batch form on `setCollection` and `refreshMetadata` |

## Fees and administration

| Event | Emitted by |
| --- | --- |
| `MintFeeAccrued(uint256 amountWei)` | Once per mint call with a nonzero fee, the aggregate for the call |
| `FeesWithdrawn(address indexed recipient, uint256 amountWei)` | `withdrawFees` |
| `FeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient)` | `setFeeRecipient` |
| `MintFeeUpdated(uint256 previousFee, uint256 newFee)` | `setMintFee` |
| `AdminTransferred(address indexed previousAdmin, address indexed newAdmin)` | Construction, `transferAdmin`, `renounceAdmin` |
| `RendererUpdated(address indexed renderer)`, `CollectionUpdated(address indexed collection)` | `setRenderer`, `setCollection` |
| `PresentationLocked(address indexed renderer, address indexed collection)` | `lockPresentation` |
| `ContractURIUpdated()` | ERC-7572, on `setCollection` and `refreshMetadata` |
| `PositionsSet(address indexed positions)`, `MarketSet(address indexed market)` | `setPointer` |
| `PositionsLocked(address indexed positions)`, `MarketLocked(address indexed market)` | `lockPointer` |
| `ArtistAttested(address indexed artist, bytes32 indexed releaseHash, bytes signature)` | `attestArtist`, once ever |

## Rebuilding state from logs

- **Which ids are live.** Track `Transfer`. An id is live between a `Transfer` from zero and a `Transfer` to zero. Decompose can make a dead id live again.
- **Backing.** `ShapeMinted.amountWei` at mint. After that, `Composed.denomIndex` for the survivor, `Decomposed.survivorDenomIndex`, `Split.outDenoms[i]` per child, and `BlackShapeCreated` sets redeemable value to zero. Restored inputs return with the denomination they had when consumed; keep it from their last known state.
- **Origins.** `ShapeMinted.originCount` (1), `Composed.originCount`, `Decomposed.survivorOriginCount`, `Split.originCounts`. `ShapeRedeemed.originCount` lets you keep a global origin balance without a pre-burn read.
- **Ink gene and modules.** `InkGene` and `ModulesSampled` follow every structural event in the same transaction. Apply them after the structural event.
- **Lineage.** `ShapeAbsorbed` (input into survivor), `ShapeFragmentCreated` (parent to child) and `ShapeRevived` (survivor back to input) are the three edge types. Each is indexed on both ids, so `eth_getLogs` can answer "what did token X become" and "what went into token X" without decoding arrays.
- **Owner token.** Replay `OwnerTokenMoved`; the co-emitted structural event in the same transaction says why.

The [Indexer](/docs/indexer) already does all of this and serves the result over GraphQL.
