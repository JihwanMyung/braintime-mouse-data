import { summarizeBreeding } from './breeding-summary.js?v=36';
import { summarizeCages } from './cage-summary.js?v=36';

const rows=value=>Array.isArray(value)?value.filter(row=>row&&typeof row==='object'&&!Array.isArray(row)):[];
const id=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const archived=row=>Boolean(row?.app_archived_at)||row?.archived===true;
const text=value=>typeof value==='string'?value.trim().toLowerCase():'';
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

function unweanedSummary(litters,day) {
  const seen=new Map();let anonymous=0,count=0,unknown=false;
  for(const litter of rows(litters)) {
    const key=id(litter.litter_sid)||`anonymous:${++anonymous}`;
    if(!seen.has(key))seen.set(key,[]);seen.get(key).push(litter);
  }
  for(const versions of seen.values()) {
    const signatures=new Set(versions.map(litter=>JSON.stringify([archived(litter),litter.state,litter.date_of_birth,litter.wean_date,litter.end_date])));
    if(signatures.size>1){if(versions.some(litter=>!archived(litter)))unknown=true;continue;}
    const litter=versions[0];if(archived(litter))continue;
    if(['weaned','ended'].includes(text(litter.state)))continue;
    const born=calendarDay(litter.date_of_birth),weaned=calendarDay(litter.wean_date),ended=calendarDay(litter.end_date);
    if((born!==null&&born>day)||(weaned!==null&&weaned<=day)||(ended!==null&&ended<=day))continue;
    if(text(litter.state)!=='unweaned'||born===null||
      (has(litter.wean_date)&&weaned===null)||(has(litter.end_date)&&ended===null)) {
      unknown=true;continue;
    }
    count++;
  }
  return {count,unknown};
}

/** Current operational counts, independent of table filters. Breeding follows the shared mixed-sex current-cage rule and adds only
 * nonoverlapping current source-position estimates. unknown=true flags remaining
 * uncertainty; a source estimate is not an individually confirmed cohort.
 * Historical mating.cage_sid never establishes present cohabitation.
 * Locoboxes use the shared room mappings and physical-box rules from Cages.
 */
export function summarizeOverview(dataset,{asOf=localDate()}={}) {
  const breeding=summarizeBreeding(dataset,{asOf}),day=calendarDay(asOf),tables=dataset?.tables||{},housing=summarizeCages(dataset,{asOf});
  const locoboxGroups=[housing.groups.beh,housing.groups.rat],estimate=breeding.groupEstimate;
  return {
    asOf,livingMice:breeding.total,activeGroups:estimate.totalGroups,registeredActiveGroups:estimate.registeredCount,breedingEstimate:estimate,
    unweanedLitters:unweanedSummary(tables.litters,day),
    cagesInUse:{count:housing.cages.used,unknown:Boolean(housing.unassignedMice)},
    breedingCages:{count:estimate.totalGroups,unknown:Boolean(estimate.sourceEstimatedCount||estimate.sourceConflicts.length||estimate.unresolvedRegisteredGroups.length||estimate.issues.length),unresolvedGroups:estimate.unresolvedRegisteredGroups.length},
    locoboxes:{
      count:locoboxGroups.reduce((sum,group)=>sum+group.used,0),
      ...(locoboxGroups.some(group=>group.estimatedUsed)?{estimated:true}:{}),
      unknown:Boolean(housing.unassignedMice||housing.unassignedCages||locoboxGroups.some(group=>
        !group.configured||group.roomMappingUnknown||group.unitUnknown||group.unlocatedCages||group.unlinkedPositions)),
    },
  };
}
