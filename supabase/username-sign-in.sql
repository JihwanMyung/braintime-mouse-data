-- Only the server can consume counters; no client can list usernames or emails.
begin;
create table if not exists colony_private.username_login_attempts (
 colony_id uuid not null references public.colonies(id),
 username text not null,
 window_start timestamptz not null,
 attempts integer not null,
 primary key(colony_id,username)
);
alter table colony_private.username_login_attempts enable row level security;
revoke all on colony_private.username_login_attempts from public,anon,authenticated;
create or replace function public.consume_username_login_attempt(p_colony_id uuid,p_username text)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Server only' using errcode='42501'; end if;
 if p_username is null or p_username !~ '^[a-z][a-z0-9_.-]{2,31}$' then return false; end if;
 delete from colony_private.username_login_attempts where window_start<now()-interval '1 day';
 -- A project-wide bucket prevents unbounded random-username counter creation.
 insert into colony_private.username_login_attempts values(p_colony_id,'*',now(),1)
 on conflict(colony_id,username) do update set
 attempts=case when colony_private.username_login_attempts.window_start<now()-interval '1 minute' then 1 else colony_private.username_login_attempts.attempts+1 end,
 window_start=case when colony_private.username_login_attempts.window_start<now()-interval '1 minute' then now() else colony_private.username_login_attempts.window_start end
 returning attempts into n;
 if n>120 then return false; end if;
 insert into colony_private.username_login_attempts values(p_colony_id,p_username,now(),1)
 on conflict(colony_id,username) do update set
 attempts=case when colony_private.username_login_attempts.window_start<now()-interval '10 minutes' then 1 else colony_private.username_login_attempts.attempts+1 end,
 window_start=case when colony_private.username_login_attempts.window_start<now()-interval '10 minutes' then now() else colony_private.username_login_attempts.window_start end
 returning attempts into n;
 return n<=8;
end $$;
revoke all on function public.consume_username_login_attempt(uuid,text) from public,anon,authenticated;
grant execute on function public.consume_username_login_attempt(uuid,text) to service_role;
commit;
