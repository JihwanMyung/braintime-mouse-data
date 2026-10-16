import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../web/data-store.js';
class Storage{values=new Map();getItem(k){return this.values.get(k)??null}setItem(k,v){this.values.set(k,String(v))}removeItem(k){this.values.delete(k)}clear(){this.values.clear()}}
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
const colony='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333',targetId='44444444-4444-4444-8444-444444444444';
const payload=()=>({request_person_id:requestId,request_version:2,target_person_id:targetId,target_version:5});
const approved=()=>({member:{person_id:targetId,email:'registered@example.org',secondary_emails:['original@example.org'],name:'Member',status:'current',archived:false,linked_user_id:null,intended_role:'editor',export_level:'high',version:6},merged_request:{person_id:requestId,version:3,archived:true},setup_required:true});
async function fixture(options={}){
 localStorage.clear();sessionStorage.clear();store.configureCloud({url:'https://test.supabase.co',anonKey:'x.'+btoa(JSON.stringify({role:'anon'}))+'.x',colonyId:colony});
 const state={role:'owner',calls:[],...options};
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;state.calls.push({path,body,init});
  if(path==='/auth/v1/token')return Response.json({access_token:'owner-access',refresh_token:'owner-refresh',expires_in:3600,user:{id:uid,email:'owner@example.org'}});
  if(path==='/rest/v1/memberships'){if(state.membershipWait)await state.membershipWait;return Response.json([{role:state.role,active:true,export_level:state.role==='owner'?'max':'low'}]);}
  if(path==='/rest/v1/rpc/approve_lab_member_email'){state.started?.();if(state.wait)await state.wait;if(state.throw)throw Error('Connection unavailable');return Response.json(state.result??approved(),{status:state.status??200});}
  if(path==='/auth/v1/logout')return Response.json({});
  throw Error('Unexpected route '+path);
 };
 await store.signIn('owner@example.org','synthetic-password');return state;
}
test('owner approval sends only exact saved identities and versions and never caches contacts',async()=>{
 const state=await fixture(),result=await store.approveLabMemberEmail(payload());assert.deepEqual(result,approved());
 const calls=state.calls.filter(c=>c.path.endsWith('/approve_lab_member_email'));assert.equal(calls.length,1);
 assert.deepEqual(calls[0].body,{p_colony_id:colony,p_request_person_id:requestId,p_request_version:2,p_target_person_id:targetId,p_target_version:5});assert.equal(calls[0].init.headers.Authorization,'Bearer owner-access');assert.equal(calls[0].init.redirect,'error');
 assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('original@example.org'));
 assert(!state.calls.some(c=>c.path.includes('/functions/')||c.path.includes('/invite')||c.init.method==='PUT'));
});
test('approval rejects malformed, extra-field and self-merge payloads before mutation',async()=>{
 const state=await fixture();for(const invalid of [null,[],{}, {...payload(),email:'substitute@example.org'},{...payload(),role:'owner'},{...payload(),target_person_id:requestId},{...payload(),request_version:0},{...payload(),target_version:1.5},{...payload(),request_person_id:'invalid'}])await assert.rejects(store.approveLabMemberEmail(invalid));assert(!state.calls.some(c=>c.path.endsWith('/approve_lab_member_email')));
});
test('live owner verification denies nonowners and a downgraded owner',async()=>{
 for(const role of ['viewer','editor','manager']){const state=await fixture({role});await assert.rejects(store.approveLabMemberEmail(payload()),/owner/i);assert(!state.calls.some(c=>c.path.endsWith('/approve_lab_member_email')));}
 const state=await fixture();state.role='manager';await assert.rejects(store.approveLabMemberEmail(payload()),/owner/i);assert(!state.calls.some(c=>c.path.endsWith('/approve_lab_member_email')));
});
test('conflicts and uncertain responses are not retried',async()=>{
 for(const options of [{status:409,result:{code:'40001',message:'Changed'}},{throw:true},{result:{...approved(),setup_required:false}},{result:{...approved(),merged_request:{person_id:requestId,version:2,archived:true}}},{result:{...approved(),member:{...approved().member,person_id:requestId}}},{result:{...approved(),member:{...approved().member,secondary_emails:null}}}]){const state=await fixture(options);await assert.rejects(store.approveLabMemberEmail(payload()));assert.equal(state.calls.filter(c=>c.path.endsWith('/approve_lab_member_email')).length,1);}
});
test('signout during approval suppresses the result for the replaced session',async()=>{
 let release,started;const began=new Promise(resolve=>started=resolve),state=await fixture({started});state.wait=new Promise(resolve=>release=resolve);
 const pending=store.approveLabMemberEmail(payload());await began;await store.signOut();release();await assert.rejects(pending,/account or colony changed/);assert.equal(store.getCloudStatus().signedIn,false);
});
test('account change during owner check prevents the approval mutation',async()=>{
 let release;const state=await fixture();state.membershipWait=new Promise(resolve=>release=resolve);
 const pending=store.approveLabMemberEmail(payload());await new Promise(resolve=>setTimeout(resolve,0));await store.signOut();release();await assert.rejects(pending,/account.*changed/);assert(!state.calls.some(c=>c.path.endsWith('/approve_lab_member_email')));
});
