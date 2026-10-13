import {PGlite} from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {projectRecords,projectionRequests} from '../functions/sync-animal-sheet/projection.mjs';

const db=new PGlite(),results=[];
const colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',user='11111111-1111-4111-8111-111111111111';
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create schema auth;create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../sheet-sync.sql',import.meta.url),'utf8'));
await db.query('insert into auth.users values($1)',[user]);
await db.query('insert into public.colonies(id,name,created_by) values($1,$3,$4),($2,$3,$4)',[colony,other,'Synthetic colony',user]);
await db.query('insert into public.memberships(colony_id,user_id,role) values($1,$2,$3)',[colony,user,'owner']);
async function as(role,fn){await db.exec(`set role ${role}`);try{return await fn();}finally{await db.exec('reset role');}}
async function rejected(fn){await assert.rejects(fn,e=>e.code==='42501');}
async function check(name,fn){await fn();results.push({name,status:'passed'});console.log(`PASS ${name}`);}
const claim=id=>db.query('select public.claim_sheet_sync($1) as token',[id]);
const snapshot=(id,token)=>db.query('select public.sheet_sync_snapshot($1,$2) as snapshot',[id,token]);
const finish=(token,success)=>db.query('select public.finish_sheet_sync($1,$2,$3,$4)',[colony,token,success,success?null:'Before write failed']);

await check('Only service role can invoke sync functions or read/change durable locks',async()=>{
 for(const role of ['anon','authenticated'])await as(role,async()=>{
  await rejected(()=>claim(colony));await rejected(()=>snapshot(colony,user));await rejected(()=>finish(user,true));
  await rejected(()=>db.query('select * from public.sheet_sync_state'));
  await rejected(()=>db.query('update public.sheet_sync_state set lock_token=null'));
 });
});
let first;
await check('Durable claim excludes overlapping work; invalid colony/token cannot read snapshot or release lock',async()=>{
 await as('service_role',async()=>{
  first=(await claim(colony)).rows[0].token;assert.ok(first);assert.equal((await claim(colony)).rows[0].token,null);
  assert.equal((await snapshot(other,first)).rows[0].snapshot,null);
  assert.equal((await snapshot(colony,user)).rows[0].snapshot,null);
  await finish(user,true);assert.equal((await claim(colony)).rows[0].token,null);
 });
});
await check('Single JSON snapshot retains over 1000 records and excludes other colony and archive',async()=>{
 await db.query(`insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by)
 select $1,'mice',lpad(n::text,5,'0'),jsonb_build_object('mouse_sid',lpad(n::text,5,'0'),'state','Stock'),$2,$2 from generate_series(1,2101)n`,[colony,user]);
 await db.query(`insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by)
 values($1,'archive','reconstruction','{"tables":{"source_cells":["preserved"]}}',$3,$3),($2,'mice','OTHER','{"mouse_sid":"OTHER"}',$3,$3)`,[colony,other,user]);
 const result=await as('service_role',()=>snapshot(colony,first));const data=result.rows[0].snapshot;
 assert.equal(data.records.length,2101);assert(data.records.every(r=>r.entity_type==='mice'));assert.equal(data.records[0].entity_id,'00001');assert(data.captured_at);
 const grids=projectRecords(data.records,data.captured_at);assert.equal(grids[1].length,2102);const requests=projectionRequests(grids,[]);assert.equal(requests.filter(r=>r.updateCells)[1].updateCells.rows.length,2102);
});
await check('Finished lock may be reclaimed; stale completion cannot release a newer claim',async()=>{
 await as('service_role',async()=>{
  await finish(first,false);const second=(await claim(colony)).rows[0].token;assert(second&&second!==first);
  await finish(first,true);assert.equal((await claim(colony)).rows[0].token,null);
  assert.equal((await snapshot(colony,first)).rows[0].snapshot,null);assert((await snapshot(colony,second)).rows[0].snapshot);
  await finish(second,true);const state=(await db.query('select * from public.sheet_sync_state where colony_id=$1',[colony])).rows[0];assert.equal(state.status,'ok');assert(state.last_success_at);assert.equal(state.lock_token,null);
 });
});
await check('Archive JSONB accepts source tables larger than REST row limits and retains nested unknown values',async()=>{
 const payload={tables:{raw_history:Array.from({length:1007},(_,i)=>({id:String(i).padStart(5,'0'),value:i%2?null:'=literal'}))},sources:[{url:'https://example.test/source'}],unknown_metadata:{keep:true}};
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
 const saved=await as('authenticated',()=>db.query('select * from public.save_record($1,$2,$3,$4::jsonb,1,false)',[colony,'archive','reconstruction',JSON.stringify(payload)]));
 assert.deepEqual(saved.rows[0].payload,payload);
});
const report={engine:'PGlite PostgreSQL',passed:results.length,results,limits:['No hosted Supabase or Google write was performed.','Single-connection tests verify ACLs, lock-token exclusion and stale completion; multi-connection load was not simulated.','Snapshot consistency follows one SQL statement and PostgreSQL MVCC; hosted REST response/body limits remain deployment checks.']};
await writeFile(new URL('sheet-sync-review-results.json',import.meta.url),JSON.stringify(report,null,2));await db.close();
