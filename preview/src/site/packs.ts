import {createPublicClient, decodeEventLog, formatEther, http, parseAbi, zeroAddress, type Address, type PublicClient} from "viem";
import {mainnet, sepolia} from "viem/chains";
import {shapesTransport} from "../chain/rpc";
import {safeMetadataFromTokenURI} from "./ogArtwork";
import {INDEXER_TIMEOUT_MS, checkpointOf, indexerQuery, requireFreshCheckpoint, type IndexerEnvelope, type IndexerMeta} from "./indexerClient";

export const PACKS_DEPLOYMENTS = {
  1: {
    chainId: 1, name: "Mainnet", shapes: "0x6fe9193276bf7abcbee44ab7afd717d637d6faf0",
    packs: "0xf21514b090da7df4390803497d6ae673801e5ca7",
    renderer: "0x934c491dda49c8058347c3fca191852d54705645",
    rpc: "https://mainnet.gateway.tenderly.co", explorer: "https://etherscan.io",
  },
  11155111: {
    chainId: 11155111, name: "Sepolia", shapes: "0x6c2f9c00f44fbbf141dd166979903004b80d5f99",
    packs: "0x6DB763fB3FA5B988BEDa8E7a4288c79d7E1E6f45",
    renderer: "0xbFa47D2047D61AE8eAA685008e1272E4F9d6ea60",
    rpc: "https://gateway.tenderly.co/public/sepolia", explorer: "https://sepolia.etherscan.io",
  },
} as const;

export type PacksDeployment = (typeof PACKS_DEPLOYMENTS)[keyof typeof PACKS_DEPLOYMENTS];
export function packsDeploymentFor(chainId: number): PacksDeployment | null {
  if (chainId === 1) return PACKS_DEPLOYMENTS[1];
  if (chainId === 11155111) return PACKS_DEPLOYMENTS[11155111];
  return null;
}

// EIP-7825 caps one Ethereum transaction at 2^24 gas, regardless of the block gas limit.
export const PACKS_TX_GAS_CAP = 1n << 24n;

export function packsGasBudget(blockGasLimit: bigint): bigint {
  const blockBudget = blockGasLimit * 8n / 10n;
  return blockBudget < PACKS_TX_GAS_CAP ? blockBudget : PACKS_TX_GAS_CAP;
}

export const packsAbi = [
  ...parseAbi([
    "function shapes() view returns (address)",
    "function renderer() view returns (address)",
    "function MIN_PACK_VALUE() view returns (uint256)",
    "function totalMinted() view returns (uint256)",
    "function previewCardLimit() view returns (uint256)",
    "function ownerOf(uint256 packId) view returns (address)",
    "function tokenURI(uint256 packId) view returns (string)",
    "function claimantOf(uint256 packId) view returns (address)",
    "function contentsOf(uint256 packId) view returns (uint256[])",
    "function quoteMint(uint32[] mintCounts) view returns (uint256 backingWei,uint256 feeWei,uint256 totalWei,uint256 shapeCount)",
    "function createPack(uint256[] shapeIds,uint32[] mintCounts) payable returns (uint256)",
    "function addToPack(uint256 packId,uint256[] shapeIds,uint32[] mintCounts) payable",
    "function mergePacks(uint256 targetPackId,uint256[] sourcePackIds)",
    "function open(uint256 packId)",
    "function redeem(uint256 packId)",
    "function unseal(uint256 packId,address claimant)",
    "function claim(uint256 packId,uint256 maxCount)",
    "function claimEth(uint256 packId,uint256 maxCount,address recipient)",
    "error NoShapes()",
    "error NoSourcePacks()",
    "error CannotMergePackIntoItself(uint256 packId)",
    "error MakeupLengthMismatch()",
    "error IncorrectPayment(uint256 expected,uint256 provided)",
    "error WorthlessShape(uint256 shapeId)",
    "error PackBelowMinimum(uint256 valueWei,uint256 minimum)",
    "error NotPackOwner(uint256 packId,address caller)",
    "error NotClaimant(uint256 packId,address caller)",
    "error NothingToClaim(uint256 packId)",
    "error ZeroQuantity()",
    "error InvalidRecipient(address recipient)",
  ]),
  {
    type: "function", name: "packState", stateMutability: "view",
    inputs: [{name: "packId", type: "uint256"}],
    outputs: [{name: "state", type: "tuple", components: [
      {name: "shapeIds", type: "uint256[]"},
      {name: "counts", type: "uint32[]"},
      {name: "valueWei", type: "uint256"},
      {name: "mintedCount", type: "uint256"},
      {name: "creator", type: "address"},
    ]}],
  },
] as const;

export const packsShapesAbi = parseAbi([
  "function denominationCount() view returns (uint8)",
  "function denominationAt(uint8 index) view returns (uint256)",
  "function mintFee() view returns (uint256)",
  "function backingOf(uint256 tokenId) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator,bool approved)",
]);

const packsClients = {
  1: createPublicClient({chain: mainnet, transport: http(PACKS_DEPLOYMENTS[1].rpc)}),
  11155111: createPublicClient({chain: sepolia, transport: shapesTransport(11155111, PACKS_DEPLOYMENTS[11155111].rpc)}),
};
export function packsClientFor(chainId: number): PublicClient {
  if (chainId === 1) return packsClients[1];
  return packsClients[11155111];
}

export type MintQuote = {backingWei: bigint; feeWei: bigint; totalWei: bigint; shapeCount: bigint};
export type OwnedPack = {
  id: bigint;
  kind: "live" | "claim";
  name: string;
  image: string | null;
  shapeIds: readonly bigint[];
  valueWei: bigint | null;
  mintedCount: bigint | null;
  creator: Address | null;
  backings: readonly bigint[];
};
export type PackRef = {id: bigint; kind: "live" | "claim"};
type ChainPackState = {shapeIds: readonly bigint[]; counts: readonly number[]; valueWei: bigint; mintedCount: bigint; creator: Address};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const PACK_INDEXER_PAGE_SIZE = 500;
const PACK_INDEXER_MAX_LAG = 2n;
const packEventsAbi = parseAbi([
  "event PackCreated(uint256 indexed packId, address indexed creator, address indexed to, uint256[] shapeIds, uint256 pulledCount, uint256 valueWei)",
  "event PackExtended(uint256 indexed packId, address indexed by, uint256[] shapeIds, uint256 pulledCount, uint256 addedValueWei, uint256 valueWei)",
  "event PackMerged(uint256 indexed targetPackId, uint256 indexed sourcePackId, address indexed by, uint256[] shapeIds, uint256 addedValueWei, uint256 valueWei)",
  "event PackUnsealed(uint256 indexed packId, address indexed owner, address indexed claimant, uint256 count)",
  "event ShapesClaimed(uint256 indexed packId, address indexed to, uint256[] shapeIds)",
  "event EthClaimed(uint256 indexed packId, address indexed recipient, uint256[] shapeIds, uint256 valueWei)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
]);
type IndexedHolding = {id: string; owner: Address | null; claimant: Address | null};
type IndexedPage = {items: IndexedHolding[]; pageInfo: {hasNextPage: boolean; endCursor: string | null}};
type IndexedPackResponse = {_meta?: IndexerMeta; all?: {totalCount: number; items: {contractAddress: Address}[]}; holdings?: IndexedPage};

async function indexedPackRefs(
  client: PublicClient, account: Address, totalMinted: bigint, packsAddress: Address, indexerUrl: string, chainId: number,
): Promise<PackRef[]> {
  const queryFor = (field: "owner" | "claimant") => `query WalletPacks($wallet: String!, $limit: Int!, $after: String) {
    _meta { status }
    all: packHoldings(limit: 1) { totalCount items { contractAddress } }
    holdings: packHoldings(where: {${field}: $wallet}, orderBy: "id", orderDirection: "desc", limit: $limit, after: $after) {
      items { id owner claimant }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const read = async (field: "owner" | "claimant") => {
    const rows: IndexedHolding[] = [];
    const seenCursors = new Set<string>();
    let checkpoint: bigint | null = null;
    let mintedCount: bigint | null = null;
    let after: string | null = null;
    let pages = 0n;
    do {
      pages++;
      if (pages > (totalMinted + BigInt(PACK_INDEXER_PAGE_SIZE - 1)) / BigInt(PACK_INDEXER_PAGE_SIZE) + 1n) {
        throw new Error("Packs indexer returned too many pages");
      }
      const result: IndexerEnvelope<IndexedPackResponse> = await indexerQuery<IndexedPackResponse>(indexerUrl, fetch, queryFor(field), {
        wallet: account.toLowerCase(), limit: PACK_INDEXER_PAGE_SIZE, after,
      }, INDEXER_TIMEOUT_MS, true);
      const data: IndexedPackResponse | undefined = result.data;
      if (!data?.all || !data.holdings || !Number.isSafeInteger(data.all.totalCount) ||
        data.all.totalCount < 0) {
        throw new Error("Packs indexer mint count disagrees with chain");
      }
      if (data.all.totalCount > 0 && (!data.all.items[0]?.contractAddress ||
        !same(data.all.items[0].contractAddress, packsAddress))) {
        throw new Error("Packs indexer targets a different contract");
      }
      const pageBlock = checkpointOf(data._meta, chainId);
      if (checkpoint !== null && checkpoint !== pageBlock) throw new Error("Packs indexer advanced during pagination");
      checkpoint = pageBlock;
      const pageMintedCount = BigInt(data.all.totalCount);
      if (mintedCount !== null && mintedCount !== pageMintedCount) throw new Error("Packs indexer mint count changed during pagination");
      mintedCount = pageMintedCount;
      const {items, pageInfo}: IndexedPage = data.holdings;
      if (items.length > PACK_INDEXER_PAGE_SIZE || (pageInfo.hasNextPage && items.length !== PACK_INDEXER_PAGE_SIZE)) {
        throw new Error("Packs indexer returned an invalid page");
      }
      rows.push(...items);
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      if (pageInfo.hasNextPage && !after) throw new Error("Packs indexer omitted a page cursor");
      if (after !== null && seenCursors.has(after)) throw new Error("Packs indexer repeated a page cursor");
      if (after !== null) seenCursors.add(after);
    } while (after !== null);
    if (checkpoint === null || mintedCount === null) throw new Error("Packs indexer omitted its checkpoint");
    return {rows, checkpoint, mintedCount};
  };
  let [owned, claims] = await Promise.all([read("owner"), read("claimant")]);
  // A block can finish between the two POSTs. Refresh the earlier result before treating a
  // normal checkpoint transition as an indexer failure and scanning every Pack.
  for (let retry = 0; retry < 2 && owned.checkpoint !== claims.checkpoint; retry++) {
    if (owned.checkpoint < claims.checkpoint) owned = await read("owner");
    else claims = await read("claimant");
  }
  if (owned.checkpoint !== claims.checkpoint) throw new Error("Packs indexer advanced between wallet queries");
  if (owned.mintedCount !== claims.mintedCount) throw new Error("Packs indexer mint count changed between wallet queries");
  const head = await client.getBlockNumber();
  requireFreshCheckpoint(owned.checkpoint, head, PACK_INDEXER_MAX_LAG);
  const headTotalMinted = await client.readContract({address: packsAddress, abi: packsAbi,
    functionName: "totalMinted", blockNumber: head});
  if (owned.mintedCount > headTotalMinted) throw new Error("Packs indexer mint count is ahead of chain");
  const refs = new Map<bigint, PackRef>();
  for (const row of owned.rows) {
    const id = BigInt(row.id);
    if (id < 1n || id > headTotalMinted || !row.owner || !same(row.owner, account) || refs.has(id)) {
      throw new Error("Packs indexer returned invalid ownership");
    }
    refs.set(id, {id, kind: "live"});
  }
  for (const row of claims.rows) {
    const id = BigInt(row.id);
    if (id < 1n || id > headTotalMinted || !row.claimant || !same(row.claimant, account) || refs.has(id)) {
      throw new Error("Packs indexer returned invalid claim rights");
    }
    refs.set(id, {id, kind: "claim"});
  }
  // Receipts contain every Pack event in the short gap, including incoming transfers and new
  // claims that the indexer has not seen. An unsupported or incomplete receipt read falls back
  // to the full onchain scan instead of silently omitting a wallet right.
  const touched = new Set<bigint>();
  const minted = new Set<bigint>();
  if (head > owned.checkpoint) {
    const blocks = Array.from({length: Number(head - owned.checkpoint)}, (_, i) => owned.checkpoint + BigInt(i + 1));
    const receipts = await Promise.all(blocks.map(async (blockNumber) => {
      const [rows, count] = await Promise.all([
        client.getBlockReceipts({blockNumber}), client.getBlockTransactionCount({blockNumber}),
      ]);
      if (rows.length !== count || new Set(rows.map((row) => row.transactionHash)).size !== count ||
        rows.some((row) => row.blockNumber !== blockNumber)) {
        throw new Error(`Incomplete receipts at block ${blockNumber}`);
      }
      return rows;
    }));
    for (const block of receipts) for (const receipt of block) for (const log of receipt.logs) {
      if (!same(log.address, packsAddress)) continue;
      const event = decodeEventLog({abi: packEventsAbi, data: log.data, topics: log.topics});
      switch (event.eventName) {
        case "Transfer":
          touched.add(event.args.tokenId);
          if (same(event.args.from, zeroAddress)) minted.add(event.args.tokenId);
          break;
        case "PackMerged":
          touched.add(event.args.targetPackId);
          touched.add(event.args.sourcePackId);
          break;
        case "Approval":
        case "ApprovalForAll":
          break;
        default:
          touched.add(event.args.packId);
      }
    }
  }
  if (BigInt(minted.size) !== headTotalMinted - owned.mintedCount ||
    [...minted].some((id) => id <= owned.mintedCount || id > headTotalMinted)) {
    throw new Error("Packs indexer mint gap disagrees with chain receipts");
  }
  if (touched.size > 0) {
    const ids = [...touched];
    const rights = await client.multicall({contracts: ids.flatMap((id) => [
      {address: packsAddress, abi: packsAbi, functionName: "ownerOf", args: [id]} as const,
      {address: packsAddress, abi: packsAbi, functionName: "claimantOf", args: [id]} as const,
    ]), allowFailure: true, blockNumber: head});
    ids.forEach((id, i) => {
      const owner = rights[i * 2];
      const claimant = rights[i * 2 + 1];
      if (id < 1n || id > headTotalMinted || claimant.status !== "success") {
        throw new Error(`Cannot reconcile Pack #${id} wallet rights`);
      }
      refs.delete(id);
      if (owner.status === "success" && same(owner.result as string, account)) refs.set(id, {id, kind: "live"});
      else if (same(claimant.result as string, account)) refs.set(id, {id, kind: "claim"});
    });
  }
  return [...refs.values()].sort((a, b) => a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
}

async function chainPackRefs(
  client: PublicClient, account: Address, totalMinted: bigint, packsAddress: Address,
): Promise<PackRef[]> {
  const found: PackRef[] = [];
  for (let from = 1n; from <= totalMinted; from += 100n) {
    const page: bigint[] = [];
    for (let id = from; id <= totalMinted && id < from + 100n; id++) page.push(id);
    const results = await client.multicall({contracts: page.flatMap((id) => [
      {address: packsAddress, abi: packsAbi, functionName: "ownerOf", args: [id]} as const,
      {address: packsAddress, abi: packsAbi, functionName: "claimantOf", args: [id]} as const,
    ]), allowFailure: true});
    page.forEach((id, i) => {
      const owner = results[i * 2];
      const claimant = results[i * 2 + 1];
      if (claimant.status !== "success") throw new Error(`Cannot verify Pack #${id} claimant`);
      if (owner.status === "success" && same(owner.result as string, account)) found.push({id, kind: "live"});
      else if (same(claimant.result as string, account)) found.push({id, kind: "claim"});
    });
  }
  return found.reverse();
}

/** Short indexer lag is reconciled from chain receipts. Missing schema, older lag, or incomplete
 * receipts take the complete chain scan, which remains authoritative for wallet rights. */
export async function discoverOwnedPackRefs(
  client: PublicClient, account: Address, totalMinted: bigint, packsAddress: Address,
  options: {indexerUrl?: string; chainId: number; forceChain?: boolean},
): Promise<{refs: PackRef[]; source: "indexer" | "chain"}> {
  if (options.indexerUrl && !options.forceChain) {
    try {
      const refs = await indexedPackRefs(client, account, totalMinted, packsAddress, options.indexerUrl, options.chainId);
      return {refs, source: "indexer"};
    } catch { /* The complete onchain scan is the fallback for every indexer uncertainty. */ }
  }
  const headTotalMinted = await client.readContract({address: packsAddress, abi: packsAbi, functionName: "totalMinted"});
  return {refs: await chainPackRefs(client, account, headTotalMinted, packsAddress), source: "chain"};
}

/** Load only requested Packs. Onchain owner/claimant checks reject stale indexed candidates. */
export async function loadPackPage(client: PublicClient, account: Address, found: readonly PackRef[],
  packsAddress: Address, shapesAddress: Address): Promise<OwnedPack[]> {
  if (found.length === 0) return [];
  const holders = await client.multicall({contracts: found.flatMap(({id}) => [
    {address: packsAddress, abi: packsAbi, functionName: "ownerOf", args: [id]} as const,
    {address: packsAddress, abi: packsAbi, functionName: "claimantOf", args: [id]} as const,
  ]), allowFailure: true});
  found.forEach(({id, kind}, i) => {
    const owner = holders[i * 2];
    const claimant = holders[i * 2 + 1];
    const valid = kind === "live" ? owner.status === "success" && same(owner.result as string, account)
      : claimant.status === "success" && same(claimant.result as string, account);
    if (!valid) throw new Error(`Pack #${id} wallet rights changed`);
  });
  const liveIds = found.filter((pack) => pack.kind === "live").map((pack) => pack.id);
  const claimIds = found.filter((pack) => pack.kind === "claim").map((pack) => pack.id);
  const liveStates: ChainPackState[] = [];
  for (let offset = 0; offset < liveIds.length; offset += 5) {
    const batch = await client.multicall({contracts: liveIds.slice(offset, offset + 5).map((id) => ({
      address: packsAddress, abi: packsAbi, functionName: "packState", args: [id],
    } as const)), allowFailure: false}) as unknown as readonly ChainPackState[];
    liveStates.push(...batch);
  }
  const liveMetadata: ({status: "success"; result: string} | {status: "failure"})[] = [];
  for (let offset = 0; offset < liveIds.length; offset += 5) {
    const batch = await client.multicall({contracts: liveIds.slice(offset, offset + 5).map((id) => ({
      address: packsAddress, abi: packsAbi, functionName: "tokenURI", args: [id],
    } as const)), allowFailure: true});
    liveMetadata.push(...batch);
  }
  const claimContents: (readonly bigint[])[] = [];
  for (let offset = 0; offset < claimIds.length; offset += 5) {
    const batch = await client.multicall({contracts: claimIds.slice(offset, offset + 5).map((id) => ({
      address: packsAddress, abi: packsAbi, functionName: "contentsOf", args: [id],
    } as const)), allowFailure: false}) as unknown as readonly (readonly bigint[])[];
    claimContents.push(...batch);
  }
  const rows = found.map(({id, kind}) => {
    const state = kind === "live" ? liveStates[liveIds.indexOf(id)] : null;
    const metadataResult = kind === "live" ? liveMetadata[liveIds.indexOf(id)] : null;
    const metadata = metadataResult?.status === "success" ? safeMetadataFromTokenURI(metadataResult.result) : null;
    const shapeIds = state?.shapeIds ?? claimContents[claimIds.indexOf(id)];
    return {id, kind, name: metadata?.name ?? `Pack #${id}`, image: metadata?.image ?? null,
      shapeIds, valueWei: state?.valueWei ?? null,
      mintedCount: state?.mintedCount ?? null, creator: state?.creator ?? null};
  });
  const allShapeIds = rows.flatMap((row) => row.shapeIds);
  const allBackings: bigint[] = [];
  for (let offset = 0; offset < allShapeIds.length; offset += 100) {
    const batch = await client.multicall({contracts: allShapeIds.slice(offset, offset + 100).map((shapeId) => ({
      address: shapesAddress, abi: packsShapesAbi, functionName: "backingOf", args: [shapeId],
    })), allowFailure: false});
    allBackings.push(...batch.map((value) => BigInt(value)));
  }
  let offset = 0;
  return rows.map((row) => {
    const backings = allBackings.slice(offset, offset + row.shapeIds.length);
    offset += row.shapeIds.length;
    return {...row, backings};
  });
}

export function mintCountsValid(counts: readonly number[], denominationCount: number): boolean {
  return counts.length === denominationCount && counts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff);
}

export function creationMeetsMinimum(ownedBacking: bigint, quote: MintQuote, minimum: bigint): boolean {
  return ownedBacking + quote.backingWei >= minimum;
}

export function packPaymentBalanceError(balance: bigint, payment: bigint): string | null {
  if (balance > payment) return null;
  return `This wallet has ${formatEther(balance)} ETH. The pack needs ${formatEther(payment)} ETH plus ETH for network gas.`;
}
