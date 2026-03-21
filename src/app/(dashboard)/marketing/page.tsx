"use client";

import { Suspense } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar, Share2, Search, DollarSign, Users, Sparkles } from "lucide-react";
import { ContentCalendarTab } from "@/modules/marketing/components/content-calendar-tab";
import { SocialMediaTab } from "@/modules/marketing/components/social-media-tab";
import { SeoTab } from "@/modules/marketing/components/seo-tab";
import { AdsTab } from "@/modules/marketing/components/ads-tab";
import { InfluencerTab } from "@/modules/marketing/components/influencer-tab";
import { KlaviyoTab } from "@/modules/marketing/components/klaviyo-tab";

export default function MarketingPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Marketing Hub</h1>
        <p className="text-muted-foreground">Content, social, SEO, ads & influencer management</p>
      </div>

      <Tabs defaultValue="calendar" className="space-y-4">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="calendar" className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            <span className="hidden sm:inline">Calendar</span>
          </TabsTrigger>
          <TabsTrigger value="social" className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            <span className="hidden sm:inline">Social</span>
          </TabsTrigger>
          <TabsTrigger value="seo" className="flex items-center gap-2">
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline">SEO</span>
          </TabsTrigger>
          <TabsTrigger value="ads" className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            <span className="hidden sm:inline">Ads</span>
          </TabsTrigger>
          <TabsTrigger value="influencers" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">Influencers</span>
          </TabsTrigger>
          <TabsTrigger value="email" className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Email</span>
          </TabsTrigger>
        </TabsList>

        <Suspense fallback={<div className="animate-pulse h-96 bg-muted rounded-lg" />}>
          <TabsContent value="calendar"><ContentCalendarTab /></TabsContent>
          <TabsContent value="social"><SocialMediaTab /></TabsContent>
          <TabsContent value="seo"><SeoTab /></TabsContent>
          <TabsContent value="ads"><AdsTab /></TabsContent>
          <TabsContent value="influencers"><InfluencerTab /></TabsContent>
          <TabsContent value="email"><KlaviyoTab /></TabsContent>
        </Suspense>
      </Tabs>
    </div>
  );
}
