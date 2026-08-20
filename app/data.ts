export type TimelineEvent = {
  label: string;
  at: string;
  detail?: string;
};

export type Camera = {
  id: string;
  brand: string;
  model: string;
  purchaseJpy: number;
  originalJpy?: number;
  paidCny: number;
  exchangeRate: number;
  weightG: number;
  batchId: "batch-1" | "batch-2" | "unassigned";
  status: string;
  shippingCny: number;
  shippingEstimate: boolean;
  targetSaleCny: number;
  orderAt: string;
  allocationNote?: string;
  thesis: string;
  risk: string;
  timeline: TimelineEvent[];
  isCustom?: boolean;
};

export type LogisticsBatch = {
  id: "batch-1" | "batch-2";
  label: string;
  assets: string;
  count: number;
  carrier: string;
  route: string;
  bareWeightG: number;
  chargeableWeight: string;
  shippingJpy: string;
  shippingCny: number;
  estimate: boolean;
  unitCostCny: number;
  status: string;
  duration: string;
  timeline: TimelineEvent[];
};

export const seedCameras: Camera[] = [
  {
    id: "canon-autoboy-sii-01",
    brand: "Canon",
    model: "Autoboy S II",
    originalJpy: 21630,
    purchaseJpy: 22000,
    paidCny: 986,
    exchangeRate: 0.0448,
    weightG: 551,
    batchId: "batch-1",
    status: "国际已发货",
    shippingCny: 106,
    shippingEstimate: false,
    targetSaleCny: 1108,
    orderAt: "2026-08-04 09:11",
    thesis: "接近日本市场常见买入区间，定位为低波动使用型资产。",
    risk: "潜在利润较薄，功能状态与后续整备成本会直接决定盈亏。",
    timeline: [
      { label: "下单付款", at: "08/04 09:11" },
      { label: "国际运费支付", at: "08/11 09:31" },
      { label: "合单审核通过", at: "08/14 13:34" },
      { label: "日本 EMS 发出", at: "08/16 17:39", detail: "当前无香港签收节点" },
    ],
  },
  {
    id: "contax-t2-date-back",
    brand: "Contax",
    model: "T2 Date Back",
    originalJpy: 120100,
    purchaseJpy: 110400,
    paidCny: 4913,
    exchangeRate: 0.0445,
    weightG: 603,
    batchId: "batch-1",
    status: "国际已发货",
    shippingCny: 115,
    shippingEstimate: false,
    targetSaleCny: 6202,
    orderAt: "2026-08-04 21:51",
    thesis: "净商品成本低于多数同期挂牌，是组合里成本安全垫最明显的资产。",
    risk: "电子、快门或对焦故障的维修成本较高，可能快速吞噬利润。",
    timeline: [
      { label: "下单付款", at: "08/04 21:51" },
      { label: "国际运费支付", at: "08/11 09:31" },
      { label: "合单审核通过", at: "08/14 13:34" },
      { label: "日本 EMS 发出", at: "08/16 17:39", detail: "付款至国际发货约 11 天 20 小时" },
    ],
  },
  {
    id: "nikon-28ti",
    brand: "Nikon",
    model: "28Ti",
    originalJpy: 160000,
    purchaseJpy: 147500,
    paidCny: 6505,
    exchangeRate: 0.0441,
    weightG: 555,
    batchId: "batch-2",
    status: "已入库待邮寄",
    shippingCny: 98,
    shippingEstimate: true,
    targetSaleCny: 7088,
    orderAt: "2026-08-12 21:35",
    thesis: "买入位于市场中低区间，若成色与功能符合描述，具备中上端定价空间。",
    risk: "资金占用最高；LCD 指针、测光、闪光与卷片状态是主要估值变量。",
    timeline: [
      { label: "下单付款", at: "08/12 21:35" },
      { label: "卖家发货", at: "08/15 14:48", detail: "等待 2 天 17 小时 13 分" },
      { label: "日本仓入库", at: "08/16 12:19", detail: "境内运输 21 小时 31 分" },
      { label: "拍照确认", at: "08/17 09:30" },
      { label: "航空解禁通过", at: "08/18 15:43" },
    ],
  },
  {
    id: "canon-autoboy-sii-set",
    brand: "Canon",
    model: "Autoboy S II（套装内）",
    purchaseJpy: 13700,
    paidCny: 603,
    exchangeRate: 0.044,
    weightG: 375,
    batchId: "batch-2",
    status: "已入库待邮寄",
    shippingCny: 66,
    shippingEstimate: true,
    targetSaleCny: 1107,
    orderAt: "2026-08-16 01:14",
    allocationNote: "两台套装总成本 27,400 JPY / ¥1,206、总重 750g，此处按 50% 均摊。",
    thesis: "套装买入成本较低，拆分后具备较好的潜在收益弹性。",
    risk: "成本与重量为套装均摊值，实际价值高度取决于单机功能状态。",
    timeline: [
      { label: "下单付款", at: "08/16 01:14" },
      { label: "卖家发货", at: "08/16 14:09", detail: "等待 12 小时 55 分" },
      { label: "日本仓入库", at: "08/17 13:15", detail: "境内运输 23 小时 06 分" },
      { label: "拍照确认", at: "08/18 09:15" },
      { label: "航空解禁通过", at: "08/18 15:43" },
    ],
  },
  {
    id: "canon-autoboy-s-set",
    brand: "Canon",
    model: "Autoboy S（套装内）",
    purchaseJpy: 13700,
    paidCny: 603,
    exchangeRate: 0.044,
    weightG: 375,
    batchId: "batch-2",
    status: "已入库待邮寄",
    shippingCny: 66,
    shippingEstimate: true,
    targetSaleCny: 706,
    orderAt: "2026-08-16 01:14",
    allocationNote: "两台套装总成本 27,400 JPY / ¥1,206、总重 750g，此处按 50% 均摊。",
    thesis: "低成本套装仓位，适合在确认功能后单独出售。",
    risk: "成本与重量为套装均摊值；维修或功能异常会显著压缩利润。",
    timeline: [
      { label: "下单付款", at: "08/16 01:14" },
      { label: "卖家发货", at: "08/16 14:09", detail: "等待 12 小时 55 分" },
      { label: "日本仓入库", at: "08/17 13:15", detail: "境内运输 23 小时 06 分" },
      { label: "拍照确认", at: "08/18 09:15" },
      { label: "航空解禁通过", at: "08/18 15:43" },
    ],
  },
];

export const logisticsBatches: LogisticsBatch[] = [
  {
    id: "batch-1",
    label: "第一批",
    assets: "Canon S II · Contax T2",
    count: 2,
    carrier: "日本邮政 EMS",
    route: "日本仓 → EMS → 香港",
    bareWeightG: 1154,
    chargeableWeight: "1.65 kg",
    shippingJpy: "4,970",
    shippingCny: 221,
    estimate: false,
    unitCostCny: 110.5,
    status: "国际已发货",
    duration: "5天 8小时",
    timeline: [
      { label: "运费支付", at: "08/11 09:31" },
      { label: "合单审核", at: "08/14 13:34" },
      { label: "日本发出", at: "08/16 17:39" },
      { label: "香港签收", at: "待更新" },
    ],
  },
  {
    id: "batch-2",
    label: "第二批",
    assets: "Nikon 28Ti · Canon S II · Canon S",
    count: 3,
    carrier: "待选择（EMS 预算）",
    route: "日本仓 → 待选择 → 香港",
    bareWeightG: 1305,
    chargeableWeight: "预计 1.8–1.9 kg",
    shippingJpy: "5,050–5,400",
    shippingCny: 230,
    estimate: true,
    unitCostCny: 76.7,
    status: "已入库 · 待选快递",
    duration: "尚未开始",
    timeline: [
      { label: "全数入库", at: "08/17 13:15" },
      { label: "拍照完成", at: "08/18 09:15" },
      { label: "航空解禁", at: "08/18 15:43" },
      { label: "国际发货", at: "待安排" },
    ],
  },
];

export const batchLabel = (batchId: Camera["batchId"]) =>
  batchId === "batch-1" ? "第一批" : batchId === "batch-2" ? "第二批" : "未分批";

export const landedCost = (camera: Camera) => camera.paidCny + camera.shippingCny;

