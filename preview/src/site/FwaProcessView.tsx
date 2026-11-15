import React from "react";
import {formatEther, type Hash} from "viem";
import {txUrl} from "./ui";
import "./FwaProcessView.css";

export type FwaProcessStatus = "queued" | "ready" | "checking" | "wallet" | "pending" | "confirmed" | "rejected" | "failed";
export type FwaProcessAction = {
  key: string;
  kind: "approve" | "mint" | "deposit";
  packIndex?: number;
  status: FwaProcessStatus;
  hash?: Hash;
  failedHashes?: readonly Hash[];
};
export type FwaProcessPack = {
  value: bigint;
  backing: bigint;
  fee: bigint;
  packId?: string;
  listingId?: string;
  staged?: boolean;
};
export type FwaProcessViewProps = {
  packs: readonly FwaProcessPack[];
  steps: readonly FwaProcessAction[];
  chainId: number;
  actionLabel: string;
  actionDisabled: boolean;
  onAction: () => void;
  autoContinue: boolean;
  onAutoContinueChange: (enabled: boolean) => void;
  onRetryCheck: () => void;
  canBack: boolean;
  onBack: () => void;
  onNewPlan: () => void;
  renderPackArt: (index: number) => React.ReactNode;
  error?: string;
  statusMessage?: string;
};

const eth = (amount: bigint) => `${formatEther(amount)} eth`;
const stepLabel = (step: FwaProcessAction) => step.kind === "approve" ? "Approve FWA"
  : `${step.kind === "mint" ? "Mint" : "Deposit"} pack ${(step.packIndex ?? 0) + 1}`;
const txHref = (hash: Hash, chainId: number) => chainId === 31337 ? `?tx=${hash}` : txUrl(hash, chainId);

function TxLink({hash, chainId, children}: {hash: Hash; chainId: number; children: React.ReactNode}) {
  return <a href={txHref(hash, chainId)} target="_blank" rel="noreferrer" title={hash}>{children}</a>;
}

export function FwaProcessView({packs, steps, chainId, actionLabel, actionDisabled, onAction, autoContinue, onAutoContinueChange, onRetryCheck, canBack, onBack, onNewPlan, renderPackArt, error, statusMessage}: FwaProcessViewProps) {
  const panelRef = React.useRef<HTMLElement>(null);
  const currentRowRef = React.useRef<HTMLLIElement>(null);
  const currentIndex = steps.findIndex(step => step.status !== "confirmed");
  React.useEffect(() => {
    if (currentIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      const row = currentRowRef.current;
      if (!row) return;
      const bounds = row.getBoundingClientRect();
      const mobile = window.matchMedia("(max-width: 700px)").matches;
      const top = mobile ? 68 : 100;
      const bottom = window.innerHeight - (mobile ? (panelRef.current?.getBoundingClientRect().height ?? 0) + 16 : 24);
      const distance = bounds.top < top ? bounds.top - top : bounds.bottom > bottom ? bounds.bottom - bottom : 0;
      if (distance !== 0) window.scrollBy({top: distance, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
    });
    return () => cancelAnimationFrame(frame);
  }, [currentIndex]);
  const current = currentIndex < 0 ? null : steps[currentIndex];
  const complete = steps.length > 0 && current === null;
  const confirmed = steps.length - steps.filter(step => step.status !== "confirmed").length;
  const packValue = packs.reduce((total, pack) => total + pack.value, 0n);
  const backing = packs.reduce((total, pack) => total + pack.backing, 0n);
  const mintFees = packs.reduce((total, pack) => total + pack.fee, 0n);
  const commitment = packValue + backing + mintFees;
  const paid = steps.reduce((total, step) => {
    if (step.status !== "confirmed" || step.packIndex === undefined) return total;
    const pack = packs[step.packIndex];
    return total + (step.kind === "mint" ? pack.value + pack.fee : step.kind === "deposit" ? pack.backing : 0n);
  }, 0n);
  const stagedCount = packs.filter(pack => pack.listingId && pack.staged).length;
  const activePackIndex = current?.packIndex;
  const next = currentIndex >= 0 ? steps[currentIndex + 1] : null;
  const isError = !!error || current?.status === "failed" || current?.status === "rejected";
  const currentHash = current?.hash ?? current?.failedHashes?.at(-1);
  const note = error || (complete ? stagedCount ? `${stagedCount} ${stagedCount === 1 ? "position was" : "positions were"} staged at deposit. Check FWA for current activation status.` : "All deposits are confirmed."
    : current?.status === "wallet" ? "Confirm this transaction in your wallet."
      : current?.status === "checking" ? "Checking current requirements and gas…"
        : current?.status === "pending" ? "The next action appears after this transaction confirms."
          : current?.status === "rejected" ? error || "Rejected in your wallet. Nothing was sent."
            : current?.status === "failed" ? error || "This action failed. Review the reason and try again."
              : current?.kind === "approve" ? "FWA can move all Shapes packs in this wallet, including future packs, until approval is revoked."
                : current?.kind === "mint" ? `Your wallet will ask you to confirm.${next ? ` Next: ${stepLabel(next).toLowerCase()}.` : ""}`
                  : current?.kind === "deposit" ? `Pack ${(activePackIndex ?? 0) + 1} and its ${eth(packs[activePackIndex ?? 0]?.backing ?? 0n)} FWA backing go into the main V2 pool together.`
                    : statusMessage || "Preparing your contribution…");
  const statusText = (step: FwaProcessAction) => step.status === "confirmed" ? step.kind === "deposit" && packs[step.packIndex ?? 0]?.staged ? "staged at deposit" : "confirmed"
    : step.status === "ready" ? "up next" : step.status === "checking" ? "checking" : step.status === "wallet" ? "in wallet"
      : step.status === "pending" ? "pending" : step.status === "rejected" ? "rejected" : step.status === "failed" ? "failed" : "";
  const art = (index: number) => <span className="fwa-run-art" key={index}>{renderPackArt(index)}</span>;
  const artSummary = <div className="fwa-run-art-strip" aria-label={`${packs.length} position artwork previews`}>
    <div className="fwa-run-art-strip-desktop">{packs.slice(0, 8).map((pack, index) => <span className={pack.packId ? "" : "is-unminted"} key={index}>{art(index)}</span>)}{packs.length > 8 && <span className="fwa-run-art-more">+{packs.length - 8} more</span>}</div>
    <div className="fwa-run-art-strip-mobile">{packs.slice(0, 5).map((pack, index) => <span className={pack.packId ? "" : "is-unminted"} key={index}>{art(index)}</span>)}{packs.length > 5 && <span className="fwa-run-art-more">+{packs.length - 5} more</span>}</div>
  </div>;
  const panelArt = current?.kind === "approve" || complete
    ? <div className="fwa-run-panel-art-list" aria-hidden="true">{packs.slice(0, 5).map((_, index) => art(index))}{packs.length > 5 && <span>+{packs.length - 5}</span>}</div>
    : activePackIndex !== undefined ? <div className="fwa-run-panel-art">{art(activePackIndex)}</div> : null;
  const lineItems = complete ? [
    ["pack value", eth(packValue)], ["separate FWA backing", eth(backing)], ["mint fees", eth(mintFees)], ["total committed", eth(commitment)],
  ] : current?.kind === "mint" && activePackIndex !== undefined ? [
    ["pack value", eth(packs[activePackIndex].value)], ["mint fee", eth(packs[activePackIndex].fee)], ["you send", eth(packs[activePackIndex].value + packs[activePackIndex].fee)],
  ] : current?.kind === "deposit" && activePackIndex !== undefined ? [
    ["pack", `#${packs[activePackIndex].packId ?? "—"} · holds ${eth(packs[activePackIndex].value)}`],
    ["FWA backing", eth(packs[activePackIndex].backing)], ["you send", eth(packs[activePackIndex].backing)],
  ] : [];

  return <main className="fwa-run" aria-label="FWA contribution process">
    <div className="fwa-run-checklist">
      <div className="fwa-run-checklist-inner">
        {artSummary}
        <p className="fwa-run-art-caption">Representative artwork. Final minted packs may vary.</p>
        <h1>{complete ? `${packs.length} ${packs.length === 1 ? "position is" : "positions are"} in FWA.` : `Mint and deposit ${packs.length} ${packs.length === 1 ? "pack" : "packs"}.`}</h1>
        <p className="fwa-run-sub">{steps.length} {steps.length === 1 ? "transaction" : "transactions"} · {confirmed} confirmed</p>
        {stagedCount > 0 && complete && <p className="fwa-run-staged-note" role="status">{stagedCount} {stagedCount === 1 ? "deposit was" : "deposits were"} staged at deposit. Check FWA for current activation status.</p>}
        <ol className="fwa-run-step-list" id="fwa-deposited">
          {steps.map((step, index) => <li className={`fwa-run-step is-${step.status}`} key={step.key} ref={index === currentIndex ? currentRowRef : undefined} aria-current={index === currentIndex ? "step" : undefined}>
            <span className="fwa-run-step-number">{String(index + 1).padStart(2, "0")}</span>
            <span className="fwa-run-step-label">{stepLabel(step)}</span>
            <span className="fwa-run-step-meta">
              <span>{statusText(step)}</span>
              {step.hash && <TxLink hash={step.hash} chainId={chainId}>tx ↗</TxLink>}
              {!step.hash && step.failedHashes?.at(-1) && <TxLink hash={step.failedHashes.at(-1)!} chainId={chainId}>tx ↗</TxLink>}
              {step.kind === "deposit" && step.status === "confirmed" && chainId !== 31337 && <a href="https://www.fwa.fun/manage" target="_blank" rel="noreferrer">FWA ↗</a>}
            </span>
            {!!step.failedHashes?.length && step.status !== "failed" && <details className="fwa-run-attempts"><summary>Earlier failed transactions</summary>{step.failedHashes.map((hash, attempt) => <TxLink key={hash} hash={hash} chainId={chainId}>Attempt {attempt + 1} ↗</TxLink>)}</details>}
          </li>)}
        </ol>
      </div>
    </div>
    <aside className="fwa-run-panel" ref={panelRef} aria-label="Current transaction">
      <div className="fwa-run-panel-main">
        <div className={`fwa-run-focus${current?.kind === "approve" || complete ? " is-summary" : ""}`}>
          <p className="fwa-run-eyebrow">{chainId === 31337 ? "LOCAL FORK" : chainId === 1 ? "ETHEREUM MAINNET" : `CHAIN ${chainId}`} · {complete ? `${steps.length} OF ${steps.length} CONFIRMED` : current ? `TRANSACTION ${currentIndex + 1} OF ${steps.length}` : "PREPARING CONTRIBUTION"}</p>
          {panelArt}
          <h2>{complete ? `${packs.length} ${packs.length === 1 ? "position" : "positions"} in FWA` : current ? stepLabel(current) : "Preparing contribution"}</h2>
        </div>
        {lineItems.length > 0 && <div className="fwa-run-lines">{lineItems.map(([label, value], index) => <div className={index === lineItems.length - 1 ? "is-total" : ""} key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>}
        {complete ? <a className="fwa-run-primary" href={chainId === 31337 ? "#fwa-deposited" : "https://www.fwa.fun/manage"} target={chainId === 31337 ? undefined : "_blank"} rel={chainId === 31337 ? undefined : "noreferrer"}>{chainId === 31337 ? "VIEW DEPOSITED POSITIONS ↓" : "VIEW YOUR FWA DEPOSITS ↗"}</a>
          : <button type="button" className="fwa-run-primary" disabled={actionDisabled} onClick={onAction}>{actionLabel}</button>}
        {!complete && <label className="fwa-run-auto"><input type="checkbox" checked={autoContinue} onChange={event => onAutoContinueChange(event.target.checked)}/><span>Continue after each confirmation</span></label>}
        {!complete && <p className="fwa-run-auto-hint">Each transaction still needs wallet confirmation.</p>}
        {(isError || current?.status === "pending") && currentHash && <p className="fwa-run-status-link"><TxLink hash={currentHash} chainId={chainId}>View transaction ↗</TxLink></p>}
        <p className={isError ? "fwa-run-note is-error" : "fwa-run-note"} role={isError ? "alert" : undefined}>{note}</p>
        {error && current?.status === "pending" && <button type="button" className="fwa-run-secondary" onClick={onRetryCheck}>Retry transaction check</button>}
        {complete ? <button type="button" className="fwa-run-secondary" onClick={onNewPlan}>Plan another contribution</button>
          : canBack && <button type="button" className="fwa-run-secondary" onClick={onBack}>Back to plan</button>}
      </div>
      <div className="fwa-run-footer" role="progressbar" aria-label="Contribution progress" aria-valuenow={confirmed} aria-valuemin={0} aria-valuemax={steps.length}>
        <div className="fwa-run-segments" aria-hidden="true">{steps.map(step => <span className={`is-${step.status}`} key={step.key}/>)}</div>
        <div className="fwa-run-footer-text"><span>{confirmed} of {steps.length} confirmed</span><span>{eth(paid)} of {eth(commitment)} committed</span></div>
      </div>
    </aside>
  </main>;
}
