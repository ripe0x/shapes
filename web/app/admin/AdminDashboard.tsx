"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import Link from "next/link";
import {ConnectButton} from "@rainbow-me/rainbowkit";
import {getAccount} from "@wagmi/core";
import {useAccount, useConfig, useSwitchChain, useWriteContract} from "wagmi";
import type {Address, Hash} from "viem";
import {shapesAbi} from "@shared/chain/abi";
import {bufferGas, awaitSuccessfulReceipt} from "@shared/site/tx";
import {describeTxError} from "@shared/site/errors";
import {useShapesDeployment} from "../ShapesProviders";
import {adminClient, canAccessAdmin, eth, readAdminIdentity, readAdminSnapshot, sameAddress, type AdminSnapshot, type FeeBalance} from "./chain";
import styles from "./admin.module.css";

type Gate = "disconnected" | "checking" | "denied" | "ready" | "error";
type Review = {recipient: Address; amountWei: bigint};

function AddressLink({address}: {address: Address}) {
  return <a className={styles.address} href={`https://etherscan.io/address/${address}`} target="_blank" rel="noreferrer">{address}</a>;
}

export function AdminDashboard() {
  const dep = useShapesDeployment();
  const {address, isConnected, chainId} = useAccount();
  const config = useConfig();
  const {switchChainAsync} = useSwitchChain();
  const {writeContractAsync} = useWriteContract();
  const [gate, setGate] = useState<Gate>("checking");
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const requestId = useRef(0);
  const isCurrentWallet = useCallback((wallet: Address) => {
    const current = getAccount(config);
    return current.isConnected && sameAddress(current.address, wallet);
  }, [config]);

  const refresh = useCallback(async (wallet: Address) => {
    const request = ++requestId.current;
    setReview(null);
    setGate("checking");
    setError(null);
    try {
      const data = await readAdminSnapshot(dep, wallet);
      if (request !== requestId.current || !isCurrentWallet(wallet)) return;
      setSnapshot(data);
      setGate("ready");
    } catch (cause) {
      if (request !== requestId.current || !isCurrentWallet(wallet)) return;
      setSnapshot(null);
      setGate("error");
      setError(describeTxError(cause));
    }
  }, [dep, isCurrentWallet]);

  useEffect(() => {
    let active = true;
    const request = ++requestId.current;
    void Promise.resolve().then(async () => {
      if (!active || request !== requestId.current) return;
      setReview(null);
      setTxHash(null);
      setSnapshot(null);
      if (!isConnected || !address) {
        setGate("disconnected");
        return;
      }
      if (dep.chainId !== 1 || dep.fromBlock === undefined) {
        setGate("error");
        setError("Admin is available on the mainnet site only.");
        return;
      }
      setGate("checking");
      setError(null);
      try {
        const {ensAddress, admin} = await readAdminIdentity(dep);
        if (!active || request !== requestId.current) return;
        if (!canAccessAdmin(address, ensAddress ?? undefined, admin)) {
          setGate("denied");
          return;
        }
        const data = await readAdminSnapshot(dep, address, {ensAddress, admin});
        if (!active || request !== requestId.current) return;
        setSnapshot(data);
        setGate("ready");
      } catch (cause) {
        if (!active || request !== requestId.current) return;
        setGate("error");
        setError(describeTxError(cause));
      }
    });
    return () => { active = false; };
  }, [address, dep, isConnected]);

  // A long-open page must revalidate the mutable ENS record and contract role when revisited.
  useEffect(() => {
    if (!address || gate !== "ready") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const request = ++requestId.current;
      setReview(null);
      setGate("checking");
      void readAdminSnapshot(dep, address).then((data) => {
        if (request !== requestId.current || !isCurrentWallet(address)) return;
        setSnapshot(data);
        setGate("ready");
      }).catch((cause) => {
        if (request !== requestId.current || !isCurrentWallet(address)) return;
        setSnapshot(null);
        setGate("error");
        setError(describeTxError(cause));
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [address, dep, gate, isCurrentWallet]);

  const reviewWithdrawal = async (balance: FeeBalance) => {
    if (!address || busy) return;
    const request = ++requestId.current;
    setBusy(true);
    setReview(null);
    setError(null);
    try {
      const data = await readAdminSnapshot(dep, address);
      if (request !== requestId.current || !isCurrentWallet(address)) return;
      const fresh = data.balances.find((row) => sameAddress(row.recipient, balance.recipient));
      if (!fresh || fresh.amountWei === 0n) throw new Error("No fees are available for this recipient now.");
      setSnapshot(data);
      setReview({recipient: fresh.recipient, amountWei: fresh.amountWei});
    } catch (cause) {
      if (request === requestId.current && isCurrentWallet(address)) setError(describeTxError(cause));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!review || !address || busy) return;
    setBusy(true);
    setError(null);
    setTxHash(null);
    try {
      const account = getAccount(config);
      if (!sameAddress(account.address, address) || !account.isConnected) throw new Error("The connected wallet changed. Review the withdrawal again.");
      const data = await readAdminSnapshot(dep, address);
      const balance = data.balances.find((row) => sameAddress(row.recipient, review.recipient));
      if (!balance || balance.amountWei !== review.amountWei) {
        setSnapshot(data);
        setReview(null);
        throw new Error("The available amount changed. Review the withdrawal again.");
      }
      if (account.chainId !== 1) await switchChainAsync({chainId: 1});
      const currentAccount = getAccount(config);
      if (!sameAddress(currentAccount.address, address) || currentAccount.chainId !== 1) {
        throw new Error("Connect the admin wallet on Ethereum mainnet and review again.");
      }
      const args = [review.recipient] as const;
      await adminClient.simulateContract({address: dep.shapes, abi: shapesAbi, functionName: "withdrawFees", args, account: address});
      const gas = bufferGas(await adminClient.estimateContractGas({address: dep.shapes, abi: shapesAbi, functionName: "withdrawFees", args, account: address}));
      const signingAccount = getAccount(config);
      if (!sameAddress(signingAccount.address, address) || signingAccount.chainId !== 1) {
        throw new Error("The connected wallet changed. Review the withdrawal again.");
      }
      const hash = await writeContractAsync({address: dep.shapes, abi: shapesAbi, functionName: "withdrawFees", args, gas, chainId: 1, account: address});
      setTxHash(hash);
      await awaitSuccessfulReceipt(adminClient, hash, {address: dep.shapes, abi: shapesAbi, functionName: "withdrawFees", args});
      setReview(null);
      await refresh(address);
    } catch (cause) {
      setError(describeTxError(cause));
    } finally {
      setBusy(false);
    }
  };

  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand}>SHAPES</Link>
      <span className={styles.headerTitle}>ADMIN</span>
      <ConnectButton showBalance={false} />
    </header>
    <div className={styles.content}>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>ETHEREUM MAINNET</p>
        <h1>Admin</h1>
        <p>Fees, withdrawals, and contract status.</p>
      </div>
      {gate === "disconnected" && <section className={styles.notice}>Connect ripe0x.eth to view this page.</section>}
      {gate === "checking" && <section className={styles.notice}>Checking admin wallet on mainnet…</section>}
      {gate === "denied" && <section className={styles.notice}>This wallet is not the current Shapes admin for ripe0x.eth.</section>}
      {gate === "error" && <section className={styles.notice} role="alert">{error || "Could not verify admin access."} <button onClick={() => address && refresh(address)}>Retry</button></section>}
      {gate === "ready" && snapshot && isConnected && canAccessAdmin(address, snapshot.ensAddress, snapshot.admin) && <>
        <section className={styles.summary} aria-label="Fee summary">
          <div><span>Total pending fees</span><strong>{eth(snapshot.pendingWei)}</strong></div>
          <div><span>Current recipient available</span><strong>{eth(snapshot.balances.find((row) => row.current)?.amountWei ?? 0n)}</strong></div>
          <div><span>Mint fee per Shape</span><strong>{eth(snapshot.mintFeeWei)}</strong></div>
        </section>
        <div className={styles.sectionTitle}><h2>Available to withdraw</h2><button onClick={() => address && refresh(address)} disabled={busy}>Refresh</button></div>
        <p className={styles.context}>Withdrawals pay the recorded recipient, regardless of which wallet submits the transaction.</p>
        <section className={styles.card}>
          {snapshot.balances.filter((row) => row.amountWei > 0n).length === 0
            ? <p>No fees available.</p>
            : snapshot.balances.filter((row) => row.amountWei > 0n).map((row) => <div className={styles.balanceRow} key={row.recipient}>
                <div><span className={styles.rowLabel}>{row.current ? "Current recipient" : "Previous recipient"}</span><strong>{eth(row.amountWei)}</strong><AddressLink address={row.recipient} /></div>
                <button className={styles.primary} onClick={() => void reviewWithdrawal(row)} disabled={busy}>Withdraw to recipient</button>
              </div>)}
        </section>
        {review && <section className={styles.review} aria-label="Withdrawal review">
          <h3>Review withdrawal</h3>
          <p>Amount: <strong>{eth(review.amountWei)}</strong></p>
          <p>Payout destination: <AddressLink address={review.recipient} /></p>
          <p>The contract sends all fees owed to this address. Your connected wallet pays network gas.</p>
          <div className={styles.actions}><button className={styles.primary} onClick={() => void withdraw()} disabled={busy}>{busy ? "Waiting…" : chainId === 1 ? "Confirm withdrawal in wallet" : "Switch to mainnet and withdraw"}</button><button onClick={() => setReview(null)} disabled={busy}>Cancel</button></div>
        </section>}
        {txHash && <p className={styles.tx}>Transaction: <a href={`https://etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer">{txHash}</a></p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.sectionTitle}><h2>Past withdrawals</h2><span>{snapshot.withdrawals.length} total</span></div>
        <section className={styles.card}>
          {snapshot.withdrawals.length === 0 ? <p>No withdrawals recorded since deployment.</p>
            : <div className={styles.history}>{snapshot.withdrawals.map((row) => <div className={styles.historyRow} key={`${row.transactionHash}-${row.logIndex}`}>
                <strong>{eth(row.amountWei)}</strong><AddressLink address={row.recipient} />
                <a href={`https://etherscan.io/tx/${row.transactionHash}`} target="_blank" rel="noreferrer">Block {row.blockNumber.toString()} ↗</a>
              </div>)}</div>}
        </section>
        <div className={styles.sectionTitle}><h2>Contract status</h2><span>As of block {snapshot.blockNumber.toString()}</span></div>
        <section className={styles.card}>
          <div className={styles.statusRow}><span>Admin / ripe0x.eth</span><AddressLink address={snapshot.admin} /></div>
          <div className={styles.statusRow}><span>Current fee recipient</span><AddressLink address={snapshot.feeRecipient} /></div>
          <div className={styles.statusRow}><span>Presentation</span><strong>{snapshot.presentationLocked ? "Locked" : "Editable"}</strong></div>
          <div className={styles.statusRow}><span>Positions pointer</span><span>{snapshot.positions[1] ? "Locked" : "Editable"} · <AddressLink address={snapshot.positions[0]} /></span></div>
          <div className={styles.statusRow}><span>Market pointer</span><span>{snapshot.market[1] ? "Locked" : "Editable"} · <AddressLink address={snapshot.market[0]} /></span></div>
          <div className={styles.statusRow}><span>Shapes contract</span><AddressLink address={dep.shapes} /></div>
        </section>
      </>}
    </div>
  </main>;
}
