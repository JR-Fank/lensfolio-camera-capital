#!/usr/bin/env node

import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SESSION_PATH = resolve(REPOSITORY_ROOT, ".lensfolio", "session.json");
const SESSION_REFRESH_MARGIN_SECONDS = 60;

function loadLocalEnvironment() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return;
  const environmentPath = resolve(REPOSITORY_ROOT, ".env.local");
  try {
    process.loadEnvFile(environmentPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function authConfiguration(env = process.env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing public Supabase configuration. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to the ignored .env.local file.",
    );
  }
  return { url, key };
}

function newAuthClient(url, key, clientFactory = createClient) {
  return clientFactory(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function persistedSession(session, url) {
  if (!session?.access_token || !session?.refresh_token || !session?.user?.id || !session?.expires_at) {
    throw new Error("Supabase Auth did not return a complete persistent session.");
  }
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user_id: session.user.id,
    supabase_url: url,
  };
}

export async function saveSession(session, options = {}) {
  const sessionPath = options.sessionPath ?? DEFAULT_SESSION_PATH;
  const sessionDirectory = dirname(sessionPath);
  const temporaryPath = `${sessionPath}.${process.pid}.tmp`;
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(sessionDirectory, 0o700);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, sessionPath);
    await chmod(sessionPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function loadSession(options = {}) {
  const sessionPath = options.sessionPath ?? DEFAULT_SESSION_PATH;
  let raw;
  try {
    raw = await readFile(sessionPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("No Lensfolio session found. Run: node scripts/lensfolio-auth.mjs login");
    }
    throw error;
  }

  const session = JSON.parse(raw);
  for (const key of ["access_token", "refresh_token", "expires_at", "user_id", "supabase_url"]) {
    if (!session[key]) throw new Error(`Stored Lensfolio session is invalid: missing ${key}. Please log in again.`);
  }

  const sessionMode = (await stat(sessionPath)).mode & 0o777;
  if ((sessionMode & 0o077) !== 0) await chmod(sessionPath, 0o600);
  const directoryMode = (await stat(dirname(sessionPath))).mode & 0o777;
  if ((directoryMode & 0o077) !== 0) await chmod(dirname(sessionPath), 0o700);
  return session;
}

export function isSessionFresh(session, nowMilliseconds = Date.now()) {
  return Number(session.expires_at) > Math.floor(nowMilliseconds / 1000) + SESSION_REFRESH_MARGIN_SECONDS;
}

export async function getAuthenticatedSession(options = {}) {
  loadLocalEnvironment();
  const env = options.env ?? process.env;
  const { url, key } = authConfiguration(env);
  const clientFactory = options.clientFactory ?? createClient;
  const explicitToken = env.LENSFOLIO_USER_ACCESS_TOKEN;

  if (explicitToken) {
    const client = clientFactory(url, key, {
      global: { headers: { Authorization: `Bearer ${explicitToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.getUser(explicitToken);
    if (error || !data.user) throw new Error(`Explicit debug session is invalid: ${error?.message ?? "user not found"}`);
    return { client, user: data.user, source: "explicit-token" };
  }

  const stored = await loadSession({ sessionPath: options.sessionPath });
  if (stored.supabase_url !== url) {
    throw new Error("Stored Lensfolio session belongs to a different Supabase project. Please log in again.");
  }

  const client = newAuthClient(url, key, clientFactory);
  let authResult;
  let source;
  if (isSessionFresh(stored, options.now?.() ?? Date.now())) {
    authResult = await client.auth.setSession({
      access_token: stored.access_token,
      refresh_token: stored.refresh_token,
    });
    source = "stored-session";
  } else {
    authResult = await client.auth.refreshSession({ refresh_token: stored.refresh_token });
    source = "refreshed-session";
  }

  if (authResult.error || !authResult.data.session || !authResult.data.user) {
    throw new Error(
      `Lensfolio session could not be refreshed or verified. Run login again. ${authResult.error?.message ?? ""}`.trim(),
    );
  }

  const nextSession = persistedSession(authResult.data.session, url);
  if (
    nextSession.access_token !== stored.access_token
    || nextSession.refresh_token !== stored.refresh_token
    || nextSession.expires_at !== stored.expires_at
  ) {
    await saveSession(nextSession, { sessionPath: options.sessionPath });
  }

  return { client, user: authResult.data.user, source, expires_at: nextSession.expires_at };
}

export function chooseWritablePortfolio(memberships, requestedPortfolioId) {
  const writable = memberships.filter((membership) => new Set(["owner", "editor"]).has(membership.role));
  if (requestedPortfolioId) {
    const selected = writable.find((membership) => membership.portfolio_id === requestedPortfolioId);
    if (!selected) throw new Error("Authenticated user is not an owner/editor of the requested portfolio.");
    return selected;
  }
  if (writable.length === 0) throw new Error("Authenticated user has no owner/editor portfolio access.");
  if (writable.length > 1) throw new Error("Multiple writable portfolios found. Select one with --portfolio-id.");
  return writable[0];
}

export async function getAuthenticatedContext(options = {}) {
  const session = await getAuthenticatedSession(options);
  const { data, error } = await session.client
    .from("portfolio_members")
    .select("portfolio_id,role")
    .eq("user_id", session.user.id);
  if (error) throw new Error(`Could not verify portfolio membership: ${error.message}`);
  const membership = chooseWritablePortfolio(data ?? [], options.portfolioId);
  return {
    client: session.client,
    user: session.user,
    portfolioId: membership.portfolio_id,
    role: membership.role,
    sessionSource: session.source,
  };
}

async function promptLine(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive login requires a local TTY.");
  const interfaceInstance = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await interfaceInstance.question(label)).trim();
  } finally {
    interfaceInstance.close();
  }
}

async function promptHidden(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("Sensitive login input requires a local TTY.");
  }
  process.stdout.write(label);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolvePromise, rejectPromise) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onKeypress = (text, key) => {
      if (key?.ctrl && key.name === "c") return finish(new Error("Login cancelled."));
      if (key?.name === "return" || key?.name === "enter") return finish();
      if (key?.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (!key?.ctrl && !key?.meta && text) value += text;
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function login(args) {
  loadLocalEnvironment();
  const { url, key } = authConfiguration();
  const client = newAuthClient(url, key);
  const emailFlagIndex = args.indexOf("--email");
  const email = emailFlagIndex >= 0 ? args[emailFlagIndex + 1] : await promptLine("Owner email: ");
  if (!email) throw new Error("Email is required.");

  let authResult;
  if (args.includes("--otp")) {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) throw error;
    const token = await promptHidden("Email OTP: ");
    authResult = await client.auth.verifyOtp({ email, token, type: "email" });
  } else {
    const password = await promptHidden("Password (not stored): ");
    authResult = await client.auth.signInWithPassword({ email, password });
  }

  if (authResult.error || !authResult.data.session || !authResult.data.user) {
    throw authResult.error ?? new Error("Supabase Auth did not return a session.");
  }

  const { data: memberships, error: membershipError } = await client
    .from("portfolio_members")
    .select("portfolio_id,role")
    .eq("user_id", authResult.data.user.id);
  if (membershipError) throw membershipError;
  const writable = (memberships ?? []).filter((membership) => new Set(["owner", "editor"]).has(membership.role));
  if (writable.length === 0) throw new Error("Authenticated user is not a Lensfolio owner/editor. Session was not saved.");

  await saveSession(persistedSession(authResult.data.session, url));
  console.log(JSON.stringify({
    logged_in: true,
    user_id: authResult.data.user.id,
    writable_portfolios: writable,
    session_path: DEFAULT_SESSION_PATH,
    expires_at: new Date(authResult.data.session.expires_at * 1000).toISOString(),
  }, null, 2));
}

async function status() {
  const session = await getAuthenticatedSession();
  const { data, error } = await session.client
    .from("portfolio_members")
    .select("portfolio_id,role")
    .eq("user_id", session.user.id);
  if (error) throw error;
  console.log(JSON.stringify({
    authenticated: true,
    user_id: session.user.id,
    session_source: session.source,
    expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    memberships: data,
    session_path: session.source === "explicit-token" ? null : DEFAULT_SESSION_PATH,
  }, null, 2));
}

async function logout() {
  try {
    await access(DEFAULT_SESSION_PATH, constants.F_OK);
    await unlink(DEFAULT_SESSION_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  console.log(JSON.stringify({ logged_out: true, session_removed: true }, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "login") return login(args);
  if (command === "status") return status();
  if (command === "logout") return logout();
  throw new Error("Usage: node scripts/lensfolio-auth.mjs <login|status|logout> [--email address] [--otp]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
