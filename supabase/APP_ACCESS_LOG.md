# Application access logs

Apply `app-access-log.sql` after the existing schema, Manager-permissions and lab-member migrations. It is rerunnable and preserves its original activation timestamp. It creates no historical activity or invented sign-in attempts. No Edge Function or new secret is required.

Both applications call `record_app_access(p_colony_id, p_app, p_event, p_page, p_session_id, p_event_id)` after confirming an authenticated, active member. Apps are `mouse` and `reagents`; events are `session_start`, `page_view` and `sign_out`. Pages must be an allowlisted section name. Session/event IDs are random UUIDs. The API accepts no email, user ID, name, role, timestamp, URL, query, record contents, free text, token, password, IP address or device fingerprint. Identity, email, role, roster name/acronym and time come from the database. A sign-out event means **Sign-out requested**, not proof that token revocation succeeded.

Results have `recorded`, `reason` (`recorded`, `duplicate`, `debounced`, `rate_limited`), `event_id`, and `occurred_at` when a recorded event exists. Reusing an event UUID is idempotent only for identical activity by the same member. A session's start and sign-out are recorded once; repeated views of the same page are suppressed for 30 seconds. At most 60 records per minute and 3,000 per rolling day are accepted per colony member. Logging locks the membership row briefly, serializing concurrent events with membership revocation. No log failure should block normal application use.

`list_app_access(p_colony_id, p_app=null, p_user_id=null, p_event=null, p_from=null, p_to=null, p_before=null, p_limit=50)` is readable **only by a currently active owner**. Managers remain excluded regardless of their custom capabilities or Max export level. `p_from` is inclusive and `p_to` is exclusive. Page size is 1–100. `p_before` uses the previous response's `next_before` cursor. Access IDs/cursors are decimal strings in JSON to preserve bigint precision.

The response is `{events, has_more, next_before, logging_started_at}`. Each event has `access_id, event_id, occurred_at, app, event, page, user_id, email, name, acronym, role, session_id, source`. `source` is always `app_reported`. Names, email and role are retained as they were when the event was received. `logging_started_at` is the migration activation time, independent of filters or whether anyone has used the app.

The log and activation marker live in `colony_private`, with no direct browser/service-role table access. The log is append-only, including update/delete/truncate guards. It does not enter `entity_records`, the shared record audit, Reagents history, ordinary exports, or per-member backup-viewer snapshots. Existing database-admin recovery backups may retain this private table under their separate controls. Owner-read permission is hard-coded independently of record permissions.

These are authenticated, client-reported application activities. They do not capture rejected password attempts, anonymous browsing, every database request, idle duration or complete browser navigation. Browser/network failures or a modified client may omit activity. They must not be presented as a complete security or authentication audit. Existing Supabase Auth/provider logs remain the source for authentication failures.

Verification (mock identities, isolated PostgreSQL, no production writes):

```sh
node --no-maglev --test supabase/tests/app-access-log.test.mjs
```
