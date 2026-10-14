# Private lab-member roster

Apply `lab-members.sql` after `schema.sql` and `export-permissions.sql`. Apply `manager-permissions.sql` before claiming or assigning a Manager membership. This migration creates no accounts, invitations, emails, or initial roster entries.

`lab_members` holds private contact information. Only active colony owners can read it directly or use its management RPCs. Its complete before/after audit uses the separate owner-only `lab_member_audit` table. Contacts and provenance never enter `entity_records`, `husbandry_events`, or the shared `audit_log`. The latter receives only ordinary membership changes. Service-role SELECT is reserved for the protected server-side username sign-in resolver; never expose its credential in the browser.

## Owner API

- `list_lab_members(p_colony_id)` returns `{members:[row]}` including archived rows.
- `save_lab_member(p_colony_id,p_person)` returns `{member:row}`. New entries use `person_id:null,version:0`; edits require the exact `person_id` and `version`. Omitted editable fields are preserved. Deletion is archival (`archived:true`), retaining provenance and audit history.

Editable fields are `name`, nullable `email`, `phone`, `acronym`, `category`, `status`, `intended_role`, `export_level`, `provenance` (object), nullable `notes`, and `archived`. Categories are `undergraduate`, `masters`, `phd`, `postdoc`, `visiting_student`, `visiting_faculty`, `principal_investigator`, `other`, and `unknown`. Status is `current`, `historical`, or `review`. Intended roles are `viewer`, `editor`, and `manager`; export levels are `low`, `high`, and `max`. Defaults are `review`, `editor`, and `low`. Reviewed import records explicitly specify approved higher levels; names never trigger permission inference.

Rows also contain server-owned `username`, `linked_user_id`, `version`, timestamps, and creator/editor IDs. Owner responses add `effective_role`, `effective_export_level`, and `membership_active`; these reflect the linked account. Owner memberships remain Owner/Max regardless of roster defaults. Do not send these server-owned fields back to `save_lab_member`.

Email is normalized to lowercase and unique per colony, including archived records. Current unarchived acronyms are uppercase and unique per colony. Missing contacts are allowed. A claimed account's email cannot be reassigned through the roster. Current linked nonowner access changes update membership atomically. Moving a linked person to historical/review or archiving deactivates membership. Restoring roster status does not undo account deactivation; an owner must use explicit account access management.

Errors use `40001` for stale/missing records, `23505` for duplicate identifiers, `22023` for invalid data, and `42501` for denied access. Save forms should explain membership consequences before submission.

## First-time account setup

`get_my_lab_member(p_colony_id)` requires authentication and checks the server's Auth email. It returns only the caller's matching current, unarchived record, with no provenance or private notes. Unverified, unregistered, historical/review, already-claimed-by-another-account, and disabled accounts receive no member record:

```json
{"member":null,"eligible":false,"setup_required":false,"reason":"not_registered"}
```

Other denial reasons are `email_unverified` and `access_disabled`. An eligible response is:

```json
{
  "member":{"person_id":"UUID","name":"Example","email":"person@example.org","phone":null,"acronym":"EX","category":"postdoc","status":"current","username":null,"version":1,"effective_role":"editor","effective_export_level":"low"},
  "eligible":true,"setup_required":true,"has_password":false,"reason":"password_required"
}
```

The remaining eligible reasons are `username_required` and `ready`. `complete_lab_member_setup(p_colony_id,p_username)` returns the same envelope. It requires the Auth user's verified email and a nonempty stored password hash, then atomically links the current preregistration and assigns its owner-approved role/export level. It accepts a lowercase username matching `[a-z][a-z0-9_.-]{2,31}`, normalizing case and surrounding spaces, unique per colony. It never trusts client metadata for identity or privileges. Repeating completed setup with the same username is harmless; it cannot change usernames, restore disabled membership, or grant access again after revocation. An owner can claim a seeded own roster record without changing Owner/Max access.

`get_lab_user_directory(p_colony_id)` requires an active colony member and returns `{users:[{code,name}]}` for current unarchived roster entries with acronyms, including preregistrations. It contains no contacts, notes, provenance, or historical members.

Apply `account-acronym.sql` after this migration to enable `update_my_lab_acronym(p_colony_id,p_acronym,p_expected_version)`. A user with a server-verified email matching their eligible current roster profile can change only their own acronym, including an owner before username setup. Acronyms normalize to uppercase and use 1–12 characters, beginning with a letter and followed by letters, numbers, underscores or hyphens. The current profile version is required; stale changes fail with `40001`, and a collision with another current member fails with `23505`. Disabled, historical, review, foreign-colony and unverified accounts cannot change acronyms. The RPC returns the normal self-profile envelope and records its real actor in the private audit. It changes no account credentials, roles, export levels, status, username or past experiment logs. Keep the lab ID consistent across logs; existing recorded IDs remain unchanged.

## Onboarding boundary

Public signup and verification delivery remain separate Auth operations. The private roster does not itself create Auth accounts or send messages. An unaffiliated but authenticated user can call the self-setup RPC, but only a server-verified email matching an approved current preregistration can gain membership. A public username login resolver must remain a server-only operation, enforce rate limits and uniform failure responses, and never return roster contact lookups. Passwords and password hashes are never returned by these roster RPCs.

The `username-sign-in` Edge Function retains gateway JWT verification. The browser sends the project's public legacy anon JWT in both `apikey` and `Authorization: Bearer` headers; this authenticates the project request, while the handler independently verifies the account password and current membership. This deployment bundles that public JWT as `PUBLIC_CONFIG.usernameAnonKey`, used only for username login when the saved project URL and colony UUID both exactly match the bundled deployment and the normal key is `sb_publishable_`. Ordinary Auth and REST calls continue to use the configured publishable key and, where required, the user's session token. The gateway key is not substituted into saved configuration or returned account data. An explicitly configured legacy anon key takes precedence. Other projects or colonies cannot use the bundled fallback; they need their own configured public legacy anon key for username login, or can continue with email sign-in. The publication guard verifies the bundled JWT has the public `anon` role. Never substitute a service-role key.

Run `node --no-maglev --test supabase/tests/lab-members.test.mjs` for PostgreSQL security, privacy, claim, audit, CAS, and revocation checks.
