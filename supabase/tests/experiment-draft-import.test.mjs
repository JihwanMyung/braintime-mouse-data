import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {prepareExperimentDraftImport,sourceArchiveDescriptor,prepareCsvSourceTitleRepair,asciiJson} from '../../scripts/prepare-experiment-draft-import.mjs';
import {encodeArchive} from '../../web/archive-format.js';
import {createDraftContext,prepareSourceDraft} from '../../scripts/prepare-experiment-drafts.mjs';
const colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',at='2026-10-15T03:54:08.664Z';
const source={source_id:'source-$csv_preflight$-$csv_verify$-1',kind:'tissue_sampling',workbook_id:'book1',sheet_id:0,sheet_name:'Sampling',range:'A2:W2',date:'2025-01-01',assays:['qPCR'],raw_identifiers:['P-M1'],tissue:"SCN O'Brien 腦",raw_values:{'Sampling hour':'10:35:00'},provenance_refs:[[0,0,'Sampling','A2:W2']]};
const dataset={tables:{mice:[{mouse_sid:'M1',physical_tag:'P-M1'}],husbandry_events:[],experiment_sources:[source],experiment_source_catalog:[{file_id:'book1',title:'Synthetic $csv_verify$ / $$ source'}],experiment_source_contexts:[]}};
const record=prepareSourceDraft(source,createDraftContext(dataset,{preparedAt:at})).record,descriptor=sourceArchiveDescriptor([source]);
const options={records:[record],dataset,colonyId:colony,ownerUserId:owner,sourceDescriptor:descriptor},plan=prepareExperimentDraftImport(options);
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role braintime_snapshot_reader;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb,encrypted_password text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
for(const file of ['schema.sql','functions/manage-colony-users/membership.sql','export-permissions.sql','manager-permissions.sql','iacuc.sql','locobox.sql','fees-hardening.sql','experiment-export.sql','ear-marks.sql','cage-position-guard.sql','lab-members.sql','account-acronym.sql','animal-sheet-import.sql','lac-fee-visibility.sql','brainbot.sql','app-access-log.sql','local-backup.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into auth.users(id,email)values($1,$2),($3,$4)',[owner,'owner@example.invalid',other,'other@example.invalid']);
await db.query('insert into public.colonies(id,name,created_by)values($1,$2,$3)',[colony,'Synthetic draft import',owner]);await db.query("insert into public.memberships(colony_id,user_id,role)values($1,$2,'owner')",[colony,owner]);
await db.query("insert into public.entity_records(colony_id,entity_type,entity_id,payload,version,created_by,updated_by)values($1,'archive','reconstruction',$2,4,$3,$3)",[colony,{archive_tables:{experiment_sources:descriptor},tables:{keep:['original']}},owner]);
async function reject(sql,re){try{await assert.rejects(()=>db.exec(sql),re);}finally{await db.exec('rollback');}}

await test('SQL generator requires exact source-derived payload and fresh explicit scope',()=>{
 assert.throws(()=>prepareExperimentDraftImport({...options,colonyId:null}),/UUID/);
 assert.throws(()=>prepareExperimentDraftImport({...options,ownerUserId:null}),/UUID/);
 assert.throws(()=>prepareExperimentDraftImport({...options,sourceDescriptor:{...descriptor,row_count:2}}),/descriptor/);
 assert.throws(()=>prepareExperimentDraftImport({...options,sourceDescriptor:{...descriptor,chunk_ids:['chunk:'+'0'.repeat(64)]}}),/fingerprints differ/);
 const tampered=structuredClone(record);tampered.experiment.status='completed';assert.throws(()=>prepareExperimentDraftImport({...options,records:[tampered]}),/differs/);
 assert.throws(()=>prepareExperimentDraftImport({...options,records:[record,record]}),/unique/);
 assert(plan.files.every(x=>x.bytes<700000));assert(plan.files.every(x=>!x.sql.includes('set_config')));assert.equal(plan.files[0].expected_records,1);
});
await test('source fingerprints use exact production archive boundaries and Unicode encoding',async()=>{
 const rows=Array.from({length:1000},(_,i)=>({...source,source_id:'s'+i,note:'腦 🐁'.repeat(100)})),archive=await encodeArchive({tables:{experiment_sources:rows}});
 assert.deepEqual(sourceArchiveDescriptor(rows),archive.at(-1).payload.archive_tables.experiment_sources);
});
await test('guards reject non-admin claims, inactive/wrong owner and changed source descriptors before any insert',async()=>{
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await reject(plan.files[0].sql,/Administrator SQL/);await db.query("select set_config('request.jwt.claim.sub','',false)");
 const wrong=prepareExperimentDraftImport({...options,ownerUserId:other});await reject(wrong.files[0].sql,/not an active/);
 await db.query("update public.entity_records set payload=jsonb_set(payload,'{archive_tables,experiment_sources,row_count}','2') where entity_id='reconstruction'");await reject(plan.files[0].sql,/descriptor changed/);
 await db.query("update public.entity_records set payload=jsonb_set(payload,'{archive_tables,experiment_sources}',$1) where entity_id='reconstruction'",[descriptor]);
 assert.equal((await db.query("select count(*)::int n from public.entity_records where entity_type='husbandry_events'")).rows[0].n,0);
});
await test('CSV preflight and independent parser preserve INSERT-only payload; postflight rejects incomplete upload',async()=>{
 const csv=plan.csv_files[0];assert(!/[^\x00-\x7f]/.test(csv.csv));assert((await db.exec(csv.preflight)).some(x=>x.rows?.[0]?.csv_insert_preflight_passed));await reject(csv.postflight,/batch missing/);
 const parsed=spawnSync('python3',['-c','import csv,json,sys;print(json.dumps(list(csv.DictReader(sys.stdin))))'],{input:csv.csv,encoding:'utf8'});assert.equal(parsed.status,0);const rows=JSON.parse(parsed.stdout);assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0].payload),record);assert.equal(rows[0].version,'1');assert.equal(rows[0].archived,'false');assert.equal(rows[0].created_by,owner);
});
await test('actual SQL inserts version1, emits hash receipt and retries do not overwrite or add audit',async()=>{
 const before=(await db.query("select payload,version from public.entity_records where entity_id='reconstruction'")).rows[0];
 const out=await db.exec(plan.files[0].sql),receipt=out.find(x=>x.rows?.[0]?.batch_id)?.rows[0];assert(receipt);assert.equal(receipt.verified_records,1);assert.equal(receipt.payload_fingerprints_sha256,plan.files[0].expected_payload_fingerprints_sha256);
 const stored=(await db.query('select * from public.entity_records where entity_id=$1',[record.event_id])).rows[0];assert.equal(stored.version,1);assert.equal(stored.created_by,owner);assert.deepEqual(stored.payload,record);
 const audit=(await db.query('select count(*)::int n from public.audit_log')).rows[0].n;await db.exec(plan.files[0].sql);assert.equal((await db.query('select count(*)::int n from public.audit_log')).rows[0].n,audit);
 assert.deepEqual((await db.query("select payload,version from public.entity_records where entity_id='reconstruction'")).rows[0],before);
 assert((await db.exec(plan.csv_files[0].postflight)).some(x=>x.rows?.[0]?.csv_verified));await reject(plan.csv_files[0].preflight,/Target IDs already exist/);
});
await test('owner changes and archived payloads block retry; other-ID source collisions never silently duplicate',async()=>{
 await db.query("update public.entity_records set payload=jsonb_set(payload,'{experiment,title}','\"Owner reviewed\"') where entity_id=$1",[record.event_id]);await reject(plan.files[0].sql,/refusing overwrite/);
 await db.query('update public.entity_records set payload=$1,archived=true where entity_id=$2',[record,record.event_id]);await reject(plan.files[0].sql,/refusing overwrite/);
 await db.query('update public.entity_records set archived=false where entity_id=$1',[record.event_id]);
 await db.query("insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by)values($1,'husbandry_events','OWNER-REVIEW',$2,$3,$3)",[colony,{...record,event_id:'OWNER-REVIEW'},owner]);await reject(plan.files[0].sql,/another managed experiment/);
});
await test('a conflict on the second draft rolls back the first insert in the bounded transaction',async()=>{
 const sources=[{...source,source_id:'atomic-1',range:'A9:W9',provenance_refs:[[0,0,'Sampling','A9:W9']]},{...source,source_id:'atomic-2',range:'A10:W10',provenance_refs:[[0,0,'Sampling','A10:W10']]}],d={tables:{...dataset.tables,experiment_sources:sources}},ctx=createDraftContext(d,{preparedAt:at}),records=sources.map(s=>prepareSourceDraft(s,ctx).record),desc=sourceArchiveDescriptor(sources),p=prepareExperimentDraftImport({...options,records,dataset:d,sourceDescriptor:desc});
 await db.query("update public.entity_records set payload=jsonb_set(payload,'{archive_tables,experiment_sources}',$1) where entity_id='reconstruction'",[desc]);
 await db.query("insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by)values($1,'husbandry_events',$2,$3,$4,$4)",[colony,records[1].event_id,{...records[1],experiment:{...records[1].experiment,title:'Reviewed already'}},owner]);
 await reject(p.files[0].sql,/refusing overwrite/);
 assert.equal((await db.query('select count(*)::int n from public.entity_records where entity_id=$1',[records[0].event_id])).rows[0].n,0);
});
await test('optional private whole-preview validation uses actual maintained SQL validator without importing records',async()=>{
 if(!process.env.EXPERIMENT_DRAFT_RECORDS)return;
 const records=(await readFile(process.env.EXPERIMENT_DRAFT_RECORDS,'utf8')).trim().split('\n').map(JSON.parse);let checked=0;
 for(let i=0;i<records.length;i+=100){const batch=records.slice(i,i+100);try{await db.query("select colony_private.validate_payload('husbandry_events',x->>'event_id',x) from jsonb_array_elements($1::jsonb) x",[JSON.stringify(batch)]);}catch(error){throw new Error('Private payload validation failed at bounded batch '+Math.floor(i/100)+', SQLSTATE '+(error.code??'unknown'));}checked+=batch.length;}
 assert.equal(checked,records.length);console.log(JSON.stringify({private_payloads_validated:checked,live_database:false}));
});

await test('ASCII SQL preserves supplementary Unicode and guarded title repair only changes observed encoding corruption',async()=>{
 const expected={...record,event_id:'ENCODING-TEST',source_title:'Source 📓 腦'},observed={...expected,source_title:'Source �� 腦'};
 assert.equal(JSON.parse(asciiJson(expected)).source_title,expected.source_title);assert(!/[^\x00-\x7f]/.test(asciiJson(expected)));
 const repair=prepareCsvSourceTitleRepair({expectedRecord:expected,observedPayload:observed,colonyId:colony,ownerUserId:owner,sourceDescriptor:descriptor});assert(!/[^\x00-\x7f]/.test(repair.sql));
 assert.throws(()=>prepareCsvSourceTitleRepair({expectedRecord:expected,observedPayload:{...observed,event_date:'2026-01-01'},colonyId:colony,ownerUserId:owner,sourceDescriptor:descriptor}),/limited/);
 await db.query("update public.entity_records set payload=jsonb_set(payload,'{archive_tables,experiment_sources}',$1) where entity_id='reconstruction'",[descriptor]);
 await db.query("insert into public.entity_records(colony_id,entity_type,entity_id,payload,version,created_by,updated_by)values($1,'husbandry_events',$2,$3,1,$4,$4)",[colony,expected.event_id,observed,owner]);
 await db.exec(repair.sql);const after=(await db.query('select payload,version from public.entity_records where entity_id=$1',[expected.event_id])).rows[0];assert.deepEqual(after,{payload:expected,version:2});
 const audit=(await db.query('select count(*)::int n from public.audit_log')).rows[0].n;await db.exec(repair.sql);assert.equal((await db.query('select count(*)::int n from public.audit_log')).rows[0].n,audit);
 await db.query("update public.entity_records set payload=jsonb_set(payload,'{experiment,title}','\"Owner review\"') where entity_id=$1",[expected.event_id]);await reject(repair.sql,/Record changed/);
});

await db.close();
