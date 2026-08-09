/**
 * A GIF89a encoder for Shape cards.
 *
 * Written rather than imported: the artwork is black and white on a fixed canvas, so a
 * general-purpose encoder's colour quantisation and dithering are dead weight, and inlining a
 * dependency would bloat the single-file standalone preview.
 *
 * The palette is a grey ramp, not two colours. The *fills* are only ever black or white, but
 * the *edges* are not: every curve and diagonal depends on antialiasing to read as a smooth
 * line. Quantising to two colours throws all of that away and turns an arc into a staircase.
 * A 32-step ramp keeps the edges intact and costs little, because the interiors are still flat
 * runs of pure black and white that LZW eats for breakfast.
 *
 * Output is a strict GIF89a: global colour table, NETSCAPE2.0 looping extension, one graphic
 * control extension per frame carrying the delay, LZW image data in sub-blocks.
 */

const BLOCK_MAX = 255;

/* ------------------------------------------------------------------ *
 * bit and byte plumbing
 * ------------------------------------------------------------------ */

class ByteSink {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  private ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(v: number) {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  bytes(v: ArrayLike<number>) {
    this.ensure(v.length);
    for (let i = 0; i < v.length; i++) this.buf[this.len++] = v[i] & 0xff;
  }

  /** Little-endian uint16, which is the only multi-byte form GIF uses. */
  u16(v: number) {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  }

  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }

  get length() {
    return this.len;
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** LSB-first bit packer, which is what GIF's LZW stream expects. */
class BitWriter {
  private out: number[] = [];
  private cur = 0;
  private nbits = 0;

  write(code: number, size: number) {
    this.cur |= code << this.nbits;
    this.nbits += size;
    while (this.nbits >= 8) {
      this.out.push(this.cur & 0xff);
      this.cur >>>= 8;
      this.nbits -= 8;
    }
  }

  flush(): Uint8Array {
    if (this.nbits > 0) {
      this.out.push(this.cur & 0xff);
      this.cur = 0;
      this.nbits = 0;
    }
    return Uint8Array.from(this.out);
  }
}

/* ------------------------------------------------------------------ *
 * LZW
 * ------------------------------------------------------------------ */

/**
 * GIF-variant LZW.
 *
 * The code-size rule is the part worth stating explicitly, because it is exactly where
 * hand-rolled encoders go wrong. A GIF decoder's table lags the encoder's by one entry: it can
 * only add `(previous, firstChar(current))` once it has read the *current* code. So while the
 * encoder assigns code `2^codeSize` on emission n, the decoder does not reach that index until
 * it has processed emission n+1 — and widens only then.
 *
 * The encoder therefore widens one emission later than the naive reading suggests: after
 * assigning code `2^codeSize`, i.e. when `nextCode` becomes `2^codeSize + 1`. Widening a step
 * early desynchronises the two after roughly the first two hundred codes, which a decoder
 * reports as a truncated file.
 *
 * At 4096 the table is full and a clear code resets both sides.
 */
export function lzwEncode(pixels: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const bw = new BitWriter();

  let dict = new Map<number, number>();
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;

  const reset = () => {
    dict = new Map();
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };

  bw.write(clearCode, codeSize);

  if (pixels.length === 0) {
    bw.write(eoiCode, codeSize);
    return bw.flush();
  }

  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    // prefix < 4096 and k < 256, so this packs into one integer key
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }

    bw.write(prefix, codeSize);
    dict.set(key, nextCode);
    nextCode++;

    if (nextCode === 4096) {
      // table full: 4095 was the last assignable code
      bw.write(clearCode, codeSize);
      reset();
    } else if (nextCode === (1 << codeSize) + 1 && codeSize < 12) {
      codeSize++;
    }
    prefix = k;
  }

  bw.write(prefix, codeSize);
  bw.write(eoiCode, codeSize);
  return bw.flush();
}

/* ------------------------------------------------------------------ *
 * GIF assembly
 * ------------------------------------------------------------------ */

export interface GifOptions {
  width: number;
  height: number;
  /** Frame delay in hundredths of a second. 25 is 0.25s. */
  delayCs: number;
  /** 0 means loop forever. */
  loopCount?: number;
  /** Palette entries as [r,g,b]. Rounded up to a power of two, at least 2. */
  palette?: [number, number, number][];
}

/**
 * Assemble frames of palette indices into a GIF89a.
 *
 * Each frame must be `width * height` indices into the palette.
 */
export function encodeGif(frames: Uint8Array[], opts: GifOptions): Uint8Array {
  const { width, height, delayCs } = opts;
  const loopCount = opts.loopCount ?? 0;
  const palette = opts.palette ?? ([
    [0, 0, 0],
    [255, 255, 255],
  ] as [number, number, number][]);

  if (frames.length === 0) throw new Error("a GIF needs at least one frame");

  // GIF colour tables are sized 2^(n+1); n is stored in three bits.
  let tableBits = 0;
  while (1 << (tableBits + 1) < palette.length) tableBits++;
  const tableSize = 1 << (tableBits + 1);

  const minCodeSize = Math.max(2, tableBits + 1);

  const s = new ByteSink();

  s.ascii("GIF89a");

  // logical screen descriptor
  s.u16(width);
  s.u16(height);
  // global colour table present, colour resolution 8 bits, unsorted, size = tableBits
  s.byte(0x80 | 0x70 | tableBits);
  s.byte(0); // background colour index
  s.byte(0); // pixel aspect ratio, unspecified

  // global colour table, padded to its declared size
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] ?? [0, 0, 0];
    s.byte(c[0]);
    s.byte(c[1]);
    s.byte(c[2]);
  }

  // NETSCAPE2.0 application extension — the only way to say "loop"
  s.byte(0x21);
  s.byte(0xff);
  s.byte(11);
  s.ascii("NETSCAPE2.0");
  s.byte(3);
  s.byte(1);
  s.u16(loopCount);
  s.byte(0);

  for (const frame of frames) {
    if (frame.length !== width * height) {
      throw new Error(
        `frame has ${frame.length} pixels, expected ${width * height}`,
      );
    }

    // graphic control extension: no disposal, no transparency, just the delay
    s.byte(0x21);
    s.byte(0xf9);
    s.byte(4);
    s.byte(0x00);
    s.u16(delayCs);
    s.byte(0); // transparent colour index, unused
    s.byte(0);

    // image descriptor: full frame, no local colour table, not interlaced
    s.byte(0x2c);
    s.u16(0);
    s.u16(0);
    s.u16(width);
    s.u16(height);
    s.byte(0x00);

    s.byte(minCodeSize);
    const data = lzwEncode(frame, minCodeSize);
    for (let i = 0; i < data.length; i += BLOCK_MAX) {
      const chunk = data.subarray(i, Math.min(i + BLOCK_MAX, data.length));
      s.byte(chunk.length);
      s.bytes(chunk);
    }
    s.byte(0); // block terminator
  }

  s.byte(0x3b); // trailer
  return s.toUint8Array();
}

/* ------------------------------------------------------------------ *
 * Rasterising a card
 * ------------------------------------------------------------------ */

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

/** An evenly spaced black-to-white ramp. */
export function grayPalette(levels: number): [number, number, number][] {
  const n = Math.max(2, Math.min(256, levels));
  return Array.from({ length: n }, (_, i) => {
    const v = Math.round((i * 255) / (n - 1));
    return [v, v, v] as [number, number, number];
  });
}

/**
 * The canonical SVG carries `width="250" height="350"`, which is its intrinsic size. Drawing
 * that image scaled up makes the browser rasterise the vector at 250x350 and then enlarge the
 * bitmap — so a "500px" frame really carries 250px of detail. Rewriting the attributes makes
 * the vector rasterise at the size actually wanted. The viewBox is untouched, so the geometry
 * is identical; only the raster resolution changes.
 */
function svgAtSize(svg: string, w: number, h: number): string {
  return svg.replace('width="250" height="350"', `width="${w}" height="${h}"`);
}

export interface RasterOptions {
  /** Grey levels in the palette. */
  levels?: number;
  /** Render this many times larger, then box down. 2 is plenty for hard-edged geometry. */
  supersample?: number;
}

/**
 * Rasterise one card to palette indices.
 *
 * Two things matter for how this looks. The vector is rasterised at the output size rather
 * than scaled up from its intrinsic 250x350, and it is rendered at `supersample` times that
 * and resampled down, which gives cleaner edges than the browser's own antialiasing alone.
 */
export async function rasterToIndices(
  svg: string,
  width: number,
  height: number,
  opts: RasterOptions = {},
): Promise<Uint8Array> {
  const levels = Math.max(2, Math.min(256, opts.levels ?? 32));
  const ss = Math.max(1, Math.min(4, opts.supersample ?? 2));

  const sw = width * ss;
  const sh = height * ss;

  const img = await svgToImage(svgAtSize(svg, sw, sh));

  const hi = document.createElement("canvas");
  hi.width = sw;
  hi.height = sh;
  const hctx = hi.getContext("2d")!;
  hctx.fillStyle = "#000";
  hctx.fillRect(0, 0, sw, sh);
  hctx.drawImage(img, 0, 0, sw, sh);

  let src: HTMLCanvasElement = hi;
  if (ss !== 1) {
    const lo = document.createElement("canvas");
    lo.width = width;
    lo.height = height;
    const lctx = lo.getContext("2d", { willReadFrequently: true })!;
    lctx.imageSmoothingEnabled = true;
    lctx.imageSmoothingQuality = "high";
    lctx.drawImage(hi, 0, 0, width, height);
    src = lo;
  }

  const ctx = src.getContext("2d", { willReadFrequently: true })!;
  const { data } = ctx.getImageData(0, 0, width, height);
  const out = new Uint8Array(width * height);
  const top = levels - 1;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const y = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
    out[i] = Math.round((y / 255) * top);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The whole job
 * ------------------------------------------------------------------ */

export interface BuildGifOptions {
  /** Frame width in pixels. Height follows the 2.5:3.5 card. */
  width?: number;
  delayCs?: number;
  maxBytes?: number;
  /** Grey levels. More is smoother on curves; fewer is smaller. */
  levels?: number;
  /** Render multiple, then resample down. */
  supersample?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * How a card becomes palette indices. Defaults to canvas rasterisation; injectable so the
   * size-capping loop can be tested off a DOM, with frames chosen to defeat compression.
   */
  rasterize?: (svg: string, w: number, h: number) => Promise<Uint8Array>;
}

export interface BuildGifResult {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  frames: number;
  /** Set when the requested width had to be reduced to fit `maxBytes`. */
  scaledFrom?: number;
}

const CARD_RATIO = 350 / 250;

/**
 * Rasterise, encode, and shrink until it fits.
 *
 * Two-colour frames compress so well that the cap is rarely in play — a hundred 500px frames
 * land around a megabyte — but a large enough selection will reach it, and silently handing
 * back a 30MB file would be worse than scaling down and saying so.
 */
export async function buildGif(
  svgs: string[],
  opts: BuildGifOptions = {},
): Promise<BuildGifResult> {
  const delayCs = opts.delayCs ?? 25;
  const maxBytes = opts.maxBytes ?? 12 * 1024 * 1024;
  const levels = Math.max(2, Math.min(256, opts.levels ?? 32));
  const palette = grayPalette(levels);
  const rasterize =
    opts.rasterize ??
    ((svg: string, w: number, h: number) =>
      rasterToIndices(svg, w, h, { levels, supersample: opts.supersample }));
  let width = Math.round(opts.width ?? 500);
  const requested = width;

  for (let attempt = 0; attempt < 8; attempt++) {
    const height = Math.round(width * CARD_RATIO);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < svgs.length; i++) {
      frames.push(await rasterize(svgs[i], width, height));
      opts.onProgress?.(i + 1, svgs.length);
    }

    const bytes = encodeGif(frames, { width, height, delayCs, loopCount: 0, palette });
    if (bytes.length <= maxBytes || width <= 80) {
      return {
        blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/gif" }),
        width,
        height,
        bytes: bytes.length,
        frames: frames.length,
        scaledFrom: width === requested ? undefined : requested,
      };
    }

    // overshoot: scale by the ratio we need, with a margin, and try again
    const ratio = Math.sqrt(maxBytes / bytes.length) * 0.95;
    width = Math.max(80, Math.floor(width * Math.min(ratio, 0.9)));
  }

  throw new Error("could not fit the selection under the size limit");
}
