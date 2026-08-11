import React from "react";
import {formatEther} from "viem";
import {useAccount, usePublicClient, useWriteContract} from "wagmi";
import {ConnectButton} from "@rainbow-me/rainbowkit";
import {shapesAbi, DENOMINATIONS, denomIndexOf, type Deployment} from "./abi";

const UNIT = 10_000_000_000_000_000n; // 0.01 ETH

interface OwnedToken {
  id: bigint;
  backing: bigint; // 0 for Black
  originCount: bigint;
  complete: boolean;
  isBlack: boolean;
  image: string; // svg data URI decoded from tokenURI
}

interface Reserve {
  redeemableBacking: bigint;
  sacrificedBacking: bigint;
  blackCount: bigint;
  balance: bigint;
  supply: bigint;
  minted: bigint;
}

/// Decode a Shapes tokenURI (data:application/json;base64,...) to its inline SVG image URI.
function imageFromTokenURI(uri: string): string {
  const json = JSON.parse(atob(uri.replace("data:application/json;base64,", "")));
  return json.image as string;
}

/// The provenance label, mirroring ShapeRenderer._formation. A Black token reports backing 0, so
/// its formation is decided by the flag alone.
function formationLabel(t: OwnedToken): "Black" | "Complete" | "Direct" | "Composed" {
  if (t.isBlack) return "Black";
  const units = t.backing / UNIT;
  if (units > 1n && t.originCount === units) return "Complete";
  if (t.originCount === 1n) return "Direct";
  return "Composed";
}

export function ChainApp({dep}: {dep: Deployment}) {
  const {address, isConnected} = useAccount();
  const publicClient = usePublicClient();
  const {writeContractAsync} = useWriteContract();

  const [busy, setBusy] = React.useState<string | null>(null);
  const [txErr, setTxErr] = React.useState<string | null>(null);
  const [amountWei, setAmountWei] = React.useState<bigint>(DENOMINATIONS[3].wei); // 1 ETH
  const [qty, setQty] = React.useState(1);
  const [tokens, setTokens] = React.useState<OwnedToken[]>([]);
  const [reserve, setReserve] = React.useState<Reserve | null>(null);
  const [acctBalance, setAcctBalance] = React.useState<bigint>(0n);
  const [feeBps, setFeeBps] = React.useState<bigint>(0n);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  // The fee is a percentage of backing, so it depends on the selected denomination.
  const feePerNft = (amountWei * feeBps) / 10_000n;

  const refresh = React.useCallback(async () => {
    if (!publicClient || !address) return;
    const shapes = {address: dep.shapes, abi: shapesAbi} as const;

    const [redeemableBacking, sacrificedBacking, blackCount, supply, minted, fee, balance, acct] =
      await Promise.all([
        publicClient.readContract({...shapes, functionName: "redeemableBacking"}),
        publicClient.readContract({...shapes, functionName: "sacrificedBacking"}),
        publicClient.readContract({...shapes, functionName: "blackCount"}),
        publicClient.readContract({...shapes, functionName: "totalSupply"}),
        publicClient.readContract({...shapes, functionName: "totalMinted"}),
        publicClient.readContract({...shapes, functionName: "feeBps"}),
        publicClient.getBalance({address: dep.shapes}),
        publicClient.getBalance({address}),
      ]);
    setReserve({redeemableBacking, sacrificedBacking, blackCount, balance, supply, minted});
    setFeeBps(fee);
    setAcctBalance(acct);

    // No enumerable extension; in a dev harness the id space is tiny, so scan it and keep the
    // live tokens this account owns. Burned ids revert on ownerOf and are skipped.
    const owned: OwnedToken[] = [];
    for (let id = 1n; id <= minted; id++) {
      let owner: string;
      try {
        owner = await publicClient.readContract({...shapes, functionName: "ownerOf", args: [id]});
      } catch {
        continue; // burned
      }
      if (owner.toLowerCase() !== address.toLowerCase()) continue;
      const [backing, originCount, complete, black, uri] = await Promise.all([
        publicClient.readContract({...shapes, functionName: "backingOf", args: [id]}),
        publicClient.readContract({...shapes, functionName: "originCountOf", args: [id]}),
        publicClient.readContract({...shapes, functionName: "isComplete", args: [id]}),
        publicClient.readContract({...shapes, functionName: "isBlack", args: [id]}),
        publicClient.readContract({...shapes, functionName: "tokenURI", args: [id]}),
      ]);
      owned.push({id, backing, originCount, complete, isBlack: black, image: imageFromTokenURI(uri)});
    }
    setTokens(owned);
    // Drop selections that no longer exist (burned by compose/decompose).
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
    }
  }, [isConnected, address, refresh]);

  const run = async (label: string, send: () => Promise<`0x${string}`>) => {
    if (!publicClient) return;
    setBusy(label);
    setTxErr(null);
    try {
      const hash = await send();
      await publicClient.waitForTransactionReceipt({hash});
      await refresh();
    } catch (e) {
      setTxErr(shortError(e));
    } finally {
      setBusy(null);
    }
  };

  // wagmi infers the connected account and asserts the chain id, so a wrong-network wallet gets
  // a clear error rather than a silently misrouted transaction.
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
        ? write("mint", [amountWei, address!], value)
        : write("mintBatch", [amountWei, BigInt(qty), address!], value);
    });

  const redeem = (id: bigint) => run(`redeem ${id}`, () => write("redeem", [id]));

  const redeemAll = () => {
    const ids = tokens.filter((t) => !t.isBlack).map((t) => t.id);
    return run("redeem all", () => write("redeemBatch", [ids]));
  };

  const toggleSelect = (id: bigint) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = id.toString();
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // Compose: the summed backing must land on a denomination. Survivor is the lowest selected id,
  // so it keeps that id. One atomic transaction — no approvals, the caller owns every input.
  const selectedTokens = tokens.filter((t) => selected.has(t.id.toString()) && !t.isBlack);
  const composeSum = selectedTokens.reduce((a, t) => a + t.backing, 0n);
  const composeValid = selectedTokens.length >= 2 && denomIndexOf(composeSum) >= 0;

  const compose = () => {
    const sorted = [...selectedTokens].sort((a, b) => (a.id < b.id ? -1 : 1));
    const survivor = sorted[0].id;
    const burnIds = sorted.slice(1).map((t) => t.id);
    return run("compose", () => write("compose", [survivor, burnIds]));
  };

  // Decompose one tier down: split a token into the largest number of next-lower-tier pieces.
  const decompose = (t: OwnedToken) => {
    const di = denomIndexOf(t.backing);
    if (di <= 0) return;
    const downWei = DENOMINATIONS[di - 1].wei;
    const ratio = Number(t.backing / downWei); // 2 or 5
    const outDenoms = Array<number>(ratio).fill(di - 1);
    return run(`split ${t.id}`, () => write("decompose", [t.id, outDenoms]));
  };

  const blacken = (id: bigint) => run(`blacken ${id}`, () => write("blacken", [id]));

  return (
    <div style={S.page}>
      <div style={{maxWidth: 1100, margin: "0 auto"}}>
        <header style={S.header}>
          <div>
            <h1 style={S.h1}>Shapes — chain tester</h1>
            <div style={S.dim}>deposit ETH, read the onchain artwork back, recompose, redeem. Local dev chain only.</div>
            <div style={{...S.mono, ...S.dim, fontSize: 12, marginTop: 6}}>
              shapes {addr(dep.shapes)} · chain {dep.chainId}
            </div>
          </div>
          <ConnectButton />
        </header>

        {!isConnected || !reserve ? (
          <Centered>
            {isConnected ? "Loading chain state…" : "Connect a wallet to mint and redeem."}
          </Centered>
        ) : (
          <>
            {/* Reserve invariant, live. */}
            <ReserveCard
              reserve={reserve}
              feeBps={feeBps}
              feePerNft={feePerNft}
              acctBalance={acctBalance}
            />

            {/* Mint controls. */}
            <section style={S.card}>
              <div style={{...S.dim, marginBottom: 8}}>denomination (ETH)</div>
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
              <div style={{display: "flex", alignItems: "center", gap: 12, marginTop: 14}}>
                <label style={S.dim}>
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
                <button onClick={mint} disabled={!!busy} style={S.primary}>
                  {busy === "mint"
                    ? "minting…"
                    : `mint  (send ${formatEther((amountWei + feePerNft) * BigInt(qty))} ETH)`}
                </button>
                {tokens.some((t) => !t.isBlack) && (
                  <button onClick={redeemAll} disabled={!!busy} style={S.secondary}>
                    {busy === "redeem all"
                      ? "redeeming…"
                      : `redeem all ${tokens.filter((t) => !t.isBlack).length}`}
                  </button>
                )}
              </div>
              {txErr && <div style={{...S.mono, color: "#f66", marginTop: 10}}>{txErr}</div>}
            </section>

            {/* Compose bar — appears once two or more shapes are selected. */}
            {selectedTokens.length >= 2 && (
              <section style={{...S.card, borderColor: composeValid ? "#4a7" : "#844"}}>
                <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12}}>
                  <div style={S.dim}>
                    {selectedTokens.length} selected · sum {formatEther(composeSum)} ETH{" "}
                    {composeValid
                      ? "→ composes into one shape"
                      : "→ not a denomination; adjust the selection"}
                  </div>
                  <div style={{display: "flex", gap: 8}}>
                    <button onClick={() => setSelected(new Set())} style={S.secondary}>
                      clear
                    </button>
                    <button onClick={compose} disabled={!!busy || !composeValid} style={S.primary}>
                      {busy === "compose" ? "composing…" : "compose selected"}
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* Owned tokens, each rendered from its onchain tokenURI. */}
            <div style={{...S.dim, margin: "6px 2px"}}>
              your shapes — artwork and provenance are read from the contract
            </div>
            {tokens.length === 0 ? (
              <Centered>none yet — mint one above</Centered>
            ) : (
              <div style={S.grid}>
                {tokens.map((t) => {
                  const di = denomIndexOf(t.backing);
                  const canSplit = !t.isBlack && di > 0;
                  const canBlacken = !t.isBlack && t.complete && t.backing === DENOMINATIONS[8].wei;
                  const isSel = selected.has(t.id.toString());
                  return (
                    <div
                      key={t.id.toString()}
                      style={{...S.token, ...(isSel ? S.tokenSel : null), ...(t.isBlack ? S.tokenBlack : null)}}
                    >
                      <img src={t.image} alt={`shape ${t.id}`} style={S.img} />
                      <div style={{...S.mono, fontSize: 12, marginTop: 8}}>
                        #{t.id.toString()} · {t.isBlack ? "sacrificed" : `${formatEther(t.backing)} ETH`}
                      </div>
                      <div style={{marginTop: 4}}>
                        <FormationBadge label={formationLabel(t)} />
                        <span style={{...S.dim, ...S.mono, fontSize: 11, marginLeft: 6}}>
                          {t.originCount.toString()} origin{t.originCount === 1n ? "" : "s"}
                        </span>
                      </div>

                      {!t.isBlack && (
                        <label style={{...S.dim, ...S.mono, fontSize: 11, display: "flex", alignItems: "center", gap: 6, marginTop: 8, justifyContent: "center"}}>
                          <input type="checkbox" checked={isSel} onChange={() => toggleSelect(t.id)} />
                          select to compose
                        </label>
                      )}

                      <div style={{display: "flex", gap: 6, marginTop: 8}}>
                        {!t.isBlack && (
                          <button onClick={() => redeem(t.id)} disabled={!!busy} style={S.smallBtn}>
                            {busy === `redeem ${t.id}` ? "…" : "redeem"}
                          </button>
                        )}
                        {canSplit && (
                          <button onClick={() => decompose(t)} disabled={!!busy} style={S.smallBtn}>
                            {busy === `split ${t.id}` ? "…" : `split →${DENOMINATIONS[di - 1].label}`}
                          </button>
                        )}
                      </div>
                      {canBlacken && (
                        <button onClick={() => blacken(t.id)} disabled={!!busy} style={S.blacken}>
                          {busy === `blacken ${t.id}` ? "sacrificing…" : "blacken (sacrifice 100 ETH)"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FormationBadge({label}: {label: "Black" | "Complete" | "Direct" | "Composed"}) {
  const color: Record<string, React.CSSProperties> = {
    Black: {background: "#fff", color: "#000", borderColor: "#fff"},
    Complete: {background: "#123", color: "#8cf", borderColor: "#2a5"},
    Composed: {background: "#111", color: "#cc9", borderColor: "#553"},
    Direct: {background: "#111", color: "#999", borderColor: "#333"},
  };
  return (
    <span style={{...S.badge, ...color[label]}}>
      {label}
    </span>
  );
}

function ReserveCard({
  reserve,
  feeBps,
  feePerNft,
  acctBalance,
}: {
  reserve: Reserve;
  feeBps: bigint;
  feePerNft: bigint;
  acctBalance: bigint;
}) {
  const solvent = reserve.balance >= reserve.redeemableBacking;
  const stray = reserve.balance - reserve.redeemableBacking;
  const feePct = Number(feeBps) / 100;
  return (
    <section style={{...S.card, borderColor: solvent ? "#1c5" : "#e33"}}>
      <Row k="contract balance" v={`${formatEther(reserve.balance)} ETH`} />
      <Row k="redeemableBacking()" v={`${formatEther(reserve.redeemableBacking)} ETH`} />
      <Row
        k="invariant  balance ≥ redeemable"
        v={solvent ? `OK  (+${stray} wei stray)` : "INSOLVENT"}
        danger={!solvent}
      />
      {reserve.blackCount > 0n && (
        <Row
          k="sacrificed (Black)"
          v={`${formatEther(reserve.sacrificedBacking)} ETH · ${reserve.blackCount} black`}
        />
      )}
      <Row k="live / minted" v={`${reserve.supply} / ${reserve.minted}`} />
      <Row k="mint fee" v={`${feePct}% · ${formatEther(feePerNft)} ETH for this denomination`} />
      <Row k="your balance" v={`${formatEther(acctBalance)} ETH`} />
    </section>
  );
}

function shortError(e: unknown): string {
  const a = e as {shortMessage?: string; message?: string};
  return a?.shortMessage || a?.message || String(e);
}

const addr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Row({k, v, danger}: {k: string; v: string; danger?: boolean}) {
  return (
    <div style={{display: "flex", justifyContent: "space-between", padding: "3px 0"}}>
      <span style={S.dim}>{k}</span>
      <span style={{...S.mono, color: danger ? "#f66" : "#ddd"}}>{v}</span>
    </div>
  );
}

function Centered({children}: {children: React.ReactNode}) {
  return <div style={{...S.dim, textAlign: "center", padding: "48px 0"}}>{children}</div>;
}

const S: Record<string, React.CSSProperties> = {
  page: {minHeight: "100vh", background: "#000", color: "#eee", padding: "40px 32px 120px"},
  header: {display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, gap: 16},
  h1: {fontSize: 20, margin: 0, fontWeight: 600},
  dim: {color: "#888", fontSize: 13},
  mono: {fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"},
  card: {border: "1px solid #333", borderRadius: 10, padding: 16, marginBottom: 16, background: "#0b0b0b"},
  chip: {background: "#111", color: "#ccc", border: "1px solid #333", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontFamily: "ui-monospace, monospace"},
  chipOn: {background: "#fff", color: "#000", borderColor: "#fff"},
  num: {width: 56, background: "#111", color: "#eee", border: "1px solid #333", borderRadius: 6, padding: "5px 8px"},
  primary: {background: "#fff", color: "#000", border: "none", borderRadius: 8, padding: "9px 16px", cursor: "pointer", fontWeight: 600},
  secondary: {background: "#111", color: "#ccc", border: "1px solid #444", borderRadius: 8, padding: "9px 16px", cursor: "pointer"},
  grid: {display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16},
  token: {border: "1px solid #222", borderRadius: 10, padding: 12, background: "#0b0b0b", textAlign: "center"},
  tokenSel: {borderColor: "#4a7", boxShadow: "0 0 0 1px #4a7 inset"},
  tokenBlack: {borderColor: "#666", background: "#050505"},
  badge: {display: "inline-block", fontFamily: "ui-monospace, monospace", fontSize: 11, padding: "2px 7px", borderRadius: 5, border: "1px solid #333"},
  img: {width: "100%", aspectRatio: "250 / 350", background: "#000", borderRadius: 4},
  smallBtn: {flex: 1, background: "#111", color: "#ccc", border: "1px solid #444", borderRadius: 6, padding: "6px 0", cursor: "pointer", fontSize: 12},
  blacken: {marginTop: 8, width: "100%", background: "#181818", color: "#fff", border: "1px solid #666", borderRadius: 6, padding: "7px 0", cursor: "pointer", fontSize: 12, fontWeight: 600},
};
