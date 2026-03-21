"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ACTIVITY_TYPES, type ActivityType } from "@/modules/sales/schema/pipeline";
import { formatDistanceToNow, format } from "date-fns";
import {
  StickyNote,
  Mail,
  Phone,
  Handshake,
  ArrowRightLeft,
  Clock,
  RefreshCw,
  Search,
  UserCheck,
  Send,
} from "lucide-react";

const ACTIVITY_ICONS: Record<string, React.ReactNode> = {
  note: <StickyNote className="h-4 w-4 text-gray-500" />,
  email: <Mail className="h-4 w-4 text-blue-500" />,
  call: <Phone className="h-4 w-4 text-green-500" />,
  meeting: <Handshake className="h-4 w-4 text-purple-500" />,
  stage_change: <ArrowRightLeft className="h-4 w-4 text-amber-500" />,
  snooze: <Clock className="h-4 w-4 text-orange-500" />,
  reorder: <RefreshCw className="h-4 w-4 text-teal-500" />,
  enrichment: <Search className="h-4 w-4 text-indigo-500" />,
  owner_change: <UserCheck className="h-4 w-4 text-pink-500" />,
};

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  note: "📝 Note",
  email: "✉️ Email",
  call: "📞 Call",
  meeting: "🤝 Meeting",
  stage_change: "🔄 Stage Change",
  snooze: "⏰ Snooze",
  reorder: "🔁 Reorder",
  enrichment: "🔍 Enrichment",
  owner_change: "👤 Owner Change",
};

interface Props {
  activities: Record<string, unknown>[];
  onAddActivity: (type: ActivityType, description: string) => void;
}

export function ActivityTimeline({ activities, onAddActivity }: Props) {
  const [type, setType] = useState<ActivityType>("note");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!description.trim()) return;
    setSubmitting(true);
    onAddActivity(type, description.trim());
    setDescription("");
    setSubmitting(false);
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Activity</h3>

      {/* Add activity */}
      <Card className="p-4 space-y-3">
        <div className="flex gap-2">
          <Select value={type} onValueChange={(v) => setType(v as ActivityType)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["note", "email", "call", "meeting"] as ActivityType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {ACTIVITY_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1">
            <Textarea
              placeholder="Add a note, log a call..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.metaKey) handleSubmit();
              }}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={handleSubmit} disabled={!description.trim() || submitting}>
            <Send className="h-3.5 w-3.5 mr-1.5" /> Add
          </Button>
        </div>
      </Card>

      {/* Timeline */}
      <div className="relative">
        <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />
        <div className="space-y-4">
          {activities.map((act) => (
            <div key={act.id as string} className="flex gap-3 relative">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-muted flex items-center justify-center z-10">
                {ACTIVITY_ICONS[act.type as string] || <StickyNote className="h-4 w-4" />}
              </div>
              <div className="flex-1 pt-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium capitalize">{(act.type as string).replace("_", " ")}</span>
                  <span className="text-xs text-muted-foreground">
                    {act.created_at
                      ? formatDistanceToNow(new Date(act.created_at as string), { addSuffix: true })
                      : ""}
                  </span>
                </div>
                {act.description ? (
                  <p className="text-sm mt-0.5">{String(act.description)}</p>
                ) : null}
              </div>
            </div>
          ))}
          {activities.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No activity yet</p>
          )}
        </div>
      </div>
    </div>
  );
}
