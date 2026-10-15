import test from 'node:test';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {planCageMove,planCageRemoval,validateCageMovementOccupancy} from '../web/cage-movement.js';import {applyCageSheetDrafts} from '../web/cage-sheet.js';import {normalizeDataset} from '../web/model.js';
globalThis.crypto??=webcrypto;
function fixture(){return normalizeDataset({tables:{rooms:[{room_id:'R1',name:'Room one'},{room_id:'R2',name:'Room two'}],racks:[{rack_id:'K1',room_id:'R1',name:'Rack one'},{rack_id:'K2',room_id:'R2',name:'Rack two'}],locations:[{location_id:'L1',room_id:'R1',rack_id:'K1',label:'A1'},{location_id:'L2',room_id:'R2',rack_id:'K2',label:'B2'},{location_id:'L3',room_id:'R2',rack_id:'K2',label:'B3'}],cages:[{cage_sid:'C1',cage_tag:'A1',location_id:'L1',room_id:'R1',rack_id:'K1',state:'Active',source_raw:'original one'},{cage_sid:'C2',cage_tag:'B2',location_id:'L2',room_id:'R2',rack_id:'K2',state:'Active',source_raw:'original two'}],mice:[{mouse_sid:'M1',physical_tag:'P001',state:'Stock',cage_sid:'C1',cage_tag:'A1',ear_mark:'L0R1'},{mouse_sid:'M2',state:'Stock',cage_sid:'C2',cage_tag:'B2'},{mouse_sid:'OLD',state:'Ended',cage_sid:'C1',cage_tag:'Old historical label'}]}});}
const at='2026-10-15T08:00:00+08:00';
test('move to an empty slot across rooms changes position labels but preserves permanent identities and provenance',()=>{
 const data=fixture(),before=structuredClone(data),plan=planCageMove(data,'C1','L3');assert.equal(plan.kind,'move');assert.equal(plan.changes.length,2);assert.deepEqual(data,before);
 const next=applyCageSheetDrafts(data,plan.changes,{at});const cage=next.tables.cages[0];assert.equal(cage.location_id,'L3');assert.equal(cage.room_id,'R2');assert.equal(cage.rack_id,'K2');assert.equal(cage.cage_tag,'B3');assert.equal(cage.cage_sid,'C1');assert.equal(cage.source_raw,'original one');assert.deepEqual(next.tables.mice[0],{...data.tables.mice[0],cage_tag:'B3',app_modified_at:at});assert.equal(next.tables.mice[2].cage_tag,'Old historical label');assert.equal(next.tables.husbandry_events.length,1);
});
test('occupied destination plans a complete cross-room swap, applied atomically with two movement records',()=>{
 const data=fixture(),plan=planCageMove(data,'C1','L2');assert.equal(plan.kind,'swap');assert.equal(plan.other_cage_sid,'C2');assert.equal(plan.changes.length,4);
 const next=applyCageSheetDrafts(data,plan.changes,{at});assert.deepEqual(next.tables.cages.map(c=>[c.cage_sid,c.location_id,c.cage_tag,c.room_id,c.rack_id]),[['C1','L2','B2','R2','K2'],['C2','L1','A1','R1','K1']]);assert.equal(next.tables.mice[0].cage_sid,'C1');assert.equal(next.tables.mice[1].cage_sid,'C2');assert.equal(next.tables.husbandry_events.length,2);assert.equal(new Set(next.tables.husbandry_events.map(e=>e.event_id)).size,2);
});
test('removal clears physical placement only, retains tag, states and animals, and is idempotent',()=>{
 const data=fixture(),plan=planCageRemoval(data,'C1');assert.equal(plan.kind,'remove');assert.deepEqual(plan.changes,[{type:'cages',id:'C1',field:'location_id',base:'L1',value:null}]);const next=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(next.tables.cages[0].location_id,null);assert.equal(next.tables.cages[0].room_id,null);assert.equal(next.tables.cages[0].cage_tag,'A1');assert.equal(next.tables.cages[0].state,'Active');assert.deepEqual(next.tables.mice,data.tables.mice);assert.equal(planCageRemoval(next,'C1').kind,'noop');assert.equal(planCageMove(data,'C1','L1').changes.length,0);
});
test('ambiguous occupancy, archived entities and inconsistent hierarchy are rejected without modifying data',()=>{
 for(const mutate of [d=>d.tables.cages.push({...d.tables.cages[1],cage_sid:'C3'}),d=>d.tables.cages.push({...d.tables.cages[0],cage_sid:'C3'}),d=>d.tables.cages[0].archived=true,d=>d.tables.locations[1].archived=true,d=>d.tables.racks[1].room_id='R1',d=>d.tables.rooms[1].app_archived_at=at,d=>d.tables.cages[0].room_id='R2',d=>d.tables.locations[1].label=null]){const d=fixture();mutate(d);const before=structuredClone(d);assert.throws(()=>planCageMove(d,'C1','L2'));assert.deepEqual(d,before);}
});
test('source candidate labels and historical cage references do not invent current occupants',()=>{
 const data=fixture();data.tables.locations[2].source_candidate_cage_sids=['C2'];data.tables.cages.push({cage_sid:'H',state:'Ended',location_id:'L3'});assert.equal(planCageMove(data,'C1','L3').kind,'move');
 data.tables.cages[0].location_id=null;data.tables.cages[0].room_id=null;data.tables.cages[0].rack_id=null;assert.equal(planCageMove(data,'C1','L3').kind,'move');assert.throws(()=>planCageMove(data,'C1','L2'),/occupied/);
});
test('apply checks current rights and stale cells, retaining unrelated remote edits',()=>{
 const data=fixture(),plan=planCageMove(data,'C1','L2');assert.throws(()=>applyCageSheetDrafts(data,plan.changes,{canEdit:()=>false,at}),/permission/);assert.throws(()=>applyCageSheetDrafts(data,plan.changes,{canEdit:t=>t!=='mice',at}),/mouse records/);
 const changed=structuredClone(data);changed.tables.cages[1].location_id='L3';assert.throws(()=>applyCageSheetDrafts(changed,plan.changes,{at}),/Changed by another editor/);assert.equal(changed.tables.cages[0].location_id,'L1');data.tables.cages[0].comment='Concurrent note';assert.equal(applyCageSheetDrafts(data,plan.changes,{at}).tables.cages[0].comment,'Concurrent note');
});

test('fresh occupancy validation detects a new third cage, permits a full swap and ignores unrelated draft fields',()=>{
 const d=fixture(),move=planCageMove(d,'C1','L3');d.tables.cages.push({cage_sid:'ARRIVED',state:'Active',location_id:'L3'});assert.throws(()=>validateCageMovementOccupancy(d,move.changes),/became occupied/);
 const clean=fixture();assert.equal(validateCageMovementOccupancy(clean,planCageMove(clean,'C1','L2').changes),true);assert.equal(validateCageMovementOccupancy(d,[{type:'cages',id:'C1',field:'comment',base:null,value:'note'}]),true);
});

test('withdrawn destinations reject new moves and stale drafts while permitting removal or movement out',()=>{
 const d=fixture(),plan=planCageMove(d,'C1','L3');d.tables.locations[2].source_current=false;
 assert.throws(()=>planCageMove(d,'C1','L3'),/withdrawn/);assert.throws(()=>validateCageMovementOccupancy(d,plan.changes),/withdrawn/);
 assert.throws(()=>applyCageSheetDrafts(d,plan.changes,{at}),/withdrawn/);
 d.tables.locations[0].source_current=false;d.tables.locations[2].source_current=true;
 assert.equal(planCageRemoval(d,'C1').kind,'remove');
 const out=planCageMove(d,'C1','L3');assert.equal(out.kind,'move');assert.equal(applyCageSheetDrafts(d,out.changes,{at}).tables.cages[0].location_id,'L3');
 assert.throws(()=>planCageMove(d,'C1','L2'),/withdrawn/,'swapping must not move the other cage into the withdrawn source');
});
