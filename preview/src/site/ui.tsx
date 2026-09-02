import React from "react";
import {C, label} from "./theme";

/**
 * The page grammar: a two-column section, 190px label column with a right border, content
 * column, 1px rule below. `labelNode` replaces the plain text label (used for the
 * recomposition tabs). `pad` overrides the content padding where a screen needs to.
 */
export function Section({
  title,
  labelNode,
  pad = "24px 48px 26px 32px",
  last = false,
  children,
}: {
  title?: string;
  labelNode?: React.ReactNode;
  pad?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="site-section"
      style={{
        display: "grid",
        gridTemplateColumns: "190px minmax(0, 1fr)",
        borderBottom: last ? "none" : `1px solid ${C.rule}`,
      }}
    >
      <div
        className="site-section-label"
        style={{padding: "26px 24px 26px 48px", borderRight: `1px solid ${C.rule}`, ...label}}
      >
        {labelNode ?? title}
      </div>
      <div className="site-section-content" style={{padding: pad}}>{children}</div>
    </div>
  );
}

/** Artwork on its pure-black ground at the exact 2.5:3.5 card proportion. */
export function Art({src, alt = "", width}: {src: string; alt?: string; width?: number | string}) {
  return (
    <div className="shape-art" style={{width: width ?? "100%", maxWidth: "100%", aspectRatio: "250 / 350", backgroundColor: C.art}}>
      <img
        src={src}
        alt={alt}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          animation: "artin .35s ease both",
        }}
      />
    </div>
  );
}

/**
 * A confirmation dialog. Escape and an overlay click both cancel, so a destructive action always
 * has a way out that is not the confirm button. `title` takes the section label's type.
 * `maxWidth` overrides the panel's default 480px cap (`.modal-panel` in site.html) for content
 * wider than a confirmation prompt; it also switches on internal scrolling so tall content clips
 * to the viewport instead of overflowing it.
 */
export function Modal({
  title,
  onCancel,
  maxWidth,
  children,
}: {
  title: string;
  onCancel: () => void;
  maxWidth?: number | string;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={maxWidth != null ? {maxWidth, maxHeight: "calc(100vh - 48px)", overflowY: "auto"} : undefined}
      >
        <div style={{...label, marginBottom: 18}}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const txUrl = (hash: string, chainId: number) =>
  `https://evm.now/tx/${hash}?chainId=${chainId}`;

export const addrUrl = (address: string, chainId: number) =>
  `https://evm.now/address/${address}?chainId=${chainId}`;

export interface PendingTx {
  op: string;
  hash: `0x${string}`;
}

/** Staged label for a button driving a write: the fallback label while idle, "Confirm in
 *  wallet" once the op is busy but the wallet has not yet returned a hash, "Pending" once it
 *  has. */
export function txStageLabel(
  op: string,
  fallback: string,
  busy: string | null,
  pendingTx: PendingTx | null,
): string {
  if (busy !== op) return fallback;
  return pendingTx?.op === op ? "Pending" : "Confirm in wallet";
}

/**
 * Stage line for one write op: nothing while idle, "Confirm in wallet" once the op is busy but
 * has no hash yet, "Transaction pending" plus the evm.now link once the wallet returns a hash.
 * Placed directly under the primary button of the flow it tracks.
 */
export function TxStage({
  op,
  busy,
  pendingTx,
  chainId,
}: {
  op: string;
  busy: string | null;
  pendingTx: PendingTx | null;
  chainId: number;
}) {
  if (busy !== op) return null;
  return (
    <div style={{marginTop: 10, fontSize: 11, color: C.muted}}>
      {pendingTx?.op === op ? (
        <>
          Transaction pending ·{" "}
          <a href={txUrl(pendingTx.hash, chainId)} target="_blank" rel="noreferrer" style={{color: C.muted}}>
            View transaction
          </a>
        </>
      ) : (
        "Confirm in wallet"
      )}
    </div>
  );
}
