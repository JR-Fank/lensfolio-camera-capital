import { getSupabaseDashboardData } from "../../lib/supabase/dashboard";
import ManagementApp from "../ManagementApp";

export const dynamic = "force-dynamic";
export default async function AssetsPage() {
  return <ManagementApp initialData={await getSupabaseDashboardData()} section="assets" />;
}
