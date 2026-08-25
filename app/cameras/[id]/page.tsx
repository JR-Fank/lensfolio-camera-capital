import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSupabaseAssetDetailData } from "../../../lib/supabase/dashboard";
import ManagementApp from "../../ManagementApp";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const data = await getSupabaseAssetDetailData(id);
  const asset = data?.assets[0];
  if (!asset) return { title: "相机记录未找到 · Lensfolio" };
  return {
    title: `${asset.brand} ${asset.model} · 相机投资档案`,
    description: `${asset.brand} ${asset.model} 的真实成本、市场估值与投资回报。`,
  };
}

export default async function CameraPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getSupabaseAssetDetailData(id);
  if (!data) notFound();
  return <ManagementApp initialData={data} section="assets" selectedAssetId={id} />;
}
