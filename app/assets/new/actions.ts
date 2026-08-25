"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPortfolioAccess } from "../../../lib/supabase/portfolio-access";
import { createClient } from "../../../lib/supabase/server";

export type CreateAssetState = {
  error: string | null;
};

const statusValues = new Set([
  "acquired",
  "in_transit",
  "in_storage",
  "inspection",
  "repair",
  "ready_for_sale",
  "listed",
  "sold",
  "retired",
]);

function requiredText(formData: FormData, name: string, label: string) {
  const value = String(formData.get(name) ?? "").trim();
  if (!value) throw new Error(`请填写${label}`);
  return value;
}

function optionalText(formData: FormData, name: string) {
  const value = String(formData.get(name) ?? "").trim();
  return value || null;
}

function requiredAmount(formData: FormData, name: string, label: string) {
  const raw = String(formData.get(name) ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${label}必须为正数，最多保留两位小数`);
  }
  return raw;
}

function optionalNumber(formData: FormData, name: string, label: string) {
  const raw = String(formData.get(name) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}必须为正数`);
  return raw;
}

export async function createAssetWithPurchase(
  _previousState: CreateAssetState,
  formData: FormData,
): Promise<CreateAssetState> {
  let assetId: string | null = null;

  try {
    const access = await getPortfolioAccess();
    if (!access.canWrite) return { error: "当前账户只有查看权限，不能新增资产。" };

    const brand = requiredText(formData, "brand", "品牌");
    const model = requiredText(formData, "model", "型号");
    const purchaseDate = requiredText(formData, "purchase_date", "购买日期");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw new Error("购买日期格式不正确");

    const actualPaidCny = requiredAmount(formData, "actual_paid_cny", "人民币实付");
    const measuredWeight = optionalNumber(formData, "measured_weight_g", "实测重量");
    if (measuredWeight && !/^\d+$/.test(measuredWeight)) throw new Error("实测重量必须为整数克");

    const purchasePriceJpy = optionalNumber(formData, "purchase_price_jpy", "日元购买价");
    const exchangeRate = optionalNumber(formData, "exchange_rate_jpy_to_cny", "日元汇率");
    if ((purchasePriceJpy === null) !== (exchangeRate === null)) {
      throw new Error("日元购买价和实际汇率需要同时填写，或同时留空");
    }

    const status = optionalText(formData, "status") ?? "acquired";
    if (!statusValues.has(status)) throw new Error("资产状态不在允许范围内");

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_asset_with_purchase", {
      p_portfolio_id: access.portfolioId,
      p_brand: brand,
      p_model: model,
      p_purchase_date: purchaseDate,
      p_actual_paid_cny: actualPaidCny,
      p_serial_number: optionalText(formData, "serial_number"),
      p_measured_weight_g: measuredWeight ? Number(measuredWeight) : null,
      p_condition: optionalText(formData, "condition"),
      p_operational_status: status,
      p_notes: optionalText(formData, "notes"),
      p_purchase_price_jpy: purchasePriceJpy,
      p_exchange_rate_jpy_to_cny: exchangeRate,
      p_platform: optionalText(formData, "platform"),
      p_order_reference: optionalText(formData, "order_reference"),
    });

    if (error) throw new Error(error.message);
    const result = Array.isArray(data) ? data[0] : data;
    assetId = result && typeof result === "object" && "asset_id" in result
      ? String(result.asset_id)
      : null;
    if (!assetId) throw new Error("数据库未返回新增资产 ID");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "保存失败，请稍后再试" };
  }

  revalidatePath("/");
  revalidatePath("/assets");
  redirect(`/cameras/${assetId}`);
}
