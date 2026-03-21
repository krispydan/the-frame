CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`severity` text NOT NULL,
	`module` text NOT NULL,
	`entity_id` text,
	`entity_type` text,
	`read` integer DEFAULT 0 NOT NULL,
	`dismissed` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `marketing_social_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`handle` text,
	`followers` integer DEFAULT 0,
	`posts` integer DEFAULT 0,
	`engagement_rate` real DEFAULT 0,
	`growth` real DEFAULT 0,
	`updated_at` text DEFAULT (datetime('now')),
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `marketing_social_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`platform` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_date` text,
	`published_date` text,
	`likes` integer DEFAULT 0,
	`comments` integer DEFAULT 0,
	`shares` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_social_post_status` ON `marketing_social_posts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_social_post_platform` ON `marketing_social_posts` (`platform`);--> statement-breakpoint
ALTER TABLE `marketing_seo_keywords` ADD `difficulty` integer;