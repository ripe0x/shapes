/**
 * Persists the post-write confirmation toast across a remount, keyed once in `sessionStorage`
 * and consumed on the next mount. On the Next host, a route change after compose/decompose/
 * split/redeem remounts `SiteApp` through the catch-all segment before the toast can be read;
 * `sessionStorage` survives that remount without coupling the shared `SiteApp` component to any
 * particular host's routing.
 */
export interface ActionNotice {
  title: string;
  detail: string;
  hash: string;
  tokenIds: bigint[];
}

const KEY = "shapes:actionNotice";

/** The notice a previous mount stored, or null when there is none or storage is unavailable
 *  (private browsing, disabled storage). Consumes it: a second call in the same session returns
 *  null even if nothing re-stores one. */
export function takeStoredActionNotice(): ActionNotice | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as {title: string; detail: string; hash: string; tokenIds: string[]};
    return {...parsed, tokenIds: parsed.tokenIds.map(BigInt)};
  } catch {
    return null;
  }
}

/** Stores a notice for the next mount to pick up via `takeStoredActionNotice`. */
export function storeActionNotice(notice: ActionNotice): void {
  try {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({...notice, tokenIds: notice.tokenIds.map(String)}),
    );
  } catch {
    // Storage unavailable: the notice just does not survive a remount.
  }
}

/** Clears a stored notice, e.g. when the viewer dismisses it before any remount happens. */
export function clearStoredActionNotice(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage unavailable; nothing to clear.
  }
}
