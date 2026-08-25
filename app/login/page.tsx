import { redirect } from "next/navigation";
import { getCurrentUser } from "../../lib/supabase/server";
import { login } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getCurrentUser()) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-mark">LF</div>
        <p className="eyebrow">SECURE PORTFOLIO ACCESS</p>
        <h1>登录 Lensfolio</h1>
        <p>使用现有 Supabase owner 账户继续。此页面不会创建新用户。</p>
        <form action={login}>
          <label>邮箱<input name="email" type="email" autoComplete="email" required /></label>
          <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
          {error && <div className="login-error" role="alert">{error === "missing" ? "请填写邮箱和密码。" : "邮箱或密码不正确。"}</div>}
          <button type="submit">安全登录</button>
        </form>
      </section>
    </main>
  );
}
