/**
 * Shared chain-actor helpers for the dev-chain simulation scripts (`simulate.ts`,
 * `simulateHistory.ts`). Wraps every Shapes / ShapeAuctionHouse entrypoint the
 * scripts drive behind a small set of functions bound to a deployment and a pool of wallets, so
 * neither script hand-rolls gas buffering, event parsing or client setup.
 */
import {readFileSync} from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  defineChain,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {shapesAbi, auctionHouseAbi, DENOMINATIONS, type Deployment} from "../../src/chain/abi";

/** Anvil's ten default, publicly-known test private keys, in account order. Test chains only. */
export const ANVIL_KEYS: readonly Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const;

/** The dev browser wallet. Never touched except to receive presents at the very end of a run. */
export const PRESENTS_TO = "0xCB43078C32423F5348Cab5885911C3B5faE217F9" as const;

/** Loads a `deployment.json` written by `script/fork-dev.sh`, given its absolute path. */
export function loadDeployment(path: string): Deployment {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A private key for a simulation actor beyond the ten anvil defaults, derived at call time from
 *  a seed and index. Never persisted: recomputed whenever an actor needs to sign. */
export function derivedKey(seed: string, index: number): Hex {
  return keccak256(toBytes(`${seed}:${index}`));
}

const D = DENOMINATIONS; // index: 0=0.01 1=0.05 2=0.1 3=0.5 4=1 5=5 6=10 7=50 8=100

export async function createSim(dep: Deployment, keys: readonly Hex[]) {
  const chain = defineChain({
    id: dep.chainId,
    name: "dev",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [dep.rpc]}},
  });
  // viem defaults to a 4s polling interval for receipt/confirmation waits, tuned for public
  // chains with multi-second block times. Anvil mines instantly, so left at the default,
  // `waitForTransactionReceipt` after every write spends up to 4s doing nothing: at hundreds of
  // transactions across a full run that alone dominates wall-clock time.
  const pollingInterval = 50;
  // The apex-build scenes bundle thousands of burns into one composeMany call; estimating and
  // executing that against local anvil can take well past viem's 10s default HTTP timeout.
  const transport = http(dep.rpc, {timeout: 300_000});
  const pub = createPublicClient({chain, transport, pollingInterval});
  const actors: WalletClient[] = keys.map((k) =>
    createWalletClient({chain, transport, account: privateKeyToAccount(k), pollingInterval}),
  );
  const addr = (i: number) => actors[i].account!.address as Address;

  let mintFee = (await pub.readContract({
    address: dep.shapes,
    abi: shapesAbi,
    functionName: "mintFee",
  })) as bigint;

  let txCount = 0;
  const counts: Record<string, number> = {};
  const bump = (fn: string) => {
    counts[fn] = (counts[fn] ?? 0) + 1;
  };

  /** Every write goes through here: estimates gas, buffers it 1.5x (viem's raw estimate lands
   *  exactly at the edge where the ink-gene mint's reentrancy guard OOGs on re-execution), sends,
   *  waits for the receipt, and throws on a revert. Bounded by the dev chain's block gas limit. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function send(actor: number, address: Address, abi: any, fn: string, args: unknown[], value?: bigint) {
    const req = {address, abi, functionName: fn as never, args: args as never, value, account: actors[actor].account};
    const est = await pub.estimateContractGas(req as never);
    const hash = await actors[actor].writeContract({...req, gas: (est * 3n) / 2n} as never);
    const receipt = await pub.waitForTransactionReceipt({hash});
    if (receipt.status !== "success") throw new Error(`${fn} reverted (${hash})`);
    txCount++;
    bump(fn);
    return receipt;
  }

  const sSend = (actor: number, fn: string, args: unknown[], value?: bigint) =>
    send(actor, dep.shapes, shapesAbi, fn, args, value);
  const hSend = (actor: number, fn: string, args: unknown[], value?: bigint) => {
    if (!dep.auctionHouse) throw new Error("deployment has no auctionHouse");
    return send(actor, dep.auctionHouse, auctionHouseAbi, fn, args, value);
  };

  /* ------------------------------- mint ------------------------------- */

  /** `mint` for qty 1, `mintBatch` otherwise. Original behaviour of `simulate.ts`'s helper. */
  async function mint(actor: number, di: number, qty: number): Promise<bigint[]> {
    const wei = D[di].wei;
    const value = (wei + mintFee) * BigInt(qty);
    const receipt =
      qty === 1 ? await sSend(actor, "mint", [wei], value) : await sSend(actor, "mintBatch", [wei, BigInt(qty)], value);
    return parseEventLogs({abi: shapesAbi, eventName: "ShapeMinted", logs: receipt.logs}).map((l) => l.args.tokenId as bigint);
  }

  async function mintTo(actor: number, di: number, to: Address): Promise<bigint> {
    const wei = D[di].wei;
    const receipt = await sSend(actor, "mintTo", [wei, to], wei + mintFee);
    return parseEventLogs({abi: shapesAbi, eventName: "ShapeMinted", logs: receipt.logs})[0]!.args.tokenId as bigint;
  }

  async function mintBatchTo(actor: number, di: number, qty: number, to: Address): Promise<bigint[]> {
    const wei = D[di].wei;
    const value = (wei + mintFee) * BigInt(qty);
    const receipt = await sSend(actor, "mintBatchTo", [wei, BigInt(qty), to], value);
    return parseEventLogs({abi: shapesAbi, eventName: "ShapeMinted", logs: receipt.logs}).map((l) => l.args.tokenId as bigint);
  }

  /* ----------------------------- compose ------------------------------ */

  async function compose(actor: number, survivor: bigint, burns: bigint[]): Promise<bigint> {
    await sSend(actor, "compose", [survivor, burns]);
    return survivor;
  }

  async function composeMany(actor: number, calls: {survivorId: bigint; burnIds: bigint[]}[]): Promise<bigint[]> {
    const receipt = await sSend(actor, "composeMany", [calls]);
    return parseEventLogs({abi: shapesAbi, eventName: "Composed", logs: receipt.logs}).map((l) => l.args.survivorId as bigint);
  }

  /** Compose `per` same-denomination tokens at a time, one tier up. Returns the survivors. */
  async function composeUp(actor: number, ids: bigint[], per: number): Promise<bigint[]> {
    const out: bigint[] = [];
    for (let i = 0; i + per <= ids.length; i += per) {
      out.push(await compose(actor, ids[i]!, ids.slice(i + 1, i + per)));
    }
    return out;
  }

  async function decompose(actor: number, survivorId: bigint): Promise<bigint[]> {
    const receipt = await sSend(actor, "decompose", [survivorId]);
    return parseEventLogs({abi: shapesAbi, eventName: "Decomposed", logs: receipt.logs})[0]!.args.restoredIds as bigint[];
  }

  async function decomposeTo(actor: number, survivorId: bigint, recipient: Address): Promise<bigint[]> {
    const receipt = await sSend(actor, "decomposeTo", [survivorId, recipient]);
    return parseEventLogs({abi: shapesAbi, eventName: "Decomposed", logs: receipt.logs})[0]!.args.restoredIds as bigint[];
  }

  /** One `Decomposed` event per survivor, in call order, so log order lines up with `survivorIds`. */
  async function decomposeMany(actor: number, survivorIds: bigint[]): Promise<bigint[][]> {
    const receipt = await sSend(actor, "decomposeMany", [survivorIds]);
    return parseEventLogs({abi: shapesAbi, eventName: "Decomposed", logs: receipt.logs}).map((l) => l.args.restoredIds as bigint[]);
  }

  async function decomposeManyTo(actor: number, survivorIds: bigint[], recipient: Address): Promise<bigint[][]> {
    const receipt = await sSend(actor, "decomposeManyTo", [survivorIds, recipient]);
    return parseEventLogs({abi: shapesAbi, eventName: "Decomposed", logs: receipt.logs}).map((l) => l.args.restoredIds as bigint[]);
  }

  /* ------------------------------ split -------------------------------- */

  async function split(actor: number, id: bigint, outDenoms: number[]): Promise<bigint[]> {
    const receipt = await sSend(actor, "split", [id, outDenoms]);
    return parseEventLogs({abi: shapesAbi, eventName: "Split", logs: receipt.logs})[0]!.args.newIds as bigint[];
  }

  async function splitTo(actor: number, id: bigint, outDenoms: number[], recipient: Address): Promise<bigint[]> {
    const receipt = await sSend(actor, "splitTo", [id, outDenoms, recipient]);
    return parseEventLogs({abi: shapesAbi, eventName: "Split", logs: receipt.logs})[0]!.args.newIds as bigint[];
  }

  /* --------------------------- redeem / burn ---------------------------- */

  const redeem = (actor: number, id: bigint) => sSend(actor, "redeem", [id]);
  const redeemTo = (actor: number, id: bigint, recipient: Address) => sSend(actor, "redeemTo", [id, recipient]);
  const redeemBatch = (actor: number, ids: bigint[]) => sSend(actor, "redeemBatch", [ids]);
  const redeemBatchTo = (actor: number, ids: bigint[], recipient: Address) =>
    sSend(actor, "redeemBatchTo", [ids, recipient]);
  const burn = (actor: number, id: bigint) => sSend(actor, "burn", [id]);
  const sacrifice = (actor: number, id: bigint) => sSend(actor, "sacrifice", [id]);

  /* ----------------------------- transfers ------------------------------ */

  const transfer = (actor: number, to: Address, id: bigint) => sSend(actor, "transferFrom", [addr(actor), to, id]);
  const safeTransferFrom = (actor: number, to: Address, id: bigint) =>
    sSend(actor, "safeTransferFrom", [addr(actor), to, id]);
  const setApprovalForAll = (actor: number, operator: Address, approved: boolean) =>
    sSend(actor, "setApprovalForAll", [operator, approved]);

  /* ------------------------------- admin --------------------------------- */

  const withdrawFees = (actor: number) => sSend(actor, "withdrawFees", []);
  async function setMintFee(actor: number, newFee: bigint) {
    await sSend(actor, "setMintFee", [newFee]);
    mintFee = newFee;
  }
  const setMetadataCopy = (actor: number, tokenNamePrefix: string, description: string) =>
    sSend(actor, "setMetadataCopy", [tokenNamePrefix, description]);

  /** Signs the EIP-712 `ArtistAttribution(address shapes,address artist,bytes32 releaseHash)`
   *  digest as `signerIdx` (the deployer/artist) and relays it from `relayerIdx`, who need not be
   *  the artist: `attestArtist` accepts a signature relayed by anyone. */
  async function attestArtist(signerIdx: number, relayerIdx: number, releaseHash: Hex) {
    const domain = {
      name: "Shapes Artist Attribution",
      version: "1",
      chainId: dep.chainId,
      verifyingContract: dep.shapes,
    } as const;
    const types = {
      ArtistAttribution: [
        {name: "shapes", type: "address"},
        {name: "artist", type: "address"},
        {name: "releaseHash", type: "bytes32"},
      ],
    } as const;
    const signature = await actors[signerIdx]!.signTypedData({
      account: actors[signerIdx]!.account!,
      domain,
      types,
      primaryType: "ArtistAttribution",
      message: {shapes: dep.shapes, artist: addr(signerIdx), releaseHash},
    });
    return sSend(relayerIdx, "attestArtist", [releaseHash, signature]);
  }

  /* ------------------------------- reads --------------------------------- */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const previewCompose = (actor: number, survivorId: bigint, burnIds: bigint[]): Promise<any> =>
    pub.readContract({
      address: dep.shapes,
      abi: shapesAbi,
      functionName: "previewCompose",
      args: [addr(actor), survivorId, burnIds],
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const previewSplit = (actor: number, tokenId: bigint, outDenoms: number[]): Promise<any> =>
    pub.readContract({
      address: dep.shapes,
      abi: shapesAbi,
      functionName: "previewSplit",
      args: [addr(actor), tokenId, outDenoms],
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shapeState = (tokenId: bigint): Promise<any> =>
    pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "shapeState", args: [tokenId]});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const composeRecordAt = (survivorId: bigint, depth: bigint): Promise<any> =>
    pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "composeRecordAt", args: [survivorId, depth]});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const splitOriginOf = (childId: bigint): Promise<any> =>
    pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "splitOriginOf", args: [childId]});
  const composeDepth = (tokenId: bigint): Promise<bigint> =>
    pub.readContract({address: dep.shapes, abi: shapesAbi, functionName: "composeDepth", args: [tokenId]}) as Promise<bigint>;

  /* --------------------------- auction house ------------------------------ */

  async function createAuction(
    actor: number,
    tokenId: bigint,
    duration: number,
    reserveUnits: bigint,
    minIncrementBps: number,
    extensionWindow: number,
  ): Promise<bigint> {
    const receipt = await hSend(actor, "createAuction", [
      dep.shapes,
      tokenId,
      BigInt(duration),
      reserveUnits,
      minIncrementBps,
      extensionWindow,
    ]);
    return parseEventLogs({abi: auctionHouseAbi, eventName: "AuctionCreated", logs: receipt.logs})[0]!.args
      .auctionId as bigint;
  }

  const mintCostFor = (backingWei: bigint): Promise<bigint> =>
    pub.readContract({
      address: dep.auctionHouse!,
      abi: auctionHouseAbi,
      functionName: "mintCostFor",
      args: [backingWei],
    }) as Promise<bigint>;

  /** ETH-only or mixed bids compute the exact `mintCostFor(ethBackingWei)` themselves; a
   *  cards-only bid (`ethBackingWei === 0n`) sends no value. */
  async function auctionBid(actor: number, auctionId: bigint, cardIds: bigint[], ethBackingWei: bigint) {
    const value = ethBackingWei > 0n ? await mintCostFor(ethBackingWei) : 0n;
    return hSend(actor, "bid", [auctionId, cardIds, ethBackingWei], value);
  }
  const auctionWithdraw = (actor: number, auctionId: bigint) => hSend(actor, "withdraw", [auctionId]);
  const auctionSettle = (actor: number, auctionId: bigint) => hSend(actor, "settle", [auctionId]);
  const auctionClaimLot = (actor: number, auctionId: bigint) => hSend(actor, "claimLot", [auctionId]);
  const auctionClaimProceeds = (actor: number, auctionId: bigint) => hSend(actor, "claimProceeds", [auctionId]);
  const auctionCancel = (actor: number, auctionId: bigint) => hSend(actor, "cancelAuction", [auctionId]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getAuction = (auctionId: bigint): Promise<any> =>
    pub.readContract({address: dep.auctionHouse!, abi: auctionHouseAbi, functionName: "auctions", args: [auctionId]});
  const minimumBid = (auctionId: bigint): Promise<bigint> =>
    pub.readContract({
      address: dep.auctionHouse!,
      abi: auctionHouseAbi,
      functionName: "minimumBid",
      args: [auctionId],
    }) as Promise<bigint>;

  /* ------------------------------- clock ---------------------------------- */

  /** Advances the dev chain's clock and mines one block, via anvil's `evm_increaseTime` /
   *  `evm_mine` RPC methods. */
  async function advanceTime(seconds: number) {
    await pub.request({method: "evm_increaseTime", params: [seconds]} as never);
    await pub.request({method: "evm_mine", params: []} as never);
  }

  /** Funds an address with `ethAmount` ETH via anvil's `anvil_setBalance`. For actors derived at
   *  runtime beyond the ten anvil defaults, which start with nothing. */
  async function fund(address: Address, ethAmount: bigint) {
    const wei = ethAmount * 1_000_000_000_000_000_000n;
    await pub.request({method: "anvil_setBalance", params: [address, `0x${wei.toString(16)}`]} as never);
  }

  return {
    pub,
    actors,
    addr,
    dep,
    D,
    txCount: () => txCount,
    counts: () => counts,
    mintFee: () => mintFee,
    fund,
    advanceTime,
    mint,
    mintTo,
    mintBatchTo,
    compose,
    composeMany,
    composeUp,
    decompose,
    decomposeTo,
    decomposeMany,
    decomposeManyTo,
    split,
    splitTo,
    redeem,
    redeemTo,
    redeemBatch,
    redeemBatchTo,
    burn,
    sacrifice,
    transfer,
    safeTransferFrom,
    setApprovalForAll,
    withdrawFees,
    setMintFee,
    setMetadataCopy,
    attestArtist,
    previewCompose,
    previewSplit,
    shapeState,
    composeRecordAt,
    splitOriginOf,
    composeDepth,
    createAuction,
    auctionBid,
    auctionWithdraw,
    auctionSettle,
    auctionClaimLot,
    auctionClaimProceeds,
    auctionCancel,
    mintCostFor,
    getAuction,
    minimumBid,
  };
}

export type Sim = Awaited<ReturnType<typeof createSim>>;
