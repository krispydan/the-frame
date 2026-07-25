"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { GripVertical, EyeOff, ArrowUpRight } from "lucide-react";

/**
 * Chrome around a dashboard widget: title + optional subtitle, an optional
 * "open full view" link, and — in customize mode — a drag handle and a
 * hide button. Purely presentational; the page owns drag/hide behavior.
 */
export function WidgetFrame({
  title,
  subtitle,
  href,
  linkLabel = "View",
  customizing,
  dragHandleProps,
  onHide,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  href?: string;
  linkLabel?: string;
  customizing?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  onHide?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex flex-col rounded-xl border bg-card", customizing && "ring-1 ring-primary/30", className)}>
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        {customizing && (
          <button
            {...dragHandleProps}
            className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
            aria-label="Drag to reorder"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold leading-tight">{title}</h3>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {customizing ? (
          <button
            onClick={onHide}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Hide widget"
          >
            <EyeOff className="h-3.5 w-3.5" /> Hide
          </button>
        ) : href ? (
          <Link
            href={href}
            className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {linkLabel} <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        ) : null}
      </header>
      <div className="flex-1 p-4">{children}</div>
    </section>
  );
}
