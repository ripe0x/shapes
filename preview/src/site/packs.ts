import {createPublicClient, http, parseAbi, type Address, type PublicClient} from "viem";
import {sepolia} from "viem/chains";
import {safeMetadataFromTokenURI} from "./ogArtwork";

// The Sepolia deployment is intentionally separate from Shapes' mainnet deployment record.
export const PACKS_CHAIN_ID = 11155111;
export const PACKS_SHAPES = "0x6c2f9c00f44fbbf141dd166979903004b80d5f99" as const;
export const PACKS_ADDRESS = "0xd1cfc13abcbb370d381ac192aeb6f2e1b414022a" as const;
export const PACKS_RPC = "https://gateway.tenderly.co/public/sepolia";
// EIP-7825 caps one Sepolia transaction at 2^24 gas, regardless of the block gas limit.
export const SEPOLIA_TX_GAS_CAP = 1n << 24n;

export function packsGasBudget(blockGasLimit: bigint): bigint {
  const blockBudget = blockGasLimit * 8n / 10n;
  return blockBudget < SEPOLIA_TX_GAS_CAP ? blockBudget : SEPOLIA_TX_GAS_CAP;
}

export const packsAbi = [
  ...parseAbi([
    "function shapes() view returns (address)",
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
    "function open(uint256 packId)",
    "function redeem(uint256 packId)",
    "function unseal(uint256 packId,address claimant)",
    "function claim(uint256 packId,uint256 maxCount)",
    "function claimEth(uint256 packId,uint256 maxCount,address recipient)",
    "error NoShapes()",
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
  "function collection() view returns (address)",
  "function denominationCount() view returns (uint8)",
  "function denominationAt(uint8 index) view returns (uint256)",
  "function mintFee() view returns (uint256)",
  "function backingOf(uint256 tokenId) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator,bool approved)",
]);

export const packsCollectionAbi = parseAbi(["function card(uint8 denomIndex) view returns (string)"]);

export const packsClient = createPublicClient({chain: sepolia, transport: http(PACKS_RPC)});

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
type ChainPackState = {shapeIds: readonly bigint[]; counts: readonly number[]; valueWei: bigint; mintedCount: bigint; creator: Address};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Scan pack ids in bounded Multicall batches. Burned ids can still belong to this claimant. */
export async function loadOwnedPacks(client: PublicClient, account: Address, totalMinted: bigint): Promise<OwnedPack[]> {
  const ids: bigint[] = [];
  for (let id = 1n; id <= totalMinted; id++) ids.push(id);
  const found: {id: bigint; kind: "live" | "claim"}[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const page = ids.slice(offset, offset + 100);
    const results = await client.multicall({contracts: page.flatMap((id) => [
      {address: PACKS_ADDRESS, abi: packsAbi, functionName: "ownerOf", args: [id]} as const,
      {address: PACKS_ADDRESS, abi: packsAbi, functionName: "claimantOf", args: [id]} as const,
    ]), allowFailure: true});
    page.forEach((id, i) => {
      const owner = results[i * 2];
      const claimant = results[i * 2 + 1];
      if (owner.status === "success" && same(owner.result as string, account)) found.push({id, kind: "live"});
      else if (claimant.status === "success" && same(claimant.result as string, account)) found.push({id, kind: "claim"});
    });
  }
  found.reverse();
  const liveIds = found.filter((pack) => pack.kind === "live").map((pack) => pack.id);
  const claimIds = found.filter((pack) => pack.kind === "claim").map((pack) => pack.id);
  const liveStates = liveIds.length ? await client.multicall({contracts: liveIds.map((id) => ({
    address: PACKS_ADDRESS, abi: packsAbi, functionName: "packState", args: [id],
  } as const)), allowFailure: false}) as unknown as readonly ChainPackState[] : [];
  const liveMetadata = liveIds.length ? await client.multicall({contracts: liveIds.map((id) => ({
    address: PACKS_ADDRESS, abi: packsAbi, functionName: "tokenURI", args: [id],
  } as const)), allowFailure: true}) : [];
  const claimContents = claimIds.length ? await client.multicall({contracts: claimIds.map((id) => ({
    address: PACKS_ADDRESS, abi: packsAbi, functionName: "contentsOf", args: [id],
  } as const)), allowFailure: false}) as unknown as readonly (readonly bigint[])[] : [];
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
      address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "backingOf", args: [shapeId],
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
