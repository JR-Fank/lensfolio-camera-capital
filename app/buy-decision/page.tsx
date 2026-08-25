import { createNativeDashboardBaseline } from "../../lib/native-dashboard-baseline";
import ManagementApp from "../ManagementApp";

export const dynamic = "force-dynamic";

export default async function BuyDecisionPage() {
  return <ManagementApp initialData={createNativeDashboardBaseline()} section="buy-decision" />;
}
