import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDataset,validateRecord,buildCageLocationEvent} from '../web/model.js';

const stamp='2026-10-14T12:00:00.000Z';
function fixture() {
  return normalizeDataset({tables:{
    rooms:[{room_id:'R1',name:'Animal room'},{room_id:'R2',name:'Second room'}],
    racks:[{rack_id:'K1',room_id:'R1',name:'Rack A'},{rack_id:'K2',room_id:'R1',name:'Rack B'},{rack_id:'K3',room_id:'R2',name:'Rack C'}],
    locations:[{location_id:'P1',room_id:'R1',rack_id:'K1',label:'A1',row:0,column:1},{location_id:'P2',room_id:'R1',rack_id:'K2',label:'B1',row:1,column:1},{location_id:'P3',room_id:'R2',rack_id:'K3',label:'C1'}],
    cages:[],mice:[],light_events:[],husbandry_events:[]
  }});
}
const record=(data,type,id)=>data.tables[type].find(row=>row[{rooms:'room_id',racks:'rack_id',locations:'location_id',cages:'cage_sid'}[type]]===id);
const errors=(data,type,id,patch)=>validateRecord(type,{...record(data,type,id),...patch},data,id).errors;
const cage=(extra={})=>({cage_sid:'C1',owner:'Keeper',state:'Active',location_id:'P1',...extra});
const appCreated=record=>({...record,record_origin:'app_created'});

test('new app rooms and racks need human names and new racks/positions need their parents',()=>{
  const d=fixture();
  for(const name of [null,'','  ',123])assert.match(validateRecord('rooms',appCreated({room_id:'NEW',name}),d).errors.join(' '),/human-readable name/);
  assert.match(validateRecord('racks',appCreated({rack_id:'NEW',name:'New rack'}),d).errors.join(' '),/Select a room/);
  assert.match(validateRecord('racks',appCreated({rack_id:'NEW',room_id:'R1'}),d).errors.join(' '),/human-readable name/);
  assert.match(validateRecord('locations',appCreated({location_id:'NEW',room_id:'R1'}),d).errors.join(' '),/Select a rack/);
  assert.match(validateRecord('locations',appCreated({location_id:'NEW',rack_id:'K1'}),d).errors.join(' '),/Select a room/);
  for(const [type,draft] of [['rooms',{room_id:'NEW',name:'New room'}],['racks',{rack_id:'NEW',room_id:'R1',name:'New rack'}],['locations',{location_id:'NEW',room_id:'R1',rack_id:'K1',row:0,column:0}]])assert.deepEqual(validateRecord(type,appCreated(draft),d).errors,[]);
});

test('historical missing names, ancestors and invalid coordinates survive unrelated edits with provenance intact',()=>{
  const d=fixture();
  d.tables.rooms.push({room_id:'OLD',source_record_id:'source:1'});
  d.tables.racks.push({rack_id:'OLD',room_id:'unknown',source_record_id:'source:2'});
  d.tables.locations.push({location_id:'OLD',row:-1.5,column:'source-value',source_record_id:'source:3'});
  const before=structuredClone(d);
  for(const type of ['rooms','racks','locations'])assert.deepEqual(errors(d,type,'OLD',{notes:'Reviewed without guessing'}),[]);
  assert.match(errors(d,'locations','OLD',{source_record_id:'different'}).join(' '),/provenance/);
  assert.deepEqual(d,before);
});

test('new or changed position coordinates must be nonnegative integers but blanks are allowed',()=>{
  const d=fixture();
  for(const bad of [-1,0.5,'2',Infinity,NaN,true])assert.match(errors(d,'locations','P1',{row:bad}).join(' '),/row must be a nonnegative whole number/);
  for(const good of [0,3,null,''])assert.deepEqual(errors(d,'locations','P1',{row:good}),[]);
  assert.match(validateRecord('locations',appCreated({location_id:'NEW',room_id:'R1',rack_id:'K1',column:-2}),d).errors.join(' '),/column must/);
});

test('new and changed housing rejects archived destinations and transitive ancestors',()=>{
  for(const type of ['rooms','racks','locations']){
    const d=fixture();record(d,type,{rooms:'R1',racks:'K1',locations:'P1'}[type]).app_archived_at=stamp;
    assert.match(validateRecord('cages',cage(),d).errors.join(' '),/archived/);
    d.tables.cages.push(cage({location_id:'P3'}));
    assert.match(errors(d,'cages','C1',{location_id:'P1'}).join(' '),/archived/);
  }
  const d=fixture();record(d,'rooms','R1').archived=true;
  assert.match(validateRecord('racks',appCreated({rack_id:'NEW',name:'Rack D',room_id:'R1'}),d).errors.join(' '),/archived/);
  assert.match(validateRecord('locations',appCreated({location_id:'NEW',room_id:'R1',rack_id:'K1'}),d).errors.join(' '),/archived/);
});

test('unchanged archived ancestry allows unrelated baseline edits and historical event recording',()=>{
  const d=fixture();record(d,'rooms','R1').app_archived_at=stamp;d.tables.cages.push(cage());
  assert.deepEqual(errors(d,'cages','C1',{comment:'Source remains unchanged'}),[]);
  assert.deepEqual(errors(d,'locations','P1',{notes:'Historical position note'}),[]);
  assert.deepEqual(validateRecord('light_events',{event_id:'E1',location_id:'P1',start_date:'2021-01-01',cycle_hours:23,light_hours:11},d).errors,[]);
  assert.deepEqual(validateRecord('husbandry_events',{event_id:'E2',location_id:'P1',event_date:'2021-01-01',event_type:'observation'},d).errors,[]);
});

test('new mouse assignments and restored cages reject archived hierarchy without blocking old residents',()=>{
  const d=fixture();record(d,'rooms','R1').app_archived_at=stamp;d.tables.cages.push(cage());
  const mouse={mouse_sid:'M1',sex:'Unknown',state:'Stock',cage_sid:'C1',owner:'Keeper'};
  assert.match(validateRecord('mice',mouse,d).errors.join(' '),/archived/);
  d.tables.mice.push(mouse);assert.deepEqual(validateRecord('mice',{...mouse,comment:'Source review'},d,'M1').errors,[]);
  d.tables.cages[0].app_archived_at=stamp;
  assert.match(errors(d,'cages','C1',{app_archived_at:null}).join(' '),/archived/);
});

test('reactivating a cage or mouse cannot bypass archived ancestry using unchanged housing links',()=>{
  const d=fixture();record(d,'rooms','R1').app_archived_at=stamp;d.tables.cages.push(cage({state:'Inactive'}));
  const mouse={mouse_sid:'M1',sex:'Unknown',state:'Ended',cage_sid:'C1',owner:'Keeper'};d.tables.mice.push(mouse);
  for(const state of ['Active','Occupied'])assert.match(errors(d,'cages','C1',{state}).join(' '),/archived/);
  assert.match(validateRecord('mice',{...mouse,state:'Stock'},d,'M1').errors.join(' '),/archived/);
  assert.deepEqual(errors(d,'cages','C1',{comment:'Unchanged history'}),[]);
  assert.deepEqual(validateRecord('mice',{...mouse,comment:'Unchanged history'},d,'M1').errors,[]);
});

test('archival blocks active children including indirect positions under an archived rack',()=>{
  const d=fixture();
  assert.match(errors(d,'rooms','R1',{app_archived_at:stamp}).join(' '),/active child/);
  assert.match(errors(d,'racks','K1',{app_archived_at:stamp}).join(' '),/active child/);
  d.tables.racks.filter(r=>r.room_id==='R1').forEach(r=>r.app_archived_at=stamp);
  delete record(d,'locations','P1').room_id;
  assert.match(errors(d,'rooms','R1',{app_archived_at:stamp}).join(' '),/active child/);
});

test('archival blocks Active/Occupied cages and Stock residents even when cage state is historical',()=>{
  for(const state of ['Active','Occupied'])for(const type of ['rooms','racks','locations']){
    const d=fixture();d.tables.racks.forEach(r=>r.app_archived_at=stamp);d.tables.locations.forEach(r=>r.app_archived_at=stamp);
    const id={rooms:'R1',racks:'K1',locations:'P1'}[type];delete record(d,type,id).app_archived_at;
    d.tables.cages.push(cage({state}));
    assert.match(errors(d,type,id,{app_archived_at:stamp}).join(' '),/active cages or Stock mice/);
  }
  const d=fixture();d.tables.cages.push(cage({state:'Inactive',app_archived_at:stamp}));
  d.tables.mice.push({mouse_sid:'M1',sex:'Unknown',state:'Stock',cage_sid:'C1'});
  assert.match(errors(d,'locations','P1',{app_archived_at:stamp}).join(' '),/Stock mice/);
});

test('historical inactive cages and archived or ended residents do not prevent archival',()=>{
  const d=fixture();d.tables.cages.push(cage({state:'Inactive'}));
  d.tables.mice.push({mouse_sid:'M1',sex:'Unknown',state:'Ended',cage_sid:'C1'},{mouse_sid:'M2',sex:'Unknown',state:'Stock',cage_sid:'C1',app_archived_at:stamp});
  assert.deepEqual(errors(d,'locations','P1',{app_archived_at:stamp}),[]);
  d.tables.locations.forEach(r=>r.app_archived_at=stamp);
  assert.deepEqual(errors(d,'racks','K1',{app_archived_at:stamp}),[]);
  d.tables.racks.forEach(r=>r.app_archived_at=stamp);
  assert.deepEqual(errors(d,'rooms','R1',{app_archived_at:stamp}),[]);
});

test('reparenting a rack or position is blocked by any cage including indirect archived records',()=>{
  const d=fixture();d.tables.cages.push(cage({state:'Inactive',app_archived_at:stamp}));
  assert.match(errors(d,'racks','K1',{room_id:'R2'}).join(' '),/referenced.*Create a new rack/);
  assert.match(errors(d,'locations','P1',{rack_id:'K2'}).join(' '),/referenced.*Create a new position/);
  assert.match(errors(d,'locations','P1',{rack_id:null,room_id:null}).join(' '),/referenced/);
});

test('dated references protect parentage of housing through current, old and broad event scopes',()=>{
  for(const table of ['light_events','husbandry_events'])for(const fields of [
    {location_id:'P1'},{old_location_id:'P1'},{rack_id:'K1'},{old_rack_id:'K1'},{room_id:'R1'},{old_room_id:'R1'}
  ]){
    const d=fixture();d.tables[table].push({event_id:'E1',event_date:'2020-01-01',app_archived_at:stamp,...fields});
    assert.match(errors(d,'racks','K1',{room_id:'R2'}).join(' '),/referenced/,`${table}: ${JSON.stringify(fields)}`);
    assert.match(errors(d,'locations','P1',{rack_id:'K2'}).join(' '),/referenced/,`${table}: ${JSON.stringify(fields)}`);
  }
});

test('unrelated scoped and undated events allow an unused position to change parent',()=>{
  const d=fixture();d.tables.light_events.push({event_id:'E1',location_id:'P2',room_id:'R1',start_date:'2020-01-01'},{event_id:'E2',location_id:'P1',protocol:'Undated note'});
  assert.deepEqual(errors(d,'locations','P1',{rack_id:'K2'}),[]);
  d.tables.locations=[];
  assert.deepEqual(errors(d,'racks','K1',{room_id:'R2'}),[]);
});

test('explicit cage parent mismatches remain errors and source changes remain forbidden',()=>{
  const d=fixture();d.tables.cages.push(cage({room_id:'R1',rack_id:'K1',source_record_id:'cage-source'}));
  assert.match(errors(d,'cages','C1',{location_id:'P3'}).join(' '),/differs from the selected location/);
  assert.match(errors(d,'cages','C1',{location_id:'P2',rack_id:'K2',source_record_id:'new'}).join(' '),/provenance/);
  assert.deepEqual(errors(d,'cages','C1',{location_id:'P2',rack_id:'K2'}),[]);
});

test('cage assignment events snapshot complete old and new paths with exact IDs and no mutation',()=>{
  const d=fixture(),old=cage({cage_tag:'Cage tag',source_record_id:'original'}),next={...old,location_id:'P3'};
  const before=structuredClone({d,old,next}),event=buildCageLocationEvent(next,old,'2026-10-14',d,'  Moved after check  ');
  assert.match(event.event_id,/^LOC-[0-9a-f-]{36}$/);assert.equal(event.event_type,'cage_location_assignment');
  assert.equal(event.cage_tag,'Cage tag');assert.equal(event.room_id,'R2');assert.equal(event.rack_id,'K3');assert.equal(event.location_id,'P3');
  assert.equal(event.old_room_id,'R1');assert.equal(event.old_rack_id,'K1');assert.equal(event.old_location_id,'P1');
  assert.equal(event.location_label,'Second room / Rack C / C1');assert.equal(event.old_location_label,'Animal room / Rack A / A1');
  assert.equal(event.position_label,'C1');assert.equal(event.old_position_label,'A1');assert.equal(event.notes,'Moved after check');
  assert.equal(event.app_created_at,event.app_modified_at);assert.deepEqual({d,old,next},before);
  record(d,'rooms','R2').name='Renamed later';record(d,'locations','P1').label='Renamed later';
  assert.equal(event.location_label,'Second room / Rack C / C1');assert.equal(event.old_location_label,'Animal room / Rack A / A1');
  assert.notEqual(buildCageLocationEvent(next,old,'2026-10-14',d).event_id,event.event_id);
});

test('assignment history preserves legacy text, clears unknown previous paths and validates dates',()=>{
  const d=fixture(),old=cage({location_id:null,room:'Legacy room',rack:'Legacy rack',location:'Top shelf'}),next={...old,location_id:'P3'};
  const event=buildCageLocationEvent(next,old,'2026-10-14',d);
  assert.equal(event.old_location_label,'Legacy room / Legacy rack / Top shelf');assert.equal(event.old_location_id,null);
  assert.equal(event.location_label,'Second room / Rack C / C1');
  assert.equal(buildCageLocationEvent(next,null,'2026-10-14',d).old_location_label,null);
  assert.equal(buildCageLocationEvent({...next,location_id:null,room:null,rack:null,location:null},next,'2026-10-14',d).location_label,null);
  assert.throws(()=>buildCageLocationEvent(next,old,'2026-02-30',d),/valid effective housing change date/);
  assert.throws(()=>buildCageLocationEvent(next,old,'',d),/valid effective housing change date/);
  assert.throws(()=>buildCageLocationEvent({},old,'2026-10-14',d),/cage SID/);
});

test('existing assignment references and captured path labels cannot drift through history edits',()=>{
  const d=fixture();d.tables.cages.push(cage());
  const event=buildCageLocationEvent(cage({location_id:'P2'}),cage(),'2026-10-14',d);d.tables.husbandry_events.push(event);
  for(const patch of [{location_id:'P1'},{location_label:'Changed label'},{room_label:'Different room'},{old_location_id:'P3'},{old_location_label:'Different path'},{cage_sid:null},{event_type:'observation'},{mouse_sid:'M1'}]){
    assert.match(validateRecord('husbandry_events',{...event,...patch},d,event.event_id).errors.join(' '),/captured labels/);
  }
  assert.deepEqual(validateRecord('husbandry_events',{...event,event_date:'2026-10-13',notes:'Corrected date',mouse_sid:null,old_cage_sid:null},d,event.event_id).errors,[]);
});
