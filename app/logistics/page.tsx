import { getSupabaseLogisticsData } from "../../lib/supabase/dashboard";
import { getPortfolioAccess } from "../../lib/supabase/portfolio-access";
import ManagementApp from "../ManagementApp";

export const dynamic = "force-dynamic";

export default async function LogisticsPage() {
  const [data, access] = await Promise.all([
    getSupabaseLogisticsData(),
    getPortfolioAccess(),
  ]);
  return (
    <ManagementApp
      initialData={data}
      section="logistics"
      canRefreshTracking={access.canWrite}
    />
  );
}
