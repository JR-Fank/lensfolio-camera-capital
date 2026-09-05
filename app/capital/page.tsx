import { getCapitalLedgerData } from "../../lib/supabase/capital-ledger";
import { getSupabaseDashboardData } from "../../lib/supabase/dashboard";
import ManagementApp from "../ManagementApp";
import CapitalLedgerView from "./CapitalLedgerView";

export const dynamic = "force-dynamic";

export default async function CapitalPage() {
  const [dashboard, capital] = await Promise.all([getSupabaseDashboardData(), getCapitalLedgerData()]);
  return <ManagementApp initialData={dashboard} section="capital" capitalContent={<CapitalLedgerView data={capital} />} />;
}
