/**
 * Tiny in-process cache with stale-while-revalidate.
 *
 * The dashboard bundle is expensive to build (whole-table scans for product
 * performance, FIFO P&L, business health) but changes slowly — nobody needs
 * second-level freshness on a 30-day revenue trend. Caching it per
 * (role, range, part) turns the common case into a memory read.
 *
 * The app runs as a single Node process on Railway, so a Map is sufficient and
 * avoids adding Redis. Entries are small (JSON-able aggregates), and the key
 * space is bounded by roles × ranges × parts.
 *
 * Semantics:
 *   fresh (< ttlMs)                → return immediately
 *   stale (< ttlMs + staleMs)      → return immediately, refresh in background
 *   expired                        → compute and wait
 * Concurrent callers share one in-flight build rather than stampeding.
 */

interface Entry<T> {
  value: T;
  builtAt: number;
  inFlight?: Promise<T>;
}

const store = new Map<string, Entry<unknown>>();

export interface CacheOptions {
  /** How long the value is considered fresh. */
  ttlMs?: number;
  /** Extra window during which a stale value is served while refreshing. */
  staleMs?: number;
  /** Skip the cache and rebuild (manual refresh). */
  force?: boolean;
}

export interface CachedResult<T> {
  value: T;
  /** True when served from cache rather than freshly computed. */
  cached: boolean;
  /** When the returned value was actually computed. */
  builtAt: number;
}

export async function cached<T>(
  key: string,
  build: () => T | Promise<T>,
  opts: CacheOptions = {},
): Promise<CachedResult<T>> {
  const ttlMs = opts.ttlMs ?? 60_000;
  const staleMs = opts.staleMs ?? 4 * 60_000;
  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;

  if (!opts.force && entry) {
    const age = now - entry.builtAt;
    if (age < ttlMs) {
      return { value: entry.value, cached: true, builtAt: entry.builtAt };
    }
    if (age < ttlMs + staleMs) {
      // Serve stale, refresh behind the request. Errors are swallowed — the
      // next caller simply gets the older value or rebuilds synchronously.
      if (!entry.inFlight) {
        entry.inFlight = Promise.resolve()
          .then(build)
          .then((fresh) => {
            store.set(key, { value: fresh, builtAt: Date.now() });
            return fresh;
          })
          .catch((e) => {
            console.warn(`[dashboard-cache] background refresh failed for ${key}:`, e instanceof Error ? e.message : e);
            delete entry.inFlight;
            return entry.value;
          });
      }
      return { value: entry.value, cached: true, builtAt: entry.builtAt };
    }
  }

  // Expired or forced: if someone is already building, join them.
  if (!opts.force && entry?.inFlight) {
    const value = await entry.inFlight;
    return { value, cached: true, builtAt: Date.now() };
  }

  const promise = Promise.resolve().then(build);
  store.set(key, { value: entry?.value as T, builtAt: entry?.builtAt ?? 0, inFlight: promise });
  try {
    const value = await promise;
    store.set(key, { value, builtAt: Date.now() });
    return { value, cached: false, builtAt: Date.now() };
  } catch (e) {
    store.delete(key);
    throw e;
  }
}

/** Drop cached entries (all, or those whose key contains `match`). */
export function invalidate(match?: string): number {
  if (!match) {
    const n = store.size;
    store.clear();
    return n;
  }
  let n = 0;
  for (const key of [...store.keys()]) {
    if (key.includes(match)) {
      store.delete(key);
      n++;
    }
  }
  return n;
}
