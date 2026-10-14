# Inbound Animal Sheet updates

This integration reads the original Animal Sheet. It does not write to Google Sheets. The existing `sync-animal-sheet` output integration and its schedule remain separate.

It manages the three explicitly configured current map tabs (`1717598677`, `495325388`, `1250760483`): source rooms, racks, physical positions, and lighting observations. Sheet tags and user labels retain their original source text. Exact tag matches are candidates, not confirmed mouse identity or occupancy. No mouse/cage manager assignments are changed by this worker. The private roster supplies only names, acronyms and explicit aliases from current/historical records to resolve source manager labels; review records, emails, phones and notes are excluded.

Source changes use a three-way comparison against the prior imported source. App-only fields survive. App edits to source-managed fields, archived records, missing baselines and large layout losses produce conflicts instead of replacement. Disappearing source positions retain their records with `source_current:false` and a withdrawal event. Dates describe source observations, not an inferred date of animal movement or entrainment. Initial adoption can use a separately reviewed baseline only after matching it against the existing source records.

Every successful import transaction retains an immutable native workbook snapshot (deduplicated by canonical JSON content), append-only change evidence, conflicts, and a new source baseline. A failed read/parse or failed CAS commit changes no colony records and retains the job failure code; failed captures are not persisted as snapshots. Current snapshot storage has a 24 MB limit, and merge plans a 12 MB limit. These bounds fail safely if the workbook grows. Raw workbook snapshots require Max export permission through `get_animal_sheet_import_snapshot`; ordinary members can read status and current merge conflicts.

## Deployment

1. Apply `animal-sheet-import.sql` after `schema.sql`, `export-permissions.sql`, `manager-permissions.sql`, and `lab-members.sql`. It installs no configuration, schedule, Google grant or credentials.
2. Build a paste-ready Edge Function with `node supabase/functions/import-animal-sheet/prepare-bundle.mjs /absolute/private/deployment-directory`. Deploy the generated `index.ts` as `import-animal-sheet`. **Keep JWT verification enabled.** The database queue sends this project's existing public legacy anon JWT in `Authorization`, plus the existing server-only `x-sync-secret`. The Edge Function independently checks that secret. No browser receives it.
3. Reuse existing Edge secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SHEET_SYNC_SECRET`, `SHEET_COLONY_ID`, `ANIMAL_SOURCE_SPREADSHEET_ID`. The source ID must match the privately configured authorized Animal Sheet workbook. The Vault entry remains `animal_sheet_sync_secret`. No new key or secret is needed. The worker requests only Google's `spreadsheets.readonly` OAuth scope.
4. Through the authorized owner/admin route, configure `colony_private.animal_sheet_import_settings`: exact colony, explicit `source_spreadsheet_id`, verified active responsible owner UUID, this project's function URL, and `gateway_anon_key` (the public legacy anon JWT already used for the username sign-in gateway). A publishable `sb_publishable_` key does not replace that gateway JWT. The queue checks its decoded role is `anon`; Supabase's gateway verifies its signature/project. Begin disabled. Do not put the service-role key in this column.
5. Obtain the explicitly authorized **Reader** grant for the existing sync service account on the original source workbook. No write access to that workbook is needed. Preserve the separate existing output-workbook grant.
6. Enable the configured integration. Request one manual import in the app, then verify its job, source snapshot, changes/conflicts, and absence of changes to the source Sheet. Use a second manual import to check idempotence. If a baseline is absent, existing disagreements remain conflicts for review.
7. Only after that review, apply `animal-sheet-import-schedule.sql` (the bundle's `04-activate-daily-after-verification.sql`). It requires an enabled integration with a successful completed import and installs its own daily job at `18:00 UTC`, which is `02:00 Asia/Taipei`.

Manual start requires active editor/owner access or both Imports and Housing manager permissions. The server checks those permissions again before committing a queued manual request. The worker records its true null service actor in the audit log; responsible-owner metadata does not impersonate an authenticated owner. Per-colony locking, version CAS, a claim token, and a baseline revision make retries safe. A stale worker cannot commit after its job is replaced. Source-read-only workers can be superseded after 15 minutes; requests within 30 seconds are debounced.

## App RPC contract

- `request_animal_sheet_import(p_colony_id)` returns `{job_id,status,queued_at}` or a sanitized queue error.
- `get_animal_sheet_import_status(p_colony_id)` returns `{configured,enabled,source_url,schedule_active,schedule,status,last_success_at,conflict_count,job}`. `schedule_active` checks the active cron job, independently of manual-import enablement; `schedule` is null until daily updates are active. Terminal job states are `completed`, `conflicts`, `failed`; pending states are `queued`, `running`.
- `get_animal_sheet_import_conflicts(p_colony_id,p_offset=0,p_limit=100)` returns `{job_id,conflicts,total,next_offset}`. The page limit is 1–200.
- `get_animal_sheet_import_snapshot(p_colony_id,p_snapshot_id)` returns a raw snapshot only with Max export permission.

Browser wrappers are `startAnimalSheetImport()`, `getAnimalSheetImportStatus()`, and `getAnimalSheetImportConflicts({offset,limit})`. Conflict review is read-only in this release. Conflicts are retained for explicit correction rather than silently applying either version.

## Verification

Run `node --no-maglev --test supabase/tests/animal-sheet-import*.test.mjs tests/animal-sheet-source.test.mjs tests/animal-sheet-merge.test.mjs tests/animal-sheet-import-store.test.mjs`. The flag avoids a known Node 23/PGlite Maglev issue and changes no installed runtime.

## First baseline bootstrap

`scripts/prepare-animal-sheet-baseline.mjs` prepares private admin SQL from a verified original source baseline. The SQL compares every source-owned field exactly (including array ordering) against current records, while allowing extra app-owned fields. Any mismatch, active job, completed import, or existing different baseline aborts without a write. A successful bootstrap changes only the private baseline to revision 1; source/app records and their audit history remain untouched. Apply the reviewed bootstrap after disabled configuration and before the first source import. The generator never fabricates an authenticated owner identity.
