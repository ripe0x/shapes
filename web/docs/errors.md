# Errors

Every revert is a custom error. Decode them with the Shapes ABI; the inherited ERC-721 errors come from OpenZeppelin 5.

## Minting

| Error | Cause |
| --- | --- |
| `UnsupportedDenomination(uint256 amountWei)` | Amount not on the ladder, or a compose sum that lands off it |
| `IncorrectPayment(uint256 expected, uint256 provided)` | `msg.value` is not exactly backing plus fees |
| `MintNotOpen()` | `block.timestamp < mintStart()` |
| `ZeroQuantity()` | Zero quantity, or an empty array to a batch function |
| `SelfCustodyRejected(uint256 tokenId)` | Mint or transfer to the Shapes contract itself |
| `DirectDepositRejected()` | Plain ETH sent to the contract |

## Redemption and fees

| Error | Cause |
| --- | --- |
| `NotShapeOwner(uint256 tokenId, address caller)` | Caller is not `ownerOf(tokenId)` |
| `TokenIsBlack(uint256 tokenId)` | A Black Shape in `redeem*`, `compose`, `decompose`, `split` or `burnBacking` |
| `InvalidRecipient(address recipient)` | Zero recipient on a `*To` redemption |
| `EthTransferFailed(address to, uint256 amountWei)` | The payout call returned false |
| `NoFeesPending()` | `withdrawFees` for a recipient with nothing owed |

## Recomposition

| Error | Cause |
| --- | --- |
| `NoComposeInputs()` | Empty `burnIds` |
| `DuplicateComposeInput(uint256 tokenId)` | An id repeated in `burnIds` |
| `CannotComposeWithSelf(uint256 tokenId)` | The survivor listed in `burnIds` |
| `NoComposeRecord(uint256 survivorId)` | `decompose` on an empty stack |
| `ComposeRecordOutOfRange(uint256 survivorId, uint256 depth, uint256 depthAvailable)` | `composeRecordAt` past the top |
| `SplitTooFewOutputs()` | Fewer than two outputs |
| `SplitSumMismatch(uint256 inputBacking, uint256 outputSum)` | Outputs do not sum to the input |
| `NotASplitChild(uint256 tokenId)` | `splitOriginOf` on a token not minted by split |
| `NotApexComplete(uint256 tokenId)` | `burnBacking` on anything but a Complete 100 ETH Shape |

## Reads

| Error | Cause |
| --- | --- |
| `ERC721NonexistentToken(uint256 tokenId)` | A per-token read or `ownerOf` for an id that is not live |
| `NoOwnerToken()` | `ownerToken()` after the owner token was redeemed or burned |
| `CollectionNotSet()` | `tokenURI`, `contractURI` or `lockPresentation` while the collection pointer is zero. Deployment sets it immediately |

## Administration

| Error | Cause |
| --- | --- |
| `AdminUnauthorizedAccount(address account)` | Caller is not `admin()` |
| `AdminInvalidAdmin(address admin)` | Zero address to `transferAdmin` |
| `AdminInvalidFeeRecipient(address recipient)` | Zero or the Shapes address to `setFeeRecipient` |
| `MintFeeAboveCap(uint256 fee)` | `setMintFee` above `unit()` |
| `PresentationIsLocked()` | `setRenderer`, `setCollection`, `lockPresentation` or `setMetadataCopy` after the lock |
| `UnsupportedRenderer(address renderer)` | Target lacks code or `IShapeRenderer`/`IShapeGeometry` support |
| `UnsupportedCollection(address collection)` | Target lacks `IShapeCollection` support or reports another `shapes()` |
| `InvalidPointer()` | Pointer id other than 0 (Positions) or 1 (Market) |
| `InvalidPointerTarget()` | Nonzero target without code or the expected ERC-165 answer |
| `PointerIsLocked()` | `setPointer` or `lockPointer` after that pointer's lock |
| `ArtistAlreadyAttested()`, `InvalidArtistReleaseHash()`, `InvalidArtistSignature()` | `attestArtist` |

## ERC-721

`ERC721InvalidOwner`, `ERC721NonexistentToken`, `ERC721IncorrectOwner`, `ERC721InvalidSender`, `ERC721InvalidReceiver`, `ERC721InsufficientApproval`, `ERC721InvalidApprover` and `ERC721InvalidOperator` are OpenZeppelin's. `ERC721InvalidReceiver(address)` is what you see when a contract recipient lacks `onERC721Received`.
