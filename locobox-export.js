/** Date-scoped reports. Source narrative and complete revision snapshots require the backup route. */
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const fields=(p,keys)=>Object.fromEntries(keys.filter(k=>obj(p)&&Object.hasOwn(p,k)&&(p[k]===null||typeof p[k]==='string'||typeof p[k]==='boolean'||typeof p[k]==='number'&&Number.isFinite(p[k]))).map(k=>[k,typeof p[k]==='string'?[...p[k]].slice(0,500).join(''):p[k]]));
// PostgreSQL jsonb text uses a space after each structural comma and colon.
const sqlJSON=x=>Array.isArray(x)?'['+x.map(sqlJSON).join(', ')+']':obj(x)?'{'+Object.entries(x).map(([k,v])=>JSON.stringify(k)+': '+sqlJSON(v)).join(', ')+'}':JSON.stringify(x);
const bytes=x=>new TextEncoder().encode(sqlJSON(x)).length;
export function locoboxIntervalForExport(p,{fromDate=null,toDate,includeUndated=false}={}){
 if(!obj(p)||!date(toDate))return null;
 const a=date(p.start_date)?p.start_date:null,b=date(p.end_date)?p.end_date:null;
 const inside=d=>d&&(!fromDate||d>=fromDate)&&d<=toDate;
 // An old open-ended observation is not evidence that exposure continued into this window.
 const overlap=a&&b&&a<=toDate&&(!fromDate||b>fromDate||b===fromDate&&p.end_time&&p.end_time>'00:00:00');
 if(!(inside(a)||inside(b)||overlap||!a&&!b&&includeUndated&&!fromDate))return null;
 const out={},withheld=[];
 for(const [key,d]of [['start',a],['end',b]]){
  if(inside(d)){out[key+'_date']=d;if(typeof p[key+'_time']==='string')out[key+'_time']=p[key+'_time'];}
  else if(d)withheld.push(key);else out[key+'_date']=null;
 }
 if(withheld.length){out.export_interval_clipped=true;out.export_window_start=fromDate;out.export_window_end=toDate;out.export_withheld_boundaries=withheld;}
 return out;
}
function measurement(p,timezone,range){
 if(!obj(p)||typeof p.measured_at!=='string'||!Number.isFinite(Date.parse(p.measured_at))||!/(?:Z|[+-]\d\d:\d\d)$/.test(p.measured_at))return null;
 let local;try{local=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(p.measured_at));}catch{return null;}
 if(range.fromDate&&local<range.fromDate||local>range.toDate)return null;
 return fields(p,['measured_at','phase_hours','basis','method']);
}
export function projectLocoboxExport(row,{fromDate=null,toDate,includeUndated=false}={}){
 if(row?.event_type!=='locobox_protocol'||!obj(row.locobox_protocol))return null;
 const range={fromDate,toDate,includeUndated},p=row.locobox_protocol,out=fields(row,['event_id','event_type']),nested=fields(p,['schema_version','protocol_id','title','status','evidence_status','cage_sid','location_id','source_cage_label','link_status']);
 const phases=[];let eligible=0;
 for(const phase of Array.isArray(p.phases)?p.phases:[]){
  const interval=locoboxIntervalForExport(phase,range);if(!interval)continue;eligible++;
  const item={...fields(phase,['phase_id','label','timezone','scheme','cycle_hours','light_hours','lights_on','lights_off','transition_minutes','intensity_lux']),...interval};
  if(!interval.export_interval_clipped)Object.assign(item,fields(phase,['duration_days','duration_basis']));
  const measured=measurement(phase.measured_phase,phase.timezone,range);if(measured)item.measured_phase=measured;
  const treatments=[];let treatmentCount=0;
  for(const t of Array.isArray(phase.treatments)?phase.treatments:[]){const window=locoboxIntervalForExport(t,range);if(!window)continue;treatmentCount++;if(treatments.length<30)treatments.push({...fields(t,['treatment_id','name','status','dose','dose_unit','concentration','concentration_unit','route','vehicle','delivery','frequency']),...window});}
  Object.assign(item,{treatments,treatment_count:treatmentCount,treatments_truncated:treatments.length<treatmentCount});
  if(bytes([...phases,item])<=300000)phases.push(item);
 }
 if(!phases.length)return null;
 if(date(row.event_date)&&(!fromDate||row.event_date>=fromDate)&&row.event_date<=toDate)out.event_date=row.event_date;
 else if(row.event_date)out.export_event_date_withheld=true;else out.event_date=null;
 out.locobox_protocol={...nested,phases,phase_count:eligible,phases_truncated:phases.length<eligible};return out;
}
