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
  /** PB requires owner_id OR owner_username on every contact create.
   *  Resolved automatically by phoneburner-sync from settings or by
   *  probing an existing contact. */
  owner_id?: string;
  owner_username?: string;
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

/**
 * Walk any plausible PB folder response shape and return a {id, name}
 * record. Handles direct records, single-key wrappers (`folder`,
 * `data`, `result`), arrays, and flat-with-folder_id envelopes.
 * Returns null if nothing recognizable surfaces.
 */
function extractFolder(raw: unknown): PbFolder | null {
  if (!raw) return null;

  // Array — take the first element.
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const f = extractFolder(item);
      if (f) return f;
    }
    return null;
  }

  if (typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // Direct hit — { id, name, ... }
  const directId = o.id ?? o.folder_id ?? o.category_id;
  const directName = o.name ?? o.folder_name ?? o.category_name;
  if (directId != null) {
    return {
      id: String(directId),
      name: directName != null ? String(directName) : "",
      description: typeof o.description === "string" ? o.description : undefined,
    };
  }

  // Wrapped — try the common envelope keys. Include the plural list
  // keys (`folders`, `items`) because PB's createFolder actually
  // returns the new record nested under `folders` as a numeric-keyed
  // pseudo-array — captured 2026-06-19:
  //   { folders: { "0": { id, folder_id, ... }, total_results, ... } }
  for (const key of [
    "folder",
    "folders",
    "data",
    "result",
    "category",
    "categories",
    "item",
    "items",
  ]) {
    if (key in o) {
      const f = extractFolder(o[key]);
      if (f) return f;
    }
  }

  // Numeric-keyed pseudo-array — { "0": {...}, "1": {...}, ...meta }.
  // PB mixes folder records with pagination metadata at the same
  // level; iterate the integer-keyed entries and return the first
  // one that resolves to a record with an id.
  for (const k of Object.keys(o)) {
    if (/^\d+$/.test(k)) {
      const f = extractFolder(o[k]);
      if (f) return f;
    }
  }

  return null;
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

  // ── Auth probe ──
  // PhoneBurner has no /me endpoint. A 1-item folder list is the
  // cheapest auth-required call.
  async authProbe(): Promise<{ ok: boolean; raw: unknown }> {
    const raw = await this.request<unknown>(
      "GET",
      "/folders",
      undefined,
      { page_size: 1 },
    );
    return { ok: true, raw };
  }

  /**
   * Discover the API key's owner user_id by inspecting an existing
   * contact. PB requires owner_id on every contact create, but there's
   * no /me endpoint to ask for it directly. Workaround: GET the first
   * existing contact (any folder) and read its owner_id.
   *
   * Returns null if the workspace is empty (no contacts to inspect).
   */
  async discoverOwnerId(): Promise<string | null> {
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      "/contacts",
      undefined,
      { page_size: 1 },
    );
    // PB nests contact arrays under `_embedded.contacts` and also
    // sometimes returns numeric index keys at the top level. Be lenient.
    const candidates: unknown[] = [];
    const embedded = (raw?._embedded as { contacts?: unknown[] } | undefined)?.contacts;
    if (Array.isArray(embedded)) candidates.push(...embedded);
    for (const v of Object.values(raw)) {
      if (v && typeof v === "object" && "owner_id" in (v as Record<string, unknown>)) {
        candidates.push(v);
      }
    }
    for (const c of candidates) {
      const ownerId = (c as { owner_id?: unknown }).owner_id;
      if (typeof ownerId === "string" && ownerId.length > 0) return ownerId;
      if (typeof ownerId === "number") return String(ownerId);
    }
    return null;
  }

  // ── Folders ──
  async listFolders(): Promise<PbFolder[]> {
    const raw = await this.request<unknown>(
      "GET",
      "/folders",
      undefined,
      { page_size: 100 },
    );

    // Walk every plausible PB list-response shape: direct array,
    // { data: [...] } envelope, { folders: [...] } named wrapper,
    // { items: [...] }, or anything else with a nested array of
    // folder-shaped records. Extract one PbFolder per entry.
    function asArray(x: unknown): unknown[] {
      if (Array.isArray(x)) return x;
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        // First try real arrays nested under known list keys.
        for (const key of ["data", "folders", "items", "result", "categories"]) {
          if (Array.isArray(o[key])) return o[key] as unknown[];
          // PB's actual shape: o.folders is an OBJECT with numeric
          // string keys ("0", "1") mixed with pagination metadata.
          const inner = o[key];
          if (inner && typeof inner === "object" && !Array.isArray(inner)) {
            const innerO = inner as Record<string, unknown>;
            const numericKeys = Object.keys(innerO).filter((k) =>
              /^\d+$/.test(k),
            );
            if (numericKeys.length) {
              return numericKeys.map((k) => innerO[k]);
            }
          }
        }
        // Last resort: the top-level object itself is a numeric-keyed
        // pseudo-array (rare but seen in some PB list responses).
        const topNumeric = Object.keys(o).filter((k) => /^\d+$/.test(k));
        if (topNumeric.length) return topNumeric.map((k) => o[k]);
      }
      return [];
    }
    const items = asArray(raw);
    const out: PbFolder[] = [];
    for (const item of items) {
      const f = extractFolder(item);
      if (f) out.push(f);
    }
    return out;
  }

  async createFolder(opts: {
    folder_name: string;
    description?: string;
    parent_id?: string | null;
    /**
     * PB's folder-create endpoint requires owner_id (same as contact
     * create — verified empirically 2026-06-19 after a 40004 "required
     * field not set" on this call). Caller must supply it. Null/missing
     * → PB rejects with 400.
     */
    owner_id: string;
  }): Promise<PbFolder> {
    // Strip non-ASCII from name + description. PB's tenant 2026-06
    // rejects em-dashes / smart quotes silently with a generic 40004,
    // so we pre-clean to ASCII before sending.
    const asciiOnly = (s: string) =>
      s
        .replace(/[‐-―]/g, "-")   // various dash chars → hyphen
        .replace(/[“”]/g, '"')    // smart double quotes
        .replace(/[‘’]/g, "'")    // smart single quotes
        .replace(/[^\x20-\x7E]/g, "");      // drop the rest
    const name = asciiOnly(opts.folder_name).slice(0, 64);
    const description = asciiOnly(opts.description ?? "Synced from The Frame").slice(0, 250);

    // Send BOTH `name` and `folder_name` — PB's documented field name
    // varies between v1 and current; sending both is harmless and
    // lets the API pick the one it recognizes.
    const raw = await this.request<Record<string, unknown>>(
      "POST",
      "/folders",
      {
        name,
        folder_name: name,
        description,
        parent_id: opts.parent_id ?? null,
        owner_id: opts.owner_id,
      },
    );

    // PB has historically returned the new folder in any of these
    // shapes — handle all of them so we don't crash on an unexpected
    // envelope:
    //   { id, name, ... }                  (flat record)
    //   { folder: { id, ... } }            (named wrapper)
    //   { data: { id, ... } }              (generic wrapper)
    //   { result: { id, ... } }            (rare)
    //   [{ id, ... }]                      (array with one folder)
    //   { folder_id: 123, ... }            (flat with explicit folder_id)
    //   { success: true, folder_id: 123 }  (ack envelope)
    const folder = extractFolder(raw);
    if (folder?.id) return folder;

    // Couldn't find an id anywhere — surface the actual response so
    // the operator can tell us what PB sent and we can teach the
    // extractor to handle it.
    throw new Error(
      `PhoneBurner createFolder returned an unexpected shape — no id found. Response: ${JSON.stringify(raw).slice(0, 500)}`,
    );
  }

  // ── Contacts ──
  /**
   * PB's create response uses this shape:
   *   { http_status: 201, status: "success",
   *     contacts: { contacts: { user_id: "...", first_name, ... } } }
   *
   * The contact's identifier on PB is the `user_id` field (their data
   * model treats every contact as a user record under the parent
   * account). We map that to `.id` in the return value so callers
   * stamp campaign_leads.phoneburner_contact_id consistently.
   */
  async createContact(payload: PbContactPayload): Promise<PbContactResponse> {
    const raw = await this.request<Record<string, unknown>>(
      "POST",
      "/contacts",
      payload,
    );
    // Walk the response for the first user_id we find (handles either
    // the documented `contacts.contacts.user_id` path or any other
    // future shape change without breaking).
    function findUserId(obj: unknown, depth = 0): string | null {
      if (depth > 8 || !obj || typeof obj !== "object") return null;
      const o = obj as Record<string, unknown>;
      if (typeof o.user_id === "string" && o.user_id) return o.user_id;
      if (typeof o.user_id === "number") return String(o.user_id);
      for (const v of Object.values(o)) {
        const found = findUserId(v, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const id =
      (typeof raw.id === "string" && raw.id) ||
      findUserId(raw);
    if (!id) {
      throw new Error(
        `PhoneBurner createContact returned no id/user_id: ${JSON.stringify(raw).slice(0, 300)}`,
      );
    }
    return { id, ...raw } as PbContactResponse;
  }

  async updateContact(id: string, patch: Partial<PbContactPayload>): Promise<PbContactResponse> {
    return await this.request<PbContactResponse>("PUT", `/contacts/${id}`, patch);
  }

  /**
   * Look up a contact by phone in the connected PhoneBurner account.
   *
   * Used to dedup before createContact — Daniel: "we should never
   * override a contact in phone burner." If a phone already exists in
   * PB (manual import, prior campaign, etc.) we stamp our local
   * campaign_leads row with the existing id rather than POSTing a
   * duplicate.
   *
   * Returns the first match's id or null. Tolerates the same
   * envelope-variation PB uses everywhere else: array, {data:[]},
   * {contacts:{...numeric-keyed}}, etc. — see extractFolder for the
   * historical justification.
   *
   * The `phone` arg should be the same 10-digit US string we'd send
   * on create (formatToPbPhone output). PB's documented filter
   * parameter is `phone_number`; we send both `phone_number` and
   * `phone` for safety, similar to how createFolder sends both
   * `name` and `folder_name`.
   */
  async searchContactsByPhone(phone: string): Promise<string | null> {
    if (!phone) return null;
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      "/contacts",
      undefined,
      { phone_number: phone, phone, page_size: 5 },
    );

    // Walk the response for the first id we can find. Reuses the
    // same logic as folder extraction — PB list responses often
    // arrive as { contacts: { "0": {...}, total_results, page, ... } }.
    function walk(o: unknown, depth = 0): string | null {
      if (depth > 6 || !o || typeof o !== "object") return null;
      if (Array.isArray(o)) {
        for (const item of o) {
          const id = walk(item, depth + 1);
          if (id) return id;
        }
        return null;
      }
      const obj = o as Record<string, unknown>;
      // Direct hit
      const direct =
        (typeof obj.id === "string" && obj.id) ||
        (typeof obj.id === "number" && String(obj.id)) ||
        (typeof obj.user_id === "string" && obj.user_id) ||
        (typeof obj.user_id === "number" && String(obj.user_id)) ||
        (typeof obj.contact_id === "string" && obj.contact_id) ||
        (typeof obj.contact_id === "number" && String(obj.contact_id));
      if (direct) {
        // But only if this object also has a phone (otherwise we
        // matched some envelope or count field that happens to have
        // an `id`). PB contact records always include the phone.
        const hasPhone =
          typeof obj.phone === "string" ||
          typeof obj.phone_number === "string" ||
          typeof obj.cell_phone === "string" ||
          typeof obj.work_phone === "string";
        if (hasPhone) return String(direct);
      }
      // Recurse — pseudo-array numeric keys included via Object.values.
      for (const v of Object.values(obj)) {
        const id = walk(v, depth + 1);
        if (id) return id;
      }
      return null;
    }
    return walk(raw);
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
