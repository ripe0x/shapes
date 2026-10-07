# Shape Packs — trust model and accepted residuals

`ShapePacks` custodies Shapes, and Shapes custody ETH, so the pack contract holds other people's
claims on ETH. It inherits the posture of Shapes (see its SECURITY.md) and the custody pattern of
`ShapeCardEscrow`, which Shapes' adversarial review already examined: pull with `transferFrom`, mint
into self through a narrow `onERC721Received` window, push out with `transferFrom`, clear state before
every external call.

This file records what the contract never does, the invariants it is tested against, and each
residual that was examined and accepted rather than fixed. It is a statement of the design, not an
audit: it is not a substitute for a professional audit before real value is at risk.

**Headline: there is no path from outside the holder's own exit to the Shapes in a pack, and
nothing the admin can do reaches custody.** The one thing that must never happen is a pack holder
unable to open or redeem their pack for exactly the Shapes, or exactly the ETH, inside it.

---

## The threat model

The contract has no owner over custody. A separate, transferable `admin()` administers presentation
only: the renderer address and the shared name prefix and description, lockable together and
permanently with `lockPresentation()`, renounceable. It cannot reach a Shape, a pack, ETH, or the
right to exit.

**What the contract never does**

- Call `compose`, `decompose`, `split`, `burnBacking`, `approve` or `setApprovalForAll` on Shapes.
  The only Shapes mutators it calls are `mintBatchTo` and `redeemBatchTo`. Nothing in the contract
  can change what a packed Shape is or who may move it.
- Hold ETH. Creation and additions forward `msg.value` exactly into Shapes mints; redemption pays
  the recipient directly from Shapes. `receive` and `fallback` revert `DirectDepositRejected`.
- Accept an unsolicited Shape. `onERC721Received` returns the selector only when `msg.sender ==
  shapes`, `_minting` is set, and `from == address(0)`. A `safeTransferFrom` into the contract
  reverts `UnsolicitedToken`.
- Expose an administrative path into custody. There is no pause, no recovery, no upgrade, no
  allowlist.

**Why contents can only grow.** Every Shapes mutator checks `msg.sender == ownerOf`. While packed,
`ownerOf` is the pack contract, which never calls any of them. No third party can act on a packed
Shape, and a packed Shape cannot become Black. A packed Shape's compose stack cannot be unwound while
packed; after `open` its new holder can.

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

---

## Findings and what was done

Each entry below is a design-time finding: a way the contract can surprise someone, examined and
resolved by acceptance, by construction, or by documentation. None needed a code path that
reaches custody.

### 1. Shapes pushed in by plain `transferFrom` are stranded — accepted

*Informational; confined to the pusher.* The same finding and the same resolution as the auction
house in Shapes (SECURITY.md, "Assets sent to the auction house unasked"). `onERC721Received`
refuses everything but the pack's own mints, so `safeTransferFrom` into the contract reverts. A
hook-less `transferFrom` calls no receiver and cannot be refused by any contract, so a Shape can
still be pushed in by its owner. It then sits in the contract with no pack naming it and no function
that releases it.

Accepted, not fixed. A recovery function would be an administrative path into a contract holding
other people's packs, which is the one thing this contract does not have, and it could not tell
a stray Shape from one whose pack is mid-exit without trusting someone's say-so. The loss is
self-inflicted and confined to the pusher. It is the reason I5 carries an exception: stray Shapes
are the only Shapes the contract may own that no pack or claim names. They never break I1 to I3 or
I7, because none of those speaks of a Shape without a pack. Creation and additions, which pull
with `transferFrom(msg.sender, this, id)`, are the supported way in. ETH forced in by
`selfdestruct` or coinbase payment is the same case for I4: stranded, never reachable, never
counted.

### 2. Approval is trust, with one real limit — verified, clarified

*Informational.* To pack a Shape you own, you approve `ShapePacks` on Shapes. Every pull is
`transferFrom(msg.sender, this, id)`, so that approval can only be exercised by the approver's own
call, into a pack the approver creates or owns. `setApprovalForAll(shapePacks, true)` is therefore
not a grant to anyone else, and no caller can name another account's Shape: the pull would revert
because `msg.sender` is not its owner. The UI should use the single operator approval rather than one
per Shape.

For the pack token itself nothing is new. `open`, `redeem` and `unseal` are owner-only, and `addToPack`
likewise, so an approved operator of a pack cannot exit or extend it. But an approved operator can
always transfer the pack to itself and then exit it in the same transaction, so approving an operator
of a pack is economically the same as granting it the pack, exactly as with a Shape (Shapes
SECURITY.md, finding 8). The owner-only check keeps the payout destination unambiguous; it is not
a protection against an operator you approved.

### 3. The mint fee can change between quote and inclusion — resolved by exact payment

*Informational.* `mintFee` is admin-adjustable on Shapes up to `unit()`. Creation and additions
require `msg.value` to equal the cost of the requested mints exactly, with Shapes' fee read live. A fee
change between a `quoteMint` and the transaction's inclusion therefore reverts
`IncorrectPayment(expected, provided)`. It cannot silently overcharge, and it cannot leave surplus
ETH in the contract, which would break I4. The cost is a failed transaction and its gas. A UI should
read `quoteMint` and simulate against the same block.

### 4. Packing the owner token makes `Shapes.owner()` return the pack contract — allowed, documented

*Informational.* If the Shape carrying collection ownership is packed, `Shapes.owner()` returns the
pack contract until that pack is opened. Ownership is attribution only and carries no authority in
Shapes; the administrator is `admin()`, which is separate and unaffected. But marketplaces read
`owner()` for collection controls, so the Shapes collection page would be unmanageable on those
venues while the pack is live. This is allowed and documented, and is true of any contract holding
that Shape. Whoever holds the owner token should open or unseal before relying on it for collection
controls elsewhere.

### 5. Exit gas scales with pack size — mitigated by `unseal` and `claim`

*Informational; self-inflicted only.* There is no size cap, as there is none on Shapes batches
(Shapes SECURITY.md, finding 7). A pack's creator pays gas for every Shape in it, and exit pays
again: `open` and `redeem` touch every Shape in one transaction, so a large enough pack cannot be
exited in a single block. Left uncapped rather than introducing an arbitrary constant, because a
cap is a limit on what a holder may own, and an uncapped pack only ever hurts whoever chose to
build it.

The mitigation is structural. `unseal` burns the pack token and records a claimant, and `claim` and
`claimEth` pop up to `maxCount` Shapes at a time from the end of the remaining list, so any pack can
be exited in as many block-sized transactions as it needs. `open` and `redeem` are the same code path
(`unseal` followed by one drain), so there is one exit model, and an indexer sees the same events
whichever was used. No third party can force anyone into a large pack: additions are owner-only,
which is why a stranger cannot bloat a pack's exit cost. A buyer should read `contentsOf` and size
before buying a pack they may need to exit.

The accepted consequence: an unsealed pack is a claim, not an NFT. It cannot be sold half-drained.
Exit is irrevocable and all-or-nothing at the token level, with no way to go back to a live pack. If
the claimant is a contract or key that is lost, what remains is lost with it; that is the owner's
choice of `claimant`.

### 6. Renderer and copy are admin-replaceable until locked — presentation only

*Informational.* The admin can replace the renderer and edit the name prefix and description until
`lockPresentation()`. The renderer is `view`-only and is called only by `tokenURI` and `contractURI`;
the copy is read only by those. Neither can touch ETH, a Shape, a pack or who may exit; a replacement
changes appearance only. A compromised admin could point `tokenURI` at a renderer producing
misleading or offensive metadata, or set a misleading description. `setRenderer` requires code that
answers ERC-165 for `IShapePackRenderer` but does not smoke-call it, so a broken renderer would make
`tokenURI` revert until replaced; this is cosmetic.

Copy is bounded (64 and 2048 bytes) and checked JSON-safe (printable ASCII, no `"` or `\`), so it
cannot break or restructure the JSON. It is not HTML-escaped, so a marketplace that renders
`description` as HTML would display admin-supplied markup. Each of `setRenderer`, `setMetadataCopy`
and `lockPresentation` emits ERC-4906 `BatchMetadataUpdate(1, totalMinted)` and ERC-7572
`ContractURIUpdated()`. `lockPresentation` freezes both permanently, and renouncing admin freezes
them at their last values. Until then hold the admin in a multisig. The deployed art is also drawn
through Shapes' own live `renderer()`, so a pack's cards track whatever Shapes presents.

### 7. Reentrancy posture — verified

*Informational.* Every state-changing entrypoint that creates, extends or exits a pack is
`nonReentrant`, and each follows checks-effects-interactions: the pack token is burned and the pack's
state is cleared before the first external call of any exit, and on creation the pack is recorded
before the pack token is minted, last.

The external calls that exist are few:

- **Shapes**, trusted and itself guarded: `transferFrom` to pull, `mintBatchTo` to mint into this
  contract, `transferFrom` to push out, `redeemBatchTo` to unwrap. A mint calls back into this
  contract's `onERC721Received`, which is why that hook admits a mint and nothing else.
- **The pack token's `_safeMint` receiver hook**, on creation only, to the `to` the creator chose.
  It runs after every Shape is in custody and the pack is recorded.
- **The ETH payout** on `redeem`, `redeemTo` and `claimEth`, which is paid by Shapes to the recipient,
  not by this contract, after state is final. A recipient that rejects ETH reverts the whole
  transaction and the pack survives untouched; a recipient that reenters finds the guard held.

`open`, `openTo` and `claim` push with plain `transferFrom`, which calls no receiver hook, so a
recipient cannot be handed control and cannot grief an exit by refusing. The inherited ERC-721
transfer and approval functions are not guarded: they move no ETH and no custody beyond the pack
token itself, and they are not guarded in Shapes either (Shapes SECURITY.md, finding 4). A receiver of
a pack `safeTransferFrom` can therefore call back into the contract from inside its hook; accounting
stays exact, because state is final before the hook runs.

---

## Standing caveats for anyone using or deploying this

1. **Do not push Shapes into the contract.** Use `createPack` or `addToPack` (finding 1).
2. **Packs are public.** Contents are readable onchain from the moment a pack exists, and Shape
   seeds are public. A pack is not a blind box, and nothing here makes it one.
3. **Exit cost scales with size.** If you build or buy a large pack, plan on `unseal` and `claim`
   (finding 5).
4. **The admin controls presentation until locked.** Hold it in a multisig and lock it once the
   art is final (finding 6). It is never custody.
5. **The mint fee belongs to Shapes.** The pack adds no fee. The amount is Shapes' to change within
   its cap, and exact payment turns a mid-flight change into a revert (finding 3).
6. **ERC-8060 support follows an open draft.** `valueOf` and `burn` match the draft Shapes
   implements; an immutable deployment cannot follow later changes.
7. **This is not a substitute for a professional audit** before real value is at risk.
