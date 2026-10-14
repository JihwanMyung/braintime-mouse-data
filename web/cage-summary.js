import { getCageSummaryOptions, getCageSummaryOptionsStatus } from './cage-summary-options.js?v=24';

const list=value=>Array.isArray(value)?value.filter(record=>record&&typeof record==='object'&&!Array.isArray(record)):[];
const id=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const state=record=>typeof record?.state==='string'?record.state.trim().toLowerCase():'';
const currentCage=record=>!archived(record)&&['active','occupied'].includes(state(record));
const keys={cages:'cage_sid',locations:'location_id',racks:'rack_id',rooms:'room_id'};
const topologyFields={cages:['room_id','rack_id','location_id'],locations:['room_id','rack_id','locobox_id'],racks:['room_id'],rooms:[]};
const sourcePosition=record=>record.evidence_status==='source_position_unlinked'||record.record_origin==='source_layout'||['source_block_text','source_title','source_cell'].some(key=>id(record[key]))||Object.keys(record).some(key=>key.startsWith('source_observed_')||key.startsWith('source_candidate_'));

/** Count current, explicit housing assignments, never historical Animal Sheet observations. */
export function summarizeCages(dataset) {
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
      const signatures=new Set(records.map(record=>JSON.stringify([archived(record),...topologyFields[type].map(field=>id(record[field]))])));
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
      used:0,capacity:setting.capacity,mappedPositions:0,unlocatedCages:0,unlinkedPositions:0,
      unitUnknown:['beh','rat'].includes(name)&&!['position','box_id'].includes(setting.locobox_mode),
      configured:!invalidOptions&&roomIds.length>0&&validRooms.size===roomIds.length,
      roomMappingUnknown:invalidOptions||roomIds.length===0||validRooms.size!==roomIds.length,
      overCapacity:false,
      _rooms:validRooms,_used:new Set(),_mode:setting.locobox_mode,
    };
  }

  const linkedPositions=new Set();let unassignedCages=0;
  for(const cageId of current) {
    const cage=lookup('cages',cageId,'Cage assignment'),assignment=cage?resolve(cage,'Cage assignment'):null;
    if(assignment?.locationId)linkedPositions.add(assignment.locationId);
    if(!occupied.has(cageId))continue;
    if(!assignment){unassignedCages++;continue;}
    for(const [name,group]of Object.entries(groups)) {
      if(!group._rooms.has(assignment.roomId))continue;
      if(name==='clean'||name==='spf'){group._used.add(cageId);continue;}
      const boxId=group._mode==='position'?assignment.locationId:group._mode==='box_id'?id(assignment.location?.locobox_id):'';
      if(!boxId) {
        if(!group.unitUnknown||!assignment.locationId)group.unlocatedCages++;
        continue;
      }
      // Box identifiers may repeat between rooms but refer to different physical boxes.
      group._used.add(JSON.stringify([assignment.roomId,boxId]));
    }
  }
  for(const [positionId]of indexes.locations) {
    if(indexes.locations.get(positionId).records.every(archived))continue;
    const position=lookup('locations',positionId,'Position');
    if(!position)continue;
    const assignment=resolve(position,'Position',{position:true});if(!assignment)continue;
    for(const group of Object.values(groups))if(group._rooms.has(assignment.roomId)) {
      group.mappedPositions++;
      if(sourcePosition(position)&&!linkedPositions.has(positionId))group.unlinkedPositions++;
    }
  }
  for(const group of Object.values(groups)) {
    group.used=group._used.size;
    group.overCapacity=group.capacity!==null&&group.used>group.capacity;
    delete group._rooms;delete group._used;delete group._mode;
  }
  return {cages:{used:occupied.size,total:current.size},groups,unassignedMice,unassignedCages,issues:[...issues]};
}
