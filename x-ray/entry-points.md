# Entry Point Map

> Shapes | 33 entry points | 11 permissionless | 20 role-gated | 2 admin-only

---

## Protocol Flow Paths

### Deployment (Owner)

`new Shapes(feeBps_, feeRecipient_, renderer_, collection_)` ◄── requires `renderer_`/`collection_` already deployed and codeful → `new ShapeLens(shapes_)` (optional periphery, any time) → `new ShapeAuctionHouse(shapes_)` (optional periphery, any time)

### Minting (User)

`Shapes.mint()` / `mintTo()` / `mintBatch()` / `mintBatchTo()` — permissionless, no prerequisite beyond deployment.
  ├─→ credits `redeemableBacking`, `totalSupply`, `totalMinted`
  └─→ forwards the mint fee to `feeRecipient` before minting

### Redemption (Shape Owner)

`[mint above]` → `Shapes.redeem()` / `burn()` / `redeemBatch()` / `redeemTo()` / `redeemBatchTo()` ◄── caller must currently own the token(s); Black tokens reject `redeem`/`redeemTo`/`redeemBatch(To)` but accept `burn`

### Recomposition (Shape Owner)

`[mint above]` → `Shapes.compose()` / `composeMany()` ◄── caller owns survivor + every burn id, none Black, summed backing lands on a denomination
                                              └─→ `Shapes.decompose()` / `decomposeTo()` / `decomposeMany()` / `decomposeManyTo()` ◄── a reversible record exists (LIFO)
`[mint above]` → `Shapes.split()` / `splitTo()` ◄── caller owns the token, not Black, ≥2 outputs summing to its backing
`[mint above]` → `Shapes.sacrifice()` ◄── caller owns an apex (100 ETH) Complete Shape (`originCount == unitsAt(8)`), not Black

### Presentation & Governance (Owner)

`Shapes.setRenderer()` / `setCollection()` (◄── `!rendererLocked`) → `Shapes.lockRenderer()` (one-way)
`Shapes.setTokenCopy()` / `setCollectionCopy()` — independent of the renderer lock, always editable
`Shapes.setPositionResolver()` (◄── `!positionResolverLocked`) → `Shapes.lockPositionResolver()` (one-way)
`Shapes.setContractCollectorToken()` (◄── binding unlocked) → `Shapes.lockContractCollectorBinding()` (one-way)

### Auction Flow (Seller / Bidder)

`[mint above, for card-denominated bids]` → `ShapeAuctionHouse.createAuction()` ◄── caller owns/approved the lot NFT
                                                          └─→ `ShapeAuctionHouse.bid()` ◄── auction not settled, not past `endTime`, bidder ≠ seller
                                                                          ├─→ `ShapeAuctionHouse.withdraw()` ◄── caller is not the current leader
                                                                          └─→ [auction ends] → `ShapeAuctionHouse.settle()` (permissionless)
                                                                                          ├─→ `ShapeAuctionHouse.claimLot()` ◄── caller is the winner
                                                                                          └─→ `ShapeAuctionHouse.claimProceeds()` ◄── caller is the seller
`[createAuction above, no bid ever received]` → `ShapeAuctionHouse.cancelAuction()` ◄── caller is the seller → `ShapeAuctionHouse.claimLot()` ◄── caller is the seller

---

## Permissionless

### `Shapes.mint(uint256 amountWei)`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, nonReentrant |
| Caller | Any user |
| Parameters | `amountWei` (user-controlled, must be one of nine fixed denominations) |
| Call chain | `→ Shapes._mintBatch() → Denominations.indexOf() → InkGenes.geneAtMint() → feeRecipient.call{value}() → Shapes._safeMint()` |
| State modified | `totalMinted`, `totalSupply`, `redeemableBacking`, `_shapes[tokenId]` |
| Value flow | in — `msg.value = amountWei + mintFeeFor(amountWei)`, fee forwarded to `feeRecipient` |
| Reentrancy guard | yes |

### `Shapes.mintTo(uint256 amountWei, address to)`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, nonReentrant |
| Caller | Any user |
| Parameters | `amountWei` (user-controlled), `to` (user-controlled recipient) |
| Call chain | same as `mint`, recipient parameterized |
| State modified | same as `mint` |
| Value flow | in |
| Reentrancy guard | yes |

### `Shapes.mintBatch(uint256 amountWei, uint256 quantity)`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, nonReentrant |
| Caller | Any user |
| Parameters | `amountWei` (user-controlled), `quantity` (user-controlled, unbounded — self-inflicted gas cost only, SECURITY.md #7) |
| Call chain | `→ Shapes._mintBatch()` (loop of `quantity` mints, one entropy root shared) |
| State modified | same as `mint`, scaled by `quantity` |
| Value flow | in — `msg.value = quantity * (amountWei + mintFeeFor(amountWei))` |
| Reentrancy guard | yes |

### `Shapes.mintBatchTo(uint256 amountWei, uint256 quantity, address to)`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, nonReentrant |
| Caller | Any user (also the internal call `ShapeCardEscrow._mintCards` uses to mint bid cards) |
| Parameters | `amountWei`, `quantity` (user/caller-controlled), `to` (user-controlled recipient) |
| Call chain | same as `mintBatch`, recipient parameterized |
| State modified | same as `mintBatch` |
| Value flow | in |
| Reentrancy guard | yes |

### `ShapeAuctionHouse.createAuction(address nft, uint256 tokenId, uint64 duration, uint64 reserveUnits, uint16 minIncrementBps, uint32 extensionWindow)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | The lot's owner or an approved operator |
| Parameters | `nft` (user-controlled, any ERC721), `tokenId` (user-controlled), `duration`/`reserveUnits`/`minIncrementBps`/`extensionWindow` (user-controlled, bounded by guards) |
| Call chain | `→ IERC165(nft).supportsInterface() → IERC721(nft).ownerOf() → IERC721(nft).getApproved()/isApprovedForAll() → IERC721(nft).transferFrom() → IERC721(nft).ownerOf()` |
| State modified | `auctionCount`, `_auctions[auctionId]`, `_auctionIdByToken[nft][tokenId]` |
| Value flow | none (moves the lot NFT in, not ETH or Shapes) |
| Reentrancy guard | yes |

### `ShapeAuctionHouse.bid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei)`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable, nonReentrant |
| Caller | Any user except the auction's seller |
| Parameters | `auctionId` (user-controlled), `cardIds` (user-controlled, must be caller-owned live Shapes), `ethBackingWei` (user-controlled) |
| Call chain | `→ ShapeCardEscrow._takeBid() → _takeCards() → IShapes.backingOf()/IERC721(shapes).transferFrom() → _mintCards() → IShapes.mintFeeFor()/mintBatchTo{value}()` |
| State modified | `_auctions[auctionId].highestUnits/highestBidder/endTime`, `_escrow[auctionId][msg.sender]`, `_units[auctionId][msg.sender]` |
| Value flow | in — Shape cards and/or ETH (minted into cards held in escrow) |
| Reentrancy guard | yes |

### `ShapeAuctionHouse.settle(uint256 auctionId)`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | Any user, once the auction has ended |
| Parameters | `auctionId` (user-controlled) |
| Call chain | `→ Shapes._auctions[auctionId]` storage only — no external call |
| State modified | `_auctions[auctionId].settled` |
| Value flow | none |
| Reentrancy guard | no (deliberate — calls nothing external, per contract NatSpec) |

### `Shapes.redeem(uint256 tokenId)` / `burn(uint256 tokenId)` / `redeemBatch(uint256[] calldata tokenIds)` / `redeemTo(uint256 tokenId, address payable recipient)` / `redeemBatchTo(uint256[] calldata tokenIds, address payable recipient)`

These five are grouped: each is *effectively* permissionless (any caller may invoke them) but internally gated to the token's current owner (see Role-Gated table below, "Shape Owner" role) — listed here only because the function selector itself carries no modifier. See the Role-Gated section for full detail.

---

## Role-Gated

### `Shape Owner` (enforced by `_requireCallerOwnsLive` / `_burnForRedemption`'s internal `msg.sender` check, not a modifier)

#### `Shapes.redeem(uint256 tokenId)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Current token owner |
| Parameters | `tokenId` (user-controlled) |
| Call chain | `→ Shapes._redeemTo() → _burnForRedemption() → _burn() → Shapes._sendEth()` |
| State modified | `totalSupply`, `redeemableBacking`, deletes `_shapes[tokenId]`/`_sampledModules[tokenId]` |
| Value flow | out — exact `backingOf(tokenId)` to `msg.sender` |
| Reentrancy guard | yes |

#### `Shapes.burn(uint256 tokenId)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Current token owner |
| Parameters | `tokenId` (user-controlled) |
| Call chain | same as `redeem`, but `allowBlack = true` — a Black token burns for zero with no ETH call |
| State modified | same as `redeem` |
| Value flow | out (zero if Black) |
| Reentrancy guard | yes |

#### `Shapes.redeemBatch(uint256[] calldata tokenIds)` / `redeemTo(...)` / `redeemBatchTo(...)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Current owner of every listed token |
| Parameters | `tokenIds`/`tokenId` (user-controlled), `recipient` (user-controlled, `*To` variants only) |
| Call chain | `→ Shapes._redeemBatchTo()/_redeemTo() → _burnForRedemption() (per id) → _sendEth()` (single aggregate transfer for batch) |
| State modified | same as `redeem`, `n`-wide |
| Value flow | out — summed backing, to `msg.sender` or `recipient` |
| Reentrancy guard | yes |

#### `Shapes.compose(uint256 survivorId, uint256[] calldata burnIds)` / `composeMany(ComposeCall[] calldata calls)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Owner of the survivor and every burn id |
| Parameters | `survivorId`/`burnIds` (user-controlled) |
| Call chain | `→ Shapes._compose() → GeometrySampling/ComposeCompute/InkGenes (external library calls, linked)` |
| State modified | `totalSupply`, `_shapes[survivorId]`, `_sampledModules[survivorId]`, `_composeStack[survivorId]`, deletes each burned id's `_shapes`/`_sampledModules` |
| Value flow | none |
| Reentrancy guard | yes |

#### `Shapes.decompose(uint256 survivorId)` / `decomposeTo(...)` / `decomposeMany(...)` / `decomposeManyTo(...)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Owner of the survivor |
| Parameters | `survivorId`/`survivorIds` (user-controlled), `recipient` (user-controlled, `*To` variants) |
| Call chain | `→ Shapes._decomposeTo() → Shapes._safeMint()` (re-mints each burned input) |
| State modified | `totalSupply`, `_shapes[survivorId]`, restores `_shapes[inputId]` for each popped record entry, pops `_composeStack[survivorId]` |
| Value flow | none |
| Reentrancy guard | yes |

#### `Shapes.split(uint256 tokenId, uint8[] calldata outDenoms)` / `splitTo(...)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Token owner |
| Parameters | `tokenId` (user-controlled), `outDenoms` (user-controlled, must sum to the parent's backing), `recipient` (user-controlled, `splitTo` only) |
| Call chain | `→ Shapes._splitTo() → GeometrySampling.effectiveModulesOf()/sampleSplitChild() → Shapes._safeMint()` (per child) |
| State modified | `totalSupply`, `totalMinted`, deletes parent's `_shapes`/`_sampledModules`, writes each child's `_shapes`/`_sampledModules`/`_splitOriginRef`, appends `_splitRecords` |
| Value flow | none |
| Reentrancy guard | yes |

#### `Shapes.sacrifice(uint256 tokenId)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Owner of an apex (100 ETH) Complete Shape |
| Parameters | `tokenId` (user-controlled) |
| Call chain | `→ Shapes._requireCallerOwnsLive() → Shapes._sendEth(UNSPENDABLE, 100 ether)` |
| State modified | `_shapes[tokenId].isBlack`, `redeemableBacking`, `sacrificedBacking`, `blackCount` |
| Value flow | out — fixed 100 ETH to `0x…dEaD` |
| Reentrancy guard | yes |

### `Auction Seller` (checked via `a.seller == msg.sender`)

#### `ShapeAuctionHouse.cancelAuction(uint256 auctionId)`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | The auction's seller, only before any bid, only before settlement |
| Parameters | `auctionId` (user-controlled) |
| Call chain | storage only, no external call |
| State modified | `_auctions[auctionId].settled` |
| Value flow | none |
| Reentrancy guard | no (calls nothing external) |

#### `ShapeAuctionHouse.claimProceeds(uint256 auctionId)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | The auction's seller, after settlement |
| Parameters | `auctionId` (user-controlled) |
| Call chain | `→ ShapeCardEscrow._release() → IERC721(shapes).transferFrom()` (per escrowed card) |
| State modified | deletes `_escrow[auctionId][highestBidder]`, zeroes `_units[auctionId][highestBidder]` |
| Value flow | out — the winning bid's Shape cards, to the seller |
| Reentrancy guard | yes |

### `Auction Participant (non-leader bidder)`

#### `ShapeAuctionHouse.withdraw(uint256 auctionId)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Any bidder who is not the current/final leader |
| Parameters | `auctionId` (user-controlled) |
| Call chain | `→ ShapeCardEscrow._release() → IERC721(shapes).transferFrom()` (per escrowed card) |
| State modified | deletes `_escrow[auctionId][msg.sender]`, zeroes `_units[auctionId][msg.sender]` |
| Value flow | out — caller's own escrowed cards, back to caller |
| Reentrancy guard | yes |

### `Lot Recipient` (winner, or seller of an unsold cancelled auction)

#### `ShapeAuctionHouse.claimLot(uint256 auctionId)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, nonReentrant |
| Caller | Winner (settled + bid) or seller (settled + cancelled, no bid) |
| Parameters | `auctionId` (user-controlled) |
| Call chain | `→ IERC721(a.nft).transferFrom(address(this), recipient, tokenId)` |
| State modified | `_auctions[auctionId].lotClaimed`, deletes `_auctionIdByToken[a.nft][a.tokenId]` |
| Value flow | out — the lot NFT, to `recipient` |
| Reentrancy guard | yes |

---

## Admin-Only

Gated by `Ownable.onlyOwner` on `Shapes`. None of these functions reach ETH, backing, redemption or token ownership (SECURITY.md, "Verified safe" table).

| Contract | Function | Parameters | State Modified |
|----------|----------|------------|----------------|
| Shapes | `setRenderer(address newRenderer)` | `newRenderer` (must carry code + `IShapeRenderer`) | `renderer` |
| Shapes | `lockRenderer()` | — | `rendererLocked` (one-way) |
| Shapes | `setCollection(address newCollection)` | `newCollection` (must carry code + `IShapeCollection`) | `collection` |
| Shapes | `setTokenCopy(string namePrefix, string description)` | validated UTF-8/JSON-safe, length-capped | `tokenNamePrefix`, `tokenDescription` |
| Shapes | `setCollectionCopy(string name, string description)` | validated UTF-8/JSON-safe, length-capped | `collectionName`, `collectionDescription` |
| Shapes | `setPositionResolver(address resolver_)` | zero clears; nonzero must carry code | `positionResolver` |
| Shapes | `lockPositionResolver()` | — | `positionResolverLocked` (one-way, may lock at zero) |
| Shapes | `setContractCollectorToken(address tokenContract, uint256 tokenId)` | must resolve to a nonzero `ownerOf` | `_collectorBinding.tokenContract/tokenId` |
| Shapes | `lockContractCollectorBinding()` | — | `_collectorBinding.locked` (one-way) |
| Shapes (inherited `Ownable`) | `transferOwnership(address newOwner)` | new owner address | `owner` |
| Shapes (inherited `Ownable`) | `renounceOwnership()` | — | `owner` → zero, permanently disabling every function above |

---

## Initialization

No proxy pattern is used anywhere in scope; every contract (`Shapes`, `ShapeRenderer`, `ShapeLens`, `ShapeCollection`, `ShapeAuctionHouse`) is a plain, non-upgradeable deployment configured entirely through its constructor. There is no separate `initialize()` entry point and therefore no front-runnable initialization window beyond the constructor call itself.
