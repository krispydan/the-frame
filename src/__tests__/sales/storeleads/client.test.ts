/**
 * Vitest tests for the StoreLeads API client. Mocks global fetch so no
 * real API call leaves the test runner. Covers:
 *   - Auth header shape
 *   - 2xx happy path for getStoreByDomain + bulkGetStoresByDomain
 *   - 404 → null on getStoreByDomain (vs. throwing)
 *   - 429 retry honouring Retry-After (then surfacing on second 429)
 *   - 5xx surfacing as StoreLeadsError with body preview
 *   - addDomainsToList payload shape + ≤10k guard
 *   - searchDomains filter encoding + cursor pass-through
 *   - isConfigured() reflects env presence
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.STORELEADS_API_KEY = "test-key-aaaa-bbbb-cccc-dddd";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
});

function mockFetch(impls: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
  let i = 0;
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const fn = impls[Math.min(i, impls.length - 1)];
    i++;
    return fn(String(url), init);
  }) as typeof fetch;
}

describe("storeleads/client", () => {
  it("isConfigured reads STORELEADS_API_KEY", async () => {
    const { isConfigured } = await import("@/modules/sales/lib/storeleads/client");
    expect(isConfigured()).toBe(true);
    delete process.env.STORELEADS_API_KEY;
    expect(isConfigured()).toBe(false);
  });

  it("getStoreByDomain sends Bearer auth and parses the {domain:{}} envelope", async () => {
    let capturedHeaders: Record<string, string> = {};
    mockFetch([
      (_url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        );
        return new Response(
          JSON.stringify({ domain: { domain: "shopdressup.com", platform: "shopify" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    ]);
    const { getStoreByDomain } = await import("@/modules/sales/lib/storeleads/client");
    const res = await getStoreByDomain("shopdressup.com");
    expect(res?.domain).toBe("shopdressup.com");
    expect(res?.platform).toBe("shopify");
    expect(capturedHeaders.Authorization).toBe("Bearer test-key-aaaa-bbbb-cccc-dddd");
  });

  it("getStoreByDomain returns null on 404", async () => {
    mockFetch([
      () => new Response("not found", { status: 404 }),
    ]);
    const { getStoreByDomain } = await import("@/modules/sales/lib/storeleads/client");
    expect(await getStoreByDomain("nonexistent-xyz-123.example")).toBeNull();
  });

  it("retries once on 429 honouring Retry-After", async () => {
    mockFetch([
      () => new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
      () => new Response(JSON.stringify({ domain: { domain: "ok.com" } }), { status: 200 }),
    ]);
    const { getStoreByDomain } = await import("@/modules/sales/lib/storeleads/client");
    const p = getStoreByDomain("ok.com");
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;
    expect(res?.domain).toBe("ok.com");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces a second 429 as an error (no infinite retry)", async () => {
    mockFetch([
      () => new Response("", { status: 429, headers: { "Retry-After": "1" } }),
      () => new Response("still rate-limited", { status: 429, headers: { "Retry-After": "1" } }),
    ]);
    const { getStoreByDomain, StoreLeadsError } = await import("@/modules/sales/lib/storeleads/client");
    const p = getStoreByDomain("rl.com").catch((e) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const err = await p;
    expect(err).toBeInstanceOf(StoreLeadsError);
    expect(err.status).toBe(429);
  });

  it("5xx surfaces as StoreLeadsError with body preview", async () => {
    mockFetch([
      () => new Response("upstream went boom", { status: 502 }),
    ]);
    const { getStoreByDomain, StoreLeadsError } = await import("@/modules/sales/lib/storeleads/client");
    const err = await getStoreByDomain("boom.com").catch((e) => e);
    expect(err).toBeInstanceOf(StoreLeadsError);
    expect(err.status).toBe(502);
    expect(err.bodyPreview).toContain("upstream went boom");
  });

  it("bulkGetStoresByDomain posts {domains:[]} and keys the response by domain", async () => {
    let body: Record<string, unknown> = {};
    mockFetch([
      (_url, init) => {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            domains: [
              { domain: "a.com", platform: "shopify" },
              { domain: "b.com", platform: "woocommerce" },
            ],
          }),
          { status: 200 },
        );
      },
    ]);
    const { bulkGetStoresByDomain } = await import("@/modules/sales/lib/storeleads/client");
    const res = await bulkGetStoresByDomain(["a.com", "b.com", "missing.com"]);
    expect(body).toEqual({ domains: ["a.com", "b.com", "missing.com"] });
    expect(res["a.com"]?.platform).toBe("shopify");
    expect(res["b.com"]?.platform).toBe("woocommerce");
    expect(res["missing.com"]).toBeUndefined();
  });

  it("bulkGetStoresByDomain enforces the 100-domain ceiling client-side", async () => {
    const { bulkGetStoresByDomain } = await import("@/modules/sales/lib/storeleads/client");
    const tooMany = Array.from({ length: 101 }, (_, i) => `d${i}.com`);
    await expect(bulkGetStoresByDomain(tooMany)).rejects.toThrow(/max 100/);
  });

  it("addDomainsToList PUTs to the encoded list name and parses the response", async () => {
    let url = "";
    let method = "";
    let body: Record<string, unknown> = {};
    mockFetch([
      (capturedUrl, init) => {
        url = capturedUrl;
        method = init?.method ?? "";
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            list: { id: 7, name: "Jaxy Customers" },
            count_domains_added: 2,
            unrecognized_domains: ["nope.com"],
          }),
          { status: 200 },
        );
      },
    ]);
    const { addDomainsToList } = await import("@/modules/sales/lib/storeleads/client");
    const res = await addDomainsToList({
      listName: "Jaxy Customers",
      domains: ["a.com", "b.com", "nope.com"],
    });
    expect(method).toBe("PUT");
    expect(url).toContain("/list/Jaxy%20Customers/add-domains");
    expect(body).toEqual({ domains: ["a.com", "b.com", "nope.com"] });
    expect(res.list.id).toBe(7);
    expect(res.countAdded).toBe(2);
    expect(res.unrecognized).toEqual(["nope.com"]);
  });

  it("addDomainsToList enforces the 10,000-domain ceiling client-side", async () => {
    const { addDomainsToList } = await import("@/modules/sales/lib/storeleads/client");
    const tooMany = Array.from({ length: 10001 }, (_, i) => `d${i}.com`);
    await expect(
      addDomainsToList({ listName: "x", domains: tooMany }),
    ).rejects.toThrow(/max 10,000/);
  });

  it("searchDomains encodes filters and cursor in the querystring", async () => {
    let url = "";
    mockFetch([
      (capturedUrl) => {
        url = capturedUrl;
        return new Response(
          JSON.stringify({
            domains: [{ domain: "x.com" }],
            next_cursor: "abc123",
            total: 1234,
          }),
          { status: 200 },
        );
      },
    ]);
    const { searchDomains } = await import("@/modules/sales/lib/storeleads/client");
    const res = await searchDomains({
      filters: { "f:cc": "US", "f:platform": "shopify" },
      pageSize: 50,
      cursor: "page2",
    });
    expect(url).toContain("page_size=50");
    expect(url).toContain("cursor=page2");
    expect(url).toContain("f%3Acc=US");
    expect(url).toContain("f%3Aplatform=shopify");
    expect(res.domains).toHaveLength(1);
    expect(res.nextCursor).toBe("abc123");
    expect(res.total).toBe(1234);
  });
});
