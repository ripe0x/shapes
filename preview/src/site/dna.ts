/**
 * Per-cell provenance for the DNA section of a token's detail page (SAMPLING_SPEC.md section 12).
 *
 * A live token's geometry comes from one of three sources, decided by its compose depth and
 * whether its modules are materialized:
 *
 *   composeDepth > 0        -> compose: reconstructed from composeRecordAt's stored pre-compose
 *                               state and burned inputs
 *   composeDepth == 0,
 *   modules nonempty         -> split: reconstructed from splitOriginOf's stored parent state
 *   composeDepth == 0,
 *   modules empty             -> seed-derived: grammar v1 directly from the token's own seed
 *
 * The compose and split branches reconstruct the sampled bytes independently and assert the
 * result equals the token's live `shapeState(id).modules`. A mismatch means a bug in this
 * reconstruction or in the contract's own sampling; it is surfaced as an explicit error state,
 * never rendered as if it were correct.
 *
 * The split branch has its own inner branch (SAMPLING_SPEC.md section 6, D3'), independent of the
 * classification above: the pool a split's children were sampled from is the PARENT's top compose
 * record's donor modules when the parent had one (`composeDepth(parentId) > 0` at split time,
 * read from `splitOriginOf`'s `parentId`), or the parent seed's grammar v1 expression at the
 * child's own denomination otherwise. `DnaSplitResult.branch` reports which; the parent's own
 * `parentModules` snapshot is informational only and plays no part in either.
 *
 * The reconstruction itself (`deriveComposeDna`, `deriveSplitDna`, `deriveSeedDna`) takes plain
 * fetched values and has no chain dependency, so it is unit-tested with fabricated records.
 * `loadDna` and `loadDnaFromSnapshot` are the chain-facing pieces; both classify and resolve
 * through the shared `resolveDna`, which reads `composeRecordAt` and/or `splitOriginOf` as the
 * classification requires.
 *
 * `loadDnaFromSnapshot` reads a burned-or-live token's own DNA from a compose/split donor
 * snapshot rather than `shapeState` (which reverts once the id is burned): `composeDepth`,
 * `composeRecordAt` and `splitOriginOf` all survive burning and answer for any id that ever
 * existed. This is what lets the DNA section's contributing-donor cards drill recursively into
 * each donor's own provenance.
 */

import {hexToBytes, type PublicClient} from "viem";
import {shapesAbi, shapeLensAbi, type Deployment} from "../chain/abi";
import {geometryAt, WAD, type CardGeometry, type Kind, type Params} from "../canonical/render";
import {decodeModuleByte, decodeModules} from "../canonical/moduleCodec";
import {
  effectiveModuleBytes,
  grammarSplitPoolBytes,
  sampleComposeTraced,
  sampleSplitChildTraced,
  type ComposeTraceCell,
  type LastMergeDonors,
  type SampleBurn,
  type SampleDonor,
  type SplitTraceCell,
} from "../canonical/sampling";

/* ------------------------------------------------------------------ *
 * Plain fetched inputs (no viem/chain types), fabricable in tests
 * ------------------------------------------------------------------ */

/** The subset of `shapeState(id)` the reconstruction needs. */
export interface RawShapeState {
  seed: bigint;
  denomIndex: number;
  inkGene: number;
  /** Empty when the token is unmaterialized (grammar v1). */
  modules: Uint8Array;
}

export interface RawComposeInput {
  id: bigint;
  seed: bigint;
  denomIndex: number;
  inkGene: number;
  modules: Uint8Array;
}

/** `composeRecordAt(survivorId, depth)`'s payload. */
export interface RawComposeRecord {
  survivorDenomIndex: number;
  survivorInkGene: number;
  survivorModules: Uint8Array;
  inputs: RawComposeInput[];
}

/** `splitOriginOf(childId)`'s payload. `parentId` is the burned parent's token id, needed to
 *  re-read its own `composeDepth`/`composeRecordAt` (SAMPLING_SPEC.md section 6, D3'): the split
 *  branch decision depends on whether the PARENT had a compose record, not on `parentModules`. */
export interface RawSplitOrigin {
  parentSeed: bigint;
  parentId: bigint;
  parentDenomIndex: number;
  parentInkGene: number;
  parentModules: Uint8Array;
  childIndex: number;
}

/* ------------------------------------------------------------------ *
 * Result shape the UI renders from
 * ------------------------------------------------------------------ */

/** One grid cell's decoded identity, with donor provenance when the token is sampled. */
export interface DnaCell {
  moduleIndex: number;
  byte: number;
  kind: Kind;
  solid: boolean;
  rot: number;
  /** Compose only: position in canonical donor order (0 = survivor, 1.. = burns ascending by id). */
  donorIndex?: number;
  /** Compose only: "survivor" or the burn's token id (decimal string). */
  donorId?: string;
  /** Compose only: whether the source donor was materialized rather than seed-derived. */
  donorMaterialized?: boolean;
}

export interface DnaDonor {
  /** "survivor" or the burn's token id (decimal string), canonical order. */
  id: string;
  materialized: boolean;
  /** Snapshot state at compose time, for rendering this donor's own card: `effectiveModuleBytes`
   *  plus `composeSampledShape` reconstruct exactly what it looked like before the merge. */
  seed: bigint;
  denomIndex: number;
  inkGene: number;
  /** Present iff materialized; absent means grammar-v1 from `seed`/`denomIndex`/`inkGene`. */
  modules?: Uint8Array;
}

export interface DnaSeedResult {
  kind: "seed";
  geometry: CardGeometry;
  bytes: Uint8Array;
  cells: DnaCell[];
  /** False for a live unmaterialized token (`bytes` is grammar v1 straight from `seed`). True for
   *  a split-parent leaf snapshot (see `loadDnaFromSnapshot`): `bytes` is the recorded snapshot,
   *  decoded as-is, not derived from `seed` — the two need different explanatory copy in the UI. */
  materialized: boolean;
}

export interface DnaComposeResult {
  kind: "compose";
  geometry: CardGeometry;
  bytes: Uint8Array;
  cells: DnaCell[];
  donors: DnaDonor[];
  /** Depth to pass as `loadDnaFromSnapshot`'s `depthOverride` when drilling into the "survivor"
   *  donor: one less than the depth this record was read at. The survivor's own live
   *  `composeDepth` read would instead return this same token's current, later depth and
   *  re-fetch this same record rather than walking further down the stack. */
  survivorDepth: number;
}

export interface DnaSplitResult {
  kind: "split";
  geometry: CardGeometry;
  bytes: Uint8Array;
  cells: DnaCell[];
  /** Which sampling pool this split drew from (SAMPLING_SPEC.md section 6, D3'): "record" when
   *  the parent had a compose record at split time, "grammar" otherwise. */
  branch: "record" | "grammar";
  /** Length of the pool sampling actually drew from — not the parent's own module count. */
  poolLength: number;
  /** The parent's own pre-split identity, informational only since D3': `modules` (the parent's
   *  own effective geometry snapshot) plays no part in either sampling branch. Kept for display
   *  ("split from this Shape") and drill-down into the parent's own DNA. */
  parent: {
    seed: bigint;
    denomIndex: number;
    inkGene: number;
    materialized: boolean;
    /** Present iff materialized; absent means grammar-v1 from `seed`/`denomIndex`/`inkGene`. */
    modules?: Uint8Array;
  };
  /** The grammar branch's pool, renderable as a card at the CHILD's own denomination (its module
   *  count always equals that denomination's grid, the same way a compose donor's own module
   *  count equals its own grid) — present only when `branch === "grammar"`. The record branch's
   *  pool is a multi-donor concatenation with no single grid shape, so it has no card form here;
   *  callers show it as pool index/byte only (see `DnaCell.moduleIndex`), not a two-way highlight. */
  pool?: {
    seed: bigint;
    denomIndex: number;
    inkGene: number;
    modules: Uint8Array;
  };
}

export interface DnaUnavailableResult {
  kind: "unavailable";
  message: string;
}

export interface DnaMismatchResult {
  kind: "mismatch";
  message: string;
}

export type DnaResult = DnaSeedResult | DnaComposeResult | DnaSplitResult | DnaUnavailableResult | DnaMismatchResult;

export type DnaBranch = "compose" | "split" | "seed";

/**
 * Which reconstruction path a token's provenance takes. Depth > 0 always wins: a materialized
 * split child that is later recomposed moves onto the compose stack. Otherwise nonempty modules
 * means a split child (compose is the only other source of materialization, and it is excluded
 * by the depth check); otherwise the token's geometry derives directly from its own seed.
 */
export function classifyDna(composeDepth: number, modulesLength: number): DnaBranch {
  if (composeDepth > 0) return "compose";
  if (modulesLength > 0) return "split";
  return "seed";
}

/** A card's fixed viewBox, from `svgFromComposition`. Overlay positions are percentages of this. */
const FIELD_W = 250;
const FIELD_H = 350;

export interface GeometryPercents {
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

/** Grid geometry as CSS percentages of the card's viewBox, for an absolutely-positioned overlay
 *  grid drawn over the rendered artwork. Display math only; never fed back into sampling. */
export function geometryPercents(g: CardGeometry): GeometryPercents {
  const toFloat = (w: bigint) => Number(w) / Number(WAD);
  return {
    leftPct: (toFloat(g.x0) / FIELD_W) * 100,
    topPct: (toFloat(g.y0) / FIELD_H) * 100,
    widthPct: ((toFloat(g.cell) * g.cols) / FIELD_W) * 100,
    heightPct: ((toFloat(g.cell) * g.rows) / FIELD_H) * 100,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function cellsFromBytes(bytes: Uint8Array): DnaCell[] {
  const decoded = decodeModules(bytes);
  return decoded.map((d, i) => ({moduleIndex: i, byte: bytes[i], kind: d.kind, solid: d.solid, rot: d.rot}));
}

function cellsFromComposeTrace(trace: readonly ComposeTraceCell[]): DnaCell[] {
  return trace.map((t) => {
    const d = decodeModuleByte(t.byte);
    return {
      moduleIndex: t.moduleIndex,
      byte: t.byte,
      kind: d.kind,
      solid: d.solid,
      rot: d.rot,
      donorIndex: t.donorIndex,
      donorId: t.donorId,
      donorMaterialized: t.donorMaterialized,
    };
  });
}

function cellsFromSplitTrace(trace: readonly SplitTraceCell[]): DnaCell[] {
  return trace.map((t) => {
    const d = decodeModuleByte(t.byte);
    return {moduleIndex: t.moduleIndex, byte: t.byte, kind: d.kind, solid: d.solid, rot: d.rot};
  });
}

const MISMATCH_COMPOSE =
  "Reconstructed compose bytes do not match the token's stored modules. This is a bug in " +
  "provenance reconstruction or in the contract's own sampling, not a display issue.";

const MISMATCH_SPLIT =
  "Reconstructed split bytes do not match the token's stored modules. This is a bug in " +
  "provenance reconstruction or in the contract's own sampling, not a display issue.";

/**
 * Compose branch (SAMPLING_SPEC.md section 12): rebuild the survivor and burned-input donors from
 * the recorded pre-compose state, sample at the token's current denomination, and verify the
 * result equals its live materialized bytes.
 *
 * `depth` is the depth this record was read at (the `depth` argument passed to
 * `composeRecordAt`, plus one) — carried through only to compute `survivorDepth`, not used in the
 * reconstruction itself.
 */
export function deriveComposeDna(
  state: RawShapeState,
  record: RawComposeRecord,
  depth: number,
  p?: Params,
): DnaComposeResult | DnaMismatchResult {
  const geometry = geometryAt(state.denomIndex, p);
  const survivor: SampleDonor = {
    seed: state.seed,
    denomIndex: record.survivorDenomIndex,
    inkGene: record.survivorInkGene,
    modules: record.survivorModules.length > 0 ? record.survivorModules : undefined,
  };
  const burns: SampleBurn[] = record.inputs.map((inp) => ({
    tokenId: inp.id,
    seed: inp.seed,
    denomIndex: inp.denomIndex,
    inkGene: inp.inkGene,
    modules: inp.modules.length > 0 ? inp.modules : undefined,
  }));
  const {bytes, trace} = sampleComposeTraced(survivor, burns, state.denomIndex, p);
  if (!bytesEqual(bytes, state.modules)) {
    return {kind: "mismatch", message: MISMATCH_COMPOSE};
  }
  const orderedInputs = [...record.inputs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const donors: DnaDonor[] = [
    {
      id: "survivor",
      materialized: survivor.modules != null,
      seed: survivor.seed,
      denomIndex: survivor.denomIndex,
      inkGene: survivor.inkGene,
      modules: survivor.modules,
    },
    ...orderedInputs.map((inp) => ({
      id: inp.id.toString(),
      materialized: inp.modules.length > 0,
      seed: inp.seed,
      denomIndex: inp.denomIndex,
      inkGene: inp.inkGene,
      modules: inp.modules.length > 0 ? inp.modules : undefined,
    })),
  ];
  return {kind: "compose", geometry, bytes, cells: cellsFromComposeTrace(trace), donors, survivorDepth: depth - 1};
}

/**
 * Split branch (SAMPLING_SPEC.md section 12, D3'): sample the child from the split's pool at the
 * child's own live denomination and index, and verify the result equals its live materialized
 * bytes. `record`, when given (the parent's top compose record, only present when the parent's
 * own `composeDepth` was nonzero at resolution time), selects the record branch; its absence
 * selects the grammar branch. The parent's own `origin.parentModules` snapshot is never read for
 * sampling in either branch — it is informational only, carried through to `parent.modules` for
 * display.
 */
export function deriveSplitDna(
  state: RawShapeState,
  origin: RawSplitOrigin,
  record?: RawComposeRecord,
  p?: Params,
): DnaSplitResult | DnaMismatchResult {
  const geometry = geometryAt(state.denomIndex, p);
  const parent: SampleDonor = {
    seed: origin.parentSeed,
    denomIndex: origin.parentDenomIndex,
    inkGene: origin.parentInkGene,
    modules: origin.parentModules.length > 0 ? origin.parentModules : undefined,
  };

  const lastMergeDonors: LastMergeDonors | undefined = record
    ? {
        survivor: {
          seed: origin.parentSeed,
          denomIndex: record.survivorDenomIndex,
          inkGene: record.survivorInkGene,
          modules: record.survivorModules.length > 0 ? record.survivorModules : undefined,
        },
        inputs: record.inputs.map((inp) => ({
          tokenId: inp.id,
          seed: inp.seed,
          denomIndex: inp.denomIndex,
          inkGene: inp.inkGene,
          modules: inp.modules.length > 0 ? inp.modules : undefined,
        })),
      }
    : undefined;

  const {bytes, trace, branch, poolLength} = sampleSplitChildTraced(
    parent,
    state.denomIndex,
    origin.childIndex,
    p,
    lastMergeDonors,
  );
  if (!bytesEqual(bytes, state.modules)) {
    return {kind: "mismatch", message: MISMATCH_SPLIT};
  }

  const pool =
    branch === "grammar"
      ? {
          seed: origin.parentSeed,
          denomIndex: state.denomIndex,
          inkGene: origin.parentInkGene,
          modules: grammarSplitPoolBytes(origin.parentSeed, state.denomIndex, origin.parentInkGene, p),
        }
      : undefined;

  return {
    kind: "split",
    geometry,
    bytes,
    cells: cellsFromSplitTrace(trace),
    branch,
    poolLength,
    parent: {
      seed: origin.parentSeed,
      denomIndex: origin.parentDenomIndex,
      inkGene: origin.parentInkGene,
      materialized: parent.modules != null,
      modules: parent.modules,
    },
    pool,
  };
}

/** Seed-derived branch: grammar v1 straight from the token's own seed when `state.modules` is
 *  empty. Nothing stored to verify against in that case, since an unmaterialized token has no
 *  on-chain module bytes. When `state.modules` is nonempty (a materialized snapshot with no
 *  recoverable provenance beyond itself — see `loadDnaFromSnapshot`'s split-parent case), those
 *  bytes are decoded directly instead of being re-derived from the seed. */
export function deriveSeedDna(state: RawShapeState, p?: Params): DnaSeedResult {
  const geometry = geometryAt(state.denomIndex, p);
  const bytes = effectiveModuleBytes(
    {
      seed: state.seed,
      denomIndex: state.denomIndex,
      inkGene: state.inkGene,
      modules: state.modules.length > 0 ? state.modules : undefined,
    },
    p,
  );
  return {kind: "seed", geometry, bytes, cells: cellsFromBytes(bytes), materialized: state.modules.length > 0};
}

/* ------------------------------------------------------------------ *
 * Chain reads
 * ------------------------------------------------------------------ */

/** A donor snapshot's identity fields plus the token id needed to read its own provenance:
 *  `composeDepth`, `composeRecordAt` and `splitOriginOf` all survive burning and answer for any
 *  id that ever existed, live or not. */
export interface DnaSnapshot {
  id: bigint;
  seed: bigint;
  denomIndex: number;
  inkGene: number;
  modules: Uint8Array;
}

/**
 * Classify and reconstruct a token's per-cell DNA once its identity fields and compose depth are
 * already known, whether from a live `shapeState`/`composeDepth` read (`loadDna`) or a
 * caller-supplied snapshot and depth (`loadDnaFromSnapshot`). Reads `composeRecordAt` or
 * `splitOriginOf` (both on `ShapeLens`) as the depth/modules classification requires. A
 * `splitOriginOf` revert (or any other read failure on that path) degrades to an `"unavailable"`
 * result rather than throwing, since `NotASplitChild` is an expected outcome whenever the
 * classification's assumption about stored state does not hold.
 */
async function resolveDna(
  publicClient: PublicClient,
  dep: Deployment,
  id: bigint,
  state: RawShapeState,
  depth: number,
): Promise<DnaResult> {
  const lens = {address: dep.lens, abi: shapeLensAbi} as const;

  const branch = classifyDna(depth, state.modules.length);

  if (branch === "compose") {
    const record = await publicClient.readContract({
      ...lens,
      functionName: "composeRecordAt",
      args: [id, BigInt(depth - 1)],
    });
    const rawRecord: RawComposeRecord = {
      survivorDenomIndex: record.survivorDenominationIndex,
      survivorInkGene: record.survivorInkGene,
      survivorModules: hexToBytes(record.survivorModules),
      inputs: record.inputs.map((inp) => ({
        id: inp.id,
        seed: BigInt(inp.seed),
        denomIndex: inp.denominationIndex,
        inkGene: inp.inkGene,
        modules: hexToBytes(inp.modules),
      })),
    };
    return deriveComposeDna(state, rawRecord, depth);
  }

  if (branch === "split") {
    const shapes = {address: dep.shapes, abi: shapesAbi} as const;
    try {
      const [parentSeed, parentId, parentDenomIndex, parentInkGene, parentModules, childIndex] =
        await publicClient.readContract({
          ...lens,
          functionName: "splitOriginOf",
          args: [id],
        });
      const rawOrigin: RawSplitOrigin = {
        parentSeed: BigInt(parentSeed),
        parentId,
        parentDenomIndex,
        parentInkGene,
        parentModules: hexToBytes(parentModules),
        childIndex: Number(childIndex),
      };

      // The split branch decision (SAMPLING_SPEC.md section 6, D3') keys off the PARENT's own
      // compose depth, not anything about the child: nonzero means the parent had a compose
      // record at split time (`_composeStack[parentId]` is read but never deleted by split), so
      // the record branch applies.
      const parentDepth = Number(
        await publicClient.readContract({...shapes, functionName: "composeDepth", args: [parentId]}),
      );

      let record: RawComposeRecord | undefined;
      if (parentDepth > 0) {
        const rec = await publicClient.readContract({
          ...lens,
          functionName: "composeRecordAt",
          args: [parentId, BigInt(parentDepth - 1)],
        });
        record = {
          survivorDenomIndex: rec.survivorDenominationIndex,
          survivorInkGene: rec.survivorInkGene,
          survivorModules: hexToBytes(rec.survivorModules),
          inputs: rec.inputs.map((inp) => ({
            id: inp.id,
            seed: BigInt(inp.seed),
            denomIndex: inp.denominationIndex,
            inkGene: inp.inkGene,
            modules: hexToBytes(inp.modules),
          })),
        };
      }

      return deriveSplitDna(state, rawOrigin, record);
    } catch {
      return {kind: "unavailable", message: "Split provenance is unavailable for this token."};
    }
  }

  return deriveSeedDna(state);
}

/**
 * Read a live token's provenance and reconstruct its per-cell DNA. Reads `shapeState` (on
 * `ShapeLens`) and `composeDepth` (on `Shapes`) in parallel, then classifies and resolves via
 * `resolveDna`. A missing `dep.lens` (a stale `deployment.json` predating the lens split) fails
 * every lens read the same way and is caught by the caller in `TokenView`, which renders the DNA
 * section as unavailable.
 */
export async function loadDna(publicClient: PublicClient, dep: Deployment, tokenId: bigint): Promise<DnaResult> {
  const lens = {address: dep.lens, abi: shapeLensAbi} as const;
  const shapes = {address: dep.shapes, abi: shapesAbi} as const;

  const [rawState, rawDepth] = await Promise.all([
    publicClient.readContract({...lens, functionName: "shapeState", args: [tokenId]}),
    publicClient.readContract({...shapes, functionName: "composeDepth", args: [tokenId]}),
  ]);

  const state: RawShapeState = {
    seed: BigInt(rawState.seed),
    denomIndex: rawState.denominationIndex,
    inkGene: rawState.inkGene,
    modules: hexToBytes(rawState.modules),
  };

  return resolveDna(publicClient, dep, tokenId, state, Number(rawDepth));
}

/**
 * Read a burned-or-live token's provenance from a compose/split record snapshot rather than
 * `shapeState`, which reverts once the id is burned. Identity fields come entirely from
 * `snapshot`; classification and reconstruction otherwise proceed exactly as `loadDna`'s.
 *
 * `depthOverride`, when given, replaces the `composeDepth(snapshot.id)` chain read. This is
 * correct for exactly one case: drilling into a compose record's "survivor" donor (see
 * `DnaComposeResult.survivorDepth`), whose own effective depth is one less than the depth its
 * enclosing record was read at — a fresh `composeDepth` read on that same id would instead return
 * the token's current, later depth and re-fetch the same record rather than walk further down the
 * stack. Every other donor (a burned compose input, a split child) stops mutating once buried, so
 * its live `composeDepth` is already the depth to classify it at.
 */
export async function loadDnaFromSnapshot(
  publicClient: PublicClient,
  dep: Deployment,
  snapshot: DnaSnapshot,
  depthOverride?: number,
): Promise<DnaResult> {
  const state: RawShapeState = {
    seed: snapshot.seed,
    denomIndex: snapshot.denomIndex,
    inkGene: snapshot.inkGene,
    modules: snapshot.modules,
  };

  const depth =
    depthOverride ??
    Number(
      await publicClient.readContract({
        address: dep.shapes,
        abi: shapesAbi,
        functionName: "composeDepth",
        args: [snapshot.id],
      }),
    );

  return resolveDna(publicClient, dep, snapshot.id, state, depth);
}
