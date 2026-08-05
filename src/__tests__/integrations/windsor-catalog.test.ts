/**
 * Windsor catalog probe.
 *
 * The probe exists to answer "what can this account actually serve?", so the
 * field→report grouping is the whole value. A first version grouped on a dot
 * prefix, which put 898 of 899 fields in one bucket and hid every report name
 * — the probe ran, returned 200, and told you nothing.
 *
 * Also pins redaction: the API key travels in the query string, so an
 * unredacted failure would leak it into a log, a response body or an alert.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchWindsorCatalog } from "@/modules/integrations/lib/windsor/catalog";

const KEY = "test-key-abc123";

beforeEach(() => { process.env.WINDSOR_API_KEY = KEY; });
afterEach(() => { vi.unstubAllGlobals(); });

const ok = (fields: string[]) => (async () => ({
  ok: true, status: 200, json: async () => ({ data: fields.map((name) => ({ name })) }),
})) as unknown as typeof fetch;

describe("grouping", () => {
  it("groups fields by the report named in the trailing parenthesis", async () => {
    const r = await fetchWindsorCatalog("amazon_sp", {
      fetchImpl: ok([
        "seller-sku (get_afn_inventory_data_by_country)",
        "asin (get_afn_inventory_data_by_country)",
        "amazon-order-id (get_amazon_fulfilled_shipments_data_general)",
      ]),
    });

    expect(r.ok).toBe(true);
    expect(r.reportCount).toBe(2);
    const inv = r.reports.find((x) => x.report === "get_afn_inventory_data_by_country")!;
    expect(inv.fieldCount).toBe(2);
    expect(inv.sampleFields).toEqual(["seller-sku", "asin"]);
  });

  it("keeps unqualified fields rather than dropping them", async () => {
    const r = await fetchWindsorCatalog("amazon_sp", {
      fetchImpl: ok(["Account ID", "Account Name", "sku (get_orders)"]),
    });
    const acct = r.reports.find((x) => x.report === "(account)")!;
    expect(acct.fieldCount).toBe(2);
    expect(r.fieldCount).toBe(3);
  });

  it("sorts reports so the same account reads the same way twice", async () => {
    const r = await fetchWindsorCatalog("x", {
      fetchImpl: ok(["a (zeta)", "b (alpha)"]),
    });
    expect(r.reports.map((x) => x.report)).toEqual(["alpha", "zeta"]);
  });

  it("caps the sample rather than returning every field", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `f${i} (rep)`);
    const r = await fetchWindsorCatalog("x", { fetchImpl: ok(many) });
    expect(r.reports[0].fieldCount).toBe(40);
    expect(r.reports[0].sampleFields).toHaveLength(12);
  });

  it("accepts a bare string array as well as objects", async () => {
    const impl = (async () => ({
      ok: true, status: 200, json: async () => ["sku (get_orders)"],
    })) as unknown as typeof fetch;
    const r = await fetchWindsorCatalog("x", { fetchImpl: impl });
    expect(r.reportCount).toBe(1);
  });
});

describe("failures", () => {
  it("reports an unconnected account without throwing", async () => {
    const impl = (async () => ({
      ok: false, status: 400,
      text: async () => '{"error":"No amazon_ads account for user was found"}',
    })) as unknown as typeof fetch;

    const r = await fetchWindsorCatalog("amazon_ads", { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("No amazon_ads account");
    expect(r.reports).toEqual([]);
  });

  it("never lets the api key reach the error text", async () => {
    const impl = (async () => ({
      ok: false, status: 500,
      text: async () => `upstream failed for api_key=${KEY} on retry`,
    })) as unknown as typeof fetch;

    const r = await fetchWindsorCatalog("amazon_sp", { fetchImpl: impl });
    expect(r.error).not.toContain(KEY);
    expect(r.error).toContain("***");
  });

  it("redacts a thrown network error too", async () => {
    const impl = (async () => { throw new Error(`connect failed api_key=${KEY}`); }) as unknown as typeof fetch;
    const r = await fetchWindsorCatalog("amazon_sp", { fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(KEY);
  });

  it("says so when no key is configured instead of calling out", async () => {
    delete process.env.WINDSOR_API_KEY;
    let called = false;
    const impl = (async () => { called = true; return { ok: true, json: async () => [] }; }) as unknown as typeof fetch;
    const r = await fetchWindsorCatalog("amazon_sp", { fetchImpl: impl });
    expect(called).toBe(false);
    expect(r.error).toContain("WINDSOR_API_KEY");
  });
});
