CREATE TABLE IF NOT EXISTS `marketing_video_clip_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`is_hook` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_video_clip_categories_slug_unique` ON `marketing_video_clip_categories` (`slug`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketing_video_clips` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`checksum` text NOT NULL,
	`raw_path` text NOT NULL,
	`normalized_path` text,
	`muted_path` text,
	`poster_path` text,
	`duration_sec` real,
	`width` integer,
	`height` integer,
	`size_bytes` integer,
	`category_id` text,
	`audio_mode` text DEFAULT 'mute' NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`boost` integer DEFAULT 0 NOT NULL,
	`times_used` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`norm_version` integer DEFAULT 1 NOT NULL,
	`error` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_video_clips_checksum_unique` ON `marketing_video_clips` (`checksum`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_video_clip_status` ON `marketing_video_clips` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_video_clip_category` ON `marketing_video_clips` (`category_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketing_video_clip_products` (
	`id` text PRIMARY KEY NOT NULL,
	`clip_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_clip_product_unique` ON `marketing_video_clip_products` (`clip_id`,`sku_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_clip_product_sku` ON `marketing_video_clip_products` (`sku_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketing_video_recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`pattern_json` text NOT NULL,
	`audio_policy` text DEFAULT 'silent' NOT NULL,
	`duration_target_min` real DEFAULT 15 NOT NULL,
	`duration_target_max` real DEFAULT 30 NOT NULL,
	`weight` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `marketing_video_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`permutation_hash` text NOT NULL,
	`recipe_id` text,
	`clip_ids` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`file_path` text,
	`poster_path` text,
	`duration_sec` real,
	`size_bytes` integer,
	`audio_treatment` text DEFAULT 'silent' NOT NULL,
	`audible_clip_ids` text,
	`caption` text,
	`hashtags` text,
	`instructions` text,
	`ai_context` text,
	`platform` text DEFAULT 'both' NOT NULL,
	`scheduled_date` text,
	`scheduled_slot` text,
	`posted_at` text,
	`render_job_id` text,
	`error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `marketing_video_posts_permutation_hash_unique` ON `marketing_video_posts` (`permutation_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_video_post_status` ON `marketing_video_posts` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_video_post_sched` ON `marketing_video_posts` (`scheduled_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_video_post_slot` ON `marketing_video_posts` (`scheduled_date`,`scheduled_slot`);
--> statement-breakpoint
INSERT OR IGNORE INTO `marketing_video_clip_categories` (`id`, `slug`, `name`, `description`, `is_hook`, `sort_order`) VALUES
	(lower(hex(randomblob(16))), 'hook', 'Hook', 'Attention-grabbing opener — first 1-2 seconds decide the scroll.', 1, 0),
	(lower(hex(randomblob(16))), 'flat_lay', 'Flat Lay', 'Product arranged top-down on a surface.', 0, 10),
	(lower(hex(randomblob(16))), 'on_model', 'On Model', 'Product worn/used by a person.', 1, 20),
	(lower(hex(randomblob(16))), 'ugc_unboxing', 'UGC Unboxing', 'User-generated unboxing / first-impression footage (audio often worth keeping).', 1, 30),
	(lower(hex(randomblob(16))), 'broll', 'B-Roll', 'Atmosphere / filler footage that glues sequences together.', 0, 40),
	(lower(hex(randomblob(16))), 'detail', 'Detail', 'Close-up of stitching, texture, hardware.', 0, 50),
	(lower(hex(randomblob(16))), 'lifestyle', 'Lifestyle', 'Product in real life — outings, home, travel.', 1, 60),
	(lower(hex(randomblob(16))), 'in_car', 'In Car', 'Clips shot in the car (talking head or product in use).', 1, 70),
	(lower(hex(randomblob(16))), 'outro', 'Outro', 'Closer — logo, call-to-action, sign-off.', 0, 80);
--> statement-breakpoint
INSERT OR IGNORE INTO `marketing_video_recipes` (`id`, `name`, `description`, `pattern_json`, `audio_policy`, `duration_target_min`, `duration_target_max`, `weight`, `enabled`) VALUES
	('vr-flat-lay-compilation', 'Flat-lay compilation', 'A rhythm of 4-6 flat lays. Silent — pick a trending audio in TikTok.', '[{"categories":["flat_lay"],"min":4,"max":6}]', 'silent', 15, 30, 2, 1),
	('vr-ugc-unboxing', 'UGC unboxing', 'One unboxing clip (original audio) padded with b-roll/detail shots.', '[{"categories":["ugc_unboxing"],"min":1,"max":1},{"categories":["broll","detail"],"min":2,"max":3}]', 'original', 15, 30, 2, 1),
	('vr-product-showcase', 'Product showcase', 'Hook, then on-model/detail/lifestyle mix, optional outro. Silent for trending audio.', '[{"categories":["hook"],"min":1,"max":1},{"categories":["on_model","detail","lifestyle"],"min":2,"max":4},{"categories":["outro"],"min":0,"max":1,"optional":true}]', 'silent', 15, 30, 3, 1),
	('vr-lifestyle-mix', 'Lifestyle mix', 'Lifestyle / in-car / b-roll blend. Silent for trending audio.', '[{"categories":["lifestyle","in_car","broll"],"min":3,"max":5}]', 'silent', 15, 30, 2, 1);
