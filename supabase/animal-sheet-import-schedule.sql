-- Run only after the source workbook Reader grant, configuration, deployment,
-- and one independently verified manual import. Existing outbound cron is untouched.
begin;
do $$
declare cfg record; installed integer:=0;
begin
 for cfg in select c.colony_id from colony_private.animal_sheet_import_settings c join colony_private.animal_sheet_import_state s using(colony_id)
   where c.enabled and s.last_success_at is not null and s.active_job_id is null loop
  perform cron.schedule('animal-sheet-import-'||cfg.colony_id::text,'0 18 * * *',format('select colony_private.queue_animal_sheet_import(%L::uuid,null);',cfg.colony_id::text));
  installed:=installed+1;
 end loop;
 if installed=0 then raise exception 'No enabled inbound integration has a completed verified manual import';end if;
end $$;
commit;
-- 18:00 UTC = 02:00 Asia/Taipei. Daily reads do not write to the original Sheet.
