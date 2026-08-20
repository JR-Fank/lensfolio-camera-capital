import { getDashboardData } from "../db/queries";
import ManagementApp from "./ManagementApp";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <ManagementApp initialData={await getDashboardData()} />;
}
