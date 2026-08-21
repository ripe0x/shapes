import React from "react";
import type {PublicClient} from "viem";
import {short} from "./ui";

/**
 * ENS name resolution with permanent caching. A resolved name is cached forever and never
 * refetched. A miss — no name registered, or the connected chain has no ENS registry (a local dev
 * chain) — is cached for NEGATIVE_TTL_MS and retried after that, so a stale miss on the connected
 * chain does not follow the site forever once it switches to one with real ENS support. The cache
 * is kept in memory and mirrored to localStorage so it survives a reload.
 */

interface CacheEntry {
  name: string | null;
  /** Epoch ms after which a negative result is retried. Null for a resolved name: never retried. */
  expiresAt: number | null;
}

const STORAGE_KEY = "shapes.ensCache.v1";
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, CacheEntry>();
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    for (const [addr, entry] of Object.entries(parsed)) cache.set(addr, entry);
  } catch {
    // localStorage unavailable (private browsing, disabled storage) or corrupt JSON: start empty.
  }
}

function persist(): void {
  try {
    const obj: Record<string, CacheEntry> = {};
    for (const [addr, entry] of cache) obj[addr] = entry;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // storage write failed (quota, private browsing): the cache still works in memory this session.
  }
}

function fresh(entry: CacheEntry | undefined, now: number): boolean {
  if (!entry) return false;
  return entry.expiresAt === null || entry.expiresAt > now;
}

/** Synchronous cache read, no network. Returns undefined when nothing is cached yet or the cached
 *  entry has expired. */
export function peekEnsName(address: `0x${string}`): string | null | undefined {
  hydrate();
  const entry = cache.get(address.toLowerCase());
  return fresh(entry, Date.now()) ? entry!.name : undefined;
}

/** Resolves an address to its ENS name, consulting and updating the permanent cache. Resolves to
 *  null when the address has no name, or when ENS lookup is unsupported on the connected chain —
 *  a local dev chain has no ENS registry configured, so `getEnsName` rejects and that is cached
 *  as a miss the same as a real one. */
export async function resolveEnsName(
  publicClient: PublicClient | undefined,
  address: `0x${string}`,
): Promise<string | null> {
  hydrate();
  const key = address.toLowerCase();
  const now = Date.now();
  const cached = cache.get(key);
  if (fresh(cached, now)) return cached!.name;
  if (!publicClient) return cached?.name ?? null;

  let name: string | null;
  try {
    name = await publicClient.getEnsName({address});
  } catch {
    name = null;
  }
  cache.set(key, {name, expiresAt: name === null ? now + NEGATIVE_TTL_MS : null});
  persist();
  return name;
}

/** Displays an address as its ENS name once resolved, the short address form until then or on a
 *  miss. Resolution runs once per address per cache TTL and every caller for the same address
 *  shares the one permanent cache, so a name looked up in one place never refetches in another. */
export function useEnsDisplay(
  publicClient: PublicClient | undefined,
  address: `0x${string}` | undefined,
): string {
  const [name, setName] = React.useState<string | null | undefined>(() =>
    address ? peekEnsName(address) : undefined,
  );

  React.useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setName(peekEnsName(address));
    void resolveEnsName(publicClient, address).then((n) => {
      if (!cancelled) setName(n);
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient, address]);

  if (!address) return "";
  return name ?? short(address);
}
