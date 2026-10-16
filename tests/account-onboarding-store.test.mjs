import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../web/data-store.js';
import {PUBLIC_CONFIG} from '../web/config.js';
class Storage{values=new Map();getItem(k){return this.values.get(k)??null;}setItem(k,v){this.values.set(k,String(v));}removeItem(k){this.values.delete(k);}clear(){this.values.clear();}}
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
const colony='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const session=(user=uid)=>({access_token:'access-'+user,refresh_token:'refresh-'+user,expires_in:3600,user:{id:user,email:user===uid?'new@example.org':'other@example.org'}});
const json=(value,status=200)=>Response.json(value,{status});
const anonKey='x.'+btoa(JSON.stringify({role:'anon'}))+'.x';
function fixture(options={}){
 localStorage.clear();sessionStorage.clear();store.configureCloud({url:options.url||'https://test.supabase.co',anonKey:options.anonKey||anonKey,colonyId:options.colonyId||colony});
 const state={members:[],eligible:true,hasPassword:false,setupRequired:true,username:null,profileVersion:1,profileFields:{name:'Registered Person',phone:null,acronym:'NP',category:'unknown'},calls:[],...options};
 const myProfile=()=>state.eligible?{member:{person_id:'person',email:'new@example.org',...state.profileFields,username:state.username,version:state.profileVersion,status:'current'},eligible:true,setup_required:state.setupRequired,registration_allowed:true,has_password:state.hasPassword,reason:state.hasPassword?'username_required':'password_required'}:state.registrationAllowed?{member:{person_id:state.profileVersion?'person':null,email:'new@example.org',...state.profileFields,version:state.profileVersion,status:'review'},eligible:false,setup_required:false,registration_allowed:true,reason:state.profileVersion?'approval_pending':'profile_required'}:{member:null,eligible:false,setup_required:false,registration_allowed:false,reason:'not_registered'};
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url),body=init.body?JSON.parse(init.body):null;state.calls.push({url,init,body});
  if(path.pathname==='/auth/v1/token')return json(session(body.email==='other@example.org'?other:uid));
  if(path.pathname==='/functions/v1/username-sign-in')return state.usernameDenied?json({message:'Username or password is incorrect'},401):json(session());
  if(path.pathname==='/auth/v1/verify')return json(session());
  if(path.pathname==='/auth/v1/otp')return json({});
  if(path.pathname==='/auth/v1/user'&&init.method==='PUT'){state.passwordSaved=true;state.hasPassword=true;if(state.passwordStall)return new Promise(()=>{});return json({id:init.headers.Authorization.includes(other)?other:uid});}
  if(path.pathname==='/auth/v1/user')return json({id:uid,email:'new@example.org',is_anonymous:false,email_confirmed_at:'2026-01-01'});
  if(path.pathname==='/rest/v1/memberships'){if(state.membershipFailure)throw new TypeError('Network unavailable');return json(path.searchParams.get('user_id')==='eq.'+other?[{role:'owner',active:true,export_level:'max'}]:state.members);}
  if(path.pathname==='/rest/v1/rpc/get_my_lab_member'){
   if(state.profileFailure)throw new TypeError('Network unavailable');
   if(state.profileWait)await state.profileWait;
   return json(myProfile());
  }
  if(path.pathname==='/rest/v1/rpc/submit_my_lab_profile'){
   if(state.profileSaveWait)await state.profileSaveWait;
   if(state.profileSaveFailure)return json({code:'40001',message:'Profile changed'},409);
   if(state.profileSaveDenied)return json({code:'42501',message:'Denied'},403);
   state.profileFields={...state.profileFields,...body.p_profile};state.profileVersion++;return json(myProfile());
  }
  if(path.pathname==='/rest/v1/rpc/complete_lab_member_setup'){
   if(state.completeFailure)return json({message:'This username is already registered',code:'23505'},400);
   state.members=[{role:'editor',active:true,export_level:'low'}];state.setupRequired=false;state.username=body.p_username;
   if(state.completeResponseFailure)throw new TypeError('Network unavailable');
   if(state.finalMembershipFailure)state.membershipFailure=true;
   return json({member:{username:body.p_username},eligible:true,setup_required:false});
  }
  if(path.pathname==='/rest/v1/rpc/list_lab_members')return json({members:[{name:'Private',email:'private@example.org',phone:'PRIVATE PHONE'}]});
  if(path.pathname==='/rest/v1/rpc/save_lab_member')return json({member:body.p_person});
  if(path.pathname==='/rest/v1/rpc/update_my_lab_acronym'){
   if(state.acronymWait)await state.acronymWait;
   if(state.acronymDenied)return json({message:'Profile changed',code:'40001'},400);
   return json({eligible:true,member:{person_id:'person',acronym:body.p_acronym,version:body.p_expected_version+1}});
  }
  if(path.pathname==='/auth/v1/logout')return json({});
  throw Error('Unexpected route '+path.pathname);
 };
 return state;
}
await test('verified current preregistration keeps a setup-only session and cannot pull colony or manage roster',async()=>{
 const state=fixture();await store.signIn('new@example.org','existing-password');assert.equal(store.getCloudStatus().role,'pending');assert.equal(store.getCloudStatus().setupRequired,true);assert.equal(store.getCloudStatus().mode,'local');
 await assert.rejects(store.pullFromCloud(),/not an active member/);await assert.rejects(store.listLabMembers(),/not an active member/);assert(!state.calls.some(c=>c.url.includes('/entity_records')));
});
await test('unregistered or disabled accounts lose their session and cannot substitute preregistration for revoked access',async()=>{
 for(const options of [{eligible:false},{members:[{role:'editor',active:false,export_level:'low'}]}]){const state=fixture(options);await assert.rejects(store.signIn('new@example.org','password'),/not an active member/);assert.equal(store.getCloudStatus().signedIn,false);if(options.members)assert(!state.calls.some(c=>c.url.includes('/get_my_lab_member')));}
});
await test('only the explicit registration action may request creation, with a clean same-origin return URL and no access grant',async()=>{
 const state=fixture();globalThis.location=new URL('https://app.example/mouse-data/?ignore=1#settings');
 await store.requestRegistrationEmail(' applicant@example.org ');let call=state.calls.at(-1);assert.deepEqual(call.body,{email:'applicant@example.org',create_user:true});assert.equal(new URL(call.url).searchParams.get('redirect_to'),'https://app.example/mouse-data/');assert.equal(store.getCloudStatus().signedIn,false);assert(!state.calls.some(c=>c.url.includes('/rest/v1/')));
 await store.requestEmailLink('applicant@example.org','https://app.example/mouse-data/',{firstTime:true});call=state.calls.at(-1);assert.equal(call.body.create_user,false,'ordinary sign-in must ignore a creation option');
 await store.requestEmailCode('applicant@example.org');assert.equal(state.calls.at(-1).body.create_user,false);
 const count=state.calls.length;globalThis.location=new URL('http://remote.example/mouse-data/');await assert.rejects(store.requestRegistrationEmail('applicant@example.org'),/return to this app/);assert.equal(state.calls.length,count);
});
await test('explicit registration permission retains only a pending profile session with no cached data or local writes',async()=>{
 for(const profileVersion of [0,1]){
  const state=fixture({eligible:false,registrationAllowed:true,profileVersion});await store.signIn('new@example.org','password');
  assert.equal(store.getCloudStatus().role,'pending');assert.equal(store.getCloudStatus().setupRequired,true);assert.equal(store.getCloudStatus().readyForEdits,false);
  const before=[...localStorage.values];const calls=state.calls.length;assert.equal(await store.loadDataset(),null);await assert.rejects(store.saveDataset({tables:{}},{localOnly:true}),/account setup/);
  assert.deepEqual([...localStorage.values],before,'pending read/write gates must not discard unrelated local state');assert.equal(state.calls.length,calls);
  await assert.rejects(store.completeAccountSetup('new.user','private-new-password'),/owner to register/);assert(!state.calls.some(c=>c.init.method==='PUT'||c.url.includes('/complete_lab_member_setup')));
 }
});
await test('self profile sends only allowed fields and current version, stays pending and never caches contacts',async()=>{
 const state=fixture({eligible:false,registrationAllowed:true,profileVersion:0});await store.signIn('new@example.org','password');
 const result=await store.saveMyLabProfile({name:' New Member ',phone:' PRIVATE CONTACT ',acronym:' new ',category:'phd'},0);
 assert.equal(result.reason,'approval_pending');assert.equal(result.member.version,1);assert.equal(store.getCloudStatus().role,'pending');assert.equal(store.getCloudStatus().readyForEdits,false);
 const call=state.calls.find(c=>c.url.includes('/submit_my_lab_profile'));assert.deepEqual(call.body,{p_colony_id:colony,p_profile:{name:'New Member',phone:'PRIVATE CONTACT',acronym:'NEW',category:'phd'},p_expected_version:0});
 assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('PRIVATE CONTACT'));
 for(const key of ['email','status','intended_role','export_level','user_id'])await assert.rejects(store.saveMyLabProfile({name:'Test',[key]:'owner'},1),/Only your name/);
 await assert.rejects(store.saveMyLabProfile({name:'Test'},-1),/Reload/);
 state.profileSaveFailure=true;await assert.rejects(store.saveMyLabProfile({name:'Test'},1),/changed in another session/);state.profileSaveFailure=false;
 state.profileSaveDenied=true;await assert.rejects(store.saveMyLabProfile({name:'Test'},1),error=>error.status===403);
 assert.equal(state.members.length,0);assert(!state.calls.some(c=>c.url.includes('/complete_lab_member_setup')));
});
await test('a completed current member can update their profile without being placed back into pending setup',async()=>{
 const state=fixture({setupRequired:false,username:'existing.user',members:[{role:'editor',active:true}]});await store.signIn('new@example.org','password');
 const result=await store.saveMyLabProfile({name:'Current Member',phone:'PRIVATE CURRENT CONTACT'},1);
 assert.equal(result.registration_allowed,true);assert.equal(store.getCloudStatus().setupRequired,false);assert.equal(store.getCloudStatus().role,'editor');
 assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('PRIVATE CURRENT CONTACT'));
});
await test('a delayed self-profile response cannot change a replacement login or leak its contact fields into session',async()=>{
 const state=fixture({eligible:false,registrationAllowed:true});await store.signIn('new@example.org','password');let release;state.profileSaveWait=new Promise(resolve=>release=resolve);
 const pending=store.saveMyLabProfile({name:'New Member',phone:'PRIVATE CONTACT'},1);await new Promise(resolve=>setTimeout(resolve,0));await store.signIn('other@example.org','password');release();await assert.rejects(pending,/account changed/);
 assert.equal(store.getCloudStatus().role,'owner');assert.equal(store.getCloudStatus().setupRequired,false);assert.equal(store.getCloudStatus().email,'other@example.org');assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('PRIVATE CONTACT'));
});
await test('setup saves password only through Auth, claims username separately and confirms active membership',async()=>{
 const state=fixture();await store.signIn('new@example.org','old-password');state.calls.length=0;await store.completeAccountSetup('Lab.User','new-long-account-password');
 const put=state.calls.filter(c=>c.init.method==='PUT');assert.equal(put.length,1);assert(put[0].url.endsWith('/auth/v1/user'));assert.deepEqual(put[0].body,{password:'new-long-account-password'});
 const claim=state.calls.find(c=>c.url.includes('/complete_lab_member_setup'));assert.deepEqual(claim.body,{p_colony_id:colony,p_username:'lab.user'});assert.equal(store.getCloudStatus().role,'editor');assert.equal(store.getCloudStatus().username,'lab.user');assert.equal(store.getCloudStatus().setupRequired,false);
 assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('new-long-account-password'));
 assert.equal(state.calls.filter(c=>c.url.includes('/get_my_lab_member')).length,1,'one freshly verified setup profile is enough before the password write');
});
await test('profile-check failures report the stage and send no account writes',async()=>{
 const state=fixture();await store.signIn('new@example.org','old-password');state.profileFailure=true;state.calls.length=0;
 await assert.rejects(store.completeAccountSetup('lab.user','new-long-account-password'),e=>e.setupStage==='profile'&&/profile check failed/i.test(e.message));
 assert(!state.calls.some(c=>c.init.method==='PUT'||c.url.includes('/complete_lab_member_setup')));
});
await test('partial username failure reports the saved password and does not grant membership',async()=>{
 const state=fixture({completeFailure:true});await store.signIn('new@example.org','old-password');await assert.rejects(store.completeAccountSetup('lab.user','new-long-account-password'),/password was saved.*Username setup was not confirmed/);assert.equal(state.passwordSaved,true);assert.equal(store.getCloudStatus().role,'pending');assert.equal(store.getCloudStatus().setupRequired,true);
});
await test('a lost claim response is reconciled by a read without repeating account writes',async()=>{
 const state=fixture({completeResponseFailure:true});await store.signIn('new@example.org','old-password');
 await store.completeAccountSetup('lab.user','new-long-account-password');assert.equal(store.getCloudStatus().role,'editor');
 assert.equal(state.calls.filter(c=>c.init.method==='PUT').length,1);assert.equal(state.calls.filter(c=>c.url.includes('/complete_lab_member_setup')).length,1);
});
await test('a saved account can retry final membership verification without changing its password again',async()=>{
 const state=fixture({finalMembershipFailure:true});await store.signIn('new@example.org','old-password');
 await assert.rejects(store.completeAccountSetup('lab.user','new-long-account-password'),e=>e.accountSaved===true&&e.setupStage==='verification');
 assert.equal(state.setupRequired,false);assert.equal(store.getCloudStatus().role,'pending');state.membershipFailure=false;state.finalMembershipFailure=false;
 await store.completeAccountSetup('lab.user','different-input-must-not-change-password');assert.equal(store.getCloudStatus().role,'editor');
 assert.equal(state.calls.filter(c=>c.init.method==='PUT').length,1);assert.equal(state.calls.filter(c=>c.url.includes('/complete_lab_member_setup')).length,1);
 await assert.rejects(store.completeAccountSetup('different.user','new-long-account-password'),/already complete/);
});
await test('a stalled password update is bounded, never repeated and never followed by a claim',async()=>{
 const state=fixture({passwordStall:true});await store.signIn('new@example.org','old-password');const original=setTimeout;
 globalThis.setTimeout=(callback,ms,...args)=>original(callback,ms===30000?5:ms,...args);
 try{await assert.rejects(store.completeAccountSetup('lab.user','new-long-account-password'),/password update was not confirmed/);}
 finally{globalThis.setTimeout=original;}
 assert.equal(state.calls.filter(c=>c.init.method==='PUT').length,1);assert(!state.calls.some(c=>c.url.includes('/complete_lab_member_setup')));assert.equal(store.getCloudStatus().role,'pending');
 assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('new-long-account-password'));
});
await test('account switch during profile fetch cannot mutate another session or change its password',async()=>{
 const state=fixture();await store.signIn('new@example.org','old-password');let release;state.profileWait=new Promise(resolve=>{release=resolve;});
 const pending=store.completeAccountSetup('lab.user','new-long-account-password');await new Promise(resolve=>setTimeout(resolve,0));await store.signIn('other@example.org','other-password');release();await assert.rejects(pending,/account changed/);
 assert.equal(store.getCloudStatus().email,'other@example.org');assert.equal(store.getCloudStatus().role,'owner');assert.equal(store.getCloudStatus().username,null);assert.equal(store.getCloudStatus().setupRequired,false);assert(!state.calls.some(c=>c.init.method==='PUT'));assert(!state.calls.some(c=>c.url.includes('/complete_lab_member_setup')));
});
await test('owner roster contacts are returned transiently and never cached with colony data or session',async()=>{
 const state=fixture({members:[{role:'owner',active:true,export_level:'max'}]});await store.signIn('new@example.org','owner-password');const result=await store.listLabMembers();assert.equal(result.members[0].phone,'PRIVATE PHONE');assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('PRIVATE PHONE'));assert.equal(store.getCloudStatus().exportLevel,'max');
 state.members=[{role:'manager',active:true,export_level:'max',permissions:{mice:true}}];await assert.rejects(store.listLabMembers(),/Only the owner/);
});
await test('username route is distinct from email password Auth and is rechecked against current membership',async()=>{
 const state=fixture({members:[{role:'editor',active:true,export_level:'low'}]});await store.signIn('lab.user','account-password');assert(state.calls[0].url.endsWith('/functions/v1/username-sign-in'));assert.deepEqual(state.calls[0].body,{username:'lab.user',password:'account-password'});assert.equal(state.calls[0].init.headers.apikey,anonKey);assert.equal(state.calls[0].init.headers.Authorization,'Bearer '+anonKey);assert(state.calls.some(c=>c.url.includes('/memberships')));
});
await test('publishable key configuration directs username users to email without transmitting the password to an incompatible gateway',async()=>{
 const state=fixture({anonKey:'sb_publishable_test',members:[{role:'editor',active:true,export_level:'low'}]});await assert.rejects(store.signIn('lab.user','account-password'),/Use your email to sign in/);assert.equal(state.calls.length,0);await store.signIn('new@example.org','account-password');assert.equal(store.getCloudStatus().role,'editor');assert(!state.calls.some(c=>c.url.includes('/functions/')));
});
await test('bundled public gateway key is used only for username login to the exact configured deployment',async()=>{
 const state=fixture({url:PUBLIC_CONFIG.url,colonyId:PUBLIC_CONFIG.colonyId,anonKey:PUBLIC_CONFIG.anonKey,members:[{role:'editor',active:true,export_level:'low'}]});
 assert(PUBLIC_CONFIG.anonKey.startsWith('sb_publishable_'));const claims=JSON.parse(atob(PUBLIC_CONFIG.usernameAnonKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));assert.equal(claims.role,'anon');
 const result=await store.signIn('lab.user','private-account-password'),gateway=state.calls[0];assert.equal(gateway.url,PUBLIC_CONFIG.url+'/functions/v1/username-sign-in');assert.equal(gateway.init.headers.apikey,PUBLIC_CONFIG.usernameAnonKey);assert.equal(gateway.init.headers.Authorization,'Bearer '+PUBLIC_CONFIG.usernameAnonKey);
 assert.equal(result.anonKey,PUBLIC_CONFIG.anonKey);assert.equal(result.usernameAnonKey,undefined);assert(!JSON.stringify(result).includes('private-account-password'));
 for(const call of state.calls.slice(1)){assert(call.url.startsWith(PUBLIC_CONFIG.url+'/rest/v1/'));assert.equal(call.init.headers.apikey,PUBLIC_CONFIG.anonKey);assert.equal(call.init.headers.Authorization,'Bearer access-'+uid);assert(!JSON.stringify(call.body).includes('private-account-password'));}
 assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('private-account-password'));assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes(PUBLIC_CONFIG.usernameAnonKey));
 state.calls.length=0;await store.signIn('new@example.org','private-email-password');assert(state.calls[0].url.includes('/auth/v1/token'));assert.equal(state.calls[0].init.headers.apikey,PUBLIC_CONFIG.anonKey);assert(!state.calls.some(c=>c.url.includes('/functions/')));assert(!state.calls.some(c=>Object.values(c.init.headers||{}).includes(PUBLIC_CONFIG.usernameAnonKey)));
});
await test('gateway fallback cannot cross a project or colony boundary and never replaces an explicit legacy key',async()=>{
 for(const settings of [{url:'https://other.supabase.co',colonyId:PUBLIC_CONFIG.colonyId},{url:PUBLIC_CONFIG.url,colonyId:colony}]){
  const state=fixture({...settings,anonKey:'sb_publishable_test'});await assert.rejects(store.signIn('lab.user','private-account-password'),/Use your email to sign in/);assert.equal(state.calls.length,0);assert.equal(store.getCloudStatus().signedIn,false);
 }
 for(const settings of [{url:PUBLIC_CONFIG.url,colonyId:PUBLIC_CONFIG.colonyId},{url:'https://other.supabase.co',colonyId:colony}]){
  const state=fixture({...settings,anonKey,members:[{role:'editor',active:true,export_level:'low'}]});await store.signIn('lab.user','private-account-password');assert.equal(state.calls[0].init.headers.apikey,anonKey);assert.equal(state.calls[0].init.headers.Authorization,'Bearer '+anonKey);assert(state.calls.every(c=>c.url.startsWith(settings.url+'/')));
 }
});
await test('self acronym update sends only normalized own acronym and profile version, keeps privileges unchanged and rejects stale or switched responses',async()=>{
 const state=fixture({members:[{role:'editor',active:true,export_level:'low'}]});await store.signIn('new@example.org','account-password');const role=store.getCloudStatus().role,level=store.getCloudStatus().exportLevel;
 const result=await store.updateMyLabAcronym({acronym:' lab_1 ',version:2});assert.equal(result.member.acronym,'LAB_1');const call=state.calls.find(c=>c.url.includes('/update_my_lab_acronym'));assert.deepEqual(call.body,{p_colony_id:colony,p_acronym:'LAB_1',p_expected_version:2});assert.equal(store.getCloudStatus().role,role);assert.equal(store.getCloudStatus().exportLevel,level);
 await assert.rejects(store.updateMyLabAcronym({acronym:'BAD ACRONYM',version:2}),/1–12/);await assert.rejects(store.updateMyLabAcronym({acronym:'LAB',version:0}),/Reload/);
 state.acronymDenied=true;await assert.rejects(store.updateMyLabAcronym({acronym:'LAB',version:2}),/changed in another session/);state.acronymDenied=false;
 let release;state.acronymWait=new Promise(resolve=>release=resolve);const pending=store.updateMyLabAcronym({acronym:'LAB',version:3});await new Promise(resolve=>setTimeout(resolve,0));await store.signIn('other@example.org','password');release();await assert.rejects(pending,/account changed/);assert.equal(store.getCloudStatus().email,'other@example.org');assert.equal(store.getCloudStatus().role,'owner');
});
await test('email callback may retain verified setup-only access but removes credentials from the address first',async()=>{
 const state=fixture(),token='x.'+btoa(JSON.stringify({iss:'https://test.supabase.co/auth/v1',role:'authenticated',aud:'authenticated',sub:uid,exp:Math.floor(Date.now()/1000)+3600}))+'.x';
 globalThis.location=new URL('https://app.example/#'+new URLSearchParams({access_token:token,refresh_token:'test-refresh',type:'signup'}));globalThis.history={state:null,replaceState(_s,_t,url){globalThis.location=new URL(url,globalThis.location);}};
 const result=await store.consumeAuthCallback();assert.equal(result.role,'pending');assert.equal(result.setupRequired,true);assert.equal(globalThis.location.hash,'');assert.equal(result.needsPasswordSetup,true);assert(!state.calls.some(c=>c.url.includes('/entity_records')));
});

await test('verified email callback keeps Review-only access only when the server explicitly allows registration',async()=>{
 for(const registrationAllowed of [true,false]){
  fixture({eligible:false,registrationAllowed,profileVersion:0});const token='x.'+btoa(JSON.stringify({iss:'https://test.supabase.co/auth/v1',role:'authenticated',aud:'authenticated',sub:uid,exp:Math.floor(Date.now()/1000)+3600}))+'.x';
  globalThis.location=new URL('https://app.example/#'+new URLSearchParams({access_token:token,refresh_token:'test-refresh',type:'signup'}));globalThis.history={state:null,replaceState(_s,_t,url){globalThis.location=new URL(url,globalThis.location);}};
  if(registrationAllowed){const result=await store.consumeAuthCallback();assert.equal(result.role,'pending');assert.equal(result.readyForEdits,false);assert.equal(await store.loadDataset(),null);}
  else{await assert.rejects(store.consumeAuthCallback(),/not an active member/);assert.equal(store.getCloudStatus().signedIn,false);}
  assert.equal(globalThis.location.hash,'');
 }
});

await test('internal portal verifies Auth and current membership without loading colony records or roster',async()=>{
 const state=fixture({members:[{role:'editor',active:true,export_level:'low'}]});await store.signIn('new@example.org','password');state.calls.length=0;
 const status=await store.verifyCloudMembership();assert.equal(status.role,'editor');assert.equal(state.calls.length,2);
 assert.equal(new URL(state.calls[0].url).pathname,'/auth/v1/user');assert.equal(state.calls[0].init.cache,'no-store');assert.equal(state.calls[0].init.redirect,'error');assert.equal(new URL(state.calls[1].url).pathname,'/rest/v1/memberships');
 state.members=[{role:'editor',active:false,export_level:'low'}];await assert.rejects(store.verifyCloudMembership(),/not an active member/);
});
await test('internal portal rejects recovery, setup-only, forged cached identities and revoked sessions',async()=>{
 fixture();await store.signIn('new@example.org','password');await assert.rejects(store.verifyCloudMembership(),/account setup/);
 const state=fixture({members:[{role:'owner',active:true}]});await store.signIn('new@example.org','password');const key='mouse-colony.session.v1',saved=JSON.parse(sessionStorage.getItem(key));
 sessionStorage.setItem(key,JSON.stringify({...saved,passwordRecovery:true}));state.calls.length=0;await assert.rejects(store.verifyCloudMembership(),/resetting your password/);assert.equal(state.calls.length,0);
 sessionStorage.setItem(key,JSON.stringify({...saved,user:{...saved.user,id:other}}));await assert.rejects(store.verifyCloudMembership(),/could not be verified/);
 sessionStorage.setItem(key,JSON.stringify(saved));const originalFetch=globalThis.fetch;globalThis.fetch=(url,init)=>new URL(url).pathname==='/auth/v1/user'?Promise.resolve(json({},401)):originalFetch(url,init);await assert.rejects(store.verifyCloudMembership(),/could not be verified/);
});
await test('portal access check cannot restore a session after sign-out while membership is in flight',async()=>{
 fixture({members:[{role:'editor',active:true}]});await store.signIn('new@example.org','password');let release,started;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{if(new URL(url).pathname==='/rest/v1/memberships'){started();await gate;}return originalFetch(url,init);};
 const check=store.verifyCloudMembership();await waiting;await store.signOut();release();await assert.rejects(check,/changed/);assert.equal(store.getCloudStatus().signedIn,false);
});
