import React from "react";
import {useQueryClient} from "@tanstack/react-query";
import {formatEther, parseEventLogs} from "viem";
import {useAccount, useDisconnect, usePublicClient, useSwitchChain, useWriteContract} from "wagmi";
import {useConnectModal} from "@rainbow-me/rainbowkit";
import {shapesAbi, auctionHouseAbi, DENOMINATIONS, type Deployment} from "../chain/abi";
import {C, FONT} from "./theme";
import {PreviewBoundary, txUrl, type PendingTx} from "./ui";
import {describeTxError} from "./errors";
import {loadMintFees, loadSite, loadSiteHeader, loadSiteToken, seedFee, type SiteData, type SiteHeaderData, type SiteToken} from "./data";
import {logRequestCounts} from "./indexerClient";
import {rpcRequestCounter} from "../chain/rpc";
import {mintRequest} from "./mint";
import {awaitSuccessfulReceipt, bufferGas} from "./tx";
import {clearStoredActionNotice, storeActionNotice, takeStoredActionNotice, type ActionNotice} from "./actionNotice";
import {MintPanel} from "./MintPanel";
import {useMintDraft} from "./MintDraft";
import type {DirectTokenState} from "./TokenView";
import type {ComposeDraft} from "./ComposeWorkspace";
import type {AuctionSlot, AuctionState} from "./auction";
import {useDisplayName} from "./useDisplayName";
import {SiteFooter} from "./SiteFooter";
import {SiteHeader} from "./SiteHeader";

// Only the current view loads its panel; the home mint panel stays in the initial bundle.
const viewLoaders = {
  mint: () => import("./MintView").then(m => ({default: m.MintView})),
  gallery: () => import("./GalleryView").then(m => ({default: m.GalleryView})),
  collection: () => import("./MyShapesView").then(m => ({default: m.MyShapesView})),
  token: () => import("./TokenView").then(m => ({default: m.TokenView})),
  manage: () => import("./ManageShapeView").then(m => ({default: m.ManageShapeView})),
  auction: () => import("./AuctionView").then(m => ({default: m.AuctionView})),
  packs: () => import("./PacksView").then(m => ({default: m.PacksView})),
  pack: () => import("./PackDetailView").then(m => ({default: m.PackDetailView})),
  fwa: () => import("./FwaView").then(m => ({default: m.FwaView})),
  contracts: () => import("./ContractsView"),
};
const MintView = React.lazy(viewLoaders.mint);
const GalleryView = React.lazy(viewLoaders.gallery);
const MyShapesView = React.lazy(viewLoaders.collection);
const TokenView = React.lazy(viewLoaders.token);
const ManageShapeView = React.lazy(viewLoaders.manage);
const AuctionView = React.lazy(viewLoaders.auction);
const PacksView = React.lazy(viewLoaders.packs);
const PackDetailView = React.lazy(viewLoaders.pack);
const FwaView = React.lazy(viewLoaders.fwa);
const ContractsView = React.lazy(viewLoaders.contracts);
const ComposeWorkspace = React.lazy(() => import("./ComposeWorkspace").then(m => ({default: m.ComposeWorkspace})));

function preloadView(view: View) {
  // Hover/focus is advisory; rendering owns any import error.
  if (view !== "home") void viewLoaders[view]().catch(() => {});
}

export type View =
  | "home"
  | "mint"
  | "auction"
  | "gallery"
  | "collection"
  | "token"
  | "manage"
  | "contracts"
  | "packs"
  | "pack"
  | "fwa";

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
  renderHome,
}: {
  dep: Deployment;
  /** Starting view, and a callback fired when the view changes, so a host (the Next.js site) can
   *  drive real URLs. Omitted by the Vite preview, which navigates purely in local state. */
  initialView?: View;
  initialTokenId?: bigint | null;
  onNavigate?: (view: View, tokenId: bigint | null) => void;
  /** When the view is "home", renders the mint panel and footer inside the host's own page shell
   *  (the landing page) instead of SiteApp's header/footer/mint view. Without it, "home" falls
   *  back to the mint view. The fourth argument is the header read (null until it
   *  resolves), for a host that needs a loaded total such as supply or reserve. */
  renderHome?: (
    mint: React.ReactNode,
    footer: React.ReactNode,
    header: React.ReactNode,
    data: SiteHeaderData | null,
  ) => React.ReactNode;
}) {
  const {address, isConnected, chainId: walletChainId} = useAccount();
  const {switchChainAsync} = useSwitchChain();
  const wrongChain = isConnected && walletChainId !== dep.chainId;
  // Every write goes through the deployment chain. A wallet on another chain is asked to switch
  // (wagmi adds the chain to the wallet when it is unknown) before the transaction is built,
  // instead of failing with a chain mismatch.
  const ensureChain = async () => {
    if (walletChainId !== dep.chainId) await switchChainAsync({chainId: dep.chainId});
  };
  const {disconnect} = useDisconnect();
  const {openConnectModal} = useConnectModal();
  const publicClient = usePublicClient({chainId: dep.chainId});
  const queryClient = useQueryClient();
  const {writeContractAsync} = useWriteContract();

  const siteQueryKey = React.useMemo(
    () => ["site", dep.chainId, dep.shapes.toLowerCase(), dep.fromBlock ?? 0] as const,
    [dep.chainId, dep.shapes, dep.fromBlock],
  );
  const headerQueryKey = React.useMemo(
    () => ["site-header", dep.chainId, dep.shapes.toLowerCase()] as const,
    [dep.chainId, dep.shapes],
  );

  const [view, setView] = React.useState<View>(initialView ?? "mint");
  const [tokenId, setTokenId] = React.useState<bigint | null>(initialTokenId ?? null);
  const [data, setData] = React.useState<SiteData | null>(() =>
    queryClient.getQueryData<SiteData>(siteQueryKey) ?? null,
  );
  const [siteHeader, setSiteHeader] = React.useState<SiteHeaderData | null>(() =>
    queryClient.getQueryData<SiteHeaderData>(headerQueryKey) ?? null,
  );
  const [directTokenResult, setDirectTokenResult] = React.useState<{
    id: bigint; chainId: number; shapes: string; state: DirectTokenState; updatedAt: number;
  } | null>(null);
  const mintDraft = useMintDraft();
  const {sel, setSel, qty, setQty} = mintDraft;
  const [filter, setFilter] = React.useState(-1);
  const [ownerOnly, setOwnerOnly] = React.useState(false);
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
  const [pendingTx, setPendingTx] = React.useState<PendingTx | null>(null);
  const [txErr, setTxErr] = React.useState<{op: string; text: string} | null>(null);
  const [auction, setAuction] = React.useState<AuctionSlot>("loading");
  const [lotImage, setLotImage] = React.useState<string | null>(null);
  const [txHash, setTxHash] = React.useState<string | null>(null);
  // A route change right after a write remounts SiteApp (the Next host's catch-all segment), so
  // the notice a previous mount just set would otherwise vanish before it could be read. The
  // lazy initializer picks up whatever the mount before this one stored.
  const [actionNotice, setActionNoticeState] = React.useState<ActionNotice | null>(() =>
    takeStoredActionNotice(),
  );
  const setActionNotice = (notice: ActionNotice | null) => {
    setActionNoticeState(notice);
    if (notice) storeActionNotice(notice);
    else clearStoredActionNotice();
  };
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);
  const accountMenuRef = React.useRef<HTMLDivElement>(null);
  const accountLabel = useDisplayName(address);

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

  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshFailed, setRefreshFailed] = React.useState(false);
  // Latest `data`/dirty-ids for `refresh`'s async body, kept outside React state so `refresh`
  // itself never needs `data` as a dependency (which would recreate it, and the mount effect
  // below, on every successful load).
  const dataRef = React.useRef<SiteData | null>(null);
  dataRef.current = data;
  const lastDirtyIds = React.useRef<readonly bigint[]>([]);

  React.useEffect(() => {
    setData(queryClient.getQueryData<SiteData>(siteQueryKey) ?? null);
    setSiteHeader(queryClient.getQueryData<SiteHeaderData>(headerQueryKey) ?? null);
  }, [queryClient, siteQueryKey, headerQueryKey]);

  const refreshHeader = React.useCallback(async () => {
    if (!publicClient) return;
    setRefreshing(true);
    try {
      const head = await queryClient.fetchQuery({
        queryKey: headerQueryKey,
        queryFn: () => loadSiteHeader(publicClient, dep),
        staleTime: 15_000,
      });
      setSiteHeader(head);
      setRefreshFailed(false);
    } catch {
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, [publicClient, dep, queryClient, headerQueryKey]);

  const refresh = React.useCallback(async (dirtyIds?: readonly bigint[]) => {
    if (!publicClient) return;
    if (dirtyIds) lastDirtyIds.current = dirtyIds;
    const force = dirtyIds !== undefined || lastDirtyIds.current.length > 0;
    const cached = queryClient.getQueryState<SiteData>(siteQueryKey);
    if (!force && cached?.data && !cached.isInvalidated &&
        Date.now() - cached.dataUpdatedAt < 15_000) {
      setData(cached.data);
      return;
    }
    setRefreshing(true);
    try {
      // Incremental against the previous snapshot on the chain fallback: only ids new since the
      // last scan, or a live id whose owner changed, or one the caller just acted on
      // (`lastDirtyIds`) get reread. See loadSiteFromChain in data.ts.
      const load = () => loadSite(publicClient, dep, {
        previous: queryClient.getQueryData<SiteData>(siteQueryKey) ?? null,
        dirtyIds: lastDirtyIds.current,
        onMetrics: (metrics) => logRequestCounts(metrics.source, rpcRequestCounter()),
      });
      let site: SiteData;
      if (force) {
        // A write must not join an older navigation read that lacks its dirty token ids.
        if (queryClient.getQueryState(siteQueryKey)?.fetchStatus === "fetching") {
          await queryClient.invalidateQueries({queryKey: siteQueryKey, exact: true, refetchType: "none"});
          try {
            await queryClient.fetchQuery({queryKey: siteQueryKey, queryFn: load, staleTime: 0});
          } catch {
            // The pre-write navigation read may fail; the post-write read still needs to run.
          }
        }
        site = await load();
        queryClient.setQueryData(siteQueryKey, site);
      } else {
        site = await queryClient.fetchQuery({queryKey: siteQueryKey, queryFn: load, staleTime: 15_000});
      }
      setData(site);
      const {tokens: _tokens, ...head} = site;
      queryClient.setQueryData(headerQueryKey, head);
      setSiteHeader(head);
      setRefreshFailed(false);
      lastDirtyIds.current = [];
    } catch {
      if (force) {
        void queryClient.invalidateQueries({queryKey: siteQueryKey, exact: true, refetchType: "none"});
      }
      // Leave data as-is; the header surfaces the failure with a retry action.
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, [publicClient, dep, queryClient, siteQueryKey, headerQueryKey]);

  React.useEffect(() => {
    if (view === "home" || view === "mint") void refreshHeader();
    else if (view === "auction" || view === "gallery" || view === "collection" ||
             view === "token" || view === "manage" || view === "packs") void refresh();
  }, [refresh, refreshHeader, view]);

  // A direct Shape URL can show its card before the collection-wide snapshot finishes.
  React.useEffect(() => {
    if (view !== "token" || tokenId === null || !publicClient) return;
    if (dataRef.current?.tokens.some((token) => token.id === tokenId)) return;
    let cancelled = false;
    const currentId = tokenId;
    const setCurrent = (state: DirectTokenState) => {
      if (!cancelled) setDirectTokenResult({id: currentId, chainId: dep.chainId, shapes: dep.shapes, state, updatedAt: Date.now()});
    };
    setCurrent({kind: "loading"});
    void loadSiteToken(publicClient, dep, currentId)
      .then((token) => setCurrent(token ? {kind: "live", token} : {kind: "absent"}))
      .catch(() => setCurrent({kind: "error"}));
    return () => { cancelled = true; };
  }, [view, tokenId, publicClient, dep]);

  const directToken = directTokenResult?.id === tokenId &&
    directTokenResult.chainId === dep.chainId && directTokenResult.shapes === dep.shapes
    ? data === null || directTokenResult.updatedAt >= (queryClient.getQueryState(siteQueryKey)?.dataUpdatedAt ?? 0)
      ? directTokenResult.state : undefined
    : {kind: "loading"} as const;

  const mintHeader = siteHeader ?? data;
  const mintData = mintHeader ?? mintDraft.bootstrap;

  // `op` is the same string passed to `setBusy` for this action; the returned hash is recorded
  // as `pendingTx` as soon as the wallet hands it back, so a view can tell "confirm in wallet"
  // (no hash yet) apart from "pending" (hash in hand, waiting for the receipt).
  // Every write is sent with an explicit gas limit: the reentrancy guard re-executes under the
  // 63/64 rule, so leaving gas to the wallet's own estimate under-funds that re-execution often
  // enough to matter (most visibly on mintBatch). Estimated with the connected account, then
  // buffered by `bufferGas`, the same margin auction bids already used.
  const estimateGas = async (
    contractAddress: `0x${string}`,
    abi: typeof shapesAbi | typeof auctionHouseAbi,
    functionName: string,
    args: readonly unknown[],
    value?: bigint,
  ) => {
    if (!publicClient || !address) return undefined;
    const estimate = await publicClient.estimateContractGas({
      address: contractAddress,
      abi,
      functionName,
      args,
      value,
      account: address,
    } as Parameters<typeof publicClient.estimateContractGas>[0]);
    return bufferGas(estimate);
  };

  const write = async (op: string, functionName: string, args: readonly unknown[], value?: bigint) => {
    await ensureChain();
    const gas = await estimateGas(dep.shapes, shapesAbi, functionName, args, value);
    const hash = await writeContractAsync({
      address: dep.shapes,
      abi: shapesAbi,
      functionName,
      args,
      value,
      gas,
      chainId: dep.chainId,
    } as Parameters<typeof writeContractAsync>[0]);
    setPendingTx({op, hash});
    return hash;
  };

  const writeHouse = async (op: string, functionName: string, args: readonly unknown[], value?: bigint) => {
    await ensureChain();
    const gas = await estimateGas(dep.auctionHouse!, auctionHouseAbi, functionName, args, value);
    const hash = await writeContractAsync({
      address: dep.auctionHouse!,
      abi: auctionHouseAbi,
      functionName,
      args,
      value,
      gas,
      chainId: dep.chainId,
    } as Parameters<typeof writeContractAsync>[0]);
    setPendingTx({op, hash});
    return hash;
  };

  const doMint = async () => {
    if (!address || !publicClient) return;
    setMint({status: "pending"});
    try {
      const liveFees = await loadMintFees(publicClient, dep);
      const quotedFee = seedFee(dep, mintData, sel);
      if (quotedFee === null || liveFees[sel] !== quotedFee) {
        await queryClient.invalidateQueries({queryKey: headerQueryKey, exact: true, refetchType: "none"});
        await refreshHeader();
        throw new Error("The mint fee changed. Review the updated amount and mint again.");
      }
      const wei = DENOMINATIONS[sel].wei;
      const req = mintRequest(dep, {amountWei: wei, quantity: qty, fee: liveFees[sel]});
      const gas = await estimateGas(req.address, req.abi, req.functionName, req.args, req.value);
      const hash = await writeContractAsync({...req, gas} as unknown as Parameters<typeof writeContractAsync>[0]);
      const receipt = await awaitSuccessfulReceipt(publicClient, hash, req);
      const logs = parseEventLogs({abi: shapesAbi, eventName: "ShapeMinted", logs: receipt.logs});
      await refresh(logs.map((l) => l.args.tokenId));
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
      const hash = await write("redeem", "redeem", [t.id]);
      await awaitSuccessfulReceipt(publicClient, hash, {address: dep.shapes, abi: shapesAbi, functionName: "redeem", args: [t.id]});
      await refresh([t.id]);
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
      setPendingTx(null);
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
      const args = [t.id, Array<number>(ratio).fill(t.di - 1)];
      const hash = await write("split", "split", args);
      const receipt = await awaitSuccessfulReceipt(publicClient, hash, {address: dep.shapes, abi: shapesAbi, functionName: "split", args});
      const logs = parseEventLogs({abi: shapesAbi, eventName: "Split", logs: receipt.logs});
      const newIds = logs[0]?.args.newIds ?? [];
      await refresh([t.id, ...newIds]);
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
      setPendingTx(null);
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
      const hash = await write("decompose", "decompose", [t.id]);
      const receipt = await awaitSuccessfulReceipt(publicClient, hash, {address: dep.shapes, abi: shapesAbi, functionName: "decompose", args: [t.id]});
      const logs = parseEventLogs({abi: shapesAbi, eventName: "Decomposed", logs: receipt.logs});
      const restoredIds = logs[0]?.args.restoredIds ?? [];
      // dirty: the survivor keeps its id but its state reverted, which a same-owner ownerOf
      // read alone can't reveal.
      await refresh([t.id, ...restoredIds]);
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
      setPendingTx(null);
    }
  };

  const doCompose = async (t: SiteToken, burnIds: bigint[]) => {
    if (!publicClient) return;
    setBusy("compose");
    setTxErr(null);
    setActionNotice(null);
    try {
      const sorted = [...burnIds].sort((a, b) => (a < b ? -1 : 1));
      const hash = await write("compose", "compose", [t.id, sorted]);
      await awaitSuccessfulReceipt(publicClient, hash, {address: dep.shapes, abi: shapesAbi, functionName: "compose", args: [t.id, sorted]});
      // dirty: the survivor keeps its id but grew, which a same-owner ownerOf read alone can't
      // reveal.
      await refresh([t.id, ...sorted]);
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
      setPendingTx(null);
    }
  };

  const doBurnBacking = async (t: SiteToken) => {
    if (!publicClient) return;
    setBusy("burnBacking");
    setTxErr(null);
    setActionNotice(null);
    try {
      const hash = await write("burnBacking", "burnBacking", [t.id]);
      await awaitSuccessfulReceipt(publicClient, hash, {address: dep.shapes, abi: shapesAbi, functionName: "burnBacking", args: [t.id]});
      // dirty: backing goes to zero under the same owner, which ownerOf alone can't reveal.
      await refresh([t.id]);
      setActionNotice({
        title: `Shape #${t.id.toString()} is now Black`,
        detail: "Its ETH backing is permanently unspendable.",
        hash,
        tokenIds: [t.id],
      });
      setView("token");
      window.scrollTo({top: 0, behavior: "smooth"});
    } catch (e) {
      setTxErr({op: "burnBacking", text: describeTxError(e)});
    } finally {
      setBusy(null);
      setPendingTx(null);
    }
  };


  // Token 0 is the collection owner token; its auction is looked up by token id rather than an
  // assumed auction id, since other auctions may exist before it. Reloaded after every auction
  // transaction, and whenever the wallet changes, since escrow and the lead are both per-address.
  // A deployment with no auction house has no auction to load, ever, so it resolves to null
  // immediately rather than sitting in "loading" forever; otherwise the slot stays "loading"
  // until the first read lands.
  const refreshAuction = React.useCallback(async () => {
    if (!dep.auctionHouse) {
      setAuction(null);
      setLotImage(null);
      return;
    }
    if (!publicClient) return;
    // A failed read (dead RPC, mid-redeploy chain, malformed response) degrades to the empty
    // state instead of surfacing an unhandled rejection.
    let a: AuctionState | null = null;
    let auctionReads: typeof import("./auction");
    try {
      auctionReads = await import("./auction");
      a = await auctionReads.loadAuctionFor(publicClient, dep, 0n, address);
    } catch {
      setAuction("error");
      setLotImage(null);
      return;
    }
    setAuction(a);
    // The lot is held in escrow and so is still live: its artwork is already in the loaded site
    // data. Only a lot the gallery has not supplied costs a tokenURI read.
    const loaded = a ? dataRef.current?.tokens.find((t) => t.id === a.tokenId) : undefined;
    setLotImage(a ? (loaded?.image ?? (await auctionReads.loadLotImage(publicClient, dep, a))) : null);
  }, [publicClient, dep, address]);

  React.useEffect(() => {
    if (view === "auction") void refreshAuction();
  }, [refreshAuction, view]);

  const runHouse = async (op: string, fn: string, args: readonly unknown[], value?: bigint) => {
    if (!publicClient || !dep.auctionHouse) return;
    setBusy(op);
    setTxErr(null);
    try {
      if (fn === "bid" && value !== undefined) {
        const liveFees = await loadMintFees(publicClient, dep);
        const {breakdown} = await import("./auction");
        const items = breakdown(value);
        const quotedFee = items.reduce((sum, item) => sum + BigInt(item.count) * (data?.fees[item.di] ?? 0n), 0n);
        const liveFee = items.reduce((sum, item) => sum + BigInt(item.count) * liveFees[item.di], 0n);
        if (data === null || liveFee !== quotedFee) {
          await queryClient.invalidateQueries({queryKey: siteQueryKey, exact: true, refetchType: "none"});
          await refresh();
          throw new Error("The mint fee changed. Review the updated bid amount and bid again.");
        }
        value += liveFee;
      }
      // A bid that mints its own cards lands exactly on the edge where the estimate is too tight
      // and the mint's reentrancy guard runs out of gas re-executing (ReentrancySentryOOG).
      // `writeHouse` estimates and buffers gas itself; the block gas limit still caps it.
      const hash = await writeHouse(op, fn, args, value);
      const receipt = await awaitSuccessfulReceipt(publicClient, hash, {address: dep.auctionHouse, abi: auctionHouseAbi, functionName: fn, args, value});
      setTxHash(hash);
      const changedIds = parseEventLogs({abi: shapesAbi, eventName: "Transfer", logs: receipt.logs})
        .filter((log) => log.address.toLowerCase() === dep.shapes.toLowerCase())
        .map((log) => log.args.tokenId);
      await Promise.all([refresh(changedIds), refreshAuction()]);
    } catch (e) {
      setTxErr({op, text: describeTxError(e)});
    } finally {
      setBusy(null);
      setPendingTx(null);
    }
  };

  // The house call targets the auction the page loaded for token 0, never a fixed id: on a
  // chain with earlier auctions the owner token's auction is not id 0.
  const auctionId = typeof auction === "object" && auction !== null ? auction.id : null;

  const doBid = (cardIds: bigint[], ethBackingWei: bigint) => {
    if (auctionId === null) return;
    const sorted = [...cardIds].sort((a, b) => (a < b ? -1 : 1));
    void runHouse("bid", "bid", [auctionId, sorted, ethBackingWei], ethBackingWei);
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

  // Without a host to render into, "home" has no shell of its own and falls back to the mint
  // view, so the header nav and the mint view's own render check both treat it as "mint".
  const shownView = view === "home" && !renderHome ? "mint" : view;

  // `active` is null on the home view, where no nav item corresponds to the page.
  const header = (active: View | null) => (
    <SiteHeader
      active={active}
      go={go}
      onIntent={preloadView}
      routed={onNavigate !== undefined}
      isConnected={isConnected}
      wrongChain={wrongChain}
      accountLabel={accountLabel}
      accountMenuOpen={accountMenuOpen}
      setAccountMenuOpen={setAccountMenuOpen}
      accountMenuRef={accountMenuRef}
      onConnect={() => openConnectModal?.()}
      onSwitchChain={() => void ensureChain()}
      onDisconnect={disconnect}
      refreshing={refreshing}
      refreshFailed={refreshFailed}
      onRetryRefresh={() => void (view === "home" || view === "mint" ? refreshHeader() : refresh())}
    />
  );

  const reserveLine = mintHeader
    ? `The contract holds ${formatEther(mintHeader.reserve)} ETH backing ${mintHeader.supply.toString()} Shapes.`
    : null;

  // The home view hosts the mint panel inside the host's own landing page shell, with no action
  // toast; the panel's own status text carries mint feedback, the footer still carries the
  // reserve line and attribution, and the host places the shared header itself.
  if (view === "home" && renderHome) {
    return renderHome(
      <MintPanel
        data={mintData}
        dep={dep}
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
        onConnect={() => openConnectModal?.()}
      />,
      <SiteFooter reserve={reserveLine} onContracts={() => go("contracts")} />,
      header(null),
      mintHeader,
    );
  }

  return (
    <div id="top" style={{minHeight: "100vh", background: C.page, color: C.ink, fontFamily: FONT}}>
      {header(shownView)}

      <PreviewBoundary resetKey={`${shownView}:${tokenId}:${composeMode}`} fallback={
        <div role="alert" style={{padding: 48, minHeight: 240, fontSize: 13, color: C.muted}}>
          <p>This page couldn’t load.</p>
          <button type="button" className="site-connect-btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      }>
      <React.Suspense fallback={
        <div role="status" style={{padding: 48, minHeight: 240, fontSize: 13, color: C.muted}}>Loading…</div>
      }>
      {shownView === "mint" && (
        <MintView
          data={mintData}
          dep={dep}
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
          onConnect={() => openConnectModal?.()}
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
          pendingTx={pendingTx}
          txErr={txErr}
          txHash={txHash}
          onBid={doBid}
          onWithdraw={() => { if (auctionId !== null) void runHouse("withdraw", "withdraw", [auctionId]); }}
          onRetry={() => { setAuction("loading"); void refreshAuction(); }}
          onSettle={() => { if (auctionId !== null) void runHouse("settle", "settle", [auctionId]); }}
          onClaim={() => { if (auctionId !== null) void runHouse("claim", "claimProceeds", [auctionId]); }}
          onClaimLot={() => { if (auctionId !== null) void runHouse("claimLot", "claimLot", [auctionId]); }}
          onOpenToken={openToken}
        />
      )}

      {view === "gallery" && (
        <GalleryView
          data={data}
          filter={filter}
          setFilter={setFilter}
          address={address}
          ownerOnly={ownerOnly}
          setOwnerOnly={setOwnerOnly}
          onOpenToken={openToken}
        />
      )}
      {view === "contracts" && <ContractsView dep={dep} />}
      {view === "fwa" && <FwaView dep={dep} onConnect={() => openConnectModal?.()} />}
      {view === "packs" && (
        <PacksView
          dep={dep}
          data={data}
          onConnect={() => openConnectModal?.()}
          onShapesChanged={refresh}
          onOpenPack={(id) => { setTokenId(id); go("pack"); }}
          onOpenShape={openToken}
        />
      )}
      {view === "pack" && tokenId !== null && <PackDetailView
        dep={dep}
        packId={tokenId}
        onBack={() => go("packs")}
        onOpenPack={(id) => { setTokenId(id); go("pack"); }}
        onOpenShape={openToken}
      />}
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
          pendingTx={pendingTx}
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
          directToken={directToken}
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
          pendingTx={pendingTx}
          txErr={txErr}
          onBack={() => go("token")}
          onStartCompose={(id) => startCompose(id)}
          onSplit={(t) => void doSplit(t)}
          onDecompose={(t) => void doDecompose(t)}
          onRedeem={(t) => void confirmRedeem(t)}
          onBurnBacking={(t) => void doBurnBacking(t)}
        />
      )}

      </React.Suspense>
      </PreviewBoundary>

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
            boxShadow: "0 8px 28px rgba(0, 0, 0, 0.08)",
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

      <SiteFooter topRule reserve={reserveLine} onContracts={() => go("contracts")} />
    </div>
  );
}
