/* Protocol records and auditable animal counts. No laboratory data is bundled. */
import { sampleMouseSids } from './experiment-model.js?v=24';
const list=v=>Array.isArray(v)?v:[];
const live=r=>r&&!r.app_archived_at&&r.archived!==true;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const string=v=>typeof v==='string'?v.trim():'';
export function taipeiToday(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
const events=d=>list(d?.tables?.husbandry_events).filter(live);
export const IACUC_SECTIONS=Object.freeze({aims:'Research aims',justification:'Why animals are needed',experimental_design:'Experimental design & analysis',animal_procedures:'Animal procedures',breeding:'Breeding plan',monitoring:'Monitoring & pain assessment',humane_endpoints:'Humane endpoints',anesthesia:'Anesthesia',analgesia:'Analgesia',euthanasia:'Euthanasia',replacement:'Replacement',reduction:'Reduction',refinement:'Refinement',personnel:'Trained personnel',notes:'Additional notes'});
export function normalizeIacucNumber(value){
 const key=string(value).toUpperCase().replace(/[‐‑–—]/g,'-').replace(/\s+/g,'').replace(/^(SHLAC|LAC)-(?=\d{4})/,'$1');
 // The explicit SH campus suffix is the legacy spelling of SHLAC. Bare LAC
 // remains a different institution; resolution still requires one registry match.
 return key.replace(/^LAC(20\d{2}-\d{4})\(SH\)$/,'SHLAC$1');
}
export function listIacucProtocols(dataset){return events(dataset).filter(r=>r.event_type==='iacuc_protocol'&&r.iacuc_protocol).sort((a,b)=>String(b.iacuc_protocol.start_date||'').localeCompare(String(a.iacuc_protocol.start_date||'')))}
export function resolveIacucProtocol(value,dataset){const key=normalizeIacucNumber(value);if(!key)return null;const matches=listIacucProtocols(dataset).filter(r=>r.event_id===value||[r.iacuc_protocol.number,...list(r.iacuc_protocol.aliases)].some(n=>normalizeIacucNumber(n)===key));return matches.length===1?matches[0]:null}
export function protocolDateStatus(protocol,today=taipeiToday()){const p=protocol?.iacuc_protocol||protocol||{};if(p.status!=='approved')return p.status||'unknown';if(date(p.start_date)&&p.start_date>today)return 'upcoming';if(date(p.end_date)&&p.end_date<today)return 'expired';return 'active'}
function inInterval(day,from,to){return date(day)&&(!from||date(from)&&day>=from)&&(!to||date(to)&&day<=to)}
function assigned(dataset,type,id,day,purpose){return events(dataset).filter(r=>r.event_type==='iacuc_assignment'&&r.iacuc_assignment).map(r=>({record:r,...r.iacuc_assignment})).filter(a=>a.entity_type===type&&a.entity_id===String(id)&&a.evidence_status==='confirmed'&&(!purpose||a.purpose===purpose)&&inInterval(day,a.valid_from,a.valid_to))}
export function protocolsForEntity(dataset,type,id,{day=taipeiToday()}={}){const result=new Set(assigned(dataset,type,id,day).map(a=>a.protocol_id));const key={mice:'mouse_sid',cages:'cage_sid',matings:'mating_sid',litters:'litter_sid'}[type],record=key?list(dataset?.tables?.[type]).find(r=>String(r[key])===String(id)):null;const direct=resolveIacucProtocol(record?.protocol||(type==='cages'?record?.cage_protocol:null),dataset);if(direct)result.add(direct.event_id);return listIacucProtocols(dataset).filter(r=>result.has(r.event_id))}
export function protocolAssignments(dataset,protocolId){return events(dataset).filter(r=>r.event_type==='iacuc_assignment'&&r.iacuc_assignment?.protocol_id===protocolId)}
/** Cage association never proves a historical use or a birth. Unknown identities remain separate. */
export function summarizeIacuc(dataset,protocolId,{today=taipeiToday()}={}){
 const protocol=listIacucProtocols(dataset).find(r=>r.event_id===protocolId),p=protocol?.iacuc_protocol||{},rows=events(dataset),mice=list(dataset?.tables?.mice),mouseMap=new Map(mice.map(m=>[String(m.mouse_sid),m]));
 const used=new Set(),bred=new Set(),breeders=new Set(),currentMice=new Set(),cages=new Set(),usedEvidence=[],bredEvidence=[],issues=[],unidentified=[];
 const within=day=>inInterval(day,p.start_date,p.end_date);
 const registry=listIacucProtocols(dataset),protocolNumbers=new Map(),assignmentsByEntity=new Map();
 for(const r of registry)for(const n of [r.event_id,r.iacuc_protocol.number,...list(r.iacuc_protocol.aliases)]){const k=normalizeIacucNumber(n);protocolNumbers.set(k,protocolNumbers.has(k)&&protocolNumbers.get(k)!==r?null:r);}
 const resolve=v=>protocolNumbers.get(normalizeIacucNumber(v))||null;
 for(const r of rows.filter(r=>r.event_type==='iacuc_assignment'&&r.iacuc_assignment?.evidence_status==='confirmed')){const a=r.iacuc_assignment,k=a.entity_type+':'+a.entity_id;if(!assignmentsByEntity.has(k))assignmentsByEntity.set(k,[]);assignmentsByEntity.get(k).push(a);}
 const linked=(type,id,day,purpose)=>(assignmentsByEntity.get(type+':'+id)||[]).some(a=>a.protocol_id===protocolId&&(!purpose||a.purpose===purpose)&&inInterval(day,a.valid_from,a.valid_to));
 function add(target,ids,day,source,evidence){if(!date(day)){issues.push({source,reason:'Missing event date'});return;}if(day>today){issues.push({source,reason:'Future event, not counted as completed',date:day});return;}if(!within(day)){issues.push({source,reason:'Outside protocol dates',date:day});return;}for(const id of ids){if(!mouseMap.has(String(id))){issues.push({source,reason:'Unknown mouse SID',mouse_sid:id});continue;}const m=mouseMap.get(String(id));if(date(m.date_of_birth)&&day<m.date_of_birth){issues.push({source,reason:'Event before birth',mouse_sid:id});continue;}target.add(String(id));evidence.push({mouse_sid:String(id),date:day,source});}}
 for(const m of mice.filter(live)){if((resolve(m.protocol)?.event_id===protocolId||linked('mice',m.mouse_sid,today))&&m.state==='Stock')currentMice.add(String(m.mouse_sid));}
 for(const c of list(dataset?.tables?.cages).filter(live)){if((resolve(c.protocol||c.cage_protocol)?.event_id===protocolId||linked('cages',c.cage_sid,today)))cages.add(String(c.cage_sid));}
 for(const row of rows){
  if(row.event_type==='iacuc_usage'&&row.iacuc_usage?.protocol_id===protocolId){const u=row.iacuc_usage;if(u.evidence_status!=='confirmed'){issues.push({source:row.event_id,reason:'Usage awaits confirmation'});continue;}const day=u.event_date||row.event_date;add(u.category==='bred'?bred:used,list(u.mouse_sids),day,row.event_id,u.category==='bred'?bredEvidence:usedEvidence);if(u.unregistered_count>0)unidentified.push({source:row.event_id,category:u.category,count:u.unregistered_count,date:day,within:within(day)&&day<=today});}
  if(row.event_type==='experiment'&&row.experiment){const e=row.experiment;if(!['in_progress','completed'].includes(e.status))continue;const day=row.event_date||e.started_at?.slice(0,10);const direct=resolve(e.protocol);if(direct?.event_id===protocolId||linked('experiments',row.event_id,day,'experiment')){const participants=list(e.participants).filter(a=>a.link_status==='confirmed').map(a=>a.mouse_sid);add(used,participants,day,row.event_id,usedEvidence);for(const sample of rows.filter(s=>s.event_type==='experiment_sample'&&s.experiment_sample?.experiment_id===row.event_id&&s.experiment_sample.collection_at&&s.experiment_sample.status!=='unreviewed')){const own=resolve(sample.experiment_sample.protocol);if(sample.experiment_sample.protocol&&own?.event_id!==protocolId){issues.push({source:sample.event_id,reason:'Sample has a different or unresolved protocol; not inherited from experiment'});continue;}add(used,sampleMouseSids(sample,dataset),sample.experiment_sample.collection_at.slice(0,10),sample.event_id,usedEvidence);}}}
  if(row.event_type==='experiment_sample'&&row.experiment_sample){const s=row.experiment_sample,day=s.collection_at?.slice(0,10)||row.event_date;if(!s.collection_at||s.status==='unreviewed')continue;if(resolve(s.protocol)?.event_id===protocolId)add(used,sampleMouseSids(row,dataset),day,row.event_id,usedEvidence);}
 }
 for(const litter of list(dataset?.tables?.litters).filter(live)){const day=litter.date_of_birth;if(!date(day))continue;const direct=resolve(litter.protocol),mating=list(dataset?.tables?.matings).find(m=>String(m.mating_sid)===String(litter.mating_sid));const matingProtocol=resolve(mating?.protocol);if(direct?.event_id!==protocolId&&matingProtocol?.event_id!==protocolId&&!linked('litters',litter.litter_sid,day,'breeding')&&!linked('matings',litter.mating_sid,day,'breeding'))continue;const offspring=mice.filter(m=>String(m.litter_sid||'')===String(litter.litter_sid));add(bred,offspring.map(m=>m.mouse_sid),day,'litter:'+litter.litter_sid,bredEvidence);const reported=Number(litter.size_reported);if(Number.isInteger(reported)&&reported>offspring.length)unidentified.push({source:'litter:'+litter.litter_sid,category:'bred',count:reported-offspring.length,date:day,within:within(day)&&day<=today});}
 for(const mating of list(dataset?.tables?.matings).filter(live)){if(resolve(mating.protocol)?.event_id!==protocolId&&!linked('matings',mating.mating_sid,today,'breeding'))continue;for(const id of [...list(mating.male_sids),...list(mating.female_sids)])if(mouseMap.has(String(id)))breeders.add(String(id));}
 const assignments=protocolAssignments(dataset,protocolId),review=assignments.filter(r=>r.iacuc_assignment.evidence_status!=='confirmed');
 const portalUsed=list(p.allocations).length&&list(p.allocations).every(a=>Number.isInteger(a.portal_used))?p.allocations.reduce((n,a)=>n+a.portal_used,0):null;
 const approved=Number.isInteger(p.approved_animals)?p.approved_animals:list(p.allocations).length&&list(p.allocations).every(a=>Number.isInteger(a.approved))?p.allocations.reduce((n,a)=>n+a.approved,0):null;
 return {protocolId,status:protocolDateStatus(p,today),approved,portalUsed,used:used.size,bred:bred.size,breeders:breeders.size,livingAssigned:currentMice.size,cagesAssigned:cages.size,uniqueRecordedAnimals:new Set([...used,...bred]).size,usedIds:[...used],bredIds:[...bred],breederIds:[...breeders],currentMouseIds:[...currentMice],cageIds:[...cages],usedEvidence,bredEvidence,unidentified,review,issues,overAllowance:approved!==null&&used.size>approved};
}
export function blankIacucProtocol(){return {schema_version:1,protocol_id:'',number:'',aliases:[],title:'',title_en:'',pi:'',status:'draft',start_date:null,end_date:null,approved_animals:null,allocations:[],source_url:null,source_accessed_at:null,document:null,sections:Object.fromEntries(Object.keys(IACUC_SECTIONS).map(k=>[k,''])),notes:null}}
export function validateIacucRecord(record,dataset){
 const errors=[],warnings=[],kind=record?.event_type;if(!['iacuc_protocol','iacuc_assignment','iacuc_usage','iacuc_design'].includes(kind))return {errors,warnings};const p=record[kind];if(!p||typeof p!=='object'||Array.isArray(p))return {errors:['The IACUC record is missing its details.'],warnings};if(p.schema_version!==1)errors.push('Unsupported IACUC record version.');
 if(record.event_date&&!date(record.event_date))errors.push('Choose a valid record date.');
 if(kind==='iacuc_protocol'){
  if(p.protocol_id!==record.event_id)errors.push('Protocol ID must match its record ID.');if(!string(p.number)||!string(p.title))errors.push('Protocol number and title are required.');
  if(!['draft','submitted','approved','expired','closed','unknown'].includes(p.status))errors.push('Choose a protocol status.');
  if(p.start_date&&!date(p.start_date)||p.end_date&&!date(p.end_date)||p.start_date&&p.end_date&&p.start_date>p.end_date)errors.push('Check the protocol start and end dates.');
  if(p.approved_animals!=null&&(!Number.isInteger(p.approved_animals)||p.approved_animals<0))errors.push('Approved allowance must be a nonnegative whole number.');
  const other=listIacucProtocols(dataset).find(r=>r.event_id!==record.event_id&&normalizeIacucNumber(r.iacuc_protocol.number)===normalizeIacucNumber(p.number));if(other)errors.push('This protocol number already exists.');
 }else{
  if(!listIacucProtocols(dataset).some(r=>r.event_id===p.protocol_id))errors.push('Select an existing protocol.');
  if(kind==='iacuc_assignment'){
   const key={mice:'mouse_sid',cages:'cage_sid',matings:'mating_sid',litters:'litter_sid',experiments:'event_id'}[p.entity_type];const target=p.entity_type==='experiments'?events(dataset).filter(r=>r.event_type==='experiment'):list(dataset?.tables?.[p.entity_type]);if(!key||!target.some(r=>String(r[key])===p.entity_id))errors.push('Select an existing animal, cage, breeding, litter or experiment.');
   if(!['housing','breeding','experiment'].includes(p.purpose))errors.push('Choose the assignment purpose.');if(!date(p.valid_from)||p.valid_to&&!date(p.valid_to)||p.valid_to&&p.valid_from>p.valid_to)errors.push('Choose a valid assignment period.');
  }
  if(kind==='iacuc_usage'){
   if(!['used','bred'].includes(p.category))errors.push('Choose Used or Bred.');if(!date(p.event_date)||p.event_date!==record.event_date)errors.push('Choose a valid matching usage date.');
   if(!Array.isArray(p.mouse_sids)||new Set(p.mouse_sids).size!==p.mouse_sids.length)errors.push('Mouse SIDs must be unique.');for(const id of list(p.mouse_sids))if(!list(dataset?.tables?.mice).some(m=>String(m.mouse_sid)===id))errors.push('Unknown mouse SID: '+id);
   if(!Number.isInteger(p.unregistered_count)||p.unregistered_count<0)errors.push('Unidentified animal count must be a nonnegative whole number.');if(!list(p.mouse_sids).length&&!p.unregistered_count)errors.push('Add mouse SIDs or an unidentified animal count.');
  }
  if(['iacuc_usage','iacuc_assignment'].includes(kind)&&!['confirmed','source','unresolved'].includes(p.evidence_status))errors.push('Choose an evidence status.');
 }
 return {errors,warnings};
}
