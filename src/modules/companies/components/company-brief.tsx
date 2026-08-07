"use client";

/**
 * The first screenful of the company page.
 *
 * A rep opens this page ~20 times a day on a phone, between calls, to answer
 * four questions: are they open, are they worth calling, what do I open with,
 * and what is the number. Before this existed, answering them meant scrolling
 * past a Store Profile, a Tech Stack, an AI-openers card and a Google Maps
 * panel — and the number, when you got to it, was overlapping an email
 * address.
 *
 * Rules this component enforces:
 *   - Nothing renders a placeholder. A stat with no data is absent, not an
 *     em-dash. Four em-dashes are worse than two real numbers.
 *   - Omit when UNKNOWN, not when zero. "$0 from Jaxy" against $38k of AJM
 *     history is the most important fact on the page; a 0-star Google rating
 *     means unrated and is noise.
 *   - Reach rows are full width. Email and phone never share a row on mobile.
 */
import { ReactNode } from "react";
import {
  Phone, Mail, Globe, Copy, AlertTriangle, Star, ShoppingCart, Clock, History, PenLine,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  money, moneyFull, timeAgo, telHref, formatPhone, prettyDomain, externalHref, pluralize,
} from "@/modules/companies/lib/format";

export interface BriefAlert {
  tone: "danger" | "warning";
  text: string;
}

export interface BriefProps {
  companyName: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  alerts: BriefAlert[];
  ajm: { revenue: number; orders: number } | null;
  jaxy: { revenue: number; orders: number } | null;
  google: { rating: number; reviews: number } | null;
  lastTouch: { at: string | null; label: string | null } | null;
  /** Pre-resolved talking point plus where it came from. */
  talkingPoint: { text: string; source: string } | null;
}

function ReachRow({
  icon, href, value, label, mono, copy, external,
}: {
  icon: ReactNode; href: string | null; value: string; label: string;
  mono?: boolean; copy?: string; external?: boolean;
}) {
  if (!value) return null;
  const content = (
    <span className={cn("min-w-0 flex-1 truncate text-left", mono && "text-lg tabular-nums")}>
      {value}
    </span>
  );
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-lg border px-3">
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
      {href ? (
        <a
          href={href}
          aria-label={label}
          className="flex min-w-0 flex-1 items-center font-medium text-foreground hover:text-primary hover:underline"
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {content}
        </a>
      ) : (
        <span className="min-w-0 flex-1 font-medium">{content}</span>
      )}
      {copy && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy ${label}`}
          className="size-9 shrink-0"
          onClick={() => {
            void navigator.clipboard?.writeText(copy);
            toast.success("Copied");
          }}
        >
          <Copy />
        </Button>
      )}
    </div>
  );
}

function StatTile({
  icon, value, caption, tone,
}: { icon: ReactNode; value: string; caption: string; tone?: "money" | "muted" }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="[&_svg]:size-3.5">{icon}</span>
        <span className="truncate">{caption}</span>
      </div>
      <p className={cn(
        "mt-0.5 truncate text-lg font-semibold tabular-nums",
        tone === "money" && "text-emerald-600 dark:text-emerald-400",
        tone === "muted" && "text-muted-foreground",
      )}>
        {value}
      </p>
    </div>
  );
}

export function CompanyBrief(p: BriefProps) {
  const tel = telHref(p.phone);
  const domain = prettyDomain(p.website);

  const tiles: ReactNode[] = [];
  if (p.ajm) {
    tiles.push(
      <StatTile key="ajm" icon={<History />} tone="money"
        value={money(p.ajm.revenue)} caption={`A.J. Morgan · ${p.ajm.orders}`} />,
    );
  }
  // Zero is rendered deliberately: "$0 from Jaxy" next to AJM history is the
  // whole pitch. Only an absent record omits the tile.
  if (p.jaxy) {
    tiles.push(
      <StatTile key="jaxy" icon={<ShoppingCart />}
        tone={p.jaxy.revenue > 0 ? "money" : "muted"}
        value={money(p.jaxy.revenue)} caption={`Jaxy · ${p.jaxy.orders}`} />,
    );
  }
  // A 0 rating means unrated, so it is genuinely unknown and omitted.
  if (p.google && p.google.rating > 0) {
    tiles.push(
      <StatTile key="google" icon={<Star />}
        value={`${p.google.rating.toFixed(1)}★`}
        caption={p.google.reviews ? pluralize(p.google.reviews, "review") : "Google"} />,
    );
  }
  if (p.lastTouch) {
    const ago = timeAgo(p.lastTouch.at);
    tiles.push(
      <StatTile key="touch" icon={<Clock />} tone="muted"
        value={ago ?? "Never"} caption={ago ? "Last touch" : "Not contacted"} />,
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        {p.alerts.map((a, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              a.tone === "danger"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">{a.text}</span>
          </div>
        ))}

        {/* Capped: a phone number stretched across 1500px is harder to read,
            not easier. On a phone this is simply full width. */}
        {(p.phone || p.email || domain) && (
          <div className="space-y-2 lg:max-w-xl">
            <ReachRow
              icon={<Phone />} href={tel} value={formatPhone(p.phone) || ""} mono
              label={`Call ${p.companyName}`}
            />
            <ReachRow
              icon={<Mail />} href={p.email ? `mailto:${p.email}` : null} value={p.email ?? ""}
              label={`Email ${p.companyName}`} copy={p.email ?? undefined}
            />
            <ReachRow
              icon={<Globe />} href={externalHref(p.website)} value={domain ?? ""}
              label={`Open ${domain} in a new tab`} external
            />
          </div>
        )}

        {tiles.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{tiles}</div>
        )}

        {p.talkingPoint && (
          <div className="rounded-lg bg-muted/50 px-3 py-2 lg:max-w-3xl">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {p.talkingPoint.source}
            </p>
            <p className="mt-0.5 text-sm leading-snug">{p.talkingPoint.text}</p>
          </div>
        )}

        {p.lastTouch?.label && (
          <p className="truncate text-xs text-muted-foreground">{p.lastTouch.label}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The single most useful sentence this business has, and the one nothing was
 * generating: A.J. Morgan ceased trading in Dec 2025, Jaxy employs the person
 * who ran its wholesale book, and a shop that spent $38k there and nothing
 * with us is the entire sales motion. That gap outranks any AI opener.
 */
export function resolveTalkingPoint(args: {
  ajmRevenue: number | null;
  jaxyOrders: number;
  aiOpener: string | null;
  topBrand: string | null;
  categories: string | null;
  googleCategory: string | null;
  description: string | null;
}): { text: string; source: string } | null {
  if (args.ajmRevenue && args.ajmRevenue > 0 && args.jaxyOrders === 0) {
    return {
      source: "The gap",
      text: `Spent ${moneyFull(args.ajmRevenue)} with A.J. Morgan and has never ordered from Jaxy.`,
    };
  }
  if (args.aiOpener?.trim()) return { source: "AI opener", text: args.aiOpener.trim() };
  if (args.topBrand?.trim()) {
    return {
      source: "Carries",
      text: args.categories?.trim()
        ? `${args.topBrand.trim()} · ${args.categories.trim()}`
        : args.topBrand.trim(),
    };
  }
  if (args.googleCategory?.trim()) return { source: "Google", text: args.googleCategory.trim() };
  const first = args.description?.trim().split(/(?<=\.)\s/)[0];
  if (first) return { source: "About", text: first };
  return null;
}

/** Bottom action bar — the answer to "there is no way to call without scrolling". */
export function CompanyActionBar({
  phone, email, companyName, onLog,
}: { phone: string | null; email: string | null; companyName: string; onLog: () => void }) {
  const tel = telHref(phone);
  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur",
        "px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden",
      )}
    >
      <div className="grid grid-cols-3 gap-2">
        <Button
          variant="outline" className="h-11" disabled={!tel} nativeButton={!tel}
          render={tel ? <a href={tel} aria-label={`Call ${companyName}`} /> : <button type="button" />}
        >
          <Phone /> Call
        </Button>
        <Button
          variant="outline" className="h-11" disabled={!email} nativeButton={!email}
          render={email ? <a href={`mailto:${email}`} aria-label={`Email ${companyName}`} /> : <button type="button" />}
        >
          <Mail /> Email
        </Button>
        <Button className="h-11" onClick={onLog} aria-label="Log an outcome">
          <PenLine /> Log
        </Button>
      </div>
    </div>
  );
}
