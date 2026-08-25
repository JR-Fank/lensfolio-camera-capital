import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "./server";

export type PortfolioRole = "owner" | "editor" | "viewer";

type MembershipRow = {
  portfolio_id: string;
  role: PortfolioRole;
};

export const getPortfolioAccess = cache(async () => {
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) redirect("/login");

  const { data, error } = await supabase
    .from("portfolio_members")
    .select("portfolio_id,role")
    .eq("user_id", authData.user.id)
    .order("created_at", { ascending: true })
    .limit(2);

  if (error) throw new Error(`Portfolio access query failed: ${error.message}`);
  const memberships = (data ?? []) as MembershipRow[];
  if (memberships.length !== 1) {
    throw new Error(`Expected one portfolio membership, found ${memberships.length}.`);
  }

  const membership = memberships[0];
  return {
    portfolioId: membership.portfolio_id,
    role: membership.role,
    canWrite: membership.role === "owner" || membership.role === "editor",
  };
});
