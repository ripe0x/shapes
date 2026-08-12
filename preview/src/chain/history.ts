import {formatEther, type PublicClient} from "viem";
import {shapesAbi, denomLabel, type Deployment} from "./abi";

const ZERO = "0x0000000000000000000000000000000000000000";

export type HistKind =
  | "mint"
  | "bornFromSplit"
  | "splitInto"
  | "absorbed"
  | "mergedAway"
  | "blackened"
  | "redeemed"
  | "transfer";

export interface HistEvent {
  key: string;
  block: bigint;
  logIndex: number;
  tx: `0x${string}`;
  kind: HistKind;
  /// One-line human description of what happened to this token.
  text: string;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/// Reconstruct a single token's on-chain history from the contract's event log. Each Shapes
/// operation is a distinct event, and recomposition events name every token they touch, so a
/// token's full lineage — its birth (a mint, or a split of some parent), the merges and splits it
/// took part in, transfers, and any sacrifice — is recoverable without an indexer. On a local dev
/// chain the block range is tiny, so a full scan from block 0 is cheap.
export async function loadHistory(
  publicClient: PublicClient,
  dep: Deployment,
  id: bigint,
): Promise<HistEvent[]> {
  const base = {address: dep.shapes, abi: shapesAbi, fromBlock: 0n, toBlock: "latest"} as const;
  const [minted, composed, decomposed, blackened, redeemed, transfers] = await Promise.all([
    publicClient.getContractEvents({...base, eventName: "ShapeMinted"}),
    publicClient.getContractEvents({...base, eventName: "Composed"}),
    publicClient.getContractEvents({...base, eventName: "Decomposed"}),
    publicClient.getContractEvents({...base, eventName: "Blackened"}),
    publicClient.getContractEvents({...base, eventName: "ShapeRedeemed"}),
    publicClient.getContractEvents({...base, eventName: "Transfer"}),
  ]);

  const out: HistEvent[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const push = (log: any, kind: HistKind, text: string) =>
    out.push({
      key: `${log.transactionHash}-${log.logIndex}`,
      block: log.blockNumber as bigint,
      logIndex: log.logIndex as number,
      tx: log.transactionHash as `0x${string}`,
      kind,
      text,
    });

  for (const l of minted) {
    if (l.args.tokenId === id) {
      const oc = l.args.originCount ?? 0n; // uint256 → bigint
      push(l, "mint", `Minted — ${oc} origin${oc === 1n ? "" : "s"}, ${denomLabel(l.args.amountWei ?? 0n)} ETH`);
    }
  }
  for (const l of decomposed) {
    if (l.args.newIds?.some((x) => x === id)) {
      push(l, "bornFromSplit", `Created by splitting #${l.args.tokenId?.toString()}`);
    }
    if (l.args.tokenId === id) {
      push(l, "splitInto", `Split into ${l.args.newIds?.length ?? 0} shapes`);
    }
  }
  for (const l of composed) {
    if (l.args.survivorId === id) {
      const n = l.args.burnedIds?.length ?? 0;
      push(l, "absorbed", `Absorbed ${n} shape${n === 1 ? "" : "s"} → grew to a larger denomination`);
    }
    if (l.args.burnedIds?.some((x) => x === id)) {
      push(l, "mergedAway", `Merged into #${l.args.survivorId?.toString()}`);
    }
  }
  for (const l of blackened) {
    if (l.args.tokenId === id) {
      push(l, "blackened", `Blackened — ${formatEther(l.args.sacrificedWei ?? 0n)} ETH sacrificed`);
    }
  }
  for (const l of redeemed) {
    if (l.args.tokenId === id) {
      const oc = l.args.originCount ?? 0n;
      push(
        l,
        "redeemed",
        `Redeemed — ${formatEther(l.args.amountWei ?? 0n)} ETH returned, ${oc} origin${oc === 1n ? "" : "s"} retired`,
      );
    }
  }
  for (const l of transfers) {
    if (l.args.tokenId !== id) continue;
    const from = (l.args.from ?? ZERO) as string;
    const to = (l.args.to ?? ZERO) as string;
    // The mint and burn Transfers (to/from the zero address) duplicate the semantic events above.
    if (from === ZERO || to === ZERO) continue;
    push(l, "transfer", `Transferred ${short(from)} → ${short(to)}`);
  }

  out.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  return out;
}
