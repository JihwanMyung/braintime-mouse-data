-- Optional current ear identification. Apply after schema/export domain migrations.
-- Does not replace export_records or its fee-visibility authorization wrapper.
begin;
create or replace function colony_private.validate_ear_mark(kind text,p jsonb)
returns void language plpgsql immutable set search_path='' as $$
begin
 if kind='mice' and p ? 'ear_mark' and p->'ear_mark'<>'null'::jsonb then
  if jsonb_typeof(p->'ear_mark')<>'string' or char_length(p->>'ear_mark')>160 then
   raise exception using errcode='22023',message='Ear marking must be text of at most 160 characters, or null';
  end if;
 end if;
end $$;
revoke all on function colony_private.validate_ear_mark(text,jsonb) from public,anon,authenticated;

do $$begin
 if to_regprocedure('colony_private.validate_payload_before_ear_mark(text,text,jsonb)') is null then
  alter function colony_private.validate_payload(text,text,jsonb) rename to validate_payload_before_ear_mark;
 end if;
end $$;
create or replace function colony_private.validate_payload(p_type text,p_id text,p_payload jsonb)
returns void language plpgsql set search_path='' as $$
begin
 perform colony_private.validate_payload_before_ear_mark(p_type,p_id,p_payload);
 perform colony_private.validate_ear_mark(p_type,p_payload);
end $$;
revoke all on function colony_private.validate_payload(text,text,jsonb) from public,anon,authenticated;
revoke all on function colony_private.validate_payload_before_ear_mark(text,text,jsonb) from public,anon,authenticated;

-- Also covers administrator/direct imports that do not call save_record.
create or replace function colony_private.validate_mouse_ear_mark_record()
returns trigger language plpgsql set search_path='' as $$
begin perform colony_private.validate_ear_mark(new.entity_type,new.payload);return new;end $$;
drop trigger if exists entity_records_ear_mark_validate on public.entity_records;
create trigger entity_records_ear_mark_validate before insert or update on public.entity_records
 for each row execute function colony_private.validate_mouse_ear_mark_record();
revoke all on function colony_private.validate_mouse_ear_mark_record() from public,anon,authenticated;

do $$begin
 if to_regprocedure('colony_private.export_payload_before_ear_mark(text,jsonb)') is null then
  alter function colony_private.export_payload(text,jsonb) rename to export_payload_before_ear_mark;
 end if;
end $$;
create or replace function colony_private.export_payload(kind text,p jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb;
begin
 result:=colony_private.export_payload_before_ear_mark(kind,p);
 if kind='mice' and p ? 'ear_mark' then
  if p->'ear_mark'='null'::jsonb or (jsonb_typeof(p->'ear_mark')='string' and char_length(p->>'ear_mark')<=160) then
   result:=result||jsonb_build_object('ear_mark',p->'ear_mark');
  else result:=result-'ear_mark';end if;
 end if;
 return result;
end $$;
revoke all on function colony_private.export_payload(text,jsonb) from public,anon,authenticated;
revoke all on function colony_private.export_payload_before_ear_mark(text,jsonb) from public,anon,authenticated;
commit;
