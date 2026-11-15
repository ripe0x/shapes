import React from "react";
import {formatEther, zeroAddress, type Address} from "viem";
import type {Deployment} from "../chain/abi";
import {packsAbi, packsClientFor, packsDeploymentFor} from "./packs";
import {checkpointOf, indexerQuery, requireFreshCheckpoint, type IndexerMeta} from "./indexerClient";
import {AddressName} from "./AddressName";
import {Section, txUrl} from "./ui";

type PackState = {shapeIds: readonly bigint[]; counts: readonly number[]; valueWei: bigint; mintedCount: bigint; creator: Address};
type PackEvent = {
  id: string; kind: string; blockNumber: string; timestamp: string; txHash: `0x${string}`;
  tokenIds: string[]; actor: Address; counterparty: Address | null; amountWei: string | null;
  relatedPackId?: string | null;
};

const HISTORY_QUERY = `query PackHistory($id: BigInt!) {
  _meta { status }
  activitys(where: {packId: $id}, orderBy: "orderKey", orderDirection: "desc", limit: 500) {
    items { id kind blockNumber timestamp txHash tokenIds actor counterparty amountWei relatedPackId }
  }
}`;
const LEGACY_HISTORY_QUERY = HISTORY_QUERY.replace(" relatedPackId", "");
const TERMINAL_KINDS = new Set(["packOpened", "packRedeemed", "packUnsealed", "packMergedAway"]);
const LABELS: Record<string, string> = {
  packCreated: "Created", packExtended: "Expanded", packMerged: "Merged into", packMergedAway: "Merged into another Pack",
  packUnsealed: "Unsealed", packOpened: "Opened", packRedeemed: "Redeemed",
  packShapesClaimed: "Shapes claimed", packEthClaimed: "ETH claimed", packTransferred: "Transferred",
};

async function historyFor(url: string | undefined, chainId: number, id: bigint): Promise<PackEvent[] | null> {
  if (!url) return null;
  try {
    const read = (query: string) => indexerQuery<{_meta: IndexerMeta; activitys: {items: PackEvent[]}}>(url, fetch, query, {id: id.toString()});
    const [result, head] = await Promise.all([read(HISTORY_QUERY).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("relatedPackId")) throw error;
      return read(LEGACY_HISTORY_QUERY);
    }), packsClientFor(chainId).getBlockNumber()]);
    requireFreshCheckpoint(checkpointOf(result.data?._meta, chainId), head);
    return result.data?.activitys?.items ?? null;
  } catch {
    return null;
  }
}

type Detail = {
  exists: boolean; owner: Address | null; claimant: Address | null; state: PackState | null;
  contents: readonly bigint[]; history: PackEvent[] | null; artBlock: bigint | "latest";
};

export function PackDetailView({dep, packId}: {dep: Deployment; packId: bigint}) {
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(false);
    const deployment = packsDeploymentFor(dep.chainId);
    if (!deployment || deployment.shapes.toLowerCase() !== dep.shapes.toLowerCase()) {
      setError(true);
      return;
    }
    const client = packsClientFor(dep.chainId);
    const read = async <T,>(functionName: "ownerOf" | "claimantOf" | "contentsOf" | "packState", blockNumber?: bigint): Promise<T | null> => {
      try {
        return await client.readContract({address: deployment.packs, abi: packsAbi, functionName, args: [packId],
          ...(blockNumber === undefined ? {} : {blockNumber})}) as T;
      } catch { return null; }
    };
    void (async () => {
      const [totalMinted, history] = await Promise.all([
        client.readContract({address: deployment.packs, abi: packsAbi, functionName: "totalMinted"}),
        historyFor(dep.indexerUrl, dep.chainId, packId),
      ]);
      if (packId === 0n || packId > totalMinted) {
        if (!cancelled) setDetail({exists: false, owner: null, claimant: null, state: null, contents: [], history, artBlock: "latest"});
        return;
      }
      const [owner, claimant, currentState, contents] = await Promise.all([
        read<Address>("ownerOf"), read<Address>("claimantOf"), read<PackState>("packState"), read<readonly bigint[]>("contentsOf"),
      ]);
      const terminal = history?.find((event) => TERMINAL_KINDS.has(event.kind));
      const artBlock = owner ? "latest" : terminal && BigInt(terminal.blockNumber) > 0n ? BigInt(terminal.blockNumber) - 1n : "latest";
      const state = currentState ?? (artBlock !== "latest" ? await read<PackState>("packState", artBlock) : null);
      if (!cancelled) setDetail({exists: true, owner, claimant: claimant === zeroAddress ? null : claimant,
        state, contents: contents ?? [], history, artBlock});
    })().catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [dep, packId]);

  if (error) return <Section title={`PACK #${packId}`}><p>Pack data is temporarily unavailable.</p></Section>;
  if (!detail) return <Section title={`PACK #${packId}`}><p>Loading Pack…</p></Section>;
  if (!detail.exists) return <Section title={`PACK #${packId}`}><p>This Pack does not exist.</p></Section>;

  const terminal = detail.history?.find((event) => TERMINAL_KINDS.has(event.kind));
  const status = detail.owner ? "Live" : terminal?.kind === "packMergedAway" ? "Merged"
    : terminal?.kind === "packRedeemed" ? "Redeemed" : terminal?.kind === "packOpened" ? "Opened"
      : terminal?.kind === "packUnsealed" ? "Unsealed" : "No longer live";
  const shapeIds = detail.owner ? (detail.state?.shapeIds ?? [])
    : detail.contents.length ? detail.contents : (detail.state?.shapeIds ?? terminal?.tokenIds.map(BigInt) ?? []);
  const art = `/api/pack-art/${packId}/${detail.artBlock}`;
  return <Section title={`PACK #${packId}`}>
    <p><a href="/packs">← Packs</a></p>
    <div className="pack-page-heading">
      <div className="pack-page-art"><img src={art} alt={`Pack #${packId} artwork`} /></div>
      <div>
        <p className="launch-kicker">SHAPE PACK · {status.toUpperCase()}</p>
        <h1>Pack #{packId.toString()}</h1>
        {detail.state && <p>{formatEther(detail.state.valueWei)} ETH backing · {shapeIds.length} Shapes</p>}
        {detail.owner && <p>Owner <AddressName address={detail.owner} /></p>}
        {detail.claimant && <p>Claimant <AddressName address={detail.claimant} /></p>}
        {detail.state?.creator && <p>Created by <AddressName address={detail.state.creator} /></p>}
        {!detail.owner && terminal?.kind === "packMergedAway" && terminal.relatedPackId &&
          <p>Contents moved to <a href={`/packs/${terminal.relatedPackId}`}>Pack #{terminal.relatedPackId}</a></p>}
      </div>
    </div>
    {shapeIds.length > 0 && <div className="pack-page-section">
      <h2>{detail.owner ? "Current contents" : "Contents at exit"}</h2>
      <div className="pack-page-shapes">{shapeIds.map((id) => <a key={id.toString()} href={`/shape/${id}`}>Shape #{id}</a>)}</div>
    </div>}
    {detail.history && <div className="pack-page-section">
      <h2>History</h2>
      {detail.history.length === 0 ? <p>No indexed events yet.</p> : <ol className="pack-page-history">{detail.history.map((event) =>
        <li key={event.id}><span>{LABELS[event.kind] ?? event.kind}</span>
          {event.kind === "packMergedAway" && event.relatedPackId && <a href={`/packs/${event.relatedPackId}`}>Pack #{event.relatedPackId}</a>}
          {event.kind === "packTransferred" && event.counterparty &&
            <span><AddressName address={event.actor} /> → <AddressName address={event.counterparty} /></span>}
          {event.amountWei && <span>{formatEther(BigInt(event.amountWei))} ETH</span>}
          <a href={txUrl(event.txHash, dep.chainId)} target="_blank" rel="noreferrer">{new Date(Number(event.timestamp) * 1000).toLocaleDateString()}</a>
        </li>)}</ol>}
    </div>}
    {!detail.history && <p className="packs-small">Pack history is temporarily unavailable.</p>}
  </Section>;
}
