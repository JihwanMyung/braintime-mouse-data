-- Apply after schema.sql, export-permissions.sql and manager-permissions.sql.
-- Adds typed IACUC records and one owner-controlled manager permission; no source data.
begin;
create or replace function colony_private.default_manager_permissions()
returns jsonb language sql immutable set search_path='' as $$
 select '{"mice":true,"breeding":true,"housing":true,"experiments":true,"cryo":true,"genetics":true,"imports":true,"archive":true,"fees":true,"iacuc":true}'::jsonb
$$;
revoke all on function colony_private.default_manager_permissions() from public,anon,authenticated;
create or replace function colony_private.valid_manager_permissions(p jsonb)
returns boolean language sql immutable set search_path='' as $$
 select jsonb_typeof(p)='object' and p ?& array['mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees','iacuc']
 and not exists(select 1 from jsonb_each(p) where key not in ('mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees','iacuc') or jsonb_typeof(value)<>'boolean')
$$;
revoke all on function colony_private.valid_manager_permissions(jsonb) from public,anon,authenticated;
alter table public.memberships add column if not exists permissions jsonb not null default '{"mice":true,"breeding":true,"housing":true,"experiments":true,"cryo":true,"genetics":true,"imports":true,"archive":true,"fees":true,"iacuc":true}'::jsonb;
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check check(role in ('owner','editor','viewer','manager'));
alter table public.memberships drop constraint if exists memberships_permissions_check;
alter table public.memberships alter column permissions set default '{"mice":true,"breeding":true,"housing":true,"experiments":true,"cryo":true,"genetics":true,"imports":true,"archive":true,"fees":true,"iacuc":true}'::jsonb;
update public.memberships set permissions=jsonb_build_object('iacuc',true)||permissions where not (permissions ? 'iacuc');
alter table public.memberships add constraint memberships_permissions_check check(colony_private.valid_manager_permissions(permissions));

create or replace function colony_private.has_permission(p_colony_id uuid,p_permission text)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select case when m.role in ('owner','editor') then true
   when m.role='manager' then m.permissions->p_permission='true'::jsonb else false end
   from public.memberships m where m.colony_id=p_colony_id and m.user_id=auth.uid() and m.active),false)
   and p_permission in ('mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees','iacuc')
$$;
revoke all on function colony_private.has_permission(uuid,text) from public,anon,authenticated;
grant execute on function colony_private.has_permission(uuid,text) to authenticated;

-- Check both the stored and proposed payload; changing event_type cannot evade
-- a disabled section. Presence of nested domain data also requires that section.
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

create or replace function colony_private.assert_record_permission(p_colony_id uuid,kind text,p jsonb,old_p jsonb,p_archived boolean,old_archived boolean)
returns void language plpgsql security definer set search_path='' as $$
declare role text:=colony_private.current_role(p_colony_id); permission text; required text[]; field_name text; field_group text; field_names text[];
begin
 -- User identities and display aliases are owner-managed even for editors.
 if kind='husbandry_events' and (coalesce(p->>'event_type','') like 'user_acronym%' or p ? 'user_acronym'
   or coalesce(old_p->>'event_type','') like 'user_acronym%' or old_p ? 'user_acronym') and role is distinct from 'owner' then
   raise exception using errcode='42501',message='Only the owner can manage user acronyms'; end if;
 if role in ('owner','editor') then return; end if;
 if role is distinct from 'manager' then raise exception using errcode='42501',message='Active colony write membership is required'; end if;
 required:=colony_private.record_permissions(kind,p);
 if old_p is not null then required:=required||colony_private.record_permissions(kind,old_p); end if;
 -- Mice/mating/litter forms can also move animals, alter genetics or parentage.
 -- Authorize the changed fields, not merely the screen or entity containing them.
 foreach field_group in array array['housing','genetics','breeding'] loop
   field_names:=case field_group
     when 'housing' then array['cage_sid','cage_tag','room_id','rack_id','location_id','room','rack','location','location_label']
     when 'genetics' then array['genotype','genetic_profile','mouseline','strain','strain_code','genotype_status','genotyping_status','genotype_date']
     else array['sire_sids','dam_sids','litter_sid','mating_sid'] end;
   if kind in ('mice','matings','litters') and (field_group='housing' or kind='mice') then
     foreach field_name in array field_names loop
       if coalesce(p->field_name,'null'::jsonb) is distinct from coalesce(old_p->field_name,'null'::jsonb)
         and (old_p is not null or coalesce(p->field_name,'null'::jsonb) not in ('null'::jsonb,'[]'::jsonb,'{}'::jsonb,'""'::jsonb)) then
         required:=array_append(required,field_group); exit;
       end if;
     end loop;
   end if;
 end loop;
 -- Protocol references on ordinary forms also affect IACUC associations.
 if kind in ('mice','cages','matings','litters') then
  foreach field_name in array case when kind='cages' then array['protocol','cage_protocol'] else array['protocol'] end loop
   if coalesce(p->field_name,'null'::jsonb) is distinct from coalesce(old_p->field_name,'null'::jsonb)
    and (old_p is not null or coalesce(p->field_name,'null'::jsonb) not in ('null'::jsonb,'""'::jsonb)) then required:=array_append(required,'iacuc');end if;
  end loop;
 elsif kind='husbandry_events' then
  foreach field_name in array array['experiment','experiment_sample'] loop
   if coalesce(p#>array[field_name,'protocol'],'null'::jsonb) is distinct from coalesce(old_p#>array[field_name,'protocol'],'null'::jsonb)
    and (old_p is not null or coalesce(p#>array[field_name,'protocol'],'null'::jsonb) not in ('null'::jsonb,'""'::jsonb)) then required:=array_append(required,'iacuc');end if;
  end loop;
 end if;
 if p_archived or p_archived is distinct from old_archived or coalesce(p->'app_archived_at','null'::jsonb) is distinct from coalesce(old_p->'app_archived_at','null'::jsonb)
   or coalesce(p->'archived','false'::jsonb) is distinct from coalesce(old_p->'archived','false'::jsonb) then required:=array_append(required,'archive'); end if;
 -- Newly imported operational rows require imports as well as their section.
 -- App-created reviewed observations may reference sources without being a bulk import.
 if old_p is null and p ? 'record_origin' and p->>'record_origin'<>'app_created' then required:=array_append(required,'imports'); end if;
 foreach permission in array required loop
   if not colony_private.has_permission(p_colony_id,permission) then
     raise exception using errcode='42501',message='Manager permission required: '||permission;
   end if;
 end loop;
end $$;
revoke all on function colony_private.assert_record_permission(uuid,text,jsonb,jsonb,boolean,boolean) from public,anon,authenticated;


create or replace function colony_private.iacuc_valid_date(v jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare d date;
begin
 if v is null or v='null'::jsonb then return true;end if;
 if jsonb_typeof(v)<>'string' or v#>>'{}' !~ '^\d{4}-\d{2}-\d{2}$' then return false;end if;
 begin d:=(v#>>'{}')::date;exception when others then return false;end;
 return to_char(d,'YYYY-MM-DD')=v#>>'{}';
end $$;
revoke all on function colony_private.iacuc_valid_date(jsonb) from public,anon,authenticated;
create or replace function colony_private.iacuc_nonnegative_integer(v jsonb)
returns boolean language sql immutable set search_path='' as $$
 select v is null or v='null'::jsonb or (jsonb_typeof(v)='number' and v::text ~ '^\d+$' and length(v::text)<=8)
$$;
revoke all on function colony_private.iacuc_nonnegative_integer(jsonb) from public,anon,authenticated;
create or replace function colony_private.validate_iacuc_payload(kind text,id text,p jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare tag text:=coalesce(p->>'event_type',''); nested jsonb; k text; v jsonb; x jsonb; names text[]:=array['iacuc_protocol','iacuc_assignment','iacuc_usage','iacuc_design']; count_keys integer;
begin
 if tag not like 'iacuc_%' and not (p ?| names) then return;end if;
 select count(*) into count_keys from unnest(names) n where p ? n;
 if kind<>'husbandry_events' or tag<>all(names) or count_keys<>1 or not (p ? tag) or jsonb_typeof(p->tag) is distinct from 'object' or octet_length(p::text)>1500000 then raise exception using errcode='22023',message='IACUC records require one matching typed object';end if;
 nested:=p->tag;
 if nested->'schema_version' is distinct from '1'::jsonb or jsonb_typeof(nested->'protocol_id') is distinct from 'string' or length(btrim(nested->>'protocol_id')) not between 1 and 200 or nested->>'protocol_id'<>btrim(nested->>'protocol_id') then raise exception using errcode='22023',message='IACUC schema version and protocol reference are required';end if;
 if not colony_private.iacuc_valid_date(p->'event_date') then raise exception using errcode='22023',message='IACUC event dates must be valid ISO calendar dates';end if;
 foreach k in array array['start_date','end_date','valid_from','valid_to','event_date'] loop
  if not colony_private.iacuc_valid_date(nested->k) then raise exception using errcode='22023',message='Invalid IACUC calendar date';end if;
 end loop;
 if nested->>'end_date'<nested->>'start_date' or nested->>'valid_to'<nested->>'valid_from' then raise exception using errcode='22023',message='IACUC end dates cannot precede start dates';end if;
 if nested ? 'notes' and nested->'notes'<>'null'::jsonb and (jsonb_typeof(nested->'notes')<>'string' or length(nested->>'notes')>20000) then raise exception using errcode='22023',message='IACUC notes must be text';end if;
 if nested ? 'source_refs' and (jsonb_typeof(nested->'source_refs')<>'array' or jsonb_array_length(nested->'source_refs')>200) then raise exception using errcode='22023',message='IACUC source references must be a bounded list';end if;
 if tag='iacuc_protocol' then
  if nested->>'protocol_id' is distinct from id or coalesce(nested->>'status','') not in ('draft','submitted','approved','expired','closed','unknown') then raise exception using errcode='22023',message='Protocol identifier must match its record and status must be recognized';end if;
  if not colony_private.iacuc_nonnegative_integer(nested->'approved_animals') then raise exception using errcode='22023',message='Approved animal count must be a nonnegative integer or unknown';end if;
  if nullif(btrim(nested->>'source_url'),'') is not null and nested->>'source_url' !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' then raise exception using errcode='22023',message='Protocol source links must use HTTPS';end if;
  foreach k in array array['number','title','title_en','pi','source_url','source_accessed_at'] loop
   if nested ? k and nested->k<>'null'::jsonb and (jsonb_typeof(nested->k)<>'string' or length(nested->>k)>10000) then raise exception using errcode='22023',message='Protocol metadata must be text';end if;
  end loop;
  if nested ? 'aliases' and (jsonb_typeof(nested->'aliases')<>'array' or jsonb_array_length(nested->'aliases')>100 or exists(select 1 from jsonb_array_elements(nested->'aliases') a where jsonb_typeof(a)<>'string' or length(a#>>'{}')>200)) then raise exception using errcode='22023',message='Protocol aliases must be bounded text identifiers';end if;
  if nested ? 'allocations' and (jsonb_typeof(nested->'allocations')<>'array' or jsonb_array_length(nested->'allocations')>200) then raise exception using errcode='22023',message='Protocol allocations must be a bounded list';end if;
  for x in select value from jsonb_array_elements(coalesce(nested->'allocations','[]')) loop
   if jsonb_typeof(x)<>'object' or jsonb_typeof(x->'id') is distinct from 'string' or length(btrim(x->>'id')) not between 1 and 200 then raise exception using errcode='22023',message='Each protocol allocation needs an identifier';end if;
   foreach k in array array['approved','portal_used','portal_pending'] loop
    if not colony_private.iacuc_nonnegative_integer(x->k) then raise exception using errcode='22023',message='Allocation counts must be nonnegative integers or unknown';end if;
   end loop;
   if x ? 'portal_remaining' and x->'portal_remaining'<>'null'::jsonb and (jsonb_typeof(x->'portal_remaining')<>'number' or x->>'portal_remaining' !~ '^-?\d{1,8}$') then raise exception using errcode='22023',message='Remaining allocation count must be an integer or unknown';end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(coalesce(nested->'allocations','[]')) a group by a->>'id' having count(*)>1) then raise exception using errcode='22023',message='Duplicate protocol allocation identifiers';end if;
  if nested ? 'document' and nested->'document'<>'null'::jsonb then
   if jsonb_typeof(nested->'document')<>'object' then raise exception using errcode='22023',message='Protocol document must be an object';end if;
   for k,v in select key,value from jsonb_each(nested->'document') loop
    if k not in ('filename','sha256','text','source_url') or (v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or length(v#>>'{}')>case when k='text' then 300000 else 2048 end)) then raise exception using errcode='22023',message='Invalid protocol document metadata or text size';end if;
   end loop;
   if nullif(btrim(nested#>>'{document,source_url}'),'') is not null and nested#>>'{document,source_url}' !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' then raise exception using errcode='22023',message='Protocol document links must use HTTPS';end if;
   if nested#>>'{document,sha256}' is not null and nested#>>'{document,sha256}' !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='Document checksum must be SHA-256';end if;
  end if;
  if nested ? 'sections' and nested->'sections'<>'null'::jsonb then
   if jsonb_typeof(nested->'sections')<>'object' then raise exception using errcode='22023',message='Protocol sections must be an object';end if;
   for k,v in select key,value from jsonb_each(nested->'sections') loop
    if k not in ('aims','justification','experimental_design','animal_procedures','breeding','monitoring','humane_endpoints','anesthesia','analgesia','euthanasia','replacement','reduction','refinement','personnel','notes') or (v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or length(v#>>'{}')>100000)) then raise exception using errcode='22023',message='Protocol sections must contain bounded text';end if;
   end loop;
  end if;
 elsif tag='iacuc_assignment' then
  if coalesce(nested->>'entity_type','') not in ('mice','cages','matings','litters','experiments') or jsonb_typeof(nested->'entity_id') is distinct from 'string' or length(btrim(nested->>'entity_id')) not between 1 and 200 or coalesce(nested->>'purpose','') not in ('housing','breeding','experiment') or coalesce(nested->>'evidence_status','') not in ('confirmed','source','unresolved') then raise exception using errcode='22023',message='Invalid IACUC assignment target, purpose or evidence status';end if;
 elsif tag='iacuc_usage' then
  if coalesce(nested->>'category','') not in ('used','bred') or coalesce(nested->>'evidence_status','') not in ('confirmed','source','unresolved') or not colony_private.iacuc_nonnegative_integer(nested->'unregistered_count') then raise exception using errcode='22023',message='Invalid IACUC usage category, evidence or unregistered count';end if;
  if nested->>'event_date' is distinct from p->>'event_date' then raise exception using errcode='22023',message='Usage event date must match its report date';end if;
  if jsonb_typeof(nested->'mouse_sids') is distinct from 'array' or jsonb_array_length(nested->'mouse_sids')>10000 or exists(select 1 from jsonb_array_elements(nested->'mouse_sids') a where jsonb_typeof(a)<>'string' or length(btrim(a#>>'{}')) not between 1 and 200) then raise exception using errcode='22023',message='IACUC mouse references must be a bounded identifier list';end if;
  if exists(select 1 from jsonb_array_elements(nested->'mouse_sids') a group by a having count(*)>1) then raise exception using errcode='22023',message='A mouse can appear only once within one usage entry';end if;
 elsif tag='iacuc_design' then
  foreach k in array array['breeding_inputs','breeding_results'] loop
   if nested ? k and nested->k<>'null'::jsonb and (jsonb_typeof(nested->k)<>'object' or octet_length((nested->k)::text)>100000) then raise exception using errcode='22023',message='Breeding planning inputs and results must be bounded objects';end if;
  end loop;
  if jsonb_typeof(nested->'inputs') is distinct from 'object' or jsonb_typeof(nested->'results') is distinct from 'object' or octet_length((nested->'inputs')::text)>100000 or octet_length((nested->'results')::text)>100000 then raise exception using errcode='22023',message='IACUC planning inputs and results must be bounded objects';end if;
 end if;
end $$;
revoke all on function colony_private.validate_iacuc_payload(text,text,jsonb) from public,anon,authenticated;
create or replace function colony_private.validate_iacuc_record()
returns trigger language plpgsql set search_path='' as $$
begin
 perform colony_private.validate_iacuc_payload(new.entity_type,new.entity_id,new.payload);
 -- Retyping an established IACUC record cannot remove its typed identity.
 if tg_op='UPDATE' and old.payload->>'event_type' like 'iacuc_%' and new.payload->>'event_type' is distinct from old.payload->>'event_type' then raise exception using errcode='22023',message='IACUC record types cannot be changed';end if;
 return new;
end $$;
revoke all on function colony_private.validate_iacuc_record() from public,anon,authenticated;
drop trigger if exists entity_records_iacuc_validate on public.entity_records;
create trigger entity_records_iacuc_validate before insert or update on public.entity_records for each row execute function colony_private.validate_iacuc_record();

create or replace function colony_private.iacuc_export_numeric_arrays(p jsonb,keys text[])
returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb:='{}';k text;items jsonb;
begin
 foreach k in array keys loop
  if jsonb_typeof(p->k)='array' then
   select coalesce(jsonb_agg(value),'[]') into items from (select value from jsonb_array_elements(p->k) where jsonb_typeof(value)='number' limit 100) a;
   result:=result||jsonb_build_object(k,items);
  end if;
 end loop;return result;
end $$;
revoke all on function colony_private.iacuc_export_numeric_arrays(jsonb,text[]) from public,anon,authenticated;
create or replace function colony_private.iacuc_export_design_part(p jsonb,part text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb;adjustment jsonb;
begin
 if part='inputs' then
  result:=colony_private.export_fields(p,array['design','variance','mean1','mean2','effect','sd','sd1','sd2','sdDifference','correlation','alpha','power','allocationRatio','experimentalUnit','animalsPerUnit','technicalReplicates','attrition','maxUnitsPerGroup','n1','n2','target','genotypeProbability','sexProbability','survivalProbability','confidence','maxOffspring','litterSize','littersPerPair']);
  if jsonb_typeof(p->'cluster')='object' then result:=result||jsonb_build_object('cluster',colony_private.export_fields(p->'cluster',array['animalsPerCage','icc','cages_per_group','approximate','power_recomputed','attrition_basis','whole_cage_loss_modeled']));end if;
 else
  result:=colony_private.export_fields(p,array['status','method','approximate','n1','n2','achieved_power','previous_power','df','critical','noncentrality','standard_error','alpha','target_power','effect','sd_difference','power','sidedness','usable_probability','expected_offspring','expected_offspring_rounded','confidence_offspring','achieved_probability','previous_probability','expected_litters','confidence_litters','expected_pairs','confidence_pairs','expected_unusable_at_confidence_count','breeder_animals','errors','warnings','assumptions']);
  if jsonb_typeof(p->'allocation')='object' then result:=result||jsonb_build_object('allocation',colony_private.export_fields(p->'allocation',array['rule','requested_ratio','actual_ratio']));end if;
  if jsonb_typeof(p->'maximum_checked')='object' then result:=result||jsonb_build_object('maximum_checked',colony_private.export_fields(p->'maximum_checked',array['n1','n2','power','offspring','probability']));end if;
  if jsonb_typeof(p->'adjustment')='object' then
   adjustment:=colony_private.export_fields(p->'adjustment',array['analyzed_units_per_group','independent_equivalent_units_per_group','experimental_unit','recruited_units_per_group','animals_per_group','total_animals','animals_per_unit','technical_replicates','measurement_count','attrition','attrition_basis','design_effect'])||colony_private.iacuc_export_numeric_arrays(p->'adjustment',array['analyzed_units_per_group', 'independent_equivalent_units_per_group', 'recruited_units_per_group', 'animals_per_group', 'cages_per_group']);
   if jsonb_typeof(p#>'{adjustment,cluster}')='object' then adjustment:=adjustment||jsonb_build_object('cluster',colony_private.export_fields(p#>'{adjustment,cluster}',array['animalsPerCage','icc','cages_per_group','approximate','power_recomputed','attrition_basis','whole_cage_loss_modeled'])||colony_private.iacuc_export_numeric_arrays(p#>'{adjustment,cluster}',array['cages_per_group']));end if;
   result:=result||jsonb_build_object('adjustment',adjustment);
  end if;
 end if;return result;
end $$;
revoke all on function colony_private.iacuc_export_design_part(jsonb,text) from public,anon,authenticated;

create or replace function colony_private.export_payload(kind text,p jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare keys text[]; result jsonb; nested jsonb; source_items jsonb; items jsonb;
begin
  keys:=case kind
    when 'mice' then array['mouse_sid','physical_tag','ear_mark','sex','state','mouseline','genotype','date_of_birth','end_date','wean_date','sire_sids','dam_sids','litter_sid','cage_sid','cage_tag','manager','owner']
    when 'matings' then array['mating_sid','state','male_sids','female_sids','sire_sids','dam_sids','set_up_date','disbanded_date','cage_sid','cage_tag','owner']
    when 'litters' then array['litter_sid','state','date_of_birth','wean_date','end_date','mating_sid','sire_sids','dam_sids','size_reported','male_count','female_count','unknown_count','cage_sid']
    when 'cages' then array['cage_sid','cage_tag','state','cage_type','room_id','rack_id','location_id','room','rack','location','capacity','manager','owner','set_up_date','end_date']
    when 'rooms' then array['room_id','name','label','source_current','source_last_seen_at']
    when 'racks' then array['rack_id','room_id','name','label','source_current','source_last_seen_at']
    when 'locations' then array['location_id','room_id','rack_id','label','row','column','capacity','source_current','source_last_seen_at','source_manager_name','source_manager_acronym','source_manager_status']
    when 'light_events' then array['event_id','start_date','end_date','protocol','cycle_hours','light_hours','lights_on','lights_off','transition_minutes','intensity_lux','timezone','evidence_status','interval_semantics','actual_exposure_verified','room_id','rack_id','location_id','cage_sid','source_current','source_last_seen_at']
    when 'husbandry_events' then array['event_id','event_type','event_date','mouse_sid','cage_sid','old_cage_sid','room_id','rack_id','location_id','old_room_id','old_rack_id','old_location_id','location_label','old_location_label']
    else array[]::text[] end;
  result:=colony_private.export_fields(p,keys);
  if kind='locations' then
    result:=result||jsonb_build_object('record_origin',case when p->>'record_origin'='app_created' then 'app_created' else 'source_recorded' end);
  end if;
  if kind='husbandry_events' and p->>'event_type'='iacuc_protocol' then
    nested:=colony_private.export_fields(p->'iacuc_protocol',array['schema_version','protocol_id','number','aliases','title','title_en','pi','status','start_date','end_date','approved_animals']);
    source_items:=case when jsonb_typeof(p#>'{iacuc_protocol,allocations}')='array' then p#>'{iacuc_protocol,allocations}' else '[]'::jsonb end;
    select coalesce(jsonb_agg(colony_private.export_fields(value,array['id','species','strain','approved','portal_used','portal_pending','portal_remaining'])),'[]') into items from (select value from jsonb_array_elements(source_items) where jsonb_typeof(value)='object' limit 100) a;
    result:=result||jsonb_build_object('iacuc_protocol',nested||jsonb_build_object('allocations',items,'allocation_count',jsonb_array_length(source_items),'allocations_truncated',jsonb_array_length(items)<jsonb_array_length(source_items)));
  elsif kind='husbandry_events' and p->>'event_type'='iacuc_assignment' then
    nested:=colony_private.export_fields(p->'iacuc_assignment',array['schema_version','protocol_id','entity_type','entity_id','purpose','valid_from','valid_to','evidence_status']);
    result:=result||jsonb_build_object('iacuc_assignment',nested);
  elsif kind='husbandry_events' and p->>'event_type'='iacuc_usage' then
    nested:=colony_private.export_fields(p->'iacuc_usage',array['schema_version','protocol_id','category','mouse_sids','unregistered_count','event_date','experiment_id','litter_sid','evidence_status']);
    source_items:=case when jsonb_typeof(p#>'{iacuc_usage,mouse_sids}')='array' then p#>'{iacuc_usage,mouse_sids}' else '[]'::jsonb end;
    nested:=nested||jsonb_build_object('mouse_count',jsonb_array_length(source_items),'mouse_sids_truncated',jsonb_array_length(source_items)>coalesce(jsonb_array_length(nested->'mouse_sids'),0));
    result:=result||jsonb_build_object('iacuc_usage',nested);
  elsif kind='husbandry_events' and p->>'event_type'='iacuc_design' then
    nested:=colony_private.export_fields(p->'iacuc_design',array['schema_version','protocol_id','label','title','method','calculated_at']);
    nested:=nested||jsonb_build_object('inputs',colony_private.iacuc_export_design_part(p#>'{iacuc_design,inputs}','inputs')||case when jsonb_typeof(p#>'{iacuc_design,inputs,sample_size}')='object' then jsonb_build_object('sample_size',colony_private.iacuc_export_design_part(p#>'{iacuc_design,inputs,sample_size}','inputs')) else '{}'::jsonb end||case when jsonb_typeof(p#>'{iacuc_design,inputs,breeding}')='object' then jsonb_build_object('breeding',colony_private.iacuc_export_design_part(p#>'{iacuc_design,inputs,breeding}','inputs')) else '{}'::jsonb end);
    nested:=nested||jsonb_build_object('results',colony_private.iacuc_export_design_part(p#>'{iacuc_design,results}','results')||case when jsonb_typeof(p#>'{iacuc_design,results,sample_size}')='object' then jsonb_build_object('sample_size',colony_private.iacuc_export_design_part(p#>'{iacuc_design,results,sample_size}','results')) else '{}'::jsonb end||case when jsonb_typeof(p#>'{iacuc_design,results,breeding}')='object' then jsonb_build_object('breeding',colony_private.iacuc_export_design_part(p#>'{iacuc_design,results,breeding}','results')) else '{}'::jsonb end);
    if jsonb_typeof(p#>'{iacuc_design,breeding_inputs}')='object' then nested:=nested||jsonb_build_object('breeding_inputs',colony_private.iacuc_export_design_part(p#>'{iacuc_design,breeding_inputs}','inputs'));end if;
    if jsonb_typeof(p#>'{iacuc_design,breeding_results}')='object' then nested:=nested||jsonb_build_object('breeding_results',colony_private.iacuc_export_design_part(p#>'{iacuc_design,breeding_results}','results'));end if;
    result:=result||jsonb_build_object('iacuc_design',nested);
  elsif kind='husbandry_events' and p->>'event_type'='lac_fee_options' then
    nested:=colony_private.export_fields(p->'lac_fee_options',array['schema_version','effective_from','currency','target_percent','maximum_percent','excluded_room_ids','revision']);
    source_items:=case when jsonb_typeof(p#>'{lac_fee_options,groups}')='array' then p#>'{lac_fee_options,groups}' else '[]'::jsonb end;
    select coalesce(jsonb_agg(colony_private.export_fields(value,array['key','label','unit','room_ids','rack_ids','rate','rate_period','rate_reference'])),'[]') into items
      from (select value from jsonb_array_elements(source_items) where jsonb_typeof(value)='object' limit 100) a;
    result:=result||jsonb_build_object('lac_fee_options',nested||jsonb_build_object('groups',items,'groups_count',jsonb_array_length(source_items),'groups_truncated',jsonb_array_length(items)<jsonb_array_length(source_items)));
  elsif kind='husbandry_events' and p->>'event_type'='lac_fee_month' then
    nested:=colony_private.export_fields(p->'lac_fee_month',array['schema_version','month','currency','actual_total','actual_date','invoice_reference','revision']);
    source_items:=case when jsonb_typeof(p#>'{lac_fee_month,lines}')='array' then p#>'{lac_fee_month,lines}' else '[]'::jsonb end;
    select coalesce(jsonb_agg(colony_private.export_fields(value,array['group_key','quantity','quantity_unit','evidence_kind','evidence_start','evidence_end','evidence_reference','quantity_basis','quantity_note','snapshot_count','actual_amount'])),'[]') into items
      from (select value from jsonb_array_elements(source_items) where jsonb_typeof(value)='object' limit 100) a;
    result:=result||jsonb_build_object('lac_fee_month',nested||jsonb_build_object('lines',items,'lines_count',jsonb_array_length(source_items),'lines_truncated',jsonb_array_length(items)<jsonb_array_length(source_items)));
  elsif kind='husbandry_events' and p->>'event_type'='cryopreservation_lot' then
    nested:=colony_private.export_fields(p->'cryopreservation',array['schema_version','case_id','label','strain','background','modification_method','gene','zygosity','origin','batch_ids','frozen_date','material','status','manager','quantity','quantity_unit','quantity_as_of_date','donor_mouse_sids']);
    nested:=nested||jsonb_build_object('storage_location',colony_private.export_fields(p#>'{cryopreservation,storage_location}',array['facility','tank','canister','position']));
    result:=result||jsonb_build_object('cryopreservation',nested);
  elsif kind='husbandry_events' and p->>'event_type'='cryopreservation_event' then
    result:=result||jsonb_build_object('cryopreservation_event',colony_private.export_fields(p->'cryopreservation_event',array['schema_version','lot_id','activity_type','quantity','quantity_unit','recovery_status','recovered_mouse_sids']));
  elsif kind='husbandry_events' and p->>'event_type'='experiment' then
    nested:=colony_private.export_fields(p->'experiment',array['schema_version','title','assays','status','project','operator','protocol','started_at','ended_at','timezone','circadian_time','time_basis','circadian_time_source','decapitation_at','decapitation_circadian_time','decapitation_time_basis','decapitation_circadian_time_source','sampling_at','sampling_circadian_time','sampling_time_basis','sampling_circadian_time_source','result_urls']);
    nested:=nested||jsonb_build_object('entrainment',colony_private.export_fields(p#>'{experiment,entrainment}',array['scheme','light_event_id','reference_at','reference_phase','phase_basis','phase_scale','period_hours','timezone','start_date','end_date','duration_days','duration_basis']));
    source_items:=case when jsonb_typeof(p#>'{experiment,participants}')='array' then p#>'{experiment,participants}' else '[]'::jsonb end;
    select coalesce(jsonb_agg(colony_private.export_fields(value,array['mouse_sid','raw_identifier','link_status','candidate_sids','role'])||jsonb_build_object(
        'candidate_count',case when jsonb_typeof(value->'candidate_sids')='array' then jsonb_array_length(value->'candidate_sids') else 0 end,
        'candidates_truncated',case when jsonb_typeof(value->'candidate_sids')='array' then jsonb_array_length(value->'candidate_sids')>jsonb_array_length(colony_private.export_fields(value,array['candidate_sids'])->'candidate_sids') else false end)),'[]') into items
      from (select value from jsonb_array_elements(source_items) where jsonb_typeof(value)='object' limit 100) a;
    nested:=nested||jsonb_build_object('participants',items,'participant_count',jsonb_array_length(source_items),'participants_truncated',jsonb_array_length(items)<jsonb_array_length(source_items));
    source_items:=case when jsonb_typeof(p#>'{experiment,sample_usages}')='array' then p#>'{experiment,sample_usages}' else '[]'::jsonb end;
    select coalesce(jsonb_agg(colony_private.export_fields(value,array['sample_id','purpose','amount','unit','disposition'])),'[]') into items
      from (select value from jsonb_array_elements(source_items) where jsonb_typeof(value)='object' limit 100) a;
    nested:=nested||jsonb_build_object('sample_usages',items,'sample_usage_count',jsonb_array_length(source_items),'sample_usages_truncated',jsonb_array_length(items)<jsonb_array_length(source_items));
    source_items:=case when jsonb_typeof(p#>'{experiment,result_urls}')='array' then p#>'{experiment,result_urls}' else '[]'::jsonb end;
    select coalesce(jsonb_agg(to_jsonb(left(value#>>'{}',2048))),'[]') into items from (select value from jsonb_array_elements(source_items) where jsonb_typeof(value)='string' limit 30) a;
    result:=result||jsonb_build_object('experiment',nested||jsonb_build_object('result_urls',items));
  elsif kind='husbandry_events' and p->>'event_type'='experiment_sample' then
    nested:=colony_private.export_fields(p->'experiment_sample',array['schema_version','label','experiment_id','parent_sample_ids','pooled','tissue','material','collection_at','timezone','circadian_time','time_basis','circadian_time_source','decapitation_at','decapitation_circadian_time','decapitation_time_basis','decapitation_circadian_time_source','status','quantity','quantity_unit','quantity_as_of_date','operator','project','protocol']);
    nested:=nested||jsonb_build_object('entrainment',colony_private.export_fields(p#>'{experiment_sample,entrainment}',array['scheme','light_event_id','reference_at','reference_phase','phase_basis','phase_scale','period_hours','timezone','start_date','end_date','duration_days','duration_basis']));
    source_items:=case when jsonb_typeof(p#>'{experiment_sample,donors}')='array' then p#>'{experiment_sample,donors}' else '[]'::jsonb end;
    select coalesce(jsonb_agg(colony_private.export_fields(value,array['mouse_sid','raw_identifier','link_status','candidate_sids','role'])||jsonb_build_object(
        'candidate_count',case when jsonb_typeof(value->'candidate_sids')='array' then jsonb_array_length(value->'candidate_sids') else 0 end,
        'candidates_truncated',case when jsonb_typeof(value->'candidate_sids')='array' then jsonb_array_length(value->'candidate_sids')>jsonb_array_length(colony_private.export_fields(value,array['candidate_sids'])->'candidate_sids') else false end)),'[]') into items
      from (select value from jsonb_array_elements(source_items) where jsonb_typeof(value)='object' limit 100) a;
    nested:=nested||jsonb_build_object('donors',items,'donor_count',jsonb_array_length(source_items),'donors_truncated',jsonb_array_length(items)<jsonb_array_length(source_items),
      'storage',colony_private.export_fields(p#>'{experiment_sample,storage}',array['temperature_c','facility','freezer','rack','box','position']));
    source_items:=case when jsonb_typeof(p#>'{experiment_sample,parent_sample_ids}')='array' then p#>'{experiment_sample,parent_sample_ids}' else '[]'::jsonb end;
    result:=result||jsonb_build_object('experiment_sample',nested||jsonb_build_object('parent_sample_count',jsonb_array_length(source_items),'parent_samples_truncated',jsonb_array_length(source_items)>coalesce(jsonb_array_length(nested->'parent_sample_ids'),0)));
  end if;
  -- experiment_revision before/after snapshots intentionally have no projection.
  -- Their event metadata may be reported; complete snapshots require Max backup.
  return result;
end $$;
revoke all on function colony_private.export_payload(text,jsonb) from public,anon,authenticated;

commit;
