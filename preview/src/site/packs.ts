import {createPublicClient, formatEther, parseAbi, type Address, type PublicClient} from "viem";
import {mainnet, sepolia} from "viem/chains";
import {shapesTransport} from "../chain/rpc";
import {safeMetadataFromTokenURI} from "./ogArtwork";

export const PACKS_DEPLOYMENTS = {
  1: {
    chainId: 1, name: "Mainnet", shapes: "0x6fe9193276bf7abcbee44ab7afd717d637d6faf0",
    packs: "0xf21514b090da7df4390803497d6ae673801e5ca7",
    renderer: "0xaf1c899baacc0fe8cfba0c6cf2624a018a393def",
    rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io",
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
  1: createPublicClient({chain: mainnet, transport: shapesTransport(1, PACKS_DEPLOYMENTS[1].rpc)}),
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
type ChainPackState = {shapeIds: readonly bigint[]; counts: readonly number[]; valueWei: bigint; mintedCount: bigint; creator: Address};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Scan pack ids in bounded Multicall batches. Burned ids can still belong to this claimant. */
export async function loadOwnedPacks(client: PublicClient, account: Address, totalMinted: bigint,
  packsAddress: Address, shapesAddress: Address): Promise<OwnedPack[]> {
  const ids: bigint[] = [];
  for (let id = 1n; id <= totalMinted; id++) ids.push(id);
  const found: {id: bigint; kind: "live" | "claim"}[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const page = ids.slice(offset, offset + 100);
    const results = await client.multicall({contracts: page.flatMap((id) => [
      {address: packsAddress, abi: packsAbi, functionName: "ownerOf", args: [id]} as const,
      {address: packsAddress, abi: packsAbi, functionName: "claimantOf", args: [id]} as const,
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
    address: packsAddress, abi: packsAbi, functionName: "packState", args: [id],
  } as const)), allowFailure: false}) as unknown as readonly ChainPackState[] : [];
  const liveMetadata = liveIds.length ? await client.multicall({contracts: liveIds.map((id) => ({
    address: packsAddress, abi: packsAbi, functionName: "tokenURI", args: [id],
  } as const)), allowFailure: true}) : [];
  const claimContents = claimIds.length ? await client.multicall({contracts: claimIds.map((id) => ({
    address: packsAddress, abi: packsAbi, functionName: "contentsOf", args: [id],
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
