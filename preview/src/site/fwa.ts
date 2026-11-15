import {encodeFunctionData, formatEther, parseAbi, parseAbiItem, parseEventLogs, type Address, type Hash, type PublicClient, type TransactionReceipt} from "viem";
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
  "function totalWeight() view returns (uint256)",
  "function activeListingCount() view returns (uint256)",
  "function tokenSettlementDiscountBps() view returns (uint256)",
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
  cashoutBps: bigint; settlementFeeBps: bigint; tokenCashoutBps: bigint; poolWeight: bigint; activeListings: bigint; block: bigint;
};

/** Read internal configuration through its canonical ConfigSet history. Never substitute a source default. */
export async function loadFwaSettings(client: PublicClient, localFork = false): Promise<FwaSettings> {
  const chainId = await client.getChainId();
  if (chainId !== 1 && !(localFork && chainId === 31337)) throw new Error("FWA requires Ethereum mainnet or an explicitly configured local fork.");
  const block = await client.getBlock();
  const blockNumber = block.number;
  const [packCode, poolCode, shapesCode] = await Promise.all([PACKS, FWA_POOL, SHAPES].map(address => client.getCode({address, blockNumber})));
  if (!packCode || !poolCode || !shapesCode) throw new Error("The required mainnet contracts could not be verified.");
  const [linkedShapes, minimumPack, count, mintFee, admitted, exempt, oracle, maxAge, minPeriod, premium, cashoutBps, settlementFeeBps, tokenCashoutBps, poolWeight, activeListings] = await client.multicall({blockNumber, allowFailure: false, contracts: [
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
    {address: FWA_POOL, abi: fwaAbi, functionName: "tokenSettlementDiscountBps"},
    {address: FWA_POOL, abi: fwaAbi, functionName: "totalWeight"},
    {address: FWA_POOL, abi: fwaAbi, functionName: "activeListingCount"},
  ]});
  if (linkedShapes.toLowerCase() !== SHAPES.toLowerCase()) throw new Error("The pack contract references a different shapes collection.");
  const denominations = await client.multicall({blockNumber, allowFailure: false, contracts: Array.from({length: count}, (_, i) =>
    ({address: SHAPES, abi: packsShapesAbi, functionName: "denominationAt", args: [i]} as const))});
  const event = parseAbiItem("event ConfigSet(uint256 indexed key,uint256 value)");
  // A local cache is only a checkpoint: all subsequent events are fetched before using it.
  const cacheKey = chainId === 1 ? `shapes:fwa:config:${FWA_POOL}` : `shapes:fwa:config:${chainId}:${FWA_POOL}`;
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
  for (let fromBlock = start; fromBlock <= blockNumber; fromBlock += 100_000n) {
    const toBlock = fromBlock + 99_999n < blockNumber ? fromBlock + 99_999n : blockNumber;
    const logs = await client.getLogs({address: FWA_POOL, event, args: {key: [22n, 42n]}, fromBlock, toBlock, strict: true});
    for (const log of logs) {
      if (log.args.key === 22n) minimumBacking = log.args.value;
      if (log.args.key === 42n) withdrawOnly = log.args.value !== 0n;
    }
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
  return {denominations: [...denominations], mintFee, minimumPack, minimumBacking, admitted, exempt, withdrawOnly, cap, oracleError, cashoutBps, settlementFeeBps, tokenCashoutBps, poolWeight, activeListings, block: blockNumber};
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
export type PackChoice = {value: bigint; quantity: number};
const MAX_PACK_VALUE = 10_000n * 10n ** 18n;
/** Values are user choices. A cap reports a shortfall and never changes a pack. */
export function buildExplicitFwaPlan(choices: readonly PackChoice[], ratioBps: bigint, settings: FwaSettings, cap?: bigint): Plan {
  const quantity = choices.reduce((n, r) => n + r.quantity, 0);
  if (!choices.length || choices.some(r => !Number.isInteger(r.quantity) || r.quantity < 1) || quantity > 24) throw new Error("Choose between 1 and 24 packs in total.");
  if (ratioBps < 1n || ratioBps > 100_000n) throw new Error("Choose FWA backing above 0% and up to 1000% of pack value.");
  if (cap !== undefined && cap <= 0n) throw new Error("Enter a budget cap above 0 eth or leave it empty.");
  const rows = choices.flatMap(({value, quantity}) => {
    if (value < settings.minimumPack || value > MAX_PACK_VALUE) throw new Error("Each pack must meet the pack minimum and be no larger than 10,000 eth.");
    const counts = packMakeup(value, settings.denominations);
    const fee = counts.reduce((sum, n) => sum + BigInt(n) * settings.mintFee, 0n);
    const backing = value * ratioBps / 10_000n;
    if (backing === 0n || backing < settings.minimumBacking) throw new Error("Each pack needs at least the current FWA minimum backing. Increase its value or backing percentage.");
    return Array.from({length: quantity}, () => ({value, counts: [...counts], fee, backing, payment: value + fee}));
  });
  const packValue = rows.reduce((s, r) => s + r.value, 0n);
  const backing = rows.reduce((s, r) => s + r.backing, 0n);
  const fees = rows.reduce((s, r) => s + r.fee, 0n);
  const total = packValue + backing + fees;
  return {rows, packValue, backing, fees, total, remainder: cap === undefined ? 0n : cap - total};
}
/** Strict decimal input: viem's parseEther rounds excess precision, so reject it first. */
export function parseFwaAmount(input: string): bigint {
  if (!/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(input.trim())) throw new Error("Enter an eth amount with up to 18 decimal places.");
  const [whole, fraction = ""] = input.trim().split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}
/** Calculate the chosen flat list even when live minimums are unmet, so the UI can name each offending pack. */
export function buildFwaContribution(packs: readonly {value: bigint; backing: bigint}[], settings: FwaSettings, budget: bigint): Plan {
  if (packs.length > 24) throw new Error("Choose up to 24 packs.");
  if (budget < 0n || packs.some(p => p.value <= 0n || p.backing < 0n)) throw new Error("Enter positive pack values and nonnegative FWA backing.");
  if (packs.some(p => p.value > MAX_PACK_VALUE)) throw new Error("Each pack must be no larger than 10,000 eth.");
  const rows = packs.map(({value, backing}) => {
    const counts = packMakeup(value, settings.denominations);
    const fee = counts.reduce((s, n) => s + BigInt(n) * settings.mintFee, 0n);
    return {value, backing, counts, fee, payment: value + fee};
  });
  const packValue = rows.reduce((s, r) => s + r.value, 0n);
  const backing = rows.reduce((s, r) => s + r.backing, 0n);
  const fees = rows.reduce((s, r) => s + r.fee, 0n);
  const total = packValue + backing + fees;
  return {rows, packValue, backing, fees, total, remainder: budget - total};
}
export function fwaPackRequirement(row: {value: bigint; backing: bigint}, settings: FwaSettings): string | null {
  if (row.value < settings.minimumPack) return `Minimum pack value is ${formatEther(settings.minimumPack)} eth.`;
  if (row.value > MAX_PACK_VALUE) return "Each pack must be no larger than 10,000 eth.";
  if (row.backing === 0n || row.backing < settings.minimumBacking) return `Minimum FWA backing is ${formatEther(settings.minimumBacking)} eth.`;
  if (settings.admitted && !settings.exempt && settings.cap !== null && row.backing > settings.cap) return `FWA backing exceeds the ${formatEther(settings.cap)} eth oracle ceiling.`;
  return null;
}
export type FwaSuggestionMode = "most" | "balanced" | "lower";
/** Each preset changes committed backing, which determines draw weight. */
export function suggestFwaPlan(budget: bigint, settings: FwaSettings, mode: FwaSuggestionMode = "most"): Plan {
  if (budget <= 0n) throw new Error("Enter a budget above 0 eth.");
  const blocked = depositBlocker(settings, []);
  if (blocked) throw new Error(blocked);
  const mintFee = (value: bigint) => packMakeup(value, settings.denominations).reduce((sum, n) => sum + BigInt(n) * settings.mintFee, 0n);
  const backing = (value: bigint) => {
    if (mode === "most") return settings.minimumBacking;
    const target = mode === "lower" ? settings.exempt ? 2n * value : settings.cap!
      : value > settings.minimumBacking ? value : settings.minimumBacking;
    const capped = settings.exempt || target <= settings.cap! ? target : settings.cap!;
    const affordable = budget - value - mintFee(value);
    return capped < affordable ? capped : affordable;
  };
  const eligible = (value: bigint) => value >= settings.minimumPack && value <= MAX_PACK_VALUE &&
    backing(value) > 0n && backing(value) >= settings.minimumBacking &&
    (settings.exempt || backing(value) <= settings.cap!);
  const cost = (value: bigint) => value + backing(value) + mintFee(value);
  // Cost rises between denomination carries. The first multiple at or above
  // the minimum of each denomination includes every possible cheapest carry point.
  const candidates = [...new Set(settings.denominations.map(d => (settings.minimumPack + d - 1n) / d * d))].filter(eligible);
  const value = candidates.reduce<bigint | undefined>((best, v) => best === undefined || cost(v) < cost(best) || (cost(v) === cost(best) && v < best) ? v : best, undefined);
  if (value === undefined || cost(value) > budget) throw new Error("This budget cannot fund an eligible FWA position.");
  const count = Number(budget / cost(value) < 24n ? budget / cost(value) : 24n);
  return buildFwaContribution(Array.from({length: count}, () => ({value, backing: backing(value)})), settings, budget);
}
export function fwaExposure(rows: readonly {backing: bigint}[], settings: FwaSettings) {
  const weights = rows.map(r => 10n ** 36n / r.backing);
  const addedWeight = weights.reduce((s, w) => s + w, 0n);
  return {weights, addedWeight, totalWeight: settings.poolWeight + addedWeight,
    positions: BigInt(rows.length), totalPositions: settings.activeListings + BigInt(rows.length)};
}
export function fwaSettlement(row: {value: bigint; backing: bigint}, settings: FwaSettings) {
  const returnedBacking = row.backing - row.backing * settings.settlementFeeBps / 10_000n;
  return {returnedBacking, packTakenLoss: row.value + row.backing - returnedBacking,
    packReturnedLoss: row.backing, cashBid: row.backing * settings.cashoutBps / 10_000n,
    tokenBidBudget: row.backing * settings.tokenCashoutBps / 10_000n};
}
export function depositBlocker(settings: FwaSettings, rows: readonly {backing: bigint}[]): string | null {
  if (settings.withdrawOnly) return "FWA is currently allowing withdrawals only.";
  if (!settings.admitted) return "shape packs are awaiting admission to the FWA main V2 pool.";
  if (settings.oracleError) return settings.oracleError;
  if (rows.some(r => r.backing === 0n || r.backing < settings.minimumBacking)) return "A pack's FWA backing is below the current pool minimum.";
  if (!settings.exempt && (settings.cap === null || rows.some(r => r.backing > settings.cap!))) return "The planned FWA backing exceeds the current oracle ceiling. Adjust the ratio or split.";
  return null;
}

export type FwaRow = {counts: number[]; value: string; backing: string; fee: string; packId?: string; mintHash?: Hash; mintFailedHash?: Hash; depositHash?: Hash; depositFailedHash?: Hash; listingId?: string; staged?: boolean};
export type FwaSession = {version: 1; account: Address; rows: FwaRow[]; draft?: {budget: string; quantity: number; ratio: string; spread: boolean}; approvalHash?: Hash; approvalReceipt?: Hash; approvalFailedHash?: Hash; approvalNeeded?: boolean; order?: "paired"; pendingNonces?: Record<string, number>; pendingStartBlocks?: Record<string, string>};
export type FwaAction = {key: string; kind: "approve" | "mint" | "deposit"; packIndex?: number; hash?: Hash; failedHash?: Hash; status: "queued" | "ready" | "pending" | "confirmed" | "failed"};
export const fwaActionKey = (kind: FwaAction["kind"], packIndex?: number) => kind === "approve" ? "approve" : `${kind}:${packIndex}`;
/** New runs pair each mint with its deposit; sessions saved by the earlier flow keep their original order. */
export function fwaActions(session: FwaSession): FwaAction[] {
  const completedWithoutApprovalTx = session.order !== "paired" && !session.approvalReceipt && session.rows.every(row => row.listingId !== undefined);
  const approval: FwaAction[] = session.approvalNeeded === false || completedWithoutApprovalTx ? [] : [{key: "approve", kind: "approve", hash: session.approvalHash ?? session.approvalReceipt, failedHash: session.approvalFailedHash, status: session.approvalReceipt ? "confirmed" : session.approvalHash ? "pending" : session.approvalFailedHash ? "failed" : "queued"}];
  const mint = (row: FwaRow, packIndex: number): FwaAction => ({key: fwaActionKey("mint", packIndex), kind: "mint", packIndex, hash: row.mintHash, failedHash: row.mintFailedHash, status: row.packId !== undefined ? "confirmed" : row.mintHash ? "pending" : row.mintFailedHash ? "failed" : "queued"});
  const deposit = (row: FwaRow, packIndex: number): FwaAction => ({key: fwaActionKey("deposit", packIndex), kind: "deposit", packIndex, hash: row.depositHash, failedHash: row.depositFailedHash, status: row.listingId !== undefined ? "confirmed" : row.depositHash ? "pending" : row.depositFailedHash ? "failed" : "queued"});
  const actions = session.order === "paired"
    ? [...approval, ...session.rows.flatMap((row, index) => [mint(row, index), deposit(row, index)])]
    : [...session.rows.map(mint), ...approval, ...session.rows.map(deposit)];
  const first = actions.find(action => action.status !== "confirmed");
  if (first?.status === "queued") first.status = "ready";
  return actions;
}
export const sessionKey = (account: Address, chainId = 1) => `shapes:fwa:${chainId}:${FWA_POOL}:${account.toLowerCase()}`;
export function parseFwaSession(raw: string, account: Address): FwaSession | null {
  try {
    const s = JSON.parse(raw) as FwaSession;
    if (s.version !== 1 || s.account.toLowerCase() !== account.toLowerCase() || !Array.isArray(s.rows) || s.rows.length < 1 || s.rows.length > 24 || (s.order !== undefined && s.order !== "paired") || (s.approvalNeeded !== undefined && typeof s.approvalNeeded !== "boolean")) return null;
    for (const nonce of Object.values(s.pendingNonces ?? {})) if (!Number.isSafeInteger(nonce) || nonce < 0) return null;
    for (const block of Object.values(s.pendingStartBlocks ?? {})) if (!/^\d+$/.test(block)) return null;
    for (const r of s.rows) {
      if (!Array.isArray(r.counts) || r.counts.length !== 9 || r.counts.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff) || BigInt(r.value) <= 0n || BigInt(r.backing) <= 0n || BigInt(r.fee) < 0n) return null;
      for (const id of [r.packId, r.listingId]) if (id !== undefined && !/^\d+$/.test(id)) return null;
      for (const hash of [r.mintHash, r.mintFailedHash, r.depositHash, r.depositFailedHash, s.approvalHash, s.approvalReceipt, s.approvalFailedHash]) if (hash !== undefined && !/^0x[\da-f]{64}$/i.test(hash)) return null;
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

/** Chain ID alone does not distinguish two Anvil forks that both use 31337. */
export async function assertSameFwaFork(client: PublicClient, walletClient: PublicClient, rpc: string, marker?: {address: Address; balanceWei: string}): Promise<void> {
  if (!marker || !/^0x[\da-f]{40}$/i.test(marker.address) || !/^\d+$/.test(marker.balanceWei) || BigInt(marker.balanceWei) === 0n)
    throw new Error("This local Anvil fork has no identity marker. Restart its test setup before sending.");
  let balances;
  try {balances = await Promise.all([client.getBalance({address: marker.address}), walletClient.getBalance({address: marker.address})]);}
  catch {throw new Error(`Could not verify your wallet's Anvil RPC. Check that chain 31337 uses ${rpc}.`);}
  const expected = BigInt(marker.balanceWei);
  if (balances[0] !== expected) throw new Error("The local Anvil fork identity marker is missing. Restart its test setup before sending.");
  if (balances[1] !== expected) throw new Error(`Your wallet is connected to a different Anvil fork. Set chain 31337's RPC to ${rpc} and try again.`);
  const readHeads = () => Promise.all([client.getBlock(), walletClient.getBlock()]);
  let heads;
  try {
    heads = await readHeads();
    if (heads[0].number !== heads[1].number || heads[0].hash !== heads[1].hash) heads = await readHeads();
  }
  catch {throw new Error(`Could not verify your wallet's Anvil RPC. Check that chain 31337 uses ${rpc}.`);}
  const [pageBlock, walletBlock] = heads;
  if (pageBlock.number !== walletBlock.number || pageBlock.hash !== walletBlock.hash)
    throw new Error(`Your wallet is connected to a different Anvil fork. Set chain 31337's RPC to ${rpc} and try again.`);
}

/** Recover mined writes before enabling another signature after a reload. Pending hashes stay put. */
export async function reconcileFwaSession(client: PublicClient, saved: FwaSession, verifyLocalFork = false): Promise<FwaSession> {
  const next = structuredClone(saved);
  const receiptFor = async (hash: Hash) => {
    try { return await client.getTransactionReceipt({hash}); }
    catch (e) {
      if (e instanceof Error && e.name === "TransactionReceiptNotFoundError") return null;
      throw e;
    }
  };
  const replacementFor = async (key: string, oldHash: Hash, expected: {to: Address; input: Hash; value: bigint}) => {
    let nonce = next.pendingNonces?.[key];
    if (nonce === undefined) {
      try {
        nonce = (await client.getTransaction({hash: oldHash})).nonce;
        next.pendingNonces ??= {};
        next.pendingNonces[key] = nonce;
      }
      catch (e) {if (!(e instanceof Error && e.name === "TransactionNotFoundError")) throw e;}
    }
    if (nonce === undefined) throw new Error("The pending transaction is no longer visible and its nonce was not saved. Check its status in your wallet before starting another plan; this page will not send a duplicate.");
    if (await client.getTransactionCount({address: next.account}) <= nonce) return null;
    const head = await client.getBlockNumber();
    let low = BigInt(next.pendingStartBlocks?.[key] ?? "0");
    if (low > head || await client.getTransactionCount({address: next.account, blockNumber: low}) > nonce) low = 0n;
    let high = head;
    while (low < high) {
      const mid = (low + high) / 2n;
      if (await client.getTransactionCount({address: next.account, blockNumber: mid}) > nonce) high = mid;
      else low = mid + 1n;
    }
    const block = await client.getBlock({blockNumber: low, includeTransactions: true});
    const transaction = block.transactions.find(tx => tx.from.toLowerCase() === next.account.toLowerCase() && tx.nonce === nonce);
    if (!transaction) throw new Error(`A pending FWA transaction was replaced at nonce ${nonce}, but its receipt could not be found. Check your wallet before continuing.`);
    const receipt = await receiptFor(transaction.hash);
    if (!receipt) return null;
    return {transaction, receipt, sameCall: transaction.to?.toLowerCase() === expected.to.toLowerCase() && transaction.input === expected.input && transaction.value === expected.value};
  };
  if (verifyLocalFork) {
    const stale = () => new Error("Saved local fork progress does not match this fork. Start a new plan.");
    const hashes = [...new Set([...next.rows.flatMap(row => [row.packId !== undefined ? row.mintHash : undefined, row.listingId !== undefined ? row.depositHash : undefined]), next.approvalReceipt].filter((hash): hash is Hash => hash !== undefined))];
    await Promise.all(hashes.map(async hash => {
      try {await client.getTransaction({hash});}
      catch (e) {
        if (e instanceof Error && e.name === "TransactionNotFoundError") throw stale();
        throw e;
      }
    }));
    for (const row of next.rows) {
      if (row.packId !== undefined) {
        if (!row.mintHash) throw stale();
        const receipt = await receiptFor(row.mintHash);
        if (receipt?.status !== "success") throw stale();
        try {if (mintedPackId(receipt, next.account) !== BigInt(row.packId)) throw stale();}
        catch {throw stale();}
      }
      if (row.listingId !== undefined) {
        if (!row.depositHash || row.packId === undefined) throw stale();
        const receipt = await receiptFor(row.depositHash);
        if (receipt?.status !== "success") throw stale();
        try {
          const listing = depositedListing(receipt, next.account, BigInt(row.packId));
          if (BigInt(listing.listingId) !== BigInt(row.listingId) || listing.staged !== (row.staged === true)) throw stale();
        } catch {throw stale();}
      }
    }
    if (next.approvalReceipt && (await receiptFor(next.approvalReceipt))?.status !== "success") throw stale();
  }
  const pendingReceipt = async (key: string, hash: Hash, expected: {to: Address; input: Hash; value: bigint}) => {
    const receipt = await receiptFor(hash);
    if (receipt) {
      const transaction = await client.getTransaction({hash});
      return {receipt, hash, sameCall: transaction.to?.toLowerCase() === expected.to.toLowerCase() && transaction.input === expected.input && transaction.value === expected.value};
    }
    const replacement = await replacementFor(key, hash, expected);
    if (replacement) return {receipt: replacement.receipt, hash: replacement.transaction.hash, sameCall: replacement.sameCall};
    if (verifyLocalFork) {
      try {await client.getTransaction({hash});}
      catch (e) {if (e instanceof Error && e.name === "TransactionNotFoundError") throw new Error("Saved local fork progress does not match this fork. Start a new plan."); throw e;}
    }
    return null;
  };
  for (const [index, row] of next.rows.entries()) {
    if (row.mintHash && row.packId === undefined) {
      const expected = {to: PACKS, input: encodeFunctionData({abi: packsAbi, functionName: "createPack", args: [[], row.counts]}), value: BigInt(row.value) + BigInt(row.fee)};
      const result = await pendingReceipt(fwaActionKey("mint", index), row.mintHash, expected);
      if (result) {
        if (result.sameCall && result.receipt.status === "success") {row.mintHash = result.hash; row.packId = String(mintedPackId(result.receipt, next.account));}
        else {row.mintFailedHash = result.hash; delete row.mintHash;}
      }
    }
    if (row.depositHash && row.listingId === undefined && row.packId !== undefined) {
      const expected = {to: FWA_POOL, input: encodeFunctionData({abi: fwaAbi, functionName: "listNFT", args: [PACKS, BigInt(row.packId)]}), value: BigInt(row.backing)};
      const result = await pendingReceipt(fwaActionKey("deposit", index), row.depositHash, expected);
      if (result) {
        if (result.sameCall && result.receipt.status === "success") {row.depositHash = result.hash; Object.assign(row, depositedListing(result.receipt, next.account, BigInt(row.packId)));}
        else {row.depositFailedHash = result.hash; delete row.depositHash;}
      }
    }
  }
  if (next.approvalHash) {
    const expected = {to: PACKS, input: encodeFunctionData({abi: packTransferAbi, functionName: "setApprovalForAll", args: [FWA_POOL, true]}), value: 0n};
    const result = await pendingReceipt("approve", next.approvalHash, expected);
    if (result) {
      if (result.sameCall && result.receipt.status === "success") next.approvalReceipt = result.hash;
      else next.approvalFailedHash = result.hash;
      delete next.approvalHash;
    }
  }
  return next;
}
