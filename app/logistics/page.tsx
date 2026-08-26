import { getSupabaseLogisticsData } from "../../lib/supabase/dashboard";
import ManagementApp from "../ManagementApp";

export const dynamic = "force-dynamic";

export default async function LogisticsPage() {
  return <ManagementApp initialData={await getSupabaseLogisticsData()} section="logistics" />;
}
