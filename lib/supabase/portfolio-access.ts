import "server-only";

import { cache } from "react";
import { createClient, createPublicClient } from "./server";

export type PortfolioRole = "owner" | "editor" | "viewer";

type MembershipRow = {
  portfolio_id: string;
  role: PortfolioRole;
};

export const getPortfolioAccess = cache(async () => {
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (!authError && authData.user) {
    const { data, error } = await supabase
      .from("portfolio_members")
      .select("portfolio_id,role")
      .eq("user_id", authData.user.id)
      .order("created_at", { ascending: true })
      .limit(2);
    if (error) throw new Error(`Portfolio access query failed: ${error.message}`);
    const memberships = (data ?? []) as MembershipRow[];
    if (memberships.length > 1) {
      throw new Error(`Expected one portfolio membership, found ${memberships.length}.`);
    }
    if (memberships.length === 1) {
      const membership = memberships[0];
      return {
        supabase,
        portfolioId: membership.portfolio_id,
        role: membership.role,
        canWrite: membership.role === "owner" || membership.role === "editor",
      };
    }
  }

  // Anonymous visitors and signed-in non-members use the same public RLS role.
  const publicClient = createPublicClient();
  const { data, error } = await publicClient.from("portfolios")
    .select("id").order("id").limit(2);
  if (error) throw new Error(`Public portfolio query failed: ${error.message}`);
  if (data?.length !== 1) throw new Error(`Expected one public portfolio, found ${data?.length ?? 0}.`);
  return { supabase: publicClient, portfolioId: data[0].id as string, role: "viewer" as const, canWrite: false };
});
