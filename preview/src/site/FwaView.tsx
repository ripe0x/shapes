import React from "react";
import "./FwaView.css";
import {createPublicClient, defineChain, formatEther, http, type Abi, type Address, type Hash} from "viem";
import {mainnet} from "viem/chains";
import {useAccount, useSwitchChain, useWriteContract} from "wagmi";
import {renderPack, type PackCard} from "shapes-render/pack";
import type {Deployment} from "../chain/abi";
import {packsAbi, packsGasBudget} from "./packs";
import {awaitSuccessfulReceipt, bufferGas} from "./tx";
import {describeTxError} from "./errors";
import {Section, txUrl} from "./ui";
import {sampleSeed} from "./art";
import {mintGene} from "../previewGene";
import {
  FWA_POOL, PACKS, SHAPES, suggestFwaPlan, type FwaSuggestionMode, buildFwaContribution, parseFwaAmount, fwaPackRequirement, packMakeup,
  depositBlocker, depositedListing, fwaAbi, loadFwaSettings, mintedPackId, packTransferAbi,
  parseFwaSession, reconcileFwaSession, sessionKey, type FwaSession, type FwaSettings, type Plan,
} from "./fwa";

const mainnetClient = createPublicClient({chain: mainnet, transport: http("https://mainnet.gateway.tenderly.co", {retryCount: 3, retryDelay: 1_000})});
const eth = (v: bigint | string) => formatEther(BigInt(v));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isLocalFork = (dep: Deployment) => {
  try {
    const url = new URL(dep.rpc);
    return dep.chainId === 31337 && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {return false;}
};
type Choice = {id: string; value: string; quantity: number};
type DraftPack = {key: string; value: bigint};
const choicesFor = (rows: readonly {value: bigint}[]): Choice[] => {
  const groups = new Map<string, Choice>();
  for (const row of rows) {const value = eth(row.value); const group = groups.get(value) ?? {id: value, value, quantity: 0}; group.quantity++; groups.set(value, group);}
  return [...groups.values()].sort((a, b) => parseFwaAmount(a.value) < parseFwaAmount(b.value) ? -1 : 1);
};

export function FwaView({dep, onConnect}: {dep: Deployment; onConnect: () => void}) {
  const {address, chainId} = useAccount();
  const {switchChainAsync} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const [budget, setBudget] = React.useState("1");
  const [customChoices, setChoices] = React.useState<Choice[] | null>(null);
  const [suggestionMode, setSuggestionMode] = React.useState<FwaSuggestionMode>("balanced");
  const ratio = 10_000n;
  const [backings, setBackings] = React.useState<Record<string, string>>({});
  const [perPackExpanded, setPerPackExpanded] = React.useState(false);
  const [customizeOpen, setCustomizeOpen] = React.useState(false);
  const [galleryExpanded, setGalleryExpanded] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const reviewDialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    if (reviewOpen && !reviewDialog.current?.open) reviewDialog.current?.showModal();
    if (!reviewOpen && reviewDialog.current?.open) reviewDialog.current.close();
  }, [reviewOpen]);
  const nextGroup = React.useRef(0);
  const [artSalt, setArtSalt] = React.useState<bigint | null>(null);
  React.useEffect(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    setArtSalt(BigInt(`0x${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`));
  }, []);
  const [settings, setSettings] = React.useState<FwaSettings | null>(null);
  const [settingsError, setSettingsError] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const settingsRead = React.useRef<Promise<FwaSettings> | null>(null);
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
  const forkMode = isLocalFork(dep);
  const wrongChain = !!address && chainId !== dep.chainId;
  const client = React.useMemo(() => forkMode ? createPublicClient({
    chain: defineChain({id: 31337, name: "Shapes FWA local fork", nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18}, rpcUrls: {default: {http: [dep.rpc]}}, contracts: {multicall3: {address: "0xcA11bde05977b3631167028862bE2a173976CA11"}}}),
    transport: http(dep.rpc, {retryCount: 0}),
  }) : mainnetClient, [dep.rpc, forkMode]);
  const supported = (dep.chainId === 1 || forkMode) && same(dep.shapes, SHAPES);
  const switchNetwork = () => {
    setError("");
    void switchChainAsync({chainId: dep.chainId}).catch(e => setError(describeTxError(e)));
  };
  const refreshBalance = React.useCallback(async () => {
    const account = wallet.current.address;
    if (!account) return;
    try {const balance = await client.getBalance({address: account}); if (mounted.current && same(wallet.current.address ?? "", account)) setWalletBalance(balance);}
    catch {if (mounted.current && same(wallet.current.address ?? "", account)) setWalletBalance(null);}
  }, [client]);
  const refresh = React.useCallback(async (fresh = false) => {
    if (settingsRead.current) {
      if (!fresh) return settingsRead.current;
      await settingsRead.current.catch(() => {});
    }
    setChecking(true); setSettingsError("");
    const read = loadFwaSettings(client, forkMode);
    settingsRead.current = read;
    try {const value = await read; if (mounted.current) setSettings(value); return value;}
    catch (e) {if (mounted.current) {setSettings(null); setSettingsError(describeTxError(e));} throw e;}
    finally {settingsRead.current = null; if (mounted.current) setChecking(false);}
  }, [client, forkMode]);
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
      try {raw = localStorage.getItem(sessionKey(address, dep.chainId));} catch {setStorageWarning(true);}
      if (!raw) return;
      const saved = parseFwaSession(raw, address);
      if (!saved) {if (active) {setRecoveryFailed(true); setError("Saved progress could not be read. Check your transaction history before starting a new plan.");} return;}
      const showSaved = (value: FwaSession) => {
        sessionRef.current = value; setSession(value);
        const grouped = new Map<string, Choice>();
        for (const row of value.rows) {const packValue = eth(row.value); const group = grouped.get(packValue) ?? {id: packValue, value: packValue, quantity: 0}; group.quantity++; grouped.set(packValue, group);}
        setChoices([...grouped.values()]);
        setBudget(value.draft?.budget || eth(value.rows.reduce((s, r) => s + BigInt(r.value) + BigInt(r.backing) + BigInt(r.fee), 0n)));
      };
      if (active && !forkMode) showSaved(saved);
      try {
        const recovered = await reconcileFwaSession(client, saved, forkMode);
        if (!active) return;
        try {localStorage.setItem(sessionKey(address, dep.chainId), JSON.stringify(recovered));} catch {setStorageWarning(true);}
        showSaved(recovered);
      } catch (e) {if (active) {setRecoveryFailed(true); setError(`Could not check saved transactions. ${describeTxError(e)}`);}}
    };
    void restore().finally(() => {if (active) setReady(true);});
    return () => {active = false;};
  }, [address, client, dep.chainId, forkMode, refreshBalance]);
  const save = (next: FwaSession) => {
    try {localStorage.setItem(sessionKey(next.account, dep.chainId), JSON.stringify(next));} catch {if (mounted.current) setStorageWarning(true);}
    if (same(wallet.current.address ?? "", next.account)) {sessionRef.current = next; if (mounted.current) setSession({...next, rows: [...next.rows]});}
  };
  const suggestion = React.useMemo(() => {
    if (!settings) return {plan: null, error: ""};
    try {return {plan: suggestFwaPlan(parseFwaAmount(budget), settings, suggestionMode), error: ""};}
    catch (e) {return {plan: null, error: e instanceof Error ? e.message : "Review your budget."};}
  }, [budget, settings, suggestionMode]);
  const choices = customChoices ?? choicesFor(suggestion.plan?.rows ?? []);
  const useSuggestion = (mode: FwaSuggestionMode) => {setSuggestionMode(mode); setChoices(null); setBackings({});};
  const parsedChoices = choices.map(choice => {
    try {
      if (!choice.value.trim()) throw new Error("Enter a pack value.");
      const valueWei = parseFwaAmount(choice.value);
      if (valueWei <= 0n) throw new Error("Enter a pack value above 0 eth.");
      if (settings && valueWei % settings.denominations[0] !== 0n) throw new Error(`Use multiples of ${eth(settings.denominations[0])} eth.`);
      if (settings) packMakeup(valueWei, settings.denominations);
      return {...choice, valueWei, inputError: null};
    } catch (e) {return {...choice, valueWei: null, inputError: e instanceof Error ? e.message : "Enter a valid pack value."};}
  });
  const choiceError = parsedChoices.find(r => r.inputError)?.inputError;
  const draftPacks: DraftPack[] = parsedChoices.filter(r => r.quantity > 0 && r.valueWei !== null).sort((a, b) => a.valueWei! > b.valueWei! ? -1 : 1).flatMap(r => Array.from({length: r.quantity}, (_, i) => ({key: `${r.id}:${i}`, value: r.valueWei!})));
  const defaultBacking = (value: bigint) => {
    const target = settings && value < settings.minimumBacking ? settings.minimumBacking : value;
    return settings && !settings.exempt && settings.cap !== null && target > settings.cap ? settings.cap : target;
  };
  const backingFor = (r: DraftPack) => backings[r.key] ?? eth(customChoices
    ? defaultBacking(r.value)
    : (suggestion.plan?.rows.find(row => row.value === r.value)?.backing ?? 0n));
  const startCustomEdit = () => {
    setChoices(choices);
    setBackings(current => ({...Object.fromEntries(draftPacks.map(row => [row.key, backingFor(row)])), ...current}));
  };
  const removeGroup = (id: string) => {
    startCustomEdit();
    setChoices(rows => (rows ?? choices).filter(r => r.id !== id));
    setBackings(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${id}:`))));
  };
  const changeQuantity = (id: string, quantity: number) => {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 24) return;
    startCustomEdit();
    setChoices(rows => (rows ?? choices).map(r => r.id === id ? {...r, quantity} : r));
    setBackings(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${id}:`) || Number(key.slice(id.length + 1)) < quantity));
      for (let i = 0; i < quantity; i++) next[`${id}:${i}`] ??= current[`${id}:0`] ?? eth(settings?.minimumBacking ?? 0n);
      return next;
    });
  };
  const changeValue = (id: string, value: string) => {
    startCustomEdit();
    setChoices(rows => (rows ?? choices).map(r => r.id === id ? {...r, value} : r));
  };
  const changeGroupBacking = (id: string, value: string) => {
    startCustomEdit();
    setBackings(current => ({...current, ...Object.fromEntries(draftPacks.filter(row => row.key.startsWith(`${id}:`)).map(row => [row.key, value]))}));
  };
  let plan: Plan | null = null;
  let planError = !customChoices && !session ? suggestion.error : "";
  try {if (settings && !session) plan = buildFwaContribution(draftPacks.map(r => ({value: r.value, backing: parseFwaAmount(backingFor(r))})), settings, parseFwaAmount(budget));}
  catch (e) {planError = e instanceof Error ? e.message : "Review your contribution.";}
  const visibleRows = session?.rows.map(r => ({value: BigInt(r.value), backing: BigInt(r.backing), fee: BigInt(r.fee), counts: r.counts, payment: BigInt(r.value) + BigInt(r.fee)})) ?? plan?.rows ?? [];
  const totalPackValue = visibleRows.reduce((s, r) => s + r.value, 0n);
  const totalBacking = visibleRows.reduce((s, r) => s + r.backing, 0n);
  const feeEstimate = visibleRows.reduce((s, r) => s + r.fee, 0n);
  const total = totalPackValue + totalBacking + feeEstimate;
  const minted = session?.rows.filter(r => r.packId !== undefined).length ?? 0;
  const deposited = session?.rows.filter(r => r.listingId !== undefined).length ?? 0;
  const complete = !!session && deposited === session.rows.length;
  const stagedAtDeposit = session?.rows.filter(r => r.staged).length ?? 0;
  const completionMessage = stagedAtDeposit ? "All packs deposited. Some were staged; check FWA for current activation status." : "All packs deposited.";
  let budgetWei = 0n;
  try {budgetWei = parseFwaAmount(budget);} catch {/* The plan error names invalid input. */}
  const overage = total > budgetWei ? total - budgetWei : 0n;
  const remainingPayment = session ? session.rows.reduce((s, r) => s + (r.packId === undefined ? BigInt(r.value) + BigInt(r.fee) : 0n) + (r.listingId === undefined ? BigInt(r.backing) : 0n), 0n) : total;
  const balanceShortfall = walletBalance !== null && remainingPayment > walletBalance ? remainingPayment - walletBalance : 0n;
  const packIssues = settings ? visibleRows.map((row, i) => {const issue = session?.rows[i]?.listingId === undefined ? fwaPackRequirement(row, settings) : null; return issue ? `Pack ${i + 1}: ${issue}` : null;}).filter((v): v is string => !!v) : [];
  const poolBlocker = settings && !complete ? depositBlocker(settings, visibleRows.filter((_, i) => session?.rows[i]?.listingId === undefined)) : null;
  const requirement = !supported ? "This page requires the Ethereum mainnet Shapes deployment or its local Anvil fork." : wrongChain ? `Switch your wallet to ${forkMode ? "Anvil (31337)" : "Ethereum mainnet"} to continue.` : recoveryFailed ? "Saved transactions must be checked before continuing." : choiceError || settingsError || (!settings ? "Reading current requirements…" : planError || (!visibleRows.length ? "Choose at least one pack." : packIssues[0] || poolBlocker || (overage ? `This plan is ${eth(overage)} eth over budget.` : balanceShortfall ? `This plan is ${eth(balanceShortfall)} eth above your wallet balance.` : address && walletBalance === null ? "Reading wallet balance…" : null)));
  const walletReady = (account: Address) => {
    if (!mounted.current || !same(wallet.current.address ?? "", account) || wallet.current.chainId !== dep.chainId) throw new Error(`Your wallet or network changed. Reconnect to ${forkMode ? "the local fork" : "Ethereum"} to continue.`);
  };
  const run = async () => {
    if (running.current || !ready || !address || !supported) return;
    const account = address;
    running.current = true; setBusy(true); setError(""); setActiveHash(null);
    let work: FwaSession | null = null;
    try {
      walletReady(account);
      const live = await refresh(true);
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
        try {localStorage.setItem(sessionKey(account, dep.chainId), JSON.stringify(work));} catch {setStorageWarning(true); throw new Error("Enable browser storage before minting so your transaction progress can be recovered.");}
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
        const hash = await writeContractAsync({...call, gas, chainId: dep.chainId});
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
      const depositSettings = await refresh(true);
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
      setMessage(current.rows.some(row => row.staged) ? "All packs deposited. Some were staged; check FWA for current activation status." : "All packs deposited.");
    } catch (e) {
      if (mounted.current && same(wallet.current.address ?? "", account)) setError(describeTxError(e));
    } finally {running.current = false; if (mounted.current) {setBusy(false); setActiveHash(null); void refreshBalance();}}
  };
  const reset = () => {
    if (busy || !address) return;
    if (!resetConfirm && (session || recoveryFailed) && !complete) {setResetConfirm(true); return;}
    try {localStorage.removeItem(sessionKey(address, dep.chainId));} catch {setStorageWarning(true);}
    sessionRef.current = null; setSession(null); setRecoveryFailed(false); setMessage(""); setError(""); setResetConfirm(false); setReviewOpen(false);
  };
  const addValue = () => {startCustomEdit(); const id = `new-${++nextGroup.current}`; setChoices(rows => [...(rows ?? choices), {id, value: "", quantity: 1}]);};
  const actionLabel = complete ? "DEPOSITED" : busy ? step === "mint" ? "MINTING" : step === "approve" ? "APPROVING" : "DEPOSITING" : session ? "CONTINUE" : "REVIEW CONTRIBUTION";
  const actionDisabled = busy || checking || !ready || complete || !!requirement;
  const groups = parsedChoices.map(choice => {
    const value = choice.valueWei ?? 0n;
    const drafts = draftPacks.filter(r => r.key.startsWith(`${choice.id}:`));
    const backingValues = drafts.map(backingFor);
    let counts: number[] = []; let issue: string | null = choice.inputError;
    try {if (settings && value > 0n) counts = packMakeup(value, settings.denominations);} catch (e) {issue = (e as Error).message;}
    if (settings && choice.quantity && !issue) {
      for (const draft of drafts) {
        try {issue = fwaPackRequirement({value, backing: parseFwaAmount(backingFor(draft))}, settings);}
        catch (e) {issue = e instanceof Error ? e.message : "Enter valid FWA backing.";}
        if (issue) break;
      }
    }
    return {...choice, valueWei: value, counts, issue, backing: backingValues.length && backingValues.every(v => v === backingValues[0]) ? backingValues[0] : "", drafts};
  });
  const uniformValue = visibleRows.length > 0 && visibleRows.every(row => row.value === visibleRows[0].value) ? eth(visibleRows[0].value) : null;
  const uniformBacking = visibleRows.length > 0 && visibleRows.every(row => row.backing === visibleRows[0].backing) ? eth(visibleRows[0].backing) : null;
  const usagePercent = budgetWei > 0n ? Number(total >= budgetWei ? 100n : total * 100n / budgetWei) : 0;
  const strategies = (["most", "balanced", "lower"] as const).map(mode => {
    try {
      const recommended = settings ? suggestFwaPlan(budgetWei, settings, mode) : null;
      return {mode, count: recommended?.rows.length ?? 0, backing: recommended?.rows[0]?.backing ?? null};
    } catch {return {mode, count: 0, backing: null};}
  });
  const lastGroup = groups.at(-1);
  const lastDraft = lastGroup?.drafts[0];
  const lastCost = (() => {
    try {return lastGroup && lastDraft && settings && lastGroup.valueWei > 0n
      ? lastGroup.valueWei + parseFwaAmount(backingFor(lastDraft)) + lastGroup.counts.reduce((sum, count) => sum + BigInt(count) * settings.mintFee, 0n)
      : null;}
    catch {return null;}
  })();
  const affordableExtra = lastCost && lastCost > 0n && total <= budgetWei
    ? Number((budgetWei - total) / lastCost < BigInt(24 - visibleRows.length) ? (budgetWei - total) / lastCost : BigInt(24 - visibleRows.length))
    : 0;
  return <>
    <main className="fwa-page">
      {forkMode && <div className="fwa-fork-banner" role={wrongChain ? "alert" : "status"}>
        <span>LOCAL ANVIL FORK · CHAIN 31337 · TEST TRANSACTIONS ONLY{wrongChain && ` · WALLET ON ${chainId === 1 ? "ETHEREUM MAINNET" : chainId ? `CHAIN ${chainId}` : "UNKNOWN NETWORK"}`}</span>
        {(!address || wrongChain) && <button type="button" disabled={busy} onClick={() => address ? switchNetwork() : onConnect()}>{address ? "SWITCH WALLET TO ANVIL" : "CONNECT WALLET TO ANVIL"}</button>}
        {wrongChain && error && <small>{error}</small>}
      </div>}
      {!forkMode && dep.chainId === 1 && process.env.NODE_ENV === "development" && <div className="fwa-fork-banner fwa-mainnet-banner" role="alert">ETHEREUM MAINNET · REAL TRANSACTIONS</div>}
      <section className="fwa-hero">
        <div>
          <p className="fwa-eyebrow">SHAPES / FWA MAIN V2 POOL</p>
          <h1>Build your FWA<br/>positions.</h1>
        </div>
        <div className="fwa-hero-copy">
          <p>Enter an ETH budget. We’ll create a set of positions you can deposit into the FWA main pool.</p>
          <small>Earn a share of acquisition fees while your positions remain active. Each position carries draw risk.</small>
        </div>
      </section>

      <div className="fwa-body">
        <div className="fwa-sections">
          <Section title="01 BUDGET" pad="44px 46px 46px">
            <h2>How much ETH will you commit?</h2>
            <p className="fwa-sub">We’ll suggest a set of FWA positions that fits your budget, including mint fees and separate FWA backing.</p>
            <div className="fwa-budget-row">
              <label>
                <span className="fwa-field-label">TOTAL BUDGET</span>
                <span className="fwa-budget-input">
                  <input aria-label="ETH budget" inputMode="decimal" value={budget} disabled={busy || !!session} onChange={event => setBudget(event.target.value)} autoComplete="off"/>
                  <span>ETH</span>
                </span>
              </label>
              <div className="fwa-balance"><span>Wallet balance {forkMode ? "on Anvil" : "on Ethereum"}</span><strong>{walletBalance !== null ? eth(walletBalance) + " ETH" : address ? "Reading…" : "Connect wallet to check"}</strong></div>
            </div>
          </Section>

          <Section title="02 YOUR PLAN" pad="40px 46px 40px">
            <div className="fwa-plan-heading">
              <div><p className="fwa-eyebrow">{customChoices ? "CUSTOM CONFIGURATION" : "SUGGESTED FOR YOUR BUDGET"}</p><h2>{visibleRows.length} FWA {visibleRows.length === 1 ? "position" : "positions"}.</h2></div>
              {!customChoices && <span className="fwa-auto-tag">AUTO CONFIGURED</span>}
            </div>
            <p className="fwa-sub">Each pack becomes one FWA position. Value, backing, and mint fees are calculated from the current contract requirements.</p>
            <div className="fwa-plan-stats">
              <div><span>VALUE PER POSITION</span><strong>{uniformValue ?? (visibleRows.length ? "Mixed" : "—")}{uniformValue && <small> ETH</small>}</strong></div>
              <div><span>FWA BACKING EACH</span><strong>{uniformBacking ?? (visibleRows.length ? "Mixed" : "—")}{uniformBacking && <small> ETH</small>}</strong></div>
              <div><span>POSITIONS CREATED</span><strong>{visibleRows.length}</strong></div>
            </div>
            <div className="fwa-plan-gallery" aria-label="Artwork previews of the positions in your plan">
              <div className="fwa-gallery-heading">
                <div><h3>YOUR INDIVIDUAL POSITIONS</h3><p>Each artwork represents one FWA position.</p></div>
                {visibleRows.length > 8 && <button type="button" aria-expanded={galleryExpanded} onClick={() => setGalleryExpanded(value => !value)}>{galleryExpanded ? "Show artwork preview" : "View all " + visibleRows.length + " packs"}</button>}
              </div>
              {galleryExpanded
                ? <div className="fwa-gallery-list">{visibleRows.map((row, index) => <div className="fwa-gallery-row" key={index}>
                    <PackArt value={row.value} settings={settings} salt={artSalt} nonce={index}/>
                    <span>Pack {String(index + 1).padStart(2, "0")}<small>{eth(row.backing)} ETH FWA backing</small></span>
                    <strong>{eth(row.value)} ETH</strong>
                  </div>)}</div>
                : <div className="fwa-gallery-grid">{visibleRows.slice(0, 8).map((row, index) => <figure key={index}>
                    <PackArt value={row.value} settings={settings} salt={artSalt} nonce={index}/>
                    <figcaption>#{String(index + 1).padStart(2, "0")}</figcaption>
                  </figure>)}</div>}
              {!visibleRows.length && <p className="fwa-gallery-empty">Enter a budget that can fund an eligible position.</p>}
              <p className="fwa-gallery-caption">Representative artwork. Final minted packs will vary.</p>
            </div>
            <p className="fwa-plan-warning"><span aria-hidden="true">*</span>More active positions share more acquisition fees in aggregate, but each can be drawn. Lower backing increases draw weight. Fee earnings are variable.</p>

            <button type="button" className="fwa-customize-toggle" aria-expanded={customizeOpen} aria-controls="fwa-customize-panel" onClick={() => setCustomizeOpen(value => !value)}>
              <span>Customize this plan</span><span aria-hidden="true">{customizeOpen ? "−" : "+"}</span>
            </button>
            {customizeOpen && <div className="fwa-customize-panel" id="fwa-customize-panel">
              <p className="fwa-field-label">CHANGE YOUR APPROACH</p>
              <p className="fwa-customize-intro">Choose a different balance of position count and draw exposure, or adjust individual values below.</p>
              <div className="fwa-strategy-grid" role="group" aria-label="Position strategy">
                {strategies.map(({mode, count, backing}) => <button type="button" className="fwa-strategy" key={mode} aria-pressed={!customChoices && suggestionMode === mode} disabled={busy || !!session || backing === null} onClick={() => useSuggestion(mode)}>
                  <span className="fwa-strategy-head"><span>{mode === "most" ? "Most positions" : mode === "balanced" ? "Balanced" : "Lower draw exposure"}</span><span aria-hidden="true">{!customChoices && suggestionMode === mode ? "●" : ""}</span></span>
                  <span className="fwa-strategy-copy">{mode === "most" ? "Uses minimum eligible backing to fit more fee sharing positions." : mode === "balanced" ? "Matches backing to each pack’s value where live limits allow." : "Uses more backing to reduce each position’s draw weight."}</span>
                  <span className="fwa-strategy-stat">{backing === null ? "Unavailable" : String(count) + " positions · " + eth(backing) + " ETH backing each"}</span>
                </button>)}
              </div>
              {settings && !settings.exempt && settings.cap !== null && settings.cap <= settings.minimumBacking && <p className="fwa-constraint-note">The current backing ceiling leaves no room to lower draw exposure by adding backing.</p>}
              <div className="fwa-advanced-head"><span>INDIVIDUAL POSITION SETTINGS</span>{customChoices && <button type="button" onClick={() => useSuggestion(suggestionMode)} disabled={busy || !!session}>Reset to recommended</button>}</div>
              <div className="fwa-group-head"><span>PACK VALUE</span><span>FWA BACKING</span><span>QUANTITY</span></div>
              <div className="fwa-group-list">{groups.map((row, index) => <div className="fwa-group-row" key={row.id}>
                <label className="fwa-group-value"><span className="fwa-mobile-label">PACK VALUE</span><span className="fwa-group-art">{row.valueWei > 0n && !row.inputError && <PackArt value={row.valueWei} settings={settings} salt={artSalt} nonce={index}/>}</span><span className="fwa-inline-input"><input aria-label={"Value per pack for group " + (index + 1)} inputMode="decimal" value={row.value} disabled={busy || !!session} aria-invalid={!!row.issue} onChange={event => changeValue(row.id, event.target.value)}/><span>ETH</span></span></label>
                <label className="fwa-group-backing"><span className="fwa-mobile-label">FWA BACKING</span><span className="fwa-inline-input"><input aria-label={"FWA backing for group " + (index + 1)} inputMode="decimal" value={row.backing} placeholder={row.backing ? undefined : "Mixed"} disabled={busy || !!session} onChange={event => changeGroupBacking(row.id, event.target.value)}/><span>ETH</span></span></label>
                <div className="fwa-group-quantity"><span className="fwa-mobile-label">QUANTITY</span><div className="fwa-stepper"><button type="button" aria-label={"Fewer packs in group " + (index + 1)} disabled={busy || !!session || row.quantity <= 1} onClick={() => changeQuantity(row.id, row.quantity - 1)}>−</button><input aria-label={"Number of packs in group " + (index + 1)} type="number" min={1} max={24} value={row.quantity} disabled={busy || !!session} onChange={event => changeQuantity(row.id, Number(event.target.value))}/><button type="button" aria-label={"More packs in group " + (index + 1)} disabled={busy || !!session || draftPacks.length >= 24} onClick={() => changeQuantity(row.id, row.quantity + 1)}>+</button></div></div>
                <button type="button" className="fwa-remove" aria-label={"Remove pack group " + (index + 1)} disabled={busy || !!session} onClick={() => removeGroup(row.id)}>×</button>
                {row.issue && <p className="fwa-group-error" role="alert">{row.issue}</p>}
              </div>)}</div>
              <div className="fwa-edit-tools">
                <button type="button" disabled={busy || !!session || draftPacks.length >= 24 || !!choiceError} onClick={addValue}>+ Add another pack size</button>
                <button type="button" disabled={busy || !!session || !affordableExtra || !lastGroup} onClick={() => {if (lastGroup) changeQuantity(lastGroup.id, lastGroup.quantity + affordableExtra);}}>Use remaining budget</button>
              </div>
              <button type="button" className="fwa-per-pack-toggle" aria-expanded={perPackExpanded} aria-controls="fwa-per-pack-list" onClick={() => setPerPackExpanded(value => !value)}>{perPackExpanded ? "Hide separate backing inputs" : "Set backing for each position"}</button>
              {perPackExpanded && <div className="fwa-per-pack-list" id="fwa-per-pack-list">{draftPacks.map((row, index) => <label key={row.key}><span>Position {String(index + 1).padStart(2, "0")} · {eth(row.value)} ETH pack</span><span className="fwa-inline-input"><input aria-label={"FWA backing for pack " + (index + 1)} inputMode="decimal" value={backingFor(row)} disabled={busy || !!session} onChange={event => {startCustomEdit(); setBackings(current => ({...current, [row.key]: event.target.value}));}}/><span>ETH</span></span></label>)}</div>}
              <div className="fwa-fact"><span aria-hidden="true">↗</span><div><strong>Why this configuration?</strong><p>Active positions each receive an equal share of distributable acquisition fees. Adding backing lowers a position’s inverse draw weight, while tying up more ETH. The pool’s live minimum and oracle ceiling still apply.</p></div></div>
            </div>}
          </Section>

          <Section title="03 NEXT" pad="31px 46px 35px" last>
            <h2>Ready to deposit?</h2>
            <p className="fwa-sub">Review the individual positions and costs. Then mint, approve and deposit them into FWA.</p>
            <div className="fwa-steps">
              <div><span>01</span> MINT {session && <small>{minted} of {session.rows.length} confirmed</small>}</div>
              <div><span>02</span> APPROVE {session?.approvalReceipt && <small>Confirmed</small>}</div>
              <div><span>03</span> DEPOSIT {session && <small>{deposited} of {session.rows.length} confirmed</small>}</div>
            </div>
            {session && <div className="fwa-progress-details">
              {session.rows.map((row, index) => <div key={index}><span>Pack {index + 1}</span>{row.mintHash && <FwaTransaction hash={row.mintHash} chainId={dep.chainId} label={"Mint " + (row.packId ? "confirmed" : "pending")}/>}{row.depositHash && <FwaTransaction hash={row.depositHash} chainId={dep.chainId} label={row.listingId ? row.staged ? "Staged at deposit" : "Deposited" : "Deposit pending"}/>}</div>)}
              {(session.approvalHash || session.approvalReceipt) && <FwaTransaction hash={(session.approvalHash || session.approvalReceipt)!} chainId={dep.chainId} label="Approval transaction"/>}
            </div>}
            {message && <p className="fwa-action-message" role="status">{message}</p>}
            {error && <p className="fwa-action-error" role="alert">{error}</p>}
            {activeHash && <p className="fwa-action-link"><FwaTransaction hash={activeHash} chainId={dep.chainId} label="Current transaction"/></p>}
            {storageWarning && <p className="fwa-action-error">Progress could not be saved. Keep this page open.</p>}
            <p className="fwa-manage-link"><a href="https://www.fwa.fun/manage" target="_blank" rel="noreferrer">View your positions on FWA ↗</a></p>
          </Section>
        </div>

        <aside className="fwa-summary-column" aria-label="Your contribution">
          <div className="fwa-summary-sticky">
            <p className="fwa-field-label">YOUR CONTRIBUTION</p>
            <div className="fwa-contribution-total"><strong>{eth(total)}</strong><span>ETH</span></div>
            <p className="fwa-position-count">{visibleRows.length} FWA {visibleRows.length === 1 ? "position" : "positions"}</p>
            <div className="fwa-budget-progress" aria-hidden="true"><span style={{width: usagePercent + "%"}}/></div>
            <p className={overage ? "fwa-budget-status is-error" : "fwa-budget-status"}>{overage ? eth(overage) + " ETH over budget" : eth(budgetWei - total) + " ETH remaining from " + eth(budgetWei) + " ETH budget"}</p>
            <div className="fwa-cost-list">
              <div><span>Total pack value</span><strong>{eth(totalPackValue)} ETH</strong></div>
              <div><span>Separate FWA backing</span><strong>{eth(totalBacking)} ETH</strong></div>
              <div><span>Mint fees</span><strong>{eth(feeEstimate)} ETH</strong></div>
              <div className="is-total"><span>Total commitment</span><strong>{eth(total)} ETH</strong></div>
            </div>
            <button type="button" className="btn-filled fwa-submit" disabled={actionDisabled} onClick={() => session ? void run() : setReviewOpen(true)}>{actionLabel}</button>
            <p className={requirement && !checking ? "fwa-requirement is-error" : "fwa-requirement"} role={requirement && !checking ? "alert" : "status"}>{recoveryFailed ? requirement : complete ? completionMessage : requirement || "This plan meets current requirements."}</p>
            {settingsError && <button type="button" className="fwa-retry" disabled={checking} onClick={() => void refresh().catch(() => {})}>Retry pool check</button>}
            {(session || recoveryFailed) && <button type="button" className="fwa-retry" disabled={busy} onClick={reset}>{resetConfirm ? "Confirm new plan" : "Start a new plan"}</button>}
            {resetConfirm && <button type="button" className="fwa-retry" onClick={() => setResetConfirm(false)}>Keep this plan</button>}
            <p className="fwa-summary-note">Positions can be drawn and end fee participation. The buyer’s settlement choice determines whether you lose the pack or its separate backing. <a href="https://www.fwa.fun/docs/v2" target="_blank" rel="noreferrer">FWA documentation</a></p>
          </div>
        </aside>
      </div>
    </main>

    <section className="fwa-explain">
      <p className="fwa-eyebrow">BEFORE YOU DEPOSIT</p>
      <h2>What should you know before depositing?</h2>
      <div className="fwa-explain-grid">
        <article><span>WHILE ACTIVE</span><h3>Earn a share of acquisition fees.</h3><p>Every active position receives an equal share of distributable ETH acquisition fees. FWA token rewards follow separate backing based rules. Returns depend on activity and time in the pool.</p></article>
        <article><span>IF A POSITION IS DRAWN</span><h3>The buyer chooses what happens.</h3><p>If they keep your pack, you receive its separate FWA backing less the settlement fee. If they accept FWA’s bid, your pack returns and its backing is consumed.</p></article>
        <article><span>TO BEGIN</span><h3>Made for FWA deposits.</h3><p>Shapes are assembled automatically at the required values. Live eligibility and backing limits are checked before minting and depositing. Gas costs are extra.</p></article>
      </div>
    </section>

    <dialog ref={reviewDialog} className="fwa-review-dialog" aria-labelledby="fwa-review-title" onClose={() => setReviewOpen(false)}>
      <div className="fwa-review-top"><span>CONTRIBUTION REVIEW</span><button type="button" aria-label="Close review" onClick={() => setReviewOpen(false)}>×</button></div>
      <h2 id="fwa-review-title">Review your contribution.</h2>
      <p>Each pack becomes a separate position in the FWA main V2 pool. Check the live costs and backing before signing.</p>
      <div className="fwa-review-positions">{visibleRows.map((row, index) => <div key={index}><span>Position {String(index + 1).padStart(2, "0")}</span><span>{eth(row.value)} ETH pack · {eth(row.backing)} ETH backing · {eth(row.fee)} ETH mint fee</span></div>)}</div>
      <div className="fwa-review-totals">
        <div><span>Pack value</span><strong>{eth(totalPackValue)} ETH</strong></div>
        <div><span>Separate FWA backing</span><strong>{eth(totalBacking)} ETH</strong></div>
        <div><span>Mint fees</span><strong>{eth(feeEstimate)} ETH</strong></div>
        <div className="is-total"><span>Total</span><strong>{eth(total)} ETH</strong></div>
      </div>
      <p>{visibleRows.length} pack mint {visibleRows.length === 1 ? "transaction" : "transactions"}, one approval if needed, and {visibleRows.length} separate FWA deposit {visibleRows.length === 1 ? "transaction" : "transactions"}. Each wallet transaction needs confirmation. Gas is extra.</p>
      <p className="fwa-review-risk">Approval, if needed, lets FWA transfer any Shapes pack in your wallet. A deposit can be staged and begins earning fees only when active. Withdrawals wait for unresolved purchases to clear; withdrawing the crown during its first 12 hours can cost 1% of its backing.</p>
      <button type="button" className="btn-filled fwa-review-confirm" disabled={busy || (actionDisabled && !wrongChain)} onClick={() => {setReviewOpen(false); if (!address) onConnect(); else if (wrongChain) switchNetwork(); else void run();}}>{!address ? "CONNECT WALLET" : wrongChain ? forkMode ? "SWITCH TO LOCAL FORK" : "SWITCH TO ETHEREUM" : "MINT, APPROVE & DEPOSIT"}</button>
    </dialog>
  </>;
}
function FwaTransaction({hash, chainId, label}: {hash: Hash; chainId: number; label: string}) {
  return chainId === 31337 ? <code className="fwa-fork-tx">{label} · {hash}</code>
    : <a href={txUrl(hash, chainId)} target="_blank" rel="noreferrer">{label} ↗</a>;
}
function PackArt({value, settings, salt, nonce = 0}: {value: bigint; settings: FwaSettings | null; salt: bigint | null; nonce?: number}) {
  const denominations = settings?.denominations;
  const image = React.useMemo(() => {
    if (!denominations || salt === null) return null;
    try {
      const counts = packMakeup(value, denominations); const cards: PackCard[] = [];
      for (let i = counts.length - 1; i >= 0 && cards.length < 12; i--) for (let n = 0; n < counts[i] && cards.length < 12; n++) {
        const seed = sampleSeed(salt + BigInt(nonce + 1) * 1000n + BigInt(i * 20 + n)); const amount = denominations[i];
        cards.push({seed, faceValueWei: amount, isBlack: false, inkGene: mintGene(seed, amount), modules: new Uint8Array()});
      }
      return `data:image/svg+xml;base64,${btoa(renderPack(cards))}`;
    } catch {return null;}
  }, [value, denominations, salt, nonce]);
  return image ? <img className="fwa-pack-art" src={image} alt={`Representative artwork for a ${eth(value)} ETH shape pack`}/> : <span className="fwa-art-loading" aria-label="Reading artwork"/>;
}
