-- Read-only verification as SQL-editor administrator; no users or records created.
do $$begin
 perform colony_private.validate_payload('mice','test','{"mouse_sid":"test","sex":"Female","date_of_birth":"2026-10-14","genotype":null,"dam_sids":["10","11"]}');
 perform colony_private.validate_payload('light_events','test','{"event_id":"test","start_date":null,"cycle_hours":23,"light_hours":11.5}');
end$$;
select jsonb_build_object(
 'valid_date_and_non24h_samples','PASS',
 'date_regex','2026-10-14' ~ '^\d{4}-\d{2}-\d{2}$',
 'rls_all',(select bool_and(coalesce(c.relrowsecurity,false)) from unnest(array['colonies','memberships','entity_records','audit_log','sheet_sync_state']) n left join pg_class c on c.oid=to_regclass('public.'||n)),
 'client_table_acl',(select bool_and(has_table_privilege('authenticated','public.'||n,'SELECT') and not has_table_privilege('authenticated','public.'||n,'INSERT,UPDATE,DELETE,TRUNCATE') and not has_table_privilege('anon','public.'||n,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) from unnest(array['colonies','memberships','entity_records','audit_log']) n),
 'rpc_acl',(select bool_and(coalesce(p.prosecdef and has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE'),false)) from unnest(array['public.save_record(uuid,text,text,jsonb,integer,boolean)','public.save_records(uuid,jsonb)','public.create_colony(text)','public.set_member_role(uuid,uuid,text,boolean)']) s left join pg_proc p on p.oid=to_regprocedure(s)),
 'private_history_bucket',exists(select 1 from storage.buckets where id='colony-history' and not public),
 'history_path_regex',colony_private.history_path_colony('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/history/'||repeat('a',64)||'.json') is not null
) as verification;
