/**
 * Shape Packs presentation: a TypeScript port of `ShapePackRenderer.sol` (draw-packs /
 * shape-packs repositories; the two hold the same renderer source).
 *
 * Same fan layout, same integer arithmetic, same string assembly. `scripts/checkMainnet.ts`
 * asserts byte-identical `tokenURI` output against a live Packs contract.
 *
 * `contractURI` is not ported: its illustrative image is seeded from the block, so it has no
 * fixed output to match.
 *
 * Callers supply JSON-safe `tokenNamePrefix` and `description`, as `ShapePacks` does on chain.
 */

import { getAddress } from "viem";
import { denominationIndex } from "./denominations";
import { base64Utf8, idMark, renderShape } from "./render";
import { renderSampledShape } from "./sampling";
import { CANONICAL } from "./params";
import { fmt } from "./wad";

/** The `ShapeState` fields the pack image reads for one face. */
export interface PackCard {
  seed: bigint;
  faceValueWei: bigint;
  isBlack: boolean;
  inkGene: number;
  /** Materialized module bytes; empty for a token drawn from its seed. */
  modules: Uint8Array;
}

/** Mirrors `PackRenderInput` in `IShapePackRenderer.sol`. */
export interface PackRenderInput {
  packId: bigint;
  shapeCount: bigint;
  valueWei: bigint;
  unitWei: bigint;
  /** Shapes per ladder index, same length as `denominations`. */
  counts: readonly number[];
  denominations: readonly bigint[];
  /** Shapes the pack minted itself. */
  mintedCount: bigint;
  creator: `0x${string}`;
  /** Highest backing first, then token id; at most twelve are drawn. */
  topCards: readonly PackCard[];
  tokenNamePrefix: string;
  description: string;
}

const CANVAS = 3840;
const CENTER = CANVAS / 2;
const MAX_CARDS = 12;
const THIRD_TIER_STEP = 170;
const SIX_PACK_FRONT_WIDTH = 966;
const SEVEN_PACK_FRONT_WIDTH = 1005;
const ADDED_OUTER_STEP = 180;

interface CardSlot {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: string;
}

/** Solidity uint division. Every operand here is a small non-negative integer. */
const div = (a: number, b: number): number => Math.floor(a / b);

/** The pack SVG: a fan of up to twelve Shapes faces, highest backing on top. */
export function renderPack(cards: readonly PackCard[]): string {
  return stack(cards.slice(0, MAX_CARDS).map(artwork));
}

/** The raw metadata JSON `ShapePackRenderer.metadataJSON` returns. */
export function packMetadataJson(input: PackRenderInput): string {
  return (
    `{"name":"${fmt(input.valueWei)} ETH · ${input.tokenNamePrefix}${idMark(input.tokenNamePrefix)}${input.packId}",` +
    `"description":"${input.description} ${makeup(input)}",` +
    `"image":"data:image/svg+xml;base64,${base64Utf8(renderPack(input.topCards))}",` +
    `"attributes":[${attributes(input)}]}`
  );
}

/** `data:application/json;base64,...`, as `ShapePackRenderer.tokenURI` returns it. */
export function packTokenURI(input: PackRenderInput): string {
  return `data:application/json;base64,${base64Utf8(packMetadataJson(input))}`;
}

/** `3 x 0.01 ETH, 1 x 0.05 ETH. 0.08 ETH total.` */
function makeup(input: PackRenderInput): string {
  const parts: string[] = [];
  input.counts.forEach((count, d) => {
    if (count !== 0) parts.push(`${count} x ${fmt(input.denominations[d])} ETH`);
  });
  return `${parts.join(", ")}. ${fmt(input.valueWei)} ETH total.`;
}

/** Shapes, Value, Units, one row per held denomination, Source, Creator. */
function attributes(input: PackRenderInput): string {
  let out =
    `{"trait_type":"Shapes","value":${input.shapeCount}},` +
    `{"trait_type":"Value","value":"${fmt(input.valueWei)} ETH"},` +
    `{"display_type":"number","trait_type":"Units","value":${input.valueWei / input.unitWei}}`;
  input.counts.forEach((count, d) => {
    if (count !== 0) out += `,{"trait_type":"${fmt(input.denominations[d])} ETH","value":${count}}`;
  });
  const source =
    input.mintedCount === input.shapeCount ? "Minted" : input.mintedCount === 0n ? "Packed" : "Mixed";
  return (
    out +
    `,{"trait_type":"Source","value":"${source}"}` +
    `,{"trait_type":"Creator","value":"${getAddress(input.creator)}"}`
  );
}

/** One face: sampled modules when present, else the seed. The token id never reaches the SVG. */
function artwork(card: PackCard): string {
  if (card.modules.length !== 0) {
    const denomIndex = denominationIndex(card.faceValueWei);
    if (denomIndex < 0) throw new Error(`unsupported denomination: ${card.faceValueWei}`);
    return renderSampledShape(card.modules, denomIndex, 0n, card.inkGene, CANONICAL, card.isBlack);
  }
  return renderShape(card.seed, card.faceValueWei, 0n, card.inkGene, CANONICAL, card.isBlack);
}

/** Lower-value cards are drawn first, so the highest-backed face sits on top. */
function stack(cards: readonly string[]): string {
  const n = cards.length;
  let body = open(n === 0 ? 1 : n);
  if (n === 0) body += card(0, 1, "");
  else for (let i = n; i > 0; --i) body += card(i - 1, n, cards[i - 1]);
  return body + "</svg>";
}

/** Odd fans centre the front face and extend smaller faces in left/right pairs. */
function slot(rank: number, n: number): CardSlot {
  if (n % 2 === 0) return evenSlot(rank, n);

  const pairs = div(n, 2);
  const stepPercent = n > 7 ? 50 : 65 - pairs * 5;
  let frontWidth = pairs === 0 ? 1600 : div((CANVAS - 240) * 100, pairs * stepPercent * 2 + 58);
  if (frontWidth > 1600) frontWidth = 1600;
  if (n > 7) frontWidth = SEVEN_PACK_FRONT_WIDTH;
  const frontHeight = div(frontWidth * 7, 5);
  const baseline = div(CANVAS + frontHeight, 2);
  if (rank === 0) {
    return {
      width: frontWidth,
      height: frontHeight,
      x: CENTER - div(frontWidth, 2),
      y: baseline - frontHeight,
      angle: "-1",
    };
  }
  const pair = div(rank + 1, 2);
  const width = div(frontWidth * (pair === 1 ? 75 : 58), 100);
  const height = div(width * 7, 5);
  let offset = div(frontWidth * stepPercent * (pairs === 1 ? 4 : 3), 400);
  if (pair > 1) offset += THIRD_TIER_STEP;
  if (pair > 2) offset += (pair - 2) * ADDED_OUTER_STEP;
  const right = rank % 2 === 1;
  return {
    width,
    height,
    x: right ? CENTER + offset - div(width, 2) : CENTER - offset - div(width, 2),
    y: baseline - height,
    angle: right ? String(11 - pair * 2) : neg(13 - pair * 2),
  };
}

/** Even fans keep the six-card face sizes beyond six; each outer pair adds a fixed step. */
function evenSlot(rank: number, n: number): CardSlot {
  const pairs = div(n, 2);
  let frontWidth =
    n === 2 ? 1450 : div((CANVAS - 400) * 100, 2 * (39 + (pairs - 1) * 55) + (pairs === 2 ? 75 : 58));
  if (n > 6) frontWidth = SIX_PACK_FRONT_WIDTH;
  const pair = div(rank, 2);
  const right = rank % 2 === 1;
  const width = pair === 0 ? frontWidth : div(frontWidth * (pair === 1 ? 75 : 58), 100);
  const height = div(width * 7, 5);
  let offset = div(frontWidth * 570, 1450);
  if (pair !== 0) {
    offset += div(frontWidth * 165, 400);
    if (pair > 1) offset += THIRD_TIER_STEP;
    if (pair > 2) offset += (pair - 2) * ADDED_OUTER_STEP;
  }
  let angle: string;
  if (pair === 0) angle = right ? "5" : "-5";
  else angle = right ? String(11 - pair * 2) : neg(13 - pair * 2);
  return {
    width,
    height,
    x: right ? CENTER + offset - div(width, 2) : CENTER - offset - div(width, 2),
    y: div(CANVAS + div(frontWidth * 7, 5), 2) - height,
    angle,
  };
}

/** Transparent canvas, the shared shadow filter and one rounded clip per face. */
function open(cardCount: number): string {
  let out =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3840 3840" width="3840" height="3840"' +
    ' shape-rendering="geometricPrecision"><defs>' +
    '<filter id="d" x="-15%" y="-15%" width="130%" height="130%">' +
    '<feDropShadow dx="0" dy="0" stdDeviation="44" flood-color="#000" flood-opacity="0.22"/></filter>';
  for (let i = 0; i < cardCount; ++i) {
    out += `<clipPath id="c${i}"><rect width="2000" height="2800" rx="40"/></clipPath>`;
  }
  return out + "</defs>";
}

/** A 2000x2800 Shapes SVG scaled into its slot without distortion. */
function card(rank: number, n: number, art: string): string {
  const s = slot(rank, n);
  return (
    `<g transform="translate(${s.x},${s.y}) rotate(${s.angle} ${div(s.width, 2)} ${div(s.height, 2)})">` +
    `<rect width="${s.width}" height="${s.height}" rx="${div(s.width, 50)}" fill="#000" filter="url(#d)"/>` +
    `<svg width="${s.width}" height="${s.height}" viewBox="0 0 2000 2800">` +
    `<g clip-path="url(#c${rank})">${art}</g></svg></g>`
  );
}

/** `-magnitude`, or `0` for zero. */
function neg(magnitude: number): string {
  return magnitude === 0 ? "0" : `-${magnitude}`;
}
