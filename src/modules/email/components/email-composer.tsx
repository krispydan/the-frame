"use client";

/**
 * The email composer: rich text, attachments, send / schedule / draft.
 *
 * Rich text is a contenteditable surface with a deliberate, email-sized
 * toolbar (bold, italic, underline, lists, links) — document.execCommand is
 * officially deprecated but universally supported and exactly matches
 * email-grade formatting; the editor is isolated in this component so a
 * library swap later touches one file.
 *
 * Autosave: once anything is typed, the draft persists 1.5s after the last
 * keystroke — closing the panel loses nothing. Attachments force a draft
 * save first (the upload needs an outbox row to hang off).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold, CalendarClock, Italic, Link2, List, ListOrdered, Loader2,
  Paperclip, Send, Trash2, Underline, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface Attachment { id: string; filename: string; size: number; mime: string }

export interface ComposerSeed {
  draftId?: string;
  to?: string[];
  subject?: string;
  bodyHtml?: string;
  replyToMessageId?: string | null;
  scheduledFor?: string | null;
  attachments?: Attachment[];
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** To/Cc/Bcc chip field: tokenizes on Enter, comma, semicolon, blur, paste. */
function RecipientField({
  label, value, onChange, autoFocus,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");

  const commit = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p.toLowerCase())) next.push(p.toLowerCase());
    onChange(next);
    setText("");
  };

  return (
    <div className="flex items-start gap-2 border-b py-1.5">
      <span className="text-xs text-muted-foreground w-8 pt-1.5 shrink-0">{label}</span>
      <div className="flex flex-wrap items-center gap-1 flex-1 min-w-0">
        {value.map((email) => (
          <span
            key={email}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
              EMAIL_RE.test(email) ? "bg-muted" : "bg-red-100 text-red-700"
            }`}
            title={EMAIL_RE.test(email) ? email : "Not a valid address"}
          >
            {email}
            <button onClick={() => onChange(value.filter((e) => e !== email))} className="hover:text-red-600">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[140px] bg-transparent text-sm outline-none py-1"
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(text); }
            else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => commit(text)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\s]/.test(pasted)) { e.preventDefault(); commit(pasted); }
          }}
        />
      </div>
    </div>
  );
}

export function EmailComposer({
  companyId, contactId, seed, onDone, onCancel,
}: {
  companyId?: string | null;
  contactId?: string | null;
  seed?: ComposerSeed;
  onDone: (status: "sent" | "scheduled" | "draft") => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState<string[]>(seed?.to ?? []);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>(seed?.attachments ?? []);
  const [draftId, setDraftId] = useState<string | null>(seed?.draftId ?? null);
  const [busy, setBusy] = useState<null | "send" | "schedule" | "draft" | "attach">(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");

  const editorRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editorRef.current && seed?.bodyHtml) editorRef.current.innerHTML = seed.bodyHtml;
    // seed is mount-time only by design
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payload = useCallback(
    () => ({
      id: draftId ?? undefined,
      to, cc, bcc,
      subject,
      bodyHtml: editorRef.current?.innerHTML ?? "",
      companyId: companyId ?? null,
      contactId: contactId ?? null,
      replyToMessageId: seed?.replyToMessageId ?? null,
      attachments,
    }),
    [draftId, to, cc, bcc, subject, companyId, contactId, seed?.replyToMessageId, attachments],
  );

  const persistDraft = useCallback(async (): Promise<string | null> => {
    const res = await fetch("/api/v1/email/outbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload(), action: "draft" }),
    });
    const j = await res.json();
    if (!res.ok) { toast.error("Draft not saved", { description: j.error }); return null; }
    setDraftId(j.id);
    setSavedAt(Date.now());
    return j.id as string;
  }, [payload]);

  // Debounced autosave.
  useEffect(() => {
    if (!dirtyRef.current) return;
    const t = setTimeout(() => { void persistDraft(); dirtyRef.current = false; }, 1500);
    return () => clearTimeout(t);
  });

  const markDirty = () => { dirtyRef.current = true; };

  const exec = (cmd: string, arg?: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, arg);
    markDirty();
  };

  const addLink = () => {
    const url = window.prompt("Link URL");
    if (!url) return;
    exec("createLink", /^https?:\/\//.test(url) ? url : `https://${url}`);
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("attach");
    try {
      let id = draftId;
      if (!id) id = await persistDraft();
      if (!id) return;
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("outboxId", id);
        form.set("file", file);
        const res = await fetch("/api/v1/email/attachments", { method: "POST", body: form });
        const j = await res.json();
        if (!res.ok) { toast.error(`Couldn't attach ${file.name}`, { description: j.error }); continue; }
        setAttachments(j.attachments);
      }
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async (action: "send" | "schedule" | "draft", scheduledFor?: string) => {
    setBusy(action);
    try {
      const res = await fetch("/api/v1/email/outbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload(), action, scheduledFor }),
      });
      const j = await res.json();
      if (!res.ok) { toast.error("Not sent", { description: j.error }); return; }
      if (action === "send") toast.success("Sending — it will appear in the thread shortly");
      else if (action === "schedule") toast.success(`Scheduled — sends within 5 minutes of ${new Date(scheduledFor!).toLocaleString()}`);
      else toast.success("Draft saved");
      onDone(action === "send" ? "sent" : action === "schedule" ? "scheduled" : "draft");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border bg-background shadow-sm">
      <div className="px-3 pt-2">
        <RecipientField label="To" value={to} onChange={(v) => { setTo(v); markDirty(); }} autoFocus={!seed?.to?.length} />
        {showCcBcc ? (
          <>
            <RecipientField label="Cc" value={cc} onChange={(v) => { setCc(v); markDirty(); }} />
            <RecipientField label="Bcc" value={bcc} onChange={(v) => { setBcc(v); markDirty(); }} />
          </>
        ) : (
          <button className="text-xs text-muted-foreground hover:text-foreground py-1" onClick={() => setShowCcBcc(true)}>
            + Cc/Bcc
          </button>
        )}
        <div className="border-b py-1.5">
          <Input
            className="border-0 shadow-none focus-visible:ring-0 px-0 h-7 text-sm font-medium"
            placeholder="Subject"
            value={subject}
            onChange={(e) => { setSubject(e.target.value); markDirty(); }}
          />
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("bold")} title="Bold"><Bold className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("italic")} title="Italic"><Italic className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("underline")} title="Underline"><Underline className="h-3.5 w-3.5" /></Button>
        <div className="w-px h-4 bg-border mx-1" />
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("insertUnorderedList")} title="Bullet list"><List className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => exec("insertOrderedList")} title="Numbered list"><ListOrdered className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={addLink} title="Link"><Link2 className="h-3.5 w-3.5" /></Button>
        <div className="w-px h-4 bg-border mx-1" />
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => fileRef.current?.click()} disabled={busy === "attach"} title="Attach files">
          {busy === "attach" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
        </Button>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => attach(e.target.files)} />
        <div className="flex-1" />
        {savedAt ? <span className="text-[11px] text-muted-foreground pr-2">Draft saved</span> : null}
      </div>

      {/* Editor */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={markDirty}
        className="min-h-[180px] max-h-[420px] overflow-y-auto px-3 py-2 text-sm outline-none [&_a]:text-blue-600 [&_a]:underline"
        data-placeholder="Write your email…"
      />

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
              <Paperclip className="h-3 w-3 text-muted-foreground" />
              <span className="max-w-[180px] truncate">{a.filename}</span>
              <span className="text-muted-foreground">{fmtBytes(a.size)}</span>
              <button
                onClick={() => { setAttachments(attachments.filter((x) => x.id !== a.id)); markDirty(); }}
                className="hover:text-red-600"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 px-3 py-2 border-t">
        <Button size="sm" onClick={() => submit("send")} disabled={busy !== null}>
          {busy === "send" ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
          Send
        </Button>
        <div className="relative">
          <Button size="sm" variant="outline" onClick={() => setScheduleOpen(!scheduleOpen)} disabled={busy !== null}>
            <CalendarClock className="h-3.5 w-3.5 mr-1.5" /> Schedule
          </Button>
          {scheduleOpen && (
            <div className="absolute bottom-full mb-2 left-0 z-50 rounded-md border bg-background p-3 shadow-md w-64">
              <p className="text-xs font-medium mb-1.5">Send at</p>
              <input
                type="datetime-local"
                className="w-full rounded border px-2 py-1 text-sm"
                value={scheduleAt}
                min={new Date(Date.now() + 5 * 60000).toISOString().slice(0, 16)}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Sends within 5 minutes of this time (the scheduler ticks every 5).
              </p>
              <Button
                size="sm" className="mt-2 w-full"
                disabled={!scheduleAt || busy !== null}
                onClick={() => { setScheduleOpen(false); void submit("schedule", new Date(scheduleAt).toISOString()); }}
              >
                {busy === "schedule" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Schedule"}
              </Button>
            </div>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => submit("draft")} disabled={busy !== null}>
          Save draft
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel} title="Close (draft is kept)">
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Close
        </Button>
      </div>
    </div>
  );
}
