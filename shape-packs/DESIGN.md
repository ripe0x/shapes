# Shape Packs — design

A wrapper collection that lets anyone bundle Shapes into a single ERC-721, at any makeup they
choose, from Shapes they already hold, from ETH, or both. Built as a new collection in a new
repository, `shape-packs`, against the deployed mainnet `Shapes` at
`0x6fe9193276bf7abcbee44ab7afd717d637d6faf0`. Shapes itself is not modified.

This document is the specification the implementation was built from; it is kept in step with the
code and also lives in the Shapes repository as `SHAPE_PACKS_DESIGN.md`. It records what a pack is,
how it is created, extended and exited, what the contract may never do, how it renders, how the
repository is laid out, and the decisions that were taken.

Revision 2. Changes from revision 1: packs are extendable by their holder; there is no cap on
pack size, so exit is chunkable; the pack's value is cached; the creator is recorded; the
`Sealed` trait, `createdAt` and the `IShapePositionResolver` claim are gone; rule order and the
approval wording are fixed.

---

## 1. What a pack is

A **Shape Pack** is an ERC-721 token in the `ShapePacks` collection that custodies a set of
live, non-Black Shapes. The pack contract holds the Shapes; the pack token is the claim on them.

- **Sealed against removal.** Nothing leaves a live pack. The holder may **add** Shapes to a
  pack they own, so a pack's contents can only grow while it is live. A buyer of a pack gets at
  least the Shapes the metadata listed when they looked, and the exact Shapes it lists when they
  receive it.
- **Exact value.** A pack's value is the sum of its Shapes' redeemable backing. It is cached at
  creation, increased on every addition, and asserted equal to the live sum by the invariant
  suite. It can never decrease: a packed Shape cannot be redeemed, split, composed or made Black
  by anyone, because every Shapes mutator is owner-only and the pack contract never calls one.
- **Minimum value: 0.03 ETH** at creation, expressed as `3 * shapes.unit()` so the same build is
  correct on Sepolia's 1/100 ladder. 0.03 is not itself a denomination, so the smallest packs
  are three 0.01 Shapes, one 0.05, or 0.01 + 0.05, and so on. Additions have no minimum.
- **No cap on size.** A pack may hold as many Shapes as its creator cares to pay gas for, across
  as many transactions as they like. Creation and additions are each bounded by the block only.
  Exit is chunkable (§4), so no pack can outgrow its own exit.
- **Two exits, both all-or-nothing at the token level.** `open` burns the pack and hands the
  Shapes back. `redeem` burns the pack and unwraps every Shape to ETH. For packs too large for a
  single block, `unseal` burns the pack and turns its contents into a claim that is drained in
  chunks. There is no partial exit from a live pack.
- **ERC-8060 value-bearing.** `ShapePacks` implements the same draft `IERC721Value` surface Shapes
  does: `valueOf(packId)` and `burn(packId)`. Anything that already prices a Shape by `valueOf`
  can price a pack the same way.
- **Transparent.** A pack is not a blind box. Contents are readable onchain from the moment the
  pack exists, and Shape seeds are block-derived and public. A blind, mint-on-open product is a
  different design (it would hold ETH and need its own solvency invariant) and is out of scope.

### Why a pack and not something else

| Alternative | Why not |
| --- | --- |
| ERC-6551 token-bound account per pack | Contents would be removable by the holder at any time, so a buyer could not trust the makeup; adds a registry dependency; metadata would need an indexer. |
| `compose` into one Shape | A different object: one id, one seed, ladder sums only. Shapes already offers it. A pack keeps every Shape's identity and allows any mix. |
| ERC-1155 "pack types" | Packs with identical makeup still hold distinct Shapes with distinct seeds and provenance. Each pack is unique. |
| Custody inside `Shapes` | Shapes deliberately never freezes, escrows or wraps tokens (README, SPEC D-29). The wrapper lives outside. |

The custody pattern is the one `ShapeCardEscrow` already uses and the adversarial review already
examined: pull with `transferFrom`, mint into self through a narrow `onERC721Received` window, push
out with `transferFrom`, clear state before every external call.

---

## 2. Creating a pack

One entrypoint covers every case: existing Shapes, ETH, or a mix.

```solidity
/// @param shapeIds   Shapes the caller owns. Pulled with transferFrom(msg.sender, this, id).
/// @param mintCounts One entry per ladder index (length == shapes.denominationCount()). Entry d
///                   is how many Shapes of denomination d to mint fresh into the pack.
/// @param to         Recipient of the pack token.
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
fee recipient as it would for any mint. `ShapePacks` adds no fee of its own.

Two views support a UI that starts from an ETH amount and lets the user allocate it:

```solidity
function quoteMint(uint32[] calldata mintCounts) external view
    returns (uint256 backingWei, uint256 feeWei, uint256 totalWei, uint256 shapeCount);

/// Fewest-Shapes makeup for a backing amount (largest denomination first), as a prefill.
function defaultMakeup(uint256 backingWei) external view returns (uint32[] memory mintCounts);
```

### Rules, checked in this order

0. `to` is nonzero, else `InvalidRecipient(0)`; on `createPack` it is the caller.
1. `mintCounts.length == shapes.denominationCount()`, else `MakeupLengthMismatch()`.
2. `shapeIds.length + Σ mintCounts >= 1`, else `NoShapes()`.
3. Payment is exact for the makeup, else `IncorrectPayment`. With no mints, `msg.value` must be 0.
4. For each `shapeIds[i]`: `shapes.backingOf(id)` (reverts on a dead id) is nonzero, else
   `WorthlessShape(id)`. This is how a Black Shape is refused: it keeps denomination index 8 but
   has zero backing, so the pack values by backing, never by denomination. Then
   `transferFrom(msg.sender, this, id)`. A repeated id fails on its own: the second pull finds the
   caller no longer owns it.
5. Mint each nonzero `mintCounts[d]` with one `mintBatchTo{value: count * (amount + fee)}(amount,
   count, address(this))`, taking ids from the returned `firstTokenId`. The receiver window
   `_minting` is open only across each mint call, exactly as in `ShapeCardEscrow`.
6. Total backing `>= MIN_PACK_VALUE`, else `PackBelowMinimum(valueWei, MIN_PACK_VALUE)`.
7. Record contents, `packOf` for every Shape, the cached value, the minted count and the
   creator; emit `PackCreated`; then `_safeMint(to, packId)` last.

Pack ids start at 1 and are never reissued, so `packOf(shapeId) == 0` means "not packed".

```solidity
event PackCreated(
    uint256 indexed packId, address indexed creator, address indexed to,
    uint256[] shapeIds, uint256 pulledCount, uint256 valueWei
);
```

`shapeIds` lists pulled Shapes first, then minted ones. The minted Shapes also emit Shapes' own
`ShapeMinted`, `InkGene` and `Transfer` events with `to` equal to the pack contract.

Mint-from-ETH packs depend on Shapes' `mintStart` having passed (mainnet opened 2026-09-03).

---

## 3. Extending a pack

The holder of a live pack may add to it. Additions let a large pack be built across several
transactions, each bounded by the block, and let a holder grow a pack they bought.

```solidity
function addToPack(uint256 packId, uint256[] calldata shapeIds, uint32[] calldata mintCounts)
    external payable;
```

Rules, in order: the pack is live and `msg.sender` is its owner (`NotPackOwner`); then rules 1
through 5 of creation apply unchanged (length, at least one Shape, exact payment, pulls, mints).
There is no minimum on an addition: the pack already met the floor. The cached value and minted
count increase, every added Shape gets its `packOf` entry, and the pack's metadata changes:

```solidity
event PackExtended(
    uint256 indexed packId, address indexed by,
    uint256[] shapeIds, uint256 pulledCount, uint256 addedValueWei, uint256 valueWei
);
event MetadataUpdate(uint256 packId); // ERC-4906
```

Only the owner may add. Letting anyone add would let a stranger bloat a pack's exit cost, and
there is no use for it that the owner cannot serve by adding themselves. Approved operators cannot
add, for the same reason they cannot open: every value-affecting action on a pack is owner-only.

---

## 4. Exiting a pack

Every exit is owner-only. An approved operator can transfer a pack but cannot open, redeem or
unseal it, the same rule Shapes applies to `redeem` and `burn`.

### Single transaction

```solidity
function open(uint256 packId) external;                                 // Shapes to msg.sender
function openTo(uint256 packId, address to) external;                   // Shapes to `to`
function redeem(uint256 packId) external;                               // ETH to msg.sender
function redeemTo(uint256 packId, address payable recipient) external;  // ETH to `recipient`
function burn(uint256 packId) external;                                 // IERC721Value: == redeem
```

`open` burns the pack token, clears the pack's value and `packOf` entries, then
`transferFrom(this, to, id)` for every Shape, in reverse insertion order. Plain `transferFrom` is
used, as in the escrow: `to` is chosen by the owner, and a hook-less push cannot be griefed by a
recipient. `redeem` burns the pack token, clears state, then makes one call to
`shapes.redeemBatchTo(shapeIds, recipient)`: Shapes burns every Shape and makes a single ETH
transfer; the pack contract never touches the ETH. If the recipient rejects ETH the whole
transaction reverts and the pack survives untouched.

`burn` exists for ERC-8060 parity. No pack can ever hold zero value, so `burn` always pays and is
identical to `redeem`.

### Chunked, for packs too large for one block

```solidity
function unseal(uint256 packId, address claimant) external;                 // owner-only
function claim(uint256 packId, uint256 maxCount) external;                  // claimant-only
function claimEth(uint256 packId, uint256 maxCount, address payable recipient) external; // claimant-only
function claimantOf(uint256 packId) external view returns (address);        // zero when none
```

`unseal` burns the pack token and records `claimant` as the only account that may drain what is
left. The pack is no longer an NFT and cannot be sold half-drained; what remains is a claim.
`claim` pops up to `maxCount` Shapes from the end of the remaining list and transfers them to the
claimant. `claimEth` pops up to `maxCount` and redeems them to `recipient` in one
`redeemBatchTo`. The two may be mixed freely across transactions. Because every drain pops from
the end, `contentsOf` of a partly drained pack is always a prefix of the pack's insertion order,
and a single-transaction `open` hands the Shapes back in reverse insertion order. When the list is
empty the claimant entry is cleared. `maxCount == 0` reverts `ZeroQuantity()`.

A zero `claimant` or recipient reverts `InvalidRecipient`, and so does the pack contract itself as
claimant, since Shapes transferred to it would belong to no pack. The zero address as `to` on
creation reverts the same way; the pack contract as `to` reverts `SelfCustodyRejected`, as a
transfer of a pack token to the pack contract does: a pack it held could never be opened.

The single-transaction functions are the same code path: `open` is `unseal(msg.sender)` followed
by `claim(all)`; `redeem` is `unseal(msg.sender)` followed by `claimEth(all, recipient)`. They
therefore emit the same events, so an indexer has one model of exit:

```solidity
event PackUnsealed(uint256 indexed packId, address indexed owner, address indexed claimant, uint256 count);
event ShapesClaimed(uint256 indexed packId, address indexed to, uint256[] shapeIds);
event EthClaimed(uint256 indexed packId, address indexed recipient, uint256[] shapeIds, uint256 valueWei);
```

---

## 5. Reading a pack

```solidity
function contentsOf(uint256 packId) external view returns (uint256[] memory shapeIds); // live pack: contents; unsealed: what remains
function valueOf(uint256 packId) external view returns (uint256);        // cached Σ backingOf; reverts unless live
function packOf(uint256 shapeId) external view returns (uint256);        // 0 when not packed
function makeupOf(uint256 packId) external view returns (uint32[] memory counts); // per ladder index, live pack only
function packState(uint256 packId) external view returns (PackState memory);
function exists(uint256 packId) external view returns (bool);            // live pack token
function creatorOf(uint256 packId) external view returns (address);

struct PackState {
    uint256[] shapeIds;
    uint32[]  counts;        // per ladder index
    uint256   valueWei;
    uint256   mintedCount;   // Shapes the pack minted itself, at creation and in additions
    address   creator;
}

function MIN_PACK_VALUE() external view returns (uint256);   // immutable, 3 * shapes.unit()
function shapes() external view returns (address);
function totalMinted() external view returns (uint256);      // packs ever created
function totalSupply() external view returns (uint256);      // live packs
```

`packOf` is the hook the site and the indexer use to say "this Shape is inside Pack #N". The pack
contract does not claim `IShapePositionResolver`: Shapes' D-29 defines a position as the
exchange-option layer, and the pointer holds one address. If a positions aggregator ever exists it
can read `packOf`.

---

## 6. ERC-165

`ShapePacks.supportsInterface` answers `IERC165`, `IERC721`, `IERC721Metadata`, `IERC2981`
(`royaltyInfo` returns zero, as Shapes does), ERC-4906, `IERC721Value` and `IShapePacks`.

The auction house accepts any ERC-721 as a lot, so a pack can be listed in `ShapeAuctionHouse`
with no changes there: bidders pay in Shapes for a bundle of Shapes.

---

## 7. Trust model and invariants

The pack contract holds other people's claims on ETH, so it inherits Shapes' posture: no path
reaches custody except the holder's own exit.

**What the contract never does**

- Call `compose`, `decompose`, `split`, `burnBacking`, `approve` or `setApprovalForAll` on Shapes.
  Nothing in the contract can change what a packed Shape is or who may move it.
- Hold ETH. Creation and additions forward `msg.value` exactly into Shapes mints; redemption pays
  the recipient directly from Shapes. `receive` and `fallback` revert `DirectDepositRejected`.
- Accept an unsolicited Shape. `onERC721Received` returns the selector only when `msg.sender ==
  shapes`, `_minting` is set, and `from == address(0)`. A `safeTransferFrom` into the contract
  reverts `UnsolicitedToken`.
- Expose an admin path into custody. There is no pause, no recovery, no upgrade, no allowlist.
  The admin role reaches presentation only (§8).

**Why contents can only grow.** Every Shapes mutator checks `msg.sender == ownerOf`. While
packed, `ownerOf` is the pack contract, which never calls any of them. No third party can act on a
packed Shape, and a packed Shape cannot become Black. A packed Shape's compose stack cannot be
unwound while packed; after `open` its new holder can.

**Invariants** (stateful fuzz over create, add, transfer, open, redeem, unseal, claim, claimEth,
forced ETH and raw pokes):

```
I1  for every live pack p, for every id in contentsOf(p):
        shapes.ownerOf(id) == address(packs)  and  packOf(id) == p
I2  for every live pack p:
        valueOf(p) == Σ backingOf(id) over contentsOf(p)  and  valueOf(p) >= MIN_PACK_VALUE
I3  while p is live, contentsOf(p) at any later observation starts with contentsOf(p) at any
        earlier one (contents only grow, in order)
I4  address(packs).balance == 0  (ETH can still be forced in; it is stranded, never reachable)
I5  every Shape owned by address(packs) is in exactly one live pack's contents or one unsealed
        pack's remaining list, except Shapes pushed in by plain transferFrom (below)
I6  a pack id is never reissued; totalMinted only grows; totalSupply == live packs
I7  for every unsealed pack p with remaining Shapes, claimantOf(p) != 0 and exists(p) == false
```

**Accepted, not fixed: Shapes pushed in by plain `transferFrom`.** The same finding and the same
resolution as the auction house (SECURITY.md, "Assets sent to the auction house unasked"). A
hook-less transfer cannot be refused by any contract. Such a Shape sits in the contract with no
pack naming it and no way out. A recovery function would be an administrative path into everyone
else's packs. The loss is self-inflicted and confined to the pusher.

**Approval is trust, with one real limit.** Every pull is `transferFrom(msg.sender, this, id)`, so
an approval granted to `ShapePacks` can only ever be exercised by the approver's own call, into a
pack the approver creates or owns. A `setApprovalForAll` to `ShapePacks` is therefore not a grant
to anyone else; it is a convenience the UI should use rather than asking for one approval per
Shape. For the pack token itself, an approved operator can transfer it to itself and then open
it, exactly as with a Shape.

**Reentrancy.** Every entrypoint that creates, extends or exits a pack is `nonReentrant` and
follows checks-effects-interactions. The inherited ERC-721 transfer and approval functions are not
guarded, as on Shapes: they move the pack token only, and state is final before any receiver hook
runs. The only external calls are to Shapes (trusted, itself guarded) and the two the owner
directs: the pack token's `_safeMint` receiver hook on creation, and the ETH payout on
`redeem`/`claimEth`, both after state is final.

**Owner token.** If the Shape carrying collection ownership is packed, `Shapes.owner()` returns
the pack contract until the pack is opened. Ownership is attribution only, but marketplaces read
`owner()` for collection controls, so the Shapes collection page would be unmanageable while that
pack is live. Allowed and documented; the same is true of any contract holding that Shape.

**Fee race.** `mintFee` is admin-adjustable on Shapes up to `unit()`. Exact payment means a fee
change between quote and inclusion reverts the creation rather than silently overcharging or
stranding ETH. The UI reads `quoteMint` and simulates in the same block.

---

## 8. Presentation

Metadata follows the Shapes pattern: a replaceable renderer and editable copy behind a lockable
presentation admin, with no authority over custody.

- `admin()`, `transferAdmin`, `renounceAdmin`, with the `IAdminControl` names and errors.
- `setRenderer(address)` requires code answering ERC-165 for `IShapePackRenderer`.
- `setMetadataCopy(tokenNamePrefix, description)` stores the copy on `ShapePacks` itself, bounded
  (64 and 2048 bytes) and checked JSON-safe (printable ASCII, no `"` or `\`), so it cannot break
  the JSON. Shapes' `CopyValidation` is a linked library; the pack uses an internal check with
  the same bounds to avoid a second linked deploy.
- `lockPresentation()` freezes renderer and copy permanently. Each of the three setters emits
  ERC-4906 `BatchMetadataUpdate(1, totalMinted)` and ERC-7572 `ContractURIUpdated()` so
  marketplaces re-read.

`tokenURI(packId)` is a base64 `data:application/json` URI, image a base64 `data:image/svg+xml`,
fully onchain, no fonts, black and white, same as a Shape. `ShapePacks` gathers everything the
renderer needs and passes it in one struct:

```solidity
struct PackRenderInput {
    uint256 packId;
    uint256 shapeCount;
    uint256 valueWei;
    uint256 unitWei;
    uint32[] counts;          // per ladder index
    uint256[] denominations;  // wei per ladder index
    uint256 mintedCount;
    address creator;
    ShapeState[] topCards;    // the first up to three Shapes in contents order
    string tokenNamePrefix;
    string description;
}
```

**Image.** A stack. The renderer draws the top cards (the first three in contents order, so the
creator decides what shows; documented) through Shapes' live `renderer()`, using `renderSVG` for a
seed-derived card and `renderSVGSampled` when `modules` is nonempty, fanned with a small offset,
and the remaining cards as plain black rounded card backs behind them, up to a few so the stack
reads as deep without drawing a thousand rectangles. The canvas is square with the stack inset,
rounded and shadowed, matching `ShapeCollection.imageFor`. Drawing every card is not attempted;
the three-card cap keeps `tokenURI` cheap for marketplaces and the indexer whatever the pack size.

**Name and description.** `Shape Pack 12`. Description: the shared editable copy, then the makeup
in words: `3 x 0.01 ETH, 1 x 0.05 ETH. 0.08 ETH total.`, with an ASCII `x` so the JSON stays
byte-safe, using `FixedPoint.fmt` from Shapes so numbers print the way Shapes prints them.

**Attributes.**

| trait_type | value | Notes |
| --- | --- | --- |
| `Shapes` | number | count of Shapes inside |
| `Value` | `"0.08 ETH"` | exact, from the cached value |
| `Units` | number, `display_type: number` | value in `unit()`s, for numeric filtering |
| `0.01 ETH` … `100 ETH` | number | one row per denomination with a nonzero count |
| `Source` | `Minted` / `Packed` / `Mixed` | all minted by the pack, all pulled from a wallet, or both |
| `Creator` | checksummed address | who created the pack |

`contractURI` is the collection name, the shared description and a seeded stack image: three
cards from Shapes' collection previews over two backs.

---

## 9. Repository: `ripe0x/shape-packs`

Foundry, `solc 0.8.28`, `evm_version = cancun`, `via_ir`, `optimizer_runs = 20` to match the
Shapes build. The Shapes repository is a git submodule pinned to the deployed mainnet commit
(`1b84c10`), and the new repo's OpenZeppelin and forge-std remappings point into the copies
vendored inside that submodule, so there is exactly one version of each library and it is the one
Shapes was built with.

```
src/
  ShapePacks.sol               ERC721 + custody + create/add/exit + views + presentation admin
  ShapePackRenderer.sol        the stack image, metadata JSON, contractURI
  interfaces/
    IShapePacks.sol            every function, event and error above, with NatSpec
    IShapePackRenderer.sol     PackRenderInput, tokenURI, metadataJSON, image, contractURI
lib/
  shapes/                      git submodule at 1b84c10; carries lib/openzeppelin-contracts and lib/forge-std
script/
  Deploy.s.sol                 one script, chain-id gated like Shapes': anvil, sepolia, mainnet
  deploy.sh                    the wrapper; reads script/env/<target>.env, reads back, writes deployments/<chainId>.json
  env/{anvil,sepolia,mainnet}.env   SHAPES address per chain, ADMIN; nothing secret
test/
  utils/DeployShapes.sol       deploys Shapes + renderer + collection from the submodule for local tests
  utils/Base64Decode.sol       copied from Shapes' tests, for proving tokenURI decodes to real JSON
  Create.t.sol                 every creation rule and error; pulled, minted and mixed; exact payment
  Add.t.sol                    additions: owner-only, rules, value and metadata update, I3
  Exit.t.sol                   open, openTo, redeem, redeemTo, burn, unseal, claim, claimEth; reverting recipients
  Receiver.t.sol               onERC721Received window; unsolicited safeTransferFrom refused; stray transferFrom documented
  Metadata.t.sol               JSON validity, attributes, top-card cap, copy edit, renderer swap and lock
  Invariants.t.sol             I1–I7 under fuzzed sequences
  Fork.t.sol                   env-gated: the whole lifecycle against mainnet Shapes 0x6fe9…
foundry.toml                   remappings: shapes/=lib/shapes/src/  ladder/=lib/shapes/ladders/mainnet/
                                           @openzeppelin/contracts/=lib/shapes/lib/openzeppelin-contracts/contracts/
                                           forge-std/=lib/shapes/lib/forge-std/src/
.github/workflows/ci.yml       fmt check, build with sizes, test, both profiles
README.md                      what a pack is, how to create/add/open/redeem, the trust model summary
SECURITY.md                    the accepted residuals (stray transferFrom, approval is trust, fee race, owner token)
```

`ShapePacks` is ladder-agnostic: it reads `unit()`, `denominationCount()`, `denominationAt(d)` and
`mintFee()` from Shapes live, so one build deploys to mainnet and Sepolia. Only the tests that
deploy Shapes locally need the `ladder/` remapping; a `testnet` profile mirrors Shapes' for the
Sepolia ladder.

### Deployment

`Deploy.s.sol` deploys `ShapePackRenderer(shapes)`, then `ShapePacks(shapes, renderer, admin)`,
reads back `shapes()`, `MIN_PACK_VALUE()` (asserting `3 * unit()`), `renderer()` and `admin()`,
and writes `deployments/<chainId>.json`. Sepolia first against the Sepolia Shapes, then mainnet
against `0x6fe9…faf0`. Presentation is left unlocked at launch, as Shapes' was, and locked once
the art is final.

### Site and indexer

Outside the contract scope, noted for planning: a pack builder page (pick Shapes from the wallet
and/or allocate an ETH amount across the nine denominations, see `quoteMint` live, create, add),
a pack page (the stack, the contents as cards, value, open and redeem), and the Ponder indexer
gaining the `ShapePacks` ABI and its events. The Shapes indexer already sees the `Transfer`s into
and out of the pack contract; `packOf` makes the join exact.

---

## 10. Decisions taken

1. **No pack-level fee.** The minted portion pays Shapes' per-Shape fee; the wrapper is free.
2. **Value floor only, at creation.** A single 0.05 ETH Shape is a valid pack. Additions have no
   floor.
3. **No size cap.** Users are told that a pack's exit cost scales with its size, and `unseal` +
   `claim` guarantee any pack can be exited.
4. **Additions are owner-only.** Contents only grow.
5. **Three rendered cards, creator order.**
6. **Presentation admin retained**, mirroring Shapes: renderer, copy, one lock, renounceable.
7. **Name and symbol:** `Shape Packs` / `PACK`; token name `Shape Pack N`.
8. **Not claimed:** `IShapePositionResolver`. **Not built:** blind packs, nested packs, removal.

---

## Appendix: `IShapePacks`

The authoritative interface lives in the new repository at `src/interfaces/IShapePacks.sol`; this
is its surface. `UnsupportedShapes(address)`, raised by the constructor for a token that does not
answer ERC-165 for `IShapes`, is declared on the contract rather than the interface.

```solidity
interface IShapePacks is IERC721, IERC721Value {
    // events
    event PackCreated(uint256 indexed packId, address indexed creator, address indexed to,
                      uint256[] shapeIds, uint256 pulledCount, uint256 valueWei);
    event PackExtended(uint256 indexed packId, address indexed by, uint256[] shapeIds,
                       uint256 pulledCount, uint256 addedValueWei, uint256 valueWei);
    event PackUnsealed(uint256 indexed packId, address indexed owner, address indexed claimant, uint256 count);
    event ShapesClaimed(uint256 indexed packId, address indexed to, uint256[] shapeIds);
    event EthClaimed(uint256 indexed packId, address indexed recipient, uint256[] shapeIds, uint256 valueWei);
    event RendererUpdated(address indexed renderer);
    event MetadataCopySet(string tokenNamePrefix, string description);
    event PresentationLocked(address indexed renderer);
    event ContractURIUpdated();                         // ERC-7572
    event MetadataUpdate(uint256 _tokenId);             // ERC-4906
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // errors
    error NoShapes();
    error MakeupLengthMismatch();
    error IncorrectPayment(uint256 expected, uint256 provided);
    error WorthlessShape(uint256 shapeId);
    error PackBelowMinimum(uint256 valueWei, uint256 minimum);
    error NotPackOwner(uint256 packId, address caller);
    error NotClaimant(uint256 packId, address caller);
    error NothingToClaim(uint256 packId);
    error ZeroQuantity();
    error InvalidRecipient(address recipient);
    error UnsolicitedToken(address from);
    error DirectDepositRejected();
    error NotAUnitMultiple(uint256 amountWei);
    error PresentationIsLocked();
    error UnsupportedRenderer(address renderer);
    error InvalidCopy(uint8 field);
    error AdminUnauthorizedAccount(address account);
    error AdminInvalidAdmin(address admin);
    error SelfCustodyRejected(uint256 packId);

    // create and extend
    function createPack(uint256[] calldata shapeIds, uint32[] calldata mintCounts) external payable returns (uint256);
    function createPackTo(uint256[] calldata shapeIds, uint32[] calldata mintCounts, address to) external payable returns (uint256);
    function addToPack(uint256 packId, uint256[] calldata shapeIds, uint32[] calldata mintCounts) external payable;
    function quoteMint(uint32[] calldata mintCounts) external view
        returns (uint256 backingWei, uint256 feeWei, uint256 totalWei, uint256 shapeCount);
    function defaultMakeup(uint256 backingWei) external view returns (uint32[] memory);

    // exit (owner-only); burn(packId) from IERC721Value == redeem(packId)
    function open(uint256 packId) external;
    function openTo(uint256 packId, address to) external;
    function redeem(uint256 packId) external;
    function redeemTo(uint256 packId, address payable recipient) external;
    function unseal(uint256 packId, address claimant) external;
    function claim(uint256 packId, uint256 maxCount) external;
    function claimEth(uint256 packId, uint256 maxCount, address payable recipient) external;

    // read; valueOf(packId) comes from IERC721Value
    function contentsOf(uint256 packId) external view returns (uint256[] memory);
    function packOf(uint256 shapeId) external view returns (uint256);
    function claimantOf(uint256 packId) external view returns (address);
    function creatorOf(uint256 packId) external view returns (address);
    function makeupOf(uint256 packId) external view returns (uint32[] memory);
    function packState(uint256 packId) external view returns (PackState memory);
    function exists(uint256 packId) external view returns (bool);
    function shapes() external view returns (address);
    function MIN_PACK_VALUE() external view returns (uint256);
    function totalMinted() external view returns (uint256);
    function totalSupply() external view returns (uint256);

    // presentation (admin, lockable; no reach into custody)
    function admin() external view returns (address);
    function transferAdmin(address newAdmin) external;
    function renounceAdmin() external;
    function renderer() external view returns (address);
    function presentationLocked() external view returns (bool);
    function tokenNamePrefix() external view returns (string memory);
    function description() external view returns (string memory);
    function setRenderer(address newRenderer) external;
    function setMetadataCopy(string calldata tokenNamePrefix_, string calldata description_) external;
    function lockPresentation() external;
    function contractURI() external view returns (string memory);
}
```
