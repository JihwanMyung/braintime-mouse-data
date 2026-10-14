import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),cid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids=Object.fromEntries(['owner','manager','editor','viewer','outside'].map((k,i)=>[k,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
create schema cron;create table cron.job(jobid bigint generated always as identity,jobname text,schedule text,command text,active boolean default true);
create function cron.schedule(n text,s text,c text) returns bigint language plpgsql as $$declare i bigint;begin insert into cron.job(jobname,schedule,command)values(n,s,c)returning jobid into i;return i;end$$;
create function cron.unschedule(i bigint) returns boolean language plpgsql as $$begin delete from cron.job where jobid=i;return found;end$$;`);
for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);
await db.query('insert into colonies(id,name,created_by)values($1,$2,$3),($4,$5,$6)',[cid,'Bot fixture',ids.owner,other,'Other colony',ids.outside]);
for(const k of ['owner','manager','editor','viewer'])await db.query('insert into memberships(colony_id,user_id,role)values($1,$2,$3)',[cid,ids[k],k]);
await db.query("insert into memberships(colony_id,user_id,role)values($1,$2,'owner')",[other,ids.outside]);
const rpc=async(n,args)=>(await db.query(`select public.${n}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
async function as(k,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[k]||'']);try{return await fn();}finally{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false)");}}
const denied=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true;});
const key={rooms:'room_id',racks:'rack_id',locations:'location_id',cages:'cage_sid',mice:'mouse_sid'};
const save=(type,id,p,version=0)=>rpc('save_record',[cid,type,id,{[key[type]]:id,...p},version]);
await as('owner',async()=>{
 await save('rooms','R',{name:'Room'});await save('racks','K',{room_id:'R',name:'Rack'});
 for(const id of ['P','Q','D'])await save('locations',id,{room_id:'R',rack_id:'K',label:id});
 await save('cages','SAFE',{state:'Active',location_id:'P',source_raw:'unchanged source',cage_tag:'Original tag'});
 await save('cages','CONFLICT',{state:'Active',location_id:'Q',room_id:'OTHER',rack_id:'K'});
 await save('cages','D1',{state:'Active',location_id:'D'});await save('cages','D2',{state:'Active',location_id:'D'});
 await save('cages','MISSING',{state:'Active',location_id:'no-position'});
 await save('cages','ENDED',{state:'Ended',location_id:'P'});
 await save('mice','M',{state:'Stock',cage_sid:'absent'});await save('mice','UNASSIGNED',{state:'Stock',cage_sid:null});
});
await db.exec(await readFile(new URL('../cage-position-guard.sql',import.meta.url),'utf8'));
const migration=await readFile(new URL('../brainbot.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
const all=(await db.query('select colony_private.default_manager_permissions() p')).rows[0].p;
const settings=(version,extra={})=>({version,enabled:true,daily_time:'03:00',automatic_corrections:true,permissions:all,...extra});
await test('owner-only controls and private logs cannot be accessed by manager, editor, viewer or other-colony owner',async()=>{
 for(const k of ['manager','editor','viewer','outside'])await as(k,async()=>{await denied(()=>rpc('get_brainbot_status',[cid]));await denied(()=>rpc('save_brainbot_settings',[cid,settings(0)]));await denied(()=>rpc('run_brainbot',[cid]));await denied(()=>db.query('select * from colony_private.brainbot_runs'));await denied(()=>db.query('select colony_private.run_brainbot($1)',[cid]));});
 await as(null,()=>denied(()=>rpc('get_brainbot_status',[cid])),'anon');
 const accounts=(await db.query('select count(*) n from auth.users')).rows[0].n,members=(await db.query('select count(*) n from memberships')).rows[0].n;
 const status=await as('owner',()=>rpc('save_brainbot_settings',[cid,settings(0)]));assert.equal(status.principal.role,'manager');assert(status.principal.principal_id);assert.equal(status.settings.version,1);assert.equal(status.schedule_active,true);
 assert.equal((await db.query('select count(*) n from auth.users')).rows[0].n,accounts);assert.equal((await db.query('select count(*) n from memberships')).rows[0].n,members);
 const job=(await db.query('select * from cron.job')).rows[0];assert.equal(job.schedule,'0 19 * * *');assert.equal(job.command,`select colony_private.run_brainbot('${cid}'::uuid,'scheduled');`);
});
await test('settings use strict CAS and bounded manager flags; schedule replacement and disable are atomic',async()=>{
 await as('owner',async()=>{
  await denied(()=>rpc('save_brainbot_settings',[cid,settings(0)]),'40001');
  for(const extra of [{daily_time:'25:00'},{enabled:'true'},{permissions:{...all,owner:true}},{permissions:{}},{automatic_corrections:null},{version:1.5},{role:'owner'}])await denied(()=>rpc('save_brainbot_settings',[cid,settings(1,extra)]),'22023');
  await rpc('save_brainbot_settings',[cid,settings(1,{daily_time:'07:30'})]);
 });
 assert.equal((await db.query('select schedule from cron.job')).rows[0].schedule,'30 23 * * *');assert.equal((await db.query('select count(*) n from cron.job')).rows[0].n,1);
 await as('owner',()=>rpc('save_brainbot_settings',[cid,settings(2,{enabled:false})]));assert.equal((await db.query('select count(*) n from cron.job')).rows[0].n,0);
 assert.equal((await db.query('select colony_private.run_brainbot($1) run',[cid])).rows[0].run,null);
});
let initialRun;
await test('manual execution fixes only empty confirmed hierarchy, reports conflicts and preserves identities/source values',async()=>{
 const before=(await db.query("select payload from entity_records where entity_id='SAFE'")).rows[0].payload;
 const status=await as('owner',()=>rpc('run_brainbot',[cid]));initialRun=status.last_run;
 assert.equal(initialRun.status,'completed');assert.equal(initialRun.fixed_count,1);assert.equal(initialRun.checked_count,7);assert.equal(initialRun.issue_count,6);assert.equal(initialRun.trigger,'manual');assert.equal(initialRun.requested_by,ids.owner);
 const after=(await db.query("select payload,updated_by,version from entity_records where entity_id='SAFE'")).rows[0];assert.deepEqual(after.payload,{...before,room_id:'R',rack_id:'K'});assert.equal(after.updated_by,null);assert.equal(after.version,2);
 assert.equal((await db.query("select payload->>'room_id' room from entity_records where entity_id='CONFLICT'")).rows[0].room,'OTHER');
 assert.deepEqual(initialRun.changes[0].fields,['room_id','rack_id']);assert.equal(initialRun.changes[0].before_version,1);assert.equal(initialRun.changes[0].after_version,2);
 assert.equal((await db.query("select actor_id from audit_log where entity_id='SAFE' order by audit_id desc limit 1")).rows[0].actor_id,ids.owner);
});
await test('repeated runs are idempotent and owner review has CAS; persisting resolved issues reopen',async()=>{
 const result=await as('owner',()=>rpc('run_brainbot',[cid]));assert.equal(result.last_run.fixed_count,0);assert.equal(result.issue_total,6);
 assert(result.issues.some(i=>i.entity_id==='UNASSIGNED'&&i.code==='mouse_cage_missing'));
 const issue=result.issues.find(i=>i.entity_id==='CONFLICT');
 for(const note of [null,'','  ','\n\t'])await as('owner',()=>denied(()=>rpc('review_brainbot_issue',[cid,issue.issue_id,issue.version,'acknowledged',note]),'22023'));
 const reviewed=await as('owner',()=>rpc('review_brainbot_issue',[cid,issue.issue_id,issue.version,'resolved','Reviewed separately']));assert.equal(reviewed.issues.find(i=>i.issue_id===issue.issue_id).status,'resolved');
 await as('owner',()=>denied(()=>rpc('review_brainbot_issue',[cid,issue.issue_id,issue.version,'resolved','Stale review']),'40001'));
 const again=await as('owner',()=>rpc('run_brainbot',[cid]));assert.equal(again.issues.find(i=>i.issue_id===issue.issue_id).status,'open');
 await as('manager',()=>denied(()=>rpc('review_brainbot_issue',[cid,issue.issue_id,issue.version,'resolved',null])));
});
await test('disabled capability suppresses its checks/fixes without falsely resolving open issues; report-only mode never writes',async()=>{
 await as('owner',()=>save('cages','SAFE',{state:'Active',location_id:'P',source_raw:'unchanged source',cage_tag:'Original tag'},2));
 await as('owner',()=>rpc('save_brainbot_settings',[cid,settings(3,{permissions:{...all,housing:false}})]));
 let status=await as('owner',()=>rpc('run_brainbot',[cid]));assert.equal(status.last_run.fixed_count,0);assert.equal(status.last_run.checked_count,2);assert.equal(status.issues.find(i=>i.entity_id==='CONFLICT').status,'open');
 assert.equal((await db.query("select payload->>'room_id' room from entity_records where entity_id='SAFE'")).rows[0].room,null);
 await as('owner',()=>rpc('save_brainbot_settings',[cid,settings(4,{automatic_corrections:false})]));status=await as('owner',()=>rpc('run_brainbot',[cid]));assert.equal(status.last_run.fixed_count,0);assert(status.issues.some(i=>i.entity_id==='SAFE'&&i.code==='cage_hierarchy_missing'));
});
await test('scheduled execution has an honest NULL human actor and resolves previously fixed issues',async()=>{
 await as('owner',()=>rpc('save_brainbot_settings',[cid,settings(5)]));
 const run=(await db.query('select colony_private.run_brainbot($1) run',[cid])).rows[0].run;
 const result=(await db.query('select * from colony_private.brainbot_runs where run_id=$1',[run])).rows[0];assert.equal(result.status,'completed');assert.equal(result.requested_by,null);assert.equal(result.fixed_count,1);assert.equal(result.trigger,'scheduled');assert(result.principal_id);
 assert.equal((await db.query("select actor_id from audit_log where entity_id='SAFE' order by audit_id desc limit 1")).rows[0].actor_id,null);
 assert.equal((await db.query("select status from colony_private.brainbot_issues where entity_id='SAFE'")).rows[0].status,'resolved');
});
await test('failed correction rolls back every proposed change and logs a failed run without leaking error text',async()=>{
 await as('owner',()=>save('cages','SAFE',{state:'Active',location_id:'P',source_raw:'unchanged source',cage_tag:'Original tag'},4));
 await db.exec(`create function public.fail_bot_write() returns trigger language plpgsql as $$begin if new.entity_type='cages' and new.updated_by is null then raise exception 'PRIVATE failure detail';end if;return new;end$$;create trigger fail_bot_write before update on entity_records for each row execute function public.fail_bot_write();`);
 const status=await as('owner',()=>rpc('run_brainbot',[cid]));assert.equal(status.last_run.status,'failed');assert.equal(status.last_run.error_code,'P0001');assert.equal(status.last_run.fixed_count,0);assert.deepEqual(status.last_run.changes,[]);assert(!JSON.stringify(status.last_run).includes('PRIVATE'));
 assert.equal((await db.query("select payload->>'room_id' room from entity_records where entity_id='SAFE'")).rows[0].room,null);
 await db.exec('drop trigger fail_bot_write on entity_records;drop function public.fail_bot_write();');
});
await test('source freshness check reports absent/stale success, then clears after a real recent receipt',async()=>{
 await db.exec('create table colony_private.animal_sheet_import_state(colony_id uuid,last_success_at timestamptz,active_job_id uuid)');
 let status=await as('owner',()=>rpc('run_brainbot',[cid]));assert(status.issues.some(i=>i.code==='animal_sheet_stale'&&i.status==='open'));
 await db.query('insert into colony_private.animal_sheet_import_state(colony_id,last_success_at) values($1,clock_timestamp())',[cid]);status=await as('owner',()=>rpc('run_brainbot',[cid]));assert.equal(status.issues.find(i=>i.code==='animal_sheet_stale').status,'resolved');
});
await test('stalled import jobs are reported without retrying, changing source data or exposing lock tokens',async()=>{
 await db.exec('create table colony_private.animal_sheet_import_jobs(job_id uuid,status text,queued_at timestamptz,started_at timestamptz,lock_token text)');
 const job='dddddddd-dddd-4ddd-8ddd-dddddddddddd';await db.query("insert into colony_private.animal_sheet_import_jobs values($1,'running',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour','PRIVATE token')",[job]);await db.query('update colony_private.animal_sheet_import_state set active_job_id=$1',[job]);
 let status=await as('owner',()=>rpc('run_brainbot',[cid]));const issue=status.issues.find(i=>i.code==='animal_sheet_job_stuck');assert.equal(issue.status,'open');assert(!JSON.stringify(status).includes('PRIVATE token'));assert.equal((await db.query('select status from colony_private.animal_sheet_import_jobs')).rows[0].status,'running');
 await db.exec('update colony_private.animal_sheet_import_state set active_job_id=null');status=await as('owner',()=>rpc('run_brainbot',[cid]));assert.equal(status.issues.find(i=>i.code==='animal_sheet_job_stuck').status,'resolved');
});
await db.close();
