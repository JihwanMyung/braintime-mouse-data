-- Internal manager service principal. No Auth user, password, token or membership.
-- Apply after manager-permissions.sql and cage-position-guard.sql.
begin;
create table if not exists colony_private.brainbot_settings(
 colony_id uuid primary key references public.colonies(id),
 principal_id uuid not null unique default gen_random_uuid(),
 enabled boolean not null default false,
 daily_time text not null default '03:00' check(daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 automatic_corrections boolean not null default true,
 permissions jsonb not null default colony_private.default_manager_permissions() check(colony_private.valid_manager_permissions(permissions)),
 version integer not null default 1,
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid references auth.users(id)
);
create table if not exists colony_private.brainbot_runs(
 run_id uuid primary key default gen_random_uuid(),colony_id uuid not null references public.colonies(id),
 principal_id uuid not null references colony_private.brainbot_settings(principal_id),
 trigger text not null check(trigger in ('manual','scheduled')),requested_by uuid references auth.users(id),
 status text not null check(status in ('running','completed','failed')),
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 checked_count integer not null default 0,fixed_count integer not null default 0,issue_count integer not null default 0,
 error_code text,changes jsonb not null default '[]',settings_version integer not null
);
create table if not exists colony_private.brainbot_issues(
 issue_id uuid primary key default gen_random_uuid(),colony_id uuid not null references public.colonies(id),
 code text not null,severity text not null default 'warning',entity_type text not null,entity_id text not null,
 title text not null,details jsonb not null default '{}',status text not null default 'open' check(status in ('open','acknowledged','resolved')),
 version integer not null default 1,first_seen_at timestamptz not null default clock_timestamp(),last_seen_at timestamptz not null default clock_timestamp(),
 last_run_id uuid not null references colony_private.brainbot_runs(run_id),resolution_note text,
 reviewed_by uuid references auth.users(id),reviewed_at timestamptz,
 unique(colony_id,code,entity_type,entity_id)
);
create table if not exists colony_private.brainbot_audit(
 audit_id bigint generated always as identity primary key,colony_id uuid not null references public.colonies(id),
 action text not null,actor_id uuid references auth.users(id),occurred_at timestamptz not null default clock_timestamp(),before_record jsonb,after_record jsonb not null
);
revoke all on colony_private.brainbot_settings,colony_private.brainbot_runs,colony_private.brainbot_issues,colony_private.brainbot_audit from public,anon,authenticated;
alter table colony_private.brainbot_settings enable row level security;
alter table colony_private.brainbot_runs enable row level security;
alter table colony_private.brainbot_issues enable row level security;
alter table colony_private.brainbot_audit enable row level security;
-- NULL accurately represents an internal service change; the private run records
-- its BB principal. Never manufacture a human Auth identity for scheduled work.
alter table public.entity_records alter column updated_by drop not null;

create or replace function colony_private.brainbot_require_owner(c uuid)
returns void language plpgsql stable security definer set search_path='' as $$begin
 if colony_private.current_role(c) is distinct from 'owner' then raise exception using errcode='42501',message='Only the owner can manage Brainbot';end if;
end $$;
create or replace function colony_private.brainbot_schedule(c uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare cfg colony_private.brainbot_settings%rowtype;j record;h integer;m integer;jobname text:='brainbot-'||c::text;
begin
 select * into cfg from colony_private.brainbot_settings where colony_id=c;
 if not found or to_regclass('cron.job') is null or to_regprocedure('cron.schedule(text,text,text)') is null then return false;end if;
 for j in execute 'select jobid from cron.job where jobname=$1' using jobname loop execute 'select cron.unschedule($1)' using j.jobid;end loop;
 if not cfg.enabled then return false;end if;
 h:=(split_part(cfg.daily_time,':',1)::integer+16)%24;m:=split_part(cfg.daily_time,':',2)::integer;
 execute 'select cron.schedule($1,$2,$3)' using jobname,m::text||' '||h::text||' * * *',format('select colony_private.run_brainbot(%L::uuid,''scheduled'');',c::text);
 return true;
end $$;
create or replace function public.get_brainbot_status(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare cfg colony_private.brainbot_settings%rowtype;scheduled boolean:=false;rs jsonb;iss jsonb;n integer;
begin
 perform colony_private.brainbot_require_owner(p_colony_id);
 select * into cfg from colony_private.brainbot_settings where colony_id=p_colony_id;
 if to_regclass('cron.job') is not null then execute 'select exists(select 1 from cron.job where jobname=$1 and active)' into scheduled using 'brainbot-'||p_colony_id::text;end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc),'[]') into rs from (select * from colony_private.brainbot_runs where colony_id=p_colony_id order by started_at desc limit 20) r;
 select count(*) into n from colony_private.brainbot_issues where colony_id=p_colony_id;
 select coalesce(jsonb_agg(to_jsonb(i) order by i.status='resolved',i.last_seen_at desc),'[]') into iss from (select * from colony_private.brainbot_issues where colony_id=p_colony_id order by status='resolved',last_seen_at desc,issue_id limit 200) i;
 return jsonb_build_object('principal',jsonb_build_object('principal_id',cfg.principal_id,'name','Brainbot Bot','acronym','BB','role','manager','permissions',coalesce(cfg.permissions,colony_private.default_manager_permissions())),
 'settings',jsonb_build_object('version',coalesce(cfg.version,0),'enabled',coalesce(cfg.enabled,false),'daily_time',coalesce(cfg.daily_time,'03:00'),'timezone','Asia/Taipei','automatic_corrections',coalesce(cfg.automatic_corrections,true)),
 'schedule_active',scheduled,'last_run',rs->0,'runs',rs,'issues',iss,'issue_total',n);
end $$;
create or replace function public.save_brainbot_settings(p_colony_id uuid,p_settings jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old colony_private.brainbot_settings%rowtype;saved colony_private.brainbot_settings%rowtype;
begin
 perform colony_private.brainbot_require_owner(p_colony_id);perform pg_advisory_xact_lock(hashtextextended('colony:'||p_colony_id::text,0));
 if jsonb_typeof(p_settings) is distinct from 'object' or p_settings-array['version','enabled','daily_time','automatic_corrections','permissions']<>'{}' or not (p_settings ?& array['version','enabled','daily_time','automatic_corrections','permissions'])
 or jsonb_typeof(p_settings->'enabled') is distinct from 'boolean' or jsonb_typeof(p_settings->'automatic_corrections') is distinct from 'boolean'
 or coalesce(p_settings->>'daily_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or jsonb_typeof(p_settings->'daily_time') is distinct from 'string'
 or jsonb_typeof(p_settings->'version') is distinct from 'number' or (p_settings->>'version') !~ '^[0-9]{1,9}$'
 or not coalesce(colony_private.valid_manager_permissions(p_settings->'permissions'),false) then raise exception using errcode='22023',message='Invalid Brainbot settings';end if;
 select * into old from colony_private.brainbot_settings where colony_id=p_colony_id for update;
 if coalesce(old.version,0)<>(p_settings->>'version')::integer then raise exception using errcode='40001',message='Brainbot settings changed; reload';end if;
 insert into colony_private.brainbot_settings(colony_id,enabled,daily_time,automatic_corrections,permissions,version,updated_by)
 values(p_colony_id,(p_settings->>'enabled')::boolean,p_settings->>'daily_time',(p_settings->>'automatic_corrections')::boolean,p_settings->'permissions',coalesce(old.version,0)+1,auth.uid())
 on conflict(colony_id) do update set enabled=excluded.enabled,daily_time=excluded.daily_time,automatic_corrections=excluded.automatic_corrections,permissions=excluded.permissions,version=excluded.version,updated_at=clock_timestamp(),updated_by=excluded.updated_by returning * into saved;
 perform colony_private.brainbot_schedule(p_colony_id);
 insert into colony_private.brainbot_audit(colony_id,action,actor_id,before_record,after_record) values(p_colony_id,'settings',auth.uid(),to_jsonb(old),to_jsonb(saved));
 return public.get_brainbot_status(p_colony_id);
end $$;
create or replace function colony_private.brainbot_issue(c uuid,run uuid,code_value text,kind text,id text,title_value text,detail jsonb)
returns void language plpgsql security definer set search_path='' as $$begin
 insert into colony_private.brainbot_issues(colony_id,code,entity_type,entity_id,title,details,last_run_id) values(c,code_value,kind,id,title_value,detail,run)
 on conflict(colony_id,code,entity_type,entity_id) do update set title=excluded.title,details=excluded.details,last_seen_at=clock_timestamp(),last_run_id=excluded.last_run_id,
 status=case when brainbot_issues.status='resolved' then 'open' else brainbot_issues.status end,
 resolution_note=case when brainbot_issues.status='resolved' then null else brainbot_issues.resolution_note end,
 reviewed_by=case when brainbot_issues.status='resolved' then null else brainbot_issues.reviewed_by end,
 reviewed_at=case when brainbot_issues.status='resolved' then null else brainbot_issues.reviewed_at end,version=brainbot_issues.version+1;
end $$;
create or replace function colony_private.run_brainbot(p_colony_id uuid,p_trigger text default 'scheduled')
returns uuid language plpgsql security definer set search_path='' as $$
declare cfg colony_private.brainbot_settings%rowtype;run uuid;r record;loc record;rack record;room record;other record;
 checks integer:=0;fixes integer:=0;found_issues integer:=0;occupants integer;patch jsonb;fields jsonb;v_changes jsonb:='[]';last_import timestamptz;import_job record;err text;
begin
 if p_trigger not in ('manual','scheduled') then raise exception using errcode='22023',message='Invalid Brainbot trigger';end if;
 perform pg_advisory_xact_lock(hashtextextended('colony:'||p_colony_id::text,0));
 select * into cfg from colony_private.brainbot_settings where colony_id=p_colony_id for update;
 if not found then raise exception using errcode='22023',message='Save Brainbot settings first';end if;
 if p_trigger='scheduled' and not cfg.enabled then return null;end if;
 insert into colony_private.brainbot_runs(colony_id,principal_id,trigger,requested_by,status,settings_version) values(p_colony_id,cfg.principal_id,p_trigger,auth.uid(),'running',cfg.version) returning run_id into run;
 begin
  if cfg.permissions->'housing'='true' then
   for r in select * from public.entity_records e where e.colony_id=p_colony_id and e.entity_type='cages' and colony_private.cage_is_current(p_colony_id,e.entity_id,e.payload,e.archived) order by entity_id for update loop
    checks:=checks+1;
    if nullif(r.payload->>'location_id','') is null then
     perform colony_private.brainbot_issue(p_colony_id,run,'cage_position_missing','cages',r.entity_id,'Current cage has no confirmed rack position','{}');continue;
    end if;
    select * into loc from public.entity_records where colony_id=p_colony_id and entity_type='locations' and entity_id=r.payload->>'location_id' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true';
    if not found then perform colony_private.brainbot_issue(p_colony_id,run,'cage_position_invalid','cages',r.entity_id,'Cage refers to a missing or archived position',jsonb_build_object('location_id',r.payload->>'location_id'));continue;end if;
    select count(*) into occupants from public.entity_records e where e.colony_id=p_colony_id and e.entity_type='cages' and e.payload->>'location_id'=loc.entity_id and colony_private.cage_is_current(p_colony_id,e.entity_id,e.payload,e.archived);
    if occupants<>1 then perform colony_private.brainbot_issue(p_colony_id,run,'position_overlap','cages',r.entity_id,'Several current cages share this position',jsonb_build_object('location_id',loc.entity_id,'cage_count',occupants));continue;end if;
    select * into rack from public.entity_records where colony_id=p_colony_id and entity_type='racks' and entity_id=loc.payload->>'rack_id' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true';
    select * into room from public.entity_records where colony_id=p_colony_id and entity_type='rooms' and entity_id=loc.payload->>'room_id' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true';
    if rack.entity_id is null or room.entity_id is null or rack.payload->>'room_id' is distinct from room.entity_id then perform colony_private.brainbot_issue(p_colony_id,run,'position_hierarchy_invalid','cages',r.entity_id,'Position room and rack references need review',jsonb_build_object('location_id',loc.entity_id));continue;end if;
    if (nullif(r.payload->>'room_id','') is not null and r.payload->>'room_id'<>room.entity_id) or (nullif(r.payload->>'rack_id','') is not null and r.payload->>'rack_id'<>rack.entity_id) then
     perform colony_private.brainbot_issue(p_colony_id,run,'cage_hierarchy_conflict','cages',r.entity_id,'Cage room or rack disagrees with its explicit position',jsonb_build_object('location_id',loc.entity_id,'expected_room_id',room.entity_id,'expected_rack_id',rack.entity_id));continue;
    end if;
    patch:='{}';fields:='[]';
    if nullif(r.payload->>'room_id','') is null then patch:=patch||jsonb_build_object('room_id',room.entity_id);fields:=fields||'"room_id"'::jsonb;end if;
    if nullif(r.payload->>'rack_id','') is null then patch:=patch||jsonb_build_object('rack_id',rack.entity_id);fields:=fields||'"rack_id"'::jsonb;end if;
    if patch<>'{}' then
     if cfg.automatic_corrections then
      perform colony_private.validate_payload('cages',r.entity_id,r.payload||patch);
      update public.entity_records set payload=r.payload||patch,version=r.version+1,updated_at=clock_timestamp(),updated_by=null where colony_id=p_colony_id and entity_type='cages' and entity_id=r.entity_id and version=r.version;
      if not found then raise exception using errcode='40001',message='Cage changed during Brainbot verification';end if;
      fixes:=fixes+1;v_changes:=v_changes||jsonb_build_array(jsonb_build_object('entity_type','cages','entity_id',r.entity_id,'fields',fields,'before_version',r.version,'after_version',r.version+1,'before',r.payload,'after',r.payload||patch));
     else perform colony_private.brainbot_issue(p_colony_id,run,'cage_hierarchy_missing','cages',r.entity_id,'Cage room or rack can be filled from its confirmed position',jsonb_build_object('location_id',loc.entity_id,'fields',fields));end if;
    end if;
   end loop;
  end if;
  if cfg.permissions->'mice'='true' then
   for r in select * from public.entity_records where colony_id=p_colony_id and entity_type='mice' and payload->>'state'='Stock' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true' loop
    checks:=checks+1;
    if nullif(r.payload->>'cage_sid','') is null then perform colony_private.brainbot_issue(p_colony_id,run,'mouse_cage_missing','mice',r.entity_id,'Living mouse has no confirmed cage assignment','{}');continue;end if;
    select * into other from public.entity_records where colony_id=p_colony_id and entity_type='cages' and entity_id=r.payload->>'cage_sid' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true';
    if not found then perform colony_private.brainbot_issue(p_colony_id,run,'mouse_cage_invalid','mice',r.entity_id,'Living mouse refers to a missing or archived cage',jsonb_build_object('cage_sid',r.payload->>'cage_sid'));
    elsif lower(coalesce(other.payload->>'state','')) in ('ended','inactive') then perform colony_private.brainbot_issue(p_colony_id,run,'mouse_cage_inactive','mice',r.entity_id,'Living mouse is assigned to an ended or inactive cage',jsonb_build_object('cage_sid',other.entity_id));end if;
   end loop;
  end if;
  if cfg.permissions->'imports'='true' and to_regclass('colony_private.animal_sheet_import_state') is not null then
   checks:=checks+1;execute 'select last_success_at from colony_private.animal_sheet_import_state where colony_id=$1' into last_import using p_colony_id;
   if last_import is null or last_import<clock_timestamp()-interval '36 hours' then perform colony_private.brainbot_issue(p_colony_id,run,'animal_sheet_stale','integration','animal_sheet','Animal Sheet import has no recent successful refresh',jsonb_build_object('last_success_at',last_import));end if;
   if to_regclass('colony_private.animal_sheet_import_jobs') is not null then
    execute 'select s.active_job_id,j.status,j.queued_at,j.started_at from colony_private.animal_sheet_import_state s left join colony_private.animal_sheet_import_jobs j on j.job_id=s.active_job_id where s.colony_id=$1 and s.active_job_id is not null' into import_job using p_colony_id;
    if import_job.active_job_id is not null and (import_job.status is null or import_job.status in ('queued','running') and coalesce(import_job.started_at,import_job.queued_at)<clock_timestamp()-interval '15 minutes') then
     perform colony_private.brainbot_issue(p_colony_id,run,'animal_sheet_job_stuck','integration','animal_sheet','Animal Sheet import has an unresolved or stalled active job',jsonb_build_object('job_id',import_job.active_job_id,'status',import_job.status,'queued_at',import_job.queued_at,'started_at',import_job.started_at));
    end if;
   end if;
  end if;
  select count(*) into found_issues from colony_private.brainbot_issues where last_run_id=run;
  -- Only a check that actually ran can clear its previously reported issue.
  update colony_private.brainbot_issues set status='resolved',version=version+1,resolution_note='Not detected by the latest completed check',reviewed_by=null,reviewed_at=clock_timestamp()
   where colony_id=p_colony_id and last_run_id<>run and status<>'resolved' and ((code like 'cage_%' or code in ('position_overlap','position_hierarchy_invalid')) and cfg.permissions->'housing'='true' or code like 'mouse_%' and cfg.permissions->'mice'='true' or code='animal_sheet_stale' and cfg.permissions->'imports'='true' and to_regclass('colony_private.animal_sheet_import_state') is not null or code='animal_sheet_job_stuck' and cfg.permissions->'imports'='true' and to_regclass('colony_private.animal_sheet_import_jobs') is not null);
  update colony_private.brainbot_runs set status='completed',finished_at=clock_timestamp(),checked_count=checks,fixed_count=fixes,issue_count=found_issues,changes=v_changes where run_id=run;
 exception when others then
  get stacked diagnostics err=returned_sqlstate;
  update colony_private.brainbot_runs set status='failed',finished_at=clock_timestamp(),error_code=err,checked_count=0,fixed_count=0,issue_count=0,changes='[]' where run_id=run;
 end;
 return run;
end $$;
create or replace function public.run_brainbot(p_colony_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform colony_private.brainbot_require_owner(p_colony_id);perform colony_private.run_brainbot(p_colony_id,'manual');return public.get_brainbot_status(p_colony_id);
end $$;
create or replace function public.review_brainbot_issue(p_colony_id uuid,p_issue_id uuid,p_version integer,p_status text,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old colony_private.brainbot_issues%rowtype;saved colony_private.brainbot_issues%rowtype;
begin
 perform colony_private.brainbot_require_owner(p_colony_id);perform pg_advisory_xact_lock(hashtextextended('colony:'||p_colony_id::text,0));
 if p_status not in ('acknowledged','resolved') or p_status is null or p_note is null or p_note !~ '[^[:space:]]' or length(p_note)>2000 then raise exception using errcode='22023',message='Invalid issue review';end if;
 select * into old from colony_private.brainbot_issues where colony_id=p_colony_id and issue_id=p_issue_id for update;
 if not found then raise exception using errcode='22023',message='Issue not found';end if;
 if p_version is distinct from old.version then raise exception using errcode='40001',message='Issue changed; reload';end if;
 update colony_private.brainbot_issues set status=p_status,resolution_note=nullif(btrim(p_note),''),version=version+1,reviewed_at=clock_timestamp(),reviewed_by=auth.uid() where issue_id=p_issue_id returning * into saved;
 insert into colony_private.brainbot_audit(colony_id,action,actor_id,before_record,after_record) values(p_colony_id,'issue_review',auth.uid(),to_jsonb(old),to_jsonb(saved));
 return public.get_brainbot_status(p_colony_id);
end $$;
revoke all on function colony_private.brainbot_require_owner(uuid),colony_private.brainbot_schedule(uuid),colony_private.brainbot_issue(uuid,uuid,text,text,text,text,jsonb),colony_private.run_brainbot(uuid,text) from public,anon,authenticated;
revoke all on function public.get_brainbot_status(uuid),public.save_brainbot_settings(uuid,jsonb),public.run_brainbot(uuid),public.review_brainbot_issue(uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.get_brainbot_status(uuid),public.save_brainbot_settings(uuid,jsonb),public.run_brainbot(uuid),public.review_brainbot_issue(uuid,uuid,integer,text,text) to authenticated;
commit;
