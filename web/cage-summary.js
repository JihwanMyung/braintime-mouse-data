import { getCageSummaryOptions, getCageSummaryOptionsStatus } from './cage-summary-options.js?v=33';
import { classifyAnimalSheetBreedingBlock } from './breeding-summary.js?v=24';

const list=value=>Array.isArray(value)?value.filter(record=>record&&typeof record==='object'&&!Array.isArray(record)):[];
const id=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const state=record=>typeof record?.state==='string'?record.state.trim().toLowerCase():'';
const currentCage=record=>!archived(record)&&['active','occupied'].includes(state(record));
const keys={cages:'cage_sid',locations:'location_id',racks:'rack_id',rooms:'room_id'};
const topologyFields={cages:['room_id','rack_id','location_id','cage_type'],locations:['room_id','rack_id','locobox_id','record_origin','source_current','source_snapshot_date','source_last_seen_at','source_file_id','source_historical','history_read_only','source_label_conflict','source_import_conflict','source_cell','source_block_text','source_observed_tags'],racks:['room_id'],rooms:[]};
const sourcePosition=record=>record.evidence_status==='source_position_unlinked'||record.record_origin==='source_layout'||['source_block_text','source_title','source_cell'].some(key=>id(record[key]))||Object.keys(record).some(key=>key.startsWith('source_observed_')||key.startsWith('source_candidate_'));
const temporary=record=>/^temporary[ _-]+storage$/i.test(id(record?.cage_type));
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const localDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const canonicalTag=value=>id(value).replace(/[‘’′]/g,"'").replace(/\s+/g,'');
function sourceUnit(group,assignment,cageId=null) {
  const mode=group?._mode,boxId=mode==='box_id'?id(assignment.location?.locobox_id):'';
  if(mode==='box_id')return boxId?JSON.stringify([assignment.roomId,'box',boxId]):null;
  if(mode==='cage'&&cageId)return JSON.stringify([assignment.roomId,'cage',cageId]);
  return assignment.locationId?JSON.stringify([assignment.roomId,'position',assignment.locationId]):null;
}
function sourceChangeBlocks(position,events,asOf) {
  const seenAt=Date.parse(position.source_last_seen_at),changes=[];
  for(const event of events) {
    const change=event.animal_sheet_change;
    if(archived(event)||event.event_type!=='animal_sheet_source_change'||change?.schema_version!==1||change.entity_type!=='locations'||id(change.entity_id)!==id(position.location_id))continue;
    if(position.source_file_id&&event.source_file_id!==position.source_file_id)continue;
    const date=validDate(change.observation_date)?change.observation_date:event.event_date;
    if(!validDate(date)||date>asOf||date<position.source_snapshot_date)continue;
    const capture=Date.parse(event.source_capture_at);
    if(Number.isFinite(seenAt)&&Number.isFinite(capture)&&capture<seenAt)continue;
    if(!['added','updated','conflict','withdrawn'].includes(change.action))continue;
    changes.push({date,capture:Number.isFinite(capture)?capture:0,blocked:['conflict','withdrawn'].includes(change.action)});
  }
  // A tied unresolved observation wins; a later successful import can clear it.
  changes.sort((a,b)=>b.date.localeCompare(a.date)||b.capture-a.capture||Number(b.blocked)-Number(a.blocked));
  return changes[0]?.blocked===true;
}
function sourceAnimals(position,asOf) {
  if(position.record_origin!=='current_google_sheet_map'||position.source_current!==true||position.source_historical||position.history_read_only||position.source_label_conflict||position.source_import_conflict||!validDate(position.source_snapshot_date)||position.source_snapshot_date>asOf)return [];
  if(typeof position.source_block_text==='string'&&position.source_cell)return classifyAnimalSheetBreedingBlock(position).evidence;
  // Restricted views retain sanitized labels but omit the raw source block.
  // A genotype or arbitrary note alone never establishes an occupied position.
  return (Array.isArray(position.source_observed_tags)?position.source_observed_tags:[]).flatMap(tag=>typeof tag==='string'?classifyAnimalSheetBreedingBlock({source_cell:'A1',source_block_text:`A2: ${tag.replace(/[\r\n]/g,' ')}`}).evidence:[]);
}

/** Recorded housing plus separately identified current Animal Sheet estimates.
 * Source labels establish estimated box use, never mouse identity/assignment. */
export function summarizeCages(dataset,{asOf=localDate()}={}) {
  if(!validDate(asOf))throw new TypeError('Cage counts need a valid YYYY-MM-DD date.');
  const tables=dataset?.tables||{},options=getCageSummaryOptions(dataset),invalidOptions=getCageSummaryOptionsStatus(dataset)==='invalid',issues=new Set(),indexes={};
  const note=message=>issues.add(message);
  for(const [type,key]of Object.entries(keys)) {
    const grouped=new Map();
    for(const record of list(tables[type])) {
      const recordId=id(record[key]);if(!recordId)continue;
      if(!grouped.has(recordId))grouped.set(recordId,[]);
      grouped.get(recordId).push(record);
    }
    indexes[type]=new Map([...grouped].map(([recordId,records])=>{
      const signatures=new Set(records.map(record=>JSON.stringify([archived(record),...topologyFields[type].map(field=>record[field]??null)])));
      return [recordId,{record:records[0],records,ambiguous:signatures.size>1}];
    }));
  }
  function lookup(type,recordId,owner) {
    const entry=indexes[type].get(recordId),singular={cages:'cage',locations:'position',racks:'rack',rooms:'room'}[type];
    if(!entry){note(`${owner}: a referenced ${singular} is missing.`);return null;}
    if(entry.ambiguous){note(`${owner}: a referenced ${singular} has conflicting records.`);return null;}
    if(archived(entry.record)){note(`${owner}: a referenced ${singular} is archived.`);return null;}
    return entry.record;
  }
  function resolve(record,owner,{position=false}={}) {
    const locationId=id(record.location_id);
    const location=position?record:locationId?lookup('locations',locationId,owner):null;
    if(locationId&&!location)return null;
    const rackIds=[...new Set([id(record.rack_id),id(location?.rack_id)].filter(Boolean))];
    if(rackIds.length>1){note(`${owner}: cage and position rack references disagree.`);return null;}
    const rack=rackIds.length?lookup('racks',rackIds[0],owner):null;
    if(rackIds.length&&!rack)return null;
    const roomIds=[...new Set([id(record.room_id),id(location?.room_id),id(rack?.room_id)].filter(Boolean))];
    if(roomIds.length>1){note(`${owner}: room references disagree.`);return null;}
    if(!roomIds.length){note(`${owner}: no current room is assigned.`);return null;}
    const room=lookup('rooms',roomIds[0],owner);if(!room)return null;
    return {roomId:roomIds[0],locationId,location};
  }

  const livingById=new Map();let anonymous=0;
  for(const mouse of list(tables.mice)) {
    if(archived(mouse)||state(mouse)!=='stock')continue;
    const mouseId=id(mouse.mouse_sid)||`anonymous:${++anonymous}`;
    if(!livingById.has(mouseId))livingById.set(mouseId,[]);
    livingById.get(mouseId).push(mouse);
  }
  const occupied=new Set();let unassignedMice=0;
  for(const records of livingById.values()) {
    const cageIds=new Set(records.map(record=>id(record.cage_sid)));
    if(cageIds.size!==1||cageIds.has('')) {
      unassignedMice++;
      if(cageIds.size>1)note('A current mouse has conflicting cage references.');
      continue;
    }
    occupied.add([...cageIds][0]);
  }
  const registered=new Set([...indexes.cages].filter(([,entry])=>entry.records.some(currentCage)).map(([cageId])=>cageId));
  const current=new Set([...registered,...occupied]);
  const groups={};
  for(const name of ['beh','rat','clean','spf']) {
    const setting=options.groups[name],roomIds=[...new Set(setting.room_ids.map(id).filter(Boolean))],validRooms=new Set();
    // Inferred defaults are suggestions, not a replacement for an invalid saved mapping.
    if(!invalidOptions)for(const roomId of roomIds)if(lookup('rooms',roomId,`${name} options`))validRooms.add(roomId);
    groups[name]={
      used:0,capacity:setting.capacity,mappedPositions:0,unlocatedCages:0,unlinkedPositions:0,estimatedUsed:0,sourceDates:[],temporaryStorageExcluded:0,
      unitUnknown:['beh','rat'].includes(name)&&!['cage','position','box_id'].includes(setting.locobox_mode),
      configured:!invalidOptions&&roomIds.length>0&&validRooms.size===roomIds.length,
      roomMappingUnknown:invalidOptions||roomIds.length===0||validRooms.size!==roomIds.length,
      overCapacity:false,
      _rooms:validRooms,_used:new Set(),_estimated:new Set(),_dates:new Set(),_excluded:new Set(),_blockedSourceUnits:new Set(),_mode:setting.locobox_mode,
    };
  }

  const excludedPositions=new Set(options.groups.beh.temporary_storage_location_ids||[]);
  const linkedPositions=new Set(),blockedSourcePositions=new Set(),registeredAssignments=new Map();let unassignedCages=0;
  // Even an unresolved current cage reference prevents its source position
  // from being counted again as a separate estimated cage.
  for(const cageId of current)for(const cage of indexes.cages.get(cageId)?.records||[])if(id(cage.location_id))blockedSourcePositions.add(id(cage.location_id));
  for(const cageId of current) {
    const cage=lookup('cages',cageId,'Cage assignment'),assignment=cage?resolve(cage,'Cage assignment'):null;
    if(assignment?.locationId)linkedPositions.add(assignment.locationId);
    if(assignment)for(const group of Object.values(groups))if(group._rooms.has(assignment.roomId)){
      const key=sourceUnit(group,assignment);if(key)group._blockedSourceUnits.add(key);
    }
    if(!occupied.has(cageId))continue;
    if(!assignment){unassignedCages++;continue;}
    registeredAssignments.set(cageId,assignment);
    for(const [name,group]of Object.entries(groups)) {
      if(!group._rooms.has(assignment.roomId))continue;
      if(name==='clean'||name==='spf'){group._used.add(cageId);continue;}
      if(name==='beh'&&(temporary(cage)||excludedPositions.has(assignment.locationId))){group._excluded.add(assignment.locationId||'cage:'+cageId);continue;}
      const key=sourceUnit(group,assignment,cageId);
      if(!key) {
        if(!group.unitUnknown||!assignment.locationId)group.unlocatedCages++;
        continue;
      }
      // Box identifiers may repeat between rooms but refer to different physical boxes.
      group._used.add(key);
    }
  }
  const registeredTags=new Map();
  for(const records of livingById.values())for(const mouse of records){
    const cageId=id(mouse.cage_sid),tag=canonicalTag(mouse.physical_tag);
    if(!tag||!registeredAssignments.has(cageId))continue;
    const cages=registeredTags.get(tag)||new Set();cages.add(cageId);registeredTags.set(tag,cages);
  }
  const sourceEvidence=new Map(),tagUnits=new Map(),historyBlocked=new Set(),sourceChanges=new Map();
  for(const event of list(tables.husbandry_events)){
    const change=event.animal_sheet_change;
    if(archived(event)||event.event_type!=='animal_sheet_source_change'||change?.entity_type!=='locations')continue;
    const positionId=id(change.entity_id),events=sourceChanges.get(positionId)||[];events.push(event);sourceChanges.set(positionId,events);
  }
  for(const [positionId,entry]of indexes.locations){
    if(entry.ambiguous||archived(entry.record))continue;
    if(sourceChangeBlocks(entry.record,sourceChanges.get(positionId)||[],asOf)){historyBlocked.add(positionId);continue;}
    const animals=sourceAnimals(entry.record,asOf);sourceEvidence.set(positionId,animals);
    if(!animals.length)continue;
    const assignment=resolve(entry.record,'Source position',{position:true});if(!assignment)continue;
    const group=Object.values(groups).find(g=>g._rooms.has(assignment.roomId)),key=sourceUnit(group,assignment)||JSON.stringify([assignment.roomId,'position',positionId]);
    for(const animal of animals){const units=tagUnits.get(animal.canonical_tag)||new Set();units.add(key);tagUnits.set(animal.canonical_tag,units);}
  }
  for(const [positionId]of indexes.locations) {
    if(indexes.locations.get(positionId).records.every(archived))continue;
    const position=lookup('locations',positionId,'Position');
    if(!position)continue;
    const assignment=resolve(position,'Position',{position:true});if(!assignment)continue;
    for(const [name,group]of Object.entries(groups))if(group._rooms.has(assignment.roomId)) {
      group.mappedPositions++;
      if(name==='beh'&&excludedPositions.has(positionId)){if(sourceEvidence.get(positionId)?.length)group._excluded.add(positionId);continue;}
      if(sourcePosition(position)&&!linkedPositions.has(positionId)){
        const animals=sourceEvidence.get(positionId)||[],duplicate=animals.some(animal=>tagUnits.get(animal.canonical_tag)?.size>1),key=sourceUnit(group,assignment);
        const registeredOverlap=animals.some(animal=>[...(registeredTags.get(animal.canonical_tag)||[])].some(cageId=>sourceUnit(group,registeredAssignments.get(cageId),cageId)!==key));
        if(animals.length&&key&&group._used.has(key)&&!duplicate&&!registeredOverlap&&!historyBlocked.has(positionId))continue;
        const eligible=['beh','rat'].includes(name)&&animals.length&&!duplicate&&!registeredOverlap&&!blockedSourcePositions.has(positionId)&&!group._blockedSourceUnits.has(key)&&!group.unitUnknown;
        if(eligible&&key){group._estimated.add(key);group._dates.add(position.source_snapshot_date);}
        else group.unlinkedPositions++;
        if(duplicate)note('An animal tag appears at multiple current Animal Sheet positions; those source estimates need review.');
        if(registeredOverlap)note('A current Animal Sheet animal tag overlaps a registered occupied cage; that source estimate needs review.');
        if(historyBlocked.has(positionId))note('A newer Animal Sheet conflict or withdrawal prevents a current source estimate.');
      }
    }
  }
  for(const group of Object.values(groups)) {
    group.estimatedUsed=[...group._estimated].filter(key=>!group._used.has(key)).length;
    group.used=group._used.size+group.estimatedUsed;
    group.sourceDates=[...group._dates].sort();group.temporaryStorageExcluded=group._excluded.size;
    group.overCapacity=group.capacity!==null&&group.used>group.capacity;
    for(const key of ['_rooms','_used','_mode','_estimated','_dates','_excluded','_blockedSourceUnits'])delete group[key];
  }
  return {cages:{used:occupied.size,total:current.size},groups,unassignedMice,unassignedCages,issues:[...issues]};
}
