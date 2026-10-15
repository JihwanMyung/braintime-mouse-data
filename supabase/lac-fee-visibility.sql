-- Apply after all maintained domain/export migrations. No visibility changes by default.
-- Raw source archives can include financial cells, so partial fee access cannot read them.
begin;
create table if not exists colony_private.lac_fee_visibility (
 colony_id uuid primary key references public.colonies(id) on delete cascade,
 levels jsonb not null default '{"low":{"estimate":true,"actual":true},"high":{"estimate":true,"actual":true},"max":{"estimate":true,"actual":true}}',
 version integer not null default 1 check(version>0),updated_at timestamptz not null default now(),updated_by uuid references auth.users(id)
);
create table if not exists colony_private.lac_fee_visibility_audit (
 audit_id bigint generated always as identity primary key,colony_id uuid not null,
 actor_id uuid,occurred_at timestamptz not null default now(),before_record jsonb,after_record jsonb
);
revoke all on colony_private.lac_fee_visibility,colony_private.lac_fee_visibility_audit from public,anon,authenticated;
alter table colony_private.lac_fee_visibility enable row level security;
alter table colony_private.lac_fee_visibility_audit enable row level security;
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
 'source_archive_allowed',(allowed->>'estimate')::boolean and (allowed->>'actual')::boolean)||case when is_owner then jsonb_build_object('levels',levels) else '{}'::jsonb end;
end $$;
revoke all on function public.get_lac_fee_visibility(uuid) from public,anon,authenticated;
grant execute on function public.get_lac_fee_visibility(uuid) to authenticated;
create or replace function public.save_lac_fee_visibility(p_colony_id uuid,p_version integer,p_levels jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare previous colony_private.lac_fee_visibility%rowtype;saved colony_private.lac_fee_visibility%rowtype;k text;
begin
 perform 1 from public.colonies where id=p_colony_id for update;
 if colony_private.current_role(p_colony_id) is distinct from 'owner' then raise exception using errcode='42501',message='Only the owner can change fee visibility';end if;
 if p_version is null or p_version<0 or jsonb_typeof(p_levels) is distinct from 'object' or p_levels - array['low','high','max'] <> '{}' then raise exception using errcode='22023',message='Invalid fee visibility settings';end if;
 foreach k in array array['low','high','max'] loop
  if jsonb_typeof(p_levels->k) is distinct from 'object' or (p_levels->k) - array['estimate','actual'] <> '{}' or jsonb_typeof(p_levels#>array[k,'estimate']) is distinct from 'boolean' or jsonb_typeof(p_levels#>array[k,'actual']) is distinct from 'boolean' then raise exception using errcode='22023',message='Choose estimate and actual visibility for every level';end if;
 end loop;
 select * into previous from colony_private.lac_fee_visibility where colony_id=p_colony_id for update;
 if coalesce(previous.version,0)<>p_version then raise exception using errcode='40001',message='Fee visibility changed; reload before saving';end if;
 insert into colony_private.lac_fee_visibility(colony_id,levels,version,updated_by) values(p_colony_id,p_levels,p_version+1,auth.uid())
 on conflict(colony_id) do update set levels=excluded.levels,version=excluded.version,updated_at=clock_timestamp(),updated_by=excluded.updated_by returning * into saved;
 insert into colony_private.lac_fee_visibility_audit(colony_id,actor_id,before_record,after_record) values(p_colony_id,auth.uid(),to_jsonb(previous),to_jsonb(saved));
 return public.get_lac_fee_visibility(p_colony_id);
end $$;
revoke all on function public.save_lac_fee_visibility(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.save_lac_fee_visibility(uuid,integer,jsonb) to authenticated;
create or replace function colony_private.fee_is_record(kind text,p jsonb)
returns boolean language sql immutable set search_path='' as $$select kind='husbandry_events' and (coalesce(p->>'event_type','') ~ '^(lac_fee|fee|fees|billing)_' or p->>'event_type' in ('animal_sheet_cage_snapshot','animal_sheet_source_change') or p ?| array['source_cage_snapshot','animal_sheet_change','lac_fee_options','lac_fee_month','fee_options','fee_month','fee_actual','fees','billing','billing_options','billing_month'])$$;
create or replace function colony_private.fee_full_access(p_colony_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
 if colony_private.current_role(p_colony_id) is null then return false;end if;
 return (public.get_lac_fee_visibility(p_colony_id)->>'source_archive_allowed')::boolean;
end $$;
revoke all on function colony_private.fee_is_record(text,jsonb),colony_private.fee_full_access(uuid) from public,anon,authenticated;
grant execute on function colony_private.fee_is_record(text,jsonb),colony_private.fee_full_access(uuid) to authenticated;
drop policy if exists records_financial_visibility on public.entity_records;
create policy records_financial_visibility on public.entity_records as restrictive for select to authenticated
 using((entity_type not in ('archive','locations') and not colony_private.fee_is_record(entity_type,payload)) or colony_private.fee_full_access(colony_id));
-- Audit snapshots may contain raw source/archive material. Partial access sees no raw audit.
drop policy if exists audit_financial_visibility on public.audit_log;
create policy audit_financial_visibility on public.audit_log as restrictive for select to authenticated using(colony_private.fee_full_access(colony_id));
do $$begin
 if to_regclass('storage.objects') is not null then
  execute 'drop policy if exists colony_history_fee_visibility on storage.objects';
  execute 'create policy colony_history_fee_visibility on storage.objects as restrictive for select to authenticated using(bucket_id<>''colony-history'' or colony_private.fee_full_access(colony_private.history_path_colony(name)))';
  execute 'drop policy if exists colony_history_fee_upload on storage.objects';
  execute 'create policy colony_history_fee_upload on storage.objects as restrictive for insert to authenticated with check(bucket_id<>''colony-history'' or colony_private.fee_full_access(colony_private.history_path_colony(name)))';
 end if;
end $$;
create or replace function colony_private.fee_payload(p jsonb,can_estimate boolean,can_actual boolean,p_raw boolean default false)
returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb;nested jsonb;item jsonb;items jsonb:='[]';kind text:=p->>'event_type';keys text[];
begin
 if p_raw and can_estimate and can_actual then return p;end if;
 result:=colony_private.export_fields(p,array['event_id','event_type','event_date','app_archived_at']);
 if kind='lac_fee_options' then
  nested:=colony_private.export_fields(p->kind,array['schema_version','effective_from','rate_scope','currency','target_percent','maximum_percent','revision','supersedes_event_id']);
  if can_estimate then
   nested:=nested||colony_private.export_fields(p->kind,array['excluded_room_ids']);
   for item in select value from jsonb_array_elements(case when jsonb_typeof(p#>'{lac_fee_options,groups}')='array' then p#>'{lac_fee_options,groups}' else '[]'::jsonb end) loop
    items:=items||jsonb_build_array(colony_private.export_fields(item,array['key','unit','room_ids','rack_ids','rate','rate_period'])||jsonb_build_object('rate_reference','Source reference withheld'));
   end loop;
  end if;
  nested:=nested||jsonb_build_object('groups',items);
 elsif kind='lac_fee_month' then
  nested:=colony_private.export_fields(p->kind,array['schema_version','month','currency','revision','supersedes_event_id']);
  if can_actual then nested:=nested||colony_private.export_fields(p->kind,array['actual_total','actual_date','actual_basis','paid_date'])||jsonb_build_object('invoice_reference','Source reference withheld');end if;
  keys:=array['group_key'];
  if can_estimate then keys:=keys||array['quantity','quantity_unit','evidence_kind','evidence_start','evidence_end','quantity_basis','snapshot_count'];end if;
  if can_actual then keys:=array_append(keys,'actual_amount');end if;
  for item in select value from jsonb_array_elements(case when jsonb_typeof(p#>'{lac_fee_month,lines}')='array' then p#>'{lac_fee_month,lines}' else '[]'::jsonb end) loop
   items:=items||jsonb_build_array(colony_private.export_fields(item,keys)||jsonb_build_object('evidence_reference','Source reference withheld','quantity_unit',case item->>'group_key' when 'spf_room' then 'mouse_day' else 'cage_day' end,'evidence_kind','billed_quantity')||case when can_estimate then colony_private.export_fields(item,array['quantity_unit','evidence_kind']) else '{}'::jsonb end);
  end loop;
  nested:=nested||jsonb_build_object('lines',items);
 else return result||jsonb_build_object('fee_visibility',jsonb_build_object('estimate',can_estimate,'actual',can_actual));end if;
 return result||jsonb_build_object(kind,nested,'fee_visibility',jsonb_build_object('estimate',can_estimate,'actual',can_actual));
end $$;
revoke all on function colony_private.fee_payload(jsonb,boolean,boolean,boolean) from public,anon,authenticated;
create or replace function public.get_lac_fee_records(p_colony_id uuid,p_offset integer default 0,p_limit integer default 250)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare policy jsonb;rows jsonb;
begin
 policy:=public.get_lac_fee_visibility(p_colony_id);
 if p_offset is null or p_offset<0 or p_offset>1000000 or p_limit is null or p_limit not between 1 and 250 then raise exception using errcode='22023',message='Invalid fee page';end if;
 select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('payload',colony_private.fee_payload(r.payload,(policy->>'estimate')::boolean,(policy->>'actual')::boolean,true))),'[]') into rows from
 (select colony_id,entity_type,entity_id,payload,version,archived from public.entity_records where colony_id=p_colony_id and colony_private.fee_is_record(entity_type,payload) order by entity_id collate "C" offset p_offset limit p_limit) r;
 return jsonb_build_object('visibility',policy,'rows',rows,'next_offset',case when jsonb_array_length(rows)=p_limit then p_offset+p_limit else null end);
end $$;
revoke all on function public.get_lac_fee_records(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.get_lac_fee_records(uuid,integer,integer) to authenticated;
create or replace function colony_private.guard_fee_visibility_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null and (new.entity_type='archive' or colony_private.fee_is_record(new.entity_type,new.payload) or (tg_op='UPDATE' and colony_private.fee_is_record(old.entity_type,old.payload))) and not colony_private.fee_full_access(new.colony_id) then
 raise exception using errcode='42501',message='Both estimate and actual visibility are required to edit financial records or source archives';end if;
 if new.entity_type='husbandry_events' and new.payload->>'event_type'='lac_fee_month' then
  if new.payload#>'{lac_fee_month,actual_basis}' is not null and new.payload#>'{lac_fee_month,actual_basis}'<>'null'::jsonb and (jsonb_typeof(new.payload#>'{lac_fee_month,actual_basis}')<>'string' or new.payload#>>'{lac_fee_month,actual_basis}' not in ('recorded_charge','confirmed_paid','unknown')) then raise exception using errcode='22023',message='Invalid actual fee basis';end if;
  if new.payload#>>'{lac_fee_month,actual_basis}'='confirmed_paid' and (jsonb_typeof(new.payload#>'{lac_fee_month,actual_total}') is distinct from 'number' or (new.payload#>>'{lac_fee_month,actual_total}')::numeric<0 or colony_private.export_date(new.payload#>'{lac_fee_month,paid_date}') is null) then raise exception using errcode='22023',message='Confirmed payment needs an amount and payment date';end if;
  if coalesce(new.payload#>>'{lac_fee_month,actual_basis}','recorded_charge')<>'confirmed_paid' and coalesce(new.payload#>'{lac_fee_month,paid_date}','null'::jsonb)<>'null'::jsonb then raise exception using errcode='22023',message='Payment date requires confirmed payment';end if;
  if new.payload#>'{lac_fee_month,paid_date}' is not null and new.payload#>'{lac_fee_month,paid_date}'<>'null'::jsonb and colony_private.export_date(new.payload#>'{lac_fee_month,paid_date}') is null then raise exception using errcode='22023',message='Invalid fee payment date';end if;
 end if;
 return new;
end $$;
revoke all on function colony_private.guard_fee_visibility_write() from public,anon,authenticated;
drop trigger if exists guard_fee_visibility_write on public.entity_records;
create trigger guard_fee_visibility_write before insert or update on public.entity_records for each row execute function colony_private.guard_fee_visibility_write();
-- Also guard no-op saves, which return before row triggers execute.
do $$begin
 if to_regprocedure('colony_private.assert_record_permission_before_fee_visibility(uuid,text,jsonb,jsonb,boolean,boolean)') is null then
  alter function colony_private.assert_record_permission(uuid,text,jsonb,jsonb,boolean,boolean) rename to assert_record_permission_before_fee_visibility;
 elsif position('perform colony_private.assert_record_permission_before_fee_visibility(' in pg_get_functiondef('colony_private.assert_record_permission(uuid,text,jsonb,jsonb,boolean,boolean)'::regprocedure))=0 then
  execute replace(pg_get_functiondef('colony_private.assert_record_permission(uuid,text,jsonb,jsonb,boolean,boolean)'::regprocedure),'FUNCTION colony_private.assert_record_permission(', 'FUNCTION colony_private.assert_record_permission_before_fee_visibility(');
 end if;
end $$;
revoke all on function colony_private.assert_record_permission_before_fee_visibility(uuid,text,jsonb,jsonb,boolean,boolean) from public,anon,authenticated;
create or replace function colony_private.assert_record_permission(p_colony_id uuid,kind text,p jsonb,old_p jsonb,p_archived boolean,old_archived boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if (kind='archive' or colony_private.fee_is_record(kind,p) or colony_private.fee_is_record(kind,old_p)) and not colony_private.fee_full_access(p_colony_id) then raise exception using errcode='42501',message='Full financial visibility is required for this edit';end if;
 perform colony_private.assert_record_permission_before_fee_visibility(p_colony_id,kind,p,old_p,p_archived,old_archived);
end $$;
revoke all on function colony_private.assert_record_permission(uuid,text,jsonb,jsonb,boolean,boolean) from public,anon,authenticated;
create or replace function public.assert_full_export_permission(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permission jsonb;
begin
 permission:=public.get_export_permission(p_colony_id);
 if permission->>'level'<>'max' or not colony_private.fee_full_access(p_colony_id) then raise exception using errcode='42501',message='Max export permission and full financial visibility are required for a full backup or source archive';end if;
 return permission;
end $$;
-- Keep the existing date/window/domain projection intact, then apply fee visibility.
-- The former implementation is private and cannot be called through PostgREST.
do $$begin
 if to_regprocedure('colony_private.export_records_before_fee_visibility(uuid,text,date,date,text[],integer,integer)') is null then
  alter function public.export_records(uuid,text,date,date,text[],integer,integer) set schema colony_private;
  alter function colony_private.export_records(uuid,text,date,date,text[],integer,integer) rename to export_records_before_fee_visibility;
 elsif position('report:=colony_private.export_records_before_fee_visibility(' in pg_get_functiondef('public.export_records(uuid,text,date,date,text[],integer,integer)'::regprocedure))=0 then
  execute replace(pg_get_functiondef('public.export_records(uuid,text,date,date,text[],integer,integer)'::regprocedure),'FUNCTION public.export_records(', 'FUNCTION colony_private.export_records_before_fee_visibility(');
 end if;
end $$;
revoke all on function colony_private.export_records_before_fee_visibility(uuid,text,date,date,text[],integer,integer) from public,anon,authenticated;
create or replace function public.export_records(p_colony_id uuid,p_scope text default 'current_housing',p_from_date date default null,p_to_date date default null,p_entity_types text[] default null,p_offset integer default 0,p_limit integer default 250)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare report jsonb;policy jsonb;rows jsonb;row jsonb;raw jsonb;
begin
 policy:=public.get_lac_fee_visibility(p_colony_id);
 report:=colony_private.export_records_before_fee_visibility(p_colony_id,p_scope,p_from_date,p_to_date,p_entity_types,p_offset,p_limit);rows:='[]';
 for row in select value from jsonb_array_elements(report->'rows') loop
  raw:=null;
  if row->>'entity_type'='husbandry_events' then select payload into raw from public.entity_records where colony_id=p_colony_id and entity_type=row->>'entity_type' and entity_id=row->>'entity_id';end if;
  if colony_private.fee_is_record(row->>'entity_type',raw) then
   row:=jsonb_set(row,'{payload}',colony_private.fee_payload(raw,(policy->>'estimate')::boolean,(policy->>'actual')::boolean,false));
  end if;
  rows:=rows||jsonb_build_array(row);
 end loop;
 return jsonb_set(report,'{rows}',rows)||jsonb_build_object('fee_visibility',policy);
end $$;
revoke all on function public.export_records(uuid,text,date,date,text[],integer,integer) from public,anon,authenticated;
grant execute on function public.export_records(uuid,text,date,date,text[],integer,integer) to authenticated;
-- Current position blocks also contain source fee cells. Partial financial access
-- receives a managed-field projection; raw source fields remain stored unchanged.
create or replace function colony_private.managed_location_keys()
returns text[] language sql immutable set search_path='' as $$select array[
 'location_id','room_id','rack_id','label','row','column','capacity','locobox_id',
 'active','state','manager','manager_acronym','notes','app_created_at','app_updated_at','app_modified_at',
 'app_archived_at','archived','record_origin','evidence_status','requires_review',
 'source_current','source_last_seen_at','source_snapshot_date','source_label_conflict',
 'source_manager_name','source_manager_acronym','source_manager_status',
 'source_observed_mouse_sids','source_observed_cage_sids','source_candidate_mouse_sids',
 'source_candidate_cage_sids','source_unresolved_explicit_mouse_sids','source_observed_tags','source_cage_observation']$$;
create or replace function colony_private.managed_location_payload(p jsonb)
returns jsonb language sql immutable set search_path='' as $$select colony_private.export_fields(p,colony_private.managed_location_keys())$$;
revoke all on function colony_private.managed_location_keys(),colony_private.managed_location_payload(jsonb) from public,anon,authenticated;
create or replace function public.get_managed_locations(p_colony_id uuid,p_offset integer default 0,p_limit integer default 250)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare policy jsonb;rows jsonb;
begin
 policy:=public.get_lac_fee_visibility(p_colony_id);
 if p_offset is null or p_offset<0 or p_offset>1000000 or p_limit is null or p_limit not between 1 and 250 then raise exception using errcode='22023',message='Invalid location page';end if;
 select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('payload',colony_private.managed_location_payload(r.payload))),'[]') into rows from
 (select colony_id,entity_type,entity_id,payload,version,archived from public.entity_records where colony_id=p_colony_id and entity_type='locations' order by entity_id collate "C" offset p_offset limit p_limit) r;
 return jsonb_build_object('visibility',policy,'rows',rows,'next_offset',case when jsonb_array_length(rows)=p_limit then p_offset+p_limit else null end);
end $$;
revoke all on function public.get_managed_locations(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.get_managed_locations(uuid,integer,integer) to authenticated;
-- Capture the latest save implementation when this final guard is reapplied.
-- The private implementation still enforces domain permissions, source immutability
-- and expected-version checks. It is never callable by application clients.
do $$begin
 if to_regprocedure('colony_private.save_record_before_location_visibility(uuid,text,text,jsonb,integer,boolean)') is null then
  alter function public.save_record(uuid,text,text,jsonb,integer,boolean) set schema colony_private;
  alter function colony_private.save_record(uuid,text,text,jsonb,integer,boolean) rename to save_record_before_location_visibility;
 elsif position('colony_private.save_record_before_location_visibility(' in pg_get_functiondef('public.save_record(uuid,text,text,jsonb,integer,boolean)'::regprocedure))=0 then
  execute replace(pg_get_functiondef('public.save_record(uuid,text,text,jsonb,integer,boolean)'::regprocedure),'FUNCTION public.save_record(', 'FUNCTION colony_private.save_record_before_location_visibility(');
 end if;
end $$;
revoke all on function colony_private.save_record_before_location_visibility(uuid,text,text,jsonb,integer,boolean) from public,anon,authenticated;
create or replace function public.save_record(p_colony_id uuid,p_entity_type text,p_entity_id text,p_payload jsonb,p_expected_version integer,p_archived boolean default false)
returns setof public.entity_records language plpgsql security definer set search_path='' as $$
declare existing public.entity_records%rowtype;saved public.entity_records%rowtype;keys text[];merged jsonb;
begin
 if p_entity_type is distinct from 'locations' or colony_private.fee_full_access(p_colony_id) then
  return query select * from colony_private.save_record_before_location_visibility(p_colony_id,p_entity_type,p_entity_id,p_payload,p_expected_version,p_archived);return;
 end if;
 if auth.uid() is null or coalesce(colony_private.current_role(p_colony_id),'') not in ('owner','editor','manager') then raise exception using errcode='42501',message='Active colony write membership is required';end if;
 perform colony_private.validate_payload(p_entity_type,p_entity_id,p_payload);
 keys:=colony_private.managed_location_keys();
 if exists(select 1 from jsonb_object_keys(p_payload) key where not key=any(keys)) then raise exception using errcode='42501',message='Source location fields require full financial visibility';end if;
 -- The same colony lock as single/batch saves prevents a snapshot changing
 -- between the preservation merge and the delegated CAS check.
 perform pg_advisory_xact_lock(hashtextextended('colony:'||p_colony_id::text,0));
 select * into existing from public.entity_records where colony_id=p_colony_id and entity_type=p_entity_type and entity_id=p_entity_id for update;
 merged:=case when found then (existing.payload-keys)||p_payload else p_payload end;
 for saved in select * from colony_private.save_record_before_location_visibility(p_colony_id,p_entity_type,p_entity_id,merged,p_expected_version,p_archived) loop
  saved.payload:=colony_private.managed_location_payload(saved.payload);return next saved;
 end loop;
end $$;
revoke all on function public.save_record(uuid,text,text,jsonb,integer,boolean) from public,anon,authenticated;
grant execute on function public.save_record(uuid,text,text,jsonb,integer,boolean) to authenticated;
-- Import conflicts may embed the same current/source blocks. Keep their identity
-- and version metadata available for review while withholding raw details.
do $guard$
begin
 if to_regprocedure('public.get_animal_sheet_import_conflicts(uuid,integer,integer)') is not null then
  if to_regprocedure('colony_private.get_animal_sheet_import_conflicts_before_fee_visibility(uuid,integer,integer)') is null then
   alter function public.get_animal_sheet_import_conflicts(uuid,integer,integer) set schema colony_private;
   alter function colony_private.get_animal_sheet_import_conflicts(uuid,integer,integer) rename to get_animal_sheet_import_conflicts_before_fee_visibility;
  elsif position('colony_private.get_animal_sheet_import_conflicts_before_fee_visibility(' in pg_get_functiondef('public.get_animal_sheet_import_conflicts(uuid,integer,integer)'::regprocedure))=0 then
   execute replace(pg_get_functiondef('public.get_animal_sheet_import_conflicts(uuid,integer,integer)'::regprocedure),'FUNCTION public.get_animal_sheet_import_conflicts(', 'FUNCTION colony_private.get_animal_sheet_import_conflicts_before_fee_visibility(');
  end if;
  revoke all on function colony_private.get_animal_sheet_import_conflicts_before_fee_visibility(uuid,integer,integer) from public,anon,authenticated;
  execute $fn$create or replace function public.get_animal_sheet_import_conflicts(p_colony_id uuid,p_offset integer default 0,p_limit integer default 100)
   returns jsonb language plpgsql stable security definer set search_path='' as $body$
   declare policy jsonb;result jsonb;items jsonb;
   begin
    policy:=public.get_lac_fee_visibility(p_colony_id);
    result:=colony_private.get_animal_sheet_import_conflicts_before_fee_visibility(p_colony_id,p_offset,p_limit);
    if policy->>'source_archive_allowed'='true' then return result;end if;
    select coalesce(jsonb_agg(colony_private.export_fields(value,array['entity_type','entity_id','kind','expected_version','actual_version','code'])||jsonb_build_object('source_details_withheld',true)),'[]') into items from jsonb_array_elements(coalesce(result->'conflicts','[]'));
    return colony_private.export_fields(result,array['job_id','total','next_offset'])||jsonb_build_object('conflicts',items,'source_details_withheld',true);
   end $body$ $fn$;
  revoke all on function public.get_animal_sheet_import_conflicts(uuid,integer,integer) from public,anon,authenticated;
  grant execute on function public.get_animal_sheet_import_conflicts(uuid,integer,integer) to authenticated;
 end if;
end $guard$;
commit;
