# Market Valuation Migration Plan

Status: Phase 4A-1 preparation only
Prepared: 2026-08-22
Production valuation writes performed: none

## Scope and authoritative source

The only authorized source is the frozen backup directory
`lensfolio-d1-backup-20260821T141816Z`. The migration must not query the old
production D1 database, scrape Xianyu, request an AI valuation, or create raw
market listings that do not exist in the backup.

Verified backup identity:

- Site version: `v4`
- Site access: `owner-only`
- Migration protection: enabled
- manifest SHA-256:
  `a7bb4f87a43efb58e26292f4507b6ac401102cce34c5d4529290d467bf0142f8`
- `market_valuations` JSONL SHA-256:
  `a6ef0ea2ec6da876e0d24f3ea4f67a6164c375bb1ca74033f6f7d03b82af95a8`
- manifest valuation row count: 5
- manifest current valuation total: CNY 17,250

Every file listed by `checksums.sha256` passed verification during Phase 4A-1.

## Source grain and profile

The source grain is one manually entered valuation snapshot per camera. The
five rows have five unique D1 valuation IDs and five unique camera IDs. All
camera IDs match an existing Supabase `assets.legacy_id`.

Source quality profile:

| Check | Result |
| --- | --- |
| Rows | 5 |
| Unique valuation IDs | 5 |
| Unique camera IDs | 5 |
| Missing core fields | 0 |
| Invalid `low <= median <= high` rows | 0 |
| `sample_size IS NULL` | 5 of 5 |
| Confidence values | `0.5` for all 5 |
| Source values | `闲鱼` for all 5 |
| Collection method | `人工录入` for all 5 |
| Expected/current valuation total | CNY 17,250 |
| Median total | CNY 17,250 |

The source contains valuation summaries only. It does not contain raw Xianyu
listing records. `market_listings` must therefore remain empty during this
migration.

## Valuation baseline

`expected_cny` is the old system's current valuation. For all five frozen rows,
it equals `median_cny`; the Supabase financial view uses `median` as current
valuation.

| D1 valuation ID | Asset legacy ID | Current | Low | Median | High | Confidence | Sample count |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `val-canon-01` | `canon-autoboy-sii-01` | 1,100 | 900 | 1,100 | 1,300 | 0.5 | `NULL` |
| `val-canon-set-s` | `canon-autoboy-s-set` | 700 | 500 | 700 | 900 | 0.5 | `NULL` |
| `val-canon-set-sii` | `canon-autoboy-sii-set` | 1,050 | 850 | 1,050 | 1,250 | 0.5 | `NULL` |
| `val-contax-01` | `contax-t2-date-back` | 7,000 | 6,200 | 7,000 | 7,800 | 0.5 | `NULL` |
| `val-nikon-01` | `nikon-28ti` | 7,400 | 6,800 | 7,400 | 8,200 | 0.5 | `NULL` |
| **Total** |  | **17,250** |  | **17,250** |  |  |  |

## Target Schema review

### `market_sources`

The existing table supports `name`, `source_url`, `active`, ownership, and
portfolio scoping. It does **not** contain a `type` or `source_type` field.
`unique (portfolio_id, name)` can idempotently identify the future `闲鱼`
source row.

The requested source `type` capability is therefore a Schema gap. A future,
separately approved migration should add the chosen field before valuation
import if source type must be retained. The D1 row does not contain an explicit
source type; a value such as `marketplace` would be migration metadata and must
not be represented as an original D1 fact without documenting that distinction.

### `market_listings`

The existing table supports:

- `asset_id`
- source relation through `market_source_id`
- `title`
- price through numeric `asking_price`
- `currency`
- URL through `listing_url`
- observation time through `observed_at`

It does not contain `condition` or a literal `listed_at` field. These are Schema
gaps for future raw-listing ingestion. They do not block the current frozen
snapshot migration because the D1 backup has no raw listings and no listing
rows may be invented.

### `valuation_snapshots`

The existing table supports:

- `asset_id`
- source relation through nullable `market_source_id`
- `low`, `median`, and `high`
- nullable `p25` and `p75`
- nullable `sample_count`
- nullable numeric `confidence`
- required `methodology_version`
- `valued_at` as `timestamptz`
- `created_at` as `timestamptz`

It does not contain a source `legacy_id` or `updated_at`. Both are migration
readiness gaps: `legacy_id` is needed for database-backed idempotency, and the
old `updated_at` timestamp cannot be preserved in a semantically equivalent
field today. No import should silently discard or relabel that timestamp.

## D1 to Supabase field mapping

### Market source

| D1 field | Supabase target | Rule |
| --- | --- | --- |
| `source` | `market_sources.name` | Preserve `闲鱼` exactly. |
| none | proposed `market_sources.source_type` | No source fact exists; any classification requires an approved rule. |
| none | `market_sources.source_url` | Keep `NULL`; do not invent a URL. |

### Valuation snapshots

| D1 field | Supabase target | Rule |
| --- | --- | --- |
| `id` | proposed `valuation_snapshots.legacy_id` | Preserve exact D1 ID; requires a future unique migration. |
| `camera_id` | `asset_id` | Resolve by `(portfolio_id, assets.legacy_id)`. |
| `source` | `market_source_id` | Resolve the portfolio's `market_sources.name = '闲鱼'` row. |
| `low_cny` | `low` | Copy as numeric CNY. |
| none | `p25` | Keep `NULL`; do not derive a quartile from low/median/high. |
| `median_cny` | `median` | Copy as numeric CNY; this becomes current valuation. |
| none | `p75` | Keep `NULL`; do not map `premium_cny` to a statistical quartile. |
| `high_cny` | `high` | Copy as numeric CNY. |
| `sample_size` | `sample_count` | Preserve exact value, including `NULL`. |
| `confidence` | `confidence` | Preserve `0.5` exactly. |
| migration rule | `methodology_version` | Use a documented constant such as `legacy_manual_v1`; do not claim automated sampling. |
| `valued_at` | `valued_at` | Normalize the date deterministically in `Asia/Hong_Kong`; do not infer an observation time. |
| `created_at` | `created_at` | Parse the timezone-less legacy timestamp as `Asia/Hong_Kong`, then store as `timestamptz`. |
| `updated_at` | proposed source-update field | Preserve only after an approved Schema field exists. |
| `expected_cny` | verification only | Must equal target `median`; stop if it differs. |
| `average_cny` | verification only | No target mean field; current rows equal median, but that must not become a general rule. |
| `premium_cny` | verification only | No target premium field; current rows equal high. Do not map to `p75`. |
| `keyword`, `condition_grade`, `notes`, `collection_method`, `exclusion_rules` | no current equivalent | Must not be silently presented as structured target facts; decide on future provenance fields before import if full preservation is required. |

## NULL handling rules

1. `sample_size = NULL` must be inserted explicitly as `sample_count = NULL`.
2. Do not omit the column during insert because its remaining default is `0`.
3. PostgreSQL permits `NULL`: migration `20260821000500` dropped the `NOT NULL`
   requirement, and the nonnegative check does not reject `NULL`.
4. Never convert unknown sample size to zero. Zero means a known count of zero;
   `NULL` means the count is unknown.
5. `p25` and `p75` remain `NULL`; no quartile observations exist.
6. Nullable source metadata stays `NULL`; no synthetic listing, URL, condition,
   or sample is allowed.

## Confidence rules

- Copy the legacy confidence value `0.5` without recalculation.
- Do not increase or decrease confidence based on `sample_count`, because the
  sample count is unknown rather than zero.
- Record the methodology as a legacy manual valuation, not as scraped, modelled,
  or AI-generated evidence.
- Confidence remains a source value, not a probability guarantee.

## Idempotency, audit, and rollback

Before import, a separately approved Schema migration should provide a nullable
legacy key on `valuation_snapshots` with a database uniqueness constraint such
as `unique (portfolio_id, legacy_id)`. Application-only duplicate checks are not
sufficient.

The future importer should:

1. support dry-run, apply, verify, and confirmed rollback modes;
2. use one transaction;
3. upsert the single market source by `(portfolio_id, name)`;
4. insert or upsert five snapshots by the approved legacy constraint;
5. record a `migration_run_id`, backup manifest SHA-256, source-to-target IDs,
   before/after counts, and financial totals in `audit_logs`;
6. verify that `market_listings`, sales, cost entries, purchases, and logistics
   did not change.

Rollback must delete only snapshot UUIDs recorded as inserted by the selected
migration run. It may delete the market source only if that run created it and
no snapshot or listing still references it. Rollback must refuse if the target
rows no longer match their recorded legacy IDs or if later dependent work makes
destructive rollback unsafe.

## Financial view and ROI impact

`asset_financials` selects the latest snapshot per asset and treats its `median`
as current valuation. It does not add valuation amounts to carrying cost.

With the current posted carrying cost of CNY 13,831, importing these five
medians would produce the following expected read-only financial results:

| Asset | Current valuation | Posted carrying cost | Unrealized profit | Expected ROI |
| --- | ---: | ---: | ---: | ---: |
| Canon Autoboy S II | 1,100 | 1,092 | 8 | 0.732601% |
| Contax T2 Date Back | 7,000 | 5,028 | 1,972 | 39.220366% |
| Nikon 28Ti | 7,400 | 6,505 | 895 | 13.758647% |
| Canon Autoboy S bundle component | 700 | 603 | 97 | 16.086235% |
| Canon Autoboy S II bundle component | 1,050 | 603 | 447 | 74.129353% |
| **Portfolio** | **17,250** | **13,831** | **3,419** | **24.719832%** |

ROI remains strictly `(valuation - posted total carrying cost) / posted total
carrying cost`. The CNY 230 pending shipment budget remains excluded until it is
posted. Realized profit and realized ROI remain `NULL` because sales are still
empty.

## Entry gates for the import phase

Valuation import must not begin until the following are resolved through an
approved migration or explicit scope decision:

1. decide whether `market_sources` requires a source-type column;
2. add database-backed valuation legacy idempotency if the five D1 IDs must be
   retained and safely re-run;
3. decide how to preserve D1 `updated_at` and other valuation provenance fields;
4. approve the deterministic timezone normalization for legacy date/time text;
5. confirm that no raw `market_listings` will be created from summary rows.

Until those gates are cleared, `market_sources`, `market_listings`, and
`valuation_snapshots` must remain empty.
