import React from "react";
import {formatEther} from "viem";
import {useAccount, usePublicClient, useWriteContract} from "wagmi";
import {ConnectButton} from "@rainbow-me/rainbowkit";
import {shapesAbi, DENOMINATIONS, type Deployment} from "./abi";

interface OwnedToken {
  id: bigint;
  backing: bigint;
  image: string; // svg data URI decoded from tokenURI
}

interface Reserve {
  totalBacking: bigint;
  balance: bigint;
  supply: bigint;
  minted: bigint;
}

/// Decode a Shapes tokenURI (data:application/json;base64,...) to its inline SVG image URI.
function imageFromTokenURI(uri: string): string {
  const json = JSON.parse(atob(uri.replace("data:application/json;base64,", "")));
  return json.image as string;
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
  const [mintFee, setMintFee] = React.useState<bigint>(0n);

  const refresh = React.useCallback(async () => {
    if (!publicClient || !address) return;
    const shapes = {address: dep.shapes, abi: shapesAbi} as const;

    const [totalBacking, supply, minted, fee, balance, acct] = await Promise.all([
      publicClient.readContract({...shapes, functionName: "totalBacking"}),
      publicClient.readContract({...shapes, functionName: "totalSupply"}),
      publicClient.readContract({...shapes, functionName: "totalMinted"}),
      publicClient.readContract({...shapes, functionName: "mintFee"}),
      publicClient.getBalance({address: dep.shapes}),
      publicClient.getBalance({address}),
    ]);
    setReserve({totalBacking, balance, supply, minted});
    setMintFee(fee);
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
      const [backing, uri] = await Promise.all([
        publicClient.readContract({...shapes, functionName: "backingOf", args: [id]}),
        publicClient.readContract({...shapes, functionName: "tokenURI", args: [id]}),
      ]);
      owned.push({id, backing, image: imageFromTokenURI(uri)});
    }
    setTokens(owned);
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
      const value = (amountWei + mintFee) * BigInt(qty);
      return qty === 1
        ? write("mint", [amountWei, address!], value)
        : write("mintBatch", [amountWei, BigInt(qty), address!], value);
    });

  const redeem = (id: bigint) => run(`redeem ${id}`, () => write("redeem", [id]));

  const redeemAll = () => run("redeem all", () => write("redeemBatch", [tokens.map((t) => t.id)]));

  return (
    <div style={S.page}>
      <div style={{maxWidth: 1100, margin: "0 auto"}}>
        <header style={S.header}>
          <div>
            <h1 style={S.h1}>Shapes — chain tester</h1>
            <div style={S.dim}>deposit ETH, read the onchain artwork back, redeem it. Dev fork only.</div>
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
            <ReserveCard reserve={reserve} mintFee={mintFee} acctBalance={acctBalance} />

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
                    : `mint  (send ${formatEther((amountWei + mintFee) * BigInt(qty))} ETH)`}
                </button>
                {tokens.length > 0 && (
                  <button onClick={redeemAll} disabled={!!busy} style={S.secondary}>
                    {busy === "redeem all" ? "redeeming…" : `redeem all ${tokens.length}`}
                  </button>
                )}
              </div>
              {txErr && <div style={{...S.mono, color: "#f66", marginTop: 10}}>{txErr}</div>}
            </section>

            {/* Owned tokens, each rendered from its onchain tokenURI. */}
            <div style={{...S.dim, margin: "6px 2px"}}>
              your shapes — artwork is fetched from the contract, not the local renderer
            </div>
            {tokens.length === 0 ? (
              <Centered>none yet — mint one above</Centered>
            ) : (
              <div style={S.grid}>
                {tokens.map((t) => (
                  <div key={t.id.toString()} style={S.token}>
                    <img src={t.image} alt={`shape ${t.id}`} style={S.img} />
                    <div style={{...S.mono, fontSize: 12, marginTop: 8}}>
                      #{t.id.toString()} · {formatEther(t.backing)} ETH
                    </div>
                    <button onClick={() => redeem(t.id)} disabled={!!busy} style={S.redeem}>
                      {busy === `redeem ${t.id}` ? "…" : "redeem"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ReserveCard({
  reserve,
  mintFee,
  acctBalance,
}: {
  reserve: Reserve;
  mintFee: bigint;
  acctBalance: bigint;
}) {
  const solvent = reserve.balance >= reserve.totalBacking;
  const stray = reserve.balance - reserve.totalBacking;
  return (
    <section style={{...S.card, borderColor: solvent ? "#1c5" : "#e33"}}>
      <Row k="contract balance" v={`${formatEther(reserve.balance)} ETH`} />
      <Row k="totalBacking()" v={`${formatEther(reserve.totalBacking)} ETH`} />
      <Row
        k="invariant  balance ≥ backing"
        v={solvent ? `OK  (+${stray} wei stray)` : "INSOLVENT"}
        danger={!solvent}
      />
      <Row k="live / minted" v={`${reserve.supply} / ${reserve.minted}`} />
      <Row k="mint fee" v={`${formatEther(mintFee)} ETH`} />
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
  grid: {display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 16},
  token: {border: "1px solid #222", borderRadius: 10, padding: 12, background: "#0b0b0b", textAlign: "center"},
  img: {width: "100%", aspectRatio: "250 / 350", background: "#000", borderRadius: 4},
  redeem: {marginTop: 8, width: "100%", background: "#111", color: "#ccc", border: "1px solid #444", borderRadius: 6, padding: "6px 0", cursor: "pointer"},
};
