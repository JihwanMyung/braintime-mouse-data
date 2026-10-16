# Cage manager choices

Apply `cage-managers.sql` after `member-email-approval.sql`. The migration checks for the guarded owner-save implementation before replacing it. It is rerunnable and contains no personal records or membership changes.

`lab_members.cage_manager_eligible` is a non-null boolean, default `false`. It controls whether an owner-selected Historical member appears in cage manager choices. Current members appear automatically; Review and archived records never appear. Selecting a Historical member does not restore their account or grant any access.

The owner saves this field through `save_lab_member` with the normal person ID and version. Only JSON booleans are accepted. Omission preserves the existing value, including on quick status changes; new records default to false. Self-profile submission does not accept this field. The ordinary private roster and audit retain their owner-only restrictions.

## Directory contract

`list_cage_managers(p_colony_id uuid)` returns:

```json
{
  "managers": [
    {"person_id": "uuid", "name": "Full Name", "acronym": "FN", "nickname": null, "status": "current"}
  ]
}
```

Only verified, enabled, active members of that colony can read it. Current choices come first, followed by selected Historical choices, each sorted by case-insensitive name and person ID. `nickname` is a trimmed string from the recorded nickname, or null. No email, phone, private notes, other provenance, account role, export level, or permission flags are returned.

Explicit `service_account`, `is_service_account`, `is_bot`, or service/bot `account_type` markers exclude service identities. The known Braintime Bot/Brainbot Bot name with acronym BB is excluded too. Other names are not inferred to be bots.

The RPC supplies choices, not cage assignments. Applying a choice to a cage remains an independently authorized record edit. Existing historical manager values can remain visible even when absent from the current choices.

## Source consistency

`lab-members.sql` contains the authoritative column and owner-save implementation. `cage-managers.sql` embeds the same guarded save function. The maintained `member-email-approval.sql` copy is also updated and ensures the column exists, so rerunning that upgrade does not replace the owner-save function with an older field list. Email approval's reserved provenance, pending account revocation, disabled-access preservation, and owner protections remain intact.

## Tests and deployment proof

```sh
/tmp/braintime-node20-repro/node-v20.9.0-darwin-arm64/bin/node --test supabase/tests/cage-managers.test.mjs
```

Tests cover an existing table without the column, reruns preserving selections, authorized/foreign/disabled access, exact public fields, bot exclusion, owner-only boolean validation, partial updates, version conflicts, unchanged account rights, rejected self edits, and the canonical function copy. The related roster, account profile, and email approval suites also verify their existing guards.

For a rollback-only deployment proof, record roster hashes using `to_jsonb(p) - 'cage_manager_eligible'` before and after the migration, full membership hashes, and roster/account audit counts. They must remain unchanged. On first installation, confirm every new eligibility flag is false. On reruns, compare full roster rows so existing owner selections are proven preserved. Check that the RPC returns only the documented five fields and that invoking it adds no audit rows. Do not select a Historical person or edit a live cage merely to test deployment.
