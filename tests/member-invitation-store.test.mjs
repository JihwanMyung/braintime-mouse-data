import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../web/data-store.js';

class Storage {values=new Map();getItem(k){return this.values.get(k)??null}setItem(k,v){this.values.set(k,String(v))}removeItem(k){this.values.delete(k)}clear(){this.values.clear()}}
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
const colony='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222',person='33333333-3333-4333-8333-333333333333';
const anonKey='x.'+btoa(JSON.stringify({role:'anon'}))+'.x';
async function fixture(options={}){
 localStorage.clear();sessionStorage.clear();store.configureCloud({url:'https://test.supabase.co',anonKey,colonyId:colony});
 const state={role:'owner',calls:[],...options};
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;state.calls.push({path,body,init});
  if(path==='/auth/v1/token')return Response.json({access_token:'owner-access',refresh_token:'owner-refresh',expires_in:3600,user:{id:uid,email:'owner@example.org'}});
  if(path==='/rest/v1/memberships')return Response.json([{role:state.role,active:true,export_level:state.role==='owner'?'max':'low'}]);
  if(path==='/functions/v1/manage-colony-users'){
   if(state.wait)await state.wait;
   if(state.throw)throw Error('Network error');
   return Response.json(state.result??{person_id:person,email_sent:true,message:'Invitation sent.'},{status:state.status??200});
  }
  if(path==='/auth/v1/logout')return Response.json({});
  throw Error('Unexpected route '+path);
 };
 await store.signIn('owner@example.org','synthetic-password');return state;
}
test('preregistered invitation sends only saved record identity and version, with an owner JWT',async()=>{
 const state=await fixture();const result=await store.inviteLabMember({person_id:person,version:4});assert.equal(result.email_sent,true);
 const sent=state.calls.filter(c=>c.path==='/functions/v1/manage-colony-users');assert.equal(sent.length,1);
 assert.deepEqual(sent[0].body,{person_id:person,version:4,action:'invite_preregistered',colony_id:colony});
 assert.equal(sent[0].init.headers.Authorization,'Bearer owner-access');assert.equal(sent[0].init.redirect,'error');
 assert(!state.calls.some(c=>c.path.includes('/invite')||c.path.includes('manage_colony_member')));
});
test('browser cannot substitute invite email, access, redirect or malformed roster versions',async()=>{
 const state=await fixture();
 for(const payload of [{person_id:person,version:1,email:'other@example.org'},{person_id:person,version:1,role:'manager'},{person_id:person,version:1,redirect:'https://elsewhere.example'},{person_id:'bad',version:1},{person_id:person,version:0},{person_id:person,version:1.5}])await assert.rejects(store.inviteLabMember(payload));
 assert(!state.calls.some(c=>c.path==='/functions/v1/manage-colony-users'));
});
test('nonowners and an owner downgraded since sign-in cannot send',async()=>{
 for(const role of ['viewer','editor','manager']){const state=await fixture({role});await assert.rejects(store.inviteLabMember({person_id:person,version:1}),/owner/i);assert(!state.calls.some(c=>c.path==='/functions/v1/manage-colony-users'));}
 const state=await fixture();state.role='manager';await assert.rejects(store.inviteLabMember({person_id:person,version:1}),/owner/i);assert(!state.calls.some(c=>c.path==='/functions/v1/manage-colony-users'));
});
test('unverified, rate-limited and uncertain outcomes are never automatically retried',async()=>{
 for(const options of [{result:{person_id:uid,email_sent:true}},{result:{person_id:person,email_sent:false}},{status:429,result:{code:'email_rate_limit',message:'Wait before sending another invitation.'}},{throw:true}]){
  const state=await fixture(options);await assert.rejects(store.inviteLabMember({person_id:person,version:1}));assert.equal(state.calls.filter(c=>c.path==='/functions/v1/manage-colony-users').length,1);
 }
 const state=await fixture({status:409,result:{code:'roster_changed_after_send',invitation_sent:true,message:'Email was sent, but the member changed. Refresh Members.'}});
 await assert.rejects(store.inviteLabMember({person_id:person,version:1}),e=>e.invitationSent===true&&/Email was sent/.test(e.message));assert.equal(state.calls.filter(c=>c.path==='/functions/v1/manage-colony-users').length,1);
});
test('sign-out while sending cannot publish a confirmed result into another session',async()=>{
 let release,started;const began=new Promise(r=>started=r);const state=await fixture();
 state.wait=new Promise(r=>release=r);const original=globalThis.fetch;globalThis.fetch=(url,init)=>{if(new URL(url).pathname==='/functions/v1/manage-colony-users')started();return original(url,init)};
 const pending=store.inviteLabMember({person_id:person,version:1});await began;await store.signOut();release();await assert.rejects(pending,/account or colony changed/);assert.equal(store.getCloudStatus().signedIn,false);
});
