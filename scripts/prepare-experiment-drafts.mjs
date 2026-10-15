#!/usr/bin/env node
/** Offline review package only. Never connects to a server or changes source data.
 * One draft represents one source observation, not a distinct biological event.
 * Specimen inventory is deliberately not inferred from historical source rows. */
import {readFile,writeFile,mkdir,open,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {blankExperiment,EXPERIMENT_ASSAYS,validateExperimentRecord} from '../web/experiment-model.js';
import {sourceParticipants,experimentSources} from '../web/experiment-sources.js';
import {canonicalStringify} from '../web/archive-format.js';
import {checkedUuid} from './admin-csv.mjs';

export const GENERATOR_VERSION='experiment-source-drafts-v3-compact';
const KINDS=new Set(['tissue_sampling','csf_sample','assay_run','imaging_sample']);
const sha=x=>createHash('sha256').update(x).digest('hex');
const fingerprint=x=>sha(canonicalStringify(x));
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const arr=x=>Array.isArray(x)?x:[];
const str=x=>typeof x==='string'?x.trim():'';
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const label=x=>String(x).replace(/^[A-Z]{1,3}\s*·\s*/,'').replace(/\s+/g,' ').trim().toLowerCase();
const meaningful=x=>typeof x==='string'&&Boolean(x.trim())&&!/^(?:[-—–?]+|n\/?a|none|null|unknown|tbd|false|true|date|name|sample name|mouse id|animal id|tissues?|sample|water|blank)$/i.test(x.trim())&&!x.trim().startsWith('=');
const number=x=>(typeof x==='number'&&Number.isFinite(x))||(typeof x==='string'&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(x.trim())&&Number.isFinite(Number(x)));
const clock=x=>typeof x==='string'&&/^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(x.trim());
const fields=source=>Object.entries(obj(source.raw_values)?source.raw_values:{}).map(([key,value])=>({key,label:label(key),value}));
const values=(fs,re)=>fs.filter(x=>re.test(x.label));
const present=(fs,re)=>values(fs,re).some(x=>meaningful(x.value));
const measured=(fs,re)=>values(fs,re).some(x=>number(x.value));
const dated=(fs,re)=>values(fs,re).some(x=>typeof x.value==='string'&&/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(x.value)&&date(x.value.slice(0,10)));

/** Deliberately conservative. A date or preprinted protocol by itself is not
 * evidence of a performed assay. Timing remains raw, even when it admits a row. */
export function sourceEligibility(source,{asOfDate}={}) {
  if(!KINDS.has(source?.kind))return {eligible:false,reason:'unsupported_source_kind',evidence:[],flags:[]};
  const fs=fields(source),evidence=[],flags=[];
  const ids=arr(source.raw_identifiers).filter(meaningful),sample=meaningful(source.tissue)||present(fs,/sample (?:name|id)|tissue.*name|tissue sample/);
  const numeric=measured(fs,/concentration|absorbance|a260|a280|260\s*\/\s*(?:280|230)|td20\s*\/\s*20|\[eb\].*(?:csf|plasma)/);
  const result=present(fs,/(?:qpcr|result|output).*(?:file|path)|(?:data|result).*(?:url|link)/);
  const actualClock=values(fs,/sampling (?:hour|time)|^actual time$/).some(x=>clock(x.value));
  const planText=fs.filter(x=>/status|note|comment/.test(x.label)).map(x=>String(x.value??''));
  const planned=/\b(?:planned|planning|not done|not performed|cancelled|canceled|to do|tbd)\b/i.test(planText.join('\n'))
    ||fs.some(x=>typeof x.value==='string'&&/^(?:planned|planning|not done|not performed|cancelled|canceled|to do|tbd)$/i.test(x.value.trim()));
  const template=/\b(?:template|example|blank form)\b/i.test(source.sheet_name??'')||fs.some(x=>/^(?:status|record status)$/.test(x.label)&&/template|example/i.test(String(x.value)));
  if(asOfDate&&date(source.date)&&source.date>asOfDate)return {eligible:false,reason:'future_event_date',evidence,flags};
  if((planned||template)&&!numeric&&!result)return {eligible:false,reason:planned?'planned_or_cancelled_without_result':'template_without_result',evidence,flags};
  if(planned||template)flags.push('planning_or_template_text_with_recorded_result_needs_review');
  if(source.kind==='tissue_sampling') {
    if(!meaningful(source.tissue)||!ids.length)return {eligible:false,reason:'no_specific_sample_and_identifier',evidence,flags};
    if(actualClock)evidence.push('explicit_sampling_clock_label');
    if(numeric)evidence.push('recorded_sample_measurement');
    if(dated(fs,/extraction date|lysis date|rna purification date/))evidence.push('recorded_sample_processing_date');
  } else if(source.kind==='csf_sample') {
    if(!ids.length)return {eligible:false,reason:'no_sample_identifier',evidence,flags};
    if(numeric)evidence.push('recorded_csf_measurement');
    if(actualClock&&date(source.date))evidence.push('dated_actual_sampling_clock_label');
  } else if(source.kind==='assay_run') {
    if(!sample&&!ids.length)return {eligible:false,reason:'no_specific_sample',evidence,flags};
    if(result)evidence.push('recorded_result_filename_or_link');
    if(numeric)evidence.push('recorded_sample_measurement');
    if(date(source.date)&&source.identifier_kind==='sample_label'&&ids.length&&meaningful(source.tissue)
      &&present(fs,/primary ab|sectioning|staining|thickness|orientation/)) {
      evidence.push('dated_named_sample_assay_details');flags.push('assay_result_not_verified');
    }
  } else if(source.kind==='imaging_sample') {
    if(date(source.date)&&source.identifier_kind==='sample_label'&&ids.length&&meaningful(source.tissue)&&present(fs,/^location$/))evidence.push('dated_named_imaging_sample_location');
  }
  if(!evidence.length)return {eligible:false,reason:'no_clear_recorded_sample_or_result_evidence',evidence,flags};
  if(!date(source.date))flags.push('event_date_unknown');
  if(source.identifier_kind==='sample_label')flags.push('specimen_labels_are_not_animal_identifiers');
  flags.push('one_source_observation_not_one_biological_event','identity_and_completion_unreviewed','no_current_specimen_stock_claim');
  return {eligible:true,reason:'recorded_source_evidence',evidence,flags};
}

export function draftId(sourceId){if(typeof sourceId!=='string'||!sourceId.trim()||sourceId!==sourceId.trim()||sourceId.length>200)throw new Error('Invalid source identifier.');const id='EXP-SOURCE-'+sourceId;return id.length<=200?id:'EXP-SOURCE-'+sha(sourceId);}
function referenceKeys(source,dataset){
  const refs=[];
  if(source.workbook_id!=null&&source.sheet_id!=null&&source.range)refs.push([String(source.workbook_id),String(source.sheet_id),source.range]);
  for(const ref of arr(source.provenance_refs)){
    const catalog=dataset.tables.experiment_source_catalog?.[ref?.[0]];
    if(!catalog||ref[1]==null||!ref[3])throw new Error('Unresolved source provenance reference.');
    refs.push([String(catalog.file_id??catalog.workbook_id),String(ref[1]),ref[3]]);
  }
  if(!refs.length)throw new Error('Source provenance coordinates are missing.');
  return [...new Set(refs.map(fingerprint))].sort();
}
export function createDraftContext(dataset,{preparedAt}={}) {
  if(!obj(dataset?.tables)||!Array.isArray(dataset.tables.experiment_sources)||!Array.isArray(dataset.tables.mice)||!Array.isArray(dataset.tables.husbandry_events))throw new Error('Complete source and managed tables are required.');
  if(typeof preparedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(preparedAt)||new Date(preparedAt).toISOString()!==preparedAt)throw new Error('Supply an explicit canonical --prepared-at timestamp.');
  const byId=new Map(),bySource=new Map(),sources=new Map(),history=new Map(),refs=new Map();
  for(const row of dataset.tables.husbandry_events){if(byId.has(row.event_id))throw new Error('Duplicate managed event identifier.');byId.set(row.event_id,row);if(row.source_id&&row.event_type==='experiment'){const bucket=bySource.get(row.source_id)??[];bucket.push(row);bySource.set(row.source_id,bucket);}}
  for(const source of dataset.tables.experiment_sources){draftId(source.source_id);if(sources.has(source.source_id))throw new Error('Duplicate source identifier.');sources.set(source.source_id,source);const keys=referenceKeys(source,dataset);refs.set(source.source_id,keys);for(const key of keys){const ids=history.get(key)??[];ids.push(source.source_id);history.set(key,ids);}}
  // Reuse original mouse references and just the managed event table. No source
  // archive or whole-workspace structuredClone occurs per generated record.
  const validationDataset={tables:{mice:dataset.tables.mice,husbandry_events:dataset.tables.husbandry_events}};
  return {dataset,preparedAt,byId,bySource,sources,history,refs,validationDataset,primaryById:new Map(experimentSources(dataset).map(x=>[x.source_id,x])),mouseById:new Map(dataset.tables.mice.map(x=>[x.mouse_sid,x]))};
}
export function prepareSourceDraft(source,context){
  const {dataset,preparedAt}=context,eligibility=sourceEligibility(source,{asOfDate:preparedAt.slice(0,10)});
  const index={source_id:source.source_id,source_kind:source.kind,source_fingerprint:fingerprint(source),...eligibility};
  if(!eligibility.eligible)return {index:{...index,disposition:'excluded'},record:null};
  const eventId=draftId(source.source_id),participants=sourceParticipants(source,dataset),flags=[...eligibility.flags];
  if(participants.some(x=>x.candidate_sids.length>1))flags.push('ambiguous_animal_candidates');
  if(participants.some(x=>!x.candidate_sids.length))flags.push('unmatched_animal_identifier');
  if(participants.some(x=>x.candidate_sids.some(id=>date(source.date)&&date(context.mouseById.get(id)?.date_of_birth)&&source.date<context.mouseById.get(id).date_of_birth)))flags.push('candidate_birth_after_source_date');
  const keys=context.refs.get(source.source_id),relatedKeys=keys.filter(key=>context.history.get(key).length>1);
  if(relatedKeys.length)flags.push('same_source_cell_has_other_observations_not_merged');
  const p=blankExperiment();p.status='unreviewed';p.title=['Source record',arr(source.assays).join(' / '),source.tissue,arr(source.raw_identifiers).join(', '),source.date||'date unknown'].filter(Boolean).join(' · ').slice(0,200);
  p.assays=[...new Set(arr(source.assays).map(x=>x==='Other'?'other':x).filter(x=>EXPERIMENT_ASSAYS.includes(x)))];if(!p.assays.length)p.assays=['other'];
  p.participants=participants;p.operator=typeof source.operator==='string'?source.operator:null;p.project=typeof source.project==='string'?source.project:null;p.protocol=typeof source.protocol==='string'?source.protocol:typeof source.condition==='string'?source.condition:null;
  const primary=context.primaryById.get(source.source_id),lightweight=Object.fromEntries(['source_id','kind','date','sampling_date','identifier_kind','raw_identifiers','tissue','storage'].filter(k=>Object.hasOwn(source,k)).map(k=>[k,structuredClone(source[k])]));
  const provenance={source_id:source.source_id,source_title:primary.workbook_title??null,source_sheet:primary.sheet_name??null,source_range:primary.range??null,source_url:primary.source_url??null,source_snapshot_date:primary.snapshot_date??null,
    source_ref:{schema_version:1,table:'experiment_sources',source_id:source.source_id,source_fingerprint:index.source_fingerprint,storage:'immutable_source_archive'},source_observation:lightweight};
  const record={event_id:eventId,event_type:'experiment',...provenance,record_origin:'imported_experiment_sheet_draft',event_date:date(source.date)?source.date:null,app_created_at:preparedAt,app_modified_at:preparedAt,
    source_draft:{schema_version:1,generator:GENERATOR_VERSION,source_fingerprint:index.source_fingerprint,evidence:eligibility.evidence,review_status:'unreviewed',flags},
    source_history_relation:{basis:'exact_workbook_sheet_range',shared_reference_count:relatedKeys.length,biological_event_deduplication:'not_attempted'},experiment:p};
  const existing=context.byId.get(eventId),sourceExisting=context.bySource.get(source.source_id)??[];
  if(existing){const candidate={...record,app_created_at:existing.app_created_at,app_modified_at:existing.app_modified_at};const identical=!existing.archived&&!existing.app_archived_at&&fingerprint(existing)===fingerprint(candidate);return {index:{...index,flags,event_id:eventId,disposition:identical?'already_identical':'conflict_existing_record'},record:null};}
  if(sourceExisting.length)return {index:{...index,flags,event_id:eventId,disposition:'already_managed_source'},record:null};
  const checked=validateExperimentRecord(record,context.validationDataset);
  if(checked.errors.length)return {index:{...index,flags,event_id:eventId,disposition:'validation_rejected',validation_errors:checked.errors},record:null};
  if(Buffer.byteLength(canonicalStringify(record))>500000)return {index:{...index,flags,event_id:eventId,disposition:'record_too_large'},record:null};
  return {index:{...index,flags,event_id:eventId,disposition:'draft',record_sha256:fingerprint(record),validation_warnings:checked.warnings},record};
}

/** Future publication may use these changes through existing authenticated
 * save_records only. Capture existing records immediately before each batch;
 * identical records are skipped, all conflicts stop. expected_version stays 0. */
export function prepareCreateOnlyBatches(records,existingRecords,{colonyId,maxBytes=700000,maxRecords=100}={}){
  const colony=checkedUuid(colonyId,'Verified target colony'),existing=new Map(),seen=new Set(),batches=[];let changes=[],bytes=2,identical=0;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1000||maxBytes>800000||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>100)throw new Error('Invalid publication bounds.');
  for(const row of existingRecords){if(row.colony_id!==colony||row.entity_type!=='husbandry_events'||existing.has(row.entity_id))throw new Error('Captured records must be unique and scoped to the verified colony.');existing.set(row.entity_id,row);}
  for(const record of records){
    if(record.event_type!=='experiment'||record.record_origin!=='imported_experiment_sheet_draft'||record.experiment?.status!=='unreviewed'||record.source_draft?.generator!==GENERATOR_VERSION||!record.source_id||draftId(record.source_id)!==record.event_id||record.source_ref?.source_fingerprint!==record.source_draft.source_fingerprint||seen.has(record.event_id))throw new Error('Only validated unique source drafts may be published.');
    if(arr(record.experiment.participants).some(x=>x.link_status!=='unresolved'||x.mouse_sid!==null))throw new Error('Draft publication cannot confirm animals.');seen.add(record.event_id);
    const old=existing.get(record.event_id);if(old){if(old.archived||fingerprint(old.payload)!==fingerprint(record))throw new Error('Existing draft differs; refusing overwrite.');identical++;continue;}
    const change={entity_type:'husbandry_events',entity_id:record.event_id,payload:record,expected_version:0,archived:false},size=Buffer.byteLength(canonicalStringify(change))+1;
    if(size+2>maxBytes)throw new Error('One draft exceeds publication bounds.');
    if(changes.length&&(changes.length>=maxRecords||bytes+size>maxBytes)){batches.push({p_colony_id:colony,p_changes:changes});changes=[];bytes=2;}changes.push(change);bytes+=size;
  }
  if(changes.length)batches.push({p_colony_id:colony,p_changes:changes});
  return {batches,identical,policy:'create_only_expected_version_zero; ambiguous outcome requires recapture; never upsert'};
}

export async function writePreview({dataset,outputDir,preparedAt,inputMetadata={}}){
  const context=createDraftContext(dataset,{preparedAt}),dir=resolve(outputDir);
  const parent=resolve(dir,'..'),parentStat=await lstat(parent),canonicalParent=await realpath(parent),repository=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||canonicalParent!==parent||(parentStat.mode&0o077))throw new Error('Output parent must be a canonical private directory (0700).');
  if(dir===repository||dir.startsWith(repository+'/'))throw new Error('Private draft output must remain outside the public repository.');
  await mkdir(dir,{mode:0o700}); // exclusive: preserve previous previews and reports
  const handles={};for(const name of ['records.jsonl','review-index.jsonl','source-history-index.jsonl'])handles[name]=await open(join(dir,name),'wx',0o600);
  const report={schema_version:1,generator:GENERATOR_VERSION,prepared_at:preparedAt,scope:'private offline preview; no live writes or executable publication SQL',...inputMetadata,source_observations:context.sources.size,drafts:0,managed_specimens_created:0,confirmed_animal_links:0,distinct_biological_event_count:null,by_kind:{},dispositions:{},exclusion_reasons:{},flags:{},bytes:0,max_record_bytes:0,publication:{prepared:false,requires:'Review eligibility and capture current colony UUID and managed records; use bounded create-only authenticated save_records batches, never direct upsert.'}};
  const recordsHash=createHash('sha256');
  try{
    for(const source of context.sources.values()){
      const {record,index}=prepareSourceDraft(source,context);await handles['review-index.jsonl'].write(JSON.stringify(index)+'\n');
      report.dispositions[index.disposition]=(report.dispositions[index.disposition]??0)+1;
      if(index.disposition==='excluded')report.exclusion_reasons[index.reason]=(report.exclusion_reasons[index.reason]??0)+1;
      if(record){const line=canonicalStringify(record)+'\n',size=Buffer.byteLength(line);await handles['records.jsonl'].write(line);recordsHash.update(line);report.drafts++;report.by_kind[source.kind]=(report.by_kind[source.kind]??0)+1;report.bytes+=size;report.max_record_bytes=Math.max(report.max_record_bytes,size);for(const flag of index.flags)report.flags[flag]=(report.flags[flag]??0)+1;}
    }
    let relations=0;for(const [key,ids]of context.history)if(ids.length>1){await handles['source-history-index.jsonl'].write(JSON.stringify({reference_key:key,source_ids:[...ids].sort(),meaning:'Same exact source cell, not proof of same biological event or a correction order.'})+'\n');relations++;}
    report.shared_source_cell_groups=relations;report.records_sha256=recordsHash.digest('hex');
    report.publication.estimated_700kb_batches=Math.ceil(report.bytes/700000);
    for(const handle of Object.values(handles))await handle.sync();
    await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    await writeFile(join(dir,'README.md'),'# Private experiment source draft preview\n\nNo live data was changed. Each draft is one historical source observation, not one distinct experiment, animal, or specimen. All identities and completion remain unreviewed. No specimen inventory records were generated: sample boundaries, pooling, availability and current stock need review.\n\nrecords.jsonl contains proposed managed experiment drafts. review-index.jsonl explains every inclusion, exclusion and conflict. source-history-index.jsonl groups only exact source coordinates; changed observations are retained separately and are not interpreted as biological duplicates or ordered corrections. report.json contains counts and checksums.\n\nThe compact source_ref points to the unchanged immutable source observation by ID and full canonical SHA256. All raw timing, phase, entrainment and provenance remain in that archive, not copied into every draft. source_observation is explicitly a lightweight snapshot for existing sample-review behavior. No exact timestamps, ZT/CT, entrainment durations, confirmed animal identities or current stock were inferred. Dates remain null where the parser did not have a valid recorded date.\n\nBefore publication, review eligibility and capture current managed records and the target colony UUID. prepareCreateOnlyBatches() skips exact existing payloads and refuses changed or archived records. Submit only through existing authenticated save_records with expected_version 0. After uncertain network outcomes, capture again before retrying. A separately reviewed administrator publication generator may use bounded create-only SQL with null-auth and active-owner guards. This preview contains no executable SQL, credentials or database authorization.\n',{flag:'wx',mode:0o600});
  }finally{for(const handle of Object.values(handles))await handle.close();}
  return report;
}

async function main(){
  const args=new Map();for(let i=2;i<process.argv.length;i+=2){if(!['--backup','--sources','--output-dir','--prepared-at'].includes(process.argv[i])||!process.argv[i+1]||args.has(process.argv[i]))throw new Error('Use --backup PATH --sources PATH --output-dir NEW_PRIVATE_DIRECTORY --prepared-at CANONICAL_UTC.');args.set(process.argv[i],process.argv[i+1]);}
  if(args.size!==4)throw new Error('All four arguments are required.');
  const [backupBytes,sourceBytes]=await Promise.all([readFile(args.get('--backup')),readFile(args.get('--sources'))]),backup=JSON.parse(backupBytes),source=JSON.parse(sourceBytes),dataset=backup.sections?.workspace;
  if(backup.kind!=='braintime-local-backup'||backup.full_workspace!==true||backup.permission?.level!=='max')throw new Error('A full Max owner-local backup is required.');
  for(const [table,key]of [['experiment_sources','observations'],['experiment_source_catalog','sources'],['experiment_source_contexts','contexts'],['experiment_source_coverage',null]])if(fingerprint(dataset?.tables?.[table])!==fingerprint(key?source[key]:[source.coverage]))throw new Error('Backup and source package differ: '+table);
  const parent=await lstat(resolve(args.get('--output-dir'),'..'));if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077))throw new Error('Output parent must be an existing private directory (0700).');
  const report=await writePreview({dataset,outputDir:args.get('--output-dir'),preparedAt:args.get('--prepared-at'),inputMetadata:{backup_file_sha256:sha(backupBytes),source_file_sha256:sha(sourceBytes),backup_created_at:backup.created_at}});
  console.log(JSON.stringify({drafts:report.drafts,by_kind:report.by_kind,dispositions:report.dispositions,bytes:report.bytes,records_sha256:report.records_sha256,live_writes:0},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
