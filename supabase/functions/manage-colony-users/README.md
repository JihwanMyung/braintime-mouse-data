# Owner account management

This endpoint lets the configured owner list colony users, add an existing account, invite a new email address, and change read/write access, Manager capabilities, and export levels. It cannot create owners, change owner accounts, delete authentication accounts, set passwords, or manage another colony. Disabling a member removes colony access while retaining the authentication account and audit history. The separate private roster supports preregistration without creating accounts or sending invitations.

The browser supplies its public project key and signed-in user JWT. The function verifies the JWT through Supabase Auth `getUser`, requires the configured confirmed owner email and an active owner membership, and only then uses the runtime service role for Auth admin calls. Membership changes use the **user JWT**, through the narrow `manage_colony_member` RPC. That RPC locks the colony and rechecks the actor, target and allowed role before delegating to `set_member_role`, preserving its audit actor and last-owner guard. The original owner's email alone never grants access.

## Deploy

1. Generate the bundle with `node supabase/functions/manage-colony-users/prepare-bundle.mjs /absolute/private/deployment-directory`. After the project's existing `schema.sql`, apply **all six SQL files in numeric order**: `01-membership.sql`, `02-export-permissions.sql`, `03-manager-permissions.sql`, `04-lab-members.sql`, `05-username-sign-in.sql`, then `06-account-acronym.sql`. The later migrations replace earlier RPC signatures; do not reapply an earlier file alone after the Manager migration. These files are rerunnable in order and contain no roster entries, account creation, invitations, or password changes. Export migration initializes missing nonowner levels to Low and owners to Max; Manager migration adds capabilities without changing existing member roles. A separately reviewed roster import is optional and private.
2. Set these Edge Function secrets/configuration values:

   | Name | Value |
   | --- | --- |
   | `USER_MANAGEMENT_COLONY_ID` | The one colony UUID this endpoint manages |
   | `USER_MANAGEMENT_OWNER_EMAIL` | The original owner's verified email |
   | `USER_MANAGEMENT_APP_URL` | Exact HTTPS application URL, including its path and trailing slash if used, without query or fragment |

   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are hosted runtime defaults. Do not copy any service key into browser code, the repository, or a request body. The configured app origin is the sole permitted browser origin.
3. Add the exact app URL to Supabase Auth's allowed redirect URLs. The client cannot choose invitation redirects. Keep passwordless/invitation callback handling enabled in the app.
4. Paste the generated `index.ts` into the Dashboard Edge Function named `manage-colony-users`. Keep JWT verification **enabled** for this endpoint. The bundle's `index.ts` is only the owner-management handler. To enable username login, also deploy the separate source `supabase/functions/username-sign-in/index.ts` and its adjacent `handler.mjs` as `username-sign-in`, again with JWT verification **enabled**. The username client sends the project's public legacy anon JWT as `Authorization: Bearer` plus `apikey`. For this exact bundled project URL and colony UUID, a configured `sb_publishable_` key uses `PUBLIC_CONFIG.usernameAnonKey` solely for that gateway request; normal Auth and REST calls keep the configured publishable key. Other project or colony configurations cannot use that fallback and require their own public legacy anon key for username login, or use email sign-in. Both functions use the configuration above, and the username handler performs its own password verification, active-membership check, and server-only rate limiting. Never use a service-role key in the browser. These settings are separate from `sync-animal-sheet`, whose secret-authenticated configuration remains unchanged. For CLI deployment, use the source entrypoints and retain `verify_jwt = true` for both account functions.
5. Test the owner-only **list** action through the app first. This sends no email and changes no membership. A viewer/editor or another email must receive an authorization error. Send an invitation only to an explicitly intended recipient after email delivery is configured.

### Email delivery prerequisite

Supabase's default SMTP service delivers only to project-team email addresses and has a small rate limit. General lab-member invitations require a configured custom SMTP provider; adding lab members to the Supabase project team is not an onboarding workaround. The app exposes a readable error when the SMTP service refuses the address. Sending an invitation successfully means the email provider accepted it, not that the recipient received or opened it. See [Supabase SMTP guidance](https://supabase.com/docs/guides/auth/auth-smtp).

An existing Auth account receives colony membership without another invitation email; `email_sent:false` reports that outcome. The user can use the app's existing sign-in flow. This endpoint intentionally provides no automatic resend mechanism.

Auth invitation and database membership cannot be one transaction. If the email was sent but the membership write fails, the error contains `invitation_sent:true` and instructions to reload the user list. Retrying an absent email finds the existing Auth account and adds membership without another invite. A network timeout is treated as an uncertain outcome, never automatically retried. No account is deleted as rollback.

## API

`POST /functions/v1/manage-colony-users`, `Authorization: Bearer <user JWT>`, `Content-Type: application/json`:

```json
{"action":"list","colony_id":"<configured UUID>"}
{"action":"invite","colony_id":"<configured UUID>","email":"member@example.org","role":"viewer"}
{"action":"update_access","colony_id":"<configured UUID>","user_id":"<member UUID>","role":"editor","active":true}
```

Allowed access roles are `viewer` (read), `editor` (read/write), and `manager` (owner-configurable record capabilities). Existing `owner` rows are returned for display only. Optional `permissions` contains only boolean keys `mice`, `breeding`, `housing`, `experiments`, `cryo`, `genetics`, `imports`, `archive`, and `fees`; missing keys default to true on creation, and omitted update permissions preserve existing values. Managers cannot manage users, the private roster, or privilege settings. Unexpected fields and other colony IDs are rejected. `update_access` requires an existing membership and both role and active flag. List pagination is bounded at 5,000 memberships; email lookup is bounded at 10,000 Auth accounts, with an explicit error rather than an incomplete result or duplicate invitation.

Responses:

```js
// list
{colony_id, users: [{user_id, email, name, role, active, export_level, permissions, status}]}
// invite
{user, email_sent, message}
// update_access
{user, message}
// error
{code, message, invitation_sent /* only when relevant */}
```

`status` is `active`, `invited`, `disabled`, or `unavailable`. Profile metadata is restricted to a display name; tokens, private metadata and unrelated project accounts are never returned. Clients must render email/name/message as text, never HTML. Responses are `no-store` and the function logs no request bodies, tokens or upstream error bodies.

## Verification

```sh
node --no-maglev --test supabase/tests/user-management.test.mjs supabase/tests/manager-permissions.test.mjs supabase/tests/lab-members.test.mjs supabase/tests/username-sign-in.test.mjs
```

Tests use mocked HTTP and an isolated in-memory PostgreSQL database. They send no real emails. The SQL test covers anonymous/editor/foreign-owner denial, owner/self protection even after target promotion, membership uniqueness, inactive owner rejection, unchanged other-colony ownership, and audit identity. HTTP tests cover Auth verification, allowlisted origin/redirect, list/email pagination, custom SMTP errors, invitation uncertainty, and partial completion.

References: [verified Auth user lookup](https://supabase.com/docs/reference/javascript/auth-getuser), [server-only admin user listing](https://supabase.com/docs/reference/javascript/auth-admin-listusers), [standard invite email](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail), and [Edge Function default secrets](https://supabase.com/docs/guides/functions/secrets).

## Export permission migration

The generated SQL bundle includes the export, Manager, private roster, and username-rate-limit migrations in the order listed above. Invite and access-update requests accept a separate `export_level` (`low`, `high`, `max`); list and mutation responses return it. Low covers three calendar years, High six, and Max all available history. New nonowners default to Low; omitted update values preserve the existing level. Export levels remain independent from role and Manager capabilities. See `supabase/EXPORTS.md` for the reporting RPC and `supabase/LAB_MEMBERS.md` for private roster and first-time setup boundaries. Applying these SQL files and deploying the functions sends no email; an explicitly invoked invitation or Auth verification request is a separate action.
