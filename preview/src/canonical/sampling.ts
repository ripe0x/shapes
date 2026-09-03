/**
 * Materialized module sampling, canonical TypeScript reference (SAMPLING_SPEC.md sections 5-7).
 *
 * Implements the decisions in SAMPLING_SPEC.md section 11: D1' (units-weighted donor with
 * replacement; module choice within a donor uniform over its not-yet-used modules, without
 * replacement, so compose provenance is injective at the cell level), D2 (solid bits copied
 * verbatim, never re-drawn), D3' (split children sample from a pool that depends on whether the
 * parent has a compose record: the record's donor modules when it does, otherwise the parent
 * seed's grammar v1 expression at the CHILD's own denomination — never the parent's own stored
 * modules directly).
 *
 * All hashing is `keccak256` over `abi.encodePacked` with the exact argument types Solidity
 * uses, the same convention `ink.ts` and `splitSeed.ts` follow, so the stream a Solidity port
 * opens agrees with this one byte for byte.
 */

import {encodePacked, keccak256} from "viem";
import {Round03Rand, seed32Of} from "./rand";
import {unitsAt, cellCountAt, DENOMINATIONS, LABELS} from "./denominations";
import {GENE_PROBABILITY} from "./ink";
import {
  CANONICAL,
  DESCRIPTION,
  OWNER_TOKEN_DESCRIPTION,
  composeShape,
  descriptionFor,
  geometryAt,
  metadataJsonFromComposition,
  seedHex,
  solveSize,
  svgFromComposition,
  type Composition,
  type Module,
  type Params,
  type SplitFrom,
} from "./render";
import {decodeModules, encodeModules, isValidModuleArray} from "./moduleCodec";

/**
 * A compose/split donor: a token's current visual state. `modules` is present iff the token is
 * materialized (SAMPLING_SPEC.md section 4); when absent, the donor's geometry is grammar v1,
 * derived from `seed` and `denomIndex` under its current `inkGene`. `inkGene` is required in
 * both cases because `ShapeRenderer.compose`/`GrammarV1Modules.all` take it as an argument: the
 * per-module solid draw depends on the donor's own solid probability, not the composed result's.
 */
export interface SampleDonor {
  seed: bigint;
  denomIndex: number;
  inkGene: number;
  modules?: Uint8Array;
}

/** One burned compose input. Only `tokenId` distinguishes it from the survivor: it fixes the
 *  canonical donor order (ascending token id) independent of calldata order. */
export interface SampleBurn extends SampleDonor {
  tokenId: bigint;
}

/**
 * A split parent's top compose record, in the shape sampling needs to rebuild its donor pool
 * (SAMPLING_SPEC.md section 6, D3'). `survivor` is the record's pre-compose survivor snapshot —
 * `seed` must be the parent's own live seed (compose never changes a token's seed), while
 * `denomIndex`/`inkGene`/`modules` are the snapshot the record stored. `inputs` need not already
 * be in canonical order; the pool builder sorts them ascending by `tokenId`, mirroring
 * `GeometrySampling.sortDonorsById` on the Solidity side.
 */
export interface LastMergeDonors {
  survivor: SampleDonor;
  inputs: SampleBurn[];
}

const COMPOSE_DOMAIN = "Shapes/sample/v1";
const SPLIT_DOMAIN = "Shapes/sample-split/v1";

function requireDenomIndex(index: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= DENOMINATIONS.length) {
    throw new Error(`${label} out of range: ${index}`);
  }
}

/** Reject a value that cannot be a uint256 loop counter. `childIndex` enters the split stream
 *  untruncated, so out-of-range input is an error rather than a wrap. */
function requireIndex(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer: ${value}`);
  }
}

/** keccak256(abi.encodePacked(...)), reduced to a uint256 bigint. Mirrors the private helper in
 *  ink.ts; kept local here rather than shared, matching that file's own precedent. */
function packedKeccakUint(types: readonly string[], values: readonly unknown[]): bigint {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return BigInt(keccak256(encodePacked(types as any, values as any)));
}

/**
 * A donor's effective module bytes (SAMPLING_SPEC.md section 5): its stored array if
 * materialized, otherwise the grammar-v1 module sequence of `(seed, amountAt(denomIndex))`
 * under its current ink gene, encoded the same way a materialized array would be. Only
 * kind/solid/rot participate; positions, size and weight are never read from here.
 */
export function effectiveModuleBytes(donor: SampleDonor, p: Params = CANONICAL): Uint8Array {
  requireDenomIndex(donor.denomIndex, "donor.denomIndex");
  if (donor.modules) {
    if (!isValidModuleArray(donor.modules)) {
      throw new Error("donor.modules contains an invalid module byte");
    }
    return donor.modules;
  }
  const amountWei = DENOMINATIONS[donor.denomIndex];
  const composition = composeShape(donor.seed, amountWei, donor.inkGene, p);
  return encodeModules(composition.modules);
}

/** Donor order for compose sampling: survivor first, then burns ascending by token id. Fixed
 *  regardless of calldata order, the same convention `burnSeedFold`'s XOR already relies on. */
function orderedBurns(burns: readonly SampleBurn[]): SampleBurn[] {
  return [...burns].sort((a, b) => (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0));
}

function xorFold(seeds: readonly bigint[]): bigint {
  let fold = 0n;
  for (const s of seeds) fold ^= s;
  return fold;
}

function composeSampleSeed(survivorSeed: bigint, burnSeedFold: bigint, newIndex: number): bigint {
  return packedKeccakUint(
    ["string", "bytes32", "uint256", "uint8"],
    [COMPOSE_DOMAIN, seedHex(survivorSeed), burnSeedFold, newIndex],
  );
}

/** The compose sample stream's seed inputs, for display and reproducibility. `burns` need not
 *  already be in canonical order; this orders them the same way sampling does. */
export function composeSampleSeedInputs(
  survivor: SampleDonor,
  burns: readonly SampleBurn[],
  newIndex: number,
): {survivorSeed: bigint; burnSeedFold: bigint; newIndex: number; sampleSeed: bigint} {
  const orderedB = orderedBurns(burns);
  const burnSeedFold = xorFold(orderedB.map((b) => b.seed));
  return {
    survivorSeed: survivor.seed,
    burnSeedFold,
    newIndex,
    sampleSeed: composeSampleSeed(survivor.seed, burnSeedFold, newIndex),
  };
}

interface ComposeStreamDonor {
  id: string;
  materialized: boolean;
  units: bigint;
  bytes: Uint8Array;
}

/** Donor records for the units-weighted walk, in canonical order, carrying the display-only
 *  `id`/`materialized` fields the traced sampler reports alongside each draw. */
function composeStreamDonors(
  survivor: SampleDonor,
  orderedB: readonly SampleBurn[],
  p: Params,
): ComposeStreamDonor[] {
  const donorOf = (donor: SampleDonor, id: string): ComposeStreamDonor => ({
    id,
    materialized: donor.modules != null,
    units: unitsAt(donor.denomIndex),
    bytes: effectiveModuleBytes(donor, p),
  });
  return [donorOf(survivor, "survivor"), ...orderedB.map((b) => donorOf(b, b.tokenId.toString()))];
}

/** One destination cell's provenance from a traced compose sample. */
export interface ComposeTraceCell {
  /** Position of the source donor in canonical order: 0 is the survivor, 1.. are burns
   *  ascending by token id. */
  donorIndex: number;
  /** "survivor" for the survivor, the burn's token id (decimal string) otherwise. */
  donorId: string;
  /** Index into the donor's effective module list the byte was drawn from. */
  moduleIndex: number;
  /** The sampled module byte, section 3 encoding. */
  byte: number;
  /** Whether the source donor was materialized (stored modules) rather than seed-derived. */
  donorMaterialized: boolean;
}

export interface ComposeTraceResult {
  bytes: Uint8Array;
  trace: ComposeTraceCell[];
}

/**
 * `sampleCompose` with per-cell provenance (SAMPLING_SPEC.md section 5, decision D1'). `sampleCompose`
 * is defined in terms of this function's output, so there is one draw-order implementation, not
 * two that could drift out of sync.
 *
 * `burnSeedFold` is the XOR of every burn's seed, so the order `burns` arrive in cannot affect
 * the result. Donor order for the units-weighted walk is fixed separately (survivor, then
 * burns ascending by token id), independent of the array's input order.
 *
 * Per destination cell: a donor is chosen with replacement, weighted by `unitsAt(denomIndex)`;
 * then a module is chosen uniformly from that donor's not-yet-used modules, without replacement.
 * Each donor module contributes to at most one result cell, so provenance is injective at the
 * cell level: no two result cells trace to the same `(donorIndex, moduleIndex)` pair.
 *
 * A donor's supply of unused modules can never run out while it is still being drawn from: every
 * donor's value is strictly below the result's (a compose merges two or more positive-value
 * donors into one higher-value survivor), and cell count is strictly decreasing in denomination
 * (`DENOMINATIONS`'s grid table), so every donor's module count is at least the result's cell
 * count. Total draws equal the result's cell count. See SAMPLING_SPEC.md section 10 invariant 6.
 */
export function sampleComposeTraced(
  survivor: SampleDonor,
  burns: readonly SampleBurn[],
  newIndex: number,
  p: Params = CANONICAL,
): ComposeTraceResult {
  requireDenomIndex(survivor.denomIndex, "survivor.denomIndex");
  requireDenomIndex(newIndex, "newIndex");

  const orderedB = orderedBurns(burns);
  const burnSeedFold = xorFold(orderedB.map((b) => b.seed));
  const sampleSeed = composeSampleSeed(survivor.seed, burnSeedFold, newIndex);
  const rand = new Round03Rand(seed32Of(sampleSeed));

  const donors = composeStreamDonors(survivor, orderedB, p);

  let totalUnits = 0n;
  for (const donor of donors) totalUnits += donor.units;
  if (totalUnits <= 0n) throw new Error("total donor units must be positive");

  const newCellCount = cellCountAt(newIndex);
  const bytes = new Uint8Array(newCellCount);
  const trace: ComposeTraceCell[] = new Array(newCellCount);

  // Per-donor consumption state: which module indices are already used, and how many remain.
  const consumed: boolean[][] = donors.map((donor) => new Array(donor.bytes.length).fill(false));
  const remaining: number[] = donors.map((donor) => donor.bytes.length);

  for (let j = 0; j < newCellCount; j++) {
    const d = rand.nextBelow(totalUnits);
    let acc = 0n;
    let donorIndex = donors.length - 1; // acc reaches totalUnits at the last donor, so d < acc always fires by then
    for (let i = 0; i < donors.length; i++) {
      acc += donors[i].units;
      if (d < acc) {
        donorIndex = i;
        break;
      }
    }
    const donor = donors[donorIndex];
    const k = Number(rand.nextBelow(BigInt(remaining[donorIndex])));

    const donorConsumed = consumed[donorIndex];
    let unusedSeen = 0;
    let moduleIndex = 0; // only reached if remaining[donorIndex] is 0, which the invariant in the doc comment above rules out
    for (let m = 0; m < donorConsumed.length; m++) {
      if (!donorConsumed[m]) {
        if (unusedSeen === k) {
          moduleIndex = m;
          break;
        }
        unusedSeen++;
      }
    }

    donorConsumed[moduleIndex] = true;
    remaining[donorIndex]--;

    const byte = donor.bytes[moduleIndex];
    bytes[j] = byte;
    trace[j] = {donorIndex, donorId: donor.id, moduleIndex, byte, donorMaterialized: donor.materialized};
  }

  return {bytes, trace};
}

/**
 * Sample a composed card's modules from its inputs (SAMPLING_SPEC.md section 5). Delegates to
 * `sampleComposeTraced` so the draw order lives in exactly one place.
 */
export function sampleCompose(
  survivor: SampleDonor,
  burns: readonly SampleBurn[],
  newIndex: number,
  p: Params = CANONICAL,
): Uint8Array {
  return sampleComposeTraced(survivor, burns, newIndex, p).bytes;
}

/**
 * A recordless split's sampling pool (SAMPLING_SPEC.md section 6, D3'): the parent seed's grammar
 * v1 expression at the CHILD's own denomination, under the parent's ink gene. Ignores the
 * parent's own materialized modules entirely, even when the parent is materialized (a split
 * child being split again with no compose record of its own) — the pool depends on the child's
 * denomination, not the parent's stored geometry.
 */
export function grammarSplitPoolBytes(
  parentSeed: bigint,
  childDenomIndex: number,
  parentInkGene: number,
  p: Params = CANONICAL,
): Uint8Array {
  requireDenomIndex(childDenomIndex, "childDenomIndex");
  const amountWei = DENOMINATIONS[childDenomIndex];
  const composition = composeShape(parentSeed, amountWei, parentInkGene, p);
  return encodeModules(composition.modules);
}

/**
 * A materialized-parent split's sampling pool (SAMPLING_SPEC.md section 6, D3'): the parent's top
 * compose record's donor modules, concatenated in canonical order — the record's pre-compose
 * survivor first, then its inputs ascending by token id. Child-denomination-independent: the same
 * pool is shared by every child of one split call, mirroring `GeometrySampling.buildSplitRecordPool`.
 */
export function splitRecordPoolBytes(donors: LastMergeDonors, p: Params = CANONICAL): Uint8Array {
  const survivorBytes = effectiveModuleBytes(donors.survivor, p);
  const orderedInputs = orderedBurns(donors.inputs);
  const inputBytesArr = orderedInputs.map((b) => effectiveModuleBytes(b, p));
  const total = inputBytesArr.reduce((acc, b) => acc + b.length, survivorBytes.length);
  const pool = new Uint8Array(total);
  pool.set(survivorBytes, 0);
  let o = survivorBytes.length;
  for (const ib of inputBytesArr) {
    pool.set(ib, o);
    o += ib.length;
  }
  return pool;
}

function splitSampleSeed(parentSeed: bigint, childDenomIndex: number, childIndex: number): bigint {
  return packedKeccakUint(
    ["string", "bytes32", "uint8", "uint256"],
    [SPLIT_DOMAIN, seedHex(parentSeed), childDenomIndex, BigInt(childIndex)],
  );
}

/** The split-child sample stream's seed inputs, for display and reproducibility. */
export function splitSampleSeedInputs(
  parent: SampleDonor,
  childDenomIndex: number,
  childIndex: number,
): {
  parentSeed: bigint;
  childDenomIndex: number;
  childIndex: number;
  sampleSeed: bigint;
} {
  requireIndex(childIndex, "childIndex");
  return {
    parentSeed: parent.seed,
    childDenomIndex,
    childIndex,
    sampleSeed: splitSampleSeed(parent.seed, childDenomIndex, childIndex),
  };
}

/** One destination cell's provenance from a traced split sample. `moduleIndex` indexes the split's
 *  pool (SAMPLING_SPEC.md section 6, D3'), not the parent's own module list: the record branch's
 *  pool spans multiple donors concatenated, and the grammar branch's pool is sized to the CHILD's
 *  own denomination, not the parent's. */
export interface SplitTraceCell {
  moduleIndex: number;
  byte: number;
}

export interface SplitTraceResult {
  bytes: Uint8Array;
  trace: SplitTraceCell[];
  /** Which pool branch sampling drew from (SAMPLING_SPEC.md section 6, D3'): "record" when
   *  `lastMergeDonors` was given, "grammar" otherwise. */
  branch: "record" | "grammar";
  /** Length of the pool sampling drew from: the record's concatenated donor module count (record
   *  branch) or the child-denomination grammar v1 expression's module count (grammar branch).
   *  Not the parent's own module count in either case. */
  poolLength: number;
}

/**
 * `sampleSplitChild` with per-cell provenance (SAMPLING_SPEC.md section 6, decision D3').
 * `sampleSplitChild` is defined in terms of this function's output, so there is one draw-order
 * implementation.
 *
 * The pool is child-denomination-independent when `lastMergeDonors` is given (the parent's top
 * compose record's donor modules, concatenated in canonical order via `splitRecordPoolBytes`) and
 * depends on `childDenomIndex` otherwise (the parent seed's grammar v1 expression at the child's
 * own denomination via `grammarSplitPoolBytes`, ignoring `parent.modules` even when the parent is
 * itself materialized). Either way, module choice within the pool is uniform, with replacement:
 * a single pool, so no units weighting. `childIndex` is the child's ordinal position within the
 * split call (the same loop counter `_childSeed` uses), encoded into the stream as a full
 * uint256. Encoding it as a uint8 would alias children 256 apart in the same split at the same
 * denomination.
 */
export function sampleSplitChildTraced(
  parent: SampleDonor,
  childDenomIndex: number,
  childIndex: number,
  p: Params = CANONICAL,
  lastMergeDonors?: LastMergeDonors,
): SplitTraceResult {
  requireDenomIndex(parent.denomIndex, "parent.denomIndex");
  requireDenomIndex(childDenomIndex, "childDenomIndex");
  requireIndex(childIndex, "childIndex");

  const branch: "record" | "grammar" = lastMergeDonors ? "record" : "grammar";
  const pool = lastMergeDonors
    ? splitRecordPoolBytes(lastMergeDonors, p)
    : grammarSplitPoolBytes(parent.seed, childDenomIndex, parent.inkGene, p);

  const sampleSeed = splitSampleSeed(parent.seed, childDenomIndex, childIndex);
  const rand = new Round03Rand(seed32Of(sampleSeed));

  const childCellCount = cellCountAt(childDenomIndex);
  const bytes = new Uint8Array(childCellCount);
  const trace: SplitTraceCell[] = new Array(childCellCount);
  for (let j = 0; j < childCellCount; j++) {
    const k = rand.nextBelow(BigInt(pool.length));
    const moduleIndex = Number(k);
    const byte = pool[moduleIndex];
    bytes[j] = byte;
    trace[j] = {moduleIndex, byte};
  }
  return {bytes, trace, branch, poolLength: pool.length};
}

export function sampleSplitChild(
  parent: SampleDonor,
  childDenomIndex: number,
  childIndex: number,
  p: Params = CANONICAL,
  lastMergeDonors?: LastMergeDonors,
): Uint8Array {
  return sampleSplitChildTraced(parent, childDenomIndex, childIndex, p, lastMergeDonors).bytes;
}

/**
 * Build a Card from a materialized byte array (SAMPLING_SPEC.md section 7, grammar v2).
 *
 * Decodes each byte's kind/solid/rot and derives positions, size and stroke from the grid and
 * card constants exactly as the seed-drawn path (`composeShape`) does. `solidProbability` is
 * set from the gene as metadata only; no solid draws occur on this path.
 */
export function composeSampledShape(
  modules: Uint8Array,
  denomIndex: number,
  inkGene: number,
  p: Params = CANONICAL,
): Composition {
  requireDenomIndex(denomIndex, "denomIndex");
  if (inkGene < 0 || inkGene >= GENE_PROBABILITY.length) {
    throw new Error(`gene out of range: ${inkGene}`);
  }

  const g = geometryAt(denomIndex, p);
  const expectedCount = g.cols * g.rows;
  if (modules.length !== expectedCount) {
    throw new Error(
      `sampled module array length ${modules.length} does not match grid ${g.cols}x${g.rows} (${expectedCount})`,
    );
  }

  const decoded = decodeModules(modules);
  const solidProbability = GENE_PROBABILITY[inkGene];

  const cardModules: Module[] = decoded.map((d, i) => ({
    index: i,
    kind: d.kind,
    solid: d.solid,
    rot: d.rot,
    cx: g.x0 + BigInt(i % g.cols) * g.cell + g.halfCell,
    cy: g.y0 + BigInt(Math.floor(i / g.cols)) * g.cell + g.halfCell,
    size: solveSize(d.kind, d.solid, g.target, g.weight),
    weight: g.weight,
  }));

  return {
    denomIndex,
    amountWei: DENOMINATIONS[denomIndex],
    label: LABELS[denomIndex],
    cols: g.cols,
    rows: g.rows,
    cell: g.cell,
    x0: g.x0,
    y0: g.y0,
    fill: p.fill,
    wRatio: p.wRatio,
    target: g.target,
    weight: g.weight,
    solidProbability,
    inkGene,
    modules: cardModules,
    draws: 0,
  };
}

/**
 * Render a materialized token's SVG (SAMPLING_SPEC.md section 7, grammar v2). The sampled
 * counterpart of `renderShape`: `denomIndex` selects the grid instead of an `amountWei`, and
 * `modules` decodes directly with no random draws. `tokenId` only affects the output when
 * `p.showText` is on, off under `CANONICAL`.
 */
export function renderSampledShape(
  modules: Uint8Array,
  denomIndex: number,
  tokenId: bigint,
  inkGene: number,
  p: Params = CANONICAL,
  inverted = false,
): string {
  const c = composeSampledShape(modules, denomIndex, inkGene, p);
  return svgFromComposition(c, tokenId, p, inverted);
}

/** Metadata JSON for a materialized token, the sampled counterpart of `tokenMetadataJson`. */
export function sampledTokenMetadataJson(
  modules: Uint8Array,
  denomIndex: number,
  tokenId: bigint,
  originCount: bigint,
  inverted: boolean,
  inkGene: number,
  composeDepth: bigint,
  namePrefix: string = "Shape ",
  description: string = DESCRIPTION,
  p: Params = CANONICAL,
  splitFrom?: SplitFrom,
  ownerTokenDescription: string = OWNER_TOKEN_DESCRIPTION,
): string {
  const c = composeSampledShape(modules, denomIndex, inkGene, p);
  const svg = svgFromComposition(c, tokenId, p, inverted);
  return metadataJsonFromComposition(
    c,
    svg,
    tokenId,
    originCount,
    inverted,
    inkGene,
    composeDepth,
    namePrefix,
    descriptionFor(tokenId, description, ownerTokenDescription),
    splitFrom,
  );
}
