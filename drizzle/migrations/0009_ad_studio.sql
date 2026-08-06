CREATE TABLE IF NOT EXISTS `marketing_ad_copy` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`primary_text` text NOT NULL,
	`headline` text,
	`description` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_ad_copy_code_unique` ON `marketing_ad_copy` (`code`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketing_ads` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`recipe` text NOT NULL,
	`kind` text NOT NULL,
	`background_type` text NOT NULL,
	`background_ref` text NOT NULL,
	`sku_id` text NOT NULL,
	`card_image_id` text,
	`display_name_override` text,
	`headline` text,
	`talent` text DEFAULT 'none' NOT NULL,
	`copy_variant` text DEFAULT 'C00' NOT NULL,
	`layout_overrides` text,
	`ratios` text DEFAULT '["4x5","1x1","9x16"]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`error` text,
	`published_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_ads_name_unique` ON `marketing_ads` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ads_status` ON `marketing_ads` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ads_sku` ON `marketing_ads` (`sku_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ads_recipe` ON `marketing_ads` (`recipe`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketing_ad_renders` (
	`id` text PRIMARY KEY NOT NULL,
	`ad_id` text NOT NULL,
	`ratio` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text,
	`poster_key` text,
	`width` integer,
	`height` integer,
	`duration_sec` real,
	`size_bytes` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_ad_render_ratio` ON `marketing_ad_renders` (`ad_id`,`ratio`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ad_renders_status` ON `marketing_ad_renders` (`status`);
