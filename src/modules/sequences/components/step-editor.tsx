"use client";

/**
 * The step builder. Christina owns the wording and the timing, so both have to
 * be editable here — before this, adding a day-8 follow-up meant a code change
 * and a deploy.
 *
 * Two things it does that a plain form would not:
 *  - shows the cumulative DAY number the way Faire/Pipedrive do, recalculated
 *    live as delays change, because "7 days after the previous step" is hard to
 *    reason about and "DAY 8" is not;
 *  - runs the house-style lint on every save and shows it inline.
 *
 * Attachments mirror what Faire's composer actually offers: an image/file, a
 * product, or a collection.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface EditorStep {
  id: string;
  step_no: number;
  delay_days: number;
  delay_business_days: number;
  channel: string;
  send_mode: string;
  template_body: string;
  attachment_type: string | null;
  attachment_ref: string | null;
  attachment_label: string | null;
  offer_code: string | null;
  task_note: string | null;
}

const CHANNELS = [
  { v: "faire", label: "Faire message" },
  { v: "email", label: "Email" },
  { v: "call", label: "Call (task)" },
  { v: "direct_mail", label: "Direct mail (task)" },
];
const MODES = [
  { v: "review", label: "Review first", hint: "Drafted into the queue. You send it." },
  { v: "task", label: "Task", hint: "Creates work to do. Nothing is sent." },
  { v: "auto", label: "Auto send", hint: "Sends without review. Use only once the copy is proven." },
];
const ATTACH = [
  { v: "", label: "No attachment" },
  { v: "file", label: "Image or file" },
  { v: "product", label: "Product" },
  { v: "collection", label: "Collection" },
];

export function StepEditor({ sequenceId, steps }: { sequenceId: string; steps: EditorStep[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<EditorStep>>>({});
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  const val = <K extends keyof EditorStep>(s: EditorStep, k: K): EditorStep[K] =>
    (drafts[s.id]?.[k] ?? s[k]) as EditorStep[K];
  const setVal = (id: string, k: keyof EditorStep, v: unknown) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], [k]: v } }));

  // Cumulative day numbers, recomputed from the current (possibly edited) delays.
  let day = 1;
  const dayFor: number[] = steps.map((s, i) => {
    if (i > 0) day += Number(val(s, "delay_days")) || 0;
    return day;
  });

  const post = async (body: unknown) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/v1/sequences/steps", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || `Failed (${res.status})`); return null; }
      return j;
    } catch { setError("Network error — nothing was saved."); return null; }
    finally { setBusy(false); }
  };

  const save = async (s: EditorStep) => {
    const patch = drafts[s.id];
    if (!patch || !Object.keys(patch).length) { setOpenId(null); return; }
    const j = await post({ action: "update", id: s.id, patch });
    if (!j) return;
    setWarnings((w) => ({ ...w, [s.id]: j.warnings || [] }));
    setDrafts((d) => { const n = { ...d }; delete n[s.id]; return n; });
    setOpenId(null);
    router.refresh();
  };

  const addStep = async () => { if (await post({ action: "create", sequenceId })) router.refresh(); };
  const del = async (s: EditorStep) => {
    if (!confirm(`Delete step ${s.step_no}? Steps after it move up.`)) return;
    if (await post({ action: "delete", id: s.id })) router.refresh();
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {steps.map((s, i) => {
        const open = openId === s.id;
        const dirty = !!drafts[s.id] && Object.keys(drafts[s.id]).length > 0;
        const isTask = val(s, "send_mode") === "task";
        return (
          <div key={s.id} className={`rounded-lg border ${dirty ? "border-amber-400" : ""}`}>
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm">
              <span className="font-medium">DAY {dayFor[i]}</span>
              <span className="text-muted-foreground">
                {i === 0 ? "on trigger" : `${val(s, "delay_days")} days after step ${s.step_no - 1} completes`}
              </span>
              <span className="ml-auto rounded bg-background px-2 py-0.5 text-xs">
                {CHANNELS.find((c) => c.v === val(s, "channel"))?.label ?? val(s, "channel")}
              </span>
              <span className={`rounded px-2 py-0.5 text-xs ${
                val(s, "send_mode") === "auto" ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                : isTask ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"}`}>
                {MODES.find((m) => m.v === val(s, "send_mode"))?.label}
              </span>
              <button onClick={() => setOpenId(open ? null : s.id)}
                className="rounded border px-2 py-0.5 text-xs hover:bg-background">
                {open ? "Close" : "Edit"}
              </button>
            </div>

            {!open ? (
              <>
                <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-sm leading-relaxed">
                  {val(s, "template_body")}
                </pre>
                <div className="flex flex-wrap gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
                  {val(s, "attachment_type") && (
                    <span>📎 {ATTACH.find((a) => a.v === val(s, "attachment_type"))?.label}
                      {val(s, "attachment_label") ? `: ${val(s, "attachment_label")}` : ""}</span>
                  )}
                  {val(s, "offer_code") && <span>offer: {val(s, "offer_code")}</span>}
                  {(warnings[s.id] || []).length > 0 && (
                    <span className="text-amber-600">⚠ {warnings[s.id].join(" · ")}</span>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-3 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  {i > 0 && (
                    <label className="text-xs">
                      <span className="mb-1 block text-muted-foreground">Days after previous step</span>
                      <input type="number" min={0} value={val(s, "delay_days") ?? 0}
                        onChange={(e) => setVal(s.id, "delay_days", Number(e.target.value))}
                        className="w-full rounded border bg-background px-2 py-1.5 text-sm" />
                    </label>
                  )}
                  <label className="text-xs">
                    <span className="mb-1 block text-muted-foreground">Channel</span>
                    <select value={val(s, "channel")} onChange={(e) => setVal(s.id, "channel", e.target.value)}
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm">
                      {CHANNELS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
                    </select>
                  </label>
                  <label className="text-xs">
                    <span className="mb-1 block text-muted-foreground">How it sends</span>
                    <select value={val(s, "send_mode")} onChange={(e) => setVal(s.id, "send_mode", e.target.value)}
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm">
                      {MODES.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                    </select>
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {MODES.find((m) => m.v === val(s, "send_mode"))?.hint}
                </p>

                <label className="block text-xs">
                  <span className="mb-1 block text-muted-foreground">
                    {isTask ? "What needs doing" : "Message"} — use {"{first_name}"}, {"{account_name}"}, {"{best_seller}"}
                  </span>
                  <textarea rows={9} value={val(s, "template_body")}
                    onChange={(e) => setVal(s.id, "template_body", e.target.value)}
                    className="w-full rounded border bg-background p-3 font-mono text-sm leading-relaxed" />
                </label>

                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="text-xs">
                    <span className="mb-1 block text-muted-foreground">Attachment</span>
                    <select value={val(s, "attachment_type") ?? ""}
                      onChange={(e) => setVal(s.id, "attachment_type", e.target.value)}
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm">
                      {ATTACH.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
                    </select>
                  </label>
                  {val(s, "attachment_type") && (
                    <label className="text-xs sm:col-span-2">
                      <span className="mb-1 block text-muted-foreground">
                        {val(s, "attachment_type") === "product" ? "Which product (SKU or name)"
                          : val(s, "attachment_type") === "collection" ? "Which collection"
                          : "Which file"}
                      </span>
                      <input value={val(s, "attachment_label") ?? ""}
                        onChange={(e) => setVal(s.id, "attachment_label", e.target.value)}
                        placeholder={val(s, "attachment_type") === "product" ? "JX1001-BLK"
                          : val(s, "attachment_type") === "collection" ? "New arrivals" : "Summer linesheet"}
                        className="w-full rounded border bg-background px-2 py-1.5 text-sm" />
                    </label>
                  )}
                </div>

                <div className="flex gap-2 pt-1">
                  <button onClick={() => save(s)} disabled={busy}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                    Save step
                  </button>
                  <button onClick={() => { setDrafts((d) => { const n = { ...d }; delete n[s.id]; return n; }); setOpenId(null); }}
                    className="rounded-md border px-3 py-1.5 text-sm">Cancel</button>
                  <button onClick={() => del(s)} disabled={busy}
                    className="ml-auto rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30">
                    Delete step
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button onClick={addStep} disabled={busy}
        className="w-full rounded-lg border border-dashed py-3 text-sm text-muted-foreground hover:bg-muted/40 disabled:opacity-50">
        + Add a step
      </button>
    </div>
  );
}
