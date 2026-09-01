import { getSupabaseDashboardData } from "../../lib/supabase/dashboard";
import { getPortfolioAccess } from "../../lib/supabase/portfolio-access";
import ManagementApp from "../ManagementApp";

export const dynamic = "force-dynamic";
export default async function AssetsPage() {
  const [data, access] = await Promise.all([
    getSupabaseDashboardData(),
    getPortfolioAccess(),
  ]);
  return <ManagementApp initialData={data} section="assets" canCreateAsset={access.canWrite} canManageValuation={access.canWrite} />;
}
