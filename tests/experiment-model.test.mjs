import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPERIMENT_ASSAYS,blankExperiment,blankExperimentSample,buildExperiment,buildExperimentSample,validateExperimentRecord,listExperiments,listExperimentSamples,listExperimentRevisions,experimentMouseSids,sampleMouseSids,experimentsForMouse,samplesForMouse,summarizeExperiments} from '../web/experiment-model.js';
import {validateRecord} from '../web/model.js';

const clone=structuredClone;
const confirmed=id=>({mouse_sid:id,raw_identifier:id,link_status:'confirmed',candidate_sids:[],role:null,notes:null});
const unresolved=(raw,candidates=[])=>({mouse_sid:null,raw_identifier:raw,link_status:'unresolved',candidate_sids:candidates,role:null,notes:null});
const fixture=()=>({tables:{mice:[{mouse_sid:'M1',physical_tag:'P1',state:'Stock',sex:'Male'},{mouse_sid:'M2',physical_tag:'P2',state:'Ended',sex:'Female'}],husbandry_events:[]}});
const experiment=(dataset=fixture(),extra={},options={})=>buildExperiment({title:'Clock experiment',assays:['LumiCycle'],event_date:'2026-10-14',participants:[confirmed('M1')],...extra},dataset,null,options);
const sample=(dataset=fixture(),extra={},options={})=>buildExperimentSample({label:'SCN 1',tissue:'SCN',material:'Tissue',event_date:'2026-10-14',donors:[confirmed('M1')],...extra},dataset,null,options);

test('all requested assays are supported and defaults do not invent stock or temperature',()=>{
  for(const assay of ['LumiCycle','IMG','qPCR','WB','IF/IHC','CSF','tissue_storage'])assert(EXPERIMENT_ASSAYS.includes(assay));
  assert.equal(blankExperiment().status,'planned');assert.equal(blankExperimentSample().status,'unreviewed');assert.equal(blankExperimentSample().quantity,null);assert.equal(blankExperimentSample().storage.temperature_c,null);
});

test('experiment associates multiple assays and real mice without changing animal state',()=>{
  const original=fixture(),before=clone(original),built=experiment(original,{assays:['LumiCycle','IMG','qPCR','WB','IF/IHC','CSF','tissue_storage'],participants:[confirmed('M1'),confirmed('M2')],status:'completed'});
  assert.deepEqual(original,before);assert.deepEqual(built.dataset.tables.mice,before.tables.mice);assert.equal(built.revision,null);
  assert.deepEqual(experimentMouseSids(built.record,built.dataset),['M1','M2']);assert.deepEqual(experimentsForMouse(built.dataset,'M2').map(r=>r.event_id),[built.record.event_id]);
});

test('unknown identities remain unresolved, and candidates never become confirmed associations',()=>{
  const built=experiment(fixture(),{participants:[unresolved('Old P12',['M1','M2'])]});
  assert.deepEqual(experimentMouseSids(built.record,built.dataset),[]);assert.equal(experimentsForMouse(built.dataset,'M1').length,0);assert.equal(summarizeExperiments(built.dataset).unresolved,1);
  for(const bad of [confirmed('missing'),{...unresolved('P12'),mouse_sid:'M1'},{...confirmed('M1'),candidate_sids:['M2']},unresolved('')])assert.throws(()=>experiment(fixture(),{participants:[bad]}));
});

test('duplicate animal links, duplicate assays and unrecognized assay values are rejected',()=>{
  assert.throws(()=>experiment(fixture(),{participants:[confirmed('M1'),confirmed('M1')]}),/more than once/);
  assert.throws(()=>experiment(fixture(),{assays:['LumiCycle','LumiCycle']}),/supported assays/);
  assert.throws(()=>experiment(fixture(),{assays:['Imaging']}),/supported assays/);
  assert.throws(()=>experiment(fixture(),{participants:[unresolved('old',['missing'])]}),/does not exist/);
});

test('confirmed animal dates cannot precede birth and historical tissue assays do not imply living animals',()=>{
  const dataset=fixture();dataset.tables.mice[0].date_of_birth='2026-10-15';
  assert.throws(()=>experiment(dataset),/precedes the birth/);assert.throws(()=>sample(dataset),/precedes the birth/);
  dataset.tables.mice[0].date_of_birth='2026-01-01';dataset.tables.mice[0].end_date='2026-09-01';dataset.tables.mice[0].state='Ended';
  const collected=sample(dataset,{event_date:'2026-09-01'});
  assert.doesNotThrow(()=>experiment(collected.dataset,{assays:['qPCR'],participants:[],sample_usages:[{sample_id:collected.record.event_id,disposition:'not_recorded'}]}));
});

test('timestamps need valid dates, timezone and offsets; event dates follow local time',()=>{
  const built=experiment(fixture(),{started_at:'2026-10-13T18:00:00Z',ended_at:'2026-10-14T04:00:00+08:00',timezone:'Asia/Taipei'});assert.equal(built.record.event_date,'2026-10-14');
  for(const started_at of ['2026-10-14T09:00:00','2026-02-30T01:00:00Z','2026-10-14T24:00:00Z','2026-10-14T12:60:00Z'])assert.throws(()=>experiment(fixture(),{started_at}));
  assert.throws(()=>experiment(fixture(),{started_at:'2026-10-14T01:00:00Z',timezone:'Bad/Zone'}),/timezone/i);
  assert.throws(()=>experiment(fixture(),{started_at:'2026-10-13T01:00:00Z'}),/match its start date/);
  assert.throws(()=>experiment(fixture(),{started_at:'2026-10-14T02:00:00Z',ended_at:'2026-10-14T01:00:00Z'}),/cannot precede/);
});

test('circadian phase is explicit and never inferred from clock time',()=>{
  assert.throws(()=>experiment(fixture(),{circadian_time:'12',time_basis:'unknown'}),/time basis/);
  const built=experiment(fixture(),{circadian_time:'12',time_basis:'ZT',protocol:'LD 12:12'});assert.equal(built.record.experiment.circadian_time,'12');assert.equal(built.record.experiment.time_basis,'ZT');
  assert.equal(experiment().record.experiment.circadian_time,null);
});

test('result links accept HTTP(S) only',()=>{
  assert.equal(experiment(fixture(),{result_urls:['https://example.com/results/1']}).record.experiment.result_urls.length,1);
  for(const url of ['javascript:alert(1)','data:text/html,hello','file:///tmp/results','not a url'])assert.throws(()=>experiment(fixture(),{result_urls:[url]}),/HTTP/);
});

test('stored specimens preserve explicit minus seventy storage and do not assume an amount',()=>{
  const built=sample(fixture(),{status:'stored',storage:{temperature_c:-70,facility:'Lab',freezer:'F1',rack:'R2',box:'B3',position:'C4'}});
  assert.equal(built.record.experiment_sample.quantity,null);assert.equal(built.record.experiment_sample.storage.temperature_c,-70);
  assert.equal(samplesForMouse(built.dataset,'M1').length,1);
  assert.throws(()=>sample(fixture(),{status:'stored'}),/storage location/);
  assert.throws(()=>sample(fixture(),{storage:{temperature_c:'-70'}}),/temperature/);
});

test('recorded quantities require unit and stock date; zero depleted stock is explicit',()=>{
  assert.throws(()=>sample(fixture(),{quantity:2}),/unit and stock date/);
  assert.throws(()=>sample(fixture(),{quantity:-1}),/nonnegative/);
  assert.throws(()=>sample(fixture(),{quantity:'2'}),/nonnegative/);
  assert.throws(()=>sample(fixture(),{status:'depleted'}),/zero stock/);
  assert.throws(()=>sample(fixture(),{quantity:0,quantity_unit:'vials',quantity_as_of_date:'2026-10-14',status:'available'}),/Zero stock/);
  assert.equal(sample(fixture(),{quantity:0,quantity_unit:'vials',quantity_as_of_date:'2026-10-14',status:'depleted'}).record.experiment_sample.quantity,0);
});

test('multiple donor specimens and derivatives retain pooled status',()=>{
  assert.throws(()=>sample(fixture(),{donors:[confirmed('M1'),confirmed('M2')]}),/pooled/);
  const pooled=sample(fixture(),{donors:[confirmed('M1'),confirmed('M2')],pooled:true});
  assert.throws(()=>sample(pooled.dataset,{donors:[],parent_sample_ids:[pooled.record.event_id]}),/pooled/);
  const derived=sample(pooled.dataset,{donors:[],parent_sample_ids:[pooled.record.event_id],pooled:true});
  assert.deepEqual(sampleMouseSids(derived.record,derived.dataset),['M1','M2']);
});

test('downstream experiments trace specimen and derivative use back to real donor animals',()=>{
  const first=sample(),derived=sample(first.dataset,{label:'RNA 1',donors:[],parent_sample_ids:[first.record.event_id],material:'RNA'});
  const built=experiment(derived.dataset,{assays:['qPCR'],participants:[],sample_usages:[{sample_id:derived.record.event_id,purpose:'Clock genes',amount:null,unit:null,disposition:'not_recorded'}]});
  assert.deepEqual(experimentMouseSids(built.record,built.dataset),['M1']);assert.equal(experimentsForMouse(built.dataset,'M1').length,1);
});

test('sample usage never implies automatic inventory consumption or mouse end dates',()=>{
  const first=sample(fixture(),{quantity:2,quantity_unit:'aliquots',quantity_as_of_date:'2026-10-14'}),before=clone(first.record);
  const built=experiment(first.dataset,{sample_usages:[{sample_id:first.record.event_id,purpose:'Assay',amount:1,unit:'aliquots',disposition:'consumed'}]});
  assert.deepEqual(listExperimentSamples(built.dataset)[0],before);assert.equal(built.dataset.tables.mice[0].state,'Stock');
  assert(validateExperimentRecord(built.record,built.dataset).warnings.some(x=>/does not change stored quantity/.test(x)));
});

test('missing sample links, precollection usage and invalid consumption amounts are rejected',()=>{
  assert.throws(()=>experiment(fixture(),{sample_usages:[{sample_id:'absent',disposition:'not_recorded'}]}),/does not exist/);
  const first=sample();
  assert.throws(()=>experiment(first.dataset,{event_date:'2026-10-13',sample_usages:[{sample_id:first.record.event_id,disposition:'not_recorded'}]}),/before its collection/);
  for(const amount of [0,-1,'1'])assert.throws(()=>experiment(first.dataset,{sample_usages:[{sample_id:first.record.event_id,amount,unit:'vials',disposition:'partial'}]}),/positive/);
});

test('specimen collection links target existing experiments and obeys parent dates',()=>{
  assert.throws(()=>sample(fixture(),{experiment_id:'absent'}),/collection experiment/);
  const first=experiment(),specimen=sample(first.dataset,{experiment_id:first.record.event_id});assert.equal(specimen.record.experiment_sample.experiment_id,first.record.event_id);
  assert.throws(()=>sample(specimen.dataset,{event_date:'2026-10-13',parent_sample_ids:[specimen.record.event_id]}),/parent collection date/);
});

test('explicit donor links on collected specimens also associate animals with the collection experiment',()=>{
  const first=experiment(fixture(),{participants:[]}),specimen=sample(first.dataset,{experiment_id:first.record.event_id});
  assert.deepEqual(experimentMouseSids(first.record,specimen.dataset),['M1']);
  assert.equal(experimentsForMouse(specimen.dataset,'M1').length,1);
});

test('unresolved donors cannot conceal a pooled specimen and malformed source arrays fail safely',()=>{
  assert.throws(()=>sample(fixture(),{donors:[confirmed('M1'),unresolved('old P2')]}),/pooled/);
  assert.throws(()=>experiment(fixture(),{participants:{}}),/Participants must/);
  const malformed={event_id:'OLD',event_type:'experiment',experiment:{participants:{},assays:[]}};
  assert.doesNotThrow(()=>summarizeExperiments({tables:{husbandry_events:[malformed]}}));
});

test('new sample lineage rejects self references and longer cycles',()=>{
  const first=sample(fixture(),{}, {eventId:'S1'}),second=sample(first.dataset,{parent_sample_ids:['S1']},{eventId:'S2'});
  assert.throws(()=>buildExperimentSample({parent_sample_ids:['S2']},second.dataset,first.record),/cycles/);
  assert.throws(()=>buildExperimentSample({parent_sample_ids:['S1']},first.dataset,first.record),/cycles/);
  assert.throws(()=>sample(fixture(),{parent_sample_ids:['missing']}),/does not exist/);
});

test('editing creates an atomic dated immutable revision with before and after storage',()=>{
  const first=sample(fixture(),{storage:{temperature_c:-70,freezer:'F1'}},{now:'2026-10-14T01:00:00Z'}),original=clone(first.dataset);
  const changed=buildExperimentSample({storage:{temperature_c:-70,freezer:'F2'}},first.dataset,first.record,{effectiveDate:'2026-10-15',revisionNotes:'Moved freezer',now:'2026-10-15T01:00:00Z'});
  assert.equal(changed.record.experiment_sample.revision,1);assert.equal(changed.revision.event_date,'2026-10-15');assert.equal(changed.record.event_date,'2026-10-14');
  assert.equal(changed.revision.experiment_revision.before.payload.storage.freezer,'F1');assert.equal(changed.revision.experiment_revision.after.payload.storage.freezer,'F2');
  assert.deepEqual(validateExperimentRecord(changed.record,changed.dataset,first.record).errors,[]);
  assert.deepEqual(validateExperimentRecord(changed.revision,changed.dataset).errors,[]);assert.equal(listExperimentRevisions(changed.dataset,changed.record.event_id).length,1);
  assert.deepEqual(first.dataset,original);assert(validateExperimentRecord(changed.record,first.dataset,first.record).errors.some(x=>/one transaction/.test(x)));
  const tampered=clone(changed.revision);tampered.experiment_revision.before.payload.storage.freezer='F9';assert(validateExperimentRecord(tampered,changed.dataset,changed.revision).errors.some(x=>/immutable/.test(x)));
});

test('no-op saves do not append history and stale drafts cannot overwrite newer facts',()=>{
  const first=experiment(),unchanged=buildExperiment({},first.dataset,first.record);assert.equal(unchanged.revision,null);
  const edited=buildExperiment({title:'Updated title'},first.dataset,first.record);assert.equal(edited.record.experiment.revision,1);
  assert.throws(()=>buildExperiment({title:'Stale overwrite'},edited.dataset,first.record),/changed/);
  const second=buildExperiment({title:'Second correction'},edited.dataset,edited.record);assert.equal(second.record.experiment.revision,2);assert.equal(listExperimentRevisions(second.dataset,first.record.event_id).length,2);
});

test('imported provenance remains immutable across edits and deterministic identifiers prevent duplicates',()=>{
  const first=experiment(fixture(),{participants:[unresolved('P12')]},{eventId:'EXP-SOURCE-1',sourceRecord:{record_origin:'experiment_sheet',source_spreadsheet_id:'sheet-1',source_rows:[{row:9,raw:'P12'}]},now:'2026-10-14T01:00:00Z'});
  const edited=buildExperiment({participants:[confirmed('M1')]},first.dataset,first.record);
  assert.deepEqual(edited.record.source_rows,first.record.source_rows);assert.equal(edited.record.record_origin,'experiment_sheet');
  assert.throws(()=>experiment(first.dataset,{}, {eventId:'EXP-SOURCE-1'}),/already exists/);
  assert.throws(()=>buildExperiment({},first.dataset,first.record,{sourceRecord:{source_rows:[]}}),/provenance/);
  const bad=clone(edited.record);bad.source_rows=[];assert(validateExperimentRecord(bad,edited.dataset,edited.record).errors.some(x=>/provenance/));
});

test('biological dates may remain unknown without using import or modification dates as proxies',()=>{
  const first=experiment(fixture(),{event_date:null,status:'unreviewed'},{now:'2026-10-14T01:00:00Z'});assert.equal(first.record.event_date,null);
  const second=buildExperiment({notes:'Reviewed original sheet'},first.dataset,first.record);assert.equal(second.record.event_date,null);
  assert.throws(()=>experiment(fixture(),{event_date:'2026-02-30'}),/YYYY-MM-DD/);
});

test('malformed unchanged imported facts can be retained, but fresh malformed records are blocked',()=>{
  const first=experiment(),legacy=clone(first.record);legacy.experiment.participants=[unresolved('')];
  const dataset=clone(first.dataset);dataset.tables.husbandry_events=[legacy];
  const retained=validateExperimentRecord(legacy,dataset,legacy);assert.equal(retained.errors.length,0);assert(retained.warnings.some(x=>/Existing source issue retained/.test(x)));
  const changed=clone(legacy);changed.experiment.title='Changed';assert(validateExperimentRecord(changed,dataset,legacy).errors.length>0);
});

test('archived records are hidden in defaults while traceability can include historical records',()=>{
  const exp=experiment(),specimen=sample(exp.dataset);specimen.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment').app_archived_at='2026-10-14T09:00:00Z';
  specimen.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment_sample').archived=true;
  assert.equal(listExperiments(specimen.dataset).length,0);assert.equal(listExperimentSamples(specimen.dataset).length,0);
  assert.equal(experimentsForMouse(specimen.dataset,'M1',{includeArchived:true}).length,1);assert.equal(samplesForMouse(specimen.dataset,'M1',{includeArchived:true}).length,1);
});

test('central record validation enforces experiment biology and accepts an atomic revision pair with the correct original base',()=>{
  const original=fixture(),first=experiment(original);
  assert.deepEqual(validateRecord('husbandry_events',first.record,original,null).errors,[]);
  const bad=clone(first.record);bad.experiment.participants=[confirmed('missing')];assert(validateRecord('husbandry_events',bad,original,null).errors.some(x=>/does not exist/.test(x)));
  const changed=buildExperiment({title:'Revised assay'},first.dataset,first.record),parentBase=clone(first.dataset);parentBase.tables.husbandry_events.push(changed.revision);
  assert.deepEqual(validateRecord('husbandry_events',changed.record,parentBase,first.record.event_id).errors,[]);
  const revisionBase=clone(changed.dataset);revisionBase.tables.husbandry_events=revisionBase.tables.husbandry_events.filter(r=>r.event_id!==changed.revision.event_id);
  assert.deepEqual(validateRecord('husbandry_events',changed.revision,revisionBase,null).errors,[]);
  assert(validateRecord('husbandry_events',changed.record,first.dataset,first.record.event_id).errors.some(x=>/one transaction/.test(x)));
});

test('decapitation and exact sampling preserve separate clock and circadian times from the later assay',()=>{
  const built=experiment(fixture(),{decapitation_at:'2026-10-14T09:10:00+08:00',decapitation_circadian_time:'2.1667',decapitation_time_basis:'ZT',sampling_at:'2026-10-14T09:15:00+08:00',sampling_circadian_time:'2.25',sampling_time_basis:'ZT',started_at:'2026-10-14T11:00:00+08:00',circadian_time:'4',time_basis:'ZT'});
  assert.equal(built.record.experiment.decapitation_circadian_time,'2.1667');assert.equal(built.record.experiment.sampling_circadian_time,'2.25');assert.equal(built.record.experiment.circadian_time,'4');assert.equal(built.dataset.tables.mice[0].state,'Stock');
  const specimen=sample(fixture(),{decapitation_at:'2026-10-14T09:10:00+08:00',decapitation_circadian_time:'2.1667',decapitation_time_basis:'ZT',collection_at:'2026-10-14T09:15:00+08:00',circadian_time:'2.25',time_basis:'ZT'});
  assert.equal(specimen.record.experiment_sample.collection_at,'2026-10-14T09:15:00+08:00');assert.equal(specimen.record.experiment_sample.circadian_time,'2.25');
});

test('procedure clocks validate offsets and true chronology while nonterminal collection has no decapitation',()=>{
  assert.throws(()=>experiment(fixture(),{decapitation_at:'2026-10-14T09:10:00',sampling_at:'2026-10-14T09:15:00+08:00'}),/UTC offset/);
  assert.throws(()=>sample(fixture(),{decapitation_at:'2026-10-14T09:10:00+08:00',collection_at:'2026-10-14T01:09:00Z'}),/precede decapitation/);
  assert.doesNotThrow(()=>sample(fixture(),{decapitation_at:'2026-10-14T09:10:00+08:00',collection_at:'2026-10-14T01:10:00Z'}));
  assert.equal(sample(fixture(),{collection_at:'2026-10-14T09:10:00+08:00'}).record.experiment_sample.decapitation_at,null);
  assert.throws(()=>experiment(fixture(),{sampling_circadian_time:'6'}),/basis for sampling/);
  assert.throws(()=>sample(fixture(),{decapitation_circadian_time:'6'}),/basis for decapitation/);
});

test('legacy procedure fields remain optional and timing changes keep before and after revisions',()=>{
  const first=experiment(),legacy=clone(first.record);for(const key of Object.keys(legacy.experiment))if(/^(decapitation_|sampling_)/.test(key)||key==='entrainment')delete legacy.experiment[key];
  const d=clone(first.dataset);d.tables.husbandry_events=[legacy];assert.deepEqual(validateExperimentRecord(legacy,d).errors,[]);
  const edited=buildExperiment({decapitation_at:'2026-10-14T09:00:00+08:00',sampling_at:'2026-10-14T09:03:00+08:00',entrainment:{scheme:'LP1',duration_days:30,duration_basis:'recorded'}},d,legacy);
  assert.equal(edited.revision.experiment_revision.before.payload.decapitation_at,undefined);assert.equal(edited.revision.experiment_revision.after.payload.sampling_at,'2026-10-14T09:03:00+08:00');assert.equal(edited.revision.experiment_revision.after.payload.entrainment.duration_days,30);
  assert.throws(()=>experiment(fixture(),{entrainment:{scheme:'LP1',duration_days:-1}}),/nonnegative/);
  assert.throws(()=>sample(fixture(),{decapitation_circadian_time_source:'inferred'}),/recorded or calculated/);
});

test('snapshot index handles large imported histories, replacement and appended specimen links',()=>{
 const dataset=fixture();let reads=0;
 const events=Array.from({length:15000},(_,i)=>({event_id:'E'+i,get event_type(){reads++;return 'experiment'},event_date:'2025-01-01',experiment:{...blankExperiment(),title:'Imported source',assays:['qPCR'],participants:[]}}));dataset.tables.husbandry_events=events;
 const summary=summarizeExperiments(dataset);assert.equal(summary.experiments,15000);assert.equal(summary.mice,0);assert(reads<50000,'Index avoids one full history scan per experiment');
 events.push({event_id:'S1',event_type:'experiment_sample',experiment_sample:{...blankExperimentSample(),experiment_id:'E0',donors:[confirmed('M1')]}});
 assert.deepEqual(experimentMouseSids(events[0],dataset),['M1']);
 dataset.tables.husbandry_events=[{...events[0],experiment:{...events[0].experiment,participants:[confirmed('M2')]} }];
 assert.deepEqual(experimentMouseSids(dataset.tables.husbandry_events[0],dataset),['M2']);
 const output=listExperiments(dataset);output.pop();assert.equal(listExperiments(dataset).length,1);
});
