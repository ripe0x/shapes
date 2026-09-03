/**
 * Keeps a live auction open for token #0, the collection owner token, so the site's auction page
 * always has a running auction to bid on. Runs as the last step of `simulateHistory.ts`, or
 * standalone against an already-seeded chain:
 *
 *   cd preview && npm run sim:owner-auction
 *
 * Idempotent: if token #0's auction is still running, this is a no-op (logged). If it has ended
 * without being settled, it settles it (permissionless: returns the lot to the seller when no bid
 * ever landed, or hands it to the winner) and opens a fresh auction from whoever owns token #0
 * afterward. If that owner is not one of `sim`'s actors, it logs and exits cleanly rather than
 * failing: nothing on chain is left half-done.
 *
 * `ShapeAuctionHouse` starts an auction's clock on its first bid, not at `createAuction`
 * (`endTime` is 0 until then; see `bid` in ShapeAuctionHouse.sol). So a reserve-level bid from a
 * second actor follows every creation immediately, in the same run, to open the countdown before
 * the standalone process exits.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import type {Address} from "viem";
import {createSim, ANVIL_KEYS, derivedKey, type Sim} from "./sim/lib";
import {shapesAbi, auctionHouseAbi, type Deployment} from "../src/chain/abi";
import {isSettleable} from "../src/site/auction";

const OWNER_TOKEN_ID = 0n;
// Local dev only: mainnet auctions run 24 hours and are never created by this simulation.
const AUCTION_DURATION_SECONDS = 600;
const RESERVE_UNITS = 1n;
const MIN_INCREMENT_BPS = 500;
const EXTENSION_WINDOW_SECONDS = 300;

/** The sim actor currently holding token #0, or null (logged) if none of `sim`'s actors control
 *  it, so a fresh auction cannot be signed. */
async function findOwnerActor(sim: Sim, dep: Deployment): Promise<{idx: number; address: Address} | null> {
  const owner = (await sim.pub.readContract({
    address: dep.shapes,
    abi: shapesAbi,
    functionName: "ownerOf",
    args: [OWNER_TOKEN_ID],
  })) as Address;
  const idx = sim.actors.findIndex((a) => a.account!.address.toLowerCase() === owner.toLowerCase());
  if (idx < 0) {
    console.log(`\nowner auction: token #0's owner ${owner} is not one of this run's wallets, cannot open a fresh auction`);
    return null;
  }
  return {idx, address: owner};
}

/** Approves the auction house from `ownerIdx` if needed, creates the auction for token #0, and
 *  places one reserve-level bid from a different actor to start its clock. */
async function createAndOpenAuction(sim: Sim, dep: Deployment, ownerIdx: number, ownerAddr: Address) {
  const approved = (await sim.pub.readContract({
    address: dep.shapes,
    abi: shapesAbi,
    functionName: "isApprovedForAll",
    args: [ownerAddr, dep.auctionHouse!],
  })) as boolean;
  if (!approved) await sim.setApprovalForAll(ownerIdx, dep.auctionHouse!, true);

  const auctionId = await sim.createAuction(
    ownerIdx,
    OWNER_TOKEN_ID,
    AUCTION_DURATION_SECONDS,
    RESERVE_UNITS,
    MIN_INCREMENT_BPS,
    EXTENSION_WINDOW_SECONDS,
  );

  // Reserve-level bid from a different actor: starts the auction's clock (endTime is 0, and the
  // seller cannot bid its own lot) so the auction is genuinely live, not merely created.
  const bidderIdx = sim.actors.findIndex((a) => a.account!.address.toLowerCase() !== ownerAddr.toLowerCase());
  if (bidderIdx < 0) throw new Error("openOwnerAuction: no second signer available to place the opening bid");
  const minUnits = await sim.minimumBid(auctionId);
  await sim.auctionBid(bidderIdx, auctionId, [], minUnits * sim.D[0]!.wei);

  const auction = await sim.getAuction(auctionId);
  console.log(`\nowner auction: created auction #${auctionId} for token #0, opening bid placed`);
  console.log(`  ends: ${new Date(Number(auction.endTime) * 1000).toISOString()} (unix ${auction.endTime})`);
}

export async function openOwnerAuction(sim: Sim, dep: Deployment) {
  if (!dep.auctionHouse) throw new Error("openOwnerAuction: deployment has no auctionHouse");

  const [exists, auctionId] = (await sim.pub.readContract({
    address: dep.auctionHouse,
    abi: auctionHouseAbi,
    functionName: "getAuctionFor",
    args: [dep.shapes, OWNER_TOKEN_ID],
  })) as readonly [boolean, bigint];

  if (exists) {
    let auction = await sim.getAuction(auctionId);
    const now = Number((await sim.pub.getBlock()).timestamp);

    if (!auction.settled && !isSettleable(auction, now)) {
      console.log(`\nowner auction: token #0 already has an open auction (#${auctionId}), skipping`);
      return;
    }

    if (!auction.settled) {
      console.log(`\nowner auction: auction #${auctionId} for token #0 ended unsettled, settling`);
      await sim.auctionSettle(0, auctionId); // permissionless
      auction = await sim.getAuction(auctionId);
    }

    // `settle` only records the outcome; `claimLot` is the sole path that moves the NFT (see
    // ShapeAuctionHouse.sol). Until it's claimed, `ownerOf(0)` is still the auction house itself,
    // so the lot is claimed here, in the same run, rather than leaving that for a later one.
    if (!auction.lotClaimed) {
      const recipientAddr = (
        auction.highestBidder === "0x0000000000000000000000000000000000000000" ? auction.seller : auction.highestBidder
      ) as Address;
      const recipientIdx = sim.actors.findIndex((a) => a.account!.address.toLowerCase() === recipientAddr.toLowerCase());
      if (recipientIdx < 0) {
        console.log(`\nowner auction: auction #${auctionId}'s lot recipient ${recipientAddr} is not one of this run's wallets, cannot claim it`);
        return;
      }
      await sim.auctionClaimLot(recipientIdx, auctionId);
    }
  }

  const owner = await findOwnerActor(sim, dep);
  if (!owner) return; // logged above; nothing left to do
  await createAndOpenAuction(sim, dep, owner.idx, owner.address);
}

// Standalone entry point: `npm run sim:owner-auction`, against an already-seeded chain. Loads
// deployment.json the same way simulateHistory.ts does, so both paths read the same chain state.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dep: Deployment = JSON.parse(readFileSync(join(here, "../public/deployment.json"), "utf8"));
  const derivedKeys = Array.from({length: 20}, (_, i) => derivedKey("shapes-sim", i));
  const sim = await createSim(dep, [...ANVIL_KEYS, ...derivedKeys]);
  console.log(`opening owner auction against ${dep.shapes} on ${dep.rpc}`);
  await openOwnerAuction(sim, dep);
}
