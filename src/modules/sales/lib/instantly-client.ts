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
  private apiKey: string | null;
  private rateLimiter = new RateLimiter();
  private maxRetries = 3;

  constructor() {
    this.apiKey = process.env.INSTANTLY_API_KEY || null;
  }

  get isMock(): boolean {
    return !this.apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.isMock) return this.mockResponse<T>(method, path, body);

    await this.rateLimiter.wait();

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
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
    return this.request("GET", "/campaigns");
  }

  async getCampaign(id: string): Promise<InstantlyCampaign> {
    return this.request("GET", `/campaigns/${id}`);
  }

  async createCampaign(data: CreateCampaignData): Promise<InstantlyCampaign> {
    return this.request("POST", "/campaigns", data);
  }

  async addLeadsToCampaign(campaignId: string, leads: InstantlyLead[]): Promise<{ added: number }> {
    return this.request("POST", `/campaigns/${campaignId}/leads`, { leads });
  }

  async getCampaignAnalytics(campaignId: string): Promise<InstantlyCampaignAnalytics> {
    return this.request("GET", `/campaigns/${campaignId}/analytics`);
  }

  async getLeadStatus(email: string): Promise<InstantlyLeadStatus[]> {
    return this.request("GET", `/leads/status?email=${encodeURIComponent(email)}`);
  }

  async pauseCampaign(id: string): Promise<InstantlyCampaign> {
    return this.request("POST", `/campaigns/${id}/pause`);
  }

  async resumeCampaign(id: string): Promise<InstantlyCampaign> {
    return this.request("POST", `/campaigns/${id}/resume`);
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
