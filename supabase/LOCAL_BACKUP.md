# Local-download backup gate

`local-backup.sql` adds a separate High/Max-only gate without changing ordinary exports (Low remains three years, High six years, Max full history). Apply it after the maintained export migrations, including the fee/experiment/IACUC wrappers. It delegates to the current `public.export_records` so their visibility and payload protections remain authoritative.

`get_local_backup_permission(p_colony_id)` returns the ordinary export permission fields plus `local_backup_allowed`, `backup_scope` (`bounded` or `full`) and `no_whole_workspace_restore`. Low, revoked, anonymous and service-role callers are denied. High is a partial data package, not a full database restore. Current living animal context can precede the historical cutoff, as in the existing current-housing export.

`export_local_backup_records` accepts the same seven arguments as `export_records`, plus optional `p_expected_revision`. Each page rechecks High/Max and validates the returned permission metadata. Once the first page supplies `snapshot_revision`, pass it on later current/history pages to reject concurrent changes (`40001`); the browser must also check all page metadata and repeat the permission check before delivering the file. High must collect current housing and bounded history separately and label the resulting artifact as partial with no whole-workspace restore. Max full raw-workspace backup still uses the existing Max-only method and its additional source/fee visibility gates; this wrapper does not bypass those gates or assert an unredacted full backup.

Reagents must call this shared permission gate before any separately implemented local backup flow; this migration does not add a Reagents backup payload exporter. Existing ordinary Reagents access APIs are unchanged. Neither application may treat a disabled button as the authorization boundary.

Tests: `node --test supabase/tests/local-backup.test.mjs`.
