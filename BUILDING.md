# Building on Shapes

Shapes is an ERC721 whose tokens wrap exact ETH. It is designed to be built on: other contracts
can read a Shape's state, accept it as payment, unwrap it, and reshape it, through a stable
capability-segmented interface. This document is for those contracts.

Authoritative behaviour is in [SPEC.md](SPEC.md); the threat model is in [SECURITY.md](SECURITY.md);
the metadata is in [METADATA.md](METADATA.md). This file is the integrator's view.

## The one property that matters: a hard peg

A Shape's redemption value is its denomination, and nothing else. A 0.1 ETH Shape redeems for
exactly 0.1 ETH, for its entire lifetime, no matter what it looks like or who has held it. There is
no floor price, no floating value, no oracle.

That makes a Shape a clean unit of account. "Accept a 0.1 ETH Shape" means "accept 0.1 ETH,"
provably, with no price feed. This is the property to lead with when building anything that treats
Shapes as currency, collateral, or a fee.

The nine denominations are fixed and permanent: 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100 ETH.

## Discovering what a Shapes deployment supports

Capabilities are advertised through ERC165, so a contract can depend on exactly the slice it needs
and verify it at runtime:

```solidity
shapes.supportsInterface(type(IShapeValue).interfaceId);         // read state + redeem
shapes.supportsInterface(type(IShapeRecomposition).interfaceId); // compose / decompose / split
shapes.supportsInterface(type(IShapeProvenance).interfaceId);    // seeds, origins, formation
shapes.supportsInterface(type(IShapeSimulation).interfaceId);    // deterministic previews
renderer.supportsInterface(type(IShapeGeometry).interfaceId);    // module-level geometry
```

The interfaces are declared in [src/interfaces/IShapeCapabilities.sol](src/interfaces/IShapeCapabilities.sol)
and [src/interfaces/IShapeGeometry.sol](src/interfaces/IShapeGeometry.sol).

## Reading a Shape

`shapeState` returns everything about a live Shape in one call:

```solidity
struct ShapeState {
    bytes32 seed;
    uint8 denominationIndex;
    uint32 originCount;
    uint8 inkGene;
    bool isBlack;
    ShapeFormation formation;   // Fragment | Direct | Composed | Complete | Black (stable enum)
    uint256 faceValueWei;       // the denomination; survives sacrifice
    uint256 redeemableValueWei; // 0 for a Black Shape, otherwise equals faceValueWei
}
```

For a payment check, `redeemableValueWei` is the number to trust: it is the ETH you will actually
receive on redemption, and it is 0 for a Black (sacrificed) Shape.

## Accepting a Shape as payment

Because the value is pegged, a contract can take a Shape as a fee with no oracle. Two shapes of the
same denomination are interchangeable at the value layer, so accept any Shape whose
`redeemableValueWei` meets your price.

The user approves your contract for their Shape first (standard ERC721 `approve` or
`setApprovalForAll`). Then, in one transaction:

```solidity
// SomeMint charges a 0.1 ETH Shape as its mint fee.
function mint(uint256 shapeId) external {
    ShapeState memory s = shapes.shapeState(shapeId);
    require(s.redeemableValueWei == 0.1 ether, "wrong denomination");

    shapes.transferFrom(msg.sender, address(this), shapeId); // pull the fee
    shapes.redeemTo(shapeId, payable(treasury));             // unwrap: ETH to treasury, same tx

    _mintTo(msg.sender);
}
```

`redeemTo` is the primitive that makes this clean: your contract never custodies the ETH and there
is no second transfer. Alternatively, skip the redeem and hold the Shape itself as the fee, then
unwrap it later.

## The recipient-directed value flows

Every value-moving action has a variant that delivers its output to an address you name, so a
contract can act and route in one atomic call instead of bouncing the asset through itself:

| Function | Effect |
|---|---|
| `redeemTo(id, recipient)` | Burn one Shape, send its ETH to `recipient`. |
| `redeemBatchTo(ids, recipient)` | Burn several, send the total to `recipient` once. |
| `decomposeTo(id, outDenoms, recipient)` | Split a Shape one or more tiers down, mint the children to `recipient`. |

The caller must own the token (or its inputs). These are thin wrappers over the same
checks-effects-interactions logic as the owner-directed `redeem` / `decompose` / `split`; only the
destination differs. They move no ETH that redemption does not already move, and the reserve
invariant is fuzzed against reverting, non-receiving and reentrant recipients (SECURITY.md).

## Previewing before you act

Compose and decompose outcomes are deterministic and previewable off-chain and on-chain, so a UI or
a contract can show or verify a result before committing:

```solidity
shapes.previewCompose(survivorId, burnIds);   // returns the full ShapeState the compose would yield
shapes.previewDecompose(tokenId, outDenoms);  // returns a ShapeChildPreview[] for the children
```

These are `view` and require no ownership.

## What to know before you rely on it

- **Approval is trust.** For your contract to take a Shape, the user approves it, and an approved
  operator can always move a Shape to itself and redeem it. Approving a contract for a Shape is
  economically equivalent to handing over that Shape's full ETH value (SECURITY.md #8). Ask for the
  minimum approval the flow needs.
- **The value layer is denomination-only.** Artwork, ink gene and provenance carry no redemption
  value. Do not price a Shape by its traits; price it by `redeemableValueWei`.
- **Redemption is owner-only, and pays out with a real call.** A recipient that reverts on ETH
  receipt reverts the redemption; it cannot corrupt anyone else's balance. Reentrancy is guarded.
- **Everything is immutable.** No admin can move the reserve, change denominations, or alter
  redemption. The only owner power is replacing the cosmetic renderer until it is locked. Build
  against behaviour that cannot change under you.
- **Black Shapes are non-redeemable by design.** `redeemableValueWei` is 0 and `isBlack` is true;
  never accept one as payment.
- **Give value-moving calls gas headroom over the bare estimate.** Every state-changing function
  runs behind a reentrancy guard whose storage slot is reset at the end of the call, earning a gas
  refund. `eth_estimateGas` reports the amount net of that refund, which is slightly below the gas
  the execution actually needs mid-flight, so a call funded with exactly the raw estimate can revert
  out of gas at the guard cleanup. Wallets add a buffer for this automatically; a contract or script
  that forwards a hard gas limit must add its own headroom (a small multiplier on the estimate is
  enough).
