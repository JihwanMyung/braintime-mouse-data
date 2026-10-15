import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {cageObservations} from '../../web/cage-observations.js';
import {observationCandidates,observationBackfillSQL,prepareCageObservations} from '../../scripts/prepare-cage-observations.mjs';
const db=new PGlite(),cid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='11111111-1111-4111-8111-111111111111';
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now());create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
create schema storage;create table storage.objects(id text,bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant select,insert on storage.objects to authenticated;`);
for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql','iacuc.sql','locobox.sql','ear-marks.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.exec(`create function colony_private.history_path_colony(n text) returns uuid language sql immutable as $$select split_part(n,'/',1)::uuid$$;grant execute on function colony_private.history_path_colony(text) to authenticated;`);
await db.exec(await readFile(new URL('../lac-fee-visibility.sql',import.meta.url),'utf8'));
const originalKeys=(await db.query('select colony_private.managed_location_keys() keys')).rows[0].keys;
const grantsBefore=(await db.query("select proname,proacl::text acl from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' and proname in ('get_managed_locations','save_record') order by proname")).rows;
const migration=await readFile(new URL('../cage-observations.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
await db.query('insert into auth.users(id) values($1)',[owner]);await db.query('insert into colonies(id,name,created_by) values($1,$2,$3)',[cid,'Test',owner]);await db.query("insert into memberships(colony_id,user_id,role,export_level) values($1,$2,'owner','max')",[cid,owner]);
await db.exec('create table colony_private.animal_sheet_import_settings(colony_id uuid primary key,responsible_user_id uuid)');await db.query('insert into colony_private.animal_sheet_import_settings values($1,$2)',[cid,owner]);
await db.exec("create table colony_private.animal_sheet_import_state(colony_id uuid primary key,baseline jsonb not null,baseline_revision integer not null default 1,active_job_id uuid)");
const position={location_id:'loc-test',record_origin:'current_google_sheet_map',source_current:true,source_cell:'T7',source_block_range:'T6:Y13',source_file_id:'example-source-file',source_sheet_id:1717598677,source_block_text:"W6: Vuong\nT7: L7\nT10: PB'-M3193\nU10: 0039 PB\nV10: 2026-07-23\nW10: 1\nX10: 1\nT13: 2025-12-25\nU13: 150 lux\nX13: PRIVATE FEE 1234",manager:'Explicit manager',source_observed_cage_sids:['cage-x'],source_observed_mouse_sids:['3193']};
const observation=cageObservations(position),valid=async p=>(await db.query('select colony_private.valid_cage_observation($1) valid',[p])).rows[0].valid;
const source=await readFile(new URL('../../web/data-store.js',import.meta.url),'utf8');
const clientValidator=vm.runInNewContext(source.slice(source.indexOf('function validCageObservation('),source.indexOf('function managedLocationPayload('))+';validCageObservation');
const insert=async(id,p=position,version=1)=>db.query('insert into entity_records(colony_id,entity_type,entity_id,payload,version,created_by,updated_by) values($1,\'locations\',$2,$3,$4,$5,$5)',[cid,id,{...p,location_id:id},version,owner]);
const makeRow=(id,version=1)=>({colony_id:cid,entity_id:id,entity_type:'locations',version,archived:false,payload:{...position,location_id:id}});
await test('migration preserves all managed keys, existing RPC grants, and admits the parser output',async()=>{
 const keys=(await db.query('select colony_private.managed_location_keys() keys')).rows[0].keys;assert.deepEqual(keys,[...new Set([...originalKeys,'source_cage_observation'])]);
 assert.deepEqual((await db.query("select proname,proacl::text acl from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' and proname in ('get_managed_locations','save_record') order by proname")).rows,grantsBefore);
 assert.equal(await valid(observation),true);assert.equal(clientValidator(observation),true);assert.equal(observation.animals[0].earMark,'L1R1');assert.equal(observation.intensityLux,150);assert(!JSON.stringify(observation).includes('PRIVATE'));
 const projected=(await db.query('select colony_private.managed_location_payload($1) p',[{...position,app_modified_at:'2026-10-16T02:00:00Z',source_cage_observation:observation}])).rows[0].p;assert.equal(projected.app_modified_at,'2026-10-16T02:00:00Z');assert.equal(projected.source_cage_observation.animals[0].note,'0039 PB');assert(!projected.source_block_text);
});
await test('nested raw fields and malformed values fail closed in SQL, browser projection and row writes',async()=>{
 const variants=[{...observation,source_block_text:'PRIVATE FEE'},{...observation,animals:[{...observation.animals[0],fee_amount:12}]},{...observation,animals:[{...observation.animals[0],dateOfBirth:'2026-02-31'}]},{...observation,animals:[{...observation.animals[0],left:0.5}]},{...observation,animals:[{...observation.animals[0],earMark:'L0R1'}]},{...observation,animals:[{...observation.animals[0],note:'x'.repeat(2001)}]},{...observation,managerCell:'T0'},{...observation,intensityLux:1000001},{...observation,animals:Array(101).fill(observation.animals[0])}];
 for(const bad of variants){assert.equal(await valid(bad),false);assert.equal(clientValidator(bad),false);const p=(await db.query('select colony_private.managed_location_payload($1) p',[{...position,source_cage_observation:bad}])).rows[0].p;assert(!p.source_cage_observation);await assert.rejects(()=>insert('invalid',{...position,source_cage_observation:bad}),e=>e.code==='22023');}
});
await test('users retain source observations while editing managed fields, but cannot create or alter source observations',async()=>{
 await insert('edit',{...position,source_cage_observation:observation});
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 try{
  await assert.rejects(()=>insert('user-created',{...position,source_cage_observation:observation}),e=>e.code==='42501');
  await assert.rejects(()=>db.query("update entity_records set payload=jsonb_set(payload,'{source_cage_observation,intensityLux}','250') where entity_id='edit'"),e=>e.code==='42501');
  const p=(await db.query("select payload from entity_records where entity_id='edit'")).rows[0].payload;
  const saved=(await db.query("select * from public.save_record($1,'locations','edit',$2,1)",[cid,{...p,notes:'ordinary note'}])).rows[0];assert.equal(saved.payload.source_cage_observation.intensityLux,150);assert.equal(saved.payload.notes,'ordinary note');
 }finally{await db.query("select set_config('request.jwt.claim.sub','',false)");}
});
await test('restricted members receive only validated observations and can preserve them through ordinary location edits',async()=>{
 const editor='22222222-2222-4222-8222-222222222222';await db.query('insert into auth.users(id) values($1)',[editor]);await db.query("insert into memberships(colony_id,user_id,role,export_level) values($1,$2,'editor','low')",[cid,editor]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 await db.query('select public.save_lac_fee_visibility($1,0,$2)',[cid,{low:{estimate:false,actual:false},high:{estimate:true,actual:true},max:{estimate:true,actual:true}}]);
 await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[editor]);
 try{
  const page=(await db.query('select public.get_managed_locations($1,0,250) p',[cid])).rows[0].p;const row=page.rows.find(r=>r.entity_id==='edit');assert.equal(row.payload.source_cage_observation.intensityLux,150);assert(!JSON.stringify(page).includes('PRIVATE'));
  const saved=(await db.query("select * from public.save_record($1,'locations','edit',$2,$3)",[cid,{...row.payload,notes:'Restricted managed edit'},row.version])).rows[0];assert.equal(saved.payload.source_cage_observation.animals[0].earMark,'L1R1');assert(!JSON.stringify(saved).includes('PRIVATE'));
 }finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}
 assert.equal((await db.query("select payload->>'source_block_text' source from entity_records where entity_id='edit'")).rows[0].source,position.source_block_text);
});
await test('backfill uses per-record version and exact source CAS, preserves raw provenance, audits changes, and is idempotent',async()=>{
 for(const id of ['fresh','stale-version','stale-source','baseline-drift'])await insert(id);
 await db.query("update entity_records set version=2,payload=payload||'{\"manager\":\"New manager\"}' where entity_id='stale-version'");
 await db.query("update entity_records set payload=payload||'{\"source_block_text\":\"changed source\"}' where entity_id='stale-source'");
 const rows=['fresh','stale-version','stale-source','baseline-drift'].map(id=>makeRow(id));const baseline={schema_version:1,entries:rows.map(r=>({entity_type:'locations',entity_id:r.entity_id,payload:{...r.payload,...(r.entity_id==='baseline-drift'?{source_block_text:'baseline differs'}:{})},source_present:true}))};await db.query('insert into colony_private.animal_sheet_import_state(colony_id,baseline) values($1,$2)',[cid,baseline]);
 const candidates=observationCandidates(rows,{colonyId:cid});const sql=observationBackfillSQL(candidates,{sha256:'a'.repeat(64)});
 await db.exec(sql);let report=(await db.query("select current_setting('braintime.cage_observation_backfill_report')::jsonb report")).rows[0].report;
 assert.equal(report.updated,1);assert.equal(report.baseline_updates,1);assert.deepEqual(report.records.map(r=>r.status),['updated','version_changed','source_changed','baseline_source_changed']);
 const saved=(await db.query("select payload,version,updated_by from entity_records where entity_id='fresh'")).rows[0];assert.equal(saved.version,2);assert.equal(saved.updated_by,owner);assert.deepEqual(saved.payload.source_observed_cage_sids,['cage-x']);assert.equal(saved.payload.source_block_text,position.source_block_text);assert.equal(saved.payload.manager,position.manager);assert.equal(saved.payload.source_cage_observation.animals[0].note,'0039 PB');
 assert.equal((await db.query("select count(*)::integer n from audit_log where entity_id='fresh' and operation='UPDATE'")).rows[0].n,1);
 await db.exec(sql);report=(await db.query("select current_setting('braintime.cage_observation_backfill_report')::jsonb report")).rows[0].report;assert.equal(report.updated,0);assert.equal(report.baseline_updates,0);assert.equal(report.records[0].status,'already_current');
 const stored=(await db.query('select baseline,baseline_revision from colony_private.animal_sheet_import_state where colony_id=$1',[cid])).rows[0];assert.equal(stored.baseline_revision,2);assert.equal(stored.baseline.entries[0].payload.source_cage_observation.animals[0].earMark,'L1R1');assert(!stored.baseline.entries[1].payload.source_cage_observation);assert(!stored.baseline.entries[3].payload.source_cage_observation);
});
await test('backfill refuses concurrent imports before any mutation',async()=>{
 await db.query('update colony_private.animal_sheet_import_state set active_job_id=$1 where colony_id=$2',[owner,cid]);
 const sql=observationBackfillSQL(observationCandidates([makeRow('fresh')],{colonyId:cid}),{sha256:'a'.repeat(64)});
 try{await assert.rejects(()=>db.exec(sql),/import is active/);}finally{await db.exec('rollback');await db.query('update colony_private.animal_sheet_import_state set active_job_id=null where colony_id=$1',[cid]);}
 assert.equal((await db.query("select version from entity_records where entity_id='fresh'")).rows[0].version,2);
});
await test('preparation rejects ambiguous inputs and public output destinations, reparses original cells, and reports missing sources',async()=>{
 assert.throws(()=>observationCandidates([makeRow('x'),makeRow('x')],{colonyId:cid}),/duplicate/);
 assert.throws(()=>observationCandidates([{...makeRow('x'),version:undefined}],{colonyId:cid}),/version/);
 assert.throws(()=>observationCandidates([{...makeRow('x'),colony_id:owner}],{colonyId:cid}),/different colony/);
 const row=makeRow('x');row.payload.source_cage_observation={...observation,intensityLux:999};const missing=makeRow('missing');delete missing.payload.source_cell;
 const c=observationCandidates({rows:[row,missing]},{colonyId:cid});assert.equal(c.entries[0].observation.intensityLux,150);assert.equal(c.skipped[0].reason,'missing_source_coordinates');
 await assert.rejects(()=>prepareCageObservations({input:'unused',output:'/tmp/web/private.sql',colonyId:cid}),/outside published/);
});
await db.close();
