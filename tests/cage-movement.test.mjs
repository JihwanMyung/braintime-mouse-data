import test from 'node:test';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {planCageSlotMove,planCageMove,planCageRemoval,validateCageMovementOccupancy,planMouseMove,planMouseMoveToPosition,validateMouseMoveDrafts,getMouseMoveReadDependencies,buildMouseMoveEvent} from '../web/cage-movement.js';import {applyCageSheetDrafts} from '../web/cage-sheet.js';import {normalizeDataset,validateRecord} from '../web/model.js';
import {prepareMouseCageSheetEdit,cageSheetAnimals} from '../web/cage-observations.js';
globalThis.crypto??=webcrypto;
function fixture(){return normalizeDataset({tables:{rooms:[{room_id:'R1',name:'Room one'},{room_id:'R2',name:'Room two'}],racks:[{rack_id:'K1',room_id:'R1',name:'Rack one'},{rack_id:'K2',room_id:'R2',name:'Rack two'}],locations:[{location_id:'L1',room_id:'R1',rack_id:'K1',label:'A1'},{location_id:'L2',room_id:'R2',rack_id:'K2',label:'B2'},{location_id:'L3',room_id:'R2',rack_id:'K2',label:'B3'}],cages:[{cage_sid:'C1',cage_tag:'A1',location_id:'L1',room_id:'R1',rack_id:'K1',state:'Active',source_raw:'original one'},{cage_sid:'C2',cage_tag:'B2',location_id:'L2',room_id:'R2',rack_id:'K2',state:'Active',source_raw:'original two'}],mice:[{mouse_sid:'M1',physical_tag:'P001',state:'Stock',cage_sid:'C1',cage_tag:'A1',ear_mark:'L0R1'},{mouse_sid:'M2',state:'Stock',cage_sid:'C2',cage_tag:'B2'},{mouse_sid:'OLD',state:'Ended',cage_sid:'C1',cage_tag:'Old historical label'}]}});}
const at='2026-10-15T08:00:00+08:00';
const sourcePositions=rows=>rows.map(({app_modified_at,app_cage_occupancy_revision,...source})=>source);
test('move to an empty slot across rooms changes position labels but preserves permanent identities and provenance',()=>{
 const data=fixture(),before=structuredClone(data),plan=planCageMove(data,'C1','L3');assert.equal(plan.kind,'move');assert.equal(plan.changes.length,2);assert.deepEqual(data,before);
 const next=applyCageSheetDrafts(data,plan.changes,{at});const cage=next.tables.cages[0];assert.equal(cage.location_id,'L3');assert.equal(cage.room_id,'R2');assert.equal(cage.rack_id,'K2');assert.equal(cage.cage_tag,'B3');assert.equal(cage.cage_sid,'C1');assert.equal(cage.source_raw,'original one');assert.deepEqual(next.tables.mice[0],{...data.tables.mice[0],cage_tag:'B3',cage_sheet_overrides:{cage_sid:true},app_modified_at:at});assert.equal(next.tables.mice[2].cage_tag,'Old historical label');assert.equal(next.tables.husbandry_events.length,1);
});
test('occupied destination plans a complete cross-room swap, applied atomically with two movement records',()=>{
 const data=fixture(),plan=planCageMove(data,'C1','L2');assert.equal(plan.kind,'swap');assert.equal(plan.other_cage_sid,'C2');assert.equal(plan.changes.length,4);
 const next=applyCageSheetDrafts(data,plan.changes,{at});assert.deepEqual(next.tables.cages.map(c=>[c.cage_sid,c.location_id,c.cage_tag,c.room_id,c.rack_id]),[['C1','L2','B2','R2','K2'],['C2','L1','A1','R1','K1']]);assert.equal(next.tables.mice[0].cage_sid,'C1');assert.equal(next.tables.mice[1].cage_sid,'C2');assert.equal(next.tables.husbandry_events.length,2);assert.equal(new Set(next.tables.husbandry_events.map(e=>e.event_id)).size,2);
});
test('removal clears physical placement only, retains tag, states and animals, and is idempotent',()=>{
 const data=fixture(),plan=planCageRemoval(data,'C1');assert.equal(plan.kind,'remove');assert.deepEqual(plan.changes,[{type:'cages',id:'C1',field:'location_id',base:'L1',value:null}]);const next=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(next.tables.cages[0].location_id,null);assert.equal(next.tables.cages[0].room_id,null);assert.equal(next.tables.cages[0].cage_tag,'A1');assert.equal(next.tables.cages[0].state,'Active');assert.deepEqual(next.tables.mice,[{...data.tables.mice[0],cage_sheet_overrides:{cage_sid:true},app_modified_at:at},...data.tables.mice.slice(1)]);assert.equal(planCageRemoval(next,'C1').kind,'noop');assert.equal(planCageMove(data,'C1','L1').changes.length,0);
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

test('mouse move is a pure explicit SID assignment with identity guard and complete known housing dependencies',()=>{
 const data=fixture(),before=structuredClone(data),plan=planMouseMove(data,'M1','C2',{sourceCageSid:'C1',effectiveDate:'2026-10-14'});
 assert.equal(plan.kind,'mouse_move');assert.equal(plan.changes.length,1);assert.deepEqual(plan.changes[0],{type:'mice',id:'M1',field:'cage_sid',base:'C1',value:'C2',mouseMove:{schemaVersion:1,mouseSid:'M1',sourceCageSid:'C1',destinationCageSid:'C2',identity:{physical_tag:'P001',sex:null,date_of_birth:null},effectiveDate:'2026-10-14'}});
 assert.deepEqual(data,before);assert.equal(validateMouseMoveDrafts(data,plan.changes),true);assert.deepEqual(new Set(plan.readDependencies.map(d=>d.type+':'+d.id)),new Set(['mice:M1','cages:C1','cages:C2','locations:L1','locations:L2','racks:K1','racks:K2','rooms:R1','rooms:R2']));
 assert.equal(planMouseMove(data,'M1','C1').kind,'noop');assert.throws(()=>planMouseMove(data,'M1','C2',{sourceCageSid:'C2'}),/source cage/);assert.throws(()=>planMouseMove(data,'M1','C2',{effectiveDate:'2026-02-30'}),/date/);
});

test('mouse moves reject missing, ambiguous, archived, non-Stock and historical identities or targets',()=>{
 for(const mutate of [d=>d.tables.mice[0].state='Ended',d=>d.tables.mice[0].state='Unknown',d=>d.tables.mice[0].archived=true,d=>d.tables.mice[0].app_archived_at=at,d=>d.tables.mice[0]._derived=true,d=>d.tables.mice[0].history_read_only=true,d=>d.tables.mice.push({...d.tables.mice[0]}),d=>d.history_projection={read_only:true},d=>d.tables.cages[1].state='Ended',d=>d.tables.cages[1].state='',d=>d.tables.cages[1]._derived=true,d=>d.tables.cages[1].archived=true,d=>d.tables.cages[1].history_read_only=true,d=>d.tables.locations[1].source_current=false,d=>d.tables.locations[1].archived=true,d=>d.tables.rooms[1].archived=true,d=>d.tables.racks[1].room_id='R1',d=>d.tables.cages.push({...d.tables.cages[1],cage_sid:'CONFLICT'})]){
  const d=fixture();mutate(d);const before=structuredClone(d);assert.throws(()=>planMouseMove(d,'M1','C2'));assert.deepEqual(d,before);
 }
 assert.throws(()=>planMouseMove(fixture(),'missing','C2'));assert.throws(()=>planMouseMove(fixture(),'M1','missing'));assert.throws(()=>planMouseMove(fixture(),'M1',null));
});

test('fresh mouse checks preserve unrelated edits but reject changed identity, cage or eligibility and malformed guards',()=>{
 const d=fixture(),draft=planMouseMove(d,'M1','C2').changes[0];
 for(const field of ['comment','genotype','manager']){const changed=structuredClone(d);changed.tables.mice[0][field]='Another edit';assert.equal(validateMouseMoveDrafts(changed,[draft]),true);}
 for(const mutate of [d=>d.tables.mice[0].physical_tag='Other',d=>d.tables.mice[0].date_of_birth='2026-01-01',d=>d.tables.mice[0].sex='Male',d=>d.tables.mice[0].cage_sid=null,d=>d.tables.mice[0].state='Ended',d=>d.tables.cages[1].archived=true]){const changed=structuredClone(d);mutate(changed);assert.throws(()=>validateMouseMoveDrafts(changed,[draft]));}
 for(const mutate of [c=>delete c.mouseMove,c=>c.mouseMove.mouseSid='M2',c=>c.mouseMove.destinationCageSid='C1',c=>c.base='MISSING',c=>delete c.mouseMove.sourceCageSid,c=>delete c.mouseMove.identity.sex,c=>c.mouseMove.effectiveDate='tomorrow']){const bad=structuredClone(draft);mutate(bad);assert.throws(()=>validateMouseMoveDrafts(d,[bad]));}
 assert.throws(()=>validateMouseMoveDrafts(d,[draft,draft]),/multiple staged/);
 const completed=structuredClone(d);completed.tables.mice[0].cage_sid='C2';assert.equal(validateMouseMoveDrafts(completed,[draft]),true);
});

test('mouse target can move with its cage in the same draft, with final housing revalidated and included in reads',()=>{
 const d=fixture(),drafts=[...planMouseMove(d,'M1','C2').changes,...planCageMove(d,'C2','L3').changes];assert.equal(validateMouseMoveDrafts(d,drafts),true);
 const deps=getMouseMoveReadDependencies(d,drafts);assert.ok(deps.some(x=>x.type==='locations'&&x.id==='L3'));assert.ok(deps.some(x=>x.type==='locations'&&x.id==='L2'));
 const changed=structuredClone(d);changed.tables.cages.push({cage_sid:'NEW',state:'Active',location_id:'L3'});assert.throws(()=>validateMouseMoveDrafts(changed,drafts),/occupied/);
 changed.tables.cages.pop();changed.tables.locations[2].source_current=false;assert.throws(()=>validateMouseMoveDrafts(changed,drafts),/withdrawn/);
 const off=fixture();off.tables.cages[1].location_id=null;off.tables.cages[1].room_id=null;off.tables.cages[1].rack_id=null;assert.equal(planMouseMove(off,'M1','C2').kind,'mouse_move');
});

function observed(){const d=fixture();d.tables.cages=d.tables.cages.filter(c=>c.cage_sid!=='C1');d.tables.mice[0].cage_sid='LEGACY';d.tables.mice[0].sex='Unknown';d.tables.mice[0].source_raw='Original animal provenance';d.tables.locations[0].source_cage_observation={schemaVersion:1,animals:[{tag:'P001',sourceCell:'T10',note:'Retain source note'}]};return d;}
const sourceMatch={locationId:'L1',tag:'P001',sourceCell:'T10'};
test('exact source matches allow a legacy missing old cage, but never infer an animal from an ambiguous or changed observation',()=>{
 const d=observed(),before=structuredClone(d),plan=planMouseMove(d,'M1','C2',{sourceMatch});assert.equal(plan.changes[0].base,'LEGACY');assert.deepEqual(plan.changes[0].sourceMatch,sourceMatch);assert.equal(validateMouseMoveDrafts(d,plan.changes),true);assert.deepEqual(d,before);
 assert.ok(plan.readDependencies.some(x=>x.type==='locations'&&x.id==='L1'));assert.throws(()=>planMouseMove(d,'M1','C2'),/not registered/);
 for(const mutate of [d=>d.tables.locations[0].source_cage_observation.animals[0].tag='Other',d=>d.tables.locations[0].source_current=false,d=>d.tables.locations[0].source_cage_observation.animals[0].sourceCell=null,d=>d.tables.locations[0].source_cage_observation.animals.push({...d.tables.locations[0].source_cage_observation.animals[0]}),d=>d.tables.mice.push({...d.tables.mice[0],mouse_sid:'M3'})]){const bad=structuredClone(d);mutate(bad);assert.throws(()=>validateMouseMoveDrafts(bad,plan.changes));}
});

test('move to an unlinked slot stages only one explicit cage creation and the dragged mouse, preserving every source record',()=>{
 const d=observed(),before=structuredClone(d),plan=planMouseMoveToPosition(d,'M1','L3',{cageSid:'CAGE-NEW',sourceMatch});
 assert.equal(plan.changes.length,3);const create=plan.changes[0];assert.deepEqual(create,{type:'cages',id:'CAGE-NEW',field:'$create',base:null,value:{cage_sid:'CAGE-NEW',cage_tag:'B3',state:'Active',record_origin:'app_created',location_id:'L3',room_id:'R2',rack_id:'K2',cage_sheet_source_location_id:'L3'}});
 assert.equal(plan.changes[1].id,'M1');assert.equal(plan.changes[1].value,'CAGE-NEW');assert.equal(validateMouseMoveDrafts(d,plan.changes),true);assert.deepEqual(d,before);assert.ok(!plan.readDependencies.some(x=>x.type==='cages'&&x.id==='CAGE-NEW'));
 const deps=getMouseMoveReadDependencies(d,plan.changes);for(const id of ['L1','L3'])assert.ok(deps.some(x=>x.type==='locations'&&x.id===id));
 assert.throws(()=>planMouseMoveToPosition(d,'M1','L3',{sourceMatch}),/new cage SID/);assert.throws(()=>planMouseMoveToPosition(d,'M1','L3',{cageSid:'C2',sourceMatch}),/already registered/);
 const occupied=planMouseMoveToPosition(d,'M1','L2',{sourceMatch});assert.equal(occupied.changes.length,2);assert.equal(occupied.destination_cage_sid,'C2');
});

test('new cage drafts reject stale placement, SID collisions, injected fields, inconsistent hierarchy and double occupation',()=>{
 const d=observed(),changes=planMouseMoveToPosition(d,'M1','L3',{cageSid:'CAGE-NEW',sourceMatch}).changes;
 for(const mutate of [d=>d.tables.cages.push({cage_sid:'ARRIVED',state:'Active',location_id:'L3'}),d=>d.tables.locations[2].label='Renamed',d=>d.tables.locations[2].source_current=false,d=>d.tables.racks[1].archived=true,d=>d.tables.cages.push({cage_sid:'CAGE-NEW',state:'Active',location_id:'L2'})]){const bad=structuredClone(d);mutate(bad);assert.throws(()=>validateMouseMoveDrafts(bad,changes));}
 for(const mutate of [c=>c.value.manager='Injected',c=>c.value.state='Ended',c=>c.value.cage_sid='Other',c=>c.value.room_id='R1',c=>c.value.cage_sheet_source_location_id='L1',c=>c.base={},c=>delete c.value.record_origin]){const bad=structuredClone(changes);mutate(bad[0]);assert.throws(()=>validateMouseMoveDrafts(d,bad));}
 const second=structuredClone(changes[0]);second.id='SECOND';second.value.cage_sid='SECOND';assert.throws(()=>validateMouseMoveDrafts(d,[...changes,second]),/occupied/);
 const done=applyCageSheetDrafts(d,changes,{at});done.tables.cages.find(c=>c.cage_sid==='CAGE-NEW').comment='Keep unrelated remote note';delete done.tables.locations[0].source_cage_observation;
 assert.equal(validateMouseMoveDrafts(done,changes),true,'completed moves do not require a source row hidden by the manual-assignment overlay');
});

test('registering a source position carries only its explicit cage manager, including Unassigned',()=>{
 for(const manager of ['Selected caretaker','']){
  const data=observed(),position=data.tables.locations[2];position.manager=manager;position.source_manager_name='Original source caretaker';
  data.tables.mice[0].manager='Individual caretaker';const before=structuredClone(data);
  const plan=planMouseMoveToPosition(data,'M1','L3',{cageSid:'CAGE-NEW',sourceMatch});
  assert.equal(plan.changes[0].value.manager,manager);assert.equal(validateMouseMoveDrafts(data,plan.changes),true);assert.deepEqual(data,before);
  const next=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(next.tables.cages.find(c=>c.cage_sid==='CAGE-NEW').manager,manager);assert.equal(next.tables.mice[0].manager,'Individual caretaker');assert.deepEqual(sourcePositions(next.tables.locations),sourcePositions(data.tables.locations));
  assert.deepEqual(applyCageSheetDrafts(next,plan.changes,{at}),next);
  const changed=structuredClone(data);changed.tables.locations[2].manager='Changed caretaker';assert.throws(()=>validateMouseMoveDrafts(changed,plan.changes),/destination changed/);
  const removed=structuredClone(data);delete removed.tables.locations[2].manager;assert.throws(()=>validateMouseMoveDrafts(removed,plan.changes),/destination changed/);
 }
 const data=observed();data.tables.locations[2].source_manager_name='Source only';data.tables.locations[2].source_cage_observation={managerName:'Source only'};
 assert.equal(Object.hasOwn(planMouseMoveToPosition(data,'M1','L3',{cageSid:'CAGE-NEW',sourceMatch}).changes[0].value,'manager'),false);
});

test('explicit linking carries position manager only when the cage has no assignment and validates its source',()=>{
 for(const manager of ['Selected caretaker','']){
  const data=fixture();data.tables.locations[2].manager=manager;data.tables.mice[0].manager='Individual caretaker';
  const before=structuredClone(data),plan=planCageMove(data,'C1','L3',{linkSourcePosition:true});
  const assignment=plan.changes.find(c=>c.field==='manager');assert.deepEqual(assignment,{type:'cages',id:'C1',field:'manager',base:null,value:manager,positionManager:{locationId:'L3'}});
  assert.deepEqual(data,before);const next=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(next.tables.cages[0].manager,manager);assert.equal(next.tables.mice[0].manager,'Individual caretaker');assert.deepEqual(sourcePositions(next.tables.locations),sourcePositions(data.tables.locations));
  assert.deepEqual(applyCageSheetDrafts(next,plan.changes,{at}),next);assert.ok(getMouseMoveReadDependencies(data,plan.changes).some(d=>d.type==='locations'&&d.id==='L3'));
  const changed=structuredClone(data);changed.tables.locations[2].manager='Different caretaker';assert.throws(()=>applyCageSheetDrafts(changed,plan.changes,{at}),/source position manager changed/);
  const changedCage=structuredClone(data);changedCage.tables.cages[0].manager='Concurrent assignment';assert.throws(()=>applyCageSheetDrafts(changedCage,plan.changes,{at}),/source position manager changed/);
 }
});

test('a source-card manager edit and its cage link or registration save together with stale-value protection',()=>{
 for(const manager of ['Selected caretaker','']){
  const data=fixture(),preview=structuredClone(data);preview.tables.locations[2].manager=manager;
  const managerDraft={type:'locations',id:'L3',field:'manager',base:null,value:manager};
  const changes=[managerDraft,...planCageMove(preview,'C1','L3',{linkSourcePosition:true}).changes];
  const next=applyCageSheetDrafts(data,changes,{at});assert.equal(next.tables.cages[0].manager,manager);assert.equal(next.tables.locations[2].manager,manager);assert.deepEqual(applyCageSheetDrafts(next,changes,{at}),next);
  const stale=structuredClone(data);stale.tables.locations[2].manager='Concurrent caretaker';assert.throws(()=>applyCageSheetDrafts(stale,changes,{at}),/source position manager changed/);
  assert.throws(()=>applyCageSheetDrafts(data,changes,{at,canEdit:type=>type!=='locations'}),/permission/);
  const source=observed(),sourcePreview=structuredClone(source);sourcePreview.tables.locations[2].manager=manager;
  const creation=[managerDraft,...planMouseMoveToPosition(sourcePreview,'M1','L3',{cageSid:'CAGE-NEW',sourceMatch}).changes];
  const registered=applyCageSheetDrafts(source,creation,{at});assert.equal(registered.tables.cages.find(c=>c.cage_sid==='CAGE-NEW').manager,manager);assert.equal(registered.tables.locations[2].manager,manager);assert.deepEqual(applyCageSheetDrafts(registered,creation,{at}),registered);
  const staleSource=structuredClone(source);staleSource.tables.locations[2].manager='Concurrent caretaker';assert.throws(()=>validateMouseMoveDrafts(staleSource,creation),/source position manager changed/);
 }
});

test('a manager carried by linking follows a further staged move and keeps its original source dependency',()=>{
 const data=fixture();data.tables.locations[2].manager='Selected caretaker';data.tables.locations.push({location_id:'L4',label:'B4',room_id:'R2',rack_id:'K2'});
 const link=planCageMove(data,'C1','L3',{linkSourcePosition:true}),assignment=link.changes.find(c=>c.field==='manager');
 const linked=applyCageSheetDrafts(data,link.changes,{at}),move=planCageMove(linked,'C1','L4');
 const changes=[...move.changes.map(c=>({...c,base:data.tables.cages[0][c.field]??null})),assignment];
 const next=applyCageSheetDrafts(data,changes,{at});assert.equal(next.tables.cages[0].location_id,'L4');assert.equal(next.tables.cages[0].manager,'Selected caretaker');assert.ok(getMouseMoveReadDependencies(data,changes).some(d=>d.type==='locations'&&d.id==='L3'));
 const returned=applyCageSheetDrafts(data,[assignment],{at});assert.equal(returned.tables.cages[0].location_id,'L1');assert.equal(returned.tables.cages[0].manager,'Selected caretaker');assert.ok(getMouseMoveReadDependencies(data,[assignment]).some(d=>d.type==='locations'&&d.id==='L3'));
 const stale=structuredClone(data);stale.tables.locations[2].manager='Concurrent caretaker';assert.throws(()=>applyCageSheetDrafts(stale,changes,{at}),/source position manager changed/);
});

test('ordinary cage moves and swaps never adopt destination managers or overwrite explicit cage assignments',()=>{
 const data=fixture();data.tables.locations[1].manager='Slot two';data.tables.locations[2].manager='Slot three';
 assert.ok(!planCageMove(data,'C1','L3').changes.some(c=>c.field==='manager'));
 assert.ok(!planCageMove(data,'C1','L2',{linkSourcePosition:true}).changes.some(c=>c.field==='manager'));
 for(const manager of ['Existing caretaker','']){
  data.tables.cages[0].manager=manager;const plan=planCageMove(data,'C1','L3',{linkSourcePosition:true});assert.ok(!plan.changes.some(c=>c.field==='manager'));
  const moved=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(moved.tables.cages[0].manager,manager);
 }
});

test('dated mouse events capture final cage placement and retain prior recorded IDs without changing identities or source history',()=>{
 const d=observed(),plan=planMouseMoveToPosition(d,'M1','L3',{cageSid:'CAGE-NEW',sourceMatch,effectiveDate:'2026-10-14'}),after=structuredClone(d);after.tables.cages.push(plan.changes[0].value);Object.assign(after.tables.mice[0],{cage_sid:'CAGE-NEW',cage_tag:'B3',cage_sheet_overrides:{cage_sid:true}});
 const event=buildMouseMoveEvent(d,after,plan.changes[1],{at,eventId:'MOVE-TEST'});assert.equal(event.mouse_sid,'M1');assert.equal(event.old_cage_sid,'LEGACY');assert.equal(event.cage_sid,'CAGE-NEW');assert.equal(event.event_date,'2026-10-14');assert.equal(event.room_id,'R2');assert.equal(event.location_label,'Room two / Rack two / B3');assert.equal(event.old_location_id,null);assert.equal(event.event_type,'cage_move');assert.equal(after.tables.mice[0].source_raw,d.tables.mice[0].source_raw);assert.deepEqual(after.tables.locations,d.tables.locations);assert.deepEqual(validateRecord('husbandry_events',event,after,null).errors,[]);
 assert.equal(buildMouseMoveEvent(after,after,plan.changes[1],{at}),null);
 const unassigned=fixture();unassigned.tables.mice[0].cage_sid=null;const change=planMouseMove(unassigned,'M1','C2').changes[0],assigned=structuredClone(unassigned);assigned.tables.mice[0].cage_sid='C2';const assignment=buildMouseMoveEvent(unassigned,assigned,change,{at:'2026-10-15T17:00:00Z',eventId:'MOVE-ASSIGN'});assert.equal(assignment.event_date,'2026-10-16');assert.equal(assignment.event_type,'cage_assignment');
 const future=structuredClone(change);future.mouseMove.effectiveDate='2026-10-17';assert.throws(()=>buildMouseMoveEvent(unassigned,assigned,future,{at}),/effective move date/);
 assigned.tables.mice[0].date_of_birth='2026-10-16';assert.throws(()=>buildMouseMoveEvent(unassigned,assigned,change,{at}),/DOB/);
});

test('completed move plus explicit identity edits retries only its exact guarded values',()=>{
 const d=fixture(),move=planMouseMove(d,'M1','C2').changes[0],dob={type:'mice',id:'M1',field:'date_of_birth',base:null,value:'2026-01-01'},after=structuredClone(d);
 Object.assign(after.tables.mice[0],{cage_sid:'C2',date_of_birth:dob.value,cage_sheet_overrides:{cage_sid:true,date_of_birth:true}});
 assert.equal(validateMouseMoveDrafts(after,[move,dob]),true);assert.equal(buildMouseMoveEvent(after,after,move,{at}),null);
 assert.throws(()=>validateMouseMoveDrafts(after,[move]),/identity fields/);
 assert.throws(()=>validateMouseMoveDrafts(after,[move,{...dob,base:'2025-01-01'}]),/identity fields/);
 assert.throws(()=>validateMouseMoveDrafts(after,[move,{...dob,value:'2026-02-01'}]),/identity fields/);
 delete after.tables.mice[0].cage_sheet_overrides.cage_sid;assert.throws(()=>validateMouseMoveDrafts(after,[move,dob]),/identity fields/);
});

test('ordinary source-matched cell edits include source observation and identity read guards',()=>{
 const d=observed(),deps=getMouseMoveReadDependencies(d,[{type:'mice',id:'M1',field:'ear_mark',base:'L0R1',value:'L1R1',sourceMatch}]);
 assert.deepEqual(new Set(deps.map(x=>x.type+':'+x.id)),new Set(['mice:M1','locations:L1','racks:K1','rooms:R1']));
});

test('explicit source mouse moves carry only known blank fields and record their source context',()=>{
 const d=observed(),mouse=d.tables.mice[0],animal=d.tables.locations[0].source_cage_observation.animals[0];
 mouse.ear_mark=null;animal.earMark='L0R0';animal.dateOfBirth='2026-06-01';const before=structuredClone(d),plan=planMouseMove(d,'M1','C2',{sourceMatch});
 assert.deepEqual(plan.changes.filter(c=>c.sourceFill).map(c=>[c.field,c.value]),[['ear_mark','L0R0'],['date_of_birth','2026-06-01'],['comment','Retain source note']]);assert.deepEqual(d,before);
 const next=applyCageSheetDrafts(d,plan.changes,{at});const saved=next.tables.mice[0];assert.equal(saved.ear_mark,'L0R0');assert.equal(saved.date_of_birth,'2026-06-01');assert.equal(saved.comment,'Retain source note');
 assert.equal(saved.cage_sheet_overrides.ear_mark,true);assert.deepEqual(sourcePositions(next.tables.locations),sourcePositions(d.tables.locations));assert.equal(next.tables.husbandry_events[0].source_observation.source_cell,'T10');assert.equal(next.tables.husbandry_events[0].source_observation.comment,'Retain source note');
 assert.deepEqual(applyCageSheetDrafts(next,plan.changes,{at}),next);
 const existing=structuredClone(d);Object.assign(existing.tables.mice[0],{comment:'Keep actual note',ear_mark:'L2R1',date_of_birth:'2026-06-01'});const preserved=applyCageSheetDrafts(existing,planMouseMove(existing,'M1','C2',{sourceMatch}).changes,{at});
 assert.equal(preserved.tables.mice[0].comment,'Keep actual note');assert.equal(preserved.tables.mice[0].ear_mark,'L2R1');assert.equal(preserved.tables.husbandry_events[0].source_observation.comment,'Retain source note');
 existing.tables.mice[0].ear_mark=null;existing.tables.mice[0].cage_sheet_overrides={ear_mark:true};assert.ok(!planMouseMove(existing,'M1','C2',{sourceMatch}).changes.some(c=>c.field==='ear_mark'),'manual blank is not refilled');
});

test('source field fills reject changed observations, concurrent actual edits and detached fill drafts',()=>{
 const d=observed();d.tables.mice[0].ear_mark=null;d.tables.locations[0].source_cage_observation.animals[0].earMark='L0R0';const plan=planMouseMove(d,'M1','C2',{sourceMatch});
 const changed=structuredClone(d);changed.tables.locations[0].source_cage_observation.animals[0].earMark='L1R1';assert.throws(()=>applyCageSheetDrafts(changed,plan.changes,{at}),/source details changed/);
 const remote=structuredClone(d);remote.tables.mice[0].comment='Concurrent saved note';assert.throws(()=>applyCageSheetDrafts(remote,plan.changes,{at}),/Changed by another editor/);
 assert.throws(()=>validateMouseMoveDrafts(d,plan.changes.filter(c=>c.sourceFill)),/require their staged/);
 const bad=structuredClone(plan.changes);bad.find(c=>c.sourceFill).value='L9R9';assert.throws(()=>validateMouseMoveDrafts(d,bad),/source details changed/);
});


test('renamed source-linked mouse moves against its retained source tag and records original evidence',()=>{
 const data=observed(),before=data.tables.mice[0];
 data.tables.mice[0]=prepareMouseCageSheetEdit(data,before,{...before,physical_tag:'P-RENAMED'});
 const raw=structuredClone(data.tables.locations),row=cageSheetAnimals(data,{position:data.tables.locations[0]})[0];
 assert.equal(row.tag,'P-RENAMED');assert.equal(row.sourceTag,'P001');assert.equal(row.mouseSid,'M1');
 const plan=planMouseMove(data,'M1','C2',{sourceMatch});assert.deepEqual(plan.changes[0].sourceMatch,sourceMatch);
 const after=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(after.tables.mice[0].physical_tag,'P-RENAMED');assert.equal(after.tables.mice[0].cage_sid,'C2');
 assert.deepEqual(sourcePositions(after.tables.locations),sourcePositions(raw));assert.equal(after.tables.husbandry_events.at(-1).source_observation.tag,'P001');
 const stale=structuredClone(data);stale.tables.locations[0].source_cage_observation.animals[0].note='Different occupant observation';
 const staleBefore=structuredClone(stale);assert.throws(()=>applyCageSheetDrafts(stale,plan.changes,{at}),/Animal match changed/);assert.deepEqual(stale,staleBefore);
 assert.throws(()=>planMouseMove(data,'M1','C2',{sourceMatch:{...sourceMatch,tag:'P-RENAMED'}}),/Animal match changed/);
});

function sourcePair(){
 const data=observed();data.tables.cages=[];Object.assign(data.tables.mice[1],{physical_tag:'E002',sex:'Female',cage_sid:'OTHER-LEGACY'});
 data.tables.locations[1].source_cage_observation={schemaVersion:1,animals:[{tag:'E002',sourceCell:'B10',note:'Second cage note',dateOfBirth:'2026-04-01',earMark:'L1R0'}]};
 data.tables.locations[0].manager='Vuong';data.tables.locations[1].manager='Lalitha';data.tables.mice[0].note_color='red';
 return data;
}
const sourceIds={L1:'NEW-ONE',L2:'NEW-TWO'};
test('whole source cage move registers one complete group at final destination and retains original observations',()=>{
 const data=sourcePair(),before=structuredClone(data),plan=planCageSlotMove(data,'L1','L3',{newCageIds:sourceIds});
 assert.equal(plan.kind,'move');assert.equal(plan.changes[0].value.location_id,'L3');assert.equal(plan.changes[0].value.cage_sheet_source_location_id,'L1');assert.equal(plan.changes[0].value.manager,'Vuong');
 assert.equal(validateMouseMoveDrafts(data,plan.changes),true);assert.deepEqual(data,before);
 const next=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(next.tables.cages.length,1);assert.equal(next.tables.cages[0].cage_tag,'B3');
 assert.equal(next.tables.mice[0].cage_sid,'NEW-ONE');assert.equal(next.tables.mice[0].note_color,'red');assert.equal(next.tables.mice[1].cage_sid,'OTHER-LEGACY');assert.equal(next.tables.mice[0].comment,'Retain source note');
 assert.deepEqual(next.tables.locations.map(p=>p.source_cage_observation),data.tables.locations.map(p=>p.source_cage_observation));assert.deepEqual(applyCageSheetDrafts(next,plan.changes,{at}),next);
});
test('two source-only cages swap full groups, caretakers and animal notes while slots retain lights and snapshots',()=>{
 const data=sourcePair();data.tables.light_events=[{event_id:'LIGHT',location_id:'L1',protocol:'LD'}];const plan=planCageSlotMove(data,'L1','L2',{newCageIds:sourceIds});
 assert.equal(plan.kind,'swap');assert.equal(validateMouseMoveDrafts(data,plan.changes),true);
 const next=applyCageSheetDrafts(data,plan.changes,{at});assert.deepEqual(next.tables.cages.map(c=>[c.cage_sid,c.location_id,c.manager,c.cage_sheet_source_location_id]),[['NEW-ONE','L2','Vuong','L1'],['NEW-TWO','L1','Lalitha','L2']]);
 assert.deepEqual(next.tables.mice.slice(0,2).map(m=>[m.mouse_sid,m.cage_sid,m.comment]),[['M1','NEW-ONE','Retain source note'],['M2','NEW-TWO','Second cage note']]);
 assert.equal(next.tables.mice[1].ear_mark,'L1R0');assert.equal(next.tables.mice[1].date_of_birth,'2026-04-01');assert.deepEqual(next.tables.light_events,data.tables.light_events);
 assert.deepEqual(next.tables.locations.map(p=>p.source_cage_observation),data.tables.locations.map(p=>p.source_cage_observation));assert.equal(next.tables.husbandry_events.length,4);
});
test('registered and source-only cages swap without replacing the registered stable cage ID',()=>{
 const data=observed();Object.assign(data.tables.mice[1],{sex:'Unknown'});const plan=planCageSlotMove(data,'L1','L2',{newCageIds:sourceIds});
 assert.equal(plan.kind,'swap');assert.equal(validateMouseMoveDrafts(data,plan.changes),true);
 const next=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(next.tables.cages.find(c=>c.cage_sid==='C2').location_id,'L1');assert.equal(next.tables.cages.find(c=>c.cage_sid==='NEW-ONE').location_id,'L2');assert.equal(next.tables.mice[1].cage_sid,'C2');
});
test('source whole-cage move rejects incomplete, duplicate, historical and uncertain groups without partial changes',()=>{
 for(const mutate of [d=>d.tables.locations[0].source_cage_observation.animals.push({tag:'Unknown',sourceCell:'T11'}),d=>d.tables.locations[0].source_cage_observation.animals.push({...d.tables.locations[0].source_cage_observation.animals[0]}),d=>d.tables.mice[0].state='Ended',d=>d.tables.mice[0].history_read_only=true,d=>d.tables.locations[0].source_historical=true,d=>d.tables.locations[2].source_cage_observation=structuredClone(d.tables.locations[0].source_cage_observation),d=>d.tables.mice.push({...d.tables.mice[0],mouse_sid:'DUPLICATE'})]){
  const data=sourcePair();mutate(data);const before=structuredClone(data);assert.throws(()=>planCageSlotMove(data,'L1','L2',{newCageIds:sourceIds}));assert.deepEqual(data,before);
 }
 assert.throws(()=>planCageSlotMove(sourcePair(),'L3','L1',{newCageIds:sourceIds}),/empty/);
 assert.equal(planCageSlotMove(sourcePair(),'L1','L1').kind,'noop');
});
test('whole group Save rejects changed members, source details and added destination animals',()=>{
 const data=sourcePair(),plan=planCageSlotMove(data,'L1','L2',{newCageIds:sourceIds});
 for(const mutate of [d=>d.tables.locations[0].source_cage_observation.animals=[],d=>d.tables.locations[1].source_cage_observation.animals.push({tag:'New',sourceCell:'B11'}),d=>d.tables.locations[0].source_cage_observation.animals[0].note='Changed',d=>d.tables.mice[0].cage_sid='CONCURRENT',d=>d.tables.locations[0].manager='Other']){
  const stale=structuredClone(data);mutate(stale);assert.throws(()=>validateMouseMoveDrafts(stale,plan.changes));
 }
 assert.throws(()=>validateMouseMoveDrafts(data,plan.changes.filter(c=>!(c.type==='mice'&&c.id==='M2'))),/incomplete/);
 assert.throws(()=>validateMouseMoveDrafts(data,plan.changes.map(c=>{const copy={...c};delete copy.cageSlotMove;return copy;})),/complete whole-cage/);
 const bad=structuredClone(plan.changes);bad[0].value.manager='Wrong';assert.throws(()=>validateMouseMoveDrafts(data,bad),/incomplete/);
});
test('whole registered cage moves guard membership and destination observations as well as locations',()=>{
 const data=fixture(),plan=planCageSlotMove(data,'L1','L3');assert.equal(plan.kind,'move');assert.equal(validateMouseMoveDrafts(data,plan.changes),true);
 const added=structuredClone(data);added.tables.mice.push({mouse_sid:'NEW',physical_tag:'P004',state:'Stock',cage_sid:'C1'});assert.throws(()=>validateMouseMoveDrafts(added,plan.changes),/occupants/);
 const newlyOccupied=structuredClone(data);newlyOccupied.tables.locations[2].source_cage_observation={schemaVersion:1,animals:[{tag:'Unmatched',sourceCell:'T22'}]};assert.throws(()=>validateMouseMoveDrafts(newlyOccupied,plan.changes),/unmatched/);
 const notes=structuredClone(data);notes.tables.mice[0].comment='Unrelated note';assert.equal(validateMouseMoveDrafts(notes,plan.changes),true);
 const deps=getMouseMoveReadDependencies(data,plan.changes);for(const key of ['mice:M1','cages:C1','locations:L1','locations:L3'])assert.ok(deps.some(d=>d.type+':'+d.id===key));
});


test('whole source registration carries literal source caretaker and exact start date, never destination values',()=>{
 const data=sourcePair();delete data.tables.locations[0].manager;
 Object.assign(data.tables.locations[0].source_cage_observation,{managerName:'Lalitha',startedDate:'2026-02-01'});data.tables.locations[2].manager='Destination person';
 data.tables.locations[2].source_cage_observation={schemaVersion:1,animals:[],managerName:'Destination person',startedDate:'2025-01-01'};
 const plan=planCageSlotMove(data,'L1','L3',{newCageIds:sourceIds}),created=plan.changes.find(c=>c.field==='$create').value;
 assert.equal(created.manager,'Lalitha');assert.equal(created.start_date,'2026-02-01');assert.equal(validateMouseMoveDrafts(data,plan.changes),true);
 const unset=structuredClone(data);unset.tables.locations[0].manager='';assert.equal(planCageSlotMove(unset,'L1','L3',{newCageIds:sourceIds}).changes[0].value.manager,'');
 const changed=structuredClone(data);changed.tables.locations[0].source_cage_observation.startedDate='2026-03-01';assert.throws(()=>validateMouseMoveDrafts(changed,plan.changes),/source details changed/);
});
test('registered source cage carries displayed blank animal details and source start when leaving its grid',()=>{
 const data=fixture();Object.assign(data.tables.mice[0],{sex:'Unknown',comment:null,ear_mark:null});
 data.tables.locations[0].source_cage_observation={schemaVersion:1,startedDate:'2026-05-01',animals:[{tag:'P001',sourceCell:'T10',note:'Source health note',dateOfBirth:'2026-04-01',earMark:'L1R2'}]};
 const plan=planCageSlotMove(data,'L1','L3');assert.equal(validateMouseMoveDrafts(data,plan.changes),true);
 assert.equal(plan.changes.find(c=>c.type==='cages'&&c.field==='start_date').value,'2026-05-01');
 assert.deepEqual(plan.changes.filter(c=>c.type==='mice').map(c=>[c.field,c.value]),[['ear_mark','L1R2'],['date_of_birth','2026-04-01'],['comment','Source health note']]);
 const next=applyCageSheetDrafts(data,plan.changes,{at});assert.equal(next.tables.cages[0].start_date,'2026-05-01');assert.equal(next.tables.mice[0].comment,'Source health note');assert.equal(cageSheetAnimals(next,{position:next.tables.locations[0]}).length,0);assert.equal(next.tables.mice[0].cage_sheet_overrides.cage_sid,true);assert.deepEqual(applyCageSheetDrafts(next,plan.changes,{at}),next);
 const stripped=plan.changes.map(c=>{const copy={...c};if(copy.wholeCageFill)delete copy.cageSlotMove;return copy;});assert.throws(()=>validateMouseMoveDrafts(data,stripped),/incomplete|complete whole-cage/);
});

test('whole cage refuses conflicting source details until an explicit mouse override selects the saved value',()=>{
 const data=sourcePair();data.tables.mice[0].comment='Previous saved note';
 assert.throws(()=>planCageSlotMove(data,'L1','L3',{newCageIds:sourceIds}),/note.*sheet and saved values differ/);
 data.tables.mice[0].cage_sheet_overrides={comment:true};assert.equal(validateMouseMoveDrafts(data,planCageSlotMove(data,'L1','L3',{newCageIds:sourceIds}).changes),true);
 delete data.tables.mice[0].comment;delete data.tables.mice[0].cage_sheet_overrides;
 data.tables.locations[0].source_cage_observation.animals[0].earMark='L2R1';assert.throws(()=>planCageSlotMove(data,'L1','L3',{newCageIds:sourceIds}),/earmark/);
 data.tables.mice[0].cage_sheet_overrides={ear_mark:true};assert.equal(planCageSlotMove(data,'L1','L3',{newCageIds:sourceIds}).kind,'move');
});
