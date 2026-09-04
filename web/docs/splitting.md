# Splitting

`split` breaks one Shape into several. The input is burned and each output is a fresh token whose seed derives from the input's seed. No ETH moves and no fee is charged. A split is final: there is no inverse, though the children can be composed into a new survivor.

```solidity
function split(uint256 tokenId, uint8[] calldata outDenoms) external returns (uint256[] memory newIds);
function splitTo(uint256 tokenId, uint8[] calldata outDenoms, address recipient) external returns (uint256[] memory newIds);

function previewSplit(uint256 tokenId, uint8[] calldata outDenoms) external view returns (ShapeChildPreview[] memory children);
function childSeed(bytes32 parentSeed, uint256 childIndex) external pure returns (bytes32);
function splitOriginOf(uint256 childId) external view returns (
    bytes32 parentSeed, uint256 parentId, uint8 parentDenomIndex, uint8 originDenomIndex,
    uint8 parentInkGene, bytes memory parentModules, uint256 childIndex);
```

## Rules

- The caller owns the input, it is live, and it is not Black.
- `outDenoms` are ladder indices (0 to 8), not wei. At least two, else `SplitTooFewOutputs`. An index above 8 reverts.
- The outputs' backing must sum exactly to the input's backing, else `SplitSumMismatch(inputBacking, outputSum)`. A 1 ETH Shape can become `[3,3]` (two 0.5), `[2,2,2,2,2,2,2,2,2,2]` (ten 0.1), `[3,2,2,2,2,2]`, or up to 100 units of index 0.
- Children go to the caller, or to `recipient` with `splitTo`, through `_safeMint`.
- If the input is the owner token, ownership moves to the first child.

## What the children are

Children take consecutive ids from `totalMinted()` in `outDenoms` order. For child `i`:

| Field | Value |
| --- | --- |
| Id | `totalMinted() + i` at execution time |
| Seed | `childSeed(parentSeed, i)` = `keccak256(abi.encodePacked(parentSeed, i))` |
| Denomination | `outDenoms[i]` |
| `originCount` | The parent's origins, filled into each child up to its unit capacity, in order, until exhausted |
| Ink gene | Copied from the parent |
| Modules | Sampled from the parent's effective modules and stored (`ModulesSampled`) |
| Compose depth | 0 |

The origin fill means a Complete parent yields Complete children, and a parent with few origins front-loads them: a 0.1 ETH Shape with 3 origins split `[0,0,0,0,0,0,0,0,0,0]` gives three `Direct` children and seven `Fragment` children.

The parent's compose records are left in place but unreachable, since the parent no longer exists. Every child starts with an empty stack.

## Provenance

Each child keeps a permanent reference to its split. `splitOriginOf(childId)` returns the parent's id, seed, denomination index, ink gene and effective modules at split time, the **origin denomination**, and the child's index. The origin denomination is the root split ancestor's denomination: a child of a child of a 10 ETH Shape reports `originDenomIndex == 6` however many splits down it is. The entry survives the child's later compose or split. It reverts `NotASplitChild` for an original mint and for an input re-minted by decompose.

The metadata surfaces these as the `Split From` and `Split Origin` traits.

## Preview

`previewSplit(tokenId, outDenoms)` returns one `ShapeChildPreview` per output: seed, denomination index, origin count, ink gene, face value and the exact module bytes `split` would store. It runs every check except ownership. It does not predict ids, which depend on `totalMinted()` when the split executes.

## Events

| Event | Count |
| --- | --- |
| `Transfer(owner, address(0), tokenId)` | Once, the burned input |
| `OwnerTokenMoved(tokenId, firstChildId)` | When the input was the owner token |
| `Transfer(address(0), recipient, childId)` | One per child |
| `Split(tokenId, parentSeed, newIds, outDenoms, originCounts)` | Once |
| `InkGene(childId, gene)`, `ShapeFragmentCreated(tokenId, childId, parentSeed, childIndex)`, `ModulesSampled(childId, modules)` | One each per child |

Children do not emit `ShapeMinted`.
