# Own profile and registration requests

Apply `account-profile.sql` after `lab-members.sql` and `account-acronym.sql`. It is rerunnable. It enables new profile requests only for the configured Braintime colony, `57a26815-ca94-413b-891a-e0e85ff59d69`. Other colonies remain closed. The private `colony_private.account_profile_registration` table has no client grants; rerunning the migration preserves an administrator's later disable.

The caller must already have a verified, enabled Supabase Auth session. These RPCs do not create Auth accounts, send email, or change passwords. A new person is added to the owner's private **Review** roster, without a username, linked account or membership grant. The owner must approve the row as **Current** before normal account setup can grant its configured access. Pre-existing membership rights are not revoked by submitting a profile.

Historical, archived, disabled, anonymous, unverified, banned, deleted and conflicting identities cannot request registration or complete setup. Changing an Auth email does not create a second profile around an existing linked identity. Review users can read and edit only their own safe profile fields, not the roster, application data or intended privileges.

## Client contract

`get_my_lab_member(p_colony_id)` returns the existing setup response plus `registration_allowed`:

| State | eligible | setup_required | registration_allowed | member.version |
| --- | --- | --- | --- | --- |
| No roster row, requests enabled | false | false | true | 0 |
| Review, unlinked | false | false | true | actual version |
| Current, unlinked | true | true | true | actual version |
| Current, linked and enabled | true | false | true | actual version |
| Denied | false | false | false | no member |

Retain a setup-only session when `(eligible && setup_required) || (!eligible && registration_allowed)`. A linked Current user's ordinary role remains active.

`submit_my_lab_profile(p_colony_id, p_profile, p_expected_version)` accepts only:

- `name`: required after merging, 1–200 characters.
- `phone`: optional, up to 80 characters.
- `acronym`: optional, normalized uppercase, 1–12 characters matching `[A-Z][A-Z0-9_-]*`.
- `category`: one of the existing roster categories.

Omitted fields preserve their current values. Null or blank clears optional phone/acronym fields. No control characters or nested values are accepted. The request is bounded to 4 KiB. The server obtains the email and actor from Auth; the client cannot submit identity, status, role, export access, username, linkage or private roster fields.

Use expected version `0` for a new request and the returned `member.version` for subsequent updates. A stale version fails with SQLSTATE `40001`. An unchanged normalized submission is a verified no-op with the **same version** and no audit entry; a real update increments the version. The response is the refreshed `get_my_lab_member` shape. UI save confirmation must accept matching same-version fields rather than require an increment.

Profile updates share the colony lock with owner roster changes and setup. They preserve approvals, privileges, private notes and provenance. New requests and actual changes use the existing private roster audit with the real authenticated actor. `complete_lab_member_setup` retains its existing Current-only workflow and adds the same enabled-identity guard.

## Verification

Run the isolated PostgreSQL tests with the already-installed PGlite dependency:

```sh
/tmp/braintime-node20-repro/node-v20.9.0-darwin-arm64/bin/node --test supabase/tests/account-profile.test.mjs
```

The tests exercise reruns, allowlist isolation, Auth and roster exclusions, owner approval, version conflicts, no-op behavior, private field preservation, normal manager access after approval, and a rollback-only deployment proof. They do not access production.

After deployment, inspect the three function definitions and their grants, then call `get_my_lab_member` through an existing authorized account. A read must not change the roster, memberships or audit count. Do not create a live test account or grant access solely to prove the migration.
