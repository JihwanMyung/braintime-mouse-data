-- Add truthful daily-schedule status; no import or cron is activated.
begin;
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
commit;
