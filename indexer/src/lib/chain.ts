// The indexer's own configured chain id, resolved the same way `ponder.config.ts` resolves
// `CHAIN_ID` (same env var, same 31347 dev-chain default), without importing ponder.config.ts
// itself: that file throws at import time when SHAPES_ADDRESS/AUCTION_HOUSE_ADDRESS are unset,
// which a route module must not trigger just by being imported.
export const CONFIGURED_CHAIN_ID = Number(process.env.PONDER_CHAIN_ID ?? 31347);
