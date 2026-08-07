"use client";

/**
 * Email on a company record: threads, drafts/scheduled, and the composer.
 *
 * The thread list is the default view — correspondence is what a rep opens
 * this for. Drafts & scheduled live behind a small tab so an in-progress
 * email is never lost but also never in the way.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Mail, PenLine, Reply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { EmailComposer, type ComposerSeed } from "./email-composer";

interface ThreadRow {
  id: string; subject: string | null; last_message_at: string | null;
  message_count: number; last_snippet: string | null; last_direction: string | null; last_from: string | null;
}
interface Message {
  id: string; direction: string; from_email: string | null; from_name: string | null;
  to_json: string; subject: string | null; body_html: string | null; body_text: string | null;
  has_attachments: number; attachments_json: string | null; sent_at: string | null;
}
interface OutboxRow {
  id: string; to_json: string; subject: string | null; status: string;
  scheduled_for: string | null; error: string | null; preview: string; updated_at: string;
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  const t = new Date(d);
  const days = (Date.now() - t.getTime()) / 86400000;
  if (days < 1) return t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days < 180) return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function MessageView({ m }: { m: Message }) {
  const [open, setOpen] = useState(false);
  const to = (JSON.parse(m.to_json || "[]") as string[]).join(", ");
  return (
    <div className="border rounded-md">
      <button className="w-full flex items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <Badge variant={m.direction === "outbound" ? "default" : "secondary"} className="shrink-0 text-[10px]">
          {m.direction === "outbound" ? "Sent" : "Received"}
        </Badge>
        <span className="text-sm truncate flex-1">{m.from_name || m.from_email}</span>
        {m.has_attachments ? <span className="text-xs text-muted-foreground">📎</span> : null}
        <span className="text-xs text-muted-foreground shrink-0">{fmtDate(m.sent_at)}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 border-t pt-2">
          <p className="text-xs text-muted-foreground mb-2">To: {to}</p>
          {m.body_html ? (
            // Synced mail is rendered sandboxed-ish: no scripts survive React,
            // and remote images are the sender's problem, not a tracker we add.
            <div className="text-sm prose prose-sm max-w-none [&_a]:text-blue-600" dangerouslySetInnerHTML={{ __html: m.body_html }} />
          ) : (
            <pre className="text-sm whitespace-pre-wrap font-sans">{m.body_text}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function EmailPanel({ companyId, defaultTo }: { companyId: string; defaultTo?: string | null }) {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [outbox, setOutbox] = useState<OutboxRow[]>([]);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [tab, setTab] = useState<"threads" | "outbox">("threads");
  const [composing, setComposing] = useState<ComposerSeed | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, o, c] = await Promise.all([
        fetch(`/api/v1/email/threads?companyId=${encodeURIComponent(companyId)}`).then((r) => r.json()),
        fetch(`/api/v1/email/outbox?companyId=${encodeURIComponent(companyId)}`).then((r) => r.json()),
        fetch("/api/v1/email/connections").then((r) => r.json()),
      ]);
      setThreads(t.threads ?? []);
      setOutbox((o.rows ?? []).filter((r: OutboxRow) => r.status !== "sent" && r.status !== "cancelled"));
      setConnected(!!c.connection && c.connection.status === "connected");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const openThreadView = async (id: string) => {
    if (openThread === id) { setOpenThread(null); return; }
    setOpenThread(id);
    setLoadingThread(true);
    try {
      const j = await fetch(`/api/v1/email/threads?threadId=${id}`).then((r) => r.json());
      setMessages(j.messages ?? []);
    } finally {
      setLoadingThread(false);
    }
  };

  const reply = (thread: ThreadRow) => {
    const last = messages[messages.length - 1];
    const replyTo = last?.direction === "inbound" ? last.from_email : null;
    setComposing({
      to: replyTo ? [replyTo] : defaultTo ? [defaultTo] : [],
      subject: thread.subject?.startsWith("Re:") ? thread.subject : `Re: ${thread.subject ?? ""}`,
      replyToMessageId: last?.id ?? null,
    });
  };

  const cancelOutbox = async (id: string) => {
    const res = await fetch(`/api/v1/email/outbox?id=${id}`, { method: "DELETE" });
    if (res.ok) { toast.success("Cancelled"); void load(); }
    else toast.error("Could not cancel — it may have already sent");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" /> Email
          </CardTitle>
          <CardDescription>
            {connected === false
              ? "Connect your Gmail in Settings → Integrations → Gmail to send from here"
              : "Correspondence with this store, synced from Gmail"}
          </CardDescription>
        </div>
        <Button
          size="sm"
          onClick={() => setComposing({ to: defaultTo ? [defaultTo] : [] })}
          disabled={connected === false}
        >
          <PenLine className="h-3.5 w-3.5 mr-1.5" /> Compose
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {composing && (
          <EmailComposer
            companyId={companyId}
            seed={composing}
            onDone={() => { setComposing(null); void load(); }}
            onCancel={() => { setComposing(null); void load(); }}
          />
        )}

        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {outbox.length > 0 && (
              <div className="flex gap-1 text-xs">
                <button
                  className={`px-2 py-1 rounded ${tab === "threads" ? "bg-muted font-medium" : "text-muted-foreground"}`}
                  onClick={() => setTab("threads")}
                >
                  Threads ({threads.length})
                </button>
                <button
                  className={`px-2 py-1 rounded ${tab === "outbox" ? "bg-muted font-medium" : "text-muted-foreground"}`}
                  onClick={() => setTab("outbox")}
                >
                  Drafts & scheduled ({outbox.length})
                </button>
              </div>
            )}

            {tab === "outbox" ? (
              <div className="space-y-1.5">
                {outbox.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 border rounded-md px-3 py-2">
                    <Badge variant={r.status === "failed" ? "destructive" : "secondary"} className="text-[10px] shrink-0">
                      {r.status === "scheduled" && r.scheduled_for
                        ? `Scheduled · ${fmtDate(r.scheduled_for)}`
                        : r.status}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{r.subject || "(no subject)"}</p>
                      {r.error ? <p className="text-xs text-red-600 truncate">{r.error}</p>
                        : <p className="text-xs text-muted-foreground truncate">{r.preview}</p>}
                    </div>
                    {(r.status === "draft" || r.status === "scheduled" || r.status === "failed") && (
                      <Button size="sm" variant="ghost" className="text-xs" onClick={() => cancelOutbox(r.id)}>
                        {r.status === "failed" ? "Dismiss" : "Cancel"}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : threads.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No email threads linked to this store yet.
              </p>
            ) : (
              <div className="space-y-1.5">
                {threads.map((t) => (
                  <div key={t.id}>
                    <button className="w-full flex items-center gap-2 border rounded-md px-3 py-2 text-left hover:bg-muted/40" onClick={() => openThreadView(t.id)}>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{t.subject || "(no subject)"}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {t.last_direction === "outbound" ? "You: " : ""}{t.last_snippet}
                        </p>
                      </div>
                      <Badge variant="secondary" className="text-[10px] shrink-0">{t.message_count}</Badge>
                      <span className="text-xs text-muted-foreground shrink-0">{fmtDate(t.last_message_at)}</span>
                    </button>
                    {openThread === t.id && (
                      <div className="ml-3 mt-1.5 space-y-1.5">
                        {loadingThread ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : (
                          <>
                            {messages.map((m) => <MessageView key={m.id} m={m} />)}
                            <Button size="sm" variant="outline" onClick={() => reply(t)} disabled={connected === false}>
                              <Reply className="h-3.5 w-3.5 mr-1.5" /> Reply
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
