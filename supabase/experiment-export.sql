-- Experiment report projection upgrade. Apply after export-permissions.sql.
-- Replaces only the private payload projector; roles, export windows, write RPCs,
-- existing source rows, audit logs and memberships are unchanged.
-- Kept byte-identical to export_payload in export-permissions.sql by its tests.
begin;
create or replace function colony_private.export_payload(kind text,p jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare keys text[]; result jsonb; nested jsonb; source_items jsonb; items jsonb;
begin
  keys:=case kind
    when 'mice' then array['mouse_sid','physical_tag','sex','state','mouseline','genotype','date_of_birth','end_date','wean_date','sire_sids','dam_sids','litter_sid','cage_sid','cage_tag','manager','owner']
    when 'matings' then array['mating_sid','state','male_sids','female_sids','sire_sids','dam_sids','set_up_date','disbanded_date','cage_sid','cage_tag','owner']
    when 'litters' then array['litter_sid','state','date_of_birth','wean_date','end_date','mating_sid','sire_sids','dam_sids','size_reported','male_count','female_count','unknown_count','cage_sid']
    when 'cages' then array['cage_sid','cage_tag','state','cage_type','room_id','rack_id','location_id','room','rack','location','capacity','manager','owner','set_up_date','end_date']
    when 'rooms' then array['room_id','name','label']
    when 'racks' then array['rack_id','room_id','name','label']
    when 'locations' then array['location_id','room_id','rack_id','label','row','column','capacity']
    when 'light_events' then array['event_id','start_date','end_date','protocol','cycle_hours','light_hours','lights_on','lights_off','transition_minutes','intensity_lux','timezone','evidence_status','interval_semantics','actual_exposure_verified','room_id','rack_id','location_id','cage_sid']
    when 'husbandry_events' then array['event_id','event_type','event_date','mouse_sid','cage_sid','old_cage_sid','room_id','rack_id','location_id','old_room_id','old_rack_id','old_location_id','location_label','old_location_label']
    else array[]::text[] end;
  result:=colony_private.export_fields(p,keys);
  if kind='locations' then
    result:=result||jsonb_build_object('record_origin',case when p->>'record_origin'='app_created' then 'app_created' else 'source_recorded' end);
  end if;
  if kind='husbandry_events' and p->>'event_type'='cryopreservation_lot' then
    nested:=colony_private.export_fields(p->'cryopreservation',array['schema_version','case_id','label','strain','background','modification_method','gene','zygosity','origin','batch_ids','frozen_date','material','status','manager','quantity','quantity_unit','quantity_as_of_date','donor_mouse_sids']);
    nested:=nested||jsonb_build_object('storage_location',colony_private.export_fields(p#>'{cryopreservation,storage_location}',array['facility','tank','canister','position']));
    result:=result||jsonb_build_object('cryopreservation',nested);
  elsif kind='husbandry_events' and p->>'event_type'='cryopreservation_event' then
    result:=result||jsonb_build_object('cryopreservation_event',colony_private.export_fields(p->'cryopreservation_event',array['schema_version','lot_id','activity_type','quantity','quantity_unit','recovery_status','recovered_mouse_sids']));
  elsif kind='husbandry_events' and p->>'event_type'='experiment' then
    nested:=colony_private.export_fields(p->'experiment',array['schema_version','title','assays','status','project','operator','protocol','started_at','ended_at','timezone','circadian_time','time_basis','result_urls']);
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
    nested:=colony_private.export_fields(p->'experiment_sample',array['schema_version','label','experiment_id','parent_sample_ids','pooled','tissue','material','collection_at','timezone','circadian_time','time_basis','status','quantity','quantity_unit','quantity_as_of_date','operator','project','protocol']);
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
