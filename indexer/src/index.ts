import { zeroAddress } from "viem";

import { ponder } from "ponder:registry";

import { activity, auctionLot, collectionOwner, lineageEdge, token } from "../ponder.schema";
import { activityRow, mintActivityId, type ActivityAt } from "./lib/activity";
import { backingForDenomIndex, denomIndexOfWei } from "./lib/denominations";
import { childSeedOf } from "./lib/seed";

// Unique id for one edge within one event: a compose/decompose call loops over an id
// array and emits one lineage edge per element, all sharing a transaction hash and log index.
function edgeId(txHash: `0x${string}`, logIndex: number, position: number): string {
  return `${txHash}-${logIndex}-${position}`;
}

// Chain position of the event being handled, for the activity row it writes.
function at(event: {
  log: { logIndex: number };
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: `0x${string}` };
}): ActivityAt {
  return {
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  };
}

// `collectionOwner` has exactly one row, keyed by this constant id.
const OWNER_SINGLETON_ID = "singleton";
// The contract's "no owner token" sentinel: type(uint256).max.
const NO_OWNER_TOKEN = 2n ** 256n - 1n;

// A token is born. originCount is always 1 on this event; the contract emits it only from a
// direct mint, never from recomposition.
ponder.on("Shapes:ShapeMinted", async ({ event, context }) => {
  const { tokenId, to, amountWei, seed, originCount } = event.args;

  // amountWei always lands on a denomination (the contract reverts UnsupportedDenomination
  // otherwise), so resolve it back to an index for storage rather than duplicating a wei column.
  const denomIndex = denomIndexOfWei(amountWei);
  if (denomIndex < 0) {
    throw new Error(`Shapes indexer: ShapeMinted amountWei ${amountWei} is off the denomination ladder`);
  }

  await context.db.insert(token).values({
    id: tokenId,
    seed,
    denomIndex,
    backingWei: amountWei,
    originCount: Number(originCount),
    isBlack: false,
    live: true,
    owner: to,
    mintedAtBlock: event.block.number,
    mintTxHash: event.transaction.hash,
  });

  // One activity row per transaction, however many Shapes it minted. `actor` and `logIndex` come
  // from the first mint in the transaction; a transaction minting to more than one recipient is
  // credited to that first recipient.
  await context.db
    .insert(activity)
    .values({
      ...activityRow(at(event), "mint", [tokenId], to, { amountWei }),
      id: mintActivityId(event.transaction.hash),
    })
    .onConflictDoUpdate((row) => ({
      tokenIds: [...row.tokenIds, tokenId],
      amountWei: (row.amountWei ?? 0n) + amountWei,
    }));
});

// A token's ink gene is assigned or reassigned. Emitted once per mint (right after ShapeMinted),
// per compose (the survivor) and per decompose child, always after the structural
// event that creates or continues the row, so the row exists to update here.
ponder.on("Shapes:InkGene", async ({ event, context }) => {
  const { tokenId, gene } = event.args;

  await context.db.update(token, { id: tokenId }).set({ inkGene: gene });
});

// A token's materialized geometry is set or restored: compose (survivor), each split child,
// decompose (survivor restore and each re-minted input). Always emitted after the structural
// event that creates or continues the row (Composed/Split/Decomposed), so the row exists here.
// Empty bytes mean the token reverted to seed-derived geometry (grammar v1); store null so the
// row matches an original mint, which never gets this event.
ponder.on("Shapes:ModulesSampled", async ({ event, context }) => {
  const { tokenId, modules } = event.args;

  await context.db.update(token, { id: tokenId }).set({ modules: modules === "0x" ? null : modules });
});

// The burnedIds are consumed into survivorId, which keeps its id and seed and becomes the summed
// denomination. Each burned id becomes a "continuation" edge into the survivor.
ponder.on("Shapes:Composed", async ({ event, context }) => {
  const { survivorId, burnedIds, denomIndex: denomIndexRaw, originCount } = event.args;
  const denomIndex = Number(denomIndexRaw);

  await context.db.update(token, { id: survivorId }).set((row) => ({
    denomIndex,
    backingWei: backingForDenomIndex(denomIndex),
    originCount: Number(originCount),
    composeDepth: row.composeDepth + 1,
  }));

  for (let i = 0; i < burnedIds.length; i++) {
    const burnedId = burnedIds[i]!;
    const burned = await context.db.find(token, { id: burnedId });
    if (!burned) {
      throw new Error(`Shapes indexer: Composed burned unknown token ${burnedId}`);
    }

    await context.db.update(token, { id: burnedId }).set({ live: false });

    await context.db.insert(lineageEdge).values({
      id: edgeId(event.transaction.hash, event.log.logIndex, i),
      childId: burnedId,
      parentId: survivorId,
      kind: "continuation",
      childSeed: burned.seed,
      block: event.block.number,
      txHash: event.transaction.hash,
    });
  }

  await context.db
    .insert(activity)
    .values(
      activityRow(at(event), "compose", [survivorId, ...burnedIds], event.transaction.from),
    );
});

// A split burns its input and mints fresh children, each seeded deterministically from the
// parent. This is the one-way shatter; nothing reassembles it.
ponder.on("Shapes:Split", async ({ event, context }) => {
  const { tokenId, parentSeed, newIds, outDenoms, originCounts } = event.args;

  // Split carries no recipient: it mints to msg.sender, which the event does not name. Taking
  // event.transaction.from holds for a direct EOA call and is corrected by the Transfer handler
  // for any other case.
  const owner = event.transaction.from;

  await context.db.update(token, { id: tokenId }).set({ live: false });

  for (let i = 0; i < newIds.length; i++) {
    const newId = newIds[i]!;
    const denomIndex = Number(outDenoms[i]!);
    const seed = childSeedOf(parentSeed, i);

    await context.db.insert(token).values({
      id: newId,
      seed,
      denomIndex,
      backingWei: backingForDenomIndex(denomIndex),
      originCount: Number(originCounts[i]!),
      isBlack: false,
      live: true,
      owner,
      mintedAtBlock: event.block.number,
      mintTxHash: event.transaction.hash,
    });

    await context.db.insert(lineageEdge).values({
      id: edgeId(event.transaction.hash, event.log.logIndex, i),
      childId: newId,
      parentId: tokenId,
      kind: "split",
      childSeed: seed,
      block: event.block.number,
      txHash: event.transaction.hash,
    });
  }

  await context.db
    .insert(activity)
    .values(activityRow(at(event), "split", [tokenId, ...newIds], owner));
});

// A decompose reverses the survivor's most recent compose. The survivor keeps its id and reverts
// to the denomination and origin count it held before that merge, and every input that compose
// burned is re-minted under its original id and seed. Those ids already exist as rows, so they
// are revived rather than inserted; the per-input `ShapeRevived` events carry the ids.
ponder.on("Shapes:Decomposed", async ({ event, context }) => {
  const { survivorId, restoredIds, survivorDenomIndex, survivorOriginCount } = event.args;
  const denomIndex = Number(survivorDenomIndex);

  const owner = event.transaction.from;

  await context.db.update(token, { id: survivorId }).set((row) => ({
    denomIndex,
    backingWei: backingForDenomIndex(denomIndex),
    originCount: Number(survivorOriginCount),
    composeDepth: row.composeDepth - 1,
  }));

  for (let i = 0; i < restoredIds.length; i++) {
    const revivedId = restoredIds[i]!;
    const prior = await context.db.find(token, { id: revivedId });
    if (!prior) {
      throw new Error(`Shapes indexer: Decomposed revived unknown token ${revivedId}`);
    }

    // The row still carries the seed, denomination and origins it was burned with, which is
    // exactly what decompose writes back. Only liveness and ownership move.
    await context.db.update(token, { id: revivedId }).set({ live: true, owner });

    await context.db.insert(lineageEdge).values({
      id: edgeId(event.transaction.hash, event.log.logIndex, i),
      childId: revivedId,
      parentId: survivorId,
      kind: "revival",
      childSeed: prior.seed,
      block: event.block.number,
      txHash: event.transaction.hash,
    });
  }

  await context.db
    .insert(activity)
    .values(activityRow(at(event), "decompose", [survivorId, ...restoredIds], owner));
});

// An apex Complete Shape has its 100 ETH backing burned. Terminal: it keeps its id and seed but
// stops being redeemable or recomposable.
ponder.on("Shapes:BlackShapeCreated", async ({ event, context }) => {
  const { tokenId, burnedWei } = event.args;

  await context.db.update(token, { id: tokenId }).set({
    isBlack: true,
    backingWei: 0n,
  });

  await context.db
    .insert(activity)
    .values(
      activityRow(at(event), "burnBacking", [tokenId], event.transaction.from, {
        amountWei: burnedWei,
      }),
    );
});

// A token is burned and its backing returned. Terminal.
ponder.on("Shapes:ShapeRedeemed", async ({ event, context }) => {
  const { tokenId, to, amountWei } = event.args;

  await context.db.update(token, { id: tokenId }).set({ live: false });

  await context.db
    .insert(activity)
    .values(activityRow(at(event), "redeem", [tokenId], to, { amountWei }));
});

// The collection owner token moves: constructor genesis (max -> 0), compose (donor ->
// survivor), decompose (survivor -> restored input), split (parent -> first child), and
// redeem/burn of the owner token (id -> max, "none"). Only `toTokenId` matters for state.
// `ownerAddress` is read from the target token's row when it already carries the right value
// (compose survivor, decompose restore, or a mint row inserted with its final owner). Where the
// row isn't there yet or still holds a stale owner, the Transfer handler below corrects it;
// every path that changes the owner token's holder also emits a Transfer in the same tx.
ponder.on("Shapes:OwnerTokenMoved", async ({ event, context }) => {
  const { fromTokenId, toTokenId } = event.args;
  const none = toTokenId === NO_OWNER_TOKEN;

  const ownerTokenId = none ? null : toTokenId;
  const ownerAddress = none ? null : ((await context.db.find(token, { id: toTokenId }))?.owner ?? null);

  await context.db
    .insert(collectionOwner)
    .values({ id: OWNER_SINGLETON_ID, ownerTokenId, ownerAddress, updatedAtBlock: event.block.number })
    .onConflictDoUpdate({ ownerTokenId, ownerAddress, updatedAtBlock: event.block.number });

  const moved = [fromTokenId, toTokenId].filter((id) => id !== NO_OWNER_TOKEN);
  await context.db
    .insert(activity)
    .values(activityRow(at(event), "ownerTokenMoved", moved, event.transaction.from));
});

// Every non-burn transfer establishes the canonical owner. This deliberately includes mint
// transfers: splitTo/decomposeTo only expose the recipient in ERC721 Transfer, not in their
// aggregate structural event, so transaction.from is insufficient for contracts and delegated
// recipients. The matching row has been inserted/revived before _safeMint emits this event.
ponder.on("Shapes:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;

  if (to === zeroAddress) {
    return;
  }

  await context.db.update(token, { id: tokenId }).set({ owner: to });

  // If this transfer moves the current owner token, keep the singleton's address in sync. This
  // covers OwnerTokenMoved firing before the row exists or before its owner is final.
  const collectionOwnerRow = await context.db.find(collectionOwner, { id: OWNER_SINGLETON_ID });
  if (collectionOwnerRow?.ownerTokenId === tokenId) {
    await context.db.update(collectionOwner, { id: OWNER_SINGLETON_ID }).set({ ownerAddress: to });
  }

  // Only a holder-to-holder move is its own activity. A mint transfer is already the mint row,
  // and the burn transfers are the redeem, compose and split rows.
  if (from !== zeroAddress) {
    await context.db
      .insert(activity)
      .values(activityRow(at(event), "transfer", [tokenId], from, { counterparty: to }));
  }
});

// A seller escrows a lot and opens an auction. `nft` is any ERC721; only a Shapes lot carries a
// token id the feed can draw, and that id is kept for the bid, settlement and claim rows.
ponder.on("ShapeAuctionHouse:AuctionCreated", async ({ event, context }) => {
  const { auctionId, seller, nft, tokenId } = event.args;
  const lot = nft.toLowerCase() === context.contracts.Shapes.address?.toLowerCase() ? tokenId : null;

  await context.db.insert(auctionLot).values({ id: auctionId, tokenId: lot });

  await context.db
    .insert(activity)
    .values(
      activityRow(at(event), "auctionCreated", lot === null ? [] : [lot], seller, { auctionId }),
    );
});

/** The Shape an auction escrows, as the activity row's `tokenIds`. Empty when the auction is
 *  unknown or its lot belongs to another collection. */
function lotIds(row: { tokenId: bigint | null } | null | undefined): bigint[] {
  return row?.tokenId == null ? [] : [row.tokenId];
}

// A bid takes the lead. `units` is the bidder's whole escrowed total, not the increment.
ponder.on("ShapeAuctionHouse:BidPlaced", async ({ event, context }) => {
  const { auctionId, bidder, units } = event.args;

  await context.db
    .insert(activity)
    .values(
      activityRow(at(event), "bid", lotIds(await context.db.find(auctionLot, { id: auctionId })), bidder, {
        auctionId,
        units: BigInt(units),
      }),
    );
});

// The outcome is recorded. The lot and the winning cards are both pulled afterwards.
ponder.on("ShapeAuctionHouse:AuctionSettled", async ({ event, context }) => {
  const { auctionId, winner, units } = event.args;

  await context.db
    .insert(activity)
    .values(
      activityRow(at(event), "auctionSettled", lotIds(await context.db.find(auctionLot, { id: auctionId })), winner, {
        auctionId,
        units: BigInt(units),
      }),
    );
});

// The lot leaves the house: to the winner if the auction sold, to the seller if it was cancelled.
ponder.on("ShapeAuctionHouse:LotClaimed", async ({ event, context }) => {
  const { auctionId, to } = event.args;

  await context.db
    .insert(activity)
    .values(
      activityRow(at(event), "lotClaimed", lotIds(await context.db.find(auctionLot, { id: auctionId })), to, { auctionId }),
    );
});
