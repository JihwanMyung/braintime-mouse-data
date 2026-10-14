import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../web/data-store.js';
class Storage{values=new Map();getItem(k){return this.values.get(k)??null}setItem(k,v){this.values.set(k,String(v))}removeItem(k){this.values.delete(k)}clear(){this.values.clear()}}
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
const colony='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333',anonKey='x.'+btoa(JSON.stringify({role:'anon'}))+'.x';
function fixture(role='editor',permissions={}){
 localStorage.clear();sessionStorage.clear();store.configureCloud({url:'https://test.supabase.co',anonKey,colonyId:colony});const state={role,permissions,calls:[],wait:null};
 globalThis.fetch=async(url,init={})=>{const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;state.calls.push({path,body});
 if(path==='/auth/v1/token')return Response.json({access_token:'synthetic',refresh_token:'refresh',expires_in:3600,user:{id:uid,email:'person@example.org'}});
 if(path==='/rest/v1/memberships')return Response.json([{role:state.role,permissions:state.permissions,active:true,export_level:'low'}]);
 if(path==='/rest/v1/rpc/request_animal_sheet_import'){if(state.wait)await state.wait;return Response.json({job_id:'job',status:'queued'})}
 if(path==='/rest/v1/rpc/get_animal_sheet_import_status'){if(state.wait)await state.wait;return Response.json({configured:true,enabled:true,status:'ready'})}
 if(path==='/rest/v1/rpc/get_animal_sheet_import_conflicts')return Response.json({conflicts:[],total:0,next_offset:null});
 throw Error('Unexpected route '+path);
 };return state;
}
await test('manual source refresh requires fresh import and housing access; viewers can read status',async()=>{
 for(const [role,permissions]of [['viewer',{}],['manager',{imports:false,housing:true}],['manager',{imports:true,housing:false}]]){const s=fixture(role,permissions);await store.signIn('person@example.org','password');await assert.rejects(store.startAnimalSheetImport(),/Import and housing/);assert(!s.calls.some(c=>c.path.includes('request_animal_sheet_import')));assert.equal((await store.getAnimalSheetImportStatus()).status,'ready');}
 const s=fixture('manager',{imports:true,housing:true});await store.signIn('person@example.org','password');assert.equal((await store.startAnimalSheetImport()).status,'queued');assert.deepEqual(s.calls.at(-1).body,{p_colony_id:colony});assert(!JSON.stringify(s.calls).includes('sync_secret'));
});
await test('conflict pagination is bounded and never requests a different colony',async()=>{
 const s=fixture();await store.signIn('person@example.org','password');assert.equal((await store.getAnimalSheetImportConflicts({offset:10,limit:20})).total,0);assert.deepEqual(s.calls.at(-1).body,{p_colony_id:colony,p_offset:10,p_limit:20});
 for(const args of [{offset:-1},{limit:201},{limit:0},{offset:0.5}])await assert.rejects(store.getAnimalSheetImportConflicts(args),/valid conflict/);
});
await test('late import responses cannot cross a project or colony change',async()=>{
 for(const action of ['startAnimalSheetImport','getAnimalSheetImportStatus']){const s=fixture();await store.signIn('person@example.org','password');let release;s.wait=new Promise(r=>release=r);const pending=store[action]();while(!s.calls.some(c=>c.path.includes(action==='startAnimalSheetImport'?'request_animal_sheet_import':'get_animal_sheet_import_status')))await new Promise(r=>setTimeout(r,0));store.configureCloud({url:'https://other.supabase.co',anonKey,colonyId:other});release();await assert.rejects(pending,/account changed/);}
});
