# Animal Sheet projection

The existing lab Animal Sheet remains the historical source. Use a separate whole-workbook copy as the projection destination. Keep the source and destination workbook identifiers in private deployment settings.

Five dedicated tabs are managed by this integration: Database status, Current animals, Current cages, Light history, and Room/rack map. Copied original tabs remain reference snapshots. Data flows from the database to these five tabs. Edit records in the app; editing a managed tab is temporary and the next refresh replaces it. This avoids competing editors overwriting the database from a spreadsheet.

## Activation after the cloud project exists

1. Apply `supabase/schema.sql`, then `supabase/sheet-sync.sql` to the dedicated project. Establish lab users and owner membership as described in `supabase/README.md`.
2. Create a Google Cloud service account, enable the Google Sheets API, and give that account Editor access **only to the new output workbook**. This is a required access grant; the original lab workbook need not be shared with it.
3. Store `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_OUTPUT_SHEET_ID`, `ANIMAL_SOURCE_SPREADSHEET_ID`, `SHEET_COLONY_ID`, and a random `SHEET_SYNC_SECRET` in Supabase Edge Function secrets. The source identifier is required and must differ from the output identifier; the function refuses to write when this guard is missing or the two identifiers match. `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY` are supplied by Supabase. No secret belongs in GitHub Pages, browser settings, the repository, or the spreadsheet.
4. Deploy `sync-animal-sheet` from the `supabase/functions` directory. JWT verification is disabled only for this function because database webhooks use the separate `x-sync-secret` header. The function rejects every request without that exact secret.
5. Configure database webhooks for INSERT and UPDATE on `public.entity_records`, POSTing to the deployed function with `x-sync-secret`. Add a scheduled retry every five minutes using Supabase Cron and Vault-stored secrets. The function ignores request-body record data and reads a consistent, authorized database snapshot. Set the intended `SHEET_COLONY_ID`; do not use one function deployment for several colonies.
6. Run one refresh, reopen all five tabs, and verify timestamp, animal counts, cage occupancy, a representative light event, and an unlinked physical position in Room/rack map. Then test a small app edit and check its live receipt in the sheet. Until that succeeds, the integration is **prepared, not active**.

## Consistency and recovery

Each refresh atomically replaces the five managed tab values in a single Google batchUpdate. IDs and notes use explicit string cells, so leading zeroes are retained and text beginning `=` never becomes a formula. Archived records are omitted; occupancy uses Stock mice assigned to a cage, not historical resident strings.

Room/rack map includes every non-archived physical location, even when no database cage is linked. Explicit cage assignments and their Stock mice occupy separate columns from source-listed IDs, candidate IDs, source tags, and position notes. Candidate/source labels never create an occupancy or identity link.

The map selects date-applicable schedule observations at the captured snapshot time, using each event's timezone (Asia/Taipei when unspecified). A valid start date is required. An end date is inclusive unless the source explicitly marks it as the next phase's start or another exclusive boundary. Future and expired events remain in Light history. Unknown effective dates appear in a separate undated column. Concurrent observations and planned/unverified evidence remain visible; a date-applicable schedule does not establish actual animal exposure. The map freezes room, rack, and position columns for scrolling.

A durable database lock serializes refreshes. A competing webhook returns 202; the scheduled retry reconciles changes after the active snapshot. Thus this is near-real-time with a scheduled recovery path, not a guarantee of immediate delivery for every keystroke. A Google error or timeout after a write starts retains the lock because the outcome may be uncertain. Inspect Edge logs and the output workbook, stop any outstanding invocation, and only then let a database administrator clear `sheet_sync_state.lock_token` for the colony. Locks do not silently expire and permit an older delayed write to overwrite a newer snapshot.

Setup depends on the user's Supabase project and the Google service-account grant. No credentials have been generated and no webhook, schedule or live sync has been activated in this workspace.

References: [Google atomic batch updates](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate), [service account authentication](https://developers.google.com/identity/protocols/oauth2/service-account), [Supabase function secrets](https://supabase.com/docs/guides/functions/secrets).
