# Owner approval of a different registration email

Apply `member-email-approval.sql` after `lab-members.sql`, `manager-permissions.sql`, and `account-profile.sql`. It is rerunnable and performs no approval or membership change during installation. It adds `lab_members.secondary_emails`, a server-managed text array exposed through the existing owner-only roster. These addresses are contacts only; authentication and account setup continue to use the primary email.

The owner explicitly chooses a verified self-registration request and the corresponding Current member. Names never establish the association automatically. An unclaimed member can use the approved email to finish registration. An already registered member keeps the working login and receives the approved address as a secondary contact only. The UI shows both emails, the selected member, the applicable action, and assigned role/export level before approval.

## RPC contract

`approve_lab_member_email(p_colony_id uuid, p_request_person_id uuid, p_request_version integer, p_target_person_id uuid, p_target_version integer)`

Only an active, verified, enabled owner can execute it. Both versions must still match. A successful response is:

```json
{
  "member": {"person_id": "existing-current-person-id", "email": "verified-registration-email", "secondary_emails": ["previous-invitation-email"], "version": 2},
  "merged_request": {"person_id": "request-person-id", "version": 2, "archived": true},
  "setup_required": true,
  "approval_kind": "login_email",
  "approved_email": "verified-registration-email"
}
```

`member` contains the complete existing owner roster payload. The illustrated versions are examples; each record advances by one. For `login_email`, the member remains unclaimed until the registrant completes the normal username/password setup. The response should not be described as completed registration.

For an already registered destination, the response has `approval_kind: "secondary_contact"`, `setup_required: false`, and `approved_email` equal to the reviewed request address. The member's primary `email`, `linked_user_id`, and `username` remain unchanged; the reviewed address is added to `secondary_emails`. The request is archived with the same `merged_request` shape. This does not complete or grant access to the alternate Auth account.

## Eligibility and changes

- The request must be unclaimed, unarchived Review, with `verified_self_request` provenance and an original self-registration audit entry. Its creator must be the exact enabled, verified Auth account with that primary email and no pending Auth email change. Any existing membership, including inactive or other-colony membership, prevents merging.
- The destination must be unarchived Current with a different primary email. Its person ID, name, profile details, notes, assigned role/export level, and existing references stay intact. The following invitation-transfer rules apply only when it is unclaimed.
- The original email may have no Auth account. If it has one, that account must be an enabled, unverified invitation without a pending email change. Confirmed, anonymous, banned, deleted, linked, owner, disabled, or other-colony accounts are rejected.
- An existing invitation membership must have exactly the destination's displayed role/export level. A mismatch requires the owner to review those settings first. Its custom permission flags are preserved; otherwise normal defaults apply.
- The approved email becomes the destination's primary email. Its former email is retained in `secondary_emails`, deduplicated with existing contacts. The new primary email is removed from the secondary list.
- The request is archived without deletion. Its primary email is cleared to release the unique constraint. Submitted details and audit history remain. `provenance.email_approval.merged_into_person_id` identifies the preserved destination; `approved_email` retains the submitted email.
- A new active membership is created for the verified account using the reviewed destination access. Any original unverified invitation membership is disabled, retaining its old rights and audit. Both membership changes record the actual owner as actor.

For an already registered destination:

- The existing primary Auth account must exactly match the member's linked user ID and primary email, be verified and enabled, and have no pending email change. Its active membership must be non-owner and match the displayed assigned role/export level. Inconsistent or disabled accounts require separate owner review.
- The alternate request remains subject to all verified-self-request, owner, version, and identity checks above. An address already held as another member's secondary contact is rejected.
- The approved address is added to the destination's secondary contacts; the primary address is excluded and contacts are deduplicated. The current primary email, username, linked user ID, provenance (including earlier login approval), membership, export level and custom permission flags remain unchanged.
- The request is archived, its primary email cleared, and its preserved `provenance.email_approval` records `approval_kind: "secondary_contact"`, the reviewed email and the destination person ID. The immutable roster audit records the owner and before/after changes.
- Neither Auth nor memberships are changed. The alternate account receives no login access or setup eligibility. The existing primary account continues working. No membership audit event is fabricated.
- `get_my_lab_member` returns `secondary_contact_only`, with no profile data and registration disabled, for this resolved alternate account. The decision uses its original verified self-request and immutable owner-approval audits. It prevents duplicate pending requests even after the target is moved to Historical, a contact is removed, or the alternate Auth email changes. Converting that resolved identity into a login requires a separate explicit owner workflow; this action does not provide one.

The function never changes Auth email addresses, passwords, tokens, or account metadata, and sends no invitation or email. Secondary contacts do not grant login access. For an unclaimed destination transferred to a new login email, the original invitation link cannot claim the preserved member afterward; an original membership, if present, is inactive.

The migration also includes the canonical `save_lab_member` update from `lab-members.sql`. Before username setup, the approved account is bound to its preserved member through immutable owner approval audit, not editable provenance. Ordinary roster saves cannot add, change, or remove the reserved `provenance.email_approval` key; only the approval action writes it. The owner can revoke the account by moving the member to Review/Historical or archiving it, even if the recipient has changed their Auth email. Restoring Current does not reactivate a disabled membership. The pending primary email is protected from reassignment through ordinary roster editing. This resolver is limited to email-approved accounts and the existing owner-account rule; unrelated unclaimed invitation behavior is unchanged.

The canonical `get_my_lab_member` from `account-profile.sql` is included too. A pending approved account whose Auth email no longer matches its preserved member returns `account_conflict`; it cannot create a duplicate Current profile or complete setup against another identity.

The transaction locks the colony and both roster rows, checks versions, and locks the relevant Auth identities in ID order with `FOR UPDATE`. This prevents changes to verification state and concurrent foreign-key membership inserts while validation is in progress. Foreign memberships are rejected without taking their row locks. An unexpected membership conflict aborts the whole operation; no partial merge is retained.

## Verification

```sh
/tmp/braintime-node20-repro/node-v20.9.0-darwin-arm64/bin/node --test supabase/tests/member-email-approval.test.mjs
```

Tests cover registered-member contact approval without Auth or membership changes, preservation of prior approval provenance and working primary sign-in, refusal of conflicting/disabled registered accounts, no alternate login grant, prevention of repeated contact-only registration and resistance to forged approval provenance, normal setup after unclaimed-member approval, original contact retention, unchanged Auth records, custom permissions, old and pending access revocation, actor audit, reruns, stale versions, owner-only access, claimed/historical/disabled/conflicting identities, duplicate normalized emails, pending email changes, owner-RPC provenance forgery, prevention of duplicate profiles after an Auth email change, and access mismatches. Rejected calls are checked for unchanged database state. The migration's roster-save and self-profile functions are compared with the canonical definitions. PGlite does not exercise concurrent PostgreSQL sessions; lock semantics are reviewed separately.

For deployment, apply only the schema/function migration and verify its definition and grants without approving a real request. Each actual email association requires the owner's explicit selection in the application.
