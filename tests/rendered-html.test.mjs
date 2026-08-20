import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Lensfolio portfolio dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Lensfolio · 相机投资组合<\/title>/i);
  assert.match(html, /预计全部落地/);
  assert.match(html, /¥14,061/);
  assert.match(html, /物流分析/);
  assert.match(html, /出售前，先算清/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/i);
});

test("server-renders record-specific asset details and metadata", async () => {
  const response = await render("/cameras/nikon-28ti");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Nikon 28Ti · 相机资产详情<\/title>/i);
  assert.match(html, /Nikon 28Ti 的采购成本、物流节点、落地成本与潜在回报。/);
  assert.match(html, /¥6,603/);
  assert.match(html, /航空解禁通过/);
  assert.doesNotMatch(html, /og\.png/);
});

test("removes the disposable starter preview", async () => {
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("public/og.png", templateRoot));
});
