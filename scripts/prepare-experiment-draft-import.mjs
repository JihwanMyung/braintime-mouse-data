#!/usr/bin/env node
/** Offline administrator publication preparation. No credentials or networking.
 * Inserts reviewed preview payloads only; immutable source archive stays intact. */
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonicalStringify,ARCHIVE_CHUNK_FORMAT,MAX_ARCHIVE_PAYLOAD_BYTES} from '../web/archive-format.js';
import {postgresJsonbText} from './prepare-experiment-import.mjs';
import {checkedUuid,ADMIN_CSV_COLUMNS} from './admin-csv.mjs';
import {createDraftContext,prepareSourceDraft,GENERATOR_VERSION} from './prepare-experiment-drafts.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const same=(a,b)=>canonicalStringify(a)===canonicalStringify(b);
const byteOrder=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
export function asciiJson(value){return canonicalStringify(value).replace(/[\u007f-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));}
function sqlJson(value){const text=asciiJson(value);let n=0,tag;do{tag='$draft_json_'+sha(text+':'+n++).slice(0,16)+'$';}while(text.includes(tag));return tag+text+tag+'::jsonb';}
function protectedDo(sql,label){const marker='$'+label+'$',first=sql.indexOf(marker),last=sql.lastIndexOf(marker),body=sql.slice(first+marker.length,last);let n=0,tag;do{tag='$'+label+'_'+sha(body+':'+n++).slice(0,16)+'$';}while(body.includes(tag));return sql.slice(0,first)+tag+body+tag+sql.slice(last+marker.length);}
function validateJson(value){if(typeof value==='string'){if(value.includes('\0')||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))throw new Error('Unsupported PostgreSQL JSON encoding.');}else if(Array.isArray(value))value.forEach(validateJson);else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){validateJson(key);validateJson(item);}else if(value!==null&&!['boolean','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw new Error('Only finite JSON values are supported.');}
/** Same deterministic content-addressed chunk boundaries as encodeArchive,
 * without making a second copy of the source rows. */
export function sourceArchiveDescriptor(sources){
 const table='experiment_sources',descriptor={row_count:sources.length,chunk_ids:[]},overhead=Buffer.byteLength(canonicalStringify({format:ARCHIVE_CHUNK_FORMAT,table,rows:[]}));let texts=[],bytes=overhead;
 const flush=()=>{if(!texts.length)return;descriptor.chunk_ids.push('chunk:'+sha(`{"format":${JSON.stringify(ARCHIVE_CHUNK_FORMAT)},"rows":[${texts.join(',')}],"table":${JSON.stringify(table)}}`));texts=[];bytes=overhead;};
 for(const row of sources){const text=canonicalStringify(row),size=Buffer.byteLength(text);if(overhead+size>MAX_ARCHIVE_PAYLOAD_BYTES)throw new Error('Source row exceeds archive chunk limit.');if(bytes+size+(texts.length?1:0)>MAX_ARCHIVE_PAYLOAD_BYTES)flush();bytes+=size+(texts.length?1:0);texts.push(text);}flush();return descriptor;
}

export function prepareExperimentDraftImport({records,dataset,colonyId,ownerUserId,sourceDescriptor,maxSqlBytes=690000,maxRecords=100}){
 const colony=checkedUuid(colonyId,'Verified target colony'),owner=checkedUuid(ownerUserId,'Verified active owner');
 if(!Array.isArray(records)||!records.length)throw new Error('Nonempty reviewed preview records are required.');
 if(!Number.isSafeInteger(maxSqlBytes)||maxSqlBytes<10000||maxSqlBytes>800000||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>100)throw new Error('Use at most 100 records and 800,000 SQL bytes per batch.');
 if(!sourceDescriptor||!Number.isSafeInteger(sourceDescriptor.row_count)||sourceDescriptor.row_count!==dataset.tables.experiment_sources.length||!Array.isArray(sourceDescriptor.chunk_ids)||!sourceDescriptor.chunk_ids.length||sourceDescriptor.chunk_ids.some(x=>!/^chunk:[0-9a-f]{64}$/.test(x))||new Set(sourceDescriptor.chunk_ids).size!==sourceDescriptor.chunk_ids.length)throw new Error('A freshly captured source descriptor matching the verified source row count is required.');
 if(!same(sourceArchiveDescriptor(dataset.tables.experiment_sources),sourceDescriptor))throw new Error('Source content/chunk fingerprints differ from the captured immutable archive descriptor.');
 const stamp=records[0].app_created_at,ctx=createDraftContext(dataset,{preparedAt:stamp}),seen=new Set(),entries=[];
 for(const record of records){
   validateJson(record);if(record.app_created_at!==stamp||record.app_modified_at!==stamp||seen.has(record.event_id))throw new Error('Drafts must have unique IDs and one deterministic preparation timestamp.');seen.add(record.event_id);
   const source=ctx.sources.get(record.source_id);if(!source)throw new Error('Draft source is absent from the verified archive.');
   const expected=prepareSourceDraft(source,ctx);if(!expected.record||!same(record,expected.record))throw new Error('Preview differs from current validated source draft; regenerate/review instead of publishing altered facts.');
   entries.push({entity_id:record.event_id,source_id:record.source_id,payload:record,jsonb_sha256:sha(postgresJsonbText(record))});
 }
 entries.sort((a,b)=>byteOrder(a.entity_id,b.entity_id));
 const guard=`if auth.uid() is not null then raise exception 'Administrator SQL context with no Auth claim required; this import never impersonates a member';end if;
 perform pg_advisory_xact_lock(hashtextextended('colony:'||target_colony::text,0));
 perform 1 from public.memberships where colony_id=target_colony and user_id=responsible_owner and role='owner' and active for share;
 if not found then raise exception 'Supplied responsible owner is not an active colony owner';end if;
 select payload into archive_head from public.entity_records where colony_id=target_colony and entity_type='archive' and entity_id='reconstruction' and not archived for share;
 if not found or archive_head#>'{archive_tables,experiment_sources}' is distinct from expected_source_descriptor then raise exception 'Source archive descriptor changed or is missing; capture and verify again';end if;
 if exists(select 1 from public.entity_records r join jsonb_array_elements(changes) c on r.payload->>'source_id'=c->>'source_id'
   where r.colony_id=target_colony and r.entity_type='husbandry_events' and r.payload->>'event_type'='experiment' and r.entity_id<>c->>'entity_id') then raise exception 'A source already has another managed experiment; review before importing';end if;`;
 const render=items=>{
   const payloadHash=sha(items.map(x=>x.entity_id+':'+x.jsonb_sha256).sort(byteOrder).join('\n')),batchId=sha(canonicalStringify({colony,owner,generator:GENERATOR_VERSION,sourceDescriptor,items}));
   let doTag='$draft_insert_'+batchId.slice(0,16)+'$';while(canonicalStringify(items).includes(doTag))doTag=doTag.slice(0,-1)+'x$';
   const declarations=`target_colony uuid:='${colony}';responsible_owner uuid:='${owner}';expected_source_descriptor jsonb:=${sqlJson(sourceDescriptor)};changes jsonb:=${sqlJson(items)};archive_head jsonb;item jsonb;existing public.entity_records%rowtype;`;
   const sql=`-- PRIVATE create-only experiment source drafts. Review before administrator execution.\n-- Does not set JWT claims, modify the archive, create identities, or update existing records.\nbegin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';\ndo ${doTag}\ndeclare ${declarations}\nbegin\n${guard}
 for item in select value from jsonb_array_elements(changes) loop
   if encode(pg_catalog.sha256(convert_to((item->'payload')::text,'UTF8')),'hex') is distinct from item->>'jsonb_sha256' then raise exception 'Draft payload fingerprint mismatch';end if;
   if item#>>'{payload,event_type}'<>'experiment' or item#>>'{payload,record_origin}'<>'imported_experiment_sheet_draft' or item#>>'{payload,experiment,status}'<>'unreviewed' or item#>>'{payload,source_draft,generator}'<>'${GENERATOR_VERSION}' then raise exception 'Unexpected draft scope';end if;
   if exists(select 1 from jsonb_array_elements(item#>'{payload,experiment,participants}') p where p->>'link_status' is distinct from 'unresolved' or p->'mouse_sid' is distinct from 'null'::jsonb) then raise exception 'Draft must not confirm animal identity';end if;
   perform colony_private.validate_payload('husbandry_events',item->>'entity_id',item->'payload');
   select * into existing from public.entity_records where colony_id=target_colony and entity_type='husbandry_events' and entity_id=item->>'entity_id' for update;
   if found then
     if existing.archived or existing.payload is distinct from item->'payload' then raise exception 'Existing experiment differs; refusing overwrite';end if;
   else
     insert into public.entity_records(colony_id,entity_type,entity_id,payload,version,archived,created_by,updated_by)
     values(target_colony,'husbandry_events',item->>'entity_id',item->'payload',1,false,responsible_owner,responsible_owner);
   end if;
 end loop;
end ${doTag};
with expected as (select value from jsonb_array_elements(${sqlJson(items.map(x=>({entity_id:x.entity_id,jsonb_sha256:x.jsonb_sha256})))})),verified as (
 select r.entity_id,encode(pg_catalog.sha256(convert_to(r.payload::text,'UTF8')),'hex') digest from expected e join public.entity_records r on r.colony_id='${colony}' and r.entity_type='husbandry_events' and r.entity_id=e.value->>'entity_id' and not r.archived
 where encode(pg_catalog.sha256(convert_to(r.payload::text,'UTF8')),'hex')=e.value->>'jsonb_sha256')
select '${batchId}' as batch_id,count(*)::integer as verified_records,encode(pg_catalog.sha256(convert_to(string_agg(entity_id||':'||digest,E'\\n' order by entity_id collate "C"),'UTF8')),'hex') as payload_fingerprints_sha256 from verified;
commit;\n`;
   return {sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),batch_id:batchId,expected_records:items.length,expected_payload_fingerprints_sha256:payloadHash,entity_ids:items.map(x=>x.entity_id)};
 };
 const files=[],overhead=render([]).bytes;let batch=[],estimatedBytes=overhead;
 const flush=()=>{if(!batch.length)return;const rendered=render(batch);if(rendered.bytes>maxSqlBytes)throw new Error('SQL batch exceeds exact byte bound.');files.push(rendered);batch=[];estimatedBytes=overhead;};
 for(const item of entries){const extra=Buffer.byteLength(canonicalStringify(item))+Buffer.byteLength(canonicalStringify({entity_id:item.entity_id,jsonb_sha256:item.jsonb_sha256}))+8;
   if(overhead+extra>maxSqlBytes)throw new Error('A single draft exceeds the bounded SQL file size.');if(batch.length&&(batch.length>=maxRecords||estimatedBytes+extra>maxSqlBytes))flush();batch.push(item);estimatedBytes+=extra;}
 flush();
 const csvFiles=[],csvField=x=>'"'+String(x).replaceAll('"','""')+'"',header=ADMIN_CSV_COLUMNS.join(',')+'\r\n';let csvBatch=[],csvLines=[],csvBytes=Buffer.byteLength(header);
 const flushCsv=()=>{if(!csvBatch.length)return;const csv=header+csvLines.join(''),expected=csvBatch.map(x=>({entity_id:x.entity_id,source_id:x.source_id,jsonb_sha256:x.jsonb_sha256})),id=String(csvFiles.length+1).padStart(3,'0'),batchHash=sha(expected.map(x=>x.entity_id+':'+x.jsonb_sha256).sort(byteOrder).join('\n'));
   const preflight=`-- PRIVATE read-only CSV gate. Run immediately before an INSERT-only upload.\n-- Any existing IDs block CSV; use the idempotent SQL fallback after an interrupted upload.\nbegin;\nset local statement_timeout='30s';\ndo $csv_preflight$\ndeclare target_colony uuid:='${colony}';responsible_owner uuid:='${owner}';changes jsonb:=${sqlJson(expected)};expected_source_descriptor jsonb:=${sqlJson(sourceDescriptor)};archive_head jsonb;\nbegin\n${guard}
 if exists(select 1 from public.entity_records r join jsonb_array_elements(changes) c on r.entity_id=c->>'entity_id' where r.colony_id=target_colony and r.entity_type='husbandry_events') then raise exception 'Target IDs already exist; do not upload CSV, reconcile with create-only SQL';end if;
end $csv_preflight$;\nselect true as csv_insert_preflight_passed,${expected.length} as expected_rows,'${sha(csv)}' as csv_sha256;\ncommit;\n`;
   const postflight=`-- PRIVATE read-only verification: validates only this batch, never all managed records.\nbegin;\nset local statement_timeout='60s';\ndo $csv_verify$\ndeclare target_colony uuid:='${colony}';responsible_owner uuid:='${owner}';changes jsonb:=${sqlJson(expected)};expected_source_descriptor jsonb:=${sqlJson(sourceDescriptor)};archive_head jsonb;item jsonb;stored_csv_record public.entity_records%rowtype;\nbegin\n${guard}
 for item in select value from jsonb_array_elements(changes) loop
   select * into stored_csv_record from public.entity_records where colony_id=target_colony and entity_type='husbandry_events' and entity_id=item->>'entity_id';
   if not found or stored_csv_record.archived or stored_csv_record.version<>1 or stored_csv_record.created_by<>responsible_owner or stored_csv_record.updated_by<>responsible_owner or encode(pg_catalog.sha256(convert_to(stored_csv_record.payload::text,'UTF8')),'hex') is distinct from item->>'jsonb_sha256' then raise exception 'CSV batch missing/changed/incorrectly scoped; do not overwrite, review exact records';end if;
   perform colony_private.validate_payload('husbandry_events',stored_csv_record.entity_id,stored_csv_record.payload);
 end loop;
end $csv_verify$;\nselect true as csv_verified,${expected.length} as verified_records,'${batchHash}' as payload_fingerprints_sha256;\ncommit;\n`;
   csvFiles.push({name:id+'-INSERT-ONLY-experiment-drafts.csv',csv,bytes:Buffer.byteLength(csv),sha256:sha(csv),records:expected.length,expected_payload_fingerprints_sha256:batchHash,entity_ids:expected.map(x=>x.entity_id),preflight_name:id+'-CSV-PREFLIGHT.sql',preflight:protectedDo(preflight,'csv_preflight'),postflight_name:id+'-CSV-VERIFY.sql',postflight:protectedDo(postflight,'csv_verify')});csvBatch=[];csvLines=[];csvBytes=Buffer.byteLength(header);
 };
 for(const item of entries){const line=[colony,'husbandry_events',item.entity_id,asciiJson(item.payload),1,false,owner,owner].map(csvField).join(',')+'\r\n',size=Buffer.byteLength(line);if(size+Buffer.byteLength(header)>5000000)throw new Error('One CSV record exceeds5MB.');if(csvBatch.length&&(csvBatch.length>=1000||csvBytes+size>5000000))flushCsv();csvBatch.push(item);csvLines.push(line);csvBytes+=size;}flushCsv();
 return {schema_version:1,generator:GENERATOR_VERSION,colony_id:colony,owner_user_id:owner,records:entries.length,source_descriptor:sourceDescriptor,prepared_at:stamp,files:files.map((file,i)=>({...file,name:String(i+1).padStart(4,'0')+'-create-experiment-drafts.sql'})),csv_files:csvFiles,csv_caveat:'CSV preflight and upload are separate transactions. Primary keys prevent overwriting/concurrent same-ID creates, but cross-ID source collisions need postflight review. Prefer atomic SQL when concurrent source review cannot be excluded. Never use upsert. Partial uploads use fresh preflight and idempotent SQL fallback.',executed:false};
}

/** Narrow repair for observed CSV UTF-8 replacement in display-only source_title.
 * Requires exact evidence that every other payload field is unchanged. */
export function prepareCsvSourceTitleRepair({expectedRecord,observedPayload,colonyId,ownerUserId,sourceDescriptor}){
 const colony=checkedUuid(colonyId,'Target colony'),owner=checkedUuid(ownerUserId,'Responsible owner');validateJson(expectedRecord);validateJson(observedPayload);
 if(!expectedRecord?.event_id||expectedRecord.event_type!=='experiment'||expectedRecord.record_origin!=='imported_experiment_sheet_draft'||expectedRecord.experiment?.status!=='unreviewed'||typeof expectedRecord.source_title!=='string'||typeof observedPayload?.source_title!=='string'||!observedPayload.source_title.includes('\ufffd')||!same({...observedPayload,source_title:expectedRecord.source_title},expectedRecord)||same(observedPayload,expectedRecord))throw new Error('Repair is limited to a proven display title encoding difference.');
 if(!sourceDescriptor||!Array.isArray(sourceDescriptor.chunk_ids)||!Number.isSafeInteger(sourceDescriptor.row_count))throw new Error('Verified archive descriptor required.');
 const observedHash=sha(postgresJsonbText(observedPayload)),expectedHash=sha(postgresJsonbText(expectedRecord));
 const sql=protectedDo(`-- PRIVATE: repair one observed CSV title encoding error; all other data must match.\nbegin;\nset local lock_timeout='5s';\nset local statement_timeout='30s';\ndo $title_repair$\ndeclare target_colony uuid:='${colony}';responsible_owner uuid:='${owner}';expected jsonb:=${sqlJson(expectedRecord)};descriptor jsonb:=${sqlJson(sourceDescriptor)};stored public.entity_records%rowtype;archive_head jsonb;\nbegin
 if auth.uid() is not null then raise exception 'Administrator SQL context required';end if;
 perform pg_advisory_xact_lock(hashtextextended('colony:'||target_colony::text,0));
 perform 1 from public.memberships where colony_id=target_colony and user_id=responsible_owner and role='owner' and active for share;
 if not found then raise exception 'Verified owner is no longer active';end if;
 select payload into archive_head from public.entity_records where colony_id=target_colony and entity_type='archive' and entity_id='reconstruction' and not archived for share;
 if not found or archive_head#>'{archive_tables,experiment_sources}' is distinct from descriptor then raise exception 'Source archive changed';end if;
 select * into stored from public.entity_records where colony_id=target_colony and entity_type='husbandry_events' and entity_id=expected->>'event_id' for update;
 if not found or stored.archived or stored.created_by is distinct from responsible_owner or stored.updated_by is distinct from responsible_owner then raise exception 'Record missing or ownership/archive state differs';end if;
 if stored.version=2 and stored.payload=expected then null;
 elsif stored.version=1 and encode(pg_catalog.sha256(convert_to(stored.payload::text,'UTF8')),'hex')='${observedHash}' and jsonb_set(stored.payload,'{source_title}',expected->'source_title')=expected then
   perform colony_private.validate_payload('husbandry_events',stored.entity_id,expected);
   update public.entity_records set payload=jsonb_set(payload,'{source_title}',expected->'source_title'),version=version+1,updated_at=now(),updated_by=responsible_owner where colony_id=target_colony and entity_type='husbandry_events' and entity_id=stored.entity_id and version=1;
 else raise exception 'Record changed; refusing title repair';end if;
end $title_repair$;
select entity_id,version,encode(pg_catalog.sha256(convert_to(payload::text,'UTF8')),'hex') as payload_sha256 from public.entity_records where colony_id='${colony}' and entity_type='husbandry_events' and entity_id=${sqlJson(expectedRecord.event_id)}#>>'{}';
commit;\n`,'title_repair');
 return {sql,observed_payload_sha256:observedHash,expected_payload_sha256:expectedHash,expected_version:2,sha256:sha(sql)};
}

async function main(){
 const args=new Map();for(let i=2;i<process.argv.length;i+=2){if(!['--records','--backup','--manifest','--colony-id','--owner-user-id','--output-dir'].includes(process.argv[i])||!process.argv[i+1]||args.has(process.argv[i]))throw new Error('Expected explicit records, backup, current manifest, colony/owner IDs and new output directory.');args.set(process.argv[i],process.argv[i+1]);}if(args.size!==6)throw new Error('All six arguments are required.');
 const [recordBytes,backupBytes,manifestBytes]=await Promise.all(['--records','--backup','--manifest'].map(k=>readFile(args.get(k)))),records=recordBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse),backup=JSON.parse(backupBytes),manifest=JSON.parse(manifestBytes);
 const colony=checkedUuid(args.get('--colony-id'),'Target colony'),owner=checkedUuid(args.get('--owner-user-id'),'Responsible owner');
 if(manifest.colony_id!==colony||manifest.owner_user_id!==owner||manifest.archived||manifest.entity_type!=='archive'||manifest.entity_id!=='reconstruction')throw new Error('Explicit colony/owner IDs differ from fresh manifest capture.');
 const plan=prepareExperimentDraftImport({records,dataset:backup.sections.workspace,colonyId:colony,ownerUserId:owner,sourceDescriptor:manifest.payload?.archive_tables?.experiment_sources});
 const dir=resolve(args.get('--output-dir')),parent=resolve(dir,'..'),st=await lstat(parent),repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
 if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)||await realpath(parent)!==parent||dir===repo||dir.startsWith(repo+'/'))throw new Error('Output must be outside public repository under a canonical private0700 directory.');await mkdir(dir,{mode:0o700});
 for(const file of plan.files)await writeFile(join(dir,file.name),file.sql,{flag:'wx',mode:0o600});
 for(const file of plan.csv_files)for(const [name,body]of [[file.name,file.csv],[file.preflight_name,file.preflight],[file.postflight_name,file.postflight]])await writeFile(join(dir,name),body,{flag:'wx',mode:0o600});
 const report={...plan,input_records_sha256:sha(recordBytes),input_backup_sha256:sha(backupBytes),input_manifest_sha256:sha(manifestBytes),files:plan.files.map(({sql,...metadata})=>metadata),csv_files:plan.csv_files.map(({csv,preflight,postflight,...metadata})=>({...metadata,preflight_sha256:sha(preflight),postflight_sha256:sha(postflight)}))};await writeFile(join(dir,'publication-plan.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({records:plan.records,files:plan.files.length,csv_files:plan.csv_files.length,total_sql_bytes:plan.files.reduce((n,x)=>n+x.bytes,0),max_sql_bytes:Math.max(...plan.files.map(x=>x.bytes)),executed:false},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
