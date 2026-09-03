// Vendored ShapeAuctionHouse ABI: the single event the indexer decodes, extracted from the
// compiled ABI (out/ShapeAuctionHouse.sol/ShapeAuctionHouse.json) so field order, types and
// indexed flags match the deployed bytecode exactly.
//
// Regenerate from the compiled artifact rather than editing by hand. Drifting from the contract
// silently stops the indexer decoding the event: it does not error, it simply never fires, and
// the off-chain view goes stale without saying so.
export const auctionHouseAbi = [
  {
    "type": "event",
    "name": "BidPlaced",
    "inputs": [
      { "name": "auctionId", "type": "uint256", "indexed": true, "internalType": "uint256" },
      { "name": "bidder", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "units", "type": "uint64", "indexed": false, "internalType": "uint64" },
      { "name": "endTime", "type": "uint64", "indexed": false, "internalType": "uint64" }
    ],
    "anonymous": false
  }
] as const;
