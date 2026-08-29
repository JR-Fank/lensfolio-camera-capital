"use server";

import { redirect } from "next/navigation";
import { safeReturnPath } from "../../lib/auth-redirect";
import { createClient } from "../../lib/supabase/server";

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const returnTo = safeReturnPath(String(formData.get("next") ?? "/"));
  if (!email || !password) redirect(`/login?error=missing&next=${encodeURIComponent(returnTo)}`);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?error=invalid&next=${encodeURIComponent(returnTo)}`);
  redirect(returnTo);
}
