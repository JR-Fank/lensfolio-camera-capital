import type { Metadata } from "next";
import { createNativeDashboardBaseline } from "../../../lib/native-dashboard-baseline";
import ManagementApp from "../../ManagementApp";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await params;
  return {
    title: "相机投资档案 · Lensfolio",
    description: "单机真实成本、市场估值、维修记录与退出回报。",
  };
}

export default async function CameraPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ManagementApp initialData={createNativeDashboardBaseline()} section="assets" selectedAssetId={id} />;
}
