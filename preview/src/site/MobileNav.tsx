"use client";

import React from "react";
import {C, FONT} from "./theme";

export interface MobileNavItem {
  label: string;
  /** Plain href for a wallet-free link. Omit and use onClick for an in-app view change. */
  href?: string;
  onClick?: () => void;
  /** Marks the row as the current view; colored ink instead of muted. */
  active?: boolean;
}

/**
 * Hamburger toggle and dropdown panel for narrow viewports, shared by the wallet-aware app
 * header (SiteHeader) and the wallet-free docs header. CSS shows the toggle and panel only at
 * and below 700px (see .site-mobile-nav in globals.css); above that this renders nothing visible.
 */
export function MobileNav({
  items,
  accountSlot,
}: {
  items: MobileNavItem[];
  /** Trailing account row. Receives a close callback so its own actions (connect, disconnect,
   *  switch chain) collapse the panel the same way a link tap does. */
  accountSlot?: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    // Covers back/forward navigation; a link tap or in-app view change already closes via its
    // own onClick below.
    const onPopState = () => close();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("popstate", onPopState);
    };
  }, [open, close]);

  return (
    <div className="site-mobile-nav" ref={rootRef} style={{fontFamily: FONT}}>
      <button
        type="button"
        className="btn-ghost site-mobile-nav-toggle"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls="site-mobile-nav-panel"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`site-mobile-nav-icon${open ? " is-open" : ""}`} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </button>
      <div
        id="site-mobile-nav-panel"
        className={`site-mobile-nav-panel${open ? " is-open" : ""}`}
        aria-hidden={!open}
      >
        {items.map((item) =>
          item.href !== undefined ? (
            <a
              key={item.label}
              href={item.href}
              className="site-mobile-nav-row"
              style={{color: item.active ? C.ink : C.muted}}
              onClick={close}
            >
              {item.label}
            </a>
          ) : (
            <button
              key={item.label}
              type="button"
              className="btn-ghost site-mobile-nav-row"
              style={{color: item.active ? C.ink : C.muted}}
              onClick={() => {
                close();
                item.onClick?.();
              }}
            >
              {item.label}
            </button>
          ),
        )}
        {accountSlot?.(close)}
      </div>
    </div>
  );
}
