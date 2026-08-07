"use client";

/**
 * Saved messages — craft, edit, share.
 *
 * Two columns: the library on the left, the editor on the right. The editor is
 * the same contenteditable surface as the composer so what you write here is
 * exactly what pastes there, and the merge-field palette sits beside it because
 * a token you cannot remember is a token nobody uses.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive, ArchiveRestore, Bold, Italic, Link2, List, ListOrdered, Loader2,
  Lock, Plus, Underline, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

interface Template {
  id: string;
  name: string;
  category: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  visibility: "private" | "team";
  usage_count: number;
  owner_name: string | null;
  archived_at: string | null;
  canEdit: boolean;
  mine: boolean;
}
interface MergeField { token: string; description: string }

const BLANK: Template = {
  id: "", name: "", category: null, subject: "", body_html: "", body_text: "",
  visibility: "private", usage_count: 0, owner_name: null, archived_at: null,
  canEdit: true, mine: true,
};

export default function TemplatesPage() {
  const [rows, setRows] = useState<Template[]>([]);
  const [fields, setFields] = useState<MergeField[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [sel, setSel] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [visibility, setVisibility] = useState<"private" | "team">("private");
  const [saving, setSaving] = useState(false);
  const [openSeq, setOpenSeq] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const pendingBodyRef = useRef("");

  const load = useCallback(async (archived: boolean) => {
    setLoading(true);
    try {
      const j = await fetch(`/api/v1/email/templates${archived ? "?includeArchived=1" : ""}`).then((r) => r.json());
      setRows(j.templates ?? []);
      setFields(j.mergeFields ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(showArchived); }, [load, showArchived]);

  const open = (t: Template) => {
    setSel(t);
    setName(t.name);
    setCategory(t.category ?? "");
    setSubject(t.subject ?? "");
    setVisibility(t.visibility);
    // The editor may not be mounted yet (nothing was selected), so the body is
    // handed to an effect that runs once the contenteditable exists.
    pendingBodyRef.current = t.body_html ?? "";
    setOpenSeq((n) => n + 1);
  };

  useEffect(() => {
    if (openSeq && editorRef.current) editorRef.current.innerHTML = pendingBodyRef.current;
  }, [openSeq]);

  const exec = (cmd: string, arg?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, arg);
  };

  const insertToken = (token: string) => {
    editorRef.current?.focus();
    if (!document.execCommand("insertText", false, `{${token}}`)) {
      if (editorRef.current) editorRef.current.innerHTML += `{${token}}`;
    }
  };

  const save = async () => {
    if (!name.trim()) { toast.error("Give it a name"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/v1/email/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: sel?.id || undefined,
          name: name.trim(),
          category: category.trim() || null,
          subject,
          bodyHtml: editorRef.current?.innerHTML ?? "",
          visibility,
        }),
      });
      const j = await res.json();
      if (!res.ok) { toast.error("Not saved", { description: j.error }); return; }
      toast.success("Saved");
      await load(showArchived);
      setSel(null);
    } finally {
      setSaving(false);
    }
  };

  const toggleArchive = async (t: Template) => {
    const restore = !!t.archived_at;
    const res = await fetch(`/api/v1/email/templates?id=${t.id}${restore ? "&restore=1" : ""}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Could not update"); return; }
    toast.success(restore ? "Restored" : "Archived");
    if (sel?.id === t.id) setSel(null);
    void load(showArchived);
  };

  const mine = rows.filter((t) => t.mine && t.visibility === "private");
  const team = rows.filter((t) => t.visibility === "team");

  const Row = ({ t }: { t: Template }) => (
    <div
      className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer hover:bg-muted/50 ${
        sel?.id === t.id ? "bg-muted" : ""
      } ${t.archived_at ? "opacity-60" : ""}`}
      onClick={() => open(t)}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{t.name}</p>
        <p className="text-xs text-muted-foreground truncate">
          {t.subject || t.body_text?.slice(0, 60) || "(empty)"}
        </p>
      </div>
      {t.usage_count > 0 && (
        <Badge variant="secondary" className="text-[10px] shrink-0">{t.usage_count} uses</Badge>
      )}
      {t.canEdit && (
        <Button
          size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0"
          onClick={(e) => { e.stopPropagation(); void toggleArchive(t); }}
          title={t.archived_at ? "Restore" : "Archive"}
        >
          {t.archived_at ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Saved messages</h1>
          <p className="text-muted-foreground">
            Reusable emails you can drop into the composer. Keep one to yourself or share it with the team.
          </p>
        </div>
        <Button onClick={() => open(BLANK)}>
          <Plus className="h-4 w-4 mr-1.5" /> New
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        {/* Library */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" /> Team ({team.length})
              </CardTitle>
              <CardDescription>Shared with everyone</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                : team.length === 0 ? <p className="text-sm text-muted-foreground">Nothing shared yet.</p>
                : team.map((t) => <Row key={t.id} t={t} />)}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Lock className="h-4 w-4 text-muted-foreground" /> Just mine ({mine.length})
              </CardTitle>
              <CardDescription>Only you can see these</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {mine.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p>
                : mine.map((t) => <Row key={t.id} t={t} />)}
            </CardContent>
          </Card>

          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
        </div>

        {/* Editor */}
        {sel === null ? (
          <Card>
            <CardContent className="py-16 text-center text-sm text-muted-foreground">
              Pick a saved message to edit, or create a new one.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{sel.id ? "Edit saved message" : "New saved message"}</CardTitle>
              <CardDescription>
                {sel.id && !sel.mine ? `Created by ${sel.owner_name || "a teammate"}` : "Merge fields fill in from the store record when you paste it."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="tpl-name">Name</Label>
                  <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Fill-in nudge" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="tpl-cat">Category</Label>
                  <Input id="tpl-cat" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Optional" />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="tpl-subj">Subject</Label>
                <Input
                  id="tpl-subj" value={subject} onChange={(e) => setSubject(e.target.value)}
                  placeholder="Quick fill-in for {account_name}"
                />
                <p className="text-[11px] text-muted-foreground">
                  Only used when the composer&apos;s subject is still empty, so replies keep their thread.
                </p>
              </div>

              <div className="grid gap-1.5">
                <Label>Message</Label>
                <div className="rounded-md border">
                  <div className="flex items-center gap-0.5 border-b px-2 py-1">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("bold")}><Bold className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("italic")}><Italic className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("underline")}><Underline className="h-3.5 w-3.5" /></Button>
                    <div className="w-px h-4 bg-border mx-1" />
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("insertUnorderedList")}><List className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("insertOrderedList")}><ListOrdered className="h-3.5 w-3.5" /></Button>
                    <Button
                      variant="ghost" size="sm" className="h-7 w-7 p-0"
                      onClick={() => {
                        const url = window.prompt("Link URL");
                        if (url) exec("createLink", /^https?:\/\//.test(url) ? url : `https://${url}`);
                      }}
                    >
                      <Link2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div
                    ref={editorRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="min-h-[220px] max-h-[420px] overflow-y-auto px-3 py-2 text-sm outline-none [&_a]:text-blue-600 [&_a]:underline"
                  />
                </div>
              </div>

              <div>
                <Label className="text-xs">Merge fields — click to insert</Label>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {fields.map((f) => (
                    <button
                      key={f.token}
                      title={f.description}
                      onClick={() => insertToken(f.token)}
                      className="rounded-full border px-2 py-0.5 text-xs font-mono hover:bg-muted"
                    >
                      {`{${f.token}}`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>Who can use it</Label>
                <div className="flex gap-2">
                  {(["private", "team"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setVisibility(v)}
                      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
                        visibility === v ? "bg-muted font-medium" : "text-muted-foreground"
                      }`}
                    >
                      {v === "private" ? <Lock className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
                      {v === "private" ? "Just me" : "Whole team"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button onClick={save} disabled={saving || !sel.canEdit}>
                  {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
                  {sel.id ? "Save changes" : "Create"}
                </Button>
                <Button variant="ghost" onClick={() => setSel(null)}>Cancel</Button>
                {!sel.canEdit && (
                  <span className="text-xs text-muted-foreground">
                    Read only, a teammate owns this one.
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
