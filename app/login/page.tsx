import { redirect } from "next/navigation";
import { safeReturnPath } from "../../lib/auth-redirect";
import { getCurrentUser } from "../../lib/supabase/server";
import { login } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const returnTo = safeReturnPath(next);
  if (await getCurrentUser()) redirect(returnTo);

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-mark">LF</div>
        <p className="eyebrow">OWNER SESSION REQUIRED</p>
        <h1>验证身份</h1>
        <p>仅在此设备的安全会话失效时需要登录。日常请从 lensfolio.jrfank.cc 进入。</p>
        <form action={login}>
          <input name="next" type="hidden" value={returnTo} />
          <label>邮箱<input name="email" type="email" autoComplete="email" required /></label>
          <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
          {error && <div className="login-error" role="alert">{error === "missing" ? "请填写邮箱和密码。" : "邮箱或密码不正确。"}</div>}
          <button type="submit">安全登录</button>
        </form>
      </section>
    </main>
  );
}
