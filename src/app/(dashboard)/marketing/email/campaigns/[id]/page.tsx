"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";

/**
 * Campaign detail page — Phase 1 build. Renders a basic JSON view +
 * audience pill + delete action. The 3-pane editor (variant picker,
 * form fields, live preview) lands in Phase 2.
 */
export default function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [campaign, setCampaign] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/v1/marketing/email/campaigns/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setCampaign(data.campaign);
        setLoading(false);
      });
  }, [id]);

  async function handleDelete() {
    if (!confirm("Delete this campaign?")) return;
    await fetch(`/api/v1/marketing/email/campaigns/${id}`, { method: "DELETE" });
    window.location.href = "/marketing/email";
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (error || !campaign) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Not found</h1>
        <Link href="/marketing/email">
          <Button variant="outline">Back to dashboard</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link href="/marketing/email">
              <Button variant="outline" size="sm">
                ← Back
              </Button>
            </Link>
            <Badge
              variant={
                (campaign.audience as string) === "wholesale"
                  ? "default"
                  : "outline"
              }
            >
              {campaign.audience as string}
            </Badge>
            <Badge variant="outline">{campaign.status as string}</Badge>
          </div>
          <h1 className="text-2xl font-semibold">
            {(campaign.subject as string | null) ??
              (campaign.heroHeadline as string | null) ??
              "(no subject yet)"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Scheduled {campaign.scheduledDate as string} · Week of{" "}
            {campaign.weekOf as string}
          </p>
        </div>
        <Button variant="ghost" onClick={handleDelete}>
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Raw data (Phase 1 — form editor + preview lands in Phase 2)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-[600px]">
            {JSON.stringify(campaign, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
