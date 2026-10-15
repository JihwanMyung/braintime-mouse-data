import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {prepareExperimentImport,postgresJsonbText} from '../../scripts/prepare-experiment-import.mjs';
import {encodeArchive,decodeArchive} from '../../web/archive-format.js';
const colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const original={source_note:'Original imported metadata',custom_metadata:{keep:'Original'},tables:{historical_observations:[{id:'KEEP',text:'Existing historical row'}],old_scalar_metadata:{retain:true}}};
const initialArchive=await encodeArchive(original),manifest=initialArchive.at(-1).payload;
const sources={observations:[{source_id:'source-1',raw_identifier:'OLD-01',raw_values:{A1:"O'Brien",B2:'腦時鐘 🐁',C3:1e-7,D4:'$stage_experiments$; SELECT 1; $publish_experiments$; $$ -- source text'},provenance:[{workbook_id:'file-1',sheet_id:2,row:3}]}],sources:[{file_id:'file-1',title:'Synthetic Experiment Sheet'}],contexts:[{context_id:'ctx1',protocol:'Preserve prep context'}],coverage:{workbooks:1,caveat:'Source reports, identities unconfirmed'}};
const options={manifest:{colony_id:colony,version:2,payload:manifest},sources,colonyId:colony};
const plan=await prepareExperimentImport(options);
async function database(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
 await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1),($2)',[owner,other]);await db.query('insert into public.colonies(id,name,created_by)values($1,$2,$3)',[colony,'Synthetic experiment import',owner]);await db.query('insert into public.memberships(colony_id,user_id,role)values($1,$2,$3)',[colony,owner,'owner']);
 for(const row of initialArchive)await db.query('insert into public.entity_records(colony_id,entity_type,entity_id,payload,version,created_by,updated_by)values($1,$2,$3,$4,$5,$6,$6)',[colony,'archive',row.entity_id,row.payload,row.entity_id==='reconstruction'?2:1,owner]);
 await db.query('insert into public.entity_records(colony_id,entity_type,entity_id,payload,version,created_by,updated_by)values($1,$2,$3,$4,$5,$6,$6)',[colony,'mice','MOUSE-KEEP',{mouse_sid:'MOUSE-KEEP',state:'Stock',source_record:'Original source'},7,owner]);
 return db;
}
const stages=p=>p.files.filter(file=>file.kind==='stage');
const final=p=>p.files.find(file=>file.kind==='manifest').sql;
async function rejected(db,sql,pattern){await assert.rejects(()=>db.exec(sql),pattern);await db.exec('rollback');}
async function head(db){return (await db.query("select payload,version from public.entity_records where entity_type='archive' and entity_id='reconstruction'")).rows[0];}

await test('PostgreSQL JSONB fingerprints match actual engine serialization for Unicode, exponents and nested values',async()=>{
 const db=new PGlite();
 const fixtures=[sources,{'zz':1,'a':2,'腦':3,'é':4,'😀':5,'aaa':6,'aa':7},[0,-0,1e-7,1e21,-1.23e-20,1.2345678901234567e25,1e-308,Number.MAX_VALUE],{escape:'a\nb\t"\\\r\b\f',slash:'/',lines:'\u2028\u2029'}];
 for(const value of fixtures){const actual=(await db.query('select $1::jsonb::text as text',[JSON.stringify(value)])).rows[0].text;assert.equal(postgresJsonbText(value),actual);}
 await db.close();
});
await test('generator validates manifest scope, source IDs, encoding, sizes and additive-only descriptors',async()=>{
 await assert.rejects(prepareExperimentImport({...options,colonyId:other}),/different colony/);
 await assert.rejects(prepareExperimentImport({...options,version:1}),/differs/);
 await assert.rejects(prepareExperimentImport({...options,version:0,manifest}),/positive PostgreSQL/);
 await assert.rejects(prepareExperimentImport({...options,sources:[{source_id:'same'},{source_id:'same'}]}),/Duplicate/);
 await assert.rejects(prepareExperimentImport({...options,sources:[{raw_values:[]}]}),/source_id/);
 for(const bad of ['\0','\ud800','\udfff'])await assert.rejects(prepareExperimentImport({...options,sources:[{source_id:'bad',text:bad}]}),/encoding/);
 await assert.rejects(prepareExperimentImport({...options,sources:[{source_id:'big',text:'x'.repeat(250000)}]}),/chunk limit/);
 const different=structuredClone(manifest);different.archive_tables.experiment_sources={row_count:1,chunk_ids:[]};await assert.rejects(prepareExperimentImport({...options,manifest:different,version:2}),/differs/);
 const legacy=structuredClone(manifest);legacy.tables.experiment_sources=[];await assert.rejects(prepareExperimentImport({...options,manifest:legacy,version:2}),/Legacy/);
 assert.deepEqual(Object.keys(plan.tables),['experiment_sources','experiment_source_catalog','experiment_source_contexts','experiment_source_coverage']);assert(plan.files.every(file=>file.bytes<=800000));
});
await test('staging and final CAS preserve existing records, metadata and source tables; retries create no extra audit',async()=>{
 const db=await database(),before=(await db.query("select * from public.entity_records where entity_id='MOUSE-KEEP'")).rows[0];
 const beforePreflight=(await db.exec(plan.preflightSql)).at(-1).rows[0];assert.equal(beforePreflight.captured_manifest_matches,true);assert.equal(Number(beforePreflight.existing_expected_chunks),0);assert.deepEqual(beforePreflight.conflicting_chunk_ids,[]);
 for(const file of stages(plan))await db.exec(file.sql);assert.deepEqual(await head(db),{payload:manifest,version:2});
 const stagedPreflight=(await db.exec(plan.preflightSql)).at(-1).rows[0];assert.equal(Number(stagedPreflight.existing_expected_chunks),plan.chunks.length);assert.deepEqual(stagedPreflight.conflicting_chunk_ids,[]);
 await db.exec(final(plan));const current=await head(db);assert.equal(current.version,3);assert.deepEqual(current.payload,plan.mergedManifest);
 const rows=(await db.query("select * from public.entity_records where entity_type='archive'")).rows,data=await decodeArchive(rows);
 assert.deepEqual(data.tables.experiment_sources,sources.observations);assert.deepEqual(data.tables.experiment_source_catalog,sources.sources);assert.deepEqual(data.tables.experiment_source_contexts,sources.contexts);assert.deepEqual(data.tables.experiment_source_coverage,[sources.coverage]);assert.deepEqual(data.tables.historical_observations,original.tables.historical_observations);assert.deepEqual(data.tables.old_scalar_metadata,original.tables.old_scalar_metadata);assert.equal(data.source_note,original.source_note);assert.deepEqual(data.custom_metadata,original.custom_metadata);
 assert.deepEqual((await db.query("select * from public.entity_records where entity_id='MOUSE-KEEP'")).rows[0],before);
 const auditCount=(await db.query('select count(*)::integer n from public.audit_log')).rows[0].n;
 for(const file of plan.files)await db.exec(file.sql);assert.equal((await db.query('select count(*)::integer n from public.audit_log')).rows[0].n,auditCount);assert.equal((await db.query('select count(*)::integer n from public.audit_log where actor_id is not null')).rows[0].n,0);
 await db.close();
});
await test('final refuses missing chunks and staged chunks are invisible until manifest commit',async()=>{
 const db=await database();await rejected(db,final(plan),/Missing or invalid source chunk/);assert.deepEqual(await head(db),{payload:manifest,version:2});
 await db.exec(stages(plan)[0].sql);const decoded=await decodeArchive((await db.query("select * from public.entity_records where entity_type='archive'")).rows);assert.equal(decoded.tables.experiment_sources,undefined);
 await db.close();
});
await test('stale versions, changed payloads and tampered chunk fingerprints abort without overwriting',async()=>{
 const db=await database();for(const file of stages(plan))await db.exec(file.sql);
 await db.query("update public.entity_records set version=3 where entity_id='reconstruction'");await rejected(db,final(plan),/Manifest changed/);
 await db.query("update public.entity_records set version=2,payload=jsonb_set(payload,'{custom_metadata,keep}','\"Changed\"') where entity_id='reconstruction'");await rejected(db,final(plan),/Manifest changed/);
 await db.query("update public.entity_records set payload=$1 where entity_id='reconstruction'",[manifest]);
 await db.query("update public.entity_records set payload=jsonb_set(payload,'{rows,0,raw_identifier}','\"Tampered\"') where entity_id=$1",[plan.chunks.find(chunk=>chunk.payload.table==='experiment_sources').entity_id]);
 const preflight=(await db.exec(plan.preflightSql)).at(-1).rows[0];assert.equal(preflight.conflicting_chunk_ids.length,1);
 await rejected(db,final(plan),/fingerprint/);await rejected(db,stages(plan)[0].sql,/differs, refusing overwrite/);assert.deepEqual(await head(db),{payload:manifest,version:2});
 await db.close();
});
await test('administrator identity remains genuine and responsible owner must be unambiguous or explicitly verified',async()=>{
 const db=await database();await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await rejected(db,stages(plan)[0].sql,/unclaimed administrator/);await db.query("select set_config('request.jwt.claim.sub','',false)");
 await db.query('insert into public.memberships(colony_id,user_id,role)values($1,$2,$3)',[colony,other,'owner']);await rejected(db,stages(plan)[0].sql,/explicit active owner/);
 const explicit=await prepareExperimentImport({...options,ownerUserId:owner});for(const file of explicit.files)await db.exec(file.sql);assert.equal((await head(db)).version,3);
 const wrong=await prepareExperimentImport({...options,ownerUserId:'33333333-3333-4333-8333-333333333333'});await rejected(db,stages(wrong)[0].sql,/not an active/);
 await db.close();
});

await test('CSV contains only insert-only new chunks, round-trips through an independent parser and supports final CAS',async()=>{
 const csvPlan=await prepareExperimentImport({...options,ownerUserId:owner,chunkCsv:true});assert.equal(csvPlan.csvFiles.length,1);
 const parsed=spawnSync('python3',['-c','import csv,json,sys; print(json.dumps(list(csv.DictReader(sys.stdin))))'],{input:csvPlan.csvFiles[0].csv,encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);const records=JSON.parse(parsed.stdout);
 assert.equal(records.length,csvPlan.chunks.length);assert(records.every(row=>row.entity_type==='archive'&&row.entity_id.startsWith('chunk:')&&row.version==='1'&&row.archived==='false'&&row.created_by===owner&&row.updated_by===owner));assert(!records.some(row=>row.entity_id==='reconstruction'));
 const db=await database();for(const row of records)await db.query('insert into public.entity_records(colony_id,entity_type,entity_id,payload,version,archived,created_by,updated_by)values($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',Object.values(row));
 await db.exec(final(csvPlan));const data=await decodeArchive((await db.query("select * from public.entity_records where entity_type='archive'")).rows);assert.deepEqual(data.tables.experiment_sources,sources.observations);
 const filtered=await prepareExperimentImport({...options,ownerUserId:owner,chunkCsv:true,existingChunkIds:[csvPlan.chunks[0].entity_id]});assert.equal(filtered.csvOmittedExisting,1);assert(!filtered.csvFiles[0].records.some(row=>row.entity_id===csvPlan.chunks[0].entity_id));assert.equal(filtered.chunks.length,csvPlan.chunks.length);
 await assert.rejects(prepareExperimentImport({...options,chunkCsv:true}),/explicit verified/);await db.close();
});
await test('CLI output is private, refuses overwrite and never writes generated sources into the public repository',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'experiment-import-test-'));
 try{
  const manifestPath=join(dir,'manifest.json'),sourcePath=join(dir,'sources.json'),out=join(dir,'out');await writeFile(manifestPath,JSON.stringify(options.manifest));await writeFile(sourcePath,JSON.stringify(sources));
  const script=new URL('../../scripts/prepare-experiment-import.mjs',import.meta.url).pathname,args=[script,'--manifest',manifestPath,'--sources',sourcePath,'--colony-id',colony,'--owner-user-id',owner,'--chunk-csv','chunks.csv','--output-dir',out];
  const result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.executed,false);assert.equal(report.csv_files,1);assert.equal((await stat(out)).mode&0o777,0o700);assert.equal((await stat(join(out,'chunks.csv'))).mode&0o777,0o600);
  const again=spawnSync(process.execPath,args,{encoding:'utf8'});assert.notEqual(again.status,0);assert.match(again.stderr,/EEXIST/);
  const publicArgs=[...args.slice(0,-1),new URL('../../web/forbidden-private-output',import.meta.url).pathname];const blocked=spawnSync(process.execPath,publicArgs,{encoding:'utf8'});assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/outside the public repository/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

await test('verified append preserves every historical prefix and refuses mutated baseline or replaced rows',async()=>{
 const db=await database();for(const file of plan.files)await db.exec(file.sql);
 const before=await head(db),next={...sources,observations:[...sources.observations,{source_id:'source-2',raw_values:{time:'10:45'}}],contexts:[...sources.contexts,{context_id:'ctx2',values:{tail:'Original omitted time'}}],coverage:{workbooks:1,observations:2},coverage_history:[sources.coverage,{workbooks:1,observations:2}]};
 const appended=await prepareExperimentImport({...options,manifest:{colony_id:colony,...before},baselineSources:sources,sources:next});
 assert.equal(appended.expectedVersion,3);
 for(const table of ['experiment_sources','experiment_source_contexts','experiment_source_coverage']){
  const bad=structuredClone(next),key={experiment_sources:'observations',experiment_source_contexts:'contexts',experiment_source_coverage:'coverage_history'}[table];bad[key][0]={changed:true,source_id:'changed'};
  await assert.rejects(prepareExperimentImport({...options,manifest:{colony_id:colony,...before},baselineSources:sources,sources:bad}),/unchanged.*prefix/);
 }
 const forged=structuredClone(sources);forged.observations[0].raw_identifier='FORGED';
 await assert.rejects(prepareExperimentImport({...options,manifest:{colony_id:colony,...before},baselineSources:forged,sources:{...next,observations:[...forged.observations,...next.observations.slice(1)]}}),/does not match the verified baseline/);
 for(const file of appended.files)await db.exec(file.sql);
 const decoded=await decodeArchive((await db.query("select * from public.entity_records where entity_type='archive'")).rows);
 assert.deepEqual(decoded.tables.experiment_sources,next.observations);assert.deepEqual(decoded.tables.experiment_source_coverage,next.coverage_history);assert.deepEqual(decoded.tables.historical_observations,original.tables.historical_observations);
 for(const file of appended.files)await db.exec(file.sql);assert.equal((await head(db)).version,4);
 await db.close();
});
