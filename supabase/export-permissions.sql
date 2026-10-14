-- Apply after schema.sql and functions/manage-colony-users/membership.sql.
-- Export workflows are separate from existing member viewing/editing rights.
begin;
alter table public.memberships add column if not exists export_level text not null default 'low';
alter table public.memberships drop constraint if exists memberships_export_level_check;
alter table public.memberships add constraint memberships_export_level_check check(export_level in ('low','high','max'));
update public.memberships set export_level='max' where role='owner' and export_level<>'max';

create or replace function colony_private.membership_export_default()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.role='owner' then new.export_level:='max';
  elsif tg_op='UPDATE' and old.role='owner' then new.export_level:='low'; end if;
  return new;
end $$;
revoke all on function colony_private.membership_export_default() from public,anon,authenticated;
drop trigger if exists membership_export_default on public.memberships;
create trigger membership_export_default before insert or update on public.memberships
for each row execute function colony_private.membership_export_default();

-- The optional sixth argument preserves legacy callers, while omission on an
-- update retains the level already assigned by the owner.
drop function if exists public.manage_colony_member(uuid,uuid,text,boolean,text);
create or replace function public.manage_colony_member(
  p_colony_id uuid,p_user_id uuid,p_role text,p_active boolean,p_action text,p_export_level text default null
) returns setof public.memberships language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); target public.memberships%rowtype; saved public.memberships%rowtype; requested text;
begin
  perform 1 from public.colonies where id=p_colony_id for update;
  if actor is null or colony_private.current_role(p_colony_id) is distinct from 'owner' then
    raise exception using errcode='42501',message='Only an active colony owner can manage members'; end if;
  if p_role is null or p_role not in ('viewer','editor') or p_active is null or p_action is null or p_action not in ('add','update') or p_user_id is null
    or (p_export_level is not null and p_export_level not in ('low','high','max')) then
    raise exception using errcode='22023',message='Invalid membership or export permission request'; end if;
  select * into target from public.memberships where colony_id=p_colony_id and user_id=p_user_id;
  if p_user_id=actor or target.role='owner' then raise exception using errcode='42501',message='Owner accounts are protected'; end if;
  if p_action='add' and target.user_id is not null then raise exception using errcode='23505',message='This account is already a colony member'; end if;
  if p_action='update' and target.user_id is null then raise exception using errcode='P0002',message='This account is not a colony member'; end if;
  requested:=coalesce(p_export_level,target.export_level,'low');
  select * into saved from public.set_member_role(p_colony_id,p_user_id,p_role,p_active);
  if saved.export_level<>requested then
    target:=saved;
    update public.memberships set export_level=requested,updated_at=clock_timestamp(),updated_by=actor
      where colony_id=p_colony_id and user_id=p_user_id returning * into saved;
    insert into public.audit_log(colony_id,entity_type,entity_id,operation,actor_id,before_record,after_record)
      values(p_colony_id,'membership',p_user_id::text,'UPDATE',actor,to_jsonb(target),to_jsonb(saved));
  end if;
  return next saved;
end $$;
revoke all on function public.manage_colony_member(uuid,uuid,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.manage_colony_member(uuid,uuid,text,boolean,text,text) to authenticated;

create or replace function public.get_export_permission(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare member public.memberships%rowtype; level text; today date:=(current_timestamp at time zone 'Asia/Taipei')::date; cutoff date;
begin
  select * into member from public.memberships where colony_id=p_colony_id and user_id=auth.uid() and active;
  if member.user_id is null then raise exception using errcode='42501',message='Active colony membership is required to export'; end if;
  level:=case when member.role='owner' then 'max' else member.export_level end;
  cutoff:=case level when 'low' then (today-interval '3 years')::date when 'high' then (today-interval '6 years')::date else null end;
  return jsonb_build_object('level',level,'cutoff_date',cutoff,'as_of_date',today,'full_history',level='max','captured_at',current_timestamp);
end $$;
revoke all on function public.get_export_permission(uuid) from public,anon,authenticated;
grant execute on function public.get_export_permission(uuid) to authenticated;

create or replace function public.assert_full_export_permission(p_colony_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare permission jsonb;
begin
  permission:=public.get_export_permission(p_colony_id);
  if permission->>'level'<>'max' then raise exception using errcode='42501',message='Max export permission is required for a full backup or source archive export'; end if;
  return permission;
end $$;
revoke all on function public.assert_full_export_permission(uuid) from public,anon,authenticated;
grant execute on function public.assert_full_export_permission(uuid) to authenticated;

create or replace function colony_private.export_date(value jsonb)
returns date language plpgsql immutable set search_path='' as $$
declare s text; d date;
begin
  if jsonb_typeof(value)<>'string' then return null; end if;
  s:=value#>>'{}'; if s !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  begin d:=s::date; exception when others then return null; end;
  if to_char(d,'YYYY-MM-DD')<>s then return null; end if; return d;
end $$;
revoke all on function colony_private.export_date(jsonb) from public,anon,authenticated;

create or replace function colony_private.export_domain_date(kind text,p jsonb)
returns date language plpgsql immutable set search_path='' as $$
begin
  return case kind
    when 'mice' then coalesce(colony_private.export_date(p->'end_date'),colony_private.export_date(p->'date_of_birth'))
    when 'matings' then coalesce(colony_private.export_date(p->'disbanded_date'),colony_private.export_date(p->'set_up_date'))
    when 'litters' then coalesce(colony_private.export_date(p->'end_date'),colony_private.export_date(p->'wean_date'),colony_private.export_date(p->'date_of_birth'))
    when 'cages' then coalesce(colony_private.export_date(p->'end_date'),colony_private.export_date(p->'set_up_date'))
    when 'light_events' then coalesce(colony_private.export_date(p->'end_date'),colony_private.export_date(p->'start_date'))
    when 'husbandry_events' then case when p->>'event_type'='cryopreservation_lot'
      then coalesce(colony_private.export_date(p#>'{cryopreservation,quantity_as_of_date}'),colony_private.export_date(p#>'{cryopreservation,frozen_date}'))
      else colony_private.export_date(p->'event_date') end
    else null end;
end $$;
revoke all on function colony_private.export_domain_date(text,jsonb) from public,anon,authenticated;

-- Resolve the timezone catalog once per export, never once per light record.
drop function if exists colony_private.export_light_current(jsonb);
create or replace function colony_private.export_light_current(p jsonb,p_today date)
returns boolean language plpgsql stable set search_path='' as $$
declare starts date; ends date;
begin
  starts:=colony_private.export_date(p->'start_date');ends:=colony_private.export_date(p->'end_date');
  return coalesce(starts<=p_today and (p->>'end_date' is null or case when lower(coalesce(p->>'interval_semantics','')) ~ 'next phase start|exclusive' then ends>p_today else ends>=p_today end),false);
end $$;
revoke all on function colony_private.export_light_current(jsonb,date) from public,anon,authenticated;

-- Scalar/ID-list projection rejects nested data and caps cell size. There is no
-- source*, notes, comment, audit, genotype-profile or archive pass-through.
create or replace function colony_private.export_fields(p jsonb,keys text[])
returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb:='{}'; k text; v jsonb; items jsonb;
begin
  if jsonb_typeof(p)<>'object' then return result; end if;
  foreach k in array keys loop
    v:=p->k;
    if jsonb_typeof(v)='string' then result:=result||jsonb_build_object(k,left(v#>>'{}',2048));
    elsif jsonb_typeof(v) in ('number','boolean','null') then result:=result||jsonb_build_object(k,v);
    elsif jsonb_typeof(v)='array' then
      select coalesce(jsonb_agg(value),'[]') into items from (select to_jsonb(left(value#>>'{}',200)) value from jsonb_array_elements(v) where jsonb_typeof(value)='string' limit 100) a;
      result:=result||jsonb_build_object(k,items);
    end if;
  end loop; return result;
end $$;
revoke all on function colony_private.export_fields(jsonb,text[]) from public,anon,authenticated;

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
