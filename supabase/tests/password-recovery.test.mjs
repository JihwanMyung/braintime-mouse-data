import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../functions/username-sign-in/handler.mjs';
const cid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',uid='11111111-1111-4111-8111-111111111111';
const config={SUPABASE_URL:'https://project.example',SUPABASE_SERVICE_ROLE_KEY:'server-key',SUPABASE_ANON_KEY:'public-key',USER_MANAGEMENT_COLONY_ID:cid,USER_MANAGEMENT_APP_URL:'https://app.example/colony/'};
function harness(options={}){const calls=[],pending=[],handler=createHandler({defer:task=>pending.push(task),env:{get:k=>({...config,...options.env})[k]},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body||'null');calls.push({url,init,body});if(url.includes('consume_password_recovery_attempt'))return Response.json(options.rate??true,{status:options.rateStatus??200});if(url.includes('resolve_colony_password_recovery'))return Response.json(options.unknown?null:{user_id:uid,email:'registered@example.org'},{status:options.lookupStatus??200});if(url.includes('/auth/v1/recover?')){if(options.deliveryPending)await options.deliveryPending;if(options.deliveryThrows)throw Error('PRIVATE mail server detail');return Response.json({message:'PRIVATE mail result'},{status:options.deliveryStatus??200});}throw Error('unexpected');}});return {calls,pending,flush:()=>Promise.all(pending),send:(body={action:'recover',identifier:' Lab.User '},origin='https://app.example')=>handler(new Request('https://edge.example',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)}))};}
await test('username/email recovery resolves only server-side and sends through Auth to a fixed app return URL',async()=>{
 for(const identifier of [' Lab.User ','REGISTERED@example.org']){const h=harness(),response=await h.send({action:'recover',identifier});assert.equal(response.status,202);await h.flush();const body=await response.json();assert.equal(body.accepted,true);assert(!JSON.stringify(body).includes('registered@example.org'));assert(!JSON.stringify(body).includes('server-key'));
  assert.equal(h.calls[0].body.p_identifier_hash,createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex'));assert.equal(h.calls[1].body.p_identifier,identifier.trim().toLowerCase());
  const mail=h.calls[2];assert.equal(new URL(mail.url).pathname,'/auth/v1/recover');assert.equal(new URL(mail.url).searchParams.get('redirect_to'),config.USER_MANAGEMENT_APP_URL);assert.deepEqual(mail.body,{email:'registered@example.org'});assert.equal(mail.init.headers.apikey,'public-key');assert.equal(mail.init.redirect,'error');assert.equal(mail.init.cache,'no-store');
 }
});
await test('unknown or ineligible accounts and mail-service failures have the same non-enumerating accepted response',async()=>{
 const responses=[];for(const options of [{},{unknown:true},{deliveryStatus:422},{deliveryStatus:429},{deliveryThrows:true}]){const h=harness(options),r=await h.send();assert.equal(r.status,202);responses.push(await r.text());if(options.unknown)assert.equal(h.calls.length,2);}
 assert.equal(new Set(responses).size,1);assert(!responses[0].includes('PRIVATE'));
});
await test('mail delivery latency is outside the accepted response for both known and unknown identifiers',async()=>{
 let release;const blocked=new Promise(r=>release=r);const h=harness({deliveryPending:blocked});
 const response=await h.send();assert.equal(response.status,202);assert.equal(h.pending.length,1);assert.equal(h.calls.length,3);release();await h.flush();
 const unknown=harness({unknown:true,deliveryPending:new Promise(()=>{})});assert.equal((await unknown.send()).status,202);assert.equal(unknown.pending.length,1);await unknown.flush();assert.equal(unknown.calls.length,2);
 const entry=await readFile(new URL('../functions/username-sign-in/index.ts',import.meta.url),'utf8');assert.match(entry,/EdgeRuntime\.waitUntil\(task\)/);
});
await test('rate limits, invalid request shapes and untrusted origins stop before lookup or mail',async()=>{
 for(const [options,status]of [[{rate:false},429],[{rateStatus:500},503]]){const h=harness(options);assert.equal((await h.send()).status,status);assert.equal(h.calls.length,1);}
 const h=harness();for(const body of [{action:'recover',identifier:'bad'+'x'.repeat(255)},{action:'recover',identifier:'valid',email:'other@example.org'},{action:'recover',identifier:'valid',redirectTo:'https://evil.example/'},{action:'recover',identifier:'x@invalid'}])assert.equal((await h.send(body)).status,400);assert.equal(h.calls.length,0);
 assert.equal((await h.send(undefined,'https://evil.example')).status,403);assert.equal(h.calls.length,0);
 for(const unknown of [true,false]){const wrong=harness({unknown,env:{USER_MANAGEMENT_APP_URL:'https://app.example/?return=https://evil.example/'}});assert.equal((await wrong.send()).status,503);assert.equal(wrong.calls.length,0);}
});
const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema colony_private;grant usage on schema colony_private to authenticated;
create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,is_anonymous boolean default false);
create table public.colonies(id uuid primary key);create table public.memberships(colony_id uuid,user_id uuid,active boolean);
create table public.lab_members(colony_id uuid,username text,status text,archived boolean,linked_user_id uuid,email text);
insert into colonies values('${cid}');`);
const sql=await readFile(new URL('../password-recovery.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
async function as(role,fn,claim=role){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.role',$1,false)",[claim]);try{return await fn();}finally{await db.exec('reset role');}}
const resolve=id=>db.query('select resolve_colony_password_recovery($1,$2) result',[cid,id]).then(r=>r.rows[0].result);
const consume=hash=>db.query('select consume_password_recovery_attempt($1,$2) allowed',[cid,hash]).then(r=>r.rows[0].allowed);
const hash=id=>createHash('sha256').update(id).digest('hex');
await db.query('insert into auth.users values($1,$2,now(),$3,false)',[uid,'owner@example.org','synthetic-existing-password-hash']);await db.query('insert into memberships values($1,$2,true)',[cid,uid]);
await test('recovery identity and counters cannot be queried by anon or authenticated clients, even with a forged role claim',async()=>{
 for(const role of ['anon','authenticated'])await as(role,async()=>{await assert.rejects(()=>resolve('owner@example.org'),e=>e.code==='42501');await assert.rejects(()=>consume(hash('owner')),e=>e.code==='42501');await assert.rejects(()=>db.query('select * from colony_private.password_recovery_attempts'),e=>e.code==='42501');},'service_role');
 await as('service_role',()=>assert.rejects(()=>resolve('owner@example.org'),e=>e.code==='42501'),'authenticated');
});
await test('verified active email works before username setup; username requires matching current linked roster',async()=>{
 assert.deepEqual(await as('service_role',()=>resolve(' OWNER@example.org ')),{user_id:uid,email:'owner@example.org'});assert.equal(await as('service_role',()=>resolve('lab.user')),null);
 await db.query("insert into lab_members values($1,'lab.user','current',false,$2,'owner@example.org')",[cid,uid]);assert.equal((await as('service_role',()=>resolve('LAB.USER'))).user_id,uid);
 for(const change of ["status='historical'","archived=true","email='different@example.org'","linked_user_id=null"]){await db.exec('begin');await db.exec('update lab_members set '+change);assert.equal(await as('service_role',()=>resolve('lab.user')),null);await db.exec('rollback');}
 for(const change of ["email_confirmed_at=null","encrypted_password=''","is_anonymous=true"]){await db.exec('begin');await db.exec('update auth.users set '+change);assert.equal(await as('service_role',()=>resolve('owner@example.org')),null);await db.exec('rollback');}
 await db.exec('update memberships set active=false');assert.equal(await as('service_role',()=>resolve('owner@example.org')),null);await db.exec('update memberships set active=true');assert.equal(await as('service_role',()=>resolve('missing@example.org')),null);
});
await test('recovery counters use hashed identifiers, enforce per-identifier and bounded global hourly limits',async()=>{
 await as('service_role',async()=>{for(let i=0;i<3;i++)assert.equal(await consume(hash('one')),true);assert.equal(await consume(hash('one')),false);assert.equal(await consume('owner@example.org'),false);});
 assert.equal((await db.query('select count(*) n from colony_private.password_recovery_attempts')).rows[0].n,2);
 await db.exec('delete from colony_private.password_recovery_attempts');await as('service_role',async()=>{for(let i=0;i<30;i++)assert.equal(await consume(hash('random'+i)),true);assert.equal(await consume(hash('extra')),false);});
 assert.equal((await db.query('select count(*) n from colony_private.password_recovery_attempts')).rows[0].n,31);
 await db.exec("update colony_private.password_recovery_attempts set window_start=now()-interval '2 hours'");assert.equal(await as('service_role',()=>consume(hash('extra'))),true);
});
await db.close();
