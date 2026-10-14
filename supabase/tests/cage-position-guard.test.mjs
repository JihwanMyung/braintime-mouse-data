import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),cid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',uid='11111111-1111-4111-8111-111111111111';
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into auth.users values($1)',[uid]);await db.query('insert into colonies(id,name,created_by) values($1,$2,$3)',[cid,'Synthetic rack',uid]);await db.query("insert into memberships(colony_id,user_id,role) values($1,$2,'owner')",[cid,uid]);
const save=(id,p,version=0,kind='cages')=>db.query('select * from save_record($1,$2,$3,$4,$5)',[cid,kind,id,{[kind==='cages'?'cage_sid':'mouse_sid']:id,...p},version]);
await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
await save('C1',{state:'Active',location_id:'L1'});await save('C2',{state:'Active',location_id:'L2'});await save('OLD',{state:'Ended',location_id:'L1'});await save('D1',{state:'Active',location_id:'LEGACY'});await save('D2',{state:'Active',location_id:'LEGACY'});
await db.exec('reset role');const sql=await readFile(new URL('../cage-position-guard.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);await db.exec('set role authenticated');
const denied=fn=>assert.rejects(fn,e=>{assert.equal(e.code,'23505');return true;});
const rows=async()=> (await db.query("select entity_id,payload,version from entity_records where entity_type='cages' order by entity_id")).rows;
await test('single move into an occupied slot rolls back record and audit while an empty destination succeeds',async()=>{
 const before=await rows(),audit=(await db.query('select count(*) n from audit_log')).rows[0].n;
 await denied(()=>save('C1',{state:'Active',location_id:'L2'},1));assert.deepEqual(await rows(),before);assert.equal((await db.query('select count(*) n from audit_log')).rows[0].n,audit);
 await save('C1',{state:'Active',location_id:'L3'},1);assert.equal((await rows()).find(r=>r.entity_id==='C1').version,2);
});
await test('one atomic batch can swap both cages because only the final placement is checked',async()=>{
 const changes=[{entity_type:'cages',entity_id:'C1',payload:{cage_sid:'C1',state:'Active',location_id:'L2'},expected_version:2},{entity_type:'cages',entity_id:'C2',payload:{cage_sid:'C2',state:'Active',location_id:'L3'},expected_version:1}];
 await db.query('select * from save_records($1,$2)',[cid,changes]);const current=await rows();assert.equal(current.find(r=>r.entity_id==='C1').payload.location_id,'L2');assert.equal(current.find(r=>r.entity_id==='C2').payload.location_id,'L3');
});
await test('third-cage arrival after a UI snapshot makes the stale destination plan fail without partial writes',async()=>{
 await save('THIRD',{state:'Active',location_id:'L4'});const before=await rows();await denied(()=>save('C1',{state:'Active',location_id:'L4'},3));assert.deepEqual(await rows(),before);
});
await test('unchanged historical duplicate placements remain editable; new assignments and reactivation cannot add conflicts',async()=>{
 await save('D1',{state:'Active',location_id:'LEGACY',comment:'Review pending'},1);await denied(()=>save('NEW',{state:'Active',location_id:'LEGACY'}));
 await save('C1',{state:'Active',location_id:'L1'},3);await denied(()=>save('OLD',{state:'Active',location_id:'L1'},1));
 await denied(()=>save('M1',{state:'Stock',cage_sid:'OLD'},0,'mice'));assert.equal((await db.query("select * from entity_records where entity_id='M1'")).rows.length,0);
 await save('OLD',{state:'Ended',location_id:'L1',comment:'History kept'},1);
});
await test('unassignment changes no animal identity, and guard also protects direct administrative writes',async()=>{
 await save('C1',{state:'Active',location_id:null},4);await save('M1',{state:'Stock',cage_sid:'OLD'},0,'mice');
 await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false)");const before=await rows();await denied(()=>db.query("update entity_records set payload=payload||'{\"location_id\":\"L3\"}'::jsonb where entity_id='C1'"));assert.deepEqual(await rows(),before);
 const locks=(await db.query("select pg_get_functiondef('colony_private.lock_cage_position()'::regprocedure) sql")).rows[0].sql;assert.match(locks,/pg_advisory_xact_lock/);assert.match(locks,/'colony:'/);
});
await db.close();
