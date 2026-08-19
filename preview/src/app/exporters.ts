/**
 * Export paths for the preview harness: individual SVGs, a store-only ZIP, a
 * contact sheet PNG, and the fixture JSON that becomes the Solidity parity
 * corpus.
 */

import {
  composeShape,
  renderShape,
  moduleSequence,
  renderGeometry,
  tokenMetadataJson,
} from "../canonical/render";
import { fmt } from "../canonical/wad";
import { LABELS } from "../canonical/denominations";
import type { Params } from "../canonical/params";
import { shortHash } from "../analysis";
import { mintGene } from "../previewGene";

/* ---------------- download helpers ---------------- */

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(name: string, text: string, mime = "text/plain") {
  downloadBlob(name, new Blob([text], { type: mime }));
}

/* ---------------- minimal store-only ZIP ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Uncompressed ZIP. Adequate for a few hundred small SVG files. */
export function makeZip(files: { name: string; text: string }[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const cat = (parts: Uint8Array[]) => {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);
    const local = cat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    chunks.push(local);
    central.push(
      cat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    );
    offset += local.length;
  }

  const centralBytes = cat(central);
  const end = cat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0),
  ]);

  return new Blob([cat(chunks), centralBytes, end], {
    type: "application/zip",
  });
}

/* ---------------- contact sheet ---------------- */

function svgToImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export async function contactSheetPng(
  svgs: string[],
  cols: number,
  cardW = 250,
): Promise<Blob> {
  const cardH = (cardW * 350) / 250;
  const gap = Math.round(cardW * 0.06);
  const rows = Math.ceil(svgs.length / cols);
  const W = cols * cardW + (cols + 1) * gap;
  const H = rows * cardH + (rows + 1) * gap;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f0efec";
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < svgs.length; i++) {
    const img = await svgToImage(svgs[i]);
    const x = gap + (i % cols) * (cardW + gap);
    const y = gap + Math.floor(i / cols) * (cardH + gap);
    ctx.drawImage(img, x, y, cardW, cardH);
  }

  return await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/png"),
  );
}

/* ---------------- fixtures ---------------- */

export interface Fixture {
  tokenId: string;
  seed: string;
  amountWei: string;
  amountLabel: string;
  cols: number;
  rows: number;
  cell: string;
  fill: string;
  wRatio: string;
  target: string;
  modules: string;
  moduleCount: number;
  svgHash: string;
  svg: string;
  metadata: string;
}

export function buildFixture(
  seed: bigint,
  amountWei: bigint,
  tokenId: bigint,
  p?: Params,
): Fixture {
  const c = composeShape(seed, amountWei, mintGene(seed, amountWei), p);
  const svg = renderShape(seed, amountWei, tokenId, mintGene(seed, amountWei), p);
  return {
    tokenId: tokenId.toString(),
    seed: "0x" + seed.toString(16).padStart(64, "0"),
    amountWei: amountWei.toString(),
    amountLabel: LABELS[c.denomIndex] + " ETH",
    cols: c.cols,
    rows: c.rows,
    cell: fmt(c.cell),
    fill: fmt(c.fill),
    wRatio: fmt(c.wRatio),
    target: fmt(c.target),
    modules: moduleSequence(c),
    moduleCount: c.cols * c.rows,
    svgHash: shortHash(renderGeometry(seed, amountWei, mintGene(seed, amountWei), p)),
    svg,
    metadata: tokenMetadataJson(
      seed,
      amountWei,
      tokenId,
      1n,
      false,
      mintGene(seed, amountWei),
      0n,
      p,
    ),
  };
}

export function fixtureFilename(f: Fixture) {
  return `shape-${f.amountLabel.replace(/[ .]/g, "_")}-${f.tokenId}.svg`;
}
