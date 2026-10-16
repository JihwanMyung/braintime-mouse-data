-- Apply after member-email-approval.sql. No personal data or membership changes.
begin;
do $$
begin
  if to_regprocedure('public.save_lab_member(uuid,jsonb)') is null then
    raise exception 'Apply lab-members.sql and member-email-approval.sql before cage-managers.sql';
  end if;
  if position('Email approval history is managed by the email approval action' in pg_get_functiondef('public.save_lab_member(uuid,jsonb)'::regprocedure))=0
    or position('approved.actor_id::text' in pg_get_functiondef('public.save_lab_member(uuid,jsonb)'::regprocedure))=0 then
    raise exception 'The guarded member email-approval version is required before this upgrade';
  end if;
end $$;
alter table public.lab_members add column if not exists cage_manager_eligible boolean not null default false;

create or replace function public.list_cage_managers(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null or colony_private.current_role(p_colony_id) is null
    or not exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null
      and not coalesce((to_jsonb(u)->>'is_anonymous')::boolean,false)
      and not coalesce((to_jsonb(u)->>'banned_until')::timestamptz>clock_timestamp(),false)
      and to_jsonb(u)->>'deleted_at' is null) then
    raise exception using errcode='42501',message='Active colony membership is required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'person_id',person_id,'name',name,'acronym',acronym,'status',status,
    'nickname',case when jsonb_typeof(provenance->'nickname')='string' then nullif(btrim(provenance->>'nickname'),'') else null end
  ) order by status='historical',lower(name),person_id),'[]'::jsonb) into result
  from public.lab_members where colony_id=p_colony_id and not archived
    and (status='current' or (status='historical' and cage_manager_eligible))
    and not (coalesce(provenance->>'service_account','false')='true'
      or coalesce(provenance->>'is_service_account','false')='true'
      or coalesce(provenance->>'is_bot','false')='true'
      or lower(coalesce(provenance->>'account_type','')) in ('service','service_account','bot')
      or (lower(btrim(name)) in ('braintime bot','brainbot bot') and upper(coalesce(acronym,''))='BB'));
  return jsonb_build_object('managers',result);
end $$;
revoke all on function public.list_cage_managers(uuid) from public,anon,authenticated;
grant execute on function public.list_cage_managers(uuid) to authenticated;

-- Preserve all owner access and email-approval guards.
create or replace function public.save_lab_member(p_colony_id uuid,p_person jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); previous public.lab_members%rowtype; saved public.lab_members%rowtype; previous_member public.memberships%rowtype; saved_member public.memberships%rowtype; target uuid; expected integer; merged jsonb; k text; is_new boolean;
begin
  perform 1 from public.colonies where id=p_colony_id for update;
  if actor is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then raise exception using errcode='42501',message='Only an active colony owner can edit the private roster';end if;
  if jsonb_typeof(p_person) is distinct from 'object' then raise exception using errcode='22023',message='Person must be a JSON object';end if;
  for k in select jsonb_object_keys(p_person) loop
    if k<>all(array['person_id','version','name','email','phone','acronym','category','status','intended_role','export_level','provenance','notes','archived','cage_manager_eligible']) then raise exception using errcode='22023',message='Unsupported or server-owned roster field: '||k;end if;
  end loop;
  if jsonb_typeof(p_person->'version') is distinct from 'number' or p_person->>'version' !~ '^[0-9]{1,9}$' then raise exception using errcode='22023',message='Supply the current record version (0 for a new person)';end if;
  expected:=(p_person->>'version')::integer;
  begin target:=(p_person->>'person_id')::uuid;exception when invalid_text_representation then raise exception using errcode='22023',message='Person ID must be a UUID';end;
  is_new:=target is null;
  if is_new then
    if expected<>0 then raise exception using errcode='40001',message='New person must use version 0';end if;
    merged:=jsonb_build_object('name','','email',null,'phone',null,'acronym',null,'category','unknown','status','review','intended_role','editor','export_level','low','provenance','{}'::jsonb,'notes',null,'archived',false,'cage_manager_eligible',false)||p_person;
  else
    select * into previous from public.lab_members where colony_id=p_colony_id and person_id=target for update;
    if not found or previous.version<>expected then raise exception using errcode='40001',message='Roster record changed; reload before saving';end if;
    merged:=to_jsonb(previous)||p_person;
  end if;
  foreach k in array array['name','email','phone','acronym','category','status','intended_role','export_level','notes'] loop
    if merged->k is not null and jsonb_typeof(merged->k) not in ('string','null') then raise exception using errcode='22023',message='Roster text fields must be strings or null';end if;
  end loop;
  if jsonb_typeof(merged->'archived') is distinct from 'boolean' or jsonb_typeof(merged->'provenance') is distinct from 'object' then raise exception using errcode='22023',message='Archived must be boolean and provenance must be an object';end if;
  if jsonb_typeof(merged->'cage_manager_eligible') is distinct from 'boolean' then raise exception using errcode='22023',message='Cage manager eligibility must be a boolean';end if;
  -- Only approve_lab_member_email writes this binding. Ordinary owner editing
  -- must not manufacture a matching immutable audit for a different account.
  if (is_new and merged->'provenance' ? 'email_approval') or
    (not is_new and merged->'provenance'->'email_approval' is distinct from previous.provenance->'email_approval') then
    raise exception using errcode='22023',message='Email approval history is managed by the email approval action';
  end if;
  if previous.linked_user_id is not null then select * into previous_member from public.memberships where colony_id=p_colony_id and user_id=previous.linked_user_id for update;end if;
  if not is_new and previous.linked_user_id is null then
    -- An approved account may already have access before choosing its username.
    -- Keep it attached for revocation, including after an Auth email change.
    -- The fallback uses an immutable owner approval, never editable provenance.
    select m.* into previous_member from public.memberships m where m.colony_id=p_colony_id and (
      (m.role='owner' and exists(select 1 from auth.users u where u.id=m.user_id and u.email_confirmed_at is not null and lower(btrim(u.email))=previous.email))
      or exists(select 1 from public.lab_member_audit approved
        where approved.colony_id=p_colony_id and approved.person_id=previous.person_id and approved.operation='UPDATE'
        and approved.actor_id::text=approved.after_record#>>'{provenance,email_approval,approved_by}'
        and approved.after_record#>>'{provenance,email_approval,registered_user_id}'=m.user_id::text
        and approved.before_record#>>'{provenance,email_approval,registered_user_id}' is distinct from approved.after_record#>>'{provenance,email_approval,registered_user_id}'
        and approved.after_record->>'email'=previous.email and approved.after_record#>>'{provenance,email_approval,approved_email}'=previous.email)
    ) order by m.user_id limit 1 for update of m;
  end if;
  if (previous.linked_user_id is not null or previous_member.user_id is not null) and lower(nullif(btrim(merged->>'email'),'')) is distinct from previous.email then raise exception using errcode='22023',message='An approved account email cannot be reassigned through the roster';end if;
  if previous_member.role='owner' and ((merged->>'archived')::boolean or merged->>'status' is distinct from 'current') then raise exception using errcode='42501',message='The owner roster record must remain current and active';end if;
  begin
    if is_new then
      insert into public.lab_members(colony_id,name,email,phone,acronym,category,status,intended_role,export_level,provenance,notes,archived,cage_manager_eligible,created_by,updated_by)
      values(p_colony_id,btrim(merged->>'name'),lower(nullif(btrim(merged->>'email'),'')),nullif(btrim(merged->>'phone'),''),upper(nullif(btrim(merged->>'acronym'),'')),merged->>'category',merged->>'status',merged->>'intended_role',merged->>'export_level',merged->'provenance',nullif(btrim(merged->>'notes'),''),(merged->>'archived')::boolean,(merged->>'cage_manager_eligible')::boolean,actor,actor) returning * into saved;
    else
      update public.lab_members set name=btrim(merged->>'name'),email=lower(nullif(btrim(merged->>'email'),'')),phone=nullif(btrim(merged->>'phone'),''),acronym=upper(nullif(btrim(merged->>'acronym'),'')),category=merged->>'category',status=merged->>'status',intended_role=merged->>'intended_role',export_level=merged->>'export_level',provenance=merged->'provenance',notes=nullif(btrim(merged->>'notes'),''),archived=(merged->>'archived')::boolean,cage_manager_eligible=(merged->>'cage_manager_eligible')::boolean,version=version+1,updated_at=clock_timestamp(),updated_by=actor where person_id=target returning * into saved;
    end if;
  exception when check_violation or not_null_violation or string_data_right_truncation then raise exception using errcode='22023',message='Invalid roster value, category, status, access level, or field length';end;
  if previous_member.user_id is not null and previous_member.role<>'owner' then
    -- Restoring roster status alone never undoes an explicit account deactivation.
    update public.memberships set role=saved.intended_role,export_level=saved.export_level,active=previous_member.active and saved.status='current' and not saved.archived,updated_at=clock_timestamp(),updated_by=actor where colony_id=p_colony_id and user_id=previous_member.user_id and (role,export_level,active) is distinct from (saved.intended_role,saved.export_level,previous_member.active and saved.status='current' and not saved.archived) returning * into saved_member;
    if found then insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record) values(p_colony_id,'membership',previous_member.user_id::text,'UPDATE',actor,to_jsonb(previous_member),to_jsonb(saved_member));end if;
  end if;
  return jsonb_build_object('member',colony_private.lab_member_payload(saved));
end $$;
revoke all on function public.save_lab_member(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_lab_member(uuid,jsonb) to authenticated;
commit;
