import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { createRequest, parseResponse } from "../api-helpers";

// Route handler imports
import { GET as getContent, POST as postContent } from "@/app/api/v1/marketing/content/route";
import { GET as getContentDetail, PUT as putContent, DELETE as deleteContent } from "@/app/api/v1/marketing/content/[id]/route";
// Ad-campaign spend tracking moved to /ad-campaigns when the Ad Studio
// took over /api/v1/marketing/ads.
import { GET as getAds, POST as postAd } from "@/app/api/v1/marketing/ad-campaigns/route";
import { GET as getAdDetail, PUT as putAd, DELETE as deleteAd } from "@/app/api/v1/marketing/ad-campaigns/[id]/route";
import { GET as getInfluencers, POST as postInfluencer } from "@/app/api/v1/marketing/influencers/route";
import { GET as getInfluencerDetail, PUT as putInfluencer, DELETE as deleteInfluencer } from "@/app/api/v1/marketing/influencers/[id]/route";
import { GET as getSeo, POST as postSeo } from "@/app/api/v1/marketing/seo/route";
import { GET as getSocial, POST as postSocial, DELETE as deleteSocial } from "@/app/api/v1/marketing/social/route";

function routeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("Marketing API Routes", () => {
  beforeEach(() => resetTestDb());

  // ── Content Calendar ──
  describe("Content Calendar CRUD", () => {
    it("POST creates content item", async () => {
      const req = createRequest("POST", "/api/v1/marketing/content", {
        body: { title: "Summer Launch Post", type: "social", platform: "instagram", status: "planned" },
      });
      const res = await postContent(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(201);
      expect(data.data.title).toBe("Summer Launch Post");
    });

    it("GET lists content with filters", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_content_calendar (id, title, type, platform, status) VALUES ('cc1', 'Blog Post', 'blog', 'blog', 'draft')`).run();
      db.prepare(`INSERT INTO marketing_content_calendar (id, title, type, platform, status) VALUES ('cc2', 'IG Reel', 'social', 'instagram', 'published')`).run();

      const req = createRequest("GET", "/api/v1/marketing/content", { searchParams: { status: "draft" } });
      const res = await getContent(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].title).toBe("Blog Post");
    });

    it("PUT updates content item", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_content_calendar (id, title, type, platform, status) VALUES ('cc1', 'Draft', 'blog', 'blog', 'draft')`).run();

      const req = createRequest("PUT", "/api/v1/marketing/content/cc1", { body: { status: "published", title: "Final Post" } });
      const res = await putContent(req, routeParams("cc1"));
      const { data } = await parseResponse<any>(res);
      expect(data.data.status).toBe("published");
      expect(data.data.title).toBe("Final Post");
    });

    it("DELETE removes content item", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_content_calendar (id, title, type, platform, status) VALUES ('cc1', 'To Delete', 'blog', 'blog', 'idea')`).run();

      const req = createRequest("DELETE", "/api/v1/marketing/content/cc1");
      const res = await deleteContent(req, routeParams("cc1"));
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);
    });
  });

  // ── Ad Campaigns ──
  describe("Ad Campaigns CRUD", () => {
    it("POST creates ad campaign", async () => {
      const req = createRequest("POST", "/api/v1/marketing/ads", {
        body: { platform: "meta", campaignName: "Summer Sale", monthlyBudget: 5000, spend: 1200, revenue: 4800 },
      });
      const res = await postAd(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(201);
      expect(data.data.campaignName).toBe("Summer Sale");
    });

    it("GET returns campaigns with summary", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_ad_campaigns (id, platform, campaign_name, spend, revenue, monthly_budget) VALUES ('ad1', 'meta', 'Camp A', 1000, 3000, 2000)`).run();
      db.prepare(`INSERT INTO marketing_ad_campaigns (id, platform, campaign_name, spend, revenue, monthly_budget) VALUES ('ad2', 'google', 'Camp B', 500, 1500, 1000)`).run();

      const req = createRequest("GET", "/api/v1/marketing/ads");
      const res = await getAds(req);
      const { data } = await parseResponse<any>(res);
      expect(data.total).toBe(2);
      expect(data.summary.totalSpend).toBe(1500);
      expect(data.summary.totalRevenue).toBe(4500);
      expect(data.summary.roas).toBe(3);
    });

    it("DELETE removes campaign", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_ad_campaigns (id, platform, campaign_name) VALUES ('ad1', 'meta', 'To Delete')`).run();

      const req = createRequest("DELETE", "/api/v1/marketing/ads/ad1");
      const res = await deleteAd(req, routeParams("ad1"));
      const { data } = await parseResponse<any>(res);
      expect(data.success).toBe(true);
    });
  });

  // ── Influencers ──
  describe("Influencers CRUD", () => {
    it("POST creates influencer", async () => {
      const req = createRequest("POST", "/api/v1/marketing/influencers", {
        body: { name: "Style Guru", platform: "instagram", handle: "@styleguru", followers: 50000 },
      });
      const res = await postInfluencer(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(201);
      expect(data.data.name).toBe("Style Guru");
    });

    it("GET filters by platform", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_influencers (id, name, platform, handle) VALUES ('inf1', 'IG Star', 'instagram', '@igstar')`).run();
      db.prepare(`INSERT INTO marketing_influencers (id, name, platform, handle) VALUES ('inf2', 'TT Creator', 'tiktok', '@ttcreator')`).run();

      const req = createRequest("GET", "/api/v1/marketing/influencers", { searchParams: { platform: "tiktok" } });
      const res = await getInfluencers(req);
      const { data } = await parseResponse<any>(res);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].name).toBe("TT Creator");
    });

    it("PUT updates influencer status", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_influencers (id, name, platform, status) VALUES ('inf1', 'IG Star', 'instagram', 'identified')`).run();

      const req = createRequest("PUT", "/api/v1/marketing/influencers/inf1", { body: { status: "gifted" } });
      const res = await putInfluencer(req, routeParams("inf1"));
      const { data } = await parseResponse<any>(res);
      expect(data.data.status).toBe("gifted");
    });
  });

  // ── SEO Keywords ──
  describe("SEO Keywords", () => {
    it("POST creates keyword", async () => {
      const req = createRequest("POST", "/api/v1/marketing/seo", {
        body: { keyword: "aviator sunglasses", searchVolume: 12000, difficulty: 45, currentRank: 15 },
      });
      const res = await postSeo(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(200);
      expect(data.keyword).toBe("aviator sunglasses");
    });

    it("GET returns keywords with summary", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_seo_keywords (id, keyword, current_rank, previous_rank, search_volume) VALUES ('kw1', 'sunglasses', 5, 8, 50000)`).run();
      db.prepare(`INSERT INTO marketing_seo_keywords (id, keyword, current_rank, previous_rank, search_volume) VALUES ('kw2', 'eyewear', 12, 10, 30000)`).run();

      const req = createRequest("GET", "/api/v1/marketing/seo");
      const res = await getSeo(req as any);
      const { data } = await parseResponse<any>(res);
      expect(data.total).toBe(2);
      expect(data.summary.improving).toBe(1); // kw1: 5 < 8
      expect(data.summary.declining).toBe(1); // kw2: 12 > 10
      expect(data.summary.inTop10).toBe(1);
    });
  });

  // ── Social Posts ──
  describe("Social Posts", () => {
    it("POST creates social post", async () => {
      const req = createRequest("POST", "/api/v1/marketing/social", {
        body: { content: "Check out our new collection! 🕶️", platform: "instagram" },
      });
      const res = await postSocial(req);
      const { status, data } = await parseResponse<any>(res);
      expect(status).toBe(200);
      expect(data.id).toBeDefined();
    });

    it("POST with scheduledDate sets status to scheduled", async () => {
      const req = createRequest("POST", "/api/v1/marketing/social", {
        body: { content: "Scheduled post", platform: "tiktok", scheduledDate: "2026-04-01" },
      });
      const res = await postSocial(req);
      const { data } = await parseResponse<any>(res);
      // Verify in DB
      const db = getTestDb();
      const row = db.prepare(`SELECT * FROM marketing_social_posts WHERE id = ?`).get(data.id) as any;
      expect(row.status).toBe("scheduled");
    });

    it("GET returns posts and seeds accounts if empty", async () => {
      const req = createRequest("GET", "/api/v1/marketing/social");
      const res = await getSocial(req as any);
      const { data } = await parseResponse<any>(res);
      expect(data.posts).toBeDefined();
      expect(data.accounts.length).toBeGreaterThanOrEqual(3); // seeded defaults
    });

    it("DELETE removes social post", async () => {
      const db = getTestDb();
      db.prepare(`INSERT INTO marketing_social_posts (id, content, platform, status) VALUES ('sp1', 'To delete', 'instagram', 'draft')`).run();

      const req = createRequest("DELETE", "/api/v1/marketing/social", { body: { id: "sp1" } });
      const res = await deleteSocial(req);
      const { data } = await parseResponse<any>(res);
      expect(data.deleted).toBe(true);
    });
  });
});
