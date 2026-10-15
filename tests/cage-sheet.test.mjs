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
const decode=value=>String(value??'').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const attributes=source=>Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)]));
const datasetAttributes=attrs=>Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value]));
function sheetHost(){
 let html='',nodes=new Map(),editors=[];
 const host={get innerHTML(){return html;},set innerHTML(value){
  html=value;nodes=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,{disabled:false,textContent:'',querySelector(){return {textContent:''};}}]));
  editors=[...html.matchAll(/<div class="sheet-animal-editor"([^>]*)>/g)].map(([,attrs])=>{
   let content='',controls=[];const node={dataset:datasetAttributes(attributes(attrs)),hidden:true,get innerHTML(){return content;},set innerHTML(value){content=value;controls=[...value.matchAll(/<(input|textarea)\b([^>]*)>([^<]*)/g)].map(([,tag,attrs,body])=>{const all=attributes(attrs);return {tag,attrs:all,dataset:datasetAttributes(all),value:tag==='textarea'?decode(body):all.value||'',focus(){},classList:{toggle(){}}};});},querySelector(selector){if(selector==='textarea,input')return controls[0];const match=selector.match(/^\[([^=]+)="([^"]*)"\]$/);return match?controls.find(c=>c.attrs[match[1]]===match[2])||null:null;},contains(target){return target===node||controls.includes(target);}};return node;
  });
 },querySelector(selector){return nodes.get(selector.slice(1))||null;},querySelectorAll(selector){return selector==='[data-sheet-inline-editor]'?editors:[];}};
 return host;
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

test('withdrawn current positions have no grid or selectable destination and fresh withdrawals stop sync',async()=>{
 const data=movementSample();data.tables.locations[1].source_current=false;
 let ui=renderHarness(data);assert.doesNotMatch(ui.host.innerHTML,/data-sheet-slot="P2"|<option value="P2"/);
 ui.input({sheetLink:'P2'},'C1');assert.equal(hasCageSheetDrafts(),false);assert.match(ui.host.innerHTML,/withdrawn/);
 Object.assign(data.tables.cages[0],{location_id:'P2',room_id:'R2',rack_id:'K2'});ui=renderHarness(data);
 assert.match(ui.host.innerHTML,/Position needs review/);assert.match(ui.host.innerHTML,/<option value="P2" selected disabled>B2 \(withdrawn\)<\/option>/);
 assert.match(ui.host.innerHTML,/data-sheet-edit-animal="note"/);assert.match(ui.host.innerHTML,/>P1<\/button>/);assert.doesNotMatch(ui.host.innerHTML,/data-sheet-slot="P2"/);
 const clean=movementSample(),fresh=structuredClone(clean);fresh.tables.locations[1].source_current=false;
 ui=renderHarness(clean,{loadFresh:async()=>fresh});ui.input({sheetLink:'P2'},'C1');await ui.sync();
 assert.equal(ui.saved.length,0);assert.equal(hasCageSheetDrafts(),true);assert.match(ui.host.innerHTML,/withdrawn/);clearCageSheetDrafts();
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

// Resolve a rendered button, then simulate a click on its nested icon. The parent
// card remains reachable to catch accidental cage selection or movement.
function renderedButtonTarget(host,attribute,value){
 const article=[...host.innerHTML.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/g)].find(([,attrs,content])=>content.includes(`${attribute}="${value}"`));
 assert.ok(article,`Rendered cage card containing ${attribute}=${value}`);
 const match=[...article[2].matchAll(/<button\b([^>]*)>/g)].find(([,attrs])=>attrs.includes(`${attribute}="${value}"`));
 assert.ok(match,'Rendered button exists');
 const attributes=Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,val])=>[key,decode(val)]));
 const dataset=Object.fromEntries(Object.entries(attributes).filter(([key])=>key.startsWith('data-')).map(([key,val])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),val]));
 const cardAttributes=Object.fromEntries([...article[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,val])=>[key,val]));
 const card={dataset:{cage:cardAttributes['data-cage'],sheetSlot:cardAttributes['data-sheet-slot']}};
 const button={dataset,hasAttribute:key=>Object.hasOwn(attributes,key),matches:selector=>selector==='button'};
 return {button,closest(selector){
   if(selector==='.sheet-cage')return card;
   return selector.split(',').some(part=>part==='button'||(part.startsWith('[')&&button.hasAttribute(part.slice(1,-1))))?button:null;
 }};
}

test('current read-only viewers can open header print actions for cages and source positions in either layout',()=>{
 const data=movementSample();data.tables.cages[0].location_id='P1';
 for(const layout of ['compact','detailed']){
  const calls=[],ui=renderHarness(data,{layout,canEdit:()=>false,printLabel:id=>calls.push(['cage',id]),printPositionLabel:id=>calls.push(['position',id])});
  assert.match(ui.host.innerHTML,/<header>[\s\S]*?data-sheet-label="C1"[^>]*aria-label="Print label for cage A1"[^>]*><svg/);
  assert.match(ui.host.innerHTML,/<header>[\s\S]*?data-sheet-position-label="P2"[^>]*aria-label="Print label for position B2"[^>]*><svg/);
  assert.doesNotMatch(ui.host.innerHTML,/<footer>[^<]*(?:<button[^>]*>[^<]*<\/button>)*<button[^>]*data-sheet-(?:position-)?label=/);
  ui.host.onclick({target:renderedButtonTarget(ui.host,'data-sheet-label','C1')});
  ui.host.onclick({target:renderedButtonTarget(ui.host,'data-sheet-position-label','P2')});
  assert.deepEqual(calls,[['cage','C1'],['position','P2']]);assert.equal(ui.saved.length,0);assert.equal(hasCageSheetDrafts(),false);
 }
});

test('nested print icons do not select cages or complete a pending move',()=>{
 const data=movementSample();data.tables.cages[0].location_id='P1';
 const calls=[],ui=renderHarness(data,{printLabel:id=>calls.push(id),printPositionLabel:id=>calls.push(id)});
 ui.host.onclick({target:renderedButtonTarget(ui.host,'data-sheet-move','C1')});
 assert.match(ui.host.innerHTML,/Moving cage C1/);
 const target=renderedButtonTarget(ui.host,'data-sheet-position-label','P2');
 ui.host.onclick({target});
 ui.host.onclick({target:renderedButtonTarget(ui.host,'data-sheet-label','C1')});
 assert.deepEqual(calls,['P2','C1']);assert.match(ui.host.innerHTML,/Moving cage C1/);assert.equal(hasCageSheetDrafts(),false);assert.equal(ui.saved.length,0);
 let prevented=false;ui.host.onkeydown({key:'Enter',target:target.button,preventDefault(){prevented=true;}});assert.equal(prevented,false);
});

test('printing waits for pending sheet edits to be synced or discarded on both print routes',()=>{
 const data=movementSample();data.tables.cages[0].location_id='P1';
 let calls=0;const ui=renderHarness(data,{printLabel:()=>calls++,printPositionLabel:()=>calls++});
 ui.input({sheetType:'mice',sheetId:'M1',sheetField:'genotype'},'P');
 ui.host.onclick({target:renderedButtonTarget(ui.host,'data-sheet-label','C1')});
 ui.host.onclick({target:renderedButtonTarget(ui.host,'data-sheet-position-label','P2')});
 assert.equal(calls,0);assert.equal(ui.saved.length,0);assert.equal(hasCageSheetDrafts(),true);
 assert.match(ui.host.innerHTML,/Sync or discard pending edits before printing/);assert.equal(data.tables.mice[0].genotype,undefined);clearCageSheetDrafts();
});

test('mouse-reference-derived cages never masquerade as a registered print target',()=>{
 const data=movementSample();data.tables.cages=[];
 const ui=renderHarness(data);
 assert.doesNotMatch(ui.host.innerHTML,/data-sheet-label="C1"/);
 assert.match(ui.host.innerHTML,/data-sheet-position-label="P1"/);assert.match(ui.host.innerHTML,/data-sheet-position-label="P2"/);
});

test('historical views block cage and source-position print dispatch even for stale targets',()=>{
 const data=movementSample();data.tables.cages[0].location_id='P1';
 let calls=0;const current=renderHarness(data),cageTarget=renderedButtonTarget(current.host,'data-sheet-label','C1'),positionTarget=renderedButtonTarget(current.host,'data-sheet-position-label','P2');
 for(const layout of ['compact','detailed']){
  const ui=renderHarness(data,{layout,readOnly:true,selectedDate:'2026-01-02',printLabel:()=>calls++,printPositionLabel:()=>calls++});
  assert.doesNotMatch(ui.host.innerHTML,/data-sheet-label=|data-sheet-position-label=/);
  ui.host.onclick({target:cageTarget});ui.host.onclick({target:positionTarget});assert.equal(calls,0);assert.equal(hasCageSheetDrafts(),false);
 }
});

function observationSample(){
 const data=sample();data.tables.cages=[];
 Object.assign(data.tables.mice[0],{cage_sid:null,cage_tag:null,physical_tag:"PB'-M3193",date_of_birth:'2026-07-20',ear_mark:'L0R0',comment:'Older note',manager:'Vuong'});
 Object.assign(data.tables.locations[0],{label:'L7',manager:'Vuong Truong',source_cage_observation:{schemaVersion:1,managerName:'Vuong',startedDate:'2025-12-23',intensityLux:150,animals:[{tag:"PB'-M3193",note:'0039 PB',dateOfBirth:'2026-07-20',left:1,right:1,sourceCell:'T10'}]}});
 return data;
}
function doneTarget(){return {closest(selector){return selector.includes('[data-sheet-editor-done]')?{dataset:{sheetEditorDone:'true'}}:null;}};}
async function openEditor(ui,mode){await ui.host.onclick({target:renderedButtonTarget(ui.host,'data-sheet-edit-animal',mode)});return ui.host.querySelectorAll('[data-sheet-inline-editor]').find(node=>!node.hidden);}
function enter(ui,node,field,value){const target=node.querySelector(`[data-sheet-field="${field}"]`);assert.ok(target,`editor ${field} present`);target.value=value;ui.host.oninput({target});return target;}

test('compact source cages show manager, recording date/lux and one-line tag, ear, age with hover details',()=>{
 const ui=renderHarness(observationSample(),{selectedDate:'2026-10-12'}),article=[...ui.host.innerHTML.matchAll(/<article\b[^>]*data-sheet-slot="P1"[^>]*>([\s\S]*?)<\/article>/g)][0][1];
 assert.match(article,/>Vuong<\/span>/);assert.match(article,/datetime="2025-12-23"/);assert.match(article,/>150 lux<\/span>/);
 assert.match(article,/title="0039 PB"/);assert.match(article,/>PB&#39;-M3193<\/button>/);assert.match(article,/>L1R1<\/button>/);assert.match(article,/title="DOB 2026-07-20"[^>]*>12wk<\/button>/);
 assert.doesNotMatch(article,/source labels|Source labels|Unlinked position|data-sheet-field="date_of_birth"|data-sheet-field="ear_mark"|data-sheet-field="physical_tag"/);
});

test('note editor uses displayed observation, saves on Done to exact mouse, and preserves raw note plus concurrent overrides',async()=>{
 const data=observationSample(),fresh=structuredClone(data);fresh.tables.mice[0].cage_sheet_overrides={ear_mark:true};
 const ui=renderHarness(data,{loadFresh:async()=>fresh}),editor=await openEditor(ui,'note');
 assert.ok(editor);assert.equal(editor.querySelector('[data-sheet-field="comment"]').value,'0039 PB');assert.match(editor.innerHTML,/data-sheet-open-mouse="M1"/);
 enter(ui,editor,'comment','Reviewed note');assert.equal(ui.saved.length,0);assert.equal(hasCageSheetDrafts(),true);
 await ui.host.onclick({target:doneTarget()});
 assert.equal(ui.saved.length,1);const mouse=ui.saved[0].tables.mice[0];assert.equal(mouse.comment,'Reviewed note');assert.deepEqual(mouse.cage_sheet_overrides,{ear_mark:true,comment:true});
 assert.equal(ui.saved[0].tables.locations[0].source_cage_observation.animals[0].note,'0039 PB');assert.equal(mouse.cage_sid,null);assert.equal(hasCageSheetDrafts(),false);
});

test('ear editor uses source L/R counts, retains zero, and writes canonical mark to Mice',async()=>{
 const ui=renderHarness(observationSample()),editor=await openEditor(ui,'ear'),left=editor.querySelector('[data-sheet-ear-side="L"]'),right=editor.querySelector('[data-sheet-ear-side="R"]');
 assert.equal(left.value,'1');assert.equal(right.value,'1');left.value='0';ui.host.oninput({target:left});right.value='2';ui.host.oninput({target:right});
 await ui.host.onclick({target:doneTarget()});assert.equal(ui.saved.length,1);assert.equal(ui.saved[0].tables.mice[0].ear_mark,'L0R2');assert.equal(ui.saved[0].tables.mice[0].cage_sheet_overrides.ear_mark,true);
});

test('DOB editor saves exact mouse DOB and updates compact age without changing source observation',async()=>{
 const ui=renderHarness(observationSample(),{selectedDate:'2026-10-12'}),editor=await openEditor(ui,'dob');
 assert.equal(editor.querySelector('[data-sheet-field="date_of_birth"]').value,'2026-07-20');enter(ui,editor,'date_of_birth','2026-07-13');
 await ui.host.onclick({target:doneTarget()});assert.equal(ui.saved[0].tables.mice[0].date_of_birth,'2026-07-13');assert.equal(ui.saved[0].tables.mice[0].cage_sheet_overrides.date_of_birth,true);
 assert.match(ui.host.innerHTML,/title="DOB 2026-07-13"[^>]*>13wk<\/button>/);assert.equal(ui.saved[0].tables.locations[0].source_cage_observation.animals[0].dateOfBirth,'2026-07-20');
});

test('pre-existing sheet drafts prevent inline auto-save and remain a single explicit Sync',async()=>{
 const ui=renderHarness(observationSample());ui.input({sheetType:'locations',sheetId:'P1',sheetField:'notes'},'Cage note');
 const editor=await openEditor(ui,'note');enter(ui,editor,'comment','Mouse note');await ui.host.onclick({target:doneTarget()});
 assert.equal(ui.saved.length,0);assert.equal(hasCageSheetDrafts(),true);await ui.sync();assert.equal(ui.saved.length,1);assert.equal(ui.saved[0].tables.locations[0].notes,'Cage note');assert.equal(ui.saved[0].tables.mice[0].comment,'Mouse note');
});

test('inline auto-save rechecks permission and concurrent same-field edits without overwriting them',async()=>{
 const data=observationSample(),fresh=structuredClone(data);fresh.tables.mice[0].ear_mark='L2R2';
 const ui=renderHarness(data,{loadFresh:async()=>fresh}),editor=await openEditor(ui,'ear'),left=editor.querySelector('[data-sheet-ear-side="L"]');left.value='0';ui.host.oninput({target:left});
 await ui.host.onclick({target:doneTarget()});assert.equal(ui.saved.length,0);assert.equal(fresh.tables.mice[0].ear_mark,'L2R2');assert.equal(hasCageSheetDrafts(),true);assert.match(ui.host.querySelector('#cage-sheet-status').textContent,/Changed by another editor/);clearCageSheetDrafts();
});

test('ambiguous and historical rows cannot open editable controls or navigate to guessed Mice',async()=>{
 const data=observationSample();data.tables.mice.push({...data.tables.mice[0],mouse_sid:'M2'});
 let ui=renderHarness(data),editor=await openEditor(ui,'note');assert.ok(editor);assert.doesNotMatch(editor.innerHTML,/data-sheet-field=|data-sheet-open-mouse=/);assert.match(ui.host.innerHTML,/Multiple mouse matches/);
 ui=renderHarness(observationSample(),{readOnly:true,selectedDate:'2026-10-12'});assert.match(ui.host.innerHTML,/data-sheet-edit-animal="dob"[^>]* disabled/);assert.equal(await openEditor(ui,'note'),undefined);assert.equal(hasCageSheetDrafts(),false);
});

test('future DOB is rejected without saving an earlier draft or changing Mice',async()=>{
 const ui=renderHarness(observationSample()),editor=await openEditor(ui,'dob');enter(ui,editor,'date_of_birth','2999-01-01');await ui.host.onclick({target:doneTarget()});assert.equal(ui.saved.length,0);assert.equal(editor.hidden,false);assert.match(ui.host.querySelector('#cage-sheet-status').textContent,/DOB cannot be in the future/);
 assert.throws(()=>applyCageSheetDrafts(observationSample(),[edit('mice','M1','date_of_birth','2026-07-20','2999-01-01')],{at:'2026-10-16T12:00:00Z'}),/DOB cannot be in the future/);
});

test('leaving an inline editor saves, but tabbing between controls does not save while typing',async()=>{
 const ui=renderHarness(observationSample()),editor=await openEditor(ui,'note'),target=enter(ui,editor,'comment','Saved on leaving');
 ui.host.onfocusout({target,relatedTarget:target});await new Promise(resolve=>setTimeout(resolve,3));assert.equal(ui.saved.length,0);
 ui.host.onfocusout({target,relatedTarget:null});await new Promise(resolve=>setTimeout(resolve,3));assert.equal(ui.saved.length,1);assert.equal(ui.saved[0].tables.mice[0].comment,'Saved on leaving');
});

test('source-linked inline save rejects a changed identity match or revoked permission on fresh reload',async()=>{
 const data=observationSample(),fresh=structuredClone(data);fresh.tables.mice[0].physical_tag='Different mouse';
 let ui=renderHarness(data,{loadFresh:async()=>fresh}),editor=await openEditor(ui,'note');enter(ui,editor,'comment','Must not save');await ui.host.onclick({target:doneTarget()});assert.equal(ui.saved.length,0);assert.match(ui.host.querySelector('#cage-sheet-status').textContent,/Animal match changed/);clearCageSheetDrafts();
 let allowed=true;ui=renderHarness(observationSample(),{canEdit:()=>allowed});editor=await openEditor(ui,'note');enter(ui,editor,'comment','Must not save');allowed=false;await ui.host.onclick({target:doneTarget()});assert.equal(ui.saved.length,0);assert.match(ui.host.querySelector('#cage-sheet-status').textContent,/permission/);clearCageSheetDrafts();
});

test('deliberately choosing the stored value still overrides differing source notes and earmarks',async()=>{
 const data=observationSample();data.tables.mice[0].comment=null;
 let ui=renderHarness(data),editor=await openEditor(ui,'note');enter(ui,editor,'comment','');await ui.host.onclick({target:doneTarget()});
 assert.equal(ui.saved.length,1);assert.equal(ui.saved[0].tables.mice[0].comment,null);assert.equal(ui.saved[0].tables.mice[0].cage_sheet_overrides.comment,true);
 ui=renderHarness(observationSample());editor=await openEditor(ui,'ear');const left=editor.querySelector('[data-sheet-ear-side="L"]'),right=editor.querySelector('[data-sheet-ear-side="R"]');left.value='0';ui.host.oninput({target:left});right.value='0';ui.host.oninput({target:right});await ui.host.onclick({target:doneTarget()});
 assert.equal(ui.saved.length,1);assert.equal(ui.saved[0].tables.mice[0].ear_mark,'L0R0');assert.equal(ui.saved[0].tables.mice[0].cage_sheet_overrides.ear_mark,true);
 const sourceCard=[...ui.host.innerHTML.matchAll(/<article\b[^>]*data-sheet-slot="P1"[^>]*>([\s\S]*?)<\/article>/g)][0][1];assert.match(sourceCard,/>L0R0<\/button>/);
});

test('pending source-linked mouse edits survive a sheet repaint before explicit Sync',async()=>{
 const ui=renderHarness(observationSample(),{selectedDate:'2026-10-12'});ui.input({sheetType:'locations',sheetId:'P1',sheetField:'notes'},'Pending cage note');
 let editor=await openEditor(ui,'dob');enter(ui,editor,'date_of_birth','2026-07-13');await ui.host.onclick({target:doneTarget()});
 ui.host.querySelector('#cage-sheet-rack').onchange({target:{value:''}});
 let card=[...ui.host.innerHTML.matchAll(/<article\b[^>]*data-sheet-slot="P1"[^>]*>([\s\S]*?)<\/article>/g)][0][1];
 assert.match(card,/title="DOB 2026-07-13"[^>]*>13wk<\/button>/);assert.doesNotMatch(card,/data-sheet-edit-animal="dob"[^>]* disabled/);
 editor=await openEditor(ui,'note');enter(ui,editor,'comment','Current note only');await ui.host.onclick({target:doneTarget()});
 ui.host.querySelector('#cage-sheet-rack').onchange({target:{value:''}});
 card=[...ui.host.innerHTML.matchAll(/<article\b[^>]*data-sheet-slot="P1"[^>]*>([\s\S]*?)<\/article>/g)][0][1];assert.match(card,/title="Current note only"/);assert.doesNotMatch(card,/title="Current note only · 0039 PB"/);
 assert.equal(ui.saved.length,0);await ui.sync();assert.equal(ui.saved.length,1);assert.equal(ui.saved[0].tables.mice[0].date_of_birth,'2026-07-13');assert.equal(ui.saved[0].tables.mice[0].comment,'Current note only');
 assert.equal(ui.saved[0].tables.locations[0].source_cage_observation.animals[0].note,'0039 PB');
});
