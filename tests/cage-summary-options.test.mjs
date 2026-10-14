import test from 'node:test';
import assert from 'node:assert/strict';
import { CAGE_SUMMARY_GROUPS, getCageSummaryOptions, getCageSummaryOptionsStatus, validateCageSummaryOptions, buildCageSummaryOptions, renderCageSummaryOptions } from '../web/cage-summary-options.js';

const empty=()=>({tables:{rooms:[
  {room_id:'BEH',name:'SH Animal Beh'},
  {room_id:'RAT-1',name:'Rat Room (LocoBoxes)'},
  {room_id:'RAT-2',name:'Rat room6'},
  {room_id:'SPF',name:'SHLAC-SPF Room6'},
  {room_id:'CLEAN',name:'Clean room'},
  {room_id:'OTHER',name:'Conventional room'}
],mice:[{mouse_sid:'SYNTHETIC-1'}],husbandry_events:[{event_id:'NOTE',event_type:'note',notes:'Keep me'}]}});
const clock={now:'2025-03-05T09:00:00Z',eventDate:'2025-03-05'};
const make=(extra={},dataset=empty())=>{
  const input=getCageSummaryOptions(dataset);
  for(const [key,value]of Object.entries(extra))input.groups[key]={...input.groups[key],...value};
  return buildCageSummaryOptions(dataset,input,clock);
};

test('defaults infer explicit room names only, and keep capacities and box counting unknown',()=>{
  const dataset=empty(),before=structuredClone(dataset),value=getCageSummaryOptions(dataset);
  assert.deepEqual(value,{schema_version:1,groups:{beh:{room_ids:['BEH'],capacity:null,locobox_mode:'unknown'},rat:{room_ids:['RAT-1','RAT-2'],capacity:null,locobox_mode:'unknown'},clean:{room_ids:['CLEAN'],capacity:null},spf:{room_ids:['SPF'],capacity:null}}});
  assert.deepEqual(dataset,before);assert.equal(getCageSummaryOptionsStatus(dataset),'default');assert.equal(getCageSummaryOptionsStatus(null),'default');
  assert.deepEqual(CAGE_SUMMARY_GROUPS.map(group=>group.unit),['locoboxes','locoboxes','cages','cages']);
  value.groups.beh.room_ids.push('OTHER');value.groups.spf.capacity=100;
  assert.deepEqual(getCageSummaryOptions(dataset).groups.beh.room_ids,['BEH']);assert.equal(getCageSummaryOptions(dataset).groups.spf.capacity,null);
  assert.deepEqual(getCageSummaryOptions(null).groups.clean,{room_ids:[],capacity:null});
});

test('ambiguous, archived, conventional and arbitrary names are not assigned by inference',()=>{
  const dataset=empty();dataset.tables.rooms=[
    {room_id:'ARCHIVED',name:'Animal Beh',archived:true},
    {room_id:'ARCHIVED2',name:'SPF room',app_archived_at:'2025-03-05'},
    {room_id:'DUPLICATE',name:'Rat Room'},{room_id:'DUPLICATE',name:'Clean room'},
    {room_id:'CONV',name:'Conventional room'},{room_id:'UNSPECIFIED',name:'Room6'},
    {room_id:'NON-SPF',name:'Non SPF room'},{room_id:'NOT-BEH',name:'Animal behavior testing'}
  ];
  assert.ok(Object.values(getCageSummaryOptions(dataset).groups).every(group=>group.room_ids.length===0));
  dataset.tables.rooms=[{room_id:'A',name:'  Animal   Beh '},{room_id:'B',name:'Rat Room'},{room_id:'C',name:'SPF room 12'},{room_id:'D',name:'Clean room 2'}];
  assert.deepEqual(Object.values(getCageSummaryOptions(dataset).groups).map(group=>group.room_ids),[['A'],['B'],['D'],['C']]);
});

test('current source aliases match punctuation explicitly without widening name inference',()=>{
  const dataset=empty();dataset.tables.rooms=[
    {room_id:'RAT-SOURCE',name:'Rat Room (LocoBoxes), Rat room 6'},
    {room_id:'SPF-SOURCE',name:'SHLAC-SPF, Room 6'},
    {room_id:'OLD-RAT',name:'Old Rat Room'},
    {room_id:'OLD-SPF',name:'Old SHLAC-SPF, Room 6'},
    {room_id:'CONVENTIONAL',name:'Conventional room'},
    {room_id:'RAT-NOTES',name:'Rat Room (LocoBoxes), storage'},
    {room_id:'SPF-NOTES',name:'SHLAC-SPF, Room 6 old'}
  ];
  const options=getCageSummaryOptions(dataset);
  assert.deepEqual(options.groups.rat.room_ids,['RAT-SOURCE']);
  assert.deepEqual(options.groups.spf.room_ids,['SPF-SOURCE']);
  assert.deepEqual(options.groups.clean.room_ids,[]);
  assert.equal(options.groups.rat.capacity,null);
  assert.equal(options.groups.rat.locobox_mode,'unknown');
});

test('immutable shared upsert retains provenance, nested metadata, unrelated rows and creation time',()=>{
  const original=empty(),before=structuredClone(original),first=make({beh:{capacity:0,locobox_mode:'position'},rat:{capacity:24,locobox_mode:'box_id'},spf:{capacity:120}},original);
  assert.deepEqual(original,before);assert.deepEqual(first.dataset.tables.mice,before.tables.mice);assert.deepEqual(first.dataset.tables.husbandry_events[0],before.tables.husbandry_events[0]);
  assert.equal(first.record.event_id,'CAGE-SUMMARY-OPTIONS');assert.equal(first.record.event_type,'cage_summary_options');assert.equal(first.record.event_date,clock.eventDate);
  first.record.source_file='source';first.record.cage_summary_options.extra_metadata='keep';first.record.cage_summary_options.groups.beh.notes='physical inventory';
  const input=getCageSummaryOptions(first.dataset);input.groups.clean.capacity=15;
  const second=buildCageSummaryOptions(first.dataset,input,{now:'2025-03-06T09:00:00Z',eventDate:'2025-03-06'});
  assert.equal(second.dataset.tables.husbandry_events.length,2);assert.equal(second.record.source_file,'source');assert.equal(second.record.cage_summary_options.extra_metadata,'keep');assert.equal(second.record.cage_summary_options.groups.beh.notes,'physical inventory');
  assert.equal(second.record.app_created_at,first.record.app_created_at);assert.notEqual(second.record.app_modified_at,first.record.app_modified_at);assert.equal(first.record.cage_summary_options.groups.clean.capacity,null);
  assert.equal(getCageSummaryOptions(second.dataset).groups.beh.capacity,0);assert.equal(getCageSummaryOptions(second.dataset).groups.clean.capacity,15);assert.equal(getCageSummaryOptionsStatus(second.dataset),'saved');
});

test('capacity validation distinguishes unknown, zero and whole finite nonnegative capacities',()=>{
  for(const key of ['beh','rat','clean','spf']){
    for(const capacity of [undefined,'8',NaN,Infinity,-1,0.5,100001,false])assert.throws(()=>make({[key]:{capacity}}),/whole number/);
    for(const capacity of [null,0,100000])assert.equal(make({[key]:{capacity}}).record.cage_summary_options.groups[key].capacity,capacity);
  }
  for(const locobox_mode of [null,undefined,'rack','',1])assert.throws(()=>make({beh:{locobox_mode}}),/supported locobox/);
  for(const locobox_mode of ['unknown','position','box_id'])assert.equal(make({rat:{locobox_mode}}).record.cage_summary_options.groups.rat.locobox_mode,locobox_mode);
});

test('room assignments reject missing, archived, duplicate and invalid references',()=>{
  assert.throws(()=>make({beh:{room_ids:['MISSING']}}),/existing, unarchived room/);
  for(const archived of [{archived:true},{app_archived_at:'2025-03-06'}]){
    const dataset=empty();Object.assign(dataset.tables.rooms[0],archived);assert.throws(()=>make({beh:{room_ids:['BEH']}},dataset),/existing, unarchived room/);
  }
  const duplicate=empty();duplicate.tables.rooms.push({...duplicate.tables.rooms[0]});assert.throws(()=>make({beh:{room_ids:['BEH']}},duplicate),/unique ID/);
  assert.throws(()=>make({beh:{room_ids:['BEH','BEH']}}),/assigned only once/);
  assert.throws(()=>make({rat:{room_ids:['BEH']}}),/assigned only once/);
  for(const room_ids of [undefined,null,'BEH',[null],[1],[''],['   ']])assert.throws(()=>make({beh:{room_ids}}),/room IDs must be an array/);
  assert.deepEqual(make({clean:{room_ids:[]}}).record.cage_summary_options.groups.clean.room_ids,[]);
});

test('validation retains identity and rejects malformed schema, nested groups and dates',()=>{
  const old=make().record;
  assert.deepEqual(validateCageSummaryOptions({event_type:'unrelated'}),[]);
  assert.match(validateCageSummaryOptions({...old,event_type:'note'},old).join(' '),/retain/);
  assert.match(validateCageSummaryOptions({...old,event_id:'OTHER'},old).join(' '),/stable.*ID.*cannot change/);
  assert.match(validateCageSummaryOptions({...old,cage_summary_options:null}).join(' '),/required/);
  assert.match(validateCageSummaryOptions({...old,cage_summary_options:{...old.cage_summary_options,schema_version:2}}).join(' '),/version/);
  assert.match(validateCageSummaryOptions({...old,cage_summary_options:{schema_version:1,groups:null}}).join(' '),/groups are required/);
  assert.match(validateCageSummaryOptions({...old,cage_summary_options:{schema_version:1,groups:{}}}).join(' '),/options are required/);
  assert.throws(()=>buildCageSummaryOptions(empty(),getCageSummaryOptions(empty()),{eventDate:'2025-02-29'}),/valid cage-options date/);
  assert.throws(()=>buildCageSummaryOptions(empty(),getCageSummaryOptions(empty()),{now:'invalid'}),/valid modification time/);
});

test('colliding, duplicate and archived option records cannot be silently replaced',()=>{
  const saved=make({spf:{capacity:120}}).record;
  for(const [rows,pattern]of [
    [[{event_id:'CAGE-SUMMARY-OPTIONS',event_type:'note'}],/already used/],
    [[saved,structuredClone(saved)],/Duplicate/],
    [[{...saved,event_id:'OTHER'}],/stable CAGE-SUMMARY-OPTIONS ID/],
    [[{...saved,app_archived_at:'2025-03-06'}],/archived/],
    [[{...saved,archived:true}],/archived/]
  ]){
    const dataset=empty();dataset.tables.husbandry_events=rows;
    assert.equal(getCageSummaryOptionsStatus(dataset),'invalid');assert.equal(getCageSummaryOptions(dataset).groups.spf.capacity,null);assert.throws(()=>make({},dataset),pattern);
  }
});

test('saved options become invalid when room references disappear or are archived',()=>{
  const built=make({spf:{capacity:120}});
  for(const mutation of [
    dataset=>{dataset.tables.rooms=dataset.tables.rooms.filter(room=>room.room_id!=='SPF')},
    dataset=>{dataset.tables.rooms.find(room=>room.room_id==='SPF').archived=true},
    dataset=>{dataset.tables.rooms.push({...dataset.tables.rooms.find(room=>room.room_id==='SPF')})},
    dataset=>{dataset.tables.husbandry_events[1].event_date='2025-02-31'},
    dataset=>{dataset.tables.husbandry_events[1].cage_summary_options.groups.beh.locobox_mode='invalid'}
  ]){
    const dataset=structuredClone(built.dataset);mutation(dataset);
    assert.equal(getCageSummaryOptionsStatus(dataset),'invalid');assert.equal(getCageSummaryOptions(dataset).groups.spf.capacity,null);
  }
});

function harness(overrides={},initial=empty()) {
  const container={innerHTML:''},saves=[],messages=[];let dataset=initial;
  const hooks={canEdit:()=>true,saveDataset:async next=>{saves.push(structuredClone(next));dataset=next},reloadDataset:async()=>dataset,toast:(message,error=false)=>messages.push({message,error}),...overrides};
  renderCageSummaryOptions(container,dataset,hooks);
  return {container,hooks,saves,messages,get dataset(){return dataset},
    field(group,field,value){container.oninput({target:{value,dataset:{cageSummaryGroup:group,cageSummaryField:field}}})},
    room(group,id,checked){container.onchange({target:{checked,dataset:{cageSummaryGroup:group,cageSummaryField:'room_ids',roomId:id}}})},
    async save(){let prevented=false;await container.onsubmit({target:{matches:selector=>selector==='[data-cage-summary-options-form]'},preventDefault(){prevented=true}});assert.ok(prevented)},
    render(next=dataset){dataset=next;renderCageSummaryOptions(container,dataset,hooks)}
  };
}

test('form saves rooms, zero capacity, unknown capacity and locobox mode to the shared dataset',async()=>{
  const h=harness();assert.match(h.container.innerHTML,/data-cage-summary-options-form novalidate/);assert.match(h.container.innerHTML,/type="submit" class="button primary"/);
  h.field('beh','capacity','0');h.field('beh','locobox_mode','position');h.field('rat','capacity','  ');h.field('spf','capacity','120');h.room('clean','OTHER',true);
  await h.save();assert.equal(h.saves.length,1);assert.deepEqual(h.dataset.tables.mice,[{mouse_sid:'SYNTHETIC-1'}]);assert.equal(h.dataset.tables.husbandry_events[0].notes,'Keep me');
  const value=getCageSummaryOptions(h.dataset);assert.equal(value.groups.beh.capacity,0);assert.equal(value.groups.beh.locobox_mode,'position');assert.equal(value.groups.rat.capacity,null);assert.deepEqual(value.groups.clean.room_ids,['CLEAN','OTHER']);
  assert.match(h.container.innerHTML,/Cage capacity options saved/);
  const reopened={innerHTML:''};renderCageSummaryOptions(reopened,structuredClone(h.dataset),h.hooks);
  assert.match(reopened.innerHTML,/name="spf_capacity"[^>]*value="120"/);assert.match(reopened.innerHTML,/option value="position" selected/);
  assert.match(reopened.innerHTML,/physical locoboxes/);assert.match(reopened.innerHTML,/capacity means cage slots, not mice per cage/);
});

test('unchecking rooms and repeated checkbox events keep room assignments unique',async()=>{
  const h=harness();h.room('rat','RAT-2',false);h.room('rat','RAT-1',true);h.room('rat','RAT-1',true);await h.save();
  assert.deepEqual(getCageSummaryOptions(h.dataset).groups.rat.room_ids,['RAT-1']);
  h.room('rat','BEH',true);await h.save();assert.equal(h.saves.length,1);assert.match(h.container.innerHTML,/assigned only once/);
});

test('invalid saved settings visibly warn editors and viewers without inventing capacities',()=>{
  const saved=make().record;
  for(const rows of [[saved,saved],[{...saved,archived:true}],[{event_id:'CAGE-SUMMARY-OPTIONS',event_type:'note'}]]){
    const dataset=empty();dataset.tables.husbandry_events=rows;
    for(const editable of [true,false])assert.match(harness({canEdit:()=>editable},dataset).container.innerHTML,/role="alert">Saved cage options could not be used/);
  }
  assert.doesNotMatch(harness().container.innerHTML,/Saved cage options could not be used/);
});

test('read-only and revoked permissions prevent edits and forged submissions',async()=>{
  const readonly=harness({canEdit:()=>false});assert.match(readonly.container.innerHTML,/Read only/);assert.doesNotMatch(readonly.container.innerHTML,/<input|<form|<select/);
  readonly.field('spf','capacity','120');readonly.room('clean','OTHER',true);await readonly.save();assert.equal(readonly.saves.length,0);assert.match(readonly.container.innerHTML,/Edit access is required/);
  let editable=true;const revoked=harness({canEdit:()=>editable,reloadDataset:async()=>{editable=false;return empty()}});
  revoked.field('spf','capacity','120');await revoked.save();assert.equal(revoked.saves.length,0);assert.match(revoked.container.innerHTML,/Edit access is required/);
});

test('stale options are rejected and preserve drafts, while unrelated data survives a refresh',async()=>{
  const h=harness();h.field('spf','capacity','120');h.hooks.reloadDataset=async()=>make({spf:{capacity:100}}).dataset;
  await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/changed while you were editing/);assert.match(h.container.innerHTML,/name="spf_capacity"[^>]*value="120"/);
  const safe=harness();safe.field('spf','capacity','120');const latest=empty();latest.tables.mice.push({mouse_sid:'SYNTHETIC-2'});safe.hooks.reloadDataset=async()=>latest;
  await safe.save();assert.equal(safe.saves.length,1);assert.equal(safe.saves[0].tables.mice.length,2);
});

test('rooms archived during editing are revalidated after refresh and cannot save',async()=>{
  const h=harness();h.field('spf','capacity','120');h.hooks.reloadDataset=async()=>{const latest=empty();latest.tables.rooms.find(room=>room.room_id==='SPF').archived=true;return latest};
  await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/existing, unarchived room/);assert.match(h.container.innerHTML,/name="spf_capacity"[^>]*value="120"/);
});

test('invalid capacity and network errors preserve drafts and escape unsafe content',async()=>{
  let reloads=0;const h=harness({reloadDataset:async()=>{reloads++;return empty()}});
  h.field('spf','capacity','1.5');await h.save();assert.equal(h.saves.length,0);assert.equal(reloads,0);assert.match(h.container.innerHTML,/whole number/);
  h.field('spf','capacity','120');h.hooks.saveDataset=async()=>{throw new Error('<script>Network failed</script>')};await h.save();
  assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/name="spf_capacity"[^>]*value="120"/);assert.match(h.container.innerHTML,/&lt;script&gt;Network failed&lt;\/script&gt;/);assert.doesNotMatch(h.container.innerHTML,/<script>|aria-busy="true"/);
});

test('pending saves disable controls and ignore duplicate submits and edits',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve});let saves=0;
  const h=harness({saveDataset:async()=>{saves++;await pending}});h.field('spf','capacity','120');const saving=h.save();
  await new Promise(resolve=>setImmediate(resolve));assert.match(h.container.innerHTML,/aria-busy="true"/);await h.save();h.field('spf','capacity','150');h.room('clean','OTHER',true);
  finish();await saving;assert.equal(saves,1);assert.match(h.container.innerHTML,/name="spf_capacity"[^>]*value="120"/);assert.doesNotMatch(h.container.innerHTML,/aria-busy="true"/);
});
