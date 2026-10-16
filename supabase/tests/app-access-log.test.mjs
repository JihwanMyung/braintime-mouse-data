import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite(),colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids=Object.fromEntries(['owner','editor','viewer','manager','disabled','pending','unverified','ownerB','revoked','limited','daily'].map((name,i)=>[name,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create role braintime_snapshot_reader;
create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,last_sign_in_at timestamptz,encrypted_password text,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
for(const name of Object.keys(ids))await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1,$2,$3,$4)',[ids[name],name+'@example.org',name==='unverified'?null:'2026-01-01T00:00:00Z','synthetic']);
for(const file of ['schema.sql','functions/manage-colony-users/membership.sql','export-permissions.sql','manager-permissions.sql','lab-members.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3),($4,$5,$6)',[colony,'Access test',ids.owner,other,'Other colony',ids.ownerB]);
for(const name of Object.keys(ids).filter(n=>n!=='pending'))await db.query('insert into public.memberships(colony_id,user_id,role,active,updated_by) values($1,$2,$3,$4,$5)',[name==='ownerB'?other:colony,ids[name],name==='owner'||name==='ownerB'?'owner':name==='manager'?'manager':name==='viewer'?'viewer':'editor',name!=='disabled',ids.owner]);
await db.query("update public.memberships set export_level='max' where user_id=$1",[ids.manager]);
await db.query(`insert into public.lab_members(colony_id,name,email,acronym,status,linked_user_id,username,created_by,updated_by)
 values($1,'Verified Scientist','editor@example.org','VS','current',$2,'scientist',$3,$3),($1,'Owner Name','owner@example.org','ON','current',null,null,$3,$3)`,[colony,ids.editor,ids.owner]);
const migration=await readFile(new URL('../app-access-log.sql',import.meta.url),'utf8');await db.exec(migration);
const activation=(await db.query('select started_at::text from colony_private.app_access_activation')).rows[0].started_at;
await db.exec(migration);
async function as(name,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[name?ids[name]:'']);try{return await fn();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
const rpc=async(name,args=[])=>{const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');return(await db.query(`select public.${name}(${placeholders}) result`,args)).rows[0].result;};
const record=(extra={})=>rpc('record_app_access',[extra.colony??colony,extra.app??'mouse',extra.event??'page_view',extra.page??'mice',extra.session??randomUUID(),extra.id??randomUUID()]);
const list=(extra={})=>rpc('list_app_access',[extra.colony??colony,extra.app??null,extra.user??null,extra.event??null,extra.from??null,extra.to??null,extra.before??null,extra.limit??50]);
const denied=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true;});
const count=async()=>Number((await db.query('select count(*) n from colony_private.app_access_log')).rows[0].n);

await test('migration activation is fixed across reruns, with no fabricated historical activity',async()=>{
 assert.equal(await count(),0);assert.equal((await db.query('select started_at::text from colony_private.app_access_activation')).rows[0].started_at,activation);
 const result=await as('owner',()=>list());assert.deepEqual(result.events,[]);assert.equal(result.has_more,false);assert.equal(result.next_before,null);assert.equal(Date.parse(result.logging_started_at),Date.parse(activation));
});
await test('only active verified members log; actor, role, email, identity and timestamp come from server records',async()=>{
 const before=Date.now();await db.query(`update auth.users set raw_user_meta_data='{"role":"owner","email":"forged@example.org","name":"Forged"}' where id=$1`,[ids.editor]);
 const session=randomUUID(),event=randomUUID();const result=await as('editor',()=>record({session,id:event,event:'session_start'}));
 assert.equal(result.recorded,true);assert.equal(result.reason,'recorded');assert.equal(result.event_id,event);
 const stored=(await db.query('select * from colony_private.app_access_log where event_id=$1',[event])).rows[0];
 assert.equal(stored.user_id,ids.editor);assert.equal(stored.email,'editor@example.org');assert.equal(stored.role,'editor');assert.equal(stored.name,'Verified Scientist');assert.equal(stored.acronym,'VS');assert.equal(stored.source,'app_reported');assert(Date.parse(stored.occurred_at)>=before-1000);
 for(const name of ['disabled','pending','unverified','ownerB'])await as(name,()=>denied(()=>record()));
 await as(null,()=>denied(()=>record()),'anon');await as(null,()=>denied(()=>record()),'service_role');await as(null,()=>denied(()=>record()));
 await as('viewer',()=>record({app:'reagents',page:'inventory'}));await as('manager',()=>record({page:'settings'}));
});
await test('only owner reads logs, even when manager has all capabilities and Max export; no direct table access exists',async()=>{
 for(const name of ['editor','viewer','manager','disabled','pending','unverified','ownerB'])await as(name,()=>denied(()=>list()));
 await as('owner',()=>denied(()=>list({colony:other})));await as(null,()=>denied(()=>list()),'anon');await as(null,()=>denied(()=>list()),'service_role');
 const result=await as('owner',()=>list());assert(result.events.length>=3);assert(result.events.every(e=>e.source==='app_reported'&&typeof e.access_id==='string'));
 for(const role of ['anon','authenticated','service_role','braintime_snapshot_reader'])await as(role==='authenticated'?'owner':null,async()=>{
  for(const sql of ['select * from colony_private.app_access_log','select * from colony_private.app_access_activation',"insert into colony_private.app_access_log(colony_id) values(null)",'update colony_private.app_access_log set email=email','delete from colony_private.app_access_log','truncate colony_private.app_access_log'])await denied(()=>db.query(sql));
 },role);
});
await test('logging app, events and pages are strictly bounded and reject URLs, free text, credentials and forged actor arguments',async()=>{
 for(const [app,event,page] of [['unknown','page_view','mice'],['mouse','login_failed','mice'],['mouse','page_view','https://example.org/?token=SECRET'],['reagents','page_view','mice'],['mouse','page_view','inventory'],['mouse','page_view','mice#animal-id'],['mouse','page_view','x'.repeat(100000)]])await as('editor',()=>denied(()=>record({app,event,page}),'22023'));
 await as('editor',()=>denied(()=>rpc('record_app_access',[colony,'mouse','page_view','mice',null,randomUUID()]),'22023'));
 await as('editor',()=>denied(()=>db.query("select public.record_app_access(p_colony_id=>$1,p_app=>'mouse',p_event=>'page_view',p_page=>'mice',p_session_id=>$2,p_event_id=>$3,p_email=>'forged@example.org')",[colony,randomUUID(),randomUUID()]),'42883'));
 assert(!JSON.stringify((await db.query('select * from colony_private.app_access_log')).rows).includes('SECRET'));
});
await test('event UUID retries are idempotent and cannot change existing data; starts/signouts and fast repeated page views debounce',async()=>{
 const session=randomUUID(),id=randomUUID();const first=await as('editor',()=>record({session,id})),n=await count();
 const retry=await as('editor',()=>record({session,id}));assert.equal(retry.reason,'duplicate');assert.equal(retry.recorded,false);assert.equal(retry.occurred_at,first.occurred_at);assert.equal(await count(),n);
 await as('editor',()=>denied(()=>record({session,id,page:'cages'}),'22023'));
 assert.equal((await as('editor',()=>record({session}))).reason,'debounced');assert.equal(await count(),n);
 assert.equal((await as('editor',()=>record({session,page:'cages'}))).recorded,true);
 for(const event of ['session_start','sign_out']){assert.equal((await as('editor',()=>record({session,event}))).recorded,true);assert.equal((await as('editor',()=>record({session,event,page:'settings'}))).reason,'debounced');}
 // Same caller event UUID in another account is a distinct authenticated event, not an impersonation.
 assert.equal((await as('viewer',()=>record({session,id}))).recorded,true);
});
await test('rate limiting bounds per-member writes without blocking other users or ordinary app data',async()=>{
 for(let i=0;i<60;i++)assert.equal((await as('limited',()=>record())).recorded,true);
 const n=await count(),limited=await as('limited',()=>record());assert.equal(limited.reason,'rate_limited');assert.equal(limited.recorded,false);assert.equal(await count(),n);
 assert.equal((await as('owner',()=>record({event:'session_start'}))).recorded,true);
 assert.equal((await as('limited',()=>db.query('select * from public.entity_records'))).rows.length,0);
});
await test('rolling daily limit works independently of the short per-minute limit',async()=>{
 await db.query(`insert into colony_private.app_access_log(colony_id,user_id,email,role,app,event,page,session_id,event_id,occurred_at)
   select $1,$2,'daily@example.org','editor','mouse','page_view','mice',gen_random_uuid(),gen_random_uuid(),clock_timestamp()-interval '2 hours' from generate_series(1,3000)`,[colony,ids.daily]);
 const n=await count();assert.equal((await as('daily',()=>record())).reason,'rate_limited');assert.equal(await count(),n);
});
await test('membership revocation immediately blocks both append and owner read without deleting retained history',async()=>{
 await as('revoked',()=>record());const n=await count();await db.query('update public.memberships set active=false where colony_id=$1 and user_id=$2',[colony,ids.revoked]);
 await as('revoked',()=>denied(()=>record()));assert.equal(await count(),n);
 await db.query('update public.memberships set active=false where colony_id=$1 and user_id=$2',[colony,ids.owner]);
 await as('owner',()=>denied(()=>list()));await as('owner',()=>denied(()=>record()));
 await db.query('update public.memberships set active=true where colony_id=$1 and user_id=$2',[colony,ids.owner]);
 assert.equal((await as('owner',()=>list({user:ids.revoked}))).events.length,1);
});
await test('bounded keyset pagination preserves bigint precision and filters are scoped with exclusive end times',async()=>{
 await db.query("select setval('colony_private.app_access_log_access_id_seq',9007199254740993,false)");
 for(const [time,app,event,page] of [['2001-01-01T00:00:00Z','mouse','page_view','mice'],['2001-01-01T01:00:00Z','reagents','session_start','inventory'],['2001-01-02T00:00:00Z','mouse','sign_out','settings']])await db.query(`insert into colony_private.app_access_log(colony_id,user_id,email,role,app,event,page,session_id,event_id,occurred_at) values($1,$2,'owner@example.org','owner',$3,$4,$5,$6,$7,$8)`,[colony,ids.owner,app,event,page,randomUUID(),randomUUID(),time]);
 const first=await as('owner',()=>list({limit:2}));assert.equal(first.events.length,2);assert.equal(first.has_more,true);assert.equal(first.events[0].access_id,'9007199254740995');assert.equal(first.next_before,'9007199254740994');
 const second=await as('owner',()=>list({limit:2,before:first.next_before}));assert.equal(second.events[0].access_id,'9007199254740993');assert(!second.events.some(e=>first.events.some(prior=>prior.access_id===e.access_id)));
 const dates=await as('owner',()=>list({from:'2001-01-01T00:00:00Z',to:'2001-01-02T00:00:00Z'}));assert.equal(dates.events.length,2);assert.equal(dates.has_more,false);assert.equal(dates.next_before,null);
 assert.equal((await as('owner',()=>list({app:'reagents',user:ids.owner,event:'session_start',from:'2001-01-01T00:00:00Z',to:'2001-01-02T00:00:00Z'}))).events.length,1);
 const empty=await as('owner',()=>list({user:ids.pending}));assert.equal(empty.events.length,0);assert.equal(empty.logging_started_at,first.logging_started_at);
 for(const args of [[colony,null,null,null,null,null,null,101],[colony,'bad'],[colony,null,null,'login_failed'],[colony,null,null,null,'2001-01-02','2001-01-01'],[colony,null,null,null,null,null,'0']])await as('owner',()=>denied(()=>rpc('list_app_access',args),'22023'));
});
await test('append-only guards retain history, while public exports and shared audit contain no access data',async()=>{
 for(const sql of ["update colony_private.app_access_log set email='changed@example.org'",'delete from colony_private.app_access_log','truncate colony_private.app_access_log'])await denied(()=>db.query(sql));
 assert.equal((await db.query('select count(*) n from public.entity_records')).rows[0].n,0);assert.equal((await db.query('select count(*) n from public.audit_log')).rows[0].n,0);
 for(const scope of ['current_housing','history']) {const result=await as('owner',()=>rpc('export_records',[colony,scope]));assert.deepEqual(result.rows,[]);assert(!JSON.stringify(result).includes('Verified Scientist'));}
 await as('manager',()=>denied(()=>rpc('export_records',[colony,'history',null,null,['app_access_log']]),'22023'));
 const names=(await db.query("select table_schema,table_name from information_schema.tables where table_name like 'app_access_%'")).rows;
 assert(names.every(row=>row.table_schema==='colony_private'));
});
await test('owner directory includes every colony account independently of event pages and filters',async()=>{
 const signedIn='2026-10-16T02:03:04Z';
 await db.query('update auth.users set last_sign_in_at=$1 where id=$2',[signedIn,ids.disabled]);
 const result=await as('owner',()=>list({app:'reagents',user:ids.pending,event:'sign_out',from:'2099-01-01T00:00:00Z',limit:1}));
 assert.deepEqual(result.events,[]);
 const expected=(await db.query('select user_id from public.memberships where colony_id=$1 order by user_id',[colony])).rows.map(r=>r.user_id);
 assert.deepEqual(result.users.map(u=>u.user_id).sort(),expected);
 assert(!result.users.some(u=>u.user_id===ids.ownerB||u.user_id===ids.pending));
 const editor=result.users.find(u=>u.user_id===ids.editor),owner=result.users.find(u=>u.user_id===ids.owner),disabled=result.users.find(u=>u.user_id===ids.disabled);
 assert.equal(editor.name,'Verified Scientist');assert.equal(editor.acronym,'VS');assert.equal(editor.email,'editor@example.org');assert.equal(editor.active,true);assert.equal(editor.last_sign_in_at,null);
 assert.equal(owner.name,'Owner Name');assert.equal(owner.acronym,'ON');
 assert.equal(disabled.active,false);assert.equal(Date.parse(disabled.last_sign_in_at),Date.parse(signedIn));
 const first=await as('owner',()=>list({limit:1})),second=await as('owner',()=>list({limit:1,before:first.next_before}));
 assert.deepEqual(second.users,first.users);
 assert.deepEqual(Object.keys(editor).sort(),['user_id','name','email','acronym','last_sign_in_at','active'].sort());
});
await test('directory uses linked canonical names before unlinked email matches and never another account or colony roster',async()=>{
 const linked=randomUUID(),fallback=randomUUID(),conflict=randomUUID(),otherPerson=randomUUID();
 for(const [id,email,name] of [[linked,'linked@example.org','Linked auth name'],[fallback,'  EMAIL-FALLBACK@EXAMPLE.ORG  ','Fallback auth name'],[conflict,'conflict@example.org','Correct auth fallback'],[otherPerson,'otherperson@example.org','Other account']]) {
  await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[id,email,JSON.stringify({full_name:name})]);
  await db.query("insert into public.memberships(colony_id,user_id,role,active,updated_by) values($1,$2,'editor',true,$3)",[colony,id,ids.owner]);
 }
 await db.query(`insert into public.lab_members(colony_id,name,email,acronym,status,linked_user_id,username,created_by,updated_by) values
   ($1,'Canonical Linked','old-linked@example.org','CL','current',$2,'canonical',$5,$5),
   ($1,'Unlinked Name Must Lose','linked@example.org','UL','review',null,null,$5,$5),
   ($1,'Canonical Email','email-fallback@example.org','CE','current',null,null,$5,$5),
   ($1,'Belongs To Another Account','conflict@example.org','OA','current',$3,'otheraccount',$5,$5),
   ($4,'Foreign Colony Name','conflict@example.org','FC','current',null,null,$5,$5)`,[colony,linked,otherPerson,other,ids.owner]);
 const result=await as('owner',()=>list()),byId=new Map(result.users.map(u=>[u.user_id,u]));
 assert.equal(byId.get(linked).name,'Canonical Linked');assert.equal(byId.get(linked).acronym,'CL');
 assert.equal(byId.get(fallback).name,'Canonical Email');assert.equal(byId.get(fallback).acronym,'CE');
 assert.equal(byId.get(conflict).name,'Correct auth fallback');assert.equal(byId.get(conflict).acronym,null);
 assert.equal(byId.get(otherPerson).name,'Belongs To Another Account');
});
await test('past log-only identities remain selectable without fabricating sign-ins or changing events',async()=>{
 const former=randomUUID(),deleted=randomUUID(),foreign=randomUUID();
 await db.query("insert into auth.users(id,email,last_sign_in_at) values($1,'former-current@example.org','2026-10-16T03:00:00Z')",[former]);
 for(const [id,target,email,name] of [[former,colony,'former-old@example.org','Former Scientist'],[deleted,colony,'deleted@example.org','Deleted Scientist'],[foreign,other,'foreign@example.org','Foreign Scientist']])await db.query(`insert into colony_private.app_access_log(colony_id,user_id,email,name,acronym,role,app,event,page,session_id,event_id,occurred_at) values($1,$2,$3,$4,'FORMER','editor','mouse','page_view','mice',$5,$6,'2020-01-01T00:00:00Z')`,[target,id,email,name,randomUUID(),randomUUID()]);
 const result=await as('owner',()=>list({app:'reagents',limit:1})),formerUser=result.users.find(u=>u.user_id===former),deletedUser=result.users.find(u=>u.user_id===deleted);
 assert.equal(formerUser.name,'Former Scientist');assert.equal(formerUser.email,'former-old@example.org');assert.equal(formerUser.last_sign_in_at,null);assert.equal(formerUser.active,false);
 assert.equal(deletedUser.name,'Deleted Scientist');assert.equal(deletedUser.email,'deleted@example.org');assert.equal(deletedUser.last_sign_in_at,null);assert.equal(deletedUser.active,false);
 assert(!result.users.some(u=>u.user_id===foreign));
 const event=(await as('owner',()=>list({user:former}))).events[0];
 assert.equal(event.email,'former-old@example.org');assert.equal(event.name,'Former Scientist');assert.equal(event.source,'app_reported');assert.equal(Date.parse(event.occurred_at),Date.parse('2020-01-01T00:00:00Z'));
});
await test('standalone directory migration replaces only the list RPC and preserves privileges, activation and immutable events',async()=>{
 const directoryMigration=await readFile(new URL('../app-access-directory.sql',import.meta.url),'utf8');
 assert.equal((directoryMigration.match(/create or replace function/g)||[]).length,1);
 assert(directoryMigration.includes(migration.slice(migration.indexOf('create or replace function public.list_app_access('),migration.indexOf('revoke all on function public.list_app_access('))));
 const before=(await db.query('select * from colony_private.app_access_log order by access_id')).rows;
 const grants=(await db.query("select proacl::text from pg_proc where oid='public.list_app_access(uuid,text,uuid,text,timestamptz,timestamptz,bigint,integer)'::regprocedure")).rows;
 await db.exec(directoryMigration);await db.exec(directoryMigration);
 assert.deepEqual((await db.query('select * from colony_private.app_access_log order by access_id')).rows,before);
 assert.deepEqual((await db.query("select proacl::text from pg_proc where oid='public.list_app_access(uuid,text,uuid,text,timestamptz,timestamptz,bigint,integer)'::regprocedure")).rows,grants);
 assert.equal((await db.query('select started_at::text from colony_private.app_access_activation')).rows[0].started_at,activation);
 for(const name of ['manager','editor','viewer','disabled','pending','ownerB'])await as(name,()=>denied(()=>list()));
 await as('owner',()=>denied(()=>list({colony:other})));await as(null,()=>denied(()=>list()),'anon');await as(null,()=>denied(()=>list()),'service_role');
 assert((await as('owner',()=>list())).users.some(u=>u.user_id===ids.editor));
});
await db.close();
