import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
const migrationMessage = "System is under migration protection.";
const authHeaders = {
  "Content-Type": "application/json",
  "oai-authenticated-user-id": "test-user",
  "oai-authenticated-user-email": "test@example.com",
};
let normalRuntime;
let protectedRuntime;

async function freePort() {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(runtime) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(runtime.baseUrl);
      if (response.ok) return;
    } catch {
      // The worker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Test worker did not start.\n${runtime.logs}`);
}

async function startTestWorker(readOnly) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), `lensfolio-d1-${readOnly ? "protected" : "normal"}-`));
  execFileSync(wrangler, [
    "d1", "execute", "DB", "--local",
    "--config", "dist/server/wrangler.json",
    "--persist-to", stateDirectory,
    "--file", "drizzle/0000_useful_longshot.sql",
  ], { cwd: root, stdio: "ignore" });
  execFileSync(wrangler, [
    "d1", "execute", "DB", "--local",
    "--config", "dist/server/wrangler.json",
    "--persist-to", stateDirectory,
    "--file", "drizzle/0001_fantastic_trauma.sql",
  ], { cwd: root, stdio: "ignore" });

  const port = await freePort();
  const runtime = {
    baseUrl: `http://127.0.0.1:${port}`,
    logs: "",
    server: spawn(wrangler, [
    "dev", "--local",
    "--config", "dist/server/wrangler.json",
    "--persist-to", stateDirectory,
    "--port", String(port),
    "--var", `MIGRATION_READ_ONLY:${readOnly}`,
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }),
    stateDirectory,
  };
  runtime.server.stdout.on("data", (chunk) => { runtime.logs += chunk.toString(); });
  runtime.server.stderr.on("data", (chunk) => { runtime.logs += chunk.toString(); });
  await waitForServer(runtime);
  return runtime;
}

async function stopTestWorker(runtime) {
  if (!runtime) return;
  if (runtime.server.exitCode === null) {
    runtime.server.kill("SIGTERM");
    await new Promise((resolve) => runtime.server.once("exit", resolve));
  }
  await rm(runtime.stateDirectory, { recursive: true, force: true });
}

before(async () => {
  normalRuntime = await startTestWorker(false);
  protectedRuntime = await startTestWorker(true);
});

after(async () => {
  await Promise.all([stopTestWorker(normalRuntime), stopTestWorker(protectedRuntime)]);
});

test("server-renders the database-backed investor dashboard", async () => {
  const response = await fetch(normalRuntime.baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Lensfolio · 相机投资管理系统<\/title>/i);
  assert.match(html, /总投入资金/);
  assert.match(html, /¥13,831/);
  assert.match(html, /当前市场估值/);
  assert.match(html, /¥17,250/);
  assert.match(html, /资金占比分布/);
  assert.match(html, /ROI 排行/);
  assert.match(html, /Contax/);
  assert.match(html, /＋ 新增机器/);
  assert.doesNotMatch(html, /Migration Protection Mode/);
  assert.doesNotMatch(html, /localStorage|seedCameras|SkeletonPreview/i);
});

test("server-renders logistics and record-specific asset details", async () => {
  const logistics = await fetch(`${normalRuntime.baseUrl}/logistics`);
  assert.equal(logistics.status, 200);
  const logisticsHtml = await logistics.text();
  assert.match(logisticsHtml, /EN533720370JP/);
  assert.match(logisticsHtml, /香港领取点待取/);
  assert.match(logisticsHtml, /EMS 平均成本 \/ kg/);

  const detail = await fetch(`${normalRuntime.baseUrl}/cameras/nikon-28ti`);
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /<title>Nikon 28Ti · 相机投资档案<\/title>/i);
  assert.match(detailHtml, /¥6,603/);
  assert.match(detailHtml, /机器档案/);

  const buyDecision = await fetch(`${normalRuntime.baseUrl}/buy-decision`);
  assert.equal(buyDecision.status, 200);
  const buyDecisionHtml = await buyDecision.text();
  assert.match(buyDecisionHtml, /建议最高买入/);
  assert.match(buyDecisionHtml, /偏贵，不建议/);
});

test("packages persistence migration, scheduled refresh, and social artwork", async () => {
  const workerConfig = JSON.parse(await readFile(path.join(root, "dist/server/wrangler.json"), "utf8"));
  assert.equal(workerConfig.d1_databases[0].binding, "DB");
  assert.deepEqual(workerConfig.triggers.crons, ["0 1 * * *"]);
  await access(path.join(root, "dist/.openai/drizzle/0000_useful_longshot.sql"));
  await access(path.join(root, "dist/.openai/drizzle/0001_fantastic_trauma.sql"));
  await access(path.join(root, "public/og-system.png"));
  await assert.rejects(access(path.join(root, "app/data.ts")));
});

test("rejects anonymous writes when protection is disabled", async () => {
  const response = await fetch(`${normalRuntime.baseUrl}/api/expenses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required." });
});

test("returns 423 from every write API in migration protection mode", async () => {
  const writes = [
    ["POST", "/api/cameras"],
    ["PATCH", "/api/cameras"],
    ["POST", "/api/logistics"],
    ["POST", "/api/logistics/refresh"],
    ["POST", "/api/logistics/refresh-due"],
    ["POST", "/api/repairs"],
    ["POST", "/api/expenses"],
    ["POST", "/api/valuations"],
    ["POST", "/api/sales"],
  ];

  for (const [method, pathname] of writes) {
    const response = await fetch(`${protectedRuntime.baseUrl}${pathname}`, {
      method,
      headers: authHeaders,
      body: "{}",
    });
    assert.equal(response.status, 423, `${method} ${pathname}`);
    assert.deepEqual(await response.json(), { error: migrationMessage }, `${method} ${pathname}`);
  }
});

test("renders migration state and removes all existing write controls", async () => {
  const pages = ["/", "/assets", "/logistics", "/repairs", "/sales", "/cameras/nikon-28ti"];
  const html = (await Promise.all(pages.map(async (pathname) => {
    const response = await fetch(`${protectedRuntime.baseUrl}${pathname}`);
    assert.equal(response.status, 200, pathname);
    return response.text();
  }))).join("\n");

  assert.match(html, /Migration Protection Mode/);
  assert.match(html, /System is under migration protection\./);
  for (const label of [
    "＋ 新增机器", "＋ 新增物流单", "立即同步", "＋ 新增维修记录",
    "＋ 记录出售", "＋ 更新估价", "更新状态", "＋ 其他费用", "记录出售",
  ]) {
    assert.doesNotMatch(html, new RegExp(label), label);
  }
});

test("exits the scheduled handler before database work in protection mode", async () => {
  const builtWorker = (await import(pathToFileURL(path.join(root, "dist/server/index.js")).href)).default;
  let backgroundWorkStarted = false;
  const databaseThatMustNotBeRead = new Proxy({}, {
    get() {
      throw new Error("Protected scheduled handler accessed D1");
    },
  });

  await builtWorker.scheduled({}, {
    DB: databaseThatMustNotBeRead,
    MIGRATION_READ_ONLY: "true",
  }, {
    waitUntil() {
      backgroundWorkStarted = true;
    },
  });

  assert.equal(backgroundWorkStarted, false);
});

test("keeps authenticated writes working when protection is disabled", async () => {
  const response = await fetch(`${normalRuntime.baseUrl}/api/expenses`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      cameraId: "nikon-28ti",
      expenseDate: "2026-08-21",
      category: "测试",
      amountCny: 1,
      notes: "normal mode protection test",
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });

  const dashboard = await fetch(`${normalRuntime.baseUrl}/api/dashboard`).then((result) => result.json());
  assert.equal(dashboard.expenses.some((expense) => expense.notes === "normal mode protection test"), true);
});
