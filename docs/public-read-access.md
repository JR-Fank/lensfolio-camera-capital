# Public read access — 本地交付记录

分支：`feat/public-read-access`。未连接或操作 production Supabase，未 commit、push、部署。

## 行为和权限

- 普通页面不再强制登录；`/login`、session cookie 刷新、production `.vercel.app` 到 `lensfolio.jrfank.cc` 的 308 canonical redirect 保留。
- 页面读取使用公开 publishable key；匿名及已登录但无 membership 的访客使用不携带 session cookie 的 anon client。owner/editor/viewer 继续使用原有 session/RLS。
- 应用保持唯一 portfolio 的既有前提。migration 的 anon SELECT 策略公开白名单业务列，不引入按 portfolio 切换或新的业务 schema。
- 匿名及 viewer 的变更 API 在服务端拒绝。请求中的 `oai-authenticated-user-*` 头不能作为写权限凭据。
- owner/editor 的目标 portfolio 权限仍由既有 RLS/RPC 检查。旧 D1 写接口继续遵守现有 migration protection，不解除原有 423 冻结。
- 研究页面不序列化创建者/确认者 ID、原始 metadata、去重指纹或原始错误日志。匿名物流读取不开放原始错误日志。
- 维修页和买入决策页从空基线改为 Supabase 读取；维修表没有提供的前后估值保持 null，不补造数值。
- 未更改财务、成本、ROI、物流退款、资金账本或估值算法；未修改历史 migration。

## Migration

`supabase/migrations/20260907000100_public_read_access.sql`

21 张表只授予明确列的 SELECT，同时添加仅对 anon 生效的 SELECT RLS policy：

| 用途 | 表 |
| --- | --- |
| Portfolio 定位 | portfolios（仅 id） |
| 资产与采购 | assets、asset_status_events、purchase_orders、purchase_items |
| 成本、销售、维修 | cost_entries、sales、repairs |
| 物流展示和估算输入 | shipments、shipment_items、tracking_events、tracking_sync_runs、logistics_reference_samples |
| 估值与研究展示 | market_sources、valuation_snapshots、valuation_research_runs、market_listings |
| 资金账本及视图依赖 | funding_participants、funding_accounts、funding_transactions、funding_allocations |

5 个现有视图可 SELECT，保持 `security_invoker = true`，不改视图计算：
`asset_financials`、`portfolio_metrics`、`funding_account_balances`、`funding_participant_contributions`、`sales_proceeds_pool_balances`。

匿名没有任何公开表的 INSERT/UPDATE/DELETE/TRUNCATE、sequence 权限或 public/private 函数 EXECUTE。
撤销 PUBLIC 继承的函数执行权限，并关闭 migration 执行角色未来在这两个 schema 中创建函数时的默认 PUBLIC/anon EXECUTE。
不开放 portfolio_members、profiles、audit_logs、attachments、funding_transaction_balances、auth.users，或白名单表中的 auth 身份字段、原始证据/metadata/错误日志。

## API 审核范围

- POST/PATCH `/api/cameras`
- POST `/api/expenses`、`/api/logistics`、`/api/logistics/refresh`、`/api/logistics/refresh-due`、`/api/repairs`、`/api/sales`、`/api/valuations`、`/api/valuations/confirm`
- POST/PATCH/DELETE `/api/valuations/research`
- 新增资产 server action 原有 `canWrite` 检查保留并验证匿名拒绝。

共 13 个变更 route handler，匿名 401、viewer 403 均在解析 body 或触发副作用前返回。

## 验证与复现

```sh
git diff --check
node --test tests/lensfolio-auth.test.mjs
node --test tests/manual-tracking-refresh.test.mjs
npx tsc --noEmit
node --test tests/capital-ledger-ui.test.mjs tests/xianyu-valuation.test.mjs

# 临时依赖安装在仓库之外，不更改项目依赖。
npm install --prefix /tmp/lensfolio-public-access-test --no-package-lock --no-audit --no-fund @electric-sql/pglite@0.5.8
LENSFOLIO_PGLITE_MODULE=/tmp/lensfolio-public-access-test/node_modules/@electric-sql/pglite/dist/index.js node --test tests/public-access.test.mjs
```

结果：auth 9/9；tracking 16/16；public access 12/12；capital + xianyu 41/41；TypeScript 和 diff 检查通过。

Public access 测试在本地 PGlite PostgreSQL WASM 中执行全部原始 migration 和新增 migration。
使用合成数据及最小 auth.uid 接口，验证实际 SQL 权限、全部 public RPC 的匿名执行拒绝、owner/editor 实际 DML 和采购 RPC、viewer 写入拒绝、既有 authenticated policy 完全不变。
实际页面读取函数使用受 PostgreSQL 权限约束的 query transport；执行 11 个 server page 的数据装配，断言只读 props 中无 auth/session 信息。框架客户端组件被替换，未进行浏览器布局、hydration、线上 PostgREST 或 production 数据验证。

## Production 尚需执行

1. 确认 production migration history 已包含本分支此前的 migration；不要顺带执行其他未审查 migration 或任何 repair/bootstrap RPC。
2. 应用且仅应用新增 `20260907000100_public_read_access.sql`。
3. 部署对应应用改动。先数据库权限、后公开读取应用，避免新页面遇到旧 anon SELECT 拒绝。
4. 部署后验证公开 URL、匿名拒写、授权用户权限和 canonical redirect。当前交付不代表这些 production 验证已执行。

## 修改文件

- `app/ManagementApp.tsx`
- `app/api/_shared.ts`
- `app/api/cameras/route.ts`
- `app/api/dashboard/route.ts`
- `app/api/expenses/route.ts`
- `app/api/logistics/refresh-due/route.ts`
- `app/api/logistics/refresh/route.ts`
- `app/api/logistics/route.ts`
- `app/api/repairs/route.ts`
- `app/api/sales/route.ts`
- `app/api/valuations/confirm/route.ts`
- `app/api/valuations/research/route.ts`
- `app/api/valuations/route.ts`
- `app/buy-decision/page.tsx`
- `app/cameras/[id]/valuation/research/[runId]/page.tsx`
- `app/cameras/[id]/valuation/research/page.tsx`
- `app/repairs/page.tsx`
- `db/queries.ts`
- `docs/public-read-access.md`
- `lib/supabase/capital-ledger.ts`
- `lib/supabase/dashboard.ts`
- `lib/supabase/portfolio-access.ts`
- `lib/supabase/proxy.ts`
- `lib/supabase/server.ts`
- `lib/supabase/valuations.ts`
- `lib/supabase/write-access.ts`
- `supabase/migrations/20260907000100_public_read_access.sql`
- `tests/capital-ledger-ui.test.mjs`
- `tests/public-access.test.mjs`
- `tests/xianyu-valuation.test.mjs`
