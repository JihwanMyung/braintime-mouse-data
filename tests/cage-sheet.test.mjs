import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { applyCageSheetDrafts, renderCageSheet, clearCageSheetDrafts, hasCageSheetDrafts } from '../web/cage-sheet.js';
import { projectCageHistory } from '../web/cage-history.js';
import { normalizeDataset } from '../web/model.js';
globalThis.crypto??=webcrypto;
const sample=()=>normalizeDataset({tables:{mice:[{mouse_sid:'M1',physical_tag:'P1',sex:'Male',state:'Stock',manager:'JM',cage_sid:'C1',cage_tag:'A1'}],cages:[{cage_sid:'C1',cage_tag:'A1',manager:'JM',state:'Active'}],rooms:[{room_id:'R1',name:'Clean room'}],racks:[{rack_id:'K1',room_id:'R1',name:'Rack A'}],locations:[{location_id:'P1',room_id:'R1',rack_id:'K1',label:'A1'}]}});
const edit=(type,id,field,base,value)=>({type,id,field,base,value});
test('sheet changes are a draft until applied; unrelated concurrent fields survive',()=>{
 const data=sample();data.tables.mice[0].comment='Changed remotely';
 const next=applyCageSheetDrafts(data,[edit('mice','M1','genotype',null,'P')]);
 assert.equal(next.tables.mice[0].genotype,'P');assert.equal(next.tables.mice[0].comment,'Changed remotely');assert.equal(data.tables.mice[0].genotype,undefined);
});
test('same-field conflicts block every draft, without partial writes',()=>{
 const data=sample();data.tables.mice[0].genotype='B';
 assert.throws(()=>applyCageSheetDrafts(data,[edit('cages','C1','comment',null,'note'),edit('mice','M1','genotype',null,'P')]),/Changed by another editor/);
 assert.equal(data.tables.cages[0].comment,undefined);
});
test('retry after a confirmed remote save is idempotent',()=>{
 const data=sample(),drafts=[edit('mice','M1','genotype',null,'P')];
 const next=applyCageSheetDrafts(data,drafts);assert.deepEqual(applyCageSheetDrafts(next,drafts),next);
});
test('only supported fields and permitted entity edits can sync',()=>{
 assert.throws(()=>applyCageSheetDrafts(sample(),[edit('mice','M1','mouse_sid','M1','M2')]),/Unsupported/);
 assert.throws(()=>applyCageSheetDrafts(sample(),[edit('mice','M1','genotype',null,'P')],{canEdit:()=>false}),/permission/);
 const data=sample();data.tables.mice[0].app_archived_at='2026-10-14';assert.throws(()=>applyCageSheetDrafts(data,[edit('mice','M1','genotype',null,'P')]),/archived/);
});
test('invalid mouse values are rejected by the main record validator',()=>{
 assert.throws(()=>applyCageSheetDrafts(sample(),[edit('mice','M1','sex','Male','Bad')]),/Sex/);
});
test('cage rename updates resident tags in the same save and requires mouse access',()=>{
 const draft=[edit('cages','C1','cage_tag','A1','A2')];
 const next=applyCageSheetDrafts(sample(),draft);assert.equal(next.tables.mice[0].cage_tag,'A2');
 assert.throws(()=>applyCageSheetDrafts(sample(),draft,{canEdit:type=>type!=='mice'}),/mouse records/);
});
test('other cage edits never rewrite mouse tags; historical residents retain their tags',()=>{
 const data=sample();data.tables.mice[0].cage_tag='Historical mismatch';
 const notes=applyCageSheetDrafts(data,[edit('cages','C1','comment',null,'Note')],{canEdit:type=>type!=='mice'});
 assert.equal(notes.tables.mice[0].cage_tag,'Historical mismatch');
 data.tables.mice.push({...data.tables.mice[0],mouse_sid:'OLD',state:'Ended'});
 const rename=applyCageSheetDrafts(data,[edit('cages','C1','cage_tag','A1','A2')]);
 assert.equal(rename.tables.mice.find(m=>m.mouse_sid==='OLD').cage_tag,'Historical mismatch');
});
test('position changes record a dated movement and its old and new location',()=>{
 const next=applyCageSheetDrafts(sample(),[edit('cages','C1','location_id',null,'P1')],{at:'2026-10-14T18:00:00Z'});
 assert.equal(next.tables.cages[0].room_id,'R1');assert.equal(next.tables.cages[0].rack_id,'K1');
 const event=next.tables.husbandry_events[0];assert.equal(event.event_type,'cage_location_assignment');assert.equal(event.event_date,'2026-10-15');assert.equal(event.location_id,'P1');assert.equal(event.old_location_id,null);
});
test('source position notes stay separate from immutable source text',()=>{
 const data=sample();data.tables.locations[0].source_block_text='A1: P-M123';
 const next=applyCageSheetDrafts(data,[edit('locations','P1','notes',null,'Reviewed today')]);
 assert.equal(next.tables.locations[0].source_block_text,'A1: P-M123');assert.equal(next.tables.locations[0].notes,'Reviewed today');
 assert.throws(()=>applyCageSheetDrafts(data,[edit('locations','P1','source_block_text','A1: P-M123','new')]),/Unsupported/);
});

// Exercise delegated input handlers through a small host, without a browser or external DOM library.
function sheetHost(){
 let html='',nodes=new Map();
 return {get innerHTML(){return html;},set innerHTML(value){html=value;nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,{disabled:false,textContent:'',querySelector(){return {textContent:''};}}]));},querySelector(selector){return nodes.get(selector.slice(1))||null;}};
}
function movementSample(){
 const data=sample();data.tables.rooms.push({room_id:'R2',name:'Rat room'});data.tables.racks.push({rack_id:'K2',room_id:'R2',name:'Rack B'});
 data.tables.locations.push({location_id:'P2',room_id:'R2',rack_id:'K2',label:'B2',source_block_text:'Original source label'});
 return data;
}
function renderHarness(data,overrides={}){
 clearCageSheetDrafts();const host=sheetHost(),saved=[];
 const hooks={context:'test-colony',currentContext:()=> 'test-colony',canEdit:()=>true,loadFresh:async()=>data,save:async next=>saved.push(next),...overrides};
 renderCageSheet(host,data,hooks);
 return {host,saved,hooks,input:(dataset,value)=>host.oninput({target:{dataset,value,classList:{toggle(){}}}}),sync:()=>host.querySelector('#cage-sheet-sync').onclick()};
}
test('Link cage stages destination tag and cross-room location through the movement planner',async()=>{
 const data=movementSample(),before=structuredClone(data),ui=renderHarness(data);
 ui.input({sheetLink:'P2'},'C1');
 assert.equal(hasCageSheetDrafts(),true);assert.match(ui.host.innerHTML,/Move cage C1 from off rack to B2/);assert.deepEqual(data,before);
 await ui.sync();assert.equal(ui.saved.length,1);
 const next=ui.saved[0];assert.equal(next.tables.cages[0].cage_tag,'B2');assert.equal(next.tables.cages[0].location_id,'P2');assert.equal(next.tables.cages[0].room_id,'R2');assert.equal(next.tables.cages[0].rack_id,'K2');assert.equal(next.tables.mice[0].cage_tag,'B2');assert.equal(next.tables.husbandry_events.length,1);assert.equal(next.tables.locations[1].source_block_text,'Original source label');
});
test('Position dropdown stages a complete cross-room swap rather than a duplicate assignment',async()=>{
 const data=movementSample();Object.assign(data.tables.cages[0],{location_id:'P1',room_id:'R1',rack_id:'K1'});data.tables.cages.push({cage_sid:'C2',cage_tag:'B2',location_id:'P2',room_id:'R2',rack_id:'K2',state:'Active'});
 const ui=renderHarness(data);ui.input({sheetType:'cages',sheetId:'C1',sheetField:'location_id'},'P2');assert.match(ui.host.innerHTML,/Swap cage C1/);
 await ui.sync();assert.deepEqual(ui.saved[0].tables.cages.map(c=>[c.cage_sid,c.location_id,c.cage_tag]),[['C1','P2','B2'],['C2','P1','A1']]);assert.equal(ui.saved[0].tables.husbandry_events.length,2);
});
test('sequential link moves retain original conflict bases and leave only the final physical assignment',async()=>{
 const data=movementSample(),ui=renderHarness(data);
 ui.input({sheetLink:'P2'},'C1');ui.input({sheetLink:'P1'},'C1');await ui.sync();
 assert.equal(ui.saved[0].tables.cages[0].location_id,'P1');assert.equal(ui.saved[0].tables.cages[0].cage_tag,'A1');assert.equal(ui.saved[0].tables.husbandry_events.length,1);
});
test('link respects permissions and rejects unsafe off-rack swaps without staging',()=>{
 const data=movementSample();data.tables.cages.push({cage_sid:'C2',cage_tag:'B2',location_id:'P2',room_id:'R2',rack_id:'K2',state:'Active'});
 let ui=renderHarness(data,{canEdit:()=>false});ui.input({sheetLink:'P2'},'C1');assert.equal(hasCageSheetDrafts(),false);
 ui=renderHarness(data);ui.input({sheetLink:'P2'},'C1');assert.equal(hasCageSheetDrafts(),false);assert.match(ui.host.innerHTML,/is occupied/);
});
test('link sync rechecks fresh occupancy and keeps the pending draft after a conflict',async()=>{
 const data=movementSample(),fresh=structuredClone(data);fresh.tables.cages.push({cage_sid:'ARRIVAL',state:'Active',location_id:'P2'});
 const ui=renderHarness(data,{loadFresh:async()=>fresh});ui.input({sheetLink:'P2'},'C1');await ui.sync();assert.equal(ui.saved.length,0);assert.equal(hasCageSheetDrafts(),true);assert.match(ui.host.innerHTML,/became occupied/);clearCageSheetDrafts();
});
test('historical sheet renders dated evidence with no live navigation or edit actions',()=>{
 const data=movementSample();data.tables.husbandry_events=[{event_id:'MOVE1',event_type:'cage_location_assignment',event_date:'2026-01-01',cage_sid:'C1',cage_tag:'A1',room_id:'R1',rack_id:'K1',location_id:'P1',room_label:'Clean room',rack_label:'Rack A',position_label:'A1'},{event_id:'ASSIGN1',event_type:'cage_assignment',event_date:'2026-01-01',mouse_sid:'M1',cage_sid:'C1',mouse_tag:'P1'}];
 const history=projectCageHistory(data,'2026-01-02',{today:'2026-10-15'});let calls=0;
 for(const layout of ['compact','detailed']){
  const ui=renderHarness(history.dataset,{layout,readOnly:true,selectedDate:'2026-01-02',openCage:()=>calls++,openMouse:()=>calls++,openLocobox:()=>calls++});
  assert.match(ui.host.innerHTML,/Historical evidence as of 2026-01-02/);assert.doesNotMatch(ui.host.innerHTML,/data-sheet-open-cage=|data-sheet-open-mouse=|data-sheet-locobox=|data-sheet-label=|id="cage-sheet-sync"/);
  ui.input({sheetLink:'P2'},'C1');assert.equal(hasCageSheetDrafts(),false);
  ui.host.onclick({target:{closest:()=>null}});assert.equal(calls,0);
 }
});
test('historical light applicability uses noon in Taipei, preserving event time-zone dates',()=>{
 const data=movementSample();data.tables.cages[0].location_id='P1';data.tables.light_events=[{light_event_id:'L',location_id:'P1',start_date:'2026-01-02',end_date:'2026-01-02',timezone:'America/New_York',protocol:'UNIQUE-HISTORICAL-SCHEDULE'}];
 const ui=renderHarness(data,{readOnly:true,selectedDate:'2026-01-02'});
 // Taipei noon is 04:00 UTC, still the preceding day in New York in January.
 assert.doesNotMatch(ui.host.innerHTML,/UNIQUE-HISTORICAL-SCHEDULE/);
});
