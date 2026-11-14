import {parseAbi, parseAbiItem, parseEventLogs, type Address, type Hash, type PublicClient, type TransactionReceipt} from "viem";
import {PACKS_DEPLOYMENTS, packsAbi, packsShapesAbi} from "./packs";

export const FWA_POOL = "0x958C41181182e76F221331b2755b77D9e1426A98" as const;
export const FWA_START_BLOCK = 25_944_480n;
export const PACKS = PACKS_DEPLOYMENTS[1].packs;
export const SHAPES = PACKS_DEPLOYMENTS[1].shapes;
export const fwaAbi = parseAbi([
  "function canDeposit(address collection) view returns (bool)",
  "function oracleExemptCollections(address collection) view returns (bool)",
  "function floorOracle() view returns (address)",
  "function maxOracleAge() view returns (uint48)",
  "function minOracleChallengePeriod() view returns (uint48)",
  "function oracleCeilingPremiumBps() view returns (uint256)",
  "function settlementDiscountBps() view returns (uint256)",
  "function ownerSettlementFeeBps() view returns (uint256)",
  "function listNFT(address collection,uint256 tokenId) payable returns (uint256 listingId)",
  "event ConfigSet(uint256 indexed key,uint256 value)",
  "event NFTListed(uint256 indexed listingId,uint256 indexed slot,address indexed depositor,address collection,uint256 tokenId,uint256 weight,uint256 value)",
  "event ListingStaged(uint256 indexed listingId,address indexed depositor,address collection,uint256 tokenId,uint256 value,uint256 stagedAtBlock)",
  "error CollectionNotWhitelisted()", "error WithdrawOnlyActive()", "error BelowMinBacking()",
  "error BackingAboveFloorCap()", "error InvalidFloorEstimate()", "error StaleFloorEstimate()",
  "error OracleChallengeTooShort()", "error StagingQueueFull()",
]);
export const packTransferAbi = parseAbi([
  "function approve(address to,uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
  "function setApprovalForAll(address operator,bool approved)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
const oracleAbi = parseAbi(["function getFloorRange(address collection) view returns (uint256 bid,uint256 ask,uint48 observedAt,uint48 periodUsed)"]);
export type FwaSettings = {
  denominations: bigint[]; mintFee: bigint; minimumPack: bigint; minimumBacking: bigint;
  admitted: boolean; exempt: boolean; withdrawOnly: boolean; cap: bigint | null; oracleError: string | null;
  cashoutBps: bigint; settlementFeeBps: bigint; block: bigint;
};

/** Read internal configuration through its canonical ConfigSet history. Never substitute a source default. */
export async function loadFwaSettings(client: PublicClient): Promise<FwaSettings> {
  if (await client.getChainId() !== 1) throw new Error("FWA requires Ethereum mainnet.");
  const block = await client.getBlock();
  const blockNumber = block.number;
  const [packCode, poolCode, shapesCode] = await Promise.all([PACKS, FWA_POOL, SHAPES].map(address => client.getCode({address, blockNumber})));
  if (!packCode || !poolCode || !shapesCode) throw new Error("The required mainnet contracts could not be verified.");
  const [linkedShapes, minimumPack, count, mintFee, admitted, exempt, oracle, maxAge, minPeriod, premium, cashoutBps, settlementFeeBps] = await client.multicall({blockNumber, allowFailure: false, contracts: [
    {address: PACKS, abi: packsAbi, functionName: "shapes"},
    {address: PACKS, abi: packsAbi, functionName: "MIN_PACK_VALUE"},
    {address: SHAPES, abi: packsShapesAbi, functionName: "denominationCount"},
    {address: SHAPES, abi: packsShapesAbi, functionName: "mintFee"},
    {address: FWA_POOL, abi: fwaAbi, functionName: "canDeposit", args: [PACKS]},
    {address: FWA_POOL, abi: fwaAbi, functionName: "oracleExemptCollections", args: [PACKS]},
    {address: FWA_POOL, abi: fwaAbi, functionName: "floorOracle"},
    {address: FWA_POOL, abi: fwaAbi, functionName: "maxOracleAge"},
    {address: FWA_POOL, abi: fwaAbi, functionName: "minOracleChallengePeriod"},
    {address: FWA_POOL, abi: fwaAbi, functionName: "oracleCeilingPremiumBps"},
    {address: FWA_POOL, abi: fwaAbi, functionName: "settlementDiscountBps"},
    {address: FWA_POOL, abi: fwaAbi, functionName: "ownerSettlementFeeBps"},
  ]});
  if (linkedShapes.toLowerCase() !== SHAPES.toLowerCase()) throw new Error("The pack contract references a different shapes collection.");
  const denominations = await client.multicall({blockNumber, allowFailure: false, contracts: Array.from({length: count}, (_, i) =>
    ({address: SHAPES, abi: packsShapesAbi, functionName: "denominationAt", args: [i]} as const))});
  const event = parseAbiItem("event ConfigSet(uint256 indexed key,uint256 value)");
  // A local cache is only a checkpoint: all subsequent events are fetched before using it.
  const cacheKey = `shapes:fwa:config:${FWA_POOL}`;
  let start = FWA_START_BLOCK;
  let minimumBacking: bigint | null = null;
  let withdrawOnly = false;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) ?? "null");
    if (cached && BigInt(cached.block) <= blockNumber && BigInt(cached.block) >= start &&
      (await client.getBlock({blockNumber: BigInt(cached.block)})).hash === cached.hash) {
      start = BigInt(cached.block) + 1n;
      minimumBacking = BigInt(cached.minimumBacking);
      withdrawOnly = cached.withdrawOnly === true;
    }
  } catch { /* A missing, malformed or reorganized cache requires a full scan. */ }
  const logs = start > blockNumber ? [] : await client.getLogs({address: FWA_POOL, event, args: {key: [22n, 42n]}, fromBlock: start, toBlock: blockNumber, strict: true});
  for (const log of logs) {
    if (log.args.key === 22n) minimumBacking = log.args.value;
    if (log.args.key === 42n) withdrawOnly = log.args.value !== 0n;
  }
  if (minimumBacking === null) throw new Error("FWA's current minimum backing could not be verified. Retry the pool check.");
  try { localStorage.setItem(cacheKey, JSON.stringify({block: String(blockNumber), hash: block.hash, minimumBacking: String(minimumBacking), withdrawOnly})); } catch { /* Reads remain valid without caching. */ }
  let cap: bigint | null = null;
  let oracleError: string | null = null;
  if (!exempt && admitted) {
    try {
      const [bid, ask, observedAt, periodUsed] = await client.readContract({address: oracle, abi: oracleAbi, functionName: "getFloorRange", args: [PACKS], blockNumber});
      if (bid === 0n || bid >= ask || observedAt === 0 || BigInt(observedAt) > block.timestamp ||
        block.timestamp - BigInt(observedAt) > BigInt(maxAge) || periodUsed < minPeriod) {
        oracleError = "FWA needs a valid, current oracle quote for shape packs.";
      } else cap = ask * (10_000n + premium) / 10_000n;
    } catch { oracleError = "The shape packs oracle quote could not be verified."; }
  }
  return {denominations: [...denominations], mintFee, minimumPack, minimumBacking, admitted, exempt, withdrawOnly, cap, oracleError, cashoutBps, settlementFeeBps, block: blockNumber};
}

export type PackPlan = {value: bigint; backing: bigint; counts: number[]; fee: bigint; payment: bigint};
export type Plan = {rows: PackPlan[]; packValue: bigint; backing: bigint; fees: bigint; total: bigint; remainder: bigint};
export function packMakeup(value: bigint, denominations: readonly bigint[]): number[] {
  let remaining = value;
  const counts = Array(denominations.length).fill(0) as number[];
  for (let i = denominations.length - 1; i >= 0; i--) {
    counts[i] = Number(remaining / denominations[i]);
    if (counts[i] > 0xffffffff) throw new Error("Choose a smaller budget.");
    remaining %= denominations[i];
  }
  if (remaining !== 0n) throw new Error("Pack values must match the shapes denominations.");
  return counts;
}
/** Integer-only budget allocation; include every mint fee and keep any rounding remainder visible. */
export function buildFwaPlan(budget: bigint, quantity: number, ratioBps: bigint, spread: boolean, settings: FwaSettings): Plan {
  if (budget <= 0n || budget > 10_000n * 10n ** 18n) throw new Error("Enter a budget between 0 and 10,000 eth.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 24) throw new Error("Choose between 1 and 24 packs.");
  if (ratioBps < 1n || ratioBps > 100_000n) throw new Error("Choose FWA backing above 0% and up to 1000% of pack value.");
  const unit = settings.denominations[0];
  const weights = Array.from({length: quantity}, (_, i) => spread ? BigInt(i + 1) : 1n);
  const sumWeights = weights.reduce((s, w) => s + w, 0n);
  let scale = budget * 10_000n / ((10_000n + ratioBps) * sumWeights * unit);
  const rowsFor = (scale: bigint): PackPlan[] => weights.map(weight => {
    const value = weight * scale * unit;
    const counts = packMakeup(value, settings.denominations);
    const fee = counts.reduce((s, n) => s + BigInt(n) * settings.mintFee, 0n);
    const backing = value * ratioBps / 10_000n;
    return {value, backing, counts, fee, payment: value + fee};
  });
  let rows = rowsFor(scale);
  while (scale > 0n && rows.reduce((s, r) => s + r.payment + r.backing, 0n) > budget) rows = rowsFor(--scale);
  if (rows.some(r => r.value < settings.minimumPack || r.backing === 0n || r.backing < settings.minimumBacking)) {
    throw new Error("Increase your budget, use fewer packs, or adjust the backing ratio to meet both minimums.");
  }
  const packValue = rows.reduce((s, r) => s + r.value, 0n);
  const backing = rows.reduce((s, r) => s + r.backing, 0n);
  const fees = rows.reduce((s, r) => s + r.fee, 0n);
  const total = packValue + backing + fees;
  return {rows, packValue, backing, fees, total, remainder: budget - total};
}
export function depositBlocker(settings: FwaSettings, rows: readonly {backing: bigint}[]): string | null {
  if (settings.withdrawOnly) return "FWA is currently allowing withdrawals only.";
  if (!settings.admitted) return "shape packs are awaiting admission to the FWA main pool. You can prepare your packs now and deposit once admission is live.";
  if (settings.oracleError) return settings.oracleError;
  if (rows.some(r => r.backing === 0n || r.backing < settings.minimumBacking)) return "A pack's FWA backing is below the current pool minimum.";
  if (!settings.exempt && (settings.cap === null || rows.some(r => r.backing > settings.cap!))) return "The planned FWA backing exceeds the current oracle ceiling. Adjust the ratio or split.";
  return null;
}

export type FwaRow = {counts: number[]; value: string; backing: string; fee: string; packId?: string; mintHash?: Hash; depositHash?: Hash; listingId?: string; staged?: boolean};
export type FwaSession = {version: 1; account: Address; rows: FwaRow[]; draft?: {budget: string; quantity: number; ratio: string; spread: boolean}; approvalHash?: Hash};
export const sessionKey = (account: Address) => `shapes:fwa:1:${FWA_POOL}:${account.toLowerCase()}`;
export function parseFwaSession(raw: string, account: Address): FwaSession | null {
  try {
    const s = JSON.parse(raw) as FwaSession;
    if (s.version !== 1 || s.account.toLowerCase() !== account.toLowerCase() || !Array.isArray(s.rows) || s.rows.length < 1 || s.rows.length > 24) return null;
    for (const r of s.rows) {
      if (!Array.isArray(r.counts) || r.counts.length !== 9 || r.counts.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff) || BigInt(r.value) <= 0n || BigInt(r.backing) <= 0n || BigInt(r.fee) < 0n) return null;
      for (const id of [r.packId, r.listingId]) if (id !== undefined && !/^\d+$/.test(id)) return null;
      for (const hash of [r.mintHash, r.depositHash, s.approvalHash]) if (hash !== undefined && !/^0x[\da-f]{64}$/i.test(hash)) return null;
    }
    return s;
  } catch { return null; }
}
export function mintedPackId(receipt: TransactionReceipt, account: Address): bigint {
  const events = parseEventLogs({abi: packTransferAbi, logs: receipt.logs.filter(l => l.address.toLowerCase() === PACKS), eventName: "Transfer", strict: true});
  const event = events.find(e => e.args.from === "0x0000000000000000000000000000000000000000" && e.args.to.toLowerCase() === account.toLowerCase());
  if (!event) throw new Error("Mint confirmed, but the new pack could not be identified. Keep the transaction hash and retry.");
  return event.args.tokenId;
}
export function depositedListing(receipt: TransactionReceipt, account: Address, packId: bigint) {
  const events = parseEventLogs({abi: fwaAbi, logs: receipt.logs.filter(l => l.address.toLowerCase() === FWA_POOL.toLowerCase()), strict: true});
  const event = events.find(e => (e.eventName === "NFTListed" || e.eventName === "ListingStaged") && e.args.depositor.toLowerCase() === account.toLowerCase() && e.args.collection.toLowerCase() === PACKS && e.args.tokenId === packId);
  if (!event || (event.eventName !== "NFTListed" && event.eventName !== "ListingStaged")) throw new Error("Deposit confirmed, but its listing could not be identified. Keep the transaction hash and retry.");
  return {listingId: String(event.args.listingId), staged: event.eventName === "ListingStaged"};
}

/** Recover mined writes before enabling another signature after a reload. Pending hashes stay put. */
export async function reconcileFwaSession(client: PublicClient, saved: FwaSession): Promise<FwaSession> {
  const next = structuredClone(saved);
  const receiptFor = async (hash: Hash) => {
    try { return await client.getTransactionReceipt({hash}); }
    catch (e) {
      if (e instanceof Error && e.name === "TransactionReceiptNotFoundError") return null;
      throw e;
    }
  };
  for (const row of next.rows) {
    if (row.mintHash && row.packId === undefined) {
      const receipt = await receiptFor(row.mintHash);
      if (receipt?.status === "success") row.packId = String(mintedPackId(receipt, next.account));
      if (receipt?.status === "reverted") delete row.mintHash;
    }
    if (row.depositHash && row.listingId === undefined && row.packId !== undefined) {
      const receipt = await receiptFor(row.depositHash);
      if (receipt?.status === "success") Object.assign(row, depositedListing(receipt, next.account, BigInt(row.packId)));
      if (receipt?.status === "reverted") delete row.depositHash;
    }
  }
  if (next.approvalHash && await receiptFor(next.approvalHash)) delete next.approvalHash;
  return next;
}
