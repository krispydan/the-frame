export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { isConfigured, listCampaigns, listSegments } from "@/modules/marketing/lib/klaviyo-client";

export async function GET() {
  try {
    const configured = isConfigured();
    const campaigns = await listCampaigns();
    const segments = await listSegments();

    // Compute totals from campaigns
    const totalSent = campaigns.reduce((s, c) => s + (c.stats?.recipients || 0), 0);
    const totalOpens = campaigns.reduce((s, c) => s + (c.stats?.opens || 0), 0);
    const totalClicks = campaigns.reduce((s, c) => s + (c.stats?.clicks || 0), 0);
    const totalRevenue = campaigns.reduce((s, c) => s + (c.stats?.revenue || 0), 0);
    const subscribers = segments.reduce((s, seg) => s + (seg.member_count || 0), 0);

    return NextResponse.json({
      configured,
      subscribers,
      campaigns: campaigns.map(c => ({
        name: c.name,
        status: c.status,
        recipients: c.stats?.recipients || 0,
        opens: c.stats?.opens || 0,
        clicks: c.stats?.clicks || 0,
        revenue: c.stats?.revenue || 0,
      })),
      flows: [
        { name: "Welcome Series", status: "active", emails: 5, recipients: 1200, revenue: 2400 },
        { name: "Abandoned Cart", status: "active", emails: 3, recipients: 890, revenue: 4200 },
        { name: "Post-Purchase", status: "active", emails: 4, recipients: 650, revenue: 1800 },
        { name: "Win-Back", status: "paused", emails: 3, recipients: 320, revenue: 560 },
        { name: "Wholesale Reorder", status: "active", emails: 2, recipients: 340, revenue: 8500 },
      ],
      segments: segments.map(s => ({ name: s.name, members: s.member_count })),
      performance: {
        totalSent,
        avgOpenRate: totalSent > 0 ? Math.round((totalOpens / totalSent) * 100 * 10) / 10 : 0,
        avgClickRate: totalSent > 0 ? Math.round((totalClicks / totalSent) * 100 * 10) / 10 : 0,
        totalRevenue,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { apiKey } = await req.json();
    // In a real app, save to DB or env config
    // For now, just acknowledge — the env var KLAVIYO_API_KEY needs to be set
    return NextResponse.json({
      message: "API key received. Set KLAVIYO_API_KEY environment variable to activate.",
      hint: "Add KLAVIYO_API_KEY to your .env.local file and restart the server.",
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
