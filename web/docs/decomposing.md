# Decomposing

`decompose` reverses the survivor's most recent compose. The survivor keeps its id and seed and returns to its pre-compose denomination, origin count, ink gene and modules; every input that compose burned is re-minted under its original id and seed, with its original state. No ETH moves and no fee is charged.

```solidity
function decompose(uint256 survivorId) external returns (uint256[] memory restoredIds);
function decomposeTo(uint256 survivorId, address recipient) external returns (uint256[] memory restoredIds);
function decomposeMany(uint256[] calldata survivorIds) external returns (uint256[][] memory restoredIds);
function decomposeManyTo(uint256[] calldata survivorIds, address recipient) external returns (uint256[][] memory restoredIds);

function composeDepth(uint256 survivorId) external view returns (uint256);
function composeRecordAt(uint256 survivorId, uint256 depth) external view returns (ComposeRecordView memory);
```

## Rules

- The caller owns the survivor, it is live, and it is not Black. Ownership is checked at call time, so whoever holds the survivor now can decompose it, whoever composed it.
- The survivor's compose stack is not empty, else `NoComposeRecord(survivorId)`. `composeDepth(survivorId)` is the number of reversals still available.
- Stacked composes reverse newest first. Decompose twice to unwind two composes.
- Restored inputs go to the caller, or to `recipient` with `decomposeTo`, through `_safeMint`. A contract recipient needs `IERC721Receiver`.
- If the reversed compose had moved collection ownership from one of its inputs, ownership returns to that input and its new holder becomes `owner()`.

## What is restored

The survivor's `denomIndex`, `originCount`, `inkGene` and stored modules are set back to the values recorded before that compose. Each input returns with its original seed, denomination, origins, gene and modules, and with its own compose stack intact if it had one, so a nested tree unwinds level by level.

A survivor that was transferred, composed again, or used as a donor since the compose is handled by the rules above: a later compose sits on top of the stack and must be reversed first; a survivor that was itself burned into another Shape, split or redeemed no longer exists, so its records are unreachable and the call reverts.

## Batching

`decomposeMany` pops one record per listed id, in order. Repeat an id to pop stacked records. To unwind a tree, list the parent before its restored children, since a child cannot be named until the parent's decompose has re-minted it. An empty array reverts `ZeroQuantity`.

## Inspecting the stack

`composeRecordAt(survivorId, depth)` returns the record at `depth`, with 0 the oldest and `composeDepth - 1` the one `decompose` will reverse next. It reverts `ComposeRecordOutOfRange` past the top. The record holds the survivor's pre-compose state and one entry per burned input:

```solidity
struct ComposeRecordView {
    uint8 survivorDenominationIndex;
    uint32 survivorOriginCount;
    uint8 survivorInkGene;
    bytes survivorModules;      // empty when the survivor's geometry was seed-derived
    uint256 ownerTokenFrom;     // input that held collection ownership, or type(uint256).max
    ComposeInputView[] inputs;  // id, seed, denominationIndex, originCount, inkGene, modules
}
```

This is enough to reproduce the survivor's post-compose geometry offchain and to render every burned input while it is dead.

## Events

| Event | Count |
| --- | --- |
| `Transfer(address(0), recipient, restoredId)` | One per restored input |
| `Decomposed(survivorId, restoredIds, survivorDenomIndex, survivorOriginCount)` | Once |
| `InkGene(survivorId, gene)` and `ModulesSampled(survivorId, modules)` | Once each |
| `InkGene(restoredId, gene)`, `ShapeRevived(survivorId, restoredId)`, `ModulesSampled(restoredId, modules)` | One each per restored input |
| `OwnerTokenMoved(survivorId, inputId)` | When ownership returns to an input |
| `MetadataUpdate(survivorId)` (ERC-4906) | Once |

Restored inputs do not emit `ShapeMinted`. An indexer that treats `Transfer` from zero as a mint must special-case ids that appear in `ShapeRevived` and `ShapeFragmentCreated`.
