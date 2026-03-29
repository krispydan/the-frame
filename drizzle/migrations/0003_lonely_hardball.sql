CREATE TABLE `brand_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`website` text,
	`sector` text,
	`relevance` text DEFAULT 'needs_review' NOT NULL,
	`brand_type` text DEFAULT 'unknown' NOT NULL,
	`us_locations` integer DEFAULT 0,
	`total_locations` integer DEFAULT 0,
	`top_country` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_accounts_external_id_unique` ON `brand_accounts` (`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_brand_accounts_external_id` ON `brand_accounts` (`external_id`);--> statement-breakpoint
CREATE INDEX `idx_brand_accounts_relevance` ON `brand_accounts` (`relevance`);--> statement-breakpoint
CREATE INDEX `idx_brand_accounts_sector` ON `brand_accounts` (`sector`);--> statement-breakpoint
CREATE TABLE `company_brand_links` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`brand_account_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`brand_account_id`) REFERENCES `brand_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_cbl_company` ON `company_brand_links` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_cbl_brand` ON `company_brand_links` (`brand_account_id`);--> statement-breakpoint
ALTER TABLE `companies` ADD `disqualify_reason` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `segment` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `category` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `lead_source_detail` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `source_type` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `source_id` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `source_query` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `owner_name` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `business_hours` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `facebook_url` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `instagram_url` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `twitter_url` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `linkedin_url` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `yelp_url` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `enriched_at` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `enrichment_source` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `socials` text;--> statement-breakpoint
ALTER TABLE `companies` ADD `contact_form_url` text;--> statement-breakpoint
CREATE INDEX `idx_companies_source_type` ON `companies` (`source_type`);--> statement-breakpoint
CREATE INDEX `idx_companies_source_id` ON `companies` (`source_id`);