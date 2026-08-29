/**
 * Playground exports: PNG (card / square / ladder) and GIF. Browser-only (canvas, Image, Blob).
 * PNG rasterization reuses `svgToImage` from `../app/exporters.ts` rather than duplicating it;
 * GIF assembly reuses `buildGif` from `../app/gif.ts`. Every export takes an `inverted` flag,
 * independent of the always-non-inverted on-page cards: exports build their own SVG at the
 * requested polarity rather than reusing a display SVG.
 */

import { CANONICAL } from "../canonical/params";
import { DENOMINATIONS } from "../canonical/denominations";
import { geneAtMint } from "../canonical/ink";
import { composeShape, svgFromComposition, type Composition } from "../canonical/render";
import { downloadBlob, svgToImage } from "../app/exporters";
import { buildGif } from "../app/gif";
import { nodeComposition, type PlayNode } from "./session";

const CARD_RATIO = 250 / 350; // width / height, exact 2.5:3.5

const GIF_WIDTH = 500;
const GIF_DELAY_CS = 9; // ~90ms per frame
const GIF_HOLD_FRAMES = 8;
const GIF_MAX_BYTES = 12 * 1024 * 1024;

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}

function seedHex8(seed: bigint): string {
  return seed.toString(16).padStart(64, "0").slice(0, 8);
}

/** `shape-<denomLabel>eth-<first 8 hex of seed>.png`, or the `square`/`ladder`/`gif` variants.
 *  Pure; the only extracted logic in this file worth a unit test on its own. */
export function exportFilename(
  kind: "card" | "square" | "ladder" | "gif",
  seed: bigint,
  denomLabel?: string,
): string {
  const hex = seedHex8(seed);
  if (kind === "ladder") return `shape-ladder-${hex}.png`;
  if (kind === "gif") return `shape-compose-${denomLabel}eth-${hex}.gif`;
  const prefix = kind === "square" ? "shape-square-" : "shape-";
  return `${prefix}${denomLabel}eth-${hex}.png`;
}

/** The card at `inverted`'s polarity, exact 2.5:3.5, at width 1000 (height 1400). No canvas
 *  fill: the SVG's own background rect covers the full frame, so drawing it at the target size
 *  is the whole job. */
export async function downloadCardPng(
  composition: Composition,
  denomLabel: string,
  seed: bigint,
  inverted = false,
): Promise<void> {
  const width = 1000;
  const height = Math.round(width / CARD_RATIO);
  const svg = svgFromComposition(composition, 0n, CANONICAL, inverted);
  const img = await svgToImage(svg);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
  downloadBlob(exportFilename("card", seed, denomLabel), await canvasToPng(canvas));
}

/** 1200x1200, the card centered at height 1080 (width 771), feed-friendly. Canvas background
 *  follows `inverted` so it stays flush with the card's own background. */
export async function downloadSquarePng(
  composition: Composition,
  denomLabel: string,
  seed: bigint,
  inverted = false,
): Promise<void> {
  const S = 1200;
  const cardH = 1080;
  const cardW = Math.round(cardH * CARD_RATIO);
  const svg = svgFromComposition(composition, 0n, CANONICAL, inverted);
  const img = await svgToImage(svg);
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = inverted ? "#ffffff" : "#000000";
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(img, (S - cardW) / 2, (S - cardH) / 2, cardW, cardH);
  downloadBlob(exportFilename("square", seed, denomLabel), await canvasToPng(canvas));
}

/** The given seed rendered at all nine denominations, left to right, one row. Each denomination
 *  draws its own ink gene via `geneAtMint`, matching a direct mint at that seed. Canvas
 *  background follows `inverted`. */
export async function downloadLadderPng(seed: bigint, inverted = false): Promise<void> {
  const cardW = 250;
  const cardH = Math.round(cardW / CARD_RATIO);
  const gap = Math.round(cardW * 0.04);
  const cols = DENOMINATIONS.length;
  const W = cols * cardW + (cols + 1) * gap;
  const H = cardH + 2 * gap;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = inverted ? "#ffffff" : "#000000";
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < cols; i++) {
    const composition = composeShape(seed, DENOMINATIONS[i], geneAtMint(seed, i), CANONICAL);
    const svg = svgFromComposition(composition, 0n, CANONICAL, inverted);
    const img = await svgToImage(svg);
    const x = gap + i * (cardW + gap);
    ctx.drawImage(img, x, gap, cardW, cardH);
  }

  downloadBlob(exportFilename("ladder", seed), await canvasToPng(canvas));
}

/**
 * Frame SVGs for a compose result's reveal GIF: frame 0 is the empty card, frames 1..N add one
 * cell per frame in trace/grid order (`composition.modules.slice(0, k)` on a shallow-copied
 * composition — `svgFromComposition` only reads `modules` for mark output, so slicing it alone
 * is enough), then `GIF_HOLD_FRAMES` copies of the finished card so the loop pauses before
 * repeating (the encoder's frame delay is global, so a hold is frames, not a longer delay).
 */
export function composeGifSvgs(node: PlayNode, inverted: boolean): string[] {
  const composition = nodeComposition(node);
  const n = composition.modules.length;
  const frames: string[] = [];
  for (let k = 0; k <= n; k++) {
    frames.push(
      svgFromComposition({ ...composition, modules: composition.modules.slice(0, k) }, 0n, CANONICAL, inverted),
    );
  }
  const finished = frames[frames.length - 1];
  for (let i = 0; i < GIF_HOLD_FRAMES; i++) frames.push(finished);
  return frames;
}

/** Build and download a compose result's progressive-reveal GIF. */
export async function downloadComposeGif(
  node: PlayNode,
  denomLabel: string,
  inverted: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const svgs = composeGifSvgs(node, inverted);
  const out = await buildGif(svgs, {
    width: GIF_WIDTH,
    delayCs: GIF_DELAY_CS,
    maxBytes: GIF_MAX_BYTES,
    onProgress,
  });
  downloadBlob(exportFilename("gif", node.seed, denomLabel), out.blob);
}
