import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizeDataset,createSyntheticDataset,validateRecord,ID_FIELDS} from '../web/model.js';
import {encodeArchive,decodeArchive,canonicalStringify,MAX_ARCHIVE_PAYLOAD_BYTES,MAX_RPC_BYTES,utf8Size,isArchiveChunk,partitionChanges} from '../web/archive-format.js';
import * as store from '../web/data-store.js';
import {buildCryoActivity} from '../web/cryopreservation-model.js';

class Storage { values=new Map();getItem(k){return this.values.get(k)??null;}setItem(k,v){this.values.set(k,String(v));}removeItem(k){this.values.delete(k);}clear(){this.values.clear();} }
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
const idbData=new Map();
const db={objectStoreNames:{contains:()=>true},transaction(){const tx={};tx.objectStore=()=>({get:k=>run(()=>idbData.get(k)),put:(v,k)=>run(()=>{idbData.set(k,structuredClone(v));return k;}),delete:k=>run(()=>idbData.delete(k))});function run(fn){const request={};queueMicrotask(()=>{request.result=structuredClone(fn());request.onsuccess?.();tx.oncomplete?.();});return request;}return tx;}};
globalThis.indexedDB={open(){const request={};queueMicrotask(()=>{request.result=db;request.onsuccess?.();});return request;}};
const cid='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222';
const jwt=role=>`x.${btoa(JSON.stringify({role}))}.x`;
let server;
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});}
function configure(){store.configureCloud({url:'https://test.supabase.co',anonKey:jwt('anon'),colonyId:cid});}
function callbackPage(hash=''){
  globalThis.location=new URL(`https://colony.example.test/app/${hash}`);
  globalThis.history={state:null,replaceState(_state,_title,url){globalThis.location=new URL(url,globalThis.location);}};
}
function callbackToken(overrides={}){return `x.${btoa(JSON.stringify({iss:'https://test.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',sub:uid,exp:Math.floor(Date.now()/1000)+3600,...overrides}))}.x`;}
function callbackHash(token=callbackToken(),type='magiclink'){return '#'+new URLSearchParams({access_token:token,refresh_token:'synthetic-refresh',token_type:'bearer',type}).toString();}
function installServer(){
  server={records:new Map(),objects:new Map(),role:'owner',active:true,calls:[],refreshes:0,deny:false,expires:3600,failBatch:null,batches:0};
  globalThis.fetch=async(url,options={})=>{
    server.calls.push({url,options});const u=new URL(url);const body=options.body?JSON.parse(options.body):null;
    if(u.pathname.endsWith('/token')){
      if(u.searchParams.get('grant_type')==='refresh_token')server.refreshes++;
      return response({access_token:'access',refresh_token:'refresh',expires_in:server.expires,user:{id:uid,email:'demo@example.test'}});
    }
    if(u.pathname.endsWith('/otp'))return server.otpDenied?response({message:'Email request rate limit exceeded'},429):response({});
    if(u.pathname.endsWith('/verify'))return body.token==='123456'?response({access_token:'access',refresh_token:'refresh',expires_in:3600,user:{id:uid,email:body.email}}):response({message:'Token has expired or is invalid'},403);
    if(u.pathname.endsWith('/auth/v1/user')){
      if(options.method==='PUT'&&body?.data){
        if(server.profileNetworkFailure)throw new TypeError('Network unavailable');
        if(server.profileStatus)return response(server.profileReply,server.profileStatus);
        return response(server.profileReply??{id:server.authUser??uid,email:'demo@example.test',user_metadata:{...server.userMetadata,...body.data},is_anonymous:false});
      }
      if(options.method==='PUT'&&server.passwordNetworkFailure)throw new TypeError('Network unavailable');
      if(options.method==='PUT'&&server.passwordStatus)return response(server.passwordReply,server.passwordStatus);
      return server.authRejected?response({message:'invalid token'},401):response({id:server.authUser??uid,email:'demo@example.test',is_anonymous:false});
    }
    if(u.pathname.endsWith('/logout'))return response({});
    if(server.deny)return response({message:'denied',code:'42501'},403);
    if(u.pathname.endsWith('/memberships'))return response([{role:server.role,active:server.active}]);
    if(u.pathname.endsWith('/rpc/get_export_permission')||u.pathname.endsWith('/rpc/assert_full_export_permission')){
      server.exportPermissionReads=(server.exportPermissionReads||0)+1;
      if(server.onExportPermission)server.onExportPermission(server.exportPermissionReads);
      if(!server.active||server.exportPermissionError)return response({code:'42501',message:'Active export membership required'},403);
      const level=server.exportLevel||'max';
      if(u.pathname.endsWith('/assert_full_export_permission')&&level!=='max')return response({code:'42501',message:'Max required'},403);
      return response({level,as_of_date:'2026-10-14',cutoff_date:level==='max'?null:level==='low'?'2023-10-14':'2020-10-14',full_history:level==='max'});
    }
    if(u.pathname.endsWith('/rpc/export_records')){
      if(server.exportResponse)return response(await server.exportResponse(body));
      const level=server.exportLevel||'max';
      return response({rows:[],next_offset:null,export_level:level,cutoff_date:level==='max'?null:level==='low'?'2023-10-14':'2020-10-14',as_of_date:'2026-10-14',snapshot_revision:'42',from_date:body.p_from_date,to_date:body.p_to_date,scope:body.p_scope,excluded_undated:2});
    }
    if(u.pathname.endsWith('/functions/v1/manage-colony-users')){
      if(server.managementNetworkFailure)throw new TypeError('Network unavailable');
      if(server.managementStatus)return response(server.managementReply,server.managementStatus);
      if(server.managementReply)return response(server.managementReply);
      if(body.action==='list')return response({colony_id:cid,users:[{user_id:uid,email:'demo@example.test',name:'Demo Owner',role:'owner',active:true,status:'active'}]});
      const user={user_id:body.user_id??'33333333-3333-4333-8333-333333333333',email:body.email??'colleague@example.test',role:body.role,active:body.active??true,status:body.action==='invite'?'invited':'active'};
      return response({user,message:body.action==='invite'?'Invitation sent.':'Access updated.',...(body.action==='invite'?{email_sent:true}:{})});
    }
    if(u.pathname.includes('/storage/v1/')){
      const prefix='/storage/v1/object/';
      if(u.pathname.includes('/object/list/'))return response([...server.objects.keys()].filter(p=>p.startsWith(`${body.prefix}/`)).reverse().slice(body.offset,body.offset+body.limit).map(p=>({name:p.split('/').at(-1)})));
      const authenticated=u.pathname.includes('/object/authenticated/'),path=u.pathname.slice((authenticated?`${prefix}authenticated/colony-history/`:`${prefix}colony-history/`).length);
      if(options.method==='POST'){
        if(server.role==='viewer')return response({message:'forbidden'},403);
        if(server.objects.has(path))return response({message:'The resource already exists'},409);
        server.objects.set(path,options.body);return response({Key:path});
      }
      if(!server.objects.has(path))return response({message:'Not found'},404);
      return new Response(server.objects.get(path),{headers:{'Content-Type':'application/json'}});
    }
    if(u.pathname.endsWith('/entity_records')){
      const type=u.searchParams.get('entity_type');
      const all=[...server.records.values()].filter(r=>type==='eq.archive'?r.entity_type==='archive':type==='neq.archive'?r.entity_type!=='archive':true).sort((a,b)=>`${a.entity_type}:${a.entity_id}`.localeCompare(`${b.entity_type}:${b.entity_id}`));
      const offset=Number(u.searchParams.get('offset')??0);return response(all.slice(offset,offset+Number(u.searchParams.get('limit')??1000)));
    }
    if(u.pathname.endsWith('/rpc/save_records')){
      server.batches++;if(server.failBatch===server.batches)throw new TypeError('Network unavailable');
      if(server.role==='viewer')return response({message:'forbidden',code:'42501'},403);
      const next=new Map(server.records),saved=[];
      for(const change of body.p_changes){const k=`${change.entity_type}:${change.entity_id}`,old=next.get(k);if((old?.version??0)!==change.expected_version)return response({code:'40001',message:'stale'},409);const row={...change,colony_id:cid,version:(old?.version??0)+1};delete row.expected_version;next.set(k,row);saved.push(row);}
      server.records=next;return response(saved);
    }
    if(u.pathname.endsWith('/audit_log'))return response([]);
    throw new Error(`Unexpected mocked HTTP route: ${url}`);
  };
}
async function fresh(){localStorage.clear();sessionStorage.clear();idbData.clear();installServer();await store.clearDataset();configure();}
async function connected(data=createSyntheticDataset()){await fresh();await store.saveDataset(data,{localOnly:true});await store.signIn('demo@example.test','test-password');await store.pushToCloud(data);return store.loadDataset();}
async function privateFixture(context,name){
  try{return JSON.parse(await readFile(new URL(`../../outputs/reconstruction_2026-10-14/${name}`,import.meta.url),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;context.skip('Private source fixture is not part of the public repository.');return null;}
}

test('identifiers preserve leading zeros; duplicates and provenance changes are rejected',()=>{
  const d=createSyntheticDataset();const draft={...d.tables.mice[0],mouse_sid:'0007',source_record_id:'import:1',manager:'Demo caretaker'};
  assert.deepEqual(validateRecord('mice',draft,d).errors,[]);
  d.tables.mice.push(draft);
  assert.match(validateRecord('mice',{...draft,comment:'note'},d).errors.join(' '),/already exists/);
  assert.match(validateRecord('mice',{...draft,source_record_id:'changed'},d,'0007').errors.join(' '),/provenance/);
  assert.equal(normalizeDataset(d).tables.mice.at(-1).mouse_sid,'0007');
});
test('existing imported anomalies remain reviewable, while new anomalies and sex side-effects fail',()=>{
  const d=createSyntheticDataset();d.tables.mice[0].procedure_date='1969-12-31';
  const retained=validateRecord('mice',{...d.tables.mice[0],comment:'reviewed'},d,'SYN-M001');
  assert.equal(retained.errors.length,0);assert(retained.warnings.some(w=>w.includes('precedes birth')));
  const invalid=validateRecord('mice',{...d.tables.mice[0],procedure_date:'2026-02-30'},d,'SYN-M001');assert(invalid.errors.some(x=>x.includes('valid')));
  const sex=validateRecord('mice',{...d.tables.mice[0],sex:'Female'},d,'SYN-M001');assert(sex.errors.some(x=>x.includes('sire')));
});
test('possible ancestry cycles and unknown parents fail; multiple known dams remain ambiguous',()=>{
  const d=createSyntheticDataset();const m=d.tables.mice[0];
  assert(validateRecord('mice',{...m,sire_sids:['SYN-M003']},d,m.mouse_sid).errors.some(x=>x.includes('cycle')));
  assert(validateRecord('mice',{...m,sire_sids:['missing']},d,m.mouse_sid).errors.some(x=>x.includes('does not exist')));
  d.tables.mice.push({...d.tables.mice[1],mouse_sid:'SYN-M004'});
  const child={...d.tables.mice[2],dam_sids:['SYN-M002','SYN-M004']};const result=validateRecord('mice',child,d,child.mouse_sid);
  assert.equal(result.errors.length,0);assert(result.warnings.some(x=>x.includes('candidates')));
});
test('mating member normalization seeds missing arrays once and respects later edits',()=>{
  const d=createSyntheticDataset();delete d.tables.matings[0].male_sids;d.tables.mating_members=[{mating_sid:'SYN-B1',mouse_sid:'SYN-M001',recorded_role:'male_member'}];
  const n=normalizeDataset(d);assert.deepEqual(n.tables.matings[0].male_sids,['SYN-M001']);n.tables.matings[0].male_sids=[];assert.deepEqual(normalizeDataset(n).tables.matings[0].male_sids,[]);
});
test('public-key configuration rejects service and secret keys without storing them',async()=>{
  await fresh();const before=localStorage.getItem('mouse-colony.cloud.v1');
  for(const anonKey of [jwt('service_role'),'sb_secret_forbidden'])assert.throws(()=>store.configureCloud({url:'https://test.supabase.co',colonyId:cid,anonKey}),/public|service|Secret/);
  assert.equal(localStorage.getItem('mouse-colony.cloud.v1'),before);
});
test('email-code sign-in requests existing users only, verifies membership and stores no code',async()=>{
  await fresh();await store.requestEmailCode('demo@example.test');
  assert.equal(JSON.parse(server.calls.find(c=>c.url.endsWith('/otp')).options.body).create_user,false);
  assert.equal(store.getCloudStatus().signedIn,false);assert.equal(store.getCloudStatus().pendingEmail,'demo@example.test');
  await assert.rejects(store.verifyEmailCode('demo@example.test','654321'),/permission|expired|invalid/);
  await store.verifyEmailCode('demo@example.test','123456');assert.equal(store.getCloudStatus().role,'owner');assert.equal(store.getCloudStatus().pendingEmail,null);
  assert(!JSON.stringify([...sessionStorage.values]).includes('123456'));assert.equal(localStorage.getItem('mouse-colony.session.v1'),null);
  await store.signOut();server.deny=true;await assert.rejects(store.verifyEmailCode('demo@example.test','123456'),/permission/);assert.equal(store.getCloudStatus().signedIn,false);
  server.deny=false;server.otpDenied=true;await assert.rejects(store.requestEmailCode('demo@example.test'),/rate limit/);
});
test('email-link requests existing users with an exact same-origin redirect',async()=>{
  await fresh();callbackPage();
  await store.requestEmailLink('demo@example.test','https://colony.example.test/app/');
  const call=server.calls.find(c=>new URL(c.url).pathname.endsWith('/otp'));
  assert.equal(new URL(call.url).searchParams.get('redirect_to'),'https://colony.example.test/app/');
  assert.equal(JSON.parse(call.options.body).create_user,false);assert.equal(store.getCloudStatus().signedIn,false);
  const count=server.calls.length;
  for(const url of ['https://other.example.test/','https://colony.example.test/app/#token','https://colony.example.test/app/?token=secret'])await assert.rejects(store.requestEmailLink('demo@example.test',url),/return to this app/);
  assert.equal(server.calls.length,count);
});
test('magic-link and invitation callbacks clear the fragment before verification and persist only authorized membership',async()=>{
  for(const type of ['magiclink','invite','recovery']){
    await fresh();callbackPage(callbackHash(callbackToken(),type));
    const originalFetch=fetch;globalThis.fetch=async(...args)=>{assert.equal(location.hash,'');assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),null);return originalFetch(...args);};
    const status=await store.consumeAuthCallback();assert.equal(status.signedIn,true);assert.equal(status.role,'owner');assert.equal(status.needsPasswordSetup,type==='invite'||type==='recovery');
    assert.equal(JSON.parse(sessionStorage.getItem('mouse-colony.session.v1')).user.id,uid);assert.equal(localStorage.getItem('mouse-colony.session.v1'),null);
    assert.equal(Object.hasOwn(JSON.parse(sessionStorage.getItem('mouse-colony.session.v1')),'needsPasswordSetup'),false);
    assert(server.calls.some(c=>c.url.endsWith('/auth/v1/user')));assert(server.calls.some(c=>c.url.includes('/memberships?')));
    assert.equal(await store.consumeAuthCallback(),null);
  }
});
test('callback rejects foreign projects, expired tokens, invalid users and forbidden memberships without retaining credentials',async()=>{
  const cases=[{claims:{iss:'https://foreign.supabase.co/auth/v1'},pattern:/different cloud/},{claims:{exp:1},pattern:/expired/},{authRejected:true,pattern:/rejected/},{authUser:cid,pattern:/verify this account/},{deny:true,pattern:/membership/},{role:'none',pattern:/not an active member/},{active:false,pattern:/not an active member/}];
  for(const scenario of cases){
    await fresh();Object.assign(server,scenario);callbackPage(callbackHash(callbackToken(scenario.claims)));
    await assert.rejects(store.consumeAuthCallback(),scenario.pattern);assert.equal(location.hash,'');assert.equal(store.getCloudStatus().signedIn,false);assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),null);
    if(scenario.claims)assert.equal(server.calls.length,0);
  }
  await fresh();callbackPage('#error=access_denied&error_description=DO_NOT_ECHO_THIS_TOKEN');
  await assert.rejects(store.consumeAuthCallback(),error=>/invalid or has expired/.test(error.message)&&!error.message.includes('DO_NOT_ECHO'));assert.equal(location.hash,'');assert.equal(server.calls.length,0);
  callbackPage('#record=00001');assert.equal(await store.consumeAuthCallback(),null);assert.equal(location.hash,'#record=00001');
});
test('initial cloud upload is idempotent and preserves complete non-managed archive data',async()=>{
  const d=createSyntheticDataset();d.extra_metadata={keep:'all'};d.tables.custom_scientific_notes=[{text:'unknown schema preserved'}];
  const loaded=await connected(d);assert.deepEqual(loaded.extra_metadata,d.extra_metadata);assert.deepEqual(loaded.tables.custom_scientific_notes,d.tables.custom_scientific_notes);
  const before=server.batches;await store.pushToCloud(d);assert.equal(server.batches,before);assert.equal(store.getCloudStatus().mode,'cloud');
  assert.equal(localStorage.getItem('mouse-colony.session.v1'),null);assert(sessionStorage.getItem('mouse-colony.session.v1'));
});
test('atomic multi-record conflict leaves local and all other cloud records unchanged',async()=>{
  const before=await connected();const changed=structuredClone(before);changed.tables.mice[0].comment='new first';changed.tables.mice[1].comment='new second';
  const stale=server.records.get('mice:SYN-M002');stale.version++;stale.payload.comment='external edit';
  await assert.rejects(store.saveDataset(changed),/changed in another session/);
  assert.equal(server.records.get('mice:SYN-M001').payload.comment,undefined);assert.deepEqual(await store.loadDataset(),before);
  await assert.rejects(store.saveDataset(changed),/Pull the latest/);
});
test('viewer and network failures never save cloud edits locally; import resets local mode',async()=>{
  const before=await connected(),changed=structuredClone(before);changed.tables.mice[0].comment='not saved';server.role='viewer';
  await assert.rejects(store.saveDataset(changed),/viewer/);assert.deepEqual(await store.loadDataset(),before);
  server.role='owner';server.deny=true;await assert.rejects(store.saveDataset(changed),/permission/);assert.deepEqual(await store.loadDataset(),before);
  server.deny=false;server.failBatch=server.batches+1;await assert.rejects(store.saveDataset(changed),/not confirmed/);assert.deepEqual(await store.loadDataset(),before);
  await store.saveDataset(changed,{localOnly:true});assert.equal(store.getCloudStatus().mode,'local');assert.equal((await store.loadDataset()).tables.mice[0].comment,'not saved');
});
test('archive transitions use version checks and payload flags; hard deletion is rejected',async()=>{
  const d=await connected();d.tables.mice[0].app_archived_at='2026-10-14T00:00:00Z';await store.saveDataset(d);
  assert.equal(server.records.get('mice:SYN-M001').archived,true);assert.equal(server.records.get('mice:SYN-M001').version,2);
  delete d.tables.mice[0].app_archived_at;await store.saveDataset(d);assert.equal(server.records.get('mice:SYN-M001').archived,false);
  d.tables.mice.shift();await assert.rejects(store.saveDataset(d),/Archive records instead/);
});
test('paginated pull includes more than 1000 mice, batch upload caps at 200, refresh occurs',async()=>{
  await fresh();server.expires=-1;await store.signIn('demo@example.test','test-password');server.expires=3600;
  const d=createSyntheticDataset();d.tables.mice=Array.from({length:2101},(_,i)=>({mouse_sid:`SYN-${String(i).padStart(5,'0')}`,sex:'Unknown',sire_sids:[],dam_sids:[]}));
  await store.pushToCloud(d);assert.equal((await store.loadDataset()).tables.mice.length,2101);assert(server.refreshes>=1);
  const batches=server.calls.filter(c=>c.url.endsWith('/rpc/save_records')).map(c=>JSON.parse(c.options.body).p_changes.length);assert(batches.every(n=>n<=200));
  assert(server.calls.some(c=>c.url.includes('offset=2000')));
});
test('different existing cloud payload blocks initial upload before any overwrite',async()=>{
  const d=await connected(),count=server.batches;d.tables.mice[0].comment='different import';
  await assert.rejects(store.pushToCloud(d),/already contains different data/);assert.equal(server.batches,count);
});
test('location hierarchy and light schedules validate without invented defaults',()=>{
  const d=createSyntheticDataset();d.tables.rooms=[{room_id:'R001'}];d.tables.racks=[{rack_id:'K001',room_id:'R001'}];d.tables.locations=[{location_id:'L001',room_id:'R001',rack_id:'K001'}];
  const light={event_id:'E001',location_id:'L001',start_date:'2026-10-14',cycle_hours:24,light_hours:12,lights_on:'07:00',lights_off:'19:00'};
  assert.deepEqual(validateRecord('light_events',light,d).errors,[]);
  assert(validateRecord('light_events',{...light,cycle_hours:0,light_hours:25,lights_on:'25:00'},d).errors.length>=3);
  assert(validateRecord('light_events',{...light,location_id:'missing'},d).errors.some(x=>x.includes('does not exist')));
  const unknown={event_id:'E002',location_id:'L001',protocol:'Reported schedule, timings unknown'};
  assert.equal(validateRecord('light_events',unknown,d).errors.length,0);assert.equal(normalizeDataset({...d,tables:{...d.tables,light_events:[unknown]}}).tables.light_events[0].cycle_hours,undefined);
  assert(validateRecord('husbandry_events',{event_id:'H001',event_date:'2026-02-30',mouse_sid:'missing'},d).errors.length>=2);
});
test('new managed room and husbandry entities round-trip separately from archive',async()=>{
  const d=createSyntheticDataset();d.tables.rooms=[{room_id:'0001',label:'Synthetic room'}];d.tables.husbandry_events=[{event_id:'H001',mouse_sid:'SYN-M001',event_date:'2026-10-14',event_type:'Observation'}];
  await connected(d);assert(server.records.has('rooms:0001'));assert(server.records.has('husbandry_events:H001'));
  assert.equal(server.records.get('archive:reconstruction').payload.tables.rooms,undefined);assert.equal((await store.loadDataset()).tables.rooms[0].room_id,'0001');
});
test('interrupted initial upload keeps the local import and retries identical batches idempotently',async()=>{
  await fresh();const d=createSyntheticDataset();d.tables.mice=Array.from({length:405},(_,i)=>({mouse_sid:`PART-${i}`,sex:'Unknown',sire_sids:[],dam_sids:[]}));
  await store.saveDataset(d,{localOnly:true});const original=await store.loadDataset();await store.signIn('demo@example.test','test-password');server.failBatch=2;
  await assert.rejects(store.pushToCloud(d),/confirmed 200 records/);assert.equal(server.records.size,200);assert.deepEqual(await store.loadDataset(),original);
  await assert.rejects(store.pullFromCloud(),/manifest is missing/);assert.deepEqual(await store.loadDataset(),original);
  server.failBatch=null;await store.pushToCloud(d);assert.equal((await store.loadDataset()).tables.mice.length,405);assert([...server.records.values()].every(r=>r.version===1));
});
test('private history upload is immutable, verified, idempotent and discoverable without local locator',async()=>{
  await fresh();await store.signIn('demo@example.test','test-password');
  const index={sources:[{id:'synthetic'}],sheets:[],cells:[['0001','A1','literal']]};
  const metadata=await store.uploadHistoryIndex(index);assert.match(metadata.path,new RegExp(`^${cid}/history/[a-f0-9]{64}\\.json$`));
  assert.equal(server.objects.size,1);await store.uploadHistoryIndex(index);assert.equal(server.objects.size,1);
  const config=JSON.parse(localStorage.getItem('mouse-colony.cloud.v1'));delete config.historyPath;localStorage.setItem('mouse-colony.cloud.v1',JSON.stringify(config));
  assert.deepEqual(await store.downloadHistoryIndex(),index);assert.equal(store.getCloudStatus().historyPath,metadata.path);
  for(const c of server.calls.filter(c=>c.url.includes('/storage/v1/'))){assert.equal(c.options.cache,'no-store');assert.equal(c.options.headers.Authorization,'Bearer access');assert.equal(c.options.headers['x-upsert'],undefined);assert(!c.url.includes('/public/'));}
});
test('private history rejects unsigned access, cross-colony paths, tampered bytes and viewer uploads',async()=>{
  await fresh();const path=`${cid}/history/${'a'.repeat(64)}.json`;
  await assert.rejects(store.fetchHistoryArchive(path),/signed-in|Sign in/);
  await store.signIn('demo@example.test','test-password');
  await assert.rejects(store.fetchHistoryArchive(path.replace(cid,uid)),/configured colony/);
  server.objects.set(path,JSON.stringify({sources:[],sheets:[],cells:[]}));
  await assert.rejects(store.fetchHistoryArchive(path),/checksum/);
  server.role='viewer';const before=server.objects.size;await assert.rejects(store.uploadHistoryIndex({sources:[],sheets:[],cells:[]}),/viewer/);assert.equal(server.objects.size,before);
  server.deny=true;await assert.rejects(store.downloadHistoryIndex(),/permission/);
});
test('synthetic scale dataset preserves archive history through bounded uploads and paginated pulls',async()=>{
  const d=createSyntheticDataset();
  d.tables.mice.push(...Array.from({length:6101},(_,i)=>({mouse_sid:`SYN-SCALE-${String(i).padStart(6,'0')}`,sex:'Unknown',sire_sids:[],dam_sids:[],genotype:null})));
  d.tables.historical_observations=Array.from({length:1200},(_,i)=>({observation_id:`SYN-OBS-${i}`,source_cell:`A${i+1}`,raw_text:'Synthetic light schedule α; '.repeat(40),unknown:null,measured:i%2?0:false}));
  const expected=normalizeDataset(d),loaded=await connected(d);
  for(const [type,id] of Object.entries(ID_FIELDS)){const sort=(a,b)=>a[id].localeCompare(b[id]);expected.tables[type].sort(sort);loaded.tables[type].sort(sort);}
  assert.deepEqual(loaded,expected);
  const archives=[...server.records.values()].filter(r=>r.entity_type==='archive');
  assert(archives.length>3);assert(archives.every(r=>utf8Size(r.payload)<=MAX_ARCHIVE_PAYLOAD_BYTES));
  const writes=server.calls.filter(c=>c.url.endsWith('/rpc/save_records'));assert(writes.every(c=>Buffer.byteLength(c.options.body)<=MAX_RPC_BYTES));
  assert(server.calls.some(c=>c.url.includes('offset=6000')));
  assert(server.calls.some(c=>c.url.includes('entity_type=eq.archive')&&c.url.includes('offset=3')));
});
test('complete reconstructed dataset plus augmented history round-trips all records through paginated cloud storage',async context=>{
  const d=await privateFixture(context,'dataset.json');if(!d)return;
  d.tables.historical_observations=Array.from({length:1007},(_,i)=>({source_cell:`A${i+1}`,value:i%2?null:'=literal'}));
  d.historical_import={sources:[{source_id:'synthetic-archive',sha256:'a'.repeat(64)}],unresolved:['00001']};
  const expected=normalizeDataset(d),loaded=await connected(d);
  for(const [type,id] of Object.entries(ID_FIELDS)){
    const order=(a,b)=>a[id].localeCompare(b[id]);
    expected.tables[type].sort(order);loaded.tables[type].sort(order);
  }
  assert.deepEqual(loaded,expected);
  const archive=await decodeArchive([...server.records.values()]);assert.deepEqual(archive.tables.historical_observations,d.tables.historical_observations);
  assert.deepEqual(archive.historical_import,d.historical_import);assert.deepEqual(archive.tables.parent_observations,d.tables.parent_observations);
  assert(server.calls.some(c=>c.url.includes('offset=6000')));
  const index={sources:d.historical_import.sources,sheets:[{name:'synthetic'}],cells:Array.from({length:1007},(_,i)=>[0,0,`A${i+1}`,String(i).padStart(5,'0')])};
  await store.uploadHistoryIndex(index);assert.deepEqual(await store.downloadHistoryIndex(),index);
});
test('archive chunks are byte bounded, stable under key reordering, and reject missing or corrupted chunks',async()=>{
  const d=createSyntheticDataset();d.tables.history=Array.from({length:301},(_,i)=>({id:`000${i}`,note:'生物'.repeat(300)}));
  const encoded=await encodeArchive(d),chunks=encoded.filter(isArchiveChunk);
  assert(chunks.length>1);assert(encoded.every(r=>utf8Size(r.payload)<=MAX_ARCHIVE_PAYLOAD_BYTES));
  assert.deepEqual((await decodeArchive(encoded)).tables.history,d.tables.history);
  const reordered=structuredClone(d);reordered.tables.history=reordered.tables.history.map(r=>({note:r.note,id:r.id}));
  assert.deepEqual((await encodeArchive(reordered)).map(r=>r.entity_id),encoded.map(r=>r.entity_id));
  await assert.rejects(decodeArchive(encoded.filter(r=>r!==chunks[0])),/Missing/);
  const corrupt=structuredClone(encoded);corrupt.find(isArchiveChunk).payload.rows[0].note='tampered';await assert.rejects(decodeArchive(corrupt),/checksum/);
  const batches=partitionChanges(encoded.map(r=>({...r,expected_version:0})));
  assert(batches.every(p_changes=>utf8Size({p_colony_id:cid,p_changes})<=MAX_RPC_BYTES));
});
test('legacy archive is readable and migrates safely on the first ordinary edit',async()=>{
  const d=await connected();const manifest=server.records.get('archive:reconstruction');
  manifest.payload=await decodeArchive([...server.records.values()]);
  for(const [k,r] of server.records)if(isArchiveChunk(r))server.records.delete(k);
  const before=await store.pullFromCloud();before.tables.mice[0].comment='legacy edit';await store.saveDataset(before);
  assert.equal(server.records.get('archive:reconstruction').payload.archive_format,'colony-archive-manifest-v1');
  assert.equal((await store.pullFromCloud()).tables.mice[0].comment,'legacy edit');
});
test('failed manifest commit keeps previous history authoritative and ordinary edits skip unchanged chunks',async()=>{
  const d=createSyntheticDataset();d.tables.history=[{text:'original'}];const before=await connected(d);
  const edit=structuredClone(before);edit.tables.mice[0].comment='ordinary edit';const start=server.calls.length;await store.saveDataset(edit);
  const ordinary=server.calls.slice(start).filter(c=>c.url.endsWith('/rpc/save_records')).flatMap(c=>JSON.parse(c.options.body).p_changes);assert(!ordinary.some(isArchiveChunk));
  const changed=structuredClone(edit);changed.tables.history=[{text:'new staged content'}];server.failBatch=server.batches+2;
  await assert.rejects(store.saveDataset(changed),/not confirmed/);assert.deepEqual((await store.loadDataset()).tables.history,d.tables.history);
  assert.deepEqual((await decodeArchive([...server.records.values()])).tables.history,d.tables.history);
  assert.equal(store.getCloudStatus().readyForEdits,false);
});
test('real augmented dataset round-trips with bounded archive payloads, RPCs and archive pages',async context=>{
  const d=await privateFixture(context,'dataset_augmented.json');if(!d)return;
  const expected=normalizeDataset(d),loaded=await connected(d);
  for(const [type,id] of Object.entries(ID_FIELDS)){const sort=(a,b)=>a[id].localeCompare(b[id]);expected.tables[type].sort(sort);loaded.tables[type].sort(sort);}
  const hash=value=>createHash('sha256').update(canonicalStringify(value)).digest('hex');
  assert.equal(hash(loaded),hash(expected));
  const archives=[...server.records.values()].filter(r=>r.entity_type==='archive');assert(archives.length>1);assert(archives.every(r=>utf8Size(r.payload)<=MAX_ARCHIVE_PAYLOAD_BYTES));
  const writes=server.calls.filter(c=>c.url.endsWith('/rpc/save_records'));assert(writes.every(c=>Buffer.byteLength(c.options.body)<=MAX_RPC_BYTES));
  assert(server.calls.filter(c=>c.url.includes('entity_type=eq.archive')).every(c=>new URL(c.url).searchParams.get('limit')==='3'));
  assert.equal(loaded.tables.historical_observations.length,d.tables.historical_observations.length);
});

test('owner user-management uses the configured project and refreshed authentication without storing invitations',async()=>{
  await fresh();server.expires=-1;await store.signIn('demo@example.test','test-password');server.expires=3600;
  const beforeRefresh=server.refreshes;
  const listing=await store.manageColonyUsers('list');assert.equal(listing.users[0].role,'owner');assert(server.refreshes>beforeRefresh);
  const invited=await store.manageColonyUsers('invite',{email:' colleague@example.test ',role:'editor'});
  assert.equal(invited.email_sent,true);assert.equal(invited.user.role,'editor');
  const updated=await store.manageColonyUsers('update_access',{user_id:invited.user.user_id,role:'viewer',active:false});assert.equal(updated.user.active,false);
  const calls=server.calls.filter(c=>c.url.includes('/functions/v1/'));
  assert.equal(calls.length,3);
  for(const {url,options}of calls){assert.equal(url,'https://test.supabase.co/functions/v1/manage-colony-users');assert.equal(options.method,'POST');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer access');assert.equal(options.headers.apikey,jwt('anon'));assert.equal(JSON.parse(options.body).colony_id,cid);}
  assert.deepEqual(JSON.parse(calls[1].options.body),{email:'colleague@example.test',role:'editor',action:'invite',colony_id:cid});
  assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('colleague@example.test'));
});
test('user-management rejects unsigned, nonowner, inactive and revoked membership before Edge invocation',async()=>{
  await fresh();localStorage.clear();await assert.rejects(store.manageColonyUsers('list'),/Configure/);configure();
  await assert.rejects(store.manageColonyUsers('list'),/Sign in/);
  for(const role of ['editor','viewer']){server.role=role;await store.signIn('demo@example.test','test-password');await assert.rejects(store.manageColonyUsers('list'),/Only an active colony owner/);}
  server.role='owner';await store.signIn('demo@example.test','test-password');server.active=false;
  await assert.rejects(store.manageColonyUsers('list'),/not an active member/);
  server.active=true;server.role='editor';await assert.rejects(store.manageColonyUsers('list'),/Only an active colony owner/);
  assert.equal(server.calls.filter(c=>c.url.includes('/functions/v1/')).length,0);
});
test('user-management rejects action, colony, redirect and role injection, invalid targets and self edits',async()=>{
  await fresh();await store.signIn('demo@example.test','test-password');
  const target='33333333-3333-4333-8333-333333333333';
  const bad=[['delete',{}],['list',{colony_id:target}],['invite',{email:'a@example.test',role:'viewer',redirect_to:'https://outside.example.test'}],['invite',{email:'a@example.test',role:'owner'}],['invite',{email:'invalid',role:'viewer'}],['update_access',{user_id:uid,role:'editor',active:true}],['update_access',{user_id:'wrong',role:'viewer',active:false}],['update_access',{user_id:target,role:'viewer',active:'false'}],['list',[]]];
  for(const [action,payload]of bad)await assert.rejects(store.manageColonyUsers(action,payload));
  assert.equal(server.calls.filter(c=>c.url.includes('/functions/v1/')).length,0);
});
test('user-management preserves backend delivery status and partial-invitation errors without retrying',async()=>{
  await fresh();await store.signIn('demo@example.test','test-password');
  server.managementReply={user:{user_id:'33333333-3333-4333-8333-333333333333',role:'viewer',active:true},email_sent:false,message:'Existing account access updated; no invitation email sent.'};
  assert.equal((await store.manageColonyUsers('invite',{email:'colleague@example.test',role:'viewer'})).email_sent,false);
  server.managementReply={code:'membership_failed',message:'Invitation sent, but colony access was not saved. Check the user list before retrying.',invitation_sent:true};
  for(const status of [500,403]){server.managementStatus=status;await assert.rejects(store.manageColonyUsers('invite',{email:'colleague@example.test',role:'viewer'}),error=>error.code==='membership_failed'&&error.invitationSent===true&&error.message===server.managementReply.message);}
  server.managementStatus=403;server.managementReply={message:'Owner access required.'};await assert.rejects(store.manageColonyUsers('list'),/permission/);
  server.managementStatus=null;server.managementNetworkFailure=true;const before=server.calls.length;
  await assert.rejects(store.manageColonyUsers('list'),/not confirmed/);
  assert.equal(server.calls.slice(before).filter(c=>c.url.includes('/functions/v1/')).length,1);
});

test('account password update uses authenticated PUT, preserves spaces, and never persists the password',async()=>{
  await fresh();await store.signIn('demo@example.test','test-password');
  const beforeLocal=JSON.stringify([...localStorage.values]),beforeSession=JSON.stringify([...sessionStorage.values]);
  const password=' Synthetic account password 42! ';
  const result=await store.updateAccountPassword(password);
  assert.deepEqual(result,{user_id:uid,message:'Account password updated.'});
  const call=server.calls.find(c=>c.url.endsWith('/auth/v1/user')&&c.options.method==='PUT');
  assert.equal(call.url,'https://test.supabase.co/auth/v1/user');assert.equal(call.options.headers.Authorization,'Bearer access');assert.equal(call.options.headers.apikey,jwt('anon'));assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');assert.deepEqual(JSON.parse(call.options.body),{password});
  assert.equal(JSON.stringify([...localStorage.values]),beforeLocal);assert.equal(JSON.stringify([...sessionStorage.values]),beforeSession);
  assert(!JSON.stringify(await store.loadDataset()).includes(password));assert(!JSON.stringify(result).includes(password));
});
test('account password update rejects unsigned, inactive members and invalid lengths before Auth mutation',async()=>{
  await fresh();localStorage.clear();await assert.rejects(store.updateAccountPassword('synthetic-password'),/Configure/);configure();
  await assert.rejects(store.updateAccountPassword('synthetic-password'),/Sign in/);
  await store.signIn('demo@example.test','test-password');
  for(const password of [null,123,'short','x'.repeat(129)])await assert.rejects(store.updateAccountPassword(password),/12 and 128/);
  server.active=false;await assert.rejects(store.updateAccountPassword('synthetic-password'),/not an active member/);
  assert.equal(server.calls.filter(c=>c.url.endsWith('/auth/v1/user')&&c.options.method==='PUT').length,0);
});
test('active viewers can update only their own password and Auth rejection or uncertainty is not success',async()=>{
  await fresh();server.role='viewer';await store.signIn('demo@example.test','test-password');
  await store.updateAccountPassword('synthetic-password');
  server.passwordStatus=422;server.passwordReply={message:'Rejected credential: synthetic-password'};
  await assert.rejects(store.updateAccountPassword('synthetic-password'),error=>/different/.test(error.message)&&!error.message.includes('synthetic-password'));
  server.passwordStatus=401;server.passwordReply={message:'expired'};await assert.rejects(store.updateAccountPassword('synthetic-password'),/Sign in again/);
  server.passwordStatus=null;server.authUser=cid;await assert.rejects(store.updateAccountPassword('synthetic-password'),/did not confirm/);
  server.authUser=uid;server.passwordNetworkFailure=true;const before=server.calls.length;
  await assert.rejects(store.updateAccountPassword('synthetic-password'),/not confirmed/);
  assert.equal(server.calls.slice(before).filter(c=>c.url.endsWith('/auth/v1/user')&&c.options.method==='PUT').length,1);
  assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('synthetic-password'));
});

test('account profile sends only full_name metadata and persists verified returned user with other metadata intact',async()=>{
  await fresh();await store.signIn('demo@example.test','test-password');server.userMetadata={laboratory:'Synthetic lab',full_name:'Old Name'};
  assert.equal(store.getCloudStatus().name,null);const localBefore=JSON.stringify([...localStorage.values]);
  const result=await store.updateAccountProfile('  New Name  ');assert.deepEqual(result,{user_id:uid,name:'New Name',message:'Account profile updated.'});
  const call=server.calls.find(c=>c.url.endsWith('/auth/v1/user')&&c.options.method==='PUT');
  assert.deepEqual(JSON.parse(call.options.body),{data:{full_name:'New Name'}});assert.equal(call.options.headers.Authorization,'Bearer access');assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');
  const session=JSON.parse(sessionStorage.getItem('mouse-colony.session.v1'));
  assert.deepEqual(session.user.user_metadata,{laboratory:'Synthetic lab',full_name:'New Name'});assert.equal(session.access_token,'access');assert.equal(session.role,'owner');assert.equal(store.getCloudStatus().name,'New Name');assert.equal(JSON.stringify([...localStorage.values]),localBefore);
});
test('account profile rejects unsigned/inactive users and bad names, leaving session unchanged after invalid server confirmation',async()=>{
  await fresh();await assert.rejects(store.updateAccountProfile('Name'),/Sign in/);await store.signIn('demo@example.test','test-password');
  for(const name of [null,{},'', '  ','x'.repeat(121)])await assert.rejects(store.updateAccountProfile(name),/1 and 120/);
  server.active=false;await assert.rejects(store.updateAccountProfile('Name'),/not an active member/);server.active=true;
  assert.equal(server.calls.filter(c=>c.url.endsWith('/auth/v1/user')&&c.options.method==='PUT').length,0);
  const before=sessionStorage.getItem('mouse-colony.session.v1');
  server.authUser=cid;await assert.rejects(store.updateAccountProfile('Name'),/did not confirm/);assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),before);
  server.authUser=uid;server.profileReply={id:uid,user_metadata:{full_name:'Wrong Name'}};await assert.rejects(store.updateAccountProfile('Name'),/did not confirm/);assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),before);
  server.profileStatus=403;server.profileReply={message:'Rejected'};await assert.rejects(store.updateAccountProfile('Name'),/permission/);assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),before);
});
test('active viewers may edit their own name but a sign-out during the request cannot resurrect their session',async()=>{
  await fresh();server.role='viewer';await store.signIn('demo@example.test','test-password');await store.updateAccountProfile('Viewer Name');assert.equal(store.getCloudStatus().name,'Viewer Name');assert.equal(store.getCloudStatus().role,'viewer');
  const original=fetch;globalThis.fetch=async(url,options)=>{const result=await original(url,options);if(url.endsWith('/auth/v1/user')&&options.method==='PUT')sessionStorage.clear();return result;};
  await assert.rejects(store.updateAccountProfile('New Viewer Name'),/account changed/);assert.equal(store.getCloudStatus().signedIn,false);
});


test('structured genotypes and saved breeding plans round-trip as versioned managed records',async()=>{
  const d=createSyntheticDataset();await connected(d);
  const next=await store.loadDataset(),mouse=next.tables.mice[0];
  const locus={id:'test-driver',name:'Synthetic driver',kind:'cre',chromosome:'unknown',alleles:['+','Cre']};
  mouse.genetic_profile={schema_version:1,loci:[locus],calls:{'test-driver':{alleles:['Cre','+'],evidence:'confirmed'}},notes:'Synthetic confirmation'};
  const scenario={loci:[locus],sire:{id:mouse.mouse_sid,sex:'Male',calls:structuredClone(mouse.genetic_profile.calls)},dam:{id:'SYN-M002',sex:'Female',calls:{'test-driver':{alleles:['+','+'],evidence:'confirmed'}}},targets:{'test-driver':{mode:'carrier',allele:'Cre'}},independentAssortment:true,sex:'Any',desiredCount:2,confidence:0.95,litterSize:6};
  const plan={event_id:'PLAN-SYNTHETIC',event_type:'breeding_plan',event_date:'2026-10-14',record_origin:'app_created',breeding_plan:{schema_version:1,name:'Synthetic plan',scenario}};
  next.tables.husbandry_events.push(plan);await store.saveDataset(next);
  const pulled=await store.pullFromCloud();assert.deepEqual(pulled.tables.mice[0].genetic_profile,mouse.genetic_profile);assert.deepEqual(pulled.tables.husbandry_events.find(r=>r.event_id===plan.event_id),plan);
  assert.equal(server.records.get('mice:SYN-M001').version,2);assert(server.records.has('husbandry_events:PLAN-SYNTHETIC'));
  assert.deepEqual(pulled.tables.matings,d.tables.matings);assert.equal(pulled.tables.mice.length,d.tables.mice.length);assert.equal(pulled.tables.mice[0].genotype,d.tables.mice[0].genotype);
  const stale=structuredClone(pulled);stale.tables.mice[0].genetic_profile.notes='Conflicting edit';server.records.get('mice:SYN-M001').version++;
  await assert.rejects(store.saveDataset(stale),/changed in another session/);assert.equal((await store.loadDataset()).tables.mice[0].genetic_profile.notes,'Synthetic confirmation');
});

test('cryopreservation balance and activity save atomically and a stale withdrawal creates no event',async()=>{
  const d=createSyntheticDataset(),lot={event_id:'CRYO-TEST',event_type:'cryopreservation_lot',record_origin:'app_created',cryopreservation:{schema_version:1,label:'Synthetic cryo lot',case_id:'TEST',batch_ids:['TEST-A','TEST-B'],material:'unknown',status:'unreviewed',manager:null,storage_location:{},donor_mouse_sids:[],frozen_date:'2025-01-01',quantity:null,quantity_unit:'straws',quantity_as_of_date:null,activity_revision:0,last_activity_id:null}};
  d.tables.husbandry_events.push(lot);await connected(d);
  const first=await store.loadDataset(),pair=buildCryoActivity(first.tables.husbandry_events.find(r=>r.event_id===lot.event_id),{activity_type:'stocktake',event_date:'2026-10-14',quantity:10,quantity_unit:'straws',notes:'Synthetic stocktake'},first);
  const next=structuredClone(first);next.tables.husbandry_events=next.tables.husbandry_events.map(r=>r.event_id===lot.event_id?pair.lot:r);next.tables.husbandry_events.push(pair.event);
  const before=server.calls.length;await store.saveDataset(next);
  const writes=server.calls.slice(before).filter(c=>c.url.endsWith('/rpc/save_records'));
  assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].options.body).p_changes.filter(r=>r.entity_type==='husbandry_events').map(r=>r.entity_id).sort(),[pair.lot.event_id,pair.event.event_id].sort());
  const pulled=await store.pullFromCloud();assert.equal(pulled.tables.husbandry_events.find(r=>r.event_id===lot.event_id).cryopreservation.quantity,10);assert.equal(pulled.tables.mice.length,d.tables.mice.length);
  const stalePair=buildCryoActivity(pulled.tables.husbandry_events.find(r=>r.event_id===lot.event_id),{activity_type:'use',event_date:'2026-10-14',quantity:1,quantity_unit:'straws'},pulled),stale=structuredClone(pulled);
  stale.tables.husbandry_events=stale.tables.husbandry_events.map(r=>r.event_id===lot.event_id?stalePair.lot:r);stale.tables.husbandry_events.push(stalePair.event);
  server.records.get('husbandry_events:CRYO-TEST').version++;
  await assert.rejects(store.saveDataset(stale),/changed in another session/);
  assert(!server.records.has('husbandry_events:'+stalePair.event.event_id));assert.equal(server.records.get('husbandry_events:CRYO-TEST').payload.cryopreservation.quantity,10);
  assert.equal((await store.loadDataset()).tables.husbandry_events.find(r=>r.event_id===lot.event_id).cryopreservation.quantity,10);
});

test('export date bounds use fresh server Low3 and High6 permission without changing local data',async()=>{
  const d=createSyntheticDataset();await connected(d);server.exportLevel='low';server.role='viewer';
  const before=await store.loadDataset();
  const result=await store.getExportRecords({scope:'history',entityTypes:['husbandry_events']});
  assert.equal(result.metadata.cutoff_date,'2023-10-14');assert.equal(result.metadata.excluded_undated,2);
  const body=JSON.parse(server.calls.find(c=>c.url.endsWith('/rpc/export_records')).options.body);
  assert.equal(body.p_from_date,'2023-10-14');assert.equal(body.p_to_date,'2026-10-14');assert.deepEqual(body.p_entity_types,['husbandry_events']);
  assert.deepEqual(await store.loadDataset(),before);
  await assert.rejects(store.getExportRecords({scope:'history',fromDate:'2023-10-13'}),/exceeds/);
  server.exportLevel='high';assert.equal((await store.getExportPermission()).cutoff_date,'2020-10-14');
  server.active=false;await assert.rejects(store.getExportPermission(),/permission/);
});

test('paginated exports reject mixed revisions or changed permissions before a file is returned',async()=>{
  await connected(createSyntheticDataset());server.exportLevel='low';
  server.exportResponse=body=>({rows:[{entity_type:'mice',entity_id:'EXP-'+body.p_offset,record_date:'2026-01-01',payload:{mouse_sid:'EXP-'+body.p_offset,state:'Stock',date_of_birth:'2020-01-01'}}],next_offset:body.p_offset?null:1,export_level:'low',cutoff_date:'2023-10-14',as_of_date:'2026-10-14',snapshot_revision:body.p_offset?'43':'42'});
  await assert.rejects(store.getExportRecords(),/changed while exporting/);
  server.exportResponse=()=>({rows:[],next_offset:null,export_level:'low',cutoff_date:'2023-10-14',as_of_date:'2026-10-14',snapshot_revision:'42'});
  server.exportPermissionReads=0;server.onExportPermission=n=>{if(n===2)server.exportLevel='high';};
  await assert.rejects(store.getExportRecords(),/permission changed/);
});

test('Max backups recheck permission after reading and signed-out real workspaces cannot fall back to local export',async()=>{
  const d=createSyntheticDataset();delete d.demo;delete d.synthetic;delete d.is_demo;await connected(d);
  server.exportLevel='low';await assert.rejects(store.getFullExportBackup(),/permission/);
  server.exportLevel='max';server.exportPermissionReads=0;server.onExportPermission=n=>{if(n===2)server.exportLevel='low';};
  await assert.rejects(store.getFullExportBackup(),/permission/);
  server.onExportPermission=null;await store.signOut();await assert.rejects(store.getExportPermission(),/Sign in/);
});

test('server current housing exports preserve old DOB and add explicit record date without pulling archives',async()=>{
  await connected(createSyntheticDataset());server.exportLevel='low';
  server.exportResponse=()=>({rows:[{entity_type:'mice',entity_id:'EXP-OLD',record_date:'2020-01-01',payload:{mouse_sid:'EXP-OLD',state:'Stock',date_of_birth:'2020-01-01'}}],next_offset:null,export_level:'low',cutoff_date:'2023-10-14',as_of_date:'2026-10-14',snapshot_revision:'42'});
  const start=server.calls.length,result=await store.getExportRecords({scope:'current_housing'});
  assert.equal(result.dataset.tables.mice[0].date_of_birth,'2020-01-01');assert.equal(result.dataset.tables.mice[0].export_record_date,'2020-01-01');
  assert(!server.calls.slice(start).some(c=>c.url.includes('/entity_records')));
  const body=JSON.parse(server.calls.slice(start).find(c=>c.url.endsWith('/rpc/export_records')).options.body);assert.equal(body.p_from_date,null);assert.equal(body.p_to_date,null);
});

test('exports reject account or colony changes during initial and final authorization',async()=>{
  for(const method of [()=>store.getExportRecords(),()=>store.getFullExportBackup()]){
    for(const read of [1,2]){
      await connected(createSyntheticDataset());
      server.onExportPermission=n=>{if(n===read){const key='mouse-colony.session.v1',s=JSON.parse(sessionStorage.getItem(key));s.user.id='33333333-3333-4333-8333-333333333333';sessionStorage.setItem(key,JSON.stringify(s));}};
      await assert.rejects(method(),/account or colony changed/);
    }
  }
});

test('imported demo flags do not authorize a configured colony but explicit built-in demo does',async()=>{
  await fresh();const data=createSyntheticDataset();data.demo=true;data.synthetic=true;data.is_demo=true;
  await store.saveDataset(data,{localOnly:true});await assert.rejects(store.getExportPermission(),/Sign in/);
  await store.saveDataset(data,{localOnly:true,localKind:'demo'});assert.equal((await store.getExportPermission()).local,true);
  await store.saveDataset(data,{localOnly:true});await assert.rejects(store.getExportPermission(),/Sign in/);
});

test('local current snapshots exclude historical animals and events while Max history retains undated records',async()=>{
  await fresh();const data=createSyntheticDataset();
  data.tables.mice.push({mouse_sid:'HISTORICAL',state:'Dead',date_of_birth:'2010-01-01'});
  data.tables.husbandry_events.push({event_id:'UNDATED',event_type:'note'});
  data.tables.locations.push({location_id:'POSITION-EMPTY',row:1,column:1});data.tables.cages.push({cage_sid:'INACTIVE-POSITIONED',state:'Inactive',location_id:'POSITION-EMPTY'});
  data.tables.light_events.push({event_id:'OLD-LIGHT',start_date:'2010-01-01',end_date:'2011-01-01'});
  await store.saveDataset(data,{localOnly:true,localKind:'demo'});
  const current=await store.getExportRecords();assert(current.dataset.tables.cages.some(r=>r.cage_sid==='INACTIVE-POSITIONED'));assert.equal(current.metadata.from_date,null);assert.equal(current.metadata.to_date,null);assert(!Number.isNaN(Date.parse(current.metadata.captured_at)));
  assert(current.dataset.tables.mice.every(m=>m.state==='Stock'));assert.equal(current.dataset.tables.husbandry_events.length,0);assert(!current.dataset.tables.light_events.some(r=>r.event_id==='OLD-LIGHT'));
  const history=await store.getExportRecords({scope:'history',toDate:(await store.getExportPermission()).as_of_date});assert(history.dataset.tables.husbandry_events.some(r=>r.event_id==='UNDATED'));
});

test('trusted demo cannot export a retained real source archive with Low permission',async()=>{
  await connected(createSyntheticDataset());server.exportLevel='low';await store.saveDataset(createSyntheticDataset(),{localOnly:true,localKind:'demo'});
  let loaded=false;await assert.rejects(store.getFullSourceExport(async()=>{loaded=true;return {private:true};}),/permission/);assert.equal(loaded,false);
});
