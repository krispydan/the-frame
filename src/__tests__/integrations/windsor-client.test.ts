/**
 * Windsor client tests.
 *
 * Pure-function coverage (prefixing, chunking, redaction, error
 * classification) plus fetch-level behaviour via an injected fetch. No DB,
 * no network — the client is the foundation every Amazon report sits on, and
 * a chunking or classification bug here shows up much later as a hole in the
 * ledger.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchWindsorReport,
  chunkDateRange,
  reportPrefix,
  redact,
  classifyError,
  WindsorError,
  probeConnector,
  type WindsorReport,
} from "@/modules/integrations/lib/windsor/client";

const REPORT: WindsorReport = {
  connector: "amazon_sp",
  report: "get_sales_and_traffic_report_by_date",
  fields: ["date", "salesbydate_unitsordered"],
  maxWindowDays: 7,
  timeoutMs: 5_000,
};

const PREFIX = "sales_and_traffic_report_by_date__";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const noSleep = async () => {};

beforeEach(() => {
  process.env.WINDSOR_API_KEY = "test-key-abc123";
});

afterEach(() => {
  delete process.env.WINDSOR_API_KEY;
});

describe("reportPrefix", () => {
  it("strips the get_ prefix and appends __", () => {
    expect(reportPrefix("get_sales_and_traffic_report_by_date")).toBe("sales_and_traffic_report_by_date__");
    expect(reportPrefix("get_v2_settlement_report_data_flat_file_v2")).toBe("v2_settlement_report_data_flat_file_v2__");
  });

  it("is a no-op for a name without the prefix", () => {
    expect(reportPrefix("custom_report")).toBe("custom_report__");
  });
});

describe("redact", () => {
  it("removes the configured API key", () => {
    expect(redact("failed for api_key=test-key-abc123 oops")).not.toContain("test-key-abc123");
  });

  it("removes any api_key parameter even if it is not the configured one", () => {
    // A rotated key echoed back by upstream must not leak either.
    const out = redact("https://connectors.windsor.ai/amazon_sp?api_key=some-other-secret&fields=x");
    expect(out).not.toContain("some-other-secret");
    expect(out).toContain("api_key=***");
  });

  it("leaves innocuous text alone", () => {
    expect(redact("no secrets here")).toBe("no secrets here");
  });
});

describe("chunkDateRange", () => {
  it("returns a single chunk when the range fits", () => {
    expect(chunkDateRange("2026-07-01", "2026-07-07", 7)).toEqual([{ from: "2026-07-01", to: "2026-07-07" }]);
  });

  it("splits a longer range into inclusive, contiguous, non-overlapping chunks", () => {
    const chunks = chunkDateRange("2026-07-01", "2026-07-20", 7);
    expect(chunks).toEqual([
      { from: "2026-07-01", to: "2026-07-07" },
      { from: "2026-07-08", to: "2026-07-14" },
      { from: "2026-07-15", to: "2026-07-20" },
    ]);
  });

  it("covers every day exactly once — no gaps, no duplicates", () => {
    const chunks = chunkDateRange("2026-01-01", "2026-03-31", 7);
    const days = new Set<string>();
    for (const c of chunks) {
      let d = c.from;
      while (Date.parse(d) <= Date.parse(c.to)) {
        expect(days.has(d)).toBe(false); // no day counted twice
        days.add(d);
        d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      }
    }
    expect(days.size).toBe(90); // Jan 31 + Feb 28 + Mar 31
  });

  it("throws on an inverted range rather than returning an empty-looking result", () => {
    // Windsor answers an inverted range with [], which is indistinguishable
    // from "no sales" — so this must fail loudly.
    expect(() => chunkDateRange("2026-07-20", "2026-07-01", 7)).toThrow(/after/);
  });

  it("handles a single-day range", () => {
    expect(chunkDateRange("2026-07-01", "2026-07-01", 7)).toEqual([{ from: "2026-07-01", to: "2026-07-01" }]);
  });

  it("spans month and year boundaries", () => {
    const chunks = chunkDateRange("2025-12-29", "2026-01-04", 3);
    expect(chunks[0]).toEqual({ from: "2025-12-29", to: "2025-12-31" });
    expect(chunks.at(-1)?.to).toBe("2026-01-04");
  });
});

describe("classifyError", () => {
  const cases: Array<[string, string, boolean]> = [
    ["We don't have this connector yet!", "unknown_connector", false],
    ["No shopify account for user danielgetjaxycom was found, add your accounts at ...", "no_account", false],
    ["Could not determine a report to pull data from.", "bad_fields", false],
    ["Error fetching Settlement_report. Please choose a date that is within the last 90 days from today.", "date_range", false],
    ["The report request from Amazon has been automatically cancelled. This can occur if there is no data available to return.", "no_data", false],
    ["Something exploded upstream", "http", true],
  ];

  for (const [message, kind, retryable] of cases) {
    it(`classifies "${message.slice(0, 40)}..." as ${kind}`, () => {
      const err = classifyError(message, "amazon_sp", "get_x");
      expect(err.kind).toBe(kind);
      expect(err.retryable).toBe(retryable);
    });
  }

  it("treats 401/403 as auth regardless of wording", () => {
    expect(classifyError("nope", "amazon_sp", undefined, 403).kind).toBe("auth");
  });
});

describe("fetchWindsorReport", () => {
  it("builds a prefixed field list and strips prefixes off the response", async () => {
    let calledUrl = "";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calledUrl = String(url);
      return jsonResponse({ data: [{ [`${PREFIX}date`]: "2026-07-05", [`${PREFIX}salesbydate_unitsordered`]: 4 }] });
    }) as unknown as typeof fetch;

    const rows = await fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep });

    expect(calledUrl).toContain(`fields=${encodeURIComponent(`${PREFIX}date,${PREFIX}salesbydate_unitsordered`)}`);
    expect(calledUrl).toContain("date_preset=last_7d");
    // Callers see clean names, never the mangled upstream ones.
    expect(rows).toEqual([{ date: "2026-07-05", salesbydate_unitsordered: 4 }]);
  });

  it("issues one request per chunk and concatenates the rows", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ [`${PREFIX}date`]: "2026-07-05" }] }),
    ) as unknown as typeof fetch;

    const rows = await fetchWindsorReport(REPORT, {
      dateFrom: "2026-07-01",
      dateTo: "2026-07-20",
      fetchImpl,
      sleepImpl: noSleep,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(3);
  });

  it("reports progress per chunk", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    const progress: number[] = [];
    await fetchWindsorReport(REPORT, {
      dateFrom: "2026-07-01",
      dateTo: "2026-07-14",
      fetchImpl,
      sleepImpl: noSleep,
      onProgress: (p) => progress.push(p.chunk),
    });
    expect(progress).toEqual([1, 2]);
  });

  it("retries a retryable failure and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ error: "upstream exploded" }, 500);
      return jsonResponse({ data: [{ [`${PREFIX}date`]: "2026-07-05" }] });
    }) as unknown as typeof fetch;

    const rows = await fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep, retries: 2 });
    expect(calls).toBe(2);
    expect(rows).toHaveLength(1);
  });

  it("does NOT retry a non-retryable failure — retrying a missing account just burns minutes", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "No amazon_sp account for user x was found, add your accounts at ..." }, 400),
    ) as unknown as typeof fetch;

    await expect(
      fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep, retries: 3 }),
    ).rejects.toMatchObject({ kind: "no_account" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the 90-day settlement limit as a typed, non-retryable error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "Error fetching Settlement_report. Please choose a date that is within the last 90 days from today." }, 400),
    ) as unknown as typeof fetch;

    await expect(
      fetchWindsorReport(REPORT, { dateFrom: "2025-01-01", dateTo: "2025-01-05", fetchImpl, sleepImpl: noSleep }),
    ).rejects.toMatchObject({ kind: "date_range", retryable: false });
  });

  it("classifies an aborted request as a retryable timeout", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // Simulate the abort the client's own timeout would trigger.
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      void init;
      throw err;
    }) as unknown as typeof fetch;

    await expect(
      fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep, retries: 0 }),
    ).rejects.toMatchObject({ kind: "timeout", retryable: true });
  });

  it("throws a clear, non-retryable error when the API key is missing", async () => {
    delete process.env.WINDSOR_API_KEY;
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep }),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never leaks the API key in an error message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect failed for https://connectors.windsor.ai/amazon_sp?api_key=test-key-abc123");
    }) as unknown as typeof fetch;

    let captured: WindsorError | undefined;
    try {
      await fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep, retries: 0 });
    } catch (e) {
      captured = e as WindsorError;
    }
    expect(captured?.message).toBeDefined();
    expect(captured?.message).not.toContain("test-key-abc123");
  });

  it("rejects a 200 response that is not the expected envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch;
    await expect(
      fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep }),
    ).rejects.toMatchObject({ kind: "parse" });
  });

  it("rejects non-JSON bodies without throwing a raw SyntaxError", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>gateway timeout</html>", { status: 504 })) as unknown as typeof fetch;
    await expect(
      fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep, retries: 0 }),
    ).rejects.toBeInstanceOf(WindsorError);
  });

  it("returns an empty array for an empty data set rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    await expect(
      fetchWindsorReport(REPORT, { datePreset: "last_7d", fetchImpl, sleepImpl: noSleep }),
    ).resolves.toEqual([]);
  });
});

describe("probeConnector", () => {
  it("reports ok for a linked connector", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    await expect(
      probeConnector("amazon_sp", { report: "get_x", fields: ["a"] }, { fetchImpl }),
    ).resolves.toEqual({ ok: true });
  });

  it("reports the reason for an unlinked connector instead of throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "No tiktok_shop account for user x was found, add your accounts at ..." }, 400),
    ) as unknown as typeof fetch;
    const res = await probeConnector("tiktok_shop", { report: "get_x", fields: ["a"] }, { fetchImpl });
    expect(res).toMatchObject({ ok: false, kind: "no_account" });
  });
});
