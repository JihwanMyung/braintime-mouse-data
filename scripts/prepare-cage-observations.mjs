import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {cageObservations} from '../web/cage-observations.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const quote=x=>"'"+String(x).replaceAll("'","''")+"'";
const sourceKeys=['source_block_text','source_cell','source_block_range','source_file_id','source_sheet_id','source_snapshot_date','source_last_seen_at','record_origin'];

export function observationCandidates(input,{colonyId}){
 if(!UUID.test(colonyId||''))throw Error('A valid colony UUID is required.');
 const rows=Array.isArray(input)?input:object(input)&&Array.isArray(input.rows)?input.rows:object(input)&&Array.isArray(input.data)?input.data:null;
 if(!rows||rows.length>5000)throw Error('Expected up to 5000 downloaded entity/location rows.');
 const seen=new Set(),entries=[],skipped=[];
 for(const row of rows){
  if(!object(row)||!object(row.payload)||typeof row.entity_id!=='string'||!row.entity_id||row.entity_id.length>200||row.payload.location_id!==row.entity_id||!Number.isInteger(row.version)||row.version<1||typeof row.archived!=='boolean')throw Error('Each location needs its unchanged payload, entity_id, version, and archived flag.');
  if(row.colony_id&&row.colony_id!==colonyId)throw Error('Input contains a different colony.');
  if(row.entity_type&&row.entity_type!=='locations')throw Error('Input contains a non-location entity.');
  if(seen.has(row.entity_id))throw Error('Input contains duplicate locations.');seen.add(row.entity_id);
  const p=row.payload;
  let reason=null;
  if(row.archived||p.app_archived_at||p.source_current===false)reason='not_current';
  else if(p.record_origin!=='current_google_sheet_map')reason='not_current_sheet_map';
  else if(sourceKeys.slice(0,3).some(k=>typeof p[k]!=='string'||!p[k]))reason='missing_source_coordinates';
  if(reason){skipped.push({entity_id:row.entity_id,reason});continue;}
  // Reparse the retained cells, not an earlier derived observation object.
  const original={...p};delete original.source_cage_observation;
  entries.push({entity_id:row.entity_id,expected_version:row.version,expected_source:Object.fromEntries(sourceKeys.filter(k=>Object.hasOwn(p,k)).map(k=>[k,p[k]])),observation:cageObservations(original)});
 }
 return {schema_version:1,colony_id:colonyId,entries,skipped};
}

export function observationBackfillSQL(candidates,{sha256}){
 if(!object(candidates)||candidates.schema_version!==1||!UUID.test(candidates.colony_id||'')||!Array.isArray(candidates.entries)||!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('Validated observation candidates and a source SHA-256 are required.');
 const data=JSON.stringify(candidates),tag='$observations_'+sha256.slice(0,12)+'$';
 if(data.includes(tag)||data.includes('$backfill$'))throw Error('Unexpected SQL delimiter collision.');
 return `-- PRIVATE. Generated from downloaded location rows SHA-256 ${sha256}.
-- Observations only: raw cells, cage/mouse associations and all other fields remain intact.
-- Any changed version or source is reported and skipped, never guessed or overwritten.
begin;
do $backfill$
<<backfill>>
declare candidate jsonb:=${tag}${data}${tag}::jsonb;lab uuid:=${quote(candidates.colony_id)}::uuid;actor uuid;entry jsonb;record public.entity_records%rowtype;report jsonb:='[]';status text;changed integer:=0;baseline jsonb;active_job uuid;baseline_entry jsonb;baseline_index integer;baseline_count integer;baseline_updates integer:=0;
begin
 if auth.uid() is not null then raise exception 'Use the authorized admin SQL route for observation backfill';end if;
 select cfg.responsible_user_id into actor from colony_private.animal_sheet_import_settings cfg
 join public.memberships m on m.colony_id=cfg.colony_id and m.user_id=cfg.responsible_user_id and m.role='owner' and m.active
 join auth.users u on u.id=m.user_id and u.email_confirmed_at is not null where cfg.colony_id=lab for update of cfg;
 if actor is null then raise exception 'A verified responsible owner in the existing Animal Sheet integration is required';end if;
 select state.baseline,state.active_job_id into baseline,active_job from colony_private.animal_sheet_import_state state where state.colony_id=lab for update;
 if not found or jsonb_typeof(baseline->'entries') is distinct from 'array' then raise exception 'Existing Animal Sheet baseline is required';end if;
 if active_job is not null then raise exception 'An Animal Sheet import is active; wait for it to finish before backfill';end if;
 perform pg_advisory_xact_lock(hashtextextended('colony:'||lab::text,0));
 for entry in select * from jsonb_array_elements(candidate->'entries') loop
  if not colony_private.valid_cage_observation(entry->'observation') then raise exception 'Invalid observation for %; nothing was changed',entry->>'entity_id';end if;
  status:=null;baseline_entry:=null;
  select * into record from public.entity_records where colony_id=lab and entity_type='locations' and entity_id=entry->>'entity_id' for update;
  if not found then status:='missing';
  elsif record.archived or record.payload->>'app_archived_at' is not null or record.payload->'source_current'='false'::jsonb then status:='not_current';
  elsif exists(select 1 from jsonb_each(entry->'expected_source') expected where record.payload->expected.key is distinct from expected.value) then status:='source_changed';
  end if;
  select count(*)::integer,min(ordinality)::integer-1 into baseline_count,baseline_index from jsonb_array_elements(baseline->'entries') with ordinality prior where prior.value->>'entity_type'='locations' and prior.value->>'entity_id'=entry->>'entity_id';
  if baseline_count=1 then baseline_entry:=baseline#>array['entries',baseline_index::text];end if;
  if status is null then
   if baseline_count<>1 or baseline_entry->'source_present'='false'::jsonb then status:='baseline_missing';
   elsif exists(select 1 from jsonb_each(entry->'expected_source') expected where expected.key not in ('source_snapshot_date','source_last_seen_at') and baseline_entry#>array['payload',expected.key] is distinct from expected.value) then status:='baseline_source_changed';
   elsif record.payload->'source_cage_observation'=entry->'observation' then status:='already_current';
   elsif record.version<>(entry->>'expected_version')::integer then status:='version_changed';
   else
    update public.entity_records set payload=jsonb_set(payload,'{source_cage_observation}',entry->'observation'),version=version+1,updated_at=clock_timestamp(),updated_by=actor
     where colony_id=lab and entity_type='locations' and entity_id=entry->>'entity_id';
    changed:=changed+1;status:='updated';
   end if;
  end if;
  if status in ('updated','already_current') and baseline_entry#>'{payload,source_cage_observation}' is distinct from entry->'observation' then
   baseline:=jsonb_set(baseline,array['entries',baseline_index::text,'payload','source_cage_observation'],entry->'observation');baseline_updates:=baseline_updates+1;
  end if;
  report:=report||jsonb_build_array(jsonb_build_object('entity_id',entry->>'entity_id','status',status));
 end loop;
 if baseline_updates>0 then update colony_private.animal_sheet_import_state state set baseline=backfill.baseline,baseline_revision=baseline_revision+1 where state.colony_id=lab;end if;
 perform set_config('braintime.cage_observation_backfill_report',jsonb_build_object('source_sha256',${quote(sha256)},'updated',changed,'baseline_updates',baseline_updates,'records',report,'preparation_skips',candidate->'skipped')::text,false);
end $backfill$;
commit;
select current_setting('braintime.cage_observation_backfill_report')::jsonb as observation_backfill;
`;
}

export async function prepareCageObservations({input,output,colonyId}){
 const target=resolve(output),parts=target.split(sep);
 if(parts.some(x=>['web','.git','mouse-data','public','dist'].includes(x)))throw Error('Private backfill SQL must stay outside published application assets.');
 const bytes=await readFile(resolve(input)),sha256=createHash('sha256').update(bytes).digest('hex');
 const candidates=observationCandidates(JSON.parse(bytes.toString('utf8')),{colonyId}),sql=observationBackfillSQL(candidates,{sha256});
 await mkdir(dirname(target),{recursive:true});await writeFile(target,sql,{mode:0o600});await chmod(target,0o600);
 return {output:target,source_sha256:sha256,records:candidates.entries.length,animals:candidates.entries.reduce((n,e)=>n+e.observation.animals.length,0),skipped:candidates.skipped,bytes:Buffer.byteLength(sql)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [input,output,colonyId]=process.argv.slice(2);if(!input||!output||!colonyId)throw Error('Usage: node scripts/prepare-cage-observations.mjs input-private.json output-private.sql colony-uuid');
 console.log(JSON.stringify(await prepareCageObservations({input,output,colonyId})));
}
