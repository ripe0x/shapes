import React from "react";
import {formatEther, parseEther} from "viem";
import {useAccount, usePublicClient, useWriteContract} from "wagmi";
import {ConnectButton} from "@rainbow-me/rainbowkit";
import {shapesAbi, DENOMINATIONS, denomIndexOf, type Deployment} from "./abi";
import {renderShape, CANONICAL} from "../canonical/render";
import {UNIT} from "../canonical/denominations";
import {geneAtCompose, centerGene} from "../canonical/ink";
import {geneIndexOfName} from "../previewGene";
import {splitChildSeed} from "../splitSeed";
import {loadTokenHistory, type HistEvent} from "../site/tokenHistory";


interface OwnedToken {
  id: bigint;
  backing: bigint; // redeemable backing; 0 for Black
  denomWei: bigint; // the stored denomination for display (Black keeps its apex denom)
  seed: bigint;
  originCount: bigint;
  complete: boolean;
  isBlack: boolean;
  inkGene: number; // stored ink gene, from the tokenURI "Ink" trait
  image: string; // svg data URI decoded from tokenURI
  composeDepth: bigint; // stacked composes decompose(survivorId) can still reverse
}

type Formation = "Black" | "Complete" | "Fragment" | "Direct" | "Composed";

interface Reserve {
  redeemableBacking: bigint;
  burnedBacking: bigint;
  blackShapeCount: bigint;
  balance: bigint;
  supply: bigint;
  minted: bigint;
}

interface PreviewChild {
  index: number;
  seed: bigint;
  amountWei: bigint;
  originCount: bigint;
  inkGene: number; // split copies the parent's gene verbatim to every child
}

/* ------------------------------------------------------------------ *
 *  Pure helpers
 * ------------------------------------------------------------------ */

/// Render a Shape locally from the canonical renderer — the same code the contract ports — so a
/// recomposition's outcome can be shown before any transaction is sent. Artwork is a pure function
/// of (seed, denomination), and a split fixes its children's seeds deterministically, so these
/// previews are exact, not approximations.
function localShapeImage(
  seed: bigint,
  amountWei: bigint,
  inkGene: number,
  inverted = false,
): string {
  return `data:image/svg+xml;base64,${btoa(renderShape(seed, amountWei, 0n, inkGene, CANONICAL, inverted))}`;
}

/// The ink gene a compose would assign the survivor, computed exactly as `Shapes.compose` does:
/// pool `{survivor + burns}` for the best, worst and units-weighted center, then walk the
/// survivor's gene one tier at a time. Avoids a round trip to `previewCompose`.
function composedGene(survivor: OwnedToken, burns: OwnedToken[], sumWei: bigint): number {
  const oldIndex = denomIndexOf(survivor.denomWei);
  const newIndex = denomIndexOf(sumWei);
  let best = survivor.inkGene;
  let worst = survivor.inkGene;
  const survivorUnits = survivor.denomWei / UNIT;
  let sumW = BigInt(survivor.inkGene) * survivorUnits;
  let unitsTotal = survivorUnits;
  let burnSeedFold = 0n;
  for (const b of burns) {
    burnSeedFold ^= b.seed;
    if (b.inkGene > best) best = b.inkGene;
    if (b.inkGene < worst) worst = b.inkGene;
    const bUnits = b.denomWei / UNIT;
    sumW += BigInt(b.inkGene) * bUnits;
    unitsTotal += bUnits;
  }
  const center = centerGene(sumW, unitsTotal);
  return geneAtCompose(
    survivor.seed,
    burnSeedFold,
    survivor.inkGene,
    oldIndex,
    newIndex,
    best,
    worst,
    center,
  );
}

/// Decode a Shapes tokenURI. Returns the inline SVG image and the token's stored denomination from
/// the "ETH Value" trait. `backingOf()` returns 0 for a Black token, so the metadata is the correct
/// source for a Black token's original denomination (used for the density/units display).
function parseTokenMeta(uri: string): {image: string; denomWei: bigint; inkGene: number} {
  const json = JSON.parse(atob(uri.replace("data:application/json;base64,", "")));
  const attrs = (json.attributes ?? []) as {trait_type?: string; value: string}[];
  const ethTrait = attrs.find((a) => a.trait_type === "ETH Value");
  const label = ethTrait ? String(ethTrait.value).split(" ")[0] : "0";
  const inkTrait = attrs.find((a) => a.trait_type === "Ink");
  return {
    image: json.image as string,
    denomWei: parseEther(label),
    inkGene: geneIndexOfName(String(inkTrait?.value ?? "Murk")),
  };
}

/// The provenance label for a (backing, originCount, isBlack) triple. Mirrors
/// ShapeRenderer._formation. Fragment is a zero-origin split remainder.
function formationOf(backing: bigint, originCount: bigint, isBlack: boolean): Formation {
  if (isBlack) return "Black";
  const units = backing / UNIT;
  if (units > 1n && originCount === units) return "Complete";
  if (originCount === 0n) return "Fragment";
  if (originCount === 1n) return "Direct";
  return "Composed";
}

/// `originCount / units` as a percentage string, matching ShapeRenderer._densityPercent.
function densityPercent(backing: bigint, originCount: bigint): string {
  const units = backing / UNIT;
  if (units === 0n) return "0";
  const h = (originCount * 10000n) / units;
  const whole = h / 100n;
  const frac = h % 100n;
  if (frac === 0n) return whole.toString();
  if (frac % 10n === 0n) return `${whole}.${frac / 10n}`;
  return `${whole}.${frac < 10n ? "0" : ""}${frac}`;
}

/// The exact outputs of splitting a token one tier down: fresh seeds from `splitChildSeed`, and
/// the survivor-first origin partition the contract applies (each child capped at its own capacity).
function splitChildren(t: OwnedToken): PreviewChild[] {
  const di = denomIndexOf(t.backing);
  if (di <= 0) return [];
  const downWei = DENOMINATIONS[di - 1].wei;
  const ratio = Number(t.backing / downWei); // 2 or 5
  const cap = downWei / UNIT;
  let remaining = t.originCount;
  const kids: PreviewChild[] = [];
  for (let i = 0; i < ratio; i++) {
    const give = remaining < cap ? remaining : cap;
    remaining -= give;
    kids.push({
      index: i,
      seed: splitChildSeed(t.seed, i),
      amountWei: downWei,
      originCount: give,
      inkGene: t.inkGene,
    });
  }
  return kids;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const seedHex = (s: bigint) => "0x" + s.toString(16).padStart(64, "0");

function shortError(e: unknown): string {
  const a = e as {shortMessage?: string; message?: string};
  return a?.shortMessage || a?.message || String(e);
}

/* ------------------------------------------------------------------ *
 *  App
 * ------------------------------------------------------------------ */

export function ChainApp({dep}: {dep: Deployment}) {
  const {address, isConnected} = useAccount();
  const publicClient = usePublicClient({chainId: dep.chainId});
  const {writeContractAsync} = useWriteContract();

  const [busy, setBusy] = React.useState<string | null>(null);
  const [txErr, setTxErr] = React.useState<string | null>(null);
  const [amountWei, setAmountWei] = React.useState<bigint>(DENOMINATIONS[3].wei); // 1 ETH
  const [qty, setQty] = React.useState(1);
  const [tokens, setTokens] = React.useState<OwnedToken[]>([]);
  const [reserve, setReserve] = React.useState<Reserve | null>(null);
  const [acctBalance, setAcctBalance] = React.useState<bigint>(0n);
  const [mintFee, setMintFee] = React.useState<bigint>(0n);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [splitPreview, setSplitPreview] = React.useState(false); // show split preview on the open detail
  const [view, setView] = React.useState<bigint | null>(null); // null = grid; else the detail token id
  const [history, setHistory] = React.useState<HistEvent[] | null>(null);

  const feePerNft = mintFee;

  const refresh = React.useCallback(async () => {
    if (!publicClient || !address) return;
    const shapes = {address: dep.shapes, abi: shapesAbi} as const;

    const [redeemableBacking, burnedBacking, blackShapeCount, supply, minted, fee, balance, acct] =
      await Promise.all([
        publicClient.readContract({...shapes, functionName: "redeemableBacking"}),
        publicClient.readContract({...shapes, functionName: "burnedBacking"}),
        publicClient.readContract({...shapes, functionName: "blackShapeCount"}),
        publicClient.readContract({...shapes, functionName: "totalSupply"}),
        publicClient.readContract({...shapes, functionName: "totalMinted"}),
        publicClient.readContract({...shapes, functionName: "mintFee"}),
        publicClient.getBalance({address: dep.shapes}),
        publicClient.getBalance({address}),
      ]);
    setReserve({redeemableBacking, burnedBacking, blackShapeCount, balance, supply, minted});
    setMintFee(fee);
    setAcctBalance(acct);

    // No enumerable extension; in a dev harness the id space is tiny, so scan it and keep the
    // live tokens this account owns. Burned ids revert on ownerOf and are skipped.
    const owned: OwnedToken[] = [];
    for (let id = 0n; id < minted; id++) {
      let owner: string;
      try {
        owner = await publicClient.readContract({...shapes, functionName: "ownerOf", args: [id]});
      } catch {
        continue; // burned
      }
      if (owner.toLowerCase() !== address.toLowerCase()) continue;
      const [backing, seed, originCount, complete, black, uri, composeDepth] = await Promise.all([
        publicClient.readContract({...shapes, functionName: "backingOf", args: [id]}),
        publicClient.readContract({...shapes, functionName: "seedOf", args: [id]}),
        publicClient.readContract({...shapes, functionName: "originCountOf", args: [id]}),
        publicClient.readContract({...shapes, functionName: "isComplete", args: [id]}),
        publicClient.readContract({...shapes, functionName: "isBlackShape", args: [id]}),
        publicClient.readContract({...shapes, functionName: "tokenURI", args: [id]}),
        publicClient.readContract({...shapes, functionName: "composeDepth", args: [id]}),
      ]);
      const {image, denomWei, inkGene} = parseTokenMeta(uri);
      owned.push({
        id,
        backing,
        denomWei,
        seed: BigInt(seed),
        originCount,
        complete,
        isBlack: black,
        inkGene,
        image,
        composeDepth,
      });
    }
    setTokens(owned);
    setSelected((prev) => {
      const live = new Set(owned.map((t) => t.id.toString()));
      const next = new Set([...prev].filter((s) => live.has(s)));
      return next.size === prev.size ? prev : next;
    });
  }, [publicClient, address, dep.shapes]);

  React.useEffect(() => {
    if (isConnected && address) void refresh();
    else {
      setReserve(null);
      setTokens([]);
      setView(null);
    }
  }, [isConnected, address, refresh]);

  // Load the open token's history from the indexer. Re-runs after any transaction (tokens change).
  React.useEffect(() => {
    if (view === null || !publicClient) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setHistory(null);
    void loadTokenHistory(publicClient, dep, view).then((h) => {
      if (!cancelled) setHistory(h);
    });
    return () => {
      cancelled = true;
    };
  }, [view, publicClient, dep, tokens]);

  // Returns true only when the transaction was sent, mined, and state refreshed. Callers gate
  // navigation and selection changes on this, so a reverted or rejected tx leaves the view intact.
  const run = async (label: string, send: () => Promise<`0x${string}`>): Promise<boolean> => {
    if (!publicClient) return false;
    setBusy(label);
    setTxErr(null);
    try {
      const hash = await send();
      await publicClient.waitForTransactionReceipt({hash});
      await refresh();
      return true;
    } catch (e) {
      setTxErr(shortError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const write = (functionName: string, args: readonly unknown[], value?: bigint) =>
    writeContractAsync({
      address: dep.shapes,
      abi: shapesAbi,
      functionName,
      args,
      value,
      chainId: dep.chainId,
    } as Parameters<typeof writeContractAsync>[0]);

  const mint = () =>
    run("mint", () => {
      const value = (amountWei + feePerNft) * BigInt(qty);
      return qty === 1
        ? write("mint", [amountWei], value)
        : write("mintBatch", [amountWei, BigInt(qty)], value);
    });

  const redeem = (id: bigint) =>
    void run(`redeem ${id}`, () => write("redeem", [id])).then((ok) => {
      if (ok) setView(null);
    });

  const burnBacking = (id: bigint) => run(`burnBacking ${id}`, () => write("burnBacking", [id]));

  const toggleSelect = (id: bigint) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = id.toString();
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // Compose: the summed backing must land on a denomination. Survivor is the lowest selected id, so
  // it keeps that id and its seed. One atomic transaction: no approvals, the caller owns every input.
  const selectedTokens = tokens.filter((t) => selected.has(t.id.toString()) && !t.isBlack);
  const composeSum = selectedTokens.reduce((a, t) => a + t.backing, 0n);
  const composeValid = selectedTokens.length >= 2 && denomIndexOf(composeSum) >= 0;
  const composeSurvivor =
    selectedTokens.length >= 1
      ? [...selectedTokens].sort((a, b) => (a.id < b.id ? -1 : 1))[0]
      : null;
  const composeOrigins = selectedTokens.reduce((a, t) => a + t.originCount, 0n);
  const composeResultGene =
    composeValid && composeSurvivor
      ? composedGene(
          composeSurvivor,
          selectedTokens.filter((t) => t.id !== composeSurvivor.id),
          composeSum,
        )
      : (composeSurvivor?.inkGene ?? 0);

  const compose = () => {
    if (!composeSurvivor) return;
    const burnIds = selectedTokens
      .filter((t) => t.id !== composeSurvivor.id)
      .map((t) => t.id)
      .sort((a, b) => (a < b ? -1 : 1));
    void run("compose", () => write("compose", [composeSurvivor.id, burnIds])).then((ok) => {
      if (!ok) return;
      setSelected(new Set());
      setView(composeSurvivor.id); // land on the survivor's detail to see the result + new history
    });
  };

  // Split one tier down into the ladder ratio. Confirmed from the split preview.
  const detailToken = view === null ? null : tokens.find((t) => t.id === view) ?? null;
  const splitKids = detailToken ? splitChildren(detailToken) : [];

  const confirmSplit = (t: OwnedToken) => {
    const di = denomIndexOf(t.backing);
    if (di <= 0) return;
    const outDenoms = Array<number>(splitChildren(t).length).fill(di - 1);
    void run(`split ${t.id}`, () => write("split", [t.id, outDenoms])).then((ok) => {
      if (ok) setView(null);
      else setSplitPreview(false); // keep the token open; just collapse the preview panel
    });
  };

  // Decompose: reverse the survivor's most recent still-standing compose. The survivor keeps its
  // id and reverts to its pre-compose state; every burned input comes back under its original id.
  const decomposeUndo = (id: bigint) =>
    void run(`decompose ${id}`, () => write("decompose", [id])).then((ok) => {
      if (ok) setView(id); // survivor keeps its id; land back on its detail to see the reversion
    });

  const openDetail = (id: bigint) => {
    setSplitPreview(false);
    setView(id);
  };

  return (
    <div style={S.page}>
      <div style={{maxWidth: 1080, margin: "0 auto"}}>
        <header style={S.header}>
          <div
            onClick={() => setView(null)}
            style={{cursor: "pointer"}}
            title="Shapes — back to your collection"
          >
            <div style={S.wordmark}>SHAPES</div>
            <div style={{...S.meta, marginTop: 4}}>
              onchain ETH-backed objects · {short(dep.shapes)} · chain {dep.chainId}
            </div>
          </div>
          <ConnectButton />
        </header>

        {!isConnected || !reserve ? (
          <Centered>{isConnected ? "Loading chain state…" : "Connect a wallet to begin."}</Centered>
        ) : view !== null ? (
          <Detail
            token={detailToken}
            id={view}
            history={history}
            busy={busy}
            selected={selected.has(view.toString())}
            splitPreview={splitPreview}
            splitKids={splitKids}
            onBack={() => setView(null)}
            onRedeem={redeem}
            onBurnBacking={burnBacking}
            onToggleSelect={toggleSelect}
            onToggleSplit={() => setSplitPreview((v) => !v)}
            onConfirmSplit={confirmSplit}
            onDecompose={decomposeUndo}
          />
        ) : (
          <>
            <ReserveCard reserve={reserve} feePerNft={feePerNft} acctBalance={acctBalance} />
            <MintPanel
              amountWei={amountWei}
              setAmountWei={setAmountWei}
              qty={qty}
              setQty={setQty}
              feePerNft={feePerNft}
              busy={busy}
              onMint={mint}
            />

            <div style={S.sectionLabel}>YOUR SHAPES</div>
            {tokens.length === 0 ? (
              <Centered>none yet — mint one above</Centered>
            ) : (
              <div style={S.grid}>
                {tokens.map((t) => (
                  <TokenCard
                    key={t.id.toString()}
                    t={t}
                    selected={selected.has(t.id.toString())}
                    onOpen={() => openDetail(t.id)}
                    onToggleSelect={() => toggleSelect(t.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {txErr && <div style={S.error}>{txErr}</div>}
      </div>

      {/* Compose tray — sticky, visible across grid and detail while a merge is being assembled. */}
      {selectedTokens.length >= 2 && (
        <ComposeTray
          count={selectedTokens.length}
          sum={composeSum}
          origins={composeOrigins}
          valid={composeValid}
          survivor={composeSurvivor}
          resultGene={composeResultGene}
          resultFormation={formationOf(composeSum, composeOrigins, false)}
          busy={busy}
          onClear={() => setSelected(new Set())}
          onCompose={compose}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Token detail — provenance + history
 * ------------------------------------------------------------------ */

function Detail({
  token,
  id,
  history,
  busy,
  selected,
  splitPreview,
  splitKids,
  onBack,
  onRedeem,
  onBurnBacking,
  onToggleSelect,
  onToggleSplit,
  onConfirmSplit,
  onDecompose,
}: {
  token: OwnedToken | null;
  id: bigint;
  history: HistEvent[] | null;
  busy: string | null;
  selected: boolean;
  splitPreview: boolean;
  splitKids: PreviewChild[];
  onBack: () => void;
  onRedeem: (id: bigint) => void;
  onBurnBacking: (id: bigint) => void;
  onToggleSelect: (id: bigint) => void;
  onToggleSplit: () => void;
  onConfirmSplit: (t: OwnedToken) => void;
  onDecompose: (id: bigint) => void;
}) {
  // The token can be gone (redeemed or merged elsewhere) while its history remains.
  if (!token) {
    return (
      <div>
        <button onClick={onBack} style={S.back}>
          ← all shapes
        </button>
        <div style={{...S.card, textAlign: "center"}}>
          <div style={S.meta}>SHAPE #{id.toString()}</div>
          <div style={{color: "#aaa", marginTop: 8}}>
            No longer live — it was redeemed or recomposed. Its history is below.
          </div>
        </div>
        <HistorySection history={history} />
      </div>
    );
  }

  const di = denomIndexOf(token.backing);
  const canSplit = !token.isBlack && di > 0;
  const canBurnBacking = !token.isBlack && token.complete && token.backing === DENOMINATIONS[8].wei;
  const formation = formationOf(token.backing, token.originCount, token.isBlack);

  return (
    <div>
      <button onClick={onBack} style={S.back}>
        ← all shapes
      </button>

      <div style={S.detailTop}>
        <img src={token.image} alt={`shape ${token.id}`} style={S.detailArt} />

        <div style={{flex: 1, minWidth: 260}}>
          <div style={S.meta}>SHAPE #{token.id.toString()}</div>
          <div style={S.detailValue}>
            {token.isBlack ? "backing burned" : `${formatEther(token.backing)} ETH`}
          </div>
          <div style={{marginTop: 10}}>
            <FormationBadge label={formation} large />
          </div>

          <div style={S.provGrid}>
            <Prov k="Formation" v={formation} />
            <Prov k="Independent origins" v={token.originCount.toString()} />
            <Prov k="Origin density" v={`${densityPercent(token.denomWei, token.originCount)}%`} />
            <Prov k="Units" v={(token.denomWei / UNIT).toString()} />
            <Prov k="Complete" v={token.complete ? "yes" : "no"} />
            <Prov k="Black" v={token.isBlack ? "yes" : "no"} />
          </div>
          <div style={{...S.meta, marginTop: 12, wordBreak: "break-all"}}>SEED {seedHex(token.seed)}</div>

          <div style={S.actionRow}>
            {!token.isBlack && (
              <button onClick={() => onRedeem(token.id)} disabled={!!busy} style={S.btn}>
                {busy === `redeem ${token.id}` ? "redeeming…" : "redeem"}
              </button>
            )}
            {canSplit && (
              <button onClick={onToggleSplit} disabled={!!busy} style={{...S.btn, ...(splitPreview ? S.btnOn : null)}}>
                {splitPreview ? "hide split" : `split → ${DENOMINATIONS[di - 1].label} ETH ×${splitKids.length}`}
              </button>
            )}
            {!token.isBlack && token.composeDepth > 0n && (
              <button onClick={() => onDecompose(token.id)} disabled={!!busy} style={S.btn}>
                {busy === `decompose ${token.id}` ? "decomposing…" : "decompose (undo compose)"}
              </button>
            )}
            {!token.isBlack && (
              <button
                onClick={() => onToggleSelect(token.id)}
                disabled={!!busy}
                style={{...S.btn, ...(selected ? S.btnSel : null)}}
              >
                {selected ? "selected to compose ✓" : "select to compose"}
              </button>
            )}
            {canBurnBacking && (
              <button onClick={() => onBurnBacking(token.id)} disabled={!!busy} style={S.btnBurnBacking}>
                {busy === `burnBacking ${token.id}` ? "burning backing…" : "burn backing (100 ETH)"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Split preview — exact children, rendered locally from deterministic child seeds. */}
      {canSplit && splitPreview && (
        <section style={{...S.card, borderColor: "#963"}}>
          <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12}}>
            <div style={S.meta}>
              SPLITS INTO {splitKids.length} × {DENOMINATIONS[di - 1].label} ETH — previewed from the
              deterministic child seeds; origins fill survivor-first
            </div>
            <button onClick={() => onConfirmSplit(token)} disabled={!!busy} style={S.primary}>
              {busy === `split ${token.id}` ? "splitting…" : "confirm split"}
            </button>
          </div>
          <div style={S.previewRow}>
            {splitKids.map((k) => (
              <div key={k.index} style={{textAlign: "center"}}>
                <img src={localShapeImage(k.seed, k.amountWei, k.inkGene)} alt={`child ${k.index}`} style={S.previewArt} />
                <div style={{marginTop: 5}}>
                  <FormationBadge label={formationOf(k.amountWei, k.originCount, false)} />
                </div>
                <div style={{...S.meta, marginTop: 3}}>
                  {k.originCount.toString()} origin{k.originCount === 1n ? "" : "s"}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <HistorySection history={history} />
    </div>
  );
}

const HIST_MARK: Record<HistEvent["kind"], string> = {
  mint: "◇",
  bornFromSplit: "⊟",
  splitInto: "⊟",
  absorbed: "⊞",
  mergedAway: "⊞",
  decomposed: "⊟",
  revived: "⊟",
  backingBurned: "◆",
  redeemed: "↩",
  transfer: "→",
};

/** History comes from the indexer only; with no indexer answering there is nothing to show. */
function HistorySection({history}: {history: HistEvent[] | null}) {
  if (history === null || history.length === 0) return null;
  return (
    <section style={S.card}>
      <div style={{...S.sectionLabel, margin: "0 0 12px"}}>HISTORY</div>
      {(
        <div>
          {history.map((h) => (
            <div key={h.key} style={S.histRow}>
              <span style={S.histMark}>{HIST_MARK[h.kind]}</span>
              <span style={{flex: 1}}>{h.text}</span>
              <span style={S.meta}>
                blk {h.block.toString()} · {short(h.tx)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 *  Grid + panels
 * ------------------------------------------------------------------ */

function TokenCard({
  t,
  selected,
  onOpen,
  onToggleSelect,
}: {
  t: OwnedToken;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
}) {
  return (
    <div style={{...S.card, ...(selected ? S.cardSel : null), ...(t.isBlack ? S.cardBlack : null), padding: 12}}>
      <div onClick={onOpen} style={{cursor: "pointer"}}>
        <img src={t.image} alt={`shape ${t.id}`} style={S.cardArt} />
        <div style={{...S.mono, fontSize: 12, marginTop: 8}}>
          #{t.id.toString()} · {t.isBlack ? "backing burned" : `${formatEther(t.backing)} ETH`}
        </div>
        <div style={{marginTop: 5}}>
          <FormationBadge label={formationOf(t.backing, t.originCount, t.isBlack)} />
          <span style={{...S.meta, marginLeft: 6}}>
            {t.originCount.toString()} origin{t.originCount === 1n ? "" : "s"}
          </span>
        </div>
      </div>
      {!t.isBlack && (
        <label style={{...S.meta, display: "flex", alignItems: "center", gap: 6, marginTop: 10, cursor: "pointer"}}>
          <input type="checkbox" checked={selected} onChange={onToggleSelect} />
          compose
        </label>
      )}
    </div>
  );
}

function MintPanel({
  amountWei,
  setAmountWei,
  qty,
  setQty,
  feePerNft,
  busy,
  onMint,
}: {
  amountWei: bigint;
  setAmountWei: (v: bigint) => void;
  qty: number;
  setQty: (v: number) => void;
  feePerNft: bigint;
  busy: string | null;
  onMint: () => void;
}) {
  return (
    <section style={S.card}>
      <div style={{...S.sectionLabel, margin: "0 0 10px"}}>MINT</div>
      <div style={{display: "flex", flexWrap: "wrap", gap: 6}}>
        {DENOMINATIONS.map((d) => (
          <button
            key={d.label}
            onClick={() => setAmountWei(d.wei)}
            style={{...S.chip, ...(d.wei === amountWei ? S.chipOn : null)}}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div style={{display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap"}}>
        <label style={S.meta}>
          qty{" "}
          <input
            type="number"
            min={1}
            max={50}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
            style={S.num}
          />
        </label>
        <button onClick={onMint} disabled={!!busy} style={S.primary}>
          {busy === "mint" ? "minting…" : `mint — send ${formatEther((amountWei + feePerNft) * BigInt(qty))} ETH`}
        </button>
      </div>
    </section>
  );
}

function ComposeTray({
  count,
  sum,
  origins,
  valid,
  survivor,
  resultGene,
  resultFormation,
  busy,
  onClear,
  onCompose,
}: {
  count: number;
  sum: bigint;
  origins: bigint;
  valid: boolean;
  survivor: OwnedToken | null;
  resultGene: number;
  resultFormation: Formation;
  busy: string | null;
  onClear: () => void;
  onCompose: () => void;
}) {
  return (
    <div style={S.tray}>
      <div style={{maxWidth: 1080, margin: "0 auto", display: "flex", alignItems: "center", gap: 14}}>
        {valid && survivor && (
          <img src={localShapeImage(survivor.seed, sum, resultGene)} alt="compose result" style={S.trayArt} />
        )}
        <div style={{flex: 1}}>
          <div style={{color: "#eee", fontSize: 13}}>
            {count} selected · sum {formatEther(sum)} ETH · {origins.toString()} origins
          </div>
          <div style={S.meta}>
            {valid && survivor
              ? `→ one ${resultFormation} shape, keeping #${survivor.id.toString()} (its seed, new denomination)`
              : "→ sum is not a denomination; adjust the selection"}
          </div>
        </div>
        <button onClick={onClear} style={S.btn}>
          clear
        </button>
        <button onClick={onCompose} disabled={!!busy || !valid} style={S.primary}>
          {busy === "compose" ? "composing…" : "compose"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Small pure bits
 * ------------------------------------------------------------------ */

function FormationBadge({label, large}: {label: Formation; large?: boolean}) {
  const color: Record<Formation, React.CSSProperties> = {
    Black: {background: "#fff", color: "#000", borderColor: "#fff"},
    Complete: {background: "#0b1a2a", color: "#8cf", borderColor: "#2a5a8a"},
    Composed: {background: "#161206", color: "#cc9", borderColor: "#554"},
    Fragment: {background: "#150d0d", color: "#c88", borderColor: "#633"},
    Direct: {background: "#111", color: "#999", borderColor: "#333"},
  };
  return <span style={{...S.badge, ...(large ? {fontSize: 13, padding: "4px 10px"} : null), ...color[label]}}>{label}</span>;
}

function Prov({k, v}: {k: string; v: string}) {
  return (
    <div style={S.provCell}>
      <div style={S.meta}>{k.toUpperCase()}</div>
      <div style={{...S.mono, fontSize: 14, marginTop: 2, color: "#eee"}}>{v}</div>
    </div>
  );
}

function ReserveCard({
  reserve,
  feePerNft,
  acctBalance,
}: {
  reserve: Reserve;
  feePerNft: bigint;
  acctBalance: bigint;
}) {
  const solvent = reserve.balance >= reserve.redeemableBacking;
  return (
    <section style={{...S.card, borderColor: solvent ? "#1c5" : "#e33"}}>
      <Row k="contract balance" v={`${formatEther(reserve.balance)} ETH`} />
      <Row k="redeemableBacking()" v={`${formatEther(reserve.redeemableBacking)} ETH`} />
      <Row k="invariant  balance ≥ redeemable" v={solvent ? "OK" : "INSOLVENT"} danger={!solvent} />
      {reserve.blackShapeCount > 0n && (
        <Row
          k="backing burned (Black Shapes)"
          v={`${formatEther(reserve.burnedBacking)} ETH · ${reserve.blackShapeCount} Black Shapes`}
        />
      )}
      <Row k="live / minted" v={`${reserve.supply} / ${reserve.minted}`} />
      <Row k="mint fee" v={`${formatEther(feePerNft)} ETH per Shape`} />
      <Row k="your balance" v={`${formatEther(acctBalance)} ETH`} />
    </section>
  );
}

function Row({k, v, danger}: {k: string; v: string; danger?: boolean}) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", padding: "3px 0"}}>
      <span style={S.meta}>{k}</span>
      <span style={{...S.mono, color: danger ? "#f66" : "#ddd"}}>{v}</span>
    </div>
  );
}

function Centered({children}: {children: React.ReactNode}) {
  return <div style={{...S.meta, textAlign: "center", padding: "64px 0"}}>{children}</div>;
}

/* ------------------------------------------------------------------ *
 *  Styles — Checks-inspired: black canvas, mono meta, generous space
 * ------------------------------------------------------------------ */

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const S: Record<string, React.CSSProperties> = {
  page: {minHeight: "100vh", background: "#000", color: "#eee", padding: "36px 28px 140px"},
  header: {display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, gap: 16},
  wordmark: {fontSize: 22, fontWeight: 700, letterSpacing: 2},
  meta: {color: "#777", fontSize: 11, fontFamily: MONO, letterSpacing: 0.4},
  mono: {fontFamily: MONO},
  sectionLabel: {color: "#777", fontSize: 11, fontFamily: MONO, letterSpacing: 1.5, margin: "22px 2px 10px"},
  card: {border: "1px solid #1c1c1c", borderRadius: 12, padding: 16, marginBottom: 14, background: "#080808"},
  cardSel: {borderColor: "#4a7", boxShadow: "0 0 0 1px #4a7 inset"},
  cardBlack: {borderColor: "#555", background: "#040404"},
  cardArt: {width: "100%", aspectRatio: "250 / 350", background: "#000", borderRadius: 6, border: "1px solid #151515"},
  grid: {display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 14},

  back: {background: "none", border: "none", color: "#888", fontFamily: MONO, fontSize: 12, cursor: "pointer", padding: "4px 0", marginBottom: 12},
  detailTop: {display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 8},
  detailArt: {width: 300, maxWidth: "100%", aspectRatio: "250 / 350", background: "#000", borderRadius: 10, border: "1px solid #1c1c1c"},
  detailValue: {fontSize: 30, fontWeight: 600, marginTop: 6},
  provGrid: {display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10, marginTop: 18},
  provCell: {border: "1px solid #1a1a1a", borderRadius: 8, padding: "8px 10px", background: "#0b0b0b"},
  actionRow: {display: "flex", flexWrap: "wrap", gap: 8, marginTop: 20},

  histRow: {display: "flex", alignItems: "baseline", gap: 10, padding: "7px 0", borderTop: "1px solid #151515", fontSize: 13, color: "#ddd"},
  histMark: {fontFamily: MONO, color: "#888", width: 16, textAlign: "center"},

  previewRow: {display: "flex", flexWrap: "wrap", gap: 14},
  previewArt: {width: 84, aspectRatio: "250 / 350", background: "#000", borderRadius: 5, border: "1px solid #222"},

  tray: {position: "fixed", left: 0, right: 0, bottom: 0, background: "#0b0b0bF2", borderTop: "1px solid #2a2a2a", padding: "12px 28px", backdropFilter: "blur(6px)"},
  trayArt: {width: 44, aspectRatio: "250 / 350", background: "#000", borderRadius: 4, border: "1px solid #222"},

  badge: {display: "inline-block", fontFamily: MONO, fontSize: 11, padding: "2px 8px", borderRadius: 5, border: "1px solid #333"},
  chip: {background: "#111", color: "#ccc", border: "1px solid #2a2a2a", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontFamily: MONO},
  chipOn: {background: "#fff", color: "#000", borderColor: "#fff"},
  num: {width: 56, background: "#111", color: "#eee", border: "1px solid #2a2a2a", borderRadius: 6, padding: "5px 8px"},

  primary: {background: "#fff", color: "#000", border: "none", borderRadius: 8, padding: "9px 16px", cursor: "pointer", fontWeight: 600},
  btn: {background: "#111", color: "#ccc", border: "1px solid #333", borderRadius: 8, padding: "9px 14px", cursor: "pointer", fontSize: 13},
  btnOn: {background: "#3a2a12", color: "#fb8", borderColor: "#963"},
  btnSel: {background: "#0f2418", color: "#8e8", borderColor: "#4a7"},
  btnBurnBacking: {background: "#181818", color: "#fff", border: "1px solid #666", borderRadius: 8, padding: "9px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600},

  error: {fontFamily: MONO, color: "#f66", marginTop: 12, fontSize: 13},
};
