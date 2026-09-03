import React from "react";
import {type PublicClient} from "viem";
import {DENOMINATIONS, type Deployment} from "../chain/abi";
import {geometryAt, svgFromComposition, CANONICAL} from "../canonical/render";
import {
  loadHistory,
  loadProvenance,
  type HistEvent,
  type ProvNode,
} from "../chain/history";
import {C, FONT, SANS, label} from "./theme";
import {Section, Art, Modal, short, txUrl} from "./ui";
import {localArt} from "./art";
import {mintGene} from "../previewGene";
import type {SiteData, SiteToken} from "./data";
import type {RedeemState} from "./SiteApp";
import {
  loadDna,
  loadDnaFromSnapshot,
  deriveSeedDna,
  type DnaCell,
  type DnaResult,
  type DnaDonor,
  type DnaComposeResult,
  type DnaSplitResult,
  type DnaSeedResult,
  type DnaSnapshot,
} from "./dna";
import {moduleBytesToHex} from "../canonical/moduleCodec";
import type {CardGeometry} from "../canonical/render";
import {effectiveModuleBytes, composeSampledShape, type SampleDonor} from "../canonical/sampling";
import {ProvenanceTree, initialExpandedKeys, type TreeNode} from "./ProvenanceTree";
import {C as PROV_C, forDisplay} from "../app/ui";
import {DetailPanel, GridOverlayCells, donorColor, useActiveCell} from "../app/provenance";
import {downloadTracePng, downloadTraceSvg, svgFromDataUri} from "../app/traceExport";
import {displayTraits} from "./displayTraits";
import {shapeTitle} from "./shapeTitle";

const EVENT_LABEL: Record<HistEvent["kind"], string> = {
  mint: "Minted",
  bornFromSplit: "Created",
  splitInto: "Split",
  absorbed: "Composed",
  mergedAway: "Composed",
  decomposed: "Decomposed",
  revived: "Revived",
  blackened: "Blackened",
  redeemed: "Redeemed",
  transfer: "Transferred",
};

interface DatedEvent extends HistEvent {
  dateTime: string;
}

export function TokenView({
  data,
  dep,
  publicClient,
  address,
  tokenId,
  redeem,
  backLabel,
  onBack,
  onManage,
  onOpenToken,
}: {
  data: SiteData | null;
  dep: Deployment;
  publicClient: PublicClient | undefined;
  address: `0x${string}` | undefined;
  tokenId: bigint;
  redeem: RedeemState;
  backLabel: string;
  onBack: () => void;
  onManage: () => void;
  onOpenToken: (id: bigint) => void;
}) {
  const [history, setHistory] = React.useState<DatedEvent[] | null>(null);
  const [prov, setProv] = React.useState<ProvNode | null>(null);
  const [dnaExpanded, setDnaExpanded] = React.useState(false);
  const [dna, setDna] = React.useState<DnaResult | null>(null);
  // Drill-down stack for the DNA modal: each entry is one donor's own DNA, reached by clicking a
  // contributing donor (or split parent) card. Empty means the modal is closed. Loaded lazily and
  // cached in place, so navigating back up never refetches.
  const [drillStack, setDrillStack] = React.useState<DnaDrillLevel[]>([]);

  // Ancestry tree from the event log; shown only when the token has one beyond its own mint.
  React.useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    setProv(null);
    void loadProvenance(publicClient, dep, tokenId)
      .then((p) => {
        if (!cancelled) setProv(p);
      })
      .catch(() => {
        if (!cancelled) setProv(null);
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, dep, tokenId, data]);

  // The provenance tree, plus a lookup from tree key to the live token id it represents (only
  // live nodes navigate; everything else focuses in place). Rebuilt whenever the chain-derived
  // ancestry or the set of live tokens changes.
  const provTree = React.useMemo(() => {
    if (!prov) return null;
    const liveIds = new Map<string, bigint>();
    const root = provNodeToTree(prov, data?.tokens ?? [], "root", liveIds);
    return {root, liveIds};
  }, [prov, data?.tokens]);

  const [focusedKey, setFocusedKey] = React.useState<string>("root");
  const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    setFocusedKey("root");
    setExpandedKeys(provTree ? initialExpandedKeys(provTree.root) : new Set());
  }, [provTree]);

  const handleSelectProvNode = (key: string) => {
    const liveId = provTree?.liveIds.get(key);
    if (liveId != null) onOpenToken(liveId);
    else setFocusedKey(key);
  };
  const toggleProvExpanded = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Token history from the event log, with block timestamps resolved to dates.
  React.useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    setHistory(null);
    void (async () => {
      const events = await loadHistory(publicClient, dep, tokenId);
      const blocks = [...new Set(events.map((e) => e.block))];
      const stamps = new Map(
        await Promise.all(
          blocks.map(async (b) => {
            const blk = await publicClient.getBlock({blockNumber: b});
            const dateTime = new Intl.DateTimeFormat(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(Number(blk.timestamp) * 1000));
            return [b, dateTime] as const;
          }),
        ),
      );
      if (!cancelled) {
        setHistory(events.map((e) => ({...e, dateTime: stamps.get(e.block) ?? ""})).reverse());
      }
    })().catch(() => {
      if (!cancelled) setHistory([]);
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient, dep, tokenId, data]);

  // Per-cell provenance (DNA section): reconstructed from composeRecordAt/splitOriginOf, or
  // straight from the seed when the token has never been sampled. One read per token view.
  React.useEffect(() => {
    setDna(null);
    setDrillStack([]);
    if (!dnaExpanded || !publicClient) return;
    const t = data?.tokens.find((x) => x.id === tokenId);
    if (!t) return;
    let cancelled = false;
    void loadDna(publicClient, dep, tokenId)
      .then((r) => {
        if (!cancelled) setDna(r);
      })
      .catch(() => {
        if (!cancelled) setDna({kind: "unavailable", message: "DNA unavailable on this contract deployment."});
      });
    return () => {
      cancelled = true;
    };
  }, [dnaExpanded, publicClient, dep, tokenId, data]);

  React.useEffect(() => {
    setDnaExpanded(false);
  }, [tokenId]);

  // Fetch whichever drill-stack level is topmost and still unresolved. Every other level keeps
  // its already-loaded `dna`, so navigating back up (which only truncates the stack) never
  // refetches. A level with `subjectId === null` (a split parent, which has no on-chain id to
  // read further) is resolved synchronously at push time and never reaches this effect.
  React.useEffect(() => {
    if (!publicClient) return;
    const topIndex = drillStack.length - 1;
    if (topIndex < 0) return;
    const top = drillStack[topIndex];
    if (top.dna !== null || top.subjectId === null) return;
    let cancelled = false;
    const snapshot: DnaSnapshot = {
      id: top.subjectId,
      seed: top.snapshot.seed,
      denomIndex: top.snapshot.denomIndex,
      inkGene: top.snapshot.inkGene,
      modules: top.snapshot.modules,
    };
    const applyAt = (result: DnaResult) => {
      if (cancelled) return;
      setDrillStack((prev) => {
        if (prev.length !== topIndex + 1 || prev[topIndex] !== top) return prev; // navigated away meanwhile
        const next = [...prev];
        next[topIndex] = {...top, dna: result};
        return next;
      });
    };
    void loadDnaFromSnapshot(publicClient, dep, snapshot, top.depthOverride)
      .then(applyAt)
      .catch(() => applyAt({kind: "unavailable", message: "DNA unavailable on this contract deployment."}));
    return () => {
      cancelled = true;
    };
  }, [publicClient, dep, drillStack]);

  const token = data?.tokens.find((t) => t.id === tokenId) ?? null;
  const snap = redeem.status === "done" && redeem.snap?.id === tokenId ? redeem.snap : null;
  const owned = !!token && !!address && token.owner.toLowerCase() === address.toLowerCase();

  const back = (
    <div className="token-detail-back" style={{padding: "20px 48px", borderBottom: `1px solid ${C.rule}`, fontSize: 11, letterSpacing: "0.14em"}}>
      <button
        type="button"
        className="btn-ghost"
        onClick={onBack}
        style={{letterSpacing: "0.14em", fontSize: 11, color: C.muted}}
      >
        ← {backLabel}
      </button>
    </div>
  );

  // Redeemed in this session: the token is gone, but the closing state is still shown.
  if (!token && snap) {
    const lbl = DENOMINATIONS[snap.di].label;
    return (
      <main className="token-detail-page">
        {back}
        <Section title="SHAPE" pad="36px 48px 44px 32px">
          <div className="token-detail-hero" style={{display: "flex", flexWrap: "wrap", gap: 48, alignItems: "flex-start"}}>
            <Art src={localArt(snap.seed, DENOMINATIONS[snap.di].wei, snap.inkGene)} width={340} />
            <div style={{flex: "1 1 320px", minWidth: 0}}>
              <div style={{fontSize: 40, lineHeight: 1}}>{shapeTitle(snap.id)}</div>
              <div style={{marginTop: 20, fontFamily: SANS, fontSize: 14, lineHeight: 1.6}}>
                <div>
                  Redeemed. {DENOMINATIONS[snap.di].wei.toString()} wei ({lbl} ETH) sent to{" "}
                  {address ? short(address) : "the owner"}. The token is burned.
                </div>
                {redeem.tx && (
                  <a
                    href={txUrl(redeem.tx, dep.chainId)}
                    target="_blank"
                    rel="noreferrer"
                    style={{display: "inline-block", marginTop: 12, fontFamily: FONT, fontSize: 12, overflowWrap: "anywhere"}}
                  >
                    {redeem.tx.slice(0, 12)}… on evm.now
                  </a>
                )}
              </div>
            </div>
          </div>
        </Section>
        <History history={history} chainId={dep.chainId} />
      </main>
    );
  }

  // `data` is null while the site data is (re)loading; only a loaded set that lacks the id means
  // the token is gone.
  if (!token) {
    return (
      <main className="token-detail-page">
        {back}
        <Section title="SHAPE">
          <div style={{fontSize: 40, lineHeight: 1, marginBottom: 20}}>{shapeTitle(tokenId)}</div>
          <div style={{fontFamily: SANS, fontSize: 14, lineHeight: 1.6, color: C.bodyDim, maxWidth: "60ch"}}>
            {data
              ? `Shape ${tokenId.toString()} is no longer live. It was redeemed or recomposed. Its history is below.`
              : "Reading the chain…"}
          </div>
        </Section>
        <History history={history} chainId={dep.chainId} />
      </main>
    );
  }

  if (token.di < 0) {
    return (
      <main className="token-detail-page">
        {back}
        <Section title="BLACK SHAPE" pad="36px 48px 44px 32px">
          <div className="token-detail-hero" style={{display: "flex", flexWrap: "wrap", gap: 48, alignItems: "flex-start"}}>
            <Art src={token.image} alt={`Black Shape ${token.id}`} width={340} />
            <div style={{flex: "1 1 320px", minWidth: 0}}>
              <div style={{fontSize: 40, lineHeight: 1}}>{shapeTitle(token.id)}</div>
              <div style={{marginTop: 20, fontFamily: SANS, fontSize: 14, lineHeight: 1.6}}>
                #{token.id.toString()} has been sacrificed. It remains part of the collection, but
                has no redeemable ETH backing and cannot be split, composed, or redeemed.
              </div>
              <div style={{marginTop: 14, color: C.muted, fontSize: 11}}>owner · {short(token.owner)}</div>
            </div>
          </div>
        </Section>
        <History history={history} chainId={dep.chainId} />
      </main>
    );
  }

  const di = token.di;
  const lbl = DENOMINATIONS[di].label;

  const tokRows: {
    k: string;
    v: React.ReactNode;
    description?: string;
    size?: number;
    wrap?: "anywhere" | "normal";
  }[] = [
    {k: "owner", v: owned ? `${short(token.owner)} (you)` : short(token.owner), wrap: "anywhere"},
    ...(token.id === 0n
      ? [{
          k: "collection owner",
          v: "true",
          description: "Holding Shape 0 represents collection ownership and grants no administrative authority.",
          wrap: "anywhere" as const,
        }]
      : []),
    ...displayTraits(token.meta.attributes).map((trait) => ({
      k: trait.label,
      v: trait.value,
      description: trait.description,
      wrap: "anywhere" as const,
    })),
  ];

  return (
    <main className="token-detail-page">
      {back}

      <Section title="SHAPE" pad="36px 48px 44px 32px">
        <div className="token-detail-hero" style={{display: "flex", flexWrap: "wrap", gap: 48, alignItems: "flex-start"}}>
          <Art src={token.image} alt={`Shape ${token.id}`} width={340} />
          <div style={{flex: "1 1 320px", minWidth: 0}}>
            <div style={{fontSize: 40, lineHeight: 1}}>{shapeTitle(token.id)}</div>
            <div style={{marginTop: 16, fontSize: 18, lineHeight: 1.4, color: C.bodyDim}}>{lbl} ETH</div>
            <div style={{margin: "32px 0 0"}}>
              {tokRows.map((r) => (
                <div
                  key={r.k}
                  className="token-trait-row"
                  style={{
                    padding: "12px 0",
                    borderBottom: `1px solid ${C.ruleInner}`,
                  }}
                >
                  <div>
                    <div className="token-trait-label">{r.k}</div>
                    {r.description && (
                      <div className="token-trait-description">
                        {r.description}
                      </div>
                    )}
                  </div>
                  <div
                    className="token-trait-value"
                    style={{fontSize: r.size, overflowWrap: r.wrap ?? "normal"}}
                  >
                    {r.v}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {owned && (
        <Section title="MANAGE" pad="20px 48px 22px 32px">
          <button
            type="button"
            className="btn-filled"
            onClick={onManage}
            style={{padding: "10px 18px", letterSpacing: "0.06em"}}
          >
            MANAGE SHAPE
          </button>
        </Section>
      )}

      <History history={history} chainId={dep.chainId} />

      {prov && prov.contributors.length > 0 && provTree && (
        <Section title="PROVENANCE" pad="16px 48px 36px 32px">
          <ProvenanceTree
            root={provTree.root}
            focusedKey={focusedKey}
            onSelect={handleSelectProvNode}
            expandedKeys={expandedKeys}
            onToggleExpanded={toggleProvExpanded}
            resetKey={tokenId.toString()}
          />
        </Section>
      )}

      <DnaSection
        dna={dna}
        image={token.image}
        tokenId={token.id}
        expanded={dnaExpanded}
        onToggle={() => {
          setDnaExpanded((expanded) => !expanded);
          setDrillStack([]);
        }}
        onDrillDonor={(target) => {
          if (dna == null || (dna.kind !== "compose" && dna.kind !== "split")) return;
          const level = drillTargetToLevel(dna, tokenId, target);
          if (level) setDrillStack((prev) => [...prev, level]);
        }}
      />

      {drillStack.length > 0 && (
        <DnaDrillModal
          rootTokenId={tokenId}
          stack={drillStack}
          onNavigate={(depth) => setDrillStack((prev) => prev.slice(0, depth))}
          onPush={(level) => setDrillStack((prev) => [...prev, level])}
          onClose={() => setDrillStack([])}
        />
      )}

    </main>
  );
}

/// One relation word per non-root `ProvNode.rel`, as shown under a provenance card.
const PROV_RELATION_LABEL: Partial<Record<ProvNode["rel"], string>> = {
  merged: "merged",
  splitSource: "split parent",
  piece: "piece",
  self: "earlier state",
};

/// A rollup placeholder (`more` set) carries no real token: `id: 0n` is not a token reference.
function isProvenanceRollup(node: ProvNode): node is ProvNode & {more: number} {
  return typeof node.more === "number" && node.more > 0;
}

/**
 * `ProvNode` (chain/history.ts) to `TreeNode` (ProvenanceTree.tsx): each contributor becomes a
 * child one step further back in ancestry. `path` gives every node a key unique within the tree
 * even though a `self` chain repeats the same token id across levels. Live token ids are
 * collected into `liveIds` as they are found, keyed by the same path, so the caller can tell a
 * navigable card from one that only focuses in place.
 */
function provNodeToTree(node: ProvNode, live: SiteToken[], path: string, liveIds: Map<string, bigint>): TreeNode {
  if (isProvenanceRollup(node)) {
    return {key: path, art: "", title: "", lines: [], children: [], rollup: node.more};
  }
  if (live.some((t) => t.id === node.id)) liveIds.set(path, node.id);
  const relLabel = PROV_RELATION_LABEL[node.rel];
  const children =
    node.repeat || node.truncated ? [] : node.contributors.map((c, i) => provNodeToTree(c, live, `${path}-${i}`, liveIds));
  return {
    key: path,
    art: localArt(node.seed, DENOMINATIONS[node.di].wei, mintGene(node.seed, DENOMINATIONS[node.di].wei)),
    title: `#${node.id.toString()}`,
    lines: relLabel ? [`${DENOMINATIONS[node.di].label} ETH`, relLabel] : [`${DENOMINATIONS[node.di].label} ETH`],
    children,
    repeat: node.repeat,
    truncated: node.truncated,
    muted: node.repeat,
  };
}

function History({history, chainId}: {history: DatedEvent[] | null; chainId: number}) {
  return (
    <Section title="HISTORY" pad="16px 48px 24px 32px">
      {history === null ? (
        <div style={{fontSize: 13, color: C.muted, padding: "12px 0"}}>Reading the event log…</div>
      ) : history.length === 0 ? (
        <div style={{fontSize: 13, color: C.muted, padding: "12px 0"}}>No events.</div>
      ) : (
        history.map((h) => (
          <div
            key={h.key}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto",
              alignItems: "start",
              gap: "8px 32px",
              padding: "12px 0",
              borderBottom: `1px solid ${C.ruleInner}`,
              fontSize: 13,
            }}
          >
            <div style={{minWidth: 0}}>
              <div>{EVENT_LABEL[h.kind]}</div>
              <div style={{marginTop: 4, color: C.muted, lineHeight: 1.55}}>{h.text}</div>
            </div>
            <a
              href={txUrl(h.tx, chainId)}
              target="_blank"
              rel="noreferrer"
              style={{fontSize: 12, color: C.muted, whiteSpace: "nowrap"}}
            >
              {h.dateTime}
            </a>
          </div>
        ))
      )}
    </Section>
  );
}

function seedShort(seed: bigint): string {
  const hex = seed.toString(16).padStart(64, "0");
  return `0x${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

function DnaRow({k, v}: {k: string; v: React.ReactNode}) {
  return (
    <div style={{display: "flex", gap: 10, padding: "3px 0", fontSize: 12}}>
      <span style={{color: C.muted, width: 92, flexShrink: 0}}>{k}</span>
      <span style={{color: C.body, wordBreak: "break-all"}}>{v}</span>
    </div>
  );
}

/** One donor's rendered card: its snapshot state at compose/split time, reconstructed via the
 *  canonical sampler, plus which of its own module indices the result actually drew from. */
interface DonorRender {
  /** Canonical compose donor order (0 = survivor); always 0 for a split parent (one donor). */
  donorIndex: number;
  roleLabel: string;
  denomLabel: string;
  materialized: boolean;
  /** True when this donor's token no longer exists (every donor except the compose survivor). */
  burned: boolean;
  svg: string;
  geometry: CardGeometry;
}

/** Reconstruct one donor's own card from its compose/split-time snapshot: `effectiveModuleBytes`
 *  resolves materialized-vs-seed-derived exactly as the sampler does, `composeSampledShape` lays
 *  out the grid, `svgFromComposition` draws it. Never re-derives sampling; only renders its input. */
function renderDonor(seed: bigint, denomIndex: number, inkGene: number, modules: Uint8Array | undefined): {
  svg: string;
  geometry: CardGeometry;
} {
  const donor: SampleDonor = {seed, denomIndex, inkGene, modules};
  const bytes = effectiveModuleBytes(donor);
  const composition = composeSampledShape(bytes, denomIndex, inkGene);
  return {svg: svgFromComposition(composition, 0n, CANONICAL, false), geometry: geometryAt(denomIndex)};
}

function denomLabelAt(denomIndex: number): string {
  return DENOMINATIONS[denomIndex]?.label ?? "?";
}

/**
 * Contributing donors for a compose result: donors that at least one result cell was sampled
 * from, in canonical order. Bounded by the result's own cell count (max 25, the largest grid in
 * the collection), so a wide merge never renders one card per absorbed input.
 */
function contributingComposeDonors(donors: DnaDonor[], cells: DnaCell[], shapeLabel: string): DonorRender[] {
  const contributing = new Set(cells.map((c) => c.donorIndex ?? 0));
  return donors
    .map((d, i) => ({d, i}))
    .filter(({i}) => contributing.has(i))
    .map(({d, i}) => {
      const {svg, geometry} = renderDonor(d.seed, d.denomIndex, d.inkGene, d.modules);
      return {
        donorIndex: i,
        roleLabel: d.id === "survivor" ? shapeLabel : `#${d.id}`,
        denomLabel: denomLabelAt(d.denomIndex),
        materialized: d.materialized,
        burned: d.id !== "survivor",
        svg,
        geometry,
      };
    });
}

/**
 * The grammar-branch split pool as a donor card (SAMPLING_SPEC.md section 6, D3'): the parent
 * seed's expression at the CHILD's own denomination, which is always a full grid at that
 * denomination (the same reason a compose donor's own module count equals its own grid), so it
 * renders and highlights exactly like any other donor card. Only called when `dna.pool` is
 * present — the record branch's pool has no single grid shape (see `DnaSplitResult.pool`'s
 * doc comment) and is shown as pool index/byte in the detail panel instead, with no card.
 */
function splitPoolDonor(pool: NonNullable<DnaSplitResult["pool"]>): DonorRender {
  const {svg, geometry} = renderDonor(pool.seed, pool.denomIndex, pool.inkGene, pool.modules);
  return {
    donorIndex: 0,
    roleLabel: "sampling pool: the parent's seed expressed at this denomination",
    denomLabel: denomLabelAt(pool.denomIndex),
    materialized: true,
    burned: true,
    svg,
    geometry,
  };
}

/** One donor's card: rendered SVG, its own cell outlined when it is the active cell's source,
 *  and a caption. Hovering a cell reports it up; the caller decides which cell (if any) is
 *  "active" across every card and the result grid together. `onDrill`, when given, makes the
 *  whole card a button that opens this donor's own DNA. */
function DonorMiniCard({
  donor,
  color,
  activeCell,
  onEnterCell,
  onLeaveCell,
  onDrill,
}: {
  donor: DonorRender;
  color: string;
  activeCell: {donorIndex: number; moduleIndex: number} | null;
  onEnterCell: (moduleIndex: number) => void;
  onLeaveCell: () => void;
  onDrill?: () => void;
}) {
  const cellStyle = (j: number): React.CSSProperties | undefined => {
    const isActive = activeCell != null && activeCell.donorIndex === donor.donorIndex && activeCell.moduleIndex === j;
    if (!isActive) return undefined;
    return {outline: `2px solid ${color}`, outlineOffset: -1, background: `${color}33`};
  };
  const body = (
    <div style={{display: "flex", flexDirection: "column", gap: 6, width: 108}}>
      <div style={{position: "relative", aspectRatio: "250 / 350", backgroundColor: C.art}}>
        <div
          dangerouslySetInnerHTML={{__html: forDisplay(donor.svg)}}
          style={{position: "absolute", inset: 0}}
        />
        <GridOverlayCells
          cols={donor.geometry.cols}
          rows={donor.geometry.rows}
          cell={donor.geometry.cell}
          x0={donor.geometry.x0}
          y0={donor.geometry.y0}
          cellStyle={cellStyle}
          onEnter={onEnterCell}
          onLeave={onLeaveCell}
        />
      </div>
      <div style={{fontSize: 10.5, color: C.body, textAlign: "center", lineHeight: 1.4}}>{donor.roleLabel}</div>
      <div style={{fontSize: 9.5, color: C.muted, textAlign: "center"}}>
        {donor.denomLabel} ETH{donor.materialized ? " · materialized" : ""}
      </div>
      {donor.burned && (
        <div style={{fontSize: 9, color: C.faint, textAlign: "center", lineHeight: 1.4}}>
          burned, shown from its recorded snapshot
        </div>
      )}
    </div>
  );
  if (!onDrill) return body;
  return (
    <button type="button" className="btn-ghost" onClick={onDrill} style={{display: "block", textAlign: "left"}}>
      {body}
    </button>
  );
}

/** Which donor a click on a contributing donor (or split parent) card should drill into.
 *  "survivor" and "burn" apply only to a compose result; "splitParent" only to a split result. */
type DnaDrillTarget = {kind: "survivor"} | {kind: "burn"; id: string} | {kind: "splitParent"};

/**
 * Per-cell provenance: the artwork with a cell-overlay grid, tinted per donor (compose), tinted
 * uniformly for the single parent donor (split), or untinted with only the active cell outlined
 * (seed-derived). Pure rendering over an already-resolved `dna`; `resultArt` supplies the main
 * card's artwork (the page's own `tokenURI` image at the root, or a client-rendered SVG for a
 * drilled-into donor, which has no `tokenURI`). `onDrillDonor`, when given, makes every
 * contributing donor (or split parent) card open that donor's own DNA.
 */
function DnaProvenancePanel({
  dna,
  resultArt,
  shapeLabel,
  exportBase,
  onDrillDonor,
}: {
  dna: DnaComposeResult | DnaSplitResult | DnaSeedResult;
  resultArt: {type: "image"; src: string} | {type: "svg"; svg: string};
  shapeLabel: string;
  /** Trace download filename base (`traceExport.ts`'s `traceFilename` appends `-trace.<ext>`). */
  exportBase: string;
  onDrillDonor?: (target: DnaDrillTarget) => void;
}) {
  const {active, onEnter, onLeave, onClickCell} = useActiveCell();

  // Donor-card cell hover: independent of the result grid's hover/pin.
  const [donorHover, setDonorHover] = React.useState<{donorIndex: number; moduleIndex: number} | null>(null);

  // Reverse index built once per DNA record load: (donorIndex, moduleIndex) -> every result cell
  // drawn from it (compose), or moduleIndex -> every result cell (split, one donor). Hovering a
  // donor cell is then an O(1) lookup rather than a rescan of every result cell.
  const cellsByDonorKey = React.useMemo(() => {
    const map = new Map<string, number[]>();
    if (dna.kind !== "compose" && dna.kind !== "split") return map;
    dna.cells.forEach((c, j) => {
      const key = dna.kind === "compose" ? `${c.donorIndex ?? 0}:${c.moduleIndex}` : `${c.moduleIndex}`;
      const list = map.get(key);
      if (list) list.push(j);
      else map.set(key, [j]);
    });
    return map;
  }, [dna]);

  // Result cells to highlight: every cell sampled from the hovered donor cell, or (with no donor
  // cell hovered) the single hovered/pinned result cell.
  const highlightedResultCells = React.useMemo(() => {
    if (donorHover && (dna.kind === "compose" || dna.kind === "split")) {
      const key = dna.kind === "compose" ? `${donorHover.donorIndex}:${donorHover.moduleIndex}` : `${donorHover.moduleIndex}`;
      return new Set(cellsByDonorKey.get(key) ?? []);
    }
    return active != null ? new Set([active]) : new Set<number>();
  }, [donorHover, active, cellsByDonorKey, dna]);

  // Which donor cell to highlight on every donor card: the one directly hovered, or (derived)
  // the source cell of whichever result cell is hovered/pinned.
  const activeDonorCell = React.useMemo(() => {
    if (donorHover) return donorHover;
    if (active == null || (dna.kind !== "compose" && dna.kind !== "split")) return null;
    const c = dna.cells[active];
    return {donorIndex: dna.kind === "compose" ? c.donorIndex ?? 0 : 0, moduleIndex: c.moduleIndex};
  }, [donorHover, active, dna]);

  // Donor cards: reconstructed once per DNA record load (compose survivor + contributing burns,
  // or the split parent). Never recomputed on hover.
  const donorRenders = React.useMemo<DonorRender[]>(() => {
    if (dna.kind === "compose") return contributingComposeDonors(dna.donors, dna.cells, shapeLabel);
    // Split, record branch: the pool spans multiple donors concatenated with no single grid
    // shape, so there is no card to render here (SAMPLING_SPEC.md section 6, D3'). The cell
    // detail panel still shows each cell's pool index and byte.
    if (dna.kind === "split") return dna.pool ? [splitPoolDonor(dna.pool)] : [];
    return [];
  }, [dna, shapeLabel]);

  const drillFor = (d: DonorRender): (() => void) | undefined => {
    if (!onDrillDonor) return undefined;
    if (dna.kind === "split") return () => onDrillDonor({kind: "splitParent"});
    if (dna.kind !== "compose") return undefined;
    if (d.donorIndex === 0) return () => onDrillDonor({kind: "survivor"});
    const donor = dna.donors[d.donorIndex];
    return () => onDrillDonor({kind: "burn", id: donor.id});
  };

  const cellColor = (j: number): React.CSSProperties | undefined => {
    const isHighlighted = highlightedResultCells.has(j);
    if (dna.kind === "compose") {
      const c = donorColor(dna.cells[j].donorIndex ?? 0);
      return {
        background: `${c}4d`,
        outline: `${isHighlighted ? 2 : 1}px solid ${c}${isHighlighted ? "" : "55"}`,
        outlineOffset: -1,
      };
    }
    if (dna.kind === "split") {
      return {
        background: `${PROV_C.warn}4d`,
        outline: `${isHighlighted ? 2 : 1}px solid ${PROV_C.warn}${isHighlighted ? "" : "55"}`,
        outlineOffset: -1,
      };
    }
    if (!isHighlighted) return undefined;
    return {outline: `2px solid ${PROV_C.ink}`, outlineOffset: -1, background: `${PROV_C.ink}22`};
  };

  // Every cell's color at rest (no hover state), for the trace download: matches `cellColor`'s
  // non-highlighted fill exactly, computed by `traceExport.ts`'s `buildTraceSvg`.
  const exportColor = (j: number): string | undefined => {
    if (dna.kind === "compose") return donorColor(dna.cells[j].donorIndex ?? 0);
    if (dna.kind === "split") return PROV_C.warn;
    return undefined;
  };
  const artworkSvg = resultArt.type === "svg" ? resultArt.svg : svgFromDataUri(resultArt.src);

  const cell = active != null ? dna.cells[active] : null;
  // "Absorbed" counts burns only, not the survivor snapshot (donorIndex 0). Named counts on both
  // sides of the fraction so the line cannot be misread as "none of every donor" (it read that
  // way with just a bare hidden count).
  const absorbedCount = dna.kind === "compose" ? dna.donors.length - 1 : 0;
  const absorbedWithNoCell =
    dna.kind === "compose" ? absorbedCount - donorRenders.filter((d) => d.donorIndex !== 0).length : 0;

  return (
    <>
      <p style={{margin: "0 0 24px", fontFamily: SANS, fontSize: 14, lineHeight: 1.6, color: C.muted, maxWidth: "60ch"}}>
        {dna.kind === "seed"
          ? dna.materialized
            ? "Recorded module bytes with no token id of its own, so its provenance cannot be traced any further. Hover a cell for its detail."
            : "Every cell's module derives directly from this Shape's own seed under grammar v1. Hover a cell for its detail."
          : dna.kind === "compose"
            ? "Every cell was sampled from this Shape's own prior state or one of the Shapes it absorbed. Hover a cell for its source, or hover a donor's card below to see where its modules ended up."
            : dna.branch === "grammar"
              ? "Every cell was sampled from the parent seed's expression at this denomination. Hover a cell for its source module, or hover the pool card below."
              : "Every cell was sampled from the parent's compose record: its pre-compose modules plus the modules of what it had absorbed. Hover a cell for its pool index and byte."}
      </p>
      <div style={{display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start"}}>
        <div style={{display: "flex", flexDirection: "column", gap: 8}}>
          <div style={{position: "relative", width: 220, aspectRatio: "250 / 350", backgroundColor: C.art}}>
            {resultArt.type === "image" ? (
              <img
                src={resultArt.src}
                alt=""
                style={{display: "block", width: "100%", height: "100%", objectFit: "cover"}}
              />
            ) : (
              <div
                dangerouslySetInnerHTML={{__html: forDisplay(resultArt.svg)}}
                style={{position: "absolute", inset: 0}}
              />
            )}
            <GridOverlayCells
              cols={dna.geometry.cols}
              rows={dna.geometry.rows}
              cell={dna.geometry.cell}
              x0={dna.geometry.x0}
              y0={dna.geometry.y0}
              cellStyle={cellColor}
              onEnter={(j) => {
                setDonorHover(null);
                onEnter(j);
              }}
              onLeave={onLeave}
              onClickCell={onClickCell}
            />
          </div>
          <div style={{display: "flex", gap: 8}}>
            <button
              type="button"
              className="btn-outline"
              style={{padding: "6px 12px", fontSize: 11}}
              onClick={() => downloadTracePng(artworkSvg, dna.geometry, exportColor, exportBase)}
            >
              PNG
            </button>
            <button
              type="button"
              className="btn-outline"
              style={{padding: "6px 12px", fontSize: 11}}
              onClick={() => downloadTraceSvg(artworkSvg, dna.geometry, exportColor, exportBase)}
            >
              SVG
            </button>
          </div>
        </div>
        <div style={{flex: "1 1 260px", minWidth: 240, display: "flex", flexDirection: "column", gap: 20}}>
          {dna.kind === "compose" && (
            <div>
              <div style={{...label, marginBottom: 10}}>donors</div>
              <div style={{display: "flex", flexWrap: "wrap", gap: 14}}>
                {donorRenders.map((d) => (
                  <div key={d.donorIndex} style={{display: "flex", alignItems: "center", gap: 8}}>
                    <span style={{width: 10, height: 10, background: donorColor(d.donorIndex), flexShrink: 0}} />
                    <span style={{fontSize: 12, color: C.body}}>
                      {d.roleLabel}
                      {d.materialized ? " · materialized" : ""}
                    </span>
                  </div>
                ))}
                {absorbedWithNoCell > 0 && (
                  <span style={{fontSize: 12, color: C.muted}}>
                    + {absorbedWithNoCell} of the {absorbedCount} absorbed supplied no cell
                  </span>
                )}
              </div>
            </div>
          )}
          {dna.kind === "split" && (
            <div>
              <div style={{...label, marginBottom: 10}}>parent</div>
              <DnaRow k="seed" v={seedShort(dna.parent.seed)} />
              <DnaRow k="denomination" v={`${DENOMINATIONS[dna.parent.denomIndex]?.label ?? "?"} ETH`} />
              <DnaRow k="materialized" v={dna.parent.materialized ? "yes" : "no (seed-derived)"} />
              <DnaRow
                k="sampled from"
                v={
                  dna.branch === "grammar"
                    ? "parent seed's expression at this denomination"
                    : `${dna.poolLength} modules across the parent's compose record`
                }
              />
            </div>
          )}
          {dna.kind === "seed" && (
            <div style={{fontSize: 12, color: C.muted}}>
              {dna.materialized ? "recorded snapshot, no further provenance" : "seed-derived (grammar v1)"}
            </div>
          )}
          {cell ? (
            dna.kind === "compose" ? (
              <DetailPanel
                label={cell.donorId === "survivor" ? shapeLabel : `#${cell.donorId}`}
                moduleIndex={cell.moduleIndex}
                byte={cell.byte}
                color={donorColor(cell.donorIndex ?? 0)}
              />
            ) : dna.kind === "split" ? (
              <DetailPanel
                label={
                  dna.branch === "grammar"
                    ? `parent seed at ${denomLabelAt(dna.parent.denomIndex)} ETH`
                    : "parent's compose record pool"
                }
                moduleIndex={cell.moduleIndex}
                byte={cell.byte}
                color={PROV_C.warn}
              />
            ) : (
              <DetailPanel label={`module #${cell.moduleIndex}`} moduleIndex={cell.moduleIndex} byte={cell.byte} />
            )
          ) : (
            <div style={{fontSize: 12, color: C.muted}}>Hover or tap a cell for its detail.</div>
          )}
          {(dna.kind === "compose" || dna.kind === "split") && (
            <div style={{fontSize: 11, color: C.faint, overflowWrap: "anywhere", lineHeight: 1.6}}>
              stored modules: {moduleBytesToHex(dna.bytes)}
            </div>
          )}
        </div>
      </div>
      {(dna.kind === "compose" || dna.kind === "split") && donorRenders.length > 0 && (
        <div style={{marginTop: 28}}>
          <div style={{...label, marginBottom: 8}}>{dna.kind === "compose" ? "contributing donors" : "sampling pool"}</div>
          {onDrillDonor && (
            <div style={{fontSize: 11, color: C.faint, marginBottom: 12}}>click a donor to see its own dna</div>
          )}
          <div style={{display: "flex", flexWrap: "wrap", gap: 18}}>
            {donorRenders.map((d) => (
              <DonorMiniCard
                key={d.donorIndex}
                donor={d}
                color={dna.kind === "compose" ? donorColor(d.donorIndex) : PROV_C.warn}
                activeCell={activeDonorCell}
                onEnterCell={(moduleIndex) => setDonorHover({donorIndex: d.donorIndex, moduleIndex})}
                onLeaveCell={() => setDonorHover(null)}
                onDrill={drillFor(d)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Loading/unavailable/mismatch text, or the resolved panel. Shared by the page's own DNA
 *  section and every drilled-into level in the modal. */
function DnaStateBody({
  dna,
  resultArt,
  shapeLabel,
  exportBase,
  onDrillDonor,
}: {
  dna: DnaResult | null;
  resultArt: {type: "image"; src: string} | {type: "svg"; svg: string};
  shapeLabel: string;
  exportBase: string;
  onDrillDonor?: (target: DnaDrillTarget) => void;
}) {
  if (dna === null) {
    return <div style={{fontSize: 13, color: C.muted, padding: "12px 0"}}>Reading token contract…</div>;
  }
  if (dna.kind === "unavailable" || dna.kind === "mismatch") {
    return <div style={{fontSize: 13, color: C.muted, lineHeight: 1.7, maxWidth: "60ch"}}>{dna.message}</div>;
  }
  return (
    <DnaProvenancePanel
      dna={dna}
      resultArt={resultArt}
      shapeLabel={shapeLabel}
      exportBase={exportBase}
      onDrillDonor={onDrillDonor}
    />
  );
}

/** The page's own DNA section: the live token's `tokenURI` image as the result card, wrapped in
 *  the page's label-column `Section`. Reads lazily on token change (see the `loadDna` effect in
 *  `TokenView`); this component is pure rendering over whatever state that effect has produced. */
function DnaSection({
  dna,
  image,
  tokenId,
  expanded,
  onToggle,
  onDrillDonor,
}: {
  dna: DnaResult | null;
  image: string;
  tokenId: bigint;
  expanded: boolean;
  onToggle: () => void;
  onDrillDonor: (target: DnaDrillTarget) => void;
}) {
  const bodyId = React.useId();
  return (
    <Section title="DNA" pad={expanded ? "18px 48px 36px 32px" : "18px 48px 20px 32px"}>
      <button
        type="button"
        className="btn-ghost"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        style={{display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 24, textAlign: "left"}}
      >
        <span style={{fontSize: 12, color: C.body}}>Trace every module to its source.</span>
        <span style={{fontSize: 18, color: C.muted, lineHeight: 1}} aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>
      {expanded && (
        <div id={bodyId} style={{marginTop: 26}}>
          <DnaStateBody
            dna={dna}
            resultArt={{type: "image", src: image}}
            shapeLabel={`#${tokenId.toString()} (this Shape)`}
            exportBase={`shape-${tokenId.toString()}`}
            onDrillDonor={onDrillDonor}
          />
        </div>
      )}
    </Section>
  );
}

/**
 * One level of the DNA drill-down stack: a contributing donor's (or split parent's) own DNA,
 * reached by clicking its card. `subjectId` is the donor's own token id, needed to read its
 * provenance further — absent for a split parent, since `splitOriginOf` records the parent's
 * seed/denomination/ink/modules but never its token id, making a split-parent card the
 * recursion's dead end regardless of what its own snapshot turns out to be. `depthOverride` is
 * set only when drilling into a compose survivor (see `DnaComposeResult.survivorDepth`); every
 * other level lets `loadDnaFromSnapshot` read the donor's own live `composeDepth`. `art` is
 * rendered once at push time from the snapshot alone, so it never waits on `dna` to resolve.
 */
interface DnaDrillLevel {
  label: string;
  subjectId: bigint | null;
  depthOverride: number | undefined;
  snapshot: {seed: bigint; denomIndex: number; inkGene: number; modules: Uint8Array};
  art: {svg: string; geometry: CardGeometry};
  dna: DnaResult | null;
}

/** Build the next drill-down level from a click on `parentDna`'s donor/parent card. Returns null
 *  when the target does not apply to `parentDna`'s kind (should not happen: `DnaProvenancePanel`
 *  only ever fires `"splitParent"` for a split result and `"survivor"`/`"burn"` for a compose
 *  one) or when a named burn donor cannot be found. A split parent resolves synchronously via
 *  `deriveSeedDna` (no chain read: it has no token id to read further); every other target starts
 *  `dna: null`, picked up by `TokenView`'s drill-stack fetch effect. */
function drillTargetToLevel(
  parentDna: DnaComposeResult | DnaSplitResult,
  parentSubjectId: bigint,
  target: DnaDrillTarget,
): DnaDrillLevel | null {
  if (target.kind === "splitParent") {
    if (parentDna.kind !== "split") return null;
    const p = parentDna.parent;
    const modules = p.modules ?? new Uint8Array();
    const art = renderDonor(p.seed, p.denomIndex, p.inkGene, p.modules);
    return {
      label: "before the split",
      subjectId: null,
      depthOverride: undefined,
      snapshot: {seed: p.seed, denomIndex: p.denomIndex, inkGene: p.inkGene, modules},
      art,
      dna: deriveSeedDna({seed: p.seed, denomIndex: p.denomIndex, inkGene: p.inkGene, modules}),
    };
  }
  if (parentDna.kind !== "compose") return null;
  if (target.kind === "survivor") {
    const donor = parentDna.donors[0];
    const modules = donor.modules ?? new Uint8Array();
    return {
      label: `#${parentSubjectId.toString()} (earlier state)`,
      subjectId: parentSubjectId,
      depthOverride: parentDna.survivorDepth,
      snapshot: {seed: donor.seed, denomIndex: donor.denomIndex, inkGene: donor.inkGene, modules},
      art: renderDonor(donor.seed, donor.denomIndex, donor.inkGene, donor.modules),
      dna: null,
    };
  }
  const donor = parentDna.donors.find((d) => d.id === target.id);
  if (!donor) return null;
  const modules = donor.modules ?? new Uint8Array();
  return {
    label: `#${target.id}`,
    subjectId: BigInt(target.id),
    depthOverride: undefined,
    snapshot: {seed: donor.seed, denomIndex: donor.denomIndex, inkGene: donor.inkGene, modules},
    art: renderDonor(donor.seed, donor.denomIndex, donor.inkGene, donor.modules),
    dna: null,
  };
}

/**
 * The DNA drill-down modal: a breadcrumb ("#16692 › #16692 (earlier state) › #16716") over the
 * topmost stack level's own DNA panel. Clicking the root chip closes the modal; clicking any
 * other breadcrumb entry truncates the stack back to it (cached levels below it are kept, never
 * refetched). Clicking a donor card inside the topmost level's panel builds and pushes the next
 * level via `drillTargetToLevel`.
 */
function DnaDrillModal({
  rootTokenId,
  stack,
  onNavigate,
  onPush,
  onClose,
}: {
  rootTokenId: bigint;
  stack: DnaDrillLevel[];
  onNavigate: (depth: number) => void;
  onPush: (level: DnaDrillLevel) => void;
  onClose: () => void;
}) {
  const top = stack[stack.length - 1];

  const onDrillDonor = (target: DnaDrillTarget) => {
    if (!top.dna || (top.dna.kind !== "compose" && top.dna.kind !== "split")) return;
    if (top.subjectId === null) return; // a leaf (split-parent) result never has donors to click
    const level = drillTargetToLevel(top.dna, top.subjectId, target);
    if (level) onPush(level);
  };

  return (
    <Modal title="DNA" onCancel={onClose} maxWidth="min(92vw, 760px)">
      <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 20}}>
        <button
          type="button"
          className="btn-ghost"
          onClick={onClose}
          style={{fontSize: 11, letterSpacing: "0.06em", color: C.muted}}
        >
          #{rootTokenId.toString()}
        </button>
        {stack.map((lvl, i) => (
          <React.Fragment key={i}>
            <span style={{fontSize: 11, color: C.faint}}>›</span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onNavigate(i + 1)}
              style={{
                fontSize: 11,
                letterSpacing: "0.06em",
                color: i === stack.length - 1 ? C.body : C.muted,
              }}
            >
              {lvl.label}
            </button>
          </React.Fragment>
        ))}
      </div>
      <DnaStateBody
        dna={top.dna}
        resultArt={{type: "svg", svg: top.art.svg}}
        shapeLabel={`${top.subjectId === null ? top.label : `#${top.subjectId.toString()}`} (this Shape)`}
        exportBase={
          top.subjectId !== null
            ? `shape-${top.subjectId.toString()}`
            : `shape-${top.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
        }
        onDrillDonor={onDrillDonor}
      />
    </Modal>
  );
}
