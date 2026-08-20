import type { Metadata } from "next";
import CameraDetail from "./CameraDetail";
import { seedCameras } from "../../data";

type DetailPageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: DetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const camera = seedCameras.find((item) => item.id === id);
  const title = camera ? `${camera.brand} ${camera.model} · 相机资产详情` : "相机资产详情";
  const description = camera
    ? `${camera.brand} ${camera.model} 的采购成本、物流节点、落地成本与潜在回报。`
    : "Lensfolio 本地新增相机资产详情。";

  return {
    title,
    description,
    openGraph: { title, description, images: [] },
    twitter: { card: "summary", title, description, images: [] },
  };
}

export default async function DetailPage({ params }: DetailPageProps) {
  const { id } = await params;
  const camera = seedCameras.find((item) => item.id === id) ?? null;
  return <CameraDetail id={id} initialCamera={camera} />;
}

