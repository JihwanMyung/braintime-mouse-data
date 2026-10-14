# Export permissions

Apply `export-permissions.sql` after `schema.sql` and `functions/manage-colony-users/membership.sql`, then deploy the updated user-management handler. The bundle builder includes both numbered migrations. If the original membership migration is reapplied later, reapply the export migration last: it removes the old five-argument membership overload to avoid ambiguous PostgREST calls.

The migration defaults existing and new nonowners to **Low**. Owners are **Max**. Export permission is independent of owner/editor/viewer access. Owner management requests accept `export_level: low|high|max`. Omission retains an existing level on updates; invitations default to Low. Owner rows remain protected. Changes retain the authenticated audit actor.

| Level | Historical window |
| --- | --- |
| Low | Server's current Taipei date minus three calendar years |
| High | Server's current Taipei date minus six calendar years |
| Max | All available history |

The cutoff is inclusive and uses calendar-year arithmetic, including leap-day adjustment. Requests before the allowed cutoff or after the current date fail rather than being silently clipped. A current housing snapshot includes current Stock mice even if their birth predates the cutoff.

## RPCs

`get_export_permission(p_colony_id uuid)` returns `{level, cutoff_date, as_of_date, full_history, captured_at}`. Dates are YYYY-MM-DD; `captured_at` is the actual server timestamp with timezone, and Max has null cutoff and `full_history: true`.

`assert_full_export_permission(p_colony_id uuid)` returns that object for Max, otherwise SQLSTATE `42501`. Check freshly before supported raw backup/source export actions, including again after a long fetch before generating the file. Never authorize from cached Auth metadata.

`export_records(p_colony_id uuid, p_scope text default 'current_housing', p_from_date date default null, p_to_date date default null, p_entity_types text[] default null, p_offset integer default 0, p_limit integer default 250)` returns:

```json
{
  "rows": [{"entity_type":"mice","entity_id":"EXAMPLE","record_date":"2024-01-01","payload":{"mouse_sid":"EXAMPLE","state":"Stock"}}],
  "next_offset":null,
  "export_level":"low",
  "cutoff_date":"2023-10-14",
  "as_of_date":"2026-10-14",
  "captured_at":"2026-10-14T01:23:45+00:00",
  "snapshot_revision":"42",
  "scope":"history",
  "from_date":"2023-10-14",
  "to_date":"2026-10-14",
  "excluded_undated":3
}
```

`current_housing` returns nonarchived Stock mice; Active/Occupied cages and cages referenced by current Stock mice or explicitly linked to a nonarchived position; nonarchived rooms/racks/positions; and dated ongoing light records. Position origin is reduced to an app-created/source-recorded classification so empty app positions retain their meaning without exporting source notes. Light intervals use each event's valid timezone (Taipei fallback) and exclusive end semantics where explicitly recorded. Unknown-start light records cannot establish current exposure. This scope rejects date arguments and unrelated entity types.

`history` filters managed record types by these domain dates, using the first valid populated value:

| Entity | Domain date |
| --- | --- |
| Mouse | end date, birth date |
| Mating | disbanded date, setup date |
| Litter | end date, weaning date, birth date |
| Cage | end date, setup date |
| Light event | end date, start date |
| Husbandry event | effective event date |
| Cryopreservation lot | inventory assessment date, freezing date |
| Room/rack/position | Undated |

Undated rows are included only for Max with no lower-date constraint, and retain `record_date: null`. Otherwise `excluded_undated` counts them. Future-dated rows are excluded. Import, application update and source snapshot dates never make old rows eligible. A cryopreservation review's registration date does not replace its freezing/stock date.

Every report payload uses a bounded field allowlist. Source fields, raw snapshots, comments, notes, arbitrary nested values, audit history and archive chunks are excluded, including for Max. Cryopreservation nested fields have a separate projection. Raw genotype text remains a bounded scalar; structured genetic profiles are not included. Preservation backups use the separate Max workflow.

Pages contain at most 250 rows and 800,000 bytes of projected row JSON, plus small metadata. Follow `next_offset`, which advances by actual returned rows. Compare `snapshot_revision`, `export_level`, `cutoff_date` and `as_of_date` across every page; abort and regenerate the preview if they change. The revision is the largest colony audit ID serialized as text. This detects committed changes between pages without holding a database transaction open during file generation.

## Boundary

These controls govern supported export workflows, not existing viewing rights. Member RLS reads, pedigree views, private-history viewing and local working copies remain available. Authorized users can inspect or copy data already delivered for those views, and permissions cannot retract earlier files. Restricting historical reads would require a separate access-control and application redesign. Keep viewing helpers distinct from explicit export actions.

Anonymous, inactive and cross-colony callers cannot use export RPCs. Direct membership writes and private projection helpers remain revoked. User-controlled Auth metadata never determines permission. Database administrators retain administrator powers.

## Tests

```sh
node --test supabase/tests/export-permissions.test.mjs supabase/tests/user-management.test.mjs
```

These execute the migration in PostgreSQL through PGlite and cover defaults/reruns, role separation, calendar cutoffs, domain-date filtering, unknown dates, current old-born animals, source stripping, page limits/revisions, downgrade/revocation, cross-colony/anonymous denial, metadata spoofing, helper grants, retained viewing access, invitation failures and partial outcomes.
