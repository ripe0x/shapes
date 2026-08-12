import React from "react";
import {formatEther, type PublicClient} from "viem";
import {DENOMINATIONS, denomIndexOf, type Deployment} from "../chain/abi";
import {GRIDS} from "../canonical/denominations";
import {composeShape, fillClass, seedHex} from "../canonical/render";
import {decomposeChildSeed} from "../decomposeSeed";
import {loadHistory, type HistEvent} from "../chain/history";
import {C} from "./theme";
import {Section, Art, short, txUrl} from "./ui";
import {localArt} from "./art";
import type {SiteData, SiteToken} from "./data";
import type {RedeemState} from "./SiteApp";

const EVENT_LABEL: Record<HistEvent["kind"], string> = {
  mint: "Minted",
  bornFromSplit: "Created",
  splitInto: "Split",
  absorbed: "Composed",
  mergedAway: "Merged",
  blackened: "Blackened",
  redeemed: "Redeemed",
  transfer: "Transferred",
};

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
  onDecompose,
  onCompose,
}: {
  data: SiteData | null;
  dep: Deployment;
  publicClient: PublicClient | undefined;
  address: `0x${string}` | undefined;
  tokenId: bigint;
  redeem: RedeemState;
  busy: string | null;
  txErr: string | null;
  onBack: () => void;
  onAskRedeem: () => void;
  onCancelRedeem: () => void;
  onConfirmRedeem: (t: SiteToken) => void;
  onDecompose: (t: SiteToken) => void;
  onCompose: (t: SiteToken, burnIds: bigint[]) => void;
}) {
  const [tab, setTab] = React.useState<"split" | "compose">("split");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [history, setHistory] = React.useState<DatedEvent[] | null>(null);

  React.useEffect(() => {
    setTab("split");
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

  const token = data?.tokens.find((t) => t.id === tokenId) ?? null;
  const snap = redeem.status === "done" && redeem.snap?.id === tokenId ? redeem.snap : null;

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
            <Art src={localArt(snap.seed, DENOMINATIONS[snap.di].wei)} width={340} />
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
            Shape #{tokenId.toString()} is no longer live. It was redeemed or recomposed. Its
            history is below.
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
  const comp = composeShape(token.seed, token.backing);

  const tokRows: {k: string; v: React.ReactNode; size?: number; wrap?: "anywhere" | "normal"}[] = [
    {k: "denomination", v: `${lbl} ETH`},
    {k: "token", v: `#${token.id.toString()}`},
    {k: "grid", v: `${cols} × ${rows} · ${cols * rows === 1 ? "1 mark" : `${cols * rows} marks`}`},
    {k: "fill", v: fillClass(comp)},
    {k: "owner", v: owned ? `${short(token.owner)} (you)` : short(token.owner), wrap: "anywhere"},
    {k: "seed", v: seedHex(token.seed), size: 12, wrap: "anywhere"},
    {k: "backing, exact", v: `${token.backing.toString()} wei`, size: 11},
  ];

  // Decompose: the designed one-tier-down even split. Child seeds are fixed by the parent's
  // seed, so the previews are the exact tokens the contract would mint.
  const canSplit = di > 0;
  const downWei = canSplit ? DENOMINATIONS[di - 1].wei : 0n;
  const ratio = canSplit ? Number(token.backing / downWei) : 0;
  const splitChildren = canSplit
    ? Array.from({length: ratio}, (_, i) => ({
        seed: decomposeChildSeed(token.seed, i),
        wei: downWei,
      }))
    : [];

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
  const composeValid = pickedIds.length >= 1 && sumIdx >= 0;

  return (
    <main>
      {back}

      <Section title="SHAPE" pad="36px 48px 44px 32px">
        <div style={{display: "flex", flexWrap: "wrap", gap: 48, alignItems: "flex-start"}}>
          <Art src={token.image} alt={`Shape #${token.id}`} width={340} />
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

      <History history={history} chainId={dep.chainId} />

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
                  This cannot be undone. The token is burned and {token.backing.toString()} wei (
                  {lbl} ETH) is sent to {short(token.owner)}.
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

          <Section
            labelNode={
              <div style={{display: "grid", gap: 12, fontSize: 10, letterSpacing: "0.14em"}}>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setTab("split")}
                  style={{textAlign: "left", letterSpacing: "0.14em", fontSize: 10, color: tab === "split" ? C.ink : C.muted}}
                >
                  DECOMPOSE
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setTab("compose")}
                  style={{textAlign: "left", letterSpacing: "0.14em", fontSize: 10, color: tab === "compose" ? C.ink : C.muted}}
                >
                  RECOMPOSE
                </button>
              </div>
            }
            pad="26px 48px 36px 32px"
          >
            {tab === "split" ? (
              <div>
                <p style={{margin: "0 0 8px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
                  {canSplit
                    ? `Split this Shape into ${ratio} Shapes of ${DENOMINATIONS[di - 1].label} ETH. The outputs sum to exactly ${lbl} ETH.`
                    : "0.01 ETH is the smallest denomination. This Shape cannot be split."}
                </p>
                {canSplit && (
                  <p style={{margin: "0 0 26px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
                    No ETH moves. No fee is charged. The seeds below are fixed already, so this is
                    the exact result.
                  </p>
                )}
                <div style={{display: "flex", flexWrap: "wrap", gap: 18}}>
                  {splitChildren.map((c, i) => (
                    <div key={i} style={{flex: "0 0 96px", width: 96}}>
                      <Art src={localArt(c.seed, c.wei)} />
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
                    onClick={() => onDecompose(token)}
                    disabled={!!busy}
                    style={{marginTop: 26, padding: "10px 20px"}}
                  >
                    {busy === "decompose" ? "Waiting for confirmation" : "Decompose"}
                  </button>
                )}
              </div>
            ) : (
              <div>
                <p style={{margin: "0 0 8px", fontSize: 13, lineHeight: 1.75, maxWidth: "60ch"}}>
                  Compose Shapes of the same denomination into one larger Shape. #
                  {token.id.toString()} survives and keeps its seed.
                </p>
                <p style={{margin: "0 0 24px", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
                  This Shape keeps its id and its seed. The others are burned into it. No ETH
                  moves.
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
                          font: "inherit",
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
              </div>
            )}
            {txErr && (
              <p style={{margin: "18px 0 0", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "60ch"}}>
                {txErr}
              </p>
            )}
          </Section>
        </>
      )}

      {!owned && (
        <Section title="OWNERSHIP">
          <div style={{fontSize: 13, lineHeight: 1.75, color: C.bodyDim, maxWidth: "60ch"}}>
            {address
              ? "This Shape belongs to another address. Only its owner can redeem, compose or decompose it."
              : "Connect the owning wallet to redeem, compose or decompose this Shape."}
          </div>
        </Section>
      )}
      <div style={{height: 64}} />
    </main>
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
