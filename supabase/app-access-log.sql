-- Apply after schema.sql, manager-permissions.sql and lab-members.sql.
-- App-reported authenticated activity starts with this migration. No historical
-- sign-in attempts, credentials, IP addresses, URLs or record contents are imported.
begin;

create table if not exists colony_private.app_access_activation (
  singleton boolean primary key default true check(singleton),
  started_at timestamptz not null default clock_timestamp()
);
insert into colony_private.app_access_activation(singleton) values(true) on conflict do nothing;
alter table colony_private.app_access_activation enable row level security;
revoke all on colony_private.app_access_activation from public,anon,authenticated,service_role;

create table if not exists colony_private.app_access_log (
  access_id bigint generated always as identity primary key,
  colony_id uuid not null references public.colonies(id),
  user_id uuid not null,
  email text not null check(length(email) between 3 and 320),
  name text check(name is null or length(name)<=200),
  acronym text check(acronym is null or length(acronym)<=20),
  role text not null check(role in ('owner','manager','editor','viewer')),
  app text not null check(app in ('mouse','reagents')),
  event text not null check(event in ('session_start','page_view','sign_out')),
  page text not null check(length(page) between 1 and 32),
  session_id uuid not null,
  event_id uuid not null,
  occurred_at timestamptz not null default clock_timestamp(),
  source text not null default 'app_reported' check(source='app_reported'),
  unique(colony_id,user_id,event_id)
);
create index if not exists app_access_colony_order on colony_private.app_access_log(colony_id,access_id desc);
create index if not exists app_access_colony_user_time on colony_private.app_access_log(colony_id,user_id,occurred_at desc);
create index if not exists app_access_session_event on colony_private.app_access_log(colony_id,user_id,app,session_id,event,page,occurred_at desc);
alter table colony_private.app_access_log enable row level security;
revoke all on colony_private.app_access_log from public,anon,authenticated,service_role;
revoke all on sequence colony_private.app_access_log_access_id_seq from public,anon,authenticated,service_role;
drop trigger if exists app_access_log_immutable on colony_private.app_access_log;
create trigger app_access_log_immutable before update or delete on colony_private.app_access_log
  for each row execute function colony_private.reject_removal();
drop trigger if exists app_access_log_no_truncate on colony_private.app_access_log;
create trigger app_access_log_no_truncate before truncate on colony_private.app_access_log
  for each statement execute function colony_private.reject_removal();

create or replace function public.record_app_access(
  p_colony_id uuid,p_app text,p_event text,p_page text,p_session_id uuid,p_event_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid(); actor_role text; actor_email text; actor_name text; actor_acronym text;
  received_at timestamptz:=clock_timestamp(); previous colony_private.app_access_log%rowtype; saved colony_private.app_access_log%rowtype;
begin
  if actor is null then raise exception using errcode='42501',message='Authenticated member access is required'; end if;
  -- Serializes this user's logging with revocation and concurrent event requests.
  select m.role into actor_role from public.memberships m
    where m.colony_id=p_colony_id and m.user_id=actor and m.active for update;
  if actor_role is null then raise exception using errcode='42501',message='An active colony membership is required'; end if;
  select lower(u.email) into actor_email from auth.users u where u.id=actor and u.email_confirmed_at is not null;
  if actor_email is null then raise exception using errcode='42501',message='A verified account email is required'; end if;
  if p_app is null or p_app not in ('mouse','reagents') or p_event is null or p_event not in ('session_start','page_view','sign_out')
    or p_page is null or p_session_id is null or p_event_id is null then
    raise exception using errcode='22023',message='Supply an allowed app, event, page, session UUID and event UUID';
  end if;
  if (p_app='mouse' and p_page<>all(array['overview','mice','matings','litters','cages','family','planner','experiments','iacuc','housing','locobox','cryo','fees','archive','brainbot','settings']))
    or (p_app='reagents' and p_page<>all(array['inventory','safety','usage','orders','vendors','equipment','history','review','settings'])) then
    raise exception using errcode='22023',message='Only an application section name can be logged';
  end if;
  select * into previous from colony_private.app_access_log l
    where l.colony_id=p_colony_id and l.user_id=actor and l.event_id=p_event_id;
  if found then
    if (previous.app,previous.event,previous.page,previous.session_id) is distinct from (p_app,p_event,p_page,p_session_id) then
      raise exception using errcode='22023',message='This event UUID already identifies different activity';
    end if;
    return jsonb_build_object('recorded',false,'reason','duplicate','event_id',p_event_id,'occurred_at',previous.occurred_at);
  end if;
  if exists(select 1 from colony_private.app_access_log l where l.colony_id=p_colony_id and l.user_id=actor
    and l.app=p_app and l.session_id=p_session_id and l.event=p_event
    and (p_event<>'page_view' or (l.page=p_page and l.occurred_at>received_at-interval '30 seconds'))) then
    return jsonb_build_object('recorded',false,'reason','debounced','event_id',p_event_id);
  end if;
  if (select count(*) from (select 1 from colony_private.app_access_log l where l.colony_id=p_colony_id and l.user_id=actor and l.occurred_at>received_at-interval '1 minute' limit 60) recent)>=60
    or (select count(*) from (select 1 from colony_private.app_access_log l where l.colony_id=p_colony_id and l.user_id=actor and l.occurred_at>received_at-interval '1 day' limit 3000) recent)>=3000 then
    return jsonb_build_object('recorded',false,'reason','rate_limited','event_id',p_event_id);
  end if;
  select p.name,p.acronym into actor_name,actor_acronym from public.lab_members p where p.colony_id=p_colony_id
    and (p.linked_user_id=actor or (p.linked_user_id is null and p.email=actor_email))
    order by (p.linked_user_id=actor) desc nulls last,p.person_id limit 1;
  insert into colony_private.app_access_log(colony_id,user_id,email,name,acronym,role,app,event,page,session_id,event_id,occurred_at)
    values(p_colony_id,actor,actor_email,actor_name,actor_acronym,actor_role,p_app,p_event,p_page,p_session_id,p_event_id,received_at)
    returning * into saved;
  return jsonb_build_object('recorded',true,'reason','recorded','event_id',saved.event_id,'occurred_at',saved.occurred_at);
end $$;
revoke all on function public.record_app_access(uuid,text,text,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.record_app_access(uuid,text,text,text,uuid,uuid) to authenticated;

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
revoke all on function public.list_app_access(uuid,text,uuid,text,timestamptz,timestamptz,bigint,integer) from public,anon,authenticated,service_role;
grant execute on function public.list_app_access(uuid,text,uuid,text,timestamptz,timestamptz,bigint,integer) to authenticated;
commit;
