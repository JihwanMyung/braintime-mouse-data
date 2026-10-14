import { summarizeBreeding } from './breeding-summary.js?v=17';
import { summarizeCages } from './cage-summary.js?v=17';

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

function index(records,key,signature) {
  const result=new Map();
  for(const record of rows(records)) {
    const recordId=id(record[key]);if(!recordId)continue;
    if(!result.has(recordId))result.set(recordId,{record,signature:signature(record),ambiguous:false});
    else if(result.get(recordId).signature!==signature(record))result.get(recordId).ambiguous=true;
  }
  return result;
}

// Keep date eligibility identical to the Breeding screen. Unknown dates are
// separately flagged when deciding whether a particular cage is confirmed.
function activeMating(mating,day) {
  if(mating.state!=='Active'||archived(mating))return false;
  const setup=calendarDay(mating.set_up_date),disbanded=calendarDay(mating.disbanded_date);
  return !(setup!==null&&setup>day)&&!(disbanded!==null&&disbanded<=day);
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

function breedingCageSummary(tables,day) {
  const mice=index(tables.mice,'mouse_sid',mouse=>JSON.stringify([archived(mouse),mouse.state,text(mouse.sex),id(mouse.cage_sid)]));
  const cages=index(tables.cages,'cage_sid',cage=>JSON.stringify([archived(cage),text(cage.state),...['room_id','rack_id','location_id'].map(key=>id(cage[key]))]));
  const matings=index(tables.matings,'mating_sid',mating=>JSON.stringify([archived(mating),mating.state,mating.set_up_date,mating.disbanded_date,
    ...['male_sids','female_sids'].map(key=>Array.isArray(mating[key])?[...new Set(mating[key].map(id))].sort():null)]));
  const occupied=new Set(),seen=new Set();let unresolvedGroups=0;
  for(const mating of rows(tables.matings)) {
    if(!activeMating(mating,day))continue;
    const matingId=id(mating.mating_sid);
    if(matingId&&seen.has(matingId))continue;if(matingId)seen.add(matingId);
    if(matingId&&matings.get(matingId)?.ambiguous){unresolvedGroups++;continue;}
    const invalidDates=['set_up_date','disbanded_date'].some(key=>has(mating[key])&&calendarDay(mating[key])===null);
    if(invalidDates){unresolvedGroups++;continue;}
    const byRole={male:new Set(),female:new Set()};let unresolved=false;
    for(const role of ['male','female']) {
      const members=Array.isArray(mating[`${role}_sids`])?[...new Set(mating[`${role}_sids`].map(id))]:[];
      if(!members.length)unresolved=true;
      for(const memberId of members) {
        const entry=mice.get(memberId),mouse=entry?.record;
        const sex=text(mouse?.sex),expected=role==='male'?['male','m']:['female','f'];
        if(!mouse||entry.ambiguous||archived(mouse)||mouse.state!=='Stock'||!expected.includes(sex)) {unresolved=true;continue;}
        const cageId=id(mouse.cage_sid),cageEntry=cages.get(cageId),cage=cageEntry?.record;
        if(!cage||cageEntry.ambiguous||archived(cage)||!['active','occupied'].includes(text(cage.state))) {unresolved=true;continue;}
        byRole[role].add(cageId);
      }
    }
    const together=[...byRole.male].filter(cageId=>byRole.female.has(cageId));
    for(const cageId of together)occupied.add(cageId);
    // A record whose members are split across cages cannot establish that all
    // its recorded breeding activity is still running at the old location.
    if(!together.length||new Set([...byRole.male,...byRole.female]).size>together.length)unresolved=true;
    if(unresolved)unresolvedGroups++;
  }
  return {count:occupied.size,unknown:unresolvedGroups>0,unresolvedGroups};
}

/** Current operational counts, independent of table filters. A count with
 * unknown=true is a confirmed minimum; zero then means no confirmed count.
 * A breeding cage requires living male and female members of the same active
 * group in that current cage. Historical mating.cage_sid is never consulted.
 * Locoboxes use the shared room mappings and physical-box rules from Cages.
 */
export function summarizeOverview(dataset,{asOf=localDate()}={}) {
  const breeding=summarizeBreeding(dataset,{asOf}),day=calendarDay(asOf),tables=dataset?.tables||{},housing=summarizeCages(dataset);
  const locoboxGroups=[housing.groups.beh,housing.groups.rat];
  return {
    asOf,livingMice:breeding.total,activeGroups:breeding.activeGroups,
    unweanedLitters:unweanedSummary(tables.litters,day),
    cagesInUse:{count:housing.cages.used,unknown:Boolean(housing.unassignedMice)},
    breedingCages:breedingCageSummary(tables,day),
    locoboxes:{
      count:locoboxGroups.reduce((sum,group)=>sum+group.used,0),
      unknown:Boolean(housing.unassignedMice||housing.unassignedCages||locoboxGroups.some(group=>
        !group.configured||group.roomMappingUnknown||group.unitUnknown||group.unlocatedCages||group.unlinkedPositions)),
    },
  };
}
