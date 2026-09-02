import React from "react";
import { FONT } from "../site/theme";
import { forDisplay, C as PROV_C } from "../app/ui";
import { donorColor, GridOverlayCells, byteHex, useActiveCell } from "../app/provenance";
import { CANONICAL } from "../canonical/params";
import { composeShape, svgFromComposition, type Composition } from "../canonical/render";
import { WAD } from "../canonical/wad";
import { composeSampledShape, grammarSplitPoolBytes, type ComposeTraceCell } from "../canonical/sampling";
import { DENOMINATIONS, GRIDS, LABELS, UNIT, unitsAt } from "../canonical/denominations";
import { geneAtMint } from "../canonical/ink";
import { decodeModuleByte } from "../canonical/moduleCodec";
import {
  buildCompleteShape,
  composeNodes,
  composeSummedIndex,
  decomposeNode,
  emptySession,
  keepCard,
  liveNodes,
  nodeComposition,
  randomSeed,
  removeNode,
  sacrificeNode,
  splitNode,
  type PlayNode,
  type PlaySession,
} from "./session";
import { decodeSession, encodeSession, sessionShareable } from "./urlCodec";
import { downloadCardPng, downloadComposeGif, downloadLadderPng, downloadSquarePng } from "./exports";

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

const C = {
  page: "#f7f7f3",
  ink: "#11110f",
  body: "#2f2f2b",
  bodyDim: "#4f4f49",
  muted: "#686862",
  faint: "#aaa9a1",
  rule: "#d8d8d1",
  ruleInner: "#e7e7e1",
  border: "#b9b9b1",
  row: "#efefe9",
  art: "#000000",
} as const;

const mono: React.CSSProperties = { fontFamily: FONT };
const sans: React.CSSProperties = { fontFamily: "Arial, Helvetica, sans-serif" };
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

/** A selection's summed backing, formatted for display. Every denomination is a whole multiple
 *  of UNIT (0.01 ETH), so any sum is too — at most two decimal places. */
function formatEth(wei: bigint): string {
  const hundredths = wei / UNIT;
  const whole = hundredths / 100n;
  const frac = hundredths % 100n;
  if (frac === 0n) return `${whole} ETH`;
  const fracStr = (frac < 10n ? "0" : "") + frac.toString();
  const trimmed = fracStr.endsWith("0") ? fracStr.slice(0, 1) : fracStr;
  return `${whole}.${trimmed} ETH`;
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

function PlayRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "2px 0" }}>
      <span style={{ ...mono, fontSize: 10, color: C.muted, width: 120, flexShrink: 0 }}>{k}</span>
      <span style={{ ...mono, fontSize: 10.5, color: C.ink, wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}

function PlayDetailPanel({
  label,
  moduleIndex,
  byte,
  color,
}: {
  label: string;
  moduleIndex: number;
  byte: number;
  color?: string;
}) {
  const decoded = decodeModuleByte(byte);
  return (
    <div style={{ border: `1px solid ${C.border}`, padding: 12, minWidth: 220 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        {color && <span style={{ width: 10, height: 10, background: color, flexShrink: 0 }} />}
        <span style={{ ...mono, fontSize: 11, color: C.ink, fontWeight: 500 }}>{label}</span>
      </div>
      <PlayRow k="source module #" v={moduleIndex} />
      <PlayRow k="byte" v={byteHex(byte)} />
      <PlayRow k="kind" v={decoded.kind} />
      <PlayRow k="solid" v={decoded.solid ? "solid" : "outline"} />
      <PlayRow k="rotation" v={`${decoded.rot}°`} />
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
  quantity,
  onQuantity,
  onRoll,
  effectiveSeed,
  onAdd,
  onComplete,
  completeBusy,
  inverted,
  onToggleInverted,
}: {
  denomIndex: number;
  onDenomIndex: (i: number) => void;
  quantity: number;
  onQuantity: (quantity: number) => void;
  onRoll: () => void;
  effectiveSeed: bigint;
  onAdd: () => void;
  onComplete: () => void;
  completeBusy: boolean;
  inverted: boolean;
  onToggleInverted: () => void;
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
      <SectionLabel>Draw</SectionLabel>
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
              <label className="play-quantity">
                <span>Quantity</span>
              <input
                type="number"
                min={1}
                max={25}
                inputMode="numeric"
                value={quantity}
                onChange={(event) => {
                  const next = Number.parseInt(event.target.value, 10);
                  onQuantity(Number.isFinite(next) ? Math.min(25, Math.max(1, next)) : 1);
                }}
                style={{
                  ...mono,
                  width: 52,
                  padding: "8px 8px",
                  border: `1px solid ${C.border}`,
                  background: "transparent",
                  color: C.ink,
                  fontSize: 12,
                }}
              />
              </label>
              <PlayButton onClick={onAdd}>Add</PlayButton>
            </div>
            <div className="play-action-group play-complete-group">
              <PlayButton onClick={onComplete} disabled={completeBusy}>
                {completeBusy ? "Building…" : "Complete"}
              </PlayButton>
              <span>Build every rung from independent 0.01 ETH origins.</span>
            </div>
          </div>

          <div className="play-export-row">
            <span className="play-control-label">Export</span>
            <div>
              <PlayButton small onClick={() => downloadCardPng(composition, LABELS[denomIndex], effectiveSeed, inverted)}>
                Card PNG
              </PlayButton>
              <PlayButton small onClick={() => downloadLadderPng(effectiveSeed, inverted)}>
                Ladder PNG
              </PlayButton>
              <PlayButton small active={inverted} onClick={onToggleInverted}>
                Black
              </PlayButton>
            </div>
          </div>

          <p className="play-note">Nothing is minted here. Real seeds are assigned at mint.</p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 2 — tray
 * ------------------------------------------------------------------ */

/** Which card's inline tray menu is open, and which kind (the split tier picker or the
 *  sacrifice confirmation). Only one card's menu is open at a time. */
type TrayMenu = { key: number; kind: "split" | "sacrifice" } | null;

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

function SacrificeConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, width: 200 }}>
      <Prose>
        Sacrifice sends the Shape&apos;s 100 ETH to an address no one can spend from. The card stays,
        black. On chain this requires a complete 100 ETH Shape: 10,000 independent origins.
      </Prose>
      <div style={{ display: "flex", gap: 6 }}>
        <PlayButton small onClick={onConfirm}>
          Sacrifice
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
  onToggle,
  onRemove,
  onOpenMenu,
  onSplit,
  onDecompose,
  onSacrifice,
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
  onSacrifice: (key: number) => void;
}) {
  const svg = svgFromComposition(nodeComposition(node), 0n, CANONICAL, node.black === true);
  const isTop = node.denomIndex === DENOMINATIONS.length - 1;
  const showDecompose = node.trace != null && !node.black;
  // Split children have no remove control: the session codec records a split atomically, so a
  // missing sibling would be unrepresentable (removeNode rejects them too).
  const showRemove = !showDecompose && node.splitTrace == null;
  const menuOpen = menu?.key === node.key ? menu.kind : null;

  return (
    <div style={{ position: "relative", width: 128 }}>
      <RawCard
        svg={svg}
        width="100%"
        selected={selected}
        onClick={node.black ? undefined : () => onToggle(node.key)}
        caption={
          node.black
            ? `#${node.demoId} · Black`
            : `#${node.demoId} · ${LABELS[node.denomIndex]} ETH`
        }
      />
      {showRemove && (
        <button
          onClick={() => onRemove(node.key)}
          title="remove"
          style={{
            ...mono,
            position: "absolute",
            top: 2,
            right: 2,
            fontSize: 10,
            lineHeight: 1,
            padding: "2px 5px",
            border: "none",
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          ×
        </button>
      )}
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
              onClick={() => onOpenMenu(menuOpen === "sacrifice" ? null : { key: node.key, kind: "sacrifice" })}
            >
              Sacrifice
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
      {menuOpen === "sacrifice" && (
        <SacrificeConfirm onConfirm={() => onSacrifice(node.key)} onCancel={() => onOpenMenu(null)} />
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
  onSacrifice,
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
  onSacrifice: (key: number) => void;
}) {
  return (
    <section className="play-section">
      <SectionLabel>
        Tray ({nodes.length})
      </SectionLabel>
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
              onSacrifice={onSacrifice}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 3 — compose
 * ------------------------------------------------------------------ */

/** WAD bigint to a display float, the same conversion `GridOverlayCells` (app/provenance.tsx)
 *  uses for its own positioning percentages. */
function toFloat(w: bigint): number {
  return Number(w) / Number(WAD);
}

/** `color` at `alpha` composited over solid black: `color * alpha` per channel, opaque. Used for
 *  the reveal's per-cell covers, so they read as a darkened, donor-tinted version of the color
 *  rather than the raw saturated donor swatch. */
function tintOverBlack(hex: string, alpha = 0.65): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * alpha);
  const g = Math.round(((n >> 8) & 0xff) * alpha);
  const b = Math.round((n & 0xff) * alpha);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The compose reveal: an opaque donor-tinted cover over each grid cell, fading out one by one in
 * trace order. Reimplements `GridOverlayCells`'s WAD -> percent positioning (app/provenance.tsx)
 * rather than reusing it, because each cover needs a class name for the reduced-motion-gated CSS
 * animation below, and `GridOverlayCells`'s `cellStyle` can only carry inline style. Pure CSS
 * keyframes with a per-cell `animation-delay`; no JS timers, nothing random — the same trace
 * produces the same reveal every time.
 */
function RevealOverlay({ composition, trace }: { composition: Composition; trace: ComposeTraceCell[] }) {
  const leftPct = (toFloat(composition.x0) / 250) * 100;
  const topPct = (toFloat(composition.y0) / 350) * 100;
  const widthPct = ((toFloat(composition.cell) * composition.cols) / 250) * 100;
  const heightPct = ((toFloat(composition.cell) * composition.rows) / 350) * 100;
  return (
    <div
      style={{
        position: "absolute",
        left: `${leftPct}%`,
        top: `${topPct}%`,
        width: `${widthPct}%`,
        height: `${heightPct}%`,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${composition.cols}, 1fr)`,
          gridTemplateRows: `repeat(${composition.rows}, 1fr)`,
          width: "100%",
          height: "100%",
        }}
      >
        {trace.map((cell, j) => (
          <div
            key={j}
            className="play-reveal-cell"
            style={
              {
                background: tintOverBlack(donorColor(cell.donorIndex)),
                "--cell-i": j,
              } as React.CSSProperties & Record<"--cell-i", number>
            }
          />
        ))}
      </div>
    </div>
  );
}

/** The compose result card: the finished artwork, fully rendered underneath from the start, with
 *  the reveal overlay on top when a trace is present. Keyed by the caller on the result node's
 *  key, so a new compose remounts this (and restarts the CSS animation) from scratch. */
function ComposeResultCard({
  composition,
  trace,
  inverted,
}: {
  composition: Composition;
  trace: ComposeTraceCell[] | null;
  inverted: boolean;
}) {
  const svg = React.useMemo(() => svgFromComposition(composition, 0n, CANONICAL, inverted), [composition, inverted]);
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: "2.5 / 3.5",
        background: C.art,
        overflow: "hidden",
        lineHeight: 0,
        outline: `1px solid ${C.border}`,
        outlineOffset: -1,
      }}
    >
      <div dangerouslySetInnerHTML={{ __html: forDisplay(svg) }} />
      {trace && <RevealOverlay composition={composition} trace={trace} />}
    </div>
  );
}

function ComposeBeat({
  nodes,
  selected,
  onCompose,
  error,
  lastResult,
  inverted,
  onToggleInverted,
}: {
  nodes: PlayNode[];
  selected: Set<number>;
  onCompose: () => void;
  error: string | null;
  lastResult: PlayNode | null;
  inverted: boolean;
  onToggleInverted: () => void;
}) {
  const selectedNodes = nodes.filter((n) => selected.has(n.key));
  const sumWei = selectedNodes.reduce((acc, n) => acc + DENOMINATIONS[n.denomIndex], 0n);
  const summedIndex = composeSummedIndex(selectedNodes);
  const survivor =
    selectedNodes.length > 0 ? selectedNodes.reduce((a, b) => (b.demoId < a.demoId ? b : a)) : null;
  const validAboveSurvivor = survivor != null && summedIndex >= 0 && summedIndex > survivor.denomIndex;

  let reason: string | null = null;
  if (selectedNodes.length < 2) reason = "select at least two cards";
  else if (summedIndex < 0) reason = `${formatEth(sumWei)} is not a denomination`;
  else if (!validAboveSurvivor) reason = "result must be above the survivor's denomination";

  const canCompose = reason === null;

  const resultComposition = React.useMemo(() => (lastResult ? nodeComposition(lastResult) : null), [lastResult]);
  // Exports of a black (sacrificed) result default to inverted, regardless of the manual toggle
  // below (which still lets a visitor invert a non-black result's exports).
  const effectiveInverted = inverted || lastResult?.black === true;

  const [gifBusy, setGifBusy] = React.useState<string | null>(null);

  const handleGif = async () => {
    if (!lastResult) return;
    setGifBusy("rendering…");
    try {
      await downloadComposeGif(lastResult, LABELS[lastResult.denomIndex], effectiveInverted, (done, total) =>
        setGifBusy(`rendering ${done}/${total}…`),
      );
    } catch (e) {
      console.error("GIF export failed", e);
    } finally {
      setGifBusy(null);
    }
  };

  return (
    <section className="play-section">
      <SectionLabel>Compose</SectionLabel>
      {nodes.length === 0 ? (
        <p className="play-empty">Select cards from the tray to compose them.</p>
      ) : (
        <div className="play-compose-bar">
          <div style={{ ...mono, fontSize: 10.5, color: C.body }}>
            {selectedNodes.length} selected · {formatEth(sumWei)}
          </div>
          {reason && <div style={{ ...mono, fontSize: 10.5, color: C.muted }}>{reason}</div>}
          {!reason && summedIndex >= 0 && (
            <div style={{ ...mono, fontSize: 10.5, color: C.body }}>
              → {LABELS[summedIndex]} ETH ({GRIDS[summedIndex][0]}×{GRIDS[summedIndex][1]})
            </div>
          )}
          <PlayButton onClick={onCompose} disabled={!canCompose}>
            Compose
          </PlayButton>
        </div>
      )}
      {error && <div style={{ ...mono, fontSize: 11, color: C.muted, marginBottom: 16 }}>{error}</div>}

      {lastResult && resultComposition && (
        <div key={lastResult.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ width: "min(320px, 80vw)" }}>
            <ComposeResultCard
              composition={resultComposition}
              trace={lastResult.trace ?? null}
              inverted={lastResult.black === true}
            />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <PlayButton
              small
              onClick={() => downloadCardPng(resultComposition, LABELS[lastResult.denomIndex], lastResult.seed, effectiveInverted)}
            >
              Card PNG
            </PlayButton>
            <PlayButton
              small
              onClick={() => downloadSquarePng(resultComposition, LABELS[lastResult.denomIndex], lastResult.seed, effectiveInverted)}
            >
              Square PNG
            </PlayButton>
            <PlayButton small disabled={gifBusy !== null} onClick={handleGif}>
              {gifBusy ?? "GIF"}
            </PlayButton>
            <PlayButton small active={inverted} onClick={onToggleInverted}>
              Black
            </PlayButton>
          </div>
          <Prose>
            {lastResult.black
              ? "Black."
              : `Composed from ${lastResult.parents?.length ?? 0} Shapes. Every cell sampled from a parent.`}
          </Prose>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 4 — lineage
 * ------------------------------------------------------------------ */

function LineageNode({
  node,
  byKey,
  focusedKey,
  onSelect,
  depth = 0,
}: {
  node: PlayNode;
  byKey: Map<number, PlayNode>;
  focusedKey: number | null;
  onSelect: (key: number) => void;
  depth?: number;
}) {
  const svg = svgFromComposition(nodeComposition(node), 0n, CANONICAL, node.black === true);
  const parents = (node.parents ?? []).map((k) => byKey.get(k)).filter((n): n is PlayNode => n != null);
  const selectable = node.trace != null || node.splitTrace != null;
  const widths = [120, 76, 52, 36, 26, 20];
  const width = widths[Math.min(depth, widths.length - 1)];
  const stub = 18;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <RawCard
        svg={svg}
        width={width}
        caption={width >= 26 ? `#${node.demoId}` : undefined}
        onClick={selectable ? () => onSelect(node.key) : undefined}
        selected={selectable && focusedKey === node.key}
      />
      {parents.length > 0 && (
        <>
          <div style={{ width: 1, height: stub, background: C.border }} />
          <div style={{ display: "flex", alignItems: "flex-start" }}>
            {parents.map((parent, index) => {
              const first = index === 0;
              const last = index === parents.length - 1;
              const solo = parents.length === 1;
              return (
                <div key={parent.key} style={{ position: "relative", padding: `${stub}px 9px 0` }}>
                  {!solo && !first && (
                    <div style={{ position: "absolute", top: 0, left: 0, width: "50%", height: 1, background: C.border }} />
                  )}
                  {!solo && !last && (
                    <div style={{ position: "absolute", top: 0, left: "50%", width: "50%", height: 1, background: C.border }} />
                  )}
                  <div style={{ position: "absolute", top: 0, left: "50%", width: 1, height: stub, background: C.border }} />
                  <LineageNode
                    node={parent}
                    byKey={byKey}
                    focusedKey={focusedKey}
                    onSelect={onSelect}
                    depth={depth + 1}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
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
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div style={{ width: "min(280px, 80vw)" }}>
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
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {donorLabels.map((lab, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, background: donorColor(i) }} />
              <span style={{ ...mono, fontSize: 10.5, color: C.body }}>{lab}</span>
            </div>
          ))}
        </div>
        {activeCell && (
          <PlayDetailPanel
            label={donorLabels[activeCell.donorIndex] ?? activeCell.donorId}
            moduleIndex={activeCell.moduleIndex}
            byte={activeCell.byte}
            color={donorColor(activeCell.donorIndex)}
          />
        )}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
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
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div style={{ width: "min(280px, 80vw)" }}>
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
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {activeCell && (
          <PlayDetailPanel
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
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
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
      )}
    </div>
  );
}

const COMPLETE_LAYER_PAGE_SIZE = 10;

function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function CompleteLineageLadder({
  root,
  session,
  byKey,
  focusedKey,
  onSelect,
}: {
  root: PlayNode;
  session: PlaySession;
  byKey: Map<number, PlayNode>;
  focusedKey: number | null;
  onSelect: (key: number) => void;
}) {
  const layers = React.useMemo(() => {
    const ancestry = new Set<number>();
    const pending = [root.key];
    while (pending.length > 0) {
      const key = pending.pop()!;
      if (ancestry.has(key)) continue;
      ancestry.add(key);
      for (const parentKey of byKey.get(key)?.parents ?? []) pending.push(parentKey);
    }

    return Array.from({ length: root.denomIndex + 1 }, (_, denomIndex) => ({
      denomIndex,
      nodes: session.nodes.filter((node) => ancestry.has(node.key) && node.denomIndex === denomIndex),
    })).reverse();
  }, [root.key, root.denomIndex, session.nodes, byKey]);

  const [pages, setPages] = React.useState<Record<number, number>>({});
  const originCount = layers.at(-1)?.nodes.length ?? 0;

  return (
    <div style={{ margin: "20px 0 32px" }}>
      <Prose>
        Complete {LABELS[root.denomIndex]} ETH · {formatCount(originCount)} independent origins · {layers.length} tiers.
        Select any composed card to inspect how its cells were sampled.
      </Prose>

      <div style={{ marginTop: 24, borderBottom: `1px solid ${C.rule}` }}>
        {layers.map((layer, layerIndex) => {
          const pageCount = Math.max(1, Math.ceil(layer.nodes.length / COMPLETE_LAYER_PAGE_SIZE));
          const page = Math.min(pages[layer.denomIndex] ?? 0, pageCount - 1);
          const first = page * COMPLETE_LAYER_PAGE_SIZE;
          const visible = layer.nodes.slice(first, first + COMPLETE_LAYER_PAGE_SIZE);
          const countLabel = `${formatCount(layer.nodes.length)} ${layer.nodes.length === 1 ? "Shape" : "Shapes"}`;

          return (
            <React.Fragment key={layer.denomIndex}>
              {layerIndex > 0 && (
                <div style={{ ...mono, fontSize: 9, color: C.muted, padding: "9px 0 9px 112px" }}>
                  built from
                </div>
              )}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "92px minmax(0, 1fr)",
                  gap: 20,
                  padding: "20px 0",
                  borderTop: `1px solid ${C.rule}`,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <strong style={{ ...sans, fontSize: 18, fontWeight: 500, color: C.ink }}>
                    {LABELS[layer.denomIndex]} ETH
                  </strong>
                  <span style={{ ...mono, fontSize: 9.5, color: C.muted }}>{countLabel}</span>
                </div>

                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {visible.map((node) => {
                      const selectable = node.trace != null || node.splitTrace != null;
                      return (
                        <RawCard
                          key={node.key}
                          svg={svgFromComposition(nodeComposition(node), 0n, CANONICAL, node.black === true)}
                          width={64}
                          caption={`#${node.demoId}`}
                          onClick={selectable ? () => onSelect(node.key) : undefined}
                          selected={selectable && focusedKey === node.key}
                        />
                      );
                    })}
                  </div>

                  {pageCount > 1 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                      <PlayButton
                        small
                        disabled={page === 0}
                        onClick={() => setPages((current) => ({ ...current, [layer.denomIndex]: page - 1 }))}
                      >
                        Previous
                      </PlayButton>
                      <span style={{ ...mono, fontSize: 9.5, color: C.muted }}>
                        {formatCount(first + 1)}–{formatCount(Math.min(first + COMPLETE_LAYER_PAGE_SIZE, layer.nodes.length))}
                        {" of "}{formatCount(layer.nodes.length)}
                      </span>
                      <PlayButton
                        small
                        disabled={page === pageCount - 1}
                        onClick={() => setPages((current) => ({ ...current, [layer.denomIndex]: page + 1 }))}
                      >
                        Next
                      </PlayButton>
                    </div>
                  )}
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
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
  const [focusedKey, setFocusedKey] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!mostRecentProduced) return;
    setFocusedKey(mostRecentProduced.key);
  }, [mostRecentProduced?.key]);

  const focusedNode = focusedKey != null ? byKey.get(focusedKey) ?? null : null;

  if (tips.length === 0) return null;

  return (
    <section className="play-section">
      <SectionLabel>Provenance</SectionLabel>
      {completeRoot ? (
        <CompleteLineageLadder
          key={completeRoot.key}
          root={completeRoot}
          session={session}
          byKey={byKey}
          focusedKey={focusedKey}
          onSelect={setFocusedKey}
        />
      ) : (
        <>
          <Prose>Every Shape the surviving object was built from.</Prose>
          <div className="play-lineage-scroll">
            {tips.map((tip) => (
              <LineageNode
                key={tip.key}
                node={tip}
                byKey={byKey}
                focusedKey={focusedKey}
                onSelect={setFocusedKey}
              />
            ))}
          </div>
        </>
      )}
      {focusedNode && focusedNode.trace && <CellExplorer node={focusedNode} byKey={byKey} />}
      {focusedNode && focusedNode.splitTrace && <SplitCellExplorer node={focusedNode} byKey={byKey} />}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export function PlayApp() {
  const [session, setSession] = React.useState<PlaySession>(emptySession);
  const [denomIndex, setDenomIndex] = React.useState(0);
  const [quantity, setQuantity] = React.useState(1);
  // A fixed placeholder, not a real draw: `randomSeed()` draws from `crypto.getRandomValues`,
  // which returns a different value on the server render than on the client's first paint,
  // producing a hydration mismatch. The mount effect below replaces it with a real roll.
  const [seed, setSeed] = React.useState<bigint>(0n);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [composeError, setComposeError] = React.useState<string | null>(null);
  const [completeBusy, setCompleteBusy] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  // Which tray card's split picker or sacrifice confirmation is open, if any.
  const [menu, setMenu] = React.useState<TrayMenu>(null);
  // Exports-only: Card/Square/Ladder PNG and GIF render inverted when set. On-page cards never
  // invert, so this never touches anything the visitor is looking at directly.
  const [inverted, setInverted] = React.useState(false);

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
  const lastResult = React.useMemo(() => {
    for (let i = session.nodes.length - 1; i >= 0; i--) {
      if (session.nodes[i].trace) return session.nodes[i];
    }
    return null;
  }, [session.nodes]);

  const handleAdd = () => {
    let next = session;
    let nextSeed = effectiveSeed;
    for (let i = 0; i < quantity; i++) {
      next = keepCard(next, denomIndex, nextSeed);
      nextSeed = randomSeed();
    }
    setSession(next);
    setSeed(nextSeed);
  };

  const handleComplete = () => {
    if (completeBusy) return;
    const targetDenomIndex = denomIndex;
    const startingSession = session;
    setCompleteBusy(true);
    window.setTimeout(() => {
      try {
        setSession(buildCompleteShape(startingSession, targetDenomIndex));
        setSelected(new Set());
        setComposeError(null);
        setMenu(null);
      } catch (error) {
        setComposeError(error instanceof Error ? error.message : String(error));
      } finally {
        setCompleteBusy(false);
      }
    }, 0);
  };

  const handleToggle = (key: number) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleRemove = (key: number) => {
    setSession((s) => removeNode(s, key));
    setSelected((cur) => {
      if (!cur.has(key)) return cur;
      const next = new Set(cur);
      next.delete(key);
      return next;
    });
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

  const handleSacrifice = (key: number) => {
    try {
      setSession(sacrificeNode(session, key));
      setMenu(null);
    } catch (e) {
      console.error("sacrifice failed", e);
    }
  };

  const handleCompose = () => {
    try {
      const next = composeNodes(session, [...selected]);
      setSession(next);
      setSelected(new Set());
      setComposeError(null);
    } catch (e) {
      setComposeError(e instanceof Error ? e.message : String(e));
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
        .play-lineage-scroll {
          display: flex;
          align-items: flex-start;
          gap: 32px;
          margin: 24px 0 32px;
          padding: 0 0 18px;
          overflow-x: auto;
          overscroll-behavior-x: contain;
        }
        .play-lineage-scroll > div {
          min-width: max-content;
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
          <h1>Draw. Compose. Trace.</h1>
          <Prose>
            This playground runs the same renderer and the same sampling procedure as the contract. A minted
            Shape with this seed at this denomination would be byte-identical.
          </Prose>
        </header>

        <div className="play-page-content">
          <DrawBeat
            denomIndex={denomIndex}
            onDenomIndex={setDenomIndex}
            quantity={quantity}
            onQuantity={setQuantity}
            onRoll={() => setSeed(randomSeed())}
            effectiveSeed={effectiveSeed}
            onAdd={handleAdd}
            onComplete={handleComplete}
            completeBusy={completeBusy}
            inverted={inverted}
            onToggleInverted={() => setInverted((v) => !v)}
          />

          <TrayBeat
            nodes={nodes}
            session={session}
            selected={selected}
            menu={menu}
            onToggle={handleToggle}
            onRemove={handleRemove}
            onOpenMenu={setMenu}
            onSplit={handleSplit}
            onDecompose={handleDecompose}
            onSacrifice={handleSacrifice}
          />

          <ComposeBeat
            nodes={nodes}
            selected={selected}
            onCompose={handleCompose}
            error={composeError}
            lastResult={lastResult}
            inverted={inverted}
            onToggleInverted={() => setInverted((v) => !v)}
          />

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
