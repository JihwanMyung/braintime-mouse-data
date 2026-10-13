-- Run after schema.sql in the same Supabase project. Creates only a PRIVATE
-- bucket. No archive is uploaded by this migration.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('colony-history','colony-history',false,83886080,array['application/json','application/gzip'])
on conflict(id) do update set public=false,file_size_limit=83886080,
  allowed_mime_types=array['application/json','application/gzip'];

create or replace function colony_private.history_path_colony(p_name text)
returns uuid language plpgsql immutable set search_path='' as $$
begin
  if p_name !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/history/[0-9a-f]{64}\.json(\.gz)?$' then return null; end if;
  return split_part(p_name,'/',1)::uuid;
end $$;
revoke all on function colony_private.history_path_colony(text) from public,anon,authenticated;
grant execute on function colony_private.history_path_colony(text) to authenticated;

drop policy if exists colony_history_read on storage.objects;
create policy colony_history_read on storage.objects for select to authenticated
using(bucket_id='colony-history' and colony_private.current_role(colony_private.history_path_colony(name)) is not null);
drop policy if exists colony_history_insert on storage.objects;
create policy colony_history_insert on storage.objects for insert to authenticated
with check(bucket_id='colony-history' and colony_private.current_role(colony_private.history_path_colony(name)) in ('owner','editor'));

-- Restrictive policies also guard this bucket if an unrelated broad permissive
-- policy already exists on storage.objects in the project.
drop policy if exists colony_history_private_guard on storage.objects;
create policy colony_history_private_guard on storage.objects as restrictive for select to authenticated
using(bucket_id<>'colony-history' or colony_private.current_role(colony_private.history_path_colony(name)) is not null);
drop policy if exists colony_history_insert_guard on storage.objects;
create policy colony_history_insert_guard on storage.objects as restrictive for insert to authenticated
with check(bucket_id<>'colony-history' or colony_private.current_role(colony_private.history_path_colony(name)) in ('owner','editor'));
drop policy if exists colony_history_no_update on storage.objects;
create policy colony_history_no_update on storage.objects as restrictive for update to authenticated
using(bucket_id<>'colony-history') with check(bucket_id<>'colony-history');
drop policy if exists colony_history_no_delete on storage.objects;
create policy colony_history_no_delete on storage.objects as restrictive for delete to authenticated
using(bucket_id<>'colony-history');
drop policy if exists colony_history_no_anon on storage.objects;
create policy colony_history_no_anon on storage.objects as restrictive for all to anon
using(bucket_id<>'colony-history') with check(bucket_id<>'colony-history');
commit;
