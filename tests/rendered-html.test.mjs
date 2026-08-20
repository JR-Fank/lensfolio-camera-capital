import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
let baseUrl = "";
let server;
let stateDirectory = "";
let serverLogs = "";

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

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The worker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Test worker did not start.\n${serverLogs}`);
}

before(async () => {
  stateDirectory = await mkdtemp(path.join(os.tmpdir(), "lensfolio-d1-test-"));
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
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(wrangler, [
    "dev", "--local",
    "--config", "dist/server/wrangler.json",
    "--persist-to", stateDirectory,
    "--port", String(port),
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (chunk) => { serverLogs += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverLogs += chunk.toString(); });
  await waitForServer(baseUrl);
});

after(async () => {
  server?.kill("SIGTERM");
  if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
});

test("server-renders the database-backed investor dashboard", async () => {
  const response = await fetch(baseUrl);
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
  assert.doesNotMatch(html, /localStorage|seedCameras|SkeletonPreview/i);
});

test("server-renders logistics and record-specific asset details", async () => {
  const logistics = await fetch(`${baseUrl}/logistics`);
  assert.equal(logistics.status, 200);
  const logisticsHtml = await logistics.text();
  assert.match(logisticsHtml, /EN533720370JP/);
  assert.match(logisticsHtml, /香港领取点待取/);
  assert.match(logisticsHtml, /EMS 平均成本 \/ kg/);

  const detail = await fetch(`${baseUrl}/cameras/nikon-28ti`);
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /<title>Nikon 28Ti · 相机投资档案<\/title>/i);
  assert.match(detailHtml, /¥6,603/);
  assert.match(detailHtml, /机器档案/);

  const buyDecision = await fetch(`${baseUrl}/buy-decision`);
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
