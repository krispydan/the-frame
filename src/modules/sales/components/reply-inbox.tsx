"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Inbox,
  ThumbsUp,
  ThumbsDown,
  Clock,
  ExternalLink,
  ArrowLeft,
  Star,
  XCircle,
  RefreshCw,
  Mail,
  MailOpen,
} from "lucide-react";
import Link from "next/link";

interface Reply {
  id: string;
  campaign_id: string;
  campaign_name: string;
  company_id: string;
  company_name: string;
  contact_name: string;
  email: string | null;
  status: string;
  reply_text: string | null;
  reply_classification: string | null;
  replied_at: string | null;
  dismissed: number;
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  interested: "bg-green-100 text-green-800",
  not_interested: "bg-red-100 text-red-800",
  out_of_office: "bg-yellow-100 text-yellow-800",
  wrong_person: "bg-orange-100 text-orange-800",
  question: "bg-blue-100 text-blue-800",
  auto_reply: "bg-gray-100 text-gray-800",
  bounce: "bg-red-200 text-red-900",
  unsubscribe: "bg-orange-200 text-orange-900",
};

const CLASSIFICATION_LABELS: Record<string, string> = {
  interested: "Interested",
  not_interested: "Not Interested",
  out_of_office: "Out of Office",
  wrong_person: "Wrong Person",
  question: "Question",
  auto_reply: "Auto Reply",
  bounce: "Bounce",
  unsubscribe: "Unsubscribe",
};

export function ReplyInbox({ replies: initialReplies, unreadCount }: { replies: Reply[]; unreadCount: number }) {
  const [replies, setReplies] = useState(initialReplies);
  const [filter, setFilter] = useState("all");
  const [classifying, setClassifying] = useState<string | null>(null);

  const filtered = replies.filter((r) => {
    if (r.dismissed && filter !== "dismissed") return false;
    if (filter === "all") return !r.dismissed;
    if (filter === "unclassified") return !r.reply_classification;
    if (filter === "dismissed") return !!r.dismissed;
    return r.reply_classification === filter;
  });

  const counts = {
    all: replies.filter((r) => !r.dismissed).length,
    unclassified: replies.filter((r) => !r.reply_classification && !r.dismissed).length,
    interested: replies.filter((r) => r.reply_classification === "interested").length,
    not_interested: replies.filter((r) => r.reply_classification === "not_interested").length,
    question: replies.filter((r) => r.reply_classification === "question").length,
    out_of_office: replies.filter((r) => r.reply_classification === "out_of_office").length,
    bounce: replies.filter((r) => r.reply_classification === "bounce").length,
    unsubscribe: replies.filter((r) => r.reply_classification === "unsubscribe").length,
    dismissed: replies.filter((r) => r.dismissed).length,
  };

  const handleClassify = async (id: string, classification: string) => {
    setClassifying(id);
    await fetch(`/api/v1/sales/campaigns/leads/${id}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classification }),
    });
    setReplies((prev) =>
      prev.map((r) => (r.id === id ? { ...r, reply_classification: classification } : r))
    );
    setClassifying(null);
  };

  const handleReclassify = async (id: string) => {
    setClassifying(id);
    const res = await fetch(`/api/v1/sales/campaigns/leads/${id}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto: true }),
    });
    const data = await res.json();
    if (data.classification) {
      setReplies((prev) =>
        prev.map((r) => (r.id === id ? { ...r, reply_classification: data.classification } : r))
      );
    }
    setClassifying(null);
  };

  const handleDismiss = async (id: string) => {
    await fetch(`/api/v1/sales/campaigns/leads/${id}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismiss: true }),
    });
    setReplies((prev) =>
      prev.map((r) => (r.id === id ? { ...r, dismissed: 1 } : r))
    );
  };

  const handleMarkQualified = async (id: string, companyId: string) => {
    // Classify as interested + create/update deal
    await handleClassify(id, "interested");
    await fetch("/api/v1/sales/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, stage: "interested", source: "campaign_reply" }),
    });
  };

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/campaigns">
              <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight">Reply Inbox</h1>
                {unreadCount > 0 && (
                  <Badge variant="destructive" className="text-xs">{unreadCount}</Badge>
                )}
              </div>
              <p className="text-muted-foreground">{replies.length} replies from campaigns</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3 flex-wrap">
          <Select value={filter} onValueChange={(v) => v && setFilter(v)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ({counts.all})</SelectItem>
              <SelectItem value="unclassified">Unclassified ({counts.unclassified})</SelectItem>
              <SelectItem value="interested">Interested ({counts.interested})</SelectItem>
              <SelectItem value="not_interested">Not Interested ({counts.not_interested})</SelectItem>
              <SelectItem value="question">Questions ({counts.question})</SelectItem>
              <SelectItem value="out_of_office">Out of Office ({counts.out_of_office})</SelectItem>
              <SelectItem value="bounce">Bounce ({counts.bounce})</SelectItem>
              <SelectItem value="unsubscribe">Unsubscribe ({counts.unsubscribe})</SelectItem>
              <SelectItem value="dismissed">Dismissed ({counts.dismissed})</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          {filtered.map((r) => (
            <Card key={r.id} className={r.dismissed ? "opacity-50" : ""}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {r.status === "replied" ? (
                        <MailOpen className="h-4 w-4 text-green-600 shrink-0" />
                      ) : (
                        <Mail className="h-4 w-4 text-blue-600 shrink-0" />
                      )}
                      <span className="font-semibold">{r.contact_name}</span>
                      <span className="text-muted-foreground text-sm">at {r.company_name}</span>
                      {r.reply_classification && (
                        <Badge className={CLASSIFICATION_COLORS[r.reply_classification] || "bg-gray-100"} variant="secondary">
                          {CLASSIFICATION_LABELS[r.reply_classification] || r.reply_classification.replace("_", " ")}
                        </Badge>
                      )}
                      {!r.reply_classification && (
                        <Badge variant="outline" className="text-muted-foreground">Unclassified</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mb-2">
                      Campaign: <Link href={`/campaigns/${r.campaign_id}`} className="underline">{r.campaign_name}</Link>
                      {r.replied_at && ` • ${new Date(r.replied_at).toLocaleDateString()}`}
                    </div>
                    <p className="text-sm whitespace-pre-wrap bg-muted/50 rounded p-3">{r.reply_text}</p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="default"
                          className="bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => handleMarkQualified(r.id, r.company_id)}
                          disabled={classifying === r.id}
                        >
                          <Star className="mr-1 h-3 w-3" /> Qualify
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Mark as qualified lead and create deal</TooltipContent>
                    </Tooltip>
                    {r.email && (
                      <a href={`mailto:${r.email}`}>
                        <Button size="sm" variant="outline" className="w-full">
                          <ExternalLink className="mr-1 h-3 w-3" /> Reply
                        </Button>
                      </a>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDismiss(r.id)}
                      disabled={!!r.dismissed}
                    >
                      <XCircle className="mr-1 h-3 w-3" /> Dismiss
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleReclassify(r.id)}
                      disabled={classifying === r.id}
                    >
                      <RefreshCw className={`mr-1 h-3 w-3 ${classifying === r.id ? "animate-spin" : ""}`} /> Reclassify
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {filtered.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Inbox className="mx-auto mb-3 h-8 w-8" />
                <p>No replies to show</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
