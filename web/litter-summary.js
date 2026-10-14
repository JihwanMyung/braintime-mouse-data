const rows=value=>Array.isArray(value)?value.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)):[];
const id=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const text=value=>typeof value==='string'?value.trim().toLowerCase():'';
const archived=row=>Boolean(row?.app_archived_at)||row?.archived===true;
const has=value=>value!==undefined&&value!==null&&value!=='';

function localDate() {
  const now=new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

function calendarDay(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const stamp=Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?stamp/86400000:null;
}

function groupRecords(records,key) {
  const groups=new Map();let anonymous=0;
  for(const record of rows(records)) {
    const recordId=id(record[key]),groupKey=recordId?`id:${recordId}`:`anonymous:${++anonymous}`;
    if(!groups.has(groupKey))groups.set(groupKey,{id:recordId,records:[]});
    groups.get(groupKey).records.push(record);
  }
  return groups;
}

function unanimous(records,read) {
  const values=records.map(read),first=JSON.stringify(values[0]);
  return values.every(value=>JSON.stringify(value)===first)?{value:values[0],known:true}:{known:false};
}

function currentStatus(records) {
  return unanimous(records,row=>({archived:archived(row),state:text(row.state)}));
}

function isLiving(status) {
  return status.known&&!status.value.archived&&status.value.state==='stock';
}

function dateValue(value) {return has(value)?value:null;}

function validPastWean(value,born,day) {
  const date=calendarDay(value);
  return date!==null&&date>=born&&date<=day;
}

// The mouse's own recorded dam is required. A litter or a mating does not
// resolve uncertain individual maternity, even when it lists only one dam.
function directDam(records) {
  const result=unanimous(records,row=>Array.isArray(row.dam_sids)?[...new Set(row.dam_sids.map(id))].sort():[]);
  return result.known&&result.value.length===1&&result.value[0]?result.value[0]:'';
}

function recordedWeaning(records,litters,born,day) {
  const ownDate=unanimous(records,row=>dateValue(row.wean_date));
  if(!ownDate.known)return false;
  if(ownDate.value!==null&&!validPastWean(ownDate.value,born,day))return false;
  const ownWeaning=ownDate.value!==null;
  const link=unanimous(records,row=>id(row.litter_sid));
  if(!link.known)return false;
  const litterGroup=link.value?litters.get(`id:${link.value}`):null;
  if(!litterGroup)return ownWeaning;
  const evidence=unanimous(litterGroup.records,row=>({archived:archived(row),state:text(row.state),born:dateValue(row.date_of_birth),weaned:dateValue(row.wean_date)}));
  if(!evidence.known)return false;
  const litter=evidence.value;
  if(litter.archived||litter.state==='ended')return ownWeaning;
  // A populated contradictory or invalid date must not be replaced by a
  // more convenient litter state or by the other record's date.
  if(litter.born!==null&&calendarDay(litter.born)!==born)return false;
  if(litter.weaned!==null&&!validPastWean(litter.weaned,born,day))return false;
  if(litter.state==='unweaned')return false;
  return ownWeaning||litter.weaned!==null||litter.state==='weaned';
}

function currentCage(records,cages) {
  const assignment=unanimous(records,row=>id(row.cage_sid));
  if(!assignment.known||!assignment.value)return '';
  const group=cages.get(`id:${assignment.value}`);if(!group)return '';
  const status=currentStatus(group.records);
  return status.known&&!status.value.archived&&['active','occupied'].includes(status.value.state)?assignment.value:'';
}

function separatedFromDam(group,mice,cages) {
  const damId=directDam(group.records);
  if(!damId||damId===group.id)return false;
  const dam=mice.get(`id:${damId}`);
  if(!dam||!isLiving(currentStatus(dam.records)))return false;
  const sex=unanimous(dam.records,row=>text(row.sex));
  if(!sex.known||!['female','f'].includes(sex.value))return false;
  const childCage=currentCage(group.records,cages),damCage=currentCage(dam.records,cages);
  return Boolean(childCage&&damCage&&childCage!==damCage);
}

/** Calendar-age counts for current Stock mice, independent of table filters.
 * Under three weeks includes newborns. Three weeks and older is an age group,
 * not evidence of weaning. The separate management subtotal requires recorded
 * weaning plus distinct current cages for the mouse and its sole recorded dam.
 * Litter sizes and historical housing fields never create current mice.
 */
export function summarizeLitters(dataset,{asOf=localDate()}={}) {
  const day=calendarDay(asOf);
  if(day===null)throw new TypeError('Litter summary needs a valid YYYY-MM-DD date.');
  const tables=dataset?.tables||{},mice=groupRecords(tables.mice,'mouse_sid'),litters=groupRecords(tables.litters,'litter_sid'),cages=groupRecords(tables.cages,'cage_sid');
  const result={asOf,livingMice:0,newborn:0,preWeaningAge:0,weaningAge:0,unknownAge:0,unknownCurrent:0,weanedAndSeparated:0,unconfirmedWeanedAndSeparated:0};
  for(const group of mice.values()) {
    const status=currentStatus(group.records);
    if(!status.known) {
      if(group.records.some(mouse=>!archived(mouse)&&text(mouse.state)==='stock'))result.unknownCurrent++;
      continue;
    }
    if(!isLiving(status))continue;
    result.livingMice++;
    const birth=unanimous(group.records,row=>dateValue(row.date_of_birth)),born=birth.known?calendarDay(birth.value):null,age=born===null?null:day-born;
    if(age===null||age<0){result.unknownAge++;continue;}
    if(age<7)result.newborn++;
    if(age<21)result.preWeaningAge++;
    else {
      result.weaningAge++;
      if(recordedWeaning(group.records,litters,born,day)&&separatedFromDam(group,mice,cages))result.weanedAndSeparated++;
    }
  }
  result.unconfirmedWeanedAndSeparated=result.weaningAge-result.weanedAndSeparated;
  return result;
}
