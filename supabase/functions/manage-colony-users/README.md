# Owner account management

This endpoint lets the configured owner list colony users, invite preregistered members to complete account setup, add an existing account, invite a new email address, and change read/write access, Manager capabilities, and export levels. It cannot create owners, change owner accounts, delete authentication accounts, set passwords, or manage another colony. Disabling a member removes colony access while retaining the authentication account and audit history. Saving the separate private roster never creates accounts or sends invitations; its explicit invitation action sends an account setup email.

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

The legacy `invite` action adds an existing Auth account to the colony without another invitation email; `email_sent:false` reports that outcome. This is separate from the Members preregistration action below. Neither action automatically retries a send.

Auth invitation and database membership cannot be one transaction. If Auth accepted the email request but the legacy membership write fails, the error contains `invitation_sent:true`, `delivery_status:'accepted'`, and `delivery_confirmed:false`, with instructions to reload the user list. These compatibility flags do not prove inbox delivery. Retrying an absent email finds the existing Auth account and adds membership without another invite. A network timeout is reported as `delivery_status:'unknown'`, never automatically retried. No account is deleted as rollback.

### Preregistered member invitations

`invite_preregistered` is the Members **Send invitation** action. It accepts only `person_id` and the displayed record `version`, plus the configured colony ID. It calls the existing owner-only `list_lab_members` RPC with the owner's JWT, and obtains the email from that authoritative record. The member must be current, unarchived, unclaimed, version-matched, and have a valid email. The request cannot override email, role, export level, permissions, or redirect. Owners, already linked accounts, existing colony memberships (including disabled ones), and banned Auth accounts cannot be invited through this action.

New Auth accounts and unconfirmed, unclaimed accounts use Supabase's admin invitation endpoint. Calling that endpoint again resends an invitation to an unconfirmed account. A confirmed account that has not claimed its preregistration receives an existing-account-only sign-in link (`create_user:false`), which opens the same first-time account setup. Both paths use the fixed configured application redirect. A known invitation/confirmation/recovery email within the last 60 seconds blocks another request, and Supabase's own rate limits still apply. Owner authorization and the roster version are checked again immediately before sending.

This action **never writes membership, links the roster, changes a password, or changes privileges**. After the member verifies their email, the existing onboarding screen requires their chosen ID and password. `complete_lab_member_setup` then checks the current roster and disabled-account state again before assigning its saved role/export level. Moving the preregistration to historical or archiving it prevents setup even if an earlier invitation link exists. No new SQL migration is required for this action.

Success means Auth accepted the email request, not confirmed inbox delivery. The response reports `delivery_status:'accepted'` and `delivery_confirmed:false`. The compatibility `email_sent:true` field has the same acceptance meaning. A subsequent roster recheck cannot undo the email request: a changed or unavailable roster therefore returns HTTP 200 with `registration_status:'changed'` or `'unverified'` and a short warning to refresh Members. An explicit 401/403 authorization denial also sets `access_revoked:true`: the client must clear private roster state and require sign-in while still acknowledging that the email request was accepted. Ordinary record changes and transient failures do not set that flag. This avoids an error toast that incorrectly suggests the accepted email request failed. When the check succeeds, `registration_status:'verified'` means the preregistration was rechecked, not that the recipient has completed registration. Mail acceptance and invitation activity remain in Supabase Auth/provider logs; this action does not invent a persistent delivery status on the roster.

### Manual setup links

`create_preregistered_link` accepts the same `person_id`, displayed `version`, and configured colony ID. It creates an invitation link without requesting email. It is owner-only and uses the same authoritative current, unarchived, unclaimed preregistration. The recipient and redirect cannot be supplied by the client.

Only a new Auth account or an unconfirmed account with **no membership in any colony** is eligible. Confirmed accounts, SSO accounts, banned accounts, claimed preregistrations, owners, and accounts with existing access settings are denied. In particular, this endpoint never returns a magic link or password-recovery link for an existing verified account. For that case it returns `manual_link_unavailable` and directs the member to password sign-in or email recovery; it does not send an email as a fallback.

The server calls Supabase's admin `generate_link` with `type:'invite'`, then validates the returned account, invite type, exact project verification URL, unique query parameters, token/hash agreement, and fixed application redirect. Before releasing the link, it rechecks the owner's verified identity and active membership, the roster version/email, the recipient Auth profile, and membership absence across colonies. Changed or unverifiable access withholds the link. This action can create an unconfirmed Auth account or replace its invitation token, but it does not write colony membership, roster links, roles, export limits, or passwords.

The returned URL is a bearer credential. Keep it only in the owner's current UI memory, share it only with the named recipient, and never put it in logs, analytics, persistent browser storage, or audit records. The endpoint returns no OTP, separate token/hash, or private Auth metadata. Supabase controls expiry; `expires_at:null` means the configured expiry was not queried. Regeneration may invalidate an earlier link, so use the newest link. The email cooldown is not applied to this no-email action; provider limits still apply. A network failure is an unknown generation outcome, with no link returned and no automatic retry.

## API

`POST /functions/v1/manage-colony-users`, `Authorization: Bearer <user JWT>`, `Content-Type: application/json`:

```json
{"action":"list","colony_id":"<configured UUID>"}
{"action":"invite","colony_id":"<configured UUID>","email":"member@example.org","role":"viewer"}
{"action":"invite_preregistered","colony_id":"<configured UUID>","person_id":"<roster person UUID>","version":4}
{"action":"create_preregistered_link","colony_id":"<configured UUID>","person_id":"<roster person UUID>","version":4}
{"action":"update_access","colony_id":"<configured UUID>","user_id":"<member UUID>","role":"editor","active":true}
```

Allowed access roles are `viewer` (read), `editor` (read/write), and `manager` (owner-configurable record capabilities). Existing `owner` rows are returned for display only. Optional `permissions` contains only boolean keys `mice`, `breeding`, `housing`, `experiments`, `cryo`, `genetics`, `imports`, `archive`, `fees`, and `iacuc`; missing keys default to true on creation, and omitted update permissions preserve existing values. Managers cannot manage users, the private roster, or privilege settings. Unexpected fields and other colony IDs are rejected. `update_access` requires an existing membership and both role and active flag. List pagination is bounded at 5,000 memberships; email lookup is bounded at 10,000 Auth accounts, with an explicit error rather than an incomplete result or duplicate invitation.

Responses:

```js
// list
{colony_id, users: [{user_id, email, name, role, active, export_level, permissions, status}]}
// invite
{user, email_sent, delivery_status, delivery_confirmed: false, message}
// invite_preregistered (no membership or privilege mutation)
{person_id, email_sent: true, email_kind: 'invitation' /* or 'sign_in_link' */,
 delivery_status: 'accepted', delivery_confirmed: false,
 registration_status: 'verified' /* or 'changed' or 'unverified' */,
 access_revoked: true /* only on authorization denial */, warning /* if relevant */, message}
// create_preregistered_link (sensitive URL, no email requested)
{person_id, invitation_link, link_kind: 'invitation', expires_at: null,
 email_sent: false, delivery_status: 'not_sent', delivery_confirmed: false, message}
// update_access
{user, message}
// error
{code, message, invitation_sent /* only when relevant */, delivery_status /* if known */}
```

`status` is `active`, `invited`, `disabled`, or `unavailable`. Profile metadata is restricted to a display name; tokens, private metadata and unrelated project accounts are never returned. Clients must render email/name/message as text, never HTML. Responses are `no-store` and the function logs no request bodies, tokens or upstream error bodies.

## Verification

```sh
node --no-maglev --test supabase/tests/user-management.test.mjs supabase/tests/manager-permissions.test.mjs supabase/tests/lab-members.test.mjs supabase/tests/username-sign-in.test.mjs
```

Tests use mocked HTTP and an isolated in-memory PostgreSQL database. They send no real emails and generate no real invitation links. The SQL test covers anonymous/editor/foreign-owner denial, owner/self protection even after target promotion, membership uniqueness, inactive owner rejection, unchanged other-colony ownership, and audit identity. HTTP tests cover Auth verification, allowlisted origin/redirect, list/email pagination, custom SMTP errors, invitation uncertainty, and partial completion. Preregistration tests additionally cover tampered recipient/privileges, stale or ineligible roster records, unconfirmed resend versus existing-only sign-in links, absence of membership writes, disabled accounts, cooldowns, and owner/roster changes before and after sending. Manual-link tests cover confirmed/SSO and cross-colony account exclusion, post-generation authorization changes, strict URL/type/token validation, no email or privilege mutation, minimal secret-free response fields apart from the intended bearer URL, and uncertain outcomes without retries.

References: [verified Auth user lookup](https://supabase.com/docs/reference/javascript/auth-getuser), [server-only admin user listing](https://supabase.com/docs/reference/javascript/auth-admin-listusers), [standard invite email](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail), and [Edge Function default secrets](https://supabase.com/docs/guides/functions/secrets).

The resend behavior is implemented in Supabase's [invitation handler](https://github.com/supabase/auth/blob/master/internal/api/invite.go), which rejects confirmed accounts and sends another invitation to unconfirmed accounts. The confirmed-account setup path uses [email OTP/sign-in links](https://supabase.com/docs/reference/javascript/auth-signinwithotp) with account creation disabled, as implemented in the [OTP handler](https://github.com/supabase/auth/blob/master/internal/api/otp.go). The general `auth.resend` API is not used because its supported types do not include invitations.

Manual generation uses [admin generateLink](https://supabase.com/docs/reference/javascript/auth-admin-generatelink). The direct Auth [generate-link implementation](https://github.com/supabase/auth/blob/master/internal/api/mail.go) returns flattened user/link properties and creates the invitation token without sending SMTP mail. The handler validates that direct response rather than assuming the JavaScript SDK's `{data:{user,properties}}` wrapper.

## Export permission migration

The generated SQL bundle includes the export, Manager, private roster, and username-rate-limit migrations in the order listed above. Invite and access-update requests accept a separate `export_level` (`low`, `high`, `max`); list and mutation responses return it. Low covers three calendar years, High six, and Max all available history. New nonowners default to Low; omitted update values preserve the existing level. Export levels remain independent from role and Manager capabilities. See `supabase/EXPORTS.md` for the reporting RPC and `supabase/LAB_MEMBERS.md` for private roster and first-time setup boundaries. Applying these SQL files and deploying the functions sends no email; an explicitly invoked invitation or Auth verification request is a separate action.

## IACUC permission update

The current bundle adds `07-iacuc.sql` after account setup. It adds the IACUC manager flag, typed protocol/assignment/usage/design validation and bounded report projections. Re-deploy this Edge handler with its new `iacuc` allowlist before editing that flag in owner settings. Missing legacy flags become enabled, matching the prior broad manager default; explicit denials survive reruns. No protocol data or approval is created. See `supabase/IACUC.md`.

The bundle also includes `08-locobox.sql` after IACUC. On an already migrated deployment, apply only the new Locobox migration. It reuses Housing permission, validates phase/treatment timelines, preserves source evidence and append-only revisions, and filters nested report dates independently. No additional function deployment is required specifically for Locobox. See `supabase/LOCOBOX.md`.
