import React from "react";
import "./FwaView.css";
import {formatEther, parseEther, type Abi, type Address, type Hash} from "viem";
import {useAccount, useSwitchChain, useWriteContract} from "wagmi";
import type {Deployment} from "../chain/abi";
import {packsAbi, packsClientFor, packsGasBudget} from "./packs";
import {awaitSuccessfulReceipt, bufferGas} from "./tx";
import {describeTxError} from "./errors";
import {localArt, sampleSeed} from "./art";
import {mintGene} from "../previewGene";
import {
  FWA_POOL, PACKS, buildFwaPlan, depositBlocker, depositedListing, fwaAbi, loadFwaSettings,
  mintedPackId, packTransferAbi, parseFwaSession, reconcileFwaSession, sessionKey,
  type FwaSession, type FwaSettings, type Plan,
} from "./fwa";

const client = packsClientFor(1);
const eth = (v: bigint | string) => formatEther(BigInt(v));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function FwaView({dep, onConnect}: {dep: Deployment; onConnect: () => void}) {
  const {address, chainId} = useAccount();
  const {switchChainAsync} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const [budget, setBudget] = React.useState("1");
  const [quantity, setQuantity] = React.useState(2);
  const [ratio, setRatio] = React.useState("100");
  const [spread, setSpread] = React.useState(false);
  const [settings, setSettings] = React.useState<FwaSettings | null>(null);
  const [settingsError, setSettingsError] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const [session, setSession] = React.useState<FwaSession | null>(null);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [storageWarning, setStorageWarning] = React.useState(false);
  const [activeHash, setActiveHash] = React.useState<Hash | null>(null);
  const [recoveryFailed, setRecoveryFailed] = React.useState(false);
  const [resetConfirm, setResetConfirm] = React.useState(false);
  const wallet = React.useRef({address, chainId});
  wallet.current = {address, chainId};
  const sessionRef = React.useRef(session);
  const running = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const supported = dep.chainId === 1 && same(dep.shapes, "0x6fe9193276bf7abcbee44ab7afd717d637d6faf0");
  const refresh = React.useCallback(async () => {
    setChecking(true);
    setSettingsError("");
    try { const value = await loadFwaSettings(client); if (mounted.current) setSettings(value); return value; }
    catch (e) { if (mounted.current) {setSettings(null); setSettingsError(describeTxError(e));} throw e; }
    finally { if (mounted.current) setChecking(false); }
  }, []);
  React.useEffect(() => {
    if (!supported) return;
    void refresh().catch(() => {});
    const timer = window.setInterval(() => { if (!running.current) void refresh().catch(() => {}); }, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh, supported]);
  React.useEffect(() => {
    let active = true;
    setReady(false); setRecoveryFailed(false);
    setSession(null); sessionRef.current = null;
    setError(""); setMessage(""); setActiveHash(null); setResetConfirm(false);
    const restore = async () => {
      if (!address) return;
      let raw: string | null = null;
      try { raw = localStorage.getItem(sessionKey(address)); } catch {setStorageWarning(true);}
      if (!raw) return;
      const saved = parseFwaSession(raw, address);
      if (!saved) {if (active) {setRecoveryFailed(true); setError("Saved progress could not be read. Check your wallet and transaction history before starting a new plan.");} return;}
      if (active) {
        sessionRef.current = saved; setSession(saved);
        if (saved.draft) {setBudget(saved.draft.budget); setQuantity(saved.draft.quantity); setRatio(saved.draft.ratio); setSpread(saved.draft.spread);}
      }
      try {
        const recovered = await reconcileFwaSession(client, saved);
        if (!active) return;
        try {localStorage.setItem(sessionKey(address), JSON.stringify(recovered));} catch {setStorageWarning(true);}
        sessionRef.current = recovered; setSession(recovered);
      } catch (e) {if (active) {setRecoveryFailed(true); setError(`Could not check saved transactions. Reload to retry. ${describeTxError(e)}`);}}
    };
    void restore().finally(() => {if (active) setReady(true);});
    return () => {active = false;};
  }, [address]);
  const save = (next: FwaSession) => {
    // Persist broadcast hashes before waiting, even if the account changes or the page unmounts.
    try { localStorage.setItem(sessionKey(next.account), JSON.stringify(next)); } catch {if (mounted.current) setStorageWarning(true);}
    if (same(wallet.current.address ?? "", next.account)) {
      sessionRef.current = next;
      if (mounted.current) setSession({...next, rows: [...next.rows]});
    }
  };
  let plan: Plan | null = null;
  let planError = "";
  if (settings) {
    try {
      if (!/^\d+(\.\d{0,2})?$/.test(ratio)) throw new Error("Enter a backing percentage with up to two decimal places.");
      plan = buildFwaPlan(parseEther(budget), quantity, BigInt(Math.round(Number(ratio) * 100)), spread, settings);
    } catch (e) {planError = e instanceof Error ? e.message : "Enter a valid eth budget.";}
  }
  const visibleRows = session?.rows.map(r => ({...r, value: BigInt(r.value), backing: BigInt(r.backing)})) ?? plan?.rows ?? [];
  const blocker = settings ? depositBlocker(settings, visibleRows) : null;
  const minted = session?.rows.filter(r => r.packId !== undefined).length ?? 0;
  const deposited = session?.rows.filter(r => r.listingId !== undefined).length ?? 0;
  const complete = !!session && deposited === session.rows.length;
  const allMinted = !!session && minted === session.rows.length;
  const totalPackValue = visibleRows.reduce((s, r) => s + r.value, 0n);
  const totalBacking = visibleRows.reduce((s, r) => s + r.backing, 0n);
  const feeEstimate = settings ? visibleRows.reduce((s, r) => s + r.counts.reduce((v, n) => v + BigInt(n) * settings.mintFee, 0n), 0n) : 0n;
  const walletReady = (account: Address) => {
    if (!mounted.current || !same(wallet.current.address ?? "", account) || wallet.current.chainId !== 1) throw new Error("Your wallet or network changed. Reconnect to Ethereum to continue.");
  };

  const run = async () => {
    if (running.current || !ready || !address || !supported) return;
    const account = address;
    running.current = true; setBusy(true); setError(""); setActiveHash(null);
    let work: FwaSession | null = null;
    try {
      walletReady(account);
      const live = await refresh();
      walletReady(account);
      work = sessionRef.current ? structuredClone(sessionRef.current) : null;
      if (!work) {
        if (!plan) throw new Error(planError || "Review the pack configuration first.");
        // Recompute using freshly read prices; never silently accept a changed plan.
        const fresh = buildFwaPlan(parseEther(budget), quantity, BigInt(Math.round(Number(ratio) * 100)), spread, live);
        if (fresh.total !== plan.total || fresh.rows.some((r, i) => r.value !== plan!.rows[i].value || r.fee !== plan!.rows[i].fee)) throw new Error("The mint quote changed. Review the updated plan and try again.");
        work = {version: 1, account, draft: {budget, quantity, ratio, spread}, rows: fresh.rows.map(r => ({counts: r.counts, value: String(r.value), backing: String(r.backing), fee: String(r.fee)}))};
        try {localStorage.setItem(sessionKey(account), JSON.stringify(work));} catch {setStorageWarning(true); throw new Error("Enable browser storage before minting so your transaction progress can be recovered.");}
        save(work);
      }
      const current = work;
      const send = async (target: Address, abi: Abi, functionName: string, args: readonly unknown[], value: bigint | undefined, record: (hash: Hash) => void) => {
        walletReady(account);
        const call = {address: target, abi, functionName, args, value, account} as const;
        await client.simulateContract(call);
        const gas = bufferGas(await client.estimateContractGas(call));
        const block = await client.getBlock();
        if (gas > packsGasBudget(block.gasLimit)) throw new Error("This transaction is too large. Use fewer shapes per pack.");
        const balance = await client.getBalance({address: account});
        if (balance < (value ?? 0n) + gas * await client.getGasPrice()) throw new Error("Your wallet needs more eth for this transaction and network gas.");
        walletReady(account);
        const hash = await writeContractAsync({...call, gas, chainId: 1});
        record(hash); save(current);
        if (mounted.current && same(wallet.current.address ?? "", account)) setActiveHash(hash);
        return hash;
      };
      const wait = async (hash: Hash, call: {address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint}, clear: () => void) => {
        // A network timeout preserves the hash. Only a confirmed revert permits resubmission.
        let cancelled = false;
        const receipt = await client.waitForTransactionReceipt({hash, onReplaced: ({reason, transaction}) => {
          if (reason === "cancelled") cancelled = true;
          for (const row of current.rows) {
            if (row.mintHash === hash) row.mintHash = transaction.hash;
            if (row.depositHash === hash) row.depositHash = transaction.hash;
          }
          if (current.approvalHash === hash) current.approvalHash = transaction.hash;
          save(current);
        }});
        if (cancelled) {clear(); save(current); throw new Error("The transaction was cancelled in your wallet. Continue when you are ready to retry.");}
        if (receipt.status === "reverted") {clear(); save(current); await awaitSuccessfulReceipt(client, receipt.transactionHash, call);}
        return receipt;
      };
      for (let i = 0; i < current.rows.length; i++) {
        const row = current.rows[i];
        if (row.packId !== undefined) continue;
        walletReady(account);
        setMessage(`Minting pack ${i + 1} of ${current.rows.length}. Confirm each transaction in your wallet.`);
        const quote = await client.readContract({address: PACKS, abi: packsAbi, functionName: "quoteMint", args: [row.counts]});
        if (quote[0] !== BigInt(row.value)) throw new Error("The saved pack makeup does not match its value.");
        const plannedFee = BigInt(row.fee);
        if (!row.mintHash && quote[1] !== plannedFee) throw new Error("Mint fees changed. Refresh and review before continuing.");
        // Reserve all remaining pack payments and FWA backing before the next mint.
        const remaining = current.rows.reduce((s, r) => s + (r.listingId === undefined ? BigInt(r.backing) : 0n) +
          (r.packId === undefined ? BigInt(r.value) + r.counts.reduce((v, n) => v + BigInt(n) * live.mintFee, 0n) : 0n), 0n);
        if (!row.mintHash && await client.getBalance({address: account}) <= remaining) throw new Error("Your wallet needs enough eth for the remaining packs, FWA backing, and network gas.");
        const call = {address: PACKS, abi: packsAbi, functionName: "createPack", args: [[], row.counts], value: quote[2]} as const;
        const hash = row.mintHash ?? await send(PACKS, packsAbi, "createPack", [[], row.counts], quote[2], h => {row.mintHash = h;});
        const receipt = await wait(hash, call, () => {delete row.mintHash;});
        row.packId = String(mintedPackId(receipt, account)); save(current);
      }
      walletReady(account);
      // Mint and deposit are separate review steps, even when admission is already live.
      if (!allMinted) {setMessage("Your packs are ready. Review the FWA backing, then continue to deposit."); return;}
      const depositSettings = await refresh();
      walletReady(account);
      const blocked = depositBlocker(depositSettings, current.rows.filter(r => r.listingId === undefined).map(r => ({backing: BigInt(r.backing)})));
      if (blocked) throw new Error(blocked);
      if (current.approvalHash) {
        setMessage("Checking your FWA approval transaction…");
        await wait(current.approvalHash, {address: PACKS, abi: packTransferAbi, functionName: "setApprovalForAll", args: [FWA_POOL, true]}, () => {delete current.approvalHash;});
        delete current.approvalHash; save(current);
      }
      const approved = await client.readContract({address: PACKS, abi: packTransferAbi, functionName: "isApprovedForAll", args: [account, FWA_POOL]});
      if (!approved) {
        setMessage("Approve FWA to transfer your shape packs. Deposits remain separate transactions.");
        const hash = await send(PACKS, packTransferAbi, "setApprovalForAll", [FWA_POOL, true], undefined, h => {current.approvalHash = h;});
        await wait(hash, {address: PACKS, abi: packTransferAbi, functionName: "setApprovalForAll", args: [FWA_POOL, true]}, () => {delete current.approvalHash;});
        delete current.approvalHash; save(current);
      }
      for (let i = 0; i < current.rows.length; i++) {
        const row = current.rows[i];
        if (row.listingId !== undefined) continue;
        walletReady(account);
        setMessage(`Depositing pack ${i + 1} of ${current.rows.length}. Confirm its FWA backing in your wallet.`);
        const call = {address: FWA_POOL, abi: fwaAbi, functionName: "listNFT", args: [PACKS, BigInt(row.packId!)], value: BigInt(row.backing)} as const;
        if (!row.depositHash) {
          const owner = await client.readContract({address: PACKS, abi: packsAbi, functionName: "ownerOf", args: [BigInt(row.packId!)]});
          if (!same(owner, account)) throw new Error(`Your wallet no longer owns pack #${row.packId}. Check FWA before continuing.`);
        }
        const hash = row.depositHash ?? await send(FWA_POOL, fwaAbi, "listNFT", call.args, call.value, h => {row.depositHash = h;});
        const receipt = await wait(hash, call, () => {delete row.depositHash;});
        Object.assign(row, depositedListing(receipt, account, BigInt(row.packId!))); save(current);
      }
      setMessage("All packs deposited. Your wallet owns the FWA positions.");
    } catch (e) {
      if (mounted.current && same(wallet.current.address ?? "", account)) setError(describeTxError(e));
    } finally {running.current = false; if (mounted.current) {setBusy(false); setActiveHash(null);}}
  };
  const reset = () => {
    if (busy || !address) return;
    if (!resetConfirm && (session || recoveryFailed) && !complete) {setResetConfirm(true); return;}
    try {localStorage.removeItem(sessionKey(address));} catch {setStorageWarning(true);}
    sessionRef.current = null; setSession(null); setRecoveryFailed(false); setMessage(""); setError(""); setResetConfirm(false);
  };
  const actionLabel = complete ? "All packs deposited" : !address ? "Connect wallet" : chainId !== 1 ? "Switch to Ethereum" : busy ? "Waiting for confirmation…" : !session ? `Mint ${quantity === 1 ? "pack" : `${quantity} packs`}` : !allMinted ? "Continue minting" : "Approve and deposit";
  const actionDisabled = recoveryFailed || !supported || busy || checking || !ready || complete || (!!address && chainId === 1 && (!settings || (!session && !plan) || (allMinted && !!blocker)));

  return <main className="fwa-page">
    <section className="fwa-intro">
      <div><p className="fwa-eyebrow">shapes × FWA / Ethereum</p><h1>Put your eth<br/>in the pool.</h1>
        <p className="fwa-lede">Create shape packs for the FWA main pool. Choose your split, add eth backing, and deposit directly from your wallet.</p>
        <a className="fwa-text-link" href="https://www.fwa.fun" target="_blank" rel="noreferrer">Explore FWA ↗</a></div>
      <div className="fwa-explainer"><span>Two places for your eth</span><div><b>01</b><p><strong>Inside each pack</strong>Redeemable eth held by its underlying shapes.</p></div><div><b>02</b><p><strong>Alongside it in FWA</strong>Separate eth funding the pool’s standing bid.</p></div><small>The purchaser chooses the pack or FWA’s bid. They receive one.</small></div>
    </section>
    {!supported && <div className="fwa-notice" role="alert">This page is available on the Ethereum mainnet shapes site.</div>}
    <div className="fwa-workspace">
      <section className="fwa-config" aria-label="Configure shape packs">
        <p className="fwa-eyebrow">01 / Configure</p><h2>Your pool contribution</h2>
        <fieldset disabled={busy || !!session}>
          <label className="fwa-label" htmlFor="fwa-budget">Total eth budget</label>
          <div className="fwa-amount"><input id="fwa-budget" inputMode="decimal" value={budget} onChange={e => setBudget(e.target.value)} autoComplete="off"/><span>eth</span></div>
          <p className="fwa-hint">Includes pack value, FWA backing, and mint fees. Keep extra eth for gas.</p>
          <label className="fwa-label" htmlFor="fwa-ratio">FWA backing as a percentage of pack value</label>
          <div className="fwa-pills">{[50, 100, 200].map(n => <button key={n} type="button" aria-pressed={ratio === String(n)} onClick={() => setRatio(String(n))}>{n}%{n === 100 ? " · equal" : ""}</button>)}<div className="fwa-custom"><input aria-label="Custom backing percentage" id="fwa-ratio" inputMode="decimal" value={ratio} onChange={e => setRatio(e.target.value)}/><span>%</span></div></div>
          <p className="fwa-hint">At 100%, a 0.25 eth pack gets another 0.25 eth of FWA backing. Higher FWA backing lowers its draw chance.</p>
          <div className="fwa-quantity"><label className="fwa-label" htmlFor="fwa-quantity">Number of packs</label><div><button type="button" aria-label="Fewer packs" disabled={quantity <= 1} onClick={() => setQuantity(q => q - 1)}>−</button><input id="fwa-quantity" type="number" min={1} max={24} value={quantity} onChange={e => setQuantity(Number(e.target.value))}/><button type="button" aria-label="More packs" disabled={quantity >= 24} onClick={() => setQuantity(q => q + 1)}>+</button></div></div>
          <label className="fwa-label">How to split it</label><div className="fwa-split">{[false, true].map(v => <button key={String(v)} type="button" aria-pressed={spread === v} onClick={() => setSpread(v)}><strong>{v ? "A range of sizes" : "Equal packs"}</strong><span>{v ? "Small through large" : "The same value in every pack"}</span></button>)}</div>
        </fieldset>
        {session && <p className="fwa-hint">Your plan is saved for this wallet. Finish it or start a new plan below.</p>}
        <div className="fwa-pool-check"><div><span className={`fwa-dot ${settings && !blocker ? "fwa-dot-live" : ""}`}/><strong>{checking ? "Checking pool…" : settings ? "Pool checked onchain" : "Pool check unavailable"}</strong><button type="button" disabled={checking || busy || !supported} onClick={() => void refresh().catch(() => {})}>Refresh</button></div>
          {settings && <p>Pack minimum {eth(settings.minimumPack)} eth · FWA minimum {eth(settings.minimumBacking)} eth</p>}
          {blocker && <p>{blocker}</p>}{settingsError && <p role="alert">{settingsError}</p>}
        </div>
      </section>
      <section className="fwa-preview" aria-label="Your pack plan">
        <div className="fwa-preview-heading"><p className="fwa-eyebrow">02 / Review your packs</p><span>{visibleRows.length} packs</span></div>
        <div className="fwa-pack-grid">{visibleRows.map((row, i) => <PackCard key={i} counts={row.counts} settings={settings} value={row.value} backing={row.backing} index={i} packId={session?.rows[i]?.packId} done={session?.rows[i]?.listingId !== undefined}/>)}</div>
        {!visibleRows.length && <div className="fwa-empty">{checking ? "Reading mint fees and pool requirements…" : planError || "Your pack preview will appear once the contract checks complete."}</div>}
        <dl className="fwa-totals"><div><dt>Redeemable value in packs</dt><dd>{eth(totalPackValue)} eth</dd></div><div><dt>Separate FWA backing</dt><dd>{eth(totalBacking)} eth</dd></div><div><dt>{session ? "Mint fees at current rate" : "Mint fees"}</dt><dd>{eth(feeEstimate)} eth</dd></div><div className="fwa-total"><dt>Total before gas</dt><dd>{eth(totalPackValue + totalBacking + feeEstimate)} eth</dd></div></dl>
        {!session && plan && <p className="fwa-hint">{eth(plan.remainder)} eth left in your wallet, before gas. Pack values round to valid shapes denominations.</p>}
      </section>
    </div>
    <section className="fwa-execute" aria-label="Mint and deposit">
      <div className="fwa-steps"><div className={allMinted || complete ? "fwa-step-done" : "fwa-step-current"}><span>01</span><strong>Mint packs</strong><small>{session ? `${minted} of ${session.rows.length} ready` : "Created in your wallet"}</small></div><div className={complete ? "fwa-step-done" : allMinted ? "fwa-step-current" : ""}><span>02</span><strong>Approve & deposit</strong><small>{session ? `${deposited} of ${session.rows.length} deposited` : "You own the FWA positions"}</small></div><div className={complete ? "fwa-step-current" : ""}><span>03</span><strong>Manage on FWA</strong><small>View positions and earnings</small></div></div>
      {session && <div className="fwa-progress">{session.rows.map((row, i) => <div key={i}><span>{row.packId ? `pack #${row.packId}` : `pack ${i + 1}`}</span><span>{row.listingId ? `${row.staged ? "Queued" : "Deposited"} · position #${row.listingId}` : row.depositHash ? "Deposit awaiting confirmation" : row.packId ? "Ready to deposit" : row.mintHash ? "Mint awaiting confirmation" : "Not minted"}</span>{(row.depositHash || row.mintHash) && <a href={`https://etherscan.io/tx/${row.depositHash ?? row.mintHash}`} target="_blank" rel="noreferrer">Transaction ↗</a>}</div>)}</div>}
      <div className="fwa-action-row"><div><p>Every action comes from your wallet.</p><small>Each pack needs a mint and deposit transaction. FWA approval is requested if needed.</small></div><button className="fwa-primary" type="button" disabled={actionDisabled} onClick={() => !address ? onConnect() : chainId !== 1 ? void switchChainAsync({chainId: 1}).catch(e => setError(describeTxError(e))) : void run()}>{actionLabel} <span aria-hidden="true">↗</span></button></div>
      <div aria-live="polite" className="fwa-feedback">{message && <p>{message}</p>}{error && <p role="alert">{error}</p>}{activeHash && <a href={`https://etherscan.io/tx/${activeHash}`} target="_blank" rel="noreferrer">View pending transaction ↗</a>}{storageWarning && <p>Browser storage is unavailable. Keep this page open and save your transaction links to retain progress.</p>}</div>
      <div className="fwa-bottom-links"><a href="https://www.fwa.fun/manage" target="_blank" rel="noreferrer">Manage positions on FWA ↗</a>{(session || recoveryFailed) && <button type="button" disabled={busy} onClick={reset}>{resetConfirm ? "Confirm new plan" : "Start a new plan"}</button>}</div>
      {resetConfirm && <p className="fwa-hint">Starting a new plan clears this browser’s checklist. Existing packs and FWA positions remain in your wallet and on FWA. Save any pending transaction links first. <button type="button" onClick={() => setResetConfirm(false)}>Keep this plan</button></p>}
    </section>
    <section className="fwa-notes"><div><p className="fwa-eyebrow">About the split</p><p>Every active position receives an equal share of distributable eth purchase fees. More packs create more positions and change your total draw exposure. Earnings depend on pool activity and how long each position remains active.</p></div><div><p className="fwa-eyebrow">When a pack is drawn</p><p>{settings ? `FWA’s current eth cashout is ${Number(settings.cashoutBps) / 100}% of its backing. If the purchaser keeps the pack, FWA returns your separate backing less its ${Number(settings.settlementFeeBps) / 100}% settlement fee.` : "The purchaser can keep the pack or accept FWA’s bid. Settlement fees and payout rates are set by FWA."} Deposits can queue before activation. Withdrawal timing follows FWA’s pool and crown rules.</p><a href="https://www.fwa.fun/docs/fees" target="_blank" rel="noreferrer">Read FWA’s rules ↗</a></div></section>
  </main>;
}
function PackCard({counts, settings, value, backing, index, packId, done}: {counts: number[]; settings: FwaSettings | null; value: bigint; backing: bigint; index: number; packId?: string; done: boolean}) {
  const images = React.useMemo(() => {
    if (!settings) return [];
    return counts.flatMap((n, di) => Array.from({length: Math.min(n, 3)}, (_, j) => {
      const amount = settings.denominations[di];
      const seed = sampleSeed(BigInt(index * 100 + di * 10 + j + 1));
      return localArt(seed, amount, mintGene(seed, amount));
    })).slice(0, 3);
  }, [counts, settings, index]);
  return <article className="fwa-pack-card"><div className="fwa-card-top"><span>{packId ? `pack #${packId}` : `pack ${String(index + 1).padStart(2, "0")}`}</span><span>{done ? "Deposited ✓" : "shape pack"}</span></div><div className="fwa-pack-art" aria-label="Illustrative shapes preview">{images.map((src, i) => <img key={i} src={src} alt="" style={{transform: `translate(${(i - 1) * 30}px, ${(i - 1) * -8}px) rotate(${(i - 1) * 9}deg)`}}/>)}</div><div className="fwa-card-value">{eth(value)} <span>eth</span></div><div className="fwa-card-backing">+ {eth(backing)} eth in FWA</div><small>{counts.reduce((s, n) => s + n, 0)} underlying shapes · artwork preview</small></article>;
}
