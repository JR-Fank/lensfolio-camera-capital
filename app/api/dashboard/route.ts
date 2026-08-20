import { getDashboardData } from "../../../db/queries";

export async function GET() {
  try {
    return Response.json(await getDashboardData());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "无法读取投资组合数据" },
      { status: 500 },
    );
  }
}
