/**
 * Materialized module sampling, canonical TypeScript reference (SAMPLING_SPEC.md sections 5-7).
 *
 * Implements the decisions in SAMPLING_SPEC.md section 11: D1 (units-weighted donor with
 * replacement, uniform module choice within a donor), D2 (solid bits copied verbatim, never
 * re-drawn), D3 (split children sample from the parent instead of drawing a fresh seed).
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
  composeShape,
  geometryAt,
  metadataJsonFromComposition,
  seedHex,
  solveSize,
  svgFromComposition,
  type Composition,
  type Module,
  type Params,
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

const COMPOSE_DOMAIN = "Shapes/sample/v1";
const SPLIT_DOMAIN = "Shapes/sample-split/v1";

function requireDenomIndex(index: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= DENOMINATIONS.length) {
    throw new Error(`${label} out of range: ${index}`);
  }
}

/**
 * Truncate a non-negative integer to its low 8 bits, mirroring Solidity's `uint8(x)` explicit
 * narrowing cast (wraps, does not revert). `childIndex` in `sampleSplitChild` is conceptually a
 * uint256 loop counter narrowed at the hash site the same way, so this wraps rather than throws.
 */
function toUint8(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer: ${value}`);
  }
  return value & 0xff;
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
 * `sampleCompose` with per-cell provenance (SAMPLING_SPEC.md section 5). `sampleCompose` is
 * defined in terms of this function's output, so there is one draw-order implementation, not
 * two that could drift out of sync.
 *
 * `burnSeedFold` is the XOR of every burn's seed, so the order `burns` arrive in cannot affect
 * the result. Donor order for the units-weighted walk is fixed separately (survivor, then
 * burns ascending by token id), independent of the array's input order.
 *
 * Per destination cell: a donor is chosen with replacement, weighted by `unitsAt(denomIndex)`;
 * then a module is chosen with replacement, uniformly, from that donor's effective modules.
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
    const k = rand.nextBelow(BigInt(donor.bytes.length));
    const moduleIndex = Number(k);
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

function splitSampleSeed(parentSeed: bigint, childDenomIndex: number, childIndexU8: number): bigint {
  return packedKeccakUint(
    ["string", "bytes32", "uint8", "uint8"],
    [SPLIT_DOMAIN, seedHex(parentSeed), childDenomIndex, childIndexU8],
  );
}

/** The split-child sample stream's seed inputs, for display and reproducibility. `childIndex`
 *  is truncated to its low 8 bits the same way sampling does; both the raw and truncated values
 *  are returned. */
export function splitSampleSeedInputs(
  parent: SampleDonor,
  childDenomIndex: number,
  childIndex: number,
): {
  parentSeed: bigint;
  childDenomIndex: number;
  childIndex: number;
  childIndexU8: number;
  sampleSeed: bigint;
} {
  const childIndexU8 = toUint8(childIndex, "childIndex");
  return {
    parentSeed: parent.seed,
    childDenomIndex,
    childIndex,
    childIndexU8,
    sampleSeed: splitSampleSeed(parent.seed, childDenomIndex, childIndexU8),
  };
}

/** One destination cell's provenance from a traced split sample. Single donor (the parent), so
 *  there is no donor index or id, only which parent module the byte came from. */
export interface SplitTraceCell {
  moduleIndex: number;
  byte: number;
}

export interface SplitTraceResult {
  bytes: Uint8Array;
  trace: SplitTraceCell[];
  /** Whether the parent was materialized (stored modules) rather than seed-derived. */
  parentMaterialized: boolean;
  /** Length of the parent's effective module list sampling drew from. */
  parentCellCount: number;
}

/**
 * `sampleSplitChild` with per-cell provenance (SAMPLING_SPEC.md section 6, decision D3).
 * `sampleSplitChild` is defined in terms of this function's output, so there is one draw-order
 * implementation. Single donor, so no units weighting: module choice is uniform, with
 * replacement. `childIndex` is the child's ordinal position within the split call (the same
 * loop counter `_childSeed` uses), truncated to its low 8 bits at the hash site like Solidity's
 * `uint8(childIndex)` cast. It is not itself required to already be in uint8 range.
 */
export function sampleSplitChildTraced(
  parent: SampleDonor,
  childDenomIndex: number,
  childIndex: number,
  p: Params = CANONICAL,
): SplitTraceResult {
  requireDenomIndex(parent.denomIndex, "parent.denomIndex");
  requireDenomIndex(childDenomIndex, "childDenomIndex");
  const childIndexU8 = toUint8(childIndex, "childIndex");

  const parentBytes = effectiveModuleBytes(parent, p);
  const sampleSeed = splitSampleSeed(parent.seed, childDenomIndex, childIndexU8);
  const rand = new Round03Rand(seed32Of(sampleSeed));

  const childCellCount = cellCountAt(childDenomIndex);
  const bytes = new Uint8Array(childCellCount);
  const trace: SplitTraceCell[] = new Array(childCellCount);
  for (let j = 0; j < childCellCount; j++) {
    const k = rand.nextBelow(BigInt(parentBytes.length));
    const moduleIndex = Number(k);
    const byte = parentBytes[moduleIndex];
    bytes[j] = byte;
    trace[j] = {moduleIndex, byte};
  }
  return {
    bytes,
    trace,
    parentMaterialized: parent.modules != null,
    parentCellCount: parentBytes.length,
  };
}

export function sampleSplitChild(
  parent: SampleDonor,
  childDenomIndex: number,
  childIndex: number,
  p: Params = CANONICAL,
): Uint8Array {
  return sampleSplitChildTraced(parent, childDenomIndex, childIndex, p).bytes;
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
    description,
  );
}
