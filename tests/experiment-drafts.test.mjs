import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourceEligibility,createDraftContext,prepareSourceDraft,prepareCreateOnlyBatches,writePreview,draftId} from '../scripts/prepare-experiment-drafts.mjs';
import {validateExperimentRecord} from '../web/experiment-model.js';
const at='2026-10-15T03:54:08.664Z',colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source=(overrides={})=>({source_id:'source-1',kind:'tissue_sampling',workbook_id:'book-1',sheet_id:0,sheet_name:'Sampling',range:'A2:W2',snapshot_date:'2026-10-14',date:'2025-01-01',assays:['qPCR','WB'],raw_identifiers:['P-M1'],tissue:'SCN',raw_values:{'G · Sampling hour':'10:35:00','A · Date\n(decap hour)':'2025-01-01','W · Entrainment schedule':'LP1 (30)'},provenance_refs:[[0,0,'Sampling','A2:W2']],...overrides});
const dataset=(sources=[source()])=>({largeArchiveSentinel:{untouched:true},tables:{mice:[{mouse_sid:'M1',physical_tag:'P-M1',date_of_birth:'2025-02-01'}],husbandry_events:[],experiment_sources:sources,experiment_source_catalog:[{file_id:'book-1',title:'Synthetic source',snapshot_date:'2026-10-14'}],experiment_source_contexts:[]}});
const context=d=>createDraftContext(d,{preparedAt:at});

test('only specified clear source kinds qualify; dates/protocol/template/checkbox rows do not',()=>{
 for(const kind of ['instrument_channel','source_matrix_review','animal_sheet_review','animal_usage'])assert.equal(sourceEligibility(source({kind})).eligible,false);
 for(const raw_values of [{},{'Sampling hour':false},{'Sampling hour':'=NOW()'},{'Sampling hour':'23:61'},{Date:'2025-01-01',Storage:'-70C'},{'Sampling hour':'10:35',Comment:'cancelled'}])assert.equal(sourceEligibility(source({raw_values})).eligible,false);
 assert.equal(sourceEligibility(source({sheet_name:'Blank template'})).eligible,false);
 assert.equal(sourceEligibility(source({date:'2027-01-01'}),{asOfDate:'2026-10-15'}).reason,'future_event_date');
 assert.equal(sourceEligibility(source({date:null})).eligible,true);
 assert.equal(sourceEligibility(source({raw_values:{Status:'Planning','Concentration':3.1}})).eligible,true);
});
test('CSF requires measurement or dated actual sampling, not a phase label alone',()=>{
 const csf=source({kind:'csf_sample',tissue:'CSF',assays:['CSF'],raw_values:{ZT:4}});
 assert.equal(sourceEligibility(csf).eligible,false);
 assert.equal(sourceEligibility({...csf,raw_values:{'OD CSF (raw absorbance)':0}}).eligible,true);
 assert.equal(sourceEligibility({...csf,raw_values:{'OD CSF (raw absorbance)':false}}).eligible,false);
 assert.equal(sourceEligibility({...csf,raw_values:{'OD CSF (raw absorbance)':'1e999'}}).eligible,false);
 assert.equal(sourceEligibility({...csf,raw_values:{'Actual time':'14:10:00'}}).eligible,true);
 assert.equal(sourceEligibility({...csf,date:null,raw_values:{'Actual time':'14:10:00'}}).eligible,false);
});
test('assay/sample rows need concrete sample/run evidence and sample labels never become animals',()=>{
 const assay=source({kind:'assay_run',identifier_kind:'sample_label',raw_identifiers:['SCN-dish-1'],assays:['WB'],raw_values:{'Primary Ab /':'BMAL1'}});
 assert.equal(sourceEligibility(assay).eligible,true);
 assert.equal(sourceEligibility({...assay,date:null}).eligible,false);
 assert.equal(sourceEligibility({...assay,raw_values:{Date:'2025-01-01'}}).eligible,false);
 assert.equal(sourceEligibility({...assay,raw_values:{'qPCR filename':'run1.eds'}}).eligible,true);
 const d=dataset([assay]),result=prepareSourceDraft(assay,context(d));assert.deepEqual(result.record.experiment.participants,[]);assert(result.index.flags.includes('specimen_labels_are_not_animal_identifiers'));
 const img={...assay,kind:'imaging_sample',assays:['IMG'],raw_values:{Location:'IMG/channel1'}};
 assert.equal(sourceEligibility(img).eligible,true);assert.equal(sourceEligibility({...img,raw_values:{}}).eligible,false);
});
test('drafts retain evidence, uncertainty and DOB flags; never derive timestamps, phase, stock or completed status',()=>{
 const d=dataset(),before=JSON.stringify(d),ctx=context(d),r=prepareSourceDraft(d.tables.experiment_sources[0],ctx);
 assert.equal(JSON.stringify(d),before);assert.equal(ctx.validationDataset.tables.mice,d.tables.mice);assert.equal(ctx.validationDataset.largeArchiveSentinel,undefined);
 assert.equal(r.record.experiment.status,'unreviewed');assert.equal(r.record.experiment.participants[0].mouse_sid,null);assert.deepEqual(r.record.experiment.participants[0].candidate_sids,['M1']);
 for(const key of ['started_at','ended_at','decapitation_at','sampling_at','circadian_time','decapitation_circadian_time','sampling_circadian_time'])assert.equal(r.record.experiment[key],null);
 assert.equal(r.record.experiment.entrainment.duration_days,null);assert.equal(r.record.experiment_sample,undefined);assert.equal(r.record.record_origin,'imported_experiment_sheet_draft');
 assert.equal(r.record.source_observation.kind,'tissue_sampling');assert.equal(r.record.source_observation.raw_values,undefined);assert.equal(r.record.source_raw_values,undefined);assert.equal(r.record.source_ref.storage,'immutable_source_archive');assert.equal(r.record.source_ref.source_fingerprint,r.index.source_fingerprint);assert.equal(d.tables.experiment_sources[0].raw_values['W · Entrainment schedule'],'LP1 (30)');
 assert(r.index.flags.includes('candidate_birth_after_source_date'));assert.match(r.record.experiment.title,/^Source record/);assert.deepEqual(validateExperimentRecord(r.record,ctx.validationDataset).errors,[]);
});
test('unchanged deterministic retries skip; edits, archived records and same source with a reviewed ID remain protected',()=>{
 const d=dataset(),first=prepareSourceDraft(source(),context(d)).record;
 assert.equal(first.event_id,draftId(source().source_id));assert.deepEqual(first,prepareSourceDraft(source(),context(d)).record);
 d.tables.husbandry_events=[first];assert.equal(prepareSourceDraft(source(),createDraftContext(d,{preparedAt:'2026-10-16T03:54:08.664Z'})).index.disposition,'already_identical');
 d.tables.husbandry_events=[{...first,experiment:{...first.experiment,title:'Owner reviewed'}}];assert.equal(prepareSourceDraft(source(),context(d)).index.disposition,'conflict_existing_record');
 d.tables.husbandry_events=[{...first,archived:true}];assert.equal(prepareSourceDraft(source(),context(d)).index.disposition,'conflict_existing_record');
 d.tables.husbandry_events=[{...first,event_id:'MANUAL-1'}];assert.equal(prepareSourceDraft(source(),context(d)).index.disposition,'already_managed_source');
});
test('changed observations sharing exact source coordinates remain separate with an explicit history relation',()=>{
 const a=source(),b=source({source_id:'source-2',tissue:'LVCP',raw_values:{'Sampling hour':'11:35'}}),d=dataset([a,b]),ctx=context(d);
 const one=prepareSourceDraft(a,ctx),two=prepareSourceDraft(b,ctx);assert.notEqual(one.record.event_id,two.record.event_id);assert.notEqual(one.index.source_fingerprint,two.index.source_fingerprint);
 assert.equal(one.record.source_history_relation.reference_keys,undefined);assert.equal(one.record.source_history_relation.shared_reference_count,1);assert.equal(two.record.source_history_relation.shared_reference_count,1);
 assert(one.index.flags.includes('same_source_cell_has_other_observations_not_merged'));assert.throws(()=>context(dataset([a,a])),/Duplicate source/);
});
test('invalid managed field lengths are reported, not truncated or silently published',()=>{
 const s=source({operator:'x'.repeat(301)}),r=prepareSourceDraft(s,context(dataset([s])));assert.equal(r.record,null);assert.equal(r.index.disposition,'validation_rejected');
});
test('future authenticated publication remains bounded/create-only with explicit scope and no overwrite',()=>{
 const d=dataset(),r=prepareSourceDraft(source(),context(d)).record;
 assert.throws(()=>prepareCreateOnlyBatches([r],[],{}),/UUID/);
 const plan=prepareCreateOnlyBatches([r],[],{colonyId:colony});assert.equal(plan.batches[0].p_changes[0].expected_version,0);assert.equal(plan.batches[0].p_changes[0].archived,false);
 const existing={colony_id:colony,entity_type:'husbandry_events',entity_id:r.event_id,payload:r,archived:false};assert.equal(prepareCreateOnlyBatches([r],[existing],{colonyId:colony}).identical,1);
 assert.throws(()=>prepareCreateOnlyBatches([r],[{...existing,payload:{...r,event_date:null}}],{colonyId:colony}),/refusing overwrite/);
 assert.throws(()=>prepareCreateOnlyBatches([r],[{...existing,colony_id:'other'}],{colonyId:colony}),/scoped/);
 const bad=structuredClone(r);bad.experiment.participants[0].mouse_sid='M1';bad.experiment.participants[0].link_status='confirmed';assert.throws(()=>prepareCreateOnlyBatches([bad],[],{colonyId:colony}),/cannot confirm/);
});
test('private preview is exclusively created and contains no executable SQL or inferred specimens',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'experiment-draft-test-')));
 try{const out=join(root,'drafts'),report=await writePreview({dataset:dataset(),outputDir:out,preparedAt:at});assert.equal(report.drafts,1);assert.equal(report.managed_specimens_created,0);assert.equal(report.publication.prepared,false);
 assert.equal((await stat(out)).mode&0o777,0o700);assert.equal((await stat(join(out,'records.jsonl'))).mode&0o777,0o600);assert.equal(JSON.parse((await readFile(join(out,'records.jsonl'),'utf8')).trim()).event_type,'experiment');
 await assert.rejects(writePreview({dataset:dataset(),outputDir:out,preparedAt:at}),/EEXIST/);
 }finally{await rm(root,{recursive:true,force:true});}
});
