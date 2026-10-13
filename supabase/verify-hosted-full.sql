-- Run in the Supabase SQL editor as database administrator after all three SQL files.
-- This inspects catalog permissions and tests pure validation only. No colony,
-- user, membership, entity, object or audit rows are created or modified.
begin;
create temporary table colony_verification(check_name text, passed boolean, detail text) on commit drop;

insert into colony_verification
select 'RLS enabled: '||name, coalesce(c.relrowsecurity,false), coalesce(c.relname,'TABLE MISSING')
from unnest(array['colonies','memberships','entity_records','audit_log','sheet_sync_state']) name
left join pg_class c on c.oid=to_regclass('public.'||name);

insert into colony_verification
select 'Client table privileges: '||name,
  has_table_privilege('authenticated','public.'||name,'SELECT')
  and not has_table_privilege('authenticated','public.'||name,'INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege('anon','public.'||name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
  'authenticated SELECT only; anon no read/write'
from unnest(array['colonies','memberships','entity_records','audit_log']) name;

insert into colony_verification
select 'Client RPC present and protected: '||signature,
  coalesce(p.prosecdef,false)
  and coalesce(has_function_privilege('authenticated',p.oid,'EXECUTE'),false)
  and not coalesce(has_function_privilege('anon',p.oid,'EXECUTE'),true)
  and exists(select 1 from unnest(p.proconfig) cfg where cfg in ('search_path=""','search_path=')),
  coalesce(array_to_string(p.proconfig,', '),'FUNCTION MISSING')
from unnest(array['public.save_record(uuid,text,text,jsonb,integer,boolean)',
  'public.save_records(uuid,jsonb)','public.create_colony(text)',
  'public.set_member_role(uuid,uuid,text,boolean)']) signature
left join pg_proc p on p.oid=to_regprocedure(signature);

insert into colony_verification
select 'Sheet RPC service-only: '||signature,
  coalesce(has_function_privilege('service_role',p.oid,'EXECUTE'),false)
  and not coalesce(has_function_privilege('authenticated',p.oid,'EXECUTE'),true)
  and not coalesce(has_function_privilege('anon',p.oid,'EXECUTE'),true),
  coalesce(p.proname,'FUNCTION MISSING')
from unnest(array['public.claim_sheet_sync(uuid)','public.sheet_sync_snapshot(uuid,uuid)',
  'public.finish_sheet_sync(uuid,uuid,boolean,text)']) signature
left join pg_proc p on p.oid=to_regprocedure(signature);

insert into colony_verification
select 'Pure validator not executable by clients',
 not has_function_privilege('authenticated','colony_private.validate_payload(text,text,jsonb)','EXECUTE')
 and not has_function_privilege('anon','colony_private.validate_payload(text,text,jsonb)','EXECUTE'),
 'Only authorized save RPC calls validation for clients';

insert into colony_verification
select 'Required audit/retention trigger: '||name,
 exists(select 1 from pg_trigger where tgname=name and not tgisinternal and tgenabled<>'D'),
 'Audit inserts and updates; block entity deletion and audit changes'
from unnest(array['entity_records_audit','entity_records_no_delete','audit_log_immutable']) name;

insert into colony_verification
select 'Private history bucket', exists(select 1 from storage.buckets where id='colony-history'
 and public=false and file_size_limit=83886080), '80 MiB; never public';
insert into colony_verification
select 'Restrictive history storage guard: '||name,
 exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
 and policyname=name and permissive='RESTRICTIVE'), 'Broad pre-existing storage policies cannot override this guard'
from unnest(array['colony_history_private_guard','colony_history_insert_guard',
 'colony_history_no_update','colony_history_no_delete','colony_history_no_anon']) name;

insert into colony_verification values
 ('Regex: canonical dates match', '2026-10-14' ~ '^\d{4}-\d{2}-\d{2}$', 'Tests actual hosted SQL backslash handling'),
 ('Regex: malformed dates do not match', not ('2026/10/14' ~ '^\d{4}-\d{2}-\d{2}$'), 'Calendar validity is tested separately'),
 ('Regex: valid archive content ID', ('chunk:'||repeat('a',64)) ~ '^chunk:[0-9a-f]{64}$', 'Exact lower-case hex length'),
 ('Regex: invalid archive content ID', not ('chunk:ABC' ~ '^chunk:[0-9a-f]{64}$'), 'No truncated or upper-case IDs');

do $verify$
declare t record; rejected boolean;
begin
 perform colony_private.validate_payload('mice','verify-only',
  '{"mouse_sid":"verify-only","sex":"Female","date_of_birth":"2026-01-01","genotype":null,"dam_sids":["10","11"],"sire_sids":[]}'::jsonb);
 insert into colony_verification values('Mouse accepts unknown genotype and candidate dams',true,'Pure function only; no record saved');
 perform colony_private.validate_payload('light_events','verify-light',
  '{"event_id":"verify-light","start_date":null,"end_date":null,"cycle_hours":23,"light_hours":11.5,"transition_minutes":30,"intensity_lux":150}'::jsonb);
 insert into colony_verification values('Lighting accepts non-24-hour cycle and unknown dates',true,'No 24-hour or effective-date default');
 perform colony_private.validate_payload('archive','chunk:'||repeat('a',64),
  '{"format":"colony-archive-chunk-v1","table":"historical_observations","rows":[]}'::jsonb);
 insert into colony_verification values('Archive chunk shape accepted',true,'Codec verifies content hash; SQL validates shape and immutability');
 for t in select * from (values
  ('mouse_invalid_sex','mice','verify-only','{"mouse_sid":"verify-only","sex":"invalid"}'::jsonb),
  ('mouse_invalid_calendar_date','mice','verify-only','{"mouse_sid":"verify-only","date_of_birth":"2026-02-30"}'::jsonb),
  ('mouse_self_parent','mice','verify-only','{"mouse_sid":"verify-only","dam_sids":["verify-only"]}'::jsonb),
  ('light_hours_exceed_cycle','light_events','verify-light','{"event_id":"verify-light","cycle_hours":23,"light_hours":24}'::jsonb),
  ('light_negative_intensity','light_events','verify-light','{"event_id":"verify-light","intensity_lux":-1}'::jsonb),
  ('archive_invalid_id','archive','chunk:bad','{"format":"colony-archive-chunk-v1","table":"x","rows":[]}'::jsonb)
 ) cases(name,kind,id,payload) loop
  rejected:=false;
  begin perform colony_private.validate_payload(t.kind,t.id,t.payload);
  exception when sqlstate '22023' then rejected:=true; end;
  insert into colony_verification values('Validation rejects: '||t.name,rejected,'Expected SQLSTATE 22023');
 end loop;
end $verify$;

select check_name,case when passed then 'PASS' else 'FAIL' end as result,detail
from colony_verification order by passed,check_name;
rollback;
