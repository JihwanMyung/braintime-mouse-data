-- Apply after brainbot.sql, lac-fee-visibility.sql and current domain migrations.
-- Read-only BB monitoring is distinct from owner-only controls and raw archives.
begin;
create or replace function colony_private.can_read_source_archive(c uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(colony_private.current_role(c) in ('owner','manager'),false)
$$;
create or replace function colony_private.source_archive_record(kind text,p jsonb)
returns boolean language sql immutable set search_path='' as $$
 select kind='archive' or kind='locations' or coalesce(colony_private.fee_is_record(kind,p),false) or kind='husbandry_events' and
 (coalesce(p->>'event_type','') in ('animal_sheet_cage_snapshot','animal_sheet_source_change')
  or coalesce(p ?| array['source_cage_snapshot','animal_sheet_change'],false))
$$;
revoke all on function colony_private.can_read_source_archive(uuid),colony_private.source_archive_record(text,jsonb) from public,anon,authenticated;
grant execute on function colony_private.can_read_source_archive(uuid),colony_private.source_archive_record(text,jsonb) to authenticated;
create or replace function public.get_lac_fee_visibility(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships%rowtype;config colony_private.lac_fee_visibility%rowtype;levels jsonb;allowed jsonb;is_owner boolean;
begin
 select * into m from public.memberships where colony_id=p_colony_id and user_id=auth.uid() and active;
 if m.user_id is null then raise exception using errcode='42501',message='Active membership is required';end if;
 select * into config from colony_private.lac_fee_visibility where colony_id=p_colony_id;
 levels:=coalesce(config.levels,'{"low":{"estimate":true,"actual":true},"high":{"estimate":true,"actual":true},"max":{"estimate":true,"actual":true}}');
 is_owner:=m.role='owner';allowed:=case when is_owner then '{"estimate":true,"actual":true}'::jsonb else levels->m.export_level end;
 return jsonb_build_object('version',coalesce(config.version,0),'owner',is_owner,'estimate',(allowed->>'estimate')::boolean,'actual',(allowed->>'actual')::boolean,
 'source_archive_allowed',m.role in ('owner','manager') and (allowed->>'estimate')::boolean and (allowed->>'actual')::boolean)||case when is_owner then jsonb_build_object('levels',levels) else '{}'::jsonb end;
end $$;

create or replace function colony_private.fee_full_access(p_colony_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
 if colony_private.current_role(p_colony_id) is null then return false;end if;
 return (public.get_lac_fee_visibility(p_colony_id)->>'estimate')::boolean and (public.get_lac_fee_visibility(p_colony_id)->>'actual')::boolean;
end $$;

create or replace function public.get_lac_fee_records(p_colony_id uuid,p_offset integer default 0,p_limit integer default 250)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare policy jsonb;rows jsonb;
begin
 policy:=public.get_lac_fee_visibility(p_colony_id);
 if p_offset is null or p_offset<0 or p_offset>1000000 or p_limit is null or p_limit not between 1 and 250 then raise exception using errcode='22023',message='Invalid fee page';end if;
 select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('payload',colony_private.fee_payload(r.payload,(policy->>'estimate')::boolean,(policy->>'actual')::boolean,(policy->>'source_archive_allowed')::boolean))),'[]') into rows from
 (select colony_id,entity_type,entity_id,payload,version,archived from public.entity_records where colony_id=p_colony_id and colony_private.fee_is_record(entity_type,payload) order by entity_id collate "C" offset p_offset limit p_limit) r;
 return jsonb_build_object('visibility',policy,'rows',rows,'next_offset',case when jsonb_array_length(rows)=p_limit then p_offset+p_limit else null end);
end $$;

create or replace function public.assert_full_export_permission(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permission jsonb;
begin
 permission:=public.get_export_permission(p_colony_id);
 if permission->>'level'<>'max' or not colony_private.can_read_source_archive(p_colony_id) or not colony_private.fee_full_access(p_colony_id) then raise exception using errcode='42501',message='Your account cannot export the full source archive';end if;
 return permission;
end $$;

create or replace function public.get_brainbot_status(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare cfg colony_private.brainbot_settings%rowtype;scheduled boolean:=false;rs jsonb;iss jsonb;n integer;member public.memberships%rowtype;can_raw boolean;item jsonb;change jsonb;safe_runs jsonb:='[]';safe_changes jsonb;
begin
 select * into member from public.memberships where colony_id=p_colony_id and user_id=auth.uid() and active;
 if member.user_id is null or (member.role not in ('owner','manager') and member.export_level not in ('high','max')) then
  raise exception using errcode='42501',message='Your account cannot view Braintime Bot';end if;
 can_raw:=(public.get_lac_fee_visibility(p_colony_id)->>'source_archive_allowed')::boolean;
 select * into cfg from colony_private.brainbot_settings where colony_id=p_colony_id;
 if to_regclass('cron.job') is not null then execute 'select exists(select 1 from cron.job where jobname=$1 and active)' into scheduled using 'brainbot-'||p_colony_id::text;end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc),'[]') into rs from (select * from colony_private.brainbot_runs where colony_id=p_colony_id order by started_at desc limit 20) r;
 select count(*) into n from colony_private.brainbot_issues where colony_id=p_colony_id;
 select coalesce(jsonb_agg(to_jsonb(i) order by i.status='resolved',i.last_seen_at desc),'[]') into iss from (select * from colony_private.brainbot_issues where colony_id=p_colony_id order by status='resolved',last_seen_at desc,issue_id limit 200) i;
 if not can_raw then
  for item in select value from jsonb_array_elements(rs) loop
   safe_changes:='[]';
   for change in select value from jsonb_array_elements(coalesce(item->'changes','[]')) loop
    safe_changes:=safe_changes||jsonb_build_array(colony_private.export_fields(change,array['entity_type','entity_id','fields','before_version','after_version'])||
      jsonb_build_object('before',colony_private.export_payload(change->>'entity_type',change->'before'),'after',colony_private.export_payload(change->>'entity_type',change->'after')));
   end loop;
   safe_runs:=safe_runs||jsonb_build_array(jsonb_set(item,'{changes}',safe_changes));
  end loop;
  rs:=safe_runs;
 end if;
 return jsonb_build_object('can_manage',member.role='owner','principal' ,jsonb_build_object('principal_id',cfg.principal_id,'name','Braintime Bot','acronym','BB','role','manager','permissions',coalesce(cfg.permissions,colony_private.default_manager_permissions())),
 'settings',jsonb_build_object('version',coalesce(cfg.version,0),'enabled',coalesce(cfg.enabled,false),'daily_time',coalesce(cfg.daily_time,'03:00'),'timezone','Asia/Taipei','automatic_corrections',coalesce(cfg.automatic_corrections,true)),
 'schedule_active',scheduled,'last_run',rs->0,'runs',rs,'issues',iss,'issue_total',n);
end $$;

revoke all on function public.get_brainbot_status(uuid),public.get_lac_fee_visibility(uuid),public.get_lac_fee_records(uuid,integer,integer),public.assert_full_export_permission(uuid) from public,anon,authenticated;
grant execute on function public.get_brainbot_status(uuid),public.get_lac_fee_visibility(uuid),public.get_lac_fee_records(uuid,integer,integer),public.assert_full_export_permission(uuid) to authenticated;
revoke all on function colony_private.fee_full_access(uuid) from public,anon,authenticated;
grant execute on function colony_private.fee_full_access(uuid) to authenticated;

drop policy if exists records_source_archive_access on public.entity_records;
create policy records_source_archive_access on public.entity_records as restrictive for select to authenticated
 using(not colony_private.source_archive_record(entity_type,payload) or colony_private.can_read_source_archive(colony_id));
drop policy if exists audit_source_archive_access on public.audit_log;
create policy audit_source_archive_access on public.audit_log as restrictive for select to authenticated
 using(not (colony_private.source_archive_record(entity_type,before_record->'payload') or colony_private.source_archive_record(entity_type,after_record->'payload') or colony_private.source_archive_record(entity_type,before_record) or colony_private.source_archive_record(entity_type,after_record)) or colony_private.can_read_source_archive(colony_id));
do $$begin
 if to_regclass('storage.objects') is not null then
  execute 'drop policy if exists colony_history_role_read on storage.objects';
  execute 'create policy colony_history_role_read on storage.objects as restrictive for select to authenticated using(bucket_id<>''colony-history'' or colony_private.can_read_source_archive(colony_private.history_path_colony(name)))';
  execute 'drop policy if exists colony_history_role_insert on storage.objects';
  execute 'create policy colony_history_role_insert on storage.objects as restrictive for insert to authenticated with check(bucket_id<>''colony-history'' or colony_private.can_read_source_archive(colony_private.history_path_colony(name)))';
 end if;
end $$;

-- Fee rows may contain invoices, source formulas and free-form source notes.
-- Ordinary fee writers retain the existing immutable-revision workflow, but
-- cannot fetch raw rows through a no-op save. New revisions accept only the
-- known fee form fields. A withheld reference is copied only from the matching
-- predecessor/context; it is never stored as if it were source evidence.
create or replace function colony_private.managed_fee_write(p jsonb,prior jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare kind text:=p->>'event_type';keys text[];nested jsonb;old_nested jsonb;item jsonb;old_item jsonb;items jsonb:='[]';collection text;identity_keys text[];hidden text[];k text;n integer;result jsonb;
begin
 if kind is null or kind not in ('lac_fee_options','lac_fee_month') or jsonb_typeof(p) is distinct from 'object'
  or jsonb_typeof(p->kind) is distinct from 'object' then raise exception using errcode='42501',message='This fee record requires source archive access';end if;
 keys:=array['event_id','event_type','event_date','app_archived_at','app_created_at','app_modified_at','record_origin',kind];
 if exists(select 1 from jsonb_object_keys(p) key where not key=any(keys)) then raise exception using errcode='42501',message='Only managed fee fields can be saved';end if;
 if p->>'record_origin' is not null and p->>'record_origin'<>'app_created' then raise exception using errcode='42501',message='Only managed fee fields can be saved';end if;
 nested:=p->kind;old_nested:=coalesce(prior->kind,'{}');
 keys:=array['schema_version','currency','revision','supersedes_event_id','notes']||case when kind='lac_fee_options' then array['effective_from','rate_scope','target_percent','maximum_percent','excluded_room_ids','groups'] else array['month','actual_total','actual_date','actual_basis','paid_date','invoice_reference','lines'] end;
 if exists(select 1 from jsonb_object_keys(nested) key where not key=any(keys)) then raise exception using errcode='42501',message='Only managed fee fields can be saved';end if;
 foreach k in array case when kind='lac_fee_options' then array['notes'] else array['notes','invoice_reference'] end loop
  if nested->k is not null and nested->k<>'null'::jsonb and (jsonb_typeof(nested->k)<>'string' or length(nested->>k)>case when k='notes' then 10000 else 2000 end) then raise exception using errcode='22023',message='Invalid fee reference or note';end if;
  if coalesce(nested->>k,'') in ('','Source reference withheld') then
   if old_nested ? k then nested:=jsonb_set(nested,array[k],old_nested->k);elsif nested->>k='Source reference withheld' then raise exception using errcode='22023',message='Enter a source reference for the new fee record';end if;
  end if;
 end loop;
 collection:=case kind when 'lac_fee_options' then 'groups' else 'lines' end;
 identity_keys:=case kind when 'lac_fee_options' then array['key'] else array['group_key','quantity_unit','evidence_kind','evidence_start','evidence_end'] end;
 hidden:=case kind when 'lac_fee_options' then array['rate_reference'] else array['evidence_reference','quantity_note'] end;
 keys:=case kind when 'lac_fee_options' then array['key','label','unit','room_ids','rack_ids','rate','rate_period','rate_reference'] else array['group_key','quantity','quantity_unit','evidence_kind','evidence_start','evidence_end','evidence_reference','quantity_basis','quantity_note','snapshot_count','actual_amount'] end;
 if jsonb_typeof(nested->collection) is distinct from 'array' or jsonb_array_length(nested->collection)>1000 then raise exception using errcode='22023',message='Invalid fee rows';end if;
 for item in select value from jsonb_array_elements(nested->collection) loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception using errcode='22023',message='Invalid fee row';end if;
  if exists(select 1 from jsonb_object_keys(item) key where not key=any(keys)) then raise exception using errcode='42501',message='Only managed fee fields can be saved';end if;
  old_item:=null;
  select count(*),(jsonb_agg(value))->0 into n,old_item from jsonb_array_elements(coalesce(old_nested->collection,'[]'))
   where colony_private.export_fields(value,identity_keys)=colony_private.export_fields(item,identity_keys);
  if n<>1 then old_item:=null;end if;
  foreach k in array hidden loop
   if item->k is not null and item->k<>'null'::jsonb and (jsonb_typeof(item->k)<>'string' or length(item->>k)>2000) then raise exception using errcode='22023',message='Invalid fee reference or note';end if;
   if coalesce(item->>k,'') in ('','Source reference withheld') then
    if old_item ? k then item:=jsonb_set(item,array[k],old_item->k);elsif item->>k='Source reference withheld' then raise exception using errcode='22023',message='Enter a source reference for the new fee row';end if;
   end if;
  end loop;
  items:=items||jsonb_build_array(item);
 end loop;
 result:=jsonb_set(p,array[kind],jsonb_set(nested,array[collection],items));
 return result;
end $$;
revoke all on function colony_private.managed_fee_write(jsonb,jsonb) from public,anon,authenticated;

-- Security-definer saves may return records despite read RLS. Preserve ordinary
-- edits, but merge and return only managed location fields for restricted users.
-- Copy the validated domain implementation, not the mutable public fee wrapper.
-- This dedicated base avoids a wrapper cycle if the fee migration is reapplied.
do $$begin
 if to_regprocedure('colony_private.save_record_before_source_archive_access(uuid,text,text,jsonb,integer,boolean)') is null then
  if to_regprocedure('colony_private.save_record_before_location_visibility(uuid,text,text,jsonb,integer,boolean)') is null then raise exception 'Apply the maintained fee visibility migration first';end if;
  if position('save_record_before_source_archive_access(' in pg_get_functiondef('colony_private.save_record_before_location_visibility(uuid,text,text,jsonb,integer,boolean)'::regprocedure))>0 then raise exception 'The existing save wrapper needs review before installing source access';end if;
  execute replace(pg_get_functiondef('colony_private.save_record_before_location_visibility(uuid,text,text,jsonb,integer,boolean)'::regprocedure),'FUNCTION colony_private.save_record_before_location_visibility(', 'FUNCTION colony_private.save_record_before_source_archive_access(');
 end if;
end $$;
revoke all on function colony_private.save_record_before_source_archive_access(uuid,text,text,jsonb,integer,boolean) from public,anon,authenticated;
create or replace function public.save_record(p_colony_id uuid,p_entity_type text,p_entity_id text,p_payload jsonb,p_expected_version integer,p_archived boolean default false)
returns setof public.entity_records language plpgsql security definer set search_path='' as $$
declare existing public.entity_records%rowtype;saved public.entity_records%rowtype;prior public.entity_records%rowtype;keys text[];merged jsonb;raw_allowed boolean;kind text;
begin
 if auth.uid() is null or colony_private.current_role(p_colony_id) is null then raise exception using errcode='42501',message='Active colony membership is required';end if;
 raw_allowed:=(public.get_lac_fee_visibility(p_colony_id)->>'source_archive_allowed')::boolean;
 if raw_allowed then return query select * from colony_private.save_record_before_source_archive_access(p_colony_id,p_entity_type,p_entity_id,p_payload,p_expected_version,p_archived);return;end if;
 perform pg_advisory_xact_lock(hashtextextended('colony:'||p_colony_id::text,0));
 select * into existing from public.entity_records where colony_id=p_colony_id and entity_type=p_entity_type and entity_id=p_entity_id for update;
 if p_entity_type='locations' then
  perform colony_private.validate_payload(p_entity_type,p_entity_id,p_payload);
  keys:=colony_private.managed_location_keys();
  if exists(select 1 from jsonb_object_keys(p_payload) key where not key=any(keys)) then raise exception using errcode='42501',message='Raw source location fields require Manager access and full financial visibility';end if;
  merged:=case when existing.entity_id is not null then (existing.payload-keys)||p_payload else p_payload end;
  for saved in select * from colony_private.save_record_before_source_archive_access(p_colony_id,p_entity_type,p_entity_id,merged,p_expected_version,p_archived) loop
   saved.payload:=colony_private.managed_location_payload(saved.payload);return next saved;
  end loop;
  return;
 end if;
 if p_entity_type='husbandry_events' and (p_payload->>'event_type' in ('lac_fee_options','lac_fee_month') or existing.payload->>'event_type' in ('lac_fee_options','lac_fee_month')) then
  if not colony_private.fee_full_access(p_colony_id) then raise exception using errcode='42501',message='Fee edit access is required';end if;
  kind:=p_payload->>'event_type';
  if existing.entity_id is not null then
   if p_payload is distinct from colony_private.fee_payload(existing.payload,true,true,false) then raise exception using errcode='22023',message='Save a new dated fee revision';end if;
   merged:=existing.payload;
  else
   if p_payload#>>array[kind,'supersedes_event_id'] is not null then
    select * into prior from public.entity_records where colony_id=p_colony_id and entity_type='husbandry_events' and entity_id=p_payload#>>array[kind,'supersedes_event_id'] for update;
    if prior.entity_id is null or prior.archived or prior.payload->>'event_type' is distinct from kind
     or jsonb_typeof(p_payload#>array[kind,'revision']) is distinct from 'number' or jsonb_typeof(prior.payload#>array[kind,'revision']) is distinct from 'number'
     or (p_payload#>>array[kind,'revision'])::numeric<>(prior.payload#>>array[kind,'revision'])::numeric+1
     or kind='lac_fee_month' and p_payload#>array[kind,'month'] is distinct from prior.payload#>array[kind,'month'] then raise exception using errcode='22023',message='Reopen the matching previous fee revision';end if;
   end if;
   merged:=colony_private.managed_fee_write(p_payload,prior.payload);
  end if;
  for saved in select * from colony_private.save_record_before_source_archive_access(p_colony_id,p_entity_type,p_entity_id,merged,p_expected_version,p_archived) loop
   saved.payload:=colony_private.fee_payload(saved.payload,true,true,false);return next saved;
  end loop;
  return;
 end if;
 if colony_private.source_archive_record(p_entity_type,p_payload) or colony_private.source_archive_record(p_entity_type,existing.payload) then raise exception using errcode='42501',message='Raw source records require Manager access and full financial visibility';end if;
 return query select * from colony_private.save_record_before_source_archive_access(p_colony_id,p_entity_type,p_entity_id,p_payload,p_expected_version,p_archived);
end $$;
revoke all on function public.save_record(uuid,text,text,jsonb,integer,boolean) from public,anon,authenticated;
grant execute on function public.save_record(uuid,text,text,jsonb,integer,boolean) to authenticated;
commit;
