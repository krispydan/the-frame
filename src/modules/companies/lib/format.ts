/**
 * Formatting helpers for the company page.
 *
 * Each of these exists because the page hand-rolled the same thing inline and
 * got it wrong somewhere: "Wetherby," with a trailing comma, "1 units",
 * "ICP — · 65", a contact called "Unknown".
 */

/** Join address parts, dropping blanks — never leaves a dangling comma. */
export function joinPlace(parts: Array<string | null | undefined>): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join(", ");
}

/** `1 unit` / `2 units`. */
export function pluralize(n: number, singular: string, plural?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural ?? `${singular}s`}`;
}

/** Compact money: $8.4k, $1.2M, $940. */
export function money(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "$0";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${Math.round(v).toLocaleString()}`;
}

/** Full money, for places where precision matters more than width. */
export function moneyFull(n: number | null | undefined): string {
  return `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
}

/** "3d ago", "2mo ago", "today". Null-safe. */
export function timeAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Digits only, so `tel:` works regardless of how the number was typed.
 * Keeps a leading + for international numbers.
 */
export function telHref(phone: string | null | undefined): string | null {
  const raw = (phone ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  return digits.length >= 5 ? `tel:${digits}` : null;
}

/** Group a phone for reading. Leaves anything unrecognised alone. */
export function formatPhone(phone: string | null | undefined): string {
  const raw = (phone ?? "").trim();
  const d = raw.replace(/\D/g, "");
  if (d.length === 10 && !raw.startsWith("+")) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return raw;
}

/** A contact's display name, or an honest stand-in — never "Unknown". */
export function contactLabel(c: {
  first_name?: string | null; last_name?: string | null;
  title?: string | null; email?: string | null;
}): { label: string; synthesised: boolean } {
  const name = [c.first_name, c.last_name].map((s) => s?.trim()).filter(Boolean).join(" ");
  if (name) return { label: name, synthesised: false };
  if (c.title?.trim()) return { label: c.title.trim(), synthesised: true };
  const local = c.email?.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  if (local) return { label: local, synthesised: true };
  return { label: "Unnamed contact", synthesised: true };
}

/** Domain only — a full URL is noise in a fact row. */
export function prettyDomain(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "") || null;
}

export function externalHref(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
