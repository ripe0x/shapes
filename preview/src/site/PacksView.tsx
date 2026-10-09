import React from "react";
import {formatEther, type Hash} from "viem";
import {useAccount, useSwitchChain, useWriteContract} from "wagmi";
import {Art, Section, txUrl} from "./ui";
import {describeTxError} from "./errors";
import {awaitSuccessfulReceipt, bufferGas} from "./tx";
import type {Deployment} from "../chain/abi";
import type {SiteData} from "./data";
import {
  PACKS_ADDRESS, PACKS_CHAIN_ID, PACKS_SHAPES, creationMeetsMinimum,
  loadOwnedPacks, mintCountsValid, packsAbi, packsClient, packsGasBudget, packsShapesAbi,
  type MintQuote, type OwnedPack,
} from "./packs";

type Settings = {minimum: bigint; denominations: bigint[]; mintFee: bigint; totalMinted: bigint};
type Status = {kind: "idle" | "working" | "done" | "error"; message: string; hash?: Hash};
const idle: Status = {kind: "idle", message: ""};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const eth = (value: bigint) => `${formatEther(value)} ETH`;
const step = (value: number, delta: number, min: number, max: number) =>
  Math.min(max, Math.max(min, (Number.isFinite(value) ? Math.trunc(value) : min) + delta));

export function PacksView({dep, data, onConnect, onShapesChanged}: {
  dep: Deployment;
  data: SiteData | null;
  onConnect: () => void;
  onShapesChanged: (ids: readonly bigint[]) => Promise<void>;
}) {
  const {address, isConnected, chainId} = useAccount();
  const {switchChainAsync} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [packs, setPacks] = React.useState<OwnedPack[]>([]);
  const [selectedPackId, setSelectedPackId] = React.useState<bigint | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [mode, setMode] = React.useState<"create" | "add">("create");
  const [selectedShapes, setSelectedShapes] = React.useState<bigint[]>([]);
  const [counts, setCounts] = React.useState<number[]>([]);
  const [quote, setQuote] = React.useState<MintQuote | null>(null);
  const [quoteError, setQuoteError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<Status>(idle);
  const [exitKind, setExitKind] = React.useState<"open" | "redeem">("open");
  const [chunkSize, setChunkSize] = React.useState(10);
  const [unavailableExit, setUnavailableExit] = React.useState<{packId: bigint; kind: "open" | "redeem"} | null>(null);
  const walletRef = React.useRef({address, chainId});
  walletRef.current = {address, chainId};
  const walletStillReady = (expected: string) =>
    walletRef.current.chainId === PACKS_CHAIN_ID &&
    !!walletRef.current.address && same(walletRef.current.address, expected);

  const supported = dep.chainId === PACKS_CHAIN_ID && same(dep.shapes, PACKS_SHAPES);
  const wrongChain = isConnected && chainId !== PACKS_CHAIN_ID;
  const selectedPack = packs.find((pack) => pack.id === selectedPackId) ?? null;
  const singleExitUnavailable = unavailableExit?.packId === selectedPack?.id && unavailableExit?.kind === exitKind;
  const shapesById = new Map((data?.tokens ?? []).map((token) => [token.id, token]));
  const owned = address ? (data?.tokens ?? []).filter((token) =>
    same(token.owner, address) && token.backing > 0n,
  ) : [];
  const selectedBacking = selectedShapes.reduce((sum, id) =>
    sum + (owned.find((token) => token.id === id)?.backing ?? 0n), 0n);
  const hasInputs = selectedShapes.length > 0 || counts.some((n) => n > 0);
  const validCounts = settings !== null && mintCountsValid(counts, settings.denominations.length);
  const meetsFloor = settings !== null && quote !== null &&
    creationMeetsMinimum(selectedBacking, quote, settings.minimum);
  const canSubmit = supported && !!address && !wrongChain && !loadError && status.kind !== "working" &&
    !loading && !!settings && !!quote && validCounts && hasInputs &&
    (mode === "add" ? selectedPack?.kind === "live" : meetsFloor) &&
    selectedShapes.every((id) => owned.some((token) => token.id === id));

  // Account and chain changes invalidate selections and messages from the previous wallet.
  React.useEffect(() => {
    setPacks([]);
    setSelectedShapes([]);
    setSelectedPackId(null);
    setCounts((current) => current.map(() => 0));
    setMode("create");
    setStatus(idle);
    setUnavailableExit(null);
  }, [address, chainId]);

  React.useEffect(() => {
    if (selectedPack) setChunkSize(Math.min(10, selectedPack.shapeIds.length));
  }, [selectedPackId, selectedPack?.shapeIds.length]);

  React.useEffect(() => {
    if (!supported) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const [linkedShapes, minimum, totalMinted, denominationCount, mintFee] = await packsClient.multicall({contracts: [
        {address: PACKS_ADDRESS, abi: packsAbi, functionName: "shapes"},
        {address: PACKS_ADDRESS, abi: packsAbi, functionName: "MIN_PACK_VALUE"},
        {address: PACKS_ADDRESS, abi: packsAbi, functionName: "totalMinted"},
        {address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "denominationCount"},
        {address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "mintFee"},
      ], allowFailure: false});
      if (!same(linkedShapes, PACKS_SHAPES)) throw new Error("The Packs contract points to an unexpected Shapes contract.");
      const denominations = await packsClient.multicall({contracts: Array.from({length: denominationCount}, (_, i) => ({
        address: PACKS_SHAPES, abi: packsShapesAbi, functionName: "denominationAt", args: [i],
      } as const)), allowFailure: false});
      const found = address ? await loadOwnedPacks(packsClient, address, totalMinted) : [];
      if (!active) return;
      setSettings({minimum, totalMinted, denominations, mintFee});
      setPacks(found);
      setSelectedPackId((current) => found.some((pack) => pack.id === current) ? current : found[0]?.id ?? null);
      setCounts((current) => current.length === denominations.length ? current : denominations.map(() => 0));
      setLoading(false);
    })().catch((error) => {
      if (!active) return;
      setLoadError(describeTxError(error));
      setLoading(false);
    });
    return () => { active = false; };
  }, [supported, address, reload]);

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
  }, [supported, validCounts, counts]);

  const send = async (name: string, contract: "packs" | "shapes", args: readonly unknown[], value?: bigint) => {
    if (!address || chainId !== PACKS_CHAIN_ID) throw new Error("Switch your wallet to Sepolia first.");
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
          : name === "createPack" || name === "addToPack" ? "Use fewer Shapes in this transaction." : "";
      throw new Error(`The buffered gas estimate exceeds the safe Sepolia transaction budget. ${next}`.trim());
    }
    if (!walletStillReady(address)) throw new Error("The connected wallet or network changed. Review this action again.");
    const hash = await writeContractAsync({...request, gas, chainId: PACKS_CHAIN_ID} as Parameters<typeof writeContractAsync>[0]);
    if (walletStillReady(address)) setStatus({kind: "working", message: "Waiting for Sepolia confirmation…", hash});
    await awaitSuccessfulReceipt(packsClient, hash, {address: target, abi, functionName: name, args, value});
    return hash;
  };

  const submit = async () => {
    if (!canSubmit || !address || !settings || !quote) return;
    const ids = [...selectedShapes];
    const mintCounts = [...counts];
    const packId = selectedPack?.id;
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
      if (mode === "create" && liveBacking + liveQuote[0] < settings.minimum) {
        throw new Error(`A new pack needs at least ${eth(settings.minimum)} of backing.`);
      }
      if (mode === "add") {
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
      const name = mode === "create" ? "createPack" : "addToPack";
      const args = mode === "create" ? [ids, mintCounts] : [packId!, ids, mintCounts];
      const hash = await send(name, "packs", args, liveQuote[2]);
      if (!walletStillReady(address)) return;
      setSelectedShapes([]);
      setCounts(settings.denominations.map(() => 0));
      setStatus({kind: "done", message: mode === "create" ? "Pack created." : "Shapes added to pack.", hash});
      setReload((n) => n + 1);
      await onShapesChanged(ids);
    } catch (error) {
      if (walletStillReady(address)) setStatus({kind: "error", message: describeTxError(error)});
    }
  };

  const exit = async (chunked: boolean) => {
    if (!selectedPack || !address || wrongChain || status.kind === "working") return;
    setStatus({kind: "working", message: "Checking the exit on Sepolia…"});
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

  if (!supported) return (
    <main className="packs-page">
      <Section title="PACKS"><h1>Shape Packs</h1><p>Packs are available on Sepolia only. No ShapePacks contract is deployed on mainnet.</p>
        <a href="https://shapes-sepolia.netlify.app/packs">Open the Sepolia Packs site ↗</a>
      </Section>
    </main>
  );

  return (
    <main className="packs-page">
      <Section title="PACKS">
        <p className="launch-kicker">Sepolia · Shape Packs</p>
        <h1>Keep Shapes together.</h1>
        <p>Bundle Shapes you own, mint new ones into a pack, or combine both. Open to get the Shapes back; redeem to receive their ETH backing.</p>
        <p className="packs-small">Testnet only · ShapePacks <a href={`https://sepolia.etherscan.io/address/${PACKS_ADDRESS}`} target="_blank" rel="noreferrer">{PACKS_ADDRESS} ↗</a></p>
        {!isConnected && <button type="button" className="btn-filled packs-action" onClick={onConnect}>CONNECT WALLET</button>}
        {wrongChain && <div className="packs-alert">Switch your wallet to Sepolia to use Packs. <button type="button" onClick={() =>
          void switchChainAsync({chainId: PACKS_CHAIN_ID}).catch((error) => setStatus({kind: "error", message: describeTxError(error)}))} className="btn-ghost packs-text-action">SWITCH NETWORK</button></div>}
        {loading && <p role="status">Reading Packs on Sepolia…</p>}
        {loadError && <div className="packs-alert" role="alert">{loadError} <button type="button" className="btn-ghost packs-text-action" onClick={() => setReload((n) => n + 1)}>RETRY</button></div>}
        {settings && <p className="packs-small">Minimum new pack backing: {eth(settings.minimum)} · Shapes mint fee: {eth(settings.mintFee)} per new Shape · {settings.totalMinted.toString()} packs created</p>}
      </Section>

      {isConnected && settings && <>
        <Section title="YOUR PACKS">
          {packs.length === 0 ? <p>This wallet has no live packs or unfinished pack claims.</p> : (
            <div className="packs-list">{packs.map((pack) => <button key={pack.id.toString()} type="button"
              className={selectedPackId === pack.id ? "packs-card is-selected" : "packs-card"}
              aria-pressed={selectedPackId === pack.id}
              onClick={() => {setSelectedPackId(pack.id); setUnavailableExit(null); setStatus(idle);}}>
              <span className="packs-art">{pack.image ? <img src={pack.image} alt="" /> : <span>{pack.kind === "claim" ? "UNSEALED" : "ARTWORK UNAVAILABLE"}</span>}</span>
              <span className="packs-card-title"><strong>{pack.name}</strong><small>PACK #{pack.id.toString()}</small></span>
              <span>{pack.kind === "live" ? "LIVE" : "UNSEALED CLAIM"} · {pack.shapeIds.length} Shapes · {eth(pack.valueWei ?? pack.backings.reduce((a, b) => a + b, 0n))}</span>
            </button>)}</div>
          )}
        </Section>

        {selectedPack && <Section title={`PACK #${selectedPack.id.toString()}`}>
          <div className="packs-detail-heading">
            <span className="packs-art">{selectedPack.image ? <img src={selectedPack.image} alt={`${selectedPack.name} artwork`} /> : <span>{selectedPack.kind === "claim" ? "UNSEALED" : "ARTWORK UNAVAILABLE"}</span>}</span>
            <div><p className="launch-kicker">{selectedPack.kind === "live" ? "Shape Pack token" : "Unsealed claim"} · #{selectedPack.id.toString()}</p>
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
              <span className="packs-shape-name"><strong>{shape?.meta.name ?? `Shape #${id}`}</strong><small>Shape #{id.toString()}</small></span>
              <span className="packs-shape-backing">{eth(selectedPack.backings[i] ?? 0n)}</span>
            </a>;
          })}</div>
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
        </Section>}

        <Section title="BUILD A PACK">
          <div className="shape-mode-toggle" role="group" aria-label="Pack action">
            <button type="button" aria-pressed={mode === "create"} onClick={() => setMode("create")}>CREATE</button>
            <button type="button" aria-pressed={mode === "add"} disabled={!packs.some((pack) => pack.kind === "live")}
              onClick={() => {setMode("add"); setSelectedPackId((id) => packs.find((pack) => pack.id === id && pack.kind === "live")?.id ?? packs.find((pack) => pack.kind === "live")?.id ?? null);}}>ADD TO PACK</button>
          </div>
          {mode === "add" && <p className="packs-small">Adding to pack #{selectedPack?.id.toString() ?? "—"}. Select a live pack above to change the target.</p>}
          <h2>Shapes you own</h2>
          {!data ? <p>Reading your Shapes…</p> : owned.length === 0 ? <p>No eligible Shapes in this wallet. Mint new Shapes below.</p> : (
            <div className="packs-picks">{owned.map((token) => {
              const selected = selectedShapes.includes(token.id);
              return <button key={token.id.toString()} type="button" aria-pressed={selected}
                className={`compose-select-card${selected ? " selected" : ""}`}
                onClick={() => setSelectedShapes((ids) => ids.includes(token.id) ? ids.filter((id) => id !== token.id) : [...ids, token.id])}>
                <div className="packs-pick-art"><Art src={token.image} alt="" />
                  {selected && <span className="compose-selection-badge">SELECTED</span>}
                </div>
                <span className="packs-pick-meta"><strong>{token.meta.name}</strong><small>{eth(token.backing)}</small></span>
              </button>;
            })}</div>
          )}
          <h2>Mint new Shapes into the pack</h2>
          <div className="packs-denominations">{settings.denominations.map((amount, i) => <div className="packs-denomination" key={i}>
            <label htmlFor={`packs-denom-${i}`}>{eth(amount)}</label>
            <div className="packs-stepper">
              <button type="button" className="btn-outline" aria-label={`Decrease ${eth(amount)} Shapes`} disabled={(counts[i] ?? 0) <= 0}
                onClick={() => setCounts((old) => old.map((value, index) => index === i ? step(value, -1, 0, 0xffffffff) : value))}>−</button>
              <input id={`packs-denom-${i}`} className="qty-input" type="number" min="0" max="4294967295" step="1" value={counts[i] ?? 0}
                onChange={(event) => setCounts((old) => old.map((value, index) => index === i ? Number(event.target.value) : value))} />
              <button type="button" className="btn-outline" aria-label={`Increase ${eth(amount)} Shapes`} disabled={(counts[i] ?? 0) >= 0xffffffff}
                onClick={() => setCounts((old) => old.map((value, index) => index === i ? step(value, 1, 0, 0xffffffff) : value))}>+</button>
            </div>
          </div>)}</div>
          {quote && <div className="packs-facts">
            <span><strong>{eth(selectedBacking + quote.backingWei)}</strong> total backing</span>
            <span><strong>{eth(quote.feeWei)}</strong> mint fees</span>
            <span><strong>{eth(quote.totalWei)}</strong> exact wallet payment</span>
          </div>}
          {quoteError && <p className="packs-alert" role="alert">{quoteError}</p>}
          {mode === "create" && hasInputs && quote && !meetsFloor && <p className="packs-alert">A new pack needs at least {eth(settings.minimum)} of backing.</p>}
          <p className="packs-small">Owned Shapes require approval before packing. The first action may ask your wallet to approve ShapePacks on the Shapes collection; then press the pack action again.</p>
          <button type="button" className="btn-filled packs-action" disabled={!canSubmit} onClick={() => void submit()}>
            {mode === "create" ? "CREATE PACK" : "ADD TO PACK"}
          </button>
        </Section>
      </>}

      {status.kind !== "idle" && <div className={status.kind === "error" ? "packs-status is-error" : "packs-status"} role={status.kind === "error" ? "alert" : "status"}>
        {status.message} {status.hash && <a href={txUrl(status.hash, PACKS_CHAIN_ID)} target="_blank" rel="noreferrer">View transaction ↗</a>}
      </div>}
    </main>
  );
}
