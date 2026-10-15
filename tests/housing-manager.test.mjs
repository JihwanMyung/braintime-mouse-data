import test from 'node:test';
import assert from 'node:assert/strict';

let instance=0;
async function housing(tables,hooks={}) {
  const {renderHousing}=await import(`../web/husbandry.js?housing-manager-test=${++instance}`);
  const container={innerHTML:''};
  const dataset={tables:{mice:[],cages:[],rooms:[],racks:[],locations:[],light_events:[],...tables}};
  const failures=[];
  renderHousing(container,dataset,{canEdit:()=>true,toast:message=>failures.push(message),...hooks});
  return {container,dataset,failures};
}
const cage=(cage_sid,extra={})=>({cage_sid,state:'Active',...extra});
const mouse=(mouse_sid,cage_sid,extra={})=>({mouse_sid,cage_sid,state:'Stock',...extra});
const cards=html=>[...html.matchAll(/<article class="cage-card">([\s\S]*?)<\/article>/g)].map(m=>m[1]);
const card=(html,id)=>cards(html).find(s=>s.includes(`data-housing-cage="${id}"`));

test('housing displays explicit or imported managers and safely escapes their names',async()=>{
  const {container,dataset}=await housing({cages:[cage('C-OWNER',{owner:'Recorded caretaker'}),cage('C-EDIT',{owner:'Old owner',manager:'<b>New & assigned</b>'})]});
  assert.match(card(container.innerHTML,'C-OWNER'),/Recorded caretaker/);
  assert.match(card(container.innerHTML,'C-OWNER'),/>Assigned<\/span>/);
  assert.match(card(container.innerHTML,'C-EDIT'),/&lt;b&gt;New &amp; assigned&lt;\/b&gt;/);
  assert.doesNotMatch(card(container.innerHTML,'C-EDIT'),/Old owner|<b>New/);
  assert.equal(dataset.tables.cages[1].owner,'Old owner','source owner remains intact');
});

test('housing visibly distinguishes unassigned, conflicting and incomplete resident assignments',async()=>{
  const {container}=await housing({
    cages:[cage('C-CLEARED',{manager:null,owner:'Previous owner'}),cage('C-CONFLICT'),cage('C-INCOMPLETE'),cage('C-RESIDENT')],
    mice:[mouse('M1','C-CONFLICT',{manager:'Person A'}),mouse('M2','C-CONFLICT',{manager:'Person B'}),mouse('M3','C-INCOMPLETE',{owner:'Person A'}),mouse('M4','C-INCOMPLETE'),mouse('M5','C-RESIDENT',{manager:'Current caretaker'}),mouse('M6','C-RESIDENT',{manager:'Former caretaker',state:'Ended'}),mouse('M7','C-RESIDENT',{manager:'Archived caretaker',app_archived_at:'2026-01-01'})]
  });
  assert.match(card(container.innerHTML,'C-CLEARED'),/Needs manager/);
  assert.doesNotMatch(card(container.innerHTML,'C-CLEARED'),/Previous owner/);
  assert.match(card(container.innerHTML,'C-CONFLICT'),/Manager conflict/);
  assert.match(card(container.innerHTML,'C-CONFLICT'),/Residents: Person A · Person B/);
  assert.match(card(container.innerHTML,'C-INCOMPLETE'),/Needs manager/);
  assert.match(card(container.innerHTML,'C-INCOMPLETE'),/Some residents unassigned/);
  assert.match(card(container.innerHTML,'C-RESIDENT'),/Current caretaker/);
  assert.doesNotMatch(card(container.innerHTML,'C-RESIDENT'),/Former caretaker|Archived caretaker|Manager conflict/);
});

test('housing search finds resident managers and assignment status',async()=>{
  const priorDocument=globalThis.document;
  globalThis.document={getElementById:()=>({focus(){},setSelectionRange(){}})};
  try {
    const {container}=await housing({cages:[cage('C-ASSIGNED'),cage('C-MISSING')],mice:[mouse('M1','C-ASSIGNED',{manager:'Synthetic caretaker'})]});
    const search=async value=>{container.oninput({target:{id:'housing-search',value,selectionStart:value.length}});await new Promise(resolve=>setTimeout(resolve,220))};
    await search('synthetic caretaker');
    assert.equal(cards(container.innerHTML).length,1);
    assert(card(container.innerHTML,'C-ASSIGNED'));
    await search('needs manager');
    assert.equal(cards(container.innerHTML).length,1);
    assert(card(container.innerHTML,'C-MISSING'));
  } finally {globalThis.document=priorDocument}
});

test('cage print action dispatches its ID, while unlinked source positions have no manager or print action',async()=>{
  const printed=[];
  const {container,dataset,failures}=await housing({
    cages:[cage('C-PRINT',{manager:'Caretaker'})],
    locations:[{location_id:'P-UNLINKED',label:'A1',source_block_text:'Synthetic source note',owner:'Unverified source name'}]
  },{printCage:id=>printed.push(id)});
  const before=JSON.stringify(dataset);
  assert.match(card(container.innerHTML,'C-PRINT'),/Print cage card/);
  const unlinked=container.innerHTML.match(/<article class="cage-card position-card">([\s\S]*?)<\/article>/)[1];
  assert.doesNotMatch(unlinked,/cage-manager|Print cage card|Unverified source name/);
  container.onclick({target:{closest:()=>({dataset:{housingPrintCage:'C-PRINT'}})}});
  await Promise.resolve();
  assert.deepEqual(printed,['C-PRINT']);
  assert.deepEqual(failures,[]);
  assert.equal(JSON.stringify(dataset),before,'rendering and printing do not modify records');
});

test('read-only housing retains browsing and printing without mutation controls',async()=>{
  const printed=[],opened=[];
  let saves=0;
  const {container,failures}=await housing({
    cages:[cage('C-READ')],mice:[mouse('M-READ','C-READ')],
    rooms:[{room_id:'R1',name:'Read room'},{room_id:'R-OLD',name:'Archived room',app_archived_at:'2026-01-01'}],
    racks:[{rack_id:'K1',room_id:'R1',name:'Read rack'}],
    locations:[{location_id:'P1',room_id:'R1',rack_id:'K1',label:'Read position'}],
    light_events:[{event_id:'L1',protocol:'LD',start_date:'2026-01-01'}],
    husbandry_events:[{event_id:'H1',event_type:'Observation',event_date:'2026-01-01'}]
  },{canEdit:()=>false,printCage:id=>printed.push(id),openCage:id=>opened.push(id),save:()=>{saves++}});
  const noMutationControls=()=>assert.doesNotMatch(container.innerHTML,/data-housing-action="(?:new|link-position)"|data-housing-link-position=|data-housing-edit=|id="housing-(?:save|archive)"/);
  noMutationControls();
  assert.match(container.innerHTML,/Read position/);
  assert.match(container.innerHTML,/Print cage card/);
  container.onclick({target:{closest:()=>({dataset:{housingPrintCage:'C-READ'}})}});
  container.onclick({target:{closest:()=>({dataset:{housingCage:'C-READ'}})}});
  await Promise.resolve();
  assert.deepEqual(printed,['C-READ']);assert.deepEqual(opened,['C-READ']);
  for(const tab of ['rooms','racks','locations','light_events','husbandry_events']){
    container.onclick({target:{closest:()=>({dataset:{housingTab:tab}})}});
    noMutationControls();
    assert.match(container.innerHTML,/<tbody><tr>/,'existing records remain readable');
  }
  container.onclick({target:{closest:()=>({dataset:{housingTab:'rooms'}})}});
  container.onchange({target:{id:'housing-archived',checked:true}});
  assert.match(container.innerHTML,/Archived room/);noMutationControls();
  container.onclick({target:{closest:()=>({dataset:{housingEdit:'R1',type:'rooms'}})}});
  container.onclick({target:{closest:()=>({dataset:{housingLinkPosition:'P1'}})}});
  await Promise.resolve();await Promise.resolve();
  assert.equal(saves,0);
  assert.equal(failures.length,2);
  assert(failures.every(message=>message.includes('read only')));
});

test('registered cages show current position manager, recording start and lux before an old imported owner',async()=>{
 const observation={schemaVersion:1,managerName:'Vuong',managerCell:'W6',startedDate:'2026-01-01',startedCell:'T13',intensityLux:150,intensityCell:'U13',animals:[]};
 const position={location_id:'LOC34',label:'L34',manager:'Vuong Truong',source_current:true,source_cage_observation:observation};
 const {container,dataset}=await housing({cages:[cage('C34',{owner:'Jihwan',location_id:'LOC34'})],locations:[position],mice:[mouse('M34','C34')]});
 const html=card(container.innerHTML,'C34');assert.match(html,/<strong>Vuong<\/strong>/);assert.match(html,/Started 2026-01-01 · \d+wk · 150 lux/);assert.doesNotMatch(html,/Jihwan|Manager · Animal Sheet|Source-listed animals/);
 assert.equal(dataset.tables.cages[0].owner,'Jihwan');assert.equal(dataset.tables.cages[0].manager,undefined);assert.deepEqual(dataset.tables.locations[0].source_cage_observation,observation);
});

test('explicit cage manager including a cleared assignment takes precedence over position observations',async()=>{
 const locations=['P1','P2'].map(location_id=>({location_id,label:location_id,source_current:true,source_cage_observation:{schemaVersion:1,managerName:'Source caretaker',animals:[],startedDate:'2026-01-01',intensityLux:0}}));
 const {container}=await housing({cages:[cage('EXPLICIT',{manager:'Assigned caretaker',owner:'Old owner',location_id:'P1'}),cage('CLEARED',{manager:null,owner:'Old owner',location_id:'P2'})],locations});
 assert.match(card(container.innerHTML,'EXPLICIT'),/<strong>Assigned caretaker<\/strong>/);assert.doesNotMatch(card(container.innerHTML,'EXPLICIT'),/Source caretaker|Old owner/);
 assert.match(card(container.innerHTML,'CLEARED'),/Needs manager/);assert.doesNotMatch(card(container.innerHTML,'CLEARED'),/Source caretaker|Old owner/);assert.match(card(container.innerHTML,'EXPLICIT'),/0 lux/);
});

test('manual position managers override observations and withdrawn position data never replaces registered cage owner',async()=>{
 const observation={schemaVersion:1,managerName:'Source caretaker',animals:[],startedDate:'2026-01-01',intensityLux:150};
 const {container}=await housing({cages:[cage('MANUAL',{owner:'Old owner',location_id:'P1'}),cage('WITHDRAWN',{owner:'Recorded caretaker',location_id:'P2'})],locations:[{location_id:'P1',label:'L1',manager:'Manual caretaker',app_modified_at:'2026-10-16T00:00:00Z',source_cage_observation:observation},{location_id:'P2',label:'L2',source_current:false,source_cage_observation:observation}]});
 assert.match(card(container.innerHTML,'MANUAL'),/<strong>Manual caretaker<\/strong>/);assert.doesNotMatch(card(container.innerHTML,'MANUAL'),/Source caretaker|Old owner/);
 assert.match(card(container.innerHTML,'WITHDRAWN'),/Recorded caretaker/);assert.doesNotMatch(card(container.innerHTML,'WITHDRAWN'),/Source caretaker|Started 2026-01-01|150 lux/);
});
