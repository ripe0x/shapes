/**
 * Keeps a live auction open for token #0, the collection owner token, so the site's auction page
 * always has a running auction to bid on. Runs as the last step of `simulateHistory.ts`, or
 * standalone against an already-seeded chain:
 *
 *   cd preview && npm run sim:owner-auction
 *
 * Idempotent: if token #0's auction is still running, this is a no-op (logged). If it has ended
 * without being settled, it settles it (permissionless: returns the lot to the seller when no bid
 * ever landed, or hands it to the winner), claims the lot, and opens a fresh auction from whoever
 * owns token #0 afterward. That owner (or lot recipient) is often a real wallet, not one of
 * `sim`'s actors: on chain id 31337 that address is impersonated via anvil (`actorFor`) so the dev
 * loop keeps cycling regardless of who holds the token; on any other chain, an address outside
 * `sim`'s actors logs and exits cleanly rather than failing.
 *
 * `ShapeAuctionHouse` starts an auction's clock on its first bid, not at `createAuction`
 * (`endTime` is 0 until then; see `bid` in ShapeAuctionHouse.sol). So a reserve-level bid from a
 * second actor follows every creation immediately, in the same run, to open the countdown before
 * the standalone process exits.
 *
 * START_DELAY (seconds, default 0) creates the auction with a future `startTime`: latest block
 * timestamp plus the delay. `bid` reverts `NotStarted` before that time, so the opening bid is
 * skipped when START_DELAY is set; the script logs the resolved start time instead.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {createWalletClient, defineChain, http, type Address} from "viem";
import {createSim, ANVIL_KEYS, derivedKey, type Sim} from "./sim/lib";
import {shapesAbi, auctionHouseAbi, type Deployment} from "../src/chain/abi";
import {isSettleable} from "../src/site/auction";

const ANVIL_CHAIN_ID = 31337;

const OWNER_TOKEN_ID = 0n;
// Local dev only: mainnet auctions run 24 hours and are never created by this simulation.
const AUCTION_DURATION_SECONDS = 600;
const RESERVE_UNITS = 1n;
const MIN_INCREMENT_BPS = 500;
const EXTENSION_WINDOW_SECONDS = 300;

/** START_DELAY seconds from the latest block timestamp, read right before createAuction. 0 opens
 *  the listing at creation and places the opening bid; a positive value schedules the start and
 *  places no bid. */
const START_DELAY_RAW = process.env.START_DELAY ?? "0";
if (!/^\d+$/.test(START_DELAY_RAW)) {
  throw new Error(`START_DELAY must be a non-negative integer number of seconds, got "${START_DELAY_RAW}"`);
}
const START_DELAY = Number(START_DELAY_RAW);

/** Impersonates `address` via anvil so it can sign without a private key: tops its balance up to
 *  10 ETH if under 1 (gas only, the calls that follow carry no value), and pushes a
 *  json-rpc-account wallet client for it onto `sim.actors` (so every existing sim helper, which
 *  signs by actor index, works unchanged). Anvil only: dev-chain-only account takeover, never
 *  applicable to a real network. */
async function impersonateActor(sim: Sim, dep: Deployment, address: Address): Promise<number> {
  await sim.pub.request({method: "anvil_impersonateAccount", params: [address]} as never);
  const balance = await sim.pub.getBalance({address});
  if (balance < 10n ** 18n) await sim.fund(address, 10n);
  const chain = defineChain({
    id: dep.chainId,
    name: "dev",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [dep.rpc]}},
  });
  // A bare address as `account` makes viem sign via `eth_sendTransaction` (the node signs, since
  // anvil has the account unlocked) instead of a local private key.
  sim.actors.push(createWalletClient({chain, transport: http(dep.rpc), account: address}));
  return sim.actors.length - 1;
}

/**
 * Resolves any address (a claim recipient, or token #0's current owner) to a `sim.actors` index
 * it can sign from: a `sim` actor directly if it's one of the simulation's wallets, otherwise
 * (chain 31337 only) an impersonated stand-in, memoized so the same address is impersonated at
 * most once per run and reused across both the claim and the relist. `actorFor` returns -1
 * (logged) on any other chain when the address isn't one of `sim`'s actors, so callers can bail
 * out cleanly rather than fail. `cleanup` un-impersonates every address this resolver
 * impersonated; call it once, after every use of `actorFor` is done.
 */
function actorResolver(sim: Sim, dep: Deployment) {
  const impersonated = new Map<string, number>(); // lowercased address -> sim.actors index
  const actorFor = async (address: Address): Promise<number> => {
    const known = sim.actors.findIndex((a) => a.account!.address.toLowerCase() === address.toLowerCase());
    if (known >= 0) return known;

    const key = address.toLowerCase();
    const cached = impersonated.get(key);
    if (cached !== undefined) return cached;

    if (dep.chainId !== ANVIL_CHAIN_ID) {
      console.log(`\nowner auction: ${address} is not one of this run's wallets, cannot sign for it`);
      return -1;
    }
    console.log(`\nowner auction: ${address} is not one of this run's wallets, impersonating it (chain ${ANVIL_CHAIN_ID})`);
    const idx = await impersonateActor(sim, dep, address);
    impersonated.set(key, idx);
    return idx;
  };
  const cleanup = async () => {
    for (const address of impersonated.keys()) {
      await sim.pub.request({method: "anvil_stopImpersonatingAccount", params: [address]} as never);
    }
  };
  return {actorFor, cleanup};
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

  // Resolved right before creation, off the latest block's own timestamp, not process start time.
  const startTime =
    START_DELAY > 0 ? BigInt((await sim.pub.getBlock()).timestamp) + BigInt(START_DELAY) : 0n;

  const auctionId = await sim.createAuction(
    ownerIdx,
    OWNER_TOKEN_ID,
    AUCTION_DURATION_SECONDS,
    RESERVE_UNITS,
    MIN_INCREMENT_BPS,
    EXTENSION_WINDOW_SECONDS,
    startTime,
  );

  if (startTime > 0n) {
    console.log(`\nowner auction: created auction #${auctionId} for token #0, scheduled`);
    console.log(`  starts: ${new Date(Number(startTime) * 1000).toISOString()} (unix ${startTime})`);
    return;
  }

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
  const {actorFor, cleanup} = actorResolver(sim, dep);

  try {
    const [exists, auctionId] = (await sim.pub.readContract({
      address: dep.auctionHouse,
      abi: auctionHouseAbi,
      functionName: "getAuctionFor",
      args: [dep.shapes, OWNER_TOKEN_ID],
    })) as readonly [boolean, bigint];

    if (exists) {
      let auction = await sim.getAuction(auctionId);
      // anvil only stamps time onto mined blocks, so the latest block can be minutes stale
      // between transactions. Mine an empty block first so the check uses the time the next tx
      // would get.
      await sim.pub.request({method: "evm_mine", params: []} as never);
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
      // ShapeAuctionHouse.sol). Until it's claimed, `ownerOf(0)` is still the auction house
      // itself, so the lot is claimed here, in the same run, rather than leaving that for later.
      if (!auction.lotClaimed) {
        const recipientAddr = (
          auction.highestBidder === "0x0000000000000000000000000000000000000000" ? auction.seller : auction.highestBidder
        ) as Address;
        const recipientIdx = await actorFor(recipientAddr);
        if (recipientIdx < 0) return; // logged above; nothing left to do
        await sim.auctionClaimLot(recipientIdx, auctionId);
      }
    }

    const owner = (await sim.pub.readContract({
      address: dep.shapes,
      abi: shapesAbi,
      functionName: "ownerOf",
      args: [OWNER_TOKEN_ID],
    })) as Address;
    const ownerIdx = await actorFor(owner);
    if (ownerIdx < 0) return; // logged above; nothing left to do
    await createAndOpenAuction(sim, dep, ownerIdx, owner);
  } finally {
    await cleanup();
  }
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
