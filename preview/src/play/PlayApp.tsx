import React from "react";
import { C, FONT, SANS } from "../site/theme";
import { forDisplay, C as PROV_C } from "../app/ui";
import { donorColor, GridOverlayCells, useActiveCell, DetailPanel } from "../app/provenance";
import { CANONICAL } from "../canonical/params";
import { composeShape, svgFromComposition } from "../canonical/render";
import { composeSampledShape, grammarSplitPoolBytes } from "../canonical/sampling";
import { DENOMINATIONS, GRIDS, unitsAt } from "../canonical/denominations";
// The playground presents mainnet values even when the adjacent app is built for Sepolia. The
// denomination indexes, grids, and composition ratios are identical between both ladders.
import { LABELS } from "../canonical/ladders/mainnet";
import { geneAtMint } from "../canonical/ink";
import {
  buildCompleteShape,
  decomposeNode,
  emptySession,
  liveNodes,
  nodeComposition,
  randomSeed,
  removeNode,
  burnBackingNode,
  splitNode,
  type PlayNode,
  type PlaySession,
} from "./session";
import { decodeSession, encodeSession, sessionShareable } from "./urlCodec";
import { ProvenanceTree, initialExpandedKeys, type TreeNode } from "../site/ProvenanceTree";
import { exportFilename } from "./exports";
import { downloadTracePng, downloadTraceSvg } from "../app/traceExport";

/** Split's single-donor highlight color, matching provenance.tsx's convention for split
 *  provenance (`cellStyleAt`/`cellDetailAt`): one warn-color highlight, no per-donor tints. */
const SPLIT_COLOR = PROV_C.warn;

/**
 * The Playground (`/play`): a chain-free demo of the two ideas the collection is built on —
 * value controls density, and compose is visible cell-by-cell inheritance. Draw a card, keep it,
 * compose kept cards, trace the result's cells to their parents. No wallet, no RPC, no fetch;
 * every card comes from the canonical renderer/sampler in `../canonical` over local session
 * state (`./session`).
 */

const mono: React.CSSProperties = { fontFamily: FONT };
const sans: React.CSSProperties = { fontFamily: SANS };
const labelStyle: React.CSSProperties = {
  ...mono,
  fontSize: 10,
  letterSpacing: "0.14em",
  color: C.muted,
};

const REPO_URL = "https://github.com/ripe0x/shapes";
const MAX_TRAY_CARDS = 100;

function seedHex(seed: bigint): string {
  return "0x" + seed.toString(16).padStart(64, "0");
}

/* ------------------------------------------------------------------ *
 * Small building blocks
 * ------------------------------------------------------------------ */

function PlayButton({
  onClick,
  children,
  active,
  disabled,
  small,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...mono,
        fontSize: small ? 9.5 : 10.5,
        letterSpacing: "0.06em",
        padding: small ? "6px 9px" : "9px 13px",
        border: `1px solid ${active ? C.ink : C.border}`,
        background: active ? C.ink : "transparent",
        color: disabled ? C.faint : active ? C.page : C.ink,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** A rendered card, always exactly 2.5:3.5. */
function RawCard({
  svg,
  width,
  caption,
  onClick,
  selected,
}: {
  svg: string;
  width: number | string;
  caption?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width }}>
      <div
        data-play-card={onClick ? "interactive" : undefined}
        onClick={onClick}
        style={{
          position: "relative",
          aspectRatio: "2.5 / 3.5",
          background: C.art,
          overflow: "hidden",
          lineHeight: 0,
          cursor: onClick ? "pointer" : "default",
          outline: selected ? `3px solid ${C.page}` : `1px solid ${C.border}`,
          outlineOffset: selected ? -3 : -1,
          boxShadow: selected ? `0 0 0 2px ${C.ink}` : "none",
          borderRadius: 3,
        }}
        dangerouslySetInnerHTML={{ __html: forDisplay(svg) }}
      />
      {caption !== undefined && (
        <div style={{ ...mono, fontSize: 9.5, letterSpacing: "0.04em", color: C.muted, textAlign: "center" }}>
          {caption}
        </div>
      )}
    </div>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return <p style={{ ...sans, fontSize: 14, lineHeight: 1.55, color: C.body, margin: 0 }}>{children}</p>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ ...labelStyle, textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}

/* ------------------------------------------------------------------ *
 * Beat 1 — draw
 * ------------------------------------------------------------------ */

function DrawBeat({
  denomIndex,
  onDenomIndex,
  onRoll,
  effectiveSeed,
  onComplete,
  completeBusy,
}: {
  denomIndex: number;
  onDenomIndex: (i: number) => void;
  onRoll: () => void;
  effectiveSeed: bigint;
  onComplete: () => void;
  completeBusy: boolean;
}) {
  const amountWei = DENOMINATIONS[denomIndex];
  // The gene a tray card of this seed/denomination would get (session.keepCard uses the same call).
  const composition = React.useMemo(
    () => composeShape(effectiveSeed, amountWei, geneAtMint(effectiveSeed, denomIndex), CANONICAL),
    [effectiveSeed, amountWei, denomIndex],
  );

  const svg = React.useMemo(() => svgFromComposition(composition, 0n, CANONICAL, false), [composition]);

  return (
    <section className="play-section play-draw-section">
      <SectionLabel>Generator</SectionLabel>
      <div className="play-draw-grid">
        <div className="play-draw-card">
          <RawCard svg={svg} width="100%" />
          <div className="play-seed">
            {seedHex(effectiveSeed)}
          </div>
        </div>

        <div className="play-draw-controls">
          <div className="play-control-group">
            <div className="play-control-label">Denomination</div>
            <div className="play-tier-grid">
              {LABELS.map((lab, i) => (
                <PlayButton key={i} active={denomIndex === i} onClick={() => onDenomIndex(i)}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <span>{GRIDS[i][0]}×{GRIDS[i][1]}</span>
                    <span style={{ fontSize: 9, opacity: 0.75 }}>{lab} ETH</span>
                  </div>
                </PlayButton>
              ))}
            </div>
          </div>

          <div className="play-action-row">
            <div className="play-action-group">
              <PlayButton onClick={onRoll}>Roll</PlayButton>
              <PlayButton onClick={onComplete} disabled={completeBusy}>
                {completeBusy ? "Generating…" : "Generate"}
              </PlayButton>
            </div>
          </div>

          <p className="play-note">Generate builds this denomination from independent origins and reveals its full provenance.</p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 2 — tray
 * ------------------------------------------------------------------ */

/** Which card's inline tray menu is open, and which kind (the split tier picker or the
 *  burn-backing confirmation). Only one card's menu is open at a time. */
type TrayMenu = { key: number; kind: "split" | "burnBacking" } | null;

/** The one-row split tier picker: one button per denomination below the card, labeled with its
 *  child count. */
function SplitPicker({
  node,
  session,
  onSplit,
  onCancel,
}: {
  node: PlayNode;
  session: PlaySession;
  onSplit: (childDenomIndex: number) => void;
  onCancel: () => void;
}) {
  const options = React.useMemo(() => {
    const liveCount = liveNodes(session).length;
    const opts: { i: number; count: number; fits: boolean }[] = [];
    for (let i = 0; i < node.denomIndex; i++) {
      const count = Number(unitsAt(node.denomIndex) / unitsAt(i));
      opts.push({ i, count, fits: liveCount - 1 + count <= MAX_TRAY_CARDS });
    }
    return opts;
  }, [node, session]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6, width: 180 }}>
      <Prose>Backing divides exactly. Every child cell samples from the parent.</Prose>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {options.map(({ i, count, fits }) => (
          <PlayButton key={i} small disabled={!fits} onClick={() => onSplit(i)}>
            {LABELS[i]} ×{count}
          </PlayButton>
        ))}
      </div>
      {options.some((option) => !option.fits) && (
        <div style={{ ...mono, fontSize: 10, color: C.muted }}>
          Large splits are limited to keep the tray usable.
        </div>
      )}
      <PlayButton small onClick={onCancel}>
        Cancel
      </PlayButton>
    </div>
  );
}

function BurnBackingConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, width: 200 }}>
      <Prose>
        Burning backing sends the Shape&apos;s 100 ETH to an address no one can spend from. The card
        stays, black. On chain this requires a complete 100 ETH Shape: 10,000 independent origins.
      </Prose>
      <div style={{ display: "flex", gap: 6 }}>
        <PlayButton small onClick={onConfirm}>
          Burn backing
        </PlayButton>
        <PlayButton small onClick={onCancel}>
          Cancel
        </PlayButton>
      </div>
    </div>
  );
}

function TrayCard({
  node,
  session,
  selected,
  menu,
  onOpenMenu,
  onSplit,
  onDecompose,
  onBurnBacking,
}: {
  node: PlayNode;
  session: PlaySession;
  selected: boolean;
  menu: TrayMenu;
  onToggle: (key: number) => void;
  onRemove: (key: number) => void;
  onOpenMenu: (menu: TrayMenu) => void;
  onSplit: (key: number, childDenomIndex: number) => void;
  onDecompose: (key: number) => void;
  onBurnBacking: (key: number) => void;
}) {
  const svg = svgFromComposition(nodeComposition(node), 0n, CANONICAL, node.black === true);
  const isTop = node.denomIndex === DENOMINATIONS.length - 1;
  const showDecompose = node.trace != null && !node.black;
  const menuOpen = menu?.key === node.key ? menu.kind : null;

  return (
    <div style={{ position: "relative", width: 128 }}>
      <RawCard
        svg={svg}
        width="100%"
        selected={selected}
        caption={
          node.black
            ? `#${node.demoId} · Black`
            : `#${node.demoId} · ${LABELS[node.denomIndex]} ETH`
        }
      />
      {!node.black && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {node.denomIndex > 0 && (
            <PlayButton small onClick={() => onOpenMenu(menuOpen === "split" ? null : { key: node.key, kind: "split" })}>
              Split
            </PlayButton>
          )}
          {showDecompose && (
            <PlayButton small onClick={() => onDecompose(node.key)}>
              Decompose
            </PlayButton>
          )}
          {isTop && (
            <PlayButton
              small
              onClick={() => onOpenMenu(menuOpen === "burnBacking" ? null : { key: node.key, kind: "burnBacking" })}
            >
              Burn backing
            </PlayButton>
          )}
        </div>
      )}
      {menuOpen === "split" && (
        <SplitPicker
          node={node}
          session={session}
          onSplit={(childDenomIndex) => onSplit(node.key, childDenomIndex)}
          onCancel={() => onOpenMenu(null)}
        />
      )}
      {menuOpen === "burnBacking" && (
        <BurnBackingConfirm onConfirm={() => onBurnBacking(node.key)} onCancel={() => onOpenMenu(null)} />
      )}
    </div>
  );
}

function TrayBeat({
  nodes,
  session,
  selected,
  menu,
  onToggle,
  onRemove,
  onOpenMenu,
  onSplit,
  onDecompose,
  onBurnBacking,
}: {
  nodes: PlayNode[];
  session: PlaySession;
  selected: Set<number>;
  menu: TrayMenu;
  onToggle: (key: number) => void;
  onRemove: (key: number) => void;
  onOpenMenu: (menu: TrayMenu) => void;
  onSplit: (key: number, childDenomIndex: number) => void;
  onDecompose: (key: number) => void;
  onBurnBacking: (key: number) => void;
}) {
  return (
    <section className="play-section">
      <SectionLabel>{nodes.length === 1 ? "Generated Shape" : `Generated Shapes (${nodes.length})`}</SectionLabel>
      {nodes.length === 0 ? (
        <p className="play-empty">Add a card to begin.</p>
      ) : (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
          {nodes.map((n) => (
            <TrayCard
              key={n.key}
              node={n}
              session={session}
              selected={selected.has(n.key)}
              menu={menu}
              onToggle={onToggle}
              onRemove={onRemove}
              onOpenMenu={onOpenMenu}
              onSplit={onSplit}
              onDecompose={onDecompose}
              onBurnBacking={onBurnBacking}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 4 — lineage
 * ------------------------------------------------------------------ */

/** A session node's rendered card as a data URI, so `ProvenanceTree` can draw it as a plain img
 *  regardless of host. Only `#demoId` is shown once a card gets small enough to read it. */
function playCardArt(node: PlayNode): string {
  const svg = svgFromComposition(nodeComposition(node), 0n, CANONICAL, node.black === true);
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** `PlayNode` (session.ts) to `TreeNode` (site/ProvenanceTree.tsx): a node's parents become its
 *  ancestry children. Only a composed or split node is selectable — drawn cards carry no trace
 *  to inspect. */
function playNodeToTree(node: PlayNode, byKey: Map<number, PlayNode>): TreeNode {
  const parents = (node.parents ?? []).map((k) => byKey.get(k)).filter((n): n is PlayNode => n != null);
  return {
    key: String(node.key),
    art: playCardArt(node),
    title: `#${node.demoId}`,
    lines: [],
    children: parents.map((parent) => playNodeToTree(parent, byKey)),
    selectable: node.trace != null || node.splitTrace != null,
  };
}

/** Trace export filename base for a node: `exportFilename`'s own card-name convention (seed,
 *  denomination), minus its `.png` extension, so both trace downloads can append `-trace.<ext>`. */
function traceExportBase(node: PlayNode): string {
  return exportFilename("card", node.seed, LABELS[node.denomIndex]).replace(/\.png$/, "");
}

function CellExplorer({ node, byKey }: { node: PlayNode; byKey: Map<number, PlayNode> }) {
  const composition = nodeComposition(node);
  const svg = React.useMemo(
    () => svgFromComposition(composition, 0n, CANONICAL, node.black === true),
    [composition, node.black],
  );
  const trace = node.trace!;
  const donorNodes = (node.parents ?? []).map((k) => byKey.get(k)!);
  const donorLabels = donorNodes.map((n) => `#${n.demoId}`);

  const { active, onEnter, onLeave, onClickCell } = useActiveCell();
  const [hoverDonorCell, setHoverDonorCell] = React.useState<{ donorIndex: number; moduleIndex: number } | null>(
    null,
  );

  const resultCellsByDonorCell = React.useMemo(() => {
    const map = new Map<string, number[]>();
    trace.forEach((cell, j) => {
      const key = `${cell.donorIndex}:${cell.moduleIndex}`;
      const list = map.get(key) ?? [];
      list.push(j);
      map.set(key, list);
    });
    return map;
  }, [trace]);

  const highlighted = React.useMemo(() => {
    if (hoverDonorCell) {
      return new Set(resultCellsByDonorCell.get(`${hoverDonorCell.donorIndex}:${hoverDonorCell.moduleIndex}`) ?? []);
    }
    if (active != null) return new Set([active]);
    return new Set<number>();
  }, [hoverDonorCell, active, resultCellsByDonorCell]);

  const activeCell = active != null ? trace[active] : null;

  return (
    <div className="play-inspector-body">
      <div className="play-inspector-result">
        <div
          style={{
            position: "relative",
            aspectRatio: "2.5 / 3.5",
            background: C.art,
            overflow: "hidden",
            lineHeight: 0,
            border: `1px solid ${C.border}`,
          }}
        >
          <div dangerouslySetInnerHTML={{ __html: forDisplay(svg) }} />
          <GridOverlayCells
            cols={composition.cols}
            rows={composition.rows}
            cell={composition.cell}
            x0={composition.x0}
            y0={composition.y0}
            cellStyle={(j) => {
              const c = donorColor(trace[j].donorIndex);
              const isHighlighted = highlighted.has(j);
              return {
                background: `${c}4d`,
                outline: `${isHighlighted ? 2 : 1}px solid ${c}${isHighlighted ? "" : "55"}`,
                outlineOffset: -1,
              };
            }}
            onEnter={(j) => {
              setHoverDonorCell(null);
              onEnter(j);
            }}
            onLeave={onLeave}
            onClickCell={onClickCell}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn-outline"
            style={{ padding: "6px 12px", fontSize: 11 }}
            onClick={() =>
              downloadTracePng(svg, composition, (j) => donorColor(trace[j].donorIndex), traceExportBase(node))
            }
          >
            PNG
          </button>
          <button
            type="button"
            className="btn-outline"
            style={{ padding: "6px 12px", fontSize: 11 }}
            onClick={() =>
              downloadTraceSvg(svg, composition, (j) => donorColor(trace[j].donorIndex), traceExportBase(node))
            }
          >
            SVG
          </button>
        </div>
      </div>

      <div className="play-inspector-meta">
        <div className="play-inspector-subhead">Cell sources</div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {donorLabels.map((lab, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, background: donorColor(i) }} />
              <span style={{ ...mono, fontSize: 10.5, color: C.body }}>{lab}</span>
            </div>
          ))}
        </div>
        {activeCell && (
          <DetailPanel
            label={donorLabels[activeCell.donorIndex] ?? activeCell.donorId}
            moduleIndex={activeCell.moduleIndex}
            byte={activeCell.byte}
            color={donorColor(activeCell.donorIndex)}
          />
        )}
      </div>

      <div className="play-inspector-sources">
        <div className="play-inspector-subhead">Source Shapes</div>
        <div className="play-source-cards">
          {donorNodes.map((d, i) => {
          const dc = nodeComposition(d);
          const dsvg = svgFromComposition(dc, 0n, CANONICAL, d.black === true);
          return (
            <div key={d.key} style={{ width: 120 }}>
              <div
                style={{
                  position: "relative",
                  aspectRatio: "2.5 / 3.5",
                  background: C.art,
                  overflow: "hidden",
                  lineHeight: 0,
                  border: `1px solid ${C.border}`,
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: forDisplay(dsvg) }} />
                <GridOverlayCells
                  cols={dc.cols}
                  rows={dc.rows}
                  cell={dc.cell}
                  x0={dc.x0}
                  y0={dc.y0}
                  cellStyle={(j) => {
                    const isActive = activeCell != null && activeCell.donorIndex === i && activeCell.moduleIndex === j;
                    if (!isActive) return undefined;
                    return { outline: `2px solid ${donorColor(i)}`, outlineOffset: -1, background: `${donorColor(i)}33` };
                  }}
                  onEnter={(j) => setHoverDonorCell({ donorIndex: i, moduleIndex: j })}
                  onLeave={() => setHoverDonorCell(null)}
                />
              </div>
              <div style={{ ...mono, fontSize: 9.5, color: C.muted, textAlign: "center", marginTop: 6 }}>
                {donorLabels[i]}
              </div>
            </div>
          );
          })}
        </div>
      </div>
    </div>
  );
}

/** Split's cell explorer: the compose explorer's single-donor counterpart. One donor (the
 *  parent), so cells highlight in the split provenance convention -- one warn color, no per-donor
 *  tints (see provenance.tsx's `cellStyleAt`/`cellDetailAt`) -- rather than `donorColor`. */
function SplitCellExplorer({ node, byKey }: { node: PlayNode; byKey: Map<number, PlayNode> }) {
  const composition = nodeComposition(node);
  const svg = React.useMemo(
    () => svgFromComposition(composition, 0n, CANONICAL, node.black === true),
    [composition, node.black],
  );
  const trace = node.splitTrace!;
  const parent = byKey.get(node.parents![0])!;
  // D3' pool display: the trace's moduleIndex indexes the split's POOL, not the parent's own
  // card. Grammar branch (recordless parent): the pool is the parent seed's expression at the
  // CHILD's denomination -- render that as the highlight card; its grid matches the trace. Record
  // branch (composed parent): the pool spans several concatenated donors with no single grid, so
  // there is no highlight card and the detail panel reports the pool index directly.
  const recordBranch = parent.trace != null;
  const poolComposition = React.useMemo(() => {
    if (recordBranch) return null;
    const poolBytes = grammarSplitPoolBytes(parent.seed, node.denomIndex, parent.inkGene);
    return composeSampledShape(poolBytes, node.denomIndex, parent.inkGene, CANONICAL);
  }, [recordBranch, parent.seed, parent.inkGene, node.denomIndex]);
  const poolSvg = React.useMemo(
    () => (poolComposition ? svgFromComposition(poolComposition, 0n, CANONICAL, false) : null),
    [poolComposition],
  );

  const { active, onEnter, onLeave, onClickCell } = useActiveCell();
  const [hoverParentCell, setHoverParentCell] = React.useState<number | null>(null);

  const resultCellsByParentModule = React.useMemo(() => {
    const map = new Map<number, number[]>();
    trace.forEach((cell, j) => {
      const list = map.get(cell.moduleIndex) ?? [];
      list.push(j);
      map.set(cell.moduleIndex, list);
    });
    return map;
  }, [trace]);

  const highlighted = React.useMemo(() => {
    if (hoverParentCell != null) return new Set(resultCellsByParentModule.get(hoverParentCell) ?? []);
    if (active != null) return new Set([active]);
    return new Set<number>();
  }, [hoverParentCell, active, resultCellsByParentModule]);

  const activeCell = active != null ? trace[active] : null;

  return (
    <div className="play-inspector-body">
      <div className="play-inspector-result">
        <div
          style={{
            position: "relative",
            aspectRatio: "2.5 / 3.5",
            background: C.art,
            overflow: "hidden",
            lineHeight: 0,
            border: `1px solid ${C.border}`,
          }}
        >
          <div dangerouslySetInnerHTML={{ __html: forDisplay(svg) }} />
          <GridOverlayCells
            cols={composition.cols}
            rows={composition.rows}
            cell={composition.cell}
            x0={composition.x0}
            y0={composition.y0}
            cellStyle={(j) => {
              const isHighlighted = highlighted.has(j);
              return {
                background: `${SPLIT_COLOR}4d`,
                outline: `${isHighlighted ? 2 : 1}px solid ${SPLIT_COLOR}${isHighlighted ? "" : "55"}`,
                outlineOffset: -1,
              };
            }}
            onEnter={(j) => {
              setHoverParentCell(null);
              onEnter(j);
            }}
            onLeave={onLeave}
            onClickCell={onClickCell}
          />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn-outline"
            style={{ padding: "6px 12px", fontSize: 11 }}
            onClick={() => downloadTracePng(svg, composition, () => SPLIT_COLOR, traceExportBase(node))}
          >
            PNG
          </button>
          <button
            type="button"
            className="btn-outline"
            style={{ padding: "6px 12px", fontSize: 11 }}
            onClick={() => downloadTraceSvg(svg, composition, () => SPLIT_COLOR, traceExportBase(node))}
          >
            SVG
          </button>
        </div>
      </div>

      <div className="play-inspector-meta">
        <div className="play-inspector-subhead">Cell source</div>
        {activeCell && (
          <DetailPanel
            label={recordBranch ? `#${parent.demoId} merge pool` : `#${parent.demoId} seed at ${LABELS[node.denomIndex]} ETH`}
            moduleIndex={activeCell.moduleIndex}
            byte={activeCell.byte}
            color={SPLIT_COLOR}
          />
        )}
        {recordBranch && (
          <Prose>Sampled from the cards that merged into #{parent.demoId}.</Prose>
        )}
      </div>

      {poolComposition && poolSvg && (
        <div className="play-inspector-sources">
          <div className="play-inspector-subhead">Source Shape</div>
          <div className="play-source-cards">
          <div style={{ width: 120 }}>
            <div
              style={{
                position: "relative",
                aspectRatio: "2.5 / 3.5",
                background: C.art,
                overflow: "hidden",
                lineHeight: 0,
                border: `1px solid ${C.border}`,
              }}
            >
              <div dangerouslySetInnerHTML={{ __html: forDisplay(poolSvg) }} />
              <GridOverlayCells
                cols={poolComposition.cols}
                rows={poolComposition.rows}
                cell={poolComposition.cell}
                x0={poolComposition.x0}
                y0={poolComposition.y0}
                cellStyle={(j) => {
                  const isActive = activeCell != null && activeCell.moduleIndex === j;
                  if (!isActive) return undefined;
                  return { outline: `2px solid ${SPLIT_COLOR}`, outlineOffset: -1, background: `${SPLIT_COLOR}33` };
                }}
                onEnter={(j) => setHoverParentCell(j)}
                onLeave={() => setHoverParentCell(null)}
              />
            </div>
            <div style={{ ...mono, fontSize: 9.5, color: C.muted, textAlign: "center", marginTop: 6 }}>
              #{parent.demoId} seed at {LABELS[node.denomIndex]} ETH
            </div>
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Ancestor keys reachable from `root` via `parents`, for the "N independent origins" count
 *  (denomIndex 0: mint draws, which never have parents) and the tier count (denomIndex + 1). */
function completeRootStats(root: PlayNode, byKey: Map<number, PlayNode>): {originCount: number; tierCount: number} {
  const ancestry = new Set<number>();
  const pending = [root.key];
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (ancestry.has(key)) continue;
    ancestry.add(key);
    for (const parentKey of byKey.get(key)?.parents ?? []) pending.push(parentKey);
  }
  const originCount = Array.from(ancestry).filter((k) => byKey.get(k)?.denomIndex === 0).length;
  return {originCount, tierCount: root.denomIndex + 1};
}

function LineageBeat({ session }: { session: PlaySession }) {
  const byKey = React.useMemo(() => new Map(session.nodes.map((n) => [n.key, n])), [session.nodes]);
  const tips = liveNodes(session);
  const completeRoot = React.useMemo(() => {
    const liveKeys = new Set(tips.map((tip) => tip.key));
    for (let i = session.nodes.length - 1; i >= 0; i--) {
      if (session.nodes[i].complete && liveKeys.has(session.nodes[i].key)) return session.nodes[i];
    }
    return null;
  }, [session.nodes, tips]);
  const mostRecentProduced = React.useMemo(() => {
    for (let i = session.nodes.length - 1; i >= 0; i--) {
      if (session.nodes[i].trace || session.nodes[i].splitTrace) return session.nodes[i];
    }
    return null;
  }, [session.nodes]);
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!mostRecentProduced) return;
    setFocusedKey(String(mostRecentProduced.key));
  }, [mostRecentProduced?.key]);
  const focusedNode = focusedKey != null ? byKey.get(Number(focusedKey)) ?? null : null;

  const treeRoots = React.useMemo(
    () => (completeRoot ? [playNodeToTree(completeRoot, byKey)] : tips.map((tip) => playNodeToTree(tip, byKey))),
    [completeRoot, tips, byKey],
  );
  const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    const next = new Set<string>();
    for (const root of treeRoots) for (const key of initialExpandedKeys(root)) next.add(key);
    setExpandedKeys(next);
    // treeRoots is a fresh array every render; re-seed only when the underlying roots change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completeRoot?.key, tips.map((tip) => tip.key).join(",")]);
  const toggleExpanded = (key: string) =>
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const resetKey = completeRoot ? completeRoot.key : tips.map((tip) => tip.key).reduce((sum, key) => sum + key, 0);

  if (tips.length === 0) return null;

  return (
    <section className="play-section">
      <SectionLabel>Provenance</SectionLabel>
      {completeRoot ? (
        (() => {
          const {originCount, tierCount} = completeRootStats(completeRoot, byKey);
          return (
            <div className="play-provenance-tree-block">
              <Prose>
                Complete {LABELS[completeRoot.denomIndex]} ETH · {formatCount(originCount)} independent origins · {tierCount} tiers.
                {tierCount > 1
                  ? " Select a composed card to inspect its sampling. Open a source count to trace that branch further."
                  : " This is an independent origin Shape."}
              </Prose>
              <ProvenanceTree
                root={treeRoots[0]}
                focusedKey={focusedKey}
                onSelect={setFocusedKey}
                expandedKeys={expandedKeys}
                onToggleExpanded={toggleExpanded}
                resetKey={resetKey}
                exportBase={traceExportBase(completeRoot)}
              />
            </div>
          );
        })()
      ) : (
        <>
          <Prose>Every Shape the surviving object was built from.</Prose>
          <ProvenanceTree
            root={treeRoots[0]}
            extraRoots={treeRoots.slice(1)}
            focusedKey={focusedKey}
            onSelect={setFocusedKey}
            expandedKeys={expandedKeys}
            onToggleExpanded={toggleExpanded}
            resetKey={resetKey}
            exportBase={traceExportBase(tips[0])}
          />
        </>
      )}
      {focusedNode && (focusedNode.trace || focusedNode.splitTrace) && (
        <div className="play-provenance-inspector">
          <header className="play-inspector-header">
            <div>
              <div className="play-inspector-eyebrow">↳ Selected from the provenance tree</div>
              <h3>Shape #{focusedNode.demoId} · {LABELS[focusedNode.denomIndex]} ETH</h3>
            </div>
            <p>
              {focusedNode.trace
                ? "Each colour connects a cell in this Shape to the source Shape it came from."
                : "The highlighted cells connect this Shape to the state it was split from."}
            </p>
          </header>
          {focusedNode.trace && <CellExplorer node={focusedNode} byKey={byKey} />}
          {focusedNode.splitTrace && <SplitCellExplorer node={focusedNode} byKey={byKey} />}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export function PlayApp() {
  const [session, setSession] = React.useState<PlaySession>(emptySession);
  const [denomIndex, setDenomIndex] = React.useState(0);
  // A fixed placeholder, not a real draw: `randomSeed()` draws from `crypto.getRandomValues`,
  // which returns a different value on the server render than on the client's first paint,
  // producing a hydration mismatch. The mount effect below replaces it with a real roll.
  const [seed, setSeed] = React.useState<bigint>(0n);
  const [completeBusy, setCompleteBusy] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  // Which tray card's split picker or burn-backing confirmation is open, if any.
  const [menu, setMenu] = React.useState<TrayMenu>(null);

  // Client-only setup on mount: roll the real starting seed (see the placeholder note above),
  // and restore session state from `?s=` if present. A state initializer would read `location`
  // and `crypto` during the server render and mismatch the client's first paint, so both run as
  // an effect instead. `hydrated` gates the write-back effect below until this has had a chance
  // to run first -- without it, the write-back effect's first pass (which still sees the
  // pre-restore empty session, since this effect's setSession hasn't committed yet) would strip
  // `?s=` from the URL before the restore ever reads it.
  React.useEffect(() => {
    setSeed(randomSeed());
    const encoded = new URLSearchParams(location.search).get("s");
    if (encoded) {
      const decoded = decodeSession(encoded);
      if (decoded.nodes.length > 0) setSession(decoded);
    }
    setHydrated(true);
  }, []);

  // Keep compact sessions reproducible in the URL. Full-lineage sessions intentionally stay at
  // `/play`: their thousands of nodes are useful on-page but do not belong in an address bar.
  React.useEffect(() => {
    if (!hydrated) return;
    const url = session.nodes.length > 0 && sessionShareable(session)
      ? `/play?s=${encodeSession(session)}`
      : "/play";
    history.replaceState(null, "", url);
  }, [hydrated, session]);

  const effectiveSeed = seed;

  const nodes = liveNodes(session);
  const handleComplete = () => {
    if (completeBusy) return;
    const targetDenomIndex = denomIndex;
    setCompleteBusy(true);
    window.setTimeout(() => {
      try {
        let seedIndex = 0;
        setSession(buildCompleteShape(emptySession(), targetDenomIndex, () => seedIndex++ === 0 ? effectiveSeed : randomSeed()));
        setMenu(null);
      } catch (error) {
        console.error("generation failed", error);
      } finally {
        setCompleteBusy(false);
      }
    }, 0);
  };

  const handleRemove = (key: number) => {
    setSession((s) => removeNode(s, key));
    setMenu((m) => (m?.key === key ? null : m));
  };

  const handleSplit = (key: number, childDenomIndex: number) => {
    try {
      const node = liveNodes(session).find((candidate) => candidate.key === key);
      if (!node) return;
      const childCount = Number(unitsAt(node.denomIndex) / unitsAt(childDenomIndex));
      if (liveNodes(session).length - 1 + childCount > MAX_TRAY_CARDS) return;
      setSession(splitNode(session, key, childDenomIndex));
      setMenu(null);
    } catch (e) {
      console.error("split failed", e);
    }
  };

  const handleDecompose = (key: number) => {
    try {
      setSession(decomposeNode(session, key));
    } catch (e) {
      console.error("decompose failed", e);
    }
  };

  const handleBurnBacking = (key: number) => {
    try {
      setSession(burnBackingNode(session, key));
      setMenu(null);
    } catch (e) {
      console.error("burnBacking failed", e);
    }
  };

  return (
    <div className="launch-play-page" style={{ background: C.page, minHeight: "100vh", color: C.ink }}>
      <style>{`
        /* The compose reveal is the only animation on this page. Default (and reduced-motion)
           state: no cover, no animation -- the plain finished card. Motion is opted back in only
           when the visitor hasn't asked to reduce it. */
        @keyframes playRevealFade { from { opacity: 1 } to { opacity: 0 } }
        .play-reveal-cell {
          opacity: 0;
          animation-duration: 300ms;
          animation-timing-function: ease;
          animation-fill-mode: forwards;
          animation-delay: calc(var(--cell-i, 0) * 35ms);
        }
        @media (prefers-reduced-motion: no-preference) {
          .play-reveal-cell {
            opacity: 1;
            animation-name: playRevealFade;
          }
        }
        .launch-play-page {
          color-scheme: light;
          font-family: Arial, Helvetica, sans-serif;
          font-size: 16px;
          line-height: 1.5;
        }
        .launch-play-page a {
          color: inherit;
        }
        .play-page-nav,
        .play-page-shell {
          width: min(100% - 64px, 1360px);
          margin-inline: auto;
        }
        .play-page-nav {
          min-height: 84px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid ${C.rule};
          font-family: ${FONT};
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .play-page-nav a {
          font-weight: 500;
          text-decoration: none;
        }
        .play-page-shell {
          padding: clamp(56px, 7vw, 96px) 0 42px;
        }
        .play-page-intro {
          max-width: 760px;
          margin-bottom: clamp(56px, 7vw, 88px);
        }
        .play-page-intro h1 {
          max-width: 12ch;
          margin: 0;
          font-family: Arial, Helvetica, sans-serif;
          font-size: clamp(58px, 7vw, 104px);
          font-weight: 500;
          letter-spacing: -0.065em;
          line-height: 0.94;
        }
        .play-page-intro > p:last-child {
          max-width: 620px;
          margin-top: 28px !important;
          font-size: clamp(16px, 1.35vw, 19px) !important;
          letter-spacing: -0.01em;
          line-height: 1.45 !important;
        }
        .play-page-content {
          max-width: 1120px;
        }
        .play-section {
          border-top: 1px solid ${C.rule};
          padding-top: 24px;
          margin-bottom: clamp(48px, 6vw, 72px);
        }
        .play-draw-grid {
          display: grid;
          grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
          gap: clamp(32px, 5vw, 64px);
          align-items: start;
        }
        .play-draw-card {
          width: 100%;
        }
        .play-seed {
          margin-top: 8px;
          overflow-wrap: anywhere;
          font-family: ${FONT};
          font-size: 8.5px;
          line-height: 1.45;
          color: ${C.muted};
        }
        .play-draw-controls {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 22px;
        }
        .play-control-group {
          display: flex;
          flex-direction: column;
          gap: 9px;
        }
        .play-control-label {
          font-family: ${FONT};
          font-size: 8.5px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: ${C.muted};
        }
        .play-tier-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(84px, 1fr));
          gap: 6px;
        }
        .play-tier-grid button {
          width: 100%;
        }
        .play-action-row {
          display: flex;
          align-items: flex-start;
          gap: 22px;
          flex-wrap: wrap;
        }
        .play-action-group {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .play-complete-group {
          max-width: 330px;
          padding-left: 22px;
          border-left: 1px solid ${C.rule};
        }
        .play-complete-group > span,
        .play-note,
        .play-empty {
          margin: 0;
          color: ${C.muted};
          font-family: Arial, Helvetica, sans-serif;
          font-size: 12.5px;
          line-height: 1.45;
        }
        .play-quantity {
          display: flex;
          align-items: center;
          gap: 7px;
        }
        .play-quantity > span {
          font-family: ${FONT};
          font-size: 9px;
          color: ${C.muted};
        }
        .play-export-row {
          display: flex;
          align-items: center;
          gap: 14px;
          padding-top: 18px;
          border-top: 1px solid ${C.ruleInner};
        }
        .play-export-row > div {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .play-note {
          max-width: 460px;
          font-size: 11.5px;
        }
        .play-empty {
          padding-bottom: 4px;
        }
        .play-compose-bar {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: 16px;
        }
        .play-provenance-tree-block {
          margin: 20px 0 0;
        }
        .play-provenance-inspector {
          padding: clamp(22px, 3vw, 36px);
          border: 1px solid ${C.rule};
          border-top: 3px solid ${C.ink};
          background: ${C.row};
        }
        .play-inspector-header {
          display: grid;
          grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
          gap: 24px 48px;
          align-items: end;
          margin-bottom: 28px;
          padding-bottom: 22px;
          border-bottom: 1px solid ${C.rule};
        }
        .play-inspector-eyebrow,
        .play-inspector-subhead {
          font-family: ${FONT};
          font-size: 8.5px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: ${C.muted};
        }
        .play-inspector-header h3 {
          margin: 8px 0 0;
          font-family: Arial, Helvetica, sans-serif;
          font-size: clamp(22px, 2.4vw, 32px);
          font-weight: 500;
          letter-spacing: -0.035em;
          line-height: 1.05;
        }
        .play-inspector-header p {
          max-width: 600px;
          margin: 0;
          color: ${C.bodyDim};
          font-size: 13px;
          line-height: 1.5;
        }
        .play-inspector-body {
          display: grid;
          grid-template-columns: minmax(200px, 280px) minmax(170px, 220px) minmax(240px, 1fr);
          gap: clamp(22px, 3vw, 40px);
          align-items: start;
        }
        .play-inspector-result {
          width: 100%;
        }
        .play-inspector-meta {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .play-inspector-sources {
          min-width: 0;
        }
        .play-inspector-subhead {
          margin-bottom: 12px;
        }
        .play-source-cards {
          display: flex;
          gap: 14px;
          flex-wrap: wrap;
        }
        .launch-play-page button,
        .launch-play-page input {
          border-radius: 0;
        }
        .launch-play-page button:not(:disabled):hover {
          border-color: ${C.ink} !important;
        }
        .launch-play-page input:focus-visible,
        .launch-play-page button:focus-visible,
        .launch-play-page a:focus-visible {
          outline: 2px solid ${C.ink};
          outline-offset: 3px;
        }
        .play-page-footer {
          margin-top: 72px;
          padding-top: 28px;
          border-top: 1px solid ${C.ink};
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 24px;
          font-family: ${FONT};
          font-size: 9px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .play-page-footer nav {
          display: flex;
          gap: 22px;
        }
        @media (max-width: 620px) {
          .play-page-nav,
          .play-page-shell {
            width: min(100% - 36px, 1360px);
          }
          .play-page-nav {
            min-height: 70px;
          }
          .play-page-shell {
            padding-top: 52px;
          }
          .play-page-intro h1 {
            font-size: clamp(58px, 20vw, 82px);
          }
          .play-page-intro {
            margin-bottom: 60px;
          }
          .play-draw-grid {
            grid-template-columns: 1fr;
            gap: 28px;
          }
          .play-draw-card {
            width: min(260px, 78vw);
          }
          .play-tier-grid {
            grid-template-columns: repeat(3, minmax(76px, 1fr));
          }
          .play-complete-group {
            max-width: none;
            padding-left: 0;
            border-left: 0;
          }
          .play-action-row {
            gap: 14px;
          }
          .play-section {
            margin-bottom: 48px;
          }
          .play-inspector-header,
          .play-inspector-body {
            grid-template-columns: 1fr;
          }
          .play-inspector-header {
            gap: 12px;
            margin-bottom: 22px;
            padding-bottom: 18px;
          }
          .play-inspector-result {
            width: min(240px, 100%);
          }
          .play-provenance-inspector {
            padding: 20px;
          }
          .play-page-footer {
            align-items: flex-start;
            flex-direction: column;
          }
        }
      `}</style>
      <header className="play-page-nav">
        <a href="/">shapes</a>
      </header>
      <main className="play-page-shell">
        <header className="play-page-intro">
          <h1>Generate. Split. Trace.</h1>
          <Prose>
            Choose a denomination, roll an output, then generate the complete Shape and explore where it came from.
          </Prose>
        </header>

        <div className="play-page-content">
          <DrawBeat
            denomIndex={denomIndex}
            onDenomIndex={setDenomIndex}
            onRoll={() => setSeed(randomSeed())}
            effectiveSeed={effectiveSeed}
            onComplete={handleComplete}
            completeBusy={completeBusy}
          />

          {nodes.length > 0 && (
            <TrayBeat
              nodes={nodes}
              session={session}
              selected={new Set()}
              menu={menu}
              onToggle={() => {}}
              onRemove={handleRemove}
              onOpenMenu={setMenu}
              onSplit={handleSplit}
              onDecompose={handleDecompose}
              onBurnBacking={handleBurnBacking}
            />
          )}

          <LineageBeat session={session} />
        </div>

        <footer className="play-page-footer">
          <span>
            An Ethereum primitive by <a href="https://x.com/ripe0x">ripe</a>
          </span>
          <nav aria-label="Playground footer">
            <a href="/">Back to launch</a>
            <a href={REPO_URL}>Source</a>
          </nav>
        </footer>
      </main>
    </div>
  );
}
