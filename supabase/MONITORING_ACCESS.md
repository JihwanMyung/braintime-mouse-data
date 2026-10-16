# Monitoring and source archive access

Apply `monitoring-archive-access.sql` after the current domain, fee visibility,
managed-location and Brainbot migrations. Deploy the matching browser client
(v65 or later) first so it accepts role-restricted source projections.

| Feature | View | Change |
| --- | --- | --- |
| Braintime Bot | Owner, Manager, or active High/Max membership | Owner only |
| Source archive | Owner or Manager, subject to configured fee visibility | Existing record-edit and full-source permissions |
| Fee amounts | Owner-configured estimate/actual visibility | Existing edit permissions and both fee flags |

Only Owner and Manager are displayed as role labels. History tiers remain
available in owner-only access controls. Normal exports show date windows.

The migration does not change memberships, stored records, scheduled tasks or
Bot correction rules. Raw archive, location source blocks, fee source references
and source snapshots are protected in direct reads, audit reads and storage.
Managed locations and fee amounts remain available through projections.
Ordinary fee editors add dated revisions; moving a source invoice between months
requires source access. Hidden source references are retained on revisions.

`get_brainbot_status` returns `can_manage`; only the owner receives true. Read-only
viewers receive projected correction records. Mutation RPCs retain their
existing owner check.

Validation: `supabase/tests/monitoring-archive-access.test.mjs` exercises the real
PostgreSQL policies and functions, including raw-source bypasses, account roles,
fee projections and owner-only mutations. Browser tests cover role labels,
protected routes, forged actions and account changes during archive operations.
