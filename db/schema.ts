import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const cameras = sqliteTable("cameras", {
  id: text("id").primaryKey(),
  brand: text("brand").notNull(),
  model: text("model").notNull(),
  variant: text("variant"),
  serialNumber: text("serial_number"),
  acquiredAt: text("acquired_at").notNull(),
  lifecycleStatus: text("lifecycle_status").notNull().default("持有中"),
  repairStatus: text("repair_status").notNull().default("未检测"),
  conditionGrade: text("condition_grade"),
  notes: text("notes"),
  ...timestamps,
}, (table) => [
  index("idx_cameras_lifecycle_status").on(table.lifecycleStatus),
  index("idx_cameras_acquired_at").on(table.acquiredAt),
]);

export const purchaseOrders = sqliteTable("purchase_orders", {
  id: text("id").primaryKey(),
  orderRef: text("order_ref").notNull(),
  platform: text("platform").notNull().default("任意门"),
  seller: text("seller"),
  purchasedAt: text("purchased_at").notNull(),
  itemPriceJpy: integer("item_price_jpy").notNull().default(0),
  serviceFeeJpy: integer("service_fee_jpy").notNull().default(0),
  domesticShippingJpy: integer("domestic_shipping_jpy").notNull().default(0),
  photoFeeJpy: integer("photo_fee_jpy").notNull().default(0),
  adjustmentJpy: integer("adjustment_jpy").notNull().default(0),
  discountJpy: integer("discount_jpy").notNull().default(0),
  totalJpy: integer("total_jpy").notNull(),
  paidCny: real("paid_cny").notNull(),
  exchangeRate: real("exchange_rate").notNull(),
  status: text("status").notNull().default("已付款"),
  notes: text("notes"),
  ...timestamps,
}, (table) => [
  uniqueIndex("idx_purchase_orders_order_ref").on(table.orderRef),
  index("idx_purchase_orders_purchased_at").on(table.purchasedAt),
]);

export const purchaseOrderItems = sqliteTable("purchase_order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
  cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
  itemPriceJpy: integer("item_price_jpy").notNull(),
  allocatedPaidCny: real("allocated_paid_cny").notNull(),
  allocatedDomesticShippingJpy: integer("allocated_domestic_shipping_jpy").notNull().default(0),
  allocationNote: text("allocation_note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_purchase_items_camera_id").on(table.cameraId),
  index("idx_purchase_items_order_id").on(table.orderId),
]);

export const logisticsOrders = sqliteTable("logistics_orders", {
  id: text("id").primaryKey(),
  batchCode: text("batch_code").notNull(),
  carrier: text("carrier").notNull(),
  trackingNumber: text("tracking_number"),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  status: text("status").notNull(),
  latestEvent: text("latest_event"),
  estimatedArrivalAt: text("estimated_arrival_at"),
  sellerShippedAt: text("seller_shipped_at"),
  warehouseInAt: text("warehouse_in_at"),
  internationalShippedAt: text("international_shipped_at"),
  hongKongArrivedAt: text("hong_kong_arrived_at"),
  deliveredAt: text("delivered_at"),
  bareWeightG: integer("bare_weight_g").notNull().default(0),
  chargeableWeightG: integer("chargeable_weight_g").notNull().default(0),
  shippingJpy: integer("shipping_jpy").notNull().default(0),
  shippingCny: real("shipping_cny").notNull().default(0),
  handlingCny: real("handling_cny").notNull().default(0),
  isEstimated: integer("is_estimated", { mode: "boolean" }).notNull().default(false),
  lastCheckedAt: text("last_checked_at"),
  trackingSource: text("tracking_source"),
  trackingError: text("tracking_error"),
  notes: text("notes"),
  ...timestamps,
}, (table) => [
  uniqueIndex("idx_logistics_tracking_number").on(table.trackingNumber),
  index("idx_logistics_status").on(table.status),
  index("idx_logistics_last_checked_at").on(table.lastCheckedAt),
]);

export const logisticsItems = sqliteTable("logistics_items", {
  id: text("id").primaryKey(),
  logisticsOrderId: text("logistics_order_id").notNull().references(() => logisticsOrders.id, { onDelete: "cascade" }),
  cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
  allocatedShippingCny: real("allocated_shipping_cny").notNull().default(0),
  weightG: integer("weight_g").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_logistics_items_order_id").on(table.logisticsOrderId),
  index("idx_logistics_items_camera_id").on(table.cameraId),
]);

export const logisticsEvents = sqliteTable("logistics_events", {
  id: text("id").primaryKey(),
  logisticsOrderId: text("logistics_order_id").notNull().references(() => logisticsOrders.id, { onDelete: "cascade" }),
  occurredAt: text("occurred_at").notNull(),
  rawStatus: text("raw_status").notNull(),
  statusLabel: text("status_label").notNull(),
  details: text("details"),
  office: text("office"),
  country: text("country"),
  postalCode: text("postal_code"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_logistics_event_dedupe").on(table.logisticsOrderId, table.occurredAt, table.rawStatus),
  index("idx_logistics_events_order_time").on(table.logisticsOrderId, table.occurredAt),
]);

export const repairRecords = sqliteTable("repair_records", {
  id: text("id").primaryKey(),
  cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
  repairDate: text("repair_date").notNull(),
  problem: text("problem").notNull(),
  workPerformed: text("work_performed").notNull(),
  costCny: real("cost_cny").notNull().default(0),
  vendor: text("vendor"),
  resultingStatus: text("resulting_status").notNull().default("已维修"),
  notes: text("notes"),
  ...timestamps,
}, (table) => [
  index("idx_repairs_camera_date").on(table.cameraId, table.repairDate),
]);

export const salesRecords = sqliteTable("sales_records", {
  id: text("id").primaryKey(),
  cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
  platform: text("platform").notNull().default("闲鱼"),
  status: text("status").notNull().default("待出售"),
  listedAt: text("listed_at"),
  soldAt: text("sold_at"),
  askingPriceCny: real("asking_price_cny").notNull().default(0),
  actualPriceCny: real("actual_price_cny").notNull().default(0),
  platformFeeCny: real("platform_fee_cny").notNull().default(0),
  shippingCny: real("shipping_cny").notNull().default(0),
  buyerNotes: text("buyer_notes"),
  ...timestamps,
}, (table) => [
  index("idx_sales_camera_status").on(table.cameraId, table.status),
  index("idx_sales_sold_at").on(table.soldAt),
]);

export const marketValuations = sqliteTable("market_valuations", {
  id: text("id").primaryKey(),
  cameraId: text("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("闲鱼"),
  valuedAt: text("valued_at").notNull(),
  lowCny: real("low_cny").notNull(),
  averageCny: real("average_cny").notNull(),
  premiumCny: real("premium_cny").notNull(),
  expectedCny: real("expected_cny").notNull(),
  sampleSize: integer("sample_size"),
  notes: text("notes"),
  ...timestamps,
}, (table) => [
  index("idx_valuations_camera_date").on(table.cameraId, table.valuedAt),
]);
