import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='00000001-1111-4111-8111-111111111111',viewer='00000002-1111-4111-8111-111111111111';
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql','iacuc.sql','locobox.sql','lac-fee-visibility.sql','ear-marks.sql','ear-marks.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into auth.users values($1),($2)',[owner,viewer]);await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3)',[colony,'Synthetic ear-mark tests',owner]);
await db.query("insert into public.memberships(colony_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer')",[colony,owner,viewer]);
const payload=(id,ear_mark)=>({mouse_sid:id,sex:'Unknown',state:'Stock',ear_mark});
async function as(id,fn){await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);try{return await fn();}finally{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false)");}}
const save=(id,p,v=0)=>db.query('select * from public.save_record($1,$2,$3,$4,$5,false)',[colony,'mice',id,p,v]);
const invalid=fn=>assert.rejects(fn,e=>e.code==='22023');
await test('API and direct import reject nontext and overlong marks; null and Unicode boundaries are accepted',async()=>{
 for(const [i,mark]of [null,'','L0R1','🐭'.repeat(160)].entries())await as(owner,()=>save('OK'+i,payload('OK'+i,mark)));
 for(const [i,mark]of [true,3,{},[],'x'.repeat(161),'🐭'.repeat(161)].entries()){
  await as(owner,()=>invalid(()=>save('BAD'+i,payload('BAD'+i,mark))));
  await invalid(()=>db.query("insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by) values($1,'mice',$2,$3,$4,$4)",[colony,'DIRECT'+i,payload('DIRECT'+i,mark),owner]));
 }
 await as(owner,()=>invalid(()=>db.query("select * from public.save_records($1,$2)",[colony,[{entity_type:'mice',entity_id:'ATOMIC1',payload:payload('ATOMIC1','L1R1'),expected_version:0},{entity_type:'mice',entity_id:'ATOMIC2',payload:payload('ATOMIC2',false),expected_version:0}]])));
 assert.equal((await db.query("select count(*) n from public.entity_records where entity_id='ATOMIC1'")).rows[0].n,0);
});
await test('ordinary authorization and optimistic concurrency still protect ear-mark edits',async()=>{
 await assert.rejects(as(viewer,()=>save('OK2',payload('OK2','L2R2'),1)),e=>e.code==='42501');
 await assert.rejects(as(owner,()=>save('OK2',payload('OK2','L2R2'),0)),e=>e.code==='40001');
 await as(owner,()=>save('OK2',payload('OK2','L2R2'),1));assert.equal((await db.query("select payload->>'ear_mark' mark from public.entity_records where entity_id='OK2'")).rows[0].mark,'L2R2');
});
await test('bounded current exports include only the explicit mark and preserve the fee visibility wrapper',async()=>{
 const result=await as(viewer,()=>db.query("select public.export_records($1,'current_housing',null,null,array['mice'],0,250) p",[colony]));
 assert.equal(result.rows[0].p.rows.find(r=>r.entity_id==='OK2').payload.ear_mark,'L2R2');
 const source=(await db.query("select pg_get_functiondef('public.export_records(uuid,text,date,date,text[],integer,integer)'::regprocedure) body")).rows[0].body;assert.match(source,/fee_visibility/);
 const clean=(await db.query("select colony_private.export_payload('mice',$1) p",[{mouse_sid:'X',ear_mark:'L0R1',source_raw:'PRIVATE',notes:'PRIVATE'}])).rows[0].p;assert.equal(clean.ear_mark,'L0R1');assert(!JSON.stringify(clean).includes('PRIVATE'));
});
await db.close();
