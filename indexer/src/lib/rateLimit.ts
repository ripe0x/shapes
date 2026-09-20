// Fixed-window per-key rate limiter for the public v1 routes. Each indexer app runs one Fly
// Machine (see README.md "Production deployment"), so process-local state is the whole picture;
// no shared store is needed for a single instance.
//
// ponytail: fixed window rather than sliding, and a size-triggered sweep instead of a timer.
// Upgrade to a sliding window or a shared store (Redis) if this indexer ever runs more than one
// machine, or if the fixed-window edge (up to 2x `limit` requests across a window boundary)
// matters at the observed traffic level.
export interface RateLimiter {
  /** True if `key` may proceed; false if it has exceeded `limit` requests in the current window. */
  allow(key: string): boolean;
}

const SWEEP_THRESHOLD = 10_000;

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  function sweep(now: number): void {
    if (windows.size < SWEEP_THRESHOLD) return;
    for (const [key, entry] of windows) {
      if (now >= entry.resetAt) windows.delete(key);
    }
  }

  return {
    allow(key: string): boolean {
      const now = Date.now();
      sweep(now);
      const entry = windows.get(key);
      if (!entry || now >= entry.resetAt) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count += 1;
      return true;
    },
  };
}
