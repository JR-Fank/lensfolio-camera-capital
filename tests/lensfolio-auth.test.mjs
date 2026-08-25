import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chooseWritablePortfolio,
  getAuthenticatedContext,
  getAuthenticatedSession,
  isSessionFresh,
  loadSession,
  saveSession,
} from "../scripts/lensfolio-auth.mjs";

const PUBLIC_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://fixture-project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key",
};
const USER_ID = "70000000-0000-4000-8000-000000000001";
const PORTFOLIO_ID = "70000000-0000-4000-8000-000000000002";

async function temporarySessionPath() {
  const directory = await mkdtemp(join(tmpdir(), "lensfolio-auth-test-"));
  return join(directory, ".lensfolio", "session.json");
}

function storedSession(expiresAt) {
  return {
    access_token: "fixture-access-token",
    refresh_token: "fixture-refresh-token",
    expires_at: expiresAt,
    user_id: USER_ID,
    supabase_url: PUBLIC_ENV.NEXT_PUBLIC_SUPABASE_URL,
  };
}

function authClientFactory({ refreshedSession, refreshError, memberships = [] } = {}) {
  const calls = { setSession: 0, refreshSession: 0 };
  const user = { id: USER_ID };
  const client = {
    auth: {
      async setSession(session) {
        calls.setSession += 1;
        return {
          data: {
            session: {
              ...session,
              expires_at: refreshedSession?.expires_at ?? 4102444800,
              user,
            },
            user,
          },
          error: null,
        };
      },
      async refreshSession() {
        calls.refreshSession += 1;
        if (refreshError) return { data: { session: null, user: null }, error: new Error(refreshError) };
        const session = refreshedSession ?? {
          access_token: "fixture-refreshed-access-token",
          refresh_token: "fixture-refreshed-refresh-token",
          expires_at: 4102444800,
          user,
        };
        return { data: { session, user }, error: null };
      },
    },
    from(table) {
      assert.equal(table, "portfolio_members");
      return {
        select() {
          return {
            async eq(column, value) {
              assert.equal(column, "user_id");
              assert.equal(value, USER_ID);
              return { data: memberships, error: null };
            },
          };
        },
      };
    },
  };
  return { calls, factory: () => client };
}

test("missing local session asks for one-time login", async () => {
  const sessionPath = await temporarySessionPath();
  await assert.rejects(
    getAuthenticatedSession({ env: PUBLIC_ENV, sessionPath }),
    /lensfolio-auth\.mjs login/,
  );
});

test("session file and directory are restricted to the current user", async () => {
  const sessionPath = await temporarySessionPath();
  await saveSession(storedSession(4102444800), { sessionPath });
  assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(sessionPath, ".."))).mode & 0o777, 0o700);
  const saved = JSON.parse(await readFile(sessionPath, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), [
    "access_token",
    "expires_at",
    "refresh_token",
    "supabase_url",
    "user_id",
  ]);
  assert.equal("password" in saved, false);
});

test("fresh access token is restored without explicit refresh", async () => {
  const sessionPath = await temporarySessionPath();
  await saveSession(storedSession(4102444800), { sessionPath });
  const mock = authClientFactory();
  const result = await getAuthenticatedSession({
    env: PUBLIC_ENV,
    sessionPath,
    clientFactory: mock.factory,
    now: () => 1700000000000,
  });
  assert.equal(result.user.id, USER_ID);
  assert.equal(result.source, "stored-session");
  assert.equal(mock.calls.setSession, 1);
  assert.equal(mock.calls.refreshSession, 0);
});

test("expired access token refreshes and rotates the persisted session", async () => {
  const sessionPath = await temporarySessionPath();
  await saveSession(storedSession(1), { sessionPath });
  const refreshedSession = {
    access_token: "fixture-new-access-token",
    refresh_token: "fixture-new-refresh-token",
    expires_at: 4102444800,
    user: { id: USER_ID },
  };
  const mock = authClientFactory({ refreshedSession });
  const result = await getAuthenticatedSession({
    env: PUBLIC_ENV,
    sessionPath,
    clientFactory: mock.factory,
    now: () => 1700000000000,
  });
  const saved = await loadSession({ sessionPath });
  assert.equal(result.source, "refreshed-session");
  assert.equal(mock.calls.refreshSession, 1);
  assert.equal(saved.access_token, "fixture-new-access-token");
  assert.equal(saved.refresh_token, "fixture-new-refresh-token");
});

test("refresh failure requires login and never falls back to a secret key", async () => {
  const sessionPath = await temporarySessionPath();
  await saveSession(storedSession(1), { sessionPath });
  const mock = authClientFactory({ refreshError: "refresh rejected" });
  await assert.rejects(
    getAuthenticatedSession({
      env: { ...PUBLIC_ENV, SUPABASE_SECRET_KEY: "must-not-be-used" },
      sessionPath,
      clientFactory: mock.factory,
      now: () => 1700000000000,
    }),
    /Run login again/,
  );
});

test("session freshness uses a safety margin before expiry", () => {
  assert.equal(isSessionFresh({ expires_at: 1061 }, 1000000), true);
  assert.equal(isSessionFresh({ expires_at: 1060 }, 1000000), false);
});

test("owner/editor portfolios are accepted and viewer is rejected", () => {
  assert.equal(
    chooseWritablePortfolio([{ portfolio_id: PORTFOLIO_ID, role: "owner" }]).portfolio_id,
    PORTFOLIO_ID,
  );
  assert.equal(
    chooseWritablePortfolio([{ portfolio_id: PORTFOLIO_ID, role: "editor" }]).role,
    "editor",
  );
  assert.throws(
    () => chooseWritablePortfolio([{ portfolio_id: PORTFOLIO_ID, role: "viewer" }]),
    /no owner\/editor/,
  );
});

test("authenticated context identifies the writable portfolio through RLS session", async () => {
  const sessionPath = await temporarySessionPath();
  await saveSession(storedSession(4102444800), { sessionPath });
  const mock = authClientFactory({ memberships: [{ portfolio_id: PORTFOLIO_ID, role: "owner" }] });
  const context = await getAuthenticatedContext({
    env: PUBLIC_ENV,
    sessionPath,
    clientFactory: mock.factory,
    now: () => 1700000000000,
  });
  assert.equal(context.user.id, USER_ID);
  assert.equal(context.portfolioId, PORTFOLIO_ID);
  assert.equal(context.role, "owner");
});

test("session storage is ignored and evidence scripts use the auth helper", async () => {
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  const purchaseScript = await readFile(new URL("../scripts/import-purchase-evidence.mjs", import.meta.url), "utf8");
  const logisticsScript = await readFile(new URL("../scripts/import-logistics-evidence.mjs", import.meta.url), "utf8");
  assert.match(gitignore, /^\/\.lensfolio\/$/m);
  assert.match(purchaseScript, /getAuthenticatedContext/);
  assert.match(logisticsScript, /getAuthenticatedContext/);
  assert.doesNotMatch(purchaseScript, /LENSFOLIO_USER_ACCESS_TOKEN/);
  assert.doesNotMatch(logisticsScript, /LENSFOLIO_USER_ACCESS_TOKEN/);
});
