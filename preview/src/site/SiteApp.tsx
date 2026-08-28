import React from "react";
import {parseEventLogs} from "viem";
import {useAccount, useDisconnect, usePublicClient, useWriteContract} from "wagmi";
import {useConnectModal} from "@rainbow-me/rainbowkit";
import {shapesAbi, auctionHouseAbi, DENOMINATIONS, type Deployment} from "../chain/abi";
import {C, FONT} from "./theme";
import {short, addrUrl} from "./ui";
import {describeTxError} from "./errors";
import {loadSite, type SiteData, type SiteToken} from "./data";
import {mintRequest} from "./mint";
import {MintView} from "./MintView";
import {GalleryView} from "./GalleryView";
import {TokenView} from "./TokenView";
import {AboutView} from "./AboutView";
import {AuctionView} from "./AuctionView";
import {loadAuction, loadLotImage, type AuctionSlot} from "./auction";

export type View = "mint" | "auction" | "gallery" | "token" | "about";

export interface MintState {
  status: "idle" | "pending" | "done" | "failed";
  minted?: {tokens: {id: bigint; seed: bigint}[]; di: number; tx: string};
  error?: string;
}

export interface RedeemState {
  status: "idle" | "asking" | "pending" | "done" | "failed";
  tx?: string;
  error?: string;
  snap?: {id: bigint; seed: bigint; di: number; inkGene: number};
}

export function SiteApp({
  dep,
  initialView,
  initialTokenId,
  onNavigate,
}: {
  dep: Deployment;
  /** Starting view, and a callback fired when the view changes, so a host (the Next.js site) can
   *  drive real URLs. Omitted by the Vite preview, which navigates purely in local state. */
  initialView?: View;
  initialTokenId?: bigint | null;
  onNavigate?: (view: View, tokenId: bigint | null) => void;
}) {
  const {address, isConnected} = useAccount();
  const {disconnect} = useDisconnect();
  const {openConnectModal} = useConnectModal();
  const publicClient = usePublicClient({chainId: dep.chainId});
  const {writeContractAsync} = useWriteContract();

  const [view, setView] = React.useState<View>(initialView ?? "mint");
  const [tokenId, setTokenId] = React.useState<bigint | null>(initialTokenId ?? null);
  const [data, setData] = React.useState<SiteData | null>(null);
  const [sel, setSel] = React.useState(0); // smallest denomination
  const [qty, setQty] = React.useState(1);
  const [filter, setFilter] = React.useState(-1);
  const [mint, setMint] = React.useState<MintState>({status: "idle"});
  const [redeem, setRedeem] = React.useState<RedeemState>({status: "idle"});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [txErr, setTxErr] = React.useState<{op: string; text: string} | null>(null);
  const [auction, setAuction] = React.useState<AuctionSlot>("loading");
  const [lotImage, setLotImage] = React.useState<string | null>(null);
  const [txHash, setTxHash] = React.useState<string | null>(null);

  // URL <-> view sync for the Next.js host. `lastNav` tracks the last applied navigation so a
  // URL-driven change does not echo back out through `onNavigate`, and an internal navigation does
  // not get re-applied from a stale prop.
  const navKey = (v: View, id: bigint | null) => `${v}:${id ?? ""}`;
  const lastNav = React.useRef(navKey(view, tokenId));
  React.useEffect(() => {
    if (initialView === undefined) return;
    const target = navKey(initialView, initialTokenId ?? null);
    if (target !== navKey(view, tokenId)) {
      lastNav.current = target;
      setView(initialView);
      setTokenId(initialTokenId ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialView, initialTokenId]);
  React.useEffect(() => {
    const cur = navKey(view, tokenId);
    if (cur !== lastNav.current) {
      lastNav.current = cur;
      onNavigate?.(view, tokenId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, tokenId]);

  const refresh = React.useCallback(async () => {
    if (!publicClient) return;
    // A failed load (dead RPC, contract not yet deployed on a dev chain) keeps the current
    // data and the loading state instead of surfacing an unhandled rejection.
    try {
      setData(await loadSite(publicClient, dep));
    } catch {
      /* leave data as-is; the user can reload once the chain answers */
    }
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

  const writeHouse = (
    functionName: string,
    args: readonly unknown[],
    value?: bigint,
    gas?: bigint,
  ) =>
    writeContractAsync({
      address: dep.auctionHouse!,
      abi: auctionHouseAbi,
      functionName,
      args,
      value,
      gas,
      chainId: dep.chainId,
    } as Parameters<typeof writeContractAsync>[0]);

  const doMint = async () => {
    if (!address || !publicClient || !data) return;
    setMint({status: "pending"});
    try {
      const wei = DENOMINATIONS[sel].wei;
      const req = mintRequest(dep, {amountWei: wei, quantity: qty, fee: data.fees[sel]});
      const hash = await writeContractAsync(req as unknown as Parameters<typeof writeContractAsync>[0]);
      const receipt = await publicClient.waitForTransactionReceipt({hash});
      const logs = parseEventLogs({abi: shapesAbi, eventName: "ShapeMinted", logs: receipt.logs});
      await refresh();
      setMint({
        status: "done",
        minted: {
          tokens: logs.map((l) => ({id: l.args.tokenId, seed: BigInt(l.args.seed)})),
          di: sel,
          tx: hash,
        },
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
      setRedeem({status: "done", tx: hash, snap: {id: t.id, seed: t.seed, di: t.di, inkGene: t.inkGene}});
    } catch (e) {
      setRedeem({status: "failed", error: describeTxError(e)});
    }
  };

  const doSplit = async (t: SiteToken) => {
    if (!publicClient) return;
    setBusy("split");
    setTxErr(null);
    try {
      const downWei = DENOMINATIONS[t.di - 1].wei;
      const ratio = Number(t.backing / downWei);
      const hash = await write("split", [t.id, Array<number>(ratio).fill(t.di - 1)]);
      await publicClient.waitForTransactionReceipt({hash});
      await refresh();
      setView("gallery"); // the input is burned; its children are newest in the gallery
    } catch (e) {
      setTxErr({op: "split", text: describeTxError(e)});
    } finally {
      setBusy(null);
    }
  };

  // Reverse a survivor's most recent still-standing compose: it keeps its id and reverts to its
  // pre-compose state, and every burned input is re-minted under its original id and seed.
  const doDecompose = async (t: SiteToken) => {
    if (!publicClient) return;
    setBusy("decompose");
    setTxErr(null);
    try {
      const hash = await write("decompose", [t.id]);
      await publicClient.waitForTransactionReceipt({hash});
      await refresh(); // the survivor keeps its id; its detail shows the reverted state
    } catch (e) {
      setTxErr({op: "decompose", text: describeTxError(e)});
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
      setTxErr({op: "compose", text: describeTxError(e)});
    } finally {
      setBusy(null);
    }
  };


  // Auction 0 is the collection's own. Reloaded after every auction transaction, and whenever
  // the wallet changes, since escrow and the lead are both per-address. A deployment with no
  // auction house has no auction to load, ever, so it resolves to null immediately rather than
  // sitting in "loading" forever; otherwise the slot stays "loading" until the first read lands.
  const refreshAuction = React.useCallback(async () => {
    if (!dep.auctionHouse) {
      setAuction(null);
      setLotImage(null);
      return;
    }
    if (!publicClient) return;
    // A failed read (dead RPC, mid-redeploy chain, malformed response) degrades to the empty
    // state instead of surfacing an unhandled rejection.
    let a: Awaited<ReturnType<typeof loadAuction>> = null;
    try {
      a = await loadAuction(publicClient, dep, 0n, address);
    } catch {
      a = null;
    }
    setAuction(a);
    setLotImage(a ? await loadLotImage(publicClient, dep, a) : null);
  }, [publicClient, dep, address]);

  React.useEffect(() => {
    void refreshAuction();
  }, [refreshAuction]);

  const runHouse = async (op: string, fn: string, args: readonly unknown[], value?: bigint) => {
    if (!publicClient || !dep.auctionHouse) return;
    setBusy(op);
    setTxErr(null);
    try {
      // A bid that mints its own cards lands exactly on the edge where the estimate is too tight
      // and the mint's reentrancy guard runs out of gas re-executing (ReentrancySentryOOG).
      // Estimate, then buffer; the block gas limit still caps it.
      const estimate = await publicClient.estimateContractGas({
        address: dep.auctionHouse,
        abi: auctionHouseAbi,
        functionName: fn,
        args,
        value,
        account: address!,
      } as Parameters<typeof publicClient.estimateContractGas>[0]);
      const hash = await writeHouse(fn, args, value, (estimate * 3n) / 2n);
      await publicClient.waitForTransactionReceipt({hash});
      setTxHash(hash);
      await Promise.all([refresh(), refreshAuction()]);
    } catch (e) {
      setTxErr({op, text: describeTxError(e)});
    } finally {
      setBusy(null);
    }
  };

  const doBid = (cardIds: bigint[], ethBackingWei: bigint) => {
    const sorted = [...cardIds].sort((a, b) => (a < b ? -1 : 1));
    // The mint fee rides on top of the backing, and only on the ETH portion.
    void runHouse("bid", "bid", [0n, sorted, ethBackingWei], ethBackingWei + ethBackingWei / 100n);
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
            {dep.auctionHouse && (
              <button type="button" className="btn-ghost" onClick={() => go("auction")} style={{letterSpacing: "0.14em", color: navColor("auction")}}>
                AUCTION
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={() => go("gallery")} style={{letterSpacing: "0.14em", color: navColor("gallery")}}>
              GALLERY
            </button>
            <button type="button" className="btn-ghost" onClick={() => go("about")} style={{letterSpacing: "0.14em", color: navColor("about")}}>
              HOW IT WORKS
            </button>
            {/* /play is a Next.js route outside SiteApp's view state, so it links as a plain
                anchor. Only the Next host serves it; the Vite preview (no onNavigate) omits it. */}
            {onNavigate && (
              <a href="/play" style={{letterSpacing: "0.14em", color: C.muted, textDecoration: "none"}}>
                PLAYGROUND
              </a>
            )}
          </nav>
          <div style={{marginLeft: "auto", display: "flex", alignItems: "center", gap: 18}}>
            {isConnected && address && (
              <span style={{color: C.muted, letterSpacing: "0.1em"}}>{short(address)}</span>
            )}
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
      {view === "auction" && (
        <AuctionView
          auction={auction}
          lotImage={lotImage}
          data={data}
          dep={dep}
          publicClient={publicClient}
          address={address}
          busy={busy}
          txErr={txErr}
          txHash={txHash}
          onBid={doBid}
          onWithdraw={() => void runHouse("withdraw", "withdraw", [0n])}
          onSettle={() => void runHouse("settle", "settle", [0n])}
          onClaim={() => void runHouse("claim", "claimProceeds", [0n])}
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
          onSplit={(t) => void doSplit(t)}
          onDecompose={(t) => void doDecompose(t)}
          onCompose={(t, ids) => void doCompose(t, ids)}
          onOpenToken={openToken}
        />
      )}
      {view === "about" && <AboutView dep={dep} data={data} />}

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
          <span style={{marginLeft: "auto", display: "flex", gap: 20}}>
            <a href={addrUrl(dep.shapes, dep.chainId)} target="_blank" rel="noreferrer" style={{fontSize: 11}}>
              Contract
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
