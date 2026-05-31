/**
 * F3-001: Instantly.ai API v2 Client
 * Rate-limited, retrying HTTP client with mock fallback when INSTANTLY_API_KEY is unset.
 */

// ── Types ──

export interface InstantlyCampaign {
  id: string;
  name: string;
  status: "active" | "paused" | "completed" | "draft" | "error";
  created_at: string;
  updated_at: string;
}

export interface InstantlyCampaignAnalytics {
  campaign_id: string;
  total_leads: number;
  contacted: number;
  emails_sent: number;
  emails_opened: number;
  emails_replied: number;
  emails_bounced: number;
  unsubscribed: number;
  open_rate: number;
  reply_rate: number;
  bounce_rate: number;
}

export interface InstantlyLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone?: string;
  website?: string;
  custom_variables?: Record<string, string>;
}

export interface InstantlyLeadStatus {
  email: string;
  campaign_id: string;
  status: "active" | "contacted" | "opened" | "replied" | "unsubscribed" | "bounced";
  lead_data?: Record<string, unknown>;
}

export interface CreateCampaignData {
  name: string;
  subject?: string;
  body?: string;
}

// ── Normalisation helpers (Instantly v2 → our types) ──

/**
 * Instantly v2 ships `status` as a small integer (verified against the
 * live /campaigns response, May 2026):
 *   0 = draft, 1 = active, 2 = paused, 3 = completed, 4 = error.
 * Map to our string union — anything unexpected falls back to "paused"
 * to avoid silently dropping the row through a strict enum check.
 */
function statusFromCode(code: unknown): InstantlyCampaign["status"] {
  switch (typeof code === "number" ? code : Number(code)) {
    case 0: return "draft";
    case 1: return "active";
    case 2: return "paused";
    case 3: return "completed";
    case 4: return "error";
    default: return "paused";
  }
}

/**
 * Lead status codes per Instantly v2 (observed from /leads response):
 *   1 = active (in sequence, not yet contacted)
 *   2 = contacted
 *   3 = paused / out-of-office
 *   4 = bounced / failed
 *   -1 / -2 = error states
 * We coerce anything unrecognised to "active" rather than dropping the row.
 */
function mapLeadStatus(code: unknown): InstantlyLeadStatus["status"] {
  switch (typeof code === "number" ? code : Number(code)) {
    case 1: return "active";
    case 2: return "contacted";
    case 3: return "opened";
    case 4: return "bounced";
    default: return "active";
  }
}

/** Convert a raw Instantly v2 /campaigns item into the local typed shape. */
function normalizeCampaign(raw: Record<string, unknown>): InstantlyCampaign {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? "(unnamed)"),
    status: typeof raw.status === "string"
      ? (raw.status as InstantlyCampaign["status"])
      : statusFromCode(raw.status),
    created_at: String(raw.timestamp_created ?? raw.created_at ?? ""),
    updated_at: String(raw.timestamp_updated ?? raw.updated_at ?? ""),
  };
}

// ── Rate Limiter ──

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

class InstantlyClient {
  private baseUrl = "https://api.instantly.ai/api/v2";
  private envKey: string | null;
  private rateLimiter = new RateLimiter();
  private maxRetries = 3;

  constructor() {
    this.envKey = process.env.INSTANTLY_API_KEY || null;
  }

  /**
   * Resolve the API key for THIS request. Env var wins (immutable per
   * deploy), then we fall back to the `instantly_api_key` row in the
   * settings table so the existing /settings/integrations Instantly
   * card actually takes effect without requiring a redeploy. Resolved
   * per-call so a paste-key-then-click-button flow works without an
   * app restart.
   */
  private resolveApiKey(): string | null {
    if (this.envKey) return this.envKey;
    try {
      // Local import to avoid a circular dependency at module load time
      // (sqlite needs db.ts which transitively imports modules that
      // import this client).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sqlite } = require("@/lib/db") as { sqlite: { prepare: (s: string) => { get: () => { value?: string } | undefined } } };
      const row = sqlite.prepare(`SELECT value FROM settings WHERE key='instantly_api_key' LIMIT 1`).get();
      const val = row?.value?.trim();
      return val && val.length > 0 ? val : null;
    } catch {
      return null;
    }
  }

  get isMock(): boolean {
    return !this.resolveApiKey();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const apiKey = this.resolveApiKey();
    if (!apiKey) return this.mockResponse<T>(method, path, body);

    await this.rateLimiter.wait();

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        };
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get("Retry-After") || "2");
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Instantly API ${res.status}: ${text}`);
        }

        return (await res.json()) as T;
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.maxRetries - 1) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
      }
    }
    throw lastError!;
  }

  // ── API Methods ──

  async listCampaigns(): Promise<InstantlyCampaign[]> {
    // Real Instantly v2 /campaigns returns
    //   { items: [...], next_starting_after?: "<cursor>" }
    // with paginated chunks. Status is a NUMBER, not the enum string our
    // local InstantlyCampaign type claims — map it here so callers can
    // rely on the union value. Mock mode still returns a plain array
    // (see mockResponse) — handle both shapes for either path.
    const items: InstantlyCampaign[] = [];
    let cursor: string | undefined;
    const MAX_PAGES = 50; // safety cap; 50 × default page size ≫ any real catalog
    for (let p = 0; p < MAX_PAGES; p++) {
      const path = `/campaigns${cursor ? `?starting_after=${encodeURIComponent(cursor)}` : ""}`;
      const raw = await this.request<
        | InstantlyCampaign[]
        | { items?: Array<Record<string, unknown>>; next_starting_after?: string }
      >("GET", path);
      // Mock path → plain array of already-shaped InstantlyCampaign.
      if (Array.isArray(raw)) {
        items.push(...raw);
        break;
      }
      // Real API → { items, next_starting_after } with raw fields.
      for (const r of raw.items ?? []) {
        items.push(normalizeCampaign(r));
      }
      cursor = raw.next_starting_after;
      if (!cursor) break;
    }
    return items;
  }

  async getCampaign(id: string): Promise<InstantlyCampaign> {
    return this.request("GET", `/campaigns/${id}`);
  }

  async createCampaign(data: CreateCampaignData): Promise<InstantlyCampaign> {
    return this.request("POST", "/campaigns", data);
  }

  /**
   * Add leads to an Instantly campaign. v2 has no "POST /campaigns/{id}/leads"
   * batch endpoint — verified 404 against the real API. Instead each lead
   * is its own POST /leads with `{ campaign, email, first_name, ... }`.
   * We loop here so callers stay batch-shaped; per-lead errors are
   * returned in the result so a single bad address doesn't fail the
   * whole push.
   */
  async addLeadsToCampaign(
    campaignId: string,
    leads: InstantlyLead[],
  ): Promise<{ added: number; results: Array<{ email: string; id?: string; error?: string }> }> {
    const results: Array<{ email: string; id?: string; error?: string }> = [];
    let added = 0;
    for (const l of leads) {
      try {
        const res = await this.request<{ id: string }>("POST", "/leads", {
          campaign: campaignId,
          email: l.email,
          first_name: l.first_name,
          last_name: l.last_name,
          company_name: l.company_name,
          phone: l.phone,
          website: l.website,
          ...(l.custom_variables ? { personalization: JSON.stringify(l.custom_variables) } : {}),
        });
        results.push({ email: l.email, id: res.id });
        added++;
      } catch (e) {
        results.push({ email: l.email, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { added, results };
  }

  /**
   * Fetch the analytics overview for a single campaign. The v2 path is
   * /campaigns/analytics/overview?id=X (NOT /campaigns/{id}/analytics —
   * verified 404 against the real API). Field names in the response are
   * different too — normalised here into our local InstantlyCampaignAnalytics
   * shape so callers don't have to change.
   */
  async getCampaignAnalytics(campaignId: string): Promise<InstantlyCampaignAnalytics> {
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      `/campaigns/analytics/overview?id=${encodeURIComponent(campaignId)}`,
    );
    const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
    const sent = n(raw.emails_sent_count);
    const opened = n(raw.open_count_unique);
    const replied = n(raw.reply_count_unique);
    const bounced = n(raw.bounced_count);
    return {
      campaign_id: campaignId,
      total_leads: n(raw.contacted_count) + 0, // overview doesn't ship a total — best proxy
      contacted: n(raw.contacted_count),
      emails_sent: sent,
      emails_opened: opened,
      emails_replied: replied,
      emails_bounced: bounced,
      unsubscribed: n(raw.unsubscribed_count),
      open_rate: sent > 0 ? Math.round((opened / sent) * 1000) / 10 : 0,
      reply_rate: sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0,
      bounce_rate: sent > 0 ? Math.round((bounced / sent) * 1000) / 10 : 0,
    };
  }

  /**
   * Look up a lead by email. v2 has no GET /leads/status — leads are
   * queried via POST /leads/list with a search payload. Returns the
   * matching leads (typically 1 row per (campaign, email) tuple).
   */
  async getLeadStatus(email: string): Promise<InstantlyLeadStatus[]> {
    const raw = await this.request<{ items?: Array<Record<string, unknown>> }>(
      "POST",
      "/leads/list",
      { search: email, limit: 25 },
    );
    return (raw.items ?? []).map((r) => ({
      email: String(r.email ?? ""),
      campaign_id: String(r.campaign ?? ""),
      status: mapLeadStatus(r.status),
      lead_data: r,
    }));
  }

  /**
   * Pause an active campaign. v2 path uses an action-suffix collection:
   * POST /campaigns/{id}/pause (no body). Verified.
   */
  async pauseCampaign(id: string): Promise<InstantlyCampaign> {
    return this.request("POST", `/campaigns/${encodeURIComponent(id)}/pause`);
  }

  /**
   * Resume a paused campaign. Instantly v2 uses /activate, not /resume.
   */
  async resumeCampaign(id: string): Promise<InstantlyCampaign> {
    return this.request("POST", `/campaigns/${encodeURIComponent(id)}/activate`);
  }

  // ── Mock Data ──

  private mockCampaigns: InstantlyCampaign[] = [
    { id: "mock-camp-001", name: "Q1 Boutique Outreach — Tier A", status: "active", created_at: "2026-01-15T10:00:00Z", updated_at: "2026-03-18T14:30:00Z" },
    { id: "mock-camp-002", name: "West Coast Re-engagement", status: "active", created_at: "2026-02-01T09:00:00Z", updated_at: "2026-03-19T11:00:00Z" },
    { id: "mock-camp-003", name: "A/B Test — Subject Lines March", status: "active", created_at: "2026-03-01T08:00:00Z", updated_at: "2026-03-20T09:00:00Z" },
    { id: "mock-camp-004", name: "Holiday Preview — Independent Stores", status: "paused", created_at: "2026-02-20T12:00:00Z", updated_at: "2026-03-15T16:00:00Z" },
    { id: "mock-camp-005", name: "New Arrivals — Chain Stores", status: "completed", created_at: "2025-12-01T10:00:00Z", updated_at: "2026-02-28T10:00:00Z" },
  ];

  private mockAnalytics: Record<string, InstantlyCampaignAnalytics> = {
    "mock-camp-001": { campaign_id: "mock-camp-001", total_leads: 450, contacted: 423, emails_sent: 1269, emails_opened: 584, emails_replied: 73, emails_bounced: 18, unsubscribed: 5, open_rate: 46.0, reply_rate: 5.8, bounce_rate: 1.4 },
    "mock-camp-002": { campaign_id: "mock-camp-002", total_leads: 280, contacted: 265, emails_sent: 530, emails_opened: 227, emails_replied: 34, emails_bounced: 12, unsubscribed: 3, open_rate: 42.8, reply_rate: 6.4, bounce_rate: 2.3 },
    "mock-camp-003": { campaign_id: "mock-camp-003", total_leads: 600, contacted: 580, emails_sent: 1160, emails_opened: 580, emails_replied: 87, emails_bounced: 15, unsubscribed: 4, open_rate: 50.0, reply_rate: 7.5, bounce_rate: 1.3 },
    "mock-camp-004": { campaign_id: "mock-camp-004", total_leads: 150, contacted: 89, emails_sent: 178, emails_opened: 71, emails_replied: 11, emails_bounced: 6, unsubscribed: 2, open_rate: 39.9, reply_rate: 6.2, bounce_rate: 3.4 },
    "mock-camp-005": { campaign_id: "mock-camp-005", total_leads: 320, contacted: 320, emails_sent: 960, emails_opened: 403, emails_replied: 58, emails_bounced: 22, unsubscribed: 8, open_rate: 42.0, reply_rate: 6.0, bounce_rate: 2.3 },
  };

  private mockResponse<T>(method: string, path: string, body?: unknown): T {
    if (path === "/campaigns" && method === "GET") {
      return this.mockCampaigns as unknown as T;
    }
    if (path.match(/^\/campaigns\/[^/]+$/) && method === "GET") {
      const id = path.split("/").pop()!;
      return (this.mockCampaigns.find((c) => c.id === id) || this.mockCampaigns[0]) as unknown as T;
    }
    if (path === "/campaigns" && method === "POST") {
      const data = body as CreateCampaignData;
      const camp: InstantlyCampaign = {
        id: `mock-camp-${Date.now()}`,
        name: data.name,
        status: "draft",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return camp as unknown as T;
    }
    if (path.match(/\/campaigns\/[^/]+\/leads/) && method === "POST") {
      const leads = (body as { leads: InstantlyLead[] }).leads;
      return { added: leads.length } as unknown as T;
    }
    if (path.match(/\/campaigns\/[^/]+\/analytics/)) {
      const id = path.split("/")[2];
      return (this.mockAnalytics[id] || Object.values(this.mockAnalytics)[0]) as unknown as T;
    }
    if (path.startsWith("/leads/status")) {
      return [
        { email: "test@example.com", campaign_id: "mock-camp-001", status: "replied", lead_data: {} },
      ] as unknown as T;
    }
    if (path.match(/\/campaigns\/[^/]+\/pause/)) {
      const id = path.split("/")[2];
      const camp = this.mockCampaigns.find((c) => c.id === id) || this.mockCampaigns[0];
      return { ...camp, status: "paused" } as unknown as T;
    }
    if (path.match(/\/campaigns\/[^/]+\/resume/)) {
      const id = path.split("/")[2];
      const camp = this.mockCampaigns.find((c) => c.id === id) || this.mockCampaigns[0];
      return { ...camp, status: "active" } as unknown as T;
    }
    return {} as T;
  }
}

export const instantlyClient = new InstantlyClient();
