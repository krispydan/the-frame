"use client";

/**
 * Daily outreach queue. One card at a time, because the job is "read this,
 * decide, move on" and a long scrolling table makes that slower, not faster.
 *
 * The flow it is built around: read the message -> click through to the Faire
 * thread (opens in a new tab) -> paste -> send there -> come back and mark it
 * sent. Copy is one click; the deep link is one click; keyboard shortcuts mean
 * a clean queue never requires touching the mouse.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { QueueItem } from "@/modules/sequences/lib/queue";

interface Props {
  initialItems: QueueItem[];
  initialCounts: { review: number; tasks: number; approved: number; sentToday: number };
}

export function QueueClient({ initialItems, initialCounts }: Props) {
  const [items, setItems] = useState(initialItems);
  const [counts, setCounts] = useState(initialCounts);
  const [i, setI] = useState(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: key auto-repeat can fire again before setBusy propagates.
  const busyRef = useRef(false);

  const item = items[i];
  // Keep per-card edits when navigating back and forth — resetting on every
  // card change silently discarded work the UI promises to record.
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!item) return;
    setDraft(edits[item.id] ?? item.body);
    setCopied(false);
    setError(null);
  }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (item && draft !== item.body) setEdits((e) => ({ ...e, [item.id]: draft }));
  }, [draft, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (action: "sent" | "skip" | "replied") => {
    if (!item || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/sequences/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id, action,
          editedBody: action === "sent" && draft !== item.body ? draft : undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      // The server can refuse (suppressed shop, unresolved merge field, already
      // actioned elsewhere). Keep the card and say why — silently dropping it
      // told the user it was sent when it was not.
      if (!res.ok || body.ok === false) {
        setError(body.reason || body.error || `Could not ${action} (${res.status})`);
        return;
      }
      setItems((prev) => prev.filter((x) => x.id !== item.id));
      setI((prev) => Math.min(prev, Math.max(0, items.length - 2)));
      setCounts((c) => ({
        ...c,
        review: Math.max(0, c.review - 1),
        sentToday: action === "sent" ? c.sentToday + 1 : c.sentToday,
      }));
    } catch {
      setError("Network error — nothing was changed. Try again.");
    } finally { busyRef.current = false; setBusy(false); }
  }, [item, draft, items.length]);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [draft]);

  // Keyboard: c copy, o open thread, s sent, k skip, r replied, arrows navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
      // Cmd+R / Cmd+S would otherwise mark the card replied or sent — both
      // irreversible from here, and Cmd+R is just "reload".
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c") copy();
      if (e.key === "o" && item?.threadUrl) window.open(item.threadUrl, "_blank");
      if (e.key === "s") { e.preventDefault(); act("sent"); }
      if (e.key === "k") { e.preventDefault(); act("skip"); }
      if (e.key === "r") { e.preventDefault(); act("replied"); }
      if (e.key === "ArrowRight") setI((p) => Math.min(p + 1, items.length - 1));
      if (e.key === "ArrowLeft") setI((p) => Math.max(p - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copy, act, item, items.length]);

  if (!items.length) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="text-lg font-medium">Queue clear</p>
        <p className="text-muted-foreground mt-1 text-sm">
          {counts.sentToday > 0 ? `${counts.sentToday} sent today.` : "Nothing waiting for review."}
        </p>
      </div>
    );
  }

  const ctx = [
    item.city && item.state ? `${item.city}, ${item.state}` : item.city || item.state,
    item.tier ? `${item.tier} tier` : null,
    item.totalOrders ? `${item.totalOrders} orders` : "no orders yet",
    item.lastOrderAt ? `last order ${item.lastOrderAt.slice(0, 10)}` : null,
    item.lastMessagedAt ? `last messaged ${item.lastMessagedAt.slice(0, 10)}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded bg-muted px-2 py-1 font-medium">{i + 1} of {items.length}</span>
        <span className="text-muted-foreground">{counts.sentToday} sent today</span>
        <span className="ml-auto text-xs text-muted-foreground">
          keys: <kbd>c</kbd> copy · <kbd>o</kbd> open thread · <kbd>s</kbd> sent · <kbd>k</kbd> skip · <kbd>r</kbd> replied
        </span>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b p-4">
          <div>
            <h2 className="text-lg font-semibold">{item.companyName}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{ctx}</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded bg-blue-100 px-2 py-1 font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              {item.brand?.toUpperCase()}
            </span>
            <span className="rounded bg-muted px-2 py-1">{item.sequenceName} · step {item.stepNo}</span>
          </div>
        </div>

        <div className="p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={10}
            className="w-full resize-y rounded-md border bg-background p-3 font-mono text-sm leading-relaxed"
          />
          {draft !== item.body && (
            <p className="mt-1 text-xs text-amber-600">edited — your version is what gets recorded</p>
          )}
          {item.attachmentKey && (
            <p className="mt-2 text-xs text-muted-foreground">📎 attach: {item.attachmentKey}</p>
          )}
        </div>

        {error && (
          <div className="mx-4 mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t p-4">
          <button onClick={copy} disabled={busy}
            className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
            {copied ? "Copied" : "Copy message"}
          </button>
          {item.threadUrl && (
            <a href={item.threadUrl} target="_blank" rel="noopener noreferrer"
              className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
              Open Faire thread ↗
            </a>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={() => act("replied")} disabled={busy}
              className="rounded-md border px-3 py-2 text-sm hover:bg-muted">They replied</button>
            <button onClick={() => act("skip")} disabled={busy}
              className="rounded-md border px-3 py-2 text-sm hover:bg-muted">Skip</button>
            <button onClick={() => act("sent")} disabled={busy}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              Mark sent
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setI((p) => Math.max(p - 1, 0))} disabled={i === 0}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40">← Previous</button>
        <button onClick={() => setI((p) => Math.min(p + 1, items.length - 1))} disabled={i >= items.length - 1}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40">Next →</button>
      </div>
    </div>
  );
}
