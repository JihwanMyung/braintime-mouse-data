/* Experiments and specimens are versioned husbandry records. Linking a mouse,
 * completing an assay, or recording sample usage never changes animal state or
 * specimen stock. Imported source_* observations remain immutable. */
import {blankEntrainment,validateEntrainment} from './experiment-timing.js?v=24';
export const EXPERIMENT_ASSAYS=Object.freeze(['LumiCycle','IMG','qPCR','WB','IF/IHC','CSF','tissue_storage','other']);
export const EXPERIMENT_ASSAY_LABELS=Object.freeze({LumiCycle:'LumiCycle',IMG:'IMG (Imaging)',qPCR:'qPCR',WB:'WB', 'IF/IHC':'IF / IHC',CSF:'CSF sampling',tissue_storage:'Tissue collection / storage',other:'Other'});
export const EXPERIMENT_STATUSES=Object.freeze(['unreviewed','planned','in_progress','completed','cancelled']);
export const SAMPLE_STATUSES=Object.freeze(['unreviewed','available','stored','depleted','transferred','discarded']);
export const EXPERIMENT_TIME_BASES=Object.freeze(['unknown','clock','ZT','CT','other']);
export const SAMPLE_DISPOSITIONS=Object.freeze(['not_recorded','returned','partial','consumed']);
const EXPERIMENT='experiment',SAMPLE='experiment_sample',REVISION='experiment_revision';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&x.trim().length>0;
const blank=x=>x===null||x===undefined||x==='';
const archived=x=>Boolean(x?.app_archived_at)||x?.archived===true;
const rows=d=>Array.isArray(d?.tables?.husbandry_events)?d.tables.husbandry_events:[];
const clone=structuredClone;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const timestamp=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(x)&&date(x.slice(0,10))&&Number.isFinite(Date.parse(x));
const quantity=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const unique=x=>[...new Set(x)];
const mouseIndex=d=>new Map((d?.tables?.mice??[]).map(m=>[m.mouse_sid,m]));
const nullable=x=>blank(x)?null:x;
const list=x=>Array.isArray(x)?x:[];

export function listExperiments(dataset,{includeArchived=false}={}) {
  return rows(dataset).filter(r=>r.event_type===EXPERIMENT&&(includeArchived||!archived(r))).sort(orderRecords);
}
export function listExperimentSamples(dataset,{includeArchived=false}={}) {
  return rows(dataset).filter(r=>r.event_type===SAMPLE&&(includeArchived||!archived(r))).sort(orderRecords);
}
export function listExperimentRevisions(dataset,entityId) {
  return rows(dataset).filter(r=>r.event_type===REVISION&&r.experiment_revision?.entity_id===entityId)
    .sort((a,b)=>(b.experiment_revision.revision_after??0)-(a.experiment_revision.revision_after??0)||orderRecords(a,b));
}
function orderRecords(a,b){return String(b.event_date??'').localeCompare(String(a.event_date??''))||String(a.event_id).localeCompare(String(b.event_id));}

/** Returns explicit, confirmed mouse SIDs, following recorded specimen lineage.
 * Candidate matches are deliberately excluded. Cycles in malformed imports are
 * bounded; validation rejects new cycles before saving. */
export function sampleMouseSids(sample,dataset,visited=new Set()) {
  if(!sample||visited.has(sample.event_id))return [];
  const seen=new Set(visited);seen.add(sample.event_id);
  const payload=sample.experiment_sample??{},index=new Map(listExperimentSamples(dataset,{includeArchived:true}).map(r=>[r.event_id,r]));
  const own=(Array.isArray(payload.donors)?payload.donors:[]).filter(p=>p?.link_status==='confirmed'&&text(p.mouse_sid)).map(p=>p.mouse_sid);
  return unique([...own,...(Array.isArray(payload.parent_sample_ids)?payload.parent_sample_ids:[]).flatMap(id=>sampleMouseSids(index.get(id),dataset,seen))]);
}
export function experimentMouseSids(experiment,dataset) {
  const p=experiment?.experiment??{},samples=new Map(listExperimentSamples(dataset,{includeArchived:true}).map(r=>[r.event_id,r]));
  return unique([...(Array.isArray(p.participants)?p.participants:[]).filter(r=>r?.link_status==='confirmed'&&text(r.mouse_sid)).map(r=>r.mouse_sid),
    ...(Array.isArray(p.sample_usages)?p.sample_usages:[]).flatMap(r=>sampleMouseSids(samples.get(r?.sample_id),dataset)),
    ...[...samples.values()].filter(r=>r.experiment_sample?.experiment_id===experiment?.event_id).flatMap(r=>sampleMouseSids(r,dataset))]);
}
export function experimentsForMouse(dataset,mouseSid,{includeArchived=false}={}) {
  return listExperiments(dataset,{includeArchived}).filter(r=>experimentMouseSids(r,dataset).includes(mouseSid));
}
export function samplesForMouse(dataset,mouseSid,{includeArchived=false}={}) {
  return listExperimentSamples(dataset,{includeArchived}).filter(r=>sampleMouseSids(r,dataset).includes(mouseSid));
}
export function summarizeExperiments(dataset) {
  const experiments=listExperiments(dataset),samples=listExperimentSamples(dataset),linked=unique([...experiments.flatMap(r=>experimentMouseSids(r,dataset)),...samples.flatMap(r=>sampleMouseSids(r,dataset))]);
  const unresolved=experiments.reduce((n,r)=>n+list(r.experiment?.participants).filter(p=>p?.link_status!=='confirmed').length,0)+samples.reduce((n,r)=>n+list(r.experiment_sample?.donors).filter(p=>p?.link_status!=='confirmed').length,0);
  return {experiments:experiments.length,active:experiments.filter(r=>['planned','in_progress'].includes(r.experiment?.status)).length,
    mice:linked.length,samples:samples.length,stored:samples.filter(r=>r.experiment_sample?.status==='stored').length,unresolved,
    assays:Object.fromEntries(EXPERIMENT_ASSAYS.map(a=>[a,experiments.filter(r=>list(r.experiment?.assays).includes(a)).length]))};
}

function optionalText(p,key,max,errors,label=key) {
  if(p[key]!=null&&(typeof p[key]!=='string'||p[key].length>max))errors.push(`${label} must be text of at most ${max.toLocaleString('en-US')} characters or blank.`);
}
function stringIds(value,label,errors) {
  if(!Array.isArray(value)||value.some(x=>!text(x)||x.length>200)||new Set(value).size!==value.length){errors.push(`${label} must contain distinct nonempty identifiers.`);return [];}
  return value;
}
function validTimezone(value) {
  if(!text(value))return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format();return true;}catch{return false;}
}
function localDay(value,zone) {
  if(!timestamp(value)||!validTimezone(zone))return null;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  return ['year','month','day'].map(k=>parts.find(x=>x.type===k)?.value).join('-');
}
function timingErrors(p,fields,errors) {
  for(const key of fields)if(!blank(p[key])&&!timestamp(p[key]))errors.push(`${key} must be an ISO date and time with a UTC offset, or blank.`);
  if(!blank(p.timezone)&&!validTimezone(p.timezone))errors.push('Timezone must be a valid IANA timezone such as Asia/Taipei.');
  if(fields.some(k=>!blank(p[k]))&&!validTimezone(p.timezone))errors.push('A recorded time needs its timezone.');
  if(!EXPERIMENT_TIME_BASES.includes(p.time_basis))errors.push('Select clock, ZT, CT, other, or unknown as the time basis.');
  optionalText(p,'circadian_time',100,errors,'Circadian time');
  if(text(p.circadian_time)&&p.time_basis==='unknown')errors.push('Specify the time basis for a circadian time.');
}
function procedureTimingErrors(p,samplingField,errors) {
  for(const prefix of ['decapitation',...(samplingField==='sampling_at'?['sampling']:[])]) {
    const key=prefix+'_circadian_time',basis=p[prefix+'_time_basis']??'unknown',label=prefix==='decapitation'?'Decapitation':'Sampling';
    optionalText(p,key,100,errors,`${label} circadian time`);
    if(!EXPERIMENT_TIME_BASES.includes(basis))errors.push(`${label} time basis must be clock, ZT, CT, other, or unknown.`);
    if(text(p[key])&&basis==='unknown')errors.push(`Specify the time basis for ${prefix} circadian time.`);
  }
  if(timestamp(p.decapitation_at)&&timestamp(p[samplingField])&&Date.parse(p[samplingField])<Date.parse(p.decapitation_at))errors.push('Exact sampling time cannot precede decapitation time.');
}
function referenceErrors(value,dataset,label,errors) {
  if(!Array.isArray(value)||value.length>1000){errors.push(`${label} must be an array of at most 1,000 animal links.`);return;}
  const mice=mouseIndex(dataset),seen=new Set();
  value.forEach((r,i)=>{
    const name=`${label} ${i+1}`;
    if(!obj(r)){errors.push(`${name} must be an animal link.`);return;}
    if(!['confirmed','unresolved'].includes(r.link_status))errors.push(`${name}: choose a confirmed or unresolved identity.`);
    optionalText(r,'raw_identifier',500,errors,`${name} source identifier`);
    optionalText(r,'role',160,errors,`${name} role`);optionalText(r,'notes',2000,errors,`${name} notes`);
    const candidates=stringIds(r.candidate_sids??[],`${name} candidate mice`,errors);
    for(const id of candidates)if(!mice.has(id))errors.push(`${name}: candidate mouse ${id} does not exist.`);
    if(r.link_status==='confirmed') {
      if(!text(r.mouse_sid)||!mice.has(r.mouse_sid))errors.push(`${name}: confirmed mouse ${r.mouse_sid??''} does not exist. Retain unmatched identifiers as unresolved.`);
      if(seen.has(r.mouse_sid))errors.push(`${label}: mouse ${r.mouse_sid} is linked more than once.`);seen.add(r.mouse_sid);
      if(candidates.length)errors.push(`${name}: a confirmed identity cannot also retain candidate mouse links.`);
    } else if(r.link_status==='unresolved') {
      if(!blank(r.mouse_sid))errors.push(`${name}: unresolved identity must not contain a confirmed mouse SID.`);
      if(!text(r.raw_identifier))errors.push(`${name}: keep the original identifier for an unresolved animal.`);
    }
  });
}
function commonErrors(p,draft,errors) {
  for(const key of ['operator','project'])optionalText(p,key,300,errors);
  for(const key of ['protocol','notes'])optionalText(p,key,8000,errors);
  if(!blank(draft.event_date)&&!date(draft.event_date))errors.push('Effective date must be YYYY-MM-DD or blank.');
  if(!Number.isSafeInteger(p.revision??0)||(p.revision??0)<0)errors.push('Record revision must be a nonnegative integer.');
  if((p.revision??0)===0&&!blank(p.last_revision_id)||(p.revision??0)>0&&!text(p.last_revision_id))errors.push('Record revision and latest revision identifier must agree.');
  if(p.entrainment!=null)errors.push(...validateEntrainment(p.entrainment));
  for(const key of ['circadian_time_source','decapitation_circadian_time_source','sampling_circadian_time_source'])if(p[key]!=null&&!['recorded','calculated'].includes(p[key]))errors.push('Circadian time source must be recorded or calculated.');
}
function experimentErrors(p,draft,dataset,errors,warnings) {
  if(!obj(p)||p.schema_version!==1){errors.push('Experiment must use schema version 1.');return;}
  if(!text(p.title)||p.title.length>200)errors.push('Enter an experiment title of 1–200 characters.');
  if(!Array.isArray(p.assays)||!p.assays.length||p.assays.some(a=>!EXPERIMENT_ASSAYS.includes(a))||unique(p.assays).length!==p.assays.length)errors.push('Choose one or more distinct supported assays.');
  if(!EXPERIMENT_STATUSES.includes(p.status))errors.push('Select a valid experiment status.');
  commonErrors(p,draft,errors);timingErrors(p,['started_at','ended_at','decapitation_at','sampling_at'],errors);procedureTimingErrors(p,'sampling_at',errors);
  if(timestamp(p.started_at)&&timestamp(p.ended_at)&&Date.parse(p.ended_at)<Date.parse(p.started_at))errors.push('Experiment end cannot precede its start.');
  if(timestamp(p.started_at)&&date(draft.event_date)&&localDay(p.started_at,p.timezone)!==draft.event_date)errors.push('Experiment effective date must match its start date in the recorded timezone.');
  referenceErrors(p.participants,dataset,'Participants',errors);
  const mice=mouseIndex(dataset);
  for(const ref of list(p.participants))if(ref?.link_status==='confirmed') {
    const dob=mice.get(ref.mouse_sid)?.date_of_birth;
    if(date(dob)&&date(draft.event_date)&&draft.event_date<dob)errors.push(`Experiment date precedes the birth of mouse ${ref.mouse_sid}. Review the source date or animal identity.`);
  }
  if(!Array.isArray(p.result_urls)||p.result_urls.length>30||p.result_urls.some(url=>{try{return !['http:','https:'].includes(new URL(url).protocol)||typeof url!=='string'||url.length>2048;}catch{return true;}}))errors.push('Results links must be at most 30 HTTP or HTTPS URLs.');
  if(!Array.isArray(p.sample_usages)||p.sample_usages.length>1000){errors.push('Sample usages must be an array of at most 1,000 links.');return;}
  const samples=new Map(listExperimentSamples(dataset,{includeArchived:true}).map(r=>[r.event_id,r])),seen=new Set();
  for(const use of p.sample_usages) {
    if(!obj(use)){errors.push('Each sample usage must be a record.');continue;}
    if(!text(use.sample_id)||!samples.has(use.sample_id))errors.push(`Sample ${use.sample_id??''} does not exist.`);
    if(seen.has(use.sample_id))errors.push('Record each specimen only once per experiment.');seen.add(use.sample_id);
    optionalText(use,'purpose',1000,errors);optionalText(use,'unit',80,errors);
    if(!blank(use.amount)&&(!quantity(use.amount)||use.amount===0))errors.push('Sample use amount must be positive or unknown.');
    if(quantity(use.amount)&&!text(use.unit))errors.push('A sample use amount needs its unit.');
    if(!SAMPLE_DISPOSITIONS.includes(use.disposition))errors.push('Choose a sample disposition or not recorded.');
    const sample=samples.get(use.sample_id);
    if(sample&&date(sample.event_date)&&date(draft.event_date)&&sample.event_date>draft.event_date)errors.push('A sample cannot be used before its collection date.');
    if(['partial','consumed'].includes(use.disposition))warnings.push('Sample usage does not change stored quantity automatically. Record the observed stock separately.');
  }
  if(!p.participants?.length&&!p.sample_usages.length)warnings.push('No animals or specimens are linked to this experiment yet.');
  if(list(p.participants).some(x=>x?.link_status==='unresolved'))warnings.push('Unresolved animal identifiers remain unlinked until reviewed.');
}
function sampleErrors(p,draft,dataset,errors,warnings) {
  if(!obj(p)||p.schema_version!==1){errors.push('Specimen must use schema version 1.');return;}
  if(!text(p.label)||p.label.length>200)errors.push('Enter a specimen label of 1–200 characters.');
  commonErrors(p,draft,errors);timingErrors(p,['collection_at','decapitation_at'],errors);procedureTimingErrors(p,'collection_at',errors);
  if(timestamp(p.collection_at)&&date(draft.event_date)&&localDay(p.collection_at,p.timezone)!==draft.event_date)errors.push('Specimen effective date must match its collection date in the recorded timezone.');
  for(const k of ['tissue','material'])optionalText(p,k,300,errors);
  if(!SAMPLE_STATUSES.includes(p.status))errors.push('Select a valid specimen status.');
  if(typeof p.pooled!=='boolean')errors.push('Explicitly record whether a specimen is pooled.');
  referenceErrors(p.donors,dataset,'Donors',errors);
  const parents=stringIds(p.parent_sample_ids,'Parent specimens',errors),index=new Map(listExperimentSamples(dataset,{includeArchived:true}).map(r=>[r.event_id,r]));
  const candidate={...draft,experiment_sample:p},candidateDataset={...dataset,tables:{...dataset?.tables,husbandry_events:[...rows(dataset).filter(r=>r.event_id!==draft.event_id),candidate]}};
  function reaches(id,target,seen=new Set()) {
    if(id===target)return true;if(seen.has(id))return false;seen.add(id);
    return list(index.get(id)?.experiment_sample?.parent_sample_ids).some(parent=>reaches(parent,target,seen));
  }
  for(const id of parents) {
    const parent=index.get(id);
    if(!parent)errors.push(`Parent specimen ${id} does not exist.`);
    if(reaches(id,draft.event_id))errors.push('Specimen lineage cannot contain self-links or cycles.');
    if(parent&&date(parent.event_date)&&date(draft.event_date)&&parent.event_date>draft.event_date)errors.push('A derived specimen cannot precede its parent collection date.');
  }
  const donorSids=sampleMouseSids(candidate,candidateDataset);
  const mice=mouseIndex(dataset);
  for(const id of donorSids)if(date(mice.get(id)?.date_of_birth)&&date(draft.event_date)&&draft.event_date<mice.get(id).date_of_birth)errors.push(`Specimen collection precedes the birth of donor ${id}. Review the source date or animal identity.`);
  if((donorSids.length>1||list(p.donors).length>1)&&!p.pooled)errors.push('Multiple donor mice require the pooled-specimen option.');
  if(parents.some(id=>index.get(id)?.experiment_sample?.pooled)&&!p.pooled)errors.push('A derivative of a pooled specimen must retain pooled status.');
  if(!blank(p.experiment_id)&&!listExperiments(dataset,{includeArchived:true}).some(r=>r.event_id===p.experiment_id))errors.push('The collection experiment does not exist.');
  if(!blank(p.quantity)&&!quantity(p.quantity))errors.push('Specimen stock must be a nonnegative number or unknown.');
  optionalText(p,'quantity_unit',80,errors);
  if(!blank(p.quantity_as_of_date)&&!date(p.quantity_as_of_date))errors.push('Stock date must be YYYY-MM-DD or blank.');
  if(quantity(p.quantity)&&(!text(p.quantity_unit)||!date(p.quantity_as_of_date)))errors.push('Known specimen stock needs a unit and stock date.');
  if(date(p.quantity_as_of_date)&&date(draft.event_date)&&p.quantity_as_of_date<draft.event_date)errors.push('Stock date cannot precede specimen collection.');
  if(p.status==='depleted'&&p.quantity!==0)errors.push('Depleted status requires explicitly recorded zero stock.');
  if(['available','stored'].includes(p.status)&&p.quantity===0)errors.push('Zero stock cannot be marked available or stored.');
  if(!obj(p.storage)){errors.push('Specimen storage must be an object.');return;}
  const storageKeys=['facility','freezer','rack','box','position'];
  for(const k of storageKeys)optionalText(p.storage,k,160,errors,`Storage ${k}`);
  if(!blank(p.storage.temperature_c)&&(typeof p.storage.temperature_c!=='number'||!Number.isFinite(p.storage.temperature_c)||p.storage.temperature_c< -273.15||p.storage.temperature_c>200))errors.push('Storage temperature must be a number from −273.15 to 200 °C, or unknown.');
  if(p.status==='stored'&&!storageKeys.some(k=>text(p.storage[k])))errors.push('Record a storage location before marking a specimen stored.');
  if(!donorSids.length)warnings.push('This specimen has no confirmed donor identity. Unresolved source identifiers are retained.');
  if(p.quantity==null)warnings.push('Current specimen stock is unknown. Historical reports do not establish available stock.');
}

/** Called by the enclosing record validator. Does not mutate the dataset. */
export function validateExperimentRecord(draft,dataset,old=null) {
  const errors=[],warnings=[];
  if(!obj(draft))return {errors:['A record object is required.'],warnings};
  const relevant=[EXPERIMENT,SAMPLE,REVISION].includes(draft.event_type)||[EXPERIMENT,SAMPLE,REVISION].includes(old?.event_type)||draft.experiment!=null||draft.experiment_sample!=null||draft.experiment_revision!=null;
  if(!relevant)return {errors,warnings};
  if(![EXPERIMENT,SAMPLE,REVISION].includes(draft.event_type))errors.push('Experiment payloads require their matching record type.');
  if(old&&old.event_type!==draft.event_type)errors.push('An experiment or specimen must retain its record type.');
  if(!text(draft.event_id)||draft.event_id.length>200)errors.push('A record needs a nonempty identifier of at most 200 characters.');
  for(const key of ['app_created_at','app_modified_at'])if(!blank(draft[key])&&!timestamp(draft[key]))errors.push(`${key} must be an ISO timestamp with a UTC offset.`);
  if(old&&old.event_id!==draft.event_id)errors.push('An existing record identifier cannot change.');
  if(old)for(const key of unique([...Object.keys(old),...Object.keys(draft)]))if((key.startsWith('source')||key==='record_origin')&&!same(old[key],draft[key]))errors.push(`Imported provenance ${key} cannot be changed.`);
  if(draft.experiment!=null&&draft.event_type!==EXPERIMENT||draft.experiment_sample!=null&&draft.event_type!==SAMPLE||draft.experiment_revision!=null&&draft.event_type!==REVISION)errors.push('Each record must contain only its matching experiment, specimen or revision payload.');
  if(rows(dataset).some(r=>r.event_id===draft.event_id&&r.event_id!==old?.event_id&&!same(r,draft)))errors.push(`Identifier ${draft.event_id} already exists.`);
  if(draft.event_type===REVISION) {
    const p=draft.experiment_revision;
    if(!obj(p)||p.schema_version!==1)return {errors:unique([...errors,'Experiment revision must use schema version 1.']),warnings};
    if(old&&!same(draft,old))errors.push('Experiment revision history is immutable. Make a new correction to the linked record.');
    if(archived(draft))errors.push('Experiment revision history cannot be archived.');
    if(!text(p.entity_id)||![EXPERIMENT,SAMPLE].includes(p.entity_kind))errors.push('Revision needs a linked experiment or specimen.');
    if(!date(draft.event_date)||p.effective_date!==draft.event_date)errors.push('Revision needs a valid matching effective date.');
    if(!Number.isSafeInteger(p.revision_before)||p.revision_before<0||p.revision_after!==p.revision_before+1)errors.push('Revisions must advance by one.');
    if(!obj(p.before)||!obj(p.after))errors.push('Revision needs before and after record snapshots.');
    optionalText(p,'notes',4000,errors,'Revision notes');
    const entity=rows(dataset).find(r=>r.event_id===p.entity_id&&r.event_type===p.entity_kind);
    if(!entity)errors.push('Revision target does not exist.');
    if(!old&&entity&&(entity[p.entity_kind]?.last_revision_id!==draft.event_id||entity[p.entity_kind]?.revision!==p.revision_after||!same(p.after,revisionSnapshot(entity))))errors.push('Save a new revision atomically with its updated record.');
    return {errors:unique(errors),warnings};
  }
  const issues=[];
  if(draft.event_type===EXPERIMENT)experimentErrors(draft.experiment,draft,dataset,issues,warnings);
  if(draft.event_type===SAMPLE)sampleErrors(draft.experiment_sample,draft,dataset,issues,warnings);
  const unchanged=old&&same(draft[draft.event_type],old[old.event_type])&&same(draft.event_date,old.event_date);
  (unchanged?warnings:errors).push(...issues.map(x=>unchanged?'Existing source issue retained: '+x:x));
  if(old&&!same(revisionSnapshot(draft),revisionSnapshot(old))) {
    const p=draft[draft.event_type],prior=old[old.event_type],rev=rows(dataset).find(r=>r.event_id===p?.last_revision_id&&r.event_type===REVISION)?.experiment_revision;
    if(!rev||rev.entity_id!==draft.event_id||rev.entity_kind!==draft.event_type||rev.revision_before!==(prior?.revision??0)||rev.revision_after!==(prior?.revision??0)+1||p?.revision!==rev.revision_after||!same(rev.before,revisionSnapshot(old))||!same(rev.after,revisionSnapshot(draft)))errors.push('Save changed experiment or specimen facts with their dated revision in one transaction.');
  }
  return {errors:unique(errors),warnings:unique(warnings)};
}
function revisionSnapshot(record) {
  return {event_date:record.event_date??null,payload:clone(record[record.event_type]??null),archived:archived(record)};
}

export function blankExperiment() {
  return {schema_version:1,title:'',assays:[],status:'planned',project:null,operator:null,protocol:null,started_at:null,ended_at:null,timezone:'Asia/Taipei',circadian_time:null,time_basis:'unknown',decapitation_at:null,decapitation_circadian_time:null,decapitation_time_basis:'unknown',decapitation_circadian_time_source:'recorded',sampling_at:null,sampling_circadian_time:null,sampling_time_basis:'unknown',sampling_circadian_time_source:'recorded',entrainment:blankEntrainment(),participants:[],sample_usages:[],result_urls:[],notes:null,revision:0,last_revision_id:null};
}
export function blankExperimentSample() {
  return {schema_version:1,label:'',experiment_id:null,donors:[],parent_sample_ids:[],pooled:false,tissue:null,material:null,collection_at:null,timezone:'Asia/Taipei',circadian_time:null,time_basis:'unknown',circadian_time_source:'recorded',decapitation_at:null,decapitation_circadian_time:null,decapitation_time_basis:'unknown',decapitation_circadian_time_source:'recorded',entrainment:blankEntrainment(),status:'unreviewed',quantity:null,quantity_unit:null,quantity_as_of_date:null,storage:{temperature_c:null,facility:null,freezer:null,rack:null,box:null,position:null},operator:null,project:null,protocol:null,notes:null,revision:0,last_revision_id:null};
}
function build(type,input,dataset,old,options={}) {
  if(!obj(input))throw new Error('Record fields are required.');
  if(old) {
    const current=rows(dataset).find(r=>r.event_id===old.event_id);
    if(!current||!same(current,old))throw new Error('The record changed or is unavailable. Reload before saving.');
  }
  const stamp=options.now??new Date().toISOString(),payload=type===EXPERIMENT?blankExperiment():blankExperimentSample();
  if(!timestamp(stamp))throw new Error('A valid timestamp with UTC offset is required.');
  const values=clone(input);delete values.event_date;delete values.revision;delete values.last_revision_id;
  const source=clone(Object.fromEntries(Object.entries(options.sourceRecord??{}).filter(([k])=>k.startsWith('source')||k==='record_origin')));
  if(old&&Object.keys(source).length)throw new Error('Imported provenance cannot be replaced when editing.');
  const record={...(old?clone(old):{event_id:options.eventId??(type===EXPERIMENT?'EXP-':'SAMPLE-')+crypto.randomUUID(),event_type:type,record_origin:'app_created',...source,app_created_at:stamp}),
    event_date:nullable(Object.hasOwn(input,'event_date')?input.event_date:old?.event_date),app_modified_at:stamp,[type]:{...payload,...clone(old?.[type]??{}),...values}};
  if(!old&&rows(dataset).some(r=>r.event_id===record.event_id))throw new Error(`Identifier ${record.event_id} already exists.`);
  let revision=null;
  if(old&&!same(revisionSnapshot(record),revisionSnapshot(old))) {
    const revisionId='EXPREV-'+crypto.randomUUID(),effectiveDate=options.effectiveDate??localDay(stamp,'Asia/Taipei');
    record[type].revision=(old[type]?.revision??0)+1;record[type].last_revision_id=revisionId;
    revision={event_id:revisionId,event_type:REVISION,event_date:effectiveDate,record_origin:'app_created',app_created_at:stamp,app_modified_at:stamp,
      experiment_revision:{schema_version:1,entity_id:record.event_id,entity_kind:type,effective_date:effectiveDate,revision_before:old[type]?.revision??0,revision_after:record[type].revision,before:revisionSnapshot(old),after:revisionSnapshot(record),notes:options.revisionNotes??null}};
  }
  const next=clone(dataset??{});next.tables??={};next.tables.husbandry_events=rows(next).filter(r=>r.event_id!==record.event_id);next.tables.husbandry_events.push(record);if(revision)next.tables.husbandry_events.push(revision);
  const checked=validateExperimentRecord(record,next,old),revisionCheck=revision?validateExperimentRecord(revision,next):{errors:[]};
  const errors=unique([...checked.errors,...revisionCheck.errors]);
  if(errors.length)throw new Error(errors.join(' '));
  return {record,revision,dataset:next};
}
/** Input is payload fields plus event_date. Save returned dataset atomically. */
export const buildExperiment=(input,dataset,old=null,options={})=>build(EXPERIMENT,input,dataset,old,options);
export const buildExperimentSample=(input,dataset,old=null,options={})=>build(SAMPLE,input,dataset,old,options);
