#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DOMAIN_TABLES = Object.freeze({
  assets: ["cameras", "asset_expenses"],
  purchase: ["purchase_orders", "purchase_order_items"],
  logistics: ["logistics_orders", "logistics_items", "logistics_events"],
  repairs: ["repair_records"],
  valuation: ["market_valuations"],
  sales: ["sales_records"],
});

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args.execute) {
  printPlan(args);
  process.exit(0);
}

const database = required(args.database, "--database");
const configPath = resolve(required(args.config, "--config"));
const outputDirectory = resolve(required(args.output, "--output"));
const wranglerPath = resolve(
  args.wrangler ?? join(process.cwd(), "node_modules", ".bin", "wrangler"),
);

if (!existsSync(configPath)) throw new Error(`Wrangler config not found: ${configPath}`);
if (!existsSync(wranglerPath)) throw new Error(`Wrangler executable not found: ${wranglerPath}`);
if (existsSync(outputDirectory)) {
  throw new Error(`Refusing to overwrite an existing backup directory: ${outputDirectory}`);
}

mkdirSync(outputDirectory, { recursive: true });
const dataDirectory = join(outputDirectory, "data");
mkdirSync(dataDirectory);

const schemaPath = join(outputDirectory, "schema.sql");
runWrangler([
  "d1", "export", database,
  "--remote",
  "--config", configPath,
  "--output", schemaPath,
  "--no-data",
  "--skip-confirmation",
]);

const exportedTables = [];
for (const [domain, tables] of Object.entries(DOMAIN_TABLES)) {
  for (const table of tables) {
    const result = runWrangler([
      "d1", "execute", database,
      "--remote",
      "--config", configPath,
      "--command", `SELECT * FROM "${table}" ORDER BY id`,
      "--json",
    ], true);
    const rows = extractRows(result.stdout, table);
    const filePath = join(dataDirectory, `${table}.jsonl`);
    const contents = rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileSync(filePath, contents ? `${contents}\n` : "", "utf8");
    exportedTables.push({ domain, table, rows: rows.length, file: relative(outputDirectory, filePath) });
  }
}

const gitSha = runCommand("git", ["rev-parse", "HEAD"], true).stdout.trim();
const filesToChecksum = [schemaPath, ...exportedTables.map(({ file }) => join(outputDirectory, file))];
const checksums = filesToChecksum.map((filePath) => ({
  file: relative(outputDirectory, filePath),
  sha256: sha256(filePath),
}));

const manifest = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "cloudflare-d1-remote-read-only",
  database,
  gitSha,
  schema: basename(schemaPath),
  domains: DOMAIN_TABLES,
  tables: exportedTables,
  checksums,
};

writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(
  join(outputDirectory, "checksums.sha256"),
  `${checksums.map(({ sha256: hash, file }) => `${hash}  ${file}`).join("\n")}\n`,
  "utf8",
);

console.log(`D1 backup written to ${outputDirectory}`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") parsed.help = true;
    else if (value === "--execute") parsed.execute = true;
    else if (value.startsWith("--")) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}`);
      parsed[value.slice(2)] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required with --execute`);
  return value;
}

function runWrangler(arguments_, capture = false) {
  return runCommand(wranglerPath, arguments_, capture);
}

function runCommand(command, arguments_, capture = false) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} exited with status ${result.status}${details}`);
  }
  return result;
}

function extractRows(stdout, table) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Wrangler returned invalid JSON while exporting ${table}`);
  }
  const statements = Array.isArray(payload) ? payload : [payload];
  const rows = statements.flatMap((statement) => statement?.results ?? []);
  if (!Array.isArray(rows)) throw new Error(`Wrangler returned an invalid row set for ${table}`);
  return rows;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function printPlan(options) {
  console.log("Dry run only. No database connection or file export was attempted.");
  console.log("\nPlanned domains and tables:");
  for (const [domain, tables] of Object.entries(DOMAIN_TABLES)) {
    console.log(`- ${domain}: ${tables.join(", ")}`);
  }
  console.log("\nTo perform a future authorized export, provide an explicit Wrangler config,");
  console.log("database name and new output directory, then add --execute.");
  if (options.database || options.config || options.output) {
    console.log("\nProvided preview values:");
    if (options.database) console.log(`- database: ${options.database}`);
    if (options.config) console.log(`- config: ${options.config}`);
    if (options.output) console.log(`- output: ${options.output}`);
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/export-d1.mjs
  node scripts/export-d1.mjs --database <name> --config <wrangler-config> \\
    --output <new-directory> --execute

Without --execute the script is a dry run and performs no database or file I/O.
The execution path uses read-only SELECT statements and a schema-only D1 export.
The current Sites hosting.json is a logical binding file, not a Wrangler config.`);
}
