"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Inbox, ThumbsUp, ThumbsDown, Clock, ExternalLink, ArrowLeft } from "lucide-react";
import Link from "next/link";

interface Reply {
  id: string;
  campaign_id: string;
  campaign_name: string;
  company_id: string;
  company_name: string;
  contact_name: string;
  email: string | null;
  reply_text: string | null;
  reply_classification: string | null;
  replied_at: string | null;
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  interested: "bg-green-100 text-green-800",
  not_interested: "bg-red-100 text-red-800",
  out_of_office: "bg-yellow-100 text-yellow-800",
  wrong_person: "bg-orange-100 text-orange-800",
  question: "bg-blue-100 text-blue-800",
  auto_reply: "bg-gray-100 text-gray-800",
};

export function ReplyInbox({ replies: initialReplies }: { replies: Reply[] }) {
  const [replies, setReplies] = useState(initialReplies);
  const [filter, setFilter] = useState("all");

  const filtered = replies.filter((r) => {
    if (filter === "all") return true;
    if (filter === "unclassified") return !r.reply_classification;
    return r.reply_classification === filter;
  });

  const handleAction = async (id: string, classification: string) => {
    await fetch(`/api/v1/sales/campaigns/leads/${id}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classification }),
    });
    setReplies((prev) =>
      prev.map((r) => (r.id === id ? { ...r, reply_classification: classification } : r))
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/campaigns">
            <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Reply Inbox</h1>
            <p className="text-muted-foreground">{replies.length} replies from campaigns</p>
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <Select value={filter} onValueChange={(v) => v && setFilter(v)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All ({replies.length})</SelectItem>
            <SelectItem value="unclassified">Unclassified</SelectItem>
            <SelectItem value="interested">Interested</SelectItem>
            <SelectItem value="not_interested">Not Interested</SelectItem>
            <SelectItem value="question">Questions</SelectItem>
            <SelectItem value="out_of_office">Out of Office</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        {filtered.map((r) => (
          <Card key={r.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold">{r.contact_name}</span>
                    <span className="text-muted-foreground text-sm">at {r.company_name}</span>
                    {r.reply_classification && (
                      <Badge className={CLASSIFICATION_COLORS[r.reply_classification]} variant="secondary">
                        {r.reply_classification.replace("_", " ")}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    Campaign: <Link href={`/campaigns/${r.campaign_id}`} className="underline">{r.campaign_name}</Link>
                    {r.replied_at && ` • ${new Date(r.replied_at).toLocaleDateString()}`}
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{r.reply_text}</p>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <Button size="sm" variant="outline" className="text-green-700" onClick={() => handleAction(r.id, "interested")}>
                    <ThumbsUp className="mr-1 h-3 w-3" /> Interested
                  </Button>
                  <Button size="sm" variant="outline" className="text-red-700" onClick={() => handleAction(r.id, "not_interested")}>
                    <ThumbsDown className="mr-1 h-3 w-3" /> Not Interested
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleAction(r.id, "question")}>
                    <Clock className="mr-1 h-3 w-3" /> Snooze
                  </Button>
                  {r.email && (
                    <a href={`mailto:${r.email}`}>
                      <Button size="sm" variant="ghost">
                        <ExternalLink className="mr-1 h-3 w-3" /> Reply
                      </Button>
                    </a>
                  )}
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
  );
}
