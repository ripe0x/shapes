# Shape Packs — design

A wrapper collection that lets anyone bundle Shapes into a single sealed ERC-721, at any makeup
they choose, from Shapes they already hold, from ETH, or both. Built as a new collection in a new
repository, `shape-packs`, against the deployed mainnet `Shapes` at
`0x6fe9193276bf7abcbee44ab7afd717d637d6faf0`. Shapes itself is not modified.

This document is the design. It records what a pack is, how it is created and exited, what the
contract may never do, how it renders, how the repository is laid out, and the decisions still open.

---

## 1. What a pack is

A **Shape Pack** is an ERC-721 token in the `ShapePacks` collection that custodies a fixed set of
live, non-Black Shapes. The pack contract holds the Shapes; the pack token is the claim on them.

- **Sealed.** The contents are fixed at creation and never change while the pack is live. There is
  no add, no remove, no swap. A buyer of a pack on a marketplace gets exactly the Shapes the
  metadata lists.
- **Exact value.** A pack's value is the sum of its Shapes' redeemable backing, read live from
  `Shapes.backingOf`. Since the contents cannot change and a packed Shape cannot be made Black (see
  §6), that sum is constant for the pack's whole life.
- **Minimum value: 0.03 ETH.** Expressed as `3 * shapes.unit()` so the same build is correct on
  Sepolia's 1/100 ladder (0.0003 ETH there). 0.03 is not itself a denomination, so the smallest
  packs are three 0.01 Shapes, or one 0.05, or 0.01 + 0.05, and so on.
- **Two exits, both all-or-nothing.** `open` burns the pack and hands the Shapes to the holder.
  `redeem` burns the pack and unwraps every Shape to ETH in one transfer. There is no partial exit.
- **ERC-8060 value-bearing.** `ShapePacks` implements the same draft `IERC721Value` surface Shapes
  does: `valueOf(packId)` and `burn(packId)`. Anything that already prices a Shape by `valueOf`
  can price a pack the same way.
- **Transparent.** A pack is not a blind box. Contents are readable onchain from the moment the
  pack exists, and Shape seeds are block-derived and public. A blind-pack product would need a
  commit-reveal layer and is out of scope here.

### Why not something else

| Alternative | Why not |
| --- | --- |
| ERC-6551 token-bound account per pack | Contents would be mutable by the holder at any time, so "pack" would mean nothing to a buyer; adds a registry dependency; metadata would need an indexer to enumerate. |
| `compose` into one Shape | That is a different object (one id, one seed, ladder sums only) and Shapes already offers it. A pack keeps every Shape's identity and allows any mix. |
| ERC-1155 "pack types" | Packs with identical makeup still hold distinct Shapes with distinct seeds and provenance. Each pack is unique. |
| Custody inside `Shapes` | Shapes deliberately never freezes, escrows or wraps tokens (README, SPEC D-29). The wrapper lives outside. |

The custody pattern is the one `ShapeCardEscrow` already uses and the adversarial review already
examined: pull with `transferFrom`, mint into self through a narrow `onERC721Received` window, push
out with `transferFrom`, clear state before every external call.

---

## 2. Creating a pack

One entrypoint covers every case: existing Shapes, ETH, or a mix.

```solidity
/// @param shapeIds  Shapes the caller already owns. Pulled with transferFrom; caller must have
///                  approved ShapePacks for each (or setApprovalForAll).
/// @param mintCounts One entry per ladder index (length == shapes.denominationCount()). Entry d
///                  is how many Shapes of denomination d to mint fresh into the pack.
/// @param to        Recipient of the pack token.
function createPackTo(uint256[] calldata shapeIds, uint32[] calldata mintCounts, address to)
    external payable returns (uint256 packId);

function createPack(uint256[] calldata shapeIds, uint32[] calldata mintCounts)
    external payable returns (uint256 packId); // to == msg.sender
```

The user determines the makeup of the minted portion directly: `mintCounts` is the makeup. The
"ETH amount input" is `msg.value`, which must equal exactly what that makeup costs:

```
msg.value == Σ_d mintCounts[d] * (shapes.denominationAt(d) + shapes.mintFee())
```

Over and under both revert `IncorrectPayment(expected, provided)`, matching Shapes. Each minted
Shape pays Shapes' flat per-Shape mint fee (0.001 ETH on mainnet today), which accrues to Shapes'
fee recipient as it would for any mint. `ShapePacks` adds no fee of its own (open decision §9.1).

A UI that starts from an ETH amount lets the user allocate it across the nine denominations and
passes the allocation as `mintCounts`. Two views support that:

```solidity
/// Cost breakdown for a makeup, read live.
function quoteMint(uint32[] calldata mintCounts) external view
    returns (uint256 backingWei, uint256 feeWei, uint256 totalWei, uint256 shapeCount);

/// Fewest-Shapes makeup for a backing amount (largest denomination first), as a prefill.
/// Reverts if backingWei is not a whole number of units.
function defaultMakeup(uint256 backingWei) external view returns (uint32[] memory mintCounts);
```

### Rules, checked in this order

1. `shapeIds.length + Σ mintCounts >= 1`, else `EmptyPack()`.
2. `shapeIds.length + Σ mintCounts <= MAX_SHAPES_PER_PACK`, else `TooManyShapes(count)`.
3. `mintCounts.length == shapes.denominationCount()`, else `MakeupLengthMismatch()`.
4. Payment is exact for the makeup, else `IncorrectPayment`. With no mints, `msg.value` must be 0.
5. For each `shapeIds[i]`: `shapes.backingOf(id)` (reverts if not live) is nonzero, else
   `WorthlessShape(id)`. This is how a Black Shape is refused: it keeps denomination index 8 but
   has zero backing, so the pack values by backing, never by denomination. Then
   `transferFrom(msg.sender, this, id)`. A repeated id fails on its own: the second pull finds the
   caller no longer owns it.
6. Mint each nonzero `mintCounts[d]` with one `mintBatchTo{value: count * (amount + fee)}(amount,
   count, address(this))`, taking the ids from the returned `firstTokenId`. The receiver window
   `_minting` is open only across each mint call, exactly as in `ShapeCardEscrow`.
7. Total backing `>= MIN_PACK_VALUE`, else `PackBelowMinimum(valueWei, MIN_PACK_VALUE)`.
8. Record `packId => shapeIds` and `shapeId => packId`, then `_safeMint(to, packId)` last.

Pack ids start at 1 and are never reissued, so `packOf(shapeId) == 0` means "not packed".

### Events

```solidity
event PackCreated(
    uint256 indexed packId, address indexed creator, address indexed to,
    uint256[] shapeIds, uint256 pulledCount, uint256 valueWei
);
```

`shapeIds` lists pulled Shapes first, then minted ones, so `pulledCount` splits them. The minted
Shapes also emit Shapes' own `ShapeMinted`, `InkGene` and `Transfer` events, with `to` equal to
the pack contract.

### Timing

Mint-from-ETH packs depend on Shapes' `mintStart` having passed (it has: mainnet opened
2026-09-03). Pulled-only packs never did.

---

## 3. Exiting a pack

All four are owner-only. An approved operator can transfer a pack but cannot open or redeem it,
the same rule Shapes applies to `redeem` and `burn`.

```solidity
function open(uint256 packId) external;                              // Shapes to msg.sender
function openTo(uint256 packId, address to) external;                // Shapes to `to`
function redeem(uint256 packId) external;                            // ETH to msg.sender
function redeemTo(uint256 packId, address payable recipient) external; // ETH to `recipient`
function burn(uint256 packId) external;                              // IERC721Value: == redeem
```

**open:** burn the pack token, delete the contents record and every `packOf` entry, then
`transferFrom(this, to, id)` for each Shape. State is cleared before the first transfer. Plain
`transferFrom` is used, as in the escrow: `to` is chosen by the owner, and a hook-less push cannot
be griefed by a recipient. Emits `PackOpened(packId, owner, to, shapeIds)`.

**redeem:** burn the pack token, clear state, then one call to
`shapes.redeemBatchTo(shapeIds, recipient)`. Shapes burns every Shape and makes a single ETH
transfer to `recipient`; the pack contract never touches the ETH. If the recipient rejects ETH the
whole transaction reverts and the pack survives untouched. Emits
`PackRedeemed(packId, owner, recipient, valueWei)`.

`burn` exists for ERC-8060 parity. No pack can ever hold zero value (Black Shapes are refused at
the door and cannot be made inside), so `burn` always pays and is identical to `redeem`.

---

## 4. Reading a pack

```solidity
function contentsOf(uint256 packId) external view returns (uint256[] memory shapeIds);
function valueOf(uint256 packId) external view returns (uint256 wei_);      // Σ backingOf; reverts if not live
function packOf(uint256 shapeId) external view returns (uint256 packId);    // 0 when not packed
function makeupOf(uint256 packId) external view returns (uint32[] memory counts); // per ladder index
function packState(uint256 packId) external view returns (PackState memory);

struct PackState {
    uint256[] shapeIds;
    uint32[]  counts;        // per ladder index
    uint256   valueWei;
    uint16    pulledCount;   // how many came from the creator's wallet; the rest were minted
    uint64    createdAt;
}

function MIN_PACK_VALUE() external view returns (uint256);   // immutable, 3 * shapes.unit()
function MAX_SHAPES_PER_PACK() external pure returns (uint256);
function shapes() external view returns (address);
function totalMinted() external view returns (uint256);      // next pack id - 1
function totalSupply() external view returns (uint256);      // live packs
```

### Positions hook

`ShapePacks` also answers `IShapePositionResolver`:

```solidity
function positionOf(uint256 shapeId) external view returns (address); // address(this) if packed, else 0
```

That costs one storage slot per packed Shape (the `packOf` map, which `open` clears) and lets the
site, or `Shapes.positionOf` if the Shapes admin ever points the positions pointer at it or at an
aggregator that includes it, say "this Shape is inside Pack #N". Registering it is a separate
Shapes-admin decision and is not required for packs to work (§9.5).

---

## 5. ERC-165

`ShapePacks.supportsInterface` answers `IERC165`, `IERC721`, `IERC721Metadata`, `IERC2981`
(`royaltyInfo` returns zero, as Shapes does), ERC-4906, `IERC721Value`, `IShapePositionResolver`,
`IAdminControl`-style presentation admin (see §7), and `IShapePacks`.

The auction house accepts any ERC-721 as a lot, so a pack can be listed in `ShapeAuctionHouse`
with no changes there: bidders pay in Shapes for a sealed bundle of Shapes.

---

## 6. Trust model and invariants

The pack contract holds other people's claims on ETH, so it inherits Shapes' posture: no path
reaches custody except the holder's own exit.

**What the contract never does**

- Call `compose`, `decompose`, `split`, `burnBacking`, `approve` or `setApprovalForAll` on Shapes.
  Nothing in the contract can change what a packed Shape is or who may move it.
- Hold ETH. Creation forwards `msg.value` exactly into Shapes mints; redemption pays the recipient
  directly from Shapes. `receive` and `fallback` revert `DirectDepositRejected`, as on Shapes.
- Accept an unsolicited Shape. `onERC721Received` returns the selector only when `msg.sender ==
  shapes`, `_minting` is set, and `from == address(0)`. A `safeTransferFrom` into the contract
  reverts `UnsolicitedToken`.
- Expose an admin path into custody. There is no pause, no recovery, no upgrade, no allowlist.

**Why contents are frozen by construction.** Every Shapes mutator (`redeem`, `burn`, `compose`,
`decompose`, `split`, `burnBacking`) checks `msg.sender == ownerOf`. While packed, `ownerOf` is the
pack contract, which never calls any of them. No third party can act on a packed Shape, and a
packed Shape cannot become Black. A packed Shape's compose stack therefore cannot be unwound while
packed; after `open` its new holder can.

**Invariants** (stateful fuzz, modelled on `test/Invariants.t.sol` here):

```
I1  for every live pack p, for every id in contentsOf(p):
        shapes.ownerOf(id) == address(packs)  and  packOf(id) == p
I2  for every live pack p:
        valueOf(p) == Σ backingOf(id)  and  valueOf(p) >= MIN_PACK_VALUE
I3  contentsOf(p) is identical at every observation while p is live
I4  address(packs).balance == 0  (ETH can still be forced in; it is stranded, never reachable)
I5  every Shape owned by address(packs) is in exactly one live pack's contents,
        except Shapes pushed in by plain transferFrom (see below)
I6  a burned pack id is never reissued; totalMinted only grows
```

**Accepted, not fixed: Shapes pushed in by plain `transferFrom`.** The same finding and the same
resolution as the auction house (SECURITY.md, "Assets sent to the auction house unasked"). A
hook-less transfer cannot be refused by any contract. Such a Shape sits in the contract with no
pack naming it and no way out. A recovery function would be an administrative path into everyone
else's packs. The loss is self-inflicted and confined to the pusher. Documented, not patched.

**Approval is trust.** Approving `ShapePacks` for a Shape lets it pull that Shape into a pack
created by the approver. It cannot pull it into anyone else's pack: `createPack` transfers
`from == msg.sender`, so a caller can only pack Shapes they themselves own. For the pack token, an
approved operator can transfer it to itself and then open it, exactly as with a Shape. Ask for
per-token approval in the UI, not `setApprovalForAll`, where the flow allows.

**Reentrancy.** `createPack*`, `open*`, `redeem*` and `burn` are `nonReentrant` and follow
checks-effects-interactions. The only external calls are to Shapes (trusted, itself guarded) and
the two the owner directs: the pack token's `_safeMint` receiver hook on creation, and the ETH
payout on redeem, both after state is final.

**Owner token.** If Shape #0 (or whichever Shape currently carries collection ownership) is packed,
`Shapes.owner()` returns the pack contract until the pack is opened. Ownership is attribution only
and grants nothing, so this is allowed and documented rather than refused.

**Fee race.** `mintFee` is admin-adjustable on Shapes up to `unit()`. Exact payment means a fee
change between quote and inclusion reverts the creation rather than silently overcharging or
stranding ETH. The UI reads `quoteMint` and simulates in the same block.

---

## 7. Presentation

Metadata follows the Shapes pattern: a replaceable renderer behind a lockable presentation admin,
with no authority over custody.

- `admin()`, `transferAdmin`, `renounceAdmin` (reuse the `IAdminControl` names, minus the fee
  setters, which do not exist here).
- `setRenderer(address)` requires code answering ERC-165 for `IShapePackRenderer`.
  `lockPresentation()` freezes it permanently. Both emit ERC-4906 `BatchMetadataUpdate` and
  ERC-7572 `ContractURIUpdated` so marketplaces re-read.
- `setMetadataCopy(namePrefix, description)` with the same `CopyValidation`-style JSON-safety
  bounds Shapes uses, frozen by the same lock.

`tokenURI(packId)` is a base64 `data:application/json` URI, image a base64 `data:image/svg+xml`,
fully onchain, no fonts, black and white, same as a Shape.

**Image.** A stack. The pack contract gathers `shapeState` for its contents and reads Shapes'
current `renderer()` live, so pack art tracks whatever renderer Shapes presents. The renderer
draws the top `k` cards (proposed `k = 3`) through `renderSVG` / `renderSVGSampled` (sampled when
`modules` is nonempty), fanned with a small offset, and the remaining cards as plain black
rounded card backs behind them. The canvas is square with the stack inset, rounded and shadowed,
matching `ShapeCollection.imageFor`. Drawing every card of a 100-Shape pack in one `tokenURI` is
not attempted: `k` bounds the renderer calls so the view stays cheap for marketplaces and the
indexer.

**Name and description.** `Shape Pack 12`. Description: the shared editable copy, followed by the
makeup in words: `3 × 0.01 ETH, 1 × 0.05 ETH. 0.08 ETH total.` built with Shapes' canonical
decimal formatter conventions (no trailing zeros).

**Attributes.**

| trait_type | value | Notes |
| --- | --- | --- |
| `Shapes` | number | count of Shapes inside |
| `Value` | `"0.08 ETH"` | exact, from `valueOf` |
| `Units` | number, `display_type: number` | value in `unit()`s, for numeric filtering |
| `0.01 ETH` … `100 ETH` | number | one row per denomination with a nonzero count |
| `Source` | `Minted` / `Packed` / `Mixed` | all minted by the pack, all pulled, or both |
| `Sealed` | `Yes` | always, for a live pack |

`contractURI` is the collection name, the shared description and a seeded stack image, following
`ShapeCollection.json`.

---

## 8. Repository: `ripe0x/shape-packs`

Foundry, `solc 0.8.28`, `evm_version = cancun`, `via_ir`, OpenZeppelin and forge-std as in
Shapes. The Shapes repository is a pinned git submodule so the interfaces, types and, for tests,
the full token compile from source.

```
src/
  ShapePacks.sol               ERC721 + custody + create/open/redeem + views + presentation admin
  ShapePackRenderer.sol        the stack image, metadata JSON, contractURI
  interfaces/
    IShapePacks.sol            every function, event and error above
    IShapePackRenderer.sol     renderPack(PackRenderInputs), tokenURI(...), contractURI(...)
lib/
  forge-std/
  openzeppelin-contracts/
  shapes/                      git submodule, pinned to the deployed mainnet commit
script/
  Deploy.s.sol                 one script, chain-id gated like Shapes': anvil, sepolia, mainnet
  deploy.sh                    the wrapper; reads script/env/<target>.env, verifies, writes deployments/<chainId>.json
  env/{anvil,sepolia,mainnet}.env   SHAPES address per chain; nothing secret
test/
  Create.t.sol                 every creation rule and error, pulled / minted / mixed, exact payment
  Exit.t.sol                   open, openTo, redeem, redeemTo, burn; owner-only; CEI; reverting recipient
  Receiver.t.sol               onERC721Received window; unsolicited safeTransferFrom refused; stray transferFrom documented
  Metadata.t.sol               JSON validity, attributes, k-card cap, renderer swap and lock
  Invariants.t.sol             I1–I6 under fuzzed create/open/redeem/transfer/forced-ETH sequences
  GasCeilings.t.sol            create/open/redeem at MAX_SHAPES_PER_PACK fit a block with margin
  Fork.t.sol                   env-gated: the whole lifecycle against mainnet Shapes 0x6fe9…
  utils/DeployShapes.sol       deploys Shapes + renderer + collection from the submodule for local tests
foundry.toml                   remappings: shapes/=lib/shapes/src/  ladder/=lib/shapes/ladders/mainnet/
README.md                      what a pack is, how to create/open/redeem, the trust model summary
SECURITY.md                    the accepted residuals (stray transferFrom, approval is trust, fee race)
```

Notes on the layout:

- `ShapePacks` is ladder-agnostic. It reads `unit()`, `denominationCount()`, `denominationAt(d)`
  and `mintFee()` from Shapes live, so one build deploys to mainnet and Sepolia. Only the tests that
  deploy Shapes locally need the `ladder/` remapping; a `testnet` profile mirrors Shapes' for the
  Sepolia ladder.
- `MAX_SHAPES_PER_PACK` is a compile-time constant set by measurement in `GasCeilings.t.sol`:
  the gate is that `open` and `redeem` at the cap fit comfortably in a mainnet block. Proposed
  starting value: 100, enough for a 1 ETH pack of 0.01s. Lower it if the measurement says so.
- No linked libraries are expected; the contract is small. If the renderer grows, it is already a
  separate deploy.
- CI mirrors the Shapes `contracts` job: `forge fmt --check`, `forge build --sizes`, `forge test`,
  both profiles, plus the fork test when the RPC secret is present.

### Deployment

`Deploy.s.sol` deploys `ShapePackRenderer`, then `ShapePacks(shapes, renderer, admin)`, reads
back `shapes()`, `MIN_PACK_VALUE()` (asserting `3 * unit()`), `renderer()` and `admin()`, verifies
on Etherscan, and writes `deployments/<chainId>.json`. Sepolia first against the Sepolia Shapes,
then mainnet against `0x6fe9…faf0`. Presentation is left unlocked at launch, as Shapes' was, and
locked once the art is final.

### Site and indexer

Out of this document's contract scope, noted for planning:

- A pack builder page: pick existing Shapes from the wallet and/or allocate an ETH amount across
  the nine denominations, see `quoteMint` live, create. A pack page: the stack, the contents as
  cards, value, open and redeem.
- The Ponder indexer gains the `ShapePacks` ABI and three events. The existing Shapes indexer
  already sees the `Transfer`s into and out of the pack contract; `packOf` makes the join exact.

---

## 9. Open decisions

Each has a recommendation; none blocks starting the repository.

1. **Pack-level fee.** Recommended: none. The minted portion already pays Shapes' per-Shape fee to
   the Shapes fee recipient, and a fee-less wrapper is the simpler trust story. If revenue is
   wanted, the Shapes pattern (flat per-pack fee, compile-time cap, per-recipient accrual,
   permissionless `withdrawFees`) ports directly.
2. **Minimum Shape count.** The brief specifies a value floor only, so a single 0.05 ETH Shape is a
   valid pack. Recommended: keep it that way. Requiring two or more Shapes is a one-line change if
   a one-Shape "pack" feels wrong.
3. **`MAX_SHAPES_PER_PACK`.** Proposed 100, to be confirmed by the gas ceiling test.
4. **Rendered cards per pack image.** Proposed `k = 3` on top of plain card backs. A full grid of
   every card is possible for small packs but makes `tokenURI` cost scale with contents.
5. **Positions pointer.** `ShapePacks` will answer `IShapePositionResolver` regardless. Whether the
   Shapes admin points `positions()` at it, or waits for the exchange-option layer (D-29) and an
   aggregator, is a separate Shapes decision.
6. **Name and symbol.** Proposed `Shape Packs` / `PACK`, token name `Shape Pack N`.
7. **Top-ups.** Deliberately excluded. A pack that can grow is no longer a fixed object to a buyer,
   and metadata and `PackCreated` would stop describing it. Anyone who wants a bigger pack opens
   and re-packs.

---

## Appendix: `IShapePacks` sketch

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Value} from "shapes/interfaces/IERC721Value.sol";
import {IShapePositionResolver} from "shapes/interfaces/IShapePositionResolver.sol";

struct PackState {
    uint256[] shapeIds;
    uint32[] counts;
    uint256 valueWei;
    uint16 pulledCount;
    uint64 createdAt;
}

interface IShapePacks is IERC721, IERC721Value, IShapePositionResolver {
    event PackCreated(
        uint256 indexed packId, address indexed creator, address indexed to,
        uint256[] shapeIds, uint256 pulledCount, uint256 valueWei
    );
    event PackOpened(uint256 indexed packId, address indexed owner, address indexed to, uint256[] shapeIds);
    event PackRedeemed(uint256 indexed packId, address indexed owner, address indexed recipient, uint256 valueWei);
    event RendererUpdated(address indexed renderer);
    event PresentationLocked(address indexed renderer);
    event MetadataCopySet(string namePrefix, string description);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error EmptyPack();
    error TooManyShapes(uint256 count);
    error MakeupLengthMismatch();
    error IncorrectPayment(uint256 expected, uint256 provided);
    error WorthlessShape(uint256 shapeId);
    error PackBelowMinimum(uint256 valueWei, uint256 minimum);
    error NotPackOwner(uint256 packId, address caller);
    error InvalidRecipient(address recipient);
    error UnsolicitedToken(address from);
    error DirectDepositRejected();
    error NotAUnitMultiple(uint256 amountWei);
    error PresentationIsLocked();
    error UnsupportedRenderer(address renderer);
    error AdminUnauthorizedAccount(address account);
    error AdminInvalidAdmin(address admin);

    // create
    function createPack(uint256[] calldata shapeIds, uint32[] calldata mintCounts)
        external payable returns (uint256 packId);
    function createPackTo(uint256[] calldata shapeIds, uint32[] calldata mintCounts, address to)
        external payable returns (uint256 packId);
    function quoteMint(uint32[] calldata mintCounts) external view
        returns (uint256 backingWei, uint256 feeWei, uint256 totalWei, uint256 shapeCount);
    function defaultMakeup(uint256 backingWei) external view returns (uint32[] memory mintCounts);

    // exit (owner-only); burn(packId) from IERC721Value == redeem(packId)
    function open(uint256 packId) external;
    function openTo(uint256 packId, address to) external;
    function redeem(uint256 packId) external;
    function redeemTo(uint256 packId, address payable recipient) external;

    // read; valueOf(packId) and positionOf(shapeId) come from the inherited interfaces
    function contentsOf(uint256 packId) external view returns (uint256[] memory);
    function packOf(uint256 shapeId) external view returns (uint256);
    function makeupOf(uint256 packId) external view returns (uint32[] memory);
    function packState(uint256 packId) external view returns (PackState memory);
    function exists(uint256 packId) external view returns (bool);
    function shapes() external view returns (address);
    function MIN_PACK_VALUE() external view returns (uint256);
    function MAX_SHAPES_PER_PACK() external view returns (uint256);
    function totalMinted() external view returns (uint256);
    function totalSupply() external view returns (uint256);

    // presentation (admin, lockable; no reach into custody)
    function admin() external view returns (address);
    function transferAdmin(address newAdmin) external;
    function renounceAdmin() external;
    function renderer() external view returns (address);
    function presentationLocked() external view returns (bool);
    function setRenderer(address newRenderer) external;
    function setMetadataCopy(string calldata namePrefix, string calldata description) external;
    function lockPresentation() external;
    function contractURI() external view returns (string memory);
}
```

## Appendix: creation path, in pseudocode

```solidity
function createPackTo(uint256[] calldata shapeIds, uint32[] calldata mintCounts, address to)
    external payable nonReentrant returns (uint256 packId)
{
    IShapes s = IShapes(shapes);
    uint256 n = s.denominationCount();
    if (mintCounts.length != n) revert MakeupLengthMismatch();

    // 1. price the makeup and check payment exactly
    uint256 fee = s.mintFee();
    uint256 expected; uint256 mintTotal;
    for (uint256 d = 0; d < n; ++d) {
        expected += mintCounts[d] * (s.denominationAt(uint8(d)) + fee);
        mintTotal += mintCounts[d];
    }
    if (msg.value != expected) revert IncorrectPayment(expected, msg.value);

    uint256 count = shapeIds.length + mintTotal;
    if (count == 0) revert EmptyPack();
    if (count > MAX_SHAPES_PER_PACK) revert TooManyShapes(count);

    packId = ++_lastPackId;
    uint256[] storage held = _contents[packId];
    uint256 value;

    // 2. pull the caller's own Shapes; a Black Shape has zero backing and is refused
    for (uint256 i = 0; i < shapeIds.length; ++i) {
        uint256 id = shapeIds[i];
        uint256 backing = s.backingOf(id);
        if (backing == 0) revert WorthlessShape(id);
        value += backing;
        held.push(id);
        _packOf[id] = packId;
        IERC721(shapes).transferFrom(msg.sender, address(this), id);
    }

    // 3. mint the rest straight into custody, one batch per denomination
    for (uint256 d = 0; d < n; ++d) {
        uint32 c = mintCounts[d];
        if (c == 0) continue;
        uint256 amount = s.denominationAt(uint8(d));
        _minting = true;
        uint256 first = s.mintBatchTo{value: c * (amount + fee)}(amount, c, address(this));
        _minting = false;
        for (uint256 i = 0; i < c; ++i) { held.push(first + i); _packOf[first + i] = packId; }
        value += amount * c;
    }

    // 4. the floor, then the pack token last
    if (value < MIN_PACK_VALUE) revert PackBelowMinimum(value, MIN_PACK_VALUE);
    _meta[packId] = PackMeta({pulledCount: uint16(shapeIds.length), createdAt: uint64(block.timestamp)});
    emit PackCreated(packId, msg.sender, to, held, shapeIds.length, value);
    _safeMint(to, packId);
}
```
