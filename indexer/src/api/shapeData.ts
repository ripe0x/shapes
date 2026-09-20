/**
 * Read access the shape routes need, factored behind an interface so route handlers (routes.ts)
 * are testable with a seeded in-memory fake instead of the real `ponder:api` database, which is
 * only resolvable inside Ponder's own dev/build/start runtime.
 */

export interface ShapeRow {
  id: bigint;
  seed: `0x${string}`;
  denomIndex: number;
  backingWei: bigint;
  originCount: number;
  composeDepth: number;
  inkGene: number;
  /** Materialized module bytes; null for seed-derived geometry. */
  modules: `0x${string}` | null;
  isBlack: boolean;
  live: boolean;
  owner: `0x${string}`;
}

export interface ShapeDataSource {
  getToken(id: bigint): Promise<ShapeRow | null>;
  getTokens(ids: readonly bigint[]): Promise<ShapeRow[]>;
  getTokensByOwner(owner: `0x${string}`, limit: number): Promise<ShapeRow[]>;
  /** The `orderKey` of the token's most recent `activity` row, or null if it has none. */
  latestVersion(id: bigint): Promise<bigint | null>;
  /** The highest `blockNumber` across every recorded `activity` row, or null if there are none. */
  latestIndexedBlock(): Promise<bigint | null>;
}
