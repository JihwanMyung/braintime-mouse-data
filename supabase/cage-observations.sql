-- Apply after lac-fee-visibility.sql. Literal cage observations are available
-- through its existing managed-location projection; raw source blocks stay private.
begin;
create or replace function colony_private.valid_cage_observation(p jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare animal jsonb;key text;value jsonb;raw text;parsed date;
begin
 if jsonb_typeof(p) is distinct from 'object' or p-array['schemaVersion','animals','startedDate','intensityLux','managerName','managerCell','startedCell','intensityCell']<>'{}'::jsonb
  or not p ?& array['schemaVersion','animals','startedDate','intensityLux','managerName','managerCell','startedCell','intensityCell']
  or p->'schemaVersion' is distinct from '1'::jsonb or jsonb_typeof(p->'animals') is distinct from 'array' then return false;end if;
 if jsonb_array_length(p->'animals')>100 then return false;end if;
 if p->'intensityLux'<>'null'::jsonb and (jsonb_typeof(p->'intensityLux')<>'number' or (p->>'intensityLux')::numeric not between 0 and 1000000) then return false;end if;
 if p->'managerName'<>'null'::jsonb and (jsonb_typeof(p->'managerName')<>'string' or length(p->>'managerName')>160) then return false;end if;
 foreach key in array array['managerCell','startedCell','intensityCell'] loop
  if p->key<>'null'::jsonb and (jsonb_typeof(p->key)<>'string' or p->>key !~ '^[A-Z]{1,3}[1-9][0-9]{0,5}$') then return false;end if;
 end loop;
 if p->'startedDate'<>'null'::jsonb then
  raw:=p->>'startedDate';if jsonb_typeof(p->'startedDate')<>'string' or raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false;end if;
  parsed:=raw::date;if to_char(parsed,'YYYY-MM-DD')<>raw then return false;end if;
 end if;
 for animal in select * from jsonb_array_elements(p->'animals') loop
  if jsonb_typeof(animal)<>'object' or animal-array['key','tag','note','dateOfBirth','earMark','left','right','sex','sourceCell','requiresReview']<>'{}'::jsonb
   or not animal ?& array['key','tag','note','dateOfBirth','earMark','left','right','sex','sourceCell','requiresReview'] then return false;end if;
  if jsonb_typeof(animal->'key')<>'string' or length(animal->>'key') not between 1 and 512 or jsonb_typeof(animal->'tag')<>'string' or length(animal->>'tag') not between 1 and 240
   or jsonb_typeof(animal->'note')<>'string' or length(animal->>'note')>2000 or jsonb_typeof(animal->'requiresReview')<>'boolean' then return false;end if;
  if animal->'earMark'<>'null'::jsonb and (jsonb_typeof(animal->'earMark')<>'string' or animal->>'earMark' !~ '^L[0-9]{1,2}R[0-9]{1,2}$') then return false;end if;
  foreach key in array array['left','right'] loop
   value:=animal->key;if value<>'null'::jsonb and (jsonb_typeof(value)<>'number' or (value#>>'{}')::numeric not between 0 and 99 or (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric)) then return false;end if;
  end loop;
  if animal->'earMark'<>'null'::jsonb and animal->'left'<>'null'::jsonb and animal->'right'<>'null'::jsonb and animal->>'earMark'<>'L'||(animal->>'left')||'R'||(animal->>'right') then return false;end if;
  if animal->'sex'<>'null'::jsonb and (jsonb_typeof(animal->'sex')<>'string' or animal->>'sex' not in ('Male','Female')) then return false;end if;
  if animal->'sourceCell'<>'null'::jsonb and (jsonb_typeof(animal->'sourceCell')<>'string' or animal->>'sourceCell' !~ '^[A-Z]{1,3}[1-9][0-9]{0,5}$') then return false;end if;
  if animal->'dateOfBirth'<>'null'::jsonb then
   raw:=animal->>'dateOfBirth';if jsonb_typeof(animal->'dateOfBirth')<>'string' or raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false;end if;
   parsed:=raw::date;if to_char(parsed,'YYYY-MM-DD')<>raw then return false;end if;
  end if;
 end loop;
 return true;
exception when others then return false;
end $$;
revoke all on function colony_private.valid_cage_observation(jsonb) from public,anon,authenticated;
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
returns jsonb language sql immutable set search_path='' as $$
 select (colony_private.export_fields(p,colony_private.managed_location_keys())-'source_cage_observation')
  || case when colony_private.valid_cage_observation(p->'source_cage_observation') then jsonb_build_object('source_cage_observation',p->'source_cage_observation') else '{}'::jsonb end
$$;
revoke all on function colony_private.managed_location_keys(),colony_private.managed_location_payload(jsonb) from public,anon,authenticated;
create or replace function colony_private.guard_cage_observation_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.entity_type='locations' then
  if new.payload ? 'source_cage_observation' and not colony_private.valid_cage_observation(new.payload->'source_cage_observation') then
   raise exception using errcode='22023',message='Invalid source cage observation';
  end if;
  -- Source observations are maintained only by the existing server import/admin
  -- routes. Users edit their matched mice, never reinterpret source evidence.
  if auth.uid() is not null and ((TG_OP='INSERT' and new.payload ? 'source_cage_observation') or (TG_OP='UPDATE' and old.payload->'source_cage_observation' is distinct from new.payload->'source_cage_observation')) then
   raise exception using errcode='42501',message='Source cage observations are maintained by the Animal Sheet import';
  end if;
 end if;
 return new;
end $$;
revoke all on function colony_private.guard_cage_observation_write() from public,anon,authenticated;
drop trigger if exists guard_cage_observation_write on public.entity_records;
create trigger guard_cage_observation_write before insert or update on public.entity_records for each row execute function colony_private.guard_cage_observation_write();
commit;
