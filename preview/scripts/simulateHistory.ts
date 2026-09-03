/**
 * Simulate roughly six weeks of lived-in Shapes activity on a local dev chain: 30 wallets,
 * every external function of `Shapes`, `ShapeLens` and `ShapeAuctionHouse` exercised several
 * times each, dated across `DAYS` simulated days so the site's gallery, token history, lineage
 * and auction views all have real content to render.
 *
 *   ./script/fork-dev.sh              # chain up first, from the repo root
 *   cd preview && npm run simulate:history
 *
 * Deterministic given `SIM_SEED` (default 1). `DAYS` (default 42) controls how many simulated
 * days the run covers; the scene schedule below assumes something close to the default and
 * clamps into range for a smaller value, though very small values will skip required coverage.
 * Local chains only. Never touches the browsing wallet (`PRESENTS_TO`) except to send it
 * presents at the end.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {keccak256, toBytes, type Hex} from "viem";
import {createSim, ANVIL_KEYS, PRESENTS_TO, derivedKey, type Sim} from "./sim/lib";
import {shapesAbi, auctionHouseAbi, type Deployment} from "../src/chain/abi";
import {openOwnerAuction} from "./openOwnerAuction";

const here = dirname(fileURLToPath(import.meta.url));
const dep: Deployment = JSON.parse(readFileSync(join(here, "../public/deployment.json"), "utf8"));

const SIM_SEED = Number(process.env.SIM_SEED ?? 1);
const DAYS = Math.max(20, Number(process.env.DAYS ?? 42));

/** Deterministic PRNG (mulberry32), seeded by SIM_SEED. Drives wallet/denomination/jitter
 *  choices; the required-coverage scenes themselves are deterministic code paths, not chance. */
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rand(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SIM_SEED);
const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function pickDistinct(pool: readonly number[], n: number): number[] {
  const copy = [...pool];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy[idx]!);
    copy.splice(idx, 1);
  }
  return out;
}
function pickExcept(pool: readonly number[], exclude: readonly number[]): number {
  return pick(pool.filter((w) => !exclude.includes(w)));
}

/** Tokens needed, all at denomination index i, to compose one tier up to i+1 (1 survivor +
 *  the rest as burns). Mirrors the ladder's alternating 5x/2x steps. */
const RUNG_RATIO = [5, 2, 5, 2, 5, 2, 5, 2] as const;

function normalize(v: unknown): string {
  return typeof v === "bigint" ? v.toString() : String(v);
}
function assertFieldsMatch(
  label: string,
  want: Record<string, unknown>,
  got: Record<string, unknown>,
  fields: readonly string[],
) {
  for (const f of fields) {
    if (normalize(want[f]) !== normalize(got[f])) {
      throw new Error(`${label}: field "${f}" mismatch: preview ${normalize(want[f])} != actual ${normalize(got[f])}`);
    }
  }
}
const COMPOSE_FIELDS = ["seed", "denominationIndex", "originCount", "inkGene", "modules"] as const;
const SPLIT_FIELDS = ["seed", "denominationIndex", "originCount", "inkGene", "modules"] as const;

async function assertComposeMatches(sim: Sim, label: string, preview: Record<string, unknown>, survivorId: bigint) {
  const actual = await sim.shapeState(survivorId);
  assertFieldsMatch(label, preview, actual, COMPOSE_FIELDS);
}
async function assertSplitMatches(sim: Sim, label: string, preview: Record<string, unknown>[], childIds: bigint[]) {
  for (let i = 0; i < childIds.length; i++) {
    const actual = await sim.shapeState(childIds[i]!);
    assertFieldsMatch(`${label}[${i}]`, preview[i]!, actual, SPLIT_FIELDS);
  }
}

const REQUIRED_FUNCTIONS = [
  "mint",
  "mintTo",
  "mintBatch",
  "mintBatchTo",
  "compose",
  "composeMany",
  "decompose",
  "decomposeTo",
  "decomposeMany",
  "decomposeManyTo",
  "split",
  "splitTo",
  "redeem",
  "redeemTo",
  "redeemBatch",
  "redeemBatchTo",
  "burn",
  "sacrifice",
  "transferFrom",
  "safeTransferFrom",
  "setApprovalForAll",
  "withdrawFees",
  "setMintFee",
  "attestArtist",
  "createAuction",
  "cancelAuction",
  "bid",
  "settle",
  "claimLot",
  "withdraw",
  "claimProceeds",
] as const;

async function main() {
  const startedAt = Date.now();
  console.log(`simulating ${DAYS} days against ${dep.shapes} on ${dep.rpc} (seed ${SIM_SEED})\n`);

  const derivedKeys: Hex[] = Array.from({length: 20}, (_, i) => derivedKey("shapes-sim", i));
  const sim = await createSim(dep, [...ANVIL_KEYS, ...derivedKeys]);
  const UNIT = sim.D[0]!.wei;

  // Fund the 20 derived actors (indices 10..29). The 10 anvil defaults (0..9) already carry
  // 10,000 ETH each from genesis.
  for (let i = 10; i < 30; i++) await sim.fund(sim.addr(i), 3000n);

  const wallets = Array.from({length: 30}, (_, i) => i);
  const richWallets = Array.from({length: 10}, (_, i) => i); // anvil defaults, 10,000 ETH each
  const ARTIST = 0; // the deployer, per script/fork-dev.sh's --private-key PK0

  // Cross-scene state, filled in as scenes run and consumed by later scenes/presents.
  const registry = {
    composeRecordTokens: [] as bigint[],
    splitChildren: [] as bigint[],
  };
  const ctx: {
    nestedSurvivor?: bigint;
    nestedOwner?: number;
    equalSplitChildren?: bigint[];
    equalSplitOwner?: number;
    stackedSurvivor?: bigint;
    stackedOwner?: number;
    recordBranchParent?: bigint;
    recordBranchChild?: bigint;
    recordBranchOwner?: number;
    revivedInput?: bigint;
    revivedOwner?: number;
    deepApex?: bigint;
    deepApexOwner?: number;
    pureApex?: bigint;
    pureApexOwner?: number;
    black1?: bigint;
    black2?: bigint;
    black2Owner?: number;
    auctionsSettled: number;
    auctionsCancelled: number;
    auctionsOpen: number;
  } = {auctionsSettled: 0, auctionsCancelled: 0, auctionsOpen: 0};

  /* ------------------------------- scenes -------------------------------- */

  async function attestArtistScene() {
    const releaseHash = keccak256(toBytes("shapes-sim-history-release"));
    const relayer = pickExcept(wallets, [ARTIST]);
    await sim.attestArtist(ARTIST, relayer, releaseHash);
  }

  /** mint / mintTo / mintBatch / mintBatchTo, across all nine denominations. */
  async function baselineMintWave() {
    for (let di = 0; di < 9; di++) {
      const a = pick(wallets);
      await sim.mint(a, di, 1); // mint
      const b = pickExcept(wallets, [a]);
      await sim.mintTo(a, di, sim.addr(b)); // mintTo
      const c = pick(wallets);
      await sim.mint(c, di, randInt(2, 4)); // mintBatch (qty > 1)
      const d = pick(wallets);
      const e = pickExcept(wallets, [d]);
      await sim.mintBatchTo(d, di, randInt(2, 3), sim.addr(e)); // mintBatchTo
    }
  }

  /** "0.5 + 5 x 0.1 -> 1", verified against previewCompose. */
  async function mixedComposeDemo1() {
    const a = pick(wallets);
    const [half] = await sim.mint(a, 3, 1);
    const dimes = await sim.mint(a, 2, 5);
    const preview = await sim.previewCompose(half!, dimes);
    const survivor = await sim.compose(a, half!, dimes);
    await assertComposeMatches(sim, "mixedCompose1", preview, survivor);
    registry.composeRecordTokens.push(survivor);
    ctx.recordBranchParent = survivor;
    ctx.recordBranchOwner = a;
  }

  /** "0.01 + 0.05 + 4 x 0.01 -> 0.1", verified against previewCompose. */
  async function mixedComposeDemo2() {
    const a = pick(wallets);
    const [cent] = await sim.mint(a, 0, 1);
    const [nickel] = await sim.mint(a, 1, 1);
    const cents = await sim.mint(a, 0, 4);
    const burns = [nickel!, ...cents];
    const preview = await sim.previewCompose(cent!, burns);
    const survivor = await sim.compose(a, cent!, burns);
    await assertComposeMatches(sim, "mixedCompose2", preview, survivor);
    registry.composeRecordTokens.push(survivor);
  }

  /** 0.01 + 99 x 0.01 -> 1 ETH: skips 0.05 / 0.1 / 0.5, three rungs in one compose. */
  async function multiRungJumpDemo() {
    const a = pick(wallets);
    const [cent] = await sim.mint(a, 0, 1);
    const rest = await sim.mint(a, 0, 99);
    const preview = await sim.previewCompose(cent!, rest);
    const survivor = await sim.compose(a, cent!, rest);
    await assertComposeMatches(sim, "multiRungJump", preview, survivor);
    registry.composeRecordTokens.push(survivor);
  }

  /** Three composes stacked on one survivor: 1 -> 5 -> 10 -> 50 ETH, composeDepth 3. */
  async function stackedComposeDemo() {
    const a = pick(wallets);
    const [start] = await sim.mint(a, 4, 1);
    let s = start!;

    const burns1 = await sim.mint(a, 4, RUNG_RATIO[4] - 1); // 4 x 1 ETH -> 5 ETH
    const p1 = await sim.previewCompose(s, burns1);
    s = await sim.compose(a, s, burns1);
    await assertComposeMatches(sim, "stacked-depth1", p1, s);

    const burns2 = await sim.mint(a, 5, RUNG_RATIO[5] - 1); // 1 x 5 ETH -> 10 ETH
    const p2 = await sim.previewCompose(s, burns2);
    s = await sim.compose(a, s, burns2);
    await assertComposeMatches(sim, "stacked-depth2", p2, s);

    const burns3 = await sim.mint(a, 6, RUNG_RATIO[6] - 1); // 4 x 10 ETH -> 50 ETH
    const p3 = await sim.previewCompose(s, burns3);
    s = await sim.compose(a, s, burns3);
    await assertComposeMatches(sim, "stacked-depth3", p3, s);

    const depth = await sim.composeDepth(s);
    if (depth !== 3n) throw new Error(`stackedComposeDemo: expected composeDepth 3, got ${depth}`);
    registry.composeRecordTokens.push(s);
    ctx.stackedSurvivor = s;
    ctx.stackedOwner = a;
  }

  /** Three independent composes bundled into one composeMany transaction. */
  async function composeManyLadderDemo() {
    const a = pick(wallets);
    const [s1] = await sim.mint(a, 0, 1);
    const b1 = await sim.mint(a, 0, RUNG_RATIO[0] - 1); // 0.01 -> 0.05
    const [s2] = await sim.mint(a, 2, 1);
    const b2 = await sim.mint(a, 2, RUNG_RATIO[2] - 1); // 0.1 -> 0.5
    const [s3] = await sim.mint(a, 4, 1);
    const b3 = await sim.mint(a, 4, RUNG_RATIO[4] - 1); // 1 -> 5
    const survivors = await sim.composeMany(a, [
      {survivorId: s1!, burnIds: b1},
      {survivorId: s2!, burnIds: b2},
      {survivorId: s3!, burnIds: b3},
    ]);
    registry.composeRecordTokens.push(...survivors);
  }

  /**
   * Nested compose tree: B (5 ETH, its own compose record) gets absorbed into F (also 5 ETH) to
   * make a 10 ETH survivor. decomposeMany([F, B]) unwinds parent-before-child in one tx: F's
   * decompose revives B under its original id, then B's own still-standing record (from before it
   * was absorbed) pops too, reviving its four 1 ETH originals in the same call. The revived
   * originals plus B recompose into a fresh, different survivor, decomposed again later.
   */
  async function nestedTreeScene(): Promise<bigint> {
    const a = pick(wallets);
    const leaves = await sim.mint(a, 4, 5); // 5 x 1 ETH
    const [b] = await sim.composeUp(a, leaves, 5); // B: 5 ETH, composeDepth 1
    const [f] = await sim.mint(a, 5, 1); // F: direct 5 ETH
    const previewF = await sim.previewCompose(f!, [b!]);
    await sim.compose(a, f!, [b!]); // F absorbs B -> 10 ETH
    await assertComposeMatches(sim, "nestedTree-F", previewF, f!);

    const restored = await sim.decomposeMany(a, [f!, b!]); // parent (F) before child (B)
    const revivedFromB = restored[1]!; // the four 1 ETH originals B had absorbed
    const newSurvivor = revivedFromB[0]!;
    const burns = [...revivedFromB.slice(1), b!];
    await sim.compose(a, newSurvivor, burns); // recompose into a survivor distinct from F and B
    registry.composeRecordTokens.push(newSurvivor);
    ctx.nestedOwner = a;
    return newSurvivor;
  }

  /** Single decompose and decomposeTo, on two fresh two-tier composes. */
  async function simpleDecomposeDemo() {
    const a = pick(wallets);
    const tier = await sim.mint(a, 1, RUNG_RATIO[1]); // 2 x 0.05
    const [survivor1] = await sim.composeUp(a, tier, RUNG_RATIO[1]); // -> 0.1, composeDepth 1
    const restored1 = await sim.decompose(a, survivor1!);
    ctx.revivedInput = restored1[0]!;
    ctx.revivedOwner = a;

    const b = pick(wallets);
    const tier2 = await sim.mint(b, 1, RUNG_RATIO[1]);
    const [survivor2] = await sim.composeUp(b, tier2, RUNG_RATIO[1]);
    const recipient = pickExcept(wallets, [b]);
    await sim.decomposeTo(b, survivor2!, sim.addr(recipient));
  }

  /** Equal-denomination split, uneven-denomination split, and splitTo, each checked against
   *  previewSplit. */
  async function splitDemo() {
    const a = pick(wallets);
    const [halfA] = await sim.mint(a, 3, 1);
    const previewEqual = await sim.previewSplit(halfA!, [2, 2, 2, 2, 2]);
    const equalKids = await sim.split(a, halfA!, [2, 2, 2, 2, 2]); // 0.5 -> 5 x 0.1
    await assertSplitMatches(sim, "split-equal", previewEqual, equalKids);
    registry.splitChildren.push(...equalKids);
    ctx.equalSplitChildren = equalKids;
    ctx.equalSplitOwner = a;

    const b = pick(wallets);
    const [halfB] = await sim.mint(b, 3, 1);
    const previewUneven = await sim.previewSplit(halfB!, [2, 2, 2, 2, 1, 1]);
    const unevenKids = await sim.split(b, halfB!, [2, 2, 2, 2, 1, 1]); // 0.5 -> 4x0.1 + 2x0.05
    await assertSplitMatches(sim, "split-uneven", previewUneven, unevenKids);
    registry.splitChildren.push(...unevenKids);

    const c = pick(wallets);
    const recipient = pickExcept(wallets, [c]);
    const [one] = await sim.mint(c, 4, 1);
    const previewTo = await sim.previewSplit(one!, [3, 2, 2, 2, 2, 2]);
    const toKids = await sim.splitTo(c, one!, [3, 2, 2, 2, 2, 2], sim.addr(recipient)); // 1 -> 0.5 + 5x0.1
    await assertSplitMatches(sim, "split-to", previewTo, toKids);
    registry.splitChildren.push(...toKids);
  }

  /** Splits a compose survivor (record branch) and, separately, a plain split child again
   *  (grammar branch on a recordless parent). */
  async function splitBranchDemo() {
    // Record branch: split mixedComposeDemo1's composed survivor (composeDepth > 0).
    const recordSurvivor = ctx.recordBranchParent!;
    const depth = await sim.composeDepth(recordSurvivor);
    if (depth === 0n) throw new Error("splitBranchDemo: expected a compose record on the record-branch parent");
    const kids = await sim.split(ctx.recordBranchOwner!, recordSurvivor, [3, 2, 2, 2, 2, 2]);
    registry.splitChildren.push(...kids);
    ctx.recordBranchChild = kids[0]!;

    // Grammar branch: split a plain split child again (composeDepth 0, never composed).
    const grammarParent = ctx.equalSplitChildren![0]!; // a 0.1 ETH child from splitDemo
    await sim.split(ctx.equalSplitOwner!, grammarParent, [1, 1]); // 0.1 -> 2 x 0.05
  }

  /**
   * Ownership handoff: compose on A, hand the survivor to B (by transfer, or via an auction
   * settled with claimLot), B composes further with B's own tokens, B safeTransferFroms to C,
   * C decomposes (receiving the revived input), C splits that input, sends a child to D, D
   * composes the child with D's own tokens.
   */
  async function ownershipHandoff(useAuction: boolean) {
    const [a, b, c, d] = pickDistinct(wallets, 4);
    const leaves = await sim.mint(a, 4, 5); // 5 x 1 ETH
    const [survivor] = await sim.composeUp(a, leaves, 5); // A composes -> 5 ETH

    if (useAuction) {
      await sim.setApprovalForAll(a, dep.auctionHouse!, true);
      const auctionId = await sim.createAuction(a, survivor!, 3600, 1n, 500, 300);
      await sim.auctionBid(b!, auctionId, [], UNIT);
      await sim.advanceTime(3700);
      await sim.auctionSettle(pick(wallets), auctionId);
      ctx.auctionsSettled++;
      await sim.auctionClaimLot(b!, auctionId); // ownership changes hands via claimLot
      await sim.auctionClaimProceeds(a, auctionId);
    } else {
      await sim.transfer(a, sim.addr(b!), survivor!);
    }

    const [bToken] = await sim.mint(b!, 5, 1); // B's own 5 ETH
    await sim.compose(b!, survivor!, [bToken!]); // -> 10 ETH
    await sim.safeTransferFrom(b!, sim.addr(c!), survivor!);
    const revived = await sim.decompose(c!, survivor!); // C receives the revived input
    const revivedToken = revived[0]!;
    const splitKids = await sim.split(c!, revivedToken, [4, 4, 4, 4, 4]); // 5 x 1 ETH
    registry.splitChildren.push(...splitKids);
    await sim.transfer(c!, sim.addr(d!), splitKids[0]!);
    const dTokens = await sim.mint(d!, 4, 4); // D's own 4 x 1 ETH
    await sim.compose(d!, splitKids[0]!, dTokens); // -> 5 ETH
  }

  async function redemptionDemo() {
    const a = pick(wallets);
    const [t1] = await sim.mint(a, 2, 1);
    await sim.redeem(a, t1!);

    const b = pick(wallets);
    const [t2] = await sim.mint(b, 2, 1);
    await sim.redeemTo(b, t2!, sim.addr(pickExcept(wallets, [b])));

    const c = pick(wallets);
    const batch1 = await sim.mint(c, 0, 5);
    await sim.redeemBatch(c, batch1);

    const d = pick(wallets);
    const batch2 = await sim.mint(d, 0, 5);
    await sim.redeemBatchTo(d, batch2, sim.addr(pickExcept(wallets, [d])));

    const e = pick(wallets);
    const [t3] = await sim.mint(e, 1, 1);
    await sim.burn(e, t3!); // burn of a normal token
  }

  /** Stacked composes (depth 3), popped together in one decomposeMany call. */
  async function decomposeManyStackedDemo() {
    const a = pick(wallets);
    const [start] = await sim.mint(a, 4, 1);
    let s = start!;
    await sim.compose(a, s, await sim.mint(a, 4, RUNG_RATIO[4] - 1)); // -> 5 ETH
    await sim.compose(a, s, await sim.mint(a, 5, RUNG_RATIO[5] - 1)); // -> 10 ETH
    await sim.compose(a, s, await sim.mint(a, 6, RUNG_RATIO[6] - 1)); // -> 50 ETH
    await sim.decomposeMany(a, [s, s, s]); // pop all three records in one tx
  }

  /** Two stacked composes, popped together with restored inputs sent to another wallet. */
  async function decomposeManyToDemo() {
    const a = pick(wallets);
    const recipient = pickExcept(wallets, [a]);
    const [start] = await sim.mint(a, 2, 1);
    let s = start!;
    await sim.compose(a, s, await sim.mint(a, 2, RUNG_RATIO[2] - 1)); // -> 0.5 ETH
    await sim.compose(a, s, await sim.mint(a, 3, RUNG_RATIO[3] - 1)); // -> 1 ETH
    await sim.decomposeManyTo(a, [s, s], sim.addr(recipient));
  }

  async function withdrawFeesIfAny() {
    const actor = pickExcept(wallets, [ARTIST]);
    const pending = (await sim.pub.readContract({
      address: dep.shapes,
      abi: shapesAbi,
      functionName: "pendingFees",
    })) as bigint;
    if (pending > 0n) await sim.withdrawFees(actor);
  }

  /** A genuine apex Complete: 10,000 x 0.01 composed to ten 10 ETH tokens, then to one 100 ETH
   *  apex, in a single composeMany transaction, then sacrificed. */
  async function apexScene(): Promise<{apex: bigint; actor: number}> {
    // Ten separate compose transactions, not one composeMany: a single tx bundling all 10,000
    // burns emits far more log data than an RPC response can carry (the receipt alone exceeds
    // viem's 10MB response cap). Each 1,000-token batch composes to its own 10 ETH survivor
    // first, then the ten 10 ETH survivors compose to the 100 ETH apex.
    const actor = pick(richWallets);
    const tens: bigint[] = [];
    for (let b = 0; b < 10; b++) {
      const batch = await sim.mint(actor, 0, 1_000); // 1,000 x 0.01
      tens.push(await sim.compose(actor, batch[0]!, batch.slice(1))); // -> 10 ETH
    }
    const apex = await sim.compose(actor, tens[0]!, tens.slice(1)); // 10 x 10 ETH -> 100 ETH
    await sim.sacrifice(actor, apex);
    return {apex, actor};
  }

  /** A live 100 ETH token walked up the whole ladder (never sacrificed): a genuinely "deep
   *  composed apex", distinct from the sacrificed apexes above. */
  async function deepApexScene() {
    const actor = pick(richWallets);
    const leaves: bigint[] = [];
    for (let b = 0; b < 5; b++) leaves.push(...(await sim.mint(actor, 4, 20)));
    const fives = await sim.composeUp(actor, leaves, 5);
    const tens = await sim.composeUp(actor, fives, 2);
    const fifties = await sim.composeUp(actor, tens, 5);
    const [apex] = await sim.composeUp(actor, fifties, 2);
    ctx.deepApex = apex!;
    ctx.deepApexOwner = actor;
  }

  async function pureApexScene() {
    const actor = pick(richWallets);
    const [apex] = await sim.mint(actor, 8, 1); // one direct 100 ETH mint
    ctx.pureApex = apex!;
    ctx.pureApexOwner = actor;
  }

  /** Full auction lifecycle: composed-survivor lot, cards-only / ETH-only / mixed bids,
   *  outbidding with a withdrawal, a bid inside the extension window, settle, claimLot,
   *  claimProceeds. */
  async function auctionLifecycleA() {
    const seller = pick(wallets);
    const leaves = await sim.mint(seller, 4, 5);
    const [lot] = await sim.composeUp(seller, leaves, 5); // composed survivor lot, 5 ETH
    await sim.setApprovalForAll(seller, dep.auctionHouse!, true);
    const auctionId = await sim.createAuction(seller, lot!, 3600, 1n, 1000, 300);

    const bidder1 = pickExcept(wallets, [seller]);
    const [card1] = await sim.mint(bidder1, 2, 1); // 0.1 ETH = 10 units
    await sim.setApprovalForAll(bidder1, dep.auctionHouse!, true); // cards move by transferFrom
    await sim.auctionBid(bidder1, auctionId, [card1!], 0n); // cards-only

    const bidder2 = pickExcept(wallets, [seller, bidder1]);
    await sim.auctionBid(bidder2, auctionId, [], 15n * UNIT); // ETH-only, outbids

    const bidder3 = pickExcept(wallets, [seller, bidder1, bidder2]);
    const [card3] = await sim.mint(bidder3, 1, 1); // 0.05 ETH = 5 units
    await sim.setApprovalForAll(bidder3, dep.auctionHouse!, true);
    await sim.auctionBid(bidder3, auctionId, [card3!], 15n * UNIT); // cards + ETH, outbids

    await sim.auctionWithdraw(bidder1, auctionId);

    const a1 = await sim.getAuction(auctionId);
    const now1 = (await sim.pub.getBlock()).timestamp;
    const toNearEnd = Number(a1.endTime - now1) - 100;
    if (toNearEnd > 0) await sim.advanceTime(toNearEnd);
    await sim.auctionBid(bidder2, auctionId, [], 10n * UNIT); // tops up inside the extension window

    await sim.auctionWithdraw(bidder3, auctionId); // no longer leading

    const a2 = await sim.getAuction(auctionId);
    const now2 = (await sim.pub.getBlock()).timestamp;
    await sim.advanceTime(Number(a2.endTime - now2) + 30);

    await sim.auctionSettle(pick(wallets), auctionId); // permissionless
    ctx.auctionsSettled++;
    await sim.auctionClaimLot(bidder2, auctionId);
    await sim.auctionClaimProceeds(seller, auctionId);
  }

  /** A split-child lot that never receives a bid, cancelled and returned to the seller. */
  async function auctionLifecycleB() {
    const seller = pick(wallets);
    const [parent] = await sim.mint(seller, 4, 1);
    const children = await sim.split(seller, parent!, [3, 2, 2, 2, 2, 2]); // split-child lot
    registry.splitChildren.push(...children);
    const lot = children[0]!;
    await sim.setApprovalForAll(seller, dep.auctionHouse!, true);
    const auctionId = await sim.createAuction(seller, lot, 7200, 5n, 500, 600);
    await sim.auctionCancel(seller, auctionId);
    ctx.auctionsCancelled++;
    await sim.auctionClaimLot(seller, auctionId); // returns the lot to the seller
  }

  /** An auction left open at the end of the run: created with a long duration, one bid, never
   *  settled. */
  async function auctionLifecycleC() {
    const seller = pick(wallets);
    const [lot] = await sim.mint(seller, 3, 1);
    await sim.setApprovalForAll(seller, dep.auctionHouse!, true);
    const auctionId = await sim.createAuction(seller, lot!, 15 * 24 * 3600, 1n, 500, 3600);
    const bidder = pickExcept(wallets, [seller]);
    await sim.auctionBid(bidder, auctionId, [], 5n * UNIT);
    ctx.auctionsOpen++;
  }

  async function dailyFiller() {
    const n = randInt(1, 3);
    for (let i = 0; i < n; i++) {
      const a = pick(wallets);
      const di = pick([0, 0, 0, 1, 1, 2, 2, 3, 4]); // weighted toward small denominations
      const useBatch = rng() < 0.2;
      const toks = useBatch ? await sim.mint(a, di, randInt(2, 5)) : await sim.mint(a, di, 1);
      await sim.shapeState(toks[0]!); // daily lens sample, against a token known to be live
      const roll = rng();
      if (roll < 0.4) {
        const b = pickExcept(wallets, [a]);
        await sim.transfer(a, sim.addr(b), toks[0]!);
      } else if (roll < 0.55) {
        await sim.redeem(a, toks[0]!);
      }
    }
    if (registry.composeRecordTokens.length > 0 && rng() < 0.3) {
      const id = pick(registry.composeRecordTokens);
      const depth = await sim.composeDepth(id).catch(() => 0n);
      if (depth > 0n) await sim.composeRecordAt(id, depth - 1n).catch(() => {});
    }
    if (registry.splitChildren.length > 0 && rng() < 0.3) {
      const id = pick(registry.splitChildren);
      await sim.splitOriginOf(id).catch(() => {});
    }
  }

  /* -------------------------------- schedule -------------------------------- */

  const clamp = (day: number) => Math.min(day, DAYS - 2);
  const schedule = new Map<number, () => Promise<void>>();
  const at = (day: number, fn: () => Promise<void>) => schedule.set(clamp(day), fn);

  at(0, async () => {
    await attestArtistScene();
    await baselineMintWave();
  });
  at(2, mixedComposeDemo1);
  at(3, mixedComposeDemo2);
  at(4, multiRungJumpDemo);
  at(5, stackedComposeDemo);
  at(6, composeManyLadderDemo);
  at(7, async () => {
    ctx.nestedSurvivor = await nestedTreeScene();
  });
  at(8, simpleDecomposeDemo);
  at(9, splitDemo);
  at(10, splitBranchDemo);
  at(11, () => ownershipHandoff(true));
  at(12, () => ownershipHandoff(false));
  at(13, () => ownershipHandoff(false));
  at(14, redemptionDemo);
  at(15, async () => {
    const lower = sim.mintFee() / 2n;
    await sim.setMintFee(ARTIST, lower);
    await sim.decompose(ctx.nestedOwner!, ctx.nestedSurvivor!); // decompose the recomposed survivor
  });
  at(16, withdrawFeesIfAny);
  at(17, async () => {
    const {apex, actor} = await apexScene();
    ctx.black1 = apex;
    await sim.transfer(actor, PRESENTS_TO, apex); // the one Black-token transfer, straight to presents
  });
  at(18, auctionLifecycleA);
  at(19, auctionLifecycleB);
  at(20, decomposeManyStackedDemo);
  at(21, decomposeManyToDemo);
  at(22, withdrawFeesIfAny);
  at(23, deepApexScene);
  at(24, pureApexScene);
  at(26, async () => {
    await sim.setMintFee(ARTIST, sim.mintFee() * 2n); // restore toward the original fee
  });
  at(27, withdrawFeesIfAny);
  at(29, async () => {
    const {apex, actor} = await apexScene();
    ctx.black2 = apex;
    ctx.black2Owner = actor;
  });
  at(30, withdrawFeesIfAny);
  at(32, auctionLifecycleC);
  at(34, async () => {
    await sim.burn(ctx.black2Owner!, ctx.black2!); // burned Black token, zero payout
  });
  at(35, withdrawFeesIfAny);

  for (let day = 0; day < DAYS; day++) {
    await sim.advanceTime(86400 + randInt(-1800, 1800));
    await dailyFiller();
    const scene = schedule.get(day);
    if (scene) await scene();
  }

  /* -------------------------------- presents -------------------------------- */

  console.log("\npresents for the browsing wallet:");
  await sim.transfer(ctx.deepApexOwner!, PRESENTS_TO, ctx.deepApex!);
  console.log(`  #${ctx.deepApex} - deep composed apex (100 ETH, walked the full ladder)`);
  console.log(`  #${ctx.black1} - the Black Shape (a sacrificed apex, 100 ETH burned)`);
  await sim.transfer(ctx.pureApexOwner!, PRESENTS_TO, ctx.pureApex!);
  console.log(`  #${ctx.pureApex} - a pure direct 100 ETH, one mint, untouched`);
  await sim.transfer(ctx.stackedOwner!, PRESENTS_TO, ctx.stackedSurvivor!);
  console.log(`  #${ctx.stackedSurvivor} - a stacked-compose survivor, composeDepth 3`);
  await sim.transfer(ctx.recordBranchOwner!, PRESENTS_TO, ctx.recordBranchChild!);
  console.log(`  #${ctx.recordBranchChild} - a split child of a record-branch parent`);
  await sim.transfer(ctx.revivedOwner!, PRESENTS_TO, ctx.revivedInput!);
  console.log(`  #${ctx.revivedInput} - a revived input, restored by a decompose`);

  /* ---------------------------- owner auction -------------------------------- */

  await openOwnerAuction(sim, dep);

  /* -------------------------------- totals -------------------------------- */

  const [supply, reserve, pendingFees, blackCount, auctionCount] = await Promise.all([
    sim.pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "totalSupply"}),
    sim.pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "redeemableBacking"}),
    sim.pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "pendingFees"}),
    sim.pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "blackCount"}),
    sim.pub.readContract({address: dep.auctionHouse!, abi: auctionHouseAbi, functionName: "auctionCount"}),
  ]);

  console.log("\ntotals:");
  console.log(`  transactions: ${sim.txCount()}`);
  console.log(`  live supply: ${supply}`);
  console.log(`  reserve: ${reserve} wei`);
  console.log(`  pendingFees: ${pendingFees} wei`);
  console.log(`  black count: ${blackCount}`);
  console.log(`  auctions created: ${auctionCount}`);
  console.log(`  auctions settled: ${ctx.auctionsSettled}`);
  console.log(`  auctions cancelled: ${ctx.auctionsCancelled}`);
  console.log(`  auctions open: ${ctx.auctionsOpen}`);

  console.log("\nfunction coverage:");
  const counts = sim.counts();
  const missing: string[] = [];
  for (const fn of REQUIRED_FUNCTIONS) {
    const c = counts[fn] ?? 0;
    console.log(`  ${fn.padEnd(20)} ${c}`);
    if (c === 0) missing.push(fn);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nelapsed: ${elapsed}s`);

  if (missing.length > 0) {
    console.error(`\nmissing required coverage for: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\ndone: 0");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
