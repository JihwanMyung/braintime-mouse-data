-- Apply after lab-members.sql and account-acronym.sql. No personal data or Auth
-- credentials. New requests enter private Review; existing owner-granted active
-- memberships count as approval without changing their assigned access.
begin;
create table if not exists colony_private.account_profile_registration (
  colony_id uuid primary key references public.colonies(id),
  enabled boolean not null default false
);
alter table colony_private.account_profile_registration enable row level security;
revoke all on colony_private.account_profile_registration from public,anon,authenticated,service_role;
-- Explicitly enable the configured Braintime colony only. A later administrator
-- disable survives reruns. Other colonies remain closed to unsolicited requests.
insert into colony_private.account_profile_registration(colony_id,enabled)
select id,true from public.colonies where id='57a26815-ca94-413b-891a-e0e85ff59d69'::uuid
on conflict(colony_id) do nothing;

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
  -- Contact-only approval resolves an earlier self-registration permanently.
  -- Use its immutable owner audit, not editable contact/profile fields. This
  -- email cannot recreate a pending account when the reviewed row is archived,
  -- or when the associated member later becomes historical.
  if exists(select 1 from public.lab_member_audit approved
    where approved.colony_id=p_colony_id and approved.operation='UPDATE'
    and approved.actor_id is not null and approved.actor_id<>actor
    and approved.actor_id::text=approved.after_record#>>'{provenance,email_approval,approved_by}'
    and approved.after_record#>>'{provenance,email_approval,approval_kind}'='secondary_contact'
    and approved.after_record#>>'{provenance,email_approval,registered_user_id}'=actor::text
    and approved.after_record#>>'{provenance,email_approval,merged_into_person_id}' is not null
    and approved.before_record->>'created_by'=actor::text
    and approved.before_record->>'status'='review' and approved.before_record->'archived'='false'::jsonb
    and approved.before_record#>>'{provenance,registration_method}'='verified_self_request'
    and approved.before_record->>'email'=approved.after_record#>>'{provenance,email_approval,approved_email}'
    and approved.after_record->'archived'='true'::jsonb and approved.after_record->'email'='null'::jsonb
    and exists(select 1 from public.lab_member_audit original
      where original.colony_id=p_colony_id and original.person_id=approved.person_id and original.operation='INSERT'
      and original.actor_id=actor and original.after_record->>'email'=approved.before_record->>'email'
      and original.after_record#>>'{provenance,registration_method}'='verified_self_request')) then
    return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'registration_allowed',false,'reason','secondary_contact_only');
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

create or replace function public.submit_my_lab_profile(p_colony_id uuid,p_profile jsonb,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); profile jsonb; person public.lab_members%rowtype; member public.memberships%rowtype; requested_name text; requested_phone text; requested_acronym text; requested_category text; k text; merged jsonb; membership_approved boolean;
begin
  if actor is null then raise exception using errcode='42501',message='Sign in before submitting your profile';end if;
  if jsonb_typeof(p_profile) is distinct from 'object' or octet_length(p_profile::text)>4096 or p_expected_version is null or p_expected_version<0 then
    raise exception using errcode='22023',message='Supply your profile fields and current version';
  end if;
  for k in select jsonb_object_keys(p_profile) loop
    if k<>all(array['name','phone','acronym','category']) or jsonb_typeof(p_profile->k) not in ('string','null') then
      raise exception using errcode='22023',message='Only name, phone, acronym and category can be submitted';
    end if;
  end loop;
  -- Shared with owner roster edits and setup; an approval/revocation cannot be
  -- overwritten by a profile update that saw an older roster version.
  perform 1 from public.colonies where id=p_colony_id for update;
  if not found then raise exception using errcode='42501',message='Profile registration is unavailable';end if;
  profile:=public.get_my_lab_member(p_colony_id);
  if profile->'registration_allowed' is distinct from 'true'::jsonb then raise exception using errcode='42501',message='Profile registration is unavailable for this account';end if;
  if (profile#>>'{member,version}')::integer<>p_expected_version then raise exception using errcode='40001',message='Your profile changed. Reload before saving';end if;
  if p_expected_version>0 then
    select * into person from public.lab_members where colony_id=p_colony_id and person_id=(profile#>>'{member,person_id}')::uuid for update;
    if not found or person.version<>p_expected_version then raise exception using errcode='40001',message='Your profile changed. Reload before saving';end if;
  end if;
  select * into member from public.memberships where colony_id=p_colony_id and user_id=actor;
  membership_approved:=member.user_id is not null and member.active and profile->'eligible'='true'::jsonb;
  merged:=(profile->'member')||p_profile;
  requested_name:=btrim(merged->>'name');requested_phone:=nullif(btrim(merged->>'phone'),'');requested_acronym:=upper(nullif(btrim(merged->>'acronym'),''));requested_category:=merged->>'category';
  if requested_name is null or length(requested_name) not between 1 and 200 or requested_name ~ '[[:cntrl:]]' or
     length(requested_phone)>80 or requested_phone ~ '[[:cntrl:]]' or
     (p_profile?'acronym' and requested_acronym is not null and requested_acronym !~ '^[A-Z][A-Z0-9_-]{0,11}$') or
     requested_category is null or requested_category<>all(array['undergraduate','masters','phd','postdoc','visiting_student','visiting_faculty','principal_investigator','other','unknown']) then
    raise exception using errcode='22023',message='Enter a name, optional phone/acronym and valid category within their field limits';
  end if;
  if person.person_id is null then
    insert into public.lab_members(colony_id,name,email,phone,acronym,category,status,intended_role,export_level,provenance,archived,created_by,updated_by)
    values(p_colony_id,requested_name,profile#>>'{member,email}',requested_phone,requested_acronym,requested_category,
      case when membership_approved then 'current' else 'review' end,
      case when membership_approved and member.role<>'owner' then member.role else 'editor' end,
      case when membership_approved and member.role='owner' then 'max' when membership_approved then member.export_level else 'low' end,
      jsonb_build_object('registration_method',case when membership_approved then 'owner_approved_membership' else 'verified_self_request' end),false,actor,actor);
  elsif membership_approved and person.status='review' or (person.name,person.phone,person.acronym,person.category) is distinct from (requested_name,requested_phone,requested_acronym,requested_category) then
    update public.lab_members set name=requested_name,phone=requested_phone,acronym=requested_acronym,category=requested_category,
      status=case when membership_approved and person.status='review' then 'current' else person.status end,
      intended_role=case when membership_approved and person.status='review' and member.role<>'owner' then member.role else person.intended_role end,
      export_level=case when membership_approved and person.status='review' and member.role='owner' then 'max' when membership_approved and person.status='review' then member.export_level else person.export_level end,
      version=version+1,updated_at=clock_timestamp(),updated_by=actor where person_id=person.person_id;
  end if;
  -- Existing private audit captures the actor. Profile approval/assigned levels
  -- can only come from an existing active membership, never submitted fields.
  -- No Auth credentials, membership permissions, username, email or link changes.
  return public.get_my_lab_member(p_colony_id);
end $$;
revoke all on function public.submit_my_lab_profile(uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.submit_my_lab_profile(uuid,jsonb,integer) to authenticated;

-- Use the same approval and disabled-account checks as profile submission.
-- Existing assigned membership and custom manager permissions are preserved.
create or replace function public.complete_lab_member_setup(p_colony_id uuid,p_username text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); account_email text; verified boolean; has_password boolean; requested text:=lower(btrim(p_username)); person public.lab_members%rowtype; old_member public.memberships%rowtype; saved_member public.memberships%rowtype;
begin
  if actor is null then raise exception using errcode='42501',message='Sign in before completing account setup';end if;
  if requested is null or requested !~ '^[a-z][a-z0-9_.-]{2,31}$' then raise exception using errcode='22023',message='Username must start with a letter and contain 3–32 letters, digits, dots, underscores, or hyphens';end if;
  perform 1 from public.colonies where id=p_colony_id for update;
  if public.get_my_lab_member(p_colony_id)->'eligible' is distinct from 'true'::jsonb then raise exception using errcode='42501',message='Owner-approved current registration with enabled access is required';end if;
  select lower(u.email),u.email_confirmed_at is not null,coalesce(length(u.encrypted_password),0)>0 into account_email,verified,has_password from auth.users u where u.id=actor;
  if not coalesce(verified,false) or not coalesce(has_password,false) then raise exception using errcode='42501',message='Verify your account email and set an account password first';end if;
  select * into person from public.lab_members where colony_id=p_colony_id and email=account_email and status in ('current','review') and not archived for update;
  if not found or (person.linked_user_id is not null and person.linked_user_id<>actor) then raise exception using errcode='42501',message='A current preregistered lab-member record is required';end if;
  select * into old_member from public.memberships where colony_id=p_colony_id and user_id=actor for update;
  if old_member.user_id is not null and not old_member.active then raise exception using errcode='42501',message='Account access is disabled; contact the database owner';end if;
  if person.linked_user_id=actor then
    if old_member.user_id is null then raise exception using errcode='42501',message='Account access is unavailable; contact the database owner';end if;
    if person.username<>requested then raise exception using errcode='22023',message='Setup is complete; your registered username cannot be changed here';end if;
    return public.get_my_lab_member(p_colony_id);
  end if;
  if exists(select 1 from public.lab_members where colony_id=p_colony_id and username=requested and person_id<>person.person_id) then raise exception using errcode='23505',message='This username is already registered';end if;
  update public.lab_members set username=requested,linked_user_id=actor,status='current',
    intended_role=case when old_member.user_id is not null and old_member.role<>'owner' then old_member.role else person.intended_role end,
    export_level=case when old_member.role='owner' then 'max' when old_member.user_id is not null then old_member.export_level else person.export_level end,
    version=version+1,updated_at=clock_timestamp(),updated_by=actor where person_id=person.person_id;
  if old_member.user_id is null then
    insert into public.memberships(colony_id,user_id,role,active,export_level,updated_by) values(p_colony_id,actor,person.intended_role,true,person.export_level,actor) returning * into saved_member;
    insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record) values(p_colony_id,'membership',actor::text,case when old_member.user_id is null then 'INSERT' else 'UPDATE' end,actor,case when old_member.user_id is null then null else to_jsonb(old_member) end,to_jsonb(saved_member));
  end if;
  return public.get_my_lab_member(p_colony_id);
end $$;
revoke all on function public.complete_lab_member_setup(uuid,text) from public,anon,authenticated;
grant execute on function public.complete_lab_member_setup(uuid,text) to authenticated;
commit;
