import React from "react";
import {parseEventLogs} from "viem";
import {useAccount, useDisconnect, usePublicClient, useWriteContract} from "wagmi";
import {useConnectModal} from "@rainbow-me/rainbowkit";
import {shapesAbi, auctionHouseAbi, DENOMINATIONS, type Deployment} from "../chain/abi";
import {C, FONT} from "./theme";
import {addrUrl, txUrl} from "./ui";
import {describeTxError} from "./errors";
import {loadSite, type SiteData, type SiteToken} from "./data";
import {mintRequest} from "./mint";
import {MintView} from "./MintView";
import {GalleryView} from "./GalleryView";
import {MyShapesView} from "./MyShapesView";
import {TokenView} from "./TokenView";
import {ManageShapeView} from "./ManageShapeView";
import {ComposeWorkspace, type ComposeDraft} from "./ComposeWorkspace";
import {AboutView} from "./AboutView";
import {AuctionView} from "./AuctionView";
import {loadAuction, loadLotImage, type AuctionSlot} from "./auction";
import {useEnsDisplay} from "./ens";

export type View = "mint" | "auction" | "gallery" | "collection" | "token" | "manage" | "about";

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
  const [tokenBackView, setTokenBackView] = React.useState<"gallery" | "collection">("gallery");
  const [composeMode, setComposeMode] = React.useState(false);
  const [composeDraft, setComposeDraft] = React.useState<ComposeDraft>({
    session: 0,
    selectedIds: [],
    survivorId: null,
    phase: "select",
    backView: "collection",
  });
  const [mint, setMint] = React.useState<MintState>({status: "idle"});
  const [redeem, setRedeem] = React.useState<RedeemState>({status: "idle"});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [txErr, setTxErr] = React.useState<{op: string; text: string} | null>(null);
  const [auction, setAuction] = React.useState<AuctionSlot>("loading");
  const [lotImage, setLotImage] = React.useState<string | null>(null);
  const [txHash, setTxHash] = React.useState<string | null>(null);
  const [actionNotice, setActionNotice] = React.useState<{
    title: string;
    detail: string;
    hash: string;
    tokenIds: bigint[];
  } | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);
  const accountMenuRef = React.useRef<HTMLDivElement>(null);
  const accountLabel = useEnsDisplay(publicClient, address);

  React.useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [accountMenuOpen]);

  React.useEffect(() => {
    if (!isConnected) setAccountMenuOpen(false);
  }, [isConnected]);

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
    setBusy("redeem");
    setTxErr(null);
    setActionNotice(null);
    setRedeem({status: "pending"});
    try {
      const hash = await write("redeem", [t.id]);
      await publicClient.waitForTransactionReceipt({hash});
      await refresh();
      setRedeem({status: "done", tx: hash, snap: {id: t.id, seed: t.seed, di: t.di, inkGene: t.inkGene}});
      setActionNotice({
        title: `Shape #${t.id.toString()} redeemed`,
        detail: `${DENOMINATIONS[t.di].label} ETH was returned to its owner.`,
        hash,
        tokenIds: [],
      });
      setView("token");
      window.scrollTo({top: 0, behavior: "smooth"});
    } catch (e) {
      const text = describeTxError(e);
      setRedeem({status: "failed", error: text});
      setTxErr({op: "redeem", text});
    } finally {
      setBusy(null);
    }
  };

  const doSplit = async (t: SiteToken) => {
    if (!publicClient) return;
    setBusy("split");
    setTxErr(null);
    setActionNotice(null);
    try {
      const downWei = DENOMINATIONS[t.di - 1].wei;
      const ratio = Number(t.backing / downWei);
      const hash = await write("split", [t.id, Array<number>(ratio).fill(t.di - 1)]);
      const receipt = await publicClient.waitForTransactionReceipt({hash});
      const logs = parseEventLogs({abi: shapesAbi, eventName: "Split", logs: receipt.logs});
      const newIds = logs[0]?.args.newIds ?? [];
      await refresh();
      setView("gallery"); // the input is burned; its children are newest in the gallery
      setActionNotice({
        title: `Shape #${t.id.toString()} split`,
        detail: `${newIds.length} new Shape${newIds.length === 1 ? " was" : "s were"} created.`,
        hash,
        tokenIds: [...newIds],
      });
      window.scrollTo({top: 0, behavior: "smooth"});
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
    setActionNotice(null);
    try {
      const hash = await write("decompose", [t.id]);
      const receipt = await publicClient.waitForTransactionReceipt({hash});
      const logs = parseEventLogs({abi: shapesAbi, eventName: "Decomposed", logs: receipt.logs});
      const restoredIds = logs[0]?.args.restoredIds ?? [];
      await refresh(); // the survivor keeps its id; its detail shows the reverted state
      setActionNotice({
        title: `Shape #${t.id.toString()} restored`,
        detail: `${restoredIds.length} absorbed Shape${restoredIds.length === 1 ? "" : "s"} returned with original IDs.`,
        hash,
        tokenIds: [t.id, ...restoredIds],
      });
      setView("token");
      window.scrollTo({top: 0, behavior: "smooth"});
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
    setActionNotice(null);
    try {
      const sorted = [...burnIds].sort((a, b) => (a < b ? -1 : 1));
      const hash = await write("compose", [t.id, sorted]);
      await publicClient.waitForTransactionReceipt({hash});
      await refresh(); // the survivor keeps its id; the open detail shows the new denomination
      setActionNotice({
        title: `Shape #${t.id.toString()} grew`,
        detail: `${burnIds.length} Shape${burnIds.length === 1 ? " was" : "s were"} absorbed.`,
        hash,
        tokenIds: [t.id],
      });
      setTokenId(t.id);
      setTokenBackView("collection");
      setComposeMode(false);
      setView("token");
      window.scrollTo({top: 0, behavior: "smooth"});
    } catch (e) {
      setTxErr({op: "compose", text: describeTxError(e)});
    } finally {
      setBusy(null);
    }
  };

  const doSacrifice = async (t: SiteToken) => {
    if (!publicClient) return;
    setBusy("sacrifice");
    setTxErr(null);
    setActionNotice(null);
    try {
      const hash = await write("sacrifice", [t.id]);
      await publicClient.waitForTransactionReceipt({hash});
      await refresh();
      setActionNotice({
        title: `Shape #${t.id.toString()} is now Black`,
        detail: "Its ETH backing is permanently unspendable.",
        hash,
        tokenIds: [t.id],
      });
      setView("token");
      window.scrollTo({top: 0, behavior: "smooth"});
    } catch (e) {
      setTxErr({op: "sacrifice", text: describeTxError(e)});
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
    if (view === "gallery" || view === "collection") setTokenBackView(view);
    setTokenId(id);
    setRedeem({status: "idle"});
    setTxErr(null);
    setView("token");
  };

  const go = (v: View) => {
    setTxErr(null);
    setView(v);
  };

  const startCompose = (survivorId?: bigint) => {
    setComposeDraft((previous) => ({
      session: previous.session + 1,
      selectedIds: survivorId === undefined ? [] : [survivorId],
      survivorId: survivorId ?? null,
      phase: "select",
      backView: survivorId === undefined ? "collection" : "manage",
    }));
    setComposeMode(true);
    setTxErr(null);
    setView("collection");
    window.scrollTo({top: 0, behavior: "smooth"});
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
          className="site-header-inner"
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
          <nav className="site-nav" style={{display: "flex", gap: 26}}>
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
          <div className="site-account" ref={accountMenuRef} style={{marginLeft: "auto", position: "relative"}}>
            <button
              type="button"
              className="btn-outline"
              aria-haspopup={isConnected ? "menu" : undefined}
              aria-expanded={isConnected ? accountMenuOpen : undefined}
              onClick={() =>
                isConnected ? setAccountMenuOpen((open) => !open) : openConnectModal?.()
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                maxWidth: 220,
                padding: "6px 13px",
                fontSize: 11,
                letterSpacing: "0.1em",
              }}
            >
              <span style={{overflow: "hidden", textOverflow: "ellipsis"}}>
                {isConnected ? accountLabel : "CONNECT"}
              </span>
              {isConnected && <span aria-hidden="true" style={{color: C.muted}}>▾</span>}
            </button>
            {isConnected && accountMenuOpen && (
              <div
                role="menu"
                aria-label="Wallet account"
                style={{
                  position: "absolute",
                  top: "calc(100% + 8px)",
                  right: 0,
                  minWidth: 180,
                  border: `1px solid ${C.border}`,
                  background: C.page,
                  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
                  zIndex: 30,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="account-menu-item"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    go("collection");
                  }}
                >
                  MY SHAPES
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="account-menu-item"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    disconnect();
                  }}
                >
                  DISCONNECT
                </button>
              </div>
            )}
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
      {view === "collection" && !composeMode && (
        <MyShapesView
          data={data}
          address={address}
          connected={isConnected}
          onConnect={() => openConnectModal?.()}
          onOpenToken={openToken}
          onCompose={() => startCompose()}
        />
      )}
      {view === "collection" && composeMode && (
        <ComposeWorkspace
          key={composeDraft.session}
          draft={composeDraft}
          data={data}
          dep={dep}
          publicClient={publicClient}
          address={address}
          busy={busy}
          txErr={txErr}
          onChange={setComposeDraft}
          onCancel={() => setComposeMode(false)}
          onOpenToken={openToken}
          onSubmit={(survivor, burnIds) => void doCompose(survivor, burnIds)}
        />
      )}
      {view === "token" && tokenId !== null && (
        <TokenView
          data={data}
          dep={dep}
          publicClient={publicClient}
          address={address}
          tokenId={tokenId}
          redeem={redeem}
          backLabel={tokenBackView === "collection" ? "MY SHAPES" : "GALLERY"}
          onBack={() => go(tokenBackView)}
          onManage={() => go("manage")}
          onOpenToken={openToken}
        />
      )}
      {view === "manage" && tokenId !== null && (
        <ManageShapeView
          data={data}
          dep={dep}
          publicClient={publicClient}
          address={address}
          tokenId={tokenId}
          busy={busy}
          txErr={txErr}
          onBack={() => go("token")}
          onStartCompose={(id) => startCompose(id)}
          onSplit={(t) => void doSplit(t)}
          onDecompose={(t) => void doDecompose(t)}
          onRedeem={(t) => void confirmRedeem(t)}
          onSacrifice={(t) => void doSacrifice(t)}
        />
      )}
      {view === "about" && <AboutView dep={dep} data={data} />}

      {actionNotice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            zIndex: 20,
            left: "50%",
            bottom: 20,
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 18,
            width: "max-content",
            maxWidth: "calc(100vw - 32px)",
            padding: "12px 14px 12px 18px",
            border: `1px solid ${C.ink}`,
            background: C.page,
            boxShadow: "0 8px 28px rgba(0, 0, 0, 0.18)",
            fontSize: 12,
          }}
        >
          <div style={{minWidth: 0}}>
            <div style={{color: C.ink}}>{actionNotice.title}</div>
            <div style={{marginTop: 3, color: C.muted, fontSize: 10}}>{actionNotice.detail}</div>
          </div>
          {actionNotice.tokenIds.slice(0, 3).map((id) => (
            <button
              type="button"
              key={id.toString()}
              className="btn-ghost"
              onClick={() => openToken(id)}
              style={{whiteSpace: "nowrap", color: C.ink, textDecoration: "underline"}}
            >
              Shape #{id.toString()}
            </button>
          ))}
          {actionNotice.tokenIds.length > 3 && (
            <span style={{whiteSpace: "nowrap", color: C.muted}}>
              +{actionNotice.tokenIds.length - 3} more
            </span>
          )}
          <a
            href={txUrl(actionNotice.hash, dep.chainId)}
            target="_blank"
            rel="noreferrer"
            style={{whiteSpace: "nowrap", textDecoration: "underline"}}
          >
            View transaction
          </a>
          <button
            type="button"
            aria-label="Dismiss transaction confirmation"
            onClick={() => setActionNotice(null)}
            style={{padding: "2px 4px", color: C.muted, fontSize: 16, lineHeight: 1}}
          >
            ×
          </button>
        </div>
      )}

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
