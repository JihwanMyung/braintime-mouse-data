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

test('defaults infer explicit room names, keep capacities unknown, and count one LocoBox per occupied cage',()=>{
  const dataset=empty(),before=structuredClone(dataset),value=getCageSummaryOptions(dataset);
  assert.deepEqual(value,{schema_version:1,groups:{beh:{room_ids:['BEH'],capacity:null,locobox_mode:'cage',temporary_storage_location_ids:[]},rat:{room_ids:['RAT-1','RAT-2'],capacity:null,locobox_mode:'cage'},clean:{room_ids:['CLEAN'],capacity:null},spf:{room_ids:['SPF'],capacity:null}}});
  assert.deepEqual(dataset,before);assert.equal(getCageSummaryOptionsStatus(dataset),'default');assert.equal(getCageSummaryOptionsStatus(null),'default');
  assert.deepEqual(CAGE_SUMMARY_GROUPS.map(group=>group.unit),['locoboxes','locoboxes','cage grids','cage grids']);
  assert.deepEqual(CAGE_SUMMARY_GROUPS.map(group=>group.label),['Animal Beh locobox','SHLAC Rat room','SHLAC Conventional','SHLAC SPF']);
  value.groups.beh.room_ids.push('OTHER');value.groups.spf.capacity=100;
  assert.deepEqual(getCageSummaryOptions(dataset).groups.beh.room_ids,['BEH']);assert.equal(getCageSummaryOptions(dataset).groups.spf.capacity,null);
  assert.deepEqual(getCageSummaryOptions(null).groups.clean,{room_ids:[],capacity:null});
});

test('SH LAC Conventional aliases map to Clean room without inferring capacities or matching other conventional spaces',()=>{
 const dataset=empty();dataset.tables.rooms=[
  {room_id:'LAC-1',name:'SHLAC-Conventional, Mouse Room #2'},
  {room_id:'LAC-2',name:'SH LAC Conventional'},
  {room_id:'LAC-3',name:' sh  lac - conventional ,  mouse room # 2 '},
  {room_id:'OTHER',name:'Conventional room'},
  {room_id:'OLD',name:'Old SH LAC Conventional'},
  {room_id:'STORAGE',name:'SH LAC Conventional storage'},
  {room_id:'RAT',name:'SHLAC-Conventional, Rat Room #2'},
  {room_id:'ARCHIVED',name:'SH LAC Conventional',archived:true}
 ];
 const before=structuredClone(dataset),value=getCageSummaryOptions(dataset);
 assert.deepEqual(value.groups.clean,{room_ids:['LAC-1','LAC-2','LAC-3'],capacity:null});
 assert(CAGE_SUMMARY_GROUPS.every(({key})=>value.groups[key].capacity===null));assert.deepEqual(dataset,before);
});

test('saved explicit mappings and verified capacities take precedence over Conventional alias suggestions',()=>{
 const dataset=empty();dataset.tables.rooms.push({room_id:'LAC',name:'SHLAC-Conventional, Mouse Room #2'});
 const input=getCageSummaryOptions(dataset);input.groups.clean.room_ids=['CLEAN'];input.groups.clean.capacity=18;input.groups.beh.capacity=36;input.groups.rat.capacity=24;
 const built=buildCageSummaryOptions(dataset,input,clock),before=structuredClone(built.dataset);
 assert.deepEqual(getCageSummaryOptions(built.dataset),input);assert.deepEqual(built.dataset,before);assert.equal(getCageSummaryOptionsStatus(built.dataset),'saved');
 const explicit=getCageSummaryOptions(built.dataset);explicit.groups.clean.room_ids=[];
 assert.deepEqual(getCageSummaryOptions(buildCageSummaryOptions(built.dataset,explicit,clock).dataset).groups.clean,{room_ids:[],capacity:18});
});

test('new SHLAC room names and legacy aliases retain the same room groups',()=>{
 const data=empty();data.tables.rooms=[
  {room_id:'R1',name:'SHLAC Rat room'},{room_id:'R2',name:' sh lac - rat room '},{room_id:'R3',name:'Rat Room (LocoBoxes), Rat room 6'},
  {room_id:'C1',name:'SHLAC Conventional'},{room_id:'C2',name:'Clean room'},
  {room_id:'S1',name:'SHLAC SPF'},{room_id:'S2',name:'SH LAC SPF'},{room_id:'S3',name:'SPF room'},
  {room_id:'OLD',name:'Old SHLAC Rat room'},{room_id:'STORE',name:'SHLAC Rat room storage'}
 ];
 const value=getCageSummaryOptions(data);assert.deepEqual(value.groups.rat.room_ids,['R1','R2','R3']);assert.deepEqual(value.groups.clean.room_ids,['C1','C2']);assert.deepEqual(value.groups.spf.room_ids,['S1','S2','S3']);
 assert(CAGE_SUMMARY_GROUPS.every(({key})=>value.groups[key].capacity===null));
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
  assert.equal(options.groups.rat.locobox_mode,'cage');
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
  for(const locobox_mode of ['unknown','cage','position','box_id'])assert.equal(make({rat:{locobox_mode}}).record.cage_summary_options.groups.rat.locobox_mode,locobox_mode);
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
    storage(id,checked,group='beh'){container.onchange({target:{checked,dataset:{cageSummaryGroup:group,cageSummaryField:'temporary_storage_location_ids',locationId:id}}})},
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
  assert.doesNotMatch(reopened.innerHTML,/name="(?:spf|clean)_capacity"/);assert.match(reopened.innerHTML,/Automatic from registered cage grids/);assert.equal(value.groups.spf.capacity,null);assert.match(reopened.innerHTML,/option value="position" selected/);
  assert.match(reopened.innerHTML,/physical locoboxes/);assert.match(reopened.innerHTML,/total capacity is the number of current registered cage grids/);
});

test('unchecking rooms and repeated checkbox events keep room assignments unique',async()=>{
  const h=harness();h.room('rat','RAT-2',false);h.room('rat','RAT-1',true);h.room('rat','RAT-1',true);await h.save();
  assert.deepEqual(getCageSummaryOptions(h.dataset).groups.rat.room_ids,['RAT-1']);
  h.room('rat','BEH',true);await h.save();assert.equal(h.saves.length,1);assert.match(h.container.innerHTML,/assigned only once/);
});

test('automatic grid capacities retain earlier saved totals and custom metadata during unrelated option saves',async()=>{
 const built=make({clean:{capacity:42},spf:{capacity:19}});
 built.record.cage_summary_options.groups.clean.notes='Retain the former inventory';
 const h=harness({},built.dataset);h.field('rat','capacity','24');h.field('clean','capacity','999');h.field('spf','capacity','999');await h.save();
 const value=h.dataset.tables.husbandry_events.find(row=>row.event_id==='CAGE-SUMMARY-OPTIONS').cage_summary_options;
 assert.equal(value.groups.rat.capacity,24);assert.equal(value.groups.clean.capacity,42);assert.equal(value.groups.spf.capacity,19);
 assert.equal(value.groups.clean.notes,'Retain the former inventory');
 assert.doesNotMatch(h.container.innerHTML,/name="(?:clean|spf)_capacity"/);
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
  const h=harness();h.field('rat','capacity','120');h.hooks.reloadDataset=async()=>make({rat:{capacity:100}}).dataset;
  await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/changed while you were editing/);assert.match(h.container.innerHTML,/name="rat_capacity"[^>]*value="120"/);
  const safe=harness();safe.field('rat','capacity','120');const latest=empty();latest.tables.mice.push({mouse_sid:'SYNTHETIC-2'});safe.hooks.reloadDataset=async()=>latest;
  await safe.save();assert.equal(safe.saves.length,1);assert.equal(safe.saves[0].tables.mice.length,2);
});

test('rooms archived during editing are revalidated after refresh and cannot save',async()=>{
  const h=harness();h.field('rat','capacity','120');h.hooks.reloadDataset=async()=>{const latest=empty();latest.tables.rooms.find(room=>room.room_id==='SPF').archived=true;return latest};
  await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/existing, unarchived room/);assert.match(h.container.innerHTML,/name="rat_capacity"[^>]*value="120"/);
});

test('invalid capacity and network errors preserve drafts and escape unsafe content',async()=>{
  let reloads=0;const h=harness({reloadDataset:async()=>{reloads++;return empty()}});
  h.field('rat','capacity','1.5');await h.save();assert.equal(h.saves.length,0);assert.equal(reloads,0);assert.match(h.container.innerHTML,/whole number/);
  h.field('rat','capacity','120');h.hooks.saveDataset=async()=>{throw new Error('<script>Network failed</script>')};await h.save();
  assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/name="rat_capacity"[^>]*value="120"/);assert.match(h.container.innerHTML,/&lt;script&gt;Network failed&lt;\/script&gt;/);assert.doesNotMatch(h.container.innerHTML,/<script>|aria-busy="true"/);
});

test('pending saves disable controls and ignore duplicate submits and edits',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve});let saves=0;
  const h=harness({saveDataset:async()=>{saves++;await pending}});h.field('rat','capacity','120');const saving=h.save();
  await new Promise(resolve=>setImmediate(resolve));assert.match(h.container.innerHTML,/aria-busy="true"/);await h.save();h.field('rat','capacity','150');h.room('clean','OTHER',true);
  finish();await saving;assert.equal(saves,1);assert.match(h.container.innerHTML,/name="rat_capacity"[^>]*value="120"/);assert.doesNotMatch(h.container.innerHTML,/aria-busy="true"/);
});


const positioned=()=>{
  const dataset=empty();
  dataset.tables.racks=[{rack_id:'K1',room_id:'BEH',name:'Rack A'},{rack_id:'K2',room_id:'RAT-1',name:'Rat rack'}];
  dataset.tables.locations=[{location_id:'P1',room_id:'BEH',rack_id:'K1',label:'A1'},{location_id:'P2',rack_id:'K1',label:'A2'},{location_id:'R1',room_id:'RAT-1',rack_id:'K2',label:'R1'}];
  return dataset;
};

test('exact Ani Beh aliases are recognized without treating old or temporary room names as defaults',()=>{
  const dataset=empty();dataset.tables.rooms=[
    {room_id:'A',name:'Ani Beh'},{room_id:'B',name:'SH Ani Beh'},{room_id:'C',name:' SH  Ani   Beh '},
    {room_id:'D',name:'Ani Beh storage'},{room_id:'E',name:'Old Ani Beh'},{room_id:'F',name:'SH Ani Behavior'}
  ];
  assert.deepEqual(getCageSummaryOptions(dataset).groups.beh.room_ids,['A','B','C']);
});

test('legacy unknown counting mode and missing exclusions load as cage mode with an empty exclusion list',()=>{
  const built=make({beh:{locobox_mode:'unknown'},rat:{locobox_mode:'unknown'}}),record=built.record;
  delete record.cage_summary_options.groups.beh.temporary_storage_location_ids;
  const before=structuredClone(built.dataset),value=getCageSummaryOptions(built.dataset);
  assert.deepEqual(validateCageSummaryOptions(record),[]);assert.equal(getCageSummaryOptionsStatus(built.dataset),'saved');
  assert.equal(value.groups.beh.locobox_mode,'cage');assert.equal(value.groups.rat.locobox_mode,'cage');assert.deepEqual(value.groups.beh.temporary_storage_location_ids,[]);
  assert.deepEqual(built.dataset,before);
  assert.match(harness({},built.dataset).container.innerHTML,/<option value="cage" selected>One LocoBox per occupied cage/);
});

test('temporary storage saves direct and rack-inherited Ani Beh positions and preserves custom metadata',()=>{
  const built=make({beh:{temporary_storage_location_ids:['P1','P2']}},positioned());
  built.record.cage_summary_options.groups.beh.custom_metadata={note:'keep',revision:3};
  const value=getCageSummaryOptions(built.dataset);assert.deepEqual(value.groups.beh.temporary_storage_location_ids,['P1','P2']);
  value.groups.beh.temporary_storage_location_ids.pop();
  assert.deepEqual(getCageSummaryOptions(built.dataset).groups.beh.temporary_storage_location_ids,['P1','P2']);
  const next=buildCageSummaryOptions(built.dataset,value,clock);
  assert.deepEqual(next.record.cage_summary_options.groups.beh.temporary_storage_location_ids,['P1']);
  assert.deepEqual(next.record.cage_summary_options.groups.beh.custom_metadata,{note:'keep',revision:3});
  const olderClient=getCageSummaryOptions(next.dataset);delete olderClient.groups.beh.temporary_storage_location_ids;
  assert.deepEqual(buildCageSummaryOptions(next.dataset,olderClient,clock).record.cage_summary_options.groups.beh.temporary_storage_location_ids,['P1']);
});

test('temporary storage rejects malformed arrays and missing, conflicting, archived, or out-of-room positions',()=>{
  for(const ids of [null,'P1',[null],[1],[''],['  '],['P1','P1']])assert.throws(()=>make({beh:{temporary_storage_location_ids:ids}},positioned()),/unique nonempty strings/);
  for(const id of ['MISSING','R1'])assert.throws(()=>make({beh:{temporary_storage_location_ids:[id]}},positioned()),/selected Ani Beh rooms/);
  for(const mutate of [
    data=>{data.tables.locations[0].archived=true},
    data=>{data.tables.locations[0].app_archived_at='2026-10-15'},
    data=>{data.tables.locations.push({...data.tables.locations[0]})},
    data=>{data.tables.locations[0].rack_id='MISSING'},
    data=>{data.tables.locations[0].rack_id='K2'},
    data=>{data.tables.racks[0].archived=true},
    data=>{data.tables.racks.push({...data.tables.racks[0]})},
    data=>{data.tables.racks[0].room_id='RAT-1'},
    data=>{delete data.tables.locations[0].room_id;delete data.tables.racks[0].room_id}
  ]){
    const data=positioned();mutate(data);
    assert.throws(()=>make({beh:{temporary_storage_location_ids:['P1']}},data),/unique ID and consistent room\/rack references/);
  }
});

test('saved exclusions become invalid when their position is removed, archived, or moved to another room',()=>{
  const built=make({beh:{temporary_storage_location_ids:['P1']}},positioned());
  for(const mutate of [
    data=>{data.tables.locations.shift()},
    data=>{data.tables.locations[0].archived=true},
    data=>{Object.assign(data.tables.locations[0],{room_id:'RAT-1',rack_id:'K2'})}
  ]){
    const data=structuredClone(built.dataset);mutate(data);
    assert.equal(getCageSummaryOptionsStatus(data),'invalid');
  }
});

test('temporary storage checkboxes show room, rack and position, save uniquely, and escape labels',async()=>{
  const data=positioned();data.tables.locations[1].label='<script>A2</script>';
  const h=harness({},data);
  assert.match(h.container.innerHTML,/aria-label="Ani Beh temporary storage positions"/);
  assert.match(h.container.innerHTML,/SH Animal Beh \/ Rack A \/ A1/);
  assert.match(h.container.innerHTML,/&lt;script&gt;A2&lt;\/script&gt;/);assert.doesNotMatch(h.container.innerHTML,/<script>|data-location-id="R1"/);
  h.storage('P1',true);h.storage('P1',true);h.storage('P2',true);h.storage('R1',true);h.storage('P1',true,'rat');
  await h.save();assert.equal(h.saves.length,1);
  assert.deepEqual(getCageSummaryOptions(h.dataset).groups.beh.temporary_storage_location_ids,['P1','P2']);
  assert.match(h.container.innerHTML,/data-location-id="P1"[^>]* checked/);
  const viewer=harness({canEdit:()=>false},h.dataset);
  assert.match(viewer.container.innerHTML,/SH Animal Beh \/ Rack A \/ A1/);assert.doesNotMatch(viewer.container.innerHTML,/<input|<form|<select/);
  viewer.storage('P1',false);await viewer.save();assert.equal(viewer.saves.length,0);
});

test('room changes keep selected exclusions visible for review and require explicit removal',async()=>{
  const h=harness({},positioned());h.storage('P1',true);h.room('beh','BEH',false);
  assert.match(h.container.innerHTML,/data-location-id="P1"[^>]* checked/);assert.match(h.container.innerHTML,/Review position or room/);
  await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/selected Ani Beh rooms/);
  h.storage('P1',false);await h.save();assert.equal(h.saves.length,1);
  assert.deepEqual(getCageSummaryOptions(h.dataset).groups.beh.temporary_storage_location_ids,[]);
});

test('temporary storage positions are revalidated after refresh and retain the draft on failure',async()=>{
  const h=harness({},positioned());h.storage('P2',true);
  h.hooks.reloadDataset=async()=>{const data=positioned();data.tables.racks[0].archived=true;return data};
  await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/selected Ani Beh rooms/);
  assert.match(h.container.innerHTML,/data-location-id="P2"[^>]* checked/);assert.match(h.container.innerHTML,/Review position or room/);
});
