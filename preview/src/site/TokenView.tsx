import React from "react";
import {formatEther, type PublicClient} from "viem";
import {DENOMINATIONS, denomIndexOf, type Deployment} from "../chain/abi";
import {GRIDS} from "../canonical/denominations";
import {composeShape, fillClass, geometryAt, svgFromComposition, CANONICAL} from "../canonical/render";
import {splitChildSeed} from "../splitSeed";
import {shapeLensAbi} from "../chain/abi";
import {
  loadHistory,
  loadProvenance,
  loadDecomposePreview,
  type HistEvent,
  type ProvNode,
  type DecomposeInput,
} from "../chain/history";
import {C, label} from "./theme";
import {Section, Art, Modal, short, txUrl} from "./ui";
import {localArt} from "./art";
import {mintGene} from "../previewGene";
import type {SiteData, SiteToken} from "./data";
import type {RedeemState} from "./SiteApp";
import {
  loadDna,
  loadDnaFromSnapshot,
  deriveSeedDna,
  geometryPercents,
  type DnaCell,
  type DnaResult,
  type DnaDonor,
  type DnaComposeResult,
  type DnaSplitResult,
  type DnaSeedResult,
  type DnaSnapshot,
} from "./dna";
import {moduleBytesToHex} from "../canonical/moduleCodec";
import type {CardGeometry} from "../canonical/render";
import {effectiveModuleBytes, composeSampledShape, type SampleDonor} from "../canonical/sampling";
import {isProvenanceRollup, provenanceRollupLabel} from "./provenance";

const EVENT_LABEL: Record<HistEvent["kind"], string> = {
  mint: "Minted",
  bornFromSplit: "Created",
  splitInto: "Split",
  absorbed: "Composed",
  mergedAway: "Merged",
  decomposed: "Decomposed",
  revived: "Revived",
  blackened: "Blackened",
  redeemed: "Redeemed",
  transfer: "Transferred",
};

/** Inputs one compose call can burn before a mainnet block cannot hold it. About 75k gas each
 *  against a 60M limit is roughly 775; this leaves headroom for the survivor's own writes. */
const MAX_COMPOSE_INPUTS = 700;

interface DatedEvent extends HistEvent {
  date: string;
}

export function TokenView({
  data,
  dep,
  publicClient,
  address,
  tokenId,
  redeem,
  busy,
  txErr,
  onBack,
  onAskRedeem,
  onCancelRedeem,
  onConfirmRedeem,
  onSplit,
  onDecompose,
  onCompose,
  onOpenToken,
}: {
  data: SiteData | null;
  dep: Deployment;
  publicClient: PublicClient | undefined;
  address: `0x${string}` | undefined;
  tokenId: bigint;
  redeem: RedeemState;
  busy: string | null;
  txErr: {op: string; text: string} | null;
  onBack: () => void;
  onAskRedeem: () => void;
  onCancelRedeem: () => void;
  onConfirmRedeem: (t: SiteToken) => void;
  onSplit: (t: SiteToken) => void;
  onDecompose: (t: SiteToken) => void;
  onCompose: (t: SiteToken, burnIds: bigint[]) => void;
  onOpenToken: (id: bigint) => void;
}) {
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [askSplit, setAskSplit] = React.useState(false);
  const [history, setHistory] = React.useState<DatedEvent[] | null>(null);
  const [prov, setProv] = React.useState<ProvNode | null>(null);
  const [unicodeCard, setUnicodeCard] = React.useState<string | null>(null);
  const [unicodeUnavailable, setUnicodeUnavailable] = React.useState(false);
  const [showRawUnicode, setShowRawUnicode] = React.useState(false);
  const [decompInputs, setDecompInputs] = React.useState<DecomposeInput[] | null>(null);
  const [dna, setDna] = React.useState<DnaResult | null>(null);
  // Drill-down stack for the DNA modal: each entry is one donor's own DNA, reached by clicking a
  // contributing donor (or split parent) card. Empty means the modal is closed. Loaded lazily and
  // cached in place, so navigating back up never refetches.
  const [drillStack, setDrillStack] = React.useState<DnaDrillLevel[]>([]);

  // Ancestry tree from the event log; shown only when the token has one beyond its own mint.
  React.useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    setProv(null);
    void loadProvenance(publicClient, dep, tokenId).then((p) => {
      if (!cancelled) setProv(p);
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient, dep, tokenId, data]);

  React.useEffect(() => {
    setPicked(new Set());
  }, [tokenId]);


  // Token history from the event log, with block timestamps resolved to dates.
  React.useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    setHistory(null);
    void (async () => {
      const events = await loadHistory(publicClient, dep, tokenId);
      const blocks = [...new Set(events.map((e) => e.block))];
      const stamps = new Map(
        await Promise.all(
          blocks.map(async (b) => {
            const blk = await publicClient.getBlock({blockNumber: b});
            return [b, new Date(Number(blk.timestamp) * 1000).toISOString().slice(0, 10)] as const;
          }),
        ),
      );
      if (!cancelled) setHistory(events.map((e) => ({...e, date: stamps.get(e.block) ?? ""})));
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, dep, tokenId, data]);

  // The inputs a decompose would restore (its most recent compose's burned inputs), for the preview
  // strip. Loaded only when the token has a compose to reverse; reloads after any transaction.
  React.useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    setDecompInputs(null);
    const t = data?.tokens.find((x) => x.id === tokenId);
    if (!t || t.composeDepth === 0) return;
    void loadDecomposePreview(publicClient, dep, tokenId).then((inputs) => {
      if (!cancelled) setDecompInputs(inputs);
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient, dep, tokenId, data]);

  // Per-cell provenance (DNA section): reconstructed from composeRecordAt/splitOriginOf, or
  // straight from the seed when the token has never been sampled. One read per token view.
  React.useEffect(() => {
    setDna(null);
    setDrillStack([]);
    if (!publicClient) return;
    const t = data?.tokens.find((x) => x.id === tokenId);
    if (!t) return;
    let cancelled = false;
    void loadDna(publicClient, dep, tokenId)
      .then((r) => {
        if (!cancelled) setDna(r);
      })
      .catch(() => {
        if (!cancelled) setDna({kind: "unavailable", message: "DNA unavailable on this contract deployment."});
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, dep, tokenId, data]);

  // Fetch whichever drill-stack level is topmost and still unresolved. Every other level keeps
  // its already-loaded `dna`, so navigating back up (which only truncates the stack) never
  // refetches. A level with `subjectId === null` (a split parent, which has no on-chain id to
  // read further) is resolved synchronously at push time and never reaches this effect.
  React.useEffect(() => {
    if (!publicClient) return;
    const topIndex = drillStack.length - 1;
    if (topIndex < 0) return;
    const top = drillStack[topIndex];
    if (top.dna !== null || top.subjectId === null) return;
    let cancelled = false;
    const snapshot: DnaSnapshot = {
      id: top.subjectId,
      seed: top.snapshot.seed,
      denomIndex: top.snapshot.denomIndex,
      inkGene: top.snapshot.inkGene,
      modules: top.snapshot.modules,
    };
    const applyAt = (result: DnaResult) => {
      if (cancelled) return;
      setDrillStack((prev) => {
        if (prev.length !== topIndex + 1 || prev[topIndex] !== top) return prev; // navigated away meanwhile
        const next = [...prev];
        next[topIndex] = {...top, dna: result};
        return next;
      });
    };
    void loadDnaFromSnapshot(publicClient, dep, snapshot, top.depthOverride)
      .then(applyAt)
      .catch(() => applyAt({kind: "unavailable", message: "DNA unavailable on this contract deployment."}));
    return () => {
      cancelled = true;
    };
  }, [publicClient, dep, drillStack]);

  const token = data?.tokens.find((t) => t.id === tokenId) ?? null;
  const snap = redeem.status === "done" && redeem.snap?.id === tokenId ? redeem.snap : null;

  // Read the text rendering from ShapeLens. This intentionally does not derive the grid from
  // tokenURI or the site's local renderer: the displayed bytes are the protocol's canonical
  // `unicodeCard(tokenId)` response. A missing `dep.lens` (stale deployment.json) fails this read
  // the same as any other revert and falls through to the unavailable state below.
  React.useEffect(() => {
    let cancelled = false;
    setUnicodeCard(null);
    setUnicodeUnavailable(false);
    if (!publicClient || !token) return;

    void publicClient
      .readContract({
        address: dep.lens,
        abi: shapeLensAbi,
        functionName: "unicodeCard",
        args: [tokenId],
      })
      .then((card) => {
        if (!cancelled) setUnicodeCard(card);
      })
      .catch(() => {
        if (!cancelled) setUnicodeUnavailable(true);
      });

    return () => {
      cancelled = true;
    };
  }, [publicClient, dep.lens, tokenId, token]);

  const back = (
    <div style={{padding: "20px 48px", borderBottom: `1px solid ${C.rule}`, fontSize: 11, letterSpacing: "0.14em"}}>
      <button
        type="button"
        className="btn-ghost"
        onClick={onBack}
        style={{letterSpacing: "0.14em", fontSize: 11, color: C.muted}}
      >
        ← GALLERY
      </button>
    </div>
  );

  // Redeemed in this session: the token is gone, but the closing state is still shown.
  if (!token && snap) {
    const lbl = DENOMINATIONS[snap.di].label;
    return (
      <main>
        {back}
        <Section title="SHAPE" pad="36px 48px 44px 32px">
          <div style={{display: "flex", flexWrap: "wrap", gap: 48, alignItems: "flex-start"}}>
            <Art src={localArt(snap.seed, DENOMINATIONS[snap.di].wei, snap.inkGene)} width={340} />
            <div style={{flex: "1 1 320px", minWidth: 0}}>
              <div style={{fontSize: 40, lineHeight: 1}}>{lbl} ETH</div>
              <div style={{marginTop: 20, fontSize: 13, lineHeight: 1.7}}>
                <div>
                  Redeemed. {DENOMINATIONS[snap.di].wei.toString()} wei ({lbl} ETH) sent to{" "}
                  {address ? short(address) : "the owner"}. The token is burned.
                </div>
                {redeem.tx && (
                  <a
                    href={txUrl(redeem.tx, dep.chainId)}
                    target="_blank"
                    rel="noreferrer"
                    style={{display: "inline-block", marginTop: 12, fontSize: 12, overflowWrap: "anywhere"}}
                  >
                    {redeem.tx.slice(0, 12)}… on evm.now
                  </a>
                )}
              </div>
            </div>
          </div>
        </Section>
        <History history={history} chainId={dep.chainId} />
        <div style={{height: 64}} />
      </main>
    );
  }

  if (!token) {
    return (
      <main>
        {back}
        <Section title="SHAPE">
          <div style={{fontSize: 13, lineHeight: 1.75, color: C.bodyDim, maxWidth: "60ch"}}>
            Shape {tokenId.toString()} is no longer live. It was redeemed or recomposed. Its
            history is below.
          </div>
        </Section>
        <History history={history} chainId={dep.chainId} />
        <div style={{height: 64}} />
      </main>
    );
  }

  if (token.di < 0) {
    return (
      <main>
        {back}
        <Section title="BLACK SHAPE" pad="36px 48px 44px 32px">
          <div style={{display: "flex", flexWrap: "wrap", gap: 48, alignItems: "flex-start"}}>
            <Art src={token.image} alt={`Black Shape ${token.id}`} width={340} />
            <div style={{flex: "1 1 320px", minWidth: 0, fontSize: 13, lineHeight: 1.75}}>
              <div style={{fontSize: 40, lineHeight: 1}}>Black Shape</div>
              <div style={{marginTop: 20}}>
                #{token.id.toString()} has been sacrificed. It remains part of the collection, but
                has no redeemable ETH backing and cannot be split, composed, or redeemed.
              </div>
              <div style={{marginTop: 14, color: C.muted, fontSize: 11}}>owner · {short(token.owner)}</div>
            </div>
          </div>
        </Section>
        <History history={history} chainId={dep.chainId} />
        <div style={{height: 64}} />
      </main>
    );
  }

  const di = token.di;
  const lbl = DENOMINATIONS[di].label;
  const [cols, rows] = GRIDS[di];
  const owned = !!address && token.owner.toLowerCase() === address.toLowerCase();
  const comp = composeShape(token.seed, token.backing, token.inkGene);

  const tokRows: {k: string; v: React.ReactNode; size?: number; wrap?: "anywhere" | "normal"}[] = [
    {k: "denomination", v: `${lbl} ETH`},
    {k: "token", v: `#${token.id.toString()}`},
    {k: "grid", v: `${cols} × ${rows} · ${cols * rows === 1 ? "1 mark" : `${cols * rows} marks`}`},
    {k: "fill", v: fillClass(comp)},
    {k: "owner", v: owned ? `${short(token.owner)} (you)` : short(token.owner), wrap: "anywhere"},
    {k: "backing, exact", v: `${token.backing.toString()} wei`, size: 11},
  ];

  // Split: the designed one-tier-down even split. Child seeds are fixed by the parent's
  // seed, so the previews are the exact tokens the contract would mint.
  const canSplit = di > 0;
  const downWei = canSplit ? DENOMINATIONS[di - 1].wei : 0n;
  const ratio = canSplit ? Number(token.backing / downWei) : 0;
  const splitChildren = canSplit
    ? Array.from({length: ratio}, (_, i) => ({
        seed: splitChildSeed(token.seed, i),
        wei: downWei,
      }))
    : [];

  // Decompose: reverses the survivor's most recent still-standing compose. Shown only when a
  // compose is on the stack to reverse.
  const canDecompose = token.composeDepth > 0;

  // Recompose: same-denomination Shapes this wallet owns. The open token survives, keeping its
  // id and seed.
  const candidates = owned
    ? (data?.tokens ?? []).filter(
        (t) =>
          t.di === di &&
          t.id !== token.id &&
          !!address &&
          t.owner.toLowerCase() === address.toLowerCase(),
      )
    : [];
  const pickedTokens = candidates.filter((t) => picked.has(t.id.toString()));
  const pickedIds = pickedTokens.map((t) => t.id);
  const sumWei = token.backing + pickedTokens.reduce((a, t) => a + t.backing, 0n);
  const sumIdx = denomIndexOf(sumWei);
  // Compose costs about 75k gas per burned input, so a mainnet block caps one call near 775.
  // Hold well under that: a rejected selection here is cheaper than an out of gas revert the
  // caller still pays for. A larger merge is done by composing in batches, which the survivor
  // keeping its id makes safe to repeat.
  const composeValid = pickedIds.length >= 1 && pickedIds.length <= MAX_COMPOSE_INPUTS && sumIdx >= 0;

  const errLine = (op: string) =>
    txErr && txErr.op === op ? (
      <p style={{margin: "18px 0 0", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
        {txErr.text}
      </p>
    ) : null;

  return (
    <main>
      {back}

      <Section title="SHAPE" pad="36px 48px 44px 32px">
        <div style={{display: "flex", flexWrap: "wrap", gap: 48, alignItems: "flex-start"}}>
          <Art src={token.image} alt={`Shape ${token.id}`} width={340} />
          <div style={{flex: "1 1 320px", minWidth: 0}}>
            <div style={{fontSize: 40, lineHeight: 1}}>{lbl} ETH</div>
            <p style={{margin: "20px 0 0", fontSize: 13, lineHeight: 1.75, color: C.bodyDim, maxWidth: "48ch"}}>
              This Shape holds {lbl} ETH. Its owner can burn it and receive {lbl} ETH.
            </p>
            <div style={{margin: "32px 0 0"}}>
              {tokRows.map((r) => (
                <div
                  key={r.k}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "130px minmax(0, 1fr)",
                    gap: 24,
                    padding: "10px 0",
                    borderBottom: `1px solid ${C.ruleInner}`,
                    fontSize: 13,
                  }}
                >
                  <div style={{color: C.muted}}>{r.k}</div>
                  <div style={{fontSize: r.size ?? 13, overflowWrap: r.wrap ?? "normal"}}>{r.v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title="UNICODE CARD" pad="28px 48px 34px 32px">
        <p style={{margin: "0 0 22px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
          Returned directly by <span style={{color: C.body}}>unicodeCard(#{token.id.toString()})</span> on the
          Shapes contract.
        </p>
        {unicodeCard !== null ? (
          <div
            style={{
              display: "inline-block",
              maxWidth: "100%",
              overflowX: "auto",
              padding: "24px 28px",
              border: `1px solid ${C.border}`,
              background: C.row,
            }}
          >
            <pre
              aria-label={`Unicode card for Shape ${token.id.toString()}`}
              style={{
                margin: 0,
                color: C.ink,
                fontFamily: "inherit",
                fontSize: "clamp(24px, 4.5vw, 52px)",
                fontWeight: 400,
                lineHeight: 1.28,
                letterSpacing: "0.04em",
                whiteSpace: "pre",
              }}
            >
              {unicodeCard}
            </pre>
          </div>
        ) : unicodeUnavailable ? (
          <div style={{fontSize: 12, lineHeight: 1.7, color: C.muted}}>
            Unicode card unavailable on this contract deployment.
          </div>
        ) : (
          <div style={{fontSize: 12, color: C.muted}}>Reading token contract…</div>
        )}
        {unicodeCard !== null && (
          <div style={{marginTop: 18}}>
            <button
              type="button"
              onClick={() => setShowRawUnicode((v) => !v)}
              style={{
                background: "none",
                border: `1px solid ${C.border}`,
                color: C.muted,
                fontFamily: "inherit",
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                padding: "7px 12px",
                cursor: "pointer",
              }}
            >
              {showRawUnicode ? "Hide raw string" : "Show raw string"}
            </button>
            {showRawUnicode && (
              <textarea
                readOnly
                value={unicodeCard}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={`Raw unicodeCard string for Shape ${token.id.toString()}`}
                style={{
                  display: "block",
                  marginTop: 12,
                  width: "100%",
                  maxWidth: "60ch",
                  minHeight: 140,
                  resize: "vertical",
                  padding: "12px 14px",
                  border: `1px solid ${C.border}`,
                  background: C.row,
                  color: C.body,
                  fontFamily: "ui-monospace, Menlo, monospace",
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: "pre",
                }}
              />
            )}
          </div>
        )}
      </Section>

      <DnaSection
        dna={dna}
        image={token.image}
        onDrillDonor={(target) => {
          if (dna == null || (dna.kind !== "compose" && dna.kind !== "split")) return;
          const level = drillTargetToLevel(dna, tokenId, target);
          if (level) setDrillStack((prev) => [...prev, level]);
        }}
      />

      {drillStack.length > 0 && (
        <DnaDrillModal
          rootTokenId={tokenId}
          stack={drillStack}
          onNavigate={(depth) => setDrillStack((prev) => prev.slice(0, depth))}
          onPush={(level) => setDrillStack((prev) => [...prev, level])}
          onClose={() => setDrillStack([])}
        />
      )}

      <History history={history} chainId={dep.chainId} />

      {prov && prov.contributors.length > 0 && (
        <Section title="PROVENANCE" pad="16px 48px 36px 32px">
          <p style={{margin: "8px 0 26px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
            Every Shape this one was built from. Burned Shapes are drawn from their recorded
            seeds.
          </p>
          <div style={{overflowX: "auto", paddingBottom: 8}}>
            <div style={{display: "flex", justifyContent: "flex-start", minWidth: "min-content"}}>
              <ProvTree node={prov} depth={0} live={data?.tokens ?? []} onOpen={onOpenToken} />
            </div>
          </div>
        </Section>
      )}

      <Section title="METADATA" pad="16px 48px 30px 32px">
        <p style={{margin: "8px 0 6px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
          Parsed from the token's onchain tokenURI. Nothing here is served by this site.
        </p>
        {[
          {k: "name", v: token.meta.name},
          {k: "description", v: token.meta.description},
          ...token.meta.attributes.map((a) => ({k: a.trait_type, v: a.value})),
        ].map((row) => (
          <div
            key={row.k}
            style={{
              display: "grid",
              gridTemplateColumns: "130px minmax(0, 1fr)",
              gap: 24,
              padding: "10px 0",
              borderBottom: `1px solid ${C.ruleInner}`,
              fontSize: 13,
            }}
          >
            <div style={{color: C.muted}}>{row.k}</div>
            <div style={{overflowWrap: "anywhere", maxWidth: "70ch", lineHeight: 1.6}}>{row.v}</div>
          </div>
        ))}
      </Section>

      {owned && (
        <>
          <Section title="REDEEM" pad="26px 48px 34px 32px">
            <div style={{fontSize: 15, lineHeight: 1.6}}>
              Burn this Shape. Receive {lbl} ETH.
            </div>
            <div style={{margin: "8px 0 22px", fontSize: 12, color: C.muted, overflowWrap: "anywhere"}}>
              {token.backing.toString()} wei ({lbl} ETH)
            </div>
            {(redeem.status === "idle" || redeem.status === "failed") && (
              <>
                <button type="button" className="btn-filled" onClick={onAskRedeem} style={{padding: "11px 26px"}}>
                  Redeem
                </button>
                {redeem.status === "failed" && redeem.error && (
                  <p style={{margin: "16px 0 0", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
                    {redeem.error}
                  </p>
                )}
              </>
            )}
            {(redeem.status === "asking" || redeem.status === "pending") && (
              <div>
                <p style={{margin: "0 0 20px", fontSize: 13, lineHeight: 1.7, maxWidth: "60ch"}}>
                  Redeeming burns the token and sends {token.backing.toString()} wei ({lbl} ETH)
                  to {short(token.owner)}. This cannot be undone.
                </p>
                <div style={{display: "flex", flexWrap: "wrap", gap: 12}}>
                  <button
                    type="button"
                    className="btn-filled"
                    onClick={() => onConfirmRedeem(token)}
                    disabled={redeem.status === "pending"}
                    style={{padding: "11px 26px"}}
                  >
                    {redeem.status === "pending" ? "Waiting for confirmation" : "Confirm redeem"}
                  </button>
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={onCancelRedeem}
                    disabled={redeem.status === "pending"}
                    style={{padding: "11px 26px"}}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </Section>

          <Section title="SPLIT" pad="26px 48px 36px 32px">
            <p style={{margin: "0 0 8px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
              {canSplit
                ? `Split this Shape into ${ratio} Shapes of ${DENOMINATIONS[di - 1].label} ETH. The outputs sum to exactly ${lbl} ETH.`
                : `${DENOMINATIONS[0].label} ETH is the smallest denomination. This Shape cannot be split.`}
            </p>
            {canSplit && (
              <p style={{margin: "0 0 26px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
                No ETH moves. No fee is charged. The seeds below are fixed already, so this is
                the exact result. A split is final: it burns this Shape, and its artwork cannot
                be brought back.
              </p>
            )}
            <div style={{display: "flex", flexWrap: "wrap", gap: 18}}>
              {splitChildren.map((c, i) => (
                <div key={i} style={{flex: "0 0 96px", width: 96}}>
                  {/* split copies the parent's gene verbatim to every child */}
                  <Art src={localArt(c.seed, c.wei, token.inkGene)} />
                  <div style={{marginTop: 8, fontSize: 11, color: C.muted}}>
                    {DENOMINATIONS[di - 1].label} ETH
                  </div>
                </div>
              ))}
            </div>
            {canSplit && (
              <button
                type="button"
                className="btn-outline"
                onClick={() => setAskSplit(true)}
                disabled={!!busy}
                style={{marginTop: 26, padding: "10px 20px"}}
              >
                {busy === "split" ? "Waiting for confirmation" : "Split"}
              </button>
            )}
            {errLine("split")}
            {askSplit && (
              <Modal
                title="SPLIT IS FINAL"
                onCancel={() => setAskSplit(false)}
              >
                <p style={{margin: "0 0 14px", fontSize: 14, lineHeight: 1.7, color: C.ink}}>
                  Splitting burns #{token.id.toString()} and returns {ratio} Shapes of{" "}
                  {DENOMINATIONS[di - 1].label} ETH in its place.
                </p>
                <p style={{margin: "0 0 24px", fontSize: 13, lineHeight: 1.7, color: C.muted}}>
                  This cannot be undone. Composing the pieces back gives a different Shape: the
                  artwork on this one is gone for good. Your {lbl} ETH is untouched either way.
                </p>
                <div style={{display: "flex", flexWrap: "wrap", gap: 12}}>
                  <button
                    type="button"
                    className="btn-filled"
                    onClick={() => {
                      setAskSplit(false);
                      onSplit(token);
                    }}
                    disabled={!!busy}
                    style={{padding: "11px 26px"}}
                  >
                    Split anyway
                  </button>
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => setAskSplit(false)}
                    disabled={!!busy}
                    style={{padding: "11px 26px"}}
                  >
                    Cancel
                  </button>
                </div>
              </Modal>
            )}
          </Section>

          <Section title="COMPOSE" pad="26px 48px 36px 32px">
            <p style={{margin: "0 0 8px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
              Grow this Shape. Composing burns others of the same denomination into it and moves
              it to the larger denomination.
            </p>
            <p style={{margin: "0 0 24px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
              #{token.id.toString()} keeps its id and its seed. No ETH moves. No fee is charged.
            </p>
            {candidates.map((t) => {
              const on = picked.has(t.id.toString());
              return (
                <div
                  key={t.id.toString()}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 20,
                    padding: "10px 0",
                    borderBottom: `1px solid ${C.ruleInner}`,
                  }}
                >
                  <Art src={t.image} width={34} />
                  <div style={{flex: "1 1 140px", minWidth: 0, fontSize: 13}}>
                    #{t.id.toString()} · {lbl} ETH
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        const k = t.id.toString();
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        return next;
                      })
                    }
                    style={{
                      flex: "0 0 auto",
                      whiteSpace: "nowrap",
                      border: `1px solid ${on ? C.ink : C.border}`,
                      background: on ? C.ink : "transparent",
                      color: on ? C.page : C.bodyDim,
                      padding: "6px 14px",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {on ? "Selected" : "Select"}
                  </button>
                </div>
              );
            })}
            {candidates.length === 0 && (
              <div style={{fontSize: 13, color: C.muted}}>
                This wallet owns no other {lbl} ETH Shapes to compose with.
              </div>
            )}
            {candidates.length > 0 && (
              <div style={{marginTop: 22, fontSize: 13, color: C.muted}}>
                {pickedIds.length === 0
                  ? "Select Shapes to compose."
                  : pickedIds.length > MAX_COMPOSE_INPUTS
                    ? `${pickedIds.length} Shapes is more than one transaction can burn. Compose up to ${MAX_COMPOSE_INPUTS} at a time; this Shape keeps its id, so the next batch merges into the same one.`
                    : composeValid
                      ? `${formatEther(sumWei)} ETH → one ${DENOMINATIONS[sumIdx].label} ETH Shape.`
                      : `${formatEther(sumWei)} ETH is not a denomination. The sum must be exactly one of the nine.`}
              </div>
            )}
            {composeValid && (
              <button
                type="button"
                className="btn-outline"
                onClick={() => onCompose(token, pickedIds)}
                disabled={!!busy}
                style={{marginTop: 22, padding: "10px 20px"}}
              >
                {busy === "compose" ? "Waiting for confirmation" : "Compose"}
              </button>
            )}
            {errLine("compose")}
          </Section>

          {canDecompose && (
            <Section title="DECOMPOSE" pad="26px 48px 36px 32px">
              <p style={{margin: "0 0 8px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
                Undo this Shape's most recent compose. #{token.id.toString()} keeps its id and
                returns to its pre-compose denomination and origins, and every Shape that compose
                burned is re-minted to you under its original id and seed.
              </p>
              <p style={{margin: "0 0 24px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
                No ETH moves. No fee is charged. Stacked composes reverse newest first — this
                Shape has {token.composeDepth} compose{token.composeDepth === 1 ? "" : "s"} left to
                undo.
              </p>
              {decompInputs && decompInputs.length > 0 && (
                <div style={{display: "flex", flexWrap: "wrap", gap: 18, margin: "0 0 26px"}}>
                  {decompInputs.map((c) => (
                    <div key={c.id.toString()} style={{flex: "0 0 96px", width: 96}}>
                      {/* geometry is exact from the restored seed; ink shown as the seed's mint gene */}
                      <Art src={localArt(c.seed, DENOMINATIONS[c.di].wei, mintGene(c.seed, DENOMINATIONS[c.di].wei))} />
                      <div style={{marginTop: 8, fontSize: 11, color: C.muted}}>
                        #{c.id.toString()} · {DENOMINATIONS[c.di].label} ETH
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="btn-outline"
                onClick={() => onDecompose(token)}
                disabled={!!busy}
                style={{padding: "10px 20px"}}
              >
                {busy === "decompose" ? "Waiting for confirmation" : "Decompose"}
              </button>
              {errLine("decompose")}
            </Section>
          )}

        </>
      )}

      {!owned && (
        <Section title="OWNERSHIP">
          <div style={{fontSize: 13, lineHeight: 1.75, color: C.bodyDim, maxWidth: "60ch"}}>
            {address
              ? "This Shape belongs to another address. Only its owner can redeem, split, compose or decompose it."
              : "Connect the owning wallet to redeem, split, compose or decompose this Shape."}
          </div>
        </Section>
      )}
      <div style={{height: 64}} />
    </main>
  );
}

const REL_TEXT: Record<ProvNode["rel"], string> = {
  root: "this Shape",
  merged: "merged in",
  splitSource: "split source",
  piece: "restored piece",
  self: "the same token, before the merge",
};

/** Node card width per generation. */
const TREE_W = [120, 76, 52, 36, 26, 20];
const treeWidth = (depth: number) => TREE_W[Math.min(depth, TREE_W.length - 1)];
const STUB = 18; // vertical run of each connector segment

/**
 * The ancestry as a tree: the token at the top, each generation of contributors centered
 * beneath the shape they became, joined by 1px connectors. Cards shrink per generation. A
 * repeated ancestor renders dimmed with no subtree; live ancestors open their detail page.
 */
function ProvTree({
  node,
  depth,
  live,
  onOpen,
}: {
  node: ProvNode;
  depth: number;
  live: SiteToken[];
  onOpen: (id: bigint) => void;
}) {
  if (isProvenanceRollup(node)) {
    return (
      <div
        style={{marginTop: 6, padding: "5px 7px", border: `1px solid ${C.border}`, color: C.faint, fontSize: 10}}
        title="additional contributors not expanded"
      >
        {provenanceRollupLabel(node)}
      </div>
    );
  }
  const w = treeWidth(depth);
  const isLive = live.some((t) => t.id === node.id);
  // A repeated ancestor's subtree already hangs under its first occurrence; drop the echo.
  const kids = node.contributors.filter((c) => !c.repeat);
  const note =
    `#${node.id.toString()} · ${DENOMINATIONS[node.di].label} ETH · ` +
    REL_TEXT[node.rel] +
    (node.repeat ? " (shown elsewhere)" : node.mintBorn && node.contributors.length === 0 ? ", minted" : "");
  const card = (
    <div style={{width: w, opacity: node.repeat ? 0.35 : 1}} title={note}>
      {/* Provenance nodes carry no gene: the event log (chain/history.ts) does not yet track
          InkGene events, so a historical node's exact ink is unknown here. mintGene is exact for a
          direct-mint node and an approximation for a composed one. Threading real genes through the
          provenance tree needs the indexer extended for InkGene (SPEC.md D17 / preview UX). */}
      <Art src={localArt(node.seed, DENOMINATIONS[node.di].wei, mintGene(node.seed, DENOMINATIONS[node.di].wei))} />
      {w >= 26 && (
        <div style={{marginTop: 5, fontSize: 10, color: C.muted, textAlign: "center"}}>
          #{node.id.toString()}
        </div>
      )}
    </div>
  );
  return (
    <div style={{display: "flex", flexDirection: "column", alignItems: "center"}}>
      {isLive ? (
        <button type="button" className="btn-ghost" onClick={() => onOpen(node.id)} style={{display: "block"}}>
          {card}
        </button>
      ) : (
        card
      )}
      {node.truncated && (
        <div style={{marginTop: 6, fontSize: 11, color: C.faint}} title="earlier history not shown">
          …
        </div>
      )}
      {kids.length > 0 && (
        <>
          <div style={{width: 1, height: STUB, background: C.border}} />
          <div style={{display: "flex", alignItems: "flex-start"}}>
            {kids.map((c, i) => {
              const first = i === 0;
              const last = i === kids.length - 1;
              const solo = kids.length === 1;
              return (
                <div key={`${c.id.toString()}-${i}`} style={{position: "relative", padding: `${STUB}px 9px 0`}}>
                  {!solo && !first && (
                    <div style={{position: "absolute", top: 0, left: 0, width: "50%", height: 1, background: C.border}} />
                  )}
                  {!solo && !last && (
                    <div style={{position: "absolute", top: 0, left: "50%", width: "50%", height: 1, background: C.border}} />
                  )}
                  <div style={{position: "absolute", top: 0, left: "50%", width: 1, height: STUB, background: C.border}} />
                  <ProvTree node={c} depth={depth + 1} live={live} onOpen={onOpen} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function History({history, chainId}: {history: DatedEvent[] | null; chainId: number}) {
  return (
    <Section title="HISTORY" pad="16px 48px 24px 32px">
      {history === null ? (
        <div style={{fontSize: 13, color: C.muted, padding: "12px 0"}}>Reading the event log…</div>
      ) : history.length === 0 ? (
        <div style={{fontSize: 13, color: C.muted, padding: "12px 0"}}>No events.</div>
      ) : (
        history.map((h) => (
          <div
            key={h.key}
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              gap: "8px 24px",
              padding: "12px 0",
              borderBottom: `1px solid ${C.ruleInner}`,
              fontSize: 13,
            }}
          >
            <div style={{minWidth: 92}}>{EVENT_LABEL[h.kind]}</div>
            <div style={{color: C.muted}}>{h.date}</div>
            <div style={{flex: "1 1 160px", minWidth: 0, color: C.muted}}>{h.text}</div>
            <a
              href={txUrl(h.tx, chainId)}
              target="_blank"
              rel="noreferrer"
              style={{fontSize: 12, overflowWrap: "anywhere"}}
            >
              {h.tx.slice(0, 10)}…
            </a>
          </div>
        ))
      )}
    </Section>
  );
}

/** Distinguishable donor tints for the compose overlay, canonical order: index 0 is the survivor. */
const DNA_DONOR_COLORS = ["#d9a25a", "#5a9fd9", "#7ed98a", "#d95a8a", "#a05ad9", "#d9d05a"];
function dnaDonorColor(i: number): string {
  return DNA_DONOR_COLORS[i % DNA_DONOR_COLORS.length];
}

function seedShort(seed: bigint): string {
  const hex = seed.toString(16).padStart(64, "0");
  return `0x${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

function DnaRow({k, v}: {k: string; v: React.ReactNode}) {
  return (
    <div style={{display: "flex", gap: 10, padding: "3px 0", fontSize: 12}}>
      <span style={{color: C.muted, width: 92, flexShrink: 0}}>{k}</span>
      <span style={{color: C.body, wordBreak: "break-all"}}>{v}</span>
    </div>
  );
}

/**
 * The per-cell overlay grid, absolutely positioned over the rendered artwork at the geometry's
 * exact percentage bounds. One div per cell, styled by `cellStyle(j)`; hover and click report the
 * cell index to the caller. Shared by the result card and every donor card, so both grids drive
 * their highlight state the same way.
 */
function DnaGridOverlay({
  geometry,
  cellStyle,
  onEnter,
  onLeave,
  onClick,
}: {
  geometry: CardGeometry;
  cellStyle: (j: number) => React.CSSProperties | undefined;
  onEnter: (j: number) => void;
  onLeave: () => void;
  onClick?: (j: number) => void;
}) {
  const {leftPct, topPct, widthPct, heightPct} = geometryPercents(geometry);
  const count = geometry.cols * geometry.rows;
  return (
    <div
      onMouseLeave={onLeave}
      style={{
        position: "absolute",
        left: `${leftPct}%`,
        top: `${topPct}%`,
        width: `${widthPct}%`,
        height: `${heightPct}%`,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${geometry.cols}, 1fr)`,
          gridTemplateRows: `repeat(${geometry.rows}, 1fr)`,
          width: "100%",
          height: "100%",
        }}
      >
        {Array.from({length: count}, (_, j) => (
          <div
            key={j}
            onMouseEnter={() => onEnter(j)}
            onClick={() => onClick?.(j)}
            style={{
              boxSizing: "border-box",
              cursor: onClick ? "pointer" : "default",
              outlineOffset: -1,
              ...cellStyle(j),
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** Rewrites a canonical SVG's fixed raster width/height to fill its container, matching how the
 *  harness's Card component displays sampled SVGs (app/ui.tsx forDisplay). Duplicated here rather
 *  than imported since site/ does not import from app/. */
function svgForDisplay(svg: string): string {
  return svg.replace(
    /^(<svg[^>]*?) width="\d+" height="\d+"/,
    '$1 width="100%" height="100%" style="display:block"',
  );
}

/** One donor's rendered card: its snapshot state at compose/split time, reconstructed via the
 *  canonical sampler, plus which of its own module indices the result actually drew from. */
interface DonorRender {
  /** Canonical compose donor order (0 = survivor); always 0 for a split parent (one donor). */
  donorIndex: number;
  roleLabel: string;
  denomLabel: string;
  materialized: boolean;
  /** True when this donor's token no longer exists (every donor except the compose survivor). */
  burned: boolean;
  svg: string;
  geometry: CardGeometry;
  /** This donor's own module indices that at least one result cell was sampled from. */
  sampledModuleIndices: Set<number>;
}

/** Reconstruct one donor's own card from its compose/split-time snapshot: `effectiveModuleBytes`
 *  resolves materialized-vs-seed-derived exactly as the sampler does, `composeSampledShape` lays
 *  out the grid, `svgFromComposition` draws it. Never re-derives sampling; only renders its input. */
function renderDonor(seed: bigint, denomIndex: number, inkGene: number, modules: Uint8Array | undefined): {
  svg: string;
  geometry: CardGeometry;
} {
  const donor: SampleDonor = {seed, denomIndex, inkGene, modules};
  const bytes = effectiveModuleBytes(donor);
  const composition = composeSampledShape(bytes, denomIndex, inkGene);
  return {svg: svgFromComposition(composition, 0n, CANONICAL, false), geometry: geometryAt(denomIndex)};
}

function denomLabelAt(denomIndex: number): string {
  return DENOMINATIONS[denomIndex]?.label ?? "?";
}

/**
 * Contributing donors for a compose result: donors that at least one result cell was sampled
 * from, in canonical order. Bounded by the result's own cell count (max 25, the largest grid in
 * the collection), so a wide merge never renders one card per absorbed input.
 */
function contributingComposeDonors(donors: DnaDonor[], cells: DnaCell[]): DonorRender[] {
  const contributing = new Set(cells.map((c) => c.donorIndex ?? 0));
  return donors
    .map((d, i) => ({d, i}))
    .filter(({i}) => contributing.has(i))
    .map(({d, i}) => {
      const {svg, geometry} = renderDonor(d.seed, d.denomIndex, d.inkGene, d.modules);
      const sampledModuleIndices = new Set(
        cells.filter((c) => (c.donorIndex ?? 0) === i).map((c) => c.moduleIndex),
      );
      return {
        donorIndex: i,
        roleLabel: d.id === "survivor" ? "this shape, before the merge" : `#${d.id}`,
        denomLabel: denomLabelAt(d.denomIndex),
        materialized: d.materialized,
        burned: d.id !== "survivor",
        svg,
        geometry,
        sampledModuleIndices,
      };
    });
}

/**
 * The grammar-branch split pool as a donor card (SAMPLING_SPEC.md section 6, D3'): the parent
 * seed's expression at the CHILD's own denomination, which is always a full grid at that
 * denomination (the same reason a compose donor's own module count equals its own grid), so it
 * renders and highlights exactly like any other donor card. Only called when `dna.pool` is
 * present — the record branch's pool has no single grid shape (see `DnaSplitResult.pool`'s
 * doc comment) and is shown as pool index/byte in the detail panel instead, with no card.
 */
function splitPoolDonor(pool: NonNullable<DnaSplitResult["pool"]>, cells: DnaCell[]): DonorRender {
  const {svg, geometry} = renderDonor(pool.seed, pool.denomIndex, pool.inkGene, pool.modules);
  return {
    donorIndex: 0,
    roleLabel: "sampling pool — the parent's seed, expressed at this denomination",
    denomLabel: denomLabelAt(pool.denomIndex),
    materialized: true,
    burned: true,
    svg,
    geometry,
    sampledModuleIndices: new Set(cells.map((c) => c.moduleIndex)),
  };
}

/** One donor's card: rendered SVG, per-cell overlay tinted where the result sampled from it, and
 *  a caption. Hovering a cell reports it up; the caller decides which cell (if any) is "active"
 *  across every card and the result grid together. `onDrill`, when given, makes the whole card a
 *  button that opens this donor's own DNA. */
function DonorMiniCard({
  donor,
  color,
  activeCell,
  onEnterCell,
  onLeaveCell,
  onDrill,
}: {
  donor: DonorRender;
  color: string;
  activeCell: {donorIndex: number; moduleIndex: number} | null;
  onEnterCell: (moduleIndex: number) => void;
  onLeaveCell: () => void;
  onDrill?: () => void;
}) {
  const cellStyle = (j: number): React.CSSProperties | undefined => {
    const sampled = donor.sampledModuleIndices.has(j);
    const isActive = activeCell != null && activeCell.donorIndex === donor.donorIndex && activeCell.moduleIndex === j;
    if (!sampled && !isActive) return undefined;
    return {
      background: `${color}${isActive ? "4d" : "22"}`,
      outline: `${isActive ? 2 : 1}px solid ${color}${isActive ? "" : "66"}`,
    };
  };
  const body = (
    <div style={{display: "flex", flexDirection: "column", gap: 6, width: 108}}>
      <div style={{position: "relative", aspectRatio: "250 / 350", backgroundColor: C.art}}>
        <div
          dangerouslySetInnerHTML={{__html: svgForDisplay(donor.svg)}}
          style={{position: "absolute", inset: 0}}
        />
        <DnaGridOverlay
          geometry={donor.geometry}
          cellStyle={cellStyle}
          onEnter={onEnterCell}
          onLeave={onLeaveCell}
        />
      </div>
      <div style={{fontSize: 10.5, color: C.body, textAlign: "center", lineHeight: 1.4}}>{donor.roleLabel}</div>
      <div style={{fontSize: 9.5, color: C.muted, textAlign: "center"}}>
        {donor.denomLabel} ETH{donor.materialized ? " · materialized" : ""}
      </div>
      {donor.burned && (
        <div style={{fontSize: 9, color: C.faint, textAlign: "center", lineHeight: 1.4}}>
          burned, shown from its recorded snapshot
        </div>
      )}
    </div>
  );
  if (!onDrill) return body;
  return (
    <button type="button" className="btn-ghost" onClick={onDrill} style={{display: "block", textAlign: "left"}}>
      {body}
    </button>
  );
}

/** Which donor a click on a contributing donor (or split parent) card should drill into.
 *  "survivor" and "burn" apply only to a compose result; "splitParent" only to a split result. */
type DnaDrillTarget = {kind: "survivor"} | {kind: "burn"; id: string} | {kind: "splitParent"};

/**
 * Per-cell provenance: the artwork with a cell-overlay grid, tinted per donor (compose), tinted
 * uniformly for the single parent donor (split), or untinted with only the active cell outlined
 * (seed-derived). Pure rendering over an already-resolved `dna`; `resultArt` supplies the main
 * card's artwork (the page's own `tokenURI` image at the root, or a client-rendered SVG for a
 * drilled-into donor, which has no `tokenURI`). `onDrillDonor`, when given, makes every
 * contributing donor (or split parent) card open that donor's own DNA.
 */
function DnaProvenancePanel({
  dna,
  resultArt,
  onDrillDonor,
}: {
  dna: DnaComposeResult | DnaSplitResult | DnaSeedResult;
  resultArt: {type: "image"; src: string} | {type: "svg"; svg: string};
  onDrillDonor?: (target: DnaDrillTarget) => void;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const [pin, setPin] = React.useState<number | null>(null);
  const active = hover ?? pin;

  // Donor-card cell hover: independent of the result grid's hover/pin. Reset whenever a new DNA
  // record loads, so a stale cell index from the previous token never carries over.
  const [donorHover, setDonorHover] = React.useState<{donorIndex: number; moduleIndex: number} | null>(null);
  React.useEffect(() => {
    setHover(null);
    setPin(null);
    setDonorHover(null);
  }, [dna]);

  // Reverse index built once per DNA record load: (donorIndex, moduleIndex) -> every result cell
  // drawn from it (compose), or moduleIndex -> every result cell (split, one donor). Hovering a
  // donor cell is then an O(1) lookup rather than a rescan of every result cell.
  const cellsByDonorKey = React.useMemo(() => {
    const map = new Map<string, number[]>();
    if (dna.kind !== "compose" && dna.kind !== "split") return map;
    dna.cells.forEach((c, j) => {
      const key = dna.kind === "compose" ? `${c.donorIndex ?? 0}:${c.moduleIndex}` : `${c.moduleIndex}`;
      const list = map.get(key);
      if (list) list.push(j);
      else map.set(key, [j]);
    });
    return map;
  }, [dna]);

  // Result cells to highlight: every cell sampled from the hovered donor cell, or (with no donor
  // cell hovered) the single hovered/pinned result cell.
  const highlightedResultCells = React.useMemo(() => {
    if (donorHover && (dna.kind === "compose" || dna.kind === "split")) {
      const key = dna.kind === "compose" ? `${donorHover.donorIndex}:${donorHover.moduleIndex}` : `${donorHover.moduleIndex}`;
      return new Set(cellsByDonorKey.get(key) ?? []);
    }
    return active != null ? new Set([active]) : new Set<number>();
  }, [donorHover, active, cellsByDonorKey, dna]);

  // Which donor cell to highlight on every donor card: the one directly hovered, or (derived)
  // the source cell of whichever result cell is hovered/pinned.
  const activeDonorCell = React.useMemo(() => {
    if (donorHover) return donorHover;
    if (active == null || (dna.kind !== "compose" && dna.kind !== "split")) return null;
    const c = dna.cells[active];
    return {donorIndex: dna.kind === "compose" ? c.donorIndex ?? 0 : 0, moduleIndex: c.moduleIndex};
  }, [donorHover, active, dna]);

  // Donor cards: reconstructed once per DNA record load (compose survivor + contributing burns,
  // or the split parent). Never recomputed on hover.
  const donorRenders = React.useMemo<DonorRender[]>(() => {
    if (dna.kind === "compose") return contributingComposeDonors(dna.donors, dna.cells);
    // Split, record branch: the pool spans multiple donors concatenated with no single grid
    // shape, so there is no card to render here (SAMPLING_SPEC.md section 6, D3'). The cell
    // detail panel still shows each cell's pool index and byte.
    if (dna.kind === "split") return dna.pool ? [splitPoolDonor(dna.pool, dna.cells)] : [];
    return [];
  }, [dna]);

  const drillFor = (d: DonorRender): (() => void) | undefined => {
    if (!onDrillDonor) return undefined;
    if (dna.kind === "split") return () => onDrillDonor({kind: "splitParent"});
    if (dna.kind !== "compose") return undefined;
    if (d.donorIndex === 0) return () => onDrillDonor({kind: "survivor"});
    const donor = dna.donors[d.donorIndex];
    return () => onDrillDonor({kind: "burn", id: donor.id});
  };

  const cellColor = (j: number): React.CSSProperties | undefined => {
    const cell = dna.cells[j];
    const isActive = highlightedResultCells.has(j);
    if (dna.kind === "compose") {
      const color = dnaDonorColor(cell.donorIndex ?? 0);
      return {
        background: `${color}33`,
        outline: `${isActive ? 2 : 1}px solid ${isActive ? color : `${color}66`}`,
      };
    }
    if (dna.kind === "split") {
      return {
        background: `${C.body}1a`,
        outline: `${isActive ? 2 : 1}px solid ${isActive ? C.ink : `${C.ink}40`}`,
      };
    }
    if (!isActive) return undefined;
    return {background: `${C.ink}22`, outline: `2px solid ${C.ink}`};
  };

  const cell = active != null ? dna.cells[active] : null;
  // "Absorbed" counts burns only, not the survivor snapshot (donorIndex 0). Named counts on both
  // sides of the fraction so the line cannot be misread as "none of every donor" (it read that
  // way with just a bare hidden count).
  const absorbedCount = dna.kind === "compose" ? dna.donors.length - 1 : 0;
  const absorbedWithNoCell =
    dna.kind === "compose" ? absorbedCount - donorRenders.filter((d) => d.donorIndex !== 0).length : 0;

  return (
    <>
      <p style={{margin: "0 0 24px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
        {dna.kind === "seed"
          ? dna.materialized
            ? "Recorded module bytes with no token id of its own, so its provenance cannot be traced any further. Hover a cell for its detail."
            : "Every cell's module derives directly from this Shape's own seed under grammar v1. Hover a cell for its detail."
          : dna.kind === "compose"
            ? "Every cell was sampled from this Shape's own prior state or one of the Shapes it absorbed. Hover a cell for its source, or hover a donor's card below to see where its modules ended up."
            : dna.branch === "grammar"
              ? "Every cell was sampled from the parent seed's expression at this denomination. Hover a cell for its source module, or hover the pool card below."
              : "Every cell was sampled from the parent's compose record: its pre-compose modules plus the modules of what it had absorbed. Hover a cell for its pool index and byte."}
      </p>
      <div style={{display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start"}}>
        <div style={{position: "relative", width: 220, aspectRatio: "250 / 350", backgroundColor: C.art}}>
          {resultArt.type === "image" ? (
            <img
              src={resultArt.src}
              alt=""
              style={{display: "block", width: "100%", height: "100%", objectFit: "cover"}}
            />
          ) : (
            <div
              dangerouslySetInnerHTML={{__html: svgForDisplay(resultArt.svg)}}
              style={{position: "absolute", inset: 0}}
            />
          )}
          <DnaGridOverlay
            geometry={dna.geometry}
            cellStyle={cellColor}
            onEnter={(j) => {
              setDonorHover(null);
              setHover(j);
            }}
            onLeave={() => setHover(null)}
            onClick={(j) => setPin((cur) => (cur === j ? null : j))}
          />
        </div>
        <div style={{flex: "1 1 260px", minWidth: 240, display: "flex", flexDirection: "column", gap: 20}}>
          {dna.kind === "compose" && (
            <div>
              <div style={{...label, marginBottom: 10}}>donors</div>
              <div style={{display: "flex", flexWrap: "wrap", gap: 14}}>
                {donorRenders.map((d) => (
                  <div key={d.donorIndex} style={{display: "flex", alignItems: "center", gap: 8}}>
                    <span style={{width: 10, height: 10, background: dnaDonorColor(d.donorIndex), flexShrink: 0}} />
                    <span style={{fontSize: 12, color: C.body}}>
                      {d.roleLabel}
                      {d.materialized ? " · materialized" : ""}
                    </span>
                  </div>
                ))}
                {absorbedWithNoCell > 0 && (
                  <span style={{fontSize: 12, color: C.muted}}>
                    + {absorbedWithNoCell} of the {absorbedCount} absorbed supplied no cell
                  </span>
                )}
              </div>
            </div>
          )}
          {dna.kind === "split" && (
            <div>
              <div style={{...label, marginBottom: 10}}>parent</div>
              <DnaRow k="seed" v={seedShort(dna.parent.seed)} />
              <DnaRow k="denomination" v={`${DENOMINATIONS[dna.parent.denomIndex]?.label ?? "?"} ETH`} />
              <DnaRow k="materialized" v={dna.parent.materialized ? "yes" : "no (seed-derived)"} />
              <DnaRow
                k="sampled from"
                v={
                  dna.branch === "grammar"
                    ? "parent seed's expression at this denomination"
                    : `${dna.poolLength} modules across the parent's compose record`
                }
              />
            </div>
          )}
          {dna.kind === "seed" && (
            <div style={{fontSize: 12, color: C.muted}}>
              {dna.materialized ? "recorded snapshot, no further provenance" : "seed-derived (grammar v1)"}
            </div>
          )}
          {cell ? (
            <div>
              <div style={{...label, marginBottom: 10}}>cell {active}</div>
              <DnaRow k="module #" v={cell.moduleIndex} />
              <DnaRow k="byte" v={`0x${cell.byte.toString(16).padStart(2, "0")}`} />
              <DnaRow k="kind" v={cell.kind} />
              <DnaRow k="solid" v={cell.solid ? "solid" : "outline"} />
              <DnaRow k="rotation" v={`${cell.rot}°`} />
              {dna.kind === "compose" && (
                <>
                  <DnaRow
                    k="donor"
                    v={cell.donorId === "survivor" ? "this shape, before the merge" : `#${cell.donorId}`}
                  />
                  <DnaRow k="materialized" v={cell.donorMaterialized ? "yes" : "no (seed-derived)"} />
                </>
              )}
            </div>
          ) : (
            <div style={{fontSize: 12, color: C.muted}}>Hover or tap a cell for its detail.</div>
          )}
          {(dna.kind === "compose" || dna.kind === "split") && (
            <div style={{fontSize: 11, color: C.faint, overflowWrap: "anywhere", lineHeight: 1.6}}>
              stored modules: {moduleBytesToHex(dna.bytes)}
            </div>
          )}
        </div>
      </div>
      {(dna.kind === "compose" || dna.kind === "split") && donorRenders.length > 0 && (
        <div style={{marginTop: 28}}>
          <div style={{...label, marginBottom: 8}}>{dna.kind === "compose" ? "contributing donors" : "sampling pool"}</div>
          {onDrillDonor && (
            <div style={{fontSize: 11, color: C.faint, marginBottom: 12}}>click a donor to see its own dna</div>
          )}
          <div style={{display: "flex", flexWrap: "wrap", gap: 18}}>
            {donorRenders.map((d) => (
              <DonorMiniCard
                key={d.donorIndex}
                donor={d}
                color={dna.kind === "compose" ? dnaDonorColor(d.donorIndex) : C.ink}
                activeCell={activeDonorCell}
                onEnterCell={(moduleIndex) => setDonorHover({donorIndex: d.donorIndex, moduleIndex})}
                onLeaveCell={() => setDonorHover(null)}
                onDrill={drillFor(d)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Loading/unavailable/mismatch text, or the resolved panel. Shared by the page's own DNA
 *  section and every drilled-into level in the modal. */
function DnaStateBody({
  dna,
  resultArt,
  onDrillDonor,
}: {
  dna: DnaResult | null;
  resultArt: {type: "image"; src: string} | {type: "svg"; svg: string};
  onDrillDonor?: (target: DnaDrillTarget) => void;
}) {
  if (dna === null) {
    return <div style={{fontSize: 13, color: C.muted, padding: "12px 0"}}>Reading token contract…</div>;
  }
  if (dna.kind === "unavailable" || dna.kind === "mismatch") {
    return <div style={{fontSize: 13, color: C.muted, lineHeight: 1.7, maxWidth: "60ch"}}>{dna.message}</div>;
  }
  return <DnaProvenancePanel dna={dna} resultArt={resultArt} onDrillDonor={onDrillDonor} />;
}

/** The page's own DNA section: the live token's `tokenURI` image as the result card, wrapped in
 *  the page's label-column `Section`. Reads lazily on token change (see the `loadDna` effect in
 *  `TokenView`); this component is pure rendering over whatever state that effect has produced. */
function DnaSection({
  dna,
  image,
  onDrillDonor,
}: {
  dna: DnaResult | null;
  image: string;
  onDrillDonor: (target: DnaDrillTarget) => void;
}) {
  return (
    <Section title="DNA" pad="16px 48px 36px 32px">
      <DnaStateBody dna={dna} resultArt={{type: "image", src: image}} onDrillDonor={onDrillDonor} />
    </Section>
  );
}

/**
 * One level of the DNA drill-down stack: a contributing donor's (or split parent's) own DNA,
 * reached by clicking its card. `subjectId` is the donor's own token id, needed to read its
 * provenance further — absent for a split parent, since `splitOriginOf` records the parent's
 * seed/denomination/ink/modules but never its token id, making a split-parent card the
 * recursion's dead end regardless of what its own snapshot turns out to be. `depthOverride` is
 * set only when drilling into a compose survivor (see `DnaComposeResult.survivorDepth`); every
 * other level lets `loadDnaFromSnapshot` read the donor's own live `composeDepth`. `art` is
 * rendered once at push time from the snapshot alone, so it never waits on `dna` to resolve.
 */
interface DnaDrillLevel {
  label: string;
  subjectId: bigint | null;
  depthOverride: number | undefined;
  snapshot: {seed: bigint; denomIndex: number; inkGene: number; modules: Uint8Array};
  art: {svg: string; geometry: CardGeometry};
  dna: DnaResult | null;
}

/** Build the next drill-down level from a click on `parentDna`'s donor/parent card. Returns null
 *  when the target does not apply to `parentDna`'s kind (should not happen: `DnaProvenancePanel`
 *  only ever fires `"splitParent"` for a split result and `"survivor"`/`"burn"` for a compose
 *  one) or when a named burn donor cannot be found. A split parent resolves synchronously via
 *  `deriveSeedDna` (no chain read: it has no token id to read further); every other target starts
 *  `dna: null`, picked up by `TokenView`'s drill-stack fetch effect. */
function drillTargetToLevel(
  parentDna: DnaComposeResult | DnaSplitResult,
  parentSubjectId: bigint,
  target: DnaDrillTarget,
): DnaDrillLevel | null {
  if (target.kind === "splitParent") {
    if (parentDna.kind !== "split") return null;
    const p = parentDna.parent;
    const modules = p.modules ?? new Uint8Array();
    const art = renderDonor(p.seed, p.denomIndex, p.inkGene, p.modules);
    return {
      label: "before the split",
      subjectId: null,
      depthOverride: undefined,
      snapshot: {seed: p.seed, denomIndex: p.denomIndex, inkGene: p.inkGene, modules},
      art,
      dna: deriveSeedDna({seed: p.seed, denomIndex: p.denomIndex, inkGene: p.inkGene, modules}),
    };
  }
  if (parentDna.kind !== "compose") return null;
  if (target.kind === "survivor") {
    const donor = parentDna.donors[0];
    const modules = donor.modules ?? new Uint8Array();
    return {
      label: "before the merge",
      subjectId: parentSubjectId,
      depthOverride: parentDna.survivorDepth,
      snapshot: {seed: donor.seed, denomIndex: donor.denomIndex, inkGene: donor.inkGene, modules},
      art: renderDonor(donor.seed, donor.denomIndex, donor.inkGene, donor.modules),
      dna: null,
    };
  }
  const donor = parentDna.donors.find((d) => d.id === target.id);
  if (!donor) return null;
  const modules = donor.modules ?? new Uint8Array();
  return {
    label: `#${target.id}`,
    subjectId: BigInt(target.id),
    depthOverride: undefined,
    snapshot: {seed: donor.seed, denomIndex: donor.denomIndex, inkGene: donor.inkGene, modules},
    art: renderDonor(donor.seed, donor.denomIndex, donor.inkGene, donor.modules),
    dna: null,
  };
}

/**
 * The DNA drill-down modal: a breadcrumb ("#16692 › before the merge › #16716") over the
 * topmost stack level's own DNA panel. Clicking the root chip closes the modal; clicking any
 * other breadcrumb entry truncates the stack back to it (cached levels below it are kept, never
 * refetched). Clicking a donor card inside the topmost level's panel builds and pushes the next
 * level via `drillTargetToLevel`.
 */
function DnaDrillModal({
  rootTokenId,
  stack,
  onNavigate,
  onPush,
  onClose,
}: {
  rootTokenId: bigint;
  stack: DnaDrillLevel[];
  onNavigate: (depth: number) => void;
  onPush: (level: DnaDrillLevel) => void;
  onClose: () => void;
}) {
  const top = stack[stack.length - 1];

  const onDrillDonor = (target: DnaDrillTarget) => {
    if (!top.dna || (top.dna.kind !== "compose" && top.dna.kind !== "split")) return;
    if (top.subjectId === null) return; // a leaf (split-parent) result never has donors to click
    const level = drillTargetToLevel(top.dna, top.subjectId, target);
    if (level) onPush(level);
  };

  return (
    <Modal title="DNA" onCancel={onClose} maxWidth="min(92vw, 760px)">
      <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 20}}>
        <button
          type="button"
          className="btn-ghost"
          onClick={onClose}
          style={{fontSize: 11, letterSpacing: "0.06em", color: C.muted}}
        >
          #{rootTokenId.toString()}
        </button>
        {stack.map((lvl, i) => (
          <React.Fragment key={i}>
            <span style={{fontSize: 11, color: C.faint}}>›</span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onNavigate(i + 1)}
              style={{
                fontSize: 11,
                letterSpacing: "0.06em",
                color: i === stack.length - 1 ? C.body : C.muted,
              }}
            >
              {lvl.label}
            </button>
          </React.Fragment>
        ))}
      </div>
      <DnaStateBody dna={top.dna} resultArt={{type: "svg", svg: top.art.svg}} onDrillDonor={onDrillDonor} />
    </Modal>
  );
}
