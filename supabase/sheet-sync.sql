-- Apply after schema.sql. This optional integration writes ONLY a separate output workbook.
create table if not exists public.sheet_sync_state (
  colony_id uuid primary key references public.colonies(id),
  lock_token uuid,
  started_at timestamptz,
  last_success_at timestamptz,
  status text not null default 'not_configured',
  last_error text
);
alter table public.sheet_sync_state enable row level security;
revoke all on public.sheet_sync_state from public, anon, authenticated;
grant select, insert, update on public.sheet_sync_state to service_role;

create or replace function public.claim_sheet_sync(p_colony_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare result uuid;
begin
  insert into public.sheet_sync_state(colony_id) values(p_colony_id) on conflict do nothing;
  update public.sheet_sync_state set lock_token=gen_random_uuid(), started_at=now(),
    status='running',last_error=null where colony_id=p_colony_id and lock_token is null
    returning lock_token into result;
  return result;
end $$;

-- One SQL statement gives a consistent database snapshot, regardless of paging limits.
-- Return only the fields used by the five managed Sheet tabs. Full source/history
-- payloads remain in entity_records; serializing them here can exceed REST timeouts.
create or replace function public.sheet_sync_snapshot(p_colony_id uuid, p_token uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  with projection_fields(entity_type,keys) as (values
    ('mice',array['mouse_sid','state','physical_tag','ear_mark','sex','genotype','date_of_birth','cage_sid','cage_tag','status','sire_sids','dam_sids','protocol','comment','owner','manager','manager_acronym']),
    ('cages',array['cage_sid','cage_tag','state','room_id','rack_id','location_id','room','rack','location','cage_type','capacity','comment','owner','manager','manager_acronym','cage_protocol','protocol']),
    ('rooms',array['room_id','name','label']),
    ('racks',array['rack_id','room_id','name','label']),
    ('locations',array['location_id','room_id','rack_id','label','source_label','row','column','source_observed_mouse_sids','source_candidate_mouse_sids','source_observed_tags','source_observed_cage_sids','source_candidate_cage_sids','evidence_status','notes','source_block_text','source_snapshot_date','source_current','source_last_seen_at','manager','manager_acronym','source_manager_raw','source_manager_name','source_manager_acronym']),
    ('light_events',array['event_id','location_id','cage_sid','room_id','rack_id','start_date','end_date','protocol','cycle_hours','light_hours','lights_on','lights_off','transition_minutes','intensity_lux','timezone','evidence_status','actual_exposure_verified','notes','interval_semantics'])
  )
  select jsonb_build_object('captured_at',now(),'records',coalesce((
    select jsonb_agg(jsonb_build_object('entity_type',r.entity_type,'entity_id',r.entity_id,
      'payload',(select coalesce(jsonb_object_agg(k,r.payload->k),'{}'::jsonb)
        from unnest(f.keys || array['app_archived_at','source_url','source_file','source_filename']) k
        where r.payload ? k),
      'version',r.version,'archived',r.archived) order by r.entity_type,r.entity_id)
    from public.entity_records r join projection_fields f using(entity_type)
    where r.colony_id=p_colony_id
      -- Every projection path uses Stock mice. Keep all cages, including ended
      -- cages linked to a position or Stock mouse, and all light observations.
      and (r.entity_type <> 'mice' or r.payload->>'state'='Stock')
  ),'[]'::jsonb))
  where exists(select 1 from public.sheet_sync_state where colony_id=p_colony_id and lock_token=p_token);
$$;

create or replace function public.finish_sheet_sync(p_colony_id uuid,p_token uuid,p_success boolean,p_error text default null)
returns void language sql security definer set search_path=public,pg_temp as $$
  update public.sheet_sync_state set lock_token=null,
    status=case when p_success then 'ok' else 'failed_before_write' end,
    last_success_at=case when p_success then now() else last_success_at end,
    last_error=left(p_error,500)
  where colony_id=p_colony_id and lock_token=p_token;
$$;
revoke all on function public.claim_sheet_sync(uuid) from public,anon,authenticated;
revoke all on function public.sheet_sync_snapshot(uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_sheet_sync(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.claim_sheet_sync(uuid) to service_role;
grant execute on function public.sheet_sync_snapshot(uuid,uuid) to service_role;
grant execute on function public.finish_sheet_sync(uuid,uuid,boolean,text) to service_role;
-- Locks deliberately do not expire. After a crashed/uncertain Google write, inspect the output
-- and stop outstanding invocations before an administrator clears lock_token. This prevents
-- an older, delayed request from overwriting a newer snapshot.
