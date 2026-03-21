"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const platforms = [
  {
    name: "Instagram",
    icon: "📸",
    followers: "12.4K",
    posts: 234,
    engagementRate: "3.8%",
    growth: "+2.1%",
    recentPosts: [
      { title: "Spring Collection Preview", likes: 842, comments: 56, date: "2026-03-18" },
      { title: "Behind the Scenes: Factory Tour", likes: 1203, comments: 89, date: "2026-03-15" },
      { title: "Customer Spotlight: @fashionista", likes: 567, comments: 34, date: "2026-03-12" },
    ],
  },
  {
    name: "TikTok",
    icon: "🎵",
    followers: "8.2K",
    posts: 89,
    engagementRate: "5.4%",
    growth: "+4.7%",
    recentPosts: [
      { title: "How Our Frames Are Made", likes: 4521, comments: 234, date: "2026-03-17" },
      { title: "Try-On Haul: Spring 2026", likes: 2890, comments: 178, date: "2026-03-14" },
      { title: "POV: Finding Your Perfect Frame", likes: 6734, comments: 412, date: "2026-03-10" },
    ],
  },
  {
    name: "Facebook",
    icon: "👍",
    followers: "5.8K",
    posts: 156,
    engagementRate: "1.2%",
    growth: "+0.3%",
    recentPosts: [
      { title: "New Arrivals Alert!", likes: 234, comments: 12, date: "2026-03-16" },
      { title: "Weekend Sale: 20% Off", likes: 445, comments: 28, date: "2026-03-13" },
    ],
  },
];

export function SocialMediaTab() {
  return (
    <div className="space-y-6">
      {/* Platform Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {platforms.map((p) => (
          <Card key={p.name}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-lg">
                <span className="text-2xl">{p.icon}</span>
                {p.name}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-2xl font-bold">{p.followers}</div>
                  <div className="text-xs text-muted-foreground">Followers</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{p.posts}</div>
                  <div className="text-xs text-muted-foreground">Posts</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{p.engagementRate}</div>
                  <div className="text-xs text-muted-foreground">Engagement</div>
                </div>
                <div>
                  <Badge variant="outline" className="bg-green-50 text-green-700">{p.growth}</Badge>
                  <div className="text-xs text-muted-foreground mt-1">Growth</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Posts */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Posts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {platforms.flatMap(p =>
              p.recentPosts.map((post, i) => (
                <div key={`${p.name}-${i}`} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{p.icon}</span>
                    <div>
                      <div className="font-medium text-sm">{post.title}</div>
                      <div className="text-xs text-muted-foreground">{p.name} · {post.date}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span>❤️ {post.likes.toLocaleString()}</span>
                    <span>💬 {post.comments}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Engagement Over Time Placeholder */}
      <Card>
        <CardHeader>
          <CardTitle>Engagement Over Time</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-48 text-muted-foreground">
          📊 Chart coming soon — connect social APIs to see real-time engagement trends
        </CardContent>
      </Card>
    </div>
  );
}
