import {SOURCE_ID_PATTERN,sourceHash,stableJSON,sourceDate} from './source.mjs';
const IDS=Object.freeze({rooms:'room_id',racks:'rack_id',locations:'location_id',light_events:'event_id'});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),clone=structuredClone;
const key=r=>r.entity_type+':'+r.entity_id,archived=r=>r?.archived===true||Boolean(r?.payload?.app_archived_at);
const same=(a,b)=>stableJSON(a)===stableJSON(b);
const captureKeys=new Set(['source_snapshot_date','source_capture_at','source_last_seen_at']);
const semantic=p=>Object.fromEntries(Object.entries(p??{}).filter(([k])=>!captureKeys.has(k)));
function validRecord(r,sourceId){return object(r)&&Object.hasOwn(IDS,r.entity_type)&&typeof r.entity_id==='string'&&r.entity_id&&object(r.payload)&&r.payload[IDS[r.entity_type]]===r.entity_id&&r.payload.source_file_id===sourceId}
function changedOwnedFields(current,baseline,incoming){const names=new Set([...Object.keys(baseline??{}),...Object.keys(incoming??{})]);return [...names].filter(k=>!captureKeys.has(k)&&((Object.hasOwn(baseline??{},k)&&!same(current?.[k],baseline[k]))||(!Object.hasOwn(baseline??{},k)&&Object.hasOwn(current??{},k)&&!same(current[k],incoming?.[k]))))}
function mergedPayload(current,incoming,baseline){const result=clone(current??{});for(const name of Object.keys(baseline??{}))if(!Object.hasOwn(incoming,name))delete result[name];return {...result,...clone(incoming)}}
export async function planAnimalSheetMerge(parsed,currentRecords,previousBaseline={}){
 if(parsed?.schema_version!==1||typeof parsed.source_id!=='string'||!SOURCE_ID_PATTERN.test(parsed.source_id)||!sourceDate(parsed.snapshot_date)||typeof parsed.content_hash!=='string'||!/^[a-f0-9]{64}$/.test(parsed.content_hash)||!Array.isArray(parsed.records))throw new Error('A validated source parse is required.');
 if(previousBaseline?.source_id&&previousBaseline.source_id!==parsed.source_id)throw new Error('Source baseline belongs to another workbook.');
 const current=new Map(),prior=new Map(),incoming=new Map();
 for(const r of currentRecords??[]){if(!Object.hasOwn(IDS,r.entity_type))continue;if(current.has(key(r)))throw new Error('Duplicate current entity IDs prevent safe source import.');if(!Number.isInteger(r.version)||r.version<1)throw new Error('Current source records require their server versions.');current.set(key(r),r)}
 for(const e of previousBaseline?.entries??[]){if(!validRecord(e,parsed.source_id)||prior.has(key(e)))throw new Error('Source baseline contains invalid or duplicate entries.');prior.set(key(e),e)}
 for(const r of parsed.records){if(!validRecord(r,parsed.source_id)||incoming.has(key(r)))throw new Error('Incoming source contains invalid or duplicate records.');incoming.set(key(r),r)}
 const changes=[],conflicts=[],historyRecords=[],baseline=new Map([...prior].map(([k,v])=>[k,clone(v)])),summary={added:0,updated:0,unchanged:0,adopted:0,conflicts:0,withdrawn:0};
 const history=async(action,entry,old,reason=null)=>{const id='SHEET-HISTORY-'+(await sourceHash([parsed.source_id,parsed.captured_at,parsed.content_hash,action,key(entry),old?.version??0])).slice(0,40);historyRecords.push({entity_type:'husbandry_events',entity_id:id,expected_version:0,archived:false,payload:{event_id:id,event_type:'animal_sheet_source_change',event_date:parsed.snapshot_date,record_origin:'animal_sheet_sync',source_file_id:parsed.source_id,source_capture_at:parsed.captured_at,source_content_hash:parsed.content_hash,animal_sheet_change:{schema_version:1,action,entity_type:entry.entity_type,entity_id:entry.entity_id,before:old?clone(old.payload):null,after:action==='withdrawn'?null:clone(entry.payload),conflict_reason:reason,observation_date:parsed.snapshot_date,effective_date:null}}})};
 const conflict=async(kind,entry,old,previous,fields=[])=>{const conflict_id='SHEET-CONFLICT-'+(await sourceHash([key(entry),semantic(entry.payload),old?.version??0,kind])).slice(0,40);conflicts.push({conflict_id,kind,entity_type:entry.entity_type,entity_id:entry.entity_id,expected_version:old?.version??0,source_payload:clone(entry.payload),source_managed_keys:Object.keys(entry.payload),current_payload:old?clone(old.payload):null,baseline_payload:previous?clone(previous.payload):null,changed_fields:fields,source_content_hash:parsed.content_hash,captured_at:parsed.captured_at});summary.conflicts++;await history('conflict',entry,old,kind)};
 for(const [id,entry] of incoming){const old=current.get(id),previous=prior.get(id);
  if(!old){if(previous){await conflict('managed_record_missing',entry,null,previous);continue}changes.push({...clone(entry),expected_version:0,archived:false});baseline.set(id,{...clone(entry),source_present:true});summary.added++;await history('added',entry,null);continue}
  if(previous&&same(semantic(entry.payload),semantic(previous.payload))){baseline.set(id,{...clone(entry),source_present:true});summary.unchanged++;continue}
  if(archived(old)){await conflict('app_archived_record',entry,old,previous);continue}
  if(old.payload?.source_file_id!==parsed.source_id||old.payload?.record_origin!=='current_google_sheet_map'){await conflict('existing_record_not_source_owned',entry,old,previous);continue}
  if(!previous){if(Object.keys(entry.payload).every(k=>captureKeys.has(k)||same(old.payload[k],entry.payload[k]))){baseline.set(id,{...clone(entry),source_present:true});summary.adopted++;continue}await conflict('baseline_missing',entry,old,null);continue}
  const changed=changedOwnedFields(old.payload,previous.payload,entry.payload);if(changed.length){await conflict('app_edited_source_fields',entry,old,previous,changed);continue}
  if(entry.entity_type==='locations'&&['label','room_id','rack_id'].some(k=>!same(previous.payload[k],entry.payload[k]))){await conflict('position_identity_changed',entry,old,previous,['label','room_id','rack_id'].filter(k=>!same(previous.payload[k],entry.payload[k])));continue}
  const payload=mergedPayload(old.payload,entry.payload,previous.payload);changes.push({entity_type:entry.entity_type,entity_id:entry.entity_id,payload,expected_version:old.version,archived:false});baseline.set(id,{...clone(entry),source_present:true});summary.updated++;await history('updated',entry,old);
 }
 const priorPositions=[...prior.values()].filter(e=>e.entity_type==='locations'&&e.source_present!==false),missingPositions=priorPositions.filter(e=>!incoming.has(key(e))),largeLoss=priorPositions.length>=5&&missingPositions.length/priorPositions.length>0.2;
 for(const [id,previous] of prior){if(incoming.has(id)||previous.source_present===false)continue;const old=current.get(id),withdrawn={...clone(previous),payload:{...clone(previous.payload),source_current:false,source_last_seen_at:old?.payload?.source_last_seen_at??previous.payload.source_last_seen_at??previous.payload.source_snapshot_date??null}};
  if(largeLoss&&previous.entity_type==='locations'){await conflict('large_layout_loss_requires_review',withdrawn,old,previous);continue}
  if(old&&!archived(old)){const changed=changedOwnedFields(old.payload,previous.payload,{});if(changed.length){await conflict('app_edited_withdrawn_source_record',withdrawn,old,previous,changed);continue}changes.push({entity_type:old.entity_type,entity_id:old.entity_id,payload:{...clone(old.payload),source_current:false,source_last_seen_at:withdrawn.payload.source_last_seen_at},expected_version:old.version,archived:false})}
  baseline.set(id,{...withdrawn,source_present:false});summary.withdrawn++;await history('withdrawn',withdrawn,old??null)
 }
 const nextBaseline={schema_version:1,source_id:parsed.source_id,content_hash:parsed.content_hash,captured_at:parsed.captured_at,entries:[...baseline.values()].sort((a,b)=>key(a).localeCompare(key(b)))};
 return {changes,conflicts,historyRecords,nextBaseline,summary};
}
