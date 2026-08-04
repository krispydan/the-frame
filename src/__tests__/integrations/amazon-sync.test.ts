/**
 * Amazon sync orchestrator tests.
 *
 * The point of these is the failure path, not the happy path. Windsor's
 * Amazon reports fail often enough that the escalation rules — debounce
 * transient timeouts, alert immediately on misconfiguration, never let a
 * Slack outage kill the cron tick — are the difference between a system
 * someone trusts and one they mute.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

// Loose arg typing so the mock can stand in for both call signatures and so
// `.mock.calls[n][0]` stays inspectable.
const fetchWindsorReport = vi.fn(async (..._args: unknown[]): Promise<unknown> => []);
const notifyIntegrationFailure = vi.fn(async (..._args: unknown[]): Promise<void> => {});

/** Reads an alert payload back out of the mock without fighting the types. */
function alertArg(call: number): { service: string; detail: string; fixUrl?: string } {
  return notifyIntegrationFailure.mock.calls[call][0] as { service: string; detail: string; fixUrl?: string };
}

vi.mock("@/modules/integrations/lib/windsor/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/integrations/lib/windsor/client")>();
  return { ...actual, fetchWindsorReport: (...a: unknown[]) => fetchWindsorReport(...a) };
});

vi.mock("@/modules/integrations/lib/slack/notifications", () => ({
  notifyIntegrationFailure: (...a: unknown[]) => notifyIntegrationFailure(...a),
}));

const { WindsorError } = await import("@/modules/integrations/lib/windsor/client");
const {
  syncAmazonOrders,
  syncAmazonSettlements,
  syncAmazonSalesTraffic,
  syncAmazonFbaInventory,
  backfillAmazon,
  ALERT_AFTER_FAILURES,
} = await import("@/modules/integrations/lib/amazon/sync");
const { getSyncState } = await import("@/modules/integrations/lib/amazon/ingest");

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
  fetchWindsorReport.mockReset();
  notifyIntegrationFailure.mockReset();
  process.env.WINDSOR_API_KEY = "test-key";
});

const TODAY = "2026-08-04";

describe("syncAmazonOrders", () => {
  it("pulls both report variants and lands the rows once", async () => {
    fetchWindsorReport.mockResolvedValue([
      { amazon_order_id: "111-1", sku: "JX1-BLK-FBA", quantity: "1", item_price: 28, item_status: "Pending" },
    ]);

    const outcomes = await syncAmazonOrders({ today: TODAY });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(fetchWindsorReport).toHaveBeenCalledTimes(2);
    // Same order line from both reports — upsert, so exactly one row.
    expect((sqlite.prepare("SELECT COUNT(*) n FROM amazon_order_rows").get() as { n: number }).n).toBe(1);
  });

  it("defaults to a trailing window ending yesterday, since today has no data", async () => {
    fetchWindsorReport.mockResolvedValue([]);
    const [outcome] = await syncAmazonOrders({ today: TODAY });
    expect(outcome.dateTo).toBe("2026-08-03");
    expect(outcome.dateFrom).toBe("2026-07-28"); // 7-day inclusive window
  });

  it("keeps going when the first report fails, so one bad report cannot block the other", async () => {
    fetchWindsorReport
      .mockRejectedValueOnce(new WindsorError({ kind: "timeout", connector: "amazon_sp", message: "timed out" }))
      .mockResolvedValueOnce([{ amazon_order_id: "111-1", sku: "JX1-BLK", quantity: "1" }]);

    const [first, second] = await syncAmazonOrders({ today: TODAY });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
  });
});

describe("syncAmazonSettlements", () => {
  it("lands settlement rows and records the watermark", async () => {
    fetchWindsorReport.mockResolvedValue([
      { settlement_id: "265", amount_type: "ItemPrice", amount_description: "Principal", amount: 28, posted_date: "2026-07-06" },
    ]);

    const outcome = await syncAmazonSettlements({ today: TODAY, days: 30 });

    expect(outcome.ok).toBe(true);
    expect(outcome.ingest?.inserted).toBe(1);
    const [state] = getSyncState("settlements");
    expect(state.lastStatus).toBe("ok");
  });

  it("clamps a request older than 90 days and says so, rather than returning a silent short result", async () => {
    fetchWindsorReport.mockResolvedValue([]);

    const outcome = await syncAmazonSettlements({ dateFrom: "2025-01-01", dateTo: TODAY, today: TODAY });

    expect(outcome.clamped).toBe(true);
    // 90-day window ending today, less a 2-day safety margin so a boundary
    // rejection cannot lose the whole sync.
    expect(outcome.dateFrom).toBe("2026-05-09");
    expect(outcome.notes?.join(" ")).toContain("90 days");
    // The important part: the operator is told the earlier data is gone
    // upstream, not left to assume the business simply had no sales.
    expect(outcome.notes?.join(" ")).toContain("permanently unavailable");
  });

  it("does not clamp a request already inside the window", async () => {
    fetchWindsorReport.mockResolvedValue([]);
    const outcome = await syncAmazonSettlements({ dateFrom: "2026-07-01", dateTo: TODAY, today: TODAY });
    expect(outcome.clamped).toBe(false);
    expect(outcome.dateFrom).toBe("2026-07-01");
  });
});

describe("failure handling and alert escalation", () => {
  it("stays quiet on the first transient failure — one timeout is noise", async () => {
    fetchWindsorReport.mockRejectedValue(
      new WindsorError({ kind: "timeout", connector: "amazon_sp", message: "timed out" }),
    );

    const outcome = await syncAmazonSalesTraffic({ today: TODAY });

    expect(outcome.ok).toBe(false);
    expect(outcome.errorKind).toBe("timeout");
    expect(notifyIntegrationFailure).not.toHaveBeenCalled();
  });

  it(`alerts once a report has failed ${ALERT_AFTER_FAILURES} times in a row`, async () => {
    fetchWindsorReport.mockRejectedValue(
      new WindsorError({ kind: "timeout", connector: "amazon_sp", message: "timed out" }),
    );

    for (let i = 0; i < ALERT_AFTER_FAILURES; i++) {
      await syncAmazonSalesTraffic({ today: TODAY });
    }

    expect(notifyIntegrationFailure).toHaveBeenCalledTimes(1);
    expect(alertArg(0).service).toContain("Amazon");
  });

  it("alerts immediately on a configuration error, which will never fix itself", async () => {
    fetchWindsorReport.mockRejectedValue(
      new WindsorError({ kind: "no_account", connector: "amazon_sp", message: "No amazon_sp account", retryable: false }),
    );

    await syncAmazonSalesTraffic({ today: TODAY });

    expect(notifyIntegrationFailure).toHaveBeenCalledTimes(1);
    expect(alertArg(0).detail).toContain("will not resolve on its own");
  });

  it("clears the failure counter after a recovery, so a fixed report stops alerting", async () => {
    fetchWindsorReport.mockRejectedValue(
      new WindsorError({ kind: "timeout", connector: "amazon_sp", message: "timed out" }),
    );
    await syncAmazonSalesTraffic({ today: TODAY });
    await syncAmazonSalesTraffic({ today: TODAY });

    fetchWindsorReport.mockReset();
    fetchWindsorReport.mockResolvedValue([]);
    await syncAmazonSalesTraffic({ today: TODAY });

    const [state] = getSyncState("sales_traffic");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastStatus).toBe("ok");
  });

  it("survives a Slack outage — alerting must never kill the cron tick", async () => {
    fetchWindsorReport.mockRejectedValue(
      new WindsorError({ kind: "no_account", connector: "amazon_sp", message: "No account", retryable: false }),
    );
    notifyIntegrationFailure.mockRejectedValue(new Error("slack is down"));

    const outcome = await syncAmazonSalesTraffic({ today: TODAY });
    expect(outcome.ok).toBe(false); // reported, not thrown
  });

  it("treats 'Amazon cancelled the report — no data' as an empty success, not a failure", async () => {
    // A business with no returns this week genuinely has no returns report.
    // Failing here would alert nightly and train everyone to ignore alerts.
    fetchWindsorReport.mockRejectedValue(
      new WindsorError({
        kind: "no_data",
        connector: "amazon_sp",
        message: "The report request from Amazon has been automatically cancelled.",
        retryable: false,
      }),
    );

    const outcome = await syncAmazonSalesTraffic({ today: TODAY });

    expect(outcome.ok).toBe(true);
    expect(outcome.ingest?.received).toBe(0);
    expect(outcome.notes?.join(" ")).toContain("no data");
    expect(notifyIntegrationFailure).not.toHaveBeenCalled();

    const [state] = getSyncState("sales_traffic");
    expect(state.lastStatus).toBe("ok");
    expect(state.consecutiveFailures).toBe(0);
  });

  it("never puts the API key into the stored error", async () => {
    fetchWindsorReport.mockRejectedValue(new Error("failed calling ...?api_key=test-key&fields=x"));

    await syncAmazonSalesTraffic({ today: TODAY });

    const [state] = getSyncState("sales_traffic");
    expect(state.lastError).not.toContain("test-key");
  });
});

describe("syncAmazonFbaInventory", () => {
  it("stamps the snapshot date, since the upstream report has no date column", async () => {
    fetchWindsorReport.mockResolvedValue([{ sku: "JX1-BLK-FBA", afn_fulfillable_quantity: 5, afn_total_quantity: 5 }]);

    await syncAmazonFbaInventory({ snapshotDate: "2026-08-04", today: TODAY });

    const row = sqlite.prepare("SELECT snapshot_date, internal_sku FROM amazon_fba_inventory").get() as Record<string, string>;
    expect(row.snapshot_date).toBe("2026-08-04");
    expect(row.internal_sku).toBe("JX1-BLK");
  });
});

describe("backfillAmazon", () => {
  it("runs settlements first, because they are the only data with a hard expiry", async () => {
    const order: string[] = [];
    fetchWindsorReport.mockImplementation(async (...args: unknown[]) => {
      order.push((args[0] as { report: string }).report);
      return [];
    });

    await backfillAmazon({ from: "2026-06-01", today: TODAY });

    expect(order[0]).toContain("settlement");
  });

  it("aggregates counts and surfaces warnings without throwing", async () => {
    fetchWindsorReport.mockImplementation(async (...args: unknown[]) => {
      if ((args[0] as { report: string }).report.includes("settlement")) {
        throw new WindsorError({ kind: "timeout", connector: "amazon_sp", message: "slow" });
      }
      return [{ amazon_order_id: "111-1", sku: "JX1-BLK", quantity: "1" }];
    });

    const res = await backfillAmazon({ from: "2026-07-28", today: TODAY });

    expect(res.warnings.join(" ")).toContain("settlements");
    expect(res.totalInserted).toBeGreaterThan(0); // other reports still landed
  });

  it("refuses a malformed start date instead of reporting an empty success", async () => {
    fetchWindsorReport.mockResolvedValue([]);
    await expect(backfillAmazon({ from: "not-a-date", today: TODAY })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("refuses an inverted range", async () => {
    fetchWindsorReport.mockResolvedValue([]);
    await expect(backfillAmazon({ from: "2026-08-01", to: "2026-07-01", today: TODAY })).rejects.toThrow(/is after/);
  });

  it("counts rejected rows so a malformed feed is visible, not silent", async () => {
    fetchWindsorReport.mockResolvedValue([{ amazon_order_id: "", sku: "" }]);
    const res = await backfillAmazon({ from: "2026-08-01", today: TODAY, includeInventory: false });
    expect(res.totalRejected).toBeGreaterThan(0);
  });
});
