# Interfaces

The Solidity interfaces in `src/interfaces/` of the repository, and the ERC-165 ids Shapes and its periphery answer. An interface id is the XOR of the selectors of the functions the interface itself declares, excluding inherited ones, which is what `type(I).interfaceId` returns.

## On the Shapes token

`Shapes.supportsInterface(id)` returns true for every id below.

| Interface | Id | Members |
| --- | --- | --- |
| `IERC165` | `0x01ffc9a7` | `supportsInterface` |
| `IERC721` | `0x80ac58cd` | Standard ERC-721 |
| `IERC721Metadata` | `0x5b5e139f` | `name`, `symbol`, `tokenURI` |
| `IERC2981` | `0x2a55205a` | `royaltyInfo`, always zero |
| ERC-4906 | `0x49064906` | `MetadataUpdate`, `BatchMetadataUpdate` |
| `IERC721Value` | `0x88495fe7` | `valueOf`, `burn` (draft ERC-8060) |
| `IAdminControl` | `0x0ce8a022` | `admin`, `transferAdmin`, `renounceAdmin`, `setFeeRecipient`, `setMintFee` |
| `IShapeValue` | `0xd07d718a` | `backingOf`, `denomIndexOf`, `denominationAt`, `denominationCount`, `unit`, `redeem`, `redeemBatch`, `redeemTo`, `redeemBatchTo` |
| `IShapeRecomposition` | `0xec6e0ab9` | `compose`, `decompose`, `decomposeTo`, `split`, `splitTo`, `burnBacking` |
| `IShapeProvenance` | `0x32b56359` | `seedOf`, `originCountOf`, `inkGeneOf`, `isComplete`, `formationOf`, `childSeed` |
| `IShapes` | `0xa43afc62` | The full surface: 92 functions, every event and error |

`IShapes` extends `IERC721`, `IERC721Value` and `IAdminControl`. The three slices, `IShapeValue`, `IShapeRecomposition` and `IShapeProvenance`, are declared in `IShapes.sol` for an integrator that needs only part of the surface; every member is implemented on the token.

## On the periphery

| Interface | Id | Answered by | Purpose |
| --- | --- | --- | --- |
| `IShapeRenderer` | `0xefb4cd24` | `renderer()` | `renderSVG`, `renderSVGSampled`, `metadataJSON`, `metadataJSONSampled` and the rest of the pure rendering surface |
| `IShapeGeometry` | `0xfefff92f` | `renderer()` | `grammarVersion`, `grammarHash`, `cardGeometry`, `cardGeometrySampled`, `moduleAt`, `moduleAtSampled` |
| `IShapeCollection` | `0x8d32a84b` | `collection()` | Metadata copy, `contractURI`, `json`, `image`, `imageFor`, `card`, `cardFor`, `seed` |
| `IShapePositionResolver` | `0x46f96023` | `positions().target` | `positionOf` |
| `IShapeAuctionHouse` | `0x4dec63f0` | `market().target` | The auction house |

`setRenderer` requires `IShapeRenderer` and `IShapeGeometry`; `setCollection` requires `IShapeCollection`; `setPointer` requires `IShapePositionResolver` or `IShapeAuctionHouse` for the respective slot.

## Types

`src/ShapeTypes.sol` declares the shared types:

```solidity
enum ShapeFormation { Fragment, Direct, Composed, Complete, Black }

struct ShapeState {
    bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; bool isBlack;
    ShapeFormation formation; uint256 faceValueWei; uint256 redeemableValueWei; bytes modules;
}

struct ShapeChildPreview {
    bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene;
    uint256 faceValueWei; bytes modules;
}

struct ComposeInputView {
    uint256 id; bytes32 seed; uint8 denominationIndex; uint32 originCount; uint8 inkGene; bytes modules;
}

struct ComposeRecordView {
    uint8 survivorDenominationIndex; uint32 survivorOriginCount; uint8 survivorInkGene;
    bytes survivorModules; uint256 ownerTokenFrom; ComposeInputView[] inputs;
}
```

`IShapes.Pointer` is `{ Positions, Market }`, passed to `setPointer` and `lockPointer` as `uint8` 0 or 1. `IShapes.ComposeCall` is `{ uint256 survivorId; uint256[] burnIds; }` for `composeMany`.

## Using the interfaces

Copy `IShapes.sol`, `ShapeTypes.sol`, `IERC721Value.sol` and `IAdminControl.sol` from the repository into your project (they import OpenZeppelin's `IERC721`), or declare a minimal interface with only the functions you call. The full ABI is in `deployments/1.json` and the [Contracts](/contracts) page.
