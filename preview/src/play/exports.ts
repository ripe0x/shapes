/**
 * Playground PNG exports. Browser-only (canvas, Image, Blob): rasterizes a card SVG the same way
 * `../app/exporters.ts`'s `contactSheetPng` does (`svgToImage`, reused from there rather than
 * duplicated), at the fixed sizes this file defines, and hands the result to `downloadBlob`.
 */

import { CANONICAL } from "../canonical/params";
import { DENOMINATIONS } from "../canonical/denominations";
import { geneAtMint } from "../canonical/ink";
import { composeShape, svgFromComposition } from "../canonical/render";
import { downloadBlob, svgToImage } from "../app/exporters";

const CARD_RATIO = 250 / 350; // width / height, exact 2.5:3.5

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}

function seedHex8(seed: bigint): string {
  return seed.toString(16).padStart(64, "0").slice(0, 8);
}

/** `shape-<denomLabel>eth-<first 8 hex of seed>.png`, or the `square`/`ladder` variants. Pure;
 *  the only extracted logic in this file worth a unit test on its own. */
export function exportFilename(kind: "card" | "square" | "ladder", seed: bigint, denomLabel?: string): string {
  const hex = seedHex8(seed);
  if (kind === "ladder") return `shape-ladder-${hex}.png`;
  const prefix = kind === "square" ? "shape-square-" : "shape-";
  return `${prefix}${denomLabel}eth-${hex}.png`;
}

/** The current card, exact 2.5:3.5, at width 1000 (height 1400). No canvas fill: the SVG's own
 *  black rect covers the full frame, so drawing it at the target size is the whole job. */
export async function downloadCardPng(svg: string, denomLabel: string, seed: bigint): Promise<void> {
  const width = 1000;
  const height = Math.round(width / CARD_RATIO);
  const img = await svgToImage(svg);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
  downloadBlob(exportFilename("card", seed, denomLabel), await canvasToPng(canvas));
}

/** 1200x1200 on black, the card centered at height 1080 (width 771), feed-friendly. */
export async function downloadSquarePng(svg: string, denomLabel: string, seed: bigint): Promise<void> {
  const S = 1200;
  const cardH = 1080;
  const cardW = Math.round(cardH * CARD_RATIO);
  const img = await svgToImage(svg);
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(img, (S - cardW) / 2, (S - cardH) / 2, cardW, cardH);
  downloadBlob(exportFilename("square", seed, denomLabel), await canvasToPng(canvas));
}

/** The given seed rendered at all nine denominations, left to right, one row on black. Each
 *  denomination draws its own ink gene via `geneAtMint`, matching a direct mint at that seed. */
export async function downloadLadderPng(seed: bigint): Promise<void> {
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
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < cols; i++) {
    const composition = composeShape(seed, DENOMINATIONS[i], geneAtMint(seed, i), CANONICAL);
    const svg = svgFromComposition(composition, 0n, CANONICAL, false);
    const img = await svgToImage(svg);
    const x = gap + i * (cardW + gap);
    ctx.drawImage(img, x, gap, cardW, cardH);
  }

  downloadBlob(exportFilename("ladder", seed), await canvasToPng(canvas));
}
