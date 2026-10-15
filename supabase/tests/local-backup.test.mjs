import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids=Object.fromEntries(['owner','high','low','max','revoked'].map((n,i)=>[n,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
for(const id of Object.values(ids))await db.query('insert into auth.users values($1,$2)',[id,'test@example.invalid']);
for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql','local-backup.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3)',[colony,'Test colony',ids.owner]);
for(const [n,id]of Object.entries(ids))await db.query('insert into public.memberships(colony_id,user_id,role,active,export_level) values($1,$2,$3,$4,$5)',[colony,id,n==='owner'?'owner':'editor',n!=='revoked',n==='high'?'high':n==='max'?'max':'low']);
async function as(n,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[n]??'']);try{return await fn()}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)")}}
const rpc=async(name,args)=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
const permission=()=>rpc('get_local_backup_permission',[colony]);
const page=(scope='history',from=null,revision=null)=>rpc('export_local_backup_records',[colony,scope,from,null,null,0,250,revision]);
await test('Low keeps ordinary3-year exports but cannot request a local backup; identity/revocation gates remain server-side',async()=>{
 assert.equal((await as('low',()=>rpc('get_export_permission',[colony]))).level,'low');
 assert.equal((await as('low',()=>rpc('export_records',[colony,'current_housing']))).scope,'current_housing');
 for(const n of ['low','revoked']){await as(n,()=>assert.rejects(permission,{code:'42501'}));await as(n,()=>assert.rejects(()=>page(),{code:'42501'}))}
 for(const role of ['anon','service_role'])await as('owner',()=>assert.rejects(permission,{code:'42501'}),role);
});
await test('High is bounded to6years and explicitly not a whole-workspace restore; Max remainsfull',async()=>{
 const high=await as('high',permission),max=await as('owner',permission);
 assert.equal(high.level,'high');assert.equal(high.no_whole_workspace_restore,true);assert.equal(high.backup_scope,'bounded');
 assert.equal(new Date(high.as_of_date).getUTCFullYear()-new Date(high.cutoff_date).getUTCFullYear(),6);
 assert.equal(max.level,'max');assert.equal(max.cutoff_date,null);assert.equal(max.no_whole_workspace_restore,false);
 await as('high',()=>assert.rejects(()=>page('history','2000-01-01'),{code:'42501'}));
 assert.equal((await as('high',()=>page('current_housing'))).partial,true);
 assert.equal((await as('max',()=>page())).partial,false);
});
await test('current and history pages share checked snapshot revision; later record edits force restart',async()=>{
 await as('owner',()=>db.query("select public.save_record($1,'mice','m1',$2,0,false)",[colony,{mouse_sid:'m1',state:'Stock',date_of_birth:'2000-01-01',physical_tag:'Old living animal'}]));
 const first=await as('high',()=>page('current_housing'));assert.equal(first.rows.length,1);
 const history=await as('high',()=>page('history',null,first.snapshot_revision));assert.equal(history.snapshot_revision,first.snapshot_revision);assert.equal(history.rows.length,0);
 await as('owner',()=>db.query("select public.save_record($1,'mice','m1',$2,1,false)",[colony,{mouse_sid:'m1',state:'Stock',date_of_birth:'2000-01-01',physical_tag:'Changed'}]));
 await as('high',()=>assert.rejects(()=>page('history',null,first.snapshot_revision),{code:'40001'}));
 await db.query("update public.memberships set export_level='low' where colony_id=$1 and user_id=$2",[colony,ids.high]);
 await as('high',()=>assert.rejects(()=>page('history'),{code:'42501'}));
});
await test('bounded source exclusions and downstream export wrappers are inherited, not copied or bypassed',async()=>{
 await db.query("update public.memberships set export_level='high' where user_id=$1",[ids.high]);
 const high=await as('high',()=>page());assert.equal(high.cutoff_date,(await as('high',permission)).cutoff_date);
 await as('high',()=>assert.rejects(()=>rpc('export_local_backup_records',[colony,'history',null,null,['archive']]),{code:'22023'}));
 await as('high',()=>assert.rejects(()=>page('history',null,'forged'),{code:'22023'}));
 const source=await readFile(new URL('../local-backup.sql',import.meta.url),'utf8');assert.match(source,/public\.export_records\(p_colony_id/);assert.doesNotMatch(source,/public\.entity_records/);
});
await db.close();
