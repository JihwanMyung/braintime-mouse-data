-- Apply after schema.sql and export-permissions.sql, before lab-members.sql.
-- No accounts, memberships, export levels or source records are created here.
begin;
create or replace function colony_private.default_manager_permissions()
returns jsonb language sql immutable set search_path='' as $$
 select '{"mice":true,"breeding":true,"housing":true,"experiments":true,"cryo":true,"genetics":true,"imports":true,"archive":true,"fees":true}'::jsonb
$$;
revoke all on function colony_private.default_manager_permissions() from public,anon,authenticated;
create or replace function colony_private.valid_manager_permissions(p jsonb)
returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(p)='object' and p ?& array['mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees']
 and not exists(select 1 from jsonb_each(p) where key not in ('mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees') or jsonb_typeof(value)<>'boolean')
$$;
revoke all on function colony_private.valid_manager_permissions(jsonb) from public,anon,authenticated;
alter table public.memberships add column if not exists permissions jsonb not null default '{"mice":true,"breeding":true,"housing":true,"experiments":true,"cryo":true,"genetics":true,"imports":true,"archive":true,"fees":true}'::jsonb;
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check check(role in ('owner','editor','viewer','manager'));
alter table public.memberships drop constraint if exists memberships_permissions_check;
alter table public.memberships add constraint memberships_permissions_check check(colony_private.valid_manager_permissions(permissions));

create or replace function colony_private.has_permission(p_colony_id uuid,p_permission text)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select case when m.role in ('owner','editor') then true
   when m.role='manager' then m.permissions->p_permission='true'::jsonb else false end
   from public.memberships m where m.colony_id=p_colony_id and m.user_id=auth.uid() and m.active),false)
   and p_permission in ('mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees')
$$;
revoke all on function colony_private.has_permission(uuid,text) from public,anon,authenticated;
grant execute on function colony_private.has_permission(uuid,text) to authenticated;

-- Check both the stored and proposed payload; changing event_type cannot evade
-- a disabled section. Presence of nested domain data also requires that section.
create or replace function colony_private.record_permissions(kind text,p jsonb)
returns text[] language plpgsql immutable set search_path='' as $$
declare permissions text[]:=array[]::text[]; event_kind text:=coalesce(p->>'event_type','');
begin
 if kind='mice' then return array['mice'];
 elsif kind in ('matings','litters') then return array['breeding'];
 elsif kind in ('cages','rooms','racks','locations','light_events') then return array['housing'];
 elsif kind='archive' then
   -- A reconstruction manifest can replace every source-backed domain.
   return array['imports','mice','breeding','housing','experiments','cryo','genetics','fees'];
 elsif kind='husbandry_events' then
   if event_kind like 'experiment%' or p ?| array['experiment','experiment_sample','experiment_revision'] then permissions:=array_append(permissions,'experiments'); end if;
   if event_kind like 'cryopreservation%' or p ?| array['cryopreservation','cryopreservation_event'] then permissions:=array_append(permissions,'cryo'); end if;
   if event_kind in ('strain_definition','breeding_plan') or p ?| array['strain_definition','breeding_plan'] then permissions:=array_append(permissions,'genetics'); end if;
   if event_kind='breeding_options' or p ? 'breeding_options' then permissions:=array_append(permissions,'breeding'); end if;
   if event_kind ~ '^(lac_fee|fee|fees|billing)_' or p ?| array['lac_fee_options','lac_fee_month','fee_options','fee_month','fee_actual','fees','billing','billing_options','billing_month'] then permissions:=array_append(permissions,'fees'); end if;
   if event_kind like 'cage_%' or p ? 'cage_summary_options' then permissions:=array_append(permissions,'housing'); end if;
   if cardinality(permissions)=0 then permissions:=array['housing']; end if;
   return permissions;
 end if;
 raise exception using errcode='22023',message='Unsupported record type';
end $$;
revoke all on function colony_private.record_permissions(text,jsonb) from public,anon,authenticated;

create or replace function colony_private.assert_record_permission(p_colony_id uuid,kind text,p jsonb,old_p jsonb,p_archived boolean,old_archived boolean)
returns void language plpgsql security definer set search_path='' as $$
declare role text:=colony_private.current_role(p_colony_id); permission text; required text[]; field_name text; field_group text; field_names text[];
begin
 -- User identities and display aliases are owner-managed even for editors.
 if kind='husbandry_events' and (coalesce(p->>'event_type','') like 'user_acronym%' or p ? 'user_acronym'
   or coalesce(old_p->>'event_type','') like 'user_acronym%' or old_p ? 'user_acronym') and role is distinct from 'owner' then
   raise exception using errcode='42501',message='Only the owner can manage user acronyms'; end if;
 if role in ('owner','editor') then return; end if;
 if role is distinct from 'manager' then raise exception using errcode='42501',message='Active colony write membership is required'; end if;
 required:=colony_private.record_permissions(kind,p);
 if old_p is not null then required:=required||colony_private.record_permissions(kind,old_p); end if;
 -- Mice/mating/litter forms can also move animals, alter genetics or parentage.
 -- Authorize the changed fields, not merely the screen or entity containing them.
 foreach field_group in array array['housing','genetics','breeding'] loop
   field_names:=case field_group
     when 'housing' then array['cage_sid','cage_tag','room_id','rack_id','location_id','room','rack','location','location_label']
     when 'genetics' then array['genotype','genetic_profile','mouseline','strain','strain_code','genotype_status','genotyping_status','genotype_date']
     else array['sire_sids','dam_sids','litter_sid','mating_sid'] end;
   if kind in ('mice','matings','litters') and (field_group='housing' or kind='mice') then
     foreach field_name in array field_names loop
       if coalesce(p->field_name,'null'::jsonb) is distinct from coalesce(old_p->field_name,'null'::jsonb)
         and (old_p is not null or coalesce(p->field_name,'null'::jsonb) not in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb)) then
         required:=array_append(required,field_group); exit;
       end if;
     end loop;
   end if;
 end loop;
 if p_archived or p_archived is distinct from old_archived or coalesce(p->'app_archived_at','null'::jsonb) is distinct from coalesce(old_p->'app_archived_at','null'::jsonb)
   or coalesce(p->'archived','false'::jsonb) is distinct from coalesce(old_p->'archived','false'::jsonb) then required:=array_append(required,'archive'); end if;
 -- Newly imported operational rows require imports as well as their section.
 -- App-created reviewed observations may reference sources without being a bulk import.
 if old_p is null and p ? 'record_origin' and p->>'record_origin'<>'app_created' then required:=array_append(required,'imports'); end if;
 foreach permission in array required loop
   if not colony_private.has_permission(p_colony_id,permission) then
     raise exception using errcode='42501',message='Manager permission required: '||permission;
   end if;
 end loop;
end $$;
revoke all on function colony_private.assert_record_permission(uuid,text,jsonb,jsonb,boolean,boolean) from public,anon,authenticated;

create or replace function public.save_record(
  p_colony_id uuid,p_entity_type text,p_entity_id text,p_payload jsonb,
  p_expected_version integer,p_archived boolean default false
) returns setof public.entity_records
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); existing public.entity_records%rowtype; saved public.entity_records%rowtype; k text; has_record boolean;
begin
  if actor is null or coalesce(colony_private.current_role(p_colony_id),'') not in ('owner','editor','manager') then
    raise exception using errcode='42501',message='Active colony write membership is required';
  end if;
  if p_expected_version is null or p_expected_version<0 or p_entity_id is null or btrim(p_entity_id)<>p_entity_id or length(p_entity_id) not between 1 and 200 or p_archived is null then
    raise exception using errcode='22023',message='Invalid identifier, version or archive flag';
  end if;
  perform colony_private.validate_payload(p_entity_type,p_entity_id,p_payload);
  -- Single and batch saves use the same colony lock, so multi-record workflows
  -- cannot interleave and callers cannot create a record-lock ordering deadlock.
  perform pg_advisory_xact_lock(hashtextextended('colony:'||p_colony_id::text,0));
  -- Also serializes simultaneous creates, for which no row exists to lock yet.
  perform pg_advisory_xact_lock(hashtextextended(p_colony_id::text||':'||p_entity_type||':'||p_entity_id,0));
  select * into existing from public.entity_records
    where colony_id=p_colony_id and entity_type=p_entity_type and entity_id=p_entity_id for update;
  has_record:=FOUND;
  perform colony_private.assert_record_permission(p_colony_id,p_entity_type,p_payload,
    case when has_record then existing.payload else null end,p_archived,coalesce(existing.archived,false));
  if has_record then
    if p_expected_version<>existing.version then
      raise exception using errcode='40001',message='Version conflict: reload the current record before editing';
    end if;
    for k in select key from jsonb_each(existing.payload) where key like 'source%' or key='record_origin' loop
      if (existing.payload->k) is distinct from (p_payload->k) then
        raise exception using errcode='22023',message='Existing source provenance fields are immutable';
      end if;
    end loop;
    if existing.payload=p_payload and existing.archived=p_archived then return next existing; return; end if;
    if p_entity_type='archive' and p_entity_id ~ '^chunk:[0-9a-f]{64}$' then
      raise exception using errcode='22023',message='Archive chunks are immutable; create a new content-addressed chunk';
    end if;
    update public.entity_records set payload=p_payload,archived=p_archived,version=version+1,
      updated_at=clock_timestamp(),updated_by=actor
      where colony_id=p_colony_id and entity_type=p_entity_type and entity_id=p_entity_id returning * into saved;
  else
    if p_expected_version<>0 then raise exception using errcode='40001',message='Version conflict: record does not exist'; end if;
    insert into public.entity_records(colony_id,entity_type,entity_id,payload,archived,created_by,updated_by)
    values(p_colony_id,p_entity_type,p_entity_id,p_payload,p_archived,actor,actor) returning * into saved;
  end if;
  return next saved;
end $$;
revoke all on function public.save_record(uuid,text,text,jsonb,integer,boolean) from public,anon,authenticated;
grant execute on function public.save_record(uuid,text,text,jsonb,integer,boolean) to authenticated;

create or replace function public.save_records(p_colony_id uuid,p_changes jsonb)
returns setof public.entity_records language plpgsql security definer set search_path='' as $$
declare change jsonb;
begin
  if auth.uid() is null or coalesce(colony_private.current_role(p_colony_id),'') not in ('owner','editor','manager') then
    raise exception using errcode='42501',message='Active colony write membership is required';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using errcode='22023',message='Changes must be an array';
  end if;
  if jsonb_array_length(p_changes)<1 or jsonb_array_length(p_changes)>500 then
    raise exception using errcode='22023',message='A batch must contain 1 to 500 records';
  end if;
  if exists(select 1 from jsonb_array_elements(p_changes) x group by x->>'entity_type',x->>'entity_id' having count(*)>1) then
    raise exception using errcode='22023',message='Duplicate entity identifiers in a batch';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('colony:'||p_colony_id::text,0));
  for change in select value from jsonb_array_elements(p_changes) order by value->>'entity_type',value->>'entity_id' loop
    if jsonb_typeof(change) is distinct from 'object' or jsonb_typeof(change->'entity_type') is distinct from 'string'
      or jsonb_typeof(change->'entity_id') is distinct from 'string' or jsonb_typeof(change->'expected_version') is distinct from 'number'
      or change->>'expected_version' !~ '^\d+$' or (change ? 'archived' and jsonb_typeof(change->'archived') is distinct from 'boolean') then
      raise exception using errcode='22023',message='Invalid batch change types';
    end if;
    return query select * from public.save_record(p_colony_id,change->>'entity_type',change->>'entity_id',change->'payload',
      (change->>'expected_version')::integer,coalesce((change->>'archived')::boolean,false));
  end loop;
end $$;
revoke all on function public.save_records(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_records(uuid,jsonb) to authenticated;

create or replace function public.set_member_role(p_colony_id uuid,p_user_id uuid,p_role text,p_active boolean default true)
returns setof public.memberships language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); old_member public.memberships%rowtype; saved public.memberships%rowtype;
begin
  perform 1 from public.colonies where id=p_colony_id for update;
  if actor is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then
    raise exception using errcode='42501',message='Only an active colony owner can manage members';
  end if;
  if p_role not in ('owner','editor','viewer','manager') or p_role is null or p_active is null then
    raise exception using errcode='22023',message='Invalid role or active flag';
  end if;
  select * into old_member from public.memberships where colony_id=p_colony_id and user_id=p_user_id;
  if old_member.active and old_member.role='owner' and (not p_active or p_role<>'owner') and
     (select count(*) from public.memberships where colony_id=p_colony_id and role='owner' and active)<=1 then
    raise exception using errcode='22023',message='A colony must retain at least one active owner';
  end if;
  insert into public.memberships(colony_id,user_id,role,active,updated_by)
    values(p_colony_id,p_user_id,p_role,p_active,actor)
    on conflict(colony_id,user_id) do update set role=excluded.role,active=excluded.active,updated_at=clock_timestamp(),updated_by=actor
    returning * into saved;
  insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record)
    values(p_colony_id,'membership',p_user_id::text,case when old_member.user_id is null then 'INSERT' else 'UPDATE' end,actor,
           case when old_member.user_id is null then null else to_jsonb(old_member) end,to_jsonb(saved));
  return next saved;
end $$;
revoke all on function public.set_member_role(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.set_member_role(uuid,uuid,text,boolean) to authenticated;

-- Omitted permissions retain the previous assignment; partial explicit maps use
-- the documented all-enabled defaults. Existing callers may omit both options.
drop function if exists public.manage_colony_member(uuid,uuid,text,boolean,text);
drop function if exists public.manage_colony_member(uuid,uuid,text,boolean,text,text);
create or replace function public.manage_colony_member(
 p_colony_id uuid,p_user_id uuid,p_role text,p_active boolean,p_action text,p_export_level text default null,p_permissions jsonb default null
) returns setof public.memberships language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); target public.memberships%rowtype; saved public.memberships%rowtype; requested text; flags jsonb;
begin
 perform 1 from public.colonies where id=p_colony_id for update;
 if actor is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then
   raise exception using errcode='42501',message='Only an active colony owner can manage members'; end if;
 if p_role is null or p_role not in ('viewer','editor','manager') or p_active is null or p_action is null or p_action not in ('add','update') or p_user_id is null
   or (p_export_level is not null and p_export_level not in ('low','high','max')) then
   raise exception using errcode='22023',message='Invalid membership or export permission request'; end if;
 if p_permissions is not null and (jsonb_typeof(p_permissions) is distinct from 'object' or not colony_private.valid_manager_permissions(colony_private.default_manager_permissions()||p_permissions)) then
   raise exception using errcode='22023',message='Manager permissions must contain only known boolean flags'; end if;
 select * into target from public.memberships where colony_id=p_colony_id and user_id=p_user_id;
 if p_user_id=actor or target.role='owner' then raise exception using errcode='42501',message='Owner accounts are protected'; end if;
 if p_action='add' and target.user_id is not null then raise exception using errcode='23505',message='This account is already a colony member'; end if;
 if p_action='update' and target.user_id is null then raise exception using errcode='P0002',message='This account is not a colony member'; end if;
 requested:=coalesce(p_export_level,target.export_level,'low');
 flags:=case when p_permissions is null then coalesce(target.permissions,colony_private.default_manager_permissions()) else colony_private.default_manager_permissions()||p_permissions end;
 select * into saved from public.set_member_role(p_colony_id,p_user_id,p_role,p_active);
 if saved.export_level<>requested or saved.permissions<>flags then
   target:=saved;
   update public.memberships set export_level=requested,permissions=flags,updated_at=clock_timestamp(),updated_by=actor
     where colony_id=p_colony_id and user_id=p_user_id returning * into saved;
   insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record)
     values(p_colony_id,'membership',p_user_id::text,'UPDATE',actor,to_jsonb(target),to_jsonb(saved));
 end if;
 return next saved;
end $$;
revoke all on function public.manage_colony_member(uuid,uuid,text,boolean,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.manage_colony_member(uuid,uuid,text,boolean,text,text,jsonb) to authenticated;

-- Allow only explicitly permitted managers to upload immutable history objects.
-- Optional so this migration also works before the storage integration is installed.
do $$
begin
 if to_regclass('storage.objects') is not null and to_regprocedure('colony_private.history_path_colony(text)') is not null then
   execute 'drop policy if exists colony_history_insert on storage.objects';
   execute 'create policy colony_history_insert on storage.objects for insert to authenticated with check(bucket_id=''colony-history'' and colony_private.has_permission(colony_private.history_path_colony(name),''imports''))';
   execute 'drop policy if exists colony_history_insert_guard on storage.objects';
   execute 'create policy colony_history_insert_guard on storage.objects as restrictive for insert to authenticated with check(bucket_id<>''colony-history'' or colony_private.has_permission(colony_private.history_path_colony(name),''imports''))';
 end if;
end $$;
commit;
