CREATE TABLE IF NOT EXISTS `marketing_tiktok_sounds` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`cover_url` text,
	`tiktok_link` text,
	`duration_sec` real,
	`rank` integer,
	`rank_diff` integer,
	`trend_direction` text,
	`usage_count` integer,
	`country_code` text DEFAULT 'US' NOT NULL,
	`rank_type` text DEFAULT 'popular' NOT NULL,
	`is_promoted` integer DEFAULT 0 NOT NULL,
	`raw` text,
	`synced_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tiktok_sound_chart` ON `marketing_tiktok_sounds` (`country_code`,`rank_type`,`rank`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tiktok_sound_external` ON `marketing_tiktok_sounds` (`external_id`);
--> statement-breakpoint
ALTER TABLE `marketing_video_clips` ADD `talent` text;
