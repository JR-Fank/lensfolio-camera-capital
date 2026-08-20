CREATE TABLE `asset_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`camera_id` text NOT NULL,
	`expense_date` text NOT NULL,
	`category` text DEFAULT '其他' NOT NULL,
	`amount_cny` real DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_asset_expenses_camera_date` ON `asset_expenses` (`camera_id`,`expense_date`);--> statement-breakpoint
ALTER TABLE `cameras` ADD `purchase_platform` text;--> statement-breakpoint
ALTER TABLE `cameras` ADD `weight_g` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `logistics_orders` ADD `allocation_method` text DEFAULT '按重量' NOT NULL;--> statement-breakpoint
ALTER TABLE `market_valuations` ADD `keyword` text;--> statement-breakpoint
ALTER TABLE `market_valuations` ADD `median_cny` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `market_valuations` ADD `high_cny` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `market_valuations` ADD `condition_grade` text;--> statement-breakpoint
ALTER TABLE `market_valuations` ADD `confidence` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `market_valuations` ADD `collection_method` text DEFAULT '人工录入' NOT NULL;--> statement-breakpoint
ALTER TABLE `market_valuations` ADD `exclusion_rules` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `product_name` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `payment_method` text;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `paid_at` text;--> statement-breakpoint
ALTER TABLE `repair_records` ADD `value_before_cny` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repair_records` ADD `value_after_cny` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_records` ADD `market_price_cny` real DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `cameras`
SET `purchase_platform` = COALESCE((
  SELECT po.platform
  FROM purchase_order_items poi
  JOIN purchase_orders po ON po.id = poi.order_id
  WHERE poi.camera_id = cameras.id
  ORDER BY po.purchased_at DESC
  LIMIT 1
), '任意门'),
`weight_g` = COALESCE((
  SELECT MAX(li.weight_g)
  FROM logistics_items li
  WHERE li.camera_id = cameras.id
), 0);--> statement-breakpoint
UPDATE `cameras`
SET `lifecycle_status` = CASE `lifecycle_status`
  WHEN '在途' THEN '运输中'
  WHEN '日本仓' THEN '待入库'
  WHEN '持有中' THEN '已入库'
  WHEN '待出售' THEN '可出售'
  ELSE `lifecycle_status`
END;--> statement-breakpoint
UPDATE `purchase_orders`
SET `product_name` = COALESCE((
  SELECT GROUP_CONCAT(c.brand || ' ' || c.model, ' + ')
  FROM purchase_order_items poi
  JOIN cameras c ON c.id = poi.camera_id
  WHERE poi.order_id = purchase_orders.id
), order_ref),
`payment_method` = COALESCE(payment_method, '人民币支付'),
`paid_at` = COALESCE(paid_at, purchased_at);--> statement-breakpoint
UPDATE `market_valuations`
SET `keyword` = COALESCE(keyword, (
  SELECT c.brand || ' ' || c.model || CASE WHEN c.variant IS NOT NULL THEN ' ' || c.variant ELSE '' END
  FROM cameras c WHERE c.id = market_valuations.camera_id
)),
`median_cny` = CASE WHEN median_cny = 0 THEN average_cny ELSE median_cny END,
`high_cny` = CASE WHEN high_cny = 0 THEN premium_cny ELSE high_cny END,
`condition_grade` = COALESCE(condition_grade, (
  SELECT c.condition_grade FROM cameras c WHERE c.id = market_valuations.camera_id
)),
`confidence` = CASE WHEN confidence = 0 THEN 0.5 ELSE confidence END,
`exclusion_rules` = COALESCE(exclusion_rules, '维修机,故障机,配件,皮套,说明书,空壳');--> statement-breakpoint
PRAGMA optimize;
