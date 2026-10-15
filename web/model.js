import { validateLocoboxRecord } from './locobox-model.js?v=24';
import { validateIacucRecord } from './iacuc-model.js?v=48';
import { validateLacFeeRecord } from './lac-fee-model.js?v=33';
import { validateUserAcronym } from './user-acronyms.js';
import { validateCageSummaryOptions } from './cage-summary-options.js?v=33';
import { validateBreedingOptions } from './breeding-options.js?v=24';
import { validateStrainDefinition } from './strain-registry.js?v=36';
import { validateGeneticProfile } from './genotype-schema.js?v=24';
import { validateScenario } from './genetics.js?v=24';
import { validateExperimentRecord } from './experiment-model.js?v=24';
import { validateCryoRecord } from './cryopreservation-model.js?v=24';
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

const archived = record => Boolean(record?.app_archived_at) || record?.archived===true;
const reference = value => populated(value) ? value : null;
const housingLabel = record => [record?.name,record?.label].find(value=>typeof value==='string'&&value.trim())?.trim()||null;
const housingText = value => typeof value==='string'&&value.trim()?value.trim():null;

// Resolve only recorded links. A position supplies omitted ancestors, never an inferred cage match.
function housingReferences(record,dataset,type='cages') {
  const tables=dataset.tables??{},find=(table,field,id)=>(tables[table]??[]).find(row=>populated(id)&&row[field]===id);
  const position=type==='locations'?record:find('locations','location_id',record?.location_id);
  const location_id=reference(record?.location_id);
  const rack_id=reference(record?.rack_id)??reference(position?.rack_id);
  const rack=type==='racks'?record:find('racks','rack_id',rack_id);
  const room_id=reference(record?.room_id)??reference(position?.room_id)??reference(rack?.room_id);
  const room=type==='rooms'?record:find('rooms','room_id',room_id);
  return {room_id,rack_id,location_id,room,rack,position};
}

function housingSnapshot(record,dataset) {
  const refs=housingReferences(record,dataset);
  const room_label=housingLabel(refs.room)??refs.room_id??housingText(record?.room);
  const rack_label=housingLabel(refs.rack)??refs.rack_id??housingText(record?.rack);
  const position_label=housingLabel(refs.position)??refs.location_id??housingText(record?.location);
  return {room_id:refs.room_id,rack_id:refs.rack_id,location_id:refs.location_id,room_label,rack_label,position_label,
    location_label:[room_label,rack_label,position_label].filter(populated).join(' / ')||null};
}

/** Save human-readable housing at the time of a dated cage assignment, including its previous path. */
export function buildCageLocationEvent(cage,old,date,dataset,notes='') {
  if(typeof cage?.cage_sid!=='string'||!cage.cage_sid.trim())throw new Error('A cage SID is required for assignment history.');
  if(!validDate(date))throw new Error('Choose a valid effective housing change date (YYYY-MM-DD).');
  const current=housingSnapshot(cage,dataset),previous=housingSnapshot(old,dataset),stamp=new Date().toISOString();
  return {event_id:`LOC-${crypto.randomUUID()}`,record_origin:'app_created',event_type:'cage_location_assignment',
    cage_sid:cage.cage_sid,cage_tag:cage.cage_tag??old?.cage_tag??null,event_date:date,...current,
    ...Object.fromEntries(Object.entries(previous).map(([field,value])=>[`old_${field}`,value])),
    notes:typeof notes==='string'&&notes.trim()?notes.trim():null,app_created_at:stamp,app_modified_at:stamp};
}

function housingMatches(type,id,record,dataset,recordType='cages') {
  const refs=housingReferences(record,dataset,recordType);
  return refs[ID_FIELDS[type]]===id;
}

function datedEventReferences(type,record,event,dataset) {
  if(!['event_date','start_date','end_date'].some(field=>populated(event[field])))return false;
  const target=housingReferences(record,dataset,type);
  for(const prefix of ['','old_']) {
    const scoped=Object.fromEntries(['room_id','rack_id','location_id'].map(field=>[field,event[prefix+field]]));
    const cageSid=event[prefix+'cage_sid'];
    const cage=(dataset.tables.cages??[]).find(row=>populated(cageSid)&&row.cage_sid===cageSid);
    if(cage&&housingMatches(type,record[ID_FIELDS[type]],cage,dataset))return true;
    const refs=housingReferences(scoped,dataset);
    if(type==='racks'&&refs.rack_id===record.rack_id)return true;
    if(type==='locations'&&refs.location_id===record.location_id)return true;
    // Room-wide and rack-wide events also describe their descendant positions.
    // A different specific cage or position must not become a room-wide reference.
    if(!populated(cageSid)&&!refs.location_id) {
      if(type==='locations'&&refs.rack_id&&refs.rack_id===target.rack_id)return true;
      if(!refs.rack_id&&refs.room_id&&refs.room_id===target.room_id)return true;
    }
  }
  return false;
}

function validateHousing(type,draft,old,base,errors) {
  const tables=base.tables,field=ID_FIELDS[type],id=draft[field];
  const newAppRecord=!old&&draft.record_origin==='app_created';
  if(newAppRecord&&['rooms','racks'].includes(type)&&!housingText(draft.name))errors.push(`Give this ${type==='rooms'?'room':'rack'} a human-readable name.`);
  if(newAppRecord&&['racks','locations'].includes(type)&&!housingText(draft.room_id))errors.push(`Select a room for the new ${type==='racks'?'rack':'position'}.`);
  if(newAppRecord&&type==='locations'&&!housingText(draft.rack_id))errors.push('Select a rack for the new position.');
  if(type==='locations')for(const coordinate of ['row','column']) {
    if(populated(draft[coordinate])&&(!old||key(old[coordinate])!==key(draft[coordinate]))&&
      (typeof draft[coordinate]!=='number'||!Number.isInteger(draft[coordinate])||draft[coordinate]<0))errors.push(`Position ${coordinate} must be a nonnegative whole number.`);
  }

  // Apply current-housing rules only to changed assignments, not to dated source history.
  if(['racks','locations','cages'].includes(type)) {
    const current=housingReferences(draft,base,type),previous=housingReferences(old,base,type);
    const reactivated=type==='cages'&&['Active','Occupied'].includes(draft.state)&&!['Active','Occupied'].includes(old?.state);
    const changed=!old||['room_id','rack_id','location_id'].some(name=>current[name]!==previous[name])||(archived(old)&&!archived(draft))||reactivated;
    if(changed)for(const [name,parent] of [['room',current.room],['rack',current.rack],['position',current.position]]) {
      if(parent===draft)continue;
      if(archived(parent))errors.push(`The selected ${name} is archived. Restore it or choose active housing before assigning this ${type==='cages'?'cage':type==='racks'?'rack':'position'}.`);
    }
  }
  if(type==='mice'&&populated(draft.cage_sid)&&(!old||draft.cage_sid!==old.cage_sid||(archived(old)&&!archived(draft))||(draft.state==='Stock'&&old.state!=='Stock'))) {
    const cage=tables.cages.find(row=>row.cage_sid===draft.cage_sid),refs=housingReferences(cage,base);
    if([cage,refs.room,refs.rack,refs.position].some(archived))errors.push('The selected cage or its housing is archived. Choose an active cage and housing before assigning this mouse.');
  }

  if(type==='husbandry_events'&&old?.event_type==='cage_location_assignment') {
    const snapshotFields=['room_id','rack_id','location_id','room_label','rack_label','position_label','location_label'];
    const immutable=['event_type','cage_sid','cage_tag','mouse_sid','old_cage_sid',...snapshotFields,...snapshotFields.map(name=>'old_'+name)];
    if(immutable.some(name=>key(reference(old[name]))!==key(reference(draft[name]))))errors.push('The cage, location references and captured labels of an assignment history record cannot be changed. Record a new dated cage assignment instead; the existing date and notes can be corrected.');
  }

  if(old&&['racks','locations'].includes(type)) {
    const current=housingReferences(draft,base,type),previous=housingReferences(old,base,type);
    const reparented=(type==='racks'?['room_id']:['room_id','rack_id']).some(name=>current[name]!==previous[name]);
    if(reparented) {
      const cageReference=tables.cages.some(cage=>housingMatches(type,old[field],cage,base));
      const eventReference=[...tables.light_events,...tables.husbandry_events].some(event=>datedEventReferences(type,old,event,base));
      if(cageReference||eventReference)errors.push(`This ${type==='racks'?'rack':'position'} is referenced by cages or dated history and cannot be moved to a different parent. Create a new ${type==='racks'?'rack':'position'} and use a dated cage assignment instead.`);
    }
  }

  if(old&&!archived(old)&&archived(draft)&&['rooms','racks','locations'].includes(type)) {
    const childTypes=type==='rooms'?['racks','locations']:type==='racks'?['locations']:[];
    const children=childTypes.flatMap(childType=>tables[childType].filter(child=>!archived(child)&&housingMatches(type,id,child,base,childType)));
    const stockCages=new Set(tables.mice.filter(mouse=>mouse.state==='Stock'&&!archived(mouse)).map(mouse=>mouse.cage_sid));
    const activeCages=tables.cages.filter(cage=>housingMatches(type,id,cage,base)&&
      ((!archived(cage)&&['Active','Occupied'].includes(cage.state))||stockCages.has(cage.cage_sid)));
    if(children.length)errors.push(`This ${type==='locations'?'position':type==='racks'?'rack':'room'} has active child racks or positions. Archive or move those children before archiving it.`);
    if(activeCages.length)errors.push(`This ${type==='locations'?'position':type==='racks'?'rack':'room'} contains active cages or Stock mice. Move the cages or update their current status before archiving it.`);
  }
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
      if(type==='locations'&&populated(r.locobox_id)&&(typeof r.locobox_id!=='string'||!r.locobox_id.trim()||r.locobox_id.length>100))add('locobox_id',type,id,r.locobox_id,`${id}: Locobox ID must be text of at most 100 characters.`);
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
  if(type==='mice'&&draft.ear_mark!==undefined&&draft.ear_mark!==null&&(typeof draft.ear_mark!=='string'||[...draft.ear_mark].length>160))errors.push('Ear marking must be text of at most 160 characters, or blank.');
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
  validateHousing(type,draft,old,base,errors);
  if(type==='husbandry_events')errors.push(...validateStrainDefinition(draft,old),...validateBreedingOptions(draft,old),...validateCageSummaryOptions(draft,old),...validateUserAcronym(draft,old));
  if(type==='husbandry_events'){for(const checked of [validateIacucRecord(draft,base),validateLocoboxRecord(draft,base,old)]){errors.push(...checked.errors);warnings.push(...checked.warnings);}}
  if(type==='husbandry_events'){const checked=validateLacFeeRecord(draft,base,old);errors.push(...checked.errors);warnings.push(...checked.warnings);}
  if(type==='husbandry_events'){const checked=validateExperimentRecord(draft,base,old);errors.push(...checked.errors);warnings.push(...checked.warnings);}
  if(type==='husbandry_events'){const checked=validateCryoRecord(draft,base,old);errors.push(...checked.errors);warnings.push(...checked.warnings);}
  if(type==='mice'&&key(draft.genetic_profile)!==key(old?.genetic_profile)) {
    errors.push(...validateGeneticProfile(draft.genetic_profile));
    if(draft.genetic_profile?.calls&&Object.values(draft.genetic_profile.calls).some(call=>call?.evidence!=='confirmed'))warnings.push('Unconfirmed allele calls remain provisional and are excluded from confirmed-parent ranking.');
  }
  if(type==='husbandry_events'&&(draft.event_type==='breeding_plan'||draft.breeding_plan||old?.breeding_plan)) {
    if(draft.event_type!=='breeding_plan')errors.push('A saved breeding plan must retain its breeding_plan event type.');
    if(!old||old.event_type!=='breeding_plan'||key(draft.breeding_plan)!==key(old?.breeding_plan)) {
      const plan=draft.breeding_plan;
      if(!plan||plan.schema_version!==1||typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>160)errors.push('A breeding plan needs a name and schema version 1.');
      else {const check=validateScenario(plan.scenario);errors.push(...check.errors);warnings.push(...check.warnings);}
    }
  }
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
