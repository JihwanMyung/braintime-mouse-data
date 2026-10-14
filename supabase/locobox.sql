-- Apply after schema.sql, export-permissions.sql, manager-permissions.sql and iacuc.sql.
-- No source data, accounts, credentials or schedules are changed.
begin;
create or replace function colony_private.record_permissions(kind text,p jsonb)
returns text[] language plpgsql immutable set search_path='' as $$
declare permissions text[]:=array[]::text[]; event_kind text:=coalesce(p->>'event_type','');
begin
 if kind='mice' then return array['mice'];
 elsif kind in ('matings','litters') then return array['breeding'];
 elsif kind in ('cages','rooms','racks','locations','light_events') then return array['housing'];
 elsif kind='archive' then
   -- A reconstruction manifest can replace every source-backed domain.
   return array['imports','mice','breeding','housing','experiments','cryo','genetics','fees','iacuc'];
 elsif kind='husbandry_events' then
   if event_kind like 'iacuc_%' or p ?| array['iacuc_protocol','iacuc_assignment','iacuc_usage','iacuc_design'] then permissions:=array_append(permissions,'iacuc'); end if;
   if event_kind like 'experiment%' or p ?| array['experiment','experiment_sample','experiment_revision'] then permissions:=array_append(permissions,'experiments'); end if;
   if event_kind like 'cryopreservation%' or p ?| array['cryopreservation','cryopreservation_event'] then permissions:=array_append(permissions,'cryo'); end if;
   if event_kind in ('strain_definition','breeding_plan') or p ?| array['strain_definition','breeding_plan'] then permissions:=array_append(permissions,'genetics'); end if;
   if event_kind='breeding_options' or p ? 'breeding_options' then permissions:=array_append(permissions,'breeding'); end if;
   if event_kind ~ '^(lac_fee|fee|fees|billing)_' or p ?| array['lac_fee_options','lac_fee_month','fee_options','fee_month','fee_actual','fees','billing','billing_options','billing_month'] then permissions:=array_append(permissions,'fees'); end if;
   if event_kind like 'locobox_%' or p ?| array['locobox_protocol','locobox_revision'] then permissions:=array_append(permissions,'housing'); end if;
   if event_kind like 'cage_%' or p ? 'cage_summary_options' then permissions:=array_append(permissions,'housing'); end if;
   if cardinality(permissions)=0 then permissions:=array['housing']; end if;
   return permissions;
 end if;
 raise exception using errcode='22023',message='Unsupported record type';
end $$;
revoke all on function colony_private.record_permissions(text,jsonb) from public,anon,authenticated;

-- Typed Locobox protocols, source observations and append-only revisions.
create or replace function colony_private.locobox_text(p jsonb,keys text[],maximum integer)
returns void language plpgsql immutable set search_path='' as $$
declare k text;
begin foreach k in array keys loop
 if p->k is not null and p->k<>'null'::jsonb and (jsonb_typeof(p->k)<>'string' or length(p->>k)>maximum) then raise exception using errcode='22023',message='Locobox text exceeds its field limit';end if;
end loop;end $$;
revoke all on function colony_private.locobox_text(jsonb,text[],integer) from public,anon,authenticated;
create or replace function colony_private.locobox_number(p jsonb,k text,minimum numeric,maximum numeric)
returns void language plpgsql immutable set search_path='' as $$
begin if p->k is not null and p->k<>'null'::jsonb then
 if jsonb_typeof(p->k)<>'number' then raise exception using errcode='22023',message='Locobox quantities must be numeric or unknown';end if;
 if (p->>k)::numeric<minimum or (p->>k)::numeric>maximum then raise exception using errcode='22023',message='Locobox quantity is outside the supported range';end if;
end if;end $$;
revoke all on function colony_private.locobox_number(jsonb,text,numeric,numeric) from public,anon,authenticated;
create or replace function colony_private.locobox_interval(p jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare k text;
begin
 foreach k in array array['start','end'] loop
  if p->(k||'_date') is not null and p->(k||'_date')<>'null'::jsonb and colony_private.export_date(p->(k||'_date')) is null then raise exception using errcode='22023',message='Locobox dates must be valid ISO calendar dates';end if;
  if p->(k||'_time') is not null and p->(k||'_time')<>'null'::jsonb and (jsonb_typeof(p->(k||'_time'))<>'string' or p->>(k||'_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' or colony_private.export_date(p->(k||'_date')) is null) then raise exception using errcode='22023',message='Locobox clock times require HH:mm[:ss] and their calendar date';end if;
 end loop;
 if p->>'end_date'<p->>'start_date' or (p->>'end_date'=p->>'start_date' and (p->>'end_time')::time<=(p->>'start_time')::time) then raise exception using errcode='22023',message='Locobox exclusive end must follow its start';end if;
end $$;
revoke all on function colony_private.locobox_interval(jsonb) from public,anon,authenticated;
create or replace function colony_private.validate_locobox_payload(kind text,id text,p jsonb)
returns void language plpgsql stable set search_path='' as $$
declare tag text:=coalesce(p->>'event_type',''); nested jsonb; phase jsonb; treatment jsonb; measured jsonb; previous jsonb; k text; earliest date; phase_ids text[]:=array[]::text[]; treatment_ids text[]; n integer;
begin
 if tag not like 'locobox_%' and not (p ?| array['locobox_protocol','locobox_revision']) then return;end if;
 if kind<>'husbandry_events' or tag not in ('locobox_protocol','locobox_revision') or jsonb_typeof(p->tag) is distinct from 'object' or p ? (case tag when 'locobox_protocol' then 'locobox_revision' else 'locobox_protocol' end) or octet_length(p::text)>1500000 then raise exception using errcode='22023',message='Locobox records require one matching typed object';end if;
 nested:=p->tag;
 if nested->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='Unsupported Locobox schema version';end if;
 if p->'event_date' is not null and p->'event_date'<>'null'::jsonb and colony_private.export_date(p->'event_date') is null then raise exception using errcode='22023',message='Invalid Locobox event date';end if;
 if tag='locobox_revision' then
  if jsonb_typeof(nested->'entity_id') is distinct from 'string' or length(btrim(nested->>'entity_id')) not between 1 and 200 or colony_private.export_date(nested->'effective_date') is null or nested->>'effective_date' is distinct from p->>'event_date' or jsonb_typeof(nested->'before') is distinct from 'object' or jsonb_typeof(nested->'after') is distinct from 'object' then raise exception using errcode='22023',message='Locobox revision requires target, effective date and before/after snapshots';end if;
  return;
 end if;
 if nested->>'protocol_id' is distinct from id or jsonb_typeof(nested->'title') is distinct from 'string' or length(btrim(nested->>'title')) not between 1 and 500 then raise exception using errcode='22023',message='Locobox protocol identifier and title are required';end if;
 if coalesce(nested->>'status','') not in ('planned','active','completed','source') or coalesce(nested->>'evidence_status','') not in ('recorded','planned','source','unresolved') or coalesce(nested->>'link_status','') not in ('confirmed','unresolved') then raise exception using errcode='22023',message='Invalid Locobox status or evidence';end if;
 if nested->>'link_status'='confirmed' and coalesce(btrim(nested->>'cage_sid'),'')='' or nested->>'status'='source' and nested->>'evidence_status'<>'source' or nested->>'status'='active' and (nested->>'evidence_status'<>'recorded' or nested->>'link_status'<>'confirmed') then raise exception using errcode='22023',message='Active Locobox use requires recorded evidence and a confirmed cage association';end if;
 perform colony_private.locobox_text(nested,array['title','source_cage_label'],500);perform colony_private.locobox_text(nested,array['cage_sid','location_id'],200);perform colony_private.locobox_text(nested,array['notes'],10000);
 if jsonb_typeof(nested->'phases') is distinct from 'array' or jsonb_array_length(nested->'phases') not between 1 and 100 then raise exception using errcode='22023',message='Locobox requires 1 to 100 phases';end if;
 for phase in select value from jsonb_array_elements(nested->'phases') loop
  if jsonb_typeof(phase)<>'object' or jsonb_typeof(phase->'phase_id') is distinct from 'string' or length(btrim(phase->>'phase_id')) not between 1 and 200 or phase->>'phase_id'=any(phase_ids) then raise exception using errcode='22023',message='Locobox phase identifiers must be unique';end if;
  phase_ids:=array_append(phase_ids,phase->>'phase_id');perform colony_private.locobox_interval(phase);
  if phase->>'start_date' is not null then earliest:=least(earliest,(phase->>'start_date')::date);end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=phase->>'timezone') then raise exception using errcode='22023',message='Locobox phase requires an explicit IANA timezone';end if;
  if coalesce(phase->>'scheme','') not in ('LD','DD','LL','LP1','LP2','Custom','unknown') or coalesce(phase->>'duration_basis','') not in ('recorded','date_difference','unknown') then raise exception using errcode='22023',message='Invalid Locobox scheme or duration basis';end if;
  foreach k in array array['lights_on','lights_off'] loop
   if phase->k is not null and phase->k<>'null'::jsonb and (jsonb_typeof(phase->k)<>'string' or phase->>k !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' or phase->>'scheme' in ('DD','LL')) then raise exception using errcode='22023',message='Daily light clocks must be valid and are not used for continuous DD or LL';end if;
  end loop;
  perform colony_private.locobox_number(phase,'cycle_hours',0.000001,1000);perform colony_private.locobox_number(phase,'light_hours',0,1000);perform colony_private.locobox_number(phase,'transition_minutes',0,60000);perform colony_private.locobox_number(phase,'intensity_lux',0,1000000);perform colony_private.locobox_number(phase,'duration_days',0,100000);
  if (phase->>'light_hours')::numeric>(phase->>'cycle_hours')::numeric or phase->>'scheme'='DD' and (phase->>'light_hours')::numeric<>0 or phase->>'scheme'='LL' and (phase->>'light_hours')::numeric<>(phase->>'cycle_hours')::numeric then raise exception using errcode='22023',message='Locobox light duration conflicts with its cycle or scheme';end if;
  if phase->>'duration_basis'='date_difference' and (phase->>'start_date' is null or phase->>'end_date' is null or (phase->>'duration_days')::numeric is distinct from ((phase->>'end_date')::date-(phase->>'start_date')::date)::numeric) then raise exception using errcode='22023',message='Calculated Locobox duration must equal end date minus start date';end if;
  perform colony_private.locobox_text(phase,array['label'],500);perform colony_private.locobox_text(phase,array['notes','schedule_details'],10000);
  measured:=phase->'measured_phase';
  if jsonb_typeof(measured) is distinct from 'object' or coalesce(measured->>'basis','') not in ('CT','ZT','unknown') then raise exception using errcode='22023',message='Locobox measured phase requires CT, ZT or unknown basis';end if;
  if measured->>'measured_at' is not null then
   if jsonb_typeof(measured->'measured_at')<>'string' or measured->>'measured_at' !~ '^\d{4}-\d{2}-\d{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,3})?)?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$' or colony_private.export_date(to_jsonb(left(measured->>'measured_at',10))) is null then raise exception using errcode='22023',message='Measured phase requires an ISO datetime with UTC offset';end if;
  end if;
  perform colony_private.locobox_number(measured,'phase_hours',0,23.999999999);perform colony_private.locobox_text(measured,array['method'],500);perform colony_private.locobox_text(measured,array['notes'],10000);
  if measured->>'phase_hours' is not null and (measured->>'measured_at' is null or measured->>'basis' not in ('CT','ZT') or coalesce(btrim(measured->>'method'),'')='') then raise exception using errcode='22023',message='Measured phase value requires time, basis and method';end if;
  if jsonb_typeof(phase->'treatments') is distinct from 'array' or jsonb_array_length(phase->'treatments')>100 then raise exception using errcode='22023',message='Locobox treatment list is limited to 100 per phase';end if;
  treatment_ids:=array[]::text[];
  for treatment in select value from jsonb_array_elements(phase->'treatments') loop
   if jsonb_typeof(treatment)<>'object' or jsonb_typeof(treatment->'treatment_id') is distinct from 'string' or length(btrim(treatment->>'treatment_id')) not between 1 and 200 or treatment->>'treatment_id'=any(treatment_ids) or jsonb_typeof(treatment->'name') is distinct from 'string' or length(btrim(treatment->>'name')) not between 1 and 500 or coalesce(treatment->>'status','') not in ('planned','administered','cancelled','unknown') then raise exception using errcode='22023',message='Treatment name, unique identifier and status are required';end if;
   treatment_ids:=array_append(treatment_ids,treatment->>'treatment_id');perform colony_private.locobox_interval(treatment);perform colony_private.locobox_number(treatment,'dose',0,1000000000000);perform colony_private.locobox_number(treatment,'concentration',0,1000000000000);
   if treatment->>'dose' is not null and coalesce(btrim(treatment->>'dose_unit'),'')='' or treatment->>'concentration' is not null and coalesce(btrim(treatment->>'concentration_unit'),'')='' then raise exception using errcode='22023',message='Dose and concentration require units';end if;
   perform colony_private.locobox_text(treatment,array['name','dose_unit','concentration_unit','route','vehicle','delivery','frequency'],500);perform colony_private.locobox_text(treatment,array['notes'],10000);
   if treatment->>'start_date'<phase->>'start_date' or treatment->>'end_date'>phase->>'end_date' or treatment->>'start_date'>phase->>'end_date' or treatment->>'end_date'<phase->>'start_date'
    or treatment->>'start_date'=phase->>'start_date' and (treatment->>'start_time')::time<(phase->>'start_time')::time
    or treatment->>'end_date'=phase->>'end_date' and (treatment->>'end_time')::time>(phase->>'end_time')::time
    or treatment->>'start_date'=phase->>'end_date' and (treatment->>'start_time')::time>=(phase->>'end_time')::time
    or treatment->>'end_date'=phase->>'start_date' and (treatment->>'end_time')::time<=(phase->>'start_time')::time then raise exception using errcode='22023',message='Treatment dates extend outside their phase';end if;
  end loop;
  if previous is not null and phase->>'timezone' is distinct from previous->>'timezone' then raise exception using errcode='22023',message='One sequential cage timeline uses one timezone; create a separate record for a timezone change';end if;
  if previous is not null and (phase->>'start_date'<previous->>'start_date' or previous->>'end_date'>phase->>'start_date' or previous->>'end_date'=phase->>'start_date' and previous->>'timezone'=phase->>'timezone' and (previous->>'end_time')::time>(phase->>'start_time')::time) then raise exception using errcode='22023',message='Locobox phases must be chronological and cannot have a known overlap';end if;
  previous:=phase;
 end loop;
 if colony_private.export_date(p->'event_date') is distinct from earliest then raise exception using errcode='22023',message='Locobox event date must equal its earliest known phase start';end if;
end $$;
revoke all on function colony_private.validate_locobox_payload(text,text,jsonb) from public,anon,authenticated;
create or replace function colony_private.validate_locobox_record()
returns trigger language plpgsql set search_path='' as $$
declare k text; tag text:=new.payload->>'event_type';
begin
 perform colony_private.validate_locobox_payload(new.entity_type,new.entity_id,new.payload);
 if tg_op='UPDATE' and old.payload->>'event_type' like 'locobox_%' then
  if tag is distinct from old.payload->>'event_type' then raise exception using errcode='22023',message='Locobox record types cannot be changed';end if;
  if tag='locobox_revision' and new is distinct from old then raise exception using errcode='22023',message='Locobox revisions are append-only';end if;
  for k in select key from jsonb_each(old.payload) where key like 'source\_%' escape '\' loop
   if new.payload->k is distinct from old.payload->k then raise exception using errcode='22023',message='Preserve original Locobox source evidence';end if;
  end loop;
  if old.payload#>>'{locobox_protocol,status}'='source' and new.payload->'locobox_protocol' is distinct from old.payload->'locobox_protocol' then raise exception using errcode='22023',message='Source observations are read-only; create a reviewed protocol';end if;
 end if;
 if tag='locobox_protocol' then
  if new.payload#>>'{locobox_protocol,cage_sid}' is not null and not exists(select 1 from public.entity_records where colony_id=new.colony_id and entity_type='cages' and entity_id=new.payload#>>'{locobox_protocol,cage_sid}') then raise exception using errcode='22023',message='Locobox cage reference must exist in this colony';end if;
  if new.payload#>>'{locobox_protocol,location_id}' is not null and not exists(select 1 from public.entity_records where colony_id=new.colony_id and entity_type='locations' and entity_id=new.payload#>>'{locobox_protocol,location_id}') then raise exception using errcode='22023',message='Locobox position reference must exist in this colony';end if;
 end if;
 return new;
end $$;
revoke all on function colony_private.validate_locobox_record() from public,anon,authenticated;
drop trigger if exists entity_records_locobox_validate on public.entity_records;
create trigger entity_records_locobox_validate before insert or update on public.entity_records for each row execute function colony_private.validate_locobox_record();

-- Context-sensitive Locobox reports: nested intervals have independent date limits.
create or replace function colony_private.locobox_export_fields(p jsonb,keys text[])
returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(key,case when jsonb_typeof(value)='string' then to_jsonb(left(value#>>'{}',500)) else value end),'{}')
 from jsonb_each(case when jsonb_typeof(p)='object' then p else '{}' end)
 where key=any(keys) and jsonb_typeof(value) in ('string','number','boolean','null')
$$;
revoke all on function colony_private.locobox_export_fields(jsonb,text[]) from public,anon,authenticated;
create or replace function colony_private.locobox_export_interval(p jsonb,start_at date,end_at date,include_undated boolean)
returns jsonb language plpgsql immutable set search_path='' as $$
declare a date:=colony_private.export_date(p->'start_date'); b date:=colony_private.export_date(p->'end_date'); result jsonb:='{}'; withheld jsonb:='[]'; k text; d date;
begin
 if jsonb_typeof(p) is distinct from 'object' or end_at is null then return null;end if;
 if not coalesce((a between coalesce(start_at,'0001-01-01') and end_at) or (b between coalesce(start_at,'0001-01-01') and end_at) or (a is not null and b is not null and a<=end_at and (start_at is null or b>start_at or b=start_at and p->>'end_time'>'00:00:00')) or (a is null and b is null and include_undated and start_at is null),false) then return null;end if;
 foreach k in array array['start','end'] loop
  d:=case k when 'start' then a else b end;
  if d between coalesce(start_at,'0001-01-01') and end_at then
   result:=result||jsonb_build_object(k||'_date',d);
   if jsonb_typeof(p->(k||'_time'))='string' then result:=result||jsonb_build_object(k||'_time',p->(k||'_time'));end if;
  elsif d is not null then withheld:=withheld||to_jsonb(k);
  else result:=result||jsonb_build_object(k||'_date',null);end if;
 end loop;
 if jsonb_array_length(withheld)>0 then result:=result||jsonb_build_object('export_interval_clipped',true,'export_window_start',start_at,'export_window_end',end_at,'export_withheld_boundaries',withheld);end if;
 return result;
end $$;
revoke all on function colony_private.locobox_export_interval(jsonb,date,date,boolean) from public,anon,authenticated;
create or replace function colony_private.export_locobox_payload(p jsonb,start_at date,end_at date,include_undated boolean)
returns jsonb language plpgsql stable set search_path='' as $$
declare nested jsonb:=p->'locobox_protocol'; result jsonb; phases jsonb:='[]'; phase jsonb; item jsonb; span jsonb; treatment jsonb; treatment_span jsonb; treatments jsonb; phase_count integer:=0; treatment_count integer; measured jsonb; measured_date date; event_date date:=colony_private.export_date(p->'event_date');
begin
 if p->>'event_type' is distinct from 'locobox_protocol' or jsonb_typeof(nested) is distinct from 'object' then return null;end if;
 result:=colony_private.locobox_export_fields(p,array['event_id','event_type']);
 for phase in select value from jsonb_array_elements(case when jsonb_typeof(nested->'phases')='array' then nested->'phases' else '[]' end) loop
  span:=colony_private.locobox_export_interval(phase,start_at,end_at,include_undated);if span is null then continue;end if;phase_count:=phase_count+1;
  item:=colony_private.locobox_export_fields(phase,array['phase_id','label','timezone','scheme','cycle_hours','light_hours','lights_on','lights_off','transition_minutes','intensity_lux'])||span;
  if not (span ? 'export_interval_clipped') then item:=item||colony_private.locobox_export_fields(phase,array['duration_days','duration_basis']);end if;
  measured:=phase->'measured_phase';measured_date:=null;
  if jsonb_typeof(measured)='object' and measured->>'measured_at' ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then
   begin measured_date:=((measured->>'measured_at')::timestamptz at time zone (phase->>'timezone'))::date;exception when others then measured_date:=null;end;
   if measured_date between coalesce(start_at,'0001-01-01') and end_at then item:=item||jsonb_build_object('measured_phase',colony_private.locobox_export_fields(measured,array['measured_at','phase_hours','basis','method']));end if;
  end if;
  treatments:='[]';treatment_count:=0;
  for treatment in select value from jsonb_array_elements(case when jsonb_typeof(phase->'treatments')='array' then phase->'treatments' else '[]' end) loop
   treatment_span:=colony_private.locobox_export_interval(treatment,start_at,end_at,include_undated);if treatment_span is null then continue;end if;treatment_count:=treatment_count+1;
   if jsonb_array_length(treatments)<30 then treatments:=treatments||jsonb_build_array(colony_private.locobox_export_fields(treatment,array['treatment_id','name','status','dose','dose_unit','concentration','concentration_unit','route','vehicle','delivery','frequency'])||treatment_span);end if;
  end loop;
  item:=item||jsonb_build_object('treatments',treatments,'treatment_count',treatment_count,'treatments_truncated',jsonb_array_length(treatments)<treatment_count);
  if octet_length((phases||jsonb_build_array(item))::text)<=300000 then phases:=phases||jsonb_build_array(item);end if;
 end loop;
 if jsonb_array_length(phases)=0 then return null;end if;
 if event_date between coalesce(start_at,'0001-01-01') and end_at then result:=result||jsonb_build_object('event_date',event_date);
 elsif p->>'event_date' is not null then result:=result||jsonb_build_object('export_event_date_withheld',true);else result:=result||jsonb_build_object('event_date',null);end if;
 return result||jsonb_build_object('locobox_protocol',colony_private.locobox_export_fields(nested,array['schema_version','protocol_id','title','status','evidence_status','cage_sid','location_id','source_cage_label','link_status'])||jsonb_build_object('phases',phases,'phase_count',phase_count,'phases_truncated',jsonb_array_length(phases)<phase_count));
end $$;
revoke all on function colony_private.export_locobox_payload(jsonb,date,date,boolean) from public,anon,authenticated;

create or replace function public.export_records(
  p_colony_id uuid,p_scope text default 'current_housing',p_from_date date default null,p_to_date date default null,
  p_entity_types text[] default null,p_offset integer default 0,p_limit integer default 250
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permission jsonb; today date; cutoff date; start_at date; end_at date; kinds text[]; result jsonb; omitted integer; more boolean; include_undated boolean; revision text; zone_days jsonb:='{}';
begin
  permission:=public.get_export_permission(p_colony_id);today:=(permission->>'as_of_date')::date;cutoff:=(permission->>'cutoff_date')::date;
  if p_scope is null or p_scope not in ('current_housing','history') or p_offset is null or p_offset<0 or p_offset>1000000 or p_limit is null or p_limit not between 1 and 250 then
    raise exception using errcode='22023',message='Invalid export scope or page size'; end if;
  kinds:=coalesce(p_entity_types,case p_scope when 'current_housing' then array['mice','cages','rooms','racks','locations','light_events'] else array['mice','matings','litters','cages','rooms','racks','locations','light_events','husbandry_events'] end);
  if cardinality(kinds) not between 1 and 9 or exists(select 1 from unnest(kinds) k where k is null or k not in ('mice','matings','litters','cages','rooms','racks','locations','light_events','husbandry_events')) then
    raise exception using errcode='22023',message='Choose supported managed record types; raw archives are not part of this export'; end if;
  if p_scope='current_housing' and (p_from_date is not null or p_to_date is not null or exists(select 1 from unnest(kinds) k where k not in ('mice','cages','rooms','racks','locations','light_events'))) then
    raise exception using errcode='22023',message='Current housing is a current snapshot without historical date filters'; end if;
  end_at:=coalesce(p_to_date,today);start_at:=coalesce(p_from_date,cutoff);
  if p_scope='history' and (end_at>today or (start_at is not null and start_at>end_at)) then
    raise exception using errcode='22023',message='Export dates must be ordered and cannot exceed the current date'; end if;
  if p_scope='history' and cutoff is not null and (start_at<cutoff or end_at<cutoff) then
    raise exception using errcode='42501',message='The requested dates exceed your export permission'; end if;
  include_undated:=(permission->>'level'='max' and p_from_date is null);
  select coalesce(max(audit_id),0)::text into revision from public.audit_log where colony_id=p_colony_id;
  if p_scope='current_housing' and 'light_events'=any(kinds) then
    select coalesce(jsonb_object_agg(name,(current_timestamp at time zone name)::date),'{}') into zone_days
    from pg_catalog.pg_timezone_names where name=any(array(
      select distinct payload->>'timezone' from public.entity_records
      where colony_id=p_colony_id and entity_type='light_events' and not archived
    ));
  end if;
  with current_mice as materialized (
    select distinct payload->>'cage_sid' cage_sid from public.entity_records where colony_id=p_colony_id and entity_type='mice' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true' and payload->>'state'='Stock'
  ), current_locations as materialized (
    select entity_id from public.entity_records where colony_id=p_colony_id and entity_type='locations' and not archived and coalesce(payload->>'app_archived_at','')='' and coalesce(payload->>'archived','false')<>'true'
  ), eligible as (
    select r.entity_type,r.entity_id,r.payload,colony_private.export_domain_date(r.entity_type,r.payload) domain_date
    from public.entity_records r where r.colony_id=p_colony_id and r.entity_type=any(kinds)
    and (p_scope='history' or (not r.archived and coalesce(r.payload->>'app_archived_at','')='' and coalesce(r.payload->>'archived','false')<>'true' and (
      (r.entity_type='mice' and r.payload->>'state'='Stock') or
      (r.entity_type='cages' and (lower(r.payload->>'state') in ('active','occupied') or r.entity_id in(select cage_sid from current_mice) or r.payload->>'location_id' in(select entity_id from current_locations))) or
      r.entity_type in ('rooms','racks','locations') or
      (r.entity_type='light_events' and colony_private.export_light_current(r.payload,coalesce((zone_days->>(r.payload->>'timezone'))::date,today)))
    )))
  ), contextual as materialized (
    select *,case when entity_type='husbandry_events' and payload->>'event_type'='locobox_protocol' then colony_private.export_locobox_payload(payload,start_at,end_at,include_undated) else null end locobox_report from eligible
  ), selected as (
    select * from contextual where case
      when entity_type='husbandry_events' and payload->>'event_type'='locobox_revision' then false
      when entity_type='husbandry_events' and payload->>'event_type'='locobox_protocol' then locobox_report is not null
      else p_scope='current_housing' or (domain_date between coalesce(start_at,'0001-01-01'::date) and end_at) or (domain_date is null and include_undated) end
  ), page as (select * from selected order by entity_type collate "C",entity_id collate "C" offset p_offset limit p_limit+1), projected as (
    select entity_type,entity_id,jsonb_build_object('entity_type',entity_type,'entity_id',entity_id,'record_date',case when locobox_report is not null then colony_private.export_date(locobox_report->'event_date') else domain_date end,'payload',coalesce(locobox_report,colony_private.export_payload(entity_type,payload))) body from page
  ), numbered as (
    select *,row_number() over(order by entity_type collate "C",entity_id collate "C") n,
      sum(octet_length(body::text)) over(order by entity_type collate "C",entity_id collate "C") bytes from projected
  )
  select coalesce(jsonb_agg(body order by n) filter(where n<=p_limit and bytes<=800000),'[]'),
    coalesce(bool_or(n>p_limit or bytes>800000),false),(select count(*) from eligible where p_scope='history' and domain_date is null and not include_undated)
  into result,more,omitted from numbered;
  return jsonb_build_object('rows',result,'next_offset',case when more then p_offset+jsonb_array_length(result) else null end,'export_level',permission->>'level','cutoff_date',cutoff,'as_of_date',today,'captured_at',current_timestamp,'snapshot_revision',revision,
    'from_date',case when p_scope='history' then start_at else null end,'to_date',case when p_scope='history' then end_at else null end,'scope',p_scope,'excluded_undated',omitted);
end $$;
revoke all on function public.export_records(uuid,text,date,date,text[],integer,integer) from public,anon,authenticated;
grant execute on function public.export_records(uuid,text,date,date,text[],integer,integer) to authenticated;
commit;
