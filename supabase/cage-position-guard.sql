-- Deferred final-placement validation permits atomic swaps while preventing overlap.
-- Existing ambiguous history is preserved; unrelated edits do not trigger this check.
begin;
create or replace function colony_private.cage_is_current(p_colony uuid,p_id text,p jsonb,p_archived boolean)
returns boolean language sql stable security definer set search_path='' as $$
 select not p_archived and coalesce(p->>'app_archived_at','')='' and coalesce(p->>'archived','false')<>'true'
 and (lower(coalesce(p->>'state','')) not in ('ended','inactive') or exists(
 select 1 from public.entity_records m where m.colony_id=p_colony and m.entity_type='mice' and not m.archived
 and coalesce(m.payload->>'app_archived_at','')='' and coalesce(m.payload->>'archived','false')<>'true'
 and m.payload->>'state'='Stock' and m.payload->>'cage_sid'=p_id))
$$;
revoke all on function colony_private.cage_is_current(uuid,text,jsonb,boolean) from public,anon,authenticated;
create or replace function colony_private.cage_position_check_target(kind text,p jsonb,is_archived boolean,old_p jsonb,old_archived boolean)
returns text language plpgsql immutable set search_path='' as $$
begin
 if kind='cages' and nullif(p->>'location_id','') is not null then
  if old_p is null or p->>'location_id' is distinct from old_p->>'location_id'
    or ((not is_archived and coalesce(p->>'app_archived_at','')='' and coalesce(p->>'archived','false')<>'true') and (old_archived or coalesce(old_p->>'app_archived_at','')<>'' or old_p->>'archived'='true'))
    or (lower(coalesce(p->>'state','')) not in ('ended','inactive') and lower(coalesce(old_p->>'state','')) in ('ended','inactive')) then return p->>'cage_sid';end if;
 elsif kind='mice' and p->>'state'='Stock' and not is_archived and coalesce(p->>'app_archived_at','')='' and coalesce(p->>'archived','false')<>'true' then
  if old_p is null or old_p->>'state' is distinct from 'Stock' or p->>'cage_sid' is distinct from old_p->>'cage_sid'
   or old_archived or coalesce(old_p->>'app_archived_at','')<>'' or old_p->>'archived'='true' then return nullif(p->>'cage_sid','');end if;
 end if;
 return null;
end $$;
revoke all on function colony_private.cage_position_check_target(text,jsonb,boolean,jsonb,boolean) from public,anon,authenticated;
create or replace function colony_private.lock_cage_position()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if colony_private.cage_position_check_target(new.entity_type,new.payload,new.archived,case when tg_op='UPDATE' then old.payload else null end,case when tg_op='UPDATE' then old.archived else false end) is not null then
  perform pg_advisory_xact_lock(hashtextextended('colony:'||new.colony_id::text,0));
  -- A no-value-change row write also creates a serialization conflict for an
  -- administrative REPEATABLE READ transaction with an obsolete snapshot.
  -- No colony name, membership or other stored field changes.
  update public.colonies set name=name where id=new.colony_id;
 end if;
 return new;
end $$;
revoke all on function colony_private.lock_cage_position() from public,anon,authenticated;
create or replace function colony_private.check_cage_position()
returns trigger language plpgsql security definer set search_path='' as $$
declare target text;cage public.entity_records%rowtype;position_id text;count_current integer;
begin
 target:=colony_private.cage_position_check_target(new.entity_type,new.payload,new.archived,case when tg_op='UPDATE' then old.payload else null end,case when tg_op='UPDATE' then old.archived else false end);
 if target is null then return null;end if;
 select * into cage from public.entity_records where colony_id=new.colony_id and entity_type='cages' and entity_id=target;
 if not found or not colony_private.cage_is_current(new.colony_id,target,cage.payload,cage.archived) then return null;end if;
 -- Existing active cages already count as occupied. Only an ended/inactive cage
 -- can become newly current through a Stock-animal assignment.
 if new.entity_type='mice' and lower(coalesce(cage.payload->>'state','')) not in ('ended','inactive') then return null;end if;
 position_id:=nullif(cage.payload->>'location_id','');if position_id is null then return null;end if;
 select count(*) into count_current from public.entity_records c where c.colony_id=new.colony_id and c.entity_type='cages' and c.payload->>'location_id'=position_id and colony_private.cage_is_current(c.colony_id,c.entity_id,c.payload,c.archived);
 if count_current>1 then raise exception using errcode='23505',message='Position '||position_id||' already has another current cage. Reload the rack and review the move.';end if;
 return null;
end $$;
revoke all on function colony_private.check_cage_position() from public,anon,authenticated;
drop trigger if exists lock_cage_position on public.entity_records;
create trigger lock_cage_position before insert or update on public.entity_records for each row when (new.entity_type in ('cages','mice')) execute function colony_private.lock_cage_position();
drop trigger if exists check_cage_position on public.entity_records;
create constraint trigger check_cage_position after insert or update on public.entity_records deferrable initially deferred for each row when (new.entity_type in ('cages','mice')) execute function colony_private.check_cage_position();
commit;
