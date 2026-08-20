import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDashboardData, getCameraById } from "../../../db/queries";
import ManagementApp from "../../ManagementApp";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const camera = await getCameraById(id);
  if (!camera) return { title: "相机记录未找到 · Lensfolio" };
  return {
    title: `${camera.brand} ${camera.model} · 相机投资档案`,
    description: `${camera.brand} ${camera.model} 的真实成本、市场估值、维修记录与退出回报。`,
  };
}

export default async function CameraPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getDashboardData();
  if (!data.assets.some((asset) => asset.id === id)) notFound();
  return <ManagementApp initialData={data} section="assets" selectedAssetId={id} />;
}
