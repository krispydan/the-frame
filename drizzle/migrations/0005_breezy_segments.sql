CREATE TABLE IF NOT EXISTS `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`icp_profile` text,
	`email_templates` text,
	`outreach_notes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_segments_slug` ON `segments` (`slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_segments_status` ON `segments` (`status`);
--> statement-breakpoint
ALTER TABLE `companies` ADD `segment_id` text REFERENCES `segments`(`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_companies_segment_id` ON `companies` (`segment_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `segments` (`id`, `name`, `slug`, `status`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), trim(`segment`), lower(replace(trim(`segment`), ' ', '-')), 'active', datetime('now'), datetime('now')
FROM `companies`
WHERE `segment` IS NOT NULL AND trim(`segment`) != ''
GROUP BY lower(trim(`segment`));
--> statement-breakpoint
UPDATE `companies`
SET `segment_id` = (
	SELECT s.`id`
	FROM `segments` s
	WHERE lower(trim(s.`name`)) = lower(trim(`companies`.`segment`))
	LIMIT 1
)
WHERE `segment_id` IS NULL
  AND `segment` IS NOT NULL
  AND trim(`segment`) != '';
