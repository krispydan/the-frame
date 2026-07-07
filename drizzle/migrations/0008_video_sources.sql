CREATE TABLE IF NOT EXISTS `marketing_video_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`checksum` text NOT NULL,
	`raw_path` text NOT NULL,
	`duration_sec` real,
	`width` integer,
	`height` integer,
	`size_bytes` integer,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`clip_count` integer DEFAULT 0 NOT NULL,
	`min_clip_sec` real DEFAULT 3 NOT NULL,
	`max_clip_sec` real DEFAULT 5 NOT NULL,
	`max_clips` integer DEFAULT 40 NOT NULL,
	`category_id` text,
	`talent` text,
	`audio_mode` text DEFAULT 'mute' NOT NULL,
	`sku_ids` text,
	`error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_video_sources_checksum_unique` ON `marketing_video_sources` (`checksum`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_video_source_status` ON `marketing_video_sources` (`status`);
--> statement-breakpoint
ALTER TABLE `marketing_video_clips` ADD `source_id` text;
