import test from 'node:test';
import assert from 'node:assert/strict';
import {renderExportCenter} from '../web/export-center.js';

const permission=(level='low')=>({level,cutoff_date:level==='max'?null:level==='high'?'2020-10-14':'2023-10-14',as_of_date:'2026-10-14',full_history:level==='max',local:false});
const dataset=()=>({private_source_dump:'DO NOT EXPORT THE LOCAL SNAPSHOT',tables:{
  mice:[{mouse_sid:'001',physical_tag:'OLD-001',state:'Stock',sex:'Male',date_of_birth:'2018-01-01',cage_sid:'C1',genotype:'fresh profile'},{mouse_sid:'002',state:'Stock',sex:'Female',cage_sid:'C1'},{mouse_sid:'003',state:'Ended',cage_sid:'C1'}],
  cages:[{cage_sid:'C1',cage_tag:'Cage A',state:'Active',location_id:'P1'}],rooms:[{room_id:'R1',name:'Room A'},{room_id:'R2',name:'Room B'}],racks:[{rack_id:'K1',room_id:'R1',name:'Rack A'},{rack_id:'K2',room_id:'R2',name:'Rack B'}],locations:[{location_id:'P1',room_id:'R1',rack_id:'K1',label:'A1',row:1,column:1}],light_events:[],husbandry_events:[],matings:[],litters:[]
}});
async function mount(options={},overrides={}) {
  const container={innerHTML:'',querySelector:()=>null},calls={permissions:0,records:[],backups:0,sources:0,downloads:[],prints:[],closed:0};
  const state={grant:permission(),fresh:dataset(),local:dataset()};
  const hooks={
    getPermission:async()=>{calls.permissions++;return structuredClone(state.grant)},
    getRecords:async request=>{calls.records.push(structuredClone(request));return {dataset:structuredClone(state.fresh),metadata:{export_level:state.grant.level,cutoff_date:state.grant.cutoff_date,as_of_date:state.grant.as_of_date,captured_at:'2026-10-14T04:12:34Z',scope:request.scope,from_date:request.fromDate,to_date:request.toDate,excluded_undated:0,snapshot_revision:'revision-1',local:false}}},
    getBackup:async()=>{calls.backups++;return structuredClone(state.fresh)},
    getSourceArchive:async()=>{calls.sources++;return {sources:[{title:'Synthetic source'}],sheets:[{title:'Sheet'}],cells:[[0,'A1','TEST']]}},
    download:async(blob,filename)=>calls.downloads.push({blob,filename}),print:async(html,context)=>calls.prints.push({html,context}),close:()=>{calls.closed++},
  };
  Object.assign(hooks,typeof overrides==='function'?overrides({state,calls,hooks}):overrides);
  await renderExportCenter(container,state.local,hooks,options);
  return {container,calls,state,hooks};
}
const click=(container,action)=>container.onclick({target:{closest:()=>({dataset:{exportAction:action},disabled:false})}});
const change=(container,field,value,checked)=>container.onchange({target:{dataset:{exportField:field},value,checked}});
const type=(container,entity,checked)=>container.onchange({target:{dataset:{exportType:entity},checked}});
const text=async entry=>entry.blob.text();

test('opening verifies permission and fails closed without using local or raw data',async()=>{
  const {container,calls}=await mount({}, {getPermission:async()=>{throw new Error('Reconnect to verify export access.')}});
  assert.match(container.innerHTML,/Permission unavailable/);assert.match(container.innerHTML,/Reconnect/);
  await click(container,'preview');await click(container,'export');
  assert.equal(calls.records.length,0);assert.equal(calls.backups,0);assert.equal(calls.sources,0);assert.equal(calls.downloads.length,0);
});

test('Low and High labels follow the final three and six year limits and server cutoff',async()=>{
  const {container,state}=await mount({scope:'records'});
  assert.match(container.innerHTML,/Low \(past 3 years\)/);assert.match(container.innerHTML,/High the past 6 years/);assert.match(container.innerHTML,/min="2023-10-14"/);
  state.grant=permission('high');await click(container,'refresh');assert.match(container.innerHTML,/High \(past 6 years\)/);assert.match(container.innerHTML,/min="2020-10-14"/);
});

test('history dates are inclusive, ordered and restricted before any record request',async()=>{
  const {container,calls}=await mount({scope:'records',format:'json',entityTypes:['mice']});
  change(container,'fromDate','2023-10-13');await click(container,'preview');assert.equal(calls.records.length,0);assert.match(container.innerHTML,/starts on 2023-10-14/);
  change(container,'fromDate','2023-10-14');change(container,'toDate','2026-10-15');await click(container,'preview');assert.equal(calls.records.length,0);
  change(container,'fromDate','2026-10-14');change(container,'toDate','2026-10-13');await click(container,'preview');assert.equal(calls.records.length,0);
  change(container,'fromDate','2023-10-14');change(container,'toDate','2026-10-14');await click(container,'preview');
  assert.deepEqual(calls.records[0],{scope:'history',fromDate:'2023-10-14',toDate:'2026-10-14',entityTypes:['mice']});
  type(container,'mice',false);await click(container,'preview');assert.equal(calls.records.length,1);assert.match(container.innerHTML,/Choose at least one record type/);
});

test('permission downgrade invalidates a preview and does not export or fetch stale scope',async()=>{
  const {container,calls,state}=await mount({scope:'records',format:'json',entityTypes:['mice']});
  state.grant=permission('high');await click(container,'preview');assert.equal(calls.records.length,1);
  state.grant=permission('low');await click(container,'export');
  assert.equal(calls.records.length,1);assert.equal(calls.downloads.length,0);assert.match(container.innerHTML,/Export access or its date window changed/);
  await click(container,'preview');await click(container,'export');assert.equal(calls.downloads.length,1);
});

test('raw backups and source archives require fresh Max and never use a local fallback',async()=>{
  const {container,calls,state}=await mount({scope:'backup'});
  await click(container,'preview');assert.equal(calls.backups,0);assert.match(container.innerHTML,/Max export access is required/);
  state.grant=permission('max');await click(container,'preview');assert.equal(calls.backups,1);
  state.grant=permission('low');await click(container,'export');assert.equal(calls.backups,1);assert.equal(calls.downloads.length,0);
  change(container,'scope','source-archive');await click(container,'preview');assert.equal(calls.sources,0);
  state.grant=permission('max');await click(container,'preview');await click(container,'export');assert.equal(calls.sources,2);assert.equal(calls.downloads.length,1);
  const exported=JSON.parse(await text(calls.downloads[0]));assert.equal(exported.cells[0][2],'TEST');assert.match(calls.downloads[0].filename,/source-archive.*\.json$/);
});

test('every historical export uses fresh records and selected sanitized tables only',async()=>{
  const {container,calls,state}=await mount({scope:'records',format:'json',entityTypes:['mice']});
  state.fresh.tables.mice=[{mouse_sid:'001',genotype:'preview value',export_record_date:'2026-10-01'}];await click(container,'preview');
  state.fresh.tables.mice[0].genotype='newly saved value';await click(container,'export');
  assert.equal(calls.records.length,2);assert.equal(calls.permissions,3);
  const result=JSON.parse(await text(calls.downloads[0]));assert.deepEqual(Object.keys(result.tables),['mice']);assert.equal(result.tables.mice[0].genotype,'newly saved value');assert.equal(result.metadata.export_level,'low');assert.equal(result.metadata.cutoff_date,'2023-10-14');assert.equal(result.metadata.from_date,'2023-10-14');
  assert.doesNotMatch(await text(calls.downloads[0]),/DO NOT EXPORT|private_source_dump|preview value/);
});

test('a records response with changed authority, dates or scope cannot be exported',async()=>{
  for(const override of [{export_level:'max'},{cutoff_date:null},{as_of_date:'2026-10-15'},{scope:'current_housing'},{from_date:null},{to_date:null},{local:true}]) {
    let mismatch=false;
    const {container,calls}=await mount({scope:'records',format:'json',entityTypes:['mice']},({hooks})=>{const original=hooks.getRecords;return {getRecords:async request=>{const result=await original(request);if(mismatch)Object.assign(result.metadata,override);return result}}});
    await click(container,'preview');mismatch=true;await click(container,'export');
    assert.equal(calls.downloads.length,0,JSON.stringify(override));assert.match(container.innerHTML,/changed while records were loading/);
  }
});

test('current Animal Sheet preserves old DOB animals and labels an exact selected subset',async()=>{
  const {container,calls}=await mount({scope:'animal-sheet',format:'pdf',selectedMouseIds:['001']});
  assert.match(container.innerHTML,/Selected animals only \(1\)/);
  await click(container,'preview');assert.match(container.innerHTML,/<strong>1<\/strong> selected current animals/);
  assert.deepEqual(calls.records[0],{scope:'current_housing',fromDate:null,toDate:null,entityTypes:['mice','cages','rooms','racks','locations','light_events']});
  await click(container,'export');assert.equal(calls.downloads.length,0);assert.equal(calls.prints.length,1);
  const printed=calls.prints[0];assert.match(printed.html,/OLD-001/);assert.match(printed.html,/2018-01-01/);assert.match(printed.html,/1 selected/);assert.match(printed.html,/2 total Stock/);
  assert.equal(printed.context.permission.level,'low');assert.equal(printed.context.scope,'current_housing');assert.equal(printed.context.fromDate,null);assert.equal(printed.context.toDate,null);
  assert.match(printed.html,/2026-10-14T04:12:34Z/,'actual snapshot capture timestamp is retained');
});

test('CSV guards formula-looking strings and retains exact text identifiers',async()=>{
  const {container,calls,state}=await mount({scope:'records',format:'csv',entityTypes:['mice']});
  state.fresh.tables.mice=[{mouse_sid:'000123',genotype:'=HYPERLINK("https://example.invalid")',notes:'\t+attack',count:-2}];
  await click(container,'preview');await click(container,'export');
  const csv=await text(calls.downloads[0]);assert.match(csv,/"000123"/);assert.match(csv,/"'=HYPERLINK/);assert.match(csv,/"'\t\+attack"/);assert.match(csv,/"-2"/);assert.match(calls.downloads[0].filename,/\.csv$/);assert.equal(calls.prints.length,0);
});

test('XLSX is a workbook for both scopes and scope changes invalidate previous previews',async()=>{
  const {container,calls}=await mount({scope:'animal-sheet',format:'xlsx'});
  await click(container,'preview');await click(container,'export');
  assert.equal(calls.downloads[0].blob.type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');assert.deepEqual([...new Uint8Array(await calls.downloads[0].blob.arrayBuffer()).slice(0,4)],[80,75,3,4]);
  change(container,'scope','records');await click(container,'export');assert.equal(calls.downloads.length,1);assert.match(container.innerHTML,/Preview the selected scope/);
  await click(container,'preview');await click(container,'export');assert.match(calls.downloads[1].filename,/records-history.*\.xlsx$/);
});

test('date-limited previews disclose undated omissions and changing room clears incompatible filters',async()=>{
  const {container,calls}=await mount({scope:'records',entityTypes:['mice']},({hooks})=>{const original=hooks.getRecords;return {getRecords:async request=>{const result=await original(request);result.metadata.excluded_undated=7;return result}}});
  await click(container,'preview');assert.match(container.innerHTML,/7 undated records were excluded/);
  change(container,'scope','animal-sheet');change(container,'roomId','R1');change(container,'rackId','K1');change(container,'cageId','C1');change(container,'roomId','R2');
  assert.match(container.innerHTML,/<option value="" selected>All racks/);assert.match(container.innerHTML,/<option value="" selected>All current cages/);assert.doesNotMatch(container.innerHTML,/<option value="K1"/);
  await click(container,'preview');assert.match(container.innerHTML,/<strong>0<\/strong> current animals/);assert.equal(calls.records.length,2);
});

test('closing during a fresh request prevents any download when it resolves',async()=>{
  let resolve,delay=false;
  const {container,calls}=await mount({scope:'records',format:'json'},({hooks})=>{const original=hooks.getRecords;return {getRecords:async request=>{const result=await original(request);if(delay)await new Promise(done=>{resolve=done});return result}}});
  await click(container,'preview');delay=true;const exporting=click(container,'export');while(!resolve)await new Promise(done=>setTimeout(done,0));await click(container,'close');resolve();await exporting;
  assert.equal(calls.closed,1);assert.equal(calls.downloads.length,0);
});


test('current cage selector retains Occupied, position-linked inactive, derived and unmatched selected cages',async()=>{
  const {container}=await mount({cageId:'missing-selected'},({state})=>{
    state.local.tables.cages.push({cage_sid:'OCC',state:'Occupied'},{cage_sid:'INACTIVE',state:'Inactive',location_id:'P1'});
    state.local.tables.mice.push({mouse_sid:'004',state:'Stock',cage_sid:'DERIVED'});
    return {};
  });
  assert.match(container.innerHTML,/<option value="OCC">/);assert.match(container.innerHTML,/<option value="INACTIVE">/);assert.match(container.innerHTML,/<option value="DERIVED">/);
  assert.match(container.innerHTML,/<option value="missing-selected" selected>missing-selected \(selected cage, no current match\)/);
  assert.doesNotMatch(container.innerHTML,/<option value="" selected>All current cages/);
});
