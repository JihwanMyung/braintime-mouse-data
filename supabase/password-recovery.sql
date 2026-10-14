-- Recovery lookups and counters are server-only. No emails are sent by this SQL.
begin;
create table if not exists colony_private.password_recovery_attempts(
 colony_id uuid not null references public.colonies(id),bucket text not null,
 window_start timestamptz not null,attempts integer not null,primary key(colony_id,bucket)
);
alter table colony_private.password_recovery_attempts enable row level security;
revoke all on colony_private.password_recovery_attempts from public,anon,authenticated;
create or replace function public.consume_password_recovery_attempt(p_colony_id uuid,p_identifier_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Server only';end if;
 if p_identifier_hash is null or p_identifier_hash !~ '^[a-f0-9]{64}$' then return false;end if;
 delete from colony_private.password_recovery_attempts where window_start<now()-interval '1 day';
 insert into colony_private.password_recovery_attempts values(p_colony_id,'*',now(),1)
 on conflict(colony_id,bucket) do update set attempts=case when password_recovery_attempts.window_start<now()-interval '1 hour' then 1 else password_recovery_attempts.attempts+1 end,
 window_start=case when password_recovery_attempts.window_start<now()-interval '1 hour' then now() else password_recovery_attempts.window_start end returning attempts into n;
 if n>30 then return false;end if;
 insert into colony_private.password_recovery_attempts values(p_colony_id,p_identifier_hash,now(),1)
 on conflict(colony_id,bucket) do update set attempts=case when password_recovery_attempts.window_start<now()-interval '1 hour' then 1 else password_recovery_attempts.attempts+1 end,
 window_start=case when password_recovery_attempts.window_start<now()-interval '1 hour' then now() else password_recovery_attempts.window_start end returning attempts into n;
 return n<=3;
end $$;
create or replace function public.resolve_colony_password_recovery(p_colony_id uuid,p_identifier text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare identifier text:=lower(btrim(p_identifier));result jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='Server only';end if;
 if identifier is null or length(identifier)>254 or (identifier !~ '^[a-z][a-z0-9_.-]{2,31}$' and identifier !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then return null;end if;
 select jsonb_build_object('user_id',u.id,'email',u.email) into result
 from auth.users u join public.memberships m on m.user_id=u.id and m.colony_id=p_colony_id and m.active
 where u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'' and coalesce(u.is_anonymous,false)=false
 and ((position('@' in identifier)>0 and lower(u.email)=identifier) or (position('@' in identifier)=0 and exists(
  select 1 from public.lab_members l where l.colony_id=p_colony_id and l.username=identifier and l.status='current' and not l.archived and l.linked_user_id=u.id and lower(l.email)=lower(u.email))))
 limit 1;
 return result;
end $$;
revoke all on function public.consume_password_recovery_attempt(uuid,text),public.resolve_colony_password_recovery(uuid,text) from public,anon,authenticated;
grant execute on function public.consume_password_recovery_attempt(uuid,text),public.resolve_colony_password_recovery(uuid,text) to service_role;
commit;
