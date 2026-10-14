-- Additive inbound source integration, separate from outbound sheet-sync.sql.
-- Install after schema.sql, export-permissions.sql, manager-permissions.sql and lab-members.sql.
-- No configuration, credential, schedule, Google access, or import is activated here.
begin;
create table if not exists colony_private.animal_sheet_import_settings (
 colony_id uuid primary key references public.colonies(id),
 source_spreadsheet_id text not null check(source_spreadsheet_id ~ '^[A-Za-z0-9_-]{20,100}$'),
 gateway_anon_key text check(gateway_anon_key is null or length(gateway_anon_key) between 40 and 4096),
 source_sheet_ids jsonb not null default '[1717598677,495325388,1250760483]'::jsonb check(source_sheet_ids='[1717598677,495325388,1250760483]'::jsonb),
 function_url text not null check(function_url ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/import-animal-sheet$'),
 responsible_user_id uuid not null references auth.users(id),
 enabled boolean not null default false,
 last_requested_at timestamptz
);
alter table colony_private.animal_sheet_import_settings add column if not exists gateway_anon_key text;
create table if not exists colony_private.animal_sheet_import_jobs (
 job_id uuid primary key default gen_random_uuid(),
 colony_id uuid not null references public.colonies(id),
 requested_by uuid references auth.users(id),
 trigger_kind text not null check(trigger_kind in ('manual','daily')),
 status text not null check(status in ('queued','running','completed','conflicts','failed')),
 queued_at timestamptz not null default clock_timestamp(),
 started_at timestamptz, finished_at timestamptz,
 lock_token uuid, request_id bigint,
 content_hash text, snapshot_id uuid,
 summary jsonb not null default '{}', conflicts jsonb not null default '[]',
 error_code text
);
-- Configuration must specify the authorized source; existing configured rows are retained.
alter table colony_private.animal_sheet_import_settings alter column source_spreadsheet_id drop default;
create table if not exists colony_private.animal_sheet_import_state (
 colony_id uuid primary key references public.colonies(id),
 baseline_revision integer not null default 0,
 baseline jsonb not null default '{}',
 last_content_hash text,
 active_job_id uuid references colony_private.animal_sheet_import_jobs(job_id),
 last_success_job_id uuid references colony_private.animal_sheet_import_jobs(job_id),
 last_success_at timestamptz
);
create table if not exists colony_private.animal_sheet_import_snapshots (
 snapshot_id uuid primary key default gen_random_uuid(),
 colony_id uuid not null references public.colonies(id),
 source_spreadsheet_id text not null,
 captured_at timestamptz not null,
 raw_hash text not null,
 content_hash text not null,
 raw_workbook jsonb not null,
 parsed_summary jsonb not null default '{}',
 unique(colony_id,raw_hash)
);
alter table colony_private.animal_sheet_import_settings enable row level security;
alter table colony_private.animal_sheet_import_jobs enable row level security;
alter table colony_private.animal_sheet_import_state enable row level security;
alter table colony_private.animal_sheet_import_snapshots enable row level security;
revoke all on colony_private.animal_sheet_import_settings,colony_private.animal_sheet_import_jobs,colony_private.animal_sheet_import_state,colony_private.animal_sheet_import_snapshots from public,anon,authenticated,service_role;
drop trigger if exists animal_sheet_import_snapshot_immutable on colony_private.animal_sheet_import_snapshots;
create trigger animal_sheet_import_snapshot_immutable before update or delete on colony_private.animal_sheet_import_snapshots for each row execute function colony_private.reject_removal();

create or replace function colony_private.queue_animal_sheet_import(p_colony_id uuid,p_requested_by uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg colony_private.animal_sheet_import_settings%rowtype; state colony_private.animal_sheet_import_state%rowtype; job colony_private.animal_sheet_import_jobs%rowtype; secret text; gateway_claim jsonb; gateway_body text; queued_request_id bigint;
begin
 select * into cfg from colony_private.animal_sheet_import_settings where colony_id=p_colony_id for update;
 if not found or not cfg.enabled then raise exception using errcode='55000',message='Animal Sheet import is not enabled';end if;
 insert into colony_private.animal_sheet_import_state(colony_id) values(p_colony_id) on conflict do nothing;
 select * into state from colony_private.animal_sheet_import_state where colony_id=p_colony_id for update;
 if state.active_job_id is not null then
  select * into job from colony_private.animal_sheet_import_jobs where job_id=state.active_job_id for update;
  if coalesce(job.started_at,job.queued_at)>clock_timestamp()-interval '15 minutes' then return jsonb_build_object('job_id',job.job_id,'status',job.status,'queued_at',job.queued_at);end if;
  -- Source reads have no external side effects. Superseding the token prevents
  -- an old worker from committing after this recoverable timeout.
  update colony_private.animal_sheet_import_jobs set status='failed',error_code='worker_timeout',finished_at=clock_timestamp() where job_id=job.job_id;
 end if;
 if cfg.last_requested_at>clock_timestamp()-interval '30 seconds' then raise exception using errcode='55000',message='Wait briefly before requesting another source refresh';end if;
 insert into colony_private.animal_sheet_import_jobs(colony_id,requested_by,trigger_kind,status) values(p_colony_id,p_requested_by,case when p_requested_by is null then 'daily' else 'manual' end,'queued') returning * into job;
 update colony_private.animal_sheet_import_state set active_job_id=job.job_id where colony_id=p_colony_id;
 update colony_private.animal_sheet_import_settings set last_requested_at=clock_timestamp() where colony_id=p_colony_id;
 begin
  select decrypted_secret into secret from vault.decrypted_secrets where name='animal_sheet_sync_secret';
  if secret is null or length(secret)<32 then raise exception 'Sync secret unavailable';end if;
  if cfg.gateway_anon_key is null or cfg.gateway_anon_key !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then raise exception 'Public gateway key unavailable';end if;
  gateway_body:=split_part(cfg.gateway_anon_key,'.',2);
  gateway_claim:=convert_from(decode(translate(gateway_body,'-_','+/')||repeat('=',(4-length(gateway_body)%4)%4),'base64'),'UTF8')::jsonb;
  if gateway_claim->>'role' is distinct from 'anon' then raise exception 'Only a public anon gateway JWT is allowed';end if;
  select net.http_post(url:=cfg.function_url,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||cfg.gateway_anon_key,'x-sync-secret',secret),body:=jsonb_build_object('job_id',job.job_id),timeout_milliseconds:=120000) into queued_request_id;
  update colony_private.animal_sheet_import_jobs set request_id=queued_request_id where job_id=job.job_id;
 exception when others then
  update colony_private.animal_sheet_import_jobs set status='failed',error_code='queue_unavailable',finished_at=clock_timestamp() where job_id=job.job_id;
  update colony_private.animal_sheet_import_state set active_job_id=null where colony_id=p_colony_id and active_job_id=job.job_id;
  return jsonb_build_object('job_id',job.job_id,'status','failed','error','The source refresh could not be queued. Ask the owner to check its server configuration.');
 end;
 return jsonb_build_object('job_id',job.job_id,'status','queued','queued_at',job.queued_at);
end $$;
revoke all on function colony_private.queue_animal_sheet_import(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.request_animal_sheet_import(p_colony_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not colony_private.has_permission(p_colony_id,'imports') or not colony_private.has_permission(p_colony_id,'housing') then raise exception using errcode='42501',message='Import and housing permissions are required';end if;
 return colony_private.queue_animal_sheet_import(p_colony_id,auth.uid());
end $$;
revoke all on function public.request_animal_sheet_import(uuid) from public,anon,authenticated;
grant execute on function public.request_animal_sheet_import(uuid) to authenticated;

create or replace function public.get_animal_sheet_import_status(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare cfg colony_private.animal_sheet_import_settings%rowtype; state colony_private.animal_sheet_import_state%rowtype; job colony_private.animal_sheet_import_jobs%rowtype; schedule_active boolean:=false;
begin
 if auth.uid() is null or colony_private.current_role(p_colony_id) is null then raise exception using errcode='42501',message='Active colony membership is required';end if;
 select * into cfg from colony_private.animal_sheet_import_settings where colony_id=p_colony_id;
 select * into state from colony_private.animal_sheet_import_state where colony_id=p_colony_id;
 select * into job from colony_private.animal_sheet_import_jobs where colony_id=p_colony_id order by queued_at desc,job_id desc limit 1;
 -- Installation permits manual updates; only a live, active cron job enables daily updates.
 if cfg.enabled and to_regclass('cron.job') is not null then
  execute 'select exists(select 1 from cron.job where jobname=$1 and active and schedule=$2)' into schedule_active using 'animal-sheet-import-'||p_colony_id::text,'0 18 * * *';
 end if;
 return jsonb_build_object('configured',cfg.colony_id is not null,'enabled',coalesce(cfg.enabled,false),'source_url',case when cfg.source_spreadsheet_id is not null then 'https://docs.google.com/spreadsheets/d/'||cfg.source_spreadsheet_id||'/edit' else null end,'schedule_active',schedule_active,'schedule',case when schedule_active then 'Daily 02:00 Asia/Taipei' else null end,'status',coalesce(job.status,case when cfg.enabled then 'ready' else 'not_configured' end),'last_success_at',state.last_success_at,'conflict_count',coalesce(jsonb_array_length(job.conflicts),0),'job',case when job.job_id is null then null else jsonb_build_object('job_id',job.job_id,'status',job.status,'queued_at',job.queued_at,'started_at',job.started_at,'finished_at',job.finished_at,'snapshot_id',job.snapshot_id,'summary',job.summary,'error',job.error_code) end);
end $$;
revoke all on function public.get_animal_sheet_import_status(uuid) from public,anon,authenticated;
grant execute on function public.get_animal_sheet_import_status(uuid) to authenticated;

create or replace function public.get_animal_sheet_import_conflicts(p_colony_id uuid,p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare job colony_private.animal_sheet_import_jobs%rowtype; items jsonb; total integer;
begin
 if auth.uid() is null or colony_private.current_role(p_colony_id) is null then raise exception using errcode='42501',message='Active colony membership is required';end if;
 if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 200 then raise exception using errcode='22023',message='Invalid conflict page';end if;
 select * into job from colony_private.animal_sheet_import_jobs where colony_id=p_colony_id and status in ('completed','conflicts') order by finished_at desc,job_id desc limit 1;
 total:=coalesce(jsonb_array_length(job.conflicts),0);
 select coalesce(jsonb_agg(value),'[]') into items from (select value from jsonb_array_elements(coalesce(job.conflicts,'[]')) with ordinality a(value,n) order by n offset p_offset limit p_limit) q;
 return jsonb_build_object('job_id',job.job_id,'conflicts',items,'total',total,'next_offset',case when p_offset+jsonb_array_length(items)<total then p_offset+jsonb_array_length(items) else null end);
end $$;
revoke all on function public.get_animal_sheet_import_conflicts(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.get_animal_sheet_import_conflicts(uuid,integer,integer) to authenticated;

create or replace function public.claim_animal_sheet_import(p_colony_id uuid,p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg colony_private.animal_sheet_import_settings%rowtype; state colony_private.animal_sheet_import_state%rowtype; job colony_private.animal_sheet_import_jobs%rowtype; records jsonb; directory jsonb; token uuid:=gen_random_uuid();
begin
 if coalesce(auth.role(),'')<>'service_role' or auth.uid() is not null then raise exception using errcode='42501',message='Server only';end if;
 select * into cfg from colony_private.animal_sheet_import_settings where colony_id=p_colony_id and enabled for update;
 if not found then return null;end if;
 select * into state from colony_private.animal_sheet_import_state where colony_id=p_colony_id for update;
 select * into job from colony_private.animal_sheet_import_jobs where job_id=p_job_id and colony_id=p_colony_id for update;
 if job.status is distinct from 'queued' or state.active_job_id is distinct from p_job_id then return null;end if;
 update colony_private.animal_sheet_import_jobs set status='running',started_at=clock_timestamp(),lock_token=token where job_id=p_job_id;
 select coalesce(jsonb_agg(jsonb_build_object('entity_type',r.entity_type,'entity_id',r.entity_id,'payload',case when r.entity_type='mice' then jsonb_build_object('mouse_sid',r.payload->'mouse_sid','physical_tag',r.payload->'physical_tag') when r.entity_type='cages' then jsonb_build_object('cage_sid',r.payload->'cage_sid','cage_tag',r.payload->'cage_tag') else r.payload end,'version',r.version,'archived',r.archived) order by r.entity_type,r.entity_id),'[]') into records from public.entity_records r where r.colony_id=p_colony_id and r.entity_type in ('rooms','racks','locations','light_events','mice','cages');
 select coalesce(jsonb_agg(jsonb_build_object('code',m.acronym,'name',m.name,'aliases',(select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(case when jsonb_typeof(m.provenance->'aliases')='array' then m.provenance->'aliases' else '[]'::jsonb end) x where jsonb_typeof(x)='string' and length(x#>>'{}') between 1 and 200)) order by m.name,m.person_id),'[]') into directory from public.lab_members m where m.colony_id=p_colony_id and m.status in ('current','historical') and not m.archived and m.acronym is not null;
 return jsonb_build_object('manager_directory',directory,'job_id',job.job_id,'token',token,'baseline_revision',state.baseline_revision,'previous_baseline',state.baseline,'last_content_hash',state.last_content_hash,'source_spreadsheet_id',cfg.source_spreadsheet_id,'source_sheet_ids',cfg.source_sheet_ids,'records',records);
end $$;
revoke all on function public.claim_animal_sheet_import(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_animal_sheet_import(uuid,uuid) to service_role;

create or replace function public.commit_animal_sheet_import(p_colony_id uuid,p_job_id uuid,p_token uuid,p_baseline_revision integer,p_captured_at timestamptz,p_content_hash text,p_raw_workbook jsonb,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg colony_private.animal_sheet_import_settings%rowtype; state colony_private.animal_sheet_import_state%rowtype; job colony_private.animal_sheet_import_jobs%rowtype; item jsonb; changes jsonb; old public.entity_records%rowtype; expected integer; kind text; id text; snapshot uuid; fingerprint text; new_status text; result jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' or auth.uid() is not null then raise exception using errcode='42501',message='Server only';end if;
 select * into cfg from colony_private.animal_sheet_import_settings where colony_id=p_colony_id and enabled for update;
 if not found then raise exception using errcode='55000',message='Import is disabled';end if;
 select * into state from colony_private.animal_sheet_import_state where colony_id=p_colony_id for update;
 select * into job from colony_private.animal_sheet_import_jobs where job_id=p_job_id and colony_id=p_colony_id for update;
 if job.lock_token is distinct from p_token or p_token is null then raise exception using errcode='40001',message='Import token is stale';end if;
 if job.status in ('completed','conflicts') then return jsonb_build_object('status',job.status,'job_id',job.job_id,'summary',job.summary,'snapshot_id',job.snapshot_id);end if;
 if job.status is distinct from 'running' or state.active_job_id is distinct from p_job_id or state.baseline_revision is distinct from p_baseline_revision then raise exception using errcode='40001',message='Import baseline or job changed';end if;
 if not exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.colony_id=p_colony_id and m.user_id=cfg.responsible_user_id and m.role='owner' and m.active and u.email_confirmed_at is not null) then raise exception using errcode='42501',message='A verified responsible owner is required';end if;
 if job.requested_by is not null and not exists(select 1 from public.memberships m where m.colony_id=p_colony_id and m.user_id=job.requested_by and m.active and (m.role in ('owner','editor') or (m.role='manager' and m.permissions->'imports'='true'::jsonb and m.permissions->'housing'='true'::jsonb))) then raise exception using errcode='42501',message='The requesting account no longer has import and housing access';end if;
 if p_captured_at is null or p_captured_at>clock_timestamp()+interval '5 minutes' or p_content_hash is null or p_content_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_raw_workbook) is distinct from 'object' or p_raw_workbook->>'spreadsheetId' is distinct from cfg.source_spreadsheet_id or octet_length(p_raw_workbook::text)>24000000 then raise exception using errcode='22023',message='Invalid source snapshot';end if;
 if jsonb_typeof(p_plan) is distinct from 'object' or octet_length(p_plan::text)>12000000 or jsonb_typeof(p_plan->'changes') is distinct from 'array' or jsonb_typeof(p_plan->'historyRecords') is distinct from 'array' or jsonb_typeof(p_plan->'conflicts') is distinct from 'array' or jsonb_typeof(p_plan->'nextBaseline') is distinct from 'object' or jsonb_typeof(p_plan->'summary') is distinct from 'object' then raise exception using errcode='22023',message='Invalid source merge plan';end if;
 changes:=(p_plan->'changes')||(p_plan->'historyRecords');
 if jsonb_array_length(changes)>5000 or jsonb_array_length(p_plan->'conflicts')>5000 or exists(select 1 from jsonb_array_elements(changes) x group by x->>'entity_type',x->>'entity_id' having count(*)>1) then raise exception using errcode='22023',message='Too many or duplicate source changes';end if;
 -- Standard cloud edits use the same colony advisory lock. The transaction either
 -- saves every proposed change and baseline or saves none.
 perform pg_advisory_xact_lock(hashtextextended('colony:'||p_colony_id::text,0));
 for item in select value from jsonb_array_elements(changes) order by value->>'entity_type',value->>'entity_id' loop
  kind:=item->>'entity_type';id:=item->>'entity_id';
  if kind is null or kind not in ('rooms','racks','locations','light_events','husbandry_events') or id is null or btrim(id)<>id or length(id) not between 1 and 200 or jsonb_typeof(item->'expected_version') is distinct from 'number' or item->>'expected_version' !~ '^\d+$' or (item ? 'archived' and item->'archived' is distinct from 'false'::jsonb) or octet_length((item->'payload')::text)>200000 then raise exception using errcode='22023',message='Invalid source change';end if;
  expected:=(item->>'expected_version')::integer;
  if kind='husbandry_events' and (expected<>0 or id not like 'SHEET-HISTORY-%' or item#>>'{payload,event_type}' is distinct from 'animal_sheet_source_change') then raise exception using errcode='22023',message='Only append-only source history events are allowed';end if;
  if item#>'{payload,app_archived_at}' is not null and item#>'{payload,app_archived_at}'<>'null'::jsonb or item#>'{payload,archived}'='true'::jsonb then raise exception using errcode='22023',message='Source import cannot archive records';end if;
  if kind<>'husbandry_events' and (item#>>'{payload,source_file_id}' is distinct from cfg.source_spreadsheet_id or item#>>'{payload,record_origin}' is distinct from 'current_google_sheet_map') then raise exception using errcode='22023',message='Housing imports must retain the configured source provenance';end if;
  perform colony_private.validate_payload(kind,id,item->'payload');
  select * into old from public.entity_records where colony_id=p_colony_id and entity_type=kind and entity_id=id for update;
  if (found and (old.version<>expected or old.archived or old.payload->>'app_archived_at' is not null)) or (not found and expected<>0) then raise exception using errcode='40001',message='A source-linked record changed; refresh again to preserve app edits';end if;
  if found then update public.entity_records set payload=item->'payload',version=version+1,updated_at=clock_timestamp(),updated_by=cfg.responsible_user_id where colony_id=p_colony_id and entity_type=kind and entity_id=id;
  else insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by) values(p_colony_id,kind,id,item->'payload',cfg.responsible_user_id,cfg.responsible_user_id);end if;
 end loop;
 fingerprint:=encode(sha256(convert_to(p_raw_workbook::text,'UTF8')),'hex');
 insert into colony_private.animal_sheet_import_snapshots(colony_id,source_spreadsheet_id,captured_at,raw_hash,content_hash,raw_workbook,parsed_summary) values(p_colony_id,cfg.source_spreadsheet_id,p_captured_at,fingerprint,p_content_hash,p_raw_workbook,p_plan->'summary') on conflict(colony_id,raw_hash) do nothing returning snapshot_id into snapshot;
 if snapshot is null then select snapshot_id into snapshot from colony_private.animal_sheet_import_snapshots where colony_id=p_colony_id and raw_hash=fingerprint;end if;
 new_status:=case when jsonb_array_length(p_plan->'conflicts')>0 then 'conflicts' else 'completed' end;
 update colony_private.animal_sheet_import_jobs set status=new_status,finished_at=clock_timestamp(),content_hash=p_content_hash,snapshot_id=snapshot,summary=p_plan->'summary',conflicts=p_plan->'conflicts',error_code=null where job_id=p_job_id;
 update colony_private.animal_sheet_import_state set baseline_revision=baseline_revision+1,baseline=p_plan->'nextBaseline',last_content_hash=p_content_hash,active_job_id=null,last_success_job_id=p_job_id,last_success_at=clock_timestamp() where colony_id=p_colony_id;
 return jsonb_build_object('job_id',p_job_id,'status',new_status,'summary',p_plan->'summary','snapshot_id',snapshot);
end $$;
revoke all on function public.commit_animal_sheet_import(uuid,uuid,uuid,integer,timestamptz,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.commit_animal_sheet_import(uuid,uuid,uuid,integer,timestamptz,text,jsonb,jsonb) to service_role;

create or replace function public.fail_animal_sheet_import(p_colony_id uuid,p_job_id uuid,p_token uuid,p_error_code text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or auth.uid() is not null then raise exception using errcode='42501',message='Server only';end if;
 perform 1 from colony_private.animal_sheet_import_settings where colony_id=p_colony_id for update;
 update colony_private.animal_sheet_import_jobs set status='failed',finished_at=clock_timestamp(),error_code=case when p_error_code in ('source_access_denied','google_auth_failed','source_read_failed','source_schema_changed','source_too_large','source_merge_failed','commit_conflict','commit_failed') then p_error_code else 'import_failed' end where colony_id=p_colony_id and job_id=p_job_id and lock_token=p_token and p_token is not null and status='running';
 if found then update colony_private.animal_sheet_import_state set active_job_id=null where colony_id=p_colony_id and active_job_id=p_job_id;end if;
end $$;
revoke all on function public.fail_animal_sheet_import(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.fail_animal_sheet_import(uuid,uuid,uuid,text) to service_role;

-- Full source snapshots are exportable only through the existing Max gate.
create or replace function public.get_animal_sheet_import_snapshot(p_colony_id uuid,p_snapshot_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform public.assert_full_export_permission(p_colony_id);
 select jsonb_build_object('snapshot_id',snapshot_id,'captured_at',captured_at,'source_spreadsheet_id',source_spreadsheet_id,'raw_hash',raw_hash,'content_hash',content_hash,'raw_workbook',raw_workbook) into result from colony_private.animal_sheet_import_snapshots where colony_id=p_colony_id and snapshot_id=p_snapshot_id;
 return result;
end $$;
revoke all on function public.get_animal_sheet_import_snapshot(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_animal_sheet_import_snapshot(uuid,uuid) to authenticated;
commit;
