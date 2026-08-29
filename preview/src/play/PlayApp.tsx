import React from "react";
import { C, FONT, label as labelStyle } from "../site/theme";
import { forDisplay, C as PROV_C } from "../app/ui";
import { donorColor, GridOverlayCells, byteHex, useActiveCell } from "../app/provenance";
import { CANONICAL } from "../canonical/params";
import { composeShape, svgFromComposition, type Composition } from "../canonical/render";
import { WAD } from "../canonical/wad";
import type { ComposeTraceCell } from "../canonical/sampling";
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
 * The Playground (`/play`): a chain-free demo of the two ideas the collection is built on —
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
          outline: selected ? `2px solid ${C.ink}` : `1px solid ${C.border}`,
          outlineOffset: selected ? -2 : -1,
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
  return <p style={{ ...mono, fontSize: 12, lineHeight: 1.6, color: C.body, margin: 0 }}>{children}</p>;
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
  seedText,
  onSeedText,
  onRoll,
  effectiveSeed,
  onKeep,
  keepDisabled,
  inverted,
  onToggleInverted,
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
}) {
  const amountWei = DENOMINATIONS[denomIndex];
  // The gene a kept card of this seed/denomination would get (session.keepCard uses the same call).
  const composition = React.useMemo(
    () => composeShape(effectiveSeed, amountWei, geneAtMint(effectiveSeed, denomIndex), CANONICAL),
    [effectiveSeed, amountWei, denomIndex],
  );

  const svg = React.useMemo(() => svgFromComposition(composition, 0n, CANONICAL, false), [composition]);

  return (
    <section style={sectionStyle}>
      <SectionLabel>Draw</SectionLabel>
      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ width: "min(320px, 80vw)" }}>
          <RawCard svg={svg} width="100%" />
          <div style={{ ...mono, fontSize: 9.5, color: C.muted, marginTop: 8, wordBreak: "break-all" }}>
            {seedHex(effectiveSeed)}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 260, flex: 1 }}>
          <div>
            <div style={{ ...mono, fontSize: 10, color: C.muted, marginBottom: 8 }}>denomination</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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

          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <PlayButton onClick={onRoll}>Roll</PlayButton>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ ...mono, fontSize: 10, color: C.muted }}>Seed it with a name</span>
              <input
                value={seedText}
                onChange={(e) => onSeedText(e.target.value)}
                placeholder="a name, handle, anything"
                style={{
                  ...mono,
                  fontSize: 12,
                  padding: "7px 9px",
                  border: `1px solid ${C.border}`,
                  background: "transparent",
                  color: C.ink,
                  width: 220,
                }}
              />
            </label>
          </div>

          <PlayButton onClick={onKeep} disabled={keepDisabled}>
            Keep
          </PlayButton>
          {keepDisabled && (
            <div style={{ ...mono, fontSize: 10.5, color: C.muted }}>
              The share link is full. Remove a card to continue.
            </div>
          )}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
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

          <Prose>Simulation. Nothing is minted. No wallet is used. Real seeds are assigned at mint.</Prose>
        </div>
      </div>
    </section>
  );
}

/** "Copy link" plus a quiet confirmation. Copies `location.href`, which the page-level URL-sync
 *  effect keeps equal to `/play?s=<encodeSession(session)>` at all times. No animation here: the
 *  compose reveal is the only animation this page runs. */
function ShareLink() {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
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
        {copied && <span style={{ ...mono, fontSize: 10, color: C.muted }}>copied</span>}
      </div>
      <Prose>This link reproduces it exactly.</Prose>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 2 — tray
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
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6, width: 180 }}>
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
  // Split children have no remove control: a split encodes as one atomic URL op, so a missing
  // sibling could not be reproduced by a share link (removeNode rejects them too).
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
            color: C.ink,
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
    <section style={sectionStyle}>
      <SectionLabel>
        Tray ({nodes.length})
      </SectionLabel>
      {nodes.length === 0 ? (
        <div style={{ ...mono, fontSize: 11, color: C.muted }}>—</div>
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
      {nodes.length > 0 && <ShareLink />}
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
    <section style={sectionStyle}>
      <SectionLabel>Compose</SectionLabel>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{ ...mono, fontSize: 11, color: C.body }}>
          {selectedNodes.length} selected · {formatEth(sumWei)}
        </div>
        {reason && <div style={{ ...mono, fontSize: 11, color: C.muted }}>{reason}</div>}
        {!reason && summedIndex >= 0 && (
          <div style={{ ...mono, fontSize: 11, color: C.body }}>
            → {LABELS[summedIndex]} ETH ({GRIDS[summedIndex][0]}×{GRIDS[summedIndex][1]})
          </div>
        )}
        <PlayButton onClick={onCompose} disabled={!canCompose}>
          Compose
        </PlayButton>
      </div>
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
          <div style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
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
  const parentComposition = nodeComposition(parent);
  const parentSvg = React.useMemo(
    () => svgFromComposition(parentComposition, 0n, CANONICAL, parent.black === true),
    [parentComposition, parent.black],
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
            label={`#${parent.demoId}`}
            moduleIndex={activeCell.moduleIndex}
            byte={activeCell.byte}
            color={SPLIT_COLOR}
          />
        )}
      </div>

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
            <div dangerouslySetInnerHTML={{ __html: forDisplay(parentSvg) }} />
            <GridOverlayCells
              cols={parentComposition.cols}
              rows={parentComposition.rows}
              cell={parentComposition.cell}
              x0={parentComposition.x0}
              y0={parentComposition.y0}
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
            #{parent.demoId}
          </div>
        </div>
      </div>
    </div>
  );
}

function LineageBeat({ session }: { session: PlaySession }) {
  const byKey = React.useMemo(() => new Map(session.nodes.map((n) => [n.key, n])), [session.nodes]);
  const tips = liveNodes(session);
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

  if (tips.length === 0) return null;

  return (
    <section style={sectionStyle}>
      <SectionLabel>Lineage</SectionLabel>
      <Prose>This session&apos;s compose and split history.</Prose>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "18px 0 28px" }}>
        {tips.map((tip) => (
          <LineageNode key={tip.key} node={tip} byKey={byKey} focusedKey={focusedKey} onSelect={setFocusedKey} />
        ))}
      </div>
      {focusedNode && focusedNode.trace && <CellExplorer node={focusedNode} byKey={byKey} />}
      {focusedNode && focusedNode.splitTrace && <SplitCellExplorer node={focusedNode} byKey={byKey} />}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

const sectionStyle: React.CSSProperties = {
  borderTop: `1px solid ${C.rule}`,
  paddingTop: 28,
  marginBottom: 44,
};

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
  // (urlCodec's 64-op / 4KiB decode limits) — the demo's one growth bound, unreachable in
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
      const next = splitNode(session, key, childDenomIndex);
      if (!sessionShareable(next)) return; // SplitPicker already disables this tier; ignore a stale click.
      setSession(next);
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
      `}</style>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 20px 80px" }}>
        <header style={{ marginBottom: 40 }}>
          <div style={{ ...mono, fontSize: 10, letterSpacing: "0.14em", color: C.muted, marginBottom: 10 }}>
            PLAYGROUND
          </div>
          <h1 style={{ ...mono, fontSize: 18, fontWeight: 500, color: C.ink, margin: "0 0 14px" }}>
            Draw a Shape. Compose Shapes. Trace every cell to a parent.
          </h1>
          <Prose>
            This playground runs the same renderer and the same sampling procedure as the contract. A minted
            Shape with this seed at this denomination would be byte-identical.
          </Prose>
        </header>

        <DrawBeat
          denomIndex={denomIndex}
          onDenomIndex={setDenomIndex}
          seedText={seedText}
          onSeedText={setSeedText}
          onRoll={() => {
            setSeedText("");
            setSeed(randomSeed());
          }}
          effectiveSeed={effectiveSeed}
          onKeep={handleKeep}
          keepDisabled={keepDisabled}
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

        <footer style={{ ...mono, fontSize: 11, color: C.muted, display: "flex", gap: 20 }}>
          <a href="/how-it-works" style={{ color: C.muted }}>
            how it works
          </a>
          <a href={REPO_URL} style={{ color: C.muted }}>
            source
          </a>
        </footer>
      </div>
    </div>
  );
}
