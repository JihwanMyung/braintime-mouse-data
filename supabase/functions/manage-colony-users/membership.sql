-- Apply after schema.sql. This narrower RPC keeps Settings actions atomic and
-- preserves the existing set_member_role audit actor and last-owner protection.
begin;
create or replace function public.manage_colony_member(
  p_colony_id uuid,p_user_id uuid,p_role text,p_active boolean,p_action text
)
returns setof public.memberships language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); target public.memberships%rowtype;
begin
  perform 1 from public.colonies where id=p_colony_id for update;
  if actor is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then
    raise exception using errcode='42501',message='Only an active colony owner can manage members';
  end if;
  if p_role is null or p_role not in ('viewer','editor') or p_active is null or
     p_action is null or p_action not in ('add','update') or p_user_id is null then
    raise exception using errcode='22023',message='Invalid membership request';
  end if;
  select * into target from public.memberships where colony_id=p_colony_id and user_id=p_user_id;
  if p_user_id=actor or target.role='owner' then
    raise exception using errcode='42501',message='Owner accounts are protected';
  end if;
  if p_action='add' and target.user_id is not null then
    raise exception using errcode='23505',message='This account is already a colony member';
  end if;
  if p_action='update' and target.user_id is null then
    raise exception using errcode='P0002',message='This account is not a colony member';
  end if;
  return query select * from public.set_member_role(p_colony_id,p_user_id,p_role,p_active);
end $$;
revoke all on function public.manage_colony_member(uuid,uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.manage_colony_member(uuid,uuid,text,boolean,text) to authenticated;
commit;
