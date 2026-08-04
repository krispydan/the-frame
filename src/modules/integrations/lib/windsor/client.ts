/**
 * Generic Windsor AI connector client.
 *
 * Deliberately connector-agnostic. Amazon (`amazon_sp`) is the first caller,
 * but TikTok Shop, Facebook and Amazon Ads are all planned on the same key —
 * adding one should be a report definition plus a mapper, never a new
 * integration. Nothing Amazon-specific belongs in this file.
 *
 * Three things about Windsor's API shape drive the design:
 *
 * 1. **Fields are report-scoped.** One call resolves to exactly one Amazon
 *    report, and every field must carry that report's prefix
 *    (`v2_settlement_report_data_flat_file_v2__amount`). Bare names like
 *    `date` do not resolve at all. Callers declare unprefixed field names and
 *    this module applies (and then strips) the prefix, so the rest of the
 *    codebase never sees the mangling.
 *
 * 2. **Reports generate asynchronously upstream and some never return.**
 *    Measured against the live account: all-orders over 7 days responds in
 *    ~2s but times out past 5 minutes over 90 days; the FBA shipments report
 *    timed out on every attempt including a single-day window. So: bounded
 *    windows, chunked automatically, with timeouts treated as retryable
 *    rather than fatal.
 *
 * 3. **Errors arrive as HTTP 400 with a JSON body**, not as status codes we
 *    can branch on. `classifyError` turns those strings into typed kinds so
 *    callers can distinguish "you never connected this account" (needs a
 *    human) from "the report was slow" (retry tonight).
 *
 * The API key is read from `WINDSOR_API_KEY` and appears in the query string.
 * Every error path routes through `redact()` so the key can never reach a
 * log, a Slack alert, or a database error column.
 */

const WINDSOR_BASE = "https://connectors.windsor.ai";

/** Observed upstream latency is wildly report-dependent; 7 days is the safe unit. */
const DEFAULT_MAX_WINDOW_DAYS = 7;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_RETRIES = 2;

export type WindsorErrorKind =
  /** WINDSOR_API_KEY missing/blank, or rejected by Windsor. */
  | "auth"
  /** Connector exists but this Windsor account has no such data source linked. */
  | "no_account"
  /** Connector slug isn't one Windsor offers. */
  | "unknown_connector"
  /** Fields didn't resolve to a single report (usually a typo'd field name). */
  | "bad_fields"
  /** Requested range is outside what the upstream report allows (e.g. 90-day settlement cap). */
  | "date_range"
  /** Upstream took too long — the report is probably still generating. */
  | "timeout"
  /**
   * Amazon cancelled the report because it had nothing to return. Not a
   * fault: a business with no returns this week genuinely has no returns
   * report. Callers should treat this as an empty result, not a failure.
   */
  | "no_data"
  /** Transport/HTTP failure. */
  | "http"
  /** 200 with a body we couldn't parse. */
  | "parse";

/**
 * A typed Windsor failure. `retryable` encodes whether trying again later
 * could plausibly succeed, which is what separates a silent retry from an
 * alert that needs a human.
 */
export class WindsorError extends Error {
  readonly kind: WindsorErrorKind;
  readonly connector: string;
  readonly report?: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(opts: {
    kind: WindsorErrorKind;
    message: string;
    connector: string;
    report?: string;
    status?: number;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = "WindsorError";
    this.kind = opts.kind;
    this.connector = opts.connector;
    this.report = opts.report;
    this.status = opts.status;
    // Timeouts and transport errors are worth another go; a missing account or
    // an unknown connector will fail identically forever.
    this.retryable = opts.retryable ?? (opts.kind === "timeout" || opts.kind === "http");
  }
}

export interface WindsorReport {
  /** Windsor connector slug, e.g. "amazon_sp". */
  connector: string;
  /** Upstream report/table name, e.g. "get_v2_settlement_report_data_flat_file_v2". */
  report: string;
  /** Unprefixed field names; the report prefix is applied automatically. */
  fields: string[];
  /**
   * Largest span, in days, to request in a single call. Ranges longer than
   * this are split and fetched sequentially.
   */
  maxWindowDays?: number;
  /** Per-request timeout override. */
  timeoutMs?: number;
}

export interface FetchWindsorOptions {
  /** Inclusive start date, YYYY-MM-DD. Omit to use `datePreset`. */
  dateFrom?: string;
  /** Inclusive end date, YYYY-MM-DD. */
  dateTo?: string;
  /** Windsor date preset, e.g. "last_7d". Ignored when dateFrom/dateTo are given. */
  datePreset?: string;
  /** Retry attempts per chunk on retryable failures. Default 2. */
  retries?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests so backoff doesn't actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Called after each chunk — lets long backfills report progress. */
  onProgress?: (progress: { chunk: number; totalChunks: number; rows: number; dateFrom?: string; dateTo?: string }) => void;
}

/** A single row with report prefixes stripped from its keys. */
export type WindsorRow = Record<string, string | number | null>;

/**
 * Field prefix for a report: the table name minus its `get_` prefix, plus `__`.
 * `get_sales_and_traffic_report_by_date` → `sales_and_traffic_report_by_date__`.
 */
export function reportPrefix(report: string): string {
  return `${report.replace(/^get_/, "")}__`;
}

/** Strips the API key from any string before it reaches a log or a DB column. */
export function redact(text: string): string {
  const key = process.env.WINDSOR_API_KEY;
  let out = text;
  if (key && key.length > 0) out = out.split(key).join("***");
  // Belt and braces: catch any api_key=... that isn't the configured key
  // (e.g. a rotated key echoed back in an upstream error message).
  return out.replace(/api_key=[^&\s"']+/gi, "api_key=***");
}

function requireApiKey(connector: string): string {
  const key = process.env.WINDSOR_API_KEY?.trim();
  if (!key) {
    throw new WindsorError({
      kind: "auth",
      connector,
      message:
        "WINDSOR_API_KEY is not set. Add it to the Railway environment (and .env.local for development) before running any Windsor sync.",
      retryable: false,
    });
  }
  return key;
}

/**
 * Windsor reports failures as HTTP 400 with a human-readable string, so the
 * only way to tell a permanent misconfiguration from a transient slowdown is
 * to read the message. Matching is substring-based and case-insensitive
 * because the wording carries interpolated account names.
 */
export function classifyError(message: string, connector: string, report?: string, status?: number): WindsorError {
  const m = message.toLowerCase();

  if (m.includes("don't have this connector") || m.includes("dont have this connector")) {
    return new WindsorError({
      kind: "unknown_connector",
      connector,
      report,
      status,
      message: `Windsor does not offer a connector named "${connector}".`,
      retryable: false,
    });
  }
  if (m.includes("was found") && m.includes("no ") && m.includes("account")) {
    return new WindsorError({
      kind: "no_account",
      connector,
      report,
      status,
      message: `No "${connector}" data source is linked to this Windsor account. Connect it at https://onboard.windsor.ai?datasource=${connector}`,
      retryable: false,
    });
  }
  if (m.includes("could not determine a report")) {
    return new WindsorError({
      kind: "bad_fields",
      connector,
      report,
      status,
      message: `Fields did not resolve to a single report for "${report ?? connector}". Check the field names against https://windsor.ai/data-field/${connector}/`,
      retryable: false,
    });
  }
  if (m.includes("within the last") && m.includes("days")) {
    return new WindsorError({
      kind: "date_range",
      connector,
      report,
      status,
      // Surfaced verbatim: the upstream message names the exact limit, and
      // that limit is the whole reason the raw archive exists.
      message: `Requested date range is outside what Windsor will serve for this report: ${message}`,
      retryable: false,
    });
  }
  // Observed against the live account on the reimbursements report. Amazon
  // cancels a report request when it has nothing to return, and Windsor
  // relays that as a generic failure. Without this branch, every report that
  // is legitimately empty (no returns, no reimbursements) would look broken
  // and alert nightly — training everyone to ignore the alerts that matter.
  if (m.includes("automatically cancelled") || m.includes("automatically canceled")) {
    return new WindsorError({
      kind: "no_data",
      connector,
      report,
      status,
      message: `Amazon cancelled the report request, which it does when there is no data in the requested period: ${message}`,
      retryable: false,
    });
  }
  if (m.includes("api key") || m.includes("unauthorized") || status === 401 || status === 403) {
    return new WindsorError({
      kind: "auth",
      connector,
      report,
      status,
      message: `Windsor rejected the API key: ${message}`,
      retryable: false,
    });
  }
  return new WindsorError({
    kind: "http",
    connector,
    report,
    status,
    message,
    retryable: true,
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Inclusive day count between two YYYY-MM-DD dates. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000) + 1;
}

function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Splits [from, to] into inclusive chunks of at most `maxDays`.
 * Exported for tests — chunk-boundary bugs silently drop days, which would
 * show up much later as a hole in the ledger.
 */
export function chunkDateRange(from: string, to: string, maxDays: number): Array<{ from: string; to: string }> {
  const span = daysBetween(from, to);
  // An inverted range is always a caller bug. Windsor answers it with an
  // empty result set, which reads exactly like "no sales in this period" —
  // so fail loudly here rather than let a date-arithmetic slip masquerade as
  // a quiet trading gap.
  if (span <= 0) {
    throw new Error(`Invalid date range: dateFrom (${from}) is after dateTo (${to}).`);
  }
  if (span <= maxDays) return [{ from, to }];
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = from;
  while (Date.parse(`${cursor}T00:00:00Z`) <= Date.parse(`${to}T00:00:00Z`)) {
    const end = addDays(cursor, maxDays - 1);
    const clamped = Date.parse(`${end}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`) ? to : end;
    chunks.push({ from: cursor, to: clamped });
    cursor = addDays(clamped, 1);
  }
  return chunks;
}

/** One HTTP call. Applies the timeout and normalises the response envelope. */
async function fetchOnce(
  report: WindsorReport,
  params: { dateFrom?: string; dateTo?: string; datePreset?: string },
  fetchImpl: typeof fetch,
): Promise<WindsorRow[]> {
  const key = requireApiKey(report.connector);
  const prefix = reportPrefix(report.report);
  const url = new URL(`${WINDSOR_BASE}/${report.connector}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("fields", report.fields.map((f) => `${prefix}${f}`).join(","));
  if (params.dateFrom && params.dateTo) {
    url.searchParams.set("date_from", params.dateFrom);
    url.searchParams.set("date_to", params.dateTo);
  } else if (params.datePreset) {
    url.searchParams.set("date_preset", params.datePreset);
  }

  const timeoutMs = report.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { signal: controller.signal });
  } catch (e) {
    const err = e as Error;
    const aborted = err.name === "AbortError" || controller.signal.aborted;
    throw new WindsorError({
      kind: aborted ? "timeout" : "http",
      connector: report.connector,
      report: report.report,
      message: aborted
        ? `Timed out after ${Math.round(timeoutMs / 1000)}s — the upstream report is likely still generating.`
        : redact(err.message || "network error"),
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new WindsorError({
      kind: res.ok ? "parse" : "http",
      connector: report.connector,
      report: report.report,
      status: res.status,
      message: redact(`Non-JSON response (HTTP ${res.status}): ${bodyText.slice(0, 300)}`),
      retryable: !res.ok,
    });
  }

  const envelope = body as { data?: unknown; error?: unknown };
  if (envelope && typeof envelope.error === "string") {
    throw classifyError(redact(envelope.error), report.connector, report.report, res.status);
  }
  if (!res.ok) {
    throw classifyError(redact(bodyText.slice(0, 300)), report.connector, report.report, res.status);
  }
  if (!Array.isArray(envelope?.data)) {
    throw new WindsorError({
      kind: "parse",
      connector: report.connector,
      report: report.report,
      status: res.status,
      message: redact(`Expected a "data" array, got: ${bodyText.slice(0, 200)}`),
      retryable: false,
    });
  }

  // Strip the report prefix so callers work with clean field names.
  return (envelope.data as Array<Record<string, string | number | null>>).map((row) => {
    const out: WindsorRow = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.startsWith(prefix) ? k.slice(prefix.length) : k] = v;
    }
    return out;
  });
}

/**
 * Fetch a Windsor report, chunking long date ranges and retrying transient
 * failures with exponential backoff.
 *
 * Non-retryable failures (missing account, unknown connector, bad fields,
 * out-of-range dates) throw immediately — retrying those just wastes minutes
 * against an upstream that is already telling us the answer.
 */
export async function fetchWindsorReport(
  report: WindsorReport,
  opts: FetchWindsorOptions = {},
): Promise<WindsorRow[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const maxWindow = report.maxWindowDays ?? DEFAULT_MAX_WINDOW_DAYS;

  const chunks =
    opts.dateFrom && opts.dateTo
      ? chunkDateRange(opts.dateFrom, opts.dateTo, maxWindow)
      : [{ from: undefined, to: undefined }];

  const all: WindsorRow[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let lastErr: WindsorError | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const rows = await fetchOnce(
          report,
          { dateFrom: chunk.from, dateTo: chunk.to, datePreset: opts.datePreset },
          fetchImpl,
        );
        all.push(...rows);
        opts.onProgress?.({
          chunk: i + 1,
          totalChunks: chunks.length,
          rows: rows.length,
          dateFrom: chunk.from,
          dateTo: chunk.to,
        });
        lastErr = undefined;
        break;
      } catch (e) {
        const err = e instanceof WindsorError
          ? e
          : new WindsorError({
              kind: "http",
              connector: report.connector,
              report: report.report,
              message: redact((e as Error).message),
            });
        lastErr = err;
        if (!err.retryable || attempt === retries) break;
        // 2s, 4s, 8s … — enough for a slow report to finish generating
        // upstream without stalling the nightly cron indefinitely.
        await sleepImpl(2000 * 2 ** attempt);
      }
    }

    if (lastErr) throw lastErr;
  }

  return all;
}

/**
 * Probe whether a connector is linked to this Windsor account, without
 * caring about the data itself. Used by the settings/health surface so a
 * disconnected data source reads as a configuration problem rather than
 * "no sales today".
 */
export async function probeConnector(
  connector: string,
  probe: { report: string; fields: string[] },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true } | { ok: false; kind: WindsorErrorKind; message: string }> {
  try {
    await fetchWindsorReport(
      { connector, report: probe.report, fields: probe.fields, timeoutMs: 60_000 },
      { datePreset: "last_7d", retries: 0, fetchImpl: opts.fetchImpl },
    );
    return { ok: true };
  } catch (e) {
    const err = e as WindsorError;
    return { ok: false, kind: err.kind ?? "http", message: redact(err.message) };
  }
}
