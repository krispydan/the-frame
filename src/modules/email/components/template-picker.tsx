"use client";

/**
 * The composer's saved-messages dropdown.
 *
 * Insert semantics, chosen to match how a rep actually uses a macro:
 *  - Subject fills ONLY if the subject line is still empty. Picking a template
 *    mid-reply should never silently rewrite "Re: your fill-in".
 *  - Body is INSERTED at the cursor, not swapped in. A macro is a paragraph you
 *    drop into a message you are already writing, so replacing the body would
 *    destroy work more often than it saves any.
 *  - Merge fields resolve against the store the composer is open on. Anything
 *    unresolved stays visibly in the text as {token} and is called out in a
 *    toast, because a human is right there to fix it.
 */

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Search, Settings2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export interface TemplateRow {
  id: string;
  name: string;
  category: string | null;
  subject: string | null;
  body_text: string | null;
  visibility: "private" | "team";
  usage_count: number;
  owner_name: string | null;
  mine: boolean;
}

export function TemplatePicker({
  companyId,
  onInsert,
}: {
  companyId?: string | null;
  onInsert: (r: { subject: string; bodyHtml: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [inserting, setInserting] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || rows.length) return;
    setLoading(true);
    fetch("/api/v1/email/templates")
      .then((r) => r.json())
      .then((j) => setRows(j.templates ?? []))
      .finally(() => setLoading(false));
  }, [open, rows.length]);

  // Click-away close — the picker sits inside the composer, so a stray click
  // must not leave it covering the editor.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = async (t: TemplateRow) => {
    setInserting(t.id);
    try {
      const res = await fetch("/api/v1/email/templates/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: t.id, companyId: companyId ?? null }),
      });
      const j = await res.json();
      if (!res.ok) { toast.error("Could not load template", { description: j.error }); return; }
      onInsert({ subject: j.subject ?? "", bodyHtml: j.bodyHtml ?? "" });
      setOpen(false);
      if (j.missing?.length) {
        toast.warning(`Fill in: ${j.missing.map((m: string) => `{${m}}`).join(", ")}`, {
          description: companyId ? "No value on this store record." : "Open from a store record to auto-fill these.",
        });
      }
    } finally {
      setInserting(null);
    }
  };

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((t) =>
        [t.name, t.category, t.subject, t.body_text].some((v) => v?.toLowerCase().includes(needle)),
      )
    : rows;

  return (
    <div className="relative" ref={boxRef}>
      <Button
        variant="ghost" size="sm" className="h-7 px-2"
        onClick={() => setOpen(!open)}
        title="Saved messages"
      >
        <FileText className="h-3.5 w-3.5" />
      </Button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 w-80 rounded-md border bg-background shadow-lg">
          <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              className="flex-1 bg-transparent text-sm outline-none py-0.5"
              placeholder="Search saved messages…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {loading ? (
              <div className="px-3 py-4 flex justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                {rows.length === 0 ? "No saved messages yet." : "Nothing matches."}
              </p>
            ) : (
              filtered.map((t) => (
                <button
                  key={t.id}
                  className="w-full text-left px-3 py-2 hover:bg-muted/60 disabled:opacity-50"
                  disabled={inserting !== null}
                  onClick={() => pick(t)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate flex-1">{t.name}</span>
                    {t.visibility === "team" && (
                      <Users className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Shared with the team" />
                    )}
                    {inserting === t.id && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {t.subject || t.body_text?.slice(0, 70) || "(empty)"}
                  </p>
                </button>
              ))
            )}
          </div>

          <a
            href="/settings/templates"
            className="flex items-center gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="h-3.5 w-3.5" /> Manage saved messages
          </a>
        </div>
      )}
    </div>
  );
}
