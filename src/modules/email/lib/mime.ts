/**
 * MIME building and parsing for the Gmail integration.
 *
 * Parsing helpers are ported from trycompai/crm's gmail-mime.ts (header
 * lookup, body extraction that skips attachments, root-message-id
 * resolution). Building is ours — compai never sends.
 *
 * Threading rule (what makes replies land in the same conversation in the
 * recipient's client AND in our thread table): a reply carries
 * `In-Reply-To: <parent-rfc-id>` and `References: <chain...> <parent>`, and
 * our thread key is the ROOT of that chain — first entry of References,
 * else In-Reply-To, else the message's own id.
 */

export type GmailHeader = { name?: string; value?: string };

export type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
};

export function header(headers: readonly GmailHeader[] | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = headers?.find((h) => h.name?.toLowerCase() === wanted);
  return found?.value?.trim() ?? null;
}

export function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function encodeBase64Url(data: Buffer | string): string {
  const b = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `<abc@mail.gmail.com>` → normalized form with brackets, or null. */
export function normalizeRfcId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<[^>]+>/);
  if (m) return m[0];
  const t = raw.trim();
  return t ? `<${t}>` : null;
}

/** The thread key: root of the References chain. */
export function rootMessageId(headers: readonly GmailHeader[] | undefined): string | null {
  const refs = header(headers, "references");
  if (refs) {
    const first = refs.match(/<[^>]+>/);
    if (first) return first[0];
  }
  return normalizeRfcId(header(headers, "in-reply-to")) ?? normalizeRfcId(header(headers, "message-id"));
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  const disposition = header(part.headers, "content-disposition");
  return disposition?.toLowerCase().startsWith("attachment") ?? false;
}

function findPart(part: GmailPart, mimeType: string): GmailPart | null {
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    if (isAttachment(child)) continue;
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function plainTextBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));
  if (payload.body?.data && !payload.filename) return decodeBase64Url(payload.body.data);
  return "";
}

export function htmlBody(payload: GmailPart | undefined): string | null {
  if (!payload) return null;
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return decodeBase64Url(html.body.data);
  return null;
}

export function listAttachments(
  payload: GmailPart | undefined,
): Array<{ filename: string; size: number; mime: string; gmailAttachmentId: string | null }> {
  const out: Array<{ filename: string; size: number; mime: string; gmailAttachmentId: string | null }> = [];
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    if (isAttachment(part) && part.filename) {
      out.push({
        filename: part.filename,
        size: part.body?.size ?? 0,
        mime: part.mimeType ?? "application/octet-stream",
        gmailAttachmentId: part.body?.attachmentId ?? null,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

/** `"Katie" <k@x.com>` → { name, email } — tolerant of bare addresses. */
export function parseAddress(raw: string | null | undefined): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const angled = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (angled) {
    return { name: angled[1].trim() || null, email: angled[2].trim().toLowerCase() || null };
  }
  const bare = raw.trim();
  return bare.includes("@") ? { name: null, email: bare.toLowerCase() } : { name: bare || null, email: null };
}

export function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // Split on commas not inside quotes — good enough for real-world headers.
  return raw
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => parseAddress(part).email)
    .filter((e): e is string => !!e);
}

// ── Building outbound MIME ──

export interface OutboundAttachment {
  filename: string;
  mime: string;
  content: Buffer;
}

export interface OutboundMessage {
  from: string;               // "Name <email>" or bare
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: OutboundAttachment[];
  /** RFC ids for reply threading. */
  inReplyTo?: string | null;
  references?: string[] | null;
}

/** RFC 2047 encode a header value when it needs it (subject, filenames). */
function encodeHeaderValue(v: string): string {
  return /[^\x00-\x7F]/.test(v) ? `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=` : v;
}

function foldBase64(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

/**
 * Build the full RFC822 message, base64url-encoded for Gmail's
 * `messages.send { raw }`. Structure:
 *   multipart/mixed
 *     └ multipart/alternative (text/plain + text/html)
 *     └ one part per attachment
 */
export function buildRawMessage(msg: OutboundMessage): string {
  const mixedBoundary = `mixed_${crypto.randomUUID().replace(/-/g, "")}`;
  const altBoundary = `alt_${crypto.randomUUID().replace(/-/g, "")}`;

  const headers: string[] = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(", ")}`,
  ];
  if (msg.cc?.length) headers.push(`Cc: ${msg.cc.join(", ")}`);
  if (msg.bcc?.length) headers.push(`Bcc: ${msg.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  if (msg.inReplyTo) {
    headers.push(`In-Reply-To: ${msg.inReplyTo}`);
    const refs = [...(msg.references ?? []), msg.inReplyTo];
    headers.push(`References: ${[...new Set(refs)].join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");

  const alt = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(msg.text, "utf8").toString("base64")),
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(msg.html, "utf8").toString("base64")),
    `--${altBoundary}--`,
  ].join("\r\n");

  if (!msg.attachments?.length) {
    const raw = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      alt,
    ].join("\r\n");
    return encodeBase64Url(raw);
  }

  const parts: string[] = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    alt,
  ];
  for (const a of msg.attachments) {
    const fname = encodeHeaderValue(a.filename);
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${a.mime}; name="${fname}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${fname}"`,
      "",
      foldBase64(a.content.toString("base64")),
    );
  }
  parts.push(`--${mixedBoundary}--`);

  const raw = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    parts.join("\r\n"),
  ].join("\r\n");
  return encodeBase64Url(raw);
}
