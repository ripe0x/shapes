# Reading state

Every protocol fact is readable from the Shapes address. Nothing requires a periphery contract. Reads that take a token id require a live token and revert for one that is not, except `exists`, `composeDepth` and `positionOf`, which never revert.

## One call for everything

```solidity
function shapeState(uint256 tokenId) external view returns (ShapeState memory);

struct ShapeState {
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    bool isBlack;
    ShapeFormation formation;     // 0 Fragment, 1 Direct, 2 Composed, 3 Complete, 4 Black
    uint256 faceValueWei;         // the denomination; unchanged by burnBacking
    uint256 redeemableValueWei;   // 0 for a Black Shape, else faceValueWei
    bytes modules;                // stored ModuleCodec bytes; empty when seed-derived
}
```

`previewCompose` returns the same struct for a hypothetical survivor.

## Per-token reads

| Function | Returns |
| --- | --- |
| `exists(tokenId)` | Whether the id is live now. Never reverts. True for a Black Shape |
| `ownerOf(tokenId)` | ERC-721 owner |
| `valueOf(tokenId)`, `backingOf(tokenId)` | Redeemable wei; 0 for Black |
| `denomIndexOf(tokenId)` | Ladder index 0 to 8; Black keeps 8 |
| `seedOf(tokenId)` | Immutable seed |
| `originCountOf(tokenId)` | Direct-mint origins credited |
| `inkGeneOf(tokenId)` | 0 to 6 |
| `formationOf(tokenId)`, `isComplete(tokenId)` | Formation class; see [Core concepts](/docs/concepts) |
| `isBlackShape(tokenId)` | Black flag |
| `modulesOf(tokenId)` | Stored module bytes only; empty for an original mint |
| `effectiveModulesOf(tokenId)` | Stored bytes, or the seed's grammar v1 expression |
| `composeDepth(tokenId)` | Reversible composes on the stack; 0 for a non-survivor |
| `composeRecordAt(tokenId, depth)` | One record; see [Decomposing](/docs/decomposing) |
| `splitOriginOf(tokenId)` | Split provenance; reverts `NotASplitChild` otherwise |
| `positionOf(tokenId)` | Address from the positions pointer, or zero; never reverts |
| `tokenURI(tokenId)`, `metadataJSON(tokenId)`, `svg(tokenId)`, `unicodeCard(tokenId)` | Presentation; see [Geometry and rendering](/docs/geometry) |

## Collection reads

| Function | Returns |
| --- | --- |
| `totalSupply()` | Live Shapes, Black included |
| `totalMinted()` | Next id to issue; one past the highest id ever issued |
| `redeemableBacking()` | ETH owed to live non-Black Shapes |
| `burnedBacking()` | ETH sent to `0x…dEaD` by `burnBacking`, cumulative |
| `blackShapeCount()` | Live Black Shapes |
| `pendingFees()`, `feesOwedTo(recipient)` | Accrued mint fees, outside the reserve |
| `mintFee()`, `mintStart()`, `feeRecipient()` | Mint parameters |
| `owner()`, `ownerToken()` | Owner token holder and id; `ownerToken` reverts `NoOwnerToken` once it is gone |
| `admin()`, `artist()`, `artistReleaseHash()`, `artistSignature()` | Roles and attestation |
| `renderer()`, `collection()`, `presentationLocked()` | Presentation pointers |
| `positions()`, `market()` | `(target, locked)` pointer pairs |
| `unit()`, `denominationCount()`, `denominationAt(i)`, `isSupportedDenomination(wei)` | Ladder |
| `contractURI()` | Collection metadata, from the collection contract |

`totalMinted` is not a mint count: split children advance it, decompose restores do not, and burns never lower it. Use `totalSupply` for the live count and the events for history.

## Simulating a write

`previewCompose` and `previewSplit` return outcomes without checking ownership. To learn whether an account may perform an operation, `eth_call` the mutating function from that account and decode the revert. Every error is a custom error listed on [Errors](/docs/errors).

## Reading many tokens

Reads are plain `view` calls, so Multicall3 batches them. For a gallery or a feed, prefer the [Indexer](/docs/indexer), which serves token rows, lineage edges and an activity feed without an RPC per token.

## Interface ids

`supportsInterface` answers true for ERC-721, ERC-721 Metadata, ERC-2981 (zero royalty), ERC-4906, `IERC721Value`, `IAdminControl`, `IShapes`, `IShapeValue`, `IShapeRecomposition` and `IShapeProvenance`. The ids are on [Interfaces](/docs/interfaces).
