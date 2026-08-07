"use client";

/**
 * Call and direct-mail steps. These are not messages to send — they are work to
 * do, with the context needed to do it. Marking one done is what advances the
 * sequence, which is also why they cannot be left unreachable: an open task with
 * no way to close it holds the enrollment open and quietly bars that shop from
 * every other sequence.
 */

import { useState } from "react";
import type { QueueItem } from "@/modules/sequences/lib/queue";

export function TaskList({ items }: { items: QueueItem[] }) {
  const [rows, setRows] = useState(items);
  const [busy, setBusy] = useState<string | null>(null);

  const done = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch("/api/v1/sequences/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "task_done" }),
      });
      if (res.ok) setRows((r) => r.filter((x) => x.id !== id));
    } finally { setBusy(null); }
  };

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        No open tasks.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((t) => (
        <div key={t.id} className="rounded-lg border p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-medium">{t.companyName}</div>
              <div className="text-xs text-muted-foreground">
                {[t.city, t.state].filter(Boolean).join(", ")}
                {t.totalOrders ? ` · ${t.totalOrders} orders` : ""}
                {t.lastOrderAt ? ` · last order ${t.lastOrderAt.slice(0, 10)}` : ""}
              </div>
            </div>
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              {t.channel} · {t.sequenceName} step {t.stepNo}
            </span>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm">{t.body}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={() => done(t.id)} disabled={busy === t.id}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              Mark done
            </button>
            {t.threadUrl && (
              <a href={t.threadUrl} target="_blank" rel="noopener noreferrer"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Open thread ↗</a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
