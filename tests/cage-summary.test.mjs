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

test('default cage-based box counting leaves absent room mappings and physical capacity unknown',()=>{
  const data=fixture();data.tables.locations.push({location_id:'P1',room_id:'BEH'});occupy(data,{cage_sid:'A',location_id:'P1'});
  const result=summarizeCages(data);
  assert.equal(result.groups.beh.used,1);assert.equal(result.groups.beh.unitUnknown,false);assert.equal(result.groups.beh.capacity,null);assert.equal(result.groups.beh.mappedPositions,1);
  data.tables.rooms.find(room=>room.room_id==='CLEAN').name='Conventional Mouse Room #2';
  const renamed=summarizeCages(data);assert.equal(renamed.groups.clean.configured,false);assert.equal(renamed.groups.clean.roomMappingUnknown,true);
});

const asOf='2026-10-15';
const source=(location_id='SRC1',extra={})=>({location_id,room_id:'BEH',label:location_id,source_cell:'A7',source_file_id:'SYNTHETIC_WORKBOOK',record_origin:'current_google_sheet_map',source_current:true,source_snapshot_date:asOf,source_last_seen_at:asOf+'T00:00:00Z',source_block_text:"A7: L1\nA8: PB'-M101",source_observed_tags:["PB'-M101"],evidence_status:'source_position_unlinked',...extra});
const summarize=data=>summarizeCages(data,{asOf});
const sourceChange=(location,action,extra={})=>({event_id:'CHANGE-'+action,event_type:'animal_sheet_source_change',event_date:asOf,source_file_id:location.source_file_id,source_capture_at:asOf+'T01:00:00Z',animal_sheet_change:{schema_version:1,entity_type:'locations',entity_id:location.location_id,action,observation_date:asOf},...extra});

test('defaults and saved legacy unknown count occupied room cages, except Ani Beh temporary storage',()=>{
  const data=fixture();data.tables.rooms[0].name='Ani Beh';
  occupy(data,{cage_sid:'BEH-BOX',room_id:'BEH'});occupy(data,{cage_sid:'BEH-TEMP',room_id:'BEH',cage_type:'Temporary storage'});
  occupy(data,{cage_sid:'RAT-BOX',room_id:'RAT'});occupy(data,{cage_sid:'RAT-TEMP',room_id:'RAT',cage_type:'Temporary storage'});
  for(const d of [data,configured(data,{beh:{locobox_mode:'unknown'},rat:{locobox_mode:'unknown'}})]){
    const r=summarize(d);assert.equal(r.groups.beh.used,1);assert.equal(r.groups.rat.used,2);assert.equal(r.groups.beh.temporaryStorageExcluded,1);assert.equal(r.groups.rat.temporaryStorageExcluded,0);
    assert.equal(r.groups.beh.unlocatedCages,0);assert.equal(r.groups.rat.unitUnknown,false);assert.equal(r.cages.used,4);
  }
  assert.equal(summarize(data).groups.beh.capacity,null);
  data.tables.cages.find(c=>c.cage_sid==='BEH-TEMP').room_id='RAT';
  assert.equal(summarize(data).groups.rat.used,3);
});

test('conflicting duplicate temporary types or source eligibility cannot select an arbitrary row',()=>{
  const data=fixture();occupy(data,{cage_sid:'BOX',room_id:'BEH'});data.tables.cages.push({...data.tables.cages[0],cage_type:'Temporary storage'});
  const r=summarize(data);assert.equal(r.groups.beh.used,0);assert.equal(r.unassignedCages,1);
  for(const conflict of [{source_current:false},{source_snapshot_date:'2026-10-14'},{source_observed_tags:['WT-F55']},{source_label_conflict:true}]){
    const d=fixture();d.tables.locations=[source(),source('SRC1',conflict)];const s=summarize(d);assert.equal(s.groups.beh.estimatedUsed,0);assert(s.issues.some(x=>/conflicting records/.test(x)));
  }
});

test('current source-only animal columns estimate box use without creating registered cages or animals',()=>{
  const data=fixture();data.tables.locations=[source(),source('SRC2',{room_id:'RAT',source_block_text:'A7: B1\nA8: WT-F102'})];const before=structuredClone(data),r=summarize(data);
  assert.equal(r.groups.beh.used,1);assert.equal(r.groups.beh.estimatedUsed,1);assert.equal(r.groups.rat.estimatedUsed,1);assert.deepEqual(r.groups.beh.sourceDates,[asOf]);assert.deepEqual(r.cages,{used:0,total:0});assert.deepEqual(data,before);
});

test('source estimates require current dated evidence and never infer occupancy from history, genotypes or side notes',()=>{
  const invalid=[{source_current:false},{source_current:undefined},{record_origin:'historical_snapshot_projection'},{source_historical:true},{history_read_only:true},{source_label_conflict:true},{source_import_conflict:'review'},{source_snapshot_date:'2026-02-30'},{source_snapshot_date:'2026-10-16'},{app_archived_at:asOf},
    {source_block_text:'A7: L1\nA8: P\nA9: F\nA10: LP1\nB8: PB\'-M101'},{source_block_text:"A7: L1\nA8: PB'-M101\nA8 comment: died"}];
  for(const extra of invalid){const data=fixture();data.tables.locations=[source('SRC1',extra)];assert.equal(summarize(data).groups.beh.estimatedUsed,0,JSON.stringify(extra));}
  const data=fixture();data.tables.locations=[source('SRC1',{source_snapshot_date:'2026-09-01'})];assert.equal(summarize(data).groups.beh.estimatedUsed,1,'an unchanged current source retains its original capture date');
  data.tables.locations=[];data.tables.husbandry_events=[{event_type:'animal_sheet_cage_snapshot',source_cage_snapshot:{snapshot_date:asOf,block_text:"A8: PB'-M101"}}];assert.equal(summarize(data).groups.beh.used,0);
  for(const value of ['2026-02-30',null,1])assert.throws(()=>summarizeCages(data,{asOf:value}),/valid YYYY-MM-DD/);
});

test('sanitized source-tag fallback accepts numbered animal tags but not genotype-only labels or injected notes',()=>{
  const data=fixture();data.tables.locations=[source('SRC1',{source_cell:undefined,source_block_text:undefined,source_observed_tags:["PB'-M101","PB'-M101"]})];assert.equal(summarize(data).groups.beh.estimatedUsed,1);
  for(const tags of [['P',"B'",'LD','L0R1','Sample from M5'],['P-M101\nA3: sample'],['P-M101 died']]){
    data.tables.locations[0].source_observed_tags=tags;assert.equal(summarize(data).groups.beh.estimatedUsed,0);
  }
});

test('source tags repeated within one explicit box count once, but repeated across physical boxes remain unresolved',()=>{
  const data=fixture();data.tables.locations=[source('SRC1',{locobox_id:'BOX-A'}),source('SRC2',{locobox_id:'BOX-A'})];
  let configuredData=configured(data,{beh:{locobox_mode:'box_id'}}),r=summarize(configuredData);assert.equal(r.groups.beh.used,1);assert.equal(r.groups.beh.estimatedUsed,1);assert.equal(r.groups.beh.unlinkedPositions,0);assert.equal(r.issues.length,0);
  configuredData.tables.locations[1].locobox_id='BOX-B';r=summarize(configuredData);assert.equal(r.groups.beh.used,0);assert.equal(r.groups.beh.unlinkedPositions,2);assert(r.issues.some(x=>/multiple current Animal Sheet/.test(x)));
  configuredData.tables.locations[1].room_id='RAT';configuredData.tables.locations[1].locobox_id='BOX-A';r=summarize(configuredData);assert.equal(r.groups.beh.used,0);assert.equal(r.groups.rat.used,0,'box IDs do not merge rooms');
});

test('a registered occupied cage prevents duplicate source use by physical position, box and animal tag',()=>{
  const data=fixture();data.tables.locations=[source('SRC1',{locobox_id:'BOX-A'}),source('SRC2',{locobox_id:'BOX-A'})];occupy(data,{cage_sid:'LIVE',location_id:'SRC1'},{physical_tag:"PB′-M101"});
  const d=configured(data,{beh:{locobox_mode:'box_id'}}),r=summarize(d);assert.equal(r.groups.beh.used,1);assert.equal(r.groups.beh.estimatedUsed,0);assert.equal(r.groups.beh.unlinkedPositions,0);
  const elsewhere=fixture();elsewhere.tables.locations=[source()];occupy(elsewhere,{cage_sid:'LIVE',room_id:'CLEAN'},{physical_tag:"PB′-M101"});
  const e=summarize(elsewhere);assert.equal(e.groups.clean.used,1);assert.equal(e.groups.beh.estimatedUsed,0);assert.equal(e.groups.beh.unlinkedPositions,1);assert(e.issues.some(x=>/overlaps a registered/.test(x)));
  elsewhere.tables.mice[0].state='Ended';assert.equal(summarize(elsewhere).groups.beh.estimatedUsed,1,'an ended mouse does not establish current registered occupancy');
});

test('linked empty cages and temporary storage cannot be revived by source-only tags',()=>{
  for(const cage of [{cage_sid:'EMPTY',state:'Active'},{cage_sid:'TEMP',state:'Active',cage_type:'Temporary storage'}]){
    const data=fixture();data.tables.locations=[source('SRC1',{locobox_id:'BOX-A'}),source('SRC2',{locobox_id:'BOX-A'})];data.tables.cages=[{...cage,location_id:'SRC1'}];
    const r=summarize(configured(data,{beh:{locobox_mode:'box_id'}}));assert.equal(r.groups.beh.used,0);assert.equal(r.groups.beh.estimatedUsed,0);
  }
  const data=fixture();data.tables.locations=[source()];const d=configured(data,{beh:{locobox_mode:'cage',temporary_storage_location_ids:['SRC1']}});const r=summarize(d);assert.equal(r.groups.beh.used,0);assert.equal(r.groups.beh.temporaryStorageExcluded,1);assert.equal(r.groups.beh.unlinkedPositions,0);
});

test('newer unresolved source changes block stale estimates while older, future and other-workbook changes do not',()=>{
  for(const action of ['conflict','withdrawn']){
    const data=fixture();const pos=source();data.tables.locations=[pos];data.tables.husbandry_events=[sourceChange(pos,action)];let r=summarize(data);assert.equal(r.groups.beh.estimatedUsed,0);assert(r.issues.some(x=>/conflict or withdrawal/.test(x)));
    data.tables.husbandry_events.push(sourceChange(pos,'updated',{source_capture_at:asOf+'T02:00:00Z'}));assert.equal(summarize(data).groups.beh.estimatedUsed,1);
  }
  for(const extra of [{source_capture_at:'2026-10-14T01:00:00Z'},{source_file_id:'OTHER_WORKBOOK'},{app_archived_at:asOf},{animal_sheet_change:{schema_version:1,entity_type:'locations',entity_id:'SRC1',action:'conflict',observation_date:'2026-10-16'}}]){
    const data=fixture();const pos=source();data.tables.locations=[pos];data.tables.husbandry_events=[sourceChange(pos,'conflict',extra)];assert.equal(summarize(data).groups.beh.estimatedUsed,1,JSON.stringify(extra));
  }
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
