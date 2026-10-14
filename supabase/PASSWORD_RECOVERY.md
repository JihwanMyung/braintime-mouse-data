# Password sign-in and recovery

The app uses the existing username/email and password sign-in route. Forgot password accepts either identifier, resolves eligible accounts only on the server, and requests a Supabase Auth recovery email. No account is created, no permission is granted and no recipient email is returned to the browser.

Apply `password-recovery.sql` after `lab-members.sql`, then redeploy the existing `username-sign-in` Edge Function from its current `index.ts` and `handler.mjs`. Keep JWT gateway verification enabled. The public legacy anon gateway key uses the same exact project/colony matching rules as username sign-in; ordinary Auth/REST requests retain their existing keys. Existing environment variables are reused:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `USER_MANAGEMENT_COLONY_ID`, `USER_MANAGEMENT_APP_URL`

`USER_MANAGEMENT_APP_URL` must be the HTTPS app URL without credentials, a query or a fragment, and must be allowed in Supabase Auth's redirect configuration. The browser cannot choose a redirect or substitute a recipient email.

The recovery counter and identity resolver can be called only by the service role. Counters store SHA-256 identifier hashes rather than email addresses and allow three requests per identifier per hour, with a colony-wide cap of 30 per hour. Supabase Auth's own mail limits still apply. Only verified, non-anonymous users with an existing password and active colony membership are eligible. Username recovery additionally requires a current, unarchived roster record linked to that same Auth user and email. Email recovery also works for an active owner who has not yet claimed a roster username.

Known, unknown, disabled and undeliverable accounts receive the same accepted response. Actual mail delivery runs through `EdgeRuntime.waitUntil` after lookup, outside the request's response path, so mail-server delay or rejection does not reveal account existence. This is not a claim of fully constant-time database lookup. The handler never echoes a recipient, password, service key or account-specific Auth error. Its accepted response confirms receipt of the request, not delivery of email.

Recovery callbacks clear tokens from the URL before asynchronous verification. The app verifies token scope and the current Auth user and membership, clears cached shared data, and persists `passwordRecovery=true` in session storage. While this flag is set, the app returns no cached dataset and refuses ordinary colony API requests. This is a workflow guard; a Supabase recovery token is still an authenticated token governed by existing server authorization. After a confirmed password update, the app signs out and asks for normal ID/password sign-in. Failed or uncertain updates never show success or echo a rejected password.

Auth generations prevent a delayed callback or session refresh from restoring an old session after sign-out, reconfiguration or another sign-in. A stale callback error also cannot erase a newer session. Neither new passwords nor reset identifiers are persisted in colony data or backups.

## Email delivery prerequisite

Production SMTP is required for ordinary lab-member delivery. Supabase's default sender is restricted to organization/team recipients and is not a general lab mail service. The production dashboard was checked with custom SMTP disabled during this implementation. No real recovery email was sent as part of development or testing. Configure a supported sender separately, then verify delivery using an explicitly authorized test account; do not call the generic accepted response proof of delivery.

The browser API is `requestPasswordReset(identifier)`, `consumeAuthCallback()` / `getCloudStatus().passwordRecovery`, and `completePasswordRecovery(password)`. Canceling recovery uses `signOut()`.

References: [Supabase password recovery](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail) and [Edge Function background tasks](https://supabase.com/docs/guides/functions/background-tasks).
