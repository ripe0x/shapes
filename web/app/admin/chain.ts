import {createPublicClient, formatEther, http, type Address, type Hash} from "viem";
import {mainnet} from "viem/chains";
import {shapesAbi, type Deployment} from "@shared/chain/abi";

// ENS and contract authority are checked against mainnet on every load and before a write.
// A reverse-name label or a value persisted in the browser is never an access credential.
export const adminClient = createPublicClient({
  chain: mainnet,
  transport: http("https://mainnet.gateway.tenderly.co"),
});

const ADMIN_NAME = "ripe0x.eth";

export type FeeBalance = {recipient: Address; amountWei: bigint; current: boolean};
export type Withdrawal = {
  recipient: Address;
  amountWei: bigint;
  blockNumber: bigint;
  transactionHash: Hash;
  logIndex: number;
};
export type AdminSnapshot = {
  admin: Address;
  ensAddress: Address;
  feeRecipient: Address;
  pendingWei: bigint;
  mintFeeWei: bigint;
  presentationLocked: boolean;
  positions: readonly [Address, boolean];
  market: readonly [Address, boolean];
  balances: FeeBalance[];
  withdrawals: Withdrawal[];
  blockNumber: bigint;
};

export function sameAddress(a: Address | undefined | null, b: Address | undefined | null) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function canAccessAdmin(wallet: Address | undefined, ens: Address | undefined, admin: Address | undefined) {
  return sameAddress(wallet, ens) && sameAddress(wallet, admin);
}

export function eth(wei: bigint) {
  return `${formatEther(wei)} ETH`;
}

export async function readAdminIdentity(dep: Deployment) {
  if (dep.chainId !== 1 || dep.fromBlock === undefined) throw new Error("Admin is available on mainnet only.");
  const [ensAddress, admin] = await Promise.all([
    adminClient.getEnsAddress({name: ADMIN_NAME}),
    adminClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "admin"}),
  ]);
  return {ensAddress, admin};
}

export async function readAdminSnapshot(
  dep: Deployment,
  wallet: Address,
  identity?: Awaited<ReturnType<typeof readAdminIdentity>>,
): Promise<AdminSnapshot> {
  const {ensAddress, admin} = identity ?? await readAdminIdentity(dep);
  if (!canAccessAdmin(wallet, ensAddress ?? undefined, admin)) throw new Error("This wallet is not the current Shapes admin for ripe0x.eth.");

  const blockNumber = await adminClient.getBlockNumber();
  const fromBlock = BigInt(dep.fromBlock!);
  const [feeRecipient, pendingWei, mintFeeWei, presentationLocked, positions, market, recipientEvents, withdrawalEvents] = await Promise.all([
    adminClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "feeRecipient", blockNumber}),
    adminClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "pendingFees", blockNumber}),
    adminClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "mintFee", blockNumber}),
    adminClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "presentationLocked", blockNumber}),
    adminClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "positions", blockNumber}),
    adminClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "market", blockNumber}),
    adminClient.getLogs({address: dep.shapes, event: shapesAbi.find((item) => item.type === "event" && item.name === "FeeRecipientUpdated") as Extract<typeof shapesAbi[number], {type: "event"; name: "FeeRecipientUpdated"}>, fromBlock, toBlock: blockNumber}),
    adminClient.getLogs({address: dep.shapes, event: shapesAbi.find((item) => item.type === "event" && item.name === "FeesWithdrawn") as Extract<typeof shapesAbi[number], {type: "event"; name: "FeesWithdrawn"}>, fromBlock, toBlock: blockNumber}),
  ]);

  const recipients = new Map<string, Address>();
  const addRecipient = (address: Address) => recipients.set(address.toLowerCase(), address);
  addRecipient(feeRecipient);
  for (const event of recipientEvents) {
    if (event.args.previousRecipient) addRecipient(event.args.previousRecipient);
    if (event.args.newRecipient) addRecipient(event.args.newRecipient);
  }
  const balances = await Promise.all([...recipients.values()].map(async (recipient) => ({
    recipient,
    amountWei: await adminClient.readContract({address: dep.shapes, abi: shapesAbi, functionName: "feesOwedTo", args: [recipient], blockNumber}),
    current: sameAddress(recipient, feeRecipient),
  })));
  if (balances.reduce((sum, row) => sum + row.amountWei, 0n) !== pendingWei) {
    throw new Error("The fee ledger does not reconcile with total pending fees. Withdrawals are unavailable until it does.");
  }
  const withdrawals: Withdrawal[] = withdrawalEvents.map((event) => ({
    recipient: event.args.recipient!,
    amountWei: event.args.amountWei!,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
  })).sort((a, b) => a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1);
  return {admin, ensAddress: ensAddress!, feeRecipient, pendingWei, mintFeeWei, presentationLocked, positions, market, balances, withdrawals, blockNumber};
}
