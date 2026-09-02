/**
 * Simulate collection activity on a local dev chain, so the site can be browsed in a
 * lived-in state: mints across every denomination and several actors, compositions up to
 * both a fully and a partially composed 100 ETH apex, a genuine apex Complete that is then
 * blackened (the Black Shape), a pure direct 100 ETH left untouched, one-tier and
 * mixed-multiset splits, transfers, and redemptions.
 *
 *   ./script/fork-dev.sh          # chain up first, from the repo root
 *   cd preview && npm run simulate
 *
 * Idempotent in spirit, not in effect: every run appends a fresh round of activity. Uses
 * anvil's well-known test accounts (never the SEED_WALLETS address, which it only sends
 * presents to). Local chains only.
 *
 * For weeks of dated history across 30 wallets exercising every entrypoint, see
 * `simulateHistory.ts` (`npm run simulate:history`) instead.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {createSim, ANVIL_KEYS, PRESENTS_TO} from "./sim/lib";
import {shapesAbi, type Deployment} from "../src/chain/abi";

const here = dirname(fileURLToPath(import.meta.url));
const dep: Deployment = JSON.parse(readFileSync(join(here, "../public/deployment.json"), "utf8"));

// Anvil's default, publicly-known test keys. Account 9 is left alone.
const KEYS = ANVIL_KEYS.slice(0, 8);

const sim = await createSim(dep, KEYS);
const {mint, compose, split, redeem, sacrifice, transfer, composeUp, actors} = sim;

async function main() {
  console.log(`simulating against ${dep.shapes} on ${dep.rpc}\n`);

  console.log("1. baseline mints, all denominations, several wallets");
  const dust1 = await mint(1, 0, 12);
  const dust2 = await mint(2, 0, 8);
  await mint(2, 1, 6); // 0.05s, left as they were minted
  const dimes = await mint(3, 2, 8);
  const halves = await mint(1, 3, 5);
  const ones4 = await mint(4, 4, 10);
  const fives5 = await mint(5, 5, 4);
  const tens3 = await mint(3, 6, 3);
  await mint(4, 7, 1); // a lone direct 50
  // A pure direct 100 ETH: one mint, originCount 1. Never sacrificed (sacrifice needs an apex
  // Complete, 10,000 origins), so this is the "untouched 100" that stays fully redeemable.
  const [pureApex] = await mint(5, 8, 1);

  console.log("2. the fully composed apex: 100 x 1 ETH walked up the whole ladder");
  const leaves: bigint[] = [];
  for (let b = 0; b < 5; b++) leaves.push(...(await mint(6, 4, 20)));
  const fives = await composeUp(6, leaves, 5); // 20 x 5
  const tens = await composeUp(6, fives, 2); // 10 x 10
  const fifties = await composeUp(6, tens, 5); // 2 x 50
  const [deepApex] = await composeUp(6, fifties, 2); // 1 x 100
  console.log(`   deep apex: #${deepApex} (tree: 100 -> 2x50 -> 10x10 -> 20x5 -> 100x1)`);

  console.log("3. the partially composed apex: one direct 50 + one built 50");
  const [direct50] = await mint(7, 7, 1);
  const built10s = await mint(7, 6, 5);
  const [built50] = await composeUp(7, built10s, 5);
  const partialApex = await compose(7, direct50!, [built50!]);
  console.log(`   partial apex: #${partialApex} (one branch deep, one branch a mint)`);

  console.log("4. the Black Shape: a genuine apex Complete, sacrificed (slow: 10k mints across 10 batches)");
  // 10,000 x 0.01 composed into one 100 ETH token carrying 10,000 origins (an apex Complete,
  // originCount == units). Only that state can be sacrificed: it sends the 100 ETH to the
  // burn address and inverts the art (black form on white). Terminal thereafter.
  //
  // Built in 1,000-token batches: a single 10,000-mint tx mines fine on the dev chain, but its
  // receipt carries 20,000 logs and exceeds the RPC client's response-size limit. Each batch
  // composes to a 10 ETH token, then the ten 10 ETH tokens compose to the 100 ETH apex.
  const blackTens: bigint[] = [];
  for (let b = 0; b < 10; b++) {
    const batch = await mint(0, 0, 1_000); // 1,000 x 0.01
    blackTens.push(await compose(0, batch[0]!, batch.slice(1))); // -> 10 ETH, originCount 1,000
  }
  const apexComplete = await compose(0, blackTens[0]!, blackTens.slice(1)); // 10 x 10 ETH -> 100 ETH, originCount 10,000
  await sacrifice(0, apexComplete);
  console.log(`   black shape: #${apexComplete} (10,000 origins sacrificed; 100 ETH burned)`);

  console.log("5. mid-tier compositions");
  const [nickel] = await composeUp(2, dust2.slice(0, 5), 5); // 5 x 0.01 -> 0.05
  const [half] = await composeUp(3, dimes.slice(0, 5), 5); // 5 x 0.1  -> 0.5
  const [five] = await composeUp(4, ones4.slice(0, 5), 5); // 5 x 1    -> 5
  const [extraFive] = await mint(4, 5, 1);
  const ten = await compose(4, five!, [extraFive!]); // built 5 + direct 5 -> 10

  console.log("6. splits: one-tier, mixed multiset, and deep");
  await split(1, halves[0]!, [2, 2, 2, 2, 2]); // 0.5 -> 5 x 0.1
  const mixedKids = await split(4, ones4[5]!, [3, 2, 2, 2, 2, 2]); // 1 -> 0.5 + 5 x 0.1
  await split(3, tens3[0]!, [5, 5]); // 10 -> 2 x 5

  console.log("7. transfers, including presents for the browsing wallet");
  await transfer(6, PRESENTS_TO, deepApex!);
  await transfer(7, PRESENTS_TO, partialApex);
  await transfer(0, PRESENTS_TO, apexComplete); // the Black Shape
  await transfer(5, PRESENTS_TO, pureApex!); // the pure, un-blackened direct 100
  await transfer(4, PRESENTS_TO, ten);
  await transfer(4, PRESENTS_TO, mixedKids[0]!); // the 0.5 piece of the mixed split
  await transfer(1, actors[3]!.account!.address, halves[3]!);
  await transfer(2, actors[5]!.account!.address, nickel!);
  await transfer(3, actors[2]!.account!.address, half!);
  await transfer(5, actors[1]!.account!.address, fives5[1]!);

  console.log("8. redemptions");
  await redeem(1, dust1[0]!);
  await redeem(1, dust1[1]!);
  await redeem(3, dimes[6]!);
  await redeem(5, fives5[2]!);
  await redeem(4, mixedKids[1]!); // a piece of the mixed split; splitting is final

  const supply = await sim.pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "totalSupply"});
  const reserve = await sim.pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "redeemableBacking"});
  console.log(`\ndone: ${sim.txCount()} transactions, ${supply} live Shapes, reserve ${reserve} wei`);
  console.log(
    `the browsing wallet ${PRESENTS_TO} holds the Black Shape, a pure direct 100, both composed apexes, a built 10, and a split piece`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
