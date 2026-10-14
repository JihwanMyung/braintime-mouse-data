export const ID_FIELDS = Object.freeze({mice:'mouse_sid',matings:'mating_sid',litters:'litter_sid',cages:'cage_sid',rooms:'room_id',racks:'rack_id',locations:'location_id',light_events:'event_id',husbandry_events:'event_id'});
const copy = value => structuredClone(value);
const ids = value => Array.isArray(value) ? value : (typeof value==='string' ? value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean) : []);
const validDate = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const key = value => JSON.stringify(value);
const populated = value => value!==null && value!==undefined && value!=='';
const provenance = name => name.startsWith('source') || name==='record_origin';

const managerName = value => typeof value==='string' ? value.trim().replace(/\s*\(Me\)$/,'').trim() : '';
function managerResult(name,source,status,candidates=[],incomplete=false) {
  return {name:name||null,source,status,candidates,incomplete,missing:status==='missing',conflict:status==='conflict'};
}
function recordedManager(record) {
  // An explicitly empty assignment suppresses the imported fallback without changing it.
  if(record&&Object.hasOwn(record,'manager')) {
    const name=managerName(record.manager);
    return managerResult(name,'manager',name?'assigned':'missing',name?[name]:[]);
  }
  const name=managerName(record?.owner);
  return name?managerResult(name,'owner','assigned',[name]):null;
}

/** Resolve an app assignment or the recorded owner; creators do not establish responsibility. */
export function mouseManager(record) {
  return recordedManager(record)??managerResult(null,null,'missing');
}

/** A cage can inherit a manager only when every current resident has the same assignment. */
export function cageManager(cage,mice=[]) {
  const recorded=recordedManager(cage);
  if(recorded)return recorded;
  if(typeof cage?.cage_sid!=='string'||!cage.cage_sid.trim())return managerResult(null,null,'missing');
  const residents=mice.filter(mouse=>mouse.cage_sid===cage.cage_sid&&mouse.state==='Stock'&&!mouse.app_archived_at&&mouse.archived!==true);
  if(!residents.length)return managerResult(null,null,'missing');
  const assignments=residents.map(mouseManager),candidates=[...new Set(assignments.map(r=>r.name).filter(Boolean))].sort();
  const incomplete=assignments.some(r=>r.status!=='assigned');
  if(candidates.length>1)return managerResult(null,'residents','conflict',candidates,incomplete);
  if(incomplete||!candidates.length)return managerResult(null,'residents','missing',candidates,true);
  return managerResult(candidates[0],'residents','assigned',candidates);
}

export function normalizeDataset(dataset) {
  if (!dataset || typeof dataset!=='object' || Array.isArray(dataset)) throw new Error('A dataset object is required.');
  const result=copy(dataset);
  result.tables ??= {};
  if(typeof result.tables!=='object'||Array.isArray(result.tables))throw new Error('Dataset tables must be an object of named arrays.');
  for(const name of [...Object.keys(ID_FIELDS),'parent_links','mating_members','mouse_genes','mating_litters','litter_mice','mouselines']) {
    result.tables[name] ??= [];
    if(!Array.isArray(result.tables[name]))throw new Error(`The ${name} table must be an array.`);
  }
  result.sources ??= []; result.issues ??= []; result.caveats ??= [];
  for(const mating of result.tables.matings) {
    const members=result.tables.mating_members.filter(r=>r.mating_sid===mating.mating_sid);
    if(!Array.isArray(mating.male_sids))mating.male_sids=[...new Set(members.filter(r=>r.recorded_role==='male_member').map(r=>r.mouse_sid))];
    if(!Array.isArray(mating.female_sids))mating.female_sids=[...new Set(members.filter(r=>r.recorded_role==='female_member').map(r=>r.mouse_sid))];
  }
  result.schema_version ??= '1.0';
  result.summary ??= {};
  result.summary.counts={...result.summary.counts,...Object.fromEntries(Object.entries(result.tables).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,v.length]))};
  const mice=result.tables.mice;
  result.summary.mouse_state_counts=Object.fromEntries([...new Set(mice.map(r=>r.state))].filter(Boolean).map(s=>[s,mice.filter(r=>r.state===s).length]));
  result.summary.mice_without_recorded_genotype=mice.filter(r=>!populated(r.genotype)).length;
  result.summary.mice_without_recorded_parents=mice.filter(r=>!ids(r.sire_sids).length&&!ids(r.dam_sids).length).length;
  result.summary.mice_with_multiple_candidate_dams=mice.filter(r=>ids(r.dam_sids).length>1).length;
  return result;
}

function problems(dataset) {
  const found=[];
  const tables=dataset.tables??{};
  const index={};
  for(const [type,field] of Object.entries(ID_FIELDS))index[type]=new Map((tables[type]??[]).map(r=>[r[field],r]));
  const add=(code,type,id,detail,message)=>found.push({fingerprint:key([code,type,id,detail]),type,id,message});
  for(const [type,field] of Object.entries(ID_FIELDS)) {
    const seen=new Set();
    for(const r of tables[type]??[]) {
      const id=r[field];
      if(typeof id!=='string'||!id.trim())add('id',type,id,null,`${field} must be a nonempty text identifier.`);
      if(seen.has(id))add('duplicate',type,id,null,`${type} identifier ${id} is duplicated.`);
      seen.add(id);
      for(const name of ['sire_sids','dam_sids','male_sids','female_sids'])if(Array.isArray(r[name])&&new Set(r[name]).size!==r[name].length)add('duplicate_parent',type,id,[name,r[name]],`${id}: ${name} contains duplicate identifiers.`);
      for(const [name,value] of Object.entries(r))if((name.endsWith('_date')||name==='date_of_birth')&&populated(value)&&!validDate(value))add('date',type,id,[name,value],`${id}: ${name} must be a valid YYYY-MM-DD date.`);
      const born=r.date_of_birth;
      if(validDate(born))for(const name of ['end_date','wean_date','mature_date','received_date','procedure_date','tail_tag_date'])if(validDate(r[name])&&r[name]<born)add('date_order',type,id,[name,r[name],born],`${id}: ${name} precedes birth.`);
      if(validDate(r.set_up_date)&&validDate(r.disbanded_date)&&r.disbanded_date<r.set_up_date)add('mating_dates',type,id,[r.set_up_date,r.disbanded_date],`${id}: disbanded date precedes set up date.`);
      if(populated(r.cage_sid)&&!index.cages.has(r.cage_sid))add('cage',type,id,r.cage_sid,`${id}: cage ${r.cage_sid} is not in this dataset.`);
      if(type==='mice'&&populated(r.litter_sid)&&!index.litters.has(r.litter_sid))add('litter',type,id,r.litter_sid,`${id}: litter ${r.litter_sid} is not in this dataset.`);
      if(type==='litters'&&populated(r.mating_sid)&&!index.matings.has(r.mating_sid))add('mating',type,id,r.mating_sid,`${id}: mating ${r.mating_sid} is not in this dataset.`);
      for(const [name,target] of [['room_id','rooms'],['rack_id','racks'],['location_id','locations']])if(populated(r[name])&&type!==target&&!index[target].has(r[name]))add('location_ref',type,id,[name,r[name]],`${id}: ${name} ${r[name]} does not exist.`);
      if(type==='husbandry_events'&&populated(r.mouse_sid)&&!index.mice.has(r.mouse_sid))add('mouse_ref',type,id,r.mouse_sid,`${id}: mouse ${r.mouse_sid} does not exist.`);
      if(populated(r.rack_id)&&populated(r.room_id)&&index.racks.has(r.rack_id)&&index.racks.get(r.rack_id).room_id!==r.room_id)add('rack_room',type,id,[r.rack_id,r.room_id],`${id}: the selected rack belongs to a different room.`);
      if(populated(r.location_id)&&index.locations.has(r.location_id))for(const name of ['room_id','rack_id'])if(populated(r[name])&&populated(index.locations.get(r.location_id)[name])&&r[name]!==index.locations.get(r.location_id)[name])add('location_parent',type,id,[name,r[name],r.location_id],`${id}: ${name} differs from the selected location.`);
      if(validDate(r.start_date)&&validDate(r.end_date)&&r.end_date<r.start_date)add('event_dates',type,id,[r.start_date,r.end_date],`${id}: end date precedes start date.`);
      if(type==='light_events') {
        for(const name of ['lights_on','lights_off'])if(populated(r[name])&&(typeof r[name]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(r[name])))add('time',type,id,[name,r[name]],`${id}: ${name} must use 24-hour HH:mm.`);
        for(const name of ['cycle_hours','light_hours','transition_minutes','intensity_lux'])if(populated(r[name])){
          const n=Number(r[name]);
          if((typeof r[name]==='string'&&!r[name].trim())||!Number.isFinite(n)||(name==='cycle_hours'?n<=0:n<0))add('light_number',type,id,[name,r[name]],`${id}: ${name} must be ${name==='cycle_hours'?'greater than zero':'zero or greater'}.`);
        }
        if(populated(r.light_hours)&&populated(r.cycle_hours)&&Number(r.light_hours)>Number(r.cycle_hours))add('light_cycle',type,id,[r.light_hours,r.cycle_hours],`${id}: light hours cannot exceed cycle hours.`);
      }
      if(type==='cages'&&populated(r.capacity)&&(!Number.isInteger(Number(r.capacity))||Number(r.capacity)<0))add('capacity',type,id,r.capacity,`${id}: capacity must be a nonnegative whole number.`);
    }
  }
  const graph=new Map();
  for(const m of tables.mice??[]) {
    const parents=[];
    for(const [field,expected] of [['sire_sids','Male'],['dam_sids','Female']]) {
      for(const pid of ids(m[field])) {
        parents.push(pid);
        const p=index.mice.get(pid);
        if(!p)add('parent_missing','mice',m.mouse_sid,[field,pid],`${m.mouse_sid}: parent ${pid} does not exist.`);
        else {
          if(p.sex!==expected)add('parent_sex','mice',m.mouse_sid,[field,pid,p.sex],`${m.mouse_sid}: ${field==='sire_sids'?'sire':'dam'} ${pid} has sex ${p.sex??'unknown'}; ${expected} is required.`);
          if(validDate(p.date_of_birth)&&validDate(m.date_of_birth)&&p.date_of_birth>=m.date_of_birth)add('parent_date','mice',m.mouse_sid,[pid,p.date_of_birth,m.date_of_birth],`${m.mouse_sid}: parent ${pid} must be born before the offspring.`);
        }
        if(pid===m.mouse_sid)add('self','mice',m.mouse_sid,field,`${m.mouse_sid} cannot be its own parent.`);
      }
    }
    graph.set(m.mouse_sid,parents);
  }
  // Every edge in a candidate set participates: ambiguity is not permission to add a possible cycle.
  const active=new Set(), done=new Set();
  const visit=(id,trail)=>{
    if(done.has(id))return;
    if(active.has(id)){
      const cycle=trail.slice(trail.indexOf(id));
      add('cycle','mice',id,[...cycle].sort(),`Parent links form a possible ancestry cycle: ${[...cycle,id].join(' → ')}.`);return;
    }
    active.add(id);for(const p of graph.get(id)??[])if(graph.has(p))visit(p,[...trail,id]);active.delete(id);done.add(id);
  };
  for(const id of graph.keys())visit(id,[]);
  for(const m of tables.matings??[])for(const [name,expected] of [['male_sids','Male'],['female_sids','Female'],['sire_sids','Male'],['dam_sids','Female']])for(const pid of ids(m[name])) {
    const p=index.mice.get(pid);
    if(!p)add('member','matings',m.mating_sid,[name,pid],`${m.mating_sid}: breeder ${pid} does not exist.`);
    else if(p.sex!==expected)add('member_sex','matings',m.mating_sid,[name,pid,p.sex],`${m.mating_sid}: breeder ${pid} must be ${expected}.`);
  }
  for(const litter of tables.litters??[])for(const [name,expected] of [['sire_sids','Male'],['dam_sids','Female']])for(const pid of ids(litter[name])) {
    const p=index.mice.get(pid);
    if(!p)add('parent_missing','litters',litter.litter_sid,[name,pid],`${litter.litter_sid}: parent ${pid} does not exist.`);
    else {
      if(p.sex!==expected)add('parent_sex','litters',litter.litter_sid,[name,pid,p.sex],`${litter.litter_sid}: parent ${pid} must be ${expected}.`);
      if(validDate(p.date_of_birth)&&validDate(litter.date_of_birth)&&p.date_of_birth>=litter.date_of_birth)add('parent_date','litters',litter.litter_sid,[pid,p.date_of_birth,litter.date_of_birth],`${litter.litter_sid}: parent ${pid} must be born before the litter.`);
    }
  }
  return found;
}

export function validateRecord(type,draft,dataset,originalId=null) {
  const errors=[],warnings=[];
  if(!ID_FIELDS[type])return {errors:[`Unsupported record type: ${type}.`],warnings};
  if(!draft||typeof draft!=='object'||Array.isArray(draft))return {errors:['A record object is required.'],warnings};
  const base=normalizeDataset(dataset),field=ID_FIELDS[type],old=base.tables[type].find(r=>r[field]===originalId);
  if(originalId!==null&&!old)errors.push('The original record no longer exists. Reload before editing.');
  if(typeof draft[field]!=='string'||!draft[field].trim())errors.push(`${field} must be a nonempty text identifier.`);
  if(old&&draft[field]!==originalId)errors.push('An existing record identifier cannot be changed. Create a new record instead.');
  if(base.tables[type].some(r=>r[field]===draft[field]&&r[field]!==originalId))errors.push(`Identifier ${draft[field]} already exists.`);
  if(old)for(const name of new Set([...Object.keys(old),...Object.keys(draft)]))if(provenance(name)&&key(old[name])!==key(draft[name]))errors.push(`Imported provenance ${name} cannot be changed.`);
  if(type==='mice'&&!['Male','Female','Unknown'].includes(draft.sex))errors.push('Sex must be Male, Female, or Unknown.');
  if(type==='mice'||type==='cages') {
    if(Object.hasOwn(draft,'manager')&&draft.manager!==null&&typeof draft.manager!=='string')errors.push('Manager must be a name or an empty assignment.');
    const resolved=type==='mice'?mouseManager(draft):cageManager(draft,base.tables.mice);
    const changed=old&&(Object.hasOwn(old,'manager')!==Object.hasOwn(draft,'manager')||key(old.manager)!==key(draft.manager));
    if(resolved.status!=='assigned') {
      const detail=resolved.status==='conflict'?'Resident mice have different managers.':resolved.incomplete?'Some resident mice have no recorded manager.':'No manager is recorded.';
      if(!old||changed)errors.push(`${detail} Assign a manager before saving this ${type==='mice'?'mouse':'cage'}.`);
      else warnings.push(`${detail} The existing record can be saved without inventing an assignment.`);
    }
  }
  for(const name of ['sire_sids','dam_sids','male_sids','female_sids'])if(populated(draft[name])&&(!Array.isArray(draft[name])||draft[name].some(id=>typeof id!=='string'||!id.trim())))errors.push(`${name} must contain text identifiers.`);
  const candidate=copy(base);
  candidate.tables[type]=base.tables[type].filter(r=>r[field]!==originalId);
  candidate.tables[type].push(copy(draft));
  const prior=new Set(problems(base).map(p=>p.fingerprint));
  for(const issue of problems(candidate)) {
    if(!prior.has(issue.fingerprint))errors.push(issue.message);
    else if(issue.type===type&&issue.id===originalId)warnings.push(`Existing source issue retained: ${issue.message}`);
  }
  if(ids(draft.dam_sids).length>1)warnings.push('Multiple dam IDs remain candidates; individual maternity is not established.');
  if(type==='mice'&&!populated(draft.genotype))warnings.push('Genotype remains unknown. A blank does not mean wild type.');
  if(type==='light_events'&&!populated(draft.cycle_hours))warnings.push('Cycle duration is unspecified; no light schedule is inferred.');
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}

export function createSyntheticDataset() {
  return normalizeDataset({schema_version:'1.0',as_of_local_date:'2026-10-14',synthetic:true,sources:[],caveats:['Synthetic demonstration records only.'],tables:{
    mice:[{mouse_sid:'SYN-M001',physical_tag:'Demo sire',sex:'Male',date_of_birth:'2025-01-01',state:'Stock',genotype:null,sire_sids:[],dam_sids:[],cage_sid:'SYN-C1'},{mouse_sid:'SYN-M002',physical_tag:'Demo dam',sex:'Female',date_of_birth:'2025-01-01',state:'Stock',genotype:null,sire_sids:[],dam_sids:[],cage_sid:'SYN-C1'},{mouse_sid:'SYN-M003',physical_tag:'Demo offspring',sex:'Unknown',date_of_birth:'2025-04-01',state:'Stock',genotype:null,sire_sids:['SYN-M001'],dam_sids:['SYN-M002'],litter_sid:'SYN-L1',cage_sid:'SYN-C2'}],
    cages:[{cage_sid:'SYN-C1',cage_tag:'Demo breeders',state:'Active'},{cage_sid:'SYN-C2',cage_tag:'Demo offspring',state:'Active'}],
    matings:[{mating_sid:'SYN-B1',male_sids:['SYN-M001'],female_sids:['SYN-M002'],set_up_date:'2025-03-01',state:'Active',cage_sid:'SYN-C1'}],
    litters:[{litter_sid:'SYN-L1',mating_sid:'SYN-B1',date_of_birth:'2025-04-01',size_reported:'1',state:'Weaned'}]
  }});
}
