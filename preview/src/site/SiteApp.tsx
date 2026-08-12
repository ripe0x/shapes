import React from "react";
import {parseEventLogs} from "viem";
import {useAccount, useDisconnect, usePublicClient, useWriteContract} from "wagmi";
import {useConnectModal} from "@rainbow-me/rainbowkit";
import {shapesAbi, DENOMINATIONS, type Deployment} from "../chain/abi";
import {C, FONT} from "./theme";
import {short} from "./ui";
import {describeTxError} from "./errors";
import {loadSite, type SiteData, type SiteToken} from "./data";
import {MintView} from "./MintView";
import {GalleryView} from "./GalleryView";
import {TokenView} from "./TokenView";
import {AboutView} from "./AboutView";

type View = "mint" | "gallery" | "token" | "about";

export interface MintState {
  status: "idle" | "pending" | "done" | "failed";
  minted?: {id: bigint; seed: bigint; di: number; tx: string};
  error?: string;
}

export interface RedeemState {
  status: "idle" | "asking" | "pending" | "done" | "failed";
  tx?: string;
  error?: string;
  snap?: {id: bigint; seed: bigint; di: number};
}

export function SiteApp({dep}: {dep: Deployment}) {
  const {address, isConnected} = useAccount();
  const {disconnect} = useDisconnect();
  const {openConnectModal} = useConnectModal();
  const publicClient = usePublicClient();
  const {writeContractAsync} = useWriteContract();

  const [view, setView] = React.useState<View>("mint");
  const [tokenId, setTokenId] = React.useState<bigint | null>(null);
  const [data, setData] = React.useState<SiteData | null>(null);
  const [sel, setSel] = React.useState(4); // 1 ETH
  const [qty, setQty] = React.useState(1);
  const [filter, setFilter] = React.useState(-1);
  const [mint, setMint] = React.useState<MintState>({status: "idle"});
  const [redeem, setRedeem] = React.useState<RedeemState>({status: "idle"});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [txErr, setTxErr] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!publicClient) return;
    setData(await loadSite(publicClient, dep));
  }, [publicClient, dep]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const write = (functionName: string, args: readonly unknown[], value?: bigint) =>
    writeContractAsync({
      address: dep.shapes,
      abi: shapesAbi,
      functionName,
      args,
      value,
      chainId: dep.chainId,
    } as Parameters<typeof writeContractAsync>[0]);

  const doMint = async () => {
    if (!address || !publicClient || !data) return;
    setMint({status: "pending"});
    try {
      const wei = DENOMINATIONS[sel].wei;
      const value = (wei + data.fees[sel]) * BigInt(qty);
      const hash =
        qty === 1
          ? await write("mint", [wei, address], value)
          : await write("mintBatch", [wei, BigInt(qty), address], value);
      const receipt = await publicClient.waitForTransactionReceipt({hash});
      const logs = parseEventLogs({abi: shapesAbi, eventName: "ShapeMinted", logs: receipt.logs});
      const first = logs[0];
      await refresh();
      setMint({
        status: "done",
        minted: {id: first.args.tokenId, seed: BigInt(first.args.seed), di: sel, tx: hash},
      });
    } catch (e) {
      setMint({status: "failed", error: describeTxError(e)});
    }
  };

  const confirmRedeem = async (t: SiteToken) => {
    if (!publicClient) return;
    setRedeem({status: "pending"});
    try {
      const hash = await write("redeem", [t.id]);
      await publicClient.waitForTransactionReceipt({hash});
      await refresh();
      setRedeem({status: "done", tx: hash, snap: {id: t.id, seed: t.seed, di: t.di}});
    } catch (e) {
      setRedeem({status: "failed", error: describeTxError(e)});
    }
  };

  const doDecompose = async (t: SiteToken) => {
    if (!publicClient) return;
    setBusy("decompose");
    setTxErr(null);
    try {
      const downWei = DENOMINATIONS[t.di - 1].wei;
      const ratio = Number(t.backing / downWei);
      const hash = await write("decompose", [t.id, Array<number>(ratio).fill(t.di - 1)]);
      await publicClient.waitForTransactionReceipt({hash});
      await refresh();
      setView("gallery"); // the input is burned; its children are newest in the gallery
    } catch (e) {
      setTxErr(describeTxError(e));
    } finally {
      setBusy(null);
    }
  };

  const doCompose = async (t: SiteToken, burnIds: bigint[]) => {
    if (!publicClient) return;
    setBusy("compose");
    setTxErr(null);
    try {
      const sorted = [...burnIds].sort((a, b) => (a < b ? -1 : 1));
      const hash = await write("compose", [t.id, sorted]);
      await publicClient.waitForTransactionReceipt({hash});
      await refresh(); // the survivor keeps its id; the open detail shows the new denomination
    } catch (e) {
      setTxErr(describeTxError(e));
    } finally {
      setBusy(null);
    }
  };

  const openToken = (id: bigint) => {
    setTokenId(id);
    setRedeem({status: "idle"});
    setTxErr(null);
    setView("token");
  };

  const go = (v: View) => {
    setTxErr(null);
    setView(v);
  };

  const navColor = (v: View) => (view === v ? C.ink : C.muted);

  return (
    <div style={{minHeight: "100vh", background: C.page, color: C.ink, fontFamily: FONT}}>
      <header
        style={{
          borderBottom: `1px solid ${C.rule}`,
          position: "sticky",
          top: 0,
          background: C.page,
          zIndex: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 32,
            padding: "0 48px",
            height: 54,
            fontSize: 11,
            letterSpacing: "0.14em",
          }}
        >
          <div>SHAPES</div>
          <nav style={{display: "flex", gap: 26}}>
            <button type="button" className="btn-ghost" onClick={() => go("mint")} style={{letterSpacing: "0.14em", color: navColor("mint")}}>
              MINT
            </button>
            <button type="button" className="btn-ghost" onClick={() => go("gallery")} style={{letterSpacing: "0.14em", color: navColor("gallery")}}>
              GALLERY
            </button>
            <button type="button" className="btn-ghost" onClick={() => go("about")} style={{letterSpacing: "0.14em", color: navColor("about")}}>
              HOW IT WORKS
            </button>
          </nav>
          <div style={{marginLeft: "auto", display: "flex", alignItems: "center", gap: 18}}>
            <span style={{color: C.muted, letterSpacing: "0.1em"}}>
              {isConnected && address ? short(address) : "NO WALLET CONNECTED"}
            </span>
            <button
              type="button"
              className="btn-outline"
              onClick={() => (isConnected ? disconnect() : openConnectModal?.())}
              style={{padding: "6px 13px", fontSize: 11, letterSpacing: "0.1em"}}
            >
              {isConnected ? "DISCONNECT" : "CONNECT"}
            </button>
          </div>
        </div>
      </header>

      {view === "mint" && (
        <MintView
          data={data}
          chainId={dep.chainId}
          connected={isConnected}
          sel={sel}
          setSel={(i) => {
            setSel(i);
            if (mint.status === "failed") setMint({status: "idle"});
          }}
          qty={qty}
          setQty={setQty}
          mint={mint}
          onMint={() => void doMint()}
          onOpenToken={openToken}
        />
      )}
      {view === "gallery" && (
        <GalleryView data={data} filter={filter} setFilter={setFilter} onOpenToken={openToken} />
      )}
      {view === "token" && tokenId !== null && (
        <TokenView
          data={data}
          dep={dep}
          publicClient={publicClient}
          address={address}
          tokenId={tokenId}
          redeem={redeem}
          busy={busy}
          txErr={txErr}
          onBack={() => go("gallery")}
          onAskRedeem={() => setRedeem({status: "asking"})}
          onCancelRedeem={() => setRedeem({status: "idle"})}
          onConfirmRedeem={(t) => void confirmRedeem(t)}
          onDecompose={(t) => void doDecompose(t)}
          onCompose={(t, ids) => void doCompose(t, ids)}
        />
      )}
      {view === "about" && <AboutView data={data} />}

      <footer style={{borderTop: `1px solid ${C.rule}`}}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px 32px",
            padding: "24px 48px",
            fontSize: 11,
            color: C.muted,
          }}
        >
          <span style={{letterSpacing: "0.14em"}}>SHAPES</span>
          <span>Wrapping ETH in a Shape is not an investment and earns nothing.</span>
          <span style={{marginLeft: "auto"}}>
            <a href="https://github.com/ripe0x/shapes" target="_blank" rel="noreferrer" style={{fontSize: 11}}>
              Source
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
