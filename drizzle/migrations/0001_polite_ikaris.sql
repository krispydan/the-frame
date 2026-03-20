CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text,
	`website` text,
	`domain` text,
	`phone` text,
	`email` text,
	`address` text,
	`city` text,
	`state` text,
	`zip` text,
	`country` text DEFAULT 'US',
	`google_place_id` text,
	`google_rating` real,
	`google_review_count` integer,
	`status` text DEFAULT 'new' NOT NULL,
	`source` text,
	`icp_tier` text,
	`icp_score` integer,
	`icp_reasoning` text,
	`owner_id` text,
	`tags` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_companies_icp_tier` ON `companies` (`icp_tier`);--> statement-breakpoint
CREATE INDEX `idx_companies_status` ON `companies` (`status`);--> statement-breakpoint
CREATE INDEX `idx_companies_state` ON `companies` (`state`);--> statement-breakpoint
CREATE INDEX `idx_companies_owner` ON `companies` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_companies_domain` ON `companies` (`domain`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text,
	`company_id` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`title` text,
	`email` text,
	`phone` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`owner_id` text,
	`last_contacted_at` text,
	`source` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_contacts_company` ON `contacts` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_contacts_store` ON `contacts` (`store_id`);--> statement-breakpoint
CREATE INDEX `idx_contacts_email` ON `contacts` (`email`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`address` text,
	`city` text,
	`state` text,
	`zip` text,
	`phone` text,
	`email` text,
	`manager_name` text,
	`google_place_id` text,
	`google_rating` real,
	`latitude` real,
	`longitude` real,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stores_company` ON `stores` (`company_id`);