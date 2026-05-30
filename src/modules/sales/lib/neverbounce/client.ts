/**
 * NeverBounce API client.
 *
 * Single-email verification only. NeverBounce also has a true bulk
 * (async job) API — we don't use it because per-row HTTP fits the
 * per-push verification cadence (~tens to a few hundred emails per
 * click) and avoids the polling state machine the job API requires.
 *
 *   POST https://api.neverbounce.com/v4/single/check
 *     ?key=<api_key>&email=<addr>&address_info=0&credits_info=0&timeout=10
 *
 *   { "status": "success",
 *     "result": "valid" | "invalid" | "disposable" | "catchall" | "unknown",
 *     "flags": ["has_dns", "has_dns_mx", "smtp_connectable", "free_email_host", …],
 *     "suggested_correction": "",
 *     "retry_token": "…",
 *     "execution_time": 232 }
 *
 * Result-field meanings (per NeverBounce docs):
 *   valid        — confirmed deliverable
 *   catchall     — domain accepts all addresses (gray zone — many legit
 *                  Google Workspace / O365 small businesses)
 *   unknown      — couldn't determine in the timeout
 *   invalid      — definitively undeliverable
 *   disposable   — temp/throwaway provider
 *
 * Push-to-Instantly gate (Daniel's pick): only `valid` + `catchall` are
 * eligible to push. Constants below.
 */

const BASE_URL = "https://api.neverbounce.com/v4";
const DEFAULT_TIMEOUT_SECONDS = 10;

export type NeverBounceResult =
  | "valid"
  | "invalid"
  | "disposable"
  | "catchall"
  | "unknown";

/** Results we trust enough to ship to Instantly. */
export const PUSH_ELIGIBLE_RESULTS: ReadonlySet<NeverBounceResult> = new Set([
  "valid",
  "catchall",
]);

function getApiKey(): string {
  const k = process.env.NEVERBOUNCE_API_KEY;
  if (!k) throw new Error("NEVERBOUNCE_API_KEY is not configured");
  return k;
}

export function isConfigured(): boolean {
  return !!process.env.NEVERBOUNCE_API_KEY;
}

export interface VerificationResponse {
  status: "success" | "auth_failure" | "throttle_triggered" | "bad_referrer" | "general_failure";
  result: NeverBounceResult;
  flags: string[];
  suggested_correction?: string;
  retry_token?: string;
  execution_time?: number;
  /** Present on non-success statuses. */
  message?: string;
}

export class NeverBounceError extends Error {
  constructor(message: string, public status: number, public bodyPreview: string) {
    super(message);
    this.name = "NeverBounceError";
  }
}

/**
 * Verify a single email. Returns the API response shape (result is
 * always populated on a 2xx — even auth_failure / throttle_triggered
 * gives a 200 with status='...' rather than a 4xx). Network / 5xx
 * errors throw NeverBounceError.
 */
export async function verifyEmail(
  email: string,
  opts: { timeoutSeconds?: number; signal?: AbortSignal } = {},
): Promise<VerificationResponse> {
  const params = new URLSearchParams({
    key: getApiKey(),
    email,
    address_info: "0",
    credits_info: "0",
    timeout: String(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
  });
  const url = `${BASE_URL}/single/check?${params.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NeverBounceError(
      `NeverBounce ${email}: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      res.status,
      text,
    );
  }
  const data = (await res.json()) as VerificationResponse;
  if (data.status !== "success") {
    throw new NeverBounceError(
      `NeverBounce returned ${data.status}: ${data.message ?? "no message"}`,
      200,
      JSON.stringify(data).slice(0, 200),
    );
  }
  return data;
}

/**
 * Verify many emails with bounded concurrency. NeverBounce's single
 * endpoint takes ~1-5s per call (it SMTP-probes the destination), so
 * serial would burn wall time. 5 concurrent fits comfortably under any
 * reasonable rate budget while staying inside a 100s Cloudflare edge
 * timeout for ~50 emails per batch.
 *
 * Returns a record keyed by lowercased email. Failures map to
 * `{ error: <message> }` rather than throwing — bulk callers want
 * partial-success semantics.
 */
export async function verifyMany(
  emails: string[],
  opts: { concurrency?: number; timeoutSeconds?: number; signal?: AbortSignal } = {},
): Promise<Record<string, VerificationResponse | { error: string }>> {
  const concurrency = Math.max(1, Math.min(10, opts.concurrency ?? 5));
  const out: Record<string, VerificationResponse | { error: string }> = {};

  // Deduplicate — NeverBounce charges per call.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const e of emails) {
    const k = e.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    unique.push(k);
  }

  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      if (opts.signal?.aborted) return;
      const i = cursor++;
      const email = unique[i];
      try {
        out[email] = await verifyEmail(email, {
          timeoutSeconds: opts.timeoutSeconds,
          signal: opts.signal,
        });
      } catch (e) {
        out[email] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}
