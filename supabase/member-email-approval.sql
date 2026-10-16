-- Apply after lab-members.sql, manager-permissions.sql and account-profile.sql.
-- Owner-selected reconciliation only. No account credentials or email are sent.
begin;
alter table public.lab_members add column if not exists secondary_emails text[] not null default '{}'::text[];
alter table public.lab_members add column if not exists cage_manager_eligible boolean not null default false;

create or replace function public.approve_lab_member_email(
  p_colony_id uuid,p_request_person_id uuid,p_request_version integer,
  p_target_person_id uuid,p_target_version integer
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid(); request_person public.lab_members%rowtype; target_person public.lab_members%rowtype;
  saved_target public.lab_members%rowtype; saved_request public.lab_members%rowtype;
  owner_account auth.users%rowtype; request_account auth.users%rowtype; original_account auth.users%rowtype;
  original_member public.memberships%rowtype; saved_member public.memberships%rowtype;
  matches integer; flags jsonb; previous_email text; contacts text[]; approval jsonb;
begin
  if actor is null then raise exception using errcode='42501',message='Only an active colony owner can approve a registration email';end if;
  perform 1 from public.colonies where id=p_colony_id for update;
  if not found or colony_private.current_role(p_colony_id) is distinct from 'owner' then
    raise exception using errcode='42501',message='Only an active colony owner can approve a registration email';
  end if;
  if p_request_person_id is null or p_target_person_id is null or p_request_person_id=p_target_person_id
    or p_request_version is null or p_request_version<1 or p_target_version is null or p_target_version<1 then
    raise exception using errcode='22023',message='Select a registration request and a different current member with their versions';
  end if;
  perform 1 from public.lab_members where colony_id=p_colony_id and person_id in (p_request_person_id,p_target_person_id) order by person_id for update;
  select * into request_person from public.lab_members where colony_id=p_colony_id and person_id=p_request_person_id;
  select * into target_person from public.lab_members where colony_id=p_colony_id and person_id=p_target_person_id;
  if request_person.person_id is null or target_person.person_id is null or request_person.version<>p_request_version or target_person.version<>p_target_version then
    raise exception using errcode='40001',message='A member record changed. Reload before approving the email';
  end if;
  if request_person.status<>'review' or request_person.archived or request_person.linked_user_id is not null or request_person.username is not null
    or request_person.email is null or request_person.provenance->>'registration_method' is distinct from 'verified_self_request'
    or target_person.status<>'current' or target_person.archived or target_person.linked_user_id is not null or target_person.username is not null
    or target_person.email is null or target_person.email=request_person.email then
    raise exception using errcode='42501',message='Use an unclaimed self-registration request and an unclaimed current member';
  end if;
  -- Lock exact Auth identities in one order. Confirmation, email, ban and deletion
  -- changes cannot race the approval. FOR UPDATE also blocks foreign-key inserts
  -- that would add concurrent memberships elsewhere. No Auth row is changed.
  perform 1 from auth.users where id in (actor,request_person.created_by) or lower(btrim(email)) in (request_person.email,target_person.email) order by id for update;
  select * into owner_account from auth.users where id=actor;
  if owner_account.id is null or owner_account.email_confirmed_at is null
    or coalesce((to_jsonb(owner_account)->>'is_anonymous')::boolean,false)
    or coalesce((to_jsonb(owner_account)->>'banned_until')::timestamptz>clock_timestamp(),false)
    or to_jsonb(owner_account)->>'deleted_at' is not null then
    raise exception using errcode='42501',message='An enabled, verified owner account is required';
  end if;
  select count(*) into matches from auth.users where lower(btrim(email))=request_person.email;
  select * into request_account from auth.users where id=request_person.created_by;
  if matches<>1 or request_account.id is null or request_account.id=actor or lower(btrim(request_account.email)) is distinct from request_person.email
    or request_account.email_confirmed_at is null or nullif(btrim(to_jsonb(request_account)->>'email_change'),'') is not null
    or coalesce((to_jsonb(request_account)->>'is_anonymous')::boolean,false)
    or coalesce((to_jsonb(request_account)->>'banned_until')::timestamptz>clock_timestamp(),false)
    or to_jsonb(request_account)->>'deleted_at' is not null then
    raise exception using errcode='42501',message='The registration must belong to its verified, enabled email account';
  end if;
  if not exists(select 1 from public.lab_member_audit where colony_id=p_colony_id and person_id=request_person.person_id and operation='INSERT'
    and actor_id=request_account.id and after_record->>'email'=request_person.email and after_record->'provenance'->>'registration_method'='verified_self_request') then
    raise exception using errcode='42501',message='The original self-registration could not be verified';
  end if;
  if exists(select 1 from public.memberships where user_id=request_account.id)
    or exists(select 1 from public.lab_members where linked_user_id=request_account.id
      or (colony_id=p_colony_id and email=request_person.email and person_id<>request_person.person_id)) then
    raise exception using errcode='42501',message='The registered account already has access or a conflicting member record';
  end if;
  select count(*) into matches from auth.users where lower(btrim(email))=target_person.email;
  if matches>1 then raise exception using errcode='42501',message='The original email has conflicting accounts';end if;
  select * into original_account from auth.users where lower(btrim(email))=target_person.email;
  if original_account.id is not null then
    if original_account.id in (actor,request_account.id) or original_account.email_confirmed_at is not null
      or to_jsonb(original_account)->>'invited_at' is null or nullif(btrim(to_jsonb(original_account)->>'email_change'),'') is not null
      or coalesce((to_jsonb(original_account)->>'is_anonymous')::boolean,false)
      or coalesce((to_jsonb(original_account)->>'banned_until')::timestamptz>clock_timestamp(),false)
      or to_jsonb(original_account)->>'deleted_at' is not null
      or exists(select 1 from public.lab_members where linked_user_id=original_account.id) then
      raise exception using errcode='42501',message='The original email is already registered, disabled or not an unclaimed invitation';
    end if;
    if exists(select 1 from public.memberships where user_id=original_account.id and (colony_id<>p_colony_id or role='owner' or not active)) then
      raise exception using errcode='42501',message='The original invitation has protected, disabled or conflicting access';
    end if;
    select * into original_member from public.memberships where colony_id=p_colony_id and user_id=original_account.id for update;
    if original_member.user_id is not null and (original_member.role<>target_person.intended_role or original_member.export_level<>target_person.export_level) then
      raise exception using errcode='40001',message='The original invitation access differs from the member record. Review its access before approval';
    end if;
  end if;
  previous_email:=target_person.email;
  select coalesce(array_agg(contact order by contact),'{}'::text[]) into contacts from (
    select distinct lower(btrim(value)) contact from unnest(target_person.secondary_emails||array[previous_email]) value
    where nullif(btrim(value),'') is not null and lower(btrim(value))<>request_person.email
  ) entries;
  flags:=coalesce(original_member.permissions,colony_private.default_manager_permissions());
  approval:=jsonb_build_object('request_person_id',request_person.person_id,'registered_user_id',request_account.id,
    'previous_email',previous_email,'approved_email',request_person.email,'approved_by',actor,'approved_at',clock_timestamp());
  -- Preserve the reviewed request and its audit. Free only its unique primary
  -- email; its identity and submitted details remain in the archived row.
  update public.lab_members set email=null,archived=true,provenance=provenance||jsonb_build_object('email_approval',approval||jsonb_build_object('merged_into_person_id',target_person.person_id)),
    version=version+1,updated_at=clock_timestamp(),updated_by=actor where person_id=request_person.person_id returning * into saved_request;
  update public.lab_members set email=request_person.email,secondary_emails=contacts,
    provenance=provenance||jsonb_build_object('email_approval',approval),version=version+1,updated_at=clock_timestamp(),updated_by=actor
    where person_id=target_person.person_id returning * into saved_target;
  if original_member.user_id is not null then
    update public.memberships set active=false,updated_at=clock_timestamp(),updated_by=actor where colony_id=p_colony_id and user_id=original_member.user_id returning * into saved_member;
    insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record)
      values(p_colony_id,'membership',original_member.user_id::text,'UPDATE',actor,to_jsonb(original_member),to_jsonb(saved_member));
  end if;
  insert into public.memberships(colony_id,user_id,role,active,export_level,permissions,updated_by)
    values(p_colony_id,request_account.id,target_person.intended_role,true,target_person.export_level,flags,actor) returning * into saved_member;
  insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record)
    values(p_colony_id,'membership',request_account.id::text,'INSERT',actor,null,to_jsonb(saved_member));
  return jsonb_build_object('member',colony_private.lab_member_payload(saved_target),
    'merged_request',jsonb_build_object('person_id',saved_request.person_id,'version',saved_request.version,'archived',saved_request.archived),'setup_required',true);
end $$;
revoke all on function public.approve_lab_member_email(uuid,uuid,integer,uuid,integer) from public,anon,authenticated;
grant execute on function public.approve_lab_member_email(uuid,uuid,integer,uuid,integer) to authenticated;

-- Keep pending approved accounts subject to normal owner revocation.
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

-- Reject an Auth email mismatch before a duplicate self profile can be created.
create or replace function public.get_my_lab_member(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); account_email text; verified boolean; has_password boolean; blocked boolean; person public.lab_members%rowtype; member public.memberships%rowtype; self_record jsonb; matches integer; registration_open boolean; allowed boolean; membership_approved boolean;
begin
  if actor is null then raise exception using errcode='42501',message='Sign in before completing account setup';end if;
  select lower(btrim(u.email)),u.email_confirmed_at is not null,coalesce(length(u.encrypted_password),0)>0,
    coalesce((to_jsonb(u)->>'is_anonymous')::boolean,false) or coalesce((to_jsonb(u)->>'banned_until')::timestamptz>clock_timestamp(),false) or to_jsonb(u)->>'deleted_at' is not null
    into account_email,verified,has_password,blocked from auth.users u where u.id=actor;
  if not coalesce(verified,false) or account_email is null or account_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','email_unverified');
  end if;
  if blocked then return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','access_disabled');end if;
  select * into member from public.memberships where colony_id=p_colony_id and user_id=actor;
  if member.user_id is not null and not member.active then
    return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','access_disabled');
  end if;
  -- Pending approved identity is stable before a username is chosen. An Auth
  -- email change must not turn it into a second Current profile.
  if exists(select 1 from public.lab_members pending
    where pending.colony_id=p_colony_id and pending.linked_user_id is null and pending.email is distinct from account_email
    and exists(select 1 from public.lab_member_audit approved
      where approved.colony_id=p_colony_id and approved.person_id=pending.person_id and approved.operation='UPDATE'
      and approved.actor_id::text=approved.after_record#>>'{provenance,email_approval,approved_by}'
      and approved.after_record#>>'{provenance,email_approval,registered_user_id}'=actor::text
      and approved.before_record#>>'{provenance,email_approval,registered_user_id}' is distinct from approved.after_record#>>'{provenance,email_approval,registered_user_id}'
      and approved.after_record->>'email'=pending.email and approved.after_record#>>'{provenance,email_approval,approved_email}'=pending.email)) then
    return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','account_conflict');
  end if;
  membership_approved:=member.user_id is not null and member.active;
  select count(*) into matches from public.lab_members where colony_id=p_colony_id and (email=account_email or linked_user_id=actor);
  if matches>1 then return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','account_conflict');end if;
  select * into person from public.lab_members where colony_id=p_colony_id and (email=account_email or linked_user_id=actor);
  select coalesce((select enabled from colony_private.account_profile_registration where colony_id=p_colony_id),false) into registration_open;
  if person.person_id is null then
    if not membership_approved and not registration_open then return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','not_registered');end if;
    self_record:=jsonb_build_object('person_id',null,'version',0,'name','','email',account_email,'phone',null,'acronym',null,'category','unknown','status',case when membership_approved then 'current' else 'review' end,'username',null,'effective_role',case when membership_approved then member.role else null end,'effective_export_level',case when not membership_approved then null when member.role='owner' then 'max' else member.export_level end);
    return jsonb_build_object('member',self_record,'eligible',membership_approved,'setup_required',membership_approved,'registration_allowed',true,'has_password',has_password,'reason','profile_required');
  end if;
  if person.email is distinct from account_email or person.linked_user_id is not null and person.linked_user_id<>actor then
    return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','account_conflict');
  end if;
  if person.archived or person.status='historical' or person.linked_user_id is not null and (member.user_id is null or person.status<>'current') then
    return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','access_disabled');
  end if;
  -- A self-request made before an owner added an active membership does not need
  -- a second approval. An owner-created or owner-reaffirmed Review remains a gate.
  -- Use immutable audit history: a later self-profile edit can reset updated_by.
  allowed:=person.status='current' or coalesce(
    membership_approved and person.status='review' and person.linked_user_id is null
    and person.created_by=actor and person.provenance->>'registration_method'='verified_self_request'
    and not exists(select 1 from public.lab_member_audit review_decision
      where review_decision.colony_id=p_colony_id and review_decision.person_id=person.person_id
      and review_decision.operation='UPDATE' and review_decision.actor_id is distinct from actor
      and review_decision.after_record->>'status'='review'),false);
  if not allowed and not registration_open then return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','not_registered');end if;
  self_record:=jsonb_build_object('person_id',person.person_id,'name',person.name,'email',person.email,'phone',person.phone,'acronym',person.acronym,'category',person.category,'status',person.status,'username',person.username,'version',person.version,
    'effective_role',case when allowed then coalesce(member.role,person.intended_role) else null end,
    'effective_export_level',case when not allowed then null when member.role='owner' then 'max' else coalesce(member.export_level,person.export_level) end);
  return jsonb_build_object('member',self_record,'eligible',allowed,'setup_required',allowed and person.linked_user_id is null,'registration_allowed',true,'has_password',has_password,
    'reason',case when not allowed then 'approval_pending' when not has_password then 'password_required' when person.linked_user_id is null then 'username_required' else 'ready' end);
end $$;
revoke all on function public.get_my_lab_member(uuid) from public,anon,authenticated;
grant execute on function public.get_my_lab_member(uuid) to authenticated;
commit;
