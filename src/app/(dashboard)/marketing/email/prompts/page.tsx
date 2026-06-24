"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Save, RotateCcw, Loader2, FileText, Sparkles } from "lucide-react";

interface DocListItem {
  slug: string;
  category: "prompt" | "brand";
  title: string;
  description: string;
  isEdited: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
interface DocView extends DocListItem {
  content: string;
  defaultContent: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  prompt: "Prompts",
  brand: "Brand & voice",
};

export default function PromptsPage() {
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocView | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadList = useCallback(() => {
    fetch("/api/v1/marketing/email/prompts")
      .then((r) => r.json())
      .then((d) => {
        setDocs(d.docs ?? []);
        setSlug((s) => s ?? d.docs?.[0]?.slug ?? null);
      })
      .catch(() => {});
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  // Load the selected doc.
  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setMsg(null);
    fetch(`/api/v1/marketing/email/prompts/${slug}`)
      .then((r) => r.json())
      .then((d) => { setDoc(d.doc ?? null); setDraft(d.doc?.content ?? ""); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  const dirty = doc != null && draft !== doc.content;

  async function save() {
    if (!slug || !dirty) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/marketing/email/prompts/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const data = await res.json();
      if (data.error) { setMsg(data.error); return; }
      setDoc(data.doc);
      setDraft(data.doc.content);
      setMsg("Saved — live on the next generation.");
      loadList();
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!slug) return;
    if (!confirm("Reset this document to the shipped default? Your edits will be replaced.")) return;
    setResetting(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/marketing/email/prompts/${slug}/reset`, { method: "POST" });
      const data = await res.json();
      if (data.error) { setMsg(data.error); return; }
      setDoc(data.doc);
      setDraft(data.doc.content);
      setMsg("Reset to default.");
      loadList();
    } finally {
      setResetting(false);
    }
  }

  const grouped = (["prompt", "brand"] as const).map((cat) => ({
    cat,
    items: docs.filter((d) => d.category === cat),
  }));

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link href="/marketing/email" className="text-sm text-muted-foreground hover:text-foreground">
          ← Email assistant
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Prompts &amp; brand voice</h1>
        <p className="text-muted-foreground">
          The living documents that steer every AI generation. Edits save to the database and take effect on the
          next generate — the shipped <code className="text-xs bg-muted px-1 rounded">.md</code> files stay the
          baseline you can always reset to.
        </p>
      </div>

      <div className="grid grid-cols-[260px_1fr] gap-4">
        {/* Doc list */}
        <div className="space-y-4">
          {grouped.map(({ cat, items }) => (
            <div key={cat}>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                {cat === "prompt" ? <Sparkles className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                {CATEGORY_LABEL[cat]}
              </div>
              <div className="space-y-1">
                {items.map((d) => (
                  <button
                    key={d.slug}
                    type="button"
                    onClick={() => setSlug(d.slug)}
                    className={`w-full text-left rounded-md px-2 py-1.5 text-sm ${d.slug === slug ? "bg-accent" : "hover:bg-accent/50"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{d.title}</span>
                      {d.isEdited && <Badge variant="secondary" className="text-[10px] shrink-0">edited</Badge>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Editor */}
        <Card>
          <CardContent className="p-4 space-y-3">
            {loading || !doc ? (
              <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium flex items-center gap-2">
                      {doc.title}
                      {doc.isEdited && <Badge variant="secondary" className="text-[10px]">edited</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">{doc.description}</p>
                    {doc.updatedAt && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Last edited {new Date(doc.updatedAt + "Z").toLocaleString()}
                        {doc.updatedBy ? ` · ${doc.updatedBy}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" variant="ghost" onClick={reset} disabled={resetting || saving || !doc.isEdited} title="Restore the shipped default">
                      {resetting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RotateCcw className="h-3 w-3 mr-1" />}
                      Reset
                    </Button>
                    <Button size="sm" onClick={save} disabled={!dirty || saving || resetting}>
                      {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}
                      Save
                    </Button>
                  </div>
                </div>

                {msg && <div className="text-xs rounded border border-input bg-muted/40 px-2 py-1">{msg}</div>}

                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="w-full h-[60vh] rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                />
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{draft.length.toLocaleString()} chars{dirty ? " · unsaved changes" : ""}</span>
                  <span>Markdown — the fenced ``` block is the active prompt; text around it is documentation.</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
