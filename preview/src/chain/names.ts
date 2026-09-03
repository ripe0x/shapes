import {createPublicClient, type PublicClient} from "viem";
import {mainnet} from "viem/chains";
import {createEthereumNames, type ResolvedName} from "@1001-digital/ethereum-names";
import {shapesTransport} from "./rpc";

/**
 * Reverse resolution of an address to its primary name across ENS, GNS (.gwei) and WNS (.wei).
 *
 * Lookups always run against Ethereum mainnet, whatever chain the app targets, because the
 * primary-name records of all three systems live there. A resolver caches every answer in memory
 * and mirrors it to localStorage with no expiry, deduplicates concurrent requests for one address,
 * and collects the addresses requested within a short window into one batch that runs at a bounded
 * concurrency, so a gallery of many cards issues a few requests rather than one per card.
 *
 * A lookup that fails (RPC error) is cached as no name for the session and is not written to
 * storage, so the address is tried again on the next load. A lookup that succeeds with no name,
 * or with a name that fails forward verification, is cached like any other answer.
 */

const STORAGE_KEY = "shapes.names.v1";
const BATCH_MS = 50;
const CONCURRENCY = 4;

/** One reverse lookup. `ok` is false when the lookup itself failed rather than finding no name. */
export interface LookupResult {
  name: string | null;
  ok: boolean;
}

export type NameLookup = (address: string) => Promise<LookupResult>;

/** The subset of the Storage interface the cache mirror uses. */
export interface NameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NameResolverOptions {
  lookup: NameLookup;
  /** localStorage key for the cache mirror. Omit to keep the cache in memory only. */
  storageKey?: string;
  /** Storage backing the mirror. Defaults to the global localStorage when it is available. */
  storage?: NameStorage;
  batchMs?: number;
  concurrency?: number;
}

export interface NameResolver {
  /** Cached name, or undefined when the address has not been looked up yet. No network. */
  peek(address: string): string | null | undefined;
  /** Cached name, otherwise a batched lookup. Null when the address has no verified name. */
  resolve(address: string): Promise<string | null>;
}

/**
 * The name a lookup result may be displayed as. A name is taken only from a forward-verified
 * answer: `status: "unverified"` means the reverse record named someone else's name and the
 * library already withheld it. `status: "error"` is reported as a failed lookup so it is not
 * cached as a durable answer.
 */
export function nameFromLookup(result: ResolvedName<string>): LookupResult {
  if (result.status === "error") return {name: null, ok: false};
  return {name: result.status === "resolved" ? result.name : null, ok: true};
}

function defaultStorage(): NameStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // Storage access throws in some embedded and privacy contexts. The cache stays in memory.
    return undefined;
  }
}

export function createNameResolver(options: NameResolverOptions): NameResolver {
  const {lookup, storageKey, batchMs = BATCH_MS, concurrency = CONCURRENCY} = options;
  const storage = storageKey === undefined ? undefined : options.storage ?? defaultStorage();

  /** Answers kept for good and mirrored to storage. A null value means the address has no name. */
  const cache = new Map<string, string | null>();
  /** Addresses whose lookup failed. Cleared when the page reloads. */
  const failed = new Set<string>();
  const pending = new Map<string, {promise: Promise<string | null>; settle: (name: string | null) => void}>();

  let queue: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hydrated = false;

  function hydrate(): void {
    if (hydrated) return;
    hydrated = true;
    if (!storage || !storageKey) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, string | null>;
      for (const [address, name] of Object.entries(parsed)) cache.set(address, name);
    } catch {
      // Storage unavailable or the stored JSON is corrupt. Start from an empty cache.
    }
  }

  function persist(): void {
    if (!storage || !storageKey) return;
    try {
      storage.setItem(storageKey, JSON.stringify(Object.fromEntries(cache)));
    } catch {
      // A failed write (quota, disabled storage) leaves the in-memory cache intact.
    }
  }

  async function flush(): Promise<void> {
    const keys = queue;
    queue = [];
    if (keys.length === 0) return;

    let next = 0;
    let stored = false;
    const worker = async (): Promise<void> => {
      while (next < keys.length) {
        const key = keys[next++];
        let result: LookupResult;
        try {
          result = await lookup(key);
        } catch {
          result = {name: null, ok: false};
        }
        if (result.ok) {
          cache.set(key, result.name);
          stored = true;
        } else {
          failed.add(key);
        }
        pending.get(key)?.settle(result.name);
        pending.delete(key);
      }
    };
    await Promise.all(Array.from({length: Math.min(concurrency, keys.length)}, worker));
    if (stored) persist();
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, batchMs);
  }

  function peek(address: string): string | null | undefined {
    hydrate();
    const key = address.toLowerCase();
    if (cache.has(key)) return cache.get(key) ?? null;
    return failed.has(key) ? null : undefined;
  }

  function resolve(address: string): Promise<string | null> {
    hydrate();
    const key = address.toLowerCase();
    if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
    if (failed.has(key)) return Promise.resolve(null);

    const existing = pending.get(key);
    if (existing) return existing.promise;

    let settle!: (name: string | null) => void;
    const promise = new Promise<string | null>((done) => {
      settle = done;
    });
    pending.set(key, {promise, settle});
    queue.push(key);
    schedule();
    return promise;
  }

  return {peek, resolve};
}

let mainnetNames: ReturnType<typeof createEthereumNames> | undefined;

/** Reverse lookup against mainnet, over the shared public-endpoint failover transport. */
const mainnetLookup: NameLookup = async (address) => {
  mainnetNames ??= createEthereumNames({
    client: createPublicClient({
      chain: mainnet,
      transport: shapesTransport(mainnet.id, ""),
    }) as PublicClient,
  });
  return nameFromLookup(await mainnetNames.lookup(address));
};

/** The resolver every address display reads from, so one lookup serves the whole page. */
export const names = createNameResolver({lookup: mainnetLookup, storageKey: STORAGE_KEY});
