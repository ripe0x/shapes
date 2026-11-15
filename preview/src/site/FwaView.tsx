import React from "react";
import "./FwaView.css";
import {createPublicClient, custom, defineChain, encodeFunctionData, formatEther, http, type Abi, type Address, type EIP1193Provider, type Hash} from "viem";
import {mainnet} from "viem/chains";
import {useAccount, useSwitchChain, useWriteContract} from "wagmi";
import {renderPack, type PackCard} from "shapes-render/pack";
import type {Deployment} from "../chain/abi";
import {packsAbi, packsGasBudget} from "./packs";
import {awaitSuccessfulReceipt, bufferGas} from "./tx";
import {describeTxError} from "./errors";
import {Section, txUrl} from "./ui";
import {sampleSeed} from "./art";
import {FwaProcessView, type FwaProcessAction} from "./FwaProcessView";
import {mintGene} from "../previewGene";
import {
  FWA_POOL, PACKS, SHAPES, assertSameFwaFork, suggestFwaPlan, type FwaSuggestionMode, buildFwaContribution, parseFwaAmount, fwaPackRequirement, packMakeup,
  depositBlocker, depositedListing, fwaAbi, fwaActions, loadFwaSettings, mintedPackId, packTransferAbi,
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
type ForkTxDetail = {from: Address; to: Address | null; value: bigint; block: bigint | null; status: "success" | "reverted" | "pending"; gasUsed: bigint | null; selector: string};
const choicesFor = (rows: readonly {value: bigint}[]): Choice[] => {
  const groups = new Map<string, Choice>();
  for (const row of rows) {const value = eth(row.value); const group = groups.get(value) ?? {id: value, value, quantity: 0}; group.quantity++; groups.set(value, group);}
  return [...groups.values()].sort((a, b) => parseFwaAmount(a.value) < parseFwaAmount(b.value) ? -1 : 1);
};
async function withWalletPendingNonces(saved: FwaSession, connector: ReturnType<typeof useAccount>["connector"]): Promise<FwaSession> {
  const missing = fwaActions(saved).filter(action => action.status === "pending" && action.hash && saved.pendingNonces?.[action.key] === undefined);
  if (!missing.length || !connector) return saved;
  let provider: EIP1193Provider;
  try {const source = await connector.getProvider(); if (!source || typeof source !== "object" || !("request" in source)) return saved; provider = source as EIP1193Provider;}
  catch {return saved;}
  const next = structuredClone(saved);
  for (const action of missing) {
    try {
      const transaction = await provider.request({method: "eth_getTransactionByHash", params: [action.hash!]}) as {from?: string; nonce?: string} | null;
      if (!transaction?.from || !same(transaction.from, saved.account) || !transaction.nonce || !/^0x[\da-f]+$/i.test(transaction.nonce)) continue;
      const nonce = BigInt(transaction.nonce);
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      next.pendingNonces ??= {};
      next.pendingNonces[action.key] = Number(nonce);
    } catch {/* The page RPC may still be able to recover this hash. */}
  }
  return next;
}

export function FwaView({dep, onConnect}: {dep: Deployment; onConnect: () => void}) {
  const {address, chainId, connector} = useAccount();
  const {switchChainAsync} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const [budget, setBudget] = React.useState("1");
  const [customChoices, setChoices] = React.useState<Choice[] | null>(null);
  const [suggestionMode, setSuggestionMode] = React.useState<FwaSuggestionMode>("balanced");
  const ratio = 10_000n;
  const [backings, setBackings] = React.useState<Record<string, string>>({});
  const [perPackExpanded, setPerPackExpanded] = React.useState(false);
  const [customizeOpen, setCustomizeOpen] = React.useState(false);
  const [galleryExpanded, setGalleryExpanded] = React.useState(true);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const reviewDialog = React.useRef<HTMLDialogElement>(null);
  const forkTxDialog = React.useRef<HTMLDialogElement>(null);
  const [forkTxHash, setForkTxHash] = React.useState<Hash | null>(null);
  const [forkTxDetail, setForkTxDetail] = React.useState<ForkTxDetail | null>(null);
  const [forkTxError, setForkTxError] = React.useState("");
  const [forkTxLoading, setForkTxLoading] = React.useState(false);
  const [forkTxRefresh, setForkTxRefresh] = React.useState(0);
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
  const [processActive, setProcessActive] = React.useState(true);
  const [autoContinue, setAutoContinue] = React.useState(true);
  const autoContinueRef = React.useRef(true);
  React.useEffect(() => {
    try {if (localStorage.getItem("shapes:fwa:autoContinue") === "false") {autoContinueRef.current = false; setAutoContinue(false);}}
    catch {/* The in-memory setting still works when storage is unavailable. */}
  }, []);
  const changeAutoContinue = (enabled: boolean) => {
    autoContinueRef.current = enabled; setAutoContinue(enabled);
    try {localStorage.setItem("shapes:fwa:autoContinue", String(enabled));} catch {/* The in-memory setting still works. */}
  };
  React.useEffect(() => {if (processActive && session) window.scrollTo(0, 0);}, [processActive, !!session]);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [phase, setPhase] = React.useState<"checking" | "wallet" | "confirming" | null>(null);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [storageWarning, setStorageWarning] = React.useState(false);
  const [activeActionKey, setActiveActionKey] = React.useState<string | null>(null);
  const [failureKind, setFailureKind] = React.useState<"rejected" | "failed" | null>(null);
  const [recoveryFailed, setRecoveryFailed] = React.useState(false);
  const [recoveryRefresh, setRecoveryRefresh] = React.useState(0);
  const [resetConfirm, setResetConfirm] = React.useState(false);
  const wallet = React.useRef({address, chainId, connector});
  wallet.current = {address, chainId, connector};
  const sessionRef = React.useRef(session);
  const running = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const forkMode = isLocalFork(dep);
  React.useEffect(() => {
    if (!forkMode) return;
    const hash = new URLSearchParams(window.location.search).get("tx");
    if (hash && /^0x[\da-f]{64}$/i.test(hash)) setForkTxHash(hash as Hash);
  }, [forkMode]);
  const wrongChain = !!address && chainId !== dep.chainId;
  const client = React.useMemo(() => forkMode ? createPublicClient({
    chain: defineChain({id: 31337, name: "Shapes FWA local fork", nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18}, rpcUrls: {default: {http: [dep.rpc]}}, contracts: {multicall3: {address: "0xcA11bde05977b3631167028862bE2a173976CA11"}}}),
    transport: http(dep.rpc, {retryCount: 0}),
  }) : mainnetClient, [dep.rpc, forkMode]);
  React.useEffect(() => {
    if (forkTxHash && !forkTxDialog.current?.open) forkTxDialog.current?.showModal();
    if (!forkTxHash && forkTxDialog.current?.open) forkTxDialog.current.close();
  }, [forkTxHash]);
  React.useEffect(() => {
    if (!forkMode || !forkTxHash) return;
    let active = true;
    setForkTxLoading(true); setForkTxError(""); setForkTxDetail(null);
    const read = async () => {
      const transaction = await client.getTransaction({hash: forkTxHash});
      const receipt = await client.getTransactionReceipt({hash: forkTxHash}).catch(e => {
        if (e instanceof Error && e.name === "TransactionReceiptNotFoundError") return null;
        throw e;
      });
      if (active) setForkTxDetail({from: transaction.from, to: transaction.to, value: transaction.value,
        block: receipt?.blockNumber ?? transaction.blockNumber, status: receipt?.status ?? "pending",
        gasUsed: receipt?.gasUsed ?? null, selector: transaction.input.slice(0, 10)});
    };
    void read().catch(e => {if (active) setForkTxError(describeTxError(e));}).finally(() => {if (active) setForkTxLoading(false);});
    return () => {active = false;};
  }, [client, forkMode, forkTxHash, forkTxRefresh]);
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
    if (sessionRef.current && (!address || !same(sessionRef.current.account, address))) {
      setReady(true); setError(`Reconnect ${sessionRef.current.account} to continue this contribution.`);
      return () => {active = false;};
    }
    setReady(false); setRecoveryFailed(false); setSession(null); sessionRef.current = null;
    setError(""); setMessage(""); setResetConfirm(false); setPhase(null);
    const restore = async () => {
      if (!address) return;
      let raw: string | null = null;
      try {raw = localStorage.getItem(sessionKey(address, dep.chainId));} catch {setStorageWarning(true);}
      if (!raw) return;
      const saved = parseFwaSession(raw, address);
      if (!saved) {if (active) {setRecoveryFailed(true); setError("Saved progress could not be read. Check your transaction history before starting a new plan.");} return;}
      const showSaved = (value: FwaSession) => {
        sessionRef.current = value; setSession(value); setProcessActive(true);
        const grouped = new Map<string, Choice>();
        for (const row of value.rows) {const packValue = eth(row.value); const group = grouped.get(packValue) ?? {id: packValue, value: packValue, quantity: 0}; group.quantity++; grouped.set(packValue, group);}
        setChoices([...grouped.values()]);
        setBudget(value.draft?.budget || eth(value.rows.reduce((s, r) => s + BigInt(r.value) + BigInt(r.backing) + BigInt(r.fee), 0n)));
      };
      if (active) showSaved(saved);
      try {
        const recovered = await reconcileFwaSession(client, await withWalletPendingNonces(saved, connector), forkMode);
        if (!active) return;
        try {localStorage.setItem(sessionKey(address, dep.chainId), JSON.stringify(recovered));} catch {setStorageWarning(true);}
        showSaved(recovered);
      } catch (e) {if (active) {setRecoveryFailed(true); setError(`Could not check saved transactions. ${describeTxError(e)}`);}}
    };
    void restore().finally(() => {if (active) setReady(true);});
    return () => {active = false;};
  }, [address, client, connector, dep.chainId, forkMode, recoveryRefresh, refreshBalance]);
  const save = (next: FwaSession) => {
    try {localStorage.setItem(sessionKey(next.account, dep.chainId), JSON.stringify(next));} catch {if (mounted.current) setStorageWarning(true);}
    if (same(wallet.current.address ?? "", next.account)) {sessionRef.current = next; if (mounted.current) setSession({...next, rows: [...next.rows]});}
  };
  React.useEffect(() => {
    if (!session || !ready || running.current || !fwaActions(session).some(action => action.status === "pending")) return;
    let active = true;
    const check = async () => {
      const current = sessionRef.current;
      if (!current || running.current) return;
      try {
        const recovered = await reconcileFwaSession(client, await withWalletPendingNonces(current, connector), forkMode);
        if (!active) return;
        setRecoveryFailed(false);
        if (JSON.stringify(recovered) === JSON.stringify(current)) {setError(""); return;}
        save(recovered);
        if (fwaActions(recovered).some(action => action.status === "failed")) setError("The transaction reverted. Review its receipt and try again.");
        else setError("");
      } catch (e) {if (active) {setRecoveryFailed(true); setError(`Could not check the pending transaction. ${describeTxError(e)}`);}}
    };
    void check();
    const timer = window.setInterval(() => {void check();}, 5_000);
    return () => {active = false; window.clearInterval(timer);};
  }, [client, connector, forkMode, ready, session]);
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
  const runOne = async (): Promise<boolean> => {
    if (running.current || !ready || !address || !supported) return false;
    const account = address;
    running.current = true; setBusy(true); setError(""); setFailureKind(null); setProcessActive(true);
    setMessage("Checking current pool requirements."); setPhase("checking");
    try {
      walletReady(account);
      const live = await refresh(true);
      walletReady(account);
      let current = sessionRef.current ? structuredClone(sessionRef.current) : null;
      if (!current) {
        if (requirement) throw new Error(requirement);
        if (!plan) throw new Error(planError || "Review the pack configuration first.");
        // Never silently accept a changed mint quote or backing limit after review.
        const fresh = buildFwaContribution(draftPacks.map(r => ({value: r.value, backing: parseFwaAmount(backingFor(r))})), live, parseFwaAmount(budget));
        if (fresh.total !== plan.total || fresh.rows.some((r, i) => r.value !== plan!.rows[i].value || r.fee !== plan!.rows[i].fee || r.backing !== plan!.rows[i].backing)) throw new Error("The mint quote changed. Review the updated plan and try again.");
        const blocked = depositBlocker(live, fresh.rows) || fresh.rows.map(r => fwaPackRequirement(r, live)).find(Boolean);
        if (blocked) throw new Error(blocked);
        if (fresh.total > await client.getBalance({address: account})) throw new Error("This plan exceeds your wallet balance.");
        const approved = await client.readContract({address: PACKS, abi: packTransferAbi, functionName: "isApprovedForAll", args: [account, FWA_POOL]});
        current = {version: 1, account, order: "paired", approvalNeeded: !approved,
          draft: {budget, quantity: fresh.rows.length, ratio: String(ratio), spread: false},
          rows: fresh.rows.map(r => ({counts: r.counts, value: String(r.value), backing: String(r.backing), fee: String(r.fee)}))};
        try {localStorage.setItem(sessionKey(account, dep.chainId), JSON.stringify(current));}
        catch {setStorageWarning(true); throw new Error("Enable browser storage before minting so your transaction progress can be recovered.");}
        save(current);
      }
      const next = fwaActions(current).find(action => action.status !== "confirmed");
      if (!next) {setMessage("All packs deposited."); return false;}
      const unlisted = current.rows.filter(row => row.listingId === undefined).map(row => ({value: BigInt(row.value), backing: BigInt(row.backing)}));
      const blocked = depositBlocker(live, unlisted) || unlisted.map(row => fwaPackRequirement(row, live)).find(Boolean);
      if (blocked) throw new Error(`Pool requirements changed: ${blocked}`);
      setActiveActionKey(next.key);
      const recordFailure = (hash: Hash) => {
        if (next.kind === "approve") current.approvalFailedHash = hash;
        else if (next.kind === "mint") current.rows[next.packIndex!].mintFailedHash = hash;
        else current.rows[next.packIndex!].depositFailedHash = hash;
      };
      const send = async (target: Address, abi: Abi, functionName: string, args: readonly unknown[], value: bigint | undefined, record: (hash: Hash) => void) => {
        walletReady(account);
        setPhase("checking");
        const call = {address: target, abi, functionName, args, value, account} as const;
        await client.simulateContract(call);
        const gas = bufferGas(await client.estimateContractGas(call));
        const block = await client.getBlock();
        if (gas > packsGasBudget(block.gasLimit)) throw new Error("This transaction is too large. Use fewer shapes per pack.");
        const balance = await client.getBalance({address: account});
        if (balance < (value ?? 0n) + gas * await client.getGasPrice()) throw new Error("Your wallet needs more eth for this transaction and network gas.");
        walletReady(account);
        if (forkMode) {
          const activeConnector = wallet.current.connector;
          const provider = await activeConnector?.getProvider();
          if (!provider || typeof provider !== "object" || !("request" in provider)) throw new Error("Connect a wallet to Anvil before sending.");
          await assertSameFwaFork(client, createPublicClient({transport: custom(provider as EIP1193Provider)}), dep.rpc, dep.fwaForkMarker);
          walletReady(account);
          if (wallet.current.connector?.uid !== activeConnector?.uid) throw new Error("Your wallet connection changed. Reconnect before continuing.");
        }
        current.pendingStartBlocks ??= {};
        current.pendingStartBlocks[next.key] = String(block.number);
        save(current);
        setPhase("wallet");
        const hash = await writeContractAsync({...call, gas, chainId: dep.chainId});
        record(hash); save(current);
        setPhase("confirming");
        let walletProvider: EIP1193Provider | null = null;
        try {const provider = await wallet.current.connector?.getProvider(); if (provider && typeof provider === "object" && "request" in provider) walletProvider = provider as EIP1193Provider;}
        catch {/* The page RPC can still provide the nonce. */}
        for (let attempt = 0; attempt < 5; attempt++) {
          let nonce: number | undefined;
          try {
            const transaction = await client.getTransaction({hash});
            if (same(transaction.from, account)) nonce = transaction.nonce;
          } catch {/* A private wallet RPC may know the transaction first. */}
          if (nonce === undefined && walletProvider) try {
            const transaction = await walletProvider.request({method: "eth_getTransactionByHash", params: [hash]}) as {from?: string; nonce?: string} | null;
            if (transaction?.from && same(transaction.from, account) && transaction.nonce && /^0x[\da-f]+$/i.test(transaction.nonce)) {
              const parsed = BigInt(transaction.nonce);
              if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) nonce = Number(parsed);
            }
          } catch {/* Keep the hash; a later receipt can still recover it. */}
          if (nonce !== undefined) {
            current.pendingNonces ??= {};
            current.pendingNonces[next.key] = nonce;
            save(current);
            break;
          }
          await new Promise(resolve => window.setTimeout(resolve, 200));
        }
        return hash;
      };
      const wait = async (hash: Hash, call: {address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint}, clear: () => void) => {
        setPhase("confirming");
        let cancelled = false;
        let trackedHash = hash;
        const expectedInput = encodeFunctionData({abi: call.abi, functionName: call.functionName, args: call.args});
        const receipt = await client.waitForTransactionReceipt({hash, onReplaced: ({reason, transaction}) => {
          if (reason === "cancelled" || transaction.to?.toLowerCase() !== call.address.toLowerCase() || transaction.input !== expectedInput || transaction.value !== (call.value ?? 0n)) cancelled = true;
          for (const row of current.rows) {
            if (row.mintHash === trackedHash) row.mintHash = transaction.hash;
            if (row.depositHash === trackedHash) row.depositHash = transaction.hash;
          }
          if (current.approvalHash === trackedHash) current.approvalHash = transaction.hash;
          trackedHash = transaction.hash;
          save(current);
        }});
        if (cancelled || receipt.status === "reverted") {
          recordFailure(receipt.transactionHash); clear(); save(current);
          if (cancelled) throw new Error("The transaction was cancelled or replaced by a different wallet action. Try this FWA action again when ready.");
          await awaitSuccessfulReceipt(client, receipt.transactionHash, call);
        }
        return receipt;
      };
      if (next.kind === "approve") {
        setMessage("Checking FWA pack approval.");
        const alreadyApproved = await client.readContract({address: PACKS, abi: packTransferAbi, functionName: "isApprovedForAll", args: [account, FWA_POOL]});
        if (alreadyApproved && !current.approvalHash) {
          current.approvalNeeded = false; save(current); setMessage("FWA is already approved."); return true;
        }
        setMessage("Approve FWA to transfer your shape packs for deposits.");
        const call = {address: PACKS, abi: packTransferAbi, functionName: "setApprovalForAll", args: [FWA_POOL, true]} as const;
        const hash = current.approvalHash ?? await send(PACKS, packTransferAbi, "setApprovalForAll", call.args, undefined, h => {current.approvalHash = h;});
        const receipt = await wait(hash, call, () => {delete current.approvalHash;});
        current.approvalReceipt = receipt.transactionHash; delete current.approvalHash; save(current);
        setMessage("FWA approval confirmed.");
      } else if (next.kind === "mint") {
        const index = next.packIndex!; const row = current.rows[index];
        setMessage(`Checking mint quote for pack ${index + 1}.`);
        const quote = await client.readContract({address: PACKS, abi: packsAbi, functionName: "quoteMint", args: [row.counts]});
        if (quote[0] !== BigInt(row.value)) throw new Error("The saved pack makeup does not match its value.");
        if (!row.mintHash && quote[1] !== BigInt(row.fee)) throw new Error("Mint fees changed. Refresh and review before continuing.");
        const remaining = current.rows.reduce((sum, saved) => sum + (saved.listingId === undefined ? BigInt(saved.backing) : 0n) +
          (saved.packId === undefined ? BigInt(saved.value) + saved.counts.reduce((fee, n) => fee + BigInt(n) * live.mintFee, 0n) : 0n), 0n);
        if (!row.mintHash && await client.getBalance({address: account}) <= remaining) throw new Error("Your wallet needs enough eth for the remaining packs, FWA backing, and network gas.");
        const call = {address: PACKS, abi: packsAbi, functionName: "createPack", args: [[], row.counts], value: quote[2]} as const;
        const hash = row.mintHash ?? await send(PACKS, packsAbi, "createPack", call.args, call.value, h => {row.mintHash = h;});
        const receipt = await wait(hash, call, () => {delete row.mintHash;});
        row.packId = String(mintedPackId(receipt, account)); save(current); setMessage(`Pack ${index + 1} minted.`);
      } else {
        const index = next.packIndex!; const row = current.rows[index];
        if (row.packId === undefined) throw new Error(`Mint pack ${index + 1} before depositing it.`);
        setMessage(`Checking FWA deposit for pack ${index + 1}.`);
        const depositSettings = await refresh(true); walletReady(account);
        const blocked = depositBlocker(depositSettings, [{backing: BigInt(row.backing)}]) || fwaPackRequirement({value: BigInt(row.value), backing: BigInt(row.backing)}, depositSettings);
        if (blocked) throw new Error(blocked);
        if (!row.depositHash) {
          const owner = await client.readContract({address: PACKS, abi: packsAbi, functionName: "ownerOf", args: [BigInt(row.packId)]});
          if (!same(owner, account)) throw new Error(`Your wallet no longer owns pack #${row.packId}. Check FWA before continuing.`);
          const approved = await client.readContract({address: PACKS, abi: packTransferAbi, functionName: "isApprovedForAll", args: [account, FWA_POOL]});
          if (!approved) {current.approvalNeeded = true; delete current.approvalReceipt; save(current); setMessage("FWA approval changed. Approve again before depositing this pack."); return true;}
        }
        const call = {address: FWA_POOL, abi: fwaAbi, functionName: "listNFT", args: [PACKS, BigInt(row.packId)], value: BigInt(row.backing)} as const;
        const hash = row.depositHash ?? await send(FWA_POOL, fwaAbi, "listNFT", call.args, call.value, h => {row.depositHash = h;});
        const receipt = await wait(hash, call, () => {delete row.depositHash;});
        Object.assign(row, depositedListing(receipt, account, BigInt(row.packId))); save(current);
        setMessage(row.staged ? `Pack ${index + 1} deposited and staged.` : `Pack ${index + 1} deposited.`);
      }
      setPhase(null);
      return fwaActions(current).some(action => action.status !== "confirmed");
    } catch (e) {
      if (mounted.current && same(wallet.current.address ?? "", account)) {
        const description = describeTxError(e);
        setError(description); setFailureKind(/rejected in the wallet|cancelled in your wallet/i.test(description) ? "rejected" : "failed");
      }
      return false;
    } finally {running.current = false; if (mounted.current) {setBusy(false); setPhase(null); setActiveActionKey(null); void refreshBalance();}}
  };
  const run = async () => {
    let more = await runOne();
    while (more && autoContinueRef.current) more = await runOne();
  };
  const reset = () => {
    if (busy || !address) return;
    if (!resetConfirm && (session || recoveryFailed) && !complete) {setResetConfirm(true); return;}
    try {localStorage.removeItem(sessionKey(address, dep.chainId));} catch {setStorageWarning(true);}
    sessionRef.current = null; setSession(null); setProcessActive(false); setRecoveryFailed(false); setMessage(""); setError(""); setFailureKind(null); setResetConfirm(false); setReviewOpen(false); setPhase(null);
  };
  const addValue = () => {startCustomEdit(); const id = `new-${++nextGroup.current}`; setChoices(rows => [...(rows ?? choices), {id, value: "", quantity: 1}]);};
  const actionLabel = "REVIEW CONTRIBUTION";
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
  const actionList = session ? fwaActions(session) : [];
  const pendingResetHash = actionList.find(action => action.status === "pending")?.hash;
  const currentAction = actionList.find(action => action.status !== "confirmed");
  const processSteps: FwaProcessAction[] = actionList.map(action => {
    let status: FwaProcessAction["status"] = action.status;
    if (busy && action.key === activeActionKey && status !== "confirmed") status = phase === "wallet" ? "wallet" : phase === "confirming" ? "pending" : "checking";
    else if (!busy && error && action.key === currentAction?.key && status === "ready") status = failureKind === "rejected" ? "rejected" : "failed";
    return {...action, status, failedHashes: action.failedHash ? [action.failedHash] : []};
  });
  const processPending = actionList.some(action => action.status === "pending");
  const processWrongAccount = !!session && (!address || !same(address, session.account));
  const processActionLabel = !address ? "CONNECT WALLET" : processWrongAccount ? "CONNECT ORIGINAL WALLET" : wrongChain ? forkMode ? "SWITCH TO LOCAL FORK" : "SWITCH TO ETHEREUM"
    : busy ? phase === "wallet" ? "CONFIRM IN WALLET" : phase === "confirming" ? "PENDING" : "CHECKING"
      : processPending ? "PENDING" : error || currentAction?.status === "failed" ? "TRY AGAIN"
        : currentAction?.kind === "approve" ? "APPROVE FWA" : currentAction?.kind === "mint" ? `MINT PACK ${currentAction.packIndex! + 1}` : currentAction?.kind === "deposit" ? `DEPOSIT PACK ${currentAction.packIndex! + 1}` : "COMPLETE";
  const processActionDisabled = busy || !ready || recoveryFailed || processPending || (!currentAction && !!session);
  const forkReceipt = (
    <dialog ref={forkTxDialog} className="fwa-review-dialog fwa-tx-dialog" aria-labelledby="fwa-tx-title" onClose={() => setForkTxHash(null)}>
      <div className="fwa-review-top"><span>ANVIL · CHAIN 31337</span><button type="button" aria-label="Close transaction" onClick={() => setForkTxHash(null)}>×</button></div>
      <h2 id="fwa-tx-title">Local transaction.</h2>
      {forkTxHash && <p className="fwa-tx-hash">{forkTxHash}</p>}
      {forkTxLoading && <p role="status">Reading transaction from the local fork…</p>}
      {forkTxError && <p className="fwa-action-error" role="alert">{forkTxError}</p>}
      {forkTxDetail && <div className="fwa-review-totals fwa-tx-fields">
        <div><span>Status</span><strong>{forkTxDetail.status}</strong></div>
        <div><span>Block</span><strong>{forkTxDetail.block?.toString() ?? "Pending"}</strong></div>
        <div><span>From</span><strong>{forkTxDetail.from}</strong></div>
        <div><span>To</span><strong>{forkTxDetail.to ?? "Contract creation"}</strong></div>
        <div><span>ETH value</span><strong>{eth(forkTxDetail.value)} ETH</strong></div>
        <div><span>Gas used</span><strong>{forkTxDetail.gasUsed?.toString() ?? "Pending"}</strong></div>
        <div><span>Call</span><strong>{forkTxDetail.selector}</strong></div>
      </div>}
      <button type="button" className="fwa-retry" onClick={() => setForkTxRefresh(value => value + 1)}>Refresh receipt</button>
    </dialog>
  );
  if (session && processActive) return <>
    {forkMode ? <div className="fwa-fork-banner" role={wrongChain ? "alert" : "status"}>LOCAL ANVIL FORK · CHAIN 31337 · RPC {new URL(dep.rpc).host} · TEST TRANSACTIONS ONLY</div>
      : wrongChain && <div className="fwa-fork-banner fwa-mainnet-banner" role="alert">WALLET ON {chainId ? `CHAIN ${chainId}` : "UNKNOWN NETWORK"} · SWITCH TO ETHEREUM MAINNET</div>}
    <FwaProcessView
      packs={session.rows.map(row => ({value: BigInt(row.value), backing: BigInt(row.backing), fee: BigInt(row.fee), packId: row.packId, listingId: row.listingId, staged: row.staged}))}
      steps={processSteps} chainId={dep.chainId} actionLabel={processActionLabel} actionDisabled={processActionDisabled}
      onAction={() => {if (processWrongAccount) onConnect(); else if (wrongChain) switchNetwork(); else void run();}}
      autoContinue={autoContinue} onAutoContinueChange={changeAutoContinue}
      onRetryCheck={() => setRecoveryRefresh(value => value + 1)}
      canBack={!busy && (!processPending || recoveryFailed)} onBack={() => setProcessActive(false)} onNewPlan={reset}
      renderPackArt={index => <PackArt value={BigInt(session.rows[index].value)} settings={settings} salt={artSalt} nonce={index}/>}
      error={processWrongAccount ? `Reconnect ${session.account} to continue this contribution.` : wrongChain ? `Switch your wallet to ${forkMode ? "Anvil (31337)" : "Ethereum mainnet"} to continue.` : error}
      statusMessage={message}
    />
    {forkReceipt}
  </>;
  return <>
    <main className="fwa-page">
      {forkMode && <div className="fwa-fork-banner" role={wrongChain ? "alert" : "status"}>
        <span>LOCAL ANVIL FORK · CHAIN 31337 · RPC {new URL(dep.rpc).host} · TEST TRANSACTIONS ONLY{wrongChain && ` · WALLET ON ${chainId === 1 ? "ETHEREUM MAINNET" : chainId ? `CHAIN ${chainId}` : "UNKNOWN NETWORK"}`}</span>
        {(!address || wrongChain) && <button type="button" disabled={busy} onClick={() => address ? switchNetwork() : onConnect()}>{address ? "SWITCH WALLET TO ANVIL" : "CONNECT WALLET TO ANVIL"}</button>}
        {wrongChain && error && <small>{error}</small>}
      </div>}
      {!forkMode && dep.chainId === 1 && wrongChain && <div className="fwa-fork-banner fwa-mainnet-banner" role="alert">
        <span>WALLET ON {chainId ? `CHAIN ${chainId}` : "UNKNOWN NETWORK"} · SWITCH TO ETHEREUM MAINNET</span>
        <button type="button" disabled={busy} onClick={switchNetwork}>SWITCH WALLET TO ETHEREUM</button>
        {error && <small>{error}</small>}
      </div>}
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
            {!session && customChoices && <div className="fwa-budget-hint" role="status"><span>Custom plan: changing the budget keeps your pack values, backing, and quantities.</span><button type="button" onClick={() => useSuggestion(suggestionMode)}>Recalculate plan for this budget ↗</button></div>}
            {!session && !customChoices && suggestion.plan?.rows.length === 24 && <p className="fwa-budget-hint">This plan uses the 24-position workflow limit. Any remaining budget stays in your wallet.</p>}
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
                {visibleRows.length > 8 && <button type="button" aria-expanded={galleryExpanded} onClick={() => setGalleryExpanded(value => !value)}>{galleryExpanded ? "Show first 8 packs" : "View all " + visibleRows.length + " packs"}</button>}
              </div>
              <div className={`fwa-gallery-grid${galleryExpanded ? " is-expanded" : ""}`}>{(galleryExpanded ? visibleRows : visibleRows.slice(0, 8)).map((row, index) => <figure key={index}>
                    <PackArt value={row.value} settings={settings} salt={artSalt} nonce={index}/>
                    <figcaption>#{String(index + 1).padStart(2, "0")}{galleryExpanded && <><span>{eth(row.value)} ETH pack</span><span>{eth(row.backing)} ETH backing</span></>}</figcaption>
                  </figure>)}</div>
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
            <h2>{complete ? "Contribution complete." : session ? "Your contribution is underway." : "Ready to deposit?"}</h2>
            <p className="fwa-sub">{session ? complete ? "Every pack in this plan has a confirmed FWA deposit." : "Confirmed transactions are saved as you approve, mint and deposit each position." : "Review the individual positions and costs. Then approve FWA, mint each pack, and deposit it."}</p>
            {!session && <div className="fwa-steps"><div><span>01</span> APPROVE</div><div><span>02</span> MINT</div><div><span>03</span> DEPOSIT</div></div>}
            {session && <button type="button" className="fwa-retry" onClick={() => setProcessActive(true)}>View contribution process →</button>}
            {!session && message && <p className="fwa-action-message" role="status">{message}</p>}
            {error && <p className="fwa-action-error" role="alert">{error}</p>}
            {storageWarning && <p className="fwa-action-error">Progress could not be saved. Keep this page open.</p>}
            <p className="fwa-manage-link">{forkMode ? "Fork deposits exist on this local chain only." : <a href="https://www.fwa.fun/manage" target="_blank" rel="noreferrer">View your positions on FWA ↗</a>}</p>
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
            <button type="button" className="btn-filled fwa-submit" disabled={session ? busy : actionDisabled} onClick={() => session ? setProcessActive(true) : setReviewOpen(true)}>{session ? "VIEW CONTRIBUTION PROCESS" : actionLabel}</button>
            <p className={requirement && !checking ? "fwa-requirement is-error" : "fwa-requirement"} role={requirement && !checking ? "alert" : "status"}>{recoveryFailed ? requirement : complete ? completionMessage : requirement || "This plan meets current requirements."}</p>
            {settingsError && <button type="button" className="fwa-retry" disabled={checking} onClick={() => void refresh().catch(() => {})}>Retry pool check</button>}
            {resetConfirm && pendingResetHash && <p className="fwa-action-error" role="alert">This transaction may still confirm. Check <a href={forkMode ? `?tx=${pendingResetHash}` : txUrl(pendingResetHash, dep.chainId)} target="_blank" rel="noreferrer">its receipt ↗</a> and your wallet before discarding progress; a new plan could duplicate the contribution.</p>}
            {recoveryFailed && session && <button type="button" className="fwa-retry" onClick={() => setRecoveryRefresh(value => value + 1)}>Retry saved transaction check</button>}
            {(session || recoveryFailed) && <button type="button" className="fwa-retry" disabled={busy} onClick={reset}>{resetConfirm ? pendingResetHash ? "I checked my wallet · discard saved progress" : "Confirm new plan" : "Start a new plan"}</button>}
            {resetConfirm && <button type="button" className="fwa-retry" onClick={() => setResetConfirm(false)}>Keep this plan</button>}
            <p className="fwa-summary-note">Positions can be drawn and end fee participation. The buyer’s settlement choice determines whether you lose the pack or its separate backing. <a href="https://www.fwa.fun/docs/v2" target="_blank" rel="noreferrer">FWA documentation</a></p>
          </div>
        </aside>
      </div>
    </main>

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
      <p>Approval if needed, then one mint and one FWA deposit transaction for each of the {visibleRows.length} packs. You will confirm each transaction separately. The FWA main V2 pool accepts one pack per deposit transaction. Gas is extra.</p>
      <p className="fwa-review-network">Transaction network: <strong>{forkMode ? "Local Anvil fork · chain 31337" : "Ethereum mainnet · chain 1"}</strong></p>
      <p className="fwa-review-risk">Approval, if needed, lets FWA transfer any Shapes pack in your wallet. A deposit can be staged and begins earning fees only when active. Withdrawals wait for unresolved purchases to clear; withdrawing the crown during its first 12 hours can cost 1% of its backing.</p>
      <button type="button" className="btn-filled fwa-review-confirm" disabled={busy || (actionDisabled && !wrongChain)} onClick={() => {setReviewOpen(false); if (!address) onConnect(); else if (wrongChain) switchNetwork(); else void run();}}>{!address ? "CONNECT WALLET" : wrongChain ? forkMode ? "SWITCH TO LOCAL FORK" : "SWITCH TO ETHEREUM" : "START CONTRIBUTION"}</button>
    </dialog>
    {forkReceipt}
  </>;
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
