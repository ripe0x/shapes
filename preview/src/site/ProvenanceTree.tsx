import React from "react";
import {FONT} from "./theme";
import {downloadTreePng, downloadTreeSvg} from "./treeExport";

/**
 * A single node in a provenance/ancestry tree, independent of any particular data source.
 * `art` is an image src (a data URI). `children` is oldest-toward-root order reversed: each
 * child is one step further back in ancestry than `node` itself.
 */
export interface TreeNode {
  key: string;
  art: string;
  title: string;
  /** Caption lines under the title, e.g. a denomination and a relation word. */
  lines: string[];
  children: TreeNode[];
  /** Renders as a "+N more" chip instead of a card; `children` is ignored when set. */
  rollup?: number;
  /** Renders the card dimmed with no expand control. */
  repeat?: boolean;
  /** Renders a "not expanded" hint under the card; `children` is ignored when set. */
  truncated?: boolean;
  muted?: boolean;
  /** Whether clicking the card calls `onSelect`. Default true. */
  selectable?: boolean;
}

const CARD_WIDTHS = [120, 76, 52, 36, 26, 20];
const STUB = 18;
// Depth at which a node auto-expands by default, and the depth from which a "collapse" control
// appears on an already-expanded node (collapsing the first couple of tiers would hide the tree
// as soon as it opens).
const AUTO_EXPAND_DEPTH = 3;
const COLLAPSE_MIN_DEPTH = 2;

// Layout constants shared with `layoutTree`, matching the CSS in `CSS_TEXT` below: card aspect
// ratio (`.prov-tree-card`), the gap from a card's image to its caption text and between caption
// lines (`.prov-tree-card-wrap`, `.prov-tree-caption`, `.prov-tree-title`/`.prov-tree-line`), the
// gap to the truncated hint (`.prov-tree-hint`), the horizontal gap between sibling subtrees (the
// child wrapper's left/right padding in `TreeCard`), and the gap between top-level roots
// (`.prov-tree-content`'s `gap`).
export const CARD_ASPECT = 3.5 / 2.5; // height / width, matching aspect-ratio: 2.5 / 3.5
export const CAPTION_GAP = 8; // 6px flex gap + 2px caption margin-top
export const CAPTION_LINE_H = 9.5 * 1.4; // font-size * line-height
export const HINT_GAP = 6;
export const HINT_H = 8.5 * 1.3; // approx: font-size * default line-height
const CHILD_GAP = 18; // 9px padding on each side of a child slot
const ROOT_GAP = 32; // .prov-tree-content gap
// A rollup chip's size is text-intrinsic on screen (no fixed width); this approximates it from
// its monospace character count rather than measuring the DOM, close enough for layout purposes.
const ROLLUP_CHAR_W = 6; // approx advance width of IBM Plex Mono at 10px
const ROLLUP_PAD_X = 14; // 7px padding each side
const ROLLUP_H = 26;

/** One positioned image card in a computed tree layout. */
export interface LayoutCard {
  node: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

/** One positioned "+N more" rollup chip in a computed tree layout. */
export interface LayoutRollup {
  node: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

/** A straight connector between a parent card's centre and one child's (or rollup chip's)
 *  centre. */
export interface LayoutConnector {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TreeLayout {
  width: number;
  height: number;
  cards: LayoutCard[];
  connectors: LayoutConnector[];
  rollups: LayoutRollup[];
}

interface Measured {
  node: TreeNode;
  depth: number;
  cardW: number;
  cardH: number;
  ownH: number; // card + caption + hint block height, excluding any children below it
  fullH: number; // ownH, plus expanded children's own drop and tallest subtree
  subtreeW: number; // horizontal footprint this node (and its expanded children) occupies
  expanded: boolean;
  children: Measured[]; // populated only when the node is expanded
  isRollup: boolean;
}

function captionHeight(node: TreeNode): number {
  let h = (1 + node.lines.length) * CAPTION_LINE_H;
  if (node.truncated) h += HINT_GAP + HINT_H;
  return h;
}

function measure(node: TreeNode, depth: number, expandedKeys: ReadonlySet<string>): Measured {
  if (node.rollup != null) {
    const w = `+${node.rollup} more`.length * ROLLUP_CHAR_W + ROLLUP_PAD_X + 2;
    return {node, depth, cardW: w, cardH: ROLLUP_H, ownH: ROLLUP_H, fullH: ROLLUP_H, subtreeW: w, expanded: false, children: [], isRollup: true};
  }
  const cardW = CARD_WIDTHS[Math.min(depth, CARD_WIDTHS.length - 1)];
  const cardH = cardW * CARD_ASPECT;
  const ownH = cardH + CAPTION_GAP + captionHeight(node);
  const hasChildren = !node.repeat && !node.truncated && node.children.length > 0;
  const expanded = hasChildren && expandedKeys.has(node.key);
  if (!expanded) {
    return {node, depth, cardW, cardH, ownH, fullH: ownH, subtreeW: cardW, expanded: false, children: [], isRollup: false};
  }
  const children = node.children.map((child) => measure(child, depth + 1, expandedKeys));
  const childrenW = children.reduce((sum, c) => sum + c.subtreeW, 0) + CHILD_GAP * Math.max(0, children.length - 1);
  const subtreeW = Math.max(cardW, childrenW);
  const fullH = ownH + 2 * STUB + Math.max(...children.map((c) => c.fullH));
  return {node, depth, cardW, cardH, ownH, fullH, subtreeW, expanded: true, children, isRollup: false};
}

function place(
  m: Measured,
  left: number,
  top: number,
  cards: LayoutCard[],
  connectors: LayoutConnector[],
  rollups: LayoutRollup[],
): void {
  const centerX = left + m.subtreeW / 2;
  const x = centerX - m.cardW / 2;
  if (m.isRollup) rollups.push({node: m.node, x, y: top, w: m.cardW, h: m.cardH, depth: m.depth});
  else cards.push({node: m.node, x, y: top, w: m.cardW, h: m.cardH, depth: m.depth});
  if (!m.expanded) return;

  const childTop = top + m.ownH + 2 * STUB;
  const childrenW = m.children.reduce((sum, c) => sum + c.subtreeW, 0) + CHILD_GAP * Math.max(0, m.children.length - 1);
  const parentCenter = {x: centerX, y: top + m.cardH / 2};
  let cursor = centerX - childrenW / 2;
  for (const child of m.children) {
    const childCenter = {x: cursor + child.subtreeW / 2, y: childTop + child.cardH / 2};
    connectors.push({x1: parentCenter.x, y1: parentCenter.y, x2: childCenter.x, y2: childCenter.y});
    place(child, cursor, childTop, cards, connectors, rollups);
    cursor += child.subtreeW + CHILD_GAP;
  }
}

/**
 * Pure layout for a provenance tree: every visible card and rollup chip's position and size, and
 * the connector line between each parent and its children, at 1 layout unit = 1px. Uses the same
 * constants (card widths, stub/gap distances) `ProvenanceTree` renders with, so the on-screen
 * tree and an export built from this layout never disagree. Only expanded nodes (per
 * `expandedKeys`) contribute children, matching what the component currently shows.
 */
export function layoutTree(root: TreeNode, expandedKeys: ReadonlySet<string>, extraRoots?: TreeNode[]): TreeLayout {
  const roots = extraRoots && extraRoots.length > 0 ? [root, ...extraRoots] : [root];
  const measured = roots.map((r) => measure(r, 0, expandedKeys));
  const cards: LayoutCard[] = [];
  const connectors: LayoutConnector[] = [];
  const rollups: LayoutRollup[] = [];
  let cursor = 0;
  for (const m of measured) {
    place(m, cursor, 0, cards, connectors, rollups);
    cursor += m.subtreeW + ROOT_GAP;
  }
  const width = Math.max(0, cursor - ROOT_GAP);
  const height = measured.length > 0 ? Math.max(...measured.map((m) => m.fullH)) : 0;
  return {width, height, cards, connectors, rollups};
}

/** Keys of every node within `maxDepth` generations of `root` that has children, expanded by
 *  default so a tree opens already showing its near ancestry. */
export function initialExpandedKeys(root: TreeNode, maxDepth = AUTO_EXPAND_DEPTH): Set<string> {
  const keys = new Set<string>();
  const visit = (node: TreeNode, depth: number) => {
    if (depth >= maxDepth || node.children.length === 0) return;
    keys.add(node.key);
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return keys;
}

/**
 * A provenance tree: layered ancestry cards with connector lines, panned and zoomed inside its
 * own viewport. `root` is the subject; `extraRoots`, when given, renders additional independent
 * trees beside it in the same viewport (a forest with no single common root).
 */
export function ProvenanceTree({
  root,
  extraRoots,
  focusedKey,
  onSelect,
  expandedKeys,
  onToggleExpanded,
  resetKey,
  exportBase,
}: {
  root: TreeNode;
  extraRoots?: TreeNode[];
  focusedKey: string | null;
  onSelect: (key: string) => void;
  expandedKeys: ReadonlySet<string>;
  onToggleExpanded: (key: string) => void;
  resetKey?: string | number;
  /** Download filename base (`treeExport.ts`'s `treeFilename` appends `-provenance.<ext>`). */
  exportBase: string;
}) {
  const roots = extraRoots && extraRoots.length > 0 ? [root, ...extraRoots] : [root];
  const layout = React.useMemo(() => layoutTree(root, expandedKeys, extraRoots), [root, expandedKeys, extraRoots]);
  return (
    <>
      <ProvTreeStyle />
      <ZoomableViewport
        resetKey={resetKey ?? root.key}
        onExportPng={() => void downloadTreePng(layout, {focusedKey}, exportBase)}
        onExportSvg={() => downloadTreeSvg(layout, {focusedKey}, exportBase)}
      >
        {roots.map((r) => (
          <TreeCard
            key={r.key}
            node={r}
            depth={0}
            focusedKey={focusedKey}
            onSelect={onSelect}
            expandedKeys={expandedKeys}
            onToggleExpanded={onToggleExpanded}
          />
        ))}
      </ZoomableViewport>
    </>
  );
}

function TreeCard({
  node,
  depth,
  focusedKey,
  onSelect,
  expandedKeys,
  onToggleExpanded,
}: {
  node: TreeNode;
  depth: number;
  focusedKey: string | null;
  onSelect: (key: string) => void;
  expandedKeys: ReadonlySet<string>;
  onToggleExpanded: (key: string) => void;
}) {
  const width = CARD_WIDTHS[Math.min(depth, CARD_WIDTHS.length - 1)];
  const selectable = node.selectable !== false;
  const hasChildren = !node.repeat && !node.truncated && node.children.length > 0;
  const expanded = expandedKeys.has(node.key);

  return (
    <div style={{display: "flex", flexDirection: "column", alignItems: "center"}}>
      <Card
        node={node}
        width={width}
        selected={selectable && focusedKey === node.key}
        onClick={selectable ? () => onSelect(node.key) : undefined}
      />
      {hasChildren && expanded && (
        <>
          <div style={{width: 1, height: STUB, background: "var(--border)"}} />
          <div style={{display: "flex", alignItems: "flex-start"}}>
            {node.children.map((child, index) => {
              const first = index === 0;
              const last = index === node.children.length - 1;
              const solo = node.children.length === 1;
              return (
                <div key={child.key} style={{position: "relative", padding: `${STUB}px 9px 0`}}>
                  {!solo && !first && (
                    <div style={{position: "absolute", top: 0, left: 0, width: "50%", height: 1, background: "var(--border)"}} />
                  )}
                  {!solo && !last && (
                    <div style={{position: "absolute", top: 0, left: "50%", width: "50%", height: 1, background: "var(--border)"}} />
                  )}
                  <div style={{position: "absolute", top: 0, left: "50%", width: 1, height: STUB, background: "var(--border)"}} />
                  {child.rollup != null ? (
                    <RollupChip node={child} />
                  ) : (
                    <TreeCard
                      node={child}
                      depth={depth + 1}
                      focusedKey={focusedKey}
                      onSelect={onSelect}
                      expandedKeys={expandedKeys}
                      onToggleExpanded={onToggleExpanded}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {hasChildren && !expanded && (
        <>
          <div style={{width: 1, height: STUB, background: "var(--border)"}} />
          <button type="button" className="prov-tree-rollup" onClick={() => onToggleExpanded(node.key)}>
            {node.children.length} {node.children.length === 1 ? "source" : "sources"}
          </button>
        </>
      )}
      {hasChildren && expanded && depth >= COLLAPSE_MIN_DEPTH && (
        <button type="button" className="prov-tree-collapse" onClick={() => onToggleExpanded(node.key)}>
          collapse
        </button>
      )}
    </div>
  );
}

function Card({
  node,
  width,
  selected,
  onClick,
}: {
  node: TreeNode;
  width: number;
  selected: boolean;
  onClick?: () => void;
}) {
  const image = (
    <div className={`prov-tree-card${selected ? " is-selected" : ""}${node.muted ? " is-muted" : ""}`}>
      <img src={node.art} alt="" />
    </div>
  );
  return (
    <div className="prov-tree-card-wrap" style={{width}}>
      {onClick ? (
        <button type="button" className="btn-ghost prov-tree-card-btn" onClick={onClick}>
          {image}
        </button>
      ) : (
        image
      )}
      <div className="prov-tree-caption">
        <div className="prov-tree-title">{node.title}</div>
        {node.lines.map((line, i) => (
          <div key={i} className="prov-tree-line">
            {line}
          </div>
        ))}
      </div>
      {node.truncated && (
        <div className="prov-tree-hint" title="earlier history not shown">
          not expanded
        </div>
      )}
    </div>
  );
}

function RollupChip({node}: {node: TreeNode}) {
  return (
    <div className="prov-tree-chip" title="additional contributors not expanded">
      +{node.rollup} more
    </div>
  );
}

function ZoomableViewport({
  children,
  resetKey,
  onExportPng,
  onExportSvg,
}: {
  children: React.ReactNode;
  resetKey: string | number;
  onExportPng: () => void;
  onExportSvg: () => void;
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState({x: 0, y: 0, scale: 1});
  const [dragging, setDragging] = React.useState(false);
  const dragRef = React.useRef<{pointerId: number; x: number; y: number; originX: number; originY: number} | null>(null);

  const fit = React.useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const contentWidth = content.scrollWidth;
    const contentHeight = content.scrollHeight;
    if (contentWidth === 0 || contentHeight === 0) return;
    const inset = 40;
    const scale = Math.min(1.25, (viewport.clientWidth - inset * 2) / contentWidth, (viewport.clientHeight - inset * 2) / contentHeight);
    const safeScale = Math.max(0.12, scale);
    setView({
      scale: safeScale,
      x: (viewport.clientWidth - contentWidth * safeScale) / 2,
      y: Math.max(inset, (viewport.clientHeight - contentHeight * safeScale) / 2),
    });
  }, []);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(frame);
  }, [fit, resetKey]);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit]);

  const zoomAtCenter = (factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const cx = viewport.clientWidth / 2;
    const cy = viewport.clientHeight / 2;
    setView((current) => {
      const scale = Math.min(2.5, Math.max(0.12, current.scale * factor));
      const ratio = scale / current.scale;
      return {scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio};
    });
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    setView((current) => {
      const factor = Math.exp(-event.deltaY * 0.0015);
      const scale = Math.min(2.5, Math.max(0.12, current.scale * factor));
      const ratio = scale / current.scale;
      return {scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio};
    });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: view.x, originY: view.y};
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => ({...current, x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y}));
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div className="prov-tree-frame">
      <div className="prov-tree-toolbar" aria-label="Provenance view controls">
        <button type="button" className="btn-outline prov-tree-toolbar-btn" onClick={() => zoomAtCenter(1.25)}>
          +
        </button>
        <button type="button" className="btn-outline prov-tree-toolbar-btn" onClick={() => zoomAtCenter(0.8)}>
          −
        </button>
        <button type="button" className="btn-outline prov-tree-toolbar-btn" onClick={fit}>
          Fit
        </button>
        <span>{Math.round(view.scale * 100)}%</span>
        <button type="button" className="btn-outline prov-tree-toolbar-btn" onClick={onExportPng}>
          PNG
        </button>
        <button type="button" className="btn-outline prov-tree-toolbar-btn" onClick={onExportSvg}>
          SVG
        </button>
      </div>
      <div
        ref={viewportRef}
        className={`prov-tree-viewport${dragging ? " is-dragging" : ""}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        <div ref={contentRef} className="prov-tree-content" style={{transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`}}>
          {children}
        </div>
      </div>
      <p className="prov-tree-help">Drag to pan · scroll to zoom</p>
    </div>
  );
}

const STYLE_ID = "prov-tree-style";

const CSS_TEXT = `
.prov-tree-frame {
  position: relative;
  margin: 24px 0 0;
}
.prov-tree-viewport {
  position: relative;
  height: clamp(440px, 62vh, 680px);
  overflow: hidden;
  border: 1px solid var(--rule);
  background-color: var(--page);
  background-image: radial-gradient(var(--rule) 0.7px, transparent 0.7px);
  background-size: 16px 16px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.prov-tree-viewport.is-dragging {
  cursor: grabbing;
}
.prov-tree-content {
  position: absolute;
  top: 0;
  left: 0;
  display: inline-flex;
  gap: 32px;
  width: max-content;
  align-items: flex-start;
  transform-origin: 0 0;
  will-change: transform;
}
.prov-tree-toolbar {
  position: absolute;
  z-index: 2;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px;
  border: 1px solid var(--rule);
  background: color-mix(in srgb, var(--page) 94%, transparent);
}
.prov-tree-toolbar > span {
  min-width: 38px;
  padding: 0 4px;
  font-family: ${FONT};
  font-size: 8.5px;
  color: var(--muted);
  text-align: right;
}
.prov-tree-toolbar-btn {
  font-family: ${FONT};
  font-size: 9.5px;
  letter-spacing: 0.06em;
  padding: 6px 9px;
}
.prov-tree-help {
  margin: 0;
  padding: 8px 12px;
  border: 1px solid var(--rule);
  border-top: 0;
  font-family: ${FONT};
  font-size: 8.5px;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.prov-tree-card-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.prov-tree-card-btn {
  display: block;
  width: 100%;
}
.prov-tree-card {
  position: relative;
  aspect-ratio: 2.5 / 3.5;
  overflow: hidden;
  background: var(--art);
  border: 1px solid var(--border);
  border-radius: 3px;
}
.prov-tree-card img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.prov-tree-card.is-selected {
  outline: 3px solid var(--page);
  outline-offset: -3px;
  box-shadow: 0 0 0 2px var(--ink);
}
.prov-tree-card.is-muted {
  opacity: 0.35;
}
.prov-tree-caption {
  margin-top: 2px;
  font-family: ${FONT};
  font-size: 9.5px;
  letter-spacing: 0.04em;
  line-height: 1.4;
  color: var(--muted);
  text-align: center;
}
.prov-tree-title {
  color: var(--ink);
}
.prov-tree-hint {
  font-family: ${FONT};
  font-size: 8.5px;
  color: var(--faint);
  text-align: center;
}
.prov-tree-chip {
  padding: 5px 7px;
  border: 1px solid var(--border);
  font-family: ${FONT};
  font-size: 10px;
  color: var(--faint);
  white-space: nowrap;
}
.prov-tree-rollup,
.prov-tree-collapse {
  font-family: ${FONT};
  color: var(--muted);
  background: transparent;
  cursor: pointer;
}
.prov-tree-rollup {
  padding: 5px 7px;
  border: 1px solid var(--border);
  font-size: 9px;
  letter-spacing: 0.04em;
}
.prov-tree-collapse {
  margin-top: 6px;
  padding: 0;
  border: 0;
  font-size: 8px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
@media (max-width: 620px) {
  .prov-tree-viewport {
    height: min(62vh, 520px);
  }
}
`;

function ProvTreeStyle() {
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  }, []);
  return null;
}
