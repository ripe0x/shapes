import React from "react";
import {formatEther, type Hash} from "viem";
import {useAccount, useSwitchChain, useWriteContract} from "wagmi";
import {Art, Section, txUrl} from "./ui";
import {localArt, sampleSeed} from "./art";
import {mintGene} from "../previewGene";
import {describeTxError} from "./errors";
import {awaitSuccessfulReceipt, bufferGas} from "./tx";
import {PACK_PREVIEW_CANVAS, PACK_PREVIEW_MAX_CARDS, packPreviewSlot} from "./packPreviewLayout";
import type {Deployment} from "../chain/abi";
import type {SiteData} from "./data";
import {
  PACKS_DEPLOYMENTS, creationMeetsMinimum, loadOwnedPacks, mintCountsValid, packPaymentBalanceError, packsAbi,
  packsClientFor, packsDeploymentFor, packsGasBudget, packsShapesAbi,
  type MintQuote, type OwnedPack,
} from "./packs";

type Settings = {minimum: bigint; denominations: bigint[]; mintFee: bigint; totalMinted: bigint; previewCardLimit: bigint};
type Status = {kind: "idle" | "working" | "done" | "error"; message: string; hash?: Hash};
const idle: Status = {kind: "idle", message: ""};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const eth = (value: bigint) => `${formatEther(value)} ETH`;
const step = (value: number, delta: number, min: number, max: number) =>
  Math.min(max, Math.max(min, (Number.isFinite(value) ? Math.trunc(value) : min) + delta));
const packSampleArtwork = (nonce: bigint, di: number, epoch: number, serial: number, amount: bigint) => {
  const n = (nonce << 64n) | (BigInt(di) << 56n) | (BigInt(epoch) << 16n) | BigInt(serial);
  const seed = sampleSeed(n);
  return localArt(seed, amount, mintGene(seed, amount));
};

export function PacksView({dep, data, onConnect, onShapesChanged}: {
  dep: Deployment;
  data: SiteData | null;
  onConnect: () => void;
  onShapesChanged: (ids: readonly bigint[]) => Promise<void>;
}) {
  const deployment = packsDeploymentFor(dep.chainId);
  const packConfig = deployment ?? PACKS_DEPLOYMENTS[11155111];
  const {chainId: PACKS_CHAIN_ID, shapes: PACKS_SHAPES, packs: PACKS_ADDRESS, renderer: PACKS_RENDERER} = packConfig;
  const packsClient = packsClientFor(PACKS_CHAIN_ID);
  const networkName = packConfig.name;
  const {address, isConnected, chainId} = useAccount();
  const {switchChainAsync} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [packs, setPacks] = React.useState<OwnedPack[]>([]);
  const [selectedPackId, setSelectedPackId] = React.useState<bigint | null>(null);
  const [mergeSourceIds, setMergeSourceIds] = React.useState<bigint[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [mode, setMode] = React.useState<"create" | "add">("create");
  const [addTargetId, setAddTargetId] = React.useState<bigint | null>(null);
  const [selectedShapes, setSelectedShapes] = React.useState<bigint[]>([]);
  const [counts, setCounts] = React.useState<number[]>([]);
  const [quote, setQuote] = React.useState<MintQuote | null>(null);
  const [quoteError, setQuoteError] = React.useState<string | null>(null);
  const [sampleNonce, setSampleNonce] = React.useState<bigint | null>(null);
  const [sampleEpochs, setSampleEpochs] = React.useState<Record<number, number>>({});
  const [status, setStatus] = React.useState<Status>(idle);
  const [exitKind, setExitKind] = React.useState<"open" | "redeem">("open");
  const [chunkSize, setChunkSize] = React.useState(10);
  const [unavailableExit, setUnavailableExit] = React.useState<{packId: bigint; kind: "open" | "redeem"} | null>(null);
  const walletRef = React.useRef({address, chainId});
  walletRef.current = {address, chainId};
  const walletStillReady = (expected: string) =>
    walletRef.current.chainId === PACKS_CHAIN_ID &&
    !!walletRef.current.address && same(walletRef.current.address, expected);

  const supported = !!deployment && same(dep.shapes, PACKS_SHAPES);
  const wrongChain = isConnected && chainId !== PACKS_CHAIN_ID;
  const selectedPack = packs.find((pack) => pack.id === selectedPackId) ?? null;
  const mergeCandidates = packs.filter((pack) => pack.kind === "live" && pack.id !== selectedPackId);
  const mergeSources = mergeCandidates.filter((pack) => mergeSourceIds.includes(pack.id));
  const canMerge = supported && !!address && !wrongChain && !loadError && !loading &&
    status.kind !== "working" && selectedPack?.kind === "live" && mergeSources.length > 0 &&
    mergeSources.length === mergeSourceIds.length;
  const addTarget = packs.find((pack) => pack.id === addTargetId && pack.kind === "live") ?? null;
  const willCreate = mode === "create" || addTargetId === null;
  const singleExitUnavailable = unavailableExit?.packId === selectedPack?.id && unavailableExit?.kind === exitKind;
  const shapesById = new Map((data?.tokens ?? []).map((token) => [token.id, token]));
  const owned = address ? (data?.tokens ?? []).filter((token) =>
    same(token.owner, address) && token.backing > 0n,
  ) : [];
  const activeShapes = mode === "add" ? selectedShapes : [];
  const selectedBacking = activeShapes.reduce((sum, id) =>
    sum + (owned.find((token) => token.id === id)?.backing ?? 0n), 0n);
  const hasInputs = activeShapes.length > 0 || counts.some((n) => n > 0);
  const validCounts = settings !== null && mintCountsValid(counts, settings.denominations.length);
  const meetsFloor = settings !== null && quote !== null &&
    creationMeetsMinimum(selectedBacking, quote, settings.minimum);
  const canSubmit = supported && !!address && !wrongChain && !loadError && status.kind !== "working" &&
    !loading && !!settings && !!quote && validCounts && hasInputs &&
    (willCreate ? meetsFloor : !!addTarget) &&
    activeShapes.every((id) => owned.some((token) => token.id === id));
  const previewLimit = settings ? Math.min(Number(settings.previewCardLimit), PACK_PREVIEW_MAX_CARDS) : PACK_PREVIEW_MAX_CARDS;
  const sampleArtwork = (di: number, serial: number): string | undefined => {
    if (sampleNonce === null || !settings) return undefined;
    return packSampleArtwork(sampleNonce, di, sampleEpochs[di] ?? 0, serial, settings.denominations[di]);
  };
  const denominationArt = React.useMemo(() =>
    sampleNonce === null ? [] : (settings?.denominations ?? []).map((amount, i) =>
      packSampleArtwork(sampleNonce, i, sampleEpochs[i] ?? 0, 0, amount)),
  [settings, sampleNonce, sampleEpochs]);
  const previewCards = [
    ...(!willCreate && addTarget ? addTarget.shapeIds.map((id, i) => ({key: `pack-${id}`, image: shapesById.get(id)?.image,
      backing: addTarget.backings[i] ?? 0n, label: shapesById.get(id)?.meta.name ?? `Shape #${id}`, isNew: false, tokenId: id})) : []),
    ...activeShapes.map((id) => ({key: `owned-${id}`, image: shapesById.get(id)?.image,
      backing: shapesById.get(id)?.backing ?? 0n, label: shapesById.get(id)?.meta.name ?? `Shape #${id}`, isNew: false, tokenId: id})),
    ...(settings?.denominations ?? []).flatMap((amount, i) => Array.from({length: Math.max(0, Math.min(counts[i] ?? 0, previewLimit))}, (_, j) =>
      ({key: `new-${i}-${j}`, image: undefined as string | undefined,
        backing: amount, label: `${eth(amount)} Shape`, isNew: true, tokenId: null, di: i, serial: j + 1}))),
  ].sort((a, b) => {
    if (a.backing !== b.backing) return a.backing > b.backing ? -1 : 1;
    if (a.tokenId === null) return b.tokenId === null ? 0 : 1;
    if (b.tokenId === null) return -1;
    return a.tokenId === b.tokenId ? 0 : a.tokenId < b.tokenId ? -1 : 1;
  }).slice(0, previewLimit).map((card) => "di" in card ? {...card, image: sampleArtwork(card.di, card.serial)} : card);
  const draftCount = (addTarget && !willCreate ? addTarget.shapeIds.length : 0) + activeShapes.length +
    counts.reduce((sum, count) => sum + (Number.isInteger(count) && count > 0 ? count : 0), 0);

  React.useEffect(() => {
    const random = new Uint32Array(2);
    crypto.getRandomValues(random);
    setSampleNonce((BigInt(random[0]) << 32n) | BigInt(random[1]));
  }, []);

  const changeCount = (i: number, next: number) => {
    if (next === counts[i]) return;
    setCounts((old) => old.map((value, index) => index === i ? next : value));
    setSampleEpochs((old) => ({...old, [i]: (old[i] ?? 0) + 1}));
  };

  // Account and chain changes invalidate selections and messages from the previous wallet.
  React.useEffect(() => {
    setPacks([]);
    setSelectedShapes([]);
    setSelectedPackId(null);
    setMergeSourceIds([]);
    setAddTargetId(null);
    setCounts((current) => current.map(() => 0));
    setMode("create");
    setStatus(idle);
    setUnavailableExit(null);
  }, [address, chainId, dep.chainId]);

  React.useEffect(() => {
    if (selectedPack) setChunkSize(Math.min(10, selectedPack.shapeIds.length));
  }, [selectedPackId, selectedPack?.shapeIds.length]);

  React.useEffect(() => {
    if (!supported) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const [packCode, rendererCode] = await Promise.all([
        packsClient.getCode({address: PACKS_ADDRESS}), packsClient.getCode({address: PACKS_RENDERER}),
      ]);
      if (!packCode || packCode === "0x" || !rendererCode || rendererCode === "0x") throw new Error(`The ${networkName} Packs deployment is not visible at the supplied contract addresses yet. Retry after deployment confirmation.`);
      const [linkedShapes, linkedRenderer, minimum, totalMinted, denominationCount, mintFee, previewCardLimit] = await packsClient.multicall({contracts: [
        {address: PACKS_ADDRESS, abi: packsAbi, functionName: "shapes"},
        {address: PACKS_ADDRESS, abi: packsAbi, functionName: "renderer"},
        {address: PACKS_ADDRESS, abi: packsAbi, functionName: "MIN_PACK_VALUE"},
        {address: PACKS_ADDRESS, abi: packsAbi, functionName: "totalMinted"},
        {address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "denominationCount"},
        {address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "mintFee"},
        {address: PACKS_ADDRESS, abi: packsAbi, functionName: "previewCardLimit"},
      ], allowFailure: false});
      if (!same(linkedShapes, PACKS_SHAPES)) throw new Error("The Packs contract points to an unexpected Shapes contract.");
      if (!same(linkedRenderer, PACKS_RENDERER)) throw new Error("The Packs contract points to an unexpected pack renderer.");
      const denominations = await packsClient.multicall({contracts: Array.from({length: denominationCount}, (_, i) => ({
        address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "denominationAt", args: [i],
      } as const)), allowFailure: false});
      const found = address ? await loadOwnedPacks(packsClient, address, totalMinted, PACKS_ADDRESS, PACKS_SHAPES) : [];
      if (!active) return;
      setSettings({minimum, totalMinted, denominations, mintFee, previewCardLimit});
      setPacks(found);
      setMergeSourceIds([]);
      setSelectedPackId((current) => found.some((pack) => pack.id === current) ? current : found[0]?.id ?? null);
      setAddTargetId((current) => found.some((pack) => pack.id === current && pack.kind === "live") ? current : found.find((pack) => pack.kind === "live")?.id ?? null);
      setCounts((current) => current.length === denominations.length ? current : denominations.map(() => 0));
      setLoading(false);
    })().catch((error) => {
      if (!active) return;
      setSettings(null);
      setPacks([]);
      setLoadError(describeTxError(error));
      setLoading(false);
    });
    return () => { active = false; };
  }, [supported, address, reload, PACKS_CHAIN_ID, PACKS_ADDRESS, PACKS_SHAPES, PACKS_RENDERER, networkName, packsClient]);

  React.useEffect(() => {
    if (!supported || !validCounts) { setQuote(null); return; }
    let active = true;
    setQuote(null);
    setQuoteError(null);
    const timer = window.setTimeout(() => packsClient.readContract({address: PACKS_ADDRESS, abi: packsAbi, functionName: "quoteMint", args: [counts]})
      .then((result) => {
        if (active) setQuote({backingWei: result[0], feeWei: result[1], totalWei: result[2], shapeCount: result[3]});
      })
      .catch((error) => { if (active) setQuoteError(describeTxError(error)); }), 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [supported, validCounts, counts, PACKS_ADDRESS, packsClient]);

  const send = async (name: string, contract: "packs" | "shapes", args: readonly unknown[], value?: bigint) => {
    if (!address || chainId !== PACKS_CHAIN_ID) throw new Error(`Switch your wallet to ${networkName} first.`);
    if (value !== undefined && value > 0n) {
      const balance = await packsClient.getBalance({address});
      const shortfall = packPaymentBalanceError(balance, value);
      if (shortfall) throw new Error(shortfall);
    }
    const target = contract === "packs" ? PACKS_ADDRESS : PACKS_SHAPES;
    const abi = contract === "packs" ? packsAbi : packsShapesAbi;
    const request = {address: target, abi, functionName: name, args, value, account: address} as const;
    await packsClient.simulateContract(request as Parameters<typeof packsClient.simulateContract>[0]);
    const estimate = await packsClient.estimateContractGas(request as Parameters<typeof packsClient.estimateContractGas>[0]);
    const block = await packsClient.getBlock();
    const gas = bufferGas(estimate);
    if (gas > packsGasBudget(block.gasLimit)) {
      const next = name === "open" || name === "redeem" ? "Unseal and claim in chunks."
        : name === "claim" || name === "claimEth" ? "Use a smaller claim."
          : name === "mergePacks" ? "Merge fewer source packs, or unseal and claim a source in chunks before adding its Shapes."
          : name === "createPack" || name === "addToPack" ? "Use fewer Shapes in this transaction." : "";
      throw new Error(`The buffered gas estimate exceeds the safe ${networkName} transaction budget. ${next}`.trim());
    }
    if (!walletStillReady(address)) throw new Error("The connected wallet or network changed. Review this action again.");
    const hash = await writeContractAsync({...request, gas, chainId: PACKS_CHAIN_ID} as Parameters<typeof writeContractAsync>[0]);
    if (walletStillReady(address)) setStatus({kind: "working", message: `Waiting for ${networkName} confirmation…`, hash});
    await awaitSuccessfulReceipt(packsClient, hash, {address: target, abi, functionName: name, args, value});
    return hash;
  };

  const submit = async () => {
    if (!canSubmit || !address || !settings || !quote) return;
    const ids = [...activeShapes];
    const mintCounts = [...counts];
    const packId = addTarget?.id;
    setStatus({kind: "working", message: "Checking Shapes, approval, and the exact payment…"});
    try {
      const liveQuote = await packsClient.readContract({address: PACKS_ADDRESS, abi: packsAbi, functionName: "quoteMint", args: [mintCounts]});
      let liveBacking = 0n;
      for (const id of ids) {
        const [owner, backing] = await Promise.all([
          packsClient.readContract({address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "ownerOf", args: [id]}),
          packsClient.readContract({address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "backingOf", args: [id]}),
        ]);
        if (!same(owner, address) || backing === 0n) throw new Error(`Shape #${id} is no longer an eligible Shape in this wallet.`);
        liveBacking += backing;
      }
      if (willCreate && liveBacking + liveQuote[0] < settings.minimum) {
        throw new Error(`A new pack needs at least ${eth(settings.minimum)} of backing.`);
      }
      if (!willCreate) {
        if (packId === undefined) throw new Error("Choose a live pack to add to.");
        const owner = await packsClient.readContract({address: PACKS_ADDRESS, abi: packsAbi, functionName: "ownerOf", args: [packId]});
        if (!same(owner, address)) throw new Error("This wallet no longer owns that pack.");
      }
      if (ids.length > 0) {
        const allApproved = await packsClient.readContract({address: PACKS_SHAPES, abi: packsShapesAbi,
          functionName: "isApprovedForAll", args: [address, PACKS_ADDRESS]});
        if (!allApproved) {
          const perToken = await Promise.all(ids.map((id) => packsClient.readContract({address: PACKS_SHAPES,
            abi: packsShapesAbi, functionName: "getApproved", args: [id]})));
          if (perToken.some((operator) => !same(operator, PACKS_ADDRESS))) {
            const hash = await send("setApprovalForAll", "shapes", [PACKS_ADDRESS, true]);
            if (walletStillReady(address)) setStatus({kind: "done", message: "Shapes approved. Review the pack and press the action again to sign it.", hash});
            return;
          }
        }
      }
      const name = willCreate ? "createPack" : "addToPack";
      const args = willCreate ? [ids, mintCounts] : [packId!, ids, mintCounts];
      const hash = await send(name, "packs", args, liveQuote[2]);
      if (!walletStillReady(address)) return;
      setSelectedShapes([]);
      setCounts(settings.denominations.map(() => 0));
      setStatus({kind: "done", message: willCreate ? "Pack created." : "Shapes added to pack.", hash});
      setReload((n) => n + 1);
      await onShapesChanged(ids);
    } catch (error) {
      if (walletStillReady(address)) setStatus({kind: "error", message: describeTxError(error)});
    }
  };

  const exit = async (chunked: boolean) => {
    if (!selectedPack || !address || wrongChain || status.kind === "working") return;
    setStatus({kind: "working", message: `Checking the exit on ${networkName}…`});
    try {
      const id = selectedPack.id;
      const name = selectedPack.kind === "claim"
        ? exitKind === "open" ? "claim" : "claimEth"
        : chunked ? "unseal" : exitKind;
      if (selectedPack.kind === "live") {
        const owner = await packsClient.readContract({address: PACKS_ADDRESS, abi: packsAbi, functionName: "ownerOf", args: [id]});
        if (!same(owner, address)) throw new Error("This wallet no longer owns that pack.");
      } else {
        const claimant = await packsClient.readContract({address: PACKS_ADDRESS, abi: packsAbi, functionName: "claimantOf", args: [id]});
        if (!same(claimant, address)) throw new Error("This wallet is no longer the pack claimant.");
      }
      const count = Math.min(chunkSize, selectedPack.shapeIds.length);
      if (selectedPack.kind === "claim" && (!Number.isInteger(count) || count < 1)) throw new Error("Choose at least one Shape per claim.");
      const args = selectedPack.kind === "claim"
        ? exitKind === "open" ? [id, BigInt(count)] : [id, BigInt(count), address]
        : chunked ? [id, address] : [id];
      const hash = await send(name, "packs", args);
      if (!walletStillReady(address)) return;
      setStatus({kind: "done", message: selectedPack.kind === "claim"
        ? `${count} Shape${count === 1 ? "" : "s"} claimed ${exitKind === "open" ? "as Shapes" : "as ETH"}.`
        : chunked ? "Pack unsealed. Claim its Shapes in chunks below."
          : exitKind === "open" ? "Pack opened. Shapes returned to your wallet." : "Pack redeemed. ETH returned to your wallet.", hash});
      setUnavailableExit(null);
      setReload((n) => n + 1);
      await onShapesChanged(selectedPack.shapeIds);
    } catch (error) {
      if (!walletStillReady(address)) return;
      const message = describeTxError(error);
      if (!chunked && selectedPack.kind === "live" && /gas|block|estimate/i.test(message)) {
        setUnavailableExit({packId: selectedPack.id, kind: exitKind});
      }
      setStatus({kind: "error", message});
    }
  };

  const merge = async () => {
    if (!canMerge || !address || !selectedPack) return;
    const targetId = selectedPack.id;
    const sourceIds = mergeSources.map((pack) => pack.id);
    setStatus({kind: "working", message: `Checking pack ownership and merge gas on ${networkName}…`});
    try {
      const owners = await packsClient.multicall({contracts: [targetId, ...sourceIds].map((id) => ({
        address: PACKS_ADDRESS, abi: packsAbi, functionName: "ownerOf", args: [id],
      } as const)), allowFailure: false});
      if (owners.some((owner) => !same(owner, address))) throw new Error("This wallet no longer owns every selected live pack. Reload and review the selection.");
      const hash = await send("mergePacks", "packs", [targetId, sourceIds]);
      if (!walletStillReady(address)) return;
      setMergeSourceIds([]);
      setStatus({kind: "done", message: `${sourceIds.length} pack${sourceIds.length === 1 ? "" : "s"} merged into the selected pack.`, hash});
      setReload((n) => n + 1);
    } catch (error) {
      if (walletStillReady(address)) setStatus({kind: "error", message: describeTxError(error)});
    }
  };

  if (!supported) return (
    <main className="packs-page">
      <Section title="PACKS"><h1>Shape Packs</h1><p>Packs are available on Ethereum Mainnet and Sepolia. Open the site for either network to use its deployment.</p>
        <a href="https://shapes.ripe.wtf/packs">Open Mainnet Packs ↗</a>{" · "}
        <a href="https://shapes-sepolia.netlify.app/packs">Open Sepolia Packs ↗</a>
      </Section>
    </main>
  );

  return (
    <main className="packs-page">
      <Section title="PACKS">
        <p className="launch-kicker">{networkName} · Shape Packs</p>
        <h1>Keep Shapes together.</h1>
        <p>Bundle Shapes you own, mint new ones, or merge packs you own. Open to get the Shapes back; redeem to receive their ETH backing.</p>
        <p className="packs-small">ShapePacks <a href={`${packConfig.explorer}/address/${PACKS_ADDRESS}`} target="_blank" rel="noreferrer">{PACKS_ADDRESS} ↗</a></p>
        {!isConnected && <button type="button" className="btn-filled packs-action" onClick={onConnect}>CONNECT WALLET</button>}
        {wrongChain && <div className="packs-alert">Switch your wallet to {networkName} to use Packs. <button type="button" onClick={() =>
          void switchChainAsync({chainId: PACKS_CHAIN_ID}).catch((error) => setStatus({kind: "error", message: describeTxError(error)}))} className="btn-ghost packs-text-action">SWITCH NETWORK</button></div>}
        {loading && <p role="status">Reading Packs on {networkName}…</p>}
        {loadError && <div className="packs-alert" role="alert">{loadError} <button type="button" className="btn-ghost packs-text-action" onClick={() => setReload((n) => n + 1)}>RETRY</button></div>}
        {settings && <p className="packs-small">Minimum new pack backing: {eth(settings.minimum)} · Shapes mint fee: {eth(settings.mintFee)} per new Shape · {settings.totalMinted.toString()} packs created</p>}
      </Section>

      {isConnected && settings && <>
        <Section title="BUILD A PACK">
          <div id="packs-build-anchor" className="shape-mode-toggle" role="group" aria-label="Pack action">
            <button type="button" aria-pressed={mode === "create"} onClick={() => {setMode("create"); setSelectedShapes([]);}}>CREATE</button>
            <button type="button" aria-pressed={mode === "add"} onClick={() => setMode("add")}>ADD TO PACK</button>
          </div>
          {mode === "add" && <div className="packs-destinations" role="group" aria-label="Pack destination">
            <p className="packs-small">Choose where the selected Shapes go.</p>
            <div className="packs-destination-options">
              <button type="button" className="btn-outline" aria-pressed={addTargetId === null} onClick={() => setAddTargetId(null)}>NEW PACK</button>
              {packs.filter((pack) => pack.kind === "live").map((pack) => <button key={pack.id.toString()} type="button"
                className="btn-outline" aria-pressed={addTargetId === pack.id} onClick={() => setAddTargetId(pack.id)}>{pack.name}</button>)}
            </div>
          </div>}
          <div className="packs-builder-grid">
            <div className="packs-preview-panel">
              <h2>Pack preview</h2>
              <div className={`packs-draft-art${previewCards.length === 0 ? " is-empty" : ""}`} aria-label={`${draftCount} Shape${draftCount === 1 ? "" : "s"} in draft pack`}>
                {previewCards.length === 0 ? <span className="packs-preview-empty">YOUR PACK<br />TAKES SHAPE HERE</span> : previewCards.map((card, i) => {
                  const slot = packPreviewSlot(i, previewCards.length);
                  return <div className="packs-preview-card" data-rank={i} key={card.key} title={card.label} style={{
                    left: `${slot.x / PACK_PREVIEW_CANVAS * 100}%`, top: `${slot.y / PACK_PREVIEW_CANVAS * 100}%`,
                    width: `${slot.width / PACK_PREVIEW_CANVAS * 100}%`, height: `${slot.height / PACK_PREVIEW_CANVAS * 100}%`,
                    transform: `rotate(${slot.angle}deg)`, zIndex: previewCards.length - i,
                  }}>
                    {card.image ? <img src={card.image} alt="" /> : <span className="packs-preview-unminted"><small>{card.isNew ? "NEW SHAPE" : "SHAPE"}</small><strong>{eth(card.backing)}</strong></span>}
                  </div>;
                })}
              </div>
              <p className="packs-small">{draftCount} Shape{draftCount === 1 ? "" : "s"} in {willCreate ? "a new pack" : addTarget?.name ?? "the pack"}{draftCount > previewCards.length ? ` · showing ${previewCards.length}` : ""}. New Shape artwork is revealed after mint; this preview is illustrative.</p>
            </div>
            <div className="packs-builder-main">
              <div className="packs-builder-form">
                <h2>Mint new Shapes</h2>
                <p className="packs-small">Choose a denomination, then set how many Shapes to mint into {willCreate ? "the new pack" : addTarget?.name ?? "the pack"}.</p>
                <div className="packs-denomination-groups">{settings.denominations.map((amount, i) => {
                  const artwork = denominationArt[i];
                  return <div className="packs-denomination" key={i}>
                    <div className="packs-denomination-thumb" aria-hidden="true">
                      {artwork ? <img src={artwork} alt="" /> : <span>SHAPE</span>}
                    </div>
                    <div className="packs-denomination-control">
                      <label htmlFor={`packs-denom-${i}`}>{eth(amount)}</label>
                      <div className="packs-stepper">
                        <button type="button" className="btn-outline" aria-label={`Decrease ${eth(amount)} Shapes`} disabled={(counts[i] ?? 0) <= 0}
                          onClick={() => changeCount(i, step(counts[i] ?? 0, -1, 0, 0xffffffff))}>−</button>
                        <input id={`packs-denom-${i}`} className="qty-input" type="number" min="0" max="4294967295" step="1" value={counts[i] ?? 0}
                          onChange={(event) => changeCount(i, Number(event.target.value))} />
                        <button type="button" className="btn-outline" aria-label={`Increase ${eth(amount)} Shapes`} disabled={(counts[i] ?? 0) >= 0xffffffff}
                          onClick={() => changeCount(i, step(counts[i] ?? 0, 1, 0, 0xffffffff))}>+</button>
                      </div>
                    </div>
                  </div>;
                })}</div>
                {mode === "add" && <p className="packs-small">Choose any Shapes you own in Your Shapes below. You can combine them with new Shapes here.</p>}
              </div>
              <aside className="packs-order" aria-label="Order summary">
                <h2>Order summary</h2>
                <div className="packs-summary">
                  {settings.denominations.map((amount, i) => (counts[i] ?? 0) > 0 && Number.isInteger(counts[i]) ?
                    <div className="packs-summary-row" key={i}><span>{counts[i]} × {eth(amount)}</span><strong>{eth(amount * BigInt(counts[i]))}</strong></div> : null)}
                  {mode === "add" && selectedShapes.length > 0 && <div className="packs-summary-row"><span>{selectedShapes.length} owned Shape{selectedShapes.length === 1 ? "" : "s"} backing</span><strong>{eth(selectedBacking)}</strong></div>}
                  {quote && <>
                    <div className="packs-summary-row"><span>New Shape backing</span><strong>{eth(quote.backingWei)}</strong></div>
                    <div className="packs-summary-row"><span>Mint fees</span><strong>{eth(quote.feeWei)}</strong></div>
                    <div className="packs-summary-row"><span>Pack backing after</span><strong>{eth((willCreate ? 0n : addTarget?.valueWei ?? 0n) + selectedBacking + quote.backingWei)}</strong></div>
                    <div className="packs-summary-row is-total"><span>Wallet payment</span><strong>{eth(quote.totalWei)}</strong></div>
                  </>}
                </div>
                {quoteError && <p className="packs-alert" role="alert">{quoteError}</p>}
                {willCreate && hasInputs && quote && !meetsFloor && <p className="packs-alert">A new pack needs at least {eth(settings.minimum)} of backing.</p>}
                {activeShapes.length > 0 && <p className="packs-small">Owned Shapes require approval first. If your wallet asks for approval, press the pack action again afterward.</p>}
                <button type="button" className="btn-filled packs-action" disabled={!canSubmit} onClick={() => void submit()}>
                  {willCreate ? "CREATE PACK" : "ADD TO PACK"}
                </button>
              </aside>
            </div>
          </div>
        </Section>

        <Section title="YOUR PACKS">
          {packs.length === 0 ? <p>This wallet has no live packs or unfinished pack claims.</p> : (
            <div className="packs-list">{packs.map((pack) => <button key={pack.id.toString()} type="button"
              className={selectedPackId === pack.id ? "packs-card is-selected" : "packs-card"}
              aria-pressed={selectedPackId === pack.id}
              onClick={() => {setSelectedPackId(pack.id); setMergeSourceIds([]); setUnavailableExit(null); setStatus(idle);}}>
              <span className="packs-art">{pack.image ? <img src={pack.image} alt="" /> : <span>{pack.kind === "claim" ? "UNSEALED" : "ARTWORK UNAVAILABLE"}</span>}</span>
              <span className="packs-card-title"><strong>{pack.name}</strong></span>
              <span>{pack.kind === "live" ? "LIVE" : "UNSEALED CLAIM"} · {pack.shapeIds.length} Shapes · {eth(pack.valueWei ?? pack.backings.reduce((a, b) => a + b, 0n))}</span>
            </button>)}</div>
          )}
          {selectedPack && <div className="packs-selected-detail">
          <p className="launch-kicker">SELECTED PACK</p>
          <div className="packs-detail-heading">
            <span className="packs-art">{selectedPack.image ? <img src={selectedPack.image} alt={`${selectedPack.name} artwork`} /> : <span>{selectedPack.kind === "claim" ? "UNSEALED" : "ARTWORK UNAVAILABLE"}</span>}</span>
            <div><p className="launch-kicker">{selectedPack.kind === "live" ? "Shape Pack token" : "Unsealed claim"}</p>
              <h2>{selectedPack.name}</h2></div>
          </div>
          <div className="packs-facts">
            <span><strong>{selectedPack.shapeIds.length}</strong> Shapes</span>
            <span><strong>{eth(selectedPack.valueWei ?? selectedPack.backings.reduce((a, b) => a + b, 0n))}</strong> backing</span>
            {selectedPack.kind === "live" && <span><strong>{selectedPack.mintedCount?.toString()}</strong> minted inside</span>}
          </div>
          {selectedPack.creator && <p className="packs-small">Created by {selectedPack.creator}</p>}
          <div className="packs-contents">{selectedPack.shapeIds.map((id, i) => {
            const shape = shapesById.get(id);
            return <a href={`/shape/${id}`} key={id.toString()}>
              {shape && <Art src={shape.image} alt="" width={52} />}
              <span className="packs-shape-name"><strong>{shape?.meta.name ?? `Shape #${id}`}</strong></span>
              <span className="packs-shape-backing">{eth(selectedPack.backings[i] ?? 0n)}</span>
            </a>;
          })}</div>
          {selectedPack.kind === "live" && mergeCandidates.length > 0 && <div className="packs-merge">
            <h2>Merge packs</h2>
            <p className="packs-small">Select packs to merge into {selectedPack.name}. This pack keeps its token; each selected source pack token is burned. Their Shapes and backing join this pack without leaving Packs custody.</p>
            <div className="packs-merge-sources" role="group" aria-label="Source packs to merge">
              {mergeCandidates.map((pack) => {
                const selected = mergeSourceIds.includes(pack.id);
                return <button key={pack.id.toString()} type="button" aria-pressed={selected}
                  className={`compose-select-card packs-merge-source${selected ? " selected" : ""}`}
                  onClick={() => setMergeSourceIds((ids) => selected ? ids.filter((id) => id !== pack.id) : [...ids, pack.id])}>
                  <span className="packs-merge-art">{pack.image ? <img src={pack.image} alt="" /> : "ARTWORK UNAVAILABLE"}</span>
                  <span className="packs-merge-meta"><strong>{pack.name}</strong><small>{pack.shapeIds.length} Shapes · {eth(pack.valueWei ?? 0n)}</small></span>
                </button>;
              })}
            </div>
            {mergeSources.length > 0 && <p className="packs-small">After merge: {selectedPack.shapeIds.length + mergeSources.reduce((count, pack) => count + pack.shapeIds.length, 0)} Shapes · {eth((selectedPack.valueWei ?? 0n) + mergeSources.reduce((value, pack) => value + (pack.valueWei ?? 0n), 0n))} backing. {mergeSources.length} source pack token{mergeSources.length === 1 ? "" : "s"} will be burned.</p>}
            <button type="button" className="btn-filled packs-action" disabled={!canMerge} onClick={() => void merge()}>MERGE PACKS</button>
          </div>}
          <div className="packs-exits">
            <div className="shape-mode-toggle" role="group" aria-label="Exit type">
              <button type="button" aria-pressed={exitKind === "open"} onClick={() => {
                if (exitKind !== "open") {setExitKind("open"); setUnavailableExit(null); setStatus(idle);}
              }}>OPEN · SHAPES</button>
              <button type="button" aria-pressed={exitKind === "redeem"} onClick={() => {
                if (exitKind !== "redeem") {setExitKind("redeem"); setUnavailableExit(null); setStatus(idle);}
              }}>REDEEM · ETH</button>
            </div>
            <p>{exitKind === "open" ? "Open returns the individual Shapes to your wallet." : "Redeem burns every Shape and pays its backing in ETH to your wallet."}</p>
            {selectedPack.kind === "live" ? <>
              {singleExitUnavailable ? <>
                <p className="packs-alert">Single transaction exit could not fit or be estimated. Unseal and claim in smaller chunks.</p>
                <p className="packs-small">Unsealing burns the pack token and gives only this wallet the right to claim the contents in chunks.</p>
                <button type="button" className="btn-outline packs-action" disabled={wrongChain || status.kind === "working"} onClick={() => void exit(true)}>UNSEAL FOR CHUNKED EXIT</button>
              </> : <button type="button" className="btn-filled packs-action" disabled={wrongChain || status.kind === "working"} onClick={() => void exit(false)}>
                {exitKind === "open" ? "OPEN PACK" : "REDEEM PACK"}
              </button>}
            </> : <>
              <label className="packs-small" htmlFor="packs-chunk">Shapes per claim</label>
              <div className="packs-stepper packs-claim-stepper">
                <button type="button" className="btn-outline" aria-label="Decrease Shapes per claim" disabled={chunkSize <= 1}
                  onClick={() => setChunkSize((count) => step(count, -1, 1, selectedPack.shapeIds.length))}>−</button>
                <input id="packs-chunk" className="qty-input" type="number" min="1" max={selectedPack.shapeIds.length} value={chunkSize}
                  onChange={(event) => setChunkSize(Number(event.target.value))} />
                <button type="button" className="btn-outline" aria-label="Increase Shapes per claim" disabled={chunkSize >= selectedPack.shapeIds.length}
                  onClick={() => setChunkSize((count) => step(count, 1, 1, selectedPack.shapeIds.length))}>+</button>
              </div>
              <button type="button" className="btn-filled packs-action" disabled={wrongChain || status.kind === "working" || !Number.isInteger(chunkSize) || chunkSize < 1}
                onClick={() => void exit(false)}>{exitKind === "open" ? "CLAIM SHAPES" : "CLAIM ETH"}</button>
              <p className="packs-small">Repeat until all {selectedPack.shapeIds.length} remaining Shapes are claimed. If a claim is too large for a block, lower the count.</p>
            </>}
          </div>
        </div>}
        </Section>

        <Section title="YOUR SHAPES">
          <p className="packs-small">Shapes in your wallet that are not in packs. Select one to include it in Add to Pack.</p>
          {!data ? <p>Reading your Shapes…</p> : owned.length === 0 ? <p>No eligible unpacked Shapes in this wallet.</p> : (
            <div className="packs-picks">{owned.map((token) => {
              const selected = selectedShapes.includes(token.id) && mode === "add";
              return <button key={token.id.toString()} type="button" aria-pressed={selected}
                className={`compose-select-card${selected ? " selected" : ""}`}
                onClick={() => {
                  setMode("add");
                  setSelectedShapes((ids) => selected ? ids.filter((id) => id !== token.id) : [...ids, token.id]);
                  document.getElementById("packs-build-anchor")?.scrollIntoView({behavior: "smooth", block: "start"});
                }}>
                <div className="packs-pick-art"><Art src={token.image} alt="" />
                  {selected && <span className="compose-selection-badge">SELECTED</span>}
                </div>
                <span className="packs-pick-meta"><strong>{token.meta.name}</strong><small>{eth(token.backing)}</small></span>
              </button>;
            })}</div>
          )}
        </Section>
      </>}

      {status.kind !== "idle" && <div className={status.kind === "error" ? "packs-status is-error" : "packs-status"} role={status.kind === "error" ? "alert" : "status"}>
        {status.message} {status.hash && <a href={txUrl(status.hash, PACKS_CHAIN_ID)} target="_blank" rel="noreferrer">View transaction ↗</a>}
      </div>}
    </main>
  );
}
