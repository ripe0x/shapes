# Composing

`compose` merges several Shapes into one. One input, the **survivor**, keeps its id and seed and becomes the summed denomination; the others are burned into it. No ETH moves and no fee is charged. Every compose is recorded and can be reversed exactly by [`decompose`](/docs/decomposing).

```solidity
function compose(uint256 survivorId, uint256[] calldata burnIds) external returns (uint256 outId);

struct ComposeCall { uint256 survivorId; uint256[] burnIds; }
function composeMany(ComposeCall[] calldata calls) external returns (uint256[] memory outIds);

function previewCompose(uint256 survivorId, uint256[] calldata burnIds) external view returns (ShapeState memory);
```

## Rules

Checked in this order:

1. `burnIds` is not empty, else `NoComposeInputs`.
2. The caller owns the survivor and it is live and not Black (`NotShapeOwner`, `TokenIsBlack`).
3. No id repeats in `burnIds`, else `DuplicateComposeInput(tokenId)`.
4. For each burn id: the caller owns it, it is live, it is not Black, and it is not the survivor (`CannotComposeWithSelf`).
5. The summed backing of the survivor and every input is a denomination, else `UnsupportedDenomination(sum)`.

Sums that work: five 0.01 into a 0.05, two 0.05 into a 0.1, ten 0.1 into a 1 (or five 0.1 and one 0.5), and so on. Any set whose total lands on the ladder works regardless of how it is partitioned. `outId` always equals `survivorId`.

## What the survivor becomes

| Field | After compose |
| --- | --- |
| Id and seed | Unchanged |
| Denomination | The ladder index of the summed backing |
| `originCount` | Survivor's plus every input's |
| Ink gene | A units-weighted walk from the survivor's gene toward the pooled inputs' mean |
| Modules | Sampled from the survivor's and inputs' effective modules and stored (`ModulesSampled`) |
| Formation | Recomputed from the new units and origins; a full set of origins makes it `Complete` |
| Compose depth | Plus one; the new record is on top of the stack |

Each burned input's full pre-compose state is stored in the record, including its modules, so decompose can restore it byte for byte. The record also notes whether an input held the owner token; if so ownership moves to the survivor and `OwnerTokenMoved(burnId, survivorId)` is emitted.

## Batching

`composeMany` runs each call in order under one reentrancy guard and one transaction. Because a survivor keeps its id, a later call can name a survivor an earlier call built. Each call pushes its own record; decomposing a tree pops them one at a time, newest first. An empty batch reverts `ZeroQuantity`. The batch is bounded by block gas, so size it accordingly.

## Preview

`previewCompose` returns the `ShapeState` the survivor would have, running the same checks in the same order except ownership. Simulate the real call (`eth_call` against `compose`) to learn whether a given account may execute it.

## Events

| Event | Count |
| --- | --- |
| `Transfer(owner, address(0), burnId)` | One per burned input |
| `ShapeAbsorbed(survivorId, burnId)` | One per burned input |
| `OwnerTokenMoved(burnId, survivorId)` | When an input was the owner token |
| `Composed(survivorId, burnIds, denomIndex, originCount)` | Once |
| `InkGene(survivorId, gene)` | Once |
| `ModulesSampled(survivorId, modules)` | Once |
| `MetadataUpdate(survivorId)` (ERC-4906) | Once |

## Gas

Each burned input adds roughly 52k gas for its reversible record (seed, packed fields and its module snapshot), on top of the burn and the sampling work, which builds a donor array over every input. A single compose with thousands of inputs is far past any block gas limit. Build large Shapes incrementally: compose into intermediate denominations, then compose those, with `composeMany` when the steps fit one transaction. Every step stays independently reversible.
