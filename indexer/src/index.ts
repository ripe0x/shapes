import { zeroAddress } from "viem";

import { ponder } from "ponder:registry";

import { lineageEdge, token } from "../ponder.schema";
import { backingForDenomIndex, denomIndexOfWei } from "./lib/denominations";
import { childSeedOf } from "./lib/seed";

// Unique id for one edge within one event: a compose/decompose call loops over an id
// array and emits one lineage edge per element, all sharing a transaction hash and log index.
function edgeId(txHash: `0x${string}`, logIndex: number, position: number): string {
  return `${txHash}-${logIndex}-${position}`;
}

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

  await context.db.update(token, { id: survivorId }).set({
    denomIndex,
    backingWei: backingForDenomIndex(denomIndex),
    originCount: Number(originCount),
  });

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
});

// A decompose reverses the survivor's most recent compose. The survivor keeps its id and reverts
// to the denomination and origin count it held before that merge, and every input that compose
// burned is re-minted under its original id and seed. Those ids already exist as rows, so they
// are revived rather than inserted; the per-input `ShapeRevived` events carry the ids.
ponder.on("Shapes:Decomposed", async ({ event, context }) => {
  const { survivorId, restoredIds, survivorDenomIndex, survivorOriginCount } = event.args;
  const denomIndex = Number(survivorDenomIndex);

  const owner = event.transaction.from;

  await context.db.update(token, { id: survivorId }).set({
    denomIndex,
    backingWei: backingForDenomIndex(denomIndex),
    originCount: Number(survivorOriginCount),
  });

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
});

// An apex Complete Shape sacrifices its 100 ETH backing. Terminal: it keeps its id and seed but
// stops being redeemable or recomposable.
ponder.on("Shapes:Blackened", async ({ event, context }) => {
  const { tokenId } = event.args;

  await context.db.update(token, { id: tokenId }).set({
    isBlack: true,
    backingWei: 0n,
  });
});

// A token is burned and its backing returned. Terminal.
ponder.on("Shapes:ShapeRedeemed", async ({ event, context }) => {
  const { tokenId } = event.args;

  await context.db.update(token, { id: tokenId }).set({ live: false });
});

// Ordinary ownership changes. Mint and burn transfers (from/to the zero address) are ignored
// here: ShapeMinted and Decomposed already set the initial owner on the rows they
// create, and a redeemed/consumed token's owner is no longer meaningful.
ponder.on("Shapes:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;

  if (from === zeroAddress || to === zeroAddress) {
    return;
  }

  await context.db.update(token, { id: tokenId }).set({ owner: to });
});
