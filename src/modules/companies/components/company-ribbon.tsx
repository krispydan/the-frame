"use client";

/**
 * Sticky identity bar for the company page.
 *
 * Replaces a header that gave top billing to Won and Lost — two one-way doors
 * — inside a `shrink-0` cluster that squeezed the company name down to "T..".
 * The rule here: the header identifies, it does not act. Terminal actions move
 * behind the overflow menu, where a deliberate second tap is exactly the
 * friction they deserve.
 *
 * It also replaces the in-page breadcrumb, which duplicated the global one
 * the page itself populates via `setOverride`.
 */
import { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { joinPlace } from "@/modules/companies/lib/format";

export function CompanyRibbon({
  name, city, state, kind, backHref, menu,
}: {
  name: string;
  city?: string | null;
  state?: string | null;
  /** e.g. the Google category — what kind of shop this is. */
  kind?: string | null;
  backHref: string;
  menu?: ReactNode;
}) {
  const place = joinPlace([city, state]);
  const subtitle = [place, kind].filter(Boolean).join(" · ");

  return (
    // `main` is the scroll container and supplies p-4/md:p-6, so the ribbon
    // bleeds back through that padding to sit flush at the top.
    <header
      className={cn(
        "sticky top-0 z-30 -mx-4 -mt-4 mb-4 border-b bg-background/95 px-4 py-3 backdrop-blur",
        "supports-[backdrop-filter]:bg-background/80 md:-mx-6 md:-mt-6 md:px-6",
      )}
    >
      <div className="flex items-start gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ml-1 size-11 shrink-0"
          nativeButton={false}
          render={<Link href={backHref} aria-label="Back to prospects" />}
        >
          <ArrowLeft />
        </Button>

        <div className="min-w-0 flex-1">
          {/* line-clamp-2, not truncate: the shop name is the primary
              identifier and two lines is cheaper than "T..". */}
          <h1 className="line-clamp-2 text-lg font-semibold leading-tight [overflow-wrap:anywhere] md:text-2xl">
            {name}
          </h1>
          {subtitle && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>

        {menu && (
          <div className="shrink-0">
            {menu}
          </div>
        )}
      </div>

    </header>
  );
}

/**
 * ICP chip with explicit branches. The old template printed "ICP — · 65"
 * because it fell back to an em-dash for the tier and then unconditionally
 * prefixed " · " to the score. A chip with no content renders nothing at all.
 */
/** "ICP A · 65" / "ICP A" / "ICP 65" / nothing. Never "ICP — · 65". */
export function icpChipLabel(tier?: string | null, score?: number | null): string | null {
  const t = tier?.trim();
  const hasScore = score != null && Number.isFinite(score);
  if (!t && !hasScore) return null;
  return t && hasScore ? `ICP ${t} · ${score}` : t ? `ICP ${t}` : `ICP ${score}`;
}
