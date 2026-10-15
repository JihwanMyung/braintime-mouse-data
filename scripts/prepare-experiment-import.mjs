#!/usr/bin/env node
/** Offline, additive preparation. No network, credentials, JWT claims, schema,
 * membership or live records are changed by this generator. Generated SQL is
 * private and must be reviewed/applied by the actual database administrator. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encodeArchive,canonicalStringify,ARCHIVE_MANIFEST_FORMAT,ARCHIVE_CHUNK_FORMAT,MAX_ARCHIVE_PAYLOAD_BYTES,utf8Size} from '../web/archive-format.js';
import {checkedUuid,partitionAdminCsv} from './admin-csv.mjs';
const TABLES=['experiment_sources','experiment_source_catalog','experiment_source_contexts','experiment_source_coverage'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sha=text=>createHash('sha256').update(text).digest('hex');
const same=(a,b)=>canonicalStringify(a)===canonicalStringify(b);

function validateJson(value){
  if(typeof value==='string'){
    if(value.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw new Error('PostgreSQL JSON cannot preserve NUL or unpaired surrogate characters. Retain the original source and correct its encoding before import.');
  }else if(typeof value==='number'&&!Number.isFinite(value))throw new Error('JSON numbers must be finite.');
  else if(Array.isArray(value))value.forEach(validateJson);
  else if(object(value))for(const [key,item]of Object.entries(value)){validateJson(key);validateJson(item);}
  else if(value!==null&&!['number','boolean'].includes(typeof value))throw new Error('Import data must contain JSON values only.');
}
function decimalNumber(value){
  const text=JSON.stringify(value);if(!/[eE]/.test(text))return text;
  const [coefficient,exponent]=text.toLowerCase().split('e'),negative=coefficient.startsWith('-'),unsigned=negative?coefficient.slice(1):coefficient;
  const [whole,fraction='']=unsigned.split('.'),digits=whole+fraction,point=whole.length+Number(exponent);
  return (negative?'-':'')+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
}
/** PostgreSQL JSONB text fingerprint, independent of archive canonical SHA.
 * JSONB orders UTF-8 object keys by byte length then byte value, renders numeric
 * exponents as decimal, and separates values with spaces. Tests compare this
 * function against the actual PostgreSQL engine, including Unicode/numbers. */
export function postgresJsonbText(value){
  if(Array.isArray(value))return '['+value.map(postgresJsonbText).join(', ')+']';
  if(object(value))return '{'+Object.keys(value).sort((a,b)=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b))).map(key=>JSON.stringify(key)+': '+postgresJsonbText(value[key])).join(', ')+'}';
  return typeof value==='number'?decimalNumber(value):JSON.stringify(value);
}
function sqlJson(value){
  const text=canonicalStringify(value);let index=0,tag;
  do{tag='$experiment_'+sha(text+':'+index++).slice(0,16)+'$';}while(text.includes(tag));
  return tag+text+tag+'::jsonb';
}
function protectedDoBlock(sql,label){
  const marker='$'+label+'$',first=sql.indexOf(marker),last=sql.lastIndexOf(marker);
  if(first<0||last<=first)throw new Error('SQL block delimiter is missing.');
  const body=sql.slice(first+marker.length,last);let index=0,tag;
  do{tag='$'+label+'_'+sha(body+':'+index++).slice(0,16)+'$';}while(body.includes(tag));
  return sql.slice(0,first)+tag+body+tag+sql.slice(last+marker.length);
}
function observationTables(source){
  if(Array.isArray(source))return {experiment_sources:source};
  if(!object(source)||!Array.isArray(source.observations))throw new Error('Source file must contain an observations array or be an observation array.');
  const tables={experiment_sources:source.observations};
  if(source.sources!==undefined){if(!Array.isArray(source.sources))throw new Error('Source catalog must be an array.');tables.experiment_source_catalog=source.sources;}
  if(source.contexts!==undefined){if(!Array.isArray(source.contexts))throw new Error('Source contexts must be an array.');tables.experiment_source_contexts=source.contexts;}
  if(source.coverage_history!==undefined){if(!Array.isArray(source.coverage_history)||!source.coverage_history.every(object))throw new Error('Source coverage history must be an array of objects.');tables.experiment_source_coverage=source.coverage_history;}
  else if(source.coverage!==undefined){if(!object(source.coverage))throw new Error('Source coverage must be an object.');tables.experiment_source_coverage=[source.coverage];}
  return tables;
}
function checkedManifest(input,version,colony){
  const wrapped=object(input)&&object(input.payload),payload=wrapped?input.payload:input;
  if(wrapped&&input.colony_id!==undefined&&checkedUuid(input.colony_id,'Manifest colony')!==colony)throw new Error('Manifest belongs to a different colony.');
  if(wrapped&&(input.archived===true||input.entity_type&&input.entity_type!=='archive'||input.entity_id&&input.entity_id!=='reconstruction'))throw new Error('Expected a live reconstruction manifest.');
  const expected=version??(wrapped?input.version:undefined);
  if(!Number.isInteger(expected)||expected<1||expected>=2147483647)throw new Error('Expected manifest version must be a positive PostgreSQL integer with room for one increment.');
  if(wrapped&&input.version!==undefined&&input.version!==expected)throw new Error('CLI version differs from the captured manifest version.');
  if(!object(payload)||payload.archive_format!==ARCHIVE_MANIFEST_FORMAT||!object(payload.archive_tables)||!object(payload.tables))throw new Error('Expected a content-addressed reconstruction manifest with tables and archive_tables.');
  for(const descriptor of Object.values(payload.archive_tables))if(!object(descriptor)||!Number.isSafeInteger(descriptor.row_count)||descriptor.row_count<0||!Array.isArray(descriptor.chunk_ids)||descriptor.chunk_ids.some(id=>typeof id!=='string'||!/^chunk:[a-f0-9]{64}$/.test(id)))throw new Error('Existing manifest contains an invalid archive descriptor.');
  if(utf8Size(payload)>MAX_ARCHIVE_PAYLOAD_BYTES)throw new Error('Existing reconstruction metadata exceeds the app manifest limit.');
  return {payload:structuredClone(payload),version:expected};
}

export async function prepareExperimentImport({manifest,version,sources,colonyId,ownerUserId=null,maxSqlBytes=800000,chunkCsv=false,existingChunkIds=[],baselineSources=null}){
  const colony=checkedUuid(colonyId,'--colony-id'),owner=ownerUserId===null?null:checkedUuid(ownerUserId,'--owner-user-id');
  if(!Number.isInteger(maxSqlBytes)||maxSqlBytes<10000||maxSqlBytes>1000000)throw new Error('SQL file limit must be from 10,000 to 1,000,000 bytes.');
  if(!Array.isArray(existingChunkIds)||existingChunkIds.some(id=>typeof id!=='string'||!/^chunk:[a-f0-9]{64}$/.test(id)))throw new Error('Existing chunk IDs must be a captured array of content-addressed archive IDs.');
  if(chunkCsv&&!owner)throw new Error('CSV preparation requires an explicit verified --owner-user-id.');
  validateJson(manifest);validateJson(sources);
  const old=checkedManifest(manifest,version,colony),tables=observationTables(sources),seen=new Set();
  if(!tables.experiment_sources.length)throw new Error('At least one source observation is required.');
  for(const row of tables.experiment_sources){if(!object(row)||typeof row.source_id!=='string'||!row.source_id.trim()||row.source_id.length>200)throw new Error('Every observation needs a nonempty source_id of at most 200 characters.');if(seen.has(row.source_id))throw new Error('Duplicate source_id; resolve source observations before preparing the import.');seen.add(row.source_id);}
  const encoded=await encodeArchive({tables}),chunks=encoded.filter(row=>row.entity_id!=='reconstruction'),descriptors=encoded.at(-1).payload.archive_tables;
  let baselineDescriptors=null;
  if(baselineSources!==null){
    validateJson(baselineSources);const baselineTables=observationTables(baselineSources);
    for(const [table,prior]of Object.entries(baselineTables)){
      const incoming=tables[table];
      if(!Array.isArray(incoming)||incoming.length<prior.length||prior.some((row,index)=>!same(row,incoming[index])))throw new Error('Append requires the exact unchanged '+table+' prefix.');
    }
    baselineDescriptors=(await encodeArchive({tables:baselineTables})).at(-1).payload.archive_tables;
    for(const [table,descriptor]of Object.entries(baselineDescriptors))if(!same(old.payload.archive_tables[table],descriptor)&&!same(old.payload.archive_tables[table],descriptors[table]))throw new Error('Captured manifest does not match the verified baseline for '+table+'.');
    for(const table of Object.keys(tables))if(Object.hasOwn(old.payload.archive_tables,table)&&!Object.hasOwn(baselineDescriptors,table))throw new Error('Baseline must include every existing source table being appended.');
  }
  const next=structuredClone(old.payload);
  for(const table of Object.keys(tables)){
    if(Object.hasOwn(next.tables,table))throw new Error('Legacy manifest tables already contains '+table+'; reconcile it before adding a chunked source table.');
    if(Object.hasOwn(next.archive_tables,table)&&!same(next.archive_tables[table],descriptors[table])&&!same(next.archive_tables[table],baselineDescriptors?.[table]))throw new Error('Existing '+table+' descriptor differs. This insert-only generator will not replace source history.');
    next.archive_tables[table]=descriptors[table];
  }
  if(utf8Size(next)>MAX_ARCHIVE_PAYLOAD_BYTES)throw new Error('Merged reconstruction metadata exceeds the app manifest limit.');
  for(const chunk of chunks){const content=canonicalStringify(chunk.payload);if(utf8Size(content)>MAX_ARCHIVE_PAYLOAD_BYTES||chunk.entity_id!=='chunk:'+sha(content)||chunk.payload.format!==ARCHIVE_CHUNK_FORMAT||!TABLES.includes(chunk.payload.table))throw new Error('Generated archive chunk failed SHA/format validation.');}
  for(const [table,descriptor]of Object.entries(descriptors))if(descriptor.chunk_ids.reduce((total,id)=>total+chunks.find(chunk=>chunk.entity_id===id).payload.rows.length,0)!==descriptor.row_count)throw new Error('Generated archive row count mismatch.');
  const alreadyPresent=same(old.payload,next),expectedChunks=chunks.map(chunk=>({id:chunk.entity_id,table:chunk.payload.table,rows:chunk.payload.rows.length,jsonb_sha256:sha(postgresJsonbText(chunk.payload))}));
  const declarations=`target_colony uuid:='${colony}'; responsible_owner uuid:=${owner?"'"+owner+"'":'null'}; expected_version integer:=${old.version};\n expected_manifest jsonb:=${sqlJson(old.payload)}; merged_manifest jsonb:=${sqlJson(next)}; current_manifest public.entity_records%rowtype;`;
  const guard=`if auth.uid() is not null then raise exception 'This file requires an unclaimed administrator SQL context; it never impersonates an Auth user';end if;
 if not exists(select 1 from public.colonies where id=target_colony) then raise exception 'Target colony does not exist';end if;
 if responsible_owner is null then
   if (select count(*) from public.memberships where colony_id=target_colony and role='owner' and active)<>1 then raise exception 'Supply an explicit active owner UUID when the colony does not have exactly one owner';end if;
   select user_id into responsible_owner from public.memberships where colony_id=target_colony and role='owner' and active;
 elsif not exists(select 1 from public.memberships where colony_id=target_colony and user_id=responsible_owner and role='owner' and active) then raise exception 'Supplied responsible owner is not an active colony owner';end if;
 perform pg_advisory_xact_lock(hashtextextended('colony:'||target_colony::text,0));
 select * into current_manifest from public.entity_records where colony_id=target_colony and entity_type='archive' and entity_id='reconstruction' for update;
 if not found or current_manifest.archived then raise exception 'Current reconstruction manifest is missing or archived';end if;
 if not ((current_manifest.version=expected_version and current_manifest.payload=expected_manifest) or (current_manifest.version=expected_version+1 and current_manifest.payload=merged_manifest)) then raise exception 'Manifest changed. Capture it again and prepare a fresh import; no manifest was replaced';end if;`;
  const preamble='-- PRIVATE source archive import. Review before administrator execution.\n-- Never sets JWT claims, changes membership, or updates managed animal records.\nbegin;\n';
  const rawStage=batch=>preamble+`do $stage_experiments$\ndeclare ${declarations}\n changes jsonb:=${sqlJson(batch.map(({entity_id,payload})=>({entity_id,payload})))}; item jsonb; existing public.entity_records%rowtype; inserted_count integer:=0;\nbegin\n ${guard}\n for item in select value from jsonb_array_elements(changes) loop
   perform colony_private.validate_payload('archive',item->>'entity_id',item->'payload');
   select * into existing from public.entity_records where colony_id=target_colony and entity_type='archive' and entity_id=item->>'entity_id' for update;
   if found then
     if existing.payload is distinct from item->'payload' or existing.archived then raise exception 'Existing source chunk differs, refusing overwrite: %',item->>'entity_id';end if;
   else
     insert into public.entity_records(colony_id,entity_type,entity_id,payload,version,archived,created_by,updated_by) values(target_colony,'archive',item->>'entity_id',item->'payload',1,false,responsible_owner,responsible_owner);
     inserted_count:=inserted_count+1;
   end if;
 end loop;
 raise notice 'Staged % new source chunks; existing identical chunks retained',inserted_count;
end $stage_experiments$;\ncommit;\n`;
  const stage=batch=>protectedDoBlock(rawStage(batch),'stage_experiments');
  const rawFinal=preamble+`do $publish_experiments$\ndeclare ${declarations}\n expected_chunks jsonb:=${sqlJson(expectedChunks)}; item jsonb; stored_chunk public.entity_records%rowtype; table_name text; descriptor jsonb; new_payload jsonb;\nbegin\n ${guard}\n for item in select value from jsonb_array_elements(expected_chunks) loop
   select * into stored_chunk from public.entity_records where colony_id=target_colony and entity_type='archive' and entity_id=item->>'id' for update;
   if not found or stored_chunk.archived or stored_chunk.payload->>'format' is distinct from '${ARCHIVE_CHUNK_FORMAT}' or stored_chunk.payload->>'table' is distinct from item->>'table' or jsonb_typeof(stored_chunk.payload->'rows') is distinct from 'array' then raise exception 'Missing or invalid source chunk: %',item->>'id';end if;
   if jsonb_array_length(stored_chunk.payload->'rows')<>(item->>'rows')::integer or encode(pg_catalog.sha256(convert_to(stored_chunk.payload::text,'UTF8')),'hex') is distinct from item->>'jsonb_sha256' then raise exception 'Source chunk fingerprint or row count mismatch: %',item->>'id';end if;
 end loop;
 if current_manifest.payload=merged_manifest then raise notice 'Source descriptors already present; no manifest write';return;end if;
 new_payload:=current_manifest.payload;
 for table_name,descriptor in select key,value from jsonb_each(${sqlJson(descriptors)}) loop
   if new_payload->'archive_tables' ? table_name and new_payload#>array['archive_tables',table_name] is distinct from descriptor and new_payload#>array['archive_tables',table_name] is distinct from expected_manifest#>array['archive_tables',table_name] then raise exception 'Existing source descriptor differs: %',table_name;end if;
   new_payload:=jsonb_set(new_payload,array['archive_tables',table_name],descriptor,true);
 end loop;
 if new_payload is distinct from merged_manifest or new_payload-'archive_tables' is distinct from current_manifest.payload-'archive_tables' or (new_payload->'archive_tables')-array(select jsonb_array_elements_text(${sqlJson(Object.keys(descriptors))})) is distinct from (current_manifest.payload->'archive_tables')-array(select jsonb_array_elements_text(${sqlJson(Object.keys(descriptors))})) then raise exception 'Additive manifest preservation check failed';end if;
 perform colony_private.validate_payload('archive','reconstruction',new_payload);
 update public.entity_records set payload=new_payload,version=version+1,updated_at=clock_timestamp(),updated_by=responsible_owner where colony_id=target_colony and entity_type='archive' and entity_id='reconstruction' and version=expected_version;
 if not found then raise exception 'Manifest version changed before commit';end if;
 raise notice 'Source archive published; existing managed records and other archive tables preserved';
end $publish_experiments$;\nselect version,payload->'archive_tables' as archive_tables from public.entity_records where colony_id='${colony}' and entity_type='archive' and entity_id='reconstruction';\ncommit;\n`;
  const final=protectedDoBlock(rawFinal,'publish_experiments');
  const preflightSql=`-- Read-only preflight. CSV is insert-only; zero existing chunk IDs is required for the complete CSV.
with expected as (select value item from jsonb_array_elements(${sqlJson(expectedChunks)})), matches as (
 select e.item,r.entity_id,r.archived,encode(pg_catalog.sha256(convert_to(r.payload::text,'UTF8')),'hex') fingerprint from expected e left join public.entity_records r on r.colony_id='${colony}' and r.entity_type='archive' and r.entity_id=e.item->>'id'
), head as (select payload,version,archived from public.entity_records where colony_id='${colony}' and entity_type='archive' and entity_id='reconstruction')
select (select version from head) as manifest_version,${old.version} as expected_version,coalesce((select version=${old.version} and payload=${sqlJson(old.payload)} and not archived from head),false) as captured_manifest_matches,
 (select count(*) from public.memberships where colony_id='${colony}' and role='owner' and active${owner?" and user_id='"+owner+"'":''}) as active_responsible_owner_count,
 (select count(*) from public.entity_records where colony_id='${colony}' and entity_type='archive' and payload->>'table'=any(array(select jsonb_array_elements_text(${sqlJson(Object.keys(descriptors))})))) as existing_source_namespace_chunks,
 count(entity_id) as existing_expected_chunks,coalesce(jsonb_agg(entity_id) filter(where entity_id is not null),'[]') as existing_chunk_ids,
 coalesce(jsonb_agg(entity_id) filter(where entity_id is not null and (archived or fingerprint is distinct from item->>'jsonb_sha256')),'[]') as conflicting_chunk_ids,
 (select coalesce(jsonb_object_agg(key,value),'{}') from head cross join lateral jsonb_each(head.payload->'archive_tables') where key=any(array(select jsonb_array_elements_text(${sqlJson(Object.keys(descriptors))})))) as existing_source_descriptors
from matches;
`;
  const files=[];let batch=[];
  for(const chunk of chunks){if(batch.length&&Buffer.byteLength(stage([...batch,chunk]))>maxSqlBytes){files.push({kind:'stage',sql:stage(batch),chunks:batch.map(x=>x.entity_id)});batch=[];}if(Buffer.byteLength(stage([chunk]))>maxSqlBytes)throw new Error('A single chunk SQL file exceeds the requested byte limit. Increase --max-sql-bytes.');batch.push(chunk);}
  if(batch.length)files.push({kind:'stage',sql:stage(batch),chunks:batch.map(x=>x.entity_id)});
  if(Buffer.byteLength(final)>maxSqlBytes)throw new Error('Final manifest SQL exceeds the requested byte limit; no files written.');
  files.push({kind:'manifest',sql:final,chunks:[]});
  const knownIds=new Set([...existingChunkIds,...Object.values(old.payload.archive_tables).flatMap(value=>value.chunk_ids)]),csvEntries=chunks.filter(chunk=>!knownIds.has(chunk.entity_id));
  const csvFiles=chunkCsv&&csvEntries.length?partitionAdminCsv([...csvEntries,encoded.at(-1)],colony,owner,{maxBytes:100000000,maxRecords:100000}).filter(file=>!file.manifest).map(file=>({csv:file.csv,bytes:Buffer.byteLength(file.csv),sha256:sha(file.csv),records:file.records})):[];
  return {preflightSql,csvFiles,csvOmittedExisting:chunks.length-csvEntries.length,colonyId:colony,ownerUserId:owner,expectedVersion:old.version,alreadyPresent,tables:descriptors,chunks,mergedManifest:next,files:files.map((file,i)=>({...file,name:String(i+1).padStart(3,'0')+(file.kind==='manifest'?'-MANIFEST-LAST.sql':'-stage-source-chunks.sql'),bytes:Buffer.byteLength(file.sql),sha256:sha(file.sql)}))};
}

async function main(){
  const args=process.argv.slice(2),options=new Map();
  if(args.includes('--help')){console.log('node scripts/prepare-experiment-import.mjs --manifest /private/current-manifest.json --version N --sources /private/experiment_sources.json --colony-id UUID [--owner-user-id UUID] --output-dir /private/new-directory [--max-sql-bytes 800000] [--chunk-csv chunks.csv] [--existing-chunk-ids /private/captured-ids.json] [--baseline-sources /private/verified-prior-sources.json]\nOffline only. The captured manifest must be current; generated private SQL stages immutable chunks, then compares and swaps only the new experiment archive descriptors.');return;}
  const allowed=new Set(['--manifest','--version','--sources','--colony-id','--owner-user-id','--output-dir','--max-sql-bytes','--chunk-csv','--existing-chunk-ids','--baseline-sources']);
  for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||options.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Unexpected, duplicate or incomplete CLI option. Use --help.');options.set(args[i],args[i+1]);}
  for(const name of ['--manifest','--sources','--colony-id','--output-dir'])if(!options.has(name))throw new Error('Missing '+name+'.');
  const output=resolve(options.get('--output-dir')),root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),path=relative(root,output);
  if(!path.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&path!=='..')throw new Error('Generated SQL contains private source data; choose an output directory outside the public repository.');
  const manifest=JSON.parse(await readFile(resolve(options.get('--manifest')),'utf8')),sources=JSON.parse(await readFile(resolve(options.get('--sources')),'utf8'));
  const csvName=options.get('--chunk-csv');if(csvName&&!/^[A-Za-z0-9][A-Za-z0-9._-]*\.csv$/.test(csvName))throw new Error('--chunk-csv must be a simple filename ending in .csv, inside the private output directory.');
  const existingChunkIds=options.has('--existing-chunk-ids')?JSON.parse(await readFile(resolve(options.get('--existing-chunk-ids')),'utf8')):[];
  const baselineSources=options.has('--baseline-sources')?JSON.parse(await readFile(resolve(options.get('--baseline-sources')),'utf8')):null;
  const plan=await prepareExperimentImport({baselineSources,chunkCsv:Boolean(csvName),existingChunkIds,manifest,version:options.has('--version')?Number(options.get('--version')):undefined,sources,colonyId:options.get('--colony-id'),ownerUserId:options.get('--owner-user-id')||null,maxSqlBytes:options.has('--max-sql-bytes')?Number(options.get('--max-sql-bytes')):800000});
  await mkdir(output,{mode:0o700});
  await writeFile(resolve(output,'000-PREFLIGHT.sql'),plan.preflightSql,{encoding:'utf8',mode:0o600,flag:'wx'});
  for(const file of plan.files)await writeFile(resolve(output,file.name),file.sql,{encoding:'utf8',mode:0o600,flag:'wx'});
  for(const [i,file]of plan.csvFiles.entries()){file.name=plan.csvFiles.length===1?csvName:csvName.replace(/\.csv$/,`-${String(i+1).padStart(3,'0')}.csv`);await writeFile(resolve(output,file.name),file.csv,{encoding:'utf8',mode:0o600,flag:'wx'});}
  const receipt={preflight:{file:'000-PREFLIGHT.sql',sha256:sha(plan.preflightSql),bytes:Buffer.byteLength(plan.preflightSql)},csv_files:plan.csvFiles.map(({csv,...file})=>file),csv_existing_ids_omitted:plan.csvOmittedExisting,csv_instruction:'INSERT only, never upsert. Import chunk CSV(s) instead of staging SQL, then run MANIFEST-LAST. If CSV upload is interrupted or duplicates are reported, use staging SQL to reconcile without overwrites.',colony_id:plan.colonyId,responsible_owner_user_id:plan.ownerUserId,expected_manifest_version:plan.expectedVersion,already_present:plan.alreadyPresent,source_file_sha256:sha(await readFile(resolve(options.get('--sources')))),baseline_source_sha256:baselineSources?sha(await readFile(resolve(options.get('--baseline-sources')))):null,tables:plan.tables,chunk_count:plan.chunks.length,all_archive_chunk_sha256_verified:true,files:plan.files.map(({sql,...file})=>file),audit_actor:'Actual administrator auth.uid(); this bundle requires null and never sets claims.',execution:'Apply numbered staging files, then MANIFEST-LAST. No live changes made by preparation.'};
  await writeFile(resolve(output,'import-plan.json'),JSON.stringify(receipt,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({output_directory:output,expected_manifest_version:plan.expectedVersion,tables:Object.fromEntries(Object.entries(plan.tables).map(([key,value])=>[key,value.row_count])),chunk_count:plan.chunks.length,csv_files:plan.csvFiles.length,csv_bytes:plan.csvFiles.reduce((n,file)=>n+file.bytes,0),sql_files:plan.files.length,maximum_sql_bytes:Math.max(...plan.files.map(x=>x.bytes)),already_present:plan.alreadyPresent,executed:false},null,2));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});
