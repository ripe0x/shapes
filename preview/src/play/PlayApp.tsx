import React from "react";
import { C, FONT, label as labelStyle } from "../site/theme";
import { forDisplay } from "../app/ui";
import { donorColor, GridOverlayCells, byteHex, useActiveCell } from "../app/provenance";
import { CANONICAL } from "../canonical/params";
import { composeShape, svgFromComposition, type Composition } from "../canonical/render";
import { composeSampledShape } from "../canonical/sampling";
import { DENOMINATIONS, GRIDS, LABELS, UNIT } from "../canonical/denominations";
import { geneAtMint } from "../canonical/ink";
import { decodeModuleByte } from "../canonical/moduleCodec";
import {
  composeNodes,
  composeSummedIndex,
  emptySession,
  keepCard,
  liveNodes,
  randomSeed,
  removeNode,
  textSeed,
  TRAY_CAP,
  type PlayNode,
  type PlaySession,
} from "./session";
import { decodeSession, encodeSession } from "./urlCodec";
import { downloadCardPng, downloadLadderPng, downloadSquarePng } from "./exports";

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

/** A session node's rendered composition: sampled from its stored bytes if composed, otherwise
 *  drawn fresh from its seed. */
function nodeComposition(node: PlayNode): Composition {
  if (node.modules) return composeSampledShape(node.modules, node.denomIndex, node.inkGene, CANONICAL);
  return composeShape(node.seed, DENOMINATIONS[node.denomIndex], node.inkGene, CANONICAL);
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
}: {
  denomIndex: number;
  onDenomIndex: (i: number) => void;
  seedText: string;
  onSeedText: (v: string) => void;
  onRoll: () => void;
  effectiveSeed: bigint;
  onKeep: () => void;
  keepDisabled: boolean;
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

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <PlayButton small onClick={() => downloadCardPng(svg, LABELS[denomIndex], effectiveSeed)}>
              Card PNG
            </PlayButton>
            <PlayButton small onClick={() => downloadLadderPng(effectiveSeed)}>
              Ladder PNG
            </PlayButton>
          </div>

          <Prose>Simulation. Nothing is minted. No wallet is used. Real seeds are assigned at mint.</Prose>
        </div>
      </div>
    </section>
  );
}

/** "Copy link" plus a quiet fading confirmation. Copies `location.href`, which the page-level
 *  URL-sync effect keeps equal to `/play?s=<encodeSession(session)>` at all times. */
function ShareLink() {
  const [copied, setCopied] = React.useState(false);
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
        {copied && (
          <span
            key={Date.now()}
            style={{ ...mono, fontSize: 10, color: C.muted, animation: "playFadeIn 320ms ease" }}
            onAnimationEnd={() => setTimeout(() => setCopied(false), 1200)}
          >
            copied
          </span>
        )}
      </div>
      <Prose>This link reproduces it exactly.</Prose>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 2 — tray
 * ------------------------------------------------------------------ */

function TrayBeat({
  nodes,
  selected,
  onToggle,
  onRemove,
}: {
  nodes: PlayNode[];
  selected: Set<number>;
  onToggle: (key: number) => void;
  onRemove: (key: number) => void;
}) {
  return (
    <section style={sectionStyle}>
      <SectionLabel>
        Tray ({nodes.length}/{TRAY_CAP})
      </SectionLabel>
      {nodes.length === 0 ? (
        <div style={{ ...mono, fontSize: 11, color: C.muted }}>—</div>
      ) : (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
          {nodes.map((n) => {
            const svg = svgFromComposition(nodeComposition(n), 0n, CANONICAL, false);
            return (
              <div key={n.key} style={{ position: "relative", width: 92 }}>
                <RawCard
                  svg={svg}
                  width="100%"
                  selected={selected.has(n.key)}
                  onClick={() => onToggle(n.key)}
                  caption={`#${n.demoId} · ${LABELS[n.denomIndex]} ETH`}
                />
                <button
                  onClick={() => onRemove(n.key)}
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
              </div>
            );
          })}
        </div>
      )}
      {nodes.length > 0 && <ShareLink />}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Beat 3 — compose
 * ------------------------------------------------------------------ */

function ComposeBeat({
  nodes,
  selected,
  onCompose,
  error,
  lastResult,
}: {
  nodes: PlayNode[];
  selected: Set<number>;
  onCompose: () => void;
  error: string | null;
  lastResult: PlayNode | null;
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

      {lastResult && (
        <div key={lastResult.key} style={{ display: "flex", flexDirection: "column", gap: 8, animation: "playFadeIn 320ms ease" }}>
          <div style={{ width: "min(320px, 80vw)" }}>
            <RawCard svg={svgFromComposition(nodeComposition(lastResult), 0n, CANONICAL, false)} width="100%" />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <PlayButton
              small
              onClick={() =>
                downloadCardPng(
                  svgFromComposition(nodeComposition(lastResult), 0n, CANONICAL, false),
                  LABELS[lastResult.denomIndex],
                  lastResult.seed,
                )
              }
            >
              Card PNG
            </PlayButton>
            <PlayButton
              small
              onClick={() =>
                downloadSquarePng(
                  svgFromComposition(nodeComposition(lastResult), 0n, CANONICAL, false),
                  LABELS[lastResult.denomIndex],
                  lastResult.seed,
                )
              }
            >
              Square PNG
            </PlayButton>
          </div>
          <Prose>
            Composed from {lastResult.parents?.length ?? 0} Shapes. Every cell sampled from a parent.
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
  const svg = svgFromComposition(nodeComposition(node), 0n, CANONICAL, false);
  const parents = (node.parents ?? []).map((k) => byKey.get(k)).filter((n): n is PlayNode => n != null);
  const selectable = node.trace != null;
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
  const svg = React.useMemo(() => svgFromComposition(composition, 0n, CANONICAL, false), [composition]);
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
          const dsvg = svgFromComposition(dc, 0n, CANONICAL, false);
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

function LineageBeat({ session }: { session: PlaySession }) {
  const byKey = React.useMemo(() => new Map(session.nodes.map((n) => [n.key, n])), [session.nodes]);
  const tips = liveNodes(session);
  const mostRecentComposed = React.useMemo(() => {
    for (let i = session.nodes.length - 1; i >= 0; i--) {
      if (session.nodes[i].trace) return session.nodes[i];
    }
    return null;
  }, [session.nodes]);
  const [focusedKey, setFocusedKey] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (mostRecentComposed) setFocusedKey(mostRecentComposed.key);
  }, [mostRecentComposed?.key]);

  const focusedNode = focusedKey != null ? byKey.get(focusedKey) ?? null : null;

  if (tips.length === 0) return null;

  return (
    <section style={sectionStyle}>
      <SectionLabel>Lineage</SectionLabel>
      <Prose>This session&apos;s compose history.</Prose>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", margin: "18px 0 28px" }}>
        {tips.map((tip) => (
          <LineageNode key={tip.key} node={tip} byKey={byKey} focusedKey={focusedKey} onSelect={setFocusedKey} />
        ))}
      </div>
      {focusedNode && focusedNode.trace && <CellExplorer node={focusedNode} byKey={byKey} />}
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
  const keepDisabled = nodes.length >= TRAY_CAP;

  const lastResult = React.useMemo(() => {
    for (let i = session.nodes.length - 1; i >= 0; i--) {
      if (session.nodes[i].trace) return session.nodes[i];
    }
    return null;
  }, [session.nodes]);

  const handleKeep = () => {
    try {
      setSession((s) => keepCard(s, denomIndex, effectiveSeed, trimmedText || undefined));
    } catch {
      // tray full; Keep is already disabled in this case.
    }
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
    <div style={{ background: C.page, minHeight: "100vh", color: C.ink }}>
      <style>{`@keyframes playFadeIn { from { opacity: 0 } to { opacity: 1 } }`}</style>
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
        />

        <TrayBeat nodes={nodes} selected={selected} onToggle={handleToggle} onRemove={handleRemove} />

        <ComposeBeat
          nodes={nodes}
          selected={selected}
          onCompose={handleCompose}
          error={composeError}
          lastResult={lastResult}
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
