/** Cage-associated plans and observations. No schedule, exposure, or dose is inferred. */
import {validTimingDate} from './experiment-timing.js?v=24';
const array=x=>Array.isArray(x)?x:[],object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const present=x=>x!==null&&x!==undefined&&x!=='';
const live=r=>r&&!r.app_archived_at&&r.archived!==true;
const clone=structuredClone,unique=x=>[...new Set(x)];
const txt=x=>typeof x==='string'?x.trim():'';
const clock=x=>typeof x==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(x);
const zone=x=>{try{return Boolean(txt(x))&&Boolean(new Intl.DateTimeFormat('en',{timeZone:x}));}catch{return false;}};
const instant=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(x)&&validTimingDate(x.slice(0,10))&&Number.isFinite(Date.parse(x));
const id=prefix=>prefix+'-'+(globalThis.crypto?.randomUUID?.()??Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
const stable=x=>JSON.stringify(x,(key,value)=>object(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
export const LOCOBOX_SCHEMES=Object.freeze(['unknown','LD','DD','LL','LP1','LP2','Custom']);
export function blankLocoboxTreatment(){return {treatment_id:id('TREAT'),name:'',status:'planned',dose:null,dose_unit:null,concentration:null,concentration_unit:null,route:null,vehicle:null,delivery:null,frequency:null,start_date:null,end_date:null,start_time:null,end_time:null,notes:null};}
export function blankLocoboxPhase(){return {phase_id:id('PHASE'),label:'',start_date:null,end_date:null,start_time:null,end_time:null,timezone:'Asia/Taipei',scheme:'unknown',cycle_hours:null,light_hours:null,lights_on:null,lights_off:null,transition_minutes:null,intensity_lux:null,duration_days:null,duration_basis:'unknown',schedule_details:null,measured_phase:{measured_at:null,phase_hours:null,basis:'unknown',method:null,notes:null},treatments:[],notes:null};}
export function blankLocoboxProtocol(){return {schema_version:1,protocol_id:'',title:'',status:'planned',evidence_status:'planned',cage_sid:null,location_id:null,source_cage_label:null,link_status:'unresolved',phases:[blankLocoboxPhase()],notes:null};}
export function listLocoboxProtocols(dataset,{cageSid=null,locationId=null}={}){return array(dataset?.tables?.husbandry_events).filter(r=>live(r)&&r.event_type==='locobox_protocol'&&object(r.locobox_protocol)).filter(r=>!cageSid&&!locationId||cageSid&&r.locobox_protocol.cage_sid===String(cageSid)||locationId&&r.locobox_protocol.location_id===locationId).sort((a,b)=>String(b.event_date||'').localeCompare(String(a.event_date||'')));}
function checkText(errors,p,key,label,max=10000){if(present(p[key])&&(typeof p[key]!=='string'||p[key].length>max))errors.push(`${label}: ${key.replaceAll('_',' ')} must be text, at most ${max} characters.`);}
function checkNumber(errors,p,key,label,{min=0,max=1e12}={}){if(present(p[key])&&(typeof p[key]!=='number'||!Number.isFinite(p[key])||p[key]<min||p[key]>max))errors.push(`${label}: ${key.replaceAll('_',' ')} must be a number from ${min} to ${max}, or unknown.`);}
function checkInterval(errors,p,label){
  for(const key of ['start_date','end_date'])if(present(p[key])&&!validTimingDate(p[key]))errors.push(`${label}: enter a valid ${key.replace('_',' ')}.`);
  for(const key of ['start_time','end_time'])if(present(p[key])&&!clock(p[key]))errors.push(`${label}: ${key.replace('_',' ')} must be HH:mm or HH:mm:ss.`);
  if(present(p.start_time)&&!validTimingDate(p.start_date))errors.push(`${label}: a start clock requires its date.`);
  if(present(p.end_time)&&!validTimingDate(p.end_date))errors.push(`${label}: an end clock requires its date.`);
  if(validTimingDate(p.start_date)&&validTimingDate(p.end_date)){
    if(p.end_date<p.start_date)errors.push(`${label}: end date precedes start date.`);
    if(p.end_date===p.start_date&&clock(p.start_time)&&clock(p.end_time)&&p.end_time<=p.start_time)errors.push(`${label}: exclusive end must follow its start.`);
  }
}
export function validateLocoboxRecord(record,dataset={},old=null){
  const errors=[],warnings=[],kind=record?.event_type;
  if(!['locobox_protocol','locobox_revision'].includes(kind))return {errors,warnings};
  if(typeof record.event_id!=='string'||!record.event_id.trim())errors.push('A Locobox event ID is required.');
  if(present(record.event_date)&&!validTimingDate(record.event_date))errors.push('Locobox event date is invalid.');
  if(kind==='locobox_revision'){
    const p=record.locobox_revision;
    if(!object(p)||p.schema_version!==1||!txt(p.entity_id)||!validTimingDate(p.effective_date)||!object(p.before)||!object(p.after))errors.push('A Locobox revision requires before/after snapshots, entity ID and effective date.');
    if(old&&stable(old)!==stable(record))errors.push('Locobox revision history is append-only.');
    return {errors,warnings};
  }
  const p=record.locobox_protocol;
  if(!object(p))return {errors:['Locobox protocol details are required.'],warnings};
  if(p.schema_version!==1)errors.push('Unsupported Locobox protocol version.');
  if(p.protocol_id!==record.event_id)errors.push('Locobox protocol ID must match the event ID.');
  if(!txt(p.title))errors.push('Enter a protocol title.');
  if(!['planned','active','completed','source'].includes(p.status))errors.push('Choose a Locobox protocol status.');
  if(!['recorded','planned','source','unresolved'].includes(p.evidence_status))errors.push('Choose a Locobox evidence status.');
  if(!['confirmed','unresolved'].includes(p.link_status))errors.push('Choose a cage-link status.');
  if(p.link_status==='confirmed'&&!txt(p.cage_sid))errors.push('A confirmed cage association requires an exact cage SID.');
  if(present(p.cage_sid)&&!array(dataset.tables?.cages).some(c=>String(c.cage_sid)===p.cage_sid))errors.push('Select an existing cage SID.');
  if(present(p.location_id)&&!array(dataset.tables?.locations).some(l=>l.location_id===p.location_id))errors.push('Select an existing physical position.');
  if(p.status==='source'&&p.evidence_status!=='source')errors.push('A source observation must retain source evidence status.');
  if(p.status==='active'&&(p.evidence_status!=='recorded'||p.link_status!=='confirmed'))errors.push('An active protocol requires recorded evidence and a confirmed cage association.');
  for(const key of ['title','source_cage_label'])checkText(errors,p,key,'Protocol',500);
  checkText(errors,p,'notes','Protocol');
  if(!Array.isArray(p.phases)||p.phases.length<1||p.phases.length>100)errors.push('Keep between 1 and 100 timeline phases.');
  if(new Set(array(p.phases).filter(object).map(phase=>phase.timezone).filter(zone)).size>1)errors.push('Use one timezone per timeline. Record a timezone change in a separate protocol.');
  const seen=new Set();
  for(const [i,phase] of array(p.phases).entries()){
    const label=`Phase ${i+1}`;if(!object(phase)){errors.push(`${label} must be a record.`);continue;}
    if(!txt(phase.phase_id)||seen.has(phase.phase_id))errors.push(`${label}: phase IDs must be present and unique.`);seen.add(phase.phase_id);
    checkInterval(errors,phase,label);
    if(!zone(phase.timezone))errors.push(`${label}: enter a valid IANA timezone.`);
    if(!LOCOBOX_SCHEMES.includes(phase.scheme))errors.push(`${label}: choose a supported light scheme or Custom.`);
    for(const key of ['lights_on','lights_off'])if(present(phase[key])&&!clock(phase[key]))errors.push(`${label}: ${key.replace('_',' ')} must be a local clock time.`);
    checkNumber(errors,phase,'cycle_hours',label,{min:.000001,max:1000});
    for(const [key,max] of [['light_hours',1000],['transition_minutes',60000],['intensity_lux',1000000],['duration_days',100000]])checkNumber(errors,phase,key,label,{max});
    if(Number.isFinite(phase.light_hours)&&Number.isFinite(phase.cycle_hours)&&phase.light_hours>phase.cycle_hours)errors.push(`${label}: light duration exceeds the cycle.`);
    if(phase.scheme==='DD'&&Number.isFinite(phase.light_hours)&&phase.light_hours!==0)errors.push(`${label}: DD cannot have a positive light duration.`);
    if(phase.scheme==='LL'&&Number.isFinite(phase.light_hours)&&Number.isFinite(phase.cycle_hours)&&phase.light_hours!==phase.cycle_hours)errors.push(`${label}: LL light duration must equal its cycle when both are recorded.`);
    if(['DD','LL'].includes(phase.scheme)&&(present(phase.lights_on)||present(phase.lights_off)))errors.push(`${label}: continuous DD/LL cannot use daily on/off clocks. Put a transition in the phase boundary.`);
    if(!['unknown','recorded','date_difference'].includes(phase.duration_basis))errors.push(`${label}: choose a duration basis.`);
    if(phase.duration_basis==='date_difference'){
      if(!validTimingDate(phase.start_date)||!validTimingDate(phase.end_date)||phase.duration_days!==(Date.parse(phase.end_date)-Date.parse(phase.start_date))/86400000)errors.push(`${label}: calculated duration must equal end date minus start date.`);
    }
    if(present(phase.duration_days)&&phase.duration_basis==='unknown')warnings.push(`${label}: duration is stated without an evidence basis.`);
    for(const key of ['label','schedule_details','notes'])checkText(errors,phase,key,label,key==='label'?500:10000);
    const m=phase.measured_phase;
    if(!object(m))errors.push(`${label}: measured phase must be a record.`);
    else{
      if(!['unknown','CT','ZT'].includes(m.basis))errors.push(`${label}: measured phase basis must be CT, ZT or unknown.`);
      if(present(m.measured_at)&&!instant(m.measured_at))errors.push(`${label}: measured phase needs an ISO datetime with UTC offset.`);
      checkNumber(errors,m,'phase_hours',label,{max:23.999999999});
      if(present(m.phase_hours)&&(!instant(m.measured_at)||!['CT','ZT'].includes(m.basis)||!txt(m.method)))errors.push(`${label}: measured phase needs date/time, CT/ZT basis and a measurement method.`);
      checkText(errors,m,'method',label,500);checkText(errors,m,'notes',label);
    }
    if(!Array.isArray(phase.treatments)||phase.treatments.length>100)errors.push(`${label}: treatments must be a list of at most 100 records.`);
    const treatments=new Set();
    for(const [j,t] of array(phase.treatments).entries()){
      const description=`${label}, treatment ${j+1}`;if(!object(t)){errors.push(`${description} must be a record.`);continue;}
      if(!txt(t.treatment_id)||treatments.has(t.treatment_id))errors.push(`${description}: treatment IDs must be present and unique.`);treatments.add(t.treatment_id);
      if(!txt(t.name))errors.push(`${description}: enter the treatment name.`);
      if(!['planned','administered','cancelled','unknown'].includes(t.status))errors.push(`${description}: choose planned, administered, cancelled or unknown.`);
      checkInterval(errors,t,description);checkNumber(errors,t,'dose',description);checkNumber(errors,t,'concentration',description);
      if(present(t.dose)&&!txt(t.dose_unit))errors.push(`${description}: a numeric dose requires its unit.`);
      if(present(t.concentration)&&!txt(t.concentration_unit))errors.push(`${description}: concentration requires its unit.`);
      for(const key of ['name','dose_unit','concentration_unit','route','vehicle','delivery','frequency','notes'])checkText(errors,t,key,description,key==='notes'?10000:500);
      if(validTimingDate(t.start_date)&&validTimingDate(phase.start_date)&&t.start_date<phase.start_date||validTimingDate(t.end_date)&&validTimingDate(phase.end_date)&&t.end_date>phase.end_date)errors.push(`${description}: treatment dates extend outside their phase.`);
      if(validTimingDate(t.start_date)&&validTimingDate(phase.end_date)&&t.start_date>phase.end_date||validTimingDate(t.end_date)&&validTimingDate(phase.start_date)&&t.end_date<phase.start_date)errors.push(`${description}: treatment dates are outside their phase.`);
      if(t.start_date===phase.end_date&&clock(t.start_time)&&clock(phase.end_time)&&t.start_time>=phase.end_time)errors.push(`${description}: treatment starts at or after the exclusive phase end.`);
      if(t.start_date===phase.start_date&&clock(t.start_time)&&clock(phase.start_time)&&t.start_time<phase.start_time)errors.push(`${description}: treatment starts before its phase.`);
      if(t.end_date===phase.end_date&&clock(t.end_time)&&clock(phase.end_time)&&t.end_time>phase.end_time)errors.push(`${description}: treatment ends after its phase.`);
      if(!t.start_date)warnings.push(`${description}: administration date is unknown; this does not establish delivery.`);
    }
    const previous=p.phases[i-1];
    if(previous&&validTimingDate(previous.start_date)&&validTimingDate(phase.start_date)){
      if(phase.start_date<previous.start_date)errors.push(`${label}: phases must follow chronological start order.`);
      if(phase.start_date===previous.start_date&&phase.timezone===previous.timezone&&clock(phase.start_time)&&clock(previous.start_time)&&phase.start_time<previous.start_time)errors.push(`${label}: phase start clocks are out of chronological order.`);
      if(validTimingDate(previous.end_date)&&previous.end_date>phase.start_date)errors.push(`${label}: phase intervals overlap.`);
      if(previous.end_date===phase.start_date&&previous.timezone===phase.timezone&&clock(previous.end_time)&&clock(phase.start_time)&&previous.end_time>phase.start_time)errors.push(`${label}: phase clock intervals overlap.`);
      if(!previous.end_date)warnings.push(`${label}: the previous phase has no recorded end; continuity or overlap is unknown.`);
    }
    if(!phase.start_date)warnings.push(`${label}: the phase start date is unknown.`);
    if(phase.scheme!=='unknown'&&!['DD','LL'].includes(phase.scheme)&&(!phase.cycle_hours||!present(phase.light_hours)||!phase.lights_on||!phase.lights_off))warnings.push(`${label}: the light-scheme label does not specify a complete exact schedule.`);
  }
  if(old){for(const key of Object.keys(old).filter(k=>k.startsWith('source_')))if(stable(old[key])!==stable(record[key]))errors.push('Preserve the original source evidence.');if(old.locobox_protocol?.status==='source'&&stable(old.locobox_protocol)!==stable(p))errors.push('Source observations are read-only; create a separate reviewed protocol.');}
  return {errors:unique(errors),warnings:unique(warnings)};
}
export function buildLocoboxProtocol(input,dataset,previous=null,{eventId=null,now=new Date().toISOString(),sourceRecord=null}={}){
  if(!instant(now))throw new Error('Save time must be a valid ISO datetime with UTC offset.');
  const event_id=previous?.event_id||eventId||id('LOCO'),p={...blankLocoboxProtocol(),...clone(input),protocol_id:event_id};
  const existing=array(dataset.tables?.husbandry_events).find(r=>r.event_id===event_id);
  if(!previous&&existing)throw new Error('This Locobox event ID already exists.');
  if(previous&&(previous.event_type!=='locobox_protocol'||!existing||stable(existing)!==stable(previous)))throw new Error('The Locobox record changed. Reload it before saving.');
  const source=sourceRecord?Object.fromEntries(Object.entries(clone(sourceRecord)).filter(([k])=>k.startsWith('source_'))):{};
  const record={...(previous?clone(previous):source),event_id,event_type:'locobox_protocol',event_date:array(p.phases).map(x=>x.start_date).filter(validTimingDate).sort()[0]??null,record_origin:previous?.record_origin||'app_created',app_created_at:previous?.app_created_at||now,app_updated_at:now,locobox_protocol:p};
  const checked=validateLocoboxRecord(record,dataset,previous);if(checked.errors.length)throw new Error(checked.errors.join(' '));
  const events=[...array(dataset.tables?.husbandry_events).filter(r=>r.event_id!==event_id),record];
  if(previous&&stable(previous.locobox_protocol)!==stable(p)){
    const revision_id=id('LOCO-REV'),effective_date=now.slice(0,10);
    events.push({event_id:revision_id,event_type:'locobox_revision',event_date:effective_date,record_origin:'app_created',app_created_at:now,locobox_revision:{schema_version:1,entity_id:event_id,effective_date,before:clone(previous.locobox_protocol),after:clone(p)}});
  }
  return {record,dataset:{...dataset,tables:{...dataset.tables,husbandry_events:events}},warnings:checked.warnings};
}
/** Position evidence is a candidate context, never proof of past cage exposure. */
export function locoboxEvidence(dataset,{cageSid=null,locationId=null}={}){
  const cage=array(dataset?.tables?.cages).find(c=>String(c.cage_sid)===String(cageSid));
  const position=locationId||cage?.location_id||null;
  const lights=array(dataset?.tables?.light_events).filter(live).filter(r=>cageSid&&String(r.cage_sid||'')===String(cageSid)||position&&r.location_id===position).map(r=>({kind:'light_event',record:r,relationship:cageSid&&String(r.cage_sid||'')===String(cageSid)?'Explicit cage reference':'Physical-position source; historical cage exposure unconfirmed'}));
  const experiments=array(dataset?.tables?.husbandry_events).filter(live).filter(r=>r.event_type==='experiment'&&(cageSid&&String(r.cage_sid||r.experiment?.cage_sid||'')===String(cageSid)||position&&(r.location_id===position||r.experiment?.location_id===position))).map(r=>({kind:'experiment',record:r,relationship:'Explicit source reference; review exposure and treatment evidence'}));
  return [...lights,...experiments].sort((a,b)=>String(b.record.start_date||b.record.event_date||'').localeCompare(String(a.record.start_date||a.record.event_date||'')));
}
