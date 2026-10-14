import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../functions/username-sign-in/handler.mjs';
const colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',uid='11111111-1111-4111-8111-111111111111';
const config={SUPABASE_URL:'https://project.example',SUPABASE_SERVICE_ROLE_KEY:'server-only-key',SUPABASE_ANON_KEY:'public-key',USER_MANAGEMENT_COLONY_ID:colony,USER_MANAGEMENT_APP_URL:'https://app.example/colony/'};
const json=(value,status=200)=>Response.json(value,{status});
function harness(overrides={}){
 const calls=[],options={counter:true,person:{linked_user_id:uid,email:'private@example.org'},membership:{active:true},auth:{access_token:'test-access',refresh_token:'test-refresh',expires_in:3600,user:{id:uid,email:'private@example.org',email_confirmed_at:'2026-01-01',is_anonymous:false}},...overrides};
 const handler=createHandler({env:{get:key=>({...config,...options.env})[key]},fetchImpl:async(url,init)=>{
   const body=init.body?JSON.parse(init.body):null;calls.push({url,init,body});
   if(options.networkError)throw new Error('private infrastructure error');
   if(url.includes('consume_username_login_attempt'))return json(options.counter,options.counterStatus||200);
   if(url.includes('/lab_members?'))return json(options.person?[options.person]:[],options.personStatus||200);
   if(url.includes('/memberships?'))return json(options.membership?[options.membership]:[]);
   if(url.includes('/auth/v1/token?'))return json(options.auth,options.authStatus||200);
   throw new Error('Unexpected path');
 }});
 const send=(body={username:' Lab.User ',password:'sensitive-account-password'},extra={})=>handler(new Request('https://edge.example/username-sign-in',{method:'POST',headers:{Origin:'https://app.example','Content-Type':'application/json',...extra.headers},body:typeof body==='string'?body:JSON.stringify(body),...extra}));
 return {calls,send,handler};
}
await test('password is sent only to configured Auth; privileged lookups contain no password and credentials stay server-side',async()=>{
 const {calls,send}=harness();const response=await send(),body=await response.json();assert.equal(response.status,200);assert.equal(body.access_token,'test-access');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),'https://app.example');
 assert.equal(calls.length,4);assert.deepEqual(calls[0].body,{p_colony_id:colony,p_username:'lab.user'});
 for(const call of calls){assert(call.url.startsWith(config.SUPABASE_URL+'/'));assert.equal(call.init.redirect,'error');assert.equal(call.init.cache,'no-store');if(call.url.includes('/auth/v1/')){assert.equal(call.init.headers.apikey,'public-key');assert.deepEqual(call.body,{email:'private@example.org',password:'sensitive-account-password'});}else{assert.equal(call.init.headers.apikey,'server-only-key');assert(!JSON.stringify(call.body).includes('sensitive-account-password'));}}
 assert(!JSON.stringify(body).includes('server-only-key'));assert(!JSON.stringify(body).includes('sensitive-account-password'));
});
await test('unknown, disabled, bad-password, account-mismatch, anonymous, unverified and incomplete sessions share a generic denial',async()=>{
 const tokens={access_token:'test-access',refresh_token:'test-refresh'};
 const cases=[{person:null},{membership:{active:false}},{authStatus:400,auth:{error:'PRIVATE AUTH ERROR'}},{auth:{...tokens,user:{id:'another',email_confirmed_at:'2026-01-01'}}},{auth:{...tokens,user:{id:uid,email_confirmed_at:null}}},{auth:{...tokens,user:{id:uid,email_confirmed_at:'2026-01-01',is_anonymous:true}}},{auth:{user:{id:uid,email_confirmed_at:'2026-01-01'}}}];
 const results=[];for(const options of cases){const h=harness(options),r=await h.send();assert.equal(r.status,401);results.push(await r.text());if(options.membership?.active===false||options.person===null)assert(!h.calls.some(c=>c.url.includes('/auth/v1/')));}
 assert.equal(new Set(results).size,1);assert(!results[0].includes('private@example.org'));assert(!results[0].includes('PRIVATE'));
});
await test('rate failure, untrusted origins, malformed and oversized bodies fail before account lookup',async()=>{
 for(const [options,status]of [[{counter:false},429],[{counterStatus:500},503],[{networkError:true},503]]){const h=harness(options),r=await h.send();assert.equal(r.status,status);assert(h.calls.length<=1);}
 const h=harness();for(const body of [{username:'bad@name',password:'x'},{username:'valid',password:'x',email:'injected@example.org'},[],null,'not json']){const r=await h.send(body);assert.equal(r.status,401);}assert.equal(h.calls.length,0);
 assert.equal((await h.send('x'.repeat(2049))).status,413);assert.equal((await h.send({}, {headers:{Origin:'https://evil.example','Content-Type':'application/json'}})).status,403);assert.equal(h.calls.length,0);
 const preflight=await h.handler(new Request('https://edge.example',{method:'OPTIONS',headers:{Origin:'https://app.example'}}));assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://app.example');assert(preflight.headers.get('access-control-allow-headers').split(',').map(s=>s.trim()).includes('authorization'));
});
await test('username function gateway verifies the project anon JWT; account Auth and rate checks remain in its handler',async()=>{
 const config=await readFile(new URL('../config.toml',import.meta.url),'utf8');assert.match(config,/\[functions\.username-sign-in\]\s*verify_jwt\s*=\s*true/);
 const h=harness({env:{SUPABASE_SERVICE_ROLE_KEY:null}});assert.equal((await h.send()).status,503);assert.equal(h.calls.length,0);
});

const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create function auth.role() returns text language sql stable as $$select current_setting('request.jwt.claim.role',true)$$;create table public.colonies(id uuid primary key);insert into public.colonies values('${colony}');create schema colony_private;grant usage on schema colony_private to authenticated;`);
const migration=await readFile(new URL('../username-sign-in.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
async function as(role,fn,claim=role){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.role',$1,false)",[claim]);try{return await fn();}finally{await db.exec('reset role');}}
const consume=name=>db.query('select public.consume_username_login_attempt($1,$2) allowed',[colony,name]).then(r=>r.rows[0].allowed);
await test('counter RPC and underlying table deny anonymous and authenticated callers even with forged role claim',async()=>{
 for(const role of ['anon','authenticated'])await as(role,async()=>{await assert.rejects(()=>consume('test.name'),e=>e.code==='42501');await assert.rejects(()=>db.query('select * from colony_private.username_login_attempts'),e=>e.code==='42501');},'service_role');
 await as('service_role',()=>assert.rejects(()=>consume('test.name'),e=>e.code==='42501'),'authenticated');
});
await test('per-name cap is atomic, expires, and invalid names do not create counters',async()=>{
 await as('service_role',async()=>{for(let i=0;i<8;i++)assert.equal(await consume('test.name'),true);assert.equal(await consume('test.name'),false);assert.equal(await consume('bad/name'),false);assert.equal(await consume(null),false);});
 assert.equal((await db.query("select attempts from colony_private.username_login_attempts where username='test.name'")).rows[0].attempts,9);
 await db.exec("update colony_private.username_login_attempts set window_start=now()-interval '11 minutes' where username='test.name'");assert.equal(await as('service_role',()=>consume('test.name')),true);
});
await test('global bucket bounds random usernames and resets while old counters are pruned',async()=>{
 await db.exec('delete from colony_private.username_login_attempts');await as('service_role',async()=>{for(let i=0;i<120;i++)assert.equal(await consume('person'+i),true);assert.equal(await consume('new.person'),false);});
 assert.equal((await db.query('select count(*)::integer n from colony_private.username_login_attempts')).rows[0].n,121);
 await db.exec("update colony_private.username_login_attempts set window_start=now()-interval '2 minutes' where username='*';update colony_private.username_login_attempts set window_start=now()-interval '2 days' where username='person0'");assert.equal(await as('service_role',()=>consume('new.person')),true);assert.equal((await db.query("select * from colony_private.username_login_attempts where username='person0'")).rows.length,0);
});
await db.close();
