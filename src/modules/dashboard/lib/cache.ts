/**
 * Two-tier dashboard cache with stale-while-revalidate.
 *
 * The dashboard bundle is expensive to build (~45s cold: whole-table scans for
 * product performance, FIFO P&L, business health) but only needs ~5h freshness
 * (per Daniel — Aug 2026). Caching it per (role, range, part) turns the common
 * case into a memory read.
 *
 *   L1: in-process Map — fastest, but dies on every deploy/restart, and this
 *       app deploys many times a day. Relying on it alone meant nearly every
 *       visit was a 45s cold build.
 *   L2: SQLite `dashboard_cache` table — survives restarts, so a deploy no
 *       longer throws away the bundle. Misses in L1 fall through to L2.
 *
 * A cron job (`dashboard-warm`, every 5h) force-rebuilds the bundles so a
 * human never pays the build cost; the Refresh button (fresh=1) still
 * recomputes on demand.
 *
 * Semantics:
 *   fresh (< ttlMs)                → return immediately
 *   stale (< ttlMs + staleMs)      → return immediately, refresh in background
 *   expired                        → compute and wait
 * Concurrent callers share one in-flight build rather than stampeding.
 */
import { sqlite } from "@/lib/db";

interface Entry<T> {
  value: T;
  builtAt: number;
  inFlight?: Promise<T>;
}

const store = new Map<string, Entry<unknown>>();

// ── L2 (SQLite) helpers — best-effort; a broken row never breaks the page ──

function l2Get<T>(key: string): Entry<T> | undefined {
  try {
    const row = sqlite.prepare("SELECT value_json, built_at FROM dashboard_cache WHERE key = ?").get(key) as
      | { value_json: string; built_at: number }
      | undefined;
    if (!row) return undefined;
    return { value: JSON.parse(row.value_json) as T, builtAt: row.built_at };
  } catch {
    return undefined;
  }
}

function l2Set(key: string, value: unknown, builtAt: number): void {
  try {
    sqlite.prepare(
      "INSERT INTO dashboard_cache (key, value_json, built_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, built_at = excluded.built_at",
    ).run(key, JSON.stringify(value), builtAt);
  } catch (e) {
    console.warn("[dashboard-cache] L2 write failed:", e instanceof Error ? e.message : e);
  }
}

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
  let entry = store.get(key) as Entry<T> | undefined;

  // L1 miss (fresh process after a deploy) → try the persisted copy so the
  // page is instant instead of a 45s cold build.
  if (!entry && !opts.force) {
    const persisted = l2Get<T>(key);
    if (persisted) {
      store.set(key, persisted);
      entry = persisted;
    }
  }

  if (!opts.force && entry) {
    const age = now - entry.builtAt;
    if (age < ttlMs) {
      return { value: entry.value, cached: true, builtAt: entry.builtAt };
    }
    if (age < ttlMs + staleMs) {
      // Serve stale, refresh behind the request. Errors are swallowed — the
      // next caller simply gets the older value or rebuilds synchronously.
      if (!entry.inFlight) {
        const staleEntry = entry;
        staleEntry.inFlight = Promise.resolve()
          .then(build)
          .then((fresh) => {
            const builtAt = Date.now();
            store.set(key, { value: fresh, builtAt });
            l2Set(key, fresh, builtAt);
            return fresh;
          })
          .catch((e) => {
            console.warn(`[dashboard-cache] background refresh failed for ${key}:`, e instanceof Error ? e.message : e);
            delete staleEntry.inFlight;
            return staleEntry.value;
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
    const builtAt = Date.now();
    store.set(key, { value, builtAt });
    l2Set(key, value, builtAt);
    return { value, cached: false, builtAt };
  } catch (e) {
    store.delete(key);
    throw e;
  }
}

/**
 * Build and store a bundle unconditionally (both tiers). Used by the
 * dashboard-warm cron so page loads never pay the cold-build cost.
 */
export async function primeCache<T>(key: string, build: () => T | Promise<T>): Promise<void> {
  const value = await Promise.resolve().then(build);
  const builtAt = Date.now();
  store.set(key, { value, builtAt });
  l2Set(key, value, builtAt);
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
