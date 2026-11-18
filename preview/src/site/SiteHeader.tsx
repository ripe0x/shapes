import React from "react";
import {C, FONT} from "./theme";
import {SyncStatus} from "./ui";
import {MobileNav} from "./MobileNav";
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
  initializing = false,
  onIntent,
  walletReady = true,
}: {
  /** View to mark as current, or null when no nav item corresponds to the page. */
  active: View | null;
  go: (view: View) => void;
  /** True when the host serves real routes, so the wordmark has a shareable home URL. */
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
  initializing?: boolean;
  walletReady?: boolean;
  onIntent?: (view: View) => void;
}) {
  const navColor = (v: View) => (active === v ? C.ink : C.muted);
  const paths = {home: "/", mint: "/mint", gallery: "/gallery", packs: "/packs", fwa: "/fwa"} as const;
  const navLink = (view: "mint" | "gallery" | "packs" | "fwa", text: string) => routed ? (
    <a href={paths[view]} className="site-nav-link" style={{color: navColor(view)}}
      onMouseEnter={() => onIntent?.(view)} onFocus={() => onIntent?.(view)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        go(view);
      }}>{text}</a>
  ) : (
    <button type="button" className="btn-ghost site-nav-link" style={{color: navColor(view)}}
      onMouseEnter={() => onIntent?.(view)} onFocus={() => onIntent?.(view)} onClick={() => go(view)}>{text}</button>
  );

  return (
    <header data-wallet-ready={walletReady || undefined} className="site-header" style={{fontFamily: FONT}}>
      <div className="site-header-inner">
        {/* The Next host serves "/" as a real route; the Vite preview falls back to mint. */}
        {routed ? (
          <a href="/" className="site-nav-link" onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            go("home");
          }}>SHAPES</a>
        ) : (
          <button type="button" className="btn-ghost site-nav-link" onClick={() => go("mint")}>SHAPES</button>
        )}
        <nav className="site-nav">
          {navLink("mint", "MINT")}
          {navLink("gallery", "GALLERY")}
          {navLink("packs", "PACKS")}
          {navLink("fwa", "FWA")}
        </nav>
        <SyncStatus refreshing={refreshing} failed={refreshFailed} onRetry={onRetryRefresh} />
        {/* Wraps both the desktop account control and the mobile nav's account row so the
            outside-click handler below (keyed on this one ref) treats either as "inside" no
            matter which layout is visible. display: contents keeps it out of the flex layout. */}
        <div ref={accountMenuRef} style={{display: "contents"}}>
          <div className="site-account" style={{position: "relative"}}>
            <button
              type="button"
              className="site-connect-btn"
              disabled={initializing}
              aria-busy={initializing || undefined}
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
                {wrongChain ? "SWITCH NETWORK" : isConnected ? accountLabel : "CONNECT WALLET"}
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
          <MobileNav
            items={[
              {label: "MINT", active: active === "mint", onClick: () => go("mint")},
              {label: "GALLERY", active: active === "gallery", onClick: () => go("gallery")},
              {label: "PACKS", active: active === "packs", onClick: () => go("packs")},
              {label: "FWA", active: active === "fwa", onClick: () => go("fwa")},
              ...(isConnected
                ? [{label: "MY SHAPES", active: active === "collection", onClick: () => go("collection")}]
                : []),
            ]}
            accountSlot={(closeNav) => (
              <div className="site-mobile-nav-account">
                <button
                  type="button"
                  className="btn-ghost site-mobile-nav-row"
                  disabled={initializing}
                  aria-haspopup={isConnected ? "menu" : undefined}
                  aria-expanded={isConnected ? accountMenuOpen : undefined}
                  onClick={() => {
                    if (wrongChain) {
                      closeNav();
                      onSwitchChain();
                    } else if (isConnected) {
                      setAccountMenuOpen((o) => !o);
                    } else {
                      closeNav();
                      onConnect();
                    }
                  }}
                >
                  {wrongChain ? "SWITCH NETWORK" : isConnected ? accountLabel : "CONNECT WALLET"}
                </button>
                {isConnected && accountMenuOpen && (
                  <div role="menu" aria-label="Wallet account">
                    <button
                      type="button"
                      role="menuitem"
                      className="btn-ghost site-mobile-nav-row"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        closeNav();
                        go("collection");
                      }}
                    >
                      MY SHAPES
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="btn-ghost site-mobile-nav-row"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        closeNav();
                        onDisconnect();
                      }}
                    >
                      DISCONNECT
                    </button>
                  </div>
                )}
              </div>
            )}
          />
        </div>
      </div>
    </header>
  );
}
