"use client";

/**
 * One collapsible section of the company page.
 *
 * The page was fifteen full-width cards at identical visual weight, 4,998px
 * tall on a 390px phone, with five of them holding nothing but placeholder
 * text. This wrapper enforces the two rules that fix that:
 *
 *   1. A section with nothing to say renders NOTHING. Not a card with grey
 *      text saying it is empty.
 *   2. A section's default open state is a property of the SECTION, not the
 *      screen width. Contacts and buying history are always open; store
 *      intel, the Google listing, outreach and admin are always collapsed.
 *      Deciding this per-section rather than per-viewport means no media
 *      query, no hydration mismatch, and no second layout to maintain — and
 *      nobody needs Tech Stack expanded by default on a 27" monitor either.
 *
 * `summary` is what makes collapsing acceptable: "Buying history — AJM $38.5k
 * · 38 orders" tells you whether opening it is worth a tap. A row that just
 * says "Buying history" is a lottery ticket.
 */
import { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function Section({
  title, summary, icon, children, defaultOpen = false, action, id,
}: {
  title: string;
  /** One line of what's inside — shown on the collapsed row. */
  summary?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Optional control rendered in the open body's top-right. */
  action?: ReactNode;
  id?: string;
}) {
  return (
    <details
      id={id}
      open={defaultOpen}
      className="group rounded-xl border bg-card text-card-foreground shadow-sm"
    >
      {/* min-h-11 is the iOS touch minimum; the default Button is h-8. */}
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-4 py-3",
          "[&::-webkit-details-marker]:hidden",
          "rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {icon && <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>}
        <span className="shrink-0 text-sm font-medium">{title}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
        )}
        <ChevronDown
          aria-hidden
          className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t px-4 py-4">
        {action && <div className="mb-3 flex justify-end">{action}</div>}
        {children}
      </div>
    </details>
  );
}
