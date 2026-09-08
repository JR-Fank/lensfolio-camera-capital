import { getSupabaseRepairsData } from "../../lib/supabase/dashboard";
import ManagementApp from "../ManagementApp";

export const dynamic = "force-dynamic";
export default async function RepairsPage() {
  return <ManagementApp initialData={await getSupabaseRepairsData()} section="repairs" />;
}
