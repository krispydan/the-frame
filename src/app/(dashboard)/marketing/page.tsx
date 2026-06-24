"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
  Calendar,
  Share2,
  Search,
  DollarSign,
  Users,
  Sparkles,
  ArrowRight,
} from "lucide-react";

/**
 * Marketing Hub — landing page.
 *
 * Was: tabbed view of placeholder modules (content-calendar /
 * social / seo / ads / influencers / klaviyo). Per Daniel
 * 2026-06-23: placeholder content can be deleted, Email Assistant
 * should be the front door.
 *
 * Each card links to its own page. Email Assistant lands at
 * /marketing/email (the real working feature). The rest still
 * point at their legacy tab routes — they'll be promoted to
 * dedicated pages as they get real.
 */

interface ModuleCard {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  status: "live" | "wip" | "planned";
}

const MODULES: ModuleCard[] = [
  {
    href: "/marketing/email",
    icon: Mail,
    title: "Email Assistant",
    description:
      "AI-driven weekly email pipeline — ideation, copy, designer briefs, preview, export. Replaces the agency stack.",
    status: "live",
  },
  {
    href: "/marketing/email/calendar",
    icon: Calendar,
    title: "Send schedule",
    description: "Month grid of when email campaigns send, by audience + status.",
    status: "wip",
  },
  {
    href: "/marketing/email/designer-queue",
    icon: Sparkles,
    title: "Designer Queue",
    description: "Hero + secondary image briefs awaiting Higgsfield renders + upload.",
    status: "wip",
  },
  {
    href: "#",
    icon: Share2,
    title: "Social",
    description: "Instagram + TikTok scheduling. Not built yet.",
    status: "planned",
  },
  {
    href: "#",
    icon: Search,
    title: "SEO",
    description: "Keyword tracking + content optimization. Not built yet.",
    status: "planned",
  },
  {
    href: "#",
    icon: DollarSign,
    title: "Ads",
    description: "Meta + Google ad campaign performance. Not built yet.",
    status: "planned",
  },
  {
    href: "#",
    icon: Users,
    title: "Influencers",
    description: "UGC partner tracking. Not built yet.",
    status: "planned",
  },
];

const STATUS_LABEL: Record<ModuleCard["status"], string> = {
  live: "Live",
  wip: "In progress",
  planned: "Planned",
};

const STATUS_VARIANT: Record<ModuleCard["status"], "default" | "outline" | "secondary"> = {
  live: "default",
  wip: "secondary",
  planned: "outline",
};

export default function MarketingPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Marketing</h1>
        <p className="text-muted-foreground mt-1">
          Email, content, social, ads — managed from one place.
        </p>
      </div>

      {/* Featured: Email Assistant */}
      <Card className="border-2 border-foreground/20">
        <CardContent className="p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex-1 min-w-[280px]">
              <div className="flex items-center gap-2 mb-2">
                <Mail className="h-5 w-5" />
                <h2 className="text-xl font-semibold">Email Assistant</h2>
                <Badge>Live</Badge>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Two retail emails (Mon + Thu) and two wholesale emails (Tue + Fri)
                every week. AI plans themes, drafts copy in Jaxy voice, briefs the
                designer in Higgsfield. You review, edit, export to Omnisend / Faire.
              </p>
              <div className="flex gap-2 flex-wrap">
                <Link href="/marketing/email">
                  <Button>
                    Open Email Assistant
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </Link>
                <Link href="/marketing/email/designer-queue">
                  <Button variant="outline">Designer queue</Button>
                </Link>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Other modules — links + status */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3">All modules</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {MODULES.filter((m) => m.title !== "Email Assistant").map((m) => {
            const Icon = m.icon;
            const isLive = m.status !== "planned";
            return isLive ? (
              <Link
                key={m.title}
                href={m.href}
                className="block rounded-lg border p-4 hover:bg-accent transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium text-sm">{m.title}</span>
                  </div>
                  <Badge variant={STATUS_VARIANT[m.status]} className="text-xs">
                    {STATUS_LABEL[m.status]}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{m.description}</p>
              </Link>
            ) : (
              <div
                key={m.title}
                className="rounded-lg border border-dashed p-4 opacity-60"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium text-sm">{m.title}</span>
                  </div>
                  <Badge variant="outline" className="text-xs">{STATUS_LABEL[m.status]}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{m.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
