# Adding Experiment Sheet source history

`scripts/prepare-experiment-import.mjs` prepares an additive import without connecting to Supabase. It accepts a freshly captured `archive/reconstruction` payload and version plus the reviewed source bundle. It preserves the source-catalog order used by compact provenance references. It creates four archive tables when present in the bundle: `experiment_sources`, `experiment_source_catalog`, `experiment_source_contexts`, and `experiment_source_coverage`.

```sh
node scripts/prepare-experiment-import.mjs \
  --manifest /private/captured-manifest.json \
  --version VERIFIED_VERSION \
  --sources /private/experiment_sources_app.json \
  --colony-id VERIFIED_COLONY_UUID \
  --owner-user-id VERIFIED_OWNER_UUID \
  --output-dir /private/new-experiment-import \
  --chunk-csv experiment-source-chunks.csv
```

Generated files contain private source data and are refused inside the public repository. The output directory must not exist; it is created with mode 0700 and files use 0600. `import-plan.json` records source and output checksums. Original workbooks and the complete archival bundle remain separate preservation artifacts.

1. Run `000-PREFLIGHT.sql` in the intended project's SQL editor. Confirm the captured manifest still matches, the responsible owner is active, and no conflicting chunks or source descriptors exist. The complete CSV requires zero existing expected chunk IDs. If matching chunks already exist, capture `existing_chunk_ids` as a JSON array and prepare a fresh package with `--existing-chunk-ids /private/captured-ids.json`.
2. Import the chunk CSV into `entity_records` using **INSERT**, never upsert or overwrite. The CSV contains only content-addressed archive chunks, with version 1. It does not contain the reconstruction manifest or managed animal records. Alternatively, execute the numbered staging SQL files. SQL staging is idempotent and verifies any existing matching IDs; it can reconcile an interrupted CSV import safely.
3. Run `MANIFEST-LAST.sql` only after all chunks are staged. It checks every expected chunk's exact JSONB fingerprint and row count, compares both the captured manifest payload and version, and adds only the declared experiment-table descriptors. A stale version, missing chunk, changed payload or conflicting source table aborts the transaction. Unreferenced staged chunks do not change the active dataset.
4. Reopen/pull the application, verify the four table counts and source links, and retain the private receipts. Preparation, staging and local validation are not confirmation of hosted publication.

The SQL requires an actual administrator context with `auth.uid()` null and never sets JWT claims. Audit triggers record that genuine actor. `created_by`/`updated_by` identify the explicitly verified responsible owner. If the owner argument is omitted, SQL can resolve exactly one active owner; CSV preparation always requires an explicit owner UUID. Existing different experiment source tables are never replaced by this generator. A later source merge needs a separately reviewed reconciliation process.

Test the generator and actual SQL behavior with:

```sh
node --no-maglev --test supabase/tests/experiment-import.test.mjs
```

Tests cover archive SHA checks, PostgreSQL JSONB fingerprints, source quoting, multi-table preservation, missing/tampered chunks, stale versions, idempotent retry, genuine audit identity, independent CSV parsing, and private output permissions.
