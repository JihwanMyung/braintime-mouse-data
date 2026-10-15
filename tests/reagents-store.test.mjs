import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../web/data-store.js';
class Storage {values=new Map();getItem(k){return this.values.get(k)??null;}setItem(k,v){this.values.set(k,String(v));}removeItem(k){this.values.delete(k);}clear(){this.values.clear();}}
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
const colony='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const anonKey='x.'+btoa(JSON.stringify({role:'anon'}))+'.x';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
 localStorage.clear();sessionStorage.clear();store.configureCloud({url:'https://test.supabase.co',anonKey,colonyId:colony});
 const state={active:true,calls:[],memberGate:null,rpcGate:null,rpcError:null};
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url),body=init.body?JSON.parse(init.body):null;state.calls.push({url,init,body});
  if(u.pathname==='/auth/v1/token'){const id=body.email==='other@example.org'?other:uid;return Response.json({access_token:'access-'+id,refresh_token:'refresh-'+id,expires_in:3600,user:{id,email:body.email}});}
  if(u.pathname==='/auth/v1/logout')return Response.json({});
  if(u.pathname==='/rest/v1/memberships'){if(state.memberGate){const gate=state.memberGate;state.memberGate=null;gate.started.resolve();await gate.release.promise;}return Response.json([{role:'owner',active:state.active,export_level:'max'}]);}
  if(u.pathname.startsWith('/rest/v1/rpc/reagents_')){if(state.rpcGate){const gate=state.rpcGate;state.rpcGate=null;gate.started.resolve();await gate.release.promise;}return state.rpcError?Response.json(state.rpcError.body,{status:state.rpcError.status}):Response.json({rows:[{id:'PRIVATE-REAGENT-ROW'}],total:1,next_offset:null});}
  throw Error('Unexpected endpoint '+u.pathname);
 };
 return state;
}
const signIn=()=>store.signIn('member@example.org','synthetic-password');
const gate=()=>({started:deferred(),release:deferred()});

await test('bridge forces current colony, checks live membership, uses no-store and never caches private results',async()=>{
 const s=fixture();await signIn();s.calls=[];
 const result=await store.callReagents('list',{p_colony_id:'attacker-colony',p_kind:'item'});assert.equal(result.rows[0].id,'PRIVATE-REAGENT-ROW');
 assert.equal(s.calls.length,2);assert.ok(s.calls[0].url.includes('/memberships?'));assert.ok(s.calls[1].url.endsWith('/rpc/reagents_list'));
 assert.deepEqual(s.calls[1].body,{p_colony_id:colony,p_kind:'item'});
 for(const call of s.calls){assert.equal(call.init.cache,'no-store');assert.equal(call.init.redirect,'error');assert.equal(call.init.headers.Authorization,'Bearer access-'+uid);}
 assert.ok(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('PRIVATE-REAGENT-ROW'));
});
await test('operation allowlist, signed-out, pending and recovery sessions never reach RPC endpoints',async()=>{
 const s=fixture();await assert.rejects(store.callReagents('list'),e=>e.reagentsAccessChanged===true);
 await signIn();const saved=JSON.parse(sessionStorage.getItem('mouse-colony.session.v1'));
 for(const action of ['list/../../memberships','delete','get_lab_user_directory'])await assert.rejects(store.callReagents(action),/Unsupported/);
 await assert.rejects(store.callReagents('list',[]),/Unsupported/);
 for(const extra of [{passwordRecovery:true},{setupRequired:true},{role:'pending',setupRequired:false}]){sessionStorage.setItem('mouse-colony.session.v1',JSON.stringify({...saved,...extra}));s.calls=[];await assert.rejects(store.callReagents('list'),e=>e.reagentsAccessChanged===true);assert.equal(s.calls.length,0);}
});
await test('purchase actions keep the authenticated transport and cannot override the colony',async()=>{
 const s=fixture();await signIn();
 for(const action of ['order_search','order_list','order_submit','order_transition','order_locations','order_set_location','order_import_offers']){
  s.calls=[];await store.callReagents(action,{p_colony_id:'foreign-colony'});
  assert.equal(s.calls.length,2);assert.ok(s.calls[0].url.includes('/memberships?'));
  assert.ok(s.calls[1].url.endsWith('/rpc/reagents_'+action));assert.equal(s.calls[1].body.p_colony_id,colony);
  assert.equal(s.calls[1].init.cache,'no-store');
 }
 for(const action of ['order_mail_claim','order_mail_finish','order_delete','order_approve_all'])await assert.rejects(store.callReagents(action),/Unsupported/);
 s.active=false;s.calls=[];await assert.rejects(store.callReagents('order_submit',{}),e=>e.reagentsAccessChanged===true);assert.equal(s.calls.length,1);
});
await test('revoked membership rejects before RPC and marks private UI for invalidation',async()=>{
 const s=fixture();await signIn();s.active=false;s.calls=[];
 await assert.rejects(store.callReagents('list'),e=>e.reagentsAccessChanged===true);assert.equal(s.calls.length,1);
});
await test('account switch during membership verification cannot send the old operation',async()=>{
 const s=fixture();await signIn();const g=gate();s.memberGate=g;
 const pending=store.callReagents('save',{p_id:'OLD-PRIVATE-RECORD'});const rejected=assert.rejects(pending,e=>e.reagentsAccessChanged===true);
 await g.started.promise;await store.signIn('other@example.org','synthetic-password');g.release.resolve();await rejected;
 assert.ok(!s.calls.some(c=>c.url.endsWith('/rpc/reagents_save')));assert.equal(store.getCloudStatus().email,'other@example.org');
});
await test('late RPC responses after sign-out or same-account reauthentication cannot release private data',async()=>{
 for(const change of ['sign-out','same-account']){
  const s=fixture();await signIn();const g=gate();s.rpcGate=g;
  const pending=store.callReagents('list');const rejected=assert.rejects(pending,e=>e.reagentsAccessChanged===true);
  await g.started.promise;if(change==='sign-out')await store.signOut();else await signIn();g.release.resolve();await rejected;
  assert.ok(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('PRIVATE-REAGENT-ROW'));
 }
});
await test('authorization failures invalidate UI while ordinary CAS conflicts preserve editing context',async()=>{
 const s=fixture();await signIn();s.rpcError={status:403,body:{code:'42501',message:'Denied'}};
 await assert.rejects(store.callReagents('save'),e=>e.reagentsAccessChanged===true);
 s.rpcError={status:409,body:{code:'40001',message:'Conflict'}};
 await assert.rejects(store.callReagents('save'),e=>!e.reagentsAccessChanged&&/changed in another session/.test(e.message));
});
