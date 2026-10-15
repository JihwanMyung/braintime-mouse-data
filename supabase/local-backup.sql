-- Local download backup authorization; does not alter ordinary exports.
-- Apply after export-permissions.sql and its maintained domain/fee wrappers.
begin;
create or replace function public.get_local_backup_permission(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permission jsonb;
begin
 permission:=public.get_export_permission(p_colony_id);
 if permission->>'level' not in ('high','max') then
  raise exception using errcode='42501',message='Local backup requires High or Max export access';
 end if;
 return permission||jsonb_build_object('local_backup_allowed',true,'backup_scope',case when permission->>'level'='max' then 'full' else 'bounded' end,
  'no_whole_workspace_restore',permission->>'level'<>'max');
end $$;
create or replace function public.export_local_backup_records(
 p_colony_id uuid,p_scope text default 'current_housing',p_from_date date default null,p_to_date date default null,
 p_entity_types text[] default null,p_offset integer default 0,p_limit integer default 250,p_expected_revision text default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permission jsonb;result jsonb;
begin
 permission:=public.get_local_backup_permission(p_colony_id);
 if p_expected_revision is not null and (length(p_expected_revision)>100 or p_expected_revision!~'^[0-9]+$') then
  raise exception using errcode='22023',message='Invalid local-backup revision';end if;
 result:=public.export_records(p_colony_id,p_scope,p_from_date,p_to_date,p_entity_types,p_offset,p_limit);
 if result->>'export_level' is distinct from permission->>'level' or result->'cutoff_date' is distinct from permission->'cutoff_date' or result->'as_of_date' is distinct from permission->'as_of_date' then
  raise exception using errcode='40001',message='Backup permission changed; start again';end if;
 if p_expected_revision is not null and result->>'snapshot_revision' is distinct from p_expected_revision then
  raise exception using errcode='40001',message='Shared data changed; start the local backup again';end if;
 return result||jsonb_build_object('local_backup',true,'partial',permission->>'level'<>'max','no_whole_workspace_restore',permission->>'level'<>'max');
end $$;
revoke all on function public.get_local_backup_permission(uuid),public.export_local_backup_records(uuid,text,date,date,text[],integer,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.get_local_backup_permission(uuid),public.export_local_backup_records(uuid,text,date,date,text[],integer,integer,text) to authenticated;
commit;
