// Vendored ShapeAuctionHouse ABI: the four events the activity feed records, extracted from
// src/interfaces/IShapeAuctionHouse.sol so field order, types and indexed flags match the
// deployed bytecode exactly.
//
// Regenerate from the compiled artifact rather than editing by hand. Drifting from the contract
// silently stops the indexer decoding an event: it does not error, it simply never fires, and the
// off-chain view goes stale without saying so.
export const shapeAuctionHouseAbi = [
  {
    type: "event",
    name: "AuctionCreated",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "seller", type: "address", indexed: true, internalType: "address" },
      { name: "nft", type: "address", indexed: true, internalType: "address" },
      { name: "tokenId", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "duration", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "reserveUnits", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BidPlaced",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "bidder", type: "address", indexed: true, internalType: "address" },
      { name: "units", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "endTime", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "AuctionSettled",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "winner", type: "address", indexed: true, internalType: "address" },
      { name: "units", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "LotClaimed",
    inputs: [
      { name: "auctionId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "to", type: "address", indexed: true, internalType: "address" },
    ],
    anonymous: false,
  },
] as const;
