import React from "react";
import { C, FONT, label as labelStyle } from "../site/theme";
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
  textSeed,
  type PlayNode,
  type PlaySession,
} from "./session";
import { decodeSession, encodeSession, sessionShareable } from "./urlCodec";
import { downloadCardPng, downloadComposeGif, downloadLadderPng, downloadSquarePng } from "./exports";

/** Split's single-donor highlight color, matching provenance.tsx's convention for split
 *  provenance (`cellStyleAt`/`cellDetailAt`): one warn-color highlight, no per-donor tints. */
const SPLIT_COLOR = PROV_C.warn;

/**
 * The Playground (`/play`): a chain-free demo of the two ideas the collection is built on,
 * value controls density, and compose is visible cell-by-cell inheritance. Draw a card, keep it,
 * compose kept cards, trace the result's cells to their parents. No wallet, no RPC, no fetch;
 * every card comes from the canonical renderer/sampler in `../canonical` over local session
 * state (`./session`).
 */

const mono: React.CSSProperties = { fontFamily: FONT };

const REPO_URL = "https://github.com/ripe0x/shapes";

function seedHex(seed: bigint): string {
  return "0x" + seed.toString(16).padStart(64, "0");
}

function truncateSeed(seed: bigint): string {
  const full = seedHex(seed);
  return `${full.slice(0, 8)}…${full.slice(-6)}`;
}

/** A selection's summed backing, formatted for display. Every denomination is a whole multiple
 *  of UNIT (0.01 ETH), so any sum is too, at most two decimal places. */
function formatEth(wei: bigint): string {
  const hundredths = wei / UNIT;
  const whole = hundredths / 100n;
  const frac = hundredths % 100n;
  if (frac === 0n) return `${whole} ETH`;
  const fracStr = (frac < 10n ? "0" : "") + frac.toString();
  const trimmed = fracStr.endsWith("0") ? fracStr.slice(0, 1) : fracStr;
  return `${whole}.${trimmed} ETH`;
}

function nextDenominationIndex(sumWei: bigint): number {
  return DENOMINATIONS.findIndex((denomination) => denomination > sumWei);
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
      className="play-tap"
      style={{
        ...mono,
        fontSize: small ? 10 : 11.5,
        letterSpacing: "0.04em",
        padding: small ? "5px 9px" : "8px 14px",
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

/** A rendered card, no border radius, no shadow, always exactly 2.5:3.5. */
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
  const interactive = onClick != null;
  const cardStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: 0,
    border: 0,
    position: "relative",
    aspectRatio: "2.5 / 3.5",
    background: C.art,
    overflow: "hidden",
    lineHeight: 0,
    cursor: interactive ? "pointer" : "default",
    outline: selected ? `2px solid ${C.ink}` : `1px solid ${C.border}`,
    outlineOffset: selected ? -2 : -1,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width }}>
      {interactive ? (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={selected === true}
          aria-label={typeof caption === "string" ? caption : undefined}
          className={`play-card-button${selected ? " play-card-selected" : ""}`}
          style={cardStyle}
          dangerouslySetInnerHTML={{ __html: forDisplay(svg) }}
        />
      ) : (
        <div style={cardStyle} dangerouslySetInnerHTML={{ __html: forDisplay(svg) }} />
      )}
      {caption !== undefined && (
        <div style={{ ...mono, fontSize: 9.5, letterSpacing: "0.04em", color: C.muted, textAlign: "center" }}>
          {caption}
        </div>
      )}
    </div>
  );
}

function DensityDeck({
  seed,
  selectedIndex,
  onSelect,
}: {
  seed: bigint;
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const cards = React.useMemo(
    () =>
      DENOMINATIONS.map((amountWei, index) => {
        const composition = composeShape(seed, amountWei, geneAtMint(seed, index), CANONICAL);
        return svgFromComposition(composition, 0n, CANONICAL, false);
      }),
    [seed],
  );

  return (
    <div className="play-density-scroll" aria-label="One seed across nine denominations">
      {cards.map((svg, index) => {
        const [cols, rows] = GRIDS[index];
        const marks = cols * rows;
        const active = selectedIndex === index;
        return (
          <button
            key={LABELS[index]}
            type="button"
            className={`play-density-card${active ? " play-density-card-active" : ""}`}
            aria-pressed={active}
            onClick={() => onSelect(index)}
          >
            <span
              className="play-density-art"
              dangerouslySetInnerHTML={{ __html: forDisplay(svg) }}
            />
            <span className="play-density-value">{LABELS[index]} ETH</span>
            <span className="play-density-grid">{cols}×{rows} · {marks} {marks === 1 ? "mark" : "marks"}</span>
          </button>
        );
      })}
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
  return <p style={{ ...mono, fontSize: 12, lineHeight: 1.6, color: C.body, margin: 0 }}>{children}</p>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ ...labelStyle, textTransform: "uppercase", marginBottom: 14 }}>{children}</div>;
}

/* ------------------------------------------------------------------ *
 * Beat 1: draw
 * ------------------------------------------------------------------ */

function DrawBeat({
  denomIndex,
  onDenomIndex,
  seedText,
  onSeedText,
  onRoll,
  effectiveSeed,
  onKeep,
  keepDisabled,
  inverted,
  onToggleInverted,
  drawMotionKey,
}: {
  denomIndex: number;
  onDenomIndex: (i: number) => void;
  seedText: string;
  onSeedText: (v: string) => void;
  onRoll: () => void;
  effectiveSeed: bigint;
  onKeep: () => void;
  keepDisabled: boolean;
  inverted: boolean;
  onToggleInverted: () => void;
  drawMotionKey: number;
}) {
  const amountWei = DENOMINATIONS[denomIndex];
  const composition = React.useMemo(
    () => composeShape(effectiveSeed, amountWei, geneAtMint(effectiveSeed, denomIndex), CANONICAL),
    [effectiveSeed, amountWei, denomIndex],
  );
  const svg = React.useMemo(() => svgFromComposition(composition, 0n, CANONICAL, false), [composition]);
  const [seedCopied, setSeedCopied] = React.useState(false);
  const [cols, rows] = GRIDS[denomIndex];
  const marks = cols * rows;

  React.useEffect(() => {
    if (!seedCopied) return;
    const timer = setTimeout(() => setSeedCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [seedCopied]);

  return (
    <section className="play-panel" id="draw">
      <div className="play-section-heading">
        <div>
          <SectionLabel>01 / Draw</SectionLabel>
          <h2 className="play-h2">One seed. Nine cards.</h2>
        </div>
      </div>

      <div className="play-draw-grid">
        <div className="play-hero-card">
          <div key={drawMotionKey} className="play-draft-card-motion">
            <RawCard svg={svg} width="100%" />
          </div>
          <div className="play-card-facts">
            <strong>{LABELS[denomIndex]} ETH</strong>
            <span>{cols}×{rows}</span>
            <span>{marks} {marks === 1 ? "mark" : "marks"}</span>
          </div>
        </div>

        <div className="play-draw-controls">
          <div>
            <div className="play-density-heading">
              <span>0.01 ETH · 25 marks</span>
              <span>100 ETH · 1 mark</span>
            </div>
            <DensityDeck seed={effectiveSeed} selectedIndex={denomIndex} onSelect={onDenomIndex} />
          </div>

          <div>
            <div className="play-control-label">Seed</div>
            <label className="play-seed-field">
              <span>Name or phrase</span>
              <input
                value={seedText}
                onChange={(e) => onSeedText(e.target.value)}
                placeholder="vitalik.eth"
                aria-label="Name or phrase"
              />
            </label>
            <div className="play-seed-actions">
              <PlayButton onClick={onRoll}>Roll</PlayButton>
              <button
                type="button"
                className="play-seed-copy play-tap"
                title={seedHex(effectiveSeed)}
                onClick={() => {
                  navigator.clipboard
                    .writeText(seedHex(effectiveSeed))
                    .then(() => setSeedCopied(true))
                    .catch(() => {});
                }}
              >
                {seedCopied ? "Seed copied" : truncateSeed(effectiveSeed)}
              </button>
            </div>
          </div>

          <button
            type="button"
            className="play-primary play-tap"
            onClick={onKeep}
            disabled={keepDisabled}
          >
            Keep card
          </button>
          {keepDisabled && (
            <div className="play-plain-message">
              The share link is full. Remove a card to continue.
            </div>
          )}

          <Prose>Simulation. Nothing is minted. No wallet is used. Real seeds are assigned at mint.</Prose>

          <details className="play-export">
            <summary>Export this draw</summary>
            <div className="play-export-actions">
              <PlayButton small onClick={() => downloadCardPng(composition, LABELS[denomIndex], effectiveSeed, inverted)}>
                Card PNG
              </PlayButton>
              <PlayButton small onClick={() => downloadLadderPng(effectiveSeed, inverted)}>
                Ladder PNG
              </PlayButton>
              <PlayButton small active={inverted} onClick={onToggleInverted}>
                {inverted ? "Inverted export" : "Invert export"}
              </PlayButton>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

/** "Copy link" plus a quiet confirmation. The page-level URL sync keeps `location.href` equal to
 *  `/play?s=<encodeSession(session)>` after every session change. */
function ShareLink() {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <details className="play-share-disclosure">
      <summary>Share this hand</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PlayButton
            small
            onClick={() => {
              navigator.clipboard
                .writeText(location.href)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            Copy link
          </PlayButton>
          {copied && <span style={{ ...mono, fontSize: 10, color: C.muted }}>Copied</span>}
        </div>
        <Prose>Hand and DNA are included.</Prose>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 2: tray
 * ------------------------------------------------------------------ */

/** Which card's inline tray menu is open, and which kind (the split tier picker or the
 *  sacrifice confirmation). Only one card's menu is open at a time. */
type TrayMenu = { key: number; kind: "split" | "sacrifice" } | null;

/** The one-row split tier picker: one button per denomination below the card, labeled with its
 *  child count. A tier is disabled, with the same "share link is full" reason `keepDisabled`
 *  uses, whenever splitting into it would push the session past what a share link can carry. */
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
    const opts: { i: number; count: number; shareable: boolean }[] = [];
    for (let i = 0; i < node.denomIndex; i++) {
      const count = Number(unitsAt(node.denomIndex) / unitsAt(i));
      let shareable: boolean;
      try {
        shareable = sessionShareable(splitNode(session, node.key, i));
      } catch {
        shareable = false;
      }
      opts.push({ i, count, shareable });
    }
    return opts;
  }, [node, session]);

  return (
    <div className="play-inline-menu" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6, width: 180 }}>
      <Prose>Backing divides exactly. Every child cell samples from the parent.</Prose>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {options.map(({ i, count, shareable }) => (
          <PlayButton key={i} small disabled={!shareable} onClick={() => onSplit(i)}>
            {LABELS[i]} ×{count}
          </PlayButton>
        ))}
      </div>
      {options.some((o) => !o.shareable) && (
        <div style={{ ...mono, fontSize: 10, color: C.muted }}>
          The share link is full. Remove a card to continue.
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
    <div className="play-inline-menu" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, width: 200 }}>
      <Prose>
        Sacrifice sends the Shape&apos;s 100 ETH to an address no one can spend from. The card stays
        Black. On chain this requires a complete 100 ETH Shape: 10,000 independent origins.
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
  selected,
  onToggle,
}: {
  node: PlayNode;
  selected: boolean;
  onToggle: (key: number) => void;
}) {
  const svg = svgFromComposition(nodeComposition(node), 0n, CANONICAL, node.black === true);
  return (
    <div className="play-hand-card">
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
    </div>
  );
}

function TraySelectionBar({
  node,
  session,
  menu,
  onOpenMenu,
  onSplit,
  onDecompose,
  onSacrifice,
  onRemove,
}: {
  node: PlayNode;
  session: PlaySession;
  menu: TrayMenu;
  onOpenMenu: (menu: TrayMenu) => void;
  onSplit: (key: number, childDenomIndex: number) => void;
  onDecompose: (key: number) => void;
  onSacrifice: (key: number) => void;
  onRemove: (key: number) => void;
}) {
  const isTop = node.denomIndex === DENOMINATIONS.length - 1;
  const showDecompose = node.trace != null;
  const showRemove = !showDecompose && node.splitTrace == null;
  const menuOpen = menu?.key === node.key ? menu.kind : null;
  const hasActions = node.denomIndex > 0 || showDecompose || isTop || showRemove;

  return (
    <div className="play-card-actions">
      <div className="play-card-actions-main">
        <div>
          <div className="play-control-label">Actions</div>
          <strong>#{node.demoId} · {LABELS[node.denomIndex]} ETH</strong>
        </div>
        <div className="play-action-buttons">
          {!hasActions && (
            <span className="play-plain-message">Split children stay together and cannot be removed one at a time.</span>
          )}
          {node.denomIndex > 0 && (
            <PlayButton small onClick={() => onOpenMenu(menuOpen === "split" ? null : { key: node.key, kind: "split" })}>
              Split
            </PlayButton>
          )}
          {showDecompose && (
            <PlayButton small onClick={() => onDecompose(node.key)}>
              Undo compose
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
          {showRemove && (
            <PlayButton small onClick={() => onRemove(node.key)}>
              Remove
            </PlayButton>
          )}
        </div>
      </div>
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
  const singleSelected = selected.size === 1
    ? nodes.find((node) => selected.has(node.key) && !node.black) ?? null
    : null;

  return (
    <section className="play-hand-panel" id="hand">
      <div className="play-section-heading">
        <div>
          <SectionLabel>02 / Your hand</SectionLabel>
          <h2 className="play-h2">Pick cards up.</h2>
        </div>
        <Prose>Tap cards to select them. Pick two or more to compose.</Prose>
      </div>
      {nodes.length === 0 ? (
        <div className="play-empty-hand">
          <span className="play-empty-slot" />
          <p>Keep a card above. It lands here.</p>
        </div>
      ) : (
        <>
          <div className="play-hand-scroll">
            {nodes.map((n, i) => (
              <div
                key={n.key}
                style={
                  { "--deal-delay": `${Math.min(i, 6) * 28}ms` } as React.CSSProperties &
                    Record<"--deal-delay", string>
                }
              >
                <TrayCard node={n} selected={selected.has(n.key)} onToggle={onToggle} />
              </div>
            ))}
          </div>
          {singleSelected && (
            <TraySelectionBar
              node={singleSelected}
              session={session}
              menu={menu}
              onOpenMenu={onOpenMenu}
              onSplit={onSplit}
              onDecompose={onDecompose}
              onSacrifice={onSacrifice}
              onRemove={onRemove}
            />
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 3: compose
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
 * keyframes with a per-cell `animation-delay`; no JS timers, nothing random. The same trace
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
  if (selectedNodes.length < 2) reason = "Select at least two cards.";
  else if (summedIndex < 0) {
    const nextIndex = nextDenominationIndex(sumWei);
    reason = nextIndex >= 0
      ? `${formatEth(sumWei)} is not a denomination. Add ${formatEth(DENOMINATIONS[nextIndex] - sumWei)} to reach ${LABELS[nextIndex]} ETH.`
      : `${formatEth(sumWei)} is not a denomination.`;
  } else if (!validAboveSurvivor && survivor) {
    reason = `The result must be above #${survivor.demoId}'s ${LABELS[survivor.denomIndex]} ETH rung.`;
  }

  const canCompose = reason === null;

  const resultLive = lastResult != null && nodes.some((node) => node.key === lastResult.key) ? lastResult : null;
  const resultComposition = React.useMemo(() => (resultLive ? nodeComposition(resultLive) : null), [resultLive]);
  // Exports of a black (sacrificed) result default to inverted, regardless of the manual toggle
  // below (which still lets a visitor invert a non-black result's exports).
  const effectiveInverted = inverted || resultLive?.black === true;

  const [gifBusy, setGifBusy] = React.useState<string | null>(null);
  if (nodes.length === 0 && !resultLive) return null;

  const handleGif = async () => {
    if (!resultLive) return;
    setGifBusy("rendering…");
    try {
      await downloadComposeGif(resultLive, LABELS[resultLive.denomIndex], effectiveInverted, (done, total) =>
        setGifBusy(`rendering ${done}/${total}…`),
      );
    } catch (e) {
      console.error("GIF export failed", e);
    } finally {
      setGifBusy(null);
    }
  };

  return (
    <section className="play-compose-panel" id="compose">
      <div className="play-compose-dock">
        <div className="play-compose-label">
          <SectionLabel>03 / Compose</SectionLabel>
          <strong>
            {selectedNodes.length} selected · {formatEth(sumWei)}
          </strong>
        </div>
        <div className="play-compose-outcome" aria-live="polite">
          {reason ? (
            <span>{reason}</span>
          ) : (
            <span>
              Makes {LABELS[summedIndex]} ETH · {GRIDS[summedIndex][0]}×{GRIDS[summedIndex][1]} · {GRIDS[summedIndex][0] * GRIDS[summedIndex][1]} marks
            </span>
          )}
        </div>
        <button
          type="button"
          className="play-compose-button play-tap"
          onClick={onCompose}
          disabled={!canCompose}
        >
          Compose
        </button>
      </div>
      {error && <div className="play-plain-message play-compose-error">{error}</div>}

      {resultLive && resultComposition && (
        <div key={resultLive.key} className="play-result-stage">
          <div className="play-result-card">
            <ComposeResultCard
              composition={resultComposition}
              trace={resultLive.trace ?? null}
              inverted={resultLive.black === true}
            />
          </div>
          <div className="play-result-copy">
            <SectionLabel>Result</SectionLabel>
            <h2 className="play-h2">Every cell chose a parent.</h2>
            <Prose>
              Built from {resultLive.parents?.length ?? 0} Shapes. Tap a cell below to inspect its DNA.
            </Prose>
            <details className="play-export">
              <summary>Export this result</summary>
              <div className="play-export-actions">
                <PlayButton
                  small
                  onClick={() => downloadCardPng(resultComposition, LABELS[resultLive.denomIndex], resultLive.seed, effectiveInverted)}
                >
                  Card PNG
                </PlayButton>
                <PlayButton
                  small
                  onClick={() => downloadSquarePng(resultComposition, LABELS[resultLive.denomIndex], resultLive.seed, effectiveInverted)}
                >
                  Square PNG
                </PlayButton>
                <PlayButton small disabled={gifBusy !== null} onClick={handleGif}>
                  {gifBusy ?? "Compose GIF"}
                </PlayButton>
                {!resultLive.black && (
                  <PlayButton small active={inverted} onClick={onToggleInverted}>
                    {inverted ? "Inverted export" : "Invert export"}
                  </PlayButton>
                )}
              </div>
            </details>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 4: lineage
 * ------------------------------------------------------------------ */

function LineageNode({
  node,
  byKey,
  focusedKey,
  onSelect,
}: {
  node: PlayNode;
  byKey: Map<number, PlayNode>;
  focusedKey: number | null;
  onSelect: (key: number) => void;
}) {
  const svg = svgFromComposition(nodeComposition(node), 0n, CANONICAL, node.black === true);
  const parents = (node.parents ?? []).map((k) => byKey.get(k)).filter((n): n is PlayNode => n != null);
  const selectable = node.trace != null || node.splitTrace != null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      {parents.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap", justifyContent: "center" }}>
            {parents.map((p) => (
              <LineageNode key={p.key} node={p} byKey={byKey} focusedKey={focusedKey} onSelect={onSelect} />
            ))}
          </div>
          <div style={{ width: 1, height: 14, background: C.border }} />
        </>
      )}
      <RawCard
        svg={svg}
        width={64}
        caption={`#${node.demoId}`}
        onClick={selectable ? () => onSelect(node.key) : undefined}
        selected={selectable && focusedKey === node.key}
      />
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
  const [pinnedDonorCell, setPinnedDonorCell] = React.useState<{ donorIndex: number; moduleIndex: number } | null>(
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
    const donorCell = hoverDonorCell ?? (active == null ? pinnedDonorCell : null);
    if (donorCell) {
      return new Set(resultCellsByDonorCell.get(`${donorCell.donorIndex}:${donorCell.moduleIndex}`) ?? []);
    }
    if (active != null) return new Set([active]);
    return new Set<number>();
  }, [hoverDonorCell, pinnedDonorCell, active, resultCellsByDonorCell]);

  const activeCell = active != null ? trace[active] : null;

  return (
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="play-result-dna-card" style={{ width: "min(280px, 80vw)" }}>
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
            onClickCell={(j) => {
              setPinnedDonorCell(null);
              onClickCell(j);
            }}
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

      <div className="play-donor-scroll">
        {donorNodes.map((d, i) => {
          const dc = nodeComposition(d);
          const dsvg = svgFromComposition(dc, 0n, CANONICAL, d.black === true);
          return (
            <div key={d.key} className="play-donor-card">
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
                  onClickCell={(j) => {
                    if (active != null) onClickCell(active);
                    const next = { donorIndex: i, moduleIndex: j };
                    setPinnedDonorCell((current) =>
                      current?.donorIndex === i && current.moduleIndex === j ? null : next,
                    );
                  }}
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
  const [pinnedParentCell, setPinnedParentCell] = React.useState<number | null>(null);

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
    const parentCell = hoverParentCell ?? (active == null ? pinnedParentCell : null);
    if (parentCell != null) return new Set(resultCellsByParentModule.get(parentCell) ?? []);
    if (active != null) return new Set([active]);
    return new Set<number>();
  }, [hoverParentCell, pinnedParentCell, active, resultCellsByParentModule]);

  const activeCell = active != null ? trace[active] : null;

  return (
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
      <div className="play-result-dna-card" style={{ width: "min(280px, 80vw)" }}>
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
            onClickCell={(j) => {
              setPinnedParentCell(null);
              onClickCell(j);
            }}
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
        <div className="play-donor-scroll">
          <div className="play-donor-card">
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
                onClickCell={(j) => {
                  if (active != null) onClickCell(active);
                  setPinnedParentCell((current) => current === j ? null : j);
                }}
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

function LineageBeat({ session }: { session: PlaySession }) {
  const byKey = React.useMemo(() => new Map(session.nodes.map((n) => [n.key, n])), [session.nodes]);
  const tips = liveNodes(session);
  const traceableTips = tips.filter((node) => node.trace != null || node.splitTrace != null);
  const mostRecentProduced = React.useMemo(() => {
    for (let i = session.nodes.length - 1; i >= 0; i--) {
      if (session.nodes[i].trace || session.nodes[i].splitTrace) return session.nodes[i];
    }
    return null;
  }, [session.nodes]);
  const [focusedKey, setFocusedKey] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (mostRecentProduced) setFocusedKey(mostRecentProduced.key);
  }, [mostRecentProduced?.key]);

  const focusedNode = focusedKey != null ? byKey.get(focusedKey) ?? null : null;
  if (traceableTips.length === 0) return null;

  return (
    <section className="play-dna-panel" id="dna">
      <div className="play-section-heading">
        <div>
          <SectionLabel>04 / DNA</SectionLabel>
          <h2 className="play-h2">Tap a cell. Find its parent.</h2>
        </div>
        <Prose>Compose and split leave a cell-by-cell family record.</Prose>
      </div>

      {traceableTips.length === 0 ? (
        <div className="play-dna-empty">
          <span>WAITING FOR A FAMILY</span>
          <p>Compose two or more cards, or split one card. The result and its trace will appear here.</p>
        </div>
      ) : (
        <>
          <div className="play-dna-tip-scroll" aria-label="Traceable cards">
            {traceableTips.map((tip) => {
              const svg = svgFromComposition(nodeComposition(tip), 0n, CANONICAL, tip.black === true);
              return (
                <button
                  key={tip.key}
                  type="button"
                  className={`play-dna-tip${focusedKey === tip.key ? " play-dna-tip-active" : ""}`}
                  aria-pressed={focusedKey === tip.key}
                  onClick={() => setFocusedKey(tip.key)}
                >
                  <span dangerouslySetInnerHTML={{ __html: forDisplay(svg) }} />
                  <small>#{tip.demoId} · {LABELS[tip.denomIndex]} ETH</small>
                </button>
              );
            })}
          </div>

          <div className="play-explorer-stage">
            <div className="play-control-label">
              {focusedNode?.trace ? "Compose provenance" : "Split provenance"}
            </div>
            {focusedNode && focusedNode.trace && <CellExplorer node={focusedNode} byKey={byKey} />}
            {focusedNode && focusedNode.splitTrace && <SplitCellExplorer node={focusedNode} byKey={byKey} />}
          </div>

          {focusedNode && (
            <details className="play-family-disclosure play-family-tree">
              <summary>Family tree</summary>
              <div className="play-family-tree-scroll">
                <LineageNode
                  node={focusedNode}
                  byKey={byKey}
                  focusedKey={focusedKey}
                  onSelect={setFocusedKey}
                />
              </div>
            </details>
          )}
        </>
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
  const [seedText, setSeedText] = React.useState("");
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [composeError, setComposeError] = React.useState<string | null>(null);
  const [hydrated, setHydrated] = React.useState(false);
  // Which tray card's split picker or sacrifice confirmation is open, if any.
  const [menu, setMenu] = React.useState<TrayMenu>(null);
  // Exports-only: Card/Square/Ladder PNG and GIF render inverted when set. On-page cards never
  // invert, so this never touches anything the visitor is looking at directly.
  const [inverted, setInverted] = React.useState(false);
  const [drawMotionKey, setDrawMotionKey] = React.useState(0);

  // Client-only setup on mount: roll the real starting seed (see the placeholder note above),
  // and restore session state from `?s=` if present. A state initializer would read `location`
  // and `crypto` during the server render and mismatch the client's first paint, so both run as
  // an effect instead. `hydrated` gates the write-back effect below until this has had a chance
  // to run first -- without it, the write-back effect's first pass (which still sees the
  // pre-restore empty session, since this effect's setSession hasn't committed yet) would strip
  // `?s=` from the URL before the restore ever reads it.
  React.useEffect(() => {
    setSeed(randomSeed());
    setDrawMotionKey((k) => k + 1);
    const encoded = new URLSearchParams(location.search).get("s");
    if (encoded) {
      const decoded = decodeSession(encoded);
      if (decoded.nodes.length > 0) setSession(decoded);
    }
    setHydrated(true);
  }, []);

  // Keep the URL in sync with the session: every action (keep, remove, compose) replaces the
  // `?s=` query so the address bar always reproduces the current state, with no navigation.
  React.useEffect(() => {
    if (!hydrated) return;
    const url = session.nodes.length > 0 ? `/play?s=${encodeSession(session)}` : "/play";
    history.replaceState(null, "", url);
  }, [hydrated, session]);

  const trimmedText = seedText.trim();
  const effectiveSeed = trimmedText ? textSeed(trimmedText) : seed;

  const nodes = liveNodes(session);
  // Keep is blocked only when the session it would produce no longer fits in a share link
  // (urlCodec's 64-op / 4KiB decode limits). This is the demo's one growth bound, unreachable in
  // normal play. keepCard is pure and cheap, so projecting it per render is fine.
  const keepDisabled = React.useMemo(
    () => !sessionShareable(keepCard(session, denomIndex, effectiveSeed, trimmedText || undefined)),
    [session, denomIndex, effectiveSeed, trimmedText],
  );

  const lastResult = React.useMemo(() => {
    for (let i = session.nodes.length - 1; i >= 0; i--) {
      if (session.nodes[i].trace) return session.nodes[i];
    }
    return null;
  }, [session.nodes]);

  const handleKeep = () => {
    if (keepDisabled) return;
    setSession(keepCard(session, denomIndex, effectiveSeed, trimmedText || undefined));
    // Advance the draft: a kept card stays in the tray, so the same seed has nothing more to
    // give (a text seed is fully determined by its text). Roll fresh for the next draw.
    setSeedText("");
    setSeed(randomSeed());
    setDrawMotionKey((k) => k + 1);
  };

  const handleToggle = (key: number) => {
    setComposeError(null);
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
      const next = splitNode(session, key, childDenomIndex);
      if (!sessionShareable(next)) return; // SplitPicker already disables this tier; ignore a stale click.
      setSession(next);
      setSelected((cur) => {
        if (!cur.has(key)) return cur;
        const nextSelected = new Set(cur);
        nextSelected.delete(key);
        return nextSelected;
      });
      setMenu(null);
    } catch (e) {
      console.error("split failed", e);
    }
  };

  const handleDecompose = (key: number) => {
    try {
      setSession(decomposeNode(session, key));
      setSelected((cur) => {
        if (!cur.has(key)) return cur;
        const nextSelected = new Set(cur);
        nextSelected.delete(key);
        return nextSelected;
      });
      setMenu(null);
    } catch (e) {
      console.error("decompose failed", e);
    }
  };

  const handleSacrifice = (key: number) => {
    try {
      setSession(sacrificeNode(session, key));
      setSelected((cur) => {
        if (!cur.has(key)) return cur;
        const nextSelected = new Set(cur);
        nextSelected.delete(key);
        return nextSelected;
      });
      setMenu(null);
    } catch (e) {
      console.error("sacrifice failed", e);
    }
  };

  const handleCompose = () => {
    try {
      const next = composeNodes(session, [...selected]);
      if (!sessionShareable(next)) {
        setComposeError("The share link is full. Remove a card first.");
        return;
      }
      setSession(next);
      setSelected(new Set());
      setComposeError(null);
    } catch (e) {
      setComposeError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ background: C.page, minHeight: "100vh", color: C.ink }}>
      <style>{`
        .play-shell, .play-shell * { box-sizing: border-box; }
        .play-shell { overflow-x: clip; }
        .play-shell button, .play-shell input { border-radius: 0; }
        .play-tap { min-height: 40px; }
        .play-panel {
          border-top: 1px solid ${C.rule};
          padding: 32px 0 44px;
        }
        .play-section-heading {
          display: flex;
          justify-content: space-between;
          align-items: end;
          gap: 24px;
          margin-bottom: 24px;
        }
        .play-h2 {
          font-family: ${FONT};
          color: ${C.ink};
          font-size: clamp(20px, 3vw, 30px);
          font-weight: 500;
          letter-spacing: -0.04em;
          line-height: 1.1;
          margin: 0;
        }
        .play-draw-grid {
          display: grid;
          grid-template-columns: minmax(230px, 320px) minmax(0, 1fr);
          gap: clamp(28px, 6vw, 72px);
          align-items: center;
        }
        .play-draw-grid > * { min-width: 0; }
        .play-hero-card { width: 100%; max-width: 320px; }
        .play-card-facts {
          display: grid;
          grid-template-columns: 1fr auto auto;
          gap: 14px;
          padding-top: 10px;
          color: ${C.muted};
          font-family: ${FONT};
          font-size: 10px;
        }
        .play-card-facts strong { color: ${C.ink}; font-weight: 500; }
        .play-draw-controls { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
        .play-control-label {
          color: ${C.muted};
          font-family: ${FONT};
          font-size: 10px;
          letter-spacing: 0.14em;
          margin-bottom: 8px;
          text-transform: uppercase;
        }
        .play-seed-field { display: flex; flex-direction: column; gap: 6px; }
        .play-seed-field span { color: ${C.body}; font-family: ${FONT}; font-size: 11px; }
        .play-seed-field input {
          width: 100%;
          min-height: 44px;
          border: 1px solid ${C.border};
          background: transparent;
          color: ${C.ink};
          font-family: ${FONT};
          font-size: 14px;
          padding: 10px 12px;
          outline: none;
        }
        .play-seed-field input:focus { border-color: ${C.ink}; }
        .play-seed-field input::placeholder { color: ${C.faint}; }
        .play-seed-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .play-seed-copy {
          border: 0;
          background: transparent;
          color: ${C.muted};
          cursor: pointer;
          font-family: ${FONT};
          font-size: 10px;
          padding: 6px 2px;
        }
        .play-primary {
          width: 100%;
          min-height: 52px;
          border: 1px solid ${C.ink};
          background: ${C.ink};
          color: ${C.page};
          cursor: pointer;
          font-family: ${FONT};
          font-size: 13px;
          letter-spacing: 0.04em;
          padding: 12px 16px;
        }
        .play-primary:disabled { cursor: default; opacity: 0.4; }
        .play-plain-message { color: ${C.muted}; font-family: ${FONT}; font-size: 10.5px; }
        .play-export { border-top: 1px solid ${C.ruleInner}; padding-top: 12px; }
        .play-export summary {
          color: ${C.muted};
          cursor: pointer;
          font-family: ${FONT};
          font-size: 10px;
          min-height: 40px;
          line-height: 40px;
        }
        .play-export-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 8px; }
        .play-density-heading {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          margin: 0 0 10px;
          color: ${C.muted};
          font-family: ${FONT};
          font-size: 9px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .play-density-scroll {
          display: grid;
          grid-auto-flow: column;
          grid-auto-columns: 64px;
          gap: 8px;
          overflow-x: auto;
          max-width: 100%;
          min-width: 0;
          overscroll-behavior-inline: contain;
          padding: 6px 2px 8px;
          overflow-y: hidden;
          scrollbar-color: ${C.border} transparent;
        }
        .play-density-card {
          display: flex;
          flex-direction: column;
          gap: 5px;
          min-width: 0;
          border: 1px solid transparent;
          background: transparent;
          color: ${C.body};
          cursor: pointer;
          padding: 5px;
          text-align: left;
          transition: transform 140ms cubic-bezier(.22,1,.36,1), border-color 120ms ease;
        }
        .play-density-card:hover { transform: translateY(-2px); }
        .play-density-card:focus-visible { outline: 2px solid ${C.ink}; outline-offset: 1px; }
        .play-density-card-active { border-color: ${C.ink}; transform: translateY(-4px); }
        .play-density-art {
          display: block;
          width: 100%;
          aspect-ratio: 2.5 / 3.5;
          background: ${C.art};
          line-height: 0;
          overflow: hidden;
          outline: 1px solid ${C.border};
          outline-offset: -1px;
        }
        .play-density-value, .play-density-grid { display: block; font-family: ${FONT}; white-space: nowrap; }
        .play-density-value { color: ${C.ink}; font-size: 8px; }
        .play-density-grid { color: ${C.muted}; font-size: 7px; }
        .play-card-button {
          width: 100%;
          transition: transform 180ms cubic-bezier(.22,1,.36,1), outline-color 120ms ease;
        }
        .play-card-button:focus-visible { outline: 2px solid ${C.ink} !important; outline-offset: 2px !important; }
        .play-card-button:disabled { opacity: 1; }
        .play-card-selected { transform: translateY(-8px) scale(1.015); }
        .play-card-button:not(:disabled):hover { transform: translateY(-3px); }
        .play-card-button.play-card-selected:hover { transform: translateY(-8px) scale(1.015); }
        .play-compose-button, .play-primary, .play-tap { transition: transform 120ms cubic-bezier(.22,1,.36,1); }
        .play-card-button:not(:disabled):active, .play-density-card:active, .play-dna-tip:active, .play-compose-button:active, .play-primary:active, .play-tap:active { transform: translateY(-1px) scale(.985); }
        .play-card-button.play-card-selected:active { transform: translateY(-8px) scale(1); }
        .play-draft-card-motion, .play-hand-card, .play-card-actions, .play-inline-menu, .play-result-stage { animation: none; }
        .play-hand-panel {
          border: 1px solid ${C.border};
          background: ${C.row};
          padding: 30px;
        }
        .play-hand-scroll {
          display: flex;
          gap: 14px;
          min-height: 218px;
          overflow-x: auto;
          overscroll-behavior-inline: contain;
          padding: 12px 2px 14px;
          scrollbar-color: ${C.border} transparent;
        }
        .play-hand-card { width: 132px; flex: 0 0 132px; }
        .play-empty-hand {
          min-height: 0;
          padding: 18px;
          border: 1px dashed ${C.border};
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 8px;
          color: ${C.muted};
          font-family: ${FONT};
          text-align: center;
        }
        .play-empty-slot { display: block; width: 64px; aspect-ratio: 2.5 / 3.5; border: 1px dashed ${C.border}; }
        .play-about-disclosure summary, .play-share-disclosure summary, .play-family-disclosure summary { min-height: 40px; line-height: 40px; cursor: pointer; }
        .play-about-disclosure { flex-basis: 100%; max-width: 760px; }
        .play-empty-hand span { font-size: 10px; letter-spacing: 0.14em; }
        .play-empty-hand p { color: ${C.bodyDim}; font-size: 11px; margin: 0; }
        .play-card-actions {
          border-top: 1px solid ${C.border};
          margin-top: 16px;
          padding-top: 16px;
        }
        .play-card-actions-main {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          align-items: center;
          font-family: ${FONT};
          font-size: 11px;
        }
        .play-card-actions-main strong { color: ${C.ink}; font-weight: 500; }
        .play-action-buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
        .play-share-row { margin-top: 24px; }
        .play-share-footer { border-top: 1px solid ${C.rule}; margin-top: 0; padding: 16px 0 24px; }
        .play-compose-panel { margin-bottom: 44px; }
        .play-compose-dock {
          display: grid;
          grid-template-columns: minmax(150px, 0.7fr) minmax(220px, 1.4fr) minmax(190px, 0.7fr);
          align-items: center;
          gap: 20px;
          border: 1px solid ${C.border};
          border-top: 0;
          padding: 20px 24px;
        }
        .play-compose-label { display: flex; flex-direction: column; gap: 3px; }
        .play-compose-label strong { color: ${C.ink}; font-family: ${FONT}; font-size: 12px; font-weight: 500; }
        .play-compose-outcome {
          color: ${C.bodyDim};
          font-family: ${FONT};
          font-size: 10.5px;
          line-height: 1.5;
        }
        .play-compose-button {
          min-height: 48px;
          border: 1px solid ${C.ink};
          background: ${C.ink};
          color: ${C.page};
          cursor: pointer;
          font-family: ${FONT};
          font-size: 11px;
          padding: 10px 12px;
        }
        .play-compose-button:disabled {
          border-color: ${C.border};
          background: transparent;
          color: ${C.faint};
          cursor: default;
        }
        .play-compose-error { border: 1px solid ${C.border}; border-top: 0; padding: 12px 24px; }
        .play-result-stage {
          display: grid;
          grid-template-columns: minmax(240px, 360px) minmax(260px, 1fr);
          align-items: center;
          gap: clamp(30px, 7vw, 76px);
          border: 1px solid ${C.border};
          border-top: 0;
          padding: clamp(28px, 5vw, 56px);
        }
        .play-result-card { width: 100%; }
        .play-result-copy { display: flex; flex-direction: column; gap: 14px; }
        .play-dna-panel {
          border-top: 1px solid ${C.rule};
          padding: 34px 0 48px;
        }
        .play-dna-empty {
          min-height: 210px;
          border: 1px dashed ${C.border};
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 10px;
          padding: 24px;
          color: ${C.muted};
          font-family: ${FONT};
          text-align: center;
        }
        .play-dna-empty span { font-size: 10px; letter-spacing: 0.14em; }
        .play-dna-empty p { max-width: 520px; margin: 0; color: ${C.bodyDim}; font-size: 11px; line-height: 1.6; }
        .play-dna-tip-scroll {
          display: flex;
          gap: 10px;
          overflow-x: auto;
          padding: 3px 2px 14px;
          scrollbar-color: ${C.border} transparent;
        }
        .play-dna-tip {
          flex: 0 0 86px;
          border: 1px solid transparent;
          background: transparent;
          color: ${C.muted};
          cursor: pointer;
          padding: 5px;
          text-align: center;
          transition: transform 140ms cubic-bezier(.22,1,.36,1), border-color 120ms ease;
        }
        .play-dna-tip:hover { transform: translateY(-2px); }
        .play-dna-tip-active { border-color: ${C.ink}; transform: translateY(-2px); }
        .play-dna-tip > span {
          display: block;
          width: 100%;
          aspect-ratio: 2.5 / 3.5;
          background: ${C.art};
          line-height: 0;
          overflow: hidden;
        }
        .play-dna-tip small { display: block; margin-top: 6px; font-family: ${FONT}; font-size: 8px; white-space: nowrap; }
        .play-explorer-stage {
          border: 1px solid ${C.border};
          padding: clamp(20px, 4vw, 36px);
        }
        .play-donor-scroll {
          display: flex;
          flex: 1 0 100%;
          gap: 16px;
          max-width: 100%;
          overflow-x: auto;
          padding: 2px 2px 12px;
          scrollbar-color: ${C.border} transparent;
        }
        .play-donor-card { flex: 0 0 280px; width: 280px; }
        .play-family-tree { border: 1px solid ${C.border}; border-top: 0; padding: 24px; }
        .play-family-tree-scroll { overflow-x: auto; padding: 12px 4px 4px; }

        /* Motion is opt-in for visitors who allow it. Default (and reduced-motion)
           state: no cover, no animation -- the plain finished card. Motion is opted back in only
           when the visitor hasn't asked to reduce it. */
        @keyframes playDraftSwap { from { opacity: .72; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes playDealIn { from { opacity: 0; transform: translateY(14px) scale(.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes playMenuIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes playResultIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes playRevealFade { from { opacity: 1 } to { opacity: 0 } }
        .play-reveal-cell {
          opacity: 0;
          animation-duration: 240ms;
          animation-timing-function: cubic-bezier(.22,1,.36,1);
          animation-fill-mode: forwards;
          animation-delay: calc(180ms + var(--cell-i, 0) * 28ms);
        }
        @media (prefers-reduced-motion: no-preference) {
          .play-draft-card-motion { animation: playDraftSwap 180ms cubic-bezier(.22,1,.36,1) both; }
          .play-hand-card { animation: playDealIn 240ms cubic-bezier(.22,1,.36,1) both; animation-delay: var(--deal-delay, 0ms); }
          .play-card-actions { animation: playMenuIn 180ms cubic-bezier(.22,1,.36,1) both; }
          .play-inline-menu { animation: playMenuIn 180ms cubic-bezier(.22,1,.36,1) both; }
          .play-result-stage { animation: playResultIn 260ms cubic-bezier(.22,1,.36,1) both; }
          .play-reveal-cell {
            opacity: 1;
            animation-name: playRevealFade;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .play-shell *, .play-shell *::before, .play-shell *::after { animation: none !important; transition: none !important; }
          .play-reveal-cell { opacity: 0; visibility: hidden; }
        }
        @media (max-width: 640px) {
          .play-panel { padding: 24px 0 34px; }
          .play-section-heading { align-items: start; flex-direction: column; gap: 8px; }
          .play-draw-grid { grid-template-columns: 1fr; }
          .play-hero-card { width: min(68vw, 260px); margin: 0 auto; }
          .play-density-scroll { grid-auto-columns: 84px; margin-right: -16px; padding-right: 16px; }
          .play-density-heading { font-size: 8px; }
          .play-hand-panel { margin: 0 -4px; padding: 22px 16px; }
          .play-hand-scroll { margin-right: -16px; padding-right: 16px; }
          .play-hand-card { width: 118px; flex-basis: 118px; }
          .play-card-actions-main { align-items: flex-start; flex-direction: column; }
          .play-action-buttons { justify-content: flex-start; width: 100%; }
          .play-compose-dock { grid-template-columns: 1fr; gap: 12px; padding: 18px 16px; }
          .play-compose-button { width: 100%; }
          .play-result-stage { grid-template-columns: 1fr; padding: 28px 16px; }
          .play-result-card { width: min(78vw, 320px); margin: 0 auto; }
          .play-dna-tip-scroll { margin-right: -16px; padding-right: 16px; }
          .play-explorer-stage { padding: 20px 12px; }
          .play-donor-scroll { margin-right: -12px; padding-right: 12px; }
          .play-donor-card { flex-basis: min(280px, 76vw); width: min(280px, 76vw); }
          .play-family-tree { padding: 20px 12px; }
        }
      `}</style>
      <div className="play-shell" style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 20px 80px" }}>
        <header style={{ marginBottom: 28 }}>
          <div style={{ ...mono, fontSize: 10, letterSpacing: "0.14em", color: C.muted, marginBottom: 10 }}>
            SHAPES / PLAY
          </div>
          <h1 style={{ ...mono, fontSize: "clamp(22px, 4vw, 42px)", lineHeight: 1.05, letterSpacing: "-0.045em", fontWeight: 500, color: C.ink, margin: "0 0 16px", maxWidth: 780 }}>
            More ETH. Fewer marks.
          </h1>
          <div style={{ maxWidth: 760 }}>
            <Prose>
              Draw a card, keep a few, compose one, then trace every cell.
            </Prose>
          </div>
        </header>

        <DrawBeat
          denomIndex={denomIndex}
          onDenomIndex={(index) => {
            setDenomIndex(index);
            setDrawMotionKey((k) => k + 1);
          }}
          seedText={seedText}
          onSeedText={setSeedText}
          onRoll={() => {
            setSeedText("");
            setSeed(randomSeed());
            setDrawMotionKey((k) => k + 1);
          }}
          effectiveSeed={effectiveSeed}
          onKeep={handleKeep}
          keepDisabled={keepDisabled}
          inverted={inverted}
          onToggleInverted={() => setInverted((v) => !v)}
          drawMotionKey={drawMotionKey}
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

        {nodes.length > 0 && (
          <div className="play-share-row play-share-footer">
            <ShareLink />
          </div>
        )}

        <footer style={{ ...mono, fontSize: 11, color: C.muted, display: "flex", flexWrap: "wrap", gap: "0 20px" }}>
          <a href="/how-it-works" style={{ color: C.muted }}>
            how it works
          </a>
          <a href={REPO_URL} style={{ color: C.muted }}>
            source
          </a>
          <details className="play-about-disclosure">
            <summary>About this simulation</summary>
            <Prose>This playground runs the same renderer and the same sampling procedure as the contract. A minted Shape with this seed at this denomination would be byte-identical.</Prose>
          </details>
        </footer>
      </div>
    </div>
  );
}
