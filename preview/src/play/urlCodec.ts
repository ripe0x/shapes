/**
 * Playground URL state codec. Pure, no React, no DOM APIs beyond TextEncoder/TextDecoder (both
 * available in browsers, Node, and Next's `nodejs` route runtime, so this file works unmodified
 * server-side in `web/app/og/play/route.tsx`).
 *
 * The session IS the op log: `encodeSession` walks `session.nodes` in creation order (the
 * invariant `session.ts` documents) and emits one op per node — a card op for an original card,
 * a compose op for a compose result. `decodeSession` replays those ops through `keepCard`/
 * `composeNodes`, so the reconstructed session is produced by the exact same state machine that
 * built the original, not a separate deserializer.
 *
 * Wire shape: `{v: 1, ops: OpJson[]}`, JSON -> UTF-8 -> base64url (no padding). Card op:
 * `{c: {d, t?, s?}}` (denomIndex, and exactly one of seed text / 64-hex-char seed). Compose op:
 * `{x: number[]}`, the participant ids in canonical donor order (survivor first).
 *
 * Compose participant ids are NOT the raw `PlayNode.demoId` field. `demoId` is a session-wide
 * counter that a removed card leaves a gap in (`removeNode` drops the node but never rewinds
 * `nextDemoId`), while a fresh replay's `keepCard` calls only ever run for cards that still exist
 * and so never reproduces that gap. Encoding raw `demoId` would make `decodeSession` unable to
 * resolve a compose op's participants whenever a card was removed earlier in the session, and it
 * would fail closed on an otherwise-valid session. `replayIds` below recomputes the same
 * gap-free numbering a replay produces (sequential over card ops in creation order; a compose
 * result inherits its survivor's id), so encode and decode always agree.
 *
 * One consequence: if a card was removed earlier in the session, a decoded node's `demoId` (and
 * a decoded compose result's `trace[].donorId`, which embeds the burn's token id as a display
 * string) can come out relabeled relative to the original session -- e.g. "#3" where the
 * original showed "#4" because "#2" was removed and its number was never reused. The actual
 * artwork is unaffected: `sampleComposeTraced` draws its entropy from donor seeds, never token
 * ids, so every sampled byte, donor index, and module index reproduces exactly regardless of
 * relabeling.
 */

import { DENOMINATIONS } from "../canonical/denominations";
import {
  composeNodes,
  emptySession,
  keepCard,
  liveNodes,
  textSeed,
  type PlayNode,
  type PlaySession,
} from "./session";

const MAX_ENCODED_BYTES = 4096;
const MAX_OPS = 64;
const MAX_SEED_TEXT_LEN = 128;
const SEED_HEX_RE = /^[0-9a-f]{64}$/;

interface CardOpJson {
  c: { d: number; t?: string; s?: string };
}
interface ComposeOpJson {
  x: number[];
}
type OpJson = CardOpJson | ComposeOpJson;

interface WireJson {
  v: 1;
  ops: OpJson[];
}

/* ---------------- base64url, byte-oriented (no atob/btoa: those take strings, and Node's
 * `nodejs` route runtime discourages Buffer-specific code paths shared with browser code) ---- */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_REV[B64[i]] = i;

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(triplet >> 18) & 63];
    out += B64[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triplet >> 6) & 63] : "";
    out += i + 2 < bytes.length ? B64[triplet & 63] : "";
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

/** Returns null on any malformed input (wrong alphabet, invalid length). */
function base64UrlToBytes(text: string): Uint8Array | null {
  if (text.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = base64.length % 4;
  if (remainder === 1) return null;
  const outLen = Math.floor(base64.length / 4) * 3 + (remainder === 0 ? 0 : remainder - 1);
  const out = new Uint8Array(outLen);
  let pos = 0;
  for (let i = 0; i < base64.length; i += 4) {
    const c0 = B64_REV[base64[i]];
    const c1 = B64_REV[base64[i + 1]];
    const has2 = i + 2 < base64.length;
    const has3 = i + 3 < base64.length;
    const c2 = has2 ? B64_REV[base64[i + 2]] : 0;
    const c3 = has3 ? B64_REV[base64[i + 3]] : 0;
    if (c0 === undefined || c1 === undefined || (has2 && c2 === undefined) || (has3 && c3 === undefined)) {
      return null;
    }
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[pos++] = (triplet >> 16) & 0xff;
    if (has2) out[pos++] = (triplet >> 8) & 0xff;
    if (has3) out[pos++] = triplet & 0xff;
  }
  return out;
}

/**
 * Whether `s` still fits in a share link: at most MAX_OPS nodes and an encoded payload within
 * MAX_ENCODED_BYTES, the same limits `decodeSession` enforces. The UI gates session growth on
 * this so a copied link can never silently fail to restore.
 */
export function sessionShareable(s: PlaySession): boolean {
  if (s.nodes.length > MAX_OPS) return false;
  return (base64UrlToBytes(encodeSession(s))?.length ?? Infinity) <= MAX_ENCODED_BYTES;
}

/* ---------------- encode ---------------- */

/** Node key -> the id a fresh replay would assign it (see file header). Card nodes get the next
 *  sequential integer in creation order; a compose result inherits its survivor's id (parents[0]
 *  is always the survivor, per session.ts's canonical donor order). */
function replayIds(nodes: readonly PlayNode[]): Map<number, number> {
  const ids = new Map<number, number>();
  let next = 1;
  for (const n of nodes) {
    ids.set(n.key, n.parents ? ids.get(n.parents[0])! : next++);
  }
  return ids;
}

export function encodeSession(s: PlaySession): string {
  const ids = replayIds(s.nodes);
  const ops: OpJson[] = s.nodes.map((n) => {
    if (!n.parents) {
      const c: CardOpJson["c"] = { d: n.denomIndex };
      if (n.seedText) c.t = n.seedText;
      else c.s = n.seed.toString(16).padStart(64, "0");
      return { c };
    }
    return { x: n.parents.map((k) => ids.get(k)!) };
  });
  const wire: WireJson = { v: 1, ops };
  const bytes = new TextEncoder().encode(JSON.stringify(wire));
  return bytesToBase64Url(bytes);
}

/* ---------------- decode ---------------- */

/** Never throws: any malformed input, out-of-range value, or replay failure (invalid compose
 *  sum, tray cap, unknown participant id) falls back to an empty session. */
export function decodeSession(text: string): PlaySession {
  try {
    const bytes = base64UrlToBytes(text);
    if (!bytes || bytes.length > MAX_ENCODED_BYTES) return emptySession();

    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return emptySession();

    const wire = parsed as { v?: unknown; ops?: unknown };
    if (wire.v !== 1) return emptySession();
    if (!Array.isArray(wire.ops) || wire.ops.length > MAX_OPS) return emptySession();

    let session = emptySession();
    for (const rawOp of wire.ops) {
      if (typeof rawOp !== "object" || rawOp === null) return emptySession();
      const op = rawOp as { c?: unknown; x?: unknown };
      const hasC = op.c !== undefined;
      const hasX = op.x !== undefined;
      if (hasC === hasX) return emptySession(); // exactly one of c/x

      if (hasC) {
        if (typeof op.c !== "object" || op.c === null) return emptySession();
        const c = op.c as { d?: unknown; t?: unknown; s?: unknown };
        if (!Number.isInteger(c.d) || (c.d as number) < 0 || (c.d as number) >= DENOMINATIONS.length) {
          return emptySession();
        }
        const hasT = typeof c.t === "string";
        const hasS = typeof c.s === "string";
        if (hasT === hasS) return emptySession(); // exactly one of t/s

        let seed: bigint;
        let seedText: string | undefined;
        if (hasT) {
          const t = c.t as string;
          if (t.length === 0 || t.length > MAX_SEED_TEXT_LEN) return emptySession();
          seedText = t;
          seed = textSeed(t);
        } else {
          const hex = c.s as string;
          if (!SEED_HEX_RE.test(hex)) return emptySession();
          seed = BigInt("0x" + hex);
        }
        session = keepCard(session, c.d as number, seed, seedText);
      } else {
        if (!Array.isArray(op.x) || op.x.length < 2 || !op.x.every((v) => Number.isInteger(v))) {
          return emptySession();
        }
        // Resolve participant ids against the *replay-assigned* ids of currently-live nodes: a
        // fresh session's demoId sequence has no gaps (see replayIds), so demoId doubles as the
        // replay id here.
        const live = liveNodes(session);
        const resolved = (op.x as number[]).map((id) => live.find((n) => n.demoId === id)?.key);
        if (resolved.some((k) => k === undefined)) return emptySession();
        session = composeNodes(session, resolved as number[]);
      }
    }
    return session;
  } catch {
    return emptySession();
  }
}
