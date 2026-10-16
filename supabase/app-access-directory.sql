-- Apply after app-access-log.sql and lab-members.sql.
-- Owner-only account directory, independent of event filters and page size.
-- Replaces only the read RPC; existing grants, log events and recording stay unchanged.
begin;
create or replace function public.list_app_access(
  p_colony_id uuid,p_app text default null,p_user_id uuid default null,p_event text default null,
  p_from timestamptz default null,p_to timestamptz default null,p_before bigint default null,p_limit integer default 50
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_role text; rows jsonb; users jsonb; more boolean; next_id text; started timestamptz;
begin
  -- Deliberately checks role itself. No manager capability or export level can enable this RPC.
  if auth.uid() is null then raise exception using errcode='42501',message='Only an active colony owner can view access logs'; end if;
  select m.role into actor_role from public.memberships m where m.colony_id=p_colony_id and m.user_id=auth.uid() and m.active for share;
  if actor_role is distinct from 'owner' then raise exception using errcode='42501',message='Only an active colony owner can view access logs'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or (p_before is not null and p_before<1)
    or (p_app is not null and p_app not in ('mouse','reagents'))
    or (p_event is not null and p_event not in ('session_start','page_view','sign_out'))
    or (p_from is not null and p_to is not null and p_from>=p_to) then
    raise exception using errcode='22023',message='Invalid access-log filter or page size';
  end if;
  with limited as (
    select l.* from colony_private.app_access_log l where l.colony_id=p_colony_id
      and (p_app is null or l.app=p_app) and (p_user_id is null or l.user_id=p_user_id)
      and (p_event is null or l.event=p_event) and (p_from is null or l.occurred_at>=p_from)
      and (p_to is null or l.occurred_at<p_to) and (p_before is null or l.access_id<p_before)
      order by l.access_id desc limit p_limit+1
  ), numbered as (select l.*,row_number() over(order by l.access_id desc) n from limited l)
  select coalesce(jsonb_agg(jsonb_build_object('access_id',access_id::text,'event_id',event_id,'occurred_at',occurred_at,
    'app',app,'event',event,'page',page,'user_id',user_id,'email',email,'name',name,'acronym',acronym,
    'role',role,'session_id',session_id,'source',source) order by access_id desc) filter(where n<=p_limit),'[]'::jsonb),
    count(*)>p_limit,min(access_id) filter(where n<=p_limit)::text
    into rows,more,next_id from numbered;
  -- The filter directory is independent of event pagination and filters. Account
  -- sign-in timestamps are Auth facts, not fabricated app activity. Retain past
  -- log identities after membership removal without exposing their later sign-ins.
  with user_ids as (
    select m.user_id from public.memberships m where m.colony_id=p_colony_id
    union
    select l.user_id from colony_private.app_access_log l where l.colony_id=p_colony_id
  ), directory as (
    select ids.user_id,
      coalesce(nullif(btrim(person.name),''),nullif(btrim(previous.name),''),
        nullif(btrim(u.raw_user_meta_data->>'full_name'),''),nullif(btrim(u.raw_user_meta_data->>'name'),''),
        nullif(btrim(u.raw_user_meta_data->>'display_name'),''),u.email,previous.email,ids.user_id::text) as name,
      coalesce(u.email,previous.email) as email,coalesce(person.acronym,previous.acronym) as acronym,
      case when m.user_id is not null then u.last_sign_in_at else null end as last_sign_in_at,
      coalesce(m.active,false) as active
    from user_ids ids
    left join public.memberships m on m.colony_id=p_colony_id and m.user_id=ids.user_id
    left join auth.users u on m.user_id is not null and u.id=ids.user_id
    left join lateral (
      select l.name,l.email,l.acronym from colony_private.app_access_log l
      where l.colony_id=p_colony_id and l.user_id=ids.user_id order by l.access_id desc limit 1
    ) previous on true
    left join lateral (
      select p.name,p.acronym from public.lab_members p
      where p.colony_id=p_colony_id and (p.linked_user_id=ids.user_id or
        (p.linked_user_id is null and p.email=lower(btrim(u.email))))
      order by (p.linked_user_id=ids.user_id) desc nulls last,p.person_id limit 1
    ) person on true
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'name',name,'email',email,
    'acronym',acronym,'last_sign_in_at',last_sign_in_at,'active',active) order by lower(name),user_id),'[]'::jsonb)
    into users from directory;
  select started_at into started from colony_private.app_access_activation where singleton;
  return jsonb_build_object('events',rows,'users',users,'has_more',more,'next_before',case when more then next_id else null end,'logging_started_at',started);
end $$;
commit;
