# Shared colony backend

Separate Low (three calendar years), High (six calendar years), and Max export permissions are prepared in `export-permissions.sql`. Apply it after the membership migration. See [EXPORTS.md](EXPORTS.md) for report RPCs, deployment order, tests, and the boundary between supported exports and existing viewing access.

`schema.sql` is prepared for a dedicated Supabase project. It has not been applied to a cloud account. Run it as the database owner in that project's SQL editor after reviewing it. Configure Supabase Auth with only the intended application redirect URLs, create/invite the lab users through Auth, and establish the owner membership using `bootstrap.example.sql` or the authenticated `create_colony` RPC. Membership is based on Auth UUIDs, never user-editable profile metadata.

All four public tables have RLS. Anonymous roles have no table access. Authenticated lab members can read their colony; only active owners/editors can mutate records through the SQL-checked RPC. Direct client INSERT/UPDATE/DELETE is revoked. Owner-only membership changes cannot remove the final active owner. Records are archived rather than deleted. Entity and membership changes create audit entries, and clients cannot update/delete those entries. A privileged database administrator can still change schema or disable triggers; this is not tamper-proof against the project administrator.

## Client API

- `GET /rest/v1/memberships?colony_id=eq.UUID&user_id=eq.AUTH_UUID&select=role,active`
- `GET /rest/v1/entity_records?colony_id=eq.UUID&order=entity_type.asc,entity_id.asc&limit=500&offset=0` (continue pages until fewer than 500 rows)
- `POST /rest/v1/rpc/save_record`: `p_colony_id`, `p_entity_type`, `p_entity_id`, `p_payload`, `p_expected_version`, optional `p_archived` (false)
- `POST /rest/v1/rpc/save_records`: `p_colony_id`, `p_changes` array of 1–500 objects: `entity_type`, `entity_id`, `payload`, `expected_version`, optional `archived` (false)
- `GET /rest/v1/audit_log?colony_id=eq.UUID&order=audit_id.desc&limit=100`

Both save RPCs return a JSON array of complete `entity_records` rows. An entity row contains `colony_id`, `entity_type`, `entity_id`, `payload`, `version`, `archived`, `created_at`, `updated_at`, `created_by`, `updated_by`. Expected version 0 creates a new record; a positive version must equal the current version. A conflict raises SQLSTATE `40001`; the app must reload and let the user reconcile rather than silently retry their old edit. A no-op with the correct version returns the unchanged record. A batch is one transaction, including its audit entries. A shared colony advisory lock and deterministic record ordering serialize batch operations with single-record saves.

Entity types and string payload keys: mice→`mouse_sid`, matings→`mating_sid`, litters→`litter_sid`, cages→`cage_sid`, rooms→`room_id`, racks→`rack_id`, locations→`location_id`, light_events/husbandry_events→`event_id`. `archive/reconstruction` stores remaining dataset tables and metadata. Existing payload keys beginning `source` and `record_origin` cannot be changed or removed. Source arrays and nullable unknown genotypes remain unchanged.

SQL enforces JSON identifiers, permitted sex values, real calendar dates, selected obvious date contradictions, parent-array types/self-parent prevention, and lighting quantity bounds, including non-24-hour cycles. Historic source anomalies such as procedure dates before birth are preserved for review. Full pedigree reconciliation, capacity, referenced-object completeness and biological interpretation remain application/reconstruction checks; the server does not claim genetic validation or infer missing parents. Imports may reference parents that appear later in the batch sequence.

## Import

Run `node scripts/import-reconstruction.mjs --dataset /absolute/dataset.json` for an offline dry run. To apply later, use `--apply` with `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ACCESS_TOKEN` (signed-in user access JWT), and `COLONY_ID` supplied through the process environment. Never put a service-role/secret key in browser code or this command's arguments. The importer rejects service-role credentials, checks membership, pages all existing records, skips identical records, and retains different existing records as conflicts. New records import in atomic batches of 200. A failed batch rolls back; earlier successful batches remain and rerunning resumes idempotently. The report contains IDs and outcomes, never credentials.

## Local verification

Run `npm ci --prefix supabase/tests`, then `npm test --prefix supabase/tests` from the app directory. The pinned PGlite package is local to that test folder; no shared Python/R/Julia environment is modified. Tests execute actual PostgreSQL SQL with local `auth.uid()` and Auth-user fixtures. They cover anonymous denial, cross-colony isolation, viewer/editor/owner permissions, direct-DML bypass denial, provenance immutability, stale writers, atomic rollback/audit behavior, revocation, record retention, managed lighting types and every reconstructed entity's SQL validation. Results are in `supabase/tests/results.json`.

PGlite uses one PostgreSQL connection, so the parallel write test verifies competing stale-version requests, not hosted multi-connection throughput. Hosted Auth/JWT issuance, PostgREST integration, deployment RLS checks and device access remain unperformed until a project is configured.

Design references: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [function security](https://supabase.com/docs/guides/database/functions), [PGlite](https://pglite.dev/docs/).

Historical archive tables use immutable content chunks, each at most 250,000 UTF-8 bytes, with a versioned `archive/reconstruction` manifest. The shared codec in `web/archive-format.js` hashes canonical JSON and checks referenced hashes/counts on every pull. The database accepts chunk IDs of the form `chunk:<64 lowercase hex>` and forbids changes to an existing chunk or its archive flag. The CLI and web client upload chunks before the manifest; failed staging may leave unreferenced immutable chunks. They are deliberately retained, not automatically deleted. Archive reads use three records per page; atomic writes are limited to 1 MB per request and 200 records per import batch. SQL enforces authorization and immutability; the codec verifies content hashes.

For complete exported source-cell search, apply `history-storage.sql` after the main schema. It creates the private `colony-history` bucket with member reads, owner/editor uploads, and no overwrite/delete. Object paths are `<colony UUID>/history/<SHA256>.json` or `.json.gz`. The source archive is never placed in a public web asset or service-worker cache.

For a separately authorized initial database-administrator import, the offline CLI can export CSV:

```
node scripts/import-reconstruction.mjs --dataset /private/dataset_augmented.json --export-csv /private/initial-import.csv --colony-id VERIFIED_COLONY_UUID --owner-user-id VERIFIED_AUTH_USER_UUID
```

Both UUIDs are mandatory and must be verified in the target project. The generator neither creates users or memberships nor sets JWT claims. Verify the target colony is empty, then use **insert only** into `entity_records`; do not choose upsert. `created_by`/`updated_by` name the supplied responsible owner, while the audit trigger records the actual server `auth.uid()` (null for an administrator context without Auth claims). This route intentionally uses database-administrator authority and must not be exposed to ordinary app users.

CSV rows have version 1 and preserve JSON payloads exactly. The reconstruction manifest is the final row, but a Table Editor import may use several transactions, so its presence alone does not prove completion. Reconcile the metadata sidecar counts, all entity IDs and manifest/chunk integrity after import. A partially completed CSV import cannot simply be replayed over existing rows; duplicate primary keys are deliberately rejected. The authenticated REST importer is the resumable route and skips identical existing rows while retaining conflicting edits. CSV export is offline, writes a private file without overwriting an existing filename, and handles no credentials.

`verify-hosted.sql` is the compact read-only SQL-editor check. `verify-hosted-full.sql` supplies 39 detailed permission, storage and validation checks. Neither creates lab records or supplies an Auth identity.

Add `--csv-batches /private/csv-batches` to also export sequential fallback CSV files, each at most 1,000,000 bytes and 500 rows. The final `*-MANIFEST-LAST.csv` file is separate. Use either the full CSV or the complete ordered batch sequence, never both against the same records. The metadata sidecar lists exact file hashes, counts and IDs for reconciliation. Uploading the manifest does not prove earlier batches succeeded.
