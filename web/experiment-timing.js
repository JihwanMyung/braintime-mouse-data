/* Phase calculations require a recorded reference; protocol names never imply phase. */
const text=v=>typeof v==='string'?v.trim():'';
const present=v=>v!==null&&v!==undefined&&v!=='';
const archived=r=>r?.app_archived_at||r?.archived===true;
export function validTimingDate(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v}
function instant(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(v)||!validTimingDate(v.slice(0,10)))return null;const n=Date.parse(v);return Number.isFinite(n)?n:null}
function validZone(v){try{new Intl.DateTimeFormat('en',{timeZone:v}).format();return !!text(v)}catch{return false}}
function localDate(v,zone){const n=instant(v);if(n===null||!validZone(zone))return null;return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(n))}
export function blankEntrainment(){return {scheme:'unknown',light_event_id:null,start_date:null,end_date:null,duration_days:null,duration_basis:'unknown',reference_at:null,reference_phase:null,phase_basis:'unknown',phase_scale:'clock_hours',period_hours:null,timezone:'Asia/Taipei',notes:null}}
export function validateEntrainment(e){
 if(e==null)return [];if(typeof e!=='object'||Array.isArray(e))return ['Entrainment must be a record.'];const errors=[];
 for(const [key,max] of [['scheme',200],['light_event_id',240],['notes',10000]])if(present(e[key])&&(typeof e[key]!=='string'||e[key].length>max))errors.push(`Entrainment ${key.replaceAll('_',' ')} must be text (up to ${max} characters).`);
 if(!['unknown','ZT','CT'].includes(e.phase_basis??'unknown'))errors.push('Entrainment phase basis must be ZT, CT, or unknown.');
 if(!['clock_hours','normalized_24'].includes(e.phase_scale??'clock_hours'))errors.push('Select clock hours or 24 phase hours per cycle.');
 if(present(e.period_hours)&&(!Number.isFinite(e.period_hours)||e.period_hours<=0||e.period_hours>1000))errors.push('Entrainment period must be greater than zero and at most 1000 hours.');
 if(present(e.reference_at)&&instant(e.reference_at)===null)errors.push('Phase reference needs a valid date and time with UTC offset.');
 if(present(e.timezone)&&!validZone(e.timezone))errors.push('Entrainment timezone must be a valid IANA timezone.');
 const cycle=e.phase_basis==='ZT'&&(e.phase_scale??'clock_hours')==='clock_hours'?e.period_hours:24;
 if(present(e.reference_phase)&&(!Number.isFinite(e.reference_phase)||e.reference_phase<0||(Number.isFinite(cycle)&&e.reference_phase>=cycle)))errors.push('Reference phase must be nonnegative and within one phase cycle.');
 for(const key of ['start_date','end_date'])if(present(e[key])&&!validTimingDate(e[key]))errors.push(`Entrainment ${key.replace('_',' ')} is invalid.`);
 if(validTimingDate(e.start_date)&&validTimingDate(e.end_date)&&e.end_date<e.start_date)errors.push('Entrainment end date cannot precede its start date.');
 if(present(e.duration_days)&&(!Number.isFinite(e.duration_days)||e.duration_days<0||e.duration_days>100000))errors.push('Entrainment duration must be a nonnegative number of days.');
 if(!['unknown','recorded','date_difference'].includes(e.duration_basis??'unknown'))errors.push('Select the entrainment duration basis.');
 return errors;
}
export function calculatePhase(timestamp,e={}){
 const unavailable=reason=>({status:'unavailable',value:null,basis:e.phase_basis??'unknown',reason,elapsed_hours:null,reference_at:e.reference_at??null,period_hours:e.period_hours??null});
 const errors=validateEntrainment(e);if(errors.length)return unavailable(errors[0]);
 if(!text(e.scheme)||e.scheme==='unknown')return unavailable('Record the entrainment scheme.');
 if(!['ZT','CT'].includes(e.phase_basis))return unavailable('Choose ZT or CT and define its reference.');
 if(e.phase_basis==='ZT'&&/^D[ :_-]*D$/i.test(e.scheme))return unavailable('DD has no active zeitgeber. Use CT with a phase reference, or record projected ZT separately.');
 if(instant(timestamp)===null)return unavailable('Enter the event date and clock time with UTC offset.');
 if(instant(e.reference_at)===null||!Number.isFinite(e.reference_phase)||!Number.isFinite(e.period_hours)||!validZone(e.timezone))return unavailable('Define reference date/time, reference phase, period, and timezone.');
 const date=localDate(timestamp,e.timezone);if(validTimingDate(e.start_date)&&date<e.start_date)return unavailable('This event precedes the recorded entrainment interval.');
 if(validTimingDate(e.end_date)&&date>e.end_date)return unavailable('This event follows the recorded entrainment interval; review its phase reference.');
 const elapsed_hours=(instant(timestamp)-instant(e.reference_at))/3600000;
 const cycle_hours=e.phase_basis==='CT'||e.phase_scale==='normalized_24'?24:e.period_hours;
 const value=((e.reference_phase+elapsed_hours*cycle_hours/e.period_hours)%cycle_hours+cycle_hours)%cycle_hours;
 return {status:'calculated',value:Number(value.toFixed(6))%cycle_hours,basis:e.phase_basis,cycle_hours,elapsed_hours,reference_at:e.reference_at,period_hours:e.period_hours,reason:e.phase_basis==='CT'?'Calculated CT estimate from the recorded phase reference and period.':'Calculated ZT from the recorded light-cycle reference.'};
}
export function calculateEntrainmentDuration(e={},endTimestamp=null){
 const result=(days,reason)=>({days,basis:days===null?'unknown':'date_difference',reason});
 if(!validTimingDate(e.start_date))return result(null,'Record the entrainment start date.');
 const endpointDate=validTimingDate(endTimestamp)?endTimestamp:localDate(endTimestamp,e.timezone||'Asia/Taipei');
 // An animal's recorded endpoint caps the exposure even when tissue is processed later.
 const end=[validTimingDate(e.end_date)?e.end_date:null,endpointDate].filter(Boolean).sort()[0];
 if(!end)return result(null,'Record an end date or animal sampling/decapitation time.');
 if(end<e.start_date)return result(null,'The endpoint precedes entrainment.');
 return result((Date.parse(end)-Date.parse(e.start_date))/86400000,'Elapsed calendar days (end date minus start date); not a precise elapsed-hour measurement.');
}
export function entrainmentLabel(e={}){const scheme=text(e.scheme)||'Unknown';return Number.isFinite(e.duration_days)?`${scheme} (${e.duration_days})`:scheme}
/** Reviewed cage schedules are candidates only; measured phase never becomes a reference automatically. */
export function locoboxEntrainmentCandidates(dataset){
 const rows=[];
 for(const record of dataset?.tables?.husbandry_events??[]){
  const p=record.locobox_protocol;
  if(archived(record)||record.event_type!=='locobox_protocol'||!p||!['active','completed'].includes(p.status)||p.evidence_status!=='recorded'||p.link_status!=='confirmed'||!text(p.cage_sid))continue;
  for(const phase of p.phases??[]){
   if(!phase||!text(phase.phase_id)||!validTimingDate(phase.start_date))continue;
   rows.push({event_id:record.event_id+'/'+phase.phase_id,source_record_id:record.event_id,source_phase_id:phase.phase_id,source_type:'locobox_protocol',protocol:phase.scheme||'unknown',cage_sid:p.cage_sid,location_id:p.location_id??null,start_date:phase.start_date,end_date:phase.end_date??null,start_time:phase.start_time??null,end_time:phase.end_time??null,interval_semantics:'exclusive end; date-only boundaries have unknown clocks',cycle_hours:phase.cycle_hours??null,light_hours:phase.light_hours??null,lights_on:phase.lights_on??null,lights_off:phase.lights_off??null,timezone:phase.timezone??null,evidence_status:'recorded',actual_exposure_verified:false,source_location_label:p.title});
  }
 }
 return rows;
}
export function entrainmentHistoryCandidates(dataset,mouseSids=[],date=null){
 const t=dataset?.tables??{},ids=new Set(mouseSids.map(String)),explicit=[];
 // Current cage assignments are deliberately not extrapolated back into the past.
 for(const event of t.husbandry_events??[]){if(archived(event)||!['cage_sid','location_id','rack_id','room_id'].some(k=>present(event[k])))continue;const linked=ids.has(String(event.mouse_sid))||(event.mouse_sids??[]).some(id=>ids.has(String(id)));if(!linked)continue;const start=event.event_date||event.start_date;if(!validTimingDate(start)||!validTimingDate(date)||start>date)continue;explicit.push(event)}
 const last=new Map();for(const e of explicit.sort((a,b)=>String(a.event_date||a.start_date).localeCompare(String(b.event_date||b.start_date))))for(const id of [e.mouse_sid,...(e.mouse_sids??[])].filter(Boolean))if(ids.has(String(id)))last.set(String(id),e);
 const contexts=[...last.values()].filter(e=>!present(e.end_date)||(validTimingDate(e.end_date)&&date<=e.end_date));
 return [...(t.light_events??[]).filter(e=>!archived(e)),...locoboxEntrainmentCandidates(dataset)].map(e=>{
   const validStart=validTimingDate(e.start_date),validEnd=!present(e.end_date)||validTimingDate(e.end_date);
   const applicable=(e.source_type!=='locobox_protocol'||validTimingDate(e.end_date))&&validTimingDate(date)&&validStart&&validEnd&&e.start_date<=date&&(!e.end_date||(/exclusive|next phase start/i.test(e.interval_semantics||'')?date<e.end_date:date<=e.end_date));
   const related=ids.has(String(e.mouse_sid))||(e.mouse_sids??[]).some(id=>ids.has(String(id)))||contexts.some(c=>e.cage_sid?c.cage_sid===e.cage_sid:e.location_id?c.location_id===e.location_id:e.rack_id?c.rack_id===e.rack_id:e.room_id&&c.room_id===e.room_id);
   return {...e,applicable,related,label:[e.source_type==='locobox_protocol'?'Locobox cage protocol':null,e.protocol||'Unknown scheme',e.start_date||'Start unknown',e.end_date?'to '+e.end_date:null,e.source_location_label||e.location_id||e.cage_sid||e.room_id,related?'Animal history candidate':'Check animal association',applicable?'Date applicable':'Check dates',e.source_type==='locobox_protocol'&&((date===e.start_date&&e.start_time)||(date===e.end_date&&e.end_time))?'Review exact boundary clock':null,e.actual_exposure_verified===true?'Recorded exposure':'Unverified exposure'].filter(Boolean).join(' · ')};
 }).sort((a,b)=>Number(b.related)-Number(a.related)||Number(b.applicable)-Number(a.applicable)||String(b.start_date||'').localeCompare(String(a.start_date||'')));
}
