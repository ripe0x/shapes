/**
 * Batch analysis shared by the preview UI and the command-line sweep:
 * exact geometry collision detection and distribution readouts.
 *
 * Collisions are detected by exact string equality on the geometry markup, not
 * by hashing, so there are no false positives. The short hash is display only.
 */

import { composeShape, fillClass, renderGeometry } from "./canonical/render";
import { CANONICAL, KIND_ORDER, type Kind, type Params } from "./canonical/params";
import { denominationIndex } from "./canonical/denominations";
import { geneAtMint } from "./canonical/ink";
import { seedAt, type SeedMode } from "./seeds";

export interface CardRecord {
  tokenId: bigint;
  seed: bigint;
  amountWei: bigint;
  geometry: string;
  hash: string;
}

export interface CollisionPair {
  hash: string;
  members: bigint[]; // seeds
}

export interface BatchStats {
  count: number;
  kindCounts: Record<Kind, number>;
  solid: number;
  outline: number;
  rotationCounts: Record<number, number>;
  moduleTotal: number;
  collisionPairs: CollisionPair[];
  /** Number of cards involved in at least one collision. */
  collidedCards: number;
  /** Number of distinct geometries. */
  distinct: number;
  /** Cards that came out entirely solid / entirely outlined. */
  pureSolidCards: number;
  pureOutlineCards: number;
}

/** Display-only 64-bit FNV-1a, rendered as 16 hex characters. */
export function shortHash(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) & mask;
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

export function buildBatch(
  amountWei: bigint,
  seedStart: bigint,
  count: number,
  p: Params = CANONICAL,
  mode: SeedMode = "production",
): CardRecord[] {
  const out: CardRecord[] = [];
  const denomIndex = denominationIndex(amountWei);
  for (let i = 0; i < count; i++) {
    const index = seedStart + BigInt(i);
    const seed = seedAt(index, mode);
    // The gene a real mint of this seed at this denomination would draw, so the sweep's
    // distributions reflect the actual on-chain rule rather than a stand-in constant.
    const gene = geneAtMint(seed, denomIndex);
    const geometry = renderGeometry(seed, amountWei, gene, p);
    out.push({
      tokenId: index,
      seed,
      amountWei,
      geometry,
      hash: shortHash(geometry),
    });
  }
  return out;
}

export function analyseBatch(
  cards: CardRecord[],
  amountWei: bigint,
  p: Params = CANONICAL,
): BatchStats {
  const kindCounts = Object.fromEntries(
    KIND_ORDER.map((k) => [k, 0]),
  ) as Record<Kind, number>;
  const rotationCounts: Record<number, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
  let solid = 0;
  let outline = 0;
  let moduleTotal = 0;

  let pureSolidCards = 0;
  let pureOutlineCards = 0;

  const denomIndex = denominationIndex(amountWei);
  for (const card of cards) {
    const gene = geneAtMint(card.seed, denomIndex);
    const c = composeShape(card.seed, amountWei, gene, p);
    const cls = fillClass(c);
    if (cls === "Solid") pureSolidCards++;
    if (cls === "Outline") pureOutlineCards++;
    for (const m of c.modules) {
      moduleTotal++;
      kindCounts[m.kind]++;
      if (m.solid) solid++;
      else outline++;
      rotationCounts[m.rot]++;
    }
  }

  const byGeometry = new Map<string, bigint[]>();
  for (const card of cards) {
    const list = byGeometry.get(card.geometry);
    if (list) list.push(card.seed);
    else byGeometry.set(card.geometry, [card.seed]);
  }

  const collisionPairs: CollisionPair[] = [];
  let collidedCards = 0;
  for (const [geometry, members] of byGeometry) {
    if (members.length > 1) {
      collidedCards += members.length;
      collisionPairs.push({ hash: shortHash(geometry), members });
    }
  }

  return {
    count: cards.length,
    kindCounts,
    solid,
    outline,
    rotationCounts,
    moduleTotal,
    collisionPairs,
    collidedCards,
    distinct: byGeometry.size,
    pureSolidCards,
    pureOutlineCards,
  };
}
