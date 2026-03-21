import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "the-frame.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const now = new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ── Create Tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS marketing_content_calendar (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('blog','social','email','ad')),
    platform TEXT NOT NULL CHECK(platform IN ('instagram','tiktok','facebook','blog','email')),
    status TEXT NOT NULL DEFAULT 'idea' CHECK(status IN ('idea','planned','draft','scheduled','published')),
    scheduled_date TEXT,
    published_date TEXT,
    content TEXT,
    notes TEXT,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_content_status ON marketing_content_calendar(status);
  CREATE INDEX IF NOT EXISTS idx_content_scheduled ON marketing_content_calendar(scheduled_date);
  CREATE INDEX IF NOT EXISTS idx_content_platform ON marketing_content_calendar(platform);

  CREATE TABLE IF NOT EXISTS marketing_ad_campaigns (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK(platform IN ('google','meta','tiktok')),
    campaign_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
    spend REAL NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    conversions INTEGER NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    monthly_budget REAL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ad_platform ON marketing_ad_campaigns(platform);

  CREATE TABLE IF NOT EXISTS marketing_influencers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('instagram','tiktok','youtube','twitter')),
    handle TEXT,
    followers INTEGER,
    niche TEXT,
    status TEXT NOT NULL DEFAULT 'identified' CHECK(status IN ('identified','contacted','gifted','posting','completed')),
    cost REAL,
    posts_delivered INTEGER DEFAULT 0,
    engagement REAL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_influencer_status ON marketing_influencers(status);

  CREATE TABLE IF NOT EXISTS marketing_seo_keywords (
    id TEXT PRIMARY KEY,
    keyword TEXT NOT NULL,
    current_rank INTEGER,
    previous_rank INTEGER,
    url TEXT,
    search_volume INTEGER,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Seed Content Calendar ──
const insertContent = db.prepare(`
  INSERT OR IGNORE INTO marketing_content_calendar (id, title, type, platform, status, scheduled_date, content, tags, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const contentItems = [
  { title: "Spring Collection Launch Post", type: "social", platform: "instagram", status: "scheduled", date: "2026-04-01", content: "Introducing our Spring 2026 collection 🌸", tags: ["launch", "spring"] },
  { title: "Behind the Design: Retro Frames", type: "social", platform: "tiktok", status: "draft", date: "2026-04-03", content: "Watch how our retro frames come to life", tags: ["bts", "design"] },
  { title: "Why Acetate Matters for Your Eyes", type: "blog", platform: "blog", status: "planned", date: "2026-04-10", content: "", tags: ["education", "seo"] },
  { title: "Welcome Series Email #1", type: "email", platform: "email", status: "published", date: "2026-03-15", content: "Welcome to Jaxy!", tags: ["onboarding"] },
  { title: "Mother's Day Gift Guide", type: "social", platform: "facebook", status: "idea", date: "2026-05-01", content: "", tags: ["seasonal", "gifting"] },
  { title: "Summer Sunnies Are Here", type: "ad", platform: "instagram", status: "planned", date: "2026-06-01", content: "Shop summer styles", tags: ["summer", "paid"] },
  { title: "Top 10 Sunglasses for 2026", type: "blog", platform: "blog", status: "draft", date: "2026-04-20", content: "Curated list of must-have frames", tags: ["seo", "listicle"] },
  { title: "Influencer Unboxing Reel", type: "social", platform: "tiktok", status: "idea", date: null, content: "", tags: ["influencer", "ugc"] },
];

for (const item of contentItems) {
  insertContent.run(uuid(), item.title, item.type, item.platform, item.status, item.date, item.content, JSON.stringify(item.tags), now);
}

// ── Seed Ad Campaigns ──
const insertAd = db.prepare(`
  INSERT OR IGNORE INTO marketing_ad_campaigns (id, platform, campaign_name, status, spend, impressions, clicks, conversions, revenue, start_date, end_date, monthly_budget, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const adCampaigns = [
  { platform: "meta", name: "Spring Launch - Prospecting", status: "active", spend: 2450, impressions: 185000, clicks: 4200, conversions: 68, revenue: 8160, start: "2026-03-15", end: "2026-04-15", budget: 5000 },
  { platform: "meta", name: "Spring Launch - Retargeting", status: "active", spend: 820, impressions: 42000, clicks: 1890, conversions: 45, revenue: 5400, start: "2026-03-15", end: "2026-04-15", budget: 2000 },
  { platform: "google", name: "Brand Search", status: "active", spend: 380, impressions: 12000, clicks: 960, conversions: 32, revenue: 3840, start: "2026-03-01", end: null, budget: 1000 },
  { platform: "tiktok", name: "UGC Spring Push", status: "paused", spend: 1200, impressions: 320000, clicks: 5800, conversions: 24, revenue: 2880, start: "2026-03-10", end: "2026-03-25", budget: 3000 },
];

for (const ad of adCampaigns) {
  insertAd.run(uuid(), ad.platform, ad.name, ad.status, ad.spend, ad.impressions, ad.clicks, ad.conversions, ad.revenue, ad.start, ad.end, ad.budget, now);
}

// ── Seed Influencers ──
const insertInfluencer = db.prepare(`
  INSERT OR IGNORE INTO marketing_influencers (id, name, platform, handle, followers, niche, status, cost, posts_delivered, engagement, notes, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const influencerData = [
  { name: "Maya Chen", platform: "instagram", handle: "@mayastyleco", followers: 185000, niche: "fashion", status: "gifted", cost: 0, posts: 0, engagement: 3.2, notes: "Sent 3 frames, awaiting content" },
  { name: "Tyler Brooks", platform: "tiktok", handle: "@tylerbrooks", followers: 420000, niche: "lifestyle", status: "posting", cost: 500, posts: 2, engagement: 5.1, notes: "Posted 2 TikToks, great engagement" },
  { name: "Sarah Kim", platform: "instagram", handle: "@sarahkim.style", followers: 92000, niche: "eyewear", status: "contacted", cost: null, posts: 0, engagement: 4.8, notes: "DM'd, waiting for response" },
  { name: "Jake Martinez", platform: "youtube", handle: "@jakemreview", followers: 310000, niche: "accessories", status: "identified", cost: null, posts: 0, engagement: 2.9, notes: "Great for detailed product reviews" },
  { name: "Priya Patel", platform: "tiktok", handle: "@priya.frames", followers: 67000, niche: "fashion", status: "completed", cost: 250, posts: 3, engagement: 6.3, notes: "Completed 3 posts, strong conversion" },
];

for (const inf of influencerData) {
  insertInfluencer.run(uuid(), inf.name, inf.platform as any, inf.handle, inf.followers, inf.niche, inf.status, inf.cost, inf.posts, inf.engagement, inf.notes, now);
}

// ── Seed SEO Keywords ──
const insertKeyword = db.prepare(`
  INSERT OR IGNORE INTO marketing_seo_keywords (id, keyword, current_rank, previous_rank, url, search_volume, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const keywords = [
  { keyword: "affordable sunglasses", rank: 45, prev: 52, url: "/collections/sunglasses", volume: 14800 },
  { keyword: "acetate sunglasses", rank: 23, prev: 28, url: "/collections/acetate", volume: 3400 },
  { keyword: "retro sunglasses", rank: 38, prev: 41, url: "/collections/retro", volume: 8200 },
  { keyword: "jaxy sunglasses", rank: 1, prev: 1, url: "/", volume: 120 },
  { keyword: "best sunglasses under $50", rank: 67, prev: 89, url: "/blog/best-sunglasses-under-50", volume: 22000 },
  { keyword: "polarized sunglasses women", rank: 54, prev: 58, url: "/collections/women-polarized", volume: 12400 },
  { keyword: "oversized sunglasses 2026", rank: 31, prev: 44, url: "/collections/oversized", volume: 6800 },
  { keyword: "cat eye sunglasses", rank: 72, prev: 75, url: "/collections/cat-eye", volume: 18500 },
  { keyword: "wholesale sunglasses", rank: 19, prev: 22, url: "/wholesale", volume: 9600 },
  { keyword: "independent eyewear brands", rank: 15, prev: 18, url: "/about", volume: 2100 },
];

for (const kw of keywords) {
  insertKeyword.run(uuid(), kw.keyword, kw.rank, kw.prev, kw.url, kw.volume, now);
}

console.log("✅ Marketing module seeded successfully");
console.log(`  - ${contentItems.length} content calendar items`);
console.log(`  - ${adCampaigns.length} ad campaigns`);
console.log(`  - ${influencerData.length} influencers`);
console.log(`  - ${keywords.length} SEO keywords`);
