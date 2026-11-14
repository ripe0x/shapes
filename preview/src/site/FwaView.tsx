import React from "react";
import "./FwaView.css";
import {formatEther, type Abi, type Address, type Hash} from "viem";
import {useAccount, useSwitchChain, useWriteContract} from "wagmi";
import {renderPack, type PackCard} from "shapes-render/pack";
import type {Deployment} from "../chain/abi";
import {packsAbi, packsClientFor, packsGasBudget} from "./packs";
import {awaitSuccessfulReceipt, bufferGas} from "./tx";
import {describeTxError} from "./errors";
import {Section, txUrl} from "./ui";
import {sampleSeed} from "./art";
import {mintGene} from "../previewGene";
import {
  FWA_POOL, PACKS, SHAPES, buildFwaContribution, parseFwaAmount, fwaPackRequirement, packMakeup,
  depositBlocker, depositedListing, fwaAbi, loadFwaSettings, mintedPackId, packTransferAbi,
  parseFwaSession, reconcileFwaSession, sessionKey, type FwaSession, type FwaSettings, type Plan,
} from "./fwa";

const client = packsClientFor(1);
const eth = (v: bigint | string) => formatEther(BigInt(v));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const DEFAULT_VALUES = ["0.01", "0.04", "0.05", "0.1", "0.15", "0.5"];
const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const makeup = (counts: number[], denominations: bigint[]) => counts.flatMap((n, i) => n ? [`${words[n] ?? n} ${eth(denominations[i])}`] : []).reverse().join(" and ") + (counts.find(n => n > 0) === 1 ? " shape" : " shapes");
type Choice = {value: string; quantity: number};
type DraftPack = {key: string; value: bigint};
const defaultChoices = (): Choice[] => DEFAULT_VALUES.map(value => ({value, quantity: value === "0.05" ? 3 : value === "0.1" ? 2 : 0}));

export function FwaView({dep, onConnect}: {dep: Deployment; onConnect: () => void}) {
  const {address, chainId} = useAccount();
  const {switchChainAsync} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const [budget, setBudget] = React.useState("0.75");
  const [choices, setChoices] = React.useState(defaultChoices);
  const [ratio, setRatio] = React.useState(10_000n);
  const [backings, setBackings] = React.useState<Record<string, string>>({});
  const [perPackExpanded, setPerPackExpanded] = React.useState(true);
  const [addingValue, setAddingValue] = React.useState(false);
  const [newValue, setNewValue] = React.useState("");
  const [addError, setAddError] = React.useState("");
  const [settings, setSettings] = React.useState<FwaSettings | null>(null);
  const [settingsError, setSettingsError] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const [walletBalance, setWalletBalance] = React.useState<bigint | null>(null);
  const [session, setSession] = React.useState<FwaSession | null>(null);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [step, setStep] = React.useState<"mint" | "approve" | "deposit">("mint");
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
  React.useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const supported = dep.chainId === 1 && same(dep.shapes, SHAPES);
  const refreshBalance = React.useCallback(async () => {
    const account = wallet.current.address;
    if (!account) return;
    try {const balance = await client.getBalance({address: account}); if (mounted.current && same(wallet.current.address ?? "", account)) setWalletBalance(balance);}
    catch {if (mounted.current && same(wallet.current.address ?? "", account)) setWalletBalance(null);}
  }, []);
  const refresh = React.useCallback(async () => {
    setChecking(true); setSettingsError("");
    try {const value = await loadFwaSettings(client); if (mounted.current) setSettings(value); return value;}
    catch (e) {if (mounted.current) {setSettings(null); setSettingsError(describeTxError(e));} throw e;}
    finally {if (mounted.current) setChecking(false);}
  }, []);
  React.useEffect(() => {
    if (!supported) return;
    void refresh().catch(() => {});
    const timer = window.setInterval(() => {if (!running.current) {void refresh().catch(() => {}); void refreshBalance();}}, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshBalance, supported]);
  React.useEffect(() => {
    let active = true;
    setWalletBalance(null); void refreshBalance();
    setReady(false); setRecoveryFailed(false); setSession(null); sessionRef.current = null;
    setError(""); setMessage(""); setActiveHash(null); setResetConfirm(false);
    const restore = async () => {
      if (!address) return;
      let raw: string | null = null;
      try {raw = localStorage.getItem(sessionKey(address));} catch {setStorageWarning(true);}
      if (!raw) return;
      const saved = parseFwaSession(raw, address);
      if (!saved) {if (active) {setRecoveryFailed(true); setError("Saved progress could not be read. Check your transaction history before starting a new plan.");} return;}
      if (active) {
        sessionRef.current = saved; setSession(saved);
        const grouped = new Map(DEFAULT_VALUES.map(value => [value, {value, quantity: 0}]));
        for (const row of saved.rows) {const value = eth(row.value); const group = grouped.get(value) ?? {value, quantity: 0}; group.quantity++; grouped.set(value, group);}
        setChoices([...grouped.values()]);
        setBudget(saved.draft?.budget || eth(saved.rows.reduce((s, r) => s + BigInt(r.value) + BigInt(r.backing) + BigInt(r.fee), 0n)));
      }
      try {
        const recovered = await reconcileFwaSession(client, saved);
        if (!active) return;
        try {localStorage.setItem(sessionKey(address), JSON.stringify(recovered));} catch {setStorageWarning(true);}
        sessionRef.current = recovered; setSession(recovered);
      } catch (e) {if (active) {setRecoveryFailed(true); setError(`Could not check saved transactions. ${describeTxError(e)}`);}}
    };
    void restore().finally(() => {if (active) setReady(true);});
    return () => {active = false;};
  }, [address, refreshBalance]);
  const save = (next: FwaSession) => {
    try {localStorage.setItem(sessionKey(next.account), JSON.stringify(next));} catch {if (mounted.current) setStorageWarning(true);}
    if (same(wallet.current.address ?? "", next.account)) {sessionRef.current = next; if (mounted.current) setSession({...next, rows: [...next.rows]});}
  };
  const chooseRatio = (next: bigint) => {setRatio(next); setBackings({});};
  const changeQuantity = (value: string, quantity: number) => {
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 24) return;
    setChoices(rows => rows.map(r => r.value === value ? {...r, quantity} : r));
    setBackings(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${parseFwaAmount(value)}:`) || Number(key.split(":")[1]) < quantity)));
  };
  const draftPacks: DraftPack[] = choices.filter(r => r.quantity > 0).sort((a, b) => parseFwaAmount(a.value) > parseFwaAmount(b.value) ? -1 : 1).flatMap(r => Array.from({length: r.quantity}, (_, i) => ({key: `${parseFwaAmount(r.value)}:${i}`, value: parseFwaAmount(r.value)})));
  const backingFor = (r: DraftPack) => backings[r.key] ?? eth(r.value * ratio / 10_000n);
  let plan: Plan | null = null;
  let planError = "";
  try {if (settings && !session) plan = buildFwaContribution(draftPacks.map(r => ({value: r.value, backing: parseFwaAmount(backingFor(r))})), settings, parseFwaAmount(budget));}
  catch (e) {planError = e instanceof Error ? e.message : "Review your contribution.";}
  const visibleRows = session?.rows.map(r => ({value: BigInt(r.value), backing: BigInt(r.backing), fee: BigInt(r.fee), counts: r.counts, payment: BigInt(r.value) + BigInt(r.fee)})) ?? plan?.rows ?? [];
  const totalPackValue = visibleRows.reduce((s, r) => s + r.value, 0n);
  const totalBacking = visibleRows.reduce((s, r) => s + r.backing, 0n);
  const feeEstimate = visibleRows.reduce((s, r) => s + r.fee, 0n);
  const total = totalPackValue + totalBacking + feeEstimate;
  const shapeCount = visibleRows.reduce((s, r) => s + r.counts.reduce((n, v) => n + v, 0), 0);
  const minted = session?.rows.filter(r => r.packId !== undefined).length ?? 0;
  const deposited = session?.rows.filter(r => r.listingId !== undefined).length ?? 0;
  const complete = !!session && deposited === session.rows.length;
  let budgetWei = 0n;
  try {budgetWei = parseFwaAmount(budget);} catch {/* The plan error names invalid input. */}
  const overage = total > budgetWei ? total - budgetWei : 0n;
  const remainingPayment = session ? session.rows.reduce((s, r) => s + (r.packId === undefined ? BigInt(r.value) + BigInt(r.fee) : 0n) + (r.listingId === undefined ? BigInt(r.backing) : 0n), 0n) : total;
  const balanceShortfall = walletBalance !== null && remainingPayment > walletBalance ? remainingPayment - walletBalance : 0n;
  const packIssues = settings ? visibleRows.map((row, i) => {const issue = session?.rows[i]?.listingId === undefined ? fwaPackRequirement(row, settings) : null; return issue ? `Pack ${i + 1}: ${issue}` : null;}).filter((v): v is string => !!v) : [];
  const poolBlocker = settings && !complete ? depositBlocker(settings, visibleRows.filter((_, i) => session?.rows[i]?.listingId === undefined)) : null;
  const requirement = !supported ? "This page requires the Ethereum mainnet shapes site." : recoveryFailed ? "Saved transactions must be checked before continuing." : settingsError || (!settings ? "Reading current requirements…" : planError || (!visibleRows.length ? "Choose at least one pack." : packIssues[0] || poolBlocker || (overage ? `This plan is ${eth(overage)} eth over budget.` : balanceShortfall ? `This plan is ${eth(balanceShortfall)} eth above your wallet balance.` : address && walletBalance === null ? "Reading wallet balance…" : null)));
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
        if (requirement) throw new Error(requirement);
        if (!plan) throw new Error(planError || "Review the pack configuration first.");
        // Recompute using freshly read prices; never silently accept a changed plan.
        const fresh = buildFwaContribution(draftPacks.map(r => ({value: r.value, backing: parseFwaAmount(backingFor(r))})), live, parseFwaAmount(budget));
        if (fresh.total !== plan.total || fresh.rows.some((r, i) => r.value !== plan!.rows[i].value || r.fee !== plan!.rows[i].fee || r.backing !== plan!.rows[i].backing)) throw new Error("The mint quote changed. Review the updated plan and try again.");
        const blocked = depositBlocker(live, fresh.rows) || fresh.rows.map(r => fwaPackRequirement(r, live)).find(Boolean);
        if (blocked) throw new Error(blocked);
        if (fresh.total > await client.getBalance({address: account})) throw new Error("This plan exceeds your wallet balance.");
        work = {version: 1, account, draft: {budget, quantity: fresh.rows.length, ratio: String(ratio), spread: false}, rows: fresh.rows.map(r => ({counts: r.counts, value: String(r.value), backing: String(r.backing), fee: String(r.fee)}))};
        try {localStorage.setItem(sessionKey(account), JSON.stringify(work));} catch {setStorageWarning(true); throw new Error("Enable browser storage before minting so your transaction progress can be recovered.");}
        save(work);
      }
      const current = work;
      const unlisted = current.rows.filter(r => r.listingId === undefined).map(r => ({value: BigInt(r.value), backing: BigInt(r.backing)}));
      const blockedAtStart = depositBlocker(live, unlisted) || unlisted.map(r => fwaPackRequirement(r, live)).find(Boolean);
      if (blockedAtStart) throw new Error(blockedAtStart);
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
        setStep("mint"); setMessage(`Minting pack ${i + 1} of ${current.rows.length}.`);
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
      const depositSettings = await refresh();
      walletReady(account);
      const blocked = depositBlocker(depositSettings, current.rows.filter(r => r.listingId === undefined).map(r => ({backing: BigInt(r.backing)})));
      if (blocked) throw new Error(blocked);
      setStep("approve");
      if (current.approvalHash) {
        setMessage("Checking your FWA approval transaction…");
        const receipt = await wait(current.approvalHash, {address: PACKS, abi: packTransferAbi, functionName: "setApprovalForAll", args: [FWA_POOL, true]}, () => {delete current.approvalHash;});
        current.approvalReceipt = receipt.transactionHash; delete current.approvalHash; save(current);
      }
      const approved = await client.readContract({address: PACKS, abi: packTransferAbi, functionName: "isApprovedForAll", args: [account, FWA_POOL]});
      if (!approved) {
        setMessage("Approving FWA.");
        const hash = await send(PACKS, packTransferAbi, "setApprovalForAll", [FWA_POOL, true], undefined, h => {current.approvalHash = h;});
        const receipt = await wait(hash, {address: PACKS, abi: packTransferAbi, functionName: "setApprovalForAll", args: [FWA_POOL, true]}, () => {delete current.approvalHash;});
        current.approvalReceipt = receipt.transactionHash; delete current.approvalHash; save(current);
      }
      setStep("deposit");
      for (let i = 0; i < current.rows.length; i++) {
        const row = current.rows[i];
        if (row.listingId !== undefined) continue;
        walletReady(account);
        setMessage(`Depositing pack ${i + 1} of ${current.rows.length}.`);
        const call = {address: FWA_POOL, abi: fwaAbi, functionName: "listNFT", args: [PACKS, BigInt(row.packId!)], value: BigInt(row.backing)} as const;
        if (!row.depositHash) {
          const owner = await client.readContract({address: PACKS, abi: packsAbi, functionName: "ownerOf", args: [BigInt(row.packId!)]});
          if (!same(owner, account)) throw new Error(`Your wallet no longer owns pack #${row.packId}. Check FWA before continuing.`);
        }
        const hash = row.depositHash ?? await send(FWA_POOL, fwaAbi, "listNFT", call.args, call.value, h => {row.depositHash = h;});
        const receipt = await wait(hash, call, () => {delete row.depositHash;});
        Object.assign(row, depositedListing(receipt, account, BigInt(row.packId!))); save(current);
      }
      setMessage("All packs deposited.");
    } catch (e) {
      if (mounted.current && same(wallet.current.address ?? "", account)) setError(describeTxError(e));
    } finally {running.current = false; if (mounted.current) {setBusy(false); setActiveHash(null); void refreshBalance();}}
  };
  const reset = () => {
    if (busy || !address) return;
    if (!resetConfirm && (session || recoveryFailed) && !complete) {setResetConfirm(true); return;}
    try {localStorage.removeItem(sessionKey(address));} catch {setStorageWarning(true);}
    sessionRef.current = null; setSession(null); setRecoveryFailed(false); setMessage(""); setError(""); setResetConfirm(false);
  };
  const addValue = (event: React.FormEvent) => {
    event.preventDefault(); setAddError("");
    try {
      const value = parseFwaAmount(newValue);
      if (!settings) throw new Error("Wait for current requirements.");
      if (value <= 0n) throw new Error("Enter a pack value above 0 eth.");
      packMakeup(value, settings.denominations);
      if (choices.some(r => parseFwaAmount(r.value) === value)) throw new Error("That pack value is already in the table.");
      setChoices(rows => [...rows, {value: eth(value), quantity: 0}].sort((a, b) => parseFwaAmount(a.value) < parseFwaAmount(b.value) ? -1 : 1));
      setAddingValue(false); setNewValue("");
    } catch (e) {setAddError(e instanceof Error ? e.message : "Enter a valid pack value.");}
  };
  const actionLabel = complete ? "DEPOSITED" : busy ? step === "mint" ? "MINTING" : step === "approve" ? "APPROVING" : "DEPOSITING" : address && chainId !== 1 ? "SWITCH TO ETHEREUM" : session ? "CONTINUE" : "REVIEW AND MINT";
  const actionDisabled = busy || checking || !ready || complete || !!requirement;
  const groups = choices.map(choice => {
    const value = parseFwaAmount(choice.value);
    const rows = visibleRows.filter(r => r.value === value);
    let counts: number[] = []; let issue: string | null = null;
    try {if (settings) counts = packMakeup(value, settings.denominations);} catch (e) {issue = (e as Error).message;}
    if (settings && choice.quantity) issue = rows.map(r => fwaPackRequirement(r, settings)).find(Boolean) ?? (value < settings.minimumPack ? `Minimum pack value is ${eth(settings.minimumPack)} eth.` : issue);
    return {...choice, valueWei: value, counts, issue, fee: settings ? counts.reduce((s, n) => s + BigInt(n) * settings.mintFee, 0n) : null, rows};
  });
  return <main className="fwa-page">
    <section className="fwa-hero"><h1>Back the FWA pool with shape packs.</h1><p>Mint eth backed shape packs, then deposit them into the FWA main V2 pool with separate eth backing. Each pack becomes its own position.</p></section>
    <div className="fwa-body">
      <div className="fwa-sections">
        <Section title="01 BUDGET" pad="28px 40px 40px 32px">
          <h2>How much eth will you commit?</h2><p className="fwa-help">Covers pack value, FWA backing and mint fees.</p>
          <div className="fwa-budget-row"><label className="fwa-budget-input"><input style={{width: `${Math.max(1, budget.length)}ch`, maxWidth: "calc(100% - 36px)"}} aria-label="eth budget" inputMode="decimal" value={budget} disabled={busy || !!session} onChange={e => setBudget(e.target.value)} autoComplete="off"/><span>eth</span></label><div className="fwa-balance"><span>wallet balance</span><strong>{walletBalance !== null ? `${eth(walletBalance)} eth` : address ? "Reading…" : "Connect wallet"}</strong></div></div>
        </Section>
        <Section title="02 PACKS" pad="28px 40px 40px 32px">
          <h2>Choose pack values and quantities.</h2><p className="fwa-help">Mint fees are charged per shape, so a pack's fee depends on the shapes it is made from.</p>
          <div className="fwa-table-scroll"><table className="fwa-pack-table"><colgroup>{[52,104,0,112,128,88].map((width, i) => <col key={i} style={width ? {width} : undefined}/>)}</colgroup><thead><tr><th aria-label="Artwork"/><th>PACK VALUE</th><th>MADE FROM</th><th>FEE PER PACK</th><th>QUANTITY</th><th>SUBTOTAL</th></tr></thead><tbody>{groups.map(row => <tr key={row.value} className={`${row.quantity ? "is-selected" : ""} ${row.issue ? "is-invalid" : ""}`}>
            <td><PackArt value={row.valueWei} settings={settings}/></td><td><span className="fwa-value-cell">{row.value} eth</span></td><td>{settings ? makeup(row.counts, settings.denominations) : "Reading…"}{row.issue && <span className="fwa-row-error">{row.issue}</span>}</td><td>{row.fee !== null ? `${eth(row.fee)} eth` : "Reading…"}</td>
            <td><div className="packs-stepper"><button type="button" className="btn-outline" aria-label={`Decrease ${row.value} eth packs`} disabled={busy || !!session || row.quantity <= 0} onClick={() => changeQuantity(row.value, row.quantity - 1)}>−</button><input className="qty-input" aria-label={`Quantity of ${row.value} eth packs`} type="number" min={0} max={24} value={row.quantity} disabled={busy || !!session} onChange={e => changeQuantity(row.value, Number(e.target.value))}/><button type="button" className="btn-outline" aria-label={`Increase ${row.value} eth packs`} disabled={busy || !!session || draftPacks.length >= 24} onClick={() => changeQuantity(row.value, row.quantity + 1)}>+</button></div></td><td>{row.quantity ? `${eth(row.valueWei * BigInt(row.quantity))} eth` : "·"}</td>
          </tr>)}</tbody></table></div>
          <div className="fwa-table-footer"><button type="button" className="fwa-text-button" disabled={busy || !!session} onClick={() => setAddingValue(v => !v)}>Add another pack value</button><span>{visibleRows.length} packs · {shapeCount} shapes · {eth(totalPackValue)} eth</span></div>
          {addingValue && <form className="fwa-add-value" onSubmit={addValue}><label>Pack value<input aria-label="New pack value" inputMode="decimal" value={newValue} onChange={e => setNewValue(e.target.value)} autoFocus/></label><button className="btn-outline" type="submit">ADD VALUE</button></form>}{addError && <p className="fwa-error" role="alert">{addError}</p>}
        </Section>
        <Section title="03 BACKING" pad="28px 40px 40px 32px">
          <h2>Set FWA backing.</h2><p className="fwa-help">Separate eth deposited alongside each pack. It funds the pool's bid.</p>
          <div className="fwa-backing-controls"><div className="shape-mode-toggle" role="group" aria-label="FWA backing ratio">{[5000n,10000n,15000n,20000n].map(n => <button key={String(n)} type="button" className={n === 10000n ? "fwa-caps" : ""} disabled={busy || !!session} aria-pressed={session ? session.rows.every(r => BigInt(r.backing) * 10_000n === BigInt(r.value) * n) : !Object.keys(backings).length && ratio === n} onClick={() => chooseRatio(n)}>{n === 10000n ? "EQUAL" : `${Number(n) / 10000}×`}</button>)}</div><button type="button" className="fwa-disclosure fwa-caps" aria-expanded={perPackExpanded} aria-controls="fwa-backing-list" onClick={() => setPerPackExpanded(v => !v)}>{perPackExpanded ? "HIDE PER PACK" : "SET PER PACK"}</button></div>
          <div id="fwa-backing-list" className="fwa-backing-list">{perPackExpanded ? (session ? visibleRows.map((r, i) => <div className="fwa-backing-row" key={i}><PackArt value={r.value} settings={settings} nonce={i}/><span>{eth(r.value)} eth pack</span><span className="fwa-backing-ratio">{eth(r.backing * 10n ** 18n / r.value)}× value</span><label className="fwa-backing-input"><input aria-label={`FWA backing for pack ${i + 1}`} value={eth(r.backing)} disabled/><span>eth</span></label></div>) : draftPacks.map((r, i) => <div className="fwa-backing-row" key={r.key}><PackArt value={r.value} settings={settings} nonce={i}/><span>{eth(r.value)} eth pack</span><span className="fwa-backing-ratio">{visibleRows[i] ? eth(visibleRows[i].backing * 10n ** 18n / r.value) : "…"}× value</span><label className="fwa-backing-input"><input aria-label={`FWA backing for pack ${i + 1}`} inputMode="decimal" value={backingFor(r)} disabled={busy} aria-invalid={!!(settings && visibleRows[i] && fwaPackRequirement(visibleRows[i], settings))} onChange={e => setBackings(current => ({...current, [r.key]: e.target.value}))}/><span>eth</span></label></div>)) : groups.filter(g => g.quantity > 0).map(g => <div className="fwa-backing-group" key={g.value}><span>{g.quantity} packs of {g.value} eth</span><span>{g.rows.length && g.rows.every(r => r.backing === g.rows[0].backing) ? `${eth(g.rows[0].backing)} eth each` : "Custom backing"}</span></div>)}<div className="fwa-backing-total"><span>FWA backing · {visibleRows.length} positions</span><span>{eth(totalBacking)} eth</span></div></div>
          <p className="fwa-backing-help">More backing lowers a position's chance of being drawn. Every active position receives an equal share of distributable eth fees.</p>
        </Section>
        <Section title="04 IF DRAWN" pad="28px 40px 40px 32px"><h2 className="fwa-spaced-heading">If a pack is drawn, the buyer chooses.</h2><div className="fwa-outcomes"><div><h3 className="fwa-caps">BUYER KEEPS THE PACK</h3><p>You receive the pack's FWA backing, less the settlement fee.</p></div><div><h3 className="fwa-caps">BUYER ACCEPTS FWA'S BID</h3><p>The pack returns to your wallet. The backing is consumed through settlement.</p></div></div></Section>
        <Section title="05 STEPS" pad="28px 40px 48px 32px" last><h2 className="fwa-spaced-heading">Mint, approve, deposit.</h2><div className="mechanic-grid">
          <article data-active={busy && step === "mint"}><span>01</span><h3>MINT</h3><div><p>Mint {visibleRows.length} shape packs into your wallet. <strong>{eth(totalPackValue + feeEstimate)} eth</strong></p>{session && <p className="fwa-step-status">{minted} of {session.rows.length} minted</p>}{session?.rows.map((r, i) => r.mintHash && <a key={i} className="fwa-step-tx" href={txUrl(r.mintHash, 1)} target="_blank" rel="noreferrer">pack {i + 1} · {r.packId ? "Minted" : "Pending"} ↗</a>)}</div></article>
          <article data-active={busy && step === "approve"}><span>02</span><h3>APPROVE</h3><div><p>Allow FWA to transfer these packs.</p>{(session?.approvalReceipt || complete || (busy && step === "deposit")) && <p className="fwa-step-status">Approved</p>}{(session?.approvalHash || session?.approvalReceipt) && <a className="fwa-step-tx" href={txUrl((session.approvalHash || session.approvalReceipt)!, 1)} target="_blank" rel="noreferrer">Approval transaction ↗</a>}</div></article>
          <article data-active={busy && step === "deposit"}><span>03</span><h3>DEPOSIT</h3><div><p>Deposit each pack with its backing into the FWA main V2 pool. <strong>{eth(totalBacking)} eth</strong></p>{session && <p className="fwa-step-status">{deposited} of {session.rows.length} deposited</p>}{session?.rows.map((r, i) => r.depositHash && <a key={i} className="fwa-step-tx" href={txUrl(r.depositHash, 1)} target="_blank" rel="noreferrer">pack {i + 1} · {r.listingId ? r.staged ? "Queued" : "Deposited" : "Pending"} ↗</a>)}</div></article>
          </div><p className="fwa-positions-link"><a href="https://www.fwa.fun/manage" target="_blank" rel="noreferrer">View your positions on FWA ↗</a></p>
        </Section>
      </div>
      <aside className="fwa-summary-column" aria-label="Your contribution"><div className="fwa-summary-sticky"><p className="launch-kicker fwa-caps">YOUR CONTRIBUTION</p><div className="fwa-summary-art">{visibleRows.map((row, i) => <figure key={i}><PackArt value={row.value} settings={settings} nonce={i}/><figcaption>{eth(row.value)} eth</figcaption></figure>)}</div>
        <div className="fwa-contribution-total"><strong>{eth(total)}</strong><span>eth</span></div><p className="fwa-position-count">{visibleRows.length} FWA positions</p>
        {!!overage && <p className="fwa-error">This plan is {eth(overage)} eth over budget.</p>}{!!balanceShortfall && <p className="fwa-error">This plan is {eth(balanceShortfall)} eth above your wallet balance.</p>}
        <div className="packs-summary"><div className="packs-summary-row"><span>pack value</span><strong>{eth(totalPackValue)} eth</strong></div><div className="packs-summary-row"><span>FWA backing</span><strong>{eth(totalBacking)} eth</strong></div><div className="packs-summary-row"><span>mint fees · {shapeCount} shapes</span><strong>{eth(feeEstimate)} eth</strong></div><div className="packs-summary-row is-total"><span>total</span><strong>{eth(total)} eth</strong></div><div className={`packs-summary-row ${overage ? "fwa-over-budget" : ""}`}><span>{overage ? "over budget" : "remaining budget"}</span><strong>{eth(overage || budgetWei - total)} eth</strong></div></div>
        <button type="button" className="btn-filled fwa-submit fwa-caps" disabled={actionDisabled} onClick={() => !address ? onConnect() : chainId !== 1 ? void switchChainAsync({chainId: 1}).catch(e => setError(describeTxError(e))) : void run()}>{actionLabel}</button>
        <div className="fwa-requirements"><h3 className="fwa-caps">REQUIREMENTS</h3><div><span>eligible</span><strong>shape packs only</strong></div><div><span>minimum pack value</span><span>{settings ? `${eth(settings.minimumPack)} eth` : "Reading…"}</span></div><div><span>position minimums</span><span>{settings ? `${eth(settings.minimumBacking)} eth` : "Reading…"}</span></div><p role={requirement && !checking ? "alert" : "status"}>{complete ? "All packs deposited." : requirement || "This plan meets current requirements."}</p>{settingsError && <button className="fwa-disclosure fwa-caps" type="button" disabled={checking} onClick={() => void refresh().catch(() => {})}>RETRY</button>}</div>
        <div className={`fwa-status ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{message && <p>{message}</p>}{error && <p>{error}</p>}{activeHash && <a href={txUrl(activeHash, 1)} target="_blank" rel="noreferrer">View transaction ↗</a>}{storageWarning && <p>Progress could not be saved. Keep this page open.</p>}</div>
        {(session || recoveryFailed) && <button className="fwa-disclosure fwa-caps" type="button" disabled={busy} onClick={reset}>{resetConfirm ? "CONFIRM NEW PLAN" : "START A NEW PLAN"}</button>}{resetConfirm && <button className="fwa-disclosure fwa-caps" type="button" onClick={() => setResetConfirm(false)}>KEEP THIS PLAN</button>}
      </div></aside>
    </div>
  </main>;
}
function PackArt({value, settings, nonce = 0}: {value: bigint; settings: FwaSettings | null; nonce?: number}) {
  const denominations = settings?.denominations;
  const image = React.useMemo(() => {
    if (!denominations) return null;
    try {
      const counts = packMakeup(value, denominations); const cards: PackCard[] = [];
      for (let i = counts.length - 1; i >= 0 && cards.length < 12; i--) for (let n = 0; n < counts[i] && cards.length < 12; n++) {
        const seed = sampleSeed(BigInt(nonce + 1) * 1000n + BigInt(i * 20 + n)); const amount = denominations[i];
        cards.push({seed, faceValueWei: amount, isBlack: false, inkGene: mintGene(seed, amount), modules: new Uint8Array()});
      }
      return `data:image/svg+xml;base64,${btoa(renderPack(cards))}`;
    } catch {return null;}
  }, [value, denominations, nonce]);
  return image ? <img className="fwa-pack-art" src={image} alt={`${eth(value)} eth shape pack`}/> : <span className="fwa-art-loading" aria-label="Reading artwork"/>;
}
