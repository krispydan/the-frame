-- Image generation: personas, prompt templates, variable presets, product<->persona M:N
-- Uses CREATE TABLE IF NOT EXISTS to be safe against prod drift (see src/lib/db.ts for
-- the try/catch ALTER TABLE pattern that handles catalog_images column additions idempotently).

CREATE TABLE IF NOT EXISTS `catalog_personas` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`age_range` text,
	`mood_keywords` text,
	`kind` text DEFAULT 'lifestyle' NOT NULL,
	`sort_order` integer DEFAULT 0,
	`active` integer DEFAULT true,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `catalog_personas_slug_unique` ON `catalog_personas` (`slug`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `catalog_prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`persona_slug` text NOT NULL,
	`image_type_slug` text,
	`kind` text DEFAULT 'lifestyle' NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`template_text` text NOT NULL,
	`required_vars` text,
	`order_index` integer DEFAULT 0,
	`active` integer DEFAULT true,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_prompt_tpl_persona_slug` ON `catalog_prompt_templates` (`persona_slug`,`slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_prompt_tpl_persona_kind` ON `catalog_prompt_templates` (`persona_slug`,`kind`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `catalog_variable_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'image_type' NOT NULL,
	`image_type_slug` text,
	`persona_slug` text,
	`var_name` text NOT NULL,
	`value` text NOT NULL,
	`weight` real DEFAULT 1,
	`last_used_at` text,
	`use_count` integer DEFAULT 0,
	`active` integer DEFAULT true,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_varpreset_scope` ON `catalog_variable_presets` (`image_type_slug`,`persona_slug`,`var_name`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `catalog_product_personas` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`persona_slug` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`product_id`) REFERENCES `catalog_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_product_persona` ON `catalog_product_personas` (`product_id`,`persona_slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_product_persona_product` ON `catalog_product_personas` (`product_id`);
