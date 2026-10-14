import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids=Object.fromEntries(['owner','editor','viewer','manager','disabled','foreign'].map((name,i)=>[name,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
const source='SYNTHETIC_ANIMAL_SOURCE_0000000000000001',hash='a'.repeat(64),raw={spreadsheetId:source,sheets:[],private_marker:'RAW-SNAPSHOT'};
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema vault;create schema net;create schema cron;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
grant usage on schema auth to anon,authenticated,service_role;grant execute on all functions in schema auth to anon,authenticated,service_role;
create table vault.decrypted_secrets(name text,decrypted_secret text);
insert into vault.decrypted_secrets values('animal_sheet_sync_secret',repeat('test-only-',8));
create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb,timeout_milliseconds integer);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$declare saved_id bigint;begin insert into net.requests(url,headers,body,timeout_milliseconds) values(http_post.url,http_post.headers,http_post.body,http_post.timeout_milliseconds) returning net.requests.id into saved_id;return saved_id;end$$;
create table cron.jobs(name text primary key,schedule text,command text,active boolean default true);
create view cron.job as select name jobname,schedule,active from cron.jobs;
create function cron.schedule(job_name text,schedule text,command text) returns bigint language plpgsql as $$begin insert into cron.jobs(name,schedule,command) values(job_name,schedule,command) on conflict(name) do update set schedule=excluded.schedule,command=excluded.command;return 1;end$$;`);
for(const name of Object.keys(ids))await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[ids[name],name+'@example.org']);
for(const file of ['schema.sql','functions/manage-colony-users/membership.sql','export-permissions.sql','manager-permissions.sql','lab-members.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3),($4,$5,$6)',[colony,'Source import',ids.owner,other,'Other',ids.foreign]);
for(const name of Object.keys(ids))await db.query('insert into public.memberships(colony_id,user_id,role,active,updated_by) values($1,$2,$3,$4,$5)',[name==='foreign'?other:colony,ids[name],name==='foreign'?'owner':name==='disabled'?'editor':name,name!=='disabled',ids.owner]);
const migration=await readFile(new URL('../animal-sheet-import.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
const schedule=await readFile(new URL('../animal-sheet-import-schedule.sql',import.meta.url),'utf8');
async function as(name,fn,role='authenticated',claimRole=role){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",[name?ids[name]:'',claimRole]);try{return await fn();}finally{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.role','',false)");}}
const rpc=async(name,args=[])=>{const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');return(await db.query(`select public.${name}(${placeholders}) result`,args)).rows[0].result;};
const denied=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true;});
const service=fn=>as(null,fn,'service_role');
async function freshJob(user='owner'){await db.query("update colony_private.animal_sheet_import_settings set last_requested_at=null where colony_id=$1",[colony]);return as(user,()=>rpc('request_animal_sheet_import',[colony]));}
const claim=job=>service(()=>rpc('claim_animal_sheet_import',[colony,job.job_id]));
const entry=(id,name,version=0)=>({entity_type:'rooms',entity_id:id,expected_version:version,archived:false,payload:{room_id:id,name,record_origin:'current_google_sheet_map',source_file_id:source}});
const plan=(changes=[],extra={})=>({changes,historyRecords:[],conflicts:[],nextBaseline:{schema_version:1,source_id:source,entries:[]},summary:{updated:changes.length},...extra});
const commit=(job,context,p=plan(),snapshot=raw)=>service(()=>rpc('commit_animal_sheet_import',[colony,job.job_id,context.token,context.baseline_revision,new Date().toISOString(),hash,snapshot,p]));
await test('private tables and worker RPC are inaccessible to browser roles; manual import requires imports and housing',async()=>{
 for(const user of ['owner','editor','viewer','manager','disabled','foreign'])await as(user,async()=>{for(const table of ['settings','state','jobs','snapshots'])await denied(()=>db.query('select * from colony_private.animal_sheet_import_'+table));await denied(()=>rpc('claim_animal_sheet_import',[colony,colony]));});
 await as('owner',()=>denied(()=>rpc('claim_animal_sheet_import',[colony,colony])),'authenticated','service_role');
 await as('owner',()=>denied(()=>rpc('claim_animal_sheet_import',[colony,colony])),'service_role');
 await as(null,()=>denied(()=>rpc('get_animal_sheet_import_status',[colony])),'anon');
 for(const user of ['viewer','disabled','foreign'])await as(user,()=>denied(()=>rpc('request_animal_sheet_import',[colony])));
 for(const key of ['imports','housing']){await db.query("update public.memberships set permissions=jsonb_set(permissions,array[$2], 'false') where user_id=$1",[ids.manager,key]);await as('manager',()=>denied(()=>rpc('request_animal_sheet_import',[colony])));await db.query("update public.memberships set permissions=jsonb_set(permissions,array[$2], 'true') where user_id=$1",[ids.manager,key]);}
 assert.equal((await as('viewer',()=>rpc('get_animal_sheet_import_status',[colony]))).configured,false);
 await as('owner',()=>denied(()=>rpc('request_animal_sheet_import',[colony]),'55000'));
 assert.equal((await db.query('select count(*) n from net.requests')).rows[0].n,0);
});
await test('queue serializes bursts, claims once, and returns limited source data without secrets',async()=>{
 await db.query('insert into colony_private.animal_sheet_import_settings(colony_id,function_url,responsible_user_id,enabled,gateway_anon_key,source_spreadsheet_id) values($1,$2,$3,true,$4,$5)',[colony,'https://test.supabase.co/functions/v1/import-animal-sheet',ids.owner,'test.'+Buffer.from(JSON.stringify({role:'anon'})).toString('base64url')+'.signature-is-test-only',source]);
 await db.query("insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by) values($1,'mice','M1',$2,$3,$3)",[colony,{mouse_sid:'M1',physical_tag:'P1',notes:'PRIVATE-MOUSE-NOTES'},ids.owner]);
 const job=await freshJob('manager'),again=await as('editor',()=>rpc('request_animal_sheet_import',[colony]));assert.equal(job.job_id,again.job_id);
 assert.equal((await db.query('select count(*) n from net.requests')).rows[0].n,1);
 const request=(await db.query('select * from net.requests')).rows[0];assert.deepEqual(request.body,{job_id:job.job_id});assert.equal(request.timeout_milliseconds,120000);assert(request.headers.Authorization.startsWith('Bearer test.'));
 await db.query("insert into public.lab_members(colony_id,name,acronym,status,provenance,email,phone,created_by,updated_by) values($1,'Current Person','CP','current',$2,'private@example.org','PRIVATE PHONE',$3,$3),($1,'Historical Person','HP','historical','{}',null,null,$3,$3),($1,'Uncertain Person','UP','review','{}',null,null,$3,$3)",[colony,{aliases:['Explicit Alias'],secret:'PRIVATE-PROVENANCE'},ids.owner]);
 const context=await claim(job);assert.equal(context.baseline_revision,0);assert.equal(context.source_spreadsheet_id,source);assert.equal(context.records[0].payload.physical_tag,'P1');assert(!JSON.stringify(context).includes('PRIVATE-MOUSE-NOTES'));assert.deepEqual(context.manager_directory,[{code:'CP',name:'Current Person',aliases:['Explicit Alias']},{code:'HP',name:'Historical Person',aliases:[]}]);assert(!JSON.stringify(context).includes('private@example'));assert(!JSON.stringify(context).includes('PRIVATE-PROVENANCE'));
 assert.equal(await claim(job),null);assert.equal(await service(()=>rpc('claim_animal_sheet_import',[other,job.job_id])),null);
 const status=await as('viewer',()=>rpc('get_animal_sheet_import_status',[colony]));assert.equal(status.status,'running');assert.equal(status.schedule_active,false);assert.equal(status.schedule,null);assert(!JSON.stringify(status).includes(context.token));assert(!JSON.stringify(status).includes('test-only'));
 await service(()=>rpc('fail_animal_sheet_import',[colony,job.job_id,context.token,'source_access_denied']));
});
await test('source writes, history and snapshot commit atomically; snapshots immutable and Max only',async()=>{
 const job=await freshJob(),context=await claim(job),history={entity_type:'husbandry_events',entity_id:'SHEET-HISTORY-ONE',expected_version:0,archived:false,payload:{event_id:'SHEET-HISTORY-ONE',event_type:'animal_sheet_source_change',event_date:'2026-10-15'}};
 const p=plan([entry('ROOM1','Room One')],{historyRecords:[history]});const result=await commit(job,context,p);assert.equal(result.status,'completed');
 const row=(await db.query("select * from public.entity_records where entity_id='ROOM1'")).rows[0];assert.equal(row.version,1);assert.equal(row.updated_by,ids.owner);
 const audit=(await db.query("select actor_id from public.audit_log where entity_id='ROOM1'")).rows;assert(audit.every(r=>r.actor_id===null));
 assert.deepEqual(await commit(job,context,p),result);await service(()=>rpc('fail_animal_sheet_import',[colony,job.job_id,context.token,'commit_failed']));assert.equal((await as('owner',()=>rpc('get_animal_sheet_import_status',[colony]))).status,'completed');
 for(const user of ['viewer','editor','manager','disabled','foreign'])await as(user,()=>denied(()=>rpc('get_animal_sheet_import_snapshot',[colony,result.snapshot_id])));
 const exported=await as('owner',()=>rpc('get_animal_sheet_import_snapshot',[colony,result.snapshot_id]));assert.deepEqual(exported.raw_workbook,raw);
 await denied(()=>db.query('update colony_private.animal_sheet_import_snapshots set parsed_summary=$1 where snapshot_id=$2',[{},result.snapshot_id]));await denied(()=>db.query('delete from colony_private.animal_sheet_import_snapshots where snapshot_id=$1',[result.snapshot_id]));
 const next=await freshJob(),nextContext=await claim(next),saved=await commit(next,nextContext);assert.equal(saved.snapshot_id,result.snapshot_id);assert.equal((await db.query('select count(*) n from colony_private.animal_sheet_import_snapshots')).rows[0].n,1);
});
await test('version conflicts roll back every proposed write and baseline, leaving app changes intact',async()=>{
 const job=await freshJob(),context=await claim(job);await db.query("update public.entity_records set version=version+1,payload=jsonb_set(payload,'{name}','\"App change\"') where entity_id='ROOM1'");
 const before=(await db.query('select baseline_revision from colony_private.animal_sheet_import_state')).rows[0].baseline_revision;
 await denied(()=>commit(job,context,plan([entry('A_NEW','Never committed'),entry('ROOM1','Unsafe overwrite',1)])),'40001');
 assert.equal((await db.query("select count(*) n from public.entity_records where entity_id='A_NEW'")).rows[0].n,0);assert.equal((await db.query("select payload->>'name' name from public.entity_records where entity_id='ROOM1'")).rows[0].name,'App change');assert.equal((await db.query('select baseline_revision from colony_private.animal_sheet_import_state')).rows[0].baseline_revision,before);
 await denied(()=>commit(job,{...context,baseline_revision:-1}),'40001');await denied(()=>commit(job,{...context,token:other}),'40001');
 await service(()=>rpc('fail_animal_sheet_import',[colony,job.job_id,context.token,'commit_conflict']));
});
await test('worker cannot modify mice, archive source records, overwrite source history or use a wrong source',async()=>{
 const job=await freshJob(),context=await claim(job);
 const inputs=[plan([{...entry('ROOM1','No',2),payload:{room_id:'ROOM1',name:'Missing source'}}]),plan([{entity_type:'mice',entity_id:'M1',expected_version:1,payload:{mouse_sid:'M1'}}]),plan([{...entry('ROOM1','No',2),archived:true}]),plan([{...entry('ROOM1','No',2),payload:{...entry('ROOM1','No',2).payload,app_archived_at:'2026-10-15'}}]),plan([{entity_type:'husbandry_events',entity_id:'SHEET-HISTORY-ONE',expected_version:1,payload:{event_id:'SHEET-HISTORY-ONE',event_type:'animal_sheet_source_change'}}]),plan([entry('R','a'),entry('R','b')])];
 for(const p of inputs)await denied(()=>commit(job,context,p),'22023');await denied(()=>commit(job,context,plan(),{spreadsheetId:'wrong'}),'22023');
 await db.query('update auth.users set email_confirmed_at=null where id=$1',[ids.owner]);await denied(()=>commit(job,context));await db.query('update auth.users set email_confirmed_at=now() where id=$1',[ids.owner]);
 await service(()=>rpc('fail_animal_sheet_import',[colony,job.job_id,context.token,'RAW PRIVATE ERROR']));assert.equal((await as('owner',()=>rpc('get_animal_sheet_import_status',[colony]))).job.error,'import_failed');
});
await test('conflict snapshots preserve source and current data; limited page retrieval excludes foreign members',async()=>{
 const job=await freshJob(),context=await claim(job),conflicts=[{conflict_id:'C1',entity_type:'rooms',entity_id:'ROOM1',current_payload:{name:'App change'},source_payload:{name:'Sheet change'}},{conflict_id:'C2'}];
 const result=await commit(job,context,plan([],{conflicts}));assert.equal(result.status,'conflicts');assert.equal((await db.query("select payload->>'name' name from public.entity_records where entity_id='ROOM1'")).rows[0].name,'App change');
 const page=await as('viewer',()=>rpc('get_animal_sheet_import_conflicts',[colony,0,1]));assert.equal(page.total,2);assert.equal(page.next_offset,1);assert.deepEqual(page.conflicts,[conflicts[0]]);
 await as('foreign',()=>denied(()=>rpc('get_animal_sheet_import_conflicts',[colony,0,1])));await as('viewer',()=>denied(()=>rpc('get_animal_sheet_import_conflicts',[colony,0,201]),'22023'));
});
await test('queued manual work cannot commit after its requester loses required permissions',async()=>{
 const job=await freshJob('manager'),context=await claim(job);await db.query("update public.memberships set permissions=jsonb_set(permissions,'{imports}','false') where user_id=$1",[ids.manager]);
 await denied(()=>commit(job,context));assert.equal((await db.query('select status from colony_private.animal_sheet_import_jobs where job_id=$1',[job.job_id])).rows[0].status,'running');
 await db.query("update public.memberships set permissions=jsonb_set(permissions,'{imports}','true') where user_id=$1",[ids.manager]);await service(()=>rpc('fail_animal_sheet_import',[colony,job.job_id,context.token,'import_failed']));
});
await test('stale worker token cannot commit after queue recovery, and queue failures disclose no secret',async()=>{
 const job=await freshJob(),context=await claim(job);await db.query("update colony_private.animal_sheet_import_jobs set started_at=now()-interval '16 minutes' where job_id=$1",[job.job_id]);
 const replacement=await freshJob();assert.notEqual(replacement.job_id,job.job_id);await denied(()=>commit(job,context),'40001');const nextContext=await claim(replacement);await service(()=>rpc('fail_animal_sheet_import',[colony,replacement.job_id,nextContext.token,'source_read_failed']));
 await db.exec('delete from vault.decrypted_secrets');const failed=await freshJob();assert.equal(failed.status,'failed');assert(!JSON.stringify(failed).includes('secret'));assert.equal((await as('owner',()=>rpc('get_animal_sheet_import_status',[colony]))).job.error,'queue_unavailable');
});
await test('daily schedule is separate and requires a completed import',async()=>{
 await db.exec(schedule);const rows=(await db.query('select * from cron.jobs')).rows;assert.equal(rows.length,1);assert.equal(rows[0].schedule,'0 18 * * *');assert.equal(rows[0].name,'animal-sheet-import-'+colony);assert(rows[0].command.includes('null'));
 await db.query('update colony_private.animal_sheet_import_settings set enabled=false');await assert.rejects(()=>db.exec(schedule),/No enabled inbound integration/);await db.exec('rollback');
});
await test('daily status reflects the actual enabled cron job, including later deactivation',async()=>{
 await db.query("update colony_private.animal_sheet_import_settings set enabled=true where colony_id=$1",[colony]);
 await db.query("insert into cron.jobs(name,schedule,command,active) values($1,'0 18 * * *','test',true) on conflict(name) do update set active=true",['animal-sheet-import-'+colony]);
 let status=await as('viewer',()=>rpc('get_animal_sheet_import_status',[colony]));assert.equal(status.schedule_active,true);assert.equal(status.schedule,'Daily 02:00 Asia/Taipei');
 await db.exec('update cron.jobs set active=false');status=await as('viewer',()=>rpc('get_animal_sheet_import_status',[colony]));assert.equal(status.schedule_active,false);assert.equal(status.schedule,null);
 await db.exec('drop view cron.job');status=await as('viewer',()=>rpc('get_animal_sheet_import_status',[colony]));assert.equal(status.schedule_active,false);
});
await db.close();
