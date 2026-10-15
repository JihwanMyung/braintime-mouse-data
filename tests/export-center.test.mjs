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
    getLocalBackup:async()=>{calls.backups++;return {kind:'braintime-local-backup',schema_version:1,full_workspace:state.grant.level==='max',permission:structuredClone(state.grant),sections:state.grant.level==='max'?{workspace:structuredClone(state.fresh)}:{current_housing:{tables:state.fresh.tables},history:{tables:{mice:[]}}}}},
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

test('local backup requires High or Max; full source archive still requires Max',async()=>{
  const {container,calls,state}=await mount({scope:'backup'});
  await click(container,'preview');assert.equal(calls.backups,0);assert.match(container.innerHTML,/High or Max export access is required/);
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

test('experiment CSV exposes readable assay, animal, tissue and freezer columns; JSON preserves structured associations',async()=>{
  const {container,calls,state}=await mount({scope:'records',format:'csv',entityTypes:['husbandry_events']});
  state.fresh.tables.husbandry_events=[
    {event_id:'EXP-01',event_type:'experiment',event_date:'2026-10-01',experiment:{title:'=Example study',assays:['LumiCycle','IMG'],participants:[{mouse_sid:'0001',link_status:'confirmed'},{raw_identifier:'TAG-X',link_status:'unresolved',candidate_sids:['0002']}],sample_usages:[{sample_id:'SAMPLE-1',amount:2,unit:'µL'}],participants_truncated:true,participant_count:101}},
    {event_id:'SAMPLE-1',event_type:'experiment_sample',event_date:'2026-10-01',experiment_sample:{label:'SCN aliquot',tissue:'SCN',donors:[{mouse_sid:'0001',link_status:'confirmed'}],storage:{temperature_c:-70,freezer:'F1',box:'B2',position:'A3'}}}
  ];
  await click(container,'preview');assert.match(container.innerHTML,/Experiments, fees &amp; husbandry/);assert.match(container.innerHTML,/1 experiment or specimen records contain more/);
  await click(container,'export');const csv=await text(calls.downloads[0]);
  for(const column of ['experiment_title','experiment_assays','confirmed_mouse_sids','unresolved_animal_identifiers','experiment_sample_tissue','storage_temperature_c','storage_freezer','storage_position'])assert(csv.includes(column),column);
  assert.match(csv,/"'=Example study"/);assert.match(csv,/0001/);assert.match(csv,/TAG-X/);assert.match(csv,/"-70"/);
  change(container,'format','json');await click(container,'preview');await click(container,'export');
  const json=JSON.parse(await text(calls.downloads[1]));assert.equal(json.tables.husbandry_events[0].experiment.participants[0].mouse_sid,'0001');assert.equal(json.tables.husbandry_events[1].experiment_sample.storage.temperature_c,-70);
});

test('experiment and sample exports label users by acronym while JSON preserves the compatible operator field',async()=>{
  const {container,calls,state}=await mount({scope:'records',format:'csv',entityTypes:['husbandry_events']});
  state.fresh.tables.husbandry_events=[
    {event_id:'EXP-USER',event_type:'experiment',event_date:'2026-10-01',experiment:{title:'User labels',operator:'JM'}},
    {event_id:'SAMPLE-USER',event_type:'experiment_sample',event_date:'2026-10-01',experiment_sample:{label:'Sample user',operator:'AB'}}
  ];
  await click(container,'preview');await click(container,'export');const csv=await text(calls.downloads[0]);
  assert(csv.includes('"experiment_user"'));assert(csv.includes('"sample_user"'));assert(csv.includes('"JM"'));assert(csv.includes('"AB"'));assert(!csv.includes('_operator'));
  change(container,'format','xlsx');await click(container,'preview');await click(container,'export');const workbook=await text(calls.downloads[1]);
  assert(workbook.includes('experiment_user'));assert(workbook.includes('sample_user'));assert(!workbook.includes('_operator'));
  change(container,'format','json');await click(container,'preview');await click(container,'export');const json=JSON.parse(await text(calls.downloads[2]));
  assert.equal(json.tables.husbandry_events[0].experiment.operator,'JM');assert.equal(json.tables.husbandry_events[1].experiment_sample.operator,'AB');assert.equal(json.tables.husbandry_events[0].experiment.user,undefined);
});

test('experiment and specimen CSV use explicit separate decapitation and sampling clock/circadian columns',async()=>{
  const {container,calls,state}=await mount({scope:'records',format:'csv',entityTypes:['husbandry_events']});
  const entrainment={scheme:'LP1',light_event_id:'LIGHT-1',reference_at:'2026-10-01T08:00:00+08:00',reference_phase:0,phase_basis:'ZT',phase_scale:'normalized_24',period_hours:24,timezone:'Asia/Taipei',start_date:'2026-09-01',end_date:'2026-10-01',duration_days:30,duration_basis:'date_difference'};
  state.fresh.tables.husbandry_events=[
    {event_id:'EXP-TIME',event_type:'experiment',event_date:'2026-10-01',experiment:{title:'Timing',started_at:'2026-10-02T17:00:00+08:00',circadian_time:'9',time_basis:'ZT',timezone:'Asia/Taipei',decapitation_at:'2026-10-01T10:03:00+08:00',decapitation_circadian_time:'2.05',decapitation_time_basis:'ZT',sampling_at:'2026-10-01T10:07:30+08:00',sampling_circadian_time:'14.125',sampling_time_basis:'CT'}},
    {event_id:'SAMPLE-TIME',event_type:'experiment_sample',event_date:'2026-10-01',experiment_sample:{label:'Aliquot',collection_at:'2026-10-01T10:08:00+08:00',circadian_time:'14.1333',time_basis:'CT',timezone:'Asia/Taipei',decapitation_at:'2026-10-01T10:03:00+08:00',decapitation_circadian_time:'2.05',decapitation_time_basis:'ZT'}}
  ];
  for(const row of state.fresh.tables.husbandry_events){const p=row[row.event_type];p.entrainment=entrainment;p.decapitation_circadian_time_source='recorded';p[row.event_type==='experiment'?'sampling_circadian_time_source':'circadian_time_source']='calculated';}
  await click(container,'preview');await click(container,'export');const csv=await text(calls.downloads[0]);
  for(const field of ['decapitation_clock_time','decapitation_circadian_time','decapitation_time_basis','sampling_clock_time','sampling_circadian_time','sampling_time_basis','timing_timezone','experiment_started_at','experiment_circadian_time','experiment_time_basis'])assert(csv.includes('"'+field+'"'),field);
  for(const value of ['2026-10-01T10:03:00+08:00','2026-10-01T10:07:30+08:00','2026-10-01T10:08:00+08:00','2.05','14.125','14.1333','2026-10-02T17:00:00+08:00'])assert(csv.includes(value),value);
  for(const field of ['decapitation_circadian_time_source','sampling_circadian_time_source',...Object.keys(entrainment).map(key=>'entrainment_'+key)])assert(csv.includes('"'+field+'"'),field);
  assert(csv.includes('"LP1"'));assert(csv.includes('"30"'));assert(csv.includes('"date_difference"'));assert(csv.includes('"recorded"'));assert(csv.includes('"calculated"'));
  assert(!csv.includes('experiment_sample_collection_at'),'Specimen collection is explicitly named sampling in spreadsheet reports');
});

test('fee CSV exposes billing fields and evidence certainty and warns when a bounded list is truncated',async()=>{
  const {container,calls,state}=await mount({scope:'records',format:'csv',entityTypes:['husbandry_events']});
  state.fresh.tables.husbandry_events=[{event_id:'FEE',event_type:'lac_fee_month',event_date:'2026-10-01',lac_fee_month:{month:'2026-10',currency:'TWD',actual_total:1200,invoice_reference:'Invoice A',lines:[{quantity:100,quantity_unit:'cage_day',quantity_basis:'ambiguous',quantity_note:'Review source'}],lines_count:101,lines_truncated:true}}];
  await click(container,'preview');assert.match(container.innerHTML,/more evidence lines or billing groups/);await click(container,'export');const csv=await text(calls.downloads[0]);
  for(const column of ['fee_month','fee_currency','fee_actual_total','fee_invoice_reference','fee_lines','fee_lines_count','fee_lines_truncated'])assert(csv.includes('"'+column+'"'),column);assert(csv.includes('ambiguous'));assert(csv.includes('cage_day'));assert(csv.includes('Review source'));assert(calls.permissions>=3);
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

test('Locobox CSV keeps nested intervals and makes clipped report boundaries visible',async()=>{
 const {container,calls,state}=await mount({scope:'records',format:'csv',entityTypes:['husbandry_events']});
 state.fresh.tables.husbandry_events=[{event_id:'LOCO',event_type:'locobox_protocol',export_event_date_withheld:true,locobox_protocol:{title:'Timeline',cage_sid:'C1',phase_count:2,phases_truncated:false,phases:[{phase_id:'P1',scheme:'DD',export_interval_clipped:true,export_window_start:'2023-10-14',end_date:'2026-10-01',treatments:[{treatment_id:'T',name:'Recorded compound',status:'cancelled'}],treatment_count:1,treatments_truncated:false}]}}];
 await click(container,'preview');assert.match(container.innerHTML,/Locobox protocols have intervals clipped/);await click(container,'export');const csv=await text(calls.downloads[0]);
 for(const field of ['locobox_title','locobox_cage_sid','locobox_phases','locobox_phase_count','locobox_phases_truncated','export_event_date_withheld'])assert(csv.includes('"'+field+'"'),field);assert(csv.includes('export_interval_clipped'));assert(csv.includes('cancelled'));assert(calls.permissions>=3);
});

 test('High local backup labels its partial six-year scope and denies a downgrade at download',async()=>{
  const {container,calls,state}=await mount({scope:'backup'});state.grant=permission('high');
  await click(container,'preview');assert.equal(calls.backups,1);assert.match(container.innerHTML,/2020-10-14 to 2026-10-14/);assert.match(container.innerHTML,/Partial backup/);
  await click(container,'export');const payload=JSON.parse(await text(calls.downloads[0]));assert.equal(payload.full_workspace,false);assert.equal(payload.permission.level,'high');assert.equal(payload.permission.cutoff_date,'2020-10-14');assert.equal(payload.sections.workspace,undefined);assert.match(calls.downloads[0].filename,/local-backup/);
  state.grant=permission('low');await click(container,'export');assert.equal(calls.downloads.length,1);assert.equal(calls.backups,2);
 });
 test('local backup rejects a full or wrong-window response for High',async()=>{
  for(const bad of [{full_workspace:true},{permission:permission('max')},{permission:{...permission('high'),cutoff_date:'2019-01-01'}}]){
   const {container,calls,state}=await mount({scope:'backup'},({hooks})=>{const original=hooks.getLocalBackup;return {getLocalBackup:async()=>({...await original(),...bad})}});state.grant=permission('high');
   await click(container,'preview');await click(container,'export');assert.equal(calls.downloads.length,0);assert.match(container.innerHTML,/could not be verified|permission changed|Preview/);
  }
 });


test('local backup refuses unexpected full sections for High and redacted Max envelopes',async()=>{
 for(const level of ['high','max']){
  const {container,calls,state}=await mount({scope:'backup'},({hooks})=>{const original=hooks.getLocalBackup;return {getLocalBackup:async()=>{
   const result=await original();if(level==='high')result.sections.workspace=dataset();else result.sections.workspace.source_archive_restricted=true;return result;
  }}});state.grant=permission(level);
  await click(container,'preview');assert.match(container.innerHTML,/Backup scope could not be verified/);await click(container,'export');assert.equal(calls.downloads.length,0);
 }
});
