// Run with an isolated PostgreSQL WASM runtime (no Supabase connection or keys):
// npm install --prefix /tmp/lensfolio-public-access-test --no-package-lock @electric-sql/pglite
// LENSFOLIO_PGLITE_MODULE=/tmp/lensfolio-public-access-test/node_modules/@electric-sql/pglite/dist/index.js node --test tests/public-access.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { before, after, test } from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { PGlite } = await import(process.env.LENSFOLIO_PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const portfolio = 'c9392708-c769-5f74-9587-b3071bc354bd';
const otherPortfolio = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb0';
const asset = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
const otherAsset = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb1';
const runId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2';
const sourceId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa3';
const shipment = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa4';
const users = { owner: '11111111-1111-1111-1111-111111111111', editor: '22222222-2222-2222-2222-222222222222', viewer: '33333333-3333-3333-3333-333333333333' };
let currentUser = null;
const migration = readFileSync(resolve(root, 'supabase/migrations/20260907000100_public_read_access.sql'), 'utf8');
let writerPolicies;
let authenticatedPrivileges;

async function privilegeSnapshot() {
  const tables = (await db.query(`
    select
      tablename,
      has_table_privilege('authenticated', 'public.' || tablename, 'SELECT') as sel,
      has_table_privilege('authenticated', 'public.' || tablename, 'INSERT') as ins,
      has_table_privilege('authenticated', 'public.' || tablename, 'UPDATE') as upd,
      has_table_privilege('authenticated', 'public.' || tablename, 'DELETE') as del
    from pg_tables
    where schemaname = 'public'
    order by tablename
  `)).rows;

  const functions = (await db.query(`
    select
      n.nspname,
      p.oid::regprocedure::text as signature,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as execute
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private')
    order by n.nspname, signature
  `)).rows;

  return { tables, functions };
}

async function role(name) {
  currentUser = users[name] || null;
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [currentUser || '']);
  await db.exec(`set role ${name === 'anon' ? 'anon' : 'authenticated'}`);
}
const policySnapshot = () => db.query("select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where 'authenticated' = any(roles) order by tablename,policyname");

before(async () => {
  // Only the Supabase auth interface is stubbed; tables, views, functions and RLS
  // below are the unmodified repository migrations executed by PostgreSQL.
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;`);
  const files = (await readdir(resolve(root, 'supabase/migrations'))).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (file === '20260907000100_public_read_access.sql') {
      writerPolicies = (await policySnapshot()).rows;
      authenticatedPrivileges = await privilegeSnapshot();
    }
    try { await db.exec(readFileSync(resolve(root, 'supabase/migrations', file), 'utf8')); }
    catch (e) { throw new Error(`Migration ${file}: ${e.message}`, { cause: e }); }
  }
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users(id) values ($1)', [id]);
    if (name === 'owner') await db.query('insert into public.portfolios(id,name,created_by) values ($1,$2,$3)', [portfolio, 'Public fixture', id]);
    await db.query('insert into public.portfolio_members(portfolio_id,user_id,role,created_by) values ($1,$2,$3,$4)', [portfolio,id,name,users.owner]);
  }
  await db.query(
    'insert into public.portfolios(id,name,created_by) values ($1,$2,$3)',
    [otherPortfolio, 'Private fixture', users.owner],
  );
  await db.query(`insert into assets(id,portfolio_id,brand,model,created_by) values ($1,$2,'Contax','T2',$3)`, [asset,portfolio,users.owner]);
  await db.query(`insert into assets(id,portfolio_id,brand,model,created_by) values ($1,$2,'Private','Hidden asset',$3)`, [otherAsset,otherPortfolio,users.owner]);
  const soldAsset = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa5';
  await db.query(`insert into assets(id,portfolio_id,brand,model,created_by) values ($1,$2,'Fixture','Sold asset',$3)`, [soldAsset,portfolio,users.owner]);
  await db.query(`insert into sales(portfolio_id,asset_id,status,sold_price_cny,sold_at,created_by) values ($1,$2,'sold',200,'2026-09-01T00:00:00Z',$3)`, [portfolio,soldAsset,users.owner]);
  await db.query(`insert into market_sources(id,portfolio_id,name,created_by) values ($1,$2,'Fixture market',$3)`, [sourceId,portfolio,users.owner]);
  await db.query(`insert into valuation_research_runs(id,portfolio_id,asset_id,market_source_id,created_by) values ($1,$2,$3,$4,$5)`, [runId,portfolio,asset,sourceId,users.owner]);
  await db.query(`insert into market_listings(portfolio_id,asset_id,market_source_id,research_run_id,title,asking_price,observed_at,listing_fingerprint,metadata,created_by)
    values ($1,$2,$3,$4,'Contax T2 fixture',1000,now(),'fixture','{"private":"must not be returned"}',$5)`, [portfolio,asset,sourceId,runId,users.owner]);
  await db.query(`insert into shipments(id,portfolio_id,carrier,created_by) values ($1,$2,'Japan Post',$3)`, [shipment,portfolio,users.owner]);
  await db.query(`insert into repairs(portfolio_id,asset_id,description,amount_cny,created_by) values ($1,$2,'Fixture repair',123,$3)`, [portfolio,asset,users.owner]);
  await db.query(`insert into funding_participants(portfolio_id,user_id,display_name,created_by) values ($1,$2,'Partner fixture',$2)`, [portfolio,users.owner]);
});
after(async () => { await db.close(); });

// Load the actual TypeScript modules with only framework/transport seams replaced.
function loadModule(file, overrides = {}, cache = new Map()) {
  const path = resolve(root, file);
  if (path in overrides) return overrides[path];
  if (cache.has(path)) return cache.get(path);
  const module = { exports: {} }; cache.set(path, module.exports);
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const localRequire = spec => {
    if (spec in overrides) return overrides[spec];
    if (spec === 'server-only') return {};
    if (spec === 'react') return { ...require('react'), cache: fn => fn };
    if (spec.startsWith('.')) {
      const base = resolve(dirname(path), spec);
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`].find(p => existsSync(p) && statSync(p).isFile());
      if (target in overrides) return overrides[target];
      return loadModule(target, overrides, cache);
    }
    return require(spec);
  };
  runInNewContext(output, { module, exports: module.exports, require: localRequire, process, console, URL, Request, Response, Headers, Date, crypto, setTimeout, clearTimeout, fetch: () => { throw new Error('Unexpected network access'); } }, { filename: path });
  return module.exports;
}

// Supabase query-builder transport backed by real PostgreSQL role/column checks.
const identifier = value => { assert.match(value, /^[a-z_][a-z_0-9]*$/i); return `"${value}"`; };
function client() {
  return {
    auth: { getUser: async () => ({ data: { user: currentUser ? { id: currentUser } : null }, error: null }) },
    from(table) {
      const filters = [], params = [], orders = [];
      let columns, limit, offset = 0, single = false;
      const param = v => { params.push(v); return `$${params.length}`; };
      const query = {
        select(c) { columns = c; return this; },
        eq(k,v) { filters.push(`${identifier(k)} = ${param(v)}`); return this; },
        in(k,vs) { filters.push(`${identifier(k)} in (${vs.map(param).join(',')})`); return this; },
        not(k,op,v) { assert.equal(op, 'is'); assert.equal(v,null); filters.push(`${identifier(k)} is not null`); return this; },
        order(k,options = {}) { orders.push(`${identifier(k)} ${options.ascending === false ? 'desc' : 'asc'}${options.nullsFirst === false ? ' nulls last' : ''}`); return this; },
        limit(n) { limit = n; return this; },
        range(a,b) { offset = a; limit = b-a+1; return this; },
        single() { single = true; return this; },
        maybeSingle() { single = true; return this; },
        async then(yes,no) {
          try {
            const sql = `select ${columns.split(',').map(identifier).join(',')} from public.${identifier(table)}${filters.length ? ' where '+filters.join(' and ') : ''}${orders.length ? ' order by '+orders.join(',') : ''}${limit !== undefined ? ' limit '+limit : ''}${offset ? ' offset '+offset : ''}`;
            const result = await db.query(sql, params);
            // PostgREST transports timestamps as JSON strings, unlike the native driver.
            const rows = JSON.parse(JSON.stringify(result.rows));
            return yes({ data: single ? rows[0] ?? null : rows, error: null });
          } catch (error) { return yes({ data: null, error }); }
        },
      };
      return query;
    },
  };
}
const server = () => ({ createClient: async () => client(), createPublicClient: () => client() });
function modules() {
  const overrides = { [resolve(root,'lib/supabase/server.ts')]: server(), 'next/navigation': { redirect: () => { throw new Error('Unexpected login redirect'); } } };
  const access = loadModule('lib/supabase/portfolio-access.ts', overrides);
  overrides[resolve(root,'lib/supabase/portfolio-access.ts')] = access;
  return { access, overrides, dashboard: loadModule('lib/supabase/dashboard.ts', overrides) };
}

test('anonymous proxy continues all ordinary/read-only routes, keeps canonical 308 and refreshes cookies', async () => {
  const environment = process.env.VERCEL_ENV;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.invalid';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'public-fixture';
  let claimsCalls = 0;
  const proxy = loadModule('lib/supabase/proxy.ts', {
    '@supabase/ssr': { createServerClient: (_url,_key,options) => ({ auth: { getClaims: async () => {
      claimsCalls++; options.cookies.setAll([{name:'refresh-fixture',value:'ok',options:{httpOnly:true}}], {}); return {data:null};
    } } }) },
  });
  const { NextRequest } = require('next/server');
  try {
    process.env.VERCEL_ENV = 'preview';
    for (const path of ['/', '/assets', `/cameras/${asset}`, '/logistics', '/capital', '/sales', '/analysis', '/repairs', '/buy-decision', `/cameras/${asset}/valuation/research`, `/cameras/${asset}/valuation/research/${runId}`, '/login']) {
      const response = await proxy.updateSession(new NextRequest(`https://lensfolio.jrfank.cc${path}`));
      assert.equal(response.headers.get('location'), null, path);
      assert.equal(response.headers.get('x-middleware-next'), '1');
      assert.match(response.headers.get('set-cookie'), /refresh-fixture=ok/);
    }
    assert.equal(claimsCalls,12);
    process.env.VERCEL_ENV = 'production';
    const response = await proxy.updateSession(new NextRequest('https://fixture.vercel.app/assets?sort=date', {headers:{host:'fixture.vercel.app'}}));
    assert.equal(response.status,308);
    assert.equal(response.headers.get('location'),'https://lensfolio.jrfank.cc/assets?sort=date');
  } finally {
    for (const [k,v] of Object.entries({VERCEL_ENV:environment,NEXT_PUBLIC_SUPABASE_URL:url,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:key})) v === undefined ? delete process.env[k] : process.env[k] = v;
  }
});

test('migration leaves every existing authenticated policy unchanged', async () => {
  assert.deepEqual((await policySnapshot()).rows, writerPolicies);
});

test('migration preserves authenticated table privileges and explicit app RPC access', async () => {
  const after = await privilegeSnapshot();

  assert.deepEqual(after.tables, authenticatedPrivileges.tables);

  for (const signature of [
    'create_asset_with_purchase(uuid,text,text,date,numeric,text,integer,text,asset_operational_status,text,numeric,numeric,text,text)',
    'complete_manual_tracking_sync(uuid,uuid,timestamp with time zone,jsonb)',
    'confirm_valuation_research_run(uuid)',
  ]) {
    const fn = after.functions.find(
      row => row.nspname === 'public' && row.signature === signature
    );
    assert.ok(fn, signature);
    assert.equal(fn.execute, true, signature);
  }
});

test('anon executes actual dashboard, asset, logistics, capital, repair and research readers against migrated PostgreSQL', async () => {
  await role('anon');
  const { access, overrides, dashboard } = modules();
  assert.equal((await access.getPortfolioAccess()).canWrite, false);
  assert.ok((await dashboard.getSupabaseDashboardData()).assets.some(a => a.model === 'T2'));
  assert.equal((await dashboard.getSupabaseAssetDetailData(asset)).assets[0].id, asset);
  assert.equal((await dashboard.getSupabaseLogisticsData()).logistics.length, 1);
  const repair = (await dashboard.getSupabaseRepairsData()).repairs[0];
  assert.equal(repair.costCny,123); assert.equal(repair.valueChangeCny,null);
  const capital = loadModule('lib/supabase/capital-ledger.ts', overrides);
  assert.ok(await capital.getCapitalLedgerData());
  const valuations = loadModule('lib/supabase/valuations.ts', overrides);
  const run = await valuations.getValuationResearchRun(client(),runId);
  const listings = await valuations.getValuationResearchListings(client(),runId);
  assert.equal(run.id,runId); assert.equal(listings[0].asking_price,'1000.00');
  const payload = JSON.stringify({run,listings});
  for (const forbidden of ['created_by','confirmed_by','metadata','listing_fingerprint',users.owner,'must not be returned']) assert.ok(!payload.includes(forbidden),forbidden);
});

test('anonymous reads are isolated to the published Lensfolio portfolio', async () => {
  await role('anon');
  const portfolios = (await db.query('select id from public.portfolios order by id')).rows;
  assert.deepEqual(portfolios.map(row => row.id), [portfolio]);

  const assets = (await db.query('select id,portfolio_id from public.assets order by id')).rows;
  assert.ok(assets.some(row => row.id === asset));
  assert.ok(!assets.some(row => row.id === otherAsset));
  assert.ok(assets.every(row => row.portfolio_id === portfolio));
});

test('anon has only the explicit SELECT columns; identity tables and internal columns stay inaccessible', async () => {
  await role('anon');
  const grants = [...migration.matchAll(/grant select \(([^)]+)\) on public\.([a-z_]+) to anon;/g)];
  assert.ok(grants.length >= 20);
  for (const [,columns,table] of grants) await db.query(`select ${columns} from public.${table} limit 1`);
  for (const table of ['portfolio_members','profiles','audit_logs','attachments','funding_transaction_balances']) {
    await assert.rejects(db.query(`select * from public.${table}`), {code:'42501'}, table);
  }
  await assert.rejects(db.query('select * from auth.users'), {code:'42501'});
  for (const [table,column] of [['portfolios','created_by'],['assets','created_by'],['funding_participants','user_id'],['valuation_research_runs','confirmed_by'],['market_listings','metadata'],['logistics_reference_samples','evidence']]) {
    await assert.rejects(db.query(`select ${column} from public.${table}`), {code:'42501'}, `${table}.${column}`);
  }
  const internalGrants = await db.query(`select table_name,column_name from information_schema.column_privileges where grantee='anon' and column_name in ('user_id','created_by','confirmed_by','actor_id','metadata','evidence','error_message')`);
  assert.deepEqual(internalGrants.rows,[]);
});

test('anon cannot INSERT/UPDATE/DELETE/TRUNCATE any public table or execute any public RPC', async () => {
  await role('anon');
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
  for (const {tablename} of tables) {
    const first = (await db.query("select attname from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum limit 1", [`public.${tablename}`])).rows[0].attname;
    for (const sql of [`insert into public.${tablename} default values`, `update public.${tablename} set ${first}=${first}`, `delete from public.${tablename}`, `truncate public.${tablename}`]) {
      await assert.rejects(db.exec(sql), {code:'42501'},sql);
    }
  }
  const functions = (await db.query("select p.oid::regprocedure::text signature,p.proname,pg_get_function_identity_arguments(p.oid) args,has_function_privilege('anon',p.oid,'EXECUTE') allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private')")).rows;
  assert.ok(functions.some(f => f.proname === 'complete_manual_tracking_sync'));
  for (const f of functions) assert.equal(f.allowed,false,f.signature);
  const rpc = (await db.query("select proname,oidvectortypes(proargtypes) types from pg_proc where pronamespace='public'::regnamespace")).rows;
  for (const f of rpc) {
    const args = f.types ? f.types.split(', ').map(t => `null::${t}`).join(',') : '';
    await assert.rejects(db.query(`select public.${f.proname}(${args})`), {code:'42501'},f.proname);
  }
});

for (const name of ['owner','editor','viewer']) test(`${name}: server authorization, RLS DML and purchase RPC preserve role boundary`, async () => {
  await role(name);
  const { access } = modules();
  assert.equal((await access.getPortfolioAccess()).canWrite, name !== 'viewer');
  const guard = loadModule('lib/supabase/write-access.ts');
  assert.equal((await guard.writeAccessError(client()))?.status ?? null, name === 'viewer' ? 403 : null);
  const id = crypto.randomUUID();
  const insert = () => db.query('insert into assets(id,portfolio_id,brand,model,created_by) values ($1,$2,$3,$4,$5)',[id,portfolio,'Fixture',name,users[name]]);
  const rpc = () => db.query(`select * from create_asset_with_purchase($1,'Fixture',$2,'2026-09-01',100,null,null,null,'acquired',null,null,null,null,null)`,[portfolio,name]);
  if (name === 'viewer') {
    await assert.rejects(insert(),{code:'42501'});
    assert.equal((await db.query("update assets set model='forbidden' where id=$1 returning id",[asset])).rows.length,0);
    assert.equal((await db.query('delete from assets where id=$1 returning id',[asset])).rows.length,0);
    await assert.rejects(rpc(),{code:'42501'});
    await assert.rejects(db.query('select confirm_valuation_research_run($1)',[runId]));
  } else {
    await insert();
    assert.equal((await db.query("update assets set model='updated' where id=$1 returning id",[id])).rows.length,1);
    assert.equal((await db.query('delete from assets where id=$1 returning id',[id])).rows.length,1);
    assert.equal((await rpc()).rows.length,1);
  }
});

test('every mutation route rejects anonymous/forged headers and viewer before body parsing or effects', async () => {
  const routes = [];
  async function walk(dir) {
    for (const entry of await readdir(dir,{withFileTypes:true})) {
      const path = resolve(dir,entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === 'route.ts') {
        const methods = [...readFileSync(path,'utf8').matchAll(/export async function (POST|PUT|PATCH|DELETE)\(/g)].map(m => m[1]);
        for (const method of methods) routes.push({path,method});
      }
    }
  }
  await walk(resolve(root,'app/api')); assert.equal(routes.length,13);
  for (const name of ['anon','viewer']) {
    await role(name);
    for (const {path,method} of routes) {
      const overrides = {
        [resolve(root,'lib/supabase/server.ts')]: server(),
        'cloudflare:workers': {env:{MIGRATION_READ_ONLY:'true'}},
        [resolve(root,'db/index.ts')]: {getD1: () => { throw new Error('D1 must not be reached'); }},
        [resolve(root,'db/tracking.ts')]: {refreshDueTracking: () => { throw new Error('Tracking must not be reached'); }},
      };
      const handler = loadModule(path,overrides)[method];
      const request = new Request('https://fixture.invalid/api', {method,headers:{'oai-authenticated-user-id':users.owner,'oai-authenticated-user-email':'forged@example.test'},body:'not-json'});
      const response = await handler(request);
      assert.equal(response.status,name==='anon'?401:403,`${name} ${method} ${path}`);
    }
  }
});

test('all requested server pages render database-backed readonly props without auth/session props', async () => {
  await role('anon');
  const { overrides } = modules();
  const component = {__esModule:true,default:() => null};
  for (const file of ['app/ManagementApp.tsx','app/capital/CapitalLedgerView.tsx','app/cameras/[id]/valuation/research/ValuationResearchIntake.tsx','app/cameras/[id]/valuation/research/[runId]/ValuationResearchReview.tsx']) overrides[resolve(root,file)] = component;
  overrides['next/link'] = component;
  overrides['next/navigation'] = {redirect:() => {throw new Error('Unexpected login redirect');},notFound:() => {throw new Error('Unexpected missing public data');}};
  for (const page of ['app/page.tsx','app/assets/page.tsx','app/cameras/[id]/page.tsx','app/logistics/page.tsx','app/capital/page.tsx','app/sales/page.tsx','app/analysis/page.tsx','app/repairs/page.tsx','app/buy-decision/page.tsx','app/cameras/[id]/valuation/research/page.tsx','app/cameras/[id]/valuation/research/[runId]/page.tsx']) {
    const element = await loadModule(page,overrides).default({params:Promise.resolve({id:asset,runId})});
    assert.ok(element,page);
    if (element.props.initialData) assert.ok(element.props.initialData.assets.some(a => a.id === asset),page);
    for (const key of ['canWrite','canCreateAsset','canManageValuation','canRefreshTracking']) assert.notEqual(element.props[key],true,`${page} ${key}`);
    const payload = JSON.stringify(element);
    for (const forbidden of ['access_token','refresh_token','portfolio_members','created_by','confirmed_by',users.owner,users.editor,users.viewer]) assert.ok(!payload.includes(forbidden),`${page}: ${forbidden}`);
  }
  const response = await loadModule('app/api/dashboard/route.ts',overrides).GET();
  assert.equal(response.status,200);
  assert.ok((await response.json()).assets.some(a => a.id === asset));
});

test('anonymous create-asset server action is denied before input parsing or RPC', async () => {
  await role('anon');
  const {overrides} = modules();
  overrides['next/cache'] = {revalidatePath: () => {throw new Error('Unexpected write');}};
  const action = loadModule('app/assets/new/actions.ts',overrides).createAssetWithPurchase;
  const result = await action({error:null},{get:() => {throw new Error('Must reject before parsing');}});
  assert.match(result.error,/查看权限/);
});

test('public client never imports session cookies, and a signed-in non-member falls back to public read only', async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.invalid';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'fixture-public';
  try {
    const realServer = loadModule('lib/supabase/server.ts',{
      'next/headers': {cookies:() => {throw new Error('Public client must not read session cookies');}},
      '@supabase/ssr': {createServerClient:(_url,publicKey,options) => {
        assert.equal(publicKey,'fixture-public'); assert.equal(options.cookies.getAll().length,0); return {public:true};
      }},
    });
    assert.equal(realServer.createPublicClient().public,true);
  } finally {
    url === undefined ? delete process.env.NEXT_PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    key === undefined ? delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY : process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = key;
  }
  let publicReads = 0;
  const chain = data => ({select(){return this;},eq(){return this;},order(){return this;},limit:async() => ({data,error:null})});
  const publicClient = {from: table => {assert.equal(table,'portfolios'); publicReads++; return chain([{id:portfolio}]);}};
  const access = loadModule('lib/supabase/portfolio-access.ts',{
    [resolve(root,'lib/supabase/server.ts')]: {
      createClient:async() => ({auth:{getUser:async() => ({data:{user:{id:'non-member'}},error:null})},from:table => {assert.equal(table,'portfolio_members'); return chain([]);}}),
      createPublicClient:() => publicClient,
    },
  });
  const result = await access.getPortfolioAccess();
  assert.equal(result.canWrite,false); assert.equal(result.supabase,publicClient); assert.equal(publicReads,1);
});
