-- Apply after schema.sql and functions/manage-colony-users/membership.sql.
-- Export workflows are separate from existing member viewing/editing rights.
begin;
alter table public.memberships add column if not exists export_level text not null default 'low';
alter table public.memberships drop constraint if exists memberships_export_level_check;
alter table public.memberships add constraint memberships_export_level_check check(export_level in ('low','high','max'));
update public.memberships set export_level='max' where role='owner' and export_level<>'max';

create or replace function colony_private.membership_export_default()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.role='owner' then new.export_level:='max';
  elsif tg_op='UPDATE' and old.role='owner' then new.export_level:='low'; end if;
  return new;
end $$;
revoke all on function colony_private.membership_export_default() from public,anon,authenticated;
drop trigger if exists membership_export_default on public.memberships;
create trigger membership_export_default before insert or update on public.memberships
for each row execute function colony_private.membership_export_default();

-- The optional sixth argument preserves legacy callers, while omission on an
-- update retains the level already assigned by the owner.
drop function if exists public.manage_colony_member(uuid,uuid,text,boolean,text);
create or replace function public.manage_colony_member(
  p_colony_id uuid,p_user_id uuid,p_role text,p_active boolean,p_action text,p_export_level text default null
) returns setof public.memberships language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); target public.memberships%rowtype; saved public.memberships%rowtype; requested text;
begin
  perform 1 from public.colonies where id=p_colony_id for update;
  if actor is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then
    raise exception using errcode='42501',message='Only an active colony owner can manage members'; end if;
  if p_role is null or p_role not in ('viewer','editor') or p_active is null or p_action is null or p_action not in ('add','update') or p_user_id is null
    or (p_export_level is not null and p_export_level not in ('low','high','max')) then
    raise exception using errcode='22023',message='Invalid membership or export permission request'; end if;
  select * into target from public.memberships where colony_id=p_colony_id and user_id=p_user_id;
  if p_user_id=actor or target.role='owner' then raise exception using errcode='42501',message='Owner accounts are protected'; end if;
  if p_action='add' and target.user_id is not null then raise exception using errcode='23505',message='This account is already a colony member'; end if;
  if p_action='update' and target.user_id is null then raise exception using errcode='P0002',message='This account is not a colony member'; end if;
  requested:=coalesce(p_export_level,target.export_level,'low');
  select * into saved from public.set_member_role(p_colony_id,p_user_id,p_role,p_active);
  if saved.export_level<>requested then
    target:=saved;
    update public.memberships set export_level=requested,updated_at=clock_timestamp(),updated_by=actor
      where colony_id=p_colony_id and user_id=p_user_id returning * into saved;
    insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record)
      values(p_colony_id,'membership',p_user_id::text,'UPDATE',actor,to_jsonb(target),to_jsonb(saved));
  end if;
  return next saved;
end $$;
revoke all on function public.manage_colony_member(uuid,uuid,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.manage_colony_member(uuid,uuid,text,boolean,text,text) to authenticated;

create or replace function public.get_export_permission(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare member public.memberships%rowtype; level text; today date:=(current_timestamp at time zone 'Asia/Taipei')::date; cutoff date;
begin
  select * into member from public.memberships where colony_id=p_colony_id and user_id=auth.uid() and active;
  if member.user_id is null then raise exception using errcode='42501',message='Active colony membership is required to export'; end if;
  level:=case when member.role='owner' then 'max' else member.export_level end;
  cutoff:=case level when 'low' then (today-interval '3 years')::date when 'high' then (today-interval '6 years')::date else null end;
  return jsonb_build_object('level',level,'cutoff_date',cutoff,'as_of_date',today,'full_history',level='max','captured_at',current_timestamp);
end $$;
revoke all on function public.get_export_permission(uuid) from public,anon,authenticated;
grant execute on function public.get_export_permission(uuid) to authenticated;

create or replace function public.assert_full_export_permission(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permission jsonb;
begin
  permission:=public.get_export_permission(p_colony_id);
  if permission->>'level'<>'max' then raise exception using errcode='42501',message='Max export permission is required for a full backup or source archive export'; end if;
  return permission;
end $$;
revoke all on function public.assert_full_export_permission(uuid) from public,anon,authenticated;
grant execute on function public.assert_full_export_permission(uuid) to authenticated;

create or replace function colony_private.export_date(value jsonb)
returns date language plpgsql immutable set search_path='' as $$
declare s text; d date;
begin
  if jsonb_typeof(value)<>'string' then return null; end if;
  s:=value#>>'{}'; if s !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  begin d:=s::date; exception when others then return null; end;
  if to_char(d,'YYYY-MM-DD')<>s then return null; end if; return d;
end $$;
revoke all on function colony_private.export_date(jsonb) from public,anon,authenticated;

create or replace function colony_private.export_domain_date(kind text,p jsonb)
returns date language plpgsql immutable set search_path='' as $$
begin
  return case kind
    when 'mice' then coalesce(colony_private.export_date(p->'end_date'),colony_private.export_date(p->'date_of_birth'))
    when 'matings' then coalesce(colony_private.export_date(p->'disbanded_date'),colony_private.export_date(p->'set_up_date'))
    when 'litters' then coalesce(colony_private.export_date(p->'end_date'),colony_private.export_date(p->'wean_date'),colony_private.export_date(p->'date_of_birth'))
    when 'cages' then coalesce(colony_private.export_date(p->'end_date'),colony_private.export_date(p->'set_up_date'))
    when 'light_events' then coalesce(colony_private.export_date(p->'end_date'),colony_private.export_date(p->'start_date'))
    when 'husbandry_events' then case when p->>'event_type'='cryopreservation_lot'
      then coalesce(colony_private.export_date(p#>'{cryopreservation,quantity_as_of_date}'),colony_private.export_date(p#>'{cryopreservation,frozen_date}'))
      else colony_private.export_date(p->'event_date') end
    else null end;
end $$;
revoke all on function colony_private.export_domain_date(text,jsonb) from public,anon,authenticated;

create or replace function colony_private.export_light_current(p jsonb)
returns boolean language plpgsql stable set search_path='' as $$
declare zone text:=p->>'timezone'; today date; starts date; ends date;
begin
  if zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=zone) then zone:='Asia/Taipei'; end if;
  today:=(current_timestamp at time zone zone)::date;
  starts:=colony_private.export_date(p->'start_date');ends:=colony_private.export_date(p->'end_date');
  return coalesce(starts<=today and (p->>'end_date' is null or case when lower(coalesce(p->>'interval_semantics','')) ~ 'next phase start|exclusive' then ends>today else ends>=today end),false);
end $$;
revoke all on function colony_private.export_light_current(jsonb) from public,anon,authenticated;

-- Scalar/ID-list projection rejects nested data and caps cell size. There is no
-- source*, notes, comment, audit, genotype-profile or archive pass-through.
create or replace function colony_private.export_fields(p jsonb,keys text[])
returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb:='{}'; k text; v jsonb; items jsonb;
begin
  if jsonb_typeof(p)<>'object' then return result; end if;
  foreach k in array keys loop
    v:=p->k;
    if jsonb_typeof(v)='string' then result:=result||jsonb_build_object(k,left(v#>>'{}',2048));
    elsif jsonb_typeof(v) in ('number','boolean','null') then result:=result||jsonb_build_object(k,v);
    elsif jsonb_typeof(v)='array' then
      select coalesce(jsonb_agg(value),'[]') into items from (select to_jsonb(left(value#>>'{}',200)) value from jsonb_array_elements(v) where jsonb_typeof(value)='string' limit 100) a;
      result:=result||jsonb_build_object(k,items);
    end if;
  end loop; return result;
end $$;
revoke all on function colony_private.export_fields(jsonb,text[]) from public,anon,authenticated;

create or replace function colony_private.export_payload(kind text,p jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare keys text[]; result jsonb; nested jsonb;
begin
  keys:=case kind
    when 'mice' then array['mouse_sid','physical_tag','sex','state','mouseline','genotype','date_of_birth','end_date','wean_date','sire_sids','dam_sids','litter_sid','cage_sid','cage_tag','manager','owner']
    when 'matings' then array['mating_sid','state','male_sids','female_sids','sire_sids','dam_sids','set_up_date','disbanded_date','cage_sid','cage_tag','owner']
    when 'litters' then array['litter_sid','state','date_of_birth','wean_date','end_date','mating_sid','sire_sids','dam_sids','size_reported','male_count','female_count','unknown_count','cage_sid']
    when 'cages' then array['cage_sid','cage_tag','state','cage_type','room_id','rack_id','location_id','room','rack','location','capacity','manager','owner','set_up_date','end_date']
    when 'rooms' then array['room_id','name','label']
    when 'racks' then array['rack_id','room_id','name','label']
    when 'locations' then array['location_id','room_id','rack_id','label','row','column','capacity']
    when 'light_events' then array['event_id','start_date','end_date','protocol','cycle_hours','light_hours','lights_on','lights_off','transition_minutes','intensity_lux','timezone','evidence_status','interval_semantics','actual_exposure_verified','room_id','rack_id','location_id','cage_sid']
    when 'husbandry_events' then array['event_id','event_type','event_date','mouse_sid','cage_sid','old_cage_sid','room_id','rack_id','location_id','old_room_id','old_rack_id','old_location_id','location_label','old_location_label']
    else array[]::text[] end;
  result:=colony_private.export_fields(p,keys);
  if kind='locations' then
    result:=result||jsonb_build_object('record_origin',case when p->>'record_origin'='app_created' then 'app_created' else 'source_recorded' end);
  end if;
  if kind='husbandry_events' and p->>'event_type'='cryopreservation_lot' then
    nested:=colony_private.export_fields(p->'cryopreservation',array['schema_version','case_id','label','strain','background','modification_method','gene','zygosity','origin','batch_ids','frozen_date','material','status','manager','quantity','quantity_unit','quantity_as_of_date','donor_mouse_sids']);
    nested:=nested||jsonb_build_object('storage_location',colony_private.export_fields(p#>'{cryopreservation,storage_location}',array['facility','tank','canister','position']));
    result:=result||jsonb_build_object('cryopreservation',nested);
  elsif kind='husbandry_events' and p->>'event_type'='cryopreservation_event' then
    result:=result||jsonb_build_object('cryopreservation_event',colony_private.export_fields(p->'cryopreservation_event',array['schema_version','lot_id','activity_type','quantity','quantity_unit','recovery_status','recovered_mouse_sids']));
  end if;
  return result;
end $$;
revoke all on function colony_private.export_payload(text,jsonb) from public,anon,authenticated;

create or replace function public.export_records(
  p_colony_id uuid,p_scope text default 'current_housing',p_from_date date default null,p_to_date date default null,
  p_entity_types text[] default null,p_offset integer default 0,p_limit integer default 250
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permission jsonb; today date; cutoff date; start_at date; end_at date; kinds text[]; result jsonb; omitted integer; more boolean; include_undated boolean; revision text;
begin
  permission:=public.get_export_permission(p_colony_id);today:=(permission->>'as_of_date')::date;cutoff:=(permission->>'cutoff_date')::date;
  if p_scope is null or p_scope not in ('current_housing','history') or p_offset is null or p_offset<0 or p_offset>1000000 or p_limit is null or p_limit not between 1 and 250 then
    raise exception using errcode='22023',message='Invalid export scope or page size'; end if;
  kinds:=coalesce(p_entity_types,case p_scope when 'current_housing' then array['mice','cages','rooms','racks','locations','light_events'] else array['mice','matings','litters','cages','rooms','racks','locations','light_events','husbandry_events'] end);
  if cardinality(kinds) not between 1 and 9 or exists(select 1 from unnest(kinds) k where k is null or k not in ('mice','matings','litters','cages','rooms','racks','locations','light_events','husbandry_events')) then
    raise exception using errcode='22023',message='Choose supported managed record types; raw archives are not part of this export'; end if;
  if p_scope='current_housing' and (p_from_date is not null or p_to_date is not null or exists(select 1 from unnest(kinds) k where k not in ('mice','cages','rooms','racks','locations','light_events'))) then
    raise exception using errcode='22023',message='Current housing is a current snapshot without historical date filters'; end if;
  end_at:=coalesce(p_to_date,today);start_at:=coalesce(p_from_date,cutoff);
  if p_scope='history' and (end_at>today or (start_at is not null and start_at>end_at)) then
    raise exception using errcode='22023',message='Export dates must be ordered and cannot exceed the current date'; end if;
  if p_scope='history' and cutoff is not null and (start_at<cutoff or end_at<cutoff) then
    raise exception using errcode='42501',message='The requested dates exceed your export permission'; end if;
  include_undated:=(permission->>'level'='max' and p_from_date is null);
  select coalesce(max(audit_id),0)::text into revision from public.audit_log where colony_id=p_colony_id;
  with current_mice as (
    select payload from public.entity_records where colony_id=p_colony_id and entity_type='mice' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true' and payload->>'state'='Stock'
  ), current_locations as (
    select entity_id from public.entity_records where colony_id=p_colony_id and entity_type='locations' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true'
  ), eligible as (
    select r.entity_type,r.entity_id,r.payload,colony_private.export_domain_date(r.entity_type,r.payload) domain_date
    from public.entity_records r where r.colony_id=p_colony_id and r.entity_type=any(kinds)
    and (p_scope='history' or (not r.archived and coalesce(r.payload->>'app_archived_at','')='' and coalesce(r.payload->>'archived','false')<>'true' and (
      (r.entity_type='mice' and r.payload->>'state'='Stock') or
      (r.entity_type='cages' and (lower(r.payload->>'state') in ('active','occupied') or exists(select 1 from current_mice m where m.payload->>'cage_sid'=r.entity_id) or exists(select 1 from current_locations l where l.entity_id=r.payload->>'location_id'))) or
      r.entity_type in ('rooms','racks','locations') or
      (r.entity_type='light_events' and colony_private.export_light_current(r.payload))
    )))
  ), selected as (
    select * from eligible where p_scope='current_housing' or (domain_date between coalesce(start_at,'0001-01-01'::date) and end_at) or (domain_date is null and include_undated)
  ), page as (select * from selected order by entity_type collate "C",entity_id collate "C" offset p_offset limit p_limit+1), projected as (
    select entity_type,entity_id,jsonb_build_object('entity_type',entity_type,'entity_id',entity_id,'record_date',domain_date,'payload',colony_private.export_payload(entity_type,payload)) body from page
  ), numbered as (
    select *,row_number() over(order by entity_type collate "C",entity_id collate "C") n,
      sum(octet_length(body::text)) over(order by entity_type collate "C",entity_id collate "C") bytes from projected
  )
  select coalesce(jsonb_agg(body order by n) filter(where n<=p_limit and bytes<=800000),'[]'),
    coalesce(bool_or(n>p_limit or bytes>800000),false),(select count(*) from eligible where p_scope='history' and domain_date is null and not include_undated)
  into result,more,omitted from numbered;
  return jsonb_build_object('rows',result,'next_offset',case when more then p_offset+jsonb_array_length(result) else null end,'export_level',permission->>'level','cutoff_date',cutoff,'as_of_date',today,'captured_at',current_timestamp,'snapshot_revision',revision,
    'from_date',case when p_scope='history' then start_at else null end,'to_date',case when p_scope='history' then end_at else null end,'scope',p_scope,'excluded_undated',omitted);
end $$;
revoke all on function public.export_records(uuid,text,date,date,text[],integer,integer) from public,anon,authenticated;
grant execute on function public.export_records(uuid,text,date,date,text[],integer,integer) to authenticated;
commit;
