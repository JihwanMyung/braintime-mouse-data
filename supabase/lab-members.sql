-- Apply after schema.sql and export-permissions.sql. Contains no personal data.
-- Roster contacts and their audit history are separate from member-readable records.
begin;
create table if not exists public.lab_members (
  person_id uuid primary key default gen_random_uuid(),
  colony_id uuid not null references public.colonies(id),
  name text not null check(length(btrim(name)) between 1 and 200),
  email text check(email is null or (email=lower(btrim(email)) and length(email)<=320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  phone text check(phone is null or length(phone)<=80),
  acronym text check(acronym is null or acronym ~ '^[A-Z][A-Z0-9_-]{0,19}$'),
  category text not null default 'unknown' check(category in ('undergraduate','masters','phd','postdoc','visiting_student','visiting_faculty','principal_investigator','other','unknown')),
  status text not null default 'review' check(status in ('current','historical','review')),
  intended_role text not null default 'editor' check(intended_role in ('editor','viewer','manager')),
  export_level text not null default 'low' check(export_level in ('low','high','max')),
  provenance jsonb not null default '{}'::jsonb check(jsonb_typeof(provenance)='object' and octet_length(provenance::text)<=16384),
  notes text check(notes is null or length(notes)<=10000),
  archived boolean not null default false,
  username text check(username is null or username ~ '^[a-z][a-z0-9_.-]{2,31}$'),
  linked_user_id uuid references auth.users(id),
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  check((username is null)=(linked_user_id is null))
);
create unique index if not exists lab_members_email_unique on public.lab_members(colony_id,email) where email is not null;
create unique index if not exists lab_members_username_unique on public.lab_members(colony_id,username) where username is not null;
create unique index if not exists lab_members_account_unique on public.lab_members(colony_id,linked_user_id) where linked_user_id is not null;
create unique index if not exists lab_members_current_acronym_unique on public.lab_members(colony_id,acronym) where acronym is not null and status='current' and not archived;
create table if not exists public.lab_member_audit (
  audit_id bigint generated always as identity primary key,
  colony_id uuid not null references public.colonies(id),
  person_id uuid not null references public.lab_members(person_id),
  operation text not null check(operation in ('INSERT','UPDATE')),
  actor_id uuid references auth.users(id),
  occurred_at timestamptz not null default clock_timestamp(),
  before_record jsonb,
  after_record jsonb not null
);
alter table public.lab_members enable row level security;
alter table public.lab_member_audit enable row level security;
drop policy if exists lab_members_owner_read on public.lab_members;
create policy lab_members_owner_read on public.lab_members for select to authenticated using(colony_private.current_role(colony_id)='owner');
drop policy if exists lab_member_audit_owner_read on public.lab_member_audit;
create policy lab_member_audit_owner_read on public.lab_member_audit for select to authenticated using(colony_private.current_role(colony_id)='owner');
revoke all on public.lab_members,public.lab_member_audit from public,anon,authenticated;
grant select on public.lab_members,public.lab_member_audit to authenticated;
-- The protected username sign-in Edge Function resolves only its requested user.
grant select on public.lab_members to service_role;
create or replace function colony_private.audit_lab_member_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.lab_member_audit(colony_id,person_id,operation,actor_id,before_record,after_record)
  values(new.colony_id,new.person_id,TG_OP,auth.uid(),case when TG_OP='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
  return new;
end $$;
revoke all on function colony_private.audit_lab_member_change() from public,anon,authenticated;
drop trigger if exists lab_members_audit on public.lab_members;
create trigger lab_members_audit after insert or update on public.lab_members for each row execute function colony_private.audit_lab_member_change();
drop trigger if exists lab_members_no_delete on public.lab_members;
create trigger lab_members_no_delete before delete on public.lab_members for each row execute function colony_private.reject_removal();
drop trigger if exists lab_member_audit_immutable on public.lab_member_audit;
create trigger lab_member_audit_immutable before update or delete on public.lab_member_audit for each row execute function colony_private.reject_removal();

create or replace function colony_private.lab_member_payload(p public.lab_members)
returns jsonb language sql stable security definer set search_path='' as $$
  select to_jsonb(p)||jsonb_build_object('effective_role',m.role,'effective_export_level',case when m.role='owner' then 'max' else m.export_level end,'membership_active',m.active)
  from (select 1) one left join lateral (
    select candidate.* from public.memberships candidate
    where candidate.colony_id=p.colony_id and (candidate.user_id=p.linked_user_id or
      (p.linked_user_id is null and candidate.role='owner' and exists(select 1 from auth.users u where u.id=candidate.user_id and u.email_confirmed_at is not null and lower(u.email)=p.email)))
    order by candidate.user_id limit 1
  ) m on true
$$;
revoke all on function colony_private.lab_member_payload(public.lab_members) from public,anon,authenticated;

create or replace function public.list_lab_members(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then raise exception using errcode='42501',message='Only an active colony owner can view the private roster';end if;
  select coalesce(jsonb_agg(colony_private.lab_member_payload(p) order by p.archived,p.status,p.name,p.person_id),'[]') into result from public.lab_members p where p.colony_id=p_colony_id;
  return jsonb_build_object('members',result);
end $$;
revoke all on function public.list_lab_members(uuid) from public,anon,authenticated;
grant execute on function public.list_lab_members(uuid) to authenticated;

create or replace function public.save_lab_member(p_colony_id uuid,p_person jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); previous public.lab_members%rowtype; saved public.lab_members%rowtype; previous_member public.memberships%rowtype; saved_member public.memberships%rowtype; target uuid; expected integer; merged jsonb; k text; is_new boolean;
begin
  perform 1 from public.colonies where id=p_colony_id for update;
  if actor is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then raise exception using errcode='42501',message='Only an active colony owner can edit the private roster';end if;
  if jsonb_typeof(p_person) is distinct from 'object' then raise exception using errcode='22023',message='Person must be a JSON object';end if;
  for k in select jsonb_object_keys(p_person) loop
    if k<>all(array['person_id','version','name','email','phone','acronym','category','status','intended_role','export_level','provenance','notes','archived']) then raise exception using errcode='22023',message='Unsupported or server-owned roster field: '||k;end if;
  end loop;
  if jsonb_typeof(p_person->'version') is distinct from 'number' or p_person->>'version' !~ '^[0-9]{1,9}$' then raise exception using errcode='22023',message='Supply the current record version (0 for a new person)';end if;
  expected:=(p_person->>'version')::integer;
  begin target:=(p_person->>'person_id')::uuid;exception when invalid_text_representation then raise exception using errcode='22023',message='Person ID must be a UUID';end;
  is_new:=target is null;
  if is_new then
    if expected<>0 then raise exception using errcode='40001',message='New person must use version 0';end if;
    merged:=jsonb_build_object('name','','email',null,'phone',null,'acronym',null,'category','unknown','status','review','intended_role','editor','export_level','low','provenance','{}'::jsonb,'notes',null,'archived',false)||p_person;
  else
    select * into previous from public.lab_members where colony_id=p_colony_id and person_id=target for update;
    if not found or previous.version<>expected then raise exception using errcode='40001',message='Roster record changed; reload before saving';end if;
    merged:=to_jsonb(previous)||p_person;
  end if;
  foreach k in array array['name','email','phone','acronym','category','status','intended_role','export_level','notes'] loop
    if merged->k is not null and jsonb_typeof(merged->k) not in ('string','null') then raise exception using errcode='22023',message='Roster text fields must be strings or null';end if;
  end loop;
  if jsonb_typeof(merged->'archived') is distinct from 'boolean' or jsonb_typeof(merged->'provenance') is distinct from 'object' then raise exception using errcode='22023',message='Archived must be boolean and provenance must be an object';end if;
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
      insert into public.lab_members(colony_id,name,email,phone,acronym,category,status,intended_role,export_level,provenance,notes,archived,created_by,updated_by)
      values(p_colony_id,btrim(merged->>'name'),lower(nullif(btrim(merged->>'email'),'')),nullif(btrim(merged->>'phone'),''),upper(nullif(btrim(merged->>'acronym'),'')),merged->>'category',merged->>'status',merged->>'intended_role',merged->>'export_level',merged->'provenance',nullif(btrim(merged->>'notes'),''),(merged->>'archived')::boolean,actor,actor) returning * into saved;
    else
      update public.lab_members set name=btrim(merged->>'name'),email=lower(nullif(btrim(merged->>'email'),'')),phone=nullif(btrim(merged->>'phone'),''),acronym=upper(nullif(btrim(merged->>'acronym'),'')),category=merged->>'category',status=merged->>'status',intended_role=merged->>'intended_role',export_level=merged->>'export_level',provenance=merged->'provenance',notes=nullif(btrim(merged->>'notes'),''),archived=(merged->>'archived')::boolean,version=version+1,updated_at=clock_timestamp(),updated_by=actor where person_id=target returning * into saved;
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

create or replace function public.get_my_lab_member(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); account_email text; verified boolean; has_password boolean; person public.lab_members%rowtype; member public.memberships%rowtype; self_record jsonb;
begin
  if actor is null then raise exception using errcode='42501',message='Sign in before completing account setup';end if;
  select lower(u.email),u.email_confirmed_at is not null,coalesce(length(u.encrypted_password),0)>0 into account_email,verified,has_password from auth.users u where u.id=actor;
  if not coalesce(verified,false) then return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'reason','email_unverified');end if;
  select * into person from public.lab_members where colony_id=p_colony_id and email=account_email and status='current' and not archived and (linked_user_id is null or linked_user_id=actor);
  if not found then return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'reason','not_registered');end if;
  select * into member from public.memberships where colony_id=p_colony_id and user_id=actor;
  if (member.user_id is not null and not member.active) or (person.linked_user_id is not null and member.user_id is null) then return jsonb_build_object('member',null,'eligible',false,'setup_required',false,'reason','access_disabled');end if;
  self_record:=jsonb_build_object('person_id',person.person_id,'name',person.name,'email',person.email,'phone',person.phone,'acronym',person.acronym,'category',person.category,'status',person.status,'username',person.username,'version',person.version,'effective_role',coalesce(member.role,person.intended_role),'effective_export_level',case when member.role='owner' then 'max' else coalesce(member.export_level,person.export_level) end);
  return jsonb_build_object('member',self_record,'eligible',true,'setup_required',person.linked_user_id is null,'has_password',has_password,'reason',case when not has_password then 'password_required' when person.linked_user_id is null then 'username_required' else 'ready' end);
end $$;
revoke all on function public.get_my_lab_member(uuid) from public,anon,authenticated;
grant execute on function public.get_my_lab_member(uuid) to authenticated;

create or replace function public.complete_lab_member_setup(p_colony_id uuid,p_username text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); account_email text; verified boolean; has_password boolean; requested text:=lower(btrim(p_username)); person public.lab_members%rowtype; old_member public.memberships%rowtype; saved_member public.memberships%rowtype;
begin
  if actor is null then raise exception using errcode='42501',message='Sign in before completing account setup';end if;
  if requested is null or requested !~ '^[a-z][a-z0-9_.-]{2,31}$' then raise exception using errcode='22023',message='Username must start with a letter and contain 3–32 letters, digits, dots, underscores, or hyphens';end if;
  perform 1 from public.colonies where id=p_colony_id for update;
  select lower(u.email),u.email_confirmed_at is not null,coalesce(length(u.encrypted_password),0)>0 into account_email,verified,has_password from auth.users u where u.id=actor;
  if not coalesce(verified,false) or not coalesce(has_password,false) then raise exception using errcode='42501',message='Verify your account email and set an account password first';end if;
  select * into person from public.lab_members where colony_id=p_colony_id and email=account_email and status='current' and not archived for update;
  if not found or (person.linked_user_id is not null and person.linked_user_id<>actor) then raise exception using errcode='42501',message='A current preregistered lab-member record is required';end if;
  select * into old_member from public.memberships where colony_id=p_colony_id and user_id=actor for update;
  if old_member.user_id is not null and not old_member.active then raise exception using errcode='42501',message='Account access is disabled; contact the database owner';end if;
  if person.linked_user_id=actor then
    if old_member.user_id is null then raise exception using errcode='42501',message='Account access is unavailable; contact the database owner';end if;
    if person.username<>requested then raise exception using errcode='22023',message='Setup is complete; your registered username cannot be changed here';end if;
    return public.get_my_lab_member(p_colony_id);
  end if;
  if exists(select 1 from public.lab_members where colony_id=p_colony_id and username=requested and person_id<>person.person_id) then raise exception using errcode='23505',message='This username is already registered';end if;
  update public.lab_members set username=requested,linked_user_id=actor,version=version+1,updated_at=clock_timestamp(),updated_by=actor where person_id=person.person_id;
  if old_member.role is distinct from 'owner' then
    insert into public.memberships(colony_id,user_id,role,active,export_level,updated_by) values(p_colony_id,actor,person.intended_role,true,person.export_level,actor)
    on conflict(colony_id,user_id) do update set role=excluded.role,export_level=excluded.export_level,active=true,updated_at=clock_timestamp(),updated_by=actor returning * into saved_member;
    insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record) values(p_colony_id,'membership',actor::text,case when old_member.user_id is null then 'INSERT' else 'UPDATE' end,actor,case when old_member.user_id is null then null else to_jsonb(old_member) end,to_jsonb(saved_member));
  end if;
  return public.get_my_lab_member(p_colony_id);
end $$;
revoke all on function public.complete_lab_member_setup(uuid,text) from public,anon,authenticated;
grant execute on function public.complete_lab_member_setup(uuid,text) to authenticated;

create or replace function public.get_lab_user_directory(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null or colony_private.current_role(p_colony_id) is null then raise exception using errcode='42501',message='Active colony membership is required';end if;
  select coalesce(jsonb_agg(jsonb_build_object('code',acronym,'name',name) order by acronym),'[]') into result from public.lab_members where colony_id=p_colony_id and status='current' and not archived and acronym is not null;
  return jsonb_build_object('users',result);
end $$;
revoke all on function public.get_lab_user_directory(uuid) from public,anon,authenticated;
grant execute on function public.get_lab_user_directory(uuid) to authenticated;
commit;
