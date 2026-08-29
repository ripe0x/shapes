import React from "react";
import { C, mono, Section, Button, Label, Toggle } from "./ui";
import { CANONICAL, type Params } from "../canonical/params";
import { DENOMINATIONS, LABELS, unitsAt } from "../canonical/denominations";
import { composeShape } from "../canonical/render";
import { GENE_NAMES, centerGene, geneAtCompose } from "../canonical/ink";
import { encodeModules, moduleBytesToHex } from "../canonical/moduleCodec";
import {
  composeSampledShape,
  composeSampleSeedInputs,
  effectiveModuleBytes,
  grammarSplitPoolBytes,
  sampleComposeTraced,
  sampleSplitChildTraced,
  splitSampleSeedInputs,
  type ComposeTraceResult,
  type LastMergeDonors,
  type SampleBurn,
  type SampleDonor,
  type SplitTraceResult,
} from "../canonical/sampling";
import { productionSeed } from "../seeds";
import { Inspect } from "./Inspect";
import { donorColor, Row, ProvenanceCard, DetailPanel } from "./provenance";

/**
 * DNA — per-cell sample provenance for compose and split.
 *
 * Configures the inputs `sampleComposeTraced`/`sampleSplitChildTraced` take, renders the result
 * alongside every donor, and lets a cell in the result be traced back to the exact donor and
 * source module index it was drawn from. No chain calls; every value here is computed by the
 * canonical TypeScript sampler.
 */

const MATERIALIZE_SALT = 0xc0ffeen;

/**
 * Placeholder stored bytes for a donor marked "materialized" in this view: an independent
 * module sequence derived from the donor's own seed XORed with a fixed salt, at the same
 * denomination and gene. This does not model an actual upstream compose chain — it exists only
 * to exercise `donorMaterialized`/`parentMaterialized` and to give a materialized donor card
 * bytes that differ from what its raw seed alone would produce.
 */
function materializedModules(seed: bigint, denomIndex: number, inkGene: number, p: Params): Uint8Array {
  const amountWei = DENOMINATIONS[denomIndex];
  const composition = composeShape(seed ^ MATERIALIZE_SALT, amountWei, inkGene, p);
  return encodeModules(composition.modules);
}

interface DonorForm {
  seed: bigint;
  denomIndex: number;
  inkGene: number;
  materialized: boolean;
}

interface BurnForm extends DonorForm {
  tokenId: bigint;
}

function toSampleDonor(f: DonorForm, p: Params): SampleDonor {
  return {
    seed: f.seed,
    denomIndex: f.denomIndex,
    inkGene: f.inkGene,
    modules: f.materialized ? materializedModules(f.seed, f.denomIndex, f.inkGene, p) : undefined,
  };
}

function toSampleBurn(f: BurnForm, p: Params): SampleBurn {
  return { ...toSampleDonor(f, p), tokenId: f.tokenId };
}

function byTokenIdAscending(a: BurnForm, b: BurnForm): number {
  return a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0;
}

function randomIndex(): bigint {
  return BigInt(Math.floor(Math.random() * 1_000_000));
}

function hex64(v: bigint): string {
  return "0x" + v.toString(16).padStart(64, "0");
}

function SeedField({ seed, onChange }: { seed: bigint; onChange: (v: bigint) => void }) {
  const [text, setText] = React.useState(() => seed.toString(16));
  React.useEffect(() => {
    setText(seed.toString(16));
  }, [seed]);
  const commit = () => {
    try {
      const v = BigInt("0x" + text.replace(/^0x/, ""));
      onChange(v);
    } catch {
      setText(seed.toString(16));
    }
  };
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ ...mono, fontSize: 10, color: C.dim, letterSpacing: "0.08em" }}>seed (hex)</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        style={{
          ...mono,
          fontSize: 11,
          width: 170,
          padding: "5px 7px",
          border: `1px solid ${C.hair}`,
          borderRadius: 3,
          background: "#fff",
        }}
      />
    </label>
  );
}

function DonorEditor({
  title,
  color,
  donor,
  onChange,
  extra,
}: {
  title: string;
  color?: string;
  donor: DonorForm;
  onChange: (patch: Partial<DonorForm>) => void;
  extra?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.hair}`,
        borderRadius: 5,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 230,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {color && <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />}
        <span style={{ ...mono, fontSize: 11, letterSpacing: "0.08em", fontWeight: 600 }}>{title}</span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <SeedField seed={donor.seed} onChange={(seed) => onChange({ seed })} />
        <Button onClick={() => onChange({ seed: productionSeed(randomIndex()) })}>randomize</Button>
      </div>
      <div>
        <Label>denomination</Label>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {LABELS.map((label, i) => (
            <Button key={i} active={donor.denomIndex === i} onClick={() => onChange({ denomIndex: i })}>
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <Label>ink gene</Label>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {GENE_NAMES.map((name, i) => (
            <Button key={i} active={donor.inkGene === i} onClick={() => onChange({ inkGene: i })}>
              {name}
            </Button>
          ))}
        </div>
      </div>
      <Toggle
        label="materialized (independent stored modules)"
        checked={donor.materialized}
        canonical={false}
        onChange={(materialized) => onChange({ materialized })}
      />
      {extra}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Compose mode
 * ------------------------------------------------------------------ */

function ComposeDna({ params }: { params: Params }) {
  const [survivor, setSurvivor] = React.useState<DonorForm>({
    seed: productionSeed(1n),
    denomIndex: 3,
    inkGene: 3,
    materialized: false,
  });
  const [burnForms, setBurnForms] = React.useState<BurnForm[]>([
    { tokenId: 2n, seed: productionSeed(2n), denomIndex: 1, inkGene: 2, materialized: false },
    { tokenId: 3n, seed: productionSeed(3n), denomIndex: 1, inkGene: 4, materialized: true },
  ]);
  const [newIndex, setNewIndex] = React.useState(4);

  const [hoverResultCell, setHoverResultCell] = React.useState<number | null>(null);
  const [pinnedResultCell, setPinnedResultCell] = React.useState<number | null>(null);
  const [hoverDonorCell, setHoverDonorCell] = React.useState<{ donorIndex: number; moduleIndex: number } | null>(
    null,
  );
  const [inspectResult, setInspectResult] = React.useState(false);

  const orderedBurnForms = React.useMemo(() => [...burnForms].sort(byTokenIdAscending), [burnForms]);
  const donorForms = React.useMemo(() => [survivor, ...orderedBurnForms], [survivor, orderedBurnForms]);
  const donorLabels = React.useMemo(
    () => ["survivor", ...orderedBurnForms.map((f) => `burn #${f.tokenId.toString()}`)],
    [orderedBurnForms],
  );

  const survivorDonor = React.useMemo(() => toSampleDonor(survivor, params), [survivor, params]);
  const burnDonors = React.useMemo(
    () => orderedBurnForms.map((f) => toSampleBurn(f, params)),
    [orderedBurnForms, params],
  );

  const composeResult: ComposeTraceResult | null = React.useMemo(() => {
    try {
      return sampleComposeTraced(survivorDonor, burnDonors, newIndex, params);
    } catch {
      return null;
    }
  }, [survivorDonor, burnDonors, newIndex, params]);

  const seedInputs = React.useMemo(
    () => composeSampleSeedInputs(survivorDonor, burnDonors, newIndex),
    [survivorDonor, burnDonors, newIndex],
  );

  // The gene the contract would assign: geneAtCompose over the pool statistics of
  // {survivor + burns}, exactly as `Shapes._compose` computes it. Sampled geometry never
  // draws ink, so this affects metadata display only. Falls back to the survivor's gene
  // when the chosen result denomination is not above the survivor's (unreachable onchain).
  const resultGene = React.useMemo(() => {
    let sumW = 0n;
    let unitsTotal = 0n;
    let best = survivor.inkGene;
    let worst = survivor.inkGene;
    for (const f of donorForms) {
      const u = unitsAt(f.denomIndex);
      sumW += BigInt(f.inkGene) * u;
      unitsTotal += u;
      if (f.inkGene > best) best = f.inkGene;
      if (f.inkGene < worst) worst = f.inkGene;
    }
    if (newIndex <= survivor.denomIndex) return survivor.inkGene;
    return geneAtCompose(
      seedInputs.survivorSeed,
      seedInputs.burnSeedFold,
      survivor.inkGene,
      survivor.denomIndex,
      newIndex,
      best,
      worst,
      centerGene(sumW, unitsTotal),
    );
  }, [donorForms, survivor, newIndex, seedInputs]);

  const donorCompositions = React.useMemo(
    () =>
      donorForms.map((f) => {
        const bytes = effectiveModuleBytes(toSampleDonor(f, params), params);
        return composeSampledShape(bytes, f.denomIndex, f.inkGene, params);
      }),
    [donorForms, params],
  );

  const resultComposition = React.useMemo(() => {
    if (!composeResult) return null;
    try {
      return composeSampledShape(composeResult.bytes, newIndex, resultGene, params);
    } catch {
      return null;
    }
  }, [composeResult, newIndex, resultGene, params]);

  const resultCellsByDonorCell = React.useMemo(() => {
    const map = new Map<string, number[]>();
    if (!composeResult) return map;
    composeResult.trace.forEach((cell, j) => {
      const key = `${cell.donorIndex}:${cell.moduleIndex}`;
      const list = map.get(key) ?? [];
      list.push(j);
      map.set(key, list);
    });
    return map;
  }, [composeResult]);

  const activeResultCell = hoverResultCell ?? pinnedResultCell;
  const activeTraceCell =
    activeResultCell != null && composeResult ? composeResult.trace[activeResultCell] : null;

  const highlightedResultCells = React.useMemo(() => {
    if (hoverDonorCell) {
      return new Set(resultCellsByDonorCell.get(`${hoverDonorCell.donorIndex}:${hoverDonorCell.moduleIndex}`) ?? []);
    }
    if (activeResultCell != null) return new Set([activeResultCell]);
    return new Set<number>();
  }, [hoverDonorCell, activeResultCell, resultCellsByDonorCell]);

  const setBurn = (i: number, patch: Partial<BurnForm>) => {
    setBurnForms((cur) => cur.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  };
  const addBurn = () => {
    setBurnForms((cur) => {
      const nextId = cur.reduce((m, f) => (f.tokenId > m ? f.tokenId : m), 1n) + 1n;
      return [...cur, { tokenId: nextId, seed: productionSeed(randomIndex()), denomIndex: 1, inkGene: 2, materialized: false }];
    });
  };
  const removeBurn = (i: number) => setBurnForms((cur) => cur.filter((_, j) => j !== i));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <DonorEditor
          title="survivor"
          color={donorColor(0)}
          donor={survivor}
          onChange={(patch) => setSurvivor((s) => ({ ...s, ...patch }))}
        />
        {burnForms.map((f, i) => {
          const canonicalPos = donorLabels.findIndex((l) => l === `burn #${f.tokenId.toString()}`);
          return (
            <DonorEditor
              key={i}
              title={`burn #${f.tokenId.toString()}`}
              color={donorColor(canonicalPos < 0 ? i + 1 : canonicalPos)}
              donor={f}
              onChange={(patch) => setBurn(i, patch)}
              extra={
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ ...mono, fontSize: 10, color: C.dim, letterSpacing: "0.08em" }}>token id</span>
                    <input
                      type="number"
                      value={Number(f.tokenId)}
                      min={1}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v >= 1) setBurn(i, { tokenId: BigInt(Math.floor(v)) });
                      }}
                      style={{
                        ...mono,
                        fontSize: 11,
                        width: 70,
                        padding: "5px 7px",
                        border: `1px solid ${C.hair}`,
                        borderRadius: 3,
                        background: "#fff",
                      }}
                    />
                  </label>
                  <Button onClick={() => removeBurn(i)}>remove</Button>
                </div>
              }
            />
          );
        })}
        <Button onClick={addBurn}>add burn</Button>
      </div>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <Label>result denomination</Label>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {LABELS.map((label, i) => (
              <Button key={i} active={newIndex === i} onClick={() => setNewIndex(i)}>
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <Label>result ink gene (computed via geneAtCompose; sampled cells keep their parents' ink)</Label>
          <div style={{ ...mono, fontSize: 12, padding: "7px 2px" }}>
            {GENE_NAMES[resultGene]} ({resultGene})
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" }}>
        {resultComposition && (
          <ProvenanceCard
            composition={resultComposition}
            params={params}
            width={320}
            label="composed result"
            cellStyle={(j) => {
              if (!composeResult) return undefined;
              const cell = composeResult.trace[j];
              const color = donorColor(cell.donorIndex);
              const highlighted = highlightedResultCells.has(j);
              return {
                background: `${color}4d`,
                outline: `${highlighted ? 2 : 1}px solid ${color}${highlighted ? "" : "55"}`,
                outlineOffset: -1,
              };
            }}
            onEnter={(j) => {
              setHoverDonorCell(null);
              setHoverResultCell(j);
            }}
            onLeave={() => setHoverResultCell(null)}
            onClickCell={(j) => setPinnedResultCell((cur) => (cur === j ? null : j))}
          />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <Label>donor legend</Label>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {donorForms.map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: donorColor(i) }} />
                  <span style={{ ...mono, fontSize: 10.5, color: C.mid }}>
                    {donorLabels[i]}
                    {f.materialized ? " · materialized" : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <Button onClick={() => setInspectResult(true)} disabled={!resultComposition || !composeResult}>
            open in inspector
          </Button>

          {activeTraceCell && (
            <DetailPanel
              label={donorLabels[activeTraceCell.donorIndex] ?? activeTraceCell.donorId}
              moduleIndex={activeTraceCell.moduleIndex}
              byte={activeTraceCell.byte}
              color={donorColor(activeTraceCell.donorIndex)}
            />
          )}

          <div style={{ border: `1px solid ${C.hair}`, borderRadius: 5, padding: 12, minWidth: 260 }}>
            <Row k="survivor seed" v={hex64(seedInputs.survivorSeed)} />
            <Row k="burnSeedFold" v={hex64(seedInputs.burnSeedFold)} />
            <Row k="newIndex" v={seedInputs.newIndex} />
            <Row k="sample seed" v={hex64(seedInputs.sampleSeed)} />
            <Row k="result bytes" v={composeResult ? moduleBytesToHex(composeResult.bytes) : "—"} />
          </div>
        </div>
      </div>

      <div>
        <Label>donors</Label>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          {donorCompositions.map((c, i) => (
            <ProvenanceCard
              key={i}
              composition={c}
              params={params}
              width={160}
              label={donorLabels[i]}
              cellStyle={(j) => {
                const isActive = activeTraceCell != null && activeTraceCell.donorIndex === i && activeTraceCell.moduleIndex === j;
                if (!isActive) return undefined;
                return { outline: `2px solid ${donorColor(i)}`, outlineOffset: -1, background: `${donorColor(i)}33` };
              }}
              onEnter={(j) => {
                setHoverResultCell(null);
                setHoverDonorCell({ donorIndex: i, moduleIndex: j });
              }}
              onLeave={() => setHoverDonorCell(null)}
            />
          ))}
        </div>
      </div>

      {inspectResult && resultComposition && composeResult && (
        <Inspect
          sampled={{
            composition: resultComposition,
            bytes: composeResult.bytes,
            tokenId: 0n,
            label: "composed result",
          }}
          provenance={{
            type: "compose",
            trace: composeResult.trace,
            donorLabels,
            donorMaterialized: donorForms.map((f) => f.materialized),
          }}
          params={params}
          showGrid={false}
          inverted={false}
          onClose={() => setInspectResult(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Split mode
 * ------------------------------------------------------------------ */

/** The record branch's pre-compose survivor snapshot (SAMPLING_SPEC.md §6, D3'): denomination,
 *  ink gene and materialized-or-not only. No seed field — the record's survivor is the same
 *  token as the split's parent, so its seed is always the parent's own (compose never changes a
 *  token's seed); a separate seed control here would let the sandbox build a combination the
 *  contract can never produce. */
interface RecordSurvivorForm {
  denomIndex: number;
  inkGene: number;
  materialized: boolean;
}

function RecordSurvivorEditor({
  survivor,
  onChange,
}: {
  survivor: RecordSurvivorForm;
  onChange: (patch: Partial<RecordSurvivorForm>) => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.hair}`,
        borderRadius: 5,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 230,
      }}
    >
      <div style={{ ...mono, fontSize: 11, letterSpacing: "0.08em", fontWeight: 600 }}>
        record survivor (pre-compose)
      </div>
      <div style={{ ...mono, fontSize: 10, color: C.dim }}>seed: same as parent</div>
      <div>
        <Label>denomination</Label>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {LABELS.map((label, i) => (
            <Button key={i} active={survivor.denomIndex === i} onClick={() => onChange({ denomIndex: i })}>
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <Label>ink gene</Label>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {GENE_NAMES.map((name, i) => (
            <Button key={i} active={survivor.inkGene === i} onClick={() => onChange({ inkGene: i })}>
              {name}
            </Button>
          ))}
        </div>
      </div>
      <Toggle
        label="materialized (independent stored modules)"
        checked={survivor.materialized}
        canonical={false}
        onChange={(materialized) => onChange({ materialized })}
      />
    </div>
  );
}

/**
 * Split mode (SAMPLING_SPEC.md §6, D3'). The parent card is informational only — it shows what
 * the parent itself looks like, but neither sampling branch reads its modules. `hasRecord` picks
 * the branch:
 *
 *   off (grammar branch): each child's pool is the parent seed's grammar v1 expression at that
 *   child's own denomination. That pool is always a full grid at the child's denomination (same
 *   reason a compose donor's own module count equals its own grid), so it renders as an ordinary
 *   pool card per distinct child denomination, with the same two-way cell highlight the parent
 *   card used to have.
 *
 *   on (record branch): each child's pool is the concatenation of a fabricated compose record's
 *   survivor and input modules, in canonical order. That pool's length is a sum across donors and
 *   generally is not any denomination's grid cell count, so it has no card form — the pool index
 *   and byte are shown in the detail panel only, with no card to hover (matches how
 *   `preview/src/site/TokenView.tsx` handles the same branch for a live token).
 */
function SplitDna({ params }: { params: Params }) {
  const [parent, setParent] = React.useState<DonorForm>({
    seed: productionSeed(10n),
    denomIndex: 6,
    inkGene: 4,
    materialized: false,
  });
  const [childDenoms, setChildDenoms] = React.useState<number[]>([7, 7]);

  const [hasRecord, setHasRecord] = React.useState(false);
  const [recordSurvivor, setRecordSurvivor] = React.useState<RecordSurvivorForm>({
    denomIndex: 3,
    inkGene: 4,
    materialized: false,
  });
  const [recordInputs, setRecordInputs] = React.useState<BurnForm[]>([
    { tokenId: 2n, seed: productionSeed(2n), denomIndex: 1, inkGene: 2, materialized: false },
    { tokenId: 3n, seed: productionSeed(3n), denomIndex: 1, inkGene: 4, materialized: true },
  ]);

  const [active, setActive] = React.useState<{ child: number; cell: number } | null>(null);
  const [hover, setHover] = React.useState<{ child: number; cell: number } | null>(null);
  const [hoverPoolCell, setHoverPoolCell] = React.useState<{ denom: number; moduleIndex: number } | null>(null);
  const [inspectChild, setInspectChild] = React.useState<number | null>(null);

  const parentDonor = React.useMemo(() => toSampleDonor(parent, params), [parent, params]);
  const parentBytes = React.useMemo(() => effectiveModuleBytes(parentDonor, params), [parentDonor, params]);
  const parentComposition = React.useMemo(
    () => composeSampledShape(parentBytes, parent.denomIndex, parent.inkGene, params),
    [parentBytes, parent.denomIndex, parent.inkGene, params],
  );

  const orderedRecordInputs = React.useMemo(() => [...recordInputs].sort(byTokenIdAscending), [recordInputs]);

  const lastMergeDonors: LastMergeDonors | undefined = React.useMemo(() => {
    if (!hasRecord) return undefined;
    return {
      survivor: {
        seed: parent.seed, // the record's survivor is this same token, seed unchanged by compose
        denomIndex: recordSurvivor.denomIndex,
        inkGene: recordSurvivor.inkGene,
        modules: recordSurvivor.materialized
          ? materializedModules(parent.seed, recordSurvivor.denomIndex, recordSurvivor.inkGene, params)
          : undefined,
      },
      inputs: orderedRecordInputs.map((f) => toSampleBurn(f, params)),
    };
  }, [hasRecord, parent.seed, recordSurvivor, orderedRecordInputs, params]);

  const childResults: (SplitTraceResult | null)[] = React.useMemo(
    () =>
      childDenoms.map((d, i) => {
        try {
          return sampleSplitChildTraced(parentDonor, d, i, params, lastMergeDonors);
        } catch {
          return null;
        }
      }),
    [childDenoms, parentDonor, params, lastMergeDonors],
  );

  const childSeedInputs = React.useMemo(
    () => childDenoms.map((d, i) => splitSampleSeedInputs(parentDonor, d, i)),
    [childDenoms, parentDonor],
  );

  const childCompositions = React.useMemo(
    () =>
      childResults.map((r, i) => {
        if (!r) return null;
        try {
          return composeSampledShape(r.bytes, childDenoms[i], parent.inkGene, params);
        } catch {
          return null;
        }
      }),
    [childResults, childDenoms, parent.inkGene, params],
  );

  // Grammar branch only: one pool card per distinct child denomination, the parent seed's
  // expression at that denomination. The record branch's pool has no single grid shape (see the
  // component doc comment), so this map stays empty when `hasRecord`.
  const distinctChildDenoms = React.useMemo(
    () => Array.from(new Set(childDenoms)).sort((a, b) => a - b),
    [childDenoms],
  );
  const poolCompositionByDenom = React.useMemo(() => {
    const m = new Map<number, ReturnType<typeof composeSampledShape>>();
    if (hasRecord) return m;
    for (const d of distinctChildDenoms) {
      const bytes = grammarSplitPoolBytes(parent.seed, d, parent.inkGene, params);
      m.set(d, composeSampledShape(bytes, d, parent.inkGene, params));
    }
    return m;
  }, [hasRecord, distinctChildDenoms, parent.seed, parent.inkGene, params]);

  const shown = hover ?? active;
  const shownTrace = shown && childResults[shown.child] ? childResults[shown.child]!.trace[shown.cell] : null;
  const shownDenom = shown ? childDenoms[shown.child] : null;

  const childCellsFromPoolModule = React.useMemo(() => {
    if (hoverPoolCell == null) return null;
    return childResults.map((r, i) => {
      if (!r || childDenoms[i] !== hoverPoolCell.denom) return new Set<number>();
      const cells: number[] = [];
      r.trace.forEach((cell, j) => {
        if (cell.moduleIndex === hoverPoolCell.moduleIndex) cells.push(j);
      });
      return new Set(cells);
    });
  }, [hoverPoolCell, childResults, childDenoms]);

  const setChildDenom = (i: number, d: number) => setChildDenoms((cur) => cur.map((v, j) => (j === i ? d : v)));
  const addChild = () => setChildDenoms((cur) => [...cur, parent.denomIndex]);
  const removeChild = (i: number) => setChildDenoms((cur) => cur.filter((_, j) => j !== i));

  const setRecordInput = (i: number, patch: Partial<BurnForm>) => {
    setRecordInputs((cur) => cur.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  };
  const addRecordInput = () => {
    setRecordInputs((cur) => {
      const nextId = cur.reduce((m, f) => (f.tokenId > m ? f.tokenId : m), 1n) + 1n;
      return [...cur, { tokenId: nextId, seed: productionSeed(randomIndex()), denomIndex: 1, inkGene: 2, materialized: false }];
    });
  };
  const removeRecordInput = (i: number) => setRecordInputs((cur) => cur.filter((_, j) => j !== i));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <DonorEditor
        title="parent"
        donor={parent}
        onChange={(patch) => setParent((p) => ({ ...p, ...patch }))}
      />

      <div>
        <Label>parent (informational only since D3' — neither branch samples from its own modules)</Label>
        <ProvenanceCard composition={parentComposition} params={params} width={200} cellStyle={() => undefined} />
      </div>

      <Toggle
        label="parent has a compose record (record branch, SAMPLING_SPEC.md §6, D3')"
        checked={hasRecord}
        canonical={false}
        onChange={setHasRecord}
      />

      {hasRecord && (
        <div>
          <Label>record donors (pool = survivor's modules, then inputs ascending by token id)</Label>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <RecordSurvivorEditor
              survivor={recordSurvivor}
              onChange={(patch) => setRecordSurvivor((s) => ({ ...s, ...patch }))}
            />
            {recordInputs.map((f, i) => (
              <DonorEditor
                key={i}
                title={`input #${f.tokenId.toString()}`}
                donor={f}
                onChange={(patch) => setRecordInput(i, patch)}
                extra={
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ ...mono, fontSize: 10, color: C.dim, letterSpacing: "0.08em" }}>token id</span>
                      <input
                        type="number"
                        value={Number(f.tokenId)}
                        min={1}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 1) setRecordInput(i, { tokenId: BigInt(Math.floor(v)) });
                        }}
                        style={{
                          ...mono,
                          fontSize: 11,
                          width: 70,
                          padding: "5px 7px",
                          border: `1px solid ${C.hair}`,
                          borderRadius: 3,
                          background: "#fff",
                        }}
                      />
                    </label>
                    <Button onClick={() => removeRecordInput(i)}>remove</Button>
                  </div>
                }
              />
            ))}
            <Button onClick={addRecordInput}>add input</Button>
          </div>
          <div style={{ ...mono, fontSize: 10, color: C.dim, marginTop: 8 }}>
            pool length: {childResults[0]?.poolLength ?? "—"} — no card form; see pool index/byte per cell below
          </div>
        </div>
      )}

      {!hasRecord && (
        <div>
          <Label>
            pool per child denomination (grammar branch — hover a cell to highlight every child of that
            denomination sampled from it)
          </Label>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            {distinctChildDenoms.map((d) => {
              const composition = poolCompositionByDenom.get(d);
              if (!composition) return null;
              return (
                <ProvenanceCard
                  key={d}
                  composition={composition}
                  params={params}
                  width={160}
                  label={`pool — denom ${LABELS[d]}`}
                  cellStyle={(j) => {
                    const fromShown = shownDenom === d && shownTrace && shownTrace.moduleIndex === j;
                    const isHovered = hoverPoolCell?.denom === d && hoverPoolCell.moduleIndex === j;
                    if (!fromShown && !isHovered) return undefined;
                    return { outline: `2px solid ${C.warn}`, outlineOffset: -1, background: `${C.warn}33` };
                  }}
                  onEnter={(j) => setHoverPoolCell({ denom: d, moduleIndex: j })}
                  onLeave={() => setHoverPoolCell(null)}
                />
              );
            })}
          </div>
        </div>
      )}

      <div>
        <Label>children</Label>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 12 }}>
          {childDenoms.map((d, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 200 }}>
                {LABELS.map((label, di) => (
                  <Button key={di} active={d === di} onClick={() => setChildDenom(i, di)}>
                    {label}
                  </Button>
                ))}
                <Button onClick={() => removeChild(i)}>remove</Button>
              </div>
              {childCompositions[i] && (
                <ProvenanceCard
                  composition={childCompositions[i]!}
                  params={params}
                  width={160}
                  label={`child #${i} — denom ${LABELS[d]}`}
                  cellStyle={(j) => {
                    const fromPoolHover = !hasRecord && (childCellsFromPoolModule?.[i]?.has(j) ?? false);
                    const isActive = shown && shown.child === i && shown.cell === j;
                    if (!fromPoolHover && !isActive) return undefined;
                    return {
                      outline: `2px solid ${C.warn}`,
                      outlineOffset: -1,
                      background: `${C.warn}33`,
                    };
                  }}
                  onEnter={(j) => setHover({ child: i, cell: j })}
                  onLeave={() => setHover(null)}
                  onClickCell={(j) =>
                    setActive((cur) => (cur && cur.child === i && cur.cell === j ? null : { child: i, cell: j }))
                  }
                />
              )}
              <div style={{ ...mono, fontSize: 10, color: C.dim }}>
                {childResults[i] ? moduleBytesToHex(childResults[i]!.bytes) : "—"}
              </div>
              <Button onClick={() => setInspectChild(i)} disabled={!childCompositions[i] || !childResults[i]}>
                open in inspector
              </Button>
            </div>
          ))}
        </div>
        <Button onClick={addChild}>add child</Button>
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        {shownTrace && shown && (
          <DetailPanel
            label={`pool cell (${hasRecord ? "record" : "grammar"} branch, child #${shown.child})`}
            moduleIndex={shownTrace.moduleIndex}
            byte={shownTrace.byte}
            color={C.warn}
          />
        )}
        <div style={{ border: `1px solid ${C.hair}`, borderRadius: 5, padding: 12, minWidth: 260 }}>
          {childSeedInputs.map((s, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ ...mono, fontSize: 10, color: C.dim, marginBottom: 3 }}>child #{i}</div>
              <Row k="parent seed" v={hex64(s.parentSeed)} />
              <Row k="child denomIndex" v={s.childDenomIndex} />
              <Row k="childIndex" v={s.childIndex} />
              <Row k="sample seed" v={hex64(s.sampleSeed)} />
              <Row k="pool length" v={childResults[i]?.poolLength ?? "—"} />
            </div>
          ))}
        </div>
      </div>

      {inspectChild != null && childCompositions[inspectChild] && childResults[inspectChild] && (
        <Inspect
          sampled={{
            composition: childCompositions[inspectChild]!,
            bytes: childResults[inspectChild]!.bytes,
            tokenId: 0n,
            label: `split child #${inspectChild}`,
          }}
          provenance={{ type: "split", trace: childResults[inspectChild]!.trace }}
          params={params}
          showGrid={false}
          inverted={false}
          onClose={() => setInspectChild(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Dna({ params = CANONICAL }: { params?: Params }) {
  const [mode, setMode] = React.useState<"compose" | "split">("compose");

  return (
    <Section
      title="DNA"
      note="per-cell sample provenance — which donor and source module each result cell was drawn from"
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
        <Button active={mode === "compose"} onClick={() => setMode("compose")}>
          compose
        </Button>
        <Button active={mode === "split"} onClick={() => setMode("split")}>
          split
        </Button>
      </div>
      {mode === "compose" ? <ComposeDna params={params} /> : <SplitDna params={params} />}
    </Section>
  );
}
