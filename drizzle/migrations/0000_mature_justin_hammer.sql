CREATE TABLE `activity_feed` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`module` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`data` text,
	`user_id` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`module` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` text,
	`output` text,
	`tokens_used` integer,
	`cost` integer,
	`duration_ms` integer,
	`error` text,
	`created_at` text DEFAULT (datetime('now')),
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`user_id` text,
	`permissions` text,
	`last_used_at` text,
	`expires_at` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `change_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text DEFAULT (datetime('now')),
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`user_id` text,
	`source` text NOT NULL,
	`agent_type` text,
	`request_id` text
);
--> statement-breakpoint
CREATE TABLE `error_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text DEFAULT (datetime('now')),
	`level` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`stack_trace` text,
	`request_method` text,
	`request_path` text,
	`request_body` text,
	`user_id` text,
	`ip_address` text,
	`metadata` text,
	`resolved` integer DEFAULT false NOT NULL,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`module` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` text,
	`output` text,
	`priority` integer DEFAULT 2 NOT NULL,
	`scheduled_for` text,
	`recurring` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`error` text,
	`created_at` text DEFAULT (datetime('now')),
	`started_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `reporting_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text DEFAULT (datetime('now')),
	`event_type` text NOT NULL,
	`module` text NOT NULL,
	`user_id` text,
	`metadata` text,
	`duration_ms` integer,
	`tokens_used` integer,
	`cost_cents` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`type` text DEFAULT 'string' NOT NULL,
	`module` text,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'support' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `campaign_leads` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`company_id` text NOT NULL,
	`contact_id` text,
	`instantly_lead_id` text,
	`email` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`reply_text` text,
	`reply_classification` text,
	`sent_at` text,
	`opened_at` text,
	`replied_at` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_cl_campaign` ON `campaign_leads` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `idx_cl_company` ON `campaign_leads` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_cl_status` ON `campaign_leads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_cl_instantly` ON `campaign_leads` (`instantly_lead_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'email_sequence' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`description` text,
	`instantly_campaign_id` text,
	`target_segment` text,
	`target_smart_list_id` text,
	`variant_a_subject` text,
	`variant_b_subject` text,
	`sent` integer DEFAULT 0,
	`delivered` integer DEFAULT 0,
	`opened` integer DEFAULT 0,
	`replied` integer DEFAULT 0,
	`bounced` integer DEFAULT 0,
	`meetings_booked` integer DEFAULT 0,
	`orders_placed` integer DEFAULT 0,
	`variant_a_sent` integer DEFAULT 0,
	`variant_a_opened` integer DEFAULT 0,
	`variant_a_replied` integer DEFAULT 0,
	`variant_b_sent` integer DEFAULT 0,
	`variant_b_opened` integer DEFAULT 0,
	`variant_b_replied` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_campaigns_status` ON `campaigns` (`status`);--> statement-breakpoint
CREATE INDEX `idx_campaigns_type` ON `campaigns` (`type`);--> statement-breakpoint
CREATE INDEX `idx_campaigns_instantly` ON `campaigns` (`instantly_campaign_id`);--> statement-breakpoint
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
CREATE TABLE `deal_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` text NOT NULL,
	`company_id` text,
	`type` text NOT NULL,
	`description` text,
	`metadata` text,
	`user_id` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_activities_deal` ON `deal_activities` (`deal_id`);--> statement-breakpoint
CREATE INDEX `idx_activities_company` ON `deal_activities` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_activities_created` ON `deal_activities` (`created_at`);--> statement-breakpoint
CREATE TABLE `deals` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`store_id` text,
	`contact_id` text,
	`title` text NOT NULL,
	`value` real,
	`stage` text DEFAULT 'outreach' NOT NULL,
	`previous_stage` text,
	`channel` text,
	`owner_id` text,
	`snooze_until` text,
	`snooze_reason` text,
	`last_activity_at` text DEFAULT (datetime('now')),
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	`closed_at` text,
	`reorder_due_at` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_deals_stage` ON `deals` (`stage`);--> statement-breakpoint
CREATE INDEX `idx_deals_owner` ON `deals` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_deals_company` ON `deals` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_deals_snooze` ON `deals` (`snooze_until`);--> statement-breakpoint
CREATE INDEX `idx_deals_reorder` ON `deals` (`reorder_due_at`);--> statement-breakpoint
CREATE TABLE `instantly_sync` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`instantly_id` text NOT NULL,
	`last_synced_at` text DEFAULT (datetime('now')),
	`sync_status` text DEFAULT 'pending' NOT NULL,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX `idx_sync_entity` ON `instantly_sync` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_instantly` ON `instantly_sync` (`instantly_id`);--> statement-breakpoint
CREATE TABLE `smart_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`filters` text NOT NULL,
	`owner_id` text,
	`is_shared` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`result_count` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE INDEX `idx_stores_company` ON `stores` (`company_id`);--> statement-breakpoint
CREATE TABLE `catalog_copy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`field_name` text,
	`content` text,
	`ai_model` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`product_id`) REFERENCES `catalog_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `catalog_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text,
	`file_path` text,
	`product_count` integer,
	`created_at` text DEFAULT (datetime('now')),
	`created_by` text DEFAULT 'admin'
);
--> statement-breakpoint
CREATE TABLE `catalog_image_types` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text,
	`label` text,
	`aspect_ratio` text,
	`min_width` integer,
	`min_height` integer,
	`platform` text DEFAULT 'all',
	`description` text,
	`active` integer DEFAULT true,
	`sort_order` integer DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_image_types_slug_unique` ON `catalog_image_types` (`slug`);--> statement-breakpoint
CREATE TABLE `catalog_images` (
	`id` text PRIMARY KEY NOT NULL,
	`sku_id` text NOT NULL,
	`file_path` text,
	`image_type_id` text,
	`position` integer DEFAULT 0,
	`alt_text` text,
	`width` integer,
	`height` integer,
	`ai_model_used` text,
	`ai_prompt` text,
	`status` text DEFAULT 'draft',
	`is_best` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`sku_id`) REFERENCES `catalog_skus`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_type_id`) REFERENCES `catalog_image_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `catalog_name_options` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`name` text,
	`selected` integer DEFAULT false,
	`ai_generated` integer DEFAULT false,
	FOREIGN KEY (`product_id`) REFERENCES `catalog_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `catalog_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`author` text DEFAULT 'admin',
	`text` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE `catalog_products` (
	`id` text PRIMARY KEY NOT NULL,
	`sku_prefix` text,
	`name` text,
	`description` text,
	`short_description` text,
	`bullet_points` text,
	`category` text,
	`frame_shape` text,
	`frame_material` text,
	`gender` text,
	`lens_type` text,
	`wholesale_price` real,
	`retail_price` real,
	`msrp` real,
	`purchase_order_id` text,
	`factory_name` text,
	`factory_sku` text,
	`seo_title` text,
	`meta_description` text,
	`status` text DEFAULT 'intake',
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`purchase_order_id`) REFERENCES `catalog_purchase_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_products_sku_prefix_unique` ON `catalog_products` (`sku_prefix`);--> statement-breakpoint
CREATE TABLE `catalog_purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`po_number` text,
	`supplier` text,
	`order_date` text,
	`notes` text,
	`status` text DEFAULT 'ordered',
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_purchase_orders_po_number_unique` ON `catalog_purchase_orders` (`po_number`);--> statement-breakpoint
CREATE TABLE `catalog_skus` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`sku` text,
	`color_name` text,
	`color_hex` text,
	`size` text,
	`upc` text,
	`weight_oz` real,
	`cost_price` real,
	`wholesale_price` real,
	`retail_price` real,
	`in_stock` integer DEFAULT true,
	`raw_image_filename` text,
	`seo_title` text,
	`meta_description` text,
	`twelve_pack_sku` text,
	`twelve_pack_upc` text,
	`status` text DEFAULT 'intake',
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`product_id`) REFERENCES `catalog_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_skus_sku_unique` ON `catalog_skus` (`sku`);--> statement-breakpoint
CREATE TABLE `catalog_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`tag_name` text,
	`dimension` text,
	`source` text,
	FOREIGN KEY (`product_id`) REFERENCES `catalog_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text,
	`sku_id` text,
	`sku` text,
	`product_name` text NOT NULL,
	`color_name` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_price` real DEFAULT 0 NOT NULL,
	`total_price` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `catalog_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `catalog_skus`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_order_items_order_id` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_number` text NOT NULL,
	`company_id` text,
	`store_id` text,
	`contact_id` text,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`subtotal` real DEFAULT 0 NOT NULL,
	`discount` real DEFAULT 0 NOT NULL,
	`shipping` real DEFAULT 0 NOT NULL,
	`tax` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`notes` text,
	`external_id` text,
	`tracking_number` text,
	`tracking_carrier` text,
	`placed_at` text,
	`shipped_at` text,
	`delivered_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_orders_channel` ON `orders` (`channel`);--> statement-breakpoint
CREATE INDEX `idx_orders_status` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `idx_orders_company_id` ON `orders` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_orders_external_id` ON `orders` (`external_id`);--> statement-breakpoint
CREATE INDEX `idx_orders_order_number` ON `orders` (`order_number`);--> statement-breakpoint
CREATE INDEX `idx_orders_placed_at` ON `orders` (`placed_at`);--> statement-breakpoint
CREATE TABLE `returns` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`reason` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`items` text,
	`refund_amount` real,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_returns_order_id` ON `returns` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_returns_status` ON `returns` (`status`);--> statement-breakpoint
CREATE TABLE `inventory_factories` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`contact_name` text,
	`contact_email` text,
	`contact_phone` text,
	`production_lead_days` integer DEFAULT 30 NOT NULL,
	`transit_lead_days` integer DEFAULT 25 NOT NULL,
	`moq` integer DEFAULT 300,
	`notes` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_factories_code_unique` ON `inventory_factories` (`code`);--> statement-breakpoint
CREATE TABLE `inventory` (
	`id` text PRIMARY KEY NOT NULL,
	`sku_id` text NOT NULL,
	`location` text DEFAULT 'warehouse' NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`reserved_quantity` integer DEFAULT 0 NOT NULL,
	`reorder_point` integer DEFAULT 50 NOT NULL,
	`sell_through_weekly` real DEFAULT 0,
	`days_of_stock` real DEFAULT 0,
	`reorder_date` text,
	`needs_reorder` integer DEFAULT false,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_inventory_sku_id` ON `inventory` (`sku_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_location` ON `inventory` (`location`);--> statement-breakpoint
CREATE INDEX `idx_inventory_needs_reorder` ON `inventory` (`needs_reorder`);--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`sku_id` text NOT NULL,
	`from_location` text,
	`to_location` text,
	`quantity` integer NOT NULL,
	`reason` text NOT NULL,
	`reference_id` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_movements_sku_id` ON `inventory_movements` (`sku_id`);--> statement-breakpoint
CREATE INDEX `idx_movements_created_at` ON `inventory_movements` (`created_at`);--> statement-breakpoint
CREATE TABLE `inventory_po_line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`po_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_cost` real DEFAULT 0 NOT NULL,
	`total_cost` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`po_id`) REFERENCES `inventory_purchase_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_po_line_items_po_id` ON `inventory_po_line_items` (`po_id`);--> statement-breakpoint
CREATE TABLE `inventory_purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`po_number` text NOT NULL,
	`factory_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`total_units` integer DEFAULT 0 NOT NULL,
	`total_cost` real DEFAULT 0 NOT NULL,
	`order_date` text,
	`expected_ship_date` text,
	`expected_arrival_date` text,
	`actual_arrival_date` text,
	`tracking_number` text,
	`tracking_carrier` text,
	`shipping_cost` real DEFAULT 0,
	`duties_cost` real DEFAULT 0,
	`freight_cost` real DEFAULT 0,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`factory_id`) REFERENCES `inventory_factories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_purchase_orders_po_number_unique` ON `inventory_purchase_orders` (`po_number`);--> statement-breakpoint
CREATE TABLE `inventory_qc_inspections` (
	`id` text PRIMARY KEY NOT NULL,
	`po_id` text NOT NULL,
	`inspector` text,
	`inspection_date` text,
	`total_units` integer DEFAULT 0 NOT NULL,
	`defect_count` integer DEFAULT 0 NOT NULL,
	`defect_rate` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`po_id`) REFERENCES `inventory_purchase_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `account_health_history` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_account_id` text NOT NULL,
	`score` integer NOT NULL,
	`status` text NOT NULL,
	`factors` text,
	`calculated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`customer_account_id`) REFERENCES `customer_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_health_history_account` ON `account_health_history` (`customer_account_id`);--> statement-breakpoint
CREATE INDEX `idx_health_history_date` ON `account_health_history` (`calculated_at`);--> statement-breakpoint
CREATE TABLE `customer_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`tier` text DEFAULT 'bronze' NOT NULL,
	`lifetime_value` real DEFAULT 0 NOT NULL,
	`total_orders` integer DEFAULT 0 NOT NULL,
	`avg_order_value` real DEFAULT 0 NOT NULL,
	`first_order_at` text,
	`last_order_at` text,
	`next_reorder_estimate` text,
	`health_score` integer DEFAULT 50 NOT NULL,
	`health_status` text DEFAULT 'healthy' NOT NULL,
	`payment_terms` text,
	`discount_rate` real DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_accounts_company_id_unique` ON `customer_accounts` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_customer_accounts_company` ON `customer_accounts` (`company_id`);--> statement-breakpoint
CREATE INDEX `idx_customer_accounts_tier` ON `customer_accounts` (`tier`);--> statement-breakpoint
CREATE INDEX `idx_customer_accounts_health` ON `customer_accounts` (`health_status`);--> statement-breakpoint
CREATE INDEX `idx_customer_accounts_ltv` ON `customer_accounts` (`lifetime_value`);--> statement-breakpoint
CREATE INDEX `idx_customer_accounts_reorder` ON `customer_accounts` (`next_reorder_estimate`);