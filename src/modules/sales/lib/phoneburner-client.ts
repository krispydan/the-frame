/**
 * PhoneBurner API client.
 *
 * Base URL:  https://www.phoneburner.com/rest/1/
 * Auth:      Authorization: Bearer <token>
 * Token:     env PHONEBURNER_API_KEY → fallback settings.phoneburner_api_key
 *
 * Cloned from instantly-client.ts — same rate limiter + retry + mock
 * fallback shape. The PB API rate limit is undocumented; we cap at
 * 10 req/sec to match Instantly's convention conservatively.
 *
 * Endpoints used:
 *   POST   /contacts                 — create contact
 *   PUT    /contacts/{id}            — update contact
 *   GET    /folders                  — list folders
 *   POST   /folders                  — create folder
 *   GET    /calls                    — paginated recent calls (the
 *                                      polling cron source; if the
 *                                      empirical name differs we'll
 *                                      adjust during impl. test)
 *   GET    /dialsession/call/{id}    — single call detail, including
 *                                      `include_recording=1` for the
 *                                      hosted recording URL
 *   GET    /me                       — auth probe for settings card
 */

interface PbCustomField {
  name: string;
  type?: string;
  value: string | number | null;
}

export interface PbContactPayload {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  phone_type?: number;
  phone_label?: string;
  address1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  category_id?: string;
  source_id?: string;
  notes?: string;
  /** PB lets you stash an external id on a contact. We use it to carry
   *  our own campaign_lead.id so call-result polling can match
   *  back without a phone/email lookup. */
  user_id?: string;
  custom_fields?: PbCustomField[];
  /** PB native: "update" | "skip" | "create" — re-pushing is idempotent. */
  on_duplicate?: "update" | "skip" | "create";
}

export interface PbContactResponse {
  id: string;
  [k: string]: unknown;
}

export interface PbFolder {
  id: string;
  name: string;
  description?: string;
  parent_id?: string | null;
}

export interface PbCall {
  id: string;
  call_id?: string;
  contact_id?: string;
  user_id?: string;       // round-tripped — our campaign_lead.id
  agent_id?: string;
  agent_email?: string;
  duration?: number;
  connected?: boolean | number;
  disposition?: string;
  disposition_id?: string;
  disposition_label?: string;
  notes?: string;
  recording_url?: string;
  phone?: string;
  called_at?: string;
  timestamp?: string;
  [k: string]: unknown;
}

// ── Rate limiter ──
class RateLimiter {
  private queue: number[] = [];
  private maxPerSecond = 10;

  async wait(): Promise<void> {
    const now = Date.now();
    this.queue = this.queue.filter((t) => now - t < 1000);
    if (this.queue.length >= this.maxPerSecond) {
      const oldest = this.queue[0];
      const delay = 1000 - (now - oldest);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    this.queue.push(Date.now());
  }
}

// ── Client ──
class PhoneBurnerClient {
  private baseUrl = "https://www.phoneburner.com/rest/1";
  private envKey: string | null;
  private rateLimiter = new RateLimiter();
  private maxRetries = 3;

  constructor() {
    this.envKey = process.env.PHONEBURNER_API_KEY || null;
  }

  /**
   * Resolve token for this request. Env wins (immutable per deploy),
   * then settings.phoneburner_api_key so the settings UI works without
   * a restart. Per-call lookup, same pattern as Instantly client.
   */
  private resolveApiKey(): string | null {
    if (this.envKey) return this.envKey;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sqlite } = require("@/lib/db") as {
        sqlite: {
          prepare: (s: string) => { get: () => { value?: string } | undefined };
        };
      };
      const row = sqlite
        .prepare(`SELECT value FROM settings WHERE key='phoneburner_api_key' LIMIT 1`)
        .get();
      const val = row?.value?.trim();
      return val && val.length > 0 ? val : null;
    } catch {
      return null;
    }
  }

  get isMock(): boolean {
    return !this.resolveApiKey();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new Error(
        "PhoneBurner not configured — set PHONEBURNER_API_KEY env or settings.phoneburner_api_key",
      );
    }

    await this.rateLimiter.wait();

    let url = `${this.baseUrl}${path}`;
    if (query) {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") usp.set(k, String(v));
      }
      const qs = usp.toString();
      if (qs) url += `?${qs}`;
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (res.status === 429 || res.status >= 500) {
          const backoff = 500 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoff));
          lastError = new Error(`PhoneBurner ${res.status}: ${(await res.text()).slice(0, 300)}`);
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`PhoneBurner ${res.status}: ${text.slice(0, 500)}`);
        }
        // Some PB endpoints return 204 No Content; guard JSON parse.
        const text = await res.text();
        if (!text) return {} as T;
        return JSON.parse(text) as T;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        // Network error — retry with backoff.
        const backoff = 500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastError ?? new Error("PhoneBurner request failed");
  }

  // ── Auth probe (settings card test button) ──
  async me(): Promise<{ ok: boolean; raw: unknown }> {
    const raw = await this.request<unknown>("GET", "/me");
    return { ok: true, raw };
  }

  // ── Folders ──
  async listFolders(): Promise<PbFolder[]> {
    const raw = await this.request<{ data?: PbFolder[] } | PbFolder[]>(
      "GET",
      "/folders",
      undefined,
      { page_size: 100 },
    );
    if (Array.isArray(raw)) return raw;
    return raw.data ?? [];
  }

  async createFolder(opts: {
    folder_name: string;
    description?: string;
    parent_id?: string | null;
  }): Promise<PbFolder> {
    const raw = await this.request<PbFolder | { folder?: PbFolder; data?: PbFolder }>(
      "POST",
      "/folders",
      {
        folder_name: opts.folder_name,
        description: opts.description ?? "Synced from The Frame",
        parent_id: opts.parent_id ?? null,
      },
    );
    if ("id" in raw && raw.id) return raw as PbFolder;
    const wrapped = raw as { folder?: PbFolder; data?: PbFolder };
    return (wrapped.folder ?? wrapped.data) as PbFolder;
  }

  // ── Contacts ──
  async createContact(payload: PbContactPayload): Promise<PbContactResponse> {
    const raw = await this.request<PbContactResponse | { contact?: PbContactResponse; data?: PbContactResponse }>(
      "POST",
      "/contacts",
      payload,
    );
    if ("id" in raw && raw.id) return raw as PbContactResponse;
    const wrapped = raw as { contact?: PbContactResponse; data?: PbContactResponse };
    const inner = wrapped.contact ?? wrapped.data;
    if (!inner?.id) {
      throw new Error(
        `PhoneBurner createContact returned no id: ${JSON.stringify(raw).slice(0, 300)}`,
      );
    }
    return inner;
  }

  async updateContact(id: string, patch: Partial<PbContactPayload>): Promise<PbContactResponse> {
    return await this.request<PbContactResponse>("PUT", `/contacts/${id}`, patch);
  }

  // ── Calls (polling source) ──
  /**
   * Fetch recent calls since `since` (ISO timestamp). PB's exact list
   * endpoint URL isn't fully documented; we try the most likely path
   * (`/calls`) and accept either an array body or a `{ data: [] }`
   * envelope. If the empirical path differs once we hit the live API,
   * swap the path here in one place.
   */
  async listRecentCalls(opts: {
    since?: string;
    page?: number;
    page_size?: number;
  }): Promise<PbCall[]> {
    const raw = await this.request<{ data?: PbCall[] } | PbCall[]>(
      "GET",
      "/calls",
      undefined,
      {
        since: opts.since,
        page: opts.page ?? 1,
        page_size: opts.page_size ?? 100,
      },
    );
    if (Array.isArray(raw)) return raw;
    return raw.data ?? [];
  }

  async getCall(callId: string, opts?: { include_recording?: boolean }): Promise<PbCall> {
    return await this.request<PbCall>(
      "GET",
      `/dialsession/call/${callId}`,
      undefined,
      { include_recording: opts?.include_recording ? 1 : undefined },
    );
  }
}

export const phoneBurnerClient = new PhoneBurnerClient();
