import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const db = new PGlite();
const ids = {
  owner:'11111111-1111-4111-8111-111111111111',editor:'22222222-2222-4222-8222-222222222222',
  viewer:'33333333-3333-4333-8333-333333333333',outsider:'44444444-4444-4444-8444-444444444444',
  ownerB:'55555555-5555-4555-8555-555555555555',colony:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',newUser:'66666666-6666-4666-8666-666666666666'
};
const results=[];
const SKIPPED=Symbol('private fixture absent');
async function privateFixture(name){
 try{return JSON.parse(await readFile(new URL(`../../../outputs/reconstruction_2026-10-14/${name}`,import.meta.url),'utf8'));}
 catch(error){if(error.code!=='ENOENT')throw error;return null;}
}
await db.exec(`create role anon; create role authenticated;
 create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated,anon;
 grant execute on function auth.uid() to authenticated,anon;`);
await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
for(const name of ['owner','editor','viewer','outsider','ownerB','newUser']) await db.query('insert into auth.users values($1)',[ids[name]]);
await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3),($4,$5,$6)',[ids.colony,'Lab A',ids.owner,ids.other,'Lab B',ids.ownerB]);
for(const [user,role,colony] of [['owner','owner','colony'],['editor','editor','colony'],['viewer','viewer','colony'],['ownerB','owner','other']])
  await db.query('insert into public.memberships(colony_id,user_id,role,updated_by) values($1,$2,$3,$2)',[ids[colony],ids[user],role]);
async function as(user,fn,role='authenticated') {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user?ids[user]:'']);
  try{return await fn();}finally{await db.exec('reset role');}
}
async function denied(fn,code='42501') {
  await assert.rejects(fn,e=>{assert.equal(e.code,code);return true;});
}
async function test(name,fn) {const result=await fn(),status=result===SKIPPED?'skipped':'passed';results.push({name,status,...(result===SKIPPED?{reason:'Private source fixture is not part of the public repository.'}:{})});console.log(`${status.toUpperCase()} ${name}`);}
const mouse=(id,extra={})=>({mouse_sid:id,physical_tag:`Mouse ${id}`,sex:'Female',genotype:null,date_of_birth:'2020-01-01',sire_sids:[],dam_sids:[],...extra});
const save=(id,payload,version=0,archived=false,colony=ids.colony)=>db.query('select * from public.save_record($1,$2,$3,$4::jsonb,$5,$6)',[colony,'mice',id,JSON.stringify(payload),version,archived]);
const changes=(items,colony=ids.colony)=>db.query('select * from public.save_records($1,$2::jsonb)',[colony,JSON.stringify(items)]);
const change=(id,payload=mouse(id),expected_version=0)=>({entity_type:'mice',entity_id:id,payload,expected_version,archived:false});
const record=(id)=>db.query('select * from public.entity_records where colony_id=$1 and entity_id=$2',[ids.colony,id]);

await test('Anonymous access is denied for every public table and mutation RPC',async()=>{
 await as(null,async()=>{
  for(const table of ['colonies','memberships','entity_records','audit_log']) await denied(()=>db.query(`select * from public.${table}`));
  await denied(()=>save('1',mouse('1')));
  await denied(()=>changes([change('1')]));
 },'anon');
});
await test('Owner creates a record preserving unknown genotype and ambiguous dams',async()=>{
 const r=await as('owner',()=>save('1',mouse('1',{dam_sids:['10','11'],source_filename:'raw.xlsx',source_row:2,record_origin:'explicit_export'})));
 assert.equal(r.rows[0].version,1);assert.equal(r.rows[0].payload.genotype,null);assert.deepEqual(r.rows[0].payload.dam_sids,['10','11']);
});
await test('RLS isolates two colonies and outsiders',async()=>{
 await as('ownerB',()=>save('1',mouse('1'),0,false,ids.other));
 for(const user of ['owner','editor','viewer']) await as(user,async()=>{
  const r=await db.query('select colony_id from public.entity_records');assert.equal(r.rows.length,1);assert.equal(r.rows[0].colony_id,ids.colony);
  assert.equal((await db.query('select id from public.colonies')).rows.length,1);
 });
 await as('outsider',async()=>{assert.equal((await db.query('select * from public.entity_records')).rows.length,0);assert.equal((await db.query('select * from public.audit_log')).rows.length,0);await denied(()=>save('9',mouse('9')));});
 await as('ownerB',()=>denied(()=>save('9',mouse('9'))));
});
await test('Viewers cannot save; editors cannot grant themselves ownership',async()=>{
 await as('viewer',()=>denied(()=>save('2',mouse('2'))));
 await as('editor',()=>denied(()=>db.query('select * from public.set_member_role($1,$2,$3,true)',[ids.colony,ids.editor,'owner'])));
});
await test('Authenticated users cannot bypass RPC using direct DML',async()=>{
 await as('owner',async()=>{
  await denied(()=>db.query('update public.entity_records set version=99'));
  await denied(()=>db.query('delete from public.entity_records'));
  await denied(()=>db.query('insert into public.memberships(colony_id,user_id,role) values($1,$2,$3)',[ids.colony,ids.outsider,'owner']));
  await denied(()=>db.query('update public.memberships set role=$1',['owner']));
 });
});
await test('SQL validates identifiers, biological sex, dates, and self-parent links',async()=>{
 await as('editor',async()=>{
  for(const p of [mouse('bad',{mouse_sid:3}),mouse('bad',{mouse_sid:'different'}),mouse('bad',{sex:'bogus'}),mouse('bad',{date_of_birth:'2020-02-30'}),mouse('bad',{end_date:'2019-12-31'}),mouse('bad',{sire_sids:['bad']}),mouse('bad',{dam_sids:[11]})])
   await denied(()=>save('bad',p), '22023');
  // Preserve an already documented source anomaly rather than silently rewriting it.
  const r=await save('source-anomaly',mouse('source-anomaly',{procedure_date:'1969-12-31'}));assert.equal(r.rows[0].payload.procedure_date,'1969-12-31');
 });
});
await test('Source provenance cannot be changed or removed',async()=>{
 await as('editor',async()=>{
  const original=(await record('1')).rows[0];
  await denied(()=>save('1',{...original.payload,source_filename:'changed.xlsx'},1),'22023');
  const removed={...original.payload};delete removed.source_row;await denied(()=>save('1',removed,1),'22023');
  await denied(()=>save('1',{...original.payload,record_origin:'invented'},1),'22023');
  const updated=await save('1',{...original.payload,comment:'Checked by lab'},1);assert.equal(updated.rows[0].version,2);assert.equal(updated.rows[0].created_by,ids.owner);assert.equal(updated.rows[0].updated_by,ids.editor);
 });
});
await test('Stale writes reject and identical current writes are no-ops',async()=>{
 await as('editor',async()=>{
  const r=(await record('1')).rows[0];await denied(()=>save('1',r.payload,1),'40001');await denied(()=>save('1',r.payload,0),'40001');
  const same=await save('1',r.payload,r.version);assert.equal(same.rows[0].version,r.version);
 });
});
await test('One concurrent same-version writer succeeds and one conflicts',async()=>{
 await as('editor',async()=>{
  await save('race',mouse('race'));
  const attempts=await Promise.allSettled([save('race',mouse('race',{comment:'A'}),1),save('race',mouse('race',{comment:'B'}),1)]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.find(x=>x.status==='rejected').reason.code,'40001');
  assert.equal((await record('race')).rows[0].version,2);
 });
});
await test('Batch applies all records or rolls back every record and audit event',async()=>{
 await as('editor',async()=>{
  const before=(await db.query('select count(*)::int as n from public.audit_log')).rows[0].n;
  await denied(()=>changes([change('atomic-a'),change('atomic-z',mouse('atomic-z'),8)]),'40001');
  assert.equal((await record('atomic-a')).rows.length,0);assert.equal((await record('atomic-z')).rows.length,0);
  assert.equal((await db.query('select count(*)::int as n from public.audit_log')).rows[0].n,before);
  const ok=await changes([change('atomic-a'),change('atomic-z')]);assert.equal(ok.rows.length,2);
  await denied(()=>changes([change('dup'),change('dup')]),'22023');
  await denied(()=>changes(Array.from({length:501},(_,i)=>change(`limit${i}`))),'22023');
 });
});
await test('Archive retains the row and records an append-only audit event',async()=>{
 await as('owner',async()=>{
  const r=(await record('1')).rows[0];const archived=await save('1',r.payload,r.version,true);assert.equal(archived.rows[0].archived,true);
  const logs=await db.query("select * from public.audit_log where entity_type='mice' and entity_id='1' order by audit_id");
  assert.equal(logs.rows.length,3);assert.equal(logs.rows[0].operation,'INSERT');assert.equal(logs.rows[2].after_record.archived,true);
  await denied(()=>db.query('update public.audit_log set operation=$1',['UPDATE']));await denied(()=>db.query('delete from public.audit_log'));
 });
 await denied(()=>db.query('delete from public.audit_log'));
 await denied(()=>db.query('delete from public.entity_records'));
});
await test('Owner manages membership, revocation removes access, last owner cannot leave',async()=>{
 await as('owner',async()=>{
  await denied(()=>db.query('select * from public.set_member_role($1,$2,$3,false)',[ids.colony,ids.owner,'owner']),'22023');
  await db.query('select * from public.set_member_role($1,$2,$3,true)',[ids.colony,ids.newUser,'editor']);
 });
 await as('newUser',async()=>{assert.ok((await db.query('select * from public.entity_records')).rows.length>0);});
 await as('owner',()=>db.query('select * from public.set_member_role($1,$2,$3,false)',[ids.colony,ids.newUser,'editor']));
 await as('newUser',async()=>{assert.equal((await db.query('select * from public.entity_records')).rows.length,0);await denied(()=>save('revoked',mouse('revoked')));});
});
await test('Null auth identity cannot mutate even as authenticated role',async()=>{await as(null,()=>denied(()=>save('null',mouse('null'))));});
await test('Managed rooms, racks, locations and non-24-hour lighting obey SQL validation',async()=>{
 await as('editor',async()=>{
  const rows=[['rooms','room_id','room1'],['racks','rack_id','rack1'],['locations','location_id','loc1'],['husbandry_events','event_id','event1'],['light_events','event_id','light1']].map(([entity_type,key,entity_id])=>({entity_type,entity_id,payload:{[key]:entity_id,...(entity_type==='light_events'?{cycle_hours:22,light_hours:11,transition_minutes:0,intensity_lux:100,start_date:'2026-01-01',end_date:null}:{} )},expected_version:0,archived:false}));
  assert.equal((await changes(rows)).rows.length,5);
  for(const extra of [{cycle_hours:0},{cycle_hours:22,light_hours:23},{intensity_lux:-1},{start_date:'2026-02-01',end_date:'2026-01-01'}]) {
   const bad={entity_type:'light_events',entity_id:'badlight',payload:{event_id:'badlight',...extra},expected_version:0,archived:false};await denied(()=>changes([bad]),'22023');
  }
 });
});
await test('Archive chunks accept bounded-format payloads and cannot be replaced or archived',async()=>{
 const cid='chunk:'+('a'.repeat(64));const payload={format:'colony-archive-chunk-v1',table:'historical_observations',rows:[{raw_text:'source evidence'}]};
 const chunk=(id,p,version=0,archived=false)=>changes([{entity_type:'archive',entity_id:id,payload:p,expected_version:version,archived}]);
 await as('editor',async()=>{
  assert.equal((await chunk(cid,payload)).rows[0].version,1);
  assert.equal((await chunk(cid,payload,1)).rows[0].version,1);
  await denied(()=>chunk(cid,{...payload,rows:[]},1),'22023');
  await denied(()=>chunk(cid,payload,1,true),'22023');
  await denied(()=>chunk('chunk:wrong',payload),'22023');
  await denied(()=>chunk('chunk:'+('b'.repeat(64)),{format:'wrong',rows:[]}),'22023');
  assert.equal((await chunk('reconstruction',{archive_format:'colony-archive-manifest-v1',archive_tables:{}},0)).rows[0].version,1);
 });
});
await test('Private historical archives enforce member reads, editor insert, and immutable objects',async()=>{
 await db.exec(`create schema storage;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text,unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant usage on schema storage to anon,authenticated;
 grant select,insert,update,delete on storage.objects to anon,authenticated;
 create policy intentionally_broad_existing_policy on storage.objects for all to anon,authenticated using(true) with check(true);`);
 await db.exec(await readFile(new URL('../history-storage.sql',import.meta.url),'utf8'));
 const path=`${ids.colony}/history/${'a'.repeat(64)}.json`;
 await as('editor',()=>db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['colony-history',path]));
 await as('viewer',async()=>{
  assert.equal((await db.query('select * from storage.objects')).rows.length,1);
  await denied(()=>db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['colony-history',`${ids.colony}/history/${'b'.repeat(64)}.json`]));
 });
 await as('outsider',async()=>{assert.equal((await db.query('select * from storage.objects')).rows.length,0);await denied(()=>db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['colony-history',`${ids.colony}/history/${'c'.repeat(64)}.json`]));});
 await as(null,async()=>assert.equal((await db.query('select * from storage.objects')).rows.length,0),'anon');
 await as('owner',async()=>{
  assert.equal((await db.query('update storage.objects set name=$1 returning *',[`${ids.colony}/history/${'d'.repeat(64)}.json`])).rows.length,0);
  assert.equal((await db.query('delete from storage.objects returning *')).rows.length,0);
  await denied(()=>db.query('insert into storage.objects(bucket_id,name) values($1,$2)',['colony-history','bad/history/path.json']));
 });
 assert.equal((await db.query('select public from storage.buckets where id=$1',['colony-history'])).rows[0].public,false);
});
await test('All source entity payloads pass SQL validation without mutating source data',async()=>{
 const data=await privateFixture('dataset.json');if(!data)return SKIPPED;
 for(const [type,key] of Object.entries({mice:'mouse_sid',matings:'mating_sid',litters:'litter_sid',cages:'cage_sid'})) {
  // Validate in database as database owner; ACL tests above establish that clients
  // must pass through the same function via the authenticated save RPC.
  for(const row of data.tables[type]||[]) await db.query('select colony_private.validate_payload($1,$2,$3::jsonb)',[type,row[key],JSON.stringify(row)]);
 }
});
await test('Augmented room, position and historical-event payloads pass SQL validation',async()=>{
 const data=await privateFixture('dataset_augmented.json');if(!data)return SKIPPED;
 for(const [type,key] of Object.entries({rooms:'room_id',racks:'rack_id',locations:'location_id',light_events:'event_id',husbandry_events:'event_id'}))
  for(const row of data.tables[type]||[]) await db.query('select colony_private.validate_payload($1,$2,$3::jsonb)',[type,row[key],JSON.stringify(row)]);
});
const passed=results.filter(r=>r.status==='passed').length,skipped=results.filter(r=>r.status==='skipped').length;
const report={engine:'PGlite (actual PostgreSQL WASM, Supabase auth.uid stubbed for local tests)',passed,skipped,results,limitations:['No cloud project was provisioned or contacted.','Two concurrent calls are queued by the single PGlite connection; stale-version and atomic rollback behavior are exercised, not a multi-connection hosted load test.','Supabase Auth/JWT issuance, PostgREST HTTP integration and hosted setup remain deployment checks.']};
await writeFile(new URL('results.json',import.meta.url),JSON.stringify(report,null,2));
await db.close();console.log(JSON.stringify({passed,skipped}));
