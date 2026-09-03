import React from "react";
import {C, FONT} from "./theme";
import {SyncStatus} from "./ui";
import type {View} from "./SiteApp";

/** The site-wide header: wordmark, view nav, and the connect / account control. Rendered by
 *  SiteApp's shell on every app view and by the host's landing page on the index route. */
export function SiteHeader({
  active,
  go,
  routed,
  isConnected,
  wrongChain,
  accountLabel,
  accountMenuOpen,
  setAccountMenuOpen,
  accountMenuRef,
  onConnect,
  onSwitchChain,
  onDisconnect,
  refreshing,
  refreshFailed,
  onRetryRefresh,
}: {
  /** View to mark as current, or null when no nav item corresponds to the page. */
  active: View | null;
  go: (view: View) => void;
  /** True when the host serves real routes, which makes the wordmark and /play plain anchors. */
  routed: boolean;
  isConnected: boolean;
  wrongChain: boolean;
  accountLabel: string;
  accountMenuOpen: boolean;
  setAccountMenuOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  accountMenuRef: React.RefObject<HTMLDivElement | null>;
  onConnect: () => void;
  onSwitchChain: () => void;
  onDisconnect: () => void;
  refreshing: boolean;
  refreshFailed: boolean;
  onRetryRefresh: () => void;
}) {
  const navColor = (v: View) => (active === v ? C.ink : C.muted);

  return (
    <header className="site-header" style={{fontFamily: FONT}}>
      <div className="site-header-inner">
        {/* The Next host navigates "/" as a real route outside SiteApp's view state, so the
            wordmark links there directly; the Vite preview has no such route and falls back to
            the mint view, mirroring the /play link below. */}
        {routed ? (
          <a href="/" className="site-nav-link">SHAPES</a>
        ) : (
          <button type="button" className="btn-ghost site-nav-link" onClick={() => go("mint")}>SHAPES</button>
        )}
        <nav className="site-nav" style={{display: "flex", gap: "clamp(20px, 4vw, 40px)"}}>
          <button type="button" className="btn-ghost site-nav-link" onClick={() => go("mint")} style={{color: navColor("mint")}}>
            MINT
          </button>
          <button type="button" className="btn-ghost site-nav-link" onClick={() => go("gallery")} style={{color: navColor("gallery")}}>
            GALLERY
          </button>
          {/* /play is a Next.js route outside SiteApp's view state, so it links as a plain
              anchor. Only the Next host serves it; the Vite preview (no onNavigate) omits it. */}
          {routed && (
            <a href="/play" className="site-nav-link" style={{color: C.muted}}>
              PLAY
            </a>
          )}
        </nav>
        <SyncStatus refreshing={refreshing} failed={refreshFailed} onRetry={onRetryRefresh} style={{marginLeft: "auto"}} />
        <div className="site-account" ref={accountMenuRef} style={{position: "relative"}}>
          <button
            type="button"
            className="site-connect-btn"
            aria-haspopup={isConnected ? "menu" : undefined}
            aria-expanded={isConnected ? accountMenuOpen : undefined}
            onClick={() =>
              wrongChain
                ? onSwitchChain()
                : isConnected
                  ? setAccountMenuOpen((open) => !open)
                  : onConnect()
            }
          >
            <span style={{overflow: "hidden", textOverflow: "ellipsis"}}>
              {wrongChain ? "SWITCH NETWORK" : isConnected ? accountLabel : "CONNECT"}
            </span>
            {isConnected && <span aria-hidden="true">▾</span>}
          </button>
          {isConnected && accountMenuOpen && (
            <div
              role="menu"
              aria-label="Wallet account"
              style={{
                position: "absolute",
                top: "calc(100% + 8px)",
                right: 0,
                minWidth: 180,
                border: `1px solid ${C.border}`,
                background: C.page,
                boxShadow: "0 12px 30px rgba(0, 0, 0, 0.12)",
                zIndex: 30,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="account-menu-item"
                onClick={() => {
                  setAccountMenuOpen(false);
                  go("collection");
                }}
              >
                MY SHAPES
              </button>
              <button
                type="button"
                role="menuitem"
                className="account-menu-item"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onDisconnect();
                }}
              >
                DISCONNECT
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
