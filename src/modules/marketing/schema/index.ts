import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Content Calendar ──
export const contentCalendar = sqliteTable("marketing_content_calendar", {
  id: id(),
  title: text("title").notNull(),
  type: text("type", { enum: ["blog", "social", "email", "ad"] }).notNull(),
  platform: text("platform", { enum: ["instagram", "tiktok", "facebook", "twitter", "linkedin", "blog", "email"] }).notNull(),
  status: text("status", { enum: ["idea", "planned", "draft", "scheduled", "published"] }).notNull().default("idea"),
  scheduledDate: text("scheduled_date"),
  publishedDate: text("published_date"),
  content: text("content"),
  notes: text("notes"),
  tags: text("tags"), // JSON array
  createdAt: timestamp("created_at"),
}, (table) => ({
  statusIdx: index("idx_content_status").on(table.status),
  scheduledIdx: index("idx_content_scheduled").on(table.scheduledDate),
  platformIdx: index("idx_content_platform").on(table.platform),
}));

// ── Ad Campaigns ──
export const adCampaigns = sqliteTable("marketing_ad_campaigns", {
  id: id(),
  platform: text("platform", { enum: ["google", "meta", "tiktok"] }).notNull(),
  campaignName: text("campaign_name").notNull(),
  status: text("status", { enum: ["active", "paused", "completed"] }).notNull().default("active"),
  spend: real("spend").notNull().default(0),
  impressions: integer("impressions").notNull().default(0),
  clicks: integer("clicks").notNull().default(0),
  conversions: integer("conversions").notNull().default(0),
  revenue: real("revenue").notNull().default(0),
  startDate: text("start_date"),
  endDate: text("end_date"),
  monthlyBudget: real("monthly_budget"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
}, (table) => ({
  platformIdx: index("idx_ad_platform").on(table.platform),
}));

// ── Influencers ──
export const influencers = sqliteTable("marketing_influencers", {
  id: id(),
  name: text("name").notNull(),
  platform: text("platform", { enum: ["instagram", "tiktok", "youtube", "twitter"] }).notNull(),
  handle: text("handle"),
  followers: integer("followers"),
  niche: text("niche"),
  status: text("status", { enum: ["identified", "contacted", "gifted", "posting", "completed"] }).notNull().default("identified"),
  cost: real("cost"),
  postsDelivered: integer("posts_delivered").default(0),
  engagement: real("engagement"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
}, (table) => ({
  statusIdx: index("idx_influencer_status").on(table.status),
}));

// ── SEO Keywords ──
export const seoKeywords = sqliteTable("marketing_seo_keywords", {
  id: id(),
  keyword: text("keyword").notNull(),
  currentRank: integer("current_rank"),
  previousRank: integer("previous_rank"),
  url: text("url"),
  searchVolume: integer("search_volume"),
  difficulty: integer("difficulty"),
  updatedAt: timestamp("updated_at"),
  createdAt: timestamp("created_at"),
});

// ── Social Media Posts ──
export const socialPosts = sqliteTable("marketing_social_posts", {
  id: id(),
  content: text("content").notNull(),
  platform: text("platform", { enum: ["instagram", "tiktok", "pinterest", "facebook", "twitter"] }).notNull(),
  status: text("status", { enum: ["draft", "scheduled", "published"] }).notNull().default("draft"),
  scheduledDate: text("scheduled_date"),
  publishedDate: text("published_date"),
  likes: integer("likes").default(0),
  comments: integer("comments").default(0),
  shares: integer("shares").default(0),
  createdAt: timestamp("created_at"),
}, (table) => ({
  statusIdx: index("idx_social_post_status").on(table.status),
  platformIdx: index("idx_social_post_platform").on(table.platform),
}));

// ── Social Media Accounts ──
export const socialAccounts = sqliteTable("marketing_social_accounts", {
  id: id(),
  platform: text("platform", { enum: ["instagram", "tiktok", "pinterest", "facebook", "twitter"] }).notNull(),
  handle: text("handle"),
  followers: integer("followers").default(0),
  posts: integer("posts").default(0),
  engagementRate: real("engagement_rate").default(0),
  growth: real("growth").default(0),
  updatedAt: timestamp("updated_at"),
  createdAt: timestamp("created_at"),
});
