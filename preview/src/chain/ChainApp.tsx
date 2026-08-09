import React from "react";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseEther,
  formatEther,
  defineChain,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {shapesAbi, DENOMINATIONS, type Deployment} from "./abi";

// A fixed, arbitrary test-only key — never used off a local dev chain. It signs every mint and
// redeem here so the harness needs no wallet extension. On a mainnet fork this address may
// inherit an EIP-7702 delegation (many mainnet EOAs now carry one), which would make ERC721
// `_safeMint` run a receiver check and revert. Startup strips that code and funds the account.
const DEV_PK = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;
const account = privateKeyToAccount(DEV_PK);

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

export function ChainApp() {
  const [dep, setDep] = React.useState<Deployment | null>(null);
  const [loadErr, setLoadErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [txErr, setTxErr] = React.useState<string | null>(null);
  const [amountWei, setAmountWei] = React.useState<bigint>(DENOMINATIONS[3].wei); // 1 ETH
  const [qty, setQty] = React.useState(1);
  const [tokens, setTokens] = React.useState<OwnedToken[]>([]);
  const [reserve, setReserve] = React.useState<Reserve | null>(null);
  const [acctBalance, setAcctBalance] = React.useState<bigint>(0n);
  const [mintFee, setMintFee] = React.useState<bigint>(0n);

  const clients = React.useRef<{pub: PublicClient; wallet: WalletClient; chain: Chain} | null>(
    null,
  );

  React.useEffect(() => {
    fetch("/deployment.json", {cache: "no-store"})
      .then((r) => {
        if (!r.ok) throw new Error("no deployment.json");
        return r.json();
      })
      .then(async (d: Deployment) => {
        const chain = defineChain({
          id: d.chainId,
          name: "shapes-dev",
          nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
          rpcUrls: {default: {http: [d.rpc]}},
        });
        clients.current = {
          pub: createPublicClient({chain, transport: http(d.rpc)}),
          wallet: createWalletClient({account, chain, transport: http(d.rpc)}),
          chain,
        };
        // Make the operating account a clean, funded EOA: strip any inherited 7702 delegation
        // so `_safeMint` treats it as an EOA, and top it up so gas and backing are covered.
        const test = createTestClient({chain, mode: "anvil", transport: http(d.rpc)});
        await test.setCode({address: account.address, bytecode: "0x"});
        await test.setBalance({address: account.address, value: parseEther("100000")});
        setDep(d);
      })
      .catch(() =>
        setLoadErr(
          "No deployment found. Run ./script/fork-dev.sh from the repo root, then reload.",
        ),
      );
  }, []);

  const refresh = React.useCallback(async () => {
    if (!dep || !clients.current) return;
    const {pub} = clients.current;
    const shapes = {address: dep.shapes, abi: shapesAbi} as const;

    const [totalBacking, supply, minted, fee, balance, acct] = await Promise.all([
      pub.readContract({...shapes, functionName: "totalBacking"}),
      pub.readContract({...shapes, functionName: "totalSupply"}),
      pub.readContract({...shapes, functionName: "totalMinted"}),
      pub.readContract({...shapes, functionName: "mintFee"}),
      pub.getBalance({address: dep.shapes}),
      pub.getBalance({address: account.address}),
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
        owner = await pub.readContract({...shapes, functionName: "ownerOf", args: [id]});
      } catch {
        continue; // burned
      }
      if (owner.toLowerCase() !== account.address.toLowerCase()) continue;
      const [backing, uri] = await Promise.all([
        pub.readContract({...shapes, functionName: "backingOf", args: [id]}),
        pub.readContract({...shapes, functionName: "tokenURI", args: [id]}),
      ]);
      owned.push({id, backing, image: imageFromTokenURI(uri)});
    }
    setTokens(owned);
  }, [dep]);

  React.useEffect(() => {
    if (dep) void refresh();
  }, [dep, refresh]);

  const run = async (label: string, fn: () => Promise<`0x${string}`>) => {
    if (!clients.current) return;
    setBusy(label);
    setTxErr(null);
    try {
      const hash = await fn();
      await clients.current.pub.waitForTransactionReceipt({hash});
      await refresh();
    } catch (e) {
      setTxErr(shortError(e));
    } finally {
      setBusy(null);
    }
  };

  const mint = () =>
    run("mint", async () => {
      const {wallet, chain} = clients.current!;
      const value = (amountWei + mintFee) * BigInt(qty);
      if (qty === 1) {
        return wallet.writeContract({
          address: dep!.shapes,
          abi: shapesAbi,
          functionName: "mint",
          args: [amountWei, account.address],
          value,
          chain,
          account,
        });
      }
      return wallet.writeContract({
        address: dep!.shapes,
        abi: shapesAbi,
        functionName: "mintBatch",
        args: [amountWei, BigInt(qty), account.address],
        value,
        chain,
        account,
      });
    });

  const redeem = (id: bigint) =>
    run(`redeem ${id}`, () => {
      const {wallet, chain} = clients.current!;
      return wallet.writeContract({
        address: dep!.shapes,
        abi: shapesAbi,
        functionName: "redeem",
        args: [id],
        chain,
        account,
      });
    });

  const redeemAll = () =>
    run("redeem all", () => {
      const {wallet, chain} = clients.current!;
      return wallet.writeContract({
        address: dep!.shapes,
        abi: shapesAbi,
        functionName: "redeemBatch",
        args: [tokens.map((t) => t.id)],
        chain,
        account,
      });
    });

  if (loadErr) return <Centered>{loadErr}</Centered>;
  if (!dep || !reserve) return <Centered>Connecting to dev chain…</Centered>;

  const solvent = reserve.balance >= reserve.totalBacking;
  const stray = reserve.balance - reserve.totalBacking;

  return (
    <div style={S.page}>
      <div style={{maxWidth: 1100, margin: "0 auto"}}>
        <header style={S.header}>
          <div>
            <h1 style={S.h1}>Shapes — chain tester</h1>
            <div style={S.dim}>
              deposit ETH, read the onchain artwork back, redeem it. Dev fork only.
            </div>
          </div>
          <div style={{textAlign: "right", ...S.mono, fontSize: 12}}>
            <div>shapes {addr(dep.shapes)}</div>
            <div style={S.dim}>renderer {addr(dep.renderer)}</div>
            <div style={S.dim}>chain {dep.chainId}</div>
          </div>
        </header>

        {/* Reserve invariant, live. */}
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
              {busy === "mint" ? "minting…" : `mint  (send ${formatEther((amountWei + mintFee) * BigInt(qty))} ETH)`}
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
      </div>
    </div>
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
  header: {display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20},
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
