import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDataset } from '../web/model.js';
import * as store from '../web/data-store.js';

// An isolated browser/cache and transactional RPC fixture. No live service is used.
class Storage {
  values=new Map();
  getItem(key){return this.values.get(key)??null;}
  setItem(key,value){this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
  clear(){this.values.clear();}
}
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
const savedLocal=new Map(),removed=Symbol('removed');
const db={close(){},objectStoreNames:{contains:()=>true},transaction(){
  const tx={},changes=new Map();let pending=0,scheduled=false,active=true;
  tx.abort=()=>{active=false;queueMicrotask(()=>tx.onabort?.());};
  function operation(fn){const request={};pending++;queueMicrotask(()=>{
    if(!active)return;request.result=structuredClone(fn());request.onsuccess?.();pending--;
    if(!pending&&!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;if(!active||pending)return;
      for(const [key,value] of changes)value===removed?savedLocal.delete(key):savedLocal.set(key,value);
      active=false;tx.oncomplete?.();});}
  });return request;}
  tx.objectStore=()=>({get:key=>operation(()=>changes.has(key)?changes.get(key)===removed?undefined:changes.get(key):savedLocal.get(key)),put:(value,key)=>operation(()=>{changes.set(key,structuredClone(value));return key;}),delete:key=>operation(()=>{changes.set(key,removed);})});
  return tx;
}};
globalThis.indexedDB={open(){const request={};queueMicrotask(()=>{request.result=db;request.onsuccess?.();});return request;}};
const colony='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222';
const visibility={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
const data=()=>normalizeDataset({source_archive_restricted:true,source_projection_version:2,tables:{
  mice:[{mouse_sid:'M1',state:'Stock',cage_sid:'C1',cage_tag:'A1'},{mouse_sid:'M2',state:'Stock',cage_sid:'C2',cage_tag:'A2'}],
  cages:[{cage_sid:'C1',state:'Active',cage_tag:'A1'},{cage_sid:'C2',state:'Active',cage_tag:'A2'}],
}});
async function fixture(){
  localStorage.clear();sessionStorage.clear();savedLocal.clear();
  const server={records:new Map(),batches:[],beforeResponse:null};
  for(const [type,rows] of Object.entries(data().tables))for(const payload of rows){
    const entity_id=payload[type==='mice'?'mouse_sid':'cage_sid'];
    server.records.set(`${type}:${entity_id}`,{colony_id:colony,entity_type:type,entity_id,payload,version:1,archived:false});
  }
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(url),body=init.body?JSON.parse(init.body):null;
    if(u.pathname==='/auth/v1/token')return Response.json({access_token:'synthetic',refresh_token:'synthetic-refresh',expires_in:3600,user:{id:user,email:'test@example.invalid'}});
    if(u.pathname==='/rest/v1/memberships')return Response.json([{role:'editor',active:true}]);
    if(u.pathname==='/rest/v1/rpc/get_lac_fee_visibility')return Response.json(visibility);
    if(['/rest/v1/rpc/get_lac_fee_records','/rest/v1/rpc/get_managed_locations'].includes(u.pathname))return Response.json({visibility,rows:[],next_offset:null});
    if(u.pathname==='/rest/v1/entity_records'){
      const type=u.searchParams.get('entity_type')?.slice(3),id=u.searchParams.get('entity_id');
      const rows=[...server.records.values()].filter(r=>r.entity_type===type&&(!id||id.startsWith('eq.')&&r.entity_id===id.slice(3)||id.startsWith('gt.')&&r.entity_id>id.slice(3))).sort((a,b)=>a.entity_id.localeCompare(b.entity_id)).slice(0,Number(u.searchParams.get('limit'))||1000);
      return Response.json(u.searchParams.get('select').includes('payload')?rows:rows.map(({payload,...row})=>row));
    }
    if(u.pathname==='/rest/v1/rpc/save_records'){
      const next=new Map(server.records),rows=[];server.batches.push(body.p_changes);
      for(const change of body.p_changes){const key=`${change.entity_type}:${change.entity_id}`,old=next.get(key);
        if((old?.version??0)!==change.expected_version)return Response.json({code:'40001',message:'Version conflict'},{status:409});
        const unchanged=old&&JSON.stringify(old.payload)===JSON.stringify(change.payload)&&old.archived===change.archived;
        const row=unchanged?old:{...change,colony_id:colony,version:(old?.version??0)+1};delete row.expected_version;next.set(key,row);rows.push(row);
      }
      server.records=next;await server.beforeResponse?.(rows);return Response.json(rows);
    }
    throw new Error('Unexpected fixture route '+u.pathname);
  };
  store.configureCloud({url:'https://test.supabase.co',anonKey:'x.'+btoa(JSON.stringify({role:'anon'}))+'.x',colonyId:colony});
  await store.signIn('test@example.invalid','synthetic-password');
  await store.pullFromCloud();const initial=await store.pullFromCloud();return {server,initial};
}

test('overlapping disjoint cloud saves cannot overwrite a newer cache or silently undo another save',async()=>{
  const {server,initial}=await fixture(),one=structuredClone(initial),two=structuredClone(initial);
  one.tables.mice[0].comment='First explicit edit';two.tables.mice[1].comment='Second explicit edit';
  let release,entered;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let held=false;
  server.beforeResponse=async()=>{if(!held){held=true;entered();await gate;}};
  const first=store.saveDataset(one);await waiting;
  const second=store.saveDataset(two),settled=Promise.allSettled([first,second]);await new Promise(resolve=>setImmediate(resolve));release();
  const outcomes=await settled;assert.equal(outcomes[0].status,'fulfilled');
  assert.equal(server.records.get('mice:M1').payload.comment,'First explicit edit','a queued stale whole dataset must not undo the first edit');
  const local=await store.loadDataset();
  for(const mouse of local.tables.mice)assert.deepEqual(mouse,server.records.get('mice:'+mouse.mouse_sid).payload,'the local baseline must represent every confirmed cloud save');
  if(outcomes[1].status==='fulfilled')assert.equal(local.tables.mice[1].comment,'Second explicit edit');
});

test('mouse notes and light colors round-trip through incremental cloud saves',async()=>{
  const {server,initial}=await fixture(),next=structuredClone(initial);
  next.tables.mice[0].comment='Tail discoloration, check at next cage change.';
  next.tables.mice[0].note_color='red';
  await store.saveDataset(next);
  assert.equal(server.batches.length,1);
  assert.deepEqual(server.batches[0].map(r=>`${r.entity_type}:${r.entity_id}`),['mice:M1']);
  assert.equal(server.batches[0][0].expected_version,1);
  const refreshed=await store.pullFromCloud(),mouse=refreshed.tables.mice.find(r=>r.mouse_sid==='M1');
  assert.equal(mouse.comment,next.tables.mice[0].comment);
  assert.equal(mouse.note_color,'red');
  assert.equal(mouse.cage_sid,'C1');
  assert.equal(refreshed.tables.husbandry_events.length,0);
  const colorOnly=structuredClone(refreshed);
  colorOnly.tables.mice.find(r=>r.mouse_sid==='M1').note_color='none';
  await store.saveDataset(colorOnly);
  assert.deepEqual(server.batches[1].map(r=>`${r.entity_type}:${r.entity_id}`),['mice:M1']);
  assert.equal(server.records.get('mice:M1').payload.comment,mouse.comment);
  assert.equal(server.records.get('mice:M1').payload.note_color,'none');
});

test('unchanged destination guards share one transaction with the mouse and history event',async()=>{
  const {server,initial}=await fixture(),next=structuredClone(initial);
  next.tables.mice[0].cage_sid='C2';next.tables.mice[0].cage_tag='A2';
  next.tables.husbandry_events.push({event_id:'MOVE1',event_type:'cage_assignment',event_date:'2026-10-16',mouse_sid:'M1',old_cage_sid:'C1',cage_sid:'C2'});
  await store.saveDataset(next,{readDependencies:[{type:'cages',id:'C1'},{type:'cages',id:'C2'},{type:'cages',id:'C2'}]});
  assert.equal(server.batches.length,1);assert.deepEqual(server.batches[0].map(r=>`${r.entity_type}:${r.entity_id}`).sort(),['cages:C1','cages:C2','husbandry_events:MOVE1','mice:M1']);
  assert.equal(server.records.get('cages:C2').version,1,'an unchanged guard must not rewrite the cage');
  assert.equal(server.records.get('mice:M1').version,2);assert.equal(server.records.get('husbandry_events:MOVE1').version,1);
});

test('a target changed after the fresh read rejects mouse and history together',async()=>{
  const {server,initial}=await fixture(),next=structuredClone(initial),target=server.records.get('cages:C2');
  next.tables.mice[0].cage_sid='C2';next.tables.husbandry_events.push({event_id:'MOVE1',event_type:'cage_assignment',event_date:'2026-10-16',mouse_sid:'M1',old_cage_sid:'C1',cage_sid:'C2'});
  target.payload={...target.payload,state:'Ended'};target.version++;
  await assert.rejects(store.saveDataset(next,{readDependencies:[{type:'cages',id:'C2'}]}),/changed in another session|Version conflict|not confirmed/);
  assert.equal(server.records.get('mice:M1').payload.cage_sid,'C1');assert.equal(server.records.has('husbandry_events:MOVE1'),false);
  assert.equal((await store.loadDataset()).tables.mice[0].cage_sid,'C1');
});

test('dependency IDs are strict and must belong to the verified existing snapshot',async()=>{
  const {server,initial}=await fixture();
  for(const readDependencies of [null,{},[{type:'archive',id:'reconstruction'}],[{type:'cages',id:' C2'}],[{type:'cages',id:'C2',version:1}],[{type:'cages',id:'unknown'}]])await assert.rejects(store.saveDataset(initial,{readDependencies}),/dependenc/);
  assert.equal(server.batches.length,0);
  await store.saveDataset(initial,{readDependencies:[{type:'cages',id:'C2'}]});assert.equal(server.batches.length,1,'validation failures must release the save guard');
});
