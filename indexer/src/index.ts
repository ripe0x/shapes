import { zeroAddress } from "viem";

import { ponder } from "ponder:registry";

import { lineageEdge, token } from "../ponder.schema";
import { backingForDenomIndex, denomIndexOfWei } from "./lib/denominations";
import { childSeedOf } from "./lib/seed";

// Unique id for one edge within one event: a compose/decompose/restore call loops over an id
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
// per compose (the survivor), per decompose child, and per restore, always after the structural
// event that creates or continues the row, so the row exists to update here.
ponder.on("Shapes:InkGene", async ({ event, context }) => {
  const { tokenId, gene } = event.args;

  await context.db.update(token, { id: tokenId }).set({ inkGene: gene });
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

// tokenId is consumed; newIds[] are born from it, each seed derived from tokenId's seed and its
// position. Modeled as parentId=tokenId "split into" each newId (kind "split"), since the split
// direction runs the opposite way from compose/restore's "consumed into" edges.
ponder.on("Shapes:Decomposed", async ({ event, context }) => {
  const { tokenId, parentSeed, newIds, outDenoms, originCounts } = event.args;

  // Neither Decomposed nor Restored carries a recipient: both mint to msg.sender of the call,
  // which has no argument of its own in either event. We take event.transaction.from as that
  // recipient, which holds for a direct EOA call and is corrected by the Transfer handler below
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

// childIds[] (a split's complete output set) are consumed into a freshly minted newTokenId,
// which carries the split input's original seed and denomination. Each child becomes a "restore"
// edge into newTokenId.
ponder.on("Shapes:Restored", async ({ event, context }) => {
  const { newTokenId, parentSeed, childIds, denomIndex: denomIndexRaw, originCount } = event.args;
  const denomIndex = Number(denomIndexRaw);

  // Same recipient caveat as Decomposed: restore() takes no "to" argument either.
  const owner = event.transaction.from;

  await context.db.insert(token).values({
    id: newTokenId,
    seed: parentSeed,
    denomIndex,
    backingWei: backingForDenomIndex(denomIndex),
    originCount: Number(originCount),
    isBlack: false,
    live: true,
    owner,
    mintedAtBlock: event.block.number,
    mintTxHash: event.transaction.hash,
  });

  for (let i = 0; i < childIds.length; i++) {
    const childId = childIds[i]!;
    const child = await context.db.find(token, { id: childId });
    if (!child) {
      throw new Error(`Shapes indexer: Restored consumed unknown token ${childId}`);
    }

    await context.db.update(token, { id: childId }).set({ live: false });

    await context.db.insert(lineageEdge).values({
      id: edgeId(event.transaction.hash, event.log.logIndex, i),
      childId,
      parentId: newTokenId,
      kind: "restore",
      childSeed: child.seed,
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
// here: ShapeMinted, Decomposed, and Restored already set the initial owner on the rows they
// create, and a redeemed/consumed token's owner is no longer meaningful.
ponder.on("Shapes:Transfer", async ({ event, context }) => {
  const { from, to, tokenId } = event.args;

  if (from === zeroAddress || to === zeroAddress) {
    return;
  }

  await context.db.update(token, { id: tokenId }).set({ owner: to });
});
