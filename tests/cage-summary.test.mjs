import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCages } from '../web/cage-summary.js';
import { buildCageSummaryOptions } from '../web/cage-summary-options.js';

const fixture=()=>({tables:{
  mice:[],cages:[],locations:[],racks:[],husbandry_events:[],
  rooms:[{room_id:'BEH',name:'SH Animal Beh'},{room_id:'RAT',name:'Rat Room (Locoboxes)'},{room_id:'CLEAN',name:'Clean room'},{room_id:'SPF',name:'SPF Room 6'}],
}});
function configured(data,changes={}) {
  const groups=Object.fromEntries(['beh','rat','clean','spf'].map(key=>[key,{room_ids:[key.toUpperCase()],capacity:10,...(['beh','rat'].includes(key)?{locobox_mode:'position'}:{}),...changes[key]}]));
  return buildCageSummaryOptions(data,{schema_version:1,groups},{now:'2026-10-14T00:00:00Z'}).dataset;
}
function occupy(data,cage,mouse={}) {
  data.tables.cages.push({state:'Active',...cage});
  data.tables.mice.push({mouse_sid:`M-${data.tables.mice.length}`,state:'Stock',cage_sid:cage.cage_sid,...mouse});
}

test('current cage total is active or occupied IDs, never the historical cage archive',()=>{
  const data=fixture();
  occupy(data,{cage_sid:'A',room_id:'CLEAN'});
  occupy(data,{cage_sid:'B',room_id:'CLEAN',state:'Inactive'});
  occupy(data,{cage_sid:'C',room_id:'CLEAN',archived:true});
  data.tables.mice.push({mouse_sid:'M-missing',state:'Stock',cage_sid:'MISSING'});
  data.tables.cages.push({cage_sid:'EMPTY',state:'Occupied',room_id:'CLEAN'},{cage_sid:'OLD',state:'Inactive'},{cage_sid:'ARCHIVED',state:'Active',app_archived_at:'2026-01-01'},{cage_sid:'UNKNOWN'});
  const result=summarizeCages(configured(data));
  assert.deepEqual(result.cages,{used:4,total:5});
  assert.equal(result.groups.clean.used,2);
  assert.equal(result.unassignedCages,2);
  assert.ok(result.issues.some(value=>value.includes('archived')));
  assert.ok(result.issues.some(value=>value.includes('missing')));
});

test('occupied cage IDs deduplicate mice and cage rows and ignore ended or archived mice',()=>{
  const data=fixture();occupy(data,{cage_sid:'A',room_id:'SPF'});
  data.tables.mice.push({...data.tables.mice[0]},{mouse_sid:'M2',cage_sid:'A',state:'Stock'},{mouse_sid:'M3',cage_sid:'Z',state:'Ended'},{mouse_sid:'M4',cage_sid:'Y',state:'Stock',archived:true},{mouse_sid:'M5',cage_sid:'X',state:'Stock',app_archived_at:'2026-01-01'});
  data.tables.cages.push({...data.tables.cages[0]});
  const result=summarizeCages(configured(data));
  assert.deepEqual(result.cages,{used:1,total:1});assert.equal(result.groups.spf.used,1);
});

test('missing mouse cage IDs and conflicting duplicate mouse assignments remain unknown',()=>{
  const data=fixture();
  data.tables.mice.push({mouse_sid:'M1',state:'Stock'},{mouse_sid:'M1',state:'Stock'},{mouse_sid:'M2',state:'Stock',cage_sid:'   '},{mouse_sid:'M3',state:'Stock',cage_sid:'A'},{mouse_sid:'M3',state:'Stock',cage_sid:'B'});
  const result=summarizeCages(configured(data));
  assert.deepEqual(result.cages,{used:0,total:0});assert.equal(result.unassignedMice,3);assert.equal(result.unassignedCages,0);
  assert.ok(result.issues.includes('A current mouse has conflicting cage references.'));
});

test('room assignments follow explicit cage, position and rack references consistently',()=>{
  const data=fixture();data.tables.racks.push({rack_id:'RK',room_id:'CLEAN'});
  data.tables.locations.push({location_id:'P1',rack_id:'RK'},{location_id:'P2',room_id:'CLEAN'},{location_id:'P3',room_id:'CLEAN',rack_id:'RK'});
  occupy(data,{cage_sid:'A',location_id:'P1'});occupy(data,{cage_sid:'B',location_id:'P2'});occupy(data,{cage_sid:'C',rack_id:'RK'});occupy(data,{cage_sid:'D',room_id:'CLEAN',rack_id:'RK',location_id:'P3'});
  const result=summarizeCages(configured(data));
  assert.equal(result.groups.clean.used,4);assert.equal(result.groups.clean.mappedPositions,3);assert.equal(result.unassignedCages,0);
});

test('disagreeing room or rack paths and missing referenced parents never silently select a room',()=>{
  const data=fixture();data.tables.racks.push({rack_id:'RK',room_id:'SPF'},{rack_id:'RK2',room_id:'SPF'});
  data.tables.locations.push({location_id:'P1',room_id:'CLEAN',rack_id:'RK'},{location_id:'P2',room_id:'SPF',rack_id:'RK'},{location_id:'P3',room_id:'SPF',rack_id:'MISSING'});
  occupy(data,{cage_sid:'A',location_id:'P1'});occupy(data,{cage_sid:'B',room_id:'CLEAN',location_id:'P2'});occupy(data,{cage_sid:'C',room_id:'SPF',location_id:'MISSING'});occupy(data,{cage_sid:'D',location_id:'P2',rack_id:'RK2'});occupy(data,{cage_sid:'E',location_id:'P3'});occupy(data,{cage_sid:'F',room_id:'SPF',rack_id:'MISSING'});
  const result=summarizeCages(configured(data));
  assert.equal(result.groups.clean.used,0);assert.equal(result.groups.spf.used,0);assert.equal(result.unassignedCages,6);
});

test('archived and conflicting position ancestry is excluded without changing occupied cage count',()=>{
  const data=fixture();data.tables.racks.push({rack_id:'ARCH',room_id:'BEH',archived:true},{rack_id:'CONFLICT',room_id:'BEH'},{rack_id:'CONFLICT',room_id:'RAT'});
  data.tables.locations.push({location_id:'P1',room_id:'BEH',app_archived_at:'2026-01-01'},{location_id:'P2',rack_id:'ARCH'},{location_id:'P3',rack_id:'CONFLICT'},{location_id:'P4',room_id:'BEH'},{location_id:'P4',room_id:'RAT'});
  for(const location_id of ['P1','P2','P3','P4'])occupy(data,{cage_sid:location_id,location_id});
  const result=summarizeCages(configured(data));
  assert.deepEqual(result.cages,{used:4,total:4});assert.equal(result.groups.beh.used,0);assert.equal(result.groups.beh.mappedPositions,0);assert.equal(result.unassignedCages,4);
});

test('a direct room cannot conceal conflicting duplicate cage records',()=>{
  const data=fixture();occupy(data,{cage_sid:'A',room_id:'CLEAN'});data.tables.cages.push({cage_sid:'A',state:'Active',room_id:'SPF'});
  const result=summarizeCages(configured(data));
  assert.deepEqual(result.cages,{used:1,total:1});assert.equal(result.unassignedCages,1);
});

test('locobox position mode counts physical position IDs, not repeated display labels or cage count',()=>{
  const data=fixture();data.tables.locations.push({location_id:'P1',room_id:'BEH',label:'A1'},{location_id:'P2',room_id:'BEH',label:'A1'});
  occupy(data,{cage_sid:'A',location_id:'P1'});occupy(data,{cage_sid:'B',location_id:'P1'});occupy(data,{cage_sid:'C',location_id:'P2'});occupy(data,{cage_sid:'D',room_id:'BEH'});
  const result=summarizeCages(configured(data));
  assert.equal(result.groups.beh.used,2);assert.equal(result.groups.beh.mappedPositions,2);assert.equal(result.groups.beh.unlocatedCages,1);assert.equal(result.unassignedCages,0);
});

test('locobox ID mode groups positions within rooms, while equal box IDs in separate rooms remain distinct',()=>{
  const data=fixture();data.tables.rooms.push({room_id:'BEH2',name:'Second behaviour room'});
  data.tables.locations.push({location_id:'P1',room_id:'BEH',locobox_id:'Box 1'},{location_id:'P2',room_id:'BEH',locobox_id:'Box 1'},{location_id:'P3',room_id:'BEH2',locobox_id:'Box 1'},{location_id:'P4',room_id:'BEH'});
  for(const location_id of ['P1','P2','P3','P4'])occupy(data,{cage_sid:location_id,location_id});
  const result=summarizeCages(configured(data,{beh:{room_ids:['BEH','BEH2'],locobox_mode:'box_id'}}));
  assert.equal(result.groups.beh.used,2);assert.equal(result.groups.beh.mappedPositions,4);assert.equal(result.groups.beh.unlocatedCages,1);
});

test('unknown box units and absent room mappings are explicit, never inferred physical capacity',()=>{
  const data=fixture();data.tables.locations.push({location_id:'P1',room_id:'BEH'});occupy(data,{cage_sid:'A',location_id:'P1'});
  const result=summarizeCages(data);
  assert.equal(result.groups.beh.used,0);assert.equal(result.groups.beh.unitUnknown,true);assert.equal(result.groups.beh.capacity,null);assert.equal(result.groups.beh.mappedPositions,1);
  data.tables.rooms.find(room=>room.room_id==='CLEAN').name='Conventional Mouse Room #2';
  const renamed=summarizeCages(data);assert.equal(renamed.groups.clean.configured,false);assert.equal(renamed.groups.clean.roomMappingUnknown,true);
});

test('configured zero and over-capacity usage are retained without truncation',()=>{
  const data=fixture();occupy(data,{cage_sid:'A',room_id:'SPF'});occupy(data,{cage_sid:'B',room_id:'SPF'});
  const result=summarizeCages(configured(data,{spf:{capacity:0},clean:{capacity:null}}));
  assert.equal(result.groups.spf.capacity,0);assert.equal(result.groups.spf.used,2);assert.equal(result.groups.spf.overCapacity,true);assert.equal(result.groups.clean.capacity,null);
});

test('historical observations and history events never establish current cage or room assignments',()=>{
  const data=fixture();data.tables.locations.push({location_id:'P1',room_id:'BEH',source_observed_mouse_sids:['M1'],source_observed_cage_sids:['A'],source_candidate_mouse_sids:['M1'],evidence_status:'source_position_unlinked'});
  data.tables.husbandry_events.push({event_id:'OLD',event_type:'cage_location_assignment',cage_sid:'A',room_id:'BEH',location_id:'P1'});
  occupy(data,{cage_sid:'A'},{mouse_sid:'M1'});
  const result=summarizeCages(configured(data));
  assert.equal(result.groups.beh.used,0);assert.equal(result.groups.beh.unlinkedPositions,1);assert.equal(result.groups.beh.mappedPositions,1);assert.equal(result.unassignedCages,1);
});

test('only source positions unlinked to a current eligible cage add source uncertainty',()=>{
  const data=fixture();
  data.tables.locations.push({location_id:'APP',room_id:'BEH',record_origin:'app_created'},{location_id:'LINKED',room_id:'BEH',evidence_status:'source_position_unlinked'},{location_id:'UNLINKED',room_id:'BEH',evidence_status:'source_position_unlinked'},{location_id:'INACTIVE',room_id:'BEH',evidence_status:'source_position_unlinked'});
  data.tables.cages.push({cage_sid:'EMPTY',state:'Active',location_id:'LINKED'},{cage_sid:'OLD',state:'Inactive',location_id:'INACTIVE'});
  const result=summarizeCages(configured(data));
  assert.equal(result.groups.beh.unlinkedPositions,2);assert.equal(result.groups.beh.used,0);assert.equal(result.groups.beh.mappedPositions,4);
});

test('legacy source layouts remain uncertain while app-created empty positions stay known empty',()=>{
  const data=fixture();
  const evidence=[{record_origin:'source_layout'},{source_block_text:'A1: historical mouse listing'},{source_title:'Synthetic historical map'},{source_cell:'A1'}];
  data.tables.locations.push(...evidence.map((fields,index)=>({location_id:`LEGACY-${index}`,room_id:'BEH',...fields})),{location_id:'APP',room_id:'BEH',record_origin:'app_created',notes:'Empty position'});
  const result=summarizeCages(configured(data));
  assert.equal(result.groups.beh.used,0);assert.equal(result.groups.beh.unlinkedPositions,4);assert.equal(result.groups.beh.mappedPositions,5);
  data.tables.locations=data.tables.locations.filter(position=>position.location_id==='APP');
  const appOnly=summarizeCages(configured(data));
  assert.equal(appOnly.groups.beh.used,0);assert.equal(appOnly.groups.beh.unlinkedPositions,0);assert.equal(appOnly.groups.beh.mappedPositions,1);
});

test('invalid saved room mapping produces explicit uncertainty instead of trusting fallback defaults',()=>{
  const data=configured(fixture());data.tables.rooms.find(room=>room.room_id==='BEH').archived=true;
  const result=summarizeCages(data);
  assert.equal(result.groups.beh.configured,false);assert.equal(result.groups.clean.roomMappingUnknown,true);assert.equal(result.groups.clean.capacity,null);
});

test('invalid saved options never reassign a summary to a different inferred room',()=>{
  const data=fixture();data.tables.rooms.push({room_id:'OTHER',name:'Reviewed clean facility'});
  for(let index=0;index<10;index++)occupy(data,{cage_sid:`C${index}`,room_id:'CLEAN'});
  data.tables.locations.push({location_id:'P-CLEAN',room_id:'CLEAN'});
  const saved=configured(data,{clean:{room_ids:['OTHER']}});
  saved.tables.rooms.find(room=>room.room_id==='BEH').archived=true;
  const result=summarizeCages(saved);
  assert.equal(result.cages.used,10);assert.equal(result.groups.clean.used,0);assert.equal(result.groups.clean.mappedPositions,0);
  assert.equal(result.groups.clean.configured,false);assert.equal(result.groups.clean.roomMappingUnknown,true);
});

test('empty data is safe; counts neither mutate records nor create source assignments',()=>{
  const empty=summarizeCages(null);assert.deepEqual(empty.cages,{used:0,total:0});assert.equal(empty.unassignedCages,0);assert.equal(empty.unassignedMice,0);
  const data=fixture();occupy(data,{cage_sid:' 42 ',room_id:'SPF'});data.tables.mice.push({mouse_sid:'M2',state:' Stock ',cage_sid:42});
  const before=structuredClone(data),result=summarizeCages(data);assert.deepEqual(data,before);assert.deepEqual(result.cages,{used:1,total:1});assert.equal(result.groups.spf.used,1);
});
