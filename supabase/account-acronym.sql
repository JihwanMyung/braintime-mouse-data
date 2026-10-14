-- Apply after lab-members.sql. This narrow self-service change affects only the
-- caller's current roster acronym. Historical scientific logs are never rewritten.
begin;
create or replace function public.update_my_lab_acronym(p_colony_id uuid,p_acronym text,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); requested text:=upper(btrim(p_acronym)); profile jsonb; person public.lab_members%rowtype;
begin
  if actor is null then raise exception using errcode='42501',message='Sign in before changing your acronym';end if;
  if requested is null or requested !~ '^[A-Z][A-Z0-9_-]{0,11}$' then raise exception using errcode='22023',message='Use 1–12 letters, numbers, underscores or hyphens, beginning with a letter';end if;
  if p_expected_version is null or p_expected_version<1 then raise exception using errcode='22023',message='The current profile version is required';end if;
  -- Owner roster edits and membership changes use this same colony lock.
  perform 1 from public.colonies where id=p_colony_id for update;
  profile:=public.get_my_lab_member(p_colony_id);
  if profile->'eligible' is distinct from 'true'::jsonb or profile#>>'{member,person_id}' is null then
    raise exception using errcode='42501',message='A verified current lab-member profile with enabled access is required';
  end if;
  select * into person from public.lab_members where colony_id=p_colony_id and person_id=(profile#>>'{member,person_id}')::uuid for update;
  if not found or person.version<>p_expected_version then raise exception using errcode='40001',message='Your profile changed. Reload it before saving your acronym';end if;
  if person.acronym is not distinct from requested then return profile;end if;
  if exists(select 1 from public.lab_members where colony_id=p_colony_id and person_id<>person.person_id and status='current' and not archived and acronym=requested) then
    raise exception using errcode='23505',message='This acronym is already assigned to a current lab member';
  end if;
  update public.lab_members set acronym=requested,version=version+1,updated_at=clock_timestamp(),updated_by=actor where person_id=person.person_id;
  -- Existing trigger writes the genuine actor and before/after values solely to
  -- the private roster audit. Auth accounts and memberships are untouched.
  return public.get_my_lab_member(p_colony_id);
end $$;
revoke all on function public.update_my_lab_acronym(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.update_my_lab_acronym(uuid,text,integer) to authenticated;
commit;
