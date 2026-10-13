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
create or replace function public.sheet_sync_snapshot(p_colony_id uuid, p_token uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('captured_at',now(),'records',coalesce((
    select jsonb_agg(jsonb_build_object('entity_type',r.entity_type,'entity_id',r.entity_id,
      'payload',r.payload,'version',r.version,'archived',r.archived) order by r.entity_type,r.entity_id)
    from public.entity_records r where r.colony_id=p_colony_id and r.entity_type <> 'archive'
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
