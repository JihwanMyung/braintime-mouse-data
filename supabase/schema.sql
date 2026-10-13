-- Run once in a dedicated Supabase project's SQL editor, as the database owner.
-- No cloud project or account is created by this file.
begin;
create schema if not exists colony_private;
revoke all on schema colony_private from public, anon, authenticated;
grant usage on schema colony_private to authenticated;

create table if not exists public.colonies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);
create table if not exists public.memberships (
  colony_id uuid not null references public.colonies(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner','editor','viewer')),
  active boolean not null default true,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (colony_id,user_id)
);
create table if not exists public.entity_records (
  colony_id uuid not null references public.colonies(id),
  entity_type text not null check (entity_type in ('mice','matings','litters','cages','rooms','racks','locations','light_events','husbandry_events','archive')),
  entity_id text not null check (length(entity_id) between 1 and 200 and entity_id=btrim(entity_id)),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  version integer not null default 1 check (version>0),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  primary key (colony_id,entity_type,entity_id)
);
create table if not exists public.audit_log (
  audit_id bigint generated always as identity primary key,
  colony_id uuid not null references public.colonies(id),
  entity_type text not null,
  entity_id text not null,
  operation text not null check (operation in ('INSERT','UPDATE')),
  actor_id uuid references auth.users(id),
  occurred_at timestamptz not null default clock_timestamp(),
  before_record jsonb,
  after_record jsonb not null
);
create index if not exists entity_records_colony_updated on public.entity_records(colony_id,updated_at);
create index if not exists memberships_user on public.memberships(user_id,colony_id) where active;
create index if not exists audit_log_colony_time on public.audit_log(colony_id,audit_id);

create or replace function colony_private.current_role(p_colony_id uuid)
returns text language sql stable security definer set search_path='' as $$
  select m.role from public.memberships m
  where m.colony_id=p_colony_id and m.user_id=(select auth.uid()) and m.active
$$;
revoke all on function colony_private.current_role(uuid) from public,anon,authenticated;
grant execute on function colony_private.current_role(uuid) to authenticated;

alter table public.colonies enable row level security;
alter table public.memberships enable row level security;
alter table public.entity_records enable row level security;
alter table public.audit_log enable row level security;
drop policy if exists colonies_member_read on public.colonies;
create policy colonies_member_read on public.colonies for select to authenticated
  using (colony_private.current_role(id) is not null);
drop policy if exists memberships_own_or_owner_read on public.memberships;
create policy memberships_own_or_owner_read on public.memberships for select to authenticated
  using (user_id=(select auth.uid()) or colony_private.current_role(colony_id)='owner');
drop policy if exists records_member_read on public.entity_records;
create policy records_member_read on public.entity_records for select to authenticated
  using (colony_private.current_role(colony_id) is not null);
drop policy if exists audit_member_read on public.audit_log;
create policy audit_member_read on public.audit_log for select to authenticated
  using (colony_private.current_role(colony_id) is not null);
revoke all on public.colonies,public.memberships,public.entity_records,public.audit_log from public,anon,authenticated;
grant select on public.colonies,public.memberships,public.entity_records,public.audit_log to authenticated;

create or replace function colony_private.reject_removal()
returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='42501',message='Records are retained; use the authorized archive or membership-revocation operation.'; end
$$;
revoke all on function colony_private.reject_removal() from public,anon,authenticated;
drop trigger if exists entity_records_no_delete on public.entity_records;
create trigger entity_records_no_delete before delete on public.entity_records
  for each row execute function colony_private.reject_removal();
drop trigger if exists audit_log_immutable on public.audit_log;
create trigger audit_log_immutable before update or delete on public.audit_log
  for each row execute function colony_private.reject_removal();

create or replace function colony_private.audit_entity_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record)
  values(new.colony_id,new.entity_type,new.entity_id,TG_OP,auth.uid(),
         case when TG_OP='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
  return new;
end $$;
revoke all on function colony_private.audit_entity_change() from public,anon,authenticated;
drop trigger if exists entity_records_audit on public.entity_records;
create trigger entity_records_audit after insert or update on public.entity_records
  for each row execute function colony_private.audit_entity_change();

create or replace function colony_private.validate_payload(p_type text,p_id text,p_payload jsonb)
returns void language plpgsql set search_path='' as $$
declare id_field text; k text; v text; x jsonb; dob date; event_date date; n numeric;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode='22023',message='payload must be a JSON object';
  end if;
  id_field := case p_type when 'mice' then 'mouse_sid' when 'matings' then 'mating_sid'
    when 'litters' then 'litter_sid' when 'cages' then 'cage_sid'
    when 'rooms' then 'room_id' when 'racks' then 'rack_id' when 'locations' then 'location_id'
    when 'light_events' then 'event_id' when 'husbandry_events' then 'event_id'
    when 'archive' then null else '' end;
  if id_field='' then raise exception using errcode='22023',message='Unsupported entity type'; end if;
  if p_type='archive' then
    if p_id<>'reconstruction' and p_id !~ '^chunk:[0-9a-f]{64}$' then
      raise exception using errcode='22023',message='Archive ID must be reconstruction or a content-addressed chunk';
    end if;
    if p_id<>'reconstruction' and (p_payload->>'format' is distinct from 'colony-archive-chunk-v1'
      or jsonb_typeof(p_payload->'rows') is distinct from 'array'
      or jsonb_typeof(p_payload->'table') is distinct from 'string') then
      raise exception using errcode='22023',message='Invalid archive chunk payload';
    end if;
    return;
  end if;
  if jsonb_typeof(p_payload->id_field) is distinct from 'string' or p_payload->>id_field is distinct from p_id then
    raise exception using errcode='22023',message='Payload identifier must be a string matching entity_id';
  end if;
  if p_type='mice' and p_payload->>'sex' is not null and p_payload->>'sex' not in ('Male','Female','Unknown') then
    raise exception using errcode='22023',message='Mouse sex must be Male, Female, Unknown or null';
  end if;
  foreach k in array array['date_of_birth','wean_date','mature_date','end_date','received_date','tail_tag_date','procedure_date','set_up_date','disbanded_date','start_date'] loop
    v:=p_payload->>k;
    if v is not null then
      if jsonb_typeof(p_payload->k)<>'string' or v !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception using errcode='22023',message='Dates must be YYYY-MM-DD strings or null';
      end if;
      begin event_date:=v::date;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception using errcode='22023',message='Invalid calendar date';
      end;
    end if;
  end loop;
  dob:=(p_payload->>'date_of_birth')::date;
  if dob is not null then
    foreach k in array array['end_date','wean_date','mature_date'] loop
      if (p_payload->>k)::date<dob then raise exception using errcode='22023',message='End, weaning or mature date cannot precede birth'; end if;
    end loop;
  end if;
  if (p_payload->>'disbanded_date')::date<(p_payload->>'set_up_date')::date then
    raise exception using errcode='22023',message='Mating disbanding cannot precede setup';
  end if;
  if (p_payload->>'end_date')::date<(p_payload->>'start_date')::date then
    raise exception using errcode='22023',message='End date cannot precede start date';
  end if;
  if p_type='light_events' then
    foreach k in array array['cycle_hours','light_hours','transition_minutes','intensity_lux'] loop
      if p_payload->>k is not null then
        if jsonb_typeof(p_payload->k)<>'number' then raise exception using errcode='22023',message='Light quantities must be JSON numbers or null'; end if;
        n:=(p_payload->>k)::numeric;
        if n<0 or (k='cycle_hours' and n<=0) then raise exception using errcode='22023',message='Cycle hours must be positive; durations and intensity cannot be negative'; end if;
      end if;
    end loop;
    if (p_payload->>'light_hours')::numeric>(p_payload->>'cycle_hours')::numeric then
      raise exception using errcode='22023',message='Light hours cannot exceed cycle hours';
    end if;
  end if;
  if p_type='mice' then
    foreach k in array array['sire_sids','dam_sids'] loop
      if p_payload ? k and jsonb_typeof(p_payload->k)<>'array' then
        raise exception using errcode='22023',message='Parent alternatives must be arrays of string IDs';
      end if;
      for x in select value from jsonb_array_elements(coalesce(p_payload->k,'[]'::jsonb)) loop
        if jsonb_typeof(x)<>'string' or btrim(x#>>'{}')='' or (x#>>'{}')=p_id then
          raise exception using errcode='22023',message='Invalid or self-referencing parent ID';
        end if;
      end loop;
    end loop;
  end if;
end $$;
revoke all on function colony_private.validate_payload(text,text,jsonb) from public,anon,authenticated;

create or replace function public.save_record(
  p_colony_id uuid,p_entity_type text,p_entity_id text,p_payload jsonb,
  p_expected_version integer,p_archived boolean default false
) returns setof public.entity_records
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); existing public.entity_records%rowtype; saved public.entity_records%rowtype; k text; has_record boolean;
begin
  if actor is null or coalesce(colony_private.current_role(p_colony_id),'') not in ('owner','editor') then
    raise exception using errcode='42501',message='Active colony owner or editor membership is required';
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
  if auth.uid() is null or coalesce(colony_private.current_role(p_colony_id),'') not in ('owner','editor') then
    raise exception using errcode='42501',message='Active colony owner or editor membership is required';
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

-- Administrative onboarding RPCs act only for the logged-in user or an existing
-- colony owner. No client can give itself membership in somebody else's colony.
create or replace function public.create_colony(p_name text)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); created uuid;
begin
  if actor is null then raise exception using errcode='42501',message='Sign in first'; end if;
  insert into public.colonies(name,created_by) values(p_name,actor) returning id into created;
  insert into public.memberships(colony_id,user_id,role,updated_by) values(created,actor,'owner',actor);
  return created;
end $$;
revoke all on function public.create_colony(text) from public,anon,authenticated;
grant execute on function public.create_colony(text) to authenticated;

create or replace function public.set_member_role(p_colony_id uuid,p_user_id uuid,p_role text,p_active boolean default true)
returns setof public.memberships language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); old_member public.memberships%rowtype; saved public.memberships%rowtype;
begin
  perform 1 from public.colonies where id=p_colony_id for update;
  if actor is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then
    raise exception using errcode='42501',message='Only an active colony owner can manage members';
  end if;
  if p_role not in ('owner','editor','viewer') or p_role is null or p_active is null then
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
commit;
