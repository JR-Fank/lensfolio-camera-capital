CREATE TABLE `cameras` (
	`id` text PRIMARY KEY NOT NULL,
	`brand` text NOT NULL,
	`model` text NOT NULL,
	`variant` text,
	`serial_number` text,
	`acquired_at` text NOT NULL,
	`lifecycle_status` text DEFAULT '持有中' NOT NULL,
	`repair_status` text DEFAULT '未检测' NOT NULL,
	`condition_grade` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cameras_lifecycle_status` ON `cameras` (`lifecycle_status`);--> statement-breakpoint
CREATE INDEX `idx_cameras_acquired_at` ON `cameras` (`acquired_at`);--> statement-breakpoint
CREATE TABLE `logistics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`logistics_order_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`raw_status` text NOT NULL,
	`status_label` text NOT NULL,
	`details` text,
	`office` text,
	`country` text,
	`postal_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`logistics_order_id`) REFERENCES `logistics_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_logistics_event_dedupe` ON `logistics_events` (`logistics_order_id`,`occurred_at`,`raw_status`);--> statement-breakpoint
CREATE INDEX `idx_logistics_events_order_time` ON `logistics_events` (`logistics_order_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `logistics_items` (
	`id` text PRIMARY KEY NOT NULL,
	`logistics_order_id` text NOT NULL,
	`camera_id` text NOT NULL,
	`allocated_shipping_cny` real DEFAULT 0 NOT NULL,
	`weight_g` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`logistics_order_id`) REFERENCES `logistics_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_logistics_items_order_id` ON `logistics_items` (`logistics_order_id`);--> statement-breakpoint
CREATE INDEX `idx_logistics_items_camera_id` ON `logistics_items` (`camera_id`);--> statement-breakpoint
CREATE TABLE `logistics_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_code` text NOT NULL,
	`carrier` text NOT NULL,
	`tracking_number` text,
	`origin` text NOT NULL,
	`destination` text NOT NULL,
	`status` text NOT NULL,
	`latest_event` text,
	`estimated_arrival_at` text,
	`seller_shipped_at` text,
	`warehouse_in_at` text,
	`international_shipped_at` text,
	`hong_kong_arrived_at` text,
	`delivered_at` text,
	`bare_weight_g` integer DEFAULT 0 NOT NULL,
	`chargeable_weight_g` integer DEFAULT 0 NOT NULL,
	`shipping_jpy` integer DEFAULT 0 NOT NULL,
	`shipping_cny` real DEFAULT 0 NOT NULL,
	`handling_cny` real DEFAULT 0 NOT NULL,
	`is_estimated` integer DEFAULT false NOT NULL,
	`last_checked_at` text,
	`tracking_source` text,
	`tracking_error` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_logistics_tracking_number` ON `logistics_orders` (`tracking_number`);--> statement-breakpoint
CREATE INDEX `idx_logistics_status` ON `logistics_orders` (`status`);--> statement-breakpoint
CREATE INDEX `idx_logistics_last_checked_at` ON `logistics_orders` (`last_checked_at`);--> statement-breakpoint
CREATE TABLE `market_valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`camera_id` text NOT NULL,
	`source` text DEFAULT '闲鱼' NOT NULL,
	`valued_at` text NOT NULL,
	`low_cny` real NOT NULL,
	`average_cny` real NOT NULL,
	`premium_cny` real NOT NULL,
	`expected_cny` real NOT NULL,
	`sample_size` integer,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_valuations_camera_date` ON `market_valuations` (`camera_id`,`valued_at`);--> statement-breakpoint
CREATE TABLE `purchase_order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`camera_id` text NOT NULL,
	`item_price_jpy` integer NOT NULL,
	`allocated_paid_cny` real NOT NULL,
	`allocated_domestic_shipping_jpy` integer DEFAULT 0 NOT NULL,
	`allocation_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_purchase_items_camera_id` ON `purchase_order_items` (`camera_id`);--> statement-breakpoint
CREATE INDEX `idx_purchase_items_order_id` ON `purchase_order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_ref` text NOT NULL,
	`platform` text DEFAULT '任意门' NOT NULL,
	`seller` text,
	`purchased_at` text NOT NULL,
	`item_price_jpy` integer DEFAULT 0 NOT NULL,
	`service_fee_jpy` integer DEFAULT 0 NOT NULL,
	`domestic_shipping_jpy` integer DEFAULT 0 NOT NULL,
	`photo_fee_jpy` integer DEFAULT 0 NOT NULL,
	`adjustment_jpy` integer DEFAULT 0 NOT NULL,
	`discount_jpy` integer DEFAULT 0 NOT NULL,
	`total_jpy` integer NOT NULL,
	`paid_cny` real NOT NULL,
	`exchange_rate` real NOT NULL,
	`status` text DEFAULT '已付款' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_purchase_orders_order_ref` ON `purchase_orders` (`order_ref`);--> statement-breakpoint
CREATE INDEX `idx_purchase_orders_purchased_at` ON `purchase_orders` (`purchased_at`);--> statement-breakpoint
CREATE TABLE `repair_records` (
	`id` text PRIMARY KEY NOT NULL,
	`camera_id` text NOT NULL,
	`repair_date` text NOT NULL,
	`problem` text NOT NULL,
	`work_performed` text NOT NULL,
	`cost_cny` real DEFAULT 0 NOT NULL,
	`vendor` text,
	`resulting_status` text DEFAULT '已维修' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_repairs_camera_date` ON `repair_records` (`camera_id`,`repair_date`);--> statement-breakpoint
CREATE TABLE `sales_records` (
	`id` text PRIMARY KEY NOT NULL,
	`camera_id` text NOT NULL,
	`platform` text DEFAULT '闲鱼' NOT NULL,
	`status` text DEFAULT '待出售' NOT NULL,
	`listed_at` text,
	`sold_at` text,
	`asking_price_cny` real DEFAULT 0 NOT NULL,
	`actual_price_cny` real DEFAULT 0 NOT NULL,
	`platform_fee_cny` real DEFAULT 0 NOT NULL,
	`shipping_cny` real DEFAULT 0 NOT NULL,
	`buyer_notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sales_camera_status` ON `sales_records` (`camera_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_sales_sold_at` ON `sales_records` (`sold_at`);
--> statement-breakpoint
INSERT INTO `cameras` (`id`,`brand`,`model`,`variant`,`acquired_at`,`lifecycle_status`,`repair_status`,`condition_grade`,`notes`) VALUES
('canon-autoboy-sii-01','Canon','Autoboy S II',NULL,'2026-08-04 09:11:00','在途','未检测',NULL,'第一批单机采购'),
('contax-t2-date-back','Contax','T2','Date Back','2026-08-04 21:51:00','在途','未检测',NULL,'第一批核心仓位'),
('nikon-28ti','Nikon','28Ti',NULL,'2026-08-12 21:35:00','日本仓','未检测','接近未使用','第二批核心仓位；航空解禁已通过'),
('canon-autoboy-sii-set','Canon','Autoboy S II','套装内','2026-08-16 01:14:00','日本仓','未检测',NULL,'两台套装成本与重量按 50% 均摊'),
('canon-autoboy-s-set','Canon','Autoboy S','套装内','2026-08-16 01:14:00','日本仓','未检测',NULL,'两台套装成本与重量按 50% 均摊');
--> statement-breakpoint
INSERT INTO `purchase_orders` (`id`,`order_ref`,`platform`,`purchased_at`,`item_price_jpy`,`service_fee_jpy`,`domestic_shipping_jpy`,`photo_fee_jpy`,`adjustment_jpy`,`discount_jpy`,`total_jpy`,`paid_cny`,`exchange_rate`,`status`,`notes`) VALUES
('po-canon-01','ORD-20260804-CANON-SII','任意门','2026-08-04 09:11:00',21630,300,1300,500,0,1730,22000,986,0.0448,'已付款','人民币实际扣款为成本真值'),
('po-contax-01','ORD-20260804-CONTAX-T2','任意门','2026-08-04 21:51:00',120100,300,0,0,0,10000,110400,4913,0.0445,'已付款','优惠券减免 10000 JPY'),
('po-nikon-01','ORD-20260812-NIKON-28TI','任意门','2026-08-12 21:35:00',160000,300,0,0,0,12800,147500,6505,0.0441,'已付款','另有 750 JPY 运费补差，计入物流预算'),
('po-canon-set-01','ORD-20260816-CANON-SET','任意门','2026-08-16 01:14:00',28000,300,0,500,0,1400,27400,1206,0.0440,'已付款','Autoboy S II + Autoboy S 两台套装');
--> statement-breakpoint
INSERT INTO `purchase_order_items` (`id`,`order_id`,`camera_id`,`item_price_jpy`,`allocated_paid_cny`,`allocated_domestic_shipping_jpy`,`allocation_note`) VALUES
('poi-canon-01','po-canon-01','canon-autoboy-sii-01',21630,986,1300,'单机订单'),
('poi-contax-01','po-contax-01','contax-t2-date-back',120100,4913,0,'单机订单'),
('poi-nikon-01','po-nikon-01','nikon-28ti',160000,6505,0,'单机订单'),
('poi-canon-set-sii','po-canon-set-01','canon-autoboy-sii-set',14000,603,0,'套装人民币成本按 50% 均摊'),
('poi-canon-set-s','po-canon-set-01','canon-autoboy-s-set',14000,603,0,'套装人民币成本按 50% 均摊');
--> statement-breakpoint
INSERT INTO `logistics_orders` (`id`,`batch_code`,`carrier`,`tracking_number`,`origin`,`destination`,`status`,`latest_event`,`estimated_arrival_at`,`seller_shipped_at`,`warehouse_in_at`,`international_shipped_at`,`hong_kong_arrived_at`,`delivered_at`,`bare_weight_g`,`chargeable_weight_g`,`shipping_jpy`,`shipping_cny`,`handling_cny`,`is_estimated`,`last_checked_at`,`tracking_source`,`notes`) VALUES
('logistics-batch-001','001','日本邮政 EMS','EN533720370JP','东京国际邮便局','香港','香港领取点待取','Item arrival at collection point for pick-up',NULL,NULL,NULL,'2026-08-17 10:41:00','2026-08-18 22:51:00',NULL,1154,1650,4970,221,0,0,'2026-08-20 21:15:00','Japan Post public tracking','已付；含 EMS、内部加固、运费补差与优惠券'),
('logistics-batch-002','002','日本邮政 EMS',NULL,'日本仓','香港','待支付运费','航空解禁通过',NULL,'2026-08-15 14:48:00','2026-08-17 13:15:00',NULL,NULL,NULL,1305,1801,5200,230,0,1,NULL,NULL,'页面 EMS 基础报价 4200 JPY；含可能的补差与加固后暂按 230 RMB 预提');
--> statement-breakpoint
INSERT INTO `logistics_items` (`id`,`logistics_order_id`,`camera_id`,`allocated_shipping_cny`,`weight_g`) VALUES
('li-001-canon','logistics-batch-001','canon-autoboy-sii-01',106,551),
('li-001-contax','logistics-batch-001','contax-t2-date-back',115,603),
('li-002-nikon','logistics-batch-002','nikon-28ti',98,555),
('li-002-canon-sii','logistics-batch-002','canon-autoboy-sii-set',66,375),
('li-002-canon-s','logistics-batch-002','canon-autoboy-s-set',66,375);
--> statement-breakpoint
INSERT INTO `logistics_events` (`id`,`logistics_order_id`,`occurred_at`,`raw_status`,`status_label`,`details`,`office`,`country`,`postal_code`) VALUES
('le-001-01','logistics-batch-001','2026-08-17 10:41:00','Posting/Collection','已收寄','', 'TOKYO INT','TOKYO','138-8799'),
('le-001-02','logistics-batch-001','2026-08-18 06:19:00','Arrival at outward office of exchange','到达日本国际交换局','', 'TOKYO INT','TOKYO','138-8799'),
('le-001-03','logistics-batch-001','2026-08-18 06:20:00','Dispatch from outward office of exchange','离开日本','', 'TOKYO INT','TOKYO','138-8799'),
('le-001-04','logistics-batch-001','2026-08-18 22:51:00','Arrival at inward office of exchange','到达香港','', 'HONG KONG AIR MAIL CENTRE','HONG KONG',NULL),
('le-001-05','logistics-batch-001','2026-08-19 00:35:00','Departure from inward office of exchange','离开香港交换局','', 'HONG KONG AIR MAIL CENTRE','HONG KONG',NULL),
('le-001-06','logistics-batch-001','2026-08-19 11:05:00','Processing at delivery Post Office','投递局处理中','',NULL,'HONG KONG',NULL),
('le-001-07','logistics-batch-001','2026-08-19 11:10:00','Item arrival at collection point for pick-up','香港领取点待取','',NULL,'HONG KONG',NULL);
--> statement-breakpoint
INSERT INTO `market_valuations` (`id`,`camera_id`,`source`,`valued_at`,`low_cny`,`average_cny`,`premium_cny`,`expected_cny`,`sample_size`,`notes`) VALUES
('val-canon-01','canon-autoboy-sii-01','闲鱼','2026-08-20',900,1100,1300,1100,NULL,'待补充可比成交样本'),
('val-contax-01','contax-t2-date-back','闲鱼','2026-08-20',6200,7000,7800,7000,NULL,'Date Back 版本；需按功能与成色修正'),
('val-nikon-01','nikon-28ti','闲鱼','2026-08-20',6800,7400,8200,7400,NULL,'接近未使用描述，待实机检测'),
('val-canon-set-sii','canon-autoboy-sii-set','闲鱼','2026-08-20',850,1050,1250,1050,NULL,'套装拆分估价'),
('val-canon-set-s','canon-autoboy-s-set','闲鱼','2026-08-20',500,700,900,700,NULL,'套装拆分估价');
--> statement-breakpoint
PRAGMA optimize;
