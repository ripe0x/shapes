// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IShapeCardEscrow} from "./IShapeCardEscrow.sol";

/// @title IShapeAuctionHouse
/// @notice An English auction for any ERC721, with bids denominated in Shape cards.
/// @dev A bid is a set of Shapes whose summed backing is the bid amount. Amounts are carried in
///      `UNIT` (0.01 ETH) multiples throughout, which is the finest granularity the denomination
///      ladder can express. Escrowed cards are never moved on an outbid; every payout is pulled.
interface IShapeAuctionHouse is IShapeCardEscrow {
    /// @notice Emitted when a seller escrows a token and opens an auction.
    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint64 duration,
        uint64 reserveUnits,
        uint64 startTime
    );

    /// @notice Emitted when a bid takes the lead. `units` is the bidder's whole escrowed total,
    ///         not the increment, because a bidder may top up across several transactions.
    ///         `endTime` is the deadline after any anti-sniping extension this bid triggered.
    event BidPlaced(uint256 indexed auctionId, address indexed bidder, uint64 units, uint64 endTime);

    /// @notice Emitted when the outcome is recorded. Moves nothing: the lot and the winning
    ///         cards are both pulled afterwards, by the winner and the seller respectively.
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint64 units);

    /// @notice Emitted when a seller closes an auction that never received a bid. The lot stays
    ///         escrowed until the seller pulls it back with `claimLot`.
    event AuctionCancelled(uint256 indexed auctionId);

    /// @notice Emitted when the lot leaves the house: to the winner if the auction sold, to the
    ///         seller if it was cancelled unsold.
    event LotClaimed(uint256 indexed auctionId, address indexed to);

    /// @notice Emitted when a losing bidder pulls their escrowed cards back.
    event BidWithdrawn(uint256 indexed auctionId, address indexed bidder, uint256 cardCount);

    /// @notice Emitted when the seller pulls the winning bid.
    event ProceedsClaimed(uint256 indexed auctionId, address indexed seller, uint256 cardCount);

    error AuctionNotFound(uint256 auctionId);
    error AuctionOver(uint256 auctionId);
    error AuctionStillRunning(uint256 auctionId);
    error AuctionAlreadySettled(uint256 auctionId);
    /// @dev `cancelAuction` was called by a non-seller, once a bid had landed, or after settlement.
    error InvalidAuction();
    /// @dev `createAuction` duration was zero or above `MAX_DURATION`.
    error DurationOutOfRange();
    /// @dev `createAuction` extension window exceeded the duration.
    error ExtensionWindowTooLong();
    /// @dev `createAuction` was given a `startTime` more than `MAX_DURATION` past the current block time.
    error StartTooFar();
    /// @dev `createAuction`'s transfer left the lot unheld by the house.
    error LotNotReceived();
    /// @dev `createAuction` was given a lot address with no code.
    error LotHasNoCode(address nft);
    /// @dev `createAuction`'s lot does not report the ERC721 interface under ERC165.
    error LotNotERC721(address nft);
    /// @dev `createAuction`'s caller neither owns the lot nor is approved for it.
    error NotTokenOwnerOrApproved(address nft, uint256 tokenId, address caller);
    /// @dev The house already holds this token under an auction that has not released it.
    error AuctionAlreadyExistsForToken(address nft, uint256 tokenId);
    /// @dev The lot has already left the house.
    error LotAlreadyClaimed(uint256 auctionId);
    /// @dev `claimLot` was called by someone other than the winner, or the seller of an auction
    ///      that was cancelled unsold.
    error NotLotRecipient(uint256 auctionId, address caller);
    /// @dev The seller bid its own auction.
    error SellerCannotBid();
    /// @dev `bid` was called before the auction's `startTime`.
    error NotStarted(uint256 auctionId, uint64 startTime);

    /// @notice The longest an auction may run. `createAuction` rejects a longer duration, and an
    ///         `extensionWindow` larger than the duration.
    function MAX_DURATION() external view returns (uint64);

    /// @notice Number of auctions ever created. Ids are issued from 0.
    function auctionCount() external view returns (uint256);

    /// @notice Escrow an ERC721 and open an auction on it, priced in Shapes. Bids open at
    ///         `startTime`; the clock that ends the auction starts at the first bid, so an
    ///         auction cannot expire unsold because nobody was watching on day one.
    /// @dev `nft` is any ERC721. The house verifies it holds the lot after the transfer, which
    ///      binds an honest implementation but not a contract that also lies about `ownerOf`: no
    ///      on-chain check distinguishes a collection that reports state truthfully from one
    ///      written to report whatever passes. A seller can therefore list a lot that will never
    ///      move, and a bidder who does not check `nft` can pay for it. That exposure is the
    ///      bidder's, it is the same one every permissionless marketplace carries, and it is
    ///      bounded to the parties who chose the auction: the lot address is reachable only from
    ///      this function and `claimLot`, so a losing bidder's escrow and a seller's proceeds,
    ///      which move Shapes alone, cannot be touched by it.
    ///
    ///      The lot is escrowed with `transferFrom` rather than `safeTransferFrom`, so the house
    ///      takes no receiver callback for it.
    ///
    ///      A Black Shape (zero backing) is accepted as a lot. Its worth is assessed by bidders,
    ///      unlike a bid's cards, which are valued at their backing and so reject a Black card.
    /// @param nft The collection the lot belongs to. Must have code and report the ERC721
    ///        interface under ERC165. That check rejects a wrong address, which is the common
    ///        mistake; it does not bind a contract written to answer it falsely.
    /// @param duration Seconds the auction runs for once the first bid lands. At most `MAX_DURATION`.
    /// @param reserveUnits Smallest winning bid, in `UNIT` multiples.
    /// @param minIncrementBps How far a bid must clear the standing one, in basis points.
    /// @param extensionWindow A bid inside this many seconds of the end pushes the end out by it.
    ///        At most `duration`.
    /// @param startTime Unix time bids open. Zero or a past time opens the listing at creation.
    ///        At most `MAX_DURATION` after the current block time.
    function createAuction(
        address nft,
        uint256 tokenId,
        uint64 duration,
        uint64 reserveUnits,
        uint16 minIncrementBps,
        uint32 extensionWindow,
        uint64 startTime
    ) external returns (uint256 auctionId);

    /// @notice Close an auction that never received a bid. Seller only. Records the outcome and
    ///         moves nothing; the seller then pulls the lot back with `claimLot`.
    function cancelAuction(uint256 auctionId) external;

    /// @notice Bid with Shapes, with ETH, or with both. Reverts `NotStarted` before the auction's
    ///         `startTime`.
    /// @dev `cardIds` are transferred in and valued at `backingOf`, which is zero for a Black
    ///      Shape and so rejects one. `ethBackingWei` is minted into the minimal card set for
    ///      that amount, which costs one flat Shapes mint fee per generated card; send exactly
    ///      `mintCostFor(ethBackingWei)`. A bidder already holding the standing bid adds to it
    ///      rather than replacing it.
    function bid(uint256 auctionId, uint256[] calldata cardIds, uint256 ethBackingWei) external payable;

    /// @notice Record the outcome. Permissionless once the auction has ended. An auction that
    ///         never received a bid never ends; the seller exits it with `cancelAuction`.
    /// @dev Moves no asset. Delivery is `claimLot` and payment is `claimProceeds`, so a lot that
    ///      cannot be transferred cannot hold the outcome, the seller's proceeds, or any losing
    ///      bidder's escrow hostage.
    function settle(uint256 auctionId) external;

    /// @notice Take delivery of the lot: the winner once the auction has settled, or the seller
    ///         of an auction that was cancelled unsold.
    /// @dev The only path by which the lot leaves the house, and the only one besides
    ///      `createAuction` that calls the lot's collection at all. It stays callable
    ///      indefinitely, so a collection that is paused when the auction ends can be claimed
    ///      once it resumes.
    function claimLot(uint256 auctionId) external;

    /// @notice Pull back the cards of a bid that is no longer leading.
    function withdraw(uint256 auctionId) external;

    /// @notice Pull the winning bid. Seller only, after settlement.
    function claimProceeds(uint256 auctionId) external;

    /* ----------------------------- views ------------------------------ */

    /// @notice The smallest bid that would take the lead right now, in `UNIT` multiples.
    function minimumBid(uint256 auctionId) external view returns (uint64);

    /// @notice The auction holding `tokenId` of `nft`, if the house currently holds it under one.
    /// @dev Paired with an existence flag because auction id 0 is a real id, and a bare zero
    ///      would be indistinguishable from no auction.
    function getAuctionFor(address nft, uint256 tokenId)
        external
        view
        returns (bool exists, uint256 auctionId);

    /// @notice Whether `tokenId` of `nft` is escrowed here under an auction that has not yet
    ///         released it. Cheaper than `getAuctionFor` when the id is not needed.
    function hasAuctionFor(address nft, uint256 tokenId) external view returns (bool);
}
