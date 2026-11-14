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
  FWA_POOL, PACKS, buildFwaPlan, depositBlocker, depositedListing, fwaAbi, fwaCosts, loadFwaSettings,
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
  const [quantity, setQuantity] = React.useState(1);
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
  const [txPhase, setTxPhase] = React.useState<"checking" | "wallet" | "pending">("checking");
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
      if (!/^\d+(\.\d{0,18})?$/.test(budget)) throw new Error("Enter an eth budget with up to 18 decimal places.");
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
  const {packValue: totalPackValue, backing: totalBacking, fees: feeEstimate, mintPayment, remainingMintPayment, remainingBacking} = fwaCosts(session?.rows ?? plan?.rows ?? []);
  const hasQuote = !!session || !!plan;
  const availabilityBlocked = !settings || !!blocker || !supported;
  const quantityLabel = `${visibleRows.length || quantity} ${visibleRows.length === 1 || (!visibleRows.length && quantity === 1) ? "pack" : "packs"}`;
  const pendingTransaction = session?.rows.some(r => (r.mintHash && r.packId === undefined) || (r.depositHash && r.listingId === undefined)) || !!session?.approvalHash;
  const hasBroadcasts = !!session && (!!session.approvalHash || session.rows.some(r => r.mintHash || r.depositHash));
  const walletReady = (account: Address) => {
    if (!mounted.current || !same(wallet.current.address ?? "", account) || wallet.current.chainId !== 1) throw new Error("Your wallet or network changed. Reconnect to Ethereum to continue.");
  };

  const run = async () => {
    if (running.current || !ready || !address || !supported) return;
    const account = address;
    running.current = true; setBusy(true); setError(""); setActiveHash(null); setTxPhase("checking"); setMessage("Checking your FWA deposit…");
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
        const blocked = depositBlocker(live, fresh.rows);
        if (blocked) throw new Error(blocked);
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
        setTxPhase("wallet"); setActiveHash(null);
        const hash = await writeContractAsync({...call, gas, chainId: 1});
        record(hash); save(current);
        if (mounted.current && same(wallet.current.address ?? "", account)) {setActiveHash(hash); setTxPhase("pending");}
        return hash;
      };
      const wait = async (hash: Hash, call: {address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint}, clear: () => void) => {
        // A network timeout preserves the hash. Only a confirmed revert permits resubmission.
        if (mounted.current && same(wallet.current.address ?? "", account)) {setActiveHash(hash); setTxPhase("pending");}
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
        if (!row.mintHash) {const blocked = depositBlocker(live, current.rows.map(r => ({backing: BigInt(r.backing)}))); if (blocked) throw new Error(blocked);}
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
    if (!resetConfirm && (hasBroadcasts || recoveryFailed) && !complete) {setResetConfirm(true); return;}
    try {localStorage.removeItem(sessionKey(address));} catch {setStorageWarning(true);}
    sessionRef.current = null; setSession(null); setRecoveryFailed(false); setMessage(""); setError(""); setResetConfirm(false);
  };
  const actionLabel = complete ? "Deposited in FWA" : busy ? txPhase === "checking" ? "Preparing your deposit…" : txPhase === "wallet" ? "Confirm in your wallet…" : "Confirming transaction…" : availabilityBlocked ? "FWA deposits unavailable" : !address ? "Connect wallet to continue" : chainId !== 1 ? "Switch to Ethereum" : !session ? `Create ${quantityLabel}` : !allMinted ? "Continue creating packs" : "Deposit in FWA";
  const actionDisabled = recoveryFailed || availabilityBlocked || busy || !ready || complete || (!session && !plan);
  const availabilityTitle = !supported ? "FWA deposits require Ethereum mainnet" : !settings ? settingsError ? "Couldn’t check FWA availability" : "Checking FWA availability…" : settings.withdrawOnly ? "FWA deposits are paused" : !settings.admitted ? "FWA deposits for shape packs are not live yet" : blocker ? "This configuration can’t be deposited in FWA" : "Ready for the FWA main pool";
  const recover = async () => {
    if (!session || busy) return;
    setBusy(true); setTxPhase("checking"); setError(""); setMessage("Checking your saved transactions…");
    try {save(await reconcileFwaSession(client, session)); setRecoveryFailed(false); setMessage("Transaction progress updated.");}
    catch (e) {setError(describeTxError(e));}
    finally {setBusy(false);}
  };

  return <main className="fwa-page">
    <header className="fwa-intro">
      <p className="fwa-eyebrow">FWA V2 · Main pool · Ethereum</p>
      <h1>shape packs for FWA</h1>
      <p className="fwa-lede">Turn eth into shape packs and deposit them in the FWA main pool to earn a share of purchase fees.</p>
      <a className="fwa-text-link" href="https://www.fwa.fun" target="_blank" rel="noreferrer">Explore FWA ↗</a>
    </header>

    <div className={`fwa-availability ${availabilityBlocked ? "fwa-availability-wait" : "fwa-availability-ready"}`} role="status">
      <span className={`fwa-dot ${!availabilityBlocked ? "fwa-dot-live" : ""}`}/>
      <div><strong>{availabilityTitle}</strong>
        {availabilityBlocked && <p>{!supported ? "Open this page on the mainnet shapes site to prepare an FWA deposit." : !settings ? "You can explore the options. Contract checks must complete before you create packs for FWA." : !settings.admitted ? "You can plan your deposit below. Creating packs here becomes available when FWA accepts them." : blocker}</p>}
      </div>
      <button type="button" disabled={checking || busy || !supported} onClick={() => void refresh().catch(() => {})}>{checking ? "Checking…" : "Check again"}</button>
    </div>

    <div className="fwa-workspace">
      <section className="fwa-config" aria-labelledby="fwa-config-title">
        <h2 id="fwa-config-title">Plan your FWA deposit</h2>
        <fieldset disabled={busy || !!session}>
          <label className="fwa-label" htmlFor="fwa-budget">How much eth do you want to use?</label>
          <div className="fwa-amount"><input id="fwa-budget" inputMode="decimal" value={budget} onChange={e => setBudget(e.target.value)} autoComplete="off" aria-describedby="fwa-budget-hint" aria-invalid={!!planError}/><span>eth</span></div>
          <p id="fwa-budget-hint" className="fwa-hint">Your total for the packs, FWA backing, and mint fees. Gas is extra.</p>

          <div className="fwa-quantity"><label className="fwa-label" htmlFor="fwa-quantity">How many packs?</label><div><button type="button" aria-label="Fewer packs" disabled={quantity <= 1} onClick={() => setQuantity(q => q - 1)}>−</button><input id="fwa-quantity" type="number" min={1} max={24} value={quantity} onChange={e => setQuantity(Number(e.target.value))} aria-describedby="fwa-quantity-hint"/><button type="button" aria-label="More packs" disabled={quantity >= 24} onClick={() => setQuantity(q => q + 1)}>+</button></div></div>
          <p id="fwa-quantity-hint" className="fwa-hint">Each pack becomes one FWA position. More packs mean more wallet transactions.</p>

          <div className="fwa-default"><span>FWA eth matching</span><strong>{ratio === "100" ? "1:1 with pack value" : `${ratio}% of pack value`}</strong><p>{hasQuote && visibleRows[0] ? `${eth(visibleRows[0].value)} eth in ${quantity === 1 ? "your pack" : "the first pack"} + ${eth(visibleRows[0].backing)} eth backing in FWA.` : ratio === "100" ? "Equal amounts go into the packs and FWA backing, before mint fees." : "FWA backing is separate from the redeemable eth inside each pack."}</p></div>

          <details className="fwa-options">
            <summary>Customize matching and pack sizes<span>{ratio !== "100" || (spread && quantity > 1) ? "Customized" : "Optional"}</span></summary>
            <label className="fwa-label" htmlFor="fwa-ratio">FWA backing relative to pack value</label>
            <div className="fwa-pills">{[50, 100, 200].map(n => <button key={n} type="button" aria-pressed={ratio === String(n)} onClick={() => setRatio(String(n))}>{n / 100}×{n === 100 ? " · equal" : ""}</button>)}<div className="fwa-custom"><input aria-label="Custom FWA backing percentage" id="fwa-ratio" inputMode="decimal" value={ratio} onChange={e => setRatio(e.target.value)}/><span>%</span></div></div>
            <p className="fwa-hint">1× matches each pack’s value. Higher FWA backing lowers its chance of being drawn. Pack value stays redeemable separately.</p>
            {quantity > 1 && <div role="group" aria-labelledby="fwa-split-label"><p className="fwa-label" id="fwa-split-label">Pack sizes</p><div className="fwa-split">{[false, true].map(v => <button key={String(v)} type="button" aria-pressed={spread === v} onClick={() => setSpread(v)}><strong>{v ? "Small to large" : "Equal value"}</strong><span>{v ? "Values increase evenly" : "Same amount in each pack"}</span></button>)}</div></div>}
          </details>
        </fieldset>
        {planError && !session && <p className="fwa-input-error" role="alert">{planError}</p>}
        {session && <p className="fwa-hint">This deposit is saved for your wallet. {hasBroadcasts ? "The amounts are fixed while you finish the transactions." : "You can edit it before the first transaction."}</p>}
        {session && !hasBroadcasts && <button className="fwa-edit" type="button" disabled={busy} onClick={reset}>Edit this deposit</button>}
        <details className="fwa-learn"><summary>How does depositing in FWA work?</summary>
          <p>Your pack holds redeemable eth. FWA holds a separate eth amount as its standing bid. A purchaser can keep the pack or accept FWA’s bid.</p>
          <p>Active positions share distributable eth purchase fees equally. More packs add positions and change your total draw exposure. Income depends on activity and how long each position stays in the pool.</p>
          {settings && <p>A new pack needs at least {eth(settings.minimumPack)} eth inside it. Each FWA position needs at least {eth(settings.minimumBacking)} eth of separate backing.</p>}
          <p>{settings ? `FWA’s current eth cashout is ${Number(settings.cashoutBps) / 100}% of its backing. If the purchaser keeps the pack, FWA returns your backing less its ${Number(settings.settlementFeeBps) / 100}% settlement fee.` : "Cashout amounts and settlement fees follow FWA’s current settings."} Withdrawals follow FWA’s pool and crown rules.</p>
          <a href="https://www.fwa.fun/docs/fees" target="_blank" rel="noreferrer">FWA fees and rules ↗</a>
        </details>
      </section>

      <section className="fwa-preview" aria-labelledby="fwa-review-title">
        <div className="fwa-preview-heading"><h2 id="fwa-review-title">{complete ? "Your FWA positions" : "Your FWA deposit"}</h2><span>{hasQuote ? quantityLabel : planError ? "Review your options" : "Calculating…"}</span></div>
        {visibleRows.length > 0 ? <div className="fwa-pack-list"><div className="fwa-pack-head" aria-hidden="true"><span>Pack</span><span>Pack value</span><span>FWA backing</span></div>{visibleRows.map((row, i) => <PackRow key={i} counts={row.counts} settings={settings} value={row.value} backing={row.backing} index={i} progress={session?.rows[i]}/>)}</div> : <div className="fwa-empty">{planError ? "Adjust your budget or pack options to see the deposit." : "Reading current mint fees and FWA requirements…"}</div>}
        <dl className="fwa-totals">
          <div><dt>eth inside packs<small>Redeemable by the pack holder</small></dt><dd>{hasQuote ? `${eth(totalPackValue)} eth` : "..."}</dd></div>
          <div><dt>FWA eth backing<small>Separate backing for the pool’s bid</small></dt><dd>{hasQuote ? `${eth(totalBacking)} eth` : "..."}</dd></div>
          <div><dt>Mint fees</dt><dd>{hasQuote ? `${eth(feeEstimate)} eth` : "..."}</dd></div>
          <div className="fwa-total"><dt>Total for this deposit</dt><dd>{hasQuote ? `${eth(mintPayment + totalBacking)} eth` : "..."}</dd></div>
        </dl>
        {!session && plan && <p className="fwa-hint">Unused budget: {eth(plan.remainder)} eth. Gas is extra.</p>}

        <section className="fwa-execute" aria-label="Create packs and deposit in FWA">
          <ol className="fwa-steps"><li className={allMinted ? "fwa-step-done" : "fwa-step-current"}><span>{allMinted ? "✓" : "1"}</span><div><strong>Create {quantityLabel}</strong><small>{session ? `${minted} of ${session.rows.length} created` : hasQuote ? `${eth(mintPayment)} eth` : "Mint to your wallet"}</small></div></li><li className={complete ? "fwa-step-done" : allMinted ? "fwa-step-current" : ""}><span>{complete ? "✓" : "2"}</span><div><strong>Deposit in FWA</strong><small>{session ? `${deposited} of ${session.rows.length} deposited` : hasQuote ? `${eth(totalBacking)} eth` : "Add separate backing"}</small></div></li></ol>
          {session && !complete && hasQuote && <p className="fwa-remaining"><span>Still needed before gas</span><strong>{eth(remainingMintPayment + remainingBacking)} eth</strong></p>}
          {complete ? <a className="fwa-primary" href="https://www.fwa.fun/manage" target="_blank" rel="noreferrer">View positions on FWA ↗</a> : <button className="fwa-primary" type="button" disabled={actionDisabled} onClick={() => !address ? onConnect() : chainId !== 1 ? void switchChainAsync({chainId: 1}).catch(e => setError(describeTxError(e))) : void run()}>{actionLabel}</button>}
          <p className="fwa-action-hint">{complete ? "Your wallet holds the FWA position rights. Queued deposits start earning after activation." : availabilityBlocked ? "Creating packs for FWA opens when its deposit requirements pass." : allMinted ? `Confirm ${session!.rows.length - deposited} deposit ${session!.rows.length - deposited === 1 ? "transaction" : "transactions"} in your wallet. FWA approval is requested first if needed.` : `Create the packs first, then return here to deposit in FWA. Each pack needs a separate mint and deposit transaction.`}</p>
          <div aria-live="polite" className="fwa-feedback">{message && <p>{message}</p>}{error && <p role="alert">{error}</p>}{activeHash && <a href={`https://etherscan.io/tx/${activeHash}`} target="_blank" rel="noreferrer">View pending transaction ↗</a>}{storageWarning && <p>Browser storage is unavailable. Keep this page open and save your transaction links to retain progress.</p>}</div>
          {session && (pendingTransaction || recoveryFailed) && <button className="fwa-edit" type="button" disabled={busy} onClick={() => void recover()}>Check saved transactions</button>}
          <div className="fwa-bottom-links"><a href="https://www.fwa.fun/manage" target="_blank" rel="noreferrer">Manage on FWA ↗</a>{(session || recoveryFailed) && (hasBroadcasts || complete || recoveryFailed) && <button type="button" disabled={busy || !!pendingTransaction} onClick={reset}>{resetConfirm ? "Confirm new deposit" : complete ? "Prepare another deposit" : "Start a new deposit"}</button>}</div>
          {resetConfirm && <p className="fwa-hint">Your packs and FWA positions stay onchain. This clears the saved checklist for this deposit. <button type="button" onClick={() => setResetConfirm(false)}>Keep this deposit</button></p>}
        </section>
      </section>
    </div>
    <p className="fwa-footer-note">For the <a href="https://www.fwa.fun" target="_blank" rel="noreferrer">FWA V2 main pool</a>. Transactions go directly from your wallet to the existing shapes and FWA contracts. <a href="/packs">Mint or manage shape packs without FWA</a>.</p>
  </main>;
}
function PackRow({counts, settings, value, backing, index, progress}: {counts: number[]; settings: FwaSettings | null; value: bigint; backing: bigint; index: number; progress?: FwaSession["rows"][number]}) {
  const images = React.useMemo(() => {
    if (!settings) return [];
    const previewDenominations = counts.flatMap((n, di) => Array.from({length: Math.min(n, 2)}, () => di)).slice(0, 2);
    return previewDenominations.map((di, j) => {
      const amount = settings.denominations[di];
      const seed = sampleSeed(BigInt(index * 100 + di * 10 + j + 1));
      return localArt(seed, amount, mintGene(seed, amount));
    });
  }, [counts, settings, index]);
  const status = progress?.listingId !== undefined ? `${progress.staged ? "Queued in FWA" : "In FWA"} · #${progress.listingId}` : progress?.depositHash ? "FWA deposit pending" : progress?.packId ? "Ready for FWA" : progress?.mintHash ? "Mint pending" : "New shape pack";
  return <article className="fwa-pack-row" aria-label={`pack ${index + 1}, ${eth(value)} eth value, ${eth(backing)} eth FWA backing`}><div className="fwa-pack-identity"><div className="fwa-pack-art" aria-hidden="true">{images.map((src, i) => <img key={i} src={src} alt="" style={{transform: `translateX(${i * 9}px) rotate(${i * 8 - 4}deg)`}}/>)}</div><div><strong>{progress?.packId ? `pack #${progress.packId}` : `pack ${String(index + 1).padStart(2, "0")}`}</strong><small>{status}</small>{(progress?.depositHash || progress?.mintHash) && <a href={`https://etherscan.io/tx/${progress.depositHash ?? progress.mintHash}`} target="_blank" rel="noreferrer">Transaction ↗</a>}</div></div><span>{eth(value)}<small>eth in pack</small></span><span>{eth(backing)}<small>eth in FWA</small></span></article>;
}
