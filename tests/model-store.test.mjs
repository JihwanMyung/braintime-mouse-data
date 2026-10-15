import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCageSummaryOptions, getCageSummaryOptions } from '../web/cage-summary-options.js';
import { buildBreedingOptions, getBreedingOptions } from '../web/breeding-options.js';
import { buildStrainDefinition, getStrainRegistry } from '../web/strain-registry.js';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizeDataset,createSyntheticDataset,validateRecord,ID_FIELDS} from '../web/model.js';
import {encodeArchive,decodeArchive,canonicalStringify,MAX_ARCHIVE_PAYLOAD_BYTES,MAX_RPC_BYTES,utf8Size,isArchiveChunk,partitionChanges} from '../web/archive-format.js';
import * as store from '../web/data-store.js';
import {buildCryoActivity} from '../web/cryopreservation-model.js';
import {saveHistoryIndex,loadHistoryIndex} from '../web/history-index.js';

class Storage { values=new Map();getItem(k){return this.values.get(k)??null;}setItem(k,v){this.values.set(k,String(v));}removeItem(k){this.values.delete(k);}clear(){this.values.clear();} }
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
const idbData=new Map();
const idbHooks={beforeCommit:null,afterCommit:null,afterRead:null},deleted=Symbol('deleted');
const db={close(){},objectStoreNames:{contains:()=>true},transaction(){
 const changes=new Map(),tx={};let state='active',pending=0,scheduled=false;
 tx.abort=()=>{if(state!=='active')throw Error('Transaction already finished');state='aborted';queueMicrotask(()=>tx.onabort?.());};
 tx.objectStore=()=>({get:k=>run(()=>changes.has(k)?changes.get(k)===deleted?undefined:changes.get(k):idbData.get(k)),put:(v,k)=>run(()=>{changes.set(k,structuredClone(v));return k;}),delete:k=>run(()=>{changes.set(k,deleted);})});
 function run(fn){const request={};pending++;queueMicrotask(()=>{if(state!=='active')return;request.result=structuredClone(fn());request.onsuccess?.();pending--;finish();});return request;}
 function finish(){if(pending||scheduled||state!=='active')return;scheduled=true;queueMicrotask(async()=>{scheduled=false;if(pending||state!=='active')return;if(changes.size&&idbHooks.beforeCommit)await idbHooks.beforeCommit(changes);if(state!=='active')return;for(const [k,v]of changes)v===deleted?idbData.delete(k):idbData.set(k,v);state='finished';if(changes.size&&idbHooks.afterCommit)await idbHooks.afterCommit(changes);if(!changes.size&&idbHooks.afterRead)await idbHooks.afterRead();tx.oncomplete?.();});}
 return tx;
}};
globalThis.indexedDB={open(){const request={};queueMicrotask(()=>{request.result=db;request.onsuccess?.();});return request;}};
const cid='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222';
const jwt=role=>`x.${btoa(JSON.stringify({role}))}.x`;
const locationKeys=new Set(['location_id','room_id','rack_id','label','row','column','capacity','locobox_id','active','state','manager','manager_acronym','notes','app_created_at','app_updated_at','app_archived_at','archived','record_origin','evidence_status','requires_review','source_current','source_last_seen_at','source_snapshot_date','source_label_conflict','source_manager_name','source_manager_acronym','source_manager_status','source_observed_mouse_sids','source_observed_cage_sids','source_candidate_mouse_sids','source_candidate_cage_sids','source_unresolved_explicit_mouse_sids','source_observed_tags']);
const projectLocation=row=>({...structuredClone(row),payload:Object.fromEntries(Object.entries(row.payload).filter(([key])=>locationKeys.has(key)))});
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
      else {if(server.passwordGrantNetworkFailure)throw new TypeError('Network unavailable');if(server.passwordGrantReply)return response(server.passwordGrantReply,server.passwordGrantStatus??200);}
      return response({access_token:'access',refresh_token:'refresh',expires_in:server.expires,user:{id:server.tokenUser??uid,email:'demo@example.test',email_confirmed_at:'2026-01-01T00:00:00Z'}});
    }
    if(u.pathname.endsWith('/functions/v1/username-sign-in'))return response(server.recoveryReply??{accepted:true,message:'Request accepted'},server.recoveryStatus??202);
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
    if(u.pathname.endsWith('/rpc/get_lac_fee_visibility')){server.feeReads=(server.feeReads||0)+1;if(server.onFeeRead)server.onFeeRead(server.feeReads);return response(server.feePolicy||{version:0,owner:server.role==='owner',estimate:true,actual:true,source_archive_allowed:true});}
    if(u.pathname.endsWith('/rpc/get_lac_fee_records'))return response({visibility:server.feePolicy,rows:server.feeRows||[],next_offset:null});
    if(u.pathname.endsWith('/rpc/get_managed_locations')){
      if(server.locationError)return response({code:'42501'},403);
      if(server.locationResponse)return response(await server.locationResponse(body));
      const rows=[...server.records.values()].filter(row=>row.entity_type==='locations').sort((a,b)=>a.entity_id.localeCompare(b.entity_id)).slice(body.p_offset,body.p_offset+body.p_limit).map(projectLocation);
      return response({visibility:server.feePolicy,rows,next_offset:rows.length===body.p_limit?body.p_offset+body.p_limit:null});
    }
    if(u.pathname.endsWith('/rpc/save_lac_fee_visibility')){if(server.role!=='owner')return response({code:'42501'},403);if(body.p_version!==(server.feePolicy?.version||0))return response({code:'40001'},409);server.feePolicy={version:body.p_version+1,owner:true,estimate:true,actual:true,source_archive_allowed:true,levels:body.p_levels};return response(server.feePolicy);}
    if(['/rpc/get_brainbot_status','/rpc/save_brainbot_settings','/rpc/run_brainbot','/rpc/review_brainbot_issue'].some(p=>u.pathname.endsWith(p))){if(server.onBrainbot)server.onBrainbot();return response(server.brainbotReply);}
    if(u.pathname.endsWith('/memberships'))return response(server.memberships??[{role:server.role,active:server.active}]);
    if(u.pathname.endsWith('/rpc/get_my_lab_member'))return response(server.myProfile??{eligible:false});
    if(u.pathname.endsWith('/rpc/get_export_permission')||u.pathname.endsWith('/rpc/assert_full_export_permission')||u.pathname.endsWith('/rpc/get_local_backup_permission')){
      server.exportPermissionReads=(server.exportPermissionReads||0)+1;
      if(server.onExportPermission)server.onExportPermission(server.exportPermissionReads);
      if(!server.active||server.exportPermissionError)return response({code:'42501',message:'Active export membership required'},403);
      const level=server.exportLevel||'max';
      if(u.pathname.endsWith('/assert_full_export_permission')&&level!=='max')return response({code:'42501',message:'Max required'},403);
      if(u.pathname.endsWith('/get_local_backup_permission')&&level==='low')return response({code:'42501',message:'High required'},403);
      return response({level,as_of_date:'2026-10-14',cutoff_date:level==='max'?null:level==='low'?'2023-10-14':'2020-10-14',full_history:level==='max'});
    }
    if(u.pathname.endsWith('/rpc/export_records')||u.pathname.endsWith('/rpc/export_local_backup_records')){
      if(u.pathname.endsWith('/rpc/export_local_backup_records')&&(!server.active||server.exportLevel==='low'))return response({code:'42501'},403);
      if(server.exportResponse)return response(await server.exportResponse(body));
      const level=server.exportLevel||'max';
      return response({rows:[],next_offset:null,export_level:level,cutoff_date:level==='max'?null:level==='low'?'2023-10-14':'2020-10-14',as_of_date:'2026-10-14',snapshot_revision:server.exportRevision||'42',fee_visibility:server.feePolicy||{version:0,owner:server.role==='owner',estimate:true,actual:true,source_archive_allowed:true},from_date:body.p_from_date,to_date:body.p_to_date,scope:body.p_scope,excluded_undated:2});
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
      const type=u.searchParams.get('entity_type'),after=u.searchParams.get('entity_id'),selected=after?.startsWith('in.(')?after.slice(4,-1).split(','):null;
      const all=[...server.records.values()].filter(r=>(type?.startsWith('eq.')?r.entity_type===type.slice(3):type==='neq.archive'?r.entity_type!=='archive':true)&&(!after||(selected?selected.includes(r.entity_id):after.startsWith('eq.')?r.entity_id===after.slice(3):r.entity_id.localeCompare(after.slice(3))>0))).sort((a,b)=>`${a.entity_type}:${a.entity_id}`.localeCompare(`${b.entity_type}:${b.entity_id}`));
      const offset=Number(u.searchParams.get('offset')??0),page=all.slice(offset,offset+Number(u.searchParams.get('limit')??1000));return response(u.searchParams.get('select')?.includes('payload')?page:page.map(({payload,...metadata})=>metadata));
    }
    if(u.pathname.endsWith('/rpc/save_records')){
      server.batches++;if(server.failBatch===server.batches)throw new TypeError('Network unavailable');
      if(server.role==='viewer')return response({message:'forbidden',code:'42501'},403);
      const next=new Map(server.records),saved=[];
      for(const change of body.p_changes){const k=`${change.entity_type}:${change.entity_id}`,old=next.get(k);if((old?.version??0)!==change.expected_version)return response({code:'40001',message:'stale'},409);const row={...change,colony_id:cid,version:(old?.version??0)+1};delete row.expected_version;if(server.feePolicy?.source_archive_allowed===false&&row.entity_type==='locations'){row.payload={...Object.fromEntries(Object.entries(old?.payload||{}).filter(([key])=>!locationKeys.has(key))),...row.payload};if(server.locationSaveTransform)row.payload=server.locationSaveTransform(row.payload);}next.set(k,row);saved.push(server.feePolicy?.source_archive_allowed===false&&row.entity_type==='locations'?projectLocation(row):row);}
      server.records=next;if(server.onSave)server.onSave(saved);return response(saved);
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
  server.role='owner';server.deny=true;await assert.rejects(store.saveDataset(changed),/permission/);await assert.rejects(store.loadDataset(),/permission/);assert.deepEqual(idbData.get('current'),before);
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
  assert(server.calls.some(c=>new URL(c.url).searchParams.get('entity_id')==='gt.SYN-01999'));
  assert(server.calls.filter(c=>new URL(c.url).pathname.endsWith('/entity_records')).every(c=>!new URL(c.url).searchParams.has('offset')));
});
test('cloud pull shrinks only timed-out read pages, keeps keyset cursors and preserves every archive and managed row',async()=>{
 const data=createSyntheticDataset();data.tables.mice=Array.from({length:645},(_,i)=>({mouse_sid:`READ-${String(i).padStart(4,'0')}`,sex:'Unknown',sire_sids:[],dam_sids:[]}));
 data.tables.source_history=Array.from({length:6},(_,i)=>({source_record_id:`history-${i}`,text:'archived evidence '.repeat(10000)}));
 await connected(data);const originalFetch=fetch,attempts=[],archiveSizes=[],batches=server.batches;
 globalThis.fetch=async(url,options)=>{const u=new URL(url);if(u.pathname.endsWith('/entity_records')){
  const limit=Number(u.searchParams.get('limit')),cursor=u.searchParams.get('entity_id');
  if(u.searchParams.get('entity_type')==='eq.mice'){
   attempts.push({cursor,limit});if(limit>(cursor===null?100:30))return response({code:'57014',message:'canceling statement due to statement timeout'},500);
  }else if(u.searchParams.get('entity_type')==='eq.archive'&&u.searchParams.get('select').includes('payload'))archiveSizes.push(limit);
 }return originalFetch(url,options);};
 const result=await store.pullFromCloud();
 assert.deepEqual(result.tables.mice.map(r=>r.mouse_sid),data.tables.mice.map(r=>r.mouse_sid));assert.deepEqual(result.tables.source_history,data.tables.source_history);
 assert.deepEqual(attempts.slice(0,8),[{cursor:null,limit:1000},{cursor:null,limit:500},{cursor:null,limit:250},{cursor:null,limit:125},{cursor:null,limit:62},{cursor:'gt.READ-0061',limit:62},{cursor:'gt.READ-0061',limit:31},{cursor:'gt.READ-0061',limit:15}]);
 assert(attempts.slice(8).every(row=>row.limit===15));assert(archiveSizes.length>1);assert(archiveSizes.every(size=>size>=1&&size<=3));assert.equal(server.batches,batches);assert.equal(store.getCloudStatus().readyForEdits,true);
});
test('exhausted statement-timeout retries stop at one row and preserve the previous cache after partial progress',async()=>{
 const data=createSyntheticDataset();data.tables.mice=Array.from({length:1005},(_,i)=>({mouse_sid:`KEEP-${String(i).padStart(4,'0')}`,sex:'Unknown',sire_sids:[],dam_sids:[]}));
 const before=await connected(data),mark=localStorage.getItem('mouse-colony.cloud-cache-context.v1'),originalFetch=fetch,attempts=[];
 globalThis.fetch=async(url,options)=>{const u=new URL(url);if(u.pathname.endsWith('/entity_records')&&u.searchParams.get('entity_type')==='eq.mice'){
  const cursor=u.searchParams.get('entity_id'),limit=Number(u.searchParams.get('limit'));attempts.push({cursor,limit});
  if(cursor!==null)return response({code:'57014',message:'canceling statement due to statement timeout'},500);
 }return originalFetch(url,options);};
 await assert.rejects(store.pullFromCloud(),/statement timeout/);
 assert.deepEqual(attempts,[{cursor:null,limit:1000},...[1000,500,250,125,62,31,15,7,3,1].map(limit=>({cursor:'gt.KEEP-0999',limit}))]);
 assert.deepEqual(idbData.get('current'),before);assert.equal(localStorage.getItem('mouse-colony.cloud-cache-context.v1'),mark);assert.equal(store.getCloudStatus().readyForEdits,false);
});
test('permission, network and other query cancellation failures are never retried',async()=>{
 for(const scenario of [{code:'57014',message:'canceling statement due to user request'},{message:'canceling statement due to statement timeout'},{code:'42501',message:'canceling statement due to statement timeout',status:403},{network:true}]){
  const before=await connected(),originalFetch=fetch;let attempts=0;
  globalThis.fetch=async(url,options)=>{if(new URL(url).pathname.endsWith('/entity_records')){attempts++;if(scenario.network)throw new TypeError('Network unavailable');return response(scenario,scenario.status||500);}return originalFetch(url,options);};
  await assert.rejects(store.pullFromCloud(),/canceling|permission|Network/);assert.equal(attempts,1);assert.deepEqual(idbData.get('current'),before);assert.equal(store.getCloudStatus().readyForEdits,false);
 }
});
test('the archive manifest timing out stops the pull without truncating the snapshot',async()=>{
 const before=await connected(),originalFetch=fetch;const attempts=[];
 globalThis.fetch=async(url,options)=>{const u=new URL(url);if(u.pathname.endsWith('/entity_records')&&u.searchParams.get('entity_type')==='eq.archive'){attempts.push(Number(u.searchParams.get('limit')));return response({code:'57014',message:'canceling statement due to statement timeout'},500);}return originalFetch(url,options);};
 await assert.rejects(store.pullFromCloud(),/statement timeout/);assert.deepEqual(attempts,[1]);assert.deepEqual(idbData.get('current'),before);assert.equal(store.getCloudStatus().readyForEdits,false);
});
test('account changes during a timed-out read prevent any retry with the changed session',async()=>{
 await connected();const originalFetch=fetch;let attempts=0;
 globalThis.fetch=async(url,options)=>{if(new URL(url).pathname.endsWith('/entity_records')){attempts++;await store.signOut();return response({code:'57014',message:'canceling statement due to statement timeout'},500);}return originalFetch(url,options);};
 await assert.rejects(store.pullFromCloud(),/account or colony changed/);assert.equal(attempts,1);assert.equal(store.getCloudStatus().signedIn,false);assert.equal(idbData.get('current'),undefined);
});
test('keyset cursor keeps punctuation and Unicode IDs literal without adding filters',async()=>{
 const data=createSyntheticDataset(),ids=['ID,colon:(x)"\\ & = 雪','ID.+%/é','ID)\"&entity_type=eq.archive','\tTAB','NBSP\u00a0','\u2003WIDE'];
 data.tables.mice=ids.map(mouse_sid=>({mouse_sid,sex:'Unknown',sire_sids:[],dam_sids:[]}));
 await connected(data);const originalFetch=fetch,queries=[];
 globalThis.fetch=async(url,options)=>{const u=new URL(url);if(u.pathname.endsWith('/entity_records')&&u.searchParams.get('entity_type')==='eq.mice'){
  if(Number(u.searchParams.get('limit'))>1)return response({code:'57014',message:'canceling statement due to statement timeout'},500);
  queries.push(u.searchParams);
 }return originalFetch(url,options);};
 const result=await store.pullFromCloud();assert.deepEqual(result.tables.mice.map(row=>row.mouse_sid).sort(),[...ids].sort());
 assert.deepEqual(new Set(queries.filter(q=>q.has('entity_id')).map(q=>q.get('entity_id').slice(3))),new Set(ids));
 for(const query of queries){assert.equal(query.get('entity_type'),'eq.mice');assert.equal(query.get('colony_id'),'eq.'+cid);assert.equal(query.get('order'),'entity_id.asc');assert(!query.has('offset'));assert(!query.has('and'));assert(!query.has('or'));assert.equal(query.getAll('entity_type').length,1);}
});
test('malformed, duplicate or unrelated cloud page records cannot replace a verified cache',async()=>{
 const cases=[
  rows=>({...rows[0],colony_id:uid}),rows=>({...rows[0],entity_type:'archive'}),rows=>({...rows[0],entity_type:'unsupported_type'}),rows=>({...rows[0],entity_id:''}),
  rows=>({...rows[0],version:0}),rows=>({...rows[0],archived:'false'}),rows=>({...rows[0],payload:[]}),
  rows=>({...rows[0],payload:{...rows[0].payload,mouse_sid:'DIFFERENT'}}),
 ];
 for(const change of cases){
  const before=await connected(),originalFetch=fetch;let attempts=0;
  globalThis.fetch=async(url,options)=>{const u=new URL(url),reply=await originalFetch(url,options);if(u.pathname.endsWith('/entity_records')&&u.searchParams.get('entity_type')==='eq.mice'){attempts++;const rows=await reply.json();return response([change(rows)]);}return reply;};
  await assert.rejects(store.pullFromCloud(),/invalid or unrelated record/);assert.equal(attempts,1);assert.deepEqual(idbData.get('current'),before);assert.equal(store.getCloudStatus().readyForEdits,false);
 }
 const before=await connected(),originalFetch=fetch;
 globalThis.fetch=async(url,options)=>{const u=new URL(url),reply=await originalFetch(url,options);if(u.pathname.endsWith('/entity_records')&&u.searchParams.get('entity_type')==='eq.mice'){const rows=await reply.json();return response([rows[0],rows[0]]);}return reply;};
 await assert.rejects(store.pullFromCloud(),/cursor did not advance/);assert.deepEqual(idbData.get('current'),before);
});
test('keyset record streams cover every entity type allowed by the maintained server schema',async()=>{
 const sql=await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8'),match=sql.match(/entity_type text not null check \(entity_type in \(([^)]+)\)\)/);
 assert(match);const serverTypes=[...match[1].matchAll(/'([^']+)'/g)].map(match=>match[1]);
 assert.deepEqual(serverTypes.sort(),[...Object.keys(ID_FIELDS),'archive'].sort());
});
test('a repeated keyset page fails without looping or publishing a partial cache',async()=>{
 const data=createSyntheticDataset();data.tables.mice=Array.from({length:1001},(_,i)=>({mouse_sid:`CURSOR-${String(i).padStart(4,'0')}`,sex:'Unknown',sire_sids:[],dam_sids:[]}));
 const before=await connected(data),originalFetch=fetch;let page,attempts=0;
 globalThis.fetch=async(url,options)=>{const u=new URL(url);if(u.pathname.endsWith('/entity_records')&&u.searchParams.get('entity_type')==='eq.mice'){
  attempts++;if(page)return response(page);const reply=await originalFetch(url,options);page=await reply.json();return response(page);
 }return originalFetch(url,options);};
 await assert.rejects(store.pullFromCloud(),/cursor did not advance/);assert.equal(attempts,2);assert.deepEqual(idbData.get('current'),before);assert.equal(store.getCloudStatus().readyForEdits,false);
});
test('pull progress contains only verified phase/count metadata and cannot interrupt the data read',async()=>{
 const before=await connected(),updates=[];
 const result=await store.pullFromCloud({onProgress:update=>{updates.push(update);assert(Object.isFrozen(update));assert.deepEqual(Object.keys(update).sort(),['archiveBlocksLoaded','phase','recordsLoaded']);throw Error('Detached progress view');}});
 assert.deepEqual(result,before);assert.equal(updates[0].phase,'access');assert.equal(updates.at(-1).phase,'saving');assert(updates.some(update=>update.phase==='verifying'));
 for(let i=1;i<updates.length;i++){assert(updates[i].recordsLoaded>=updates[i-1].recordsLoaded);assert(updates[i].archiveBlocksLoaded>=updates[i-1].archiveBlocksLoaded);}
 assert.equal(updates.at(-1).recordsLoaded,[...server.records.values()].filter(row=>row.entity_type!=='archive').length);assert.equal(updates.at(-1).archiveBlocksLoaded,[...server.records.values()].filter(row=>row.entity_type==='archive').length);
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
  assert(server.calls.filter(c=>new URL(c.url).searchParams.get('entity_type')==='eq.mice'&&new URL(c.url).searchParams.has('entity_id')).length>=6);
  assert(server.calls.some(c=>new URL(c.url).searchParams.get('entity_type')==='eq.archive'&&new URL(c.url).searchParams.has('entity_id')));
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
  assert(server.calls.some(c=>new URL(c.url).searchParams.get('entity_type')==='eq.mice'&&new URL(c.url).searchParams.has('entity_id')));
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
  assert(server.calls.filter(c=>c.url.includes('entity_type=eq.archive')&&new URL(c.url).searchParams.get('select').includes('payload')).every(c=>Number(new URL(c.url).searchParams.get('limit'))<=3));
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

test('experiment reports preserve animal and specimen associations without source or revision snapshots',async()=>{
  await fresh();const data=createSyntheticDataset(),longUrl='https://example.test/results/'+ 'a'.repeat(250);
  data.tables.husbandry_events=[
    {event_id:'EXP-REPORT',event_type:'experiment',event_date:'2025-02-01',source_rows:['PRIVATE SOURCE'],experiment:{schema_version:1,title:'Clock recording',assays:['LumiCycle','IMG'],status:'completed',participants:[{mouse_sid:'001',link_status:'confirmed',candidate_sids:[],notes:'PRIVATE NOTE'},{mouse_sid:null,raw_identifier:'OLD-01',link_status:'unresolved',candidate_sids:['002']}],sample_usages:[{sample_id:'SAMPLE-REPORT',amount:2,unit:'µL',disposition:'partial',notes:'PRIVATE NOTE'}],result_urls:[longUrl],notes:'PRIVATE NOTE'}},
    {event_id:'SAMPLE-REPORT',event_type:'experiment_sample',event_date:'2025-01-31',experiment_sample:{schema_version:1,label:'SCN aliquot',donors:[{mouse_sid:'001',link_status:'confirmed',candidate_sids:[]}],parent_sample_ids:[],pooled:false,tissue:'SCN',status:'stored',quantity:3,quantity_unit:'aliquots',quantity_as_of_date:'2025-02-01',storage:{temperature_c:-70,freezer:'F1',box:'B2',position:'A3',notes:'PRIVATE NOTE'},source_rows:['PRIVATE SOURCE'],notes:'PRIVATE NOTE'}},
    {event_id:'REV-REPORT',event_type:'experiment_revision',event_date:'2025-02-02',experiment_revision:{before:{notes:'PRIVATE HISTORY'},after:{notes:'PRIVATE HISTORY'}}}
  ];
  await store.saveDataset(data,{localOnly:true,localKind:'demo'});
  const result=await store.getExportRecords({scope:'history',fromDate:'2025-01-01',entityTypes:['husbandry_events']}),rows=result.dataset.tables.husbandry_events;
  const experiment=rows.find(r=>r.event_id==='EXP-REPORT').experiment,sample=rows.find(r=>r.event_id==='SAMPLE-REPORT').experiment_sample;
  assert.deepEqual(experiment.assays,['LumiCycle','IMG']);assert.equal(experiment.participants[0].mouse_sid,'001');assert.equal(experiment.participants[1].link_status,'unresolved');assert.deepEqual(experiment.participants[1].candidate_sids,['002']);assert.equal(experiment.sample_usages[0].sample_id,'SAMPLE-REPORT');assert.equal(experiment.result_urls[0],longUrl);
  assert.equal(sample.storage.temperature_c,-70);assert.equal(sample.storage.position,'A3');assert.equal(sample.donors[0].mouse_sid,'001');assert(!JSON.stringify(rows).includes('PRIVATE'));
  assert(!rows.find(r=>r.event_id==='REV-REPORT').experiment_revision);
  assert(JSON.stringify(await store.getFullExportBackup()).includes('PRIVATE HISTORY'),'Max backup retains full history');
});

test('experiment collection dates control exports; bounded link lists declare omissions',async()=>{
  await fresh();const data=createSyntheticDataset();
  data.tables.husbandry_events=[
    {event_id:'OLD-SAMPLE',event_type:'experiment_sample',event_date:'2001-01-01',app_modified_at:'2026-10-14',experiment_sample:{quantity_as_of_date:'2026-10-14',storage:{temperature_c:-70}}},
    {event_id:'UNDATED-EXPERIMENT',event_type:'experiment',event_date:null,source_snapshot_date:'2026-10-14',experiment:{title:'Undated',participants:[]}},
    {event_id:'MANY-LINKS',event_type:'experiment',event_date:'2025-01-01',experiment:{title:'Large study',participants:Array.from({length:101},(_,i)=>({mouse_sid:String(i),link_status:'confirmed',candidate_sids:[]})),sample_usages:[]}},
    {event_id:'CANDIDATES',event_type:'experiment_sample',event_date:'2025-01-01',experiment_sample:{donors:[{raw_identifier:'Repeated tag',link_status:'unresolved',candidate_sids:Array.from({length:101},(_,i)=>String(i))}],parent_sample_ids:Array.from({length:101},(_,i)=>'S'+i)}}
  ];
  await store.saveDataset(data,{localOnly:true,localKind:'demo'});
  const result=await store.getExportRecords({scope:'history',fromDate:'2025-01-01',entityTypes:['husbandry_events']});
  assert.equal(result.metadata.excluded_undated,1);assert(!result.dataset.tables.husbandry_events.some(r=>['OLD-SAMPLE','UNDATED-EXPERIMENT'].includes(r.event_id)));
  const p=result.dataset.tables.husbandry_events.find(r=>r.event_id==='MANY-LINKS').experiment;assert.equal(p.participant_count,101);assert.equal(p.participants.length,100);assert.equal(p.participants_truncated,true);
  const s=result.dataset.tables.husbandry_events.find(r=>r.event_id==='CANDIDATES').experiment_sample;assert.equal(s.donors[0].candidate_count,101);assert.equal(s.donors[0].candidate_sids.length,100);assert.equal(s.donors[0].candidates_truncated,true);assert.equal(s.parent_samples_truncated,true);
  const all=await store.getExportRecords({scope:'history',entityTypes:['husbandry_events']});assert(all.dataset.tables.husbandry_events.some(r=>r.event_id==='UNDATED-EXPERIMENT'));
});

test('experiment exports keep decapitation, sampling and assay timing separate with explicit ZT or CT',async()=>{
  await fresh();const data=createSyntheticDataset(),decapitation='2025-02-01T10:03:00+08:00',sampling='2025-02-01T10:07:30+08:00';
  const timing={decapitation_at:decapitation,decapitation_circadian_time:'2.05',decapitation_time_basis:'ZT',decapitation_circadian_time_source:'recorded',sampling_at:sampling,sampling_circadian_time:'14.125',sampling_time_basis:'CT',sampling_circadian_time_source:'calculated'};
  const entrainment={scheme:'LP1',light_event_id:'LIGHT-1',reference_at:'2025-02-01T08:00:00+08:00',reference_phase:0,phase_basis:'ZT',phase_scale:'normalized_24',period_hours:24,timezone:'Asia/Taipei',start_date:'2025-01-01',end_date:'2025-01-31',duration_days:30,duration_basis:'date_difference'};
  data.tables.husbandry_events=[
    {event_id:'TIMED-EXP',event_type:'experiment',event_date:'2025-02-01',experiment:{title:'Distinct recorded times',started_at:'2025-02-02T17:00:00+08:00',circadian_time:'9',time_basis:'ZT',circadian_time_source:'recorded',timezone:'Asia/Taipei',...timing,entrainment:{...entrainment,notes:'EXCLUDED TIMING NOTES',raw:{notes:'EXCLUDED TIMING NOTES'}}}},
    {event_id:'TIMED-SAMPLE',event_type:'experiment_sample',event_date:'2025-02-01',experiment_sample:{label:'Sample',collection_at:sampling,circadian_time:'14.125',time_basis:'CT',circadian_time_source:'calculated',timezone:'Asia/Taipei',decapitation_at:decapitation,decapitation_circadian_time:'2.05',decapitation_time_basis:'ZT',decapitation_circadian_time_source:'recorded',entrainment}},
    {event_id:'UNKNOWN-TIMING',event_type:'experiment',event_date:'2025-02-01',experiment:{title:'Unknown times',decapitation_at:null,sampling_at:null,decapitation_time_basis:'unknown',sampling_time_basis:'unknown',started_at:'2025-02-01T12:00:00+08:00'}}
  ];
  await store.saveDataset(data,{localOnly:true,localKind:'demo'});const result=await store.getExportRecords({scope:'history',fromDate:'2025-01-01',entityTypes:['husbandry_events']}),rows=result.dataset.tables.husbandry_events;
  const experiment=rows.find(row=>row.event_id==='TIMED-EXP').experiment,sample=rows.find(row=>row.event_id==='TIMED-SAMPLE').experiment_sample,unknown=rows.find(row=>row.event_id==='UNKNOWN-TIMING').experiment;
  for(const [key,value]of Object.entries(timing))assert.equal(experiment[key],value,key);
  assert.equal(experiment.started_at,'2025-02-02T17:00:00+08:00');assert.equal(experiment.circadian_time,'9');assert.equal(experiment.time_basis,'ZT');
  assert.equal(sample.decapitation_at,decapitation);assert.equal(sample.decapitation_circadian_time,'2.05');assert.equal(sample.decapitation_time_basis,'ZT');assert.equal(sample.collection_at,sampling);assert.equal(sample.circadian_time,'14.125');assert.equal(sample.time_basis,'CT');
  assert.equal(experiment.circadian_time_source,'recorded');assert.equal(sample.circadian_time_source,'calculated');assert.equal(sample.decapitation_circadian_time_source,'recorded');
  assert.deepEqual(experiment.entrainment,entrainment);assert.deepEqual(sample.entrainment,entrainment);assert(!JSON.stringify(rows).includes('EXCLUDED TIMING NOTES'));
  assert.equal(unknown.decapitation_at,null);assert.equal(unknown.sampling_at,null);assert.equal(unknown.decapitation_time_basis,'unknown');assert.equal(unknown.sampling_time_basis,'unknown');
});

test('fee report projection preserves quantities and certainty, excludes raw history and respects the recorded billing date',async()=>{
  await fresh();const data=createSyntheticDataset(),line={group_key:'clean_room',quantity:300,quantity_unit:'cage_day',evidence_kind:'snapshot_projection',evidence_reference:'Source',quantity_basis:'source_formula',quantity_note:'Provisional',notes:'FEE PRIVATE'};
  data.tables.husbandry_events=[
    {event_id:'FEE-RECENT',event_type:'lac_fee_month',event_date:'2025-02-01',source_rows:['FEE PRIVATE'],lac_fee_month:{month:'2025-02',currency:'TWD',actual_total:100,actual_date:'2025-03-01',invoice_reference:'Invoice A',notes:'FEE PRIVATE',supersedes_event_id:'FEE PRIVATE',lines:Array.from({length:101},()=>line)}},
    {event_id:'FEE-OLD',event_type:'lac_fee_month',event_date:'2001-01-01',app_modified_at:'2025-03-01',lac_fee_month:{actual_date:'2025-03-01'}},
    {event_id:'FEE-OPTIONS',event_type:'lac_fee_options',event_date:'2025-02-01',lac_fee_options:{currency:'TWD',target_percent:5,maximum_percent:10,excluded_room_ids:['ANI'],groups:[{key:'spf_room',rate:6.5,room_ids:['SPF'],notes:'FEE PRIVATE'}]}}
  ];
  await store.saveDataset(data,{localOnly:true,localKind:'demo'});const rows=(await store.getExportRecords({scope:'history',fromDate:'2025-01-01',entityTypes:['husbandry_events']})).dataset.tables.husbandry_events,p=rows.find(r=>r.event_id==='FEE-RECENT').lac_fee_month;
  assert.equal(p.actual_total,100);assert.equal(p.lines[0].quantity_basis,'source_formula');assert.equal(p.lines[0].quantity_note,'Provisional');assert.equal(p.lines_count,101);assert.equal(p.lines.length,100);assert.equal(p.lines_truncated,true);assert.equal(rows.find(r=>r.event_id==='FEE-OPTIONS').lac_fee_options.groups[0].rate,6.5);assert(!rows.some(r=>r.event_id==='FEE-OLD'));assert(!JSON.stringify(rows).includes('FEE PRIVATE'));
});

test('strain metadata uses versioned cloud records, rejects stale edits and respects read-only membership',async()=>{
  const d=await connected();
  const input={code:'E',insertion_type:'transgenic',stock_reference:'Synthetic stock',notes:'Synthetic strain note'};
  const built=buildStrainDefinition(d,input,{now:'2026-10-14T10:00:00Z'});
  assert.deepEqual(validateRecord('husbandry_events',built.record,d).errors,[]);
  await store.saveDataset(built.dataset);
  const pulled=await store.pullFromCloud();assert.equal(getStrainRegistry(pulled).find(row=>row.key==='E').notes,input.notes);
  assert.equal(server.records.get('husbandry_events:STRAIN-E').version,1);
  const edited=buildStrainDefinition(pulled,{...input,notes:'Uncommitted note'},{now:'2026-10-14T11:00:00Z'}).dataset;
  server.records.get('husbandry_events:STRAIN-E').version++;
  await assert.rejects(store.saveDataset(edited),/changed in another session/);
  const latest=await store.pullFromCloud();server.role='viewer';
  await assert.rejects(store.saveDataset(buildStrainDefinition(latest,{...input,notes:'Viewer cannot edit'}).dataset),/viewer/);
  assert.equal(getStrainRegistry(await store.loadDataset()).find(row=>row.key==='E').notes,input.notes);
  assert.equal(server.records.get('husbandry_events:STRAIN-E').payload.strain_definition.notes,input.notes);
});


test('breeding options persist through versioned cloud saves and protect read-only and stale sessions',async()=>{
  const d=await connected(),input={...getBreedingOptions(d),male_min_weeks:9,female_max_weeks:30};
  const built=buildBreedingOptions(d,input,{now:'2026-10-14T10:00:00Z'});
  assert.deepEqual(validateRecord('husbandry_events',built.record,d).errors,[]);
  await store.saveDataset(built.dataset);
  const pulled=await store.pullFromCloud();assert.equal(getBreedingOptions(pulled).male_min_weeks,9);assert.equal(getBreedingOptions(pulled).female_max_weeks,30);
  assert.equal(server.records.get('husbandry_events:BREEDING-OPTIONS').version,1);
  const edited=buildBreedingOptions(pulled,{...input,male_min_weeks:10}).dataset;
  server.records.get('husbandry_events:BREEDING-OPTIONS').version++;
  await assert.rejects(store.saveDataset(edited),/changed in another session/);
  const latest=await store.pullFromCloud();server.role='viewer';
  await assert.rejects(store.saveDataset(buildBreedingOptions(latest,{...input,male_min_weeks:10}).dataset),/viewer/);
  assert.equal(getBreedingOptions(await store.loadDataset()).male_min_weeks,9);
  assert.equal(server.records.get('husbandry_events:BREEDING-OPTIONS').payload.breeding_options.male_min_weeks,9);
});


test('room capacity options persist through shared saves with stale and read-only protection',async()=>{
  const d=await connected(),input=getCageSummaryOptions(d);input.groups.spf.capacity=120;
  const built=buildCageSummaryOptions(d,input,{now:'2026-10-14T10:00:00Z'});
  assert.deepEqual(validateRecord('husbandry_events',built.record,d).errors,[]);
  await store.saveDataset(built.dataset);
  const pulled=await store.pullFromCloud();assert.equal(getCageSummaryOptions(pulled).groups.spf.capacity,120);
  assert.equal(server.records.get('husbandry_events:CAGE-SUMMARY-OPTIONS').version,1);
  const changed=structuredClone(input);changed.groups.spf.capacity=150;
  const edited=buildCageSummaryOptions(pulled,changed).dataset;
  server.records.get('husbandry_events:CAGE-SUMMARY-OPTIONS').version++;
  await assert.rejects(store.saveDataset(edited),/changed in another session/);
  const latest=await store.pullFromCloud();server.role='viewer';
  await assert.rejects(store.saveDataset(buildCageSummaryOptions(latest,changed).dataset),/viewer/);
  assert.equal(getCageSummaryOptions(await store.loadDataset()).groups.spf.capacity,120);
  assert.equal(server.records.get('husbandry_events:CAGE-SUMMARY-OPTIONS').payload.cage_summary_options.groups.spf.capacity,120);
});

test('IACUC bounded reports omit source narratives, preserve planning counts, and cannot redate historical activity',async()=>{
 await fresh();const data=createSyntheticDataset(),common={schema_version:1,protocol_id:'IACUC-P',notes:'IACUC PRIVATE',source_refs:['IACUC PRIVATE']};
 data.tables.husbandry_events=[
  {event_id:'IACUC-P',event_type:'iacuc_protocol',event_date:'2025-02-01',iacuc_protocol:{...common,title:'Protocol',status:'approved',approved_animals:100,document:{text:'IACUC PRIVATE'},sections:{personnel:'IACUC PRIVATE'},allocations:[{id:'A',species:'Mouse',approved:100,portal_used:10,portal_pending:2,portal_remaining:88,notes:'IACUC PRIVATE'}]}},
  {event_id:'IACUC-U',event_type:'iacuc_usage',event_date:'2025-03-01',iacuc_usage:{...common,category:'used',mouse_sids:Array.from({length:101},(_,i)=>'M'+i),unregistered_count:2,evidence_status:'source',event_date:'2025-03-01'}},
  {event_id:'IACUC-A',event_type:'iacuc_assignment',event_date:'2025-03-01',iacuc_assignment:{...common,entity_type:'mice',entity_id:'M1',purpose:'experiment',evidence_status:'confirmed',valid_from:'2025-03-01'}},
  {event_id:'IACUC-D',event_type:'iacuc_design',event_date:'2025-03-01',iacuc_design:{...common,label:'Planning',title:'Study',breeding_inputs:{target:20,notes:'IACUC PRIVATE'},breeding_results:{confidence_offspring:100,notes:'IACUC PRIVATE'},inputs:{sample_size:{effect:1,sd:2,cluster:{animalsPerCage:4,icc:.1,notes:'IACUC PRIVATE'}},breeding:{target:20,genotypeProbability:.25,notes:'IACUC PRIVATE'},notes:'IACUC PRIVATE'},results:{sample_size:{status:'ok',n1:10,adjustment:{animals_per_group:[12,12],total_animals:24,cluster:{cages_per_group:[3,3],notes:'IACUC PRIVATE'}},notes:'IACUC PRIVATE'},breeding:{confidence_offspring:100,achieved_probability:.95,notes:'IACUC PRIVATE'}}}},
  {event_id:'IACUC-OLD',event_type:'iacuc_usage',event_date:'2001-01-01',source_accessed_at:'2025-03-01',iacuc_usage:{...common,event_date:'2001-01-01'}},
 ];
 await store.saveDataset(data,{localOnly:true,localKind:'demo'});const rows=(await store.getExportRecords({scope:'history',fromDate:'2025-01-01',entityTypes:['husbandry_events']})).dataset.tables.husbandry_events;
 assert(!rows.some(r=>r.event_id==='IACUC-OLD'));assert(!JSON.stringify(rows).includes('IACUC PRIVATE'));
 const p=rows.find(r=>r.event_id==='IACUC-P').iacuc_protocol,u=rows.find(r=>r.event_id==='IACUC-U').iacuc_usage,d=rows.find(r=>r.event_id==='IACUC-D').iacuc_design;
 assert.equal(p.allocations[0].portal_remaining,88);assert.equal(u.mouse_count,101);assert.equal(u.mouse_sids.length,100);assert.equal(u.mouse_sids_truncated,true);assert.equal(u.unregistered_count,2);
 assert.equal(d.title,'Study');assert.equal(d.breeding_inputs.target,20);assert.equal(d.breeding_results.confidence_offspring,100);assert.equal(d.inputs.sample_size.effect,1);assert.equal(d.inputs.breeding.genotypeProbability,.25);assert.equal(d.results.breeding.confidence_offspring,100);assert.deepEqual(d.results.sample_size.adjustment.animals_per_group,[12,12]);assert.deepEqual(d.results.sample_size.adjustment.cluster.cages_per_group,[3,3]);
});

test('Locobox local history applies phase and treatment limits independently of the wrapper date',async()=>{
 await fresh();const data=createSyntheticDataset();
 const phase=(id,start,end)=>({phase_id:id,label:id,start_date:start,end_date:end,timezone:'Asia/Taipei',scheme:'DD',cycle_hours:24,light_hours:0,notes:'LOCO PRIVATE',schedule_details:'LOCO PRIVATE',treatments:[]});
 const mixed={event_id:'LOCO-LOCAL',event_type:'locobox_protocol',event_date:'2001-01-01',source_text:'LOCO PRIVATE',locobox_protocol:{schema_version:1,protocol_id:'LOCO-LOCAL',title:'Timeline',status:'source',evidence_status:'source',phases:[phase('old','2001-01-01','2002-01-01'),{...phase('spanning','2024-01-01','2025-06-01'),duration_days:500,duration_basis:'recorded',treatments:[{treatment_id:'old-dose',name:'Old',start_date:'2024-02-01',end_date:'2024-02-02',notes:'LOCO PRIVATE'},{treatment_id:'new-dose',name:'New',status:'cancelled',start_date:'2025-01-02',end_date:null,notes:'LOCO PRIVATE'}]}]}};
 data.tables.husbandry_events=[mixed,{event_id:'LOCO-REV',event_type:'locobox_revision',event_date:'2025-02-01',locobox_revision:{before:{notes:'LOCO PRIVATE'},after:{notes:'LOCO PRIVATE'}}}];
 await store.saveDataset(data,{localOnly:true,localKind:'demo'});const rows=(await store.getExportRecords({scope:'history',fromDate:'2025-01-01',toDate:'2025-12-31',entityTypes:['husbandry_events']})).dataset.tables.husbandry_events;
 assert.equal(rows.length,1);assert.equal(rows[0].event_date,undefined);assert.equal(rows[0].export_event_date_withheld,true);const p=rows[0].locobox_protocol.phases;assert.equal(p.length,1);assert.equal(p[0].start_date,undefined);assert.equal(p[0].duration_days,undefined);assert.equal(p[0].export_interval_clipped,true);assert.deepEqual(p[0].treatments.map(t=>t.treatment_id),['new-dose']);assert.equal(p[0].treatments[0].status,'cancelled');assert(!JSON.stringify(rows).includes('LOCO PRIVATE'));
 const full=await store.getFullExportBackup();assert(full.tables.husbandry_events.some(r=>r.event_id==='LOCO-REV'));assert.equal(full.tables.husbandry_events.find(r=>r.event_id==='LOCO-LOCAL').locobox_protocol.phases.length,2);
});


test('fee visibility refresh clears raw source caches and partial cloud editing preserves hidden server records',async()=>{
 const d=createSyntheticDataset();d.tables.husbandry_events=[{event_id:'fee-private',event_type:'lac_fee_month',event_date:'2026-01-01',lac_fee_month:{schema_version:1,month:'2026-01',currency:'TWD',revision:1,actual_total:2468,lines:[]},source_raw:'PRIVATE fee source'}];d.tables.financial_source=[{raw:'PRIVATE archive'}];
 await connected(d);idbData.set('active',{index:{cells:[['PRIVATE source']]}});server.role='editor';server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
 const raw=server.records.get('husbandry_events:fee-private');server.feeRows=[{...structuredClone(raw),payload:{event_id:'fee-private',event_type:'lac_fee_month',event_date:'2026-01-01',lac_fee_month:{schema_version:1,month:'2026-01',currency:'TWD',revision:1,lines:[]},fee_visibility:{estimate:true,actual:false}}}];
 const p=await store.getLacFeeVisibility();assert.equal(p.actual,false);assert.equal(idbData.get('current'),undefined);assert.equal(idbData.get('active'),undefined);assert.equal(store.getCloudStatus().readyForEdits,false);
 const partial=await store.pullFromCloud();assert.equal(partial.source_archive_restricted,true);assert(!JSON.stringify(partial).includes('PRIVATE'));assert.equal(partial.tables.husbandry_events.length,1);assert(!Object.hasOwn(partial.tables.husbandry_events[0].lac_fee_month,'actual_total'));
 const before=structuredClone([...server.records.values()].filter(r=>r.entity_type==='archive'||r.entity_id==='fee-private'));
 partial.tables.mice[0].comment='ordinary animal edit';await store.saveDataset(partial);assert.equal(server.records.get('mice:SYN-M001').payload.comment,'ordinary animal edit');assert.deepEqual([...server.records.values()].filter(r=>r.entity_type==='archive'||r.entity_id==='fee-private'),before);
 const changed=structuredClone(partial);changed.tables.husbandry_events[0].lac_fee_month.actual_total=1;await assert.rejects(store.saveDataset(changed),/Both estimate and actual/);assert.deepEqual([...server.records.values()].filter(r=>r.entity_type==='archive'||r.entity_id==='fee-private'),before);
 await assert.rejects(store.pushToCloud(partial),/Full financial visibility/);await assert.rejects(store.uploadHistoryIndex({sources:[],sheets:[],cells:[]}),/Full financial visibility/);
 await store.signOut();assert.equal(await store.loadDataset(),null);
});
test('partial fee access accepts only sanitized cage source snapshots and preserves hidden originals',async()=>{
 const d=createSyntheticDataset();d.tables.husbandry_events=[{event_id:'snapshot',event_type:'animal_sheet_cage_snapshot',event_date:'2026-01-01',source_cage_snapshot:{body:[{raw:'PRIVATE financial source'}]},notes:'PRIVATE notes'}];
 await connected(d);server.role='editor';server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
 const raw=structuredClone(server.records.get('husbandry_events:snapshot'));server.feeRows=[{...raw,payload:{event_id:'snapshot',event_type:'animal_sheet_cage_snapshot',event_date:'2026-01-01',fee_visibility:{estimate:true,actual:false}}}];
 const partial=await store.pullFromCloud();assert.equal(partial.tables.husbandry_events.length,1);assert(!JSON.stringify(partial).includes('PRIVATE'));assert(!partial.tables.husbandry_events[0].source_cage_snapshot);
 partial.tables.mice[0].comment='ordinary edit';await store.saveDataset(partial);assert.deepEqual(server.records.get('husbandry_events:snapshot'),raw);
 partial.tables.husbandry_events[0].source_cage_snapshot={body:[]};await assert.rejects(store.saveDataset(partial),/Both estimate and actual/);
});
test('cloud cache is never reused across account contexts and fee policy changes mid-pull abort',async()=>{
 await connected();server.role='editor';server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};server.feeRows=[];
 server.feeReads=0;server.onFeeRead=n=>{if(n===2)server.feePolicy={...server.feePolicy,version:2,estimate:false};};await assert.rejects(store.pullFromCloud(),/visibility changed/i);assert.equal(store.getCloudStatus().readyForEdits,false);assert.equal(idbData.get('current'),undefined);
 server.onFeeRead=null;server.feePolicy={version:3,owner:false,estimate:true,actual:true,source_archive_allowed:true};await store.pullFromCloud();const s=JSON.parse(sessionStorage.getItem('mouse-colony.session.v1'));s.user.id='ffffffff-ffff-4fff-8fff-ffffffffffff';sessionStorage.setItem('mouse-colony.session.v1',JSON.stringify(s));assert.equal(await store.loadDataset(),null);assert.equal(idbData.get('current'),undefined);
});
test('sign-out during archive hashing prevents a first cloud pull from restoring private data or cloud mode',async()=>{
 const data=createSyntheticDataset();data.tables.private_history=[{text:'OLD-ACCOUNT-PRIVATE'}];await connected(data);await store.clearDataset();
 const digest=crypto.subtle.digest;let release,started;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 crypto.subtle.digest=async function(...args){started();await gate;return digest.apply(this,args);};
 try{
  const pull=store.pullFromCloud(),rejected=assert.rejects(pull,/account or colony changed/);await waiting;await store.signOut();release();await rejected;
  assert.equal(store.getCloudStatus().signedIn,false);assert.equal(store.getCloudStatus().mode,'local');assert.equal(idbData.get('current'),undefined);assert.equal(idbData.get('current-cloud-write'),undefined);assert.equal(await store.loadDataset(),null);
 }finally{release();crypto.subtle.digest=digest;}
});
test('an account change aborts an uncommitted cloud-cache transaction without deleting the next account workspace',async()=>{
 await connected();await store.clearDataset();let release,started,intercepted=false;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 idbHooks.beforeCommit=async changes=>{if(!intercepted&&changes.get('current-cloud-write')?.id){intercepted=true;started();await gate;}};
 try{
  const pull=store.pullFromCloud(),rejected=assert.rejects(pull,/account or colony changed/);await waiting;await store.signOut();
  server.tokenUser='33333333-3333-4333-8333-333333333333';await store.signIn('other@example.test','other-password');
  const newer=createSyntheticDataset();newer.tables.mice[0].comment='NEW-ACCOUNT-WORKSPACE';await store.saveDataset(newer,{localOnly:true});release();await rejected;
  assert.equal(idbData.get('current').tables.mice[0].comment,'NEW-ACCOUNT-WORKSPACE');assert.equal(idbData.get('current-cloud-write'),undefined);assert.equal(store.getCloudStatus().signedIn,true);assert.equal(store.getCloudStatus().mode,'local');
 }finally{release();idbHooks.beforeCommit=null;}
});
test('a committed but unpublished cloud write is unreadable and stale cleanup preserves a newer workspace',async()=>{
 await connected();await store.clearDataset();let release,started,intercepted=false;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 idbHooks.afterCommit=async changes=>{if(!intercepted&&changes.get('current-cloud-write')?.id){intercepted=true;started();await gate;}};
 try{
  const pull=store.pullFromCloud(),rejected=assert.rejects(pull,/account or colony changed/);await waiting;
  assert(idbData.get('current-cloud-write')?.id);assert.equal(await store.loadDataset(),null,'an unpublished sidecar cannot be treated as local user data');
  await store.signOut();server.tokenUser='33333333-3333-4333-8333-333333333333';await store.signIn('other@example.test','other-password');
  const newer=createSyntheticDataset();newer.tables.mice[0].comment='NEWER-WRITE-MUST-SURVIVE';await store.saveDataset(newer,{localOnly:true});release();await rejected;
  assert.equal((await store.loadDataset()).tables.mice[0].comment,'NEWER-WRITE-MUST-SURVIVE');assert.equal(store.getCloudStatus().mode,'local');assert.equal(idbData.get('current-cloud-write'),undefined);
 }finally{release();idbHooks.afterCommit=null;}
});
test('a stale restricted-data response cannot clear the next account workspace on its error path',async()=>{
 await connected();await store.clearDataset();server.role='editor';server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
 const originalFetch=globalThis.fetch;let release,started;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 globalThis.fetch=async(url,options)=>{if(new URL(url).pathname.endsWith('/rpc/get_managed_locations')){started();await gate;}return originalFetch(url,options);};
 try{
  const pull=store.pullFromCloud(),rejected=assert.rejects(pull,/account or colony changed/);await waiting;await store.signOut();
  server.tokenUser='33333333-3333-4333-8333-333333333333';await store.signIn('other@example.test','other-password');
  const newer=createSyntheticDataset();newer.tables.mice[0].comment='KEEP-AFTER-OLD-REQUEST-FAILS';await store.saveDataset(newer,{localOnly:true});release();await rejected;
  assert.equal(idbData.get('current').tables.mice[0].comment,'KEEP-AFTER-OLD-REQUEST-FAILS');assert.equal(store.getCloudStatus().signedIn,true);assert.equal(store.getCloudStatus().mode,'local');
 }finally{release();globalThis.fetch=originalFetch;}
});
test('a restricted-policy cache read cannot delete a later account workspace',async()=>{
 await connected();await store.clearDataset();server.role='editor';server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
 let release,started,intercepted=false;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 idbHooks.afterRead=async()=>{if(!intercepted){intercepted=true;started();await gate;}};
 try{
  const pull=store.pullFromCloud(),rejected=assert.rejects(pull,/account or colony changed/);await waiting;await store.signOut();
  server.tokenUser='33333333-3333-4333-8333-333333333333';await store.signIn('other@example.test','other-password');
  const newer=createSyntheticDataset();newer.tables.mice[0].comment='KEEP-AFTER-STALE-CACHE-READ';await store.saveDataset(newer,{localOnly:true});release();await rejected;
  assert.equal(idbData.get('current').tables.mice[0].comment,'KEEP-AFTER-STALE-CACHE-READ');assert.equal(store.getCloudStatus().signedIn,true);assert.equal(store.getCloudStatus().mode,'local');
 }finally{release();idbHooks.afterRead=null;}
});
test('a restricted-policy history clear aborts before deleting a later account archive',async()=>{
 await connected();await store.clearDataset();server.role='editor';server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
 let release,started,intercepted=false;const waiting=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 idbHooks.beforeCommit=async changes=>{if(!intercepted&&changes.get('active')===deleted){intercepted=true;started();await gate;}};
 try{
  const pull=store.pullFromCloud(),rejected=assert.rejects(pull,/account or colony changed/);await waiting;await store.signOut();
  server.tokenUser='33333333-3333-4333-8333-333333333333';await store.signIn('other@example.test','other-password');
  const newer=createSyntheticDataset();newer.tables.mice[0].comment='KEEP-AFTER-STALE-HISTORY-CLEAR';await store.saveDataset(newer,{localOnly:true});
  const archive={sources:[{title:'NEW-ACCOUNT-ARCHIVE'}],sheets:[{source_index:0,title:'Synthetic'}],cells:[[0,'A1','NEW-ACCOUNT-HISTORY']]};await saveHistoryIndex(archive);release();await rejected;
  assert.equal(idbData.get('current').tables.mice[0].comment,'KEEP-AFTER-STALE-HISTORY-CLEAR');assert.equal(idbData.get('active').index.cells[0][2],'NEW-ACCOUNT-HISTORY');assert.equal((await loadHistoryIndex()).index.cells[0][2],'NEW-ACCOUNT-HISTORY');
 }finally{release();idbHooks.beforeCommit=null;}
});
function locationFixture(count=1){
 const data=createSyntheticDataset();data.tables.locations=Array.from({length:count},(_,i)=>({location_id:`position-${String(i).padStart(3,'0')}`,label:`Box ${i+1}`,room_id:'room-1',rack_id:'rack-1',row:i+1,column:1,capacity:1,active:true,manager:'Verified caretaker',notes:'Editable note',record_origin:'current_google_sheet_map',source_current:true,source_snapshot_date:'2026-10-15',source_manager_name:'Verified source user',source_observed_tags:['P123'],source_observed_mouse_sids:['SYN-M001'],source_block_text:'HIDDEN-FINANCIAL-CELL-97531',source_manager_evidence_refs:[{raw:'HIDDEN-FINANCIAL-CELL-97531'}],manager_source:{raw:'HIDDEN-FINANCIAL-CELL-97531'}}));return data;
}
const restrictedPolicy=version=>({version,owner:false,estimate:true,actual:false,source_archive_allowed:false});
test('restricted location reads adapt to timeouts without falling back to raw sources or omitting positions',async()=>{
 await connected(locationFixture(81));server.role='editor';server.feePolicy=restrictedPolicy(1);const originalFetch=fetch,attempts=[],start=server.calls.length;
 globalThis.fetch=async(url,options)=>{if(new URL(url).pathname.endsWith('/rpc/get_managed_locations')){const body=JSON.parse(options.body);attempts.push([body.p_offset,body.p_limit]);if(body.p_limit>40)return response({code:'57014',message:'canceling statement due to statement timeout'},500);}return originalFetch(url,options);};
 const result=await store.pullFromCloud();assert.equal(result.tables.locations.length,81);assert.equal(new Set(result.tables.locations.map(r=>r.location_id)).size,81);assert.equal(result.source_archive_restricted,true);assert(!JSON.stringify(result).includes('HIDDEN-FINANCIAL'));
 assert.deepEqual(attempts,[[0,250],[0,125],[0,62],[0,31],[31,31],[62,31]]);assert(!server.calls.slice(start).some(call=>call.url.includes('entity_type=eq.archive')));
});
test('partial fee access pages safe current locations once and saves only projected fields while preserving hidden server sources',async()=>{
 const original=locationFixture(251);await connected(original);server.role='editor';server.feePolicy=restrictedPolicy(1);
 const partial=await store.pullFromCloud();assert.equal(partial.tables.locations.length,251);assert.equal(partial.source_projection_version,2);assert(!JSON.stringify(partial).includes('HIDDEN-FINANCIAL'));
 const location=partial.tables.locations[0];assert.equal(location.manager,'Verified caretaker');assert.equal(location.source_manager_name,'Verified source user');assert.deepEqual(location.source_observed_mouse_sids,['SYN-M001']);
 assert.deepEqual(server.calls.filter(c=>c.url.endsWith('/rpc/get_managed_locations')).map(c=>JSON.parse(c.options.body).p_offset),[0,250]);
 location.notes='Changed cage note';partial.tables.mice[0].comment='Changed with position';server.locationSaveTransform=payload=>({...payload,app_updated_at:'2026-10-15T05:00:00Z'});await store.saveDataset(partial);
 const write=JSON.parse(server.calls.filter(c=>c.url.endsWith('/rpc/save_records')).at(-1).options.body);assert.equal(write.p_changes.length,2);assert(!JSON.stringify(write).includes('HIDDEN-FINANCIAL'));assert(!Object.hasOwn(write.p_changes.find(c=>c.entity_type==='locations').payload,'source_block_text'));
 const raw=server.records.get('locations:position-000');assert.equal(raw.payload.source_block_text,'HIDDEN-FINANCIAL-CELL-97531');assert.equal(raw.payload.notes,'Changed cage note');
 const loaded=await store.loadDataset();assert.equal(loaded.tables.locations[0].app_updated_at,'2026-10-15T05:00:00Z');assert(!JSON.stringify(idbData.get('current')).includes('HIDDEN-FINANCIAL'));
 const before=server.batches;await store.saveDataset(loaded);assert.equal(server.batches,before,'server-normalized payload becomes the new baseline');
 loaded.tables.locations[0].notes='Second edit';await store.saveDataset(loaded);assert.equal(server.records.get('locations:position-000').version,3);
});
test('restricted caches from the previous projection schema are discarded even when the fee flags already match',async()=>{
 await connected(locationFixture());server.role='editor';server.feePolicy=restrictedPolicy(1);await store.pullFromCloud();
 const cache=idbData.get('current');delete cache.source_projection_version;cache.tables.locations[0].source_block_text='HIDDEN-FINANCIAL-OLD-CACHE';idbData.set('current',cache);
 const mark=JSON.parse(localStorage.getItem('mouse-colony.cloud-cache-context.v1'));delete mark.source_projection_version;localStorage.setItem('mouse-colony.cloud-cache-context.v1',JSON.stringify(mark));idbData.set('active',{index:{cells:[['HIDDEN-FINANCIAL-HISTORY']]}});
 const before=server.calls.length,loaded=await store.loadDataset();assert.equal(loaded.source_projection_version,2);assert(!JSON.stringify(loaded).includes('HIDDEN-FINANCIAL'));assert.equal(idbData.get('active'),undefined);assert(server.calls.slice(before).some(c=>c.url.endsWith('/rpc/get_managed_locations')));
 // An erroneously stamped cache containing a forbidden key is also rejected.
 const stamped=idbData.get('current');stamped.tables.locations[0].manager_source={raw:'HIDDEN-FINANCIAL'};idbData.set('current',stamped);assert(!JSON.stringify(await store.loadDataset()).includes('HIDDEN-FINANCIAL'));
});
test('restricted saves reject stale full location fields before making a write or retaining those fields locally',async()=>{
 await connected(locationFixture());server.role='editor';server.feePolicy=restrictedPolicy(1);const partial=await store.pullFromCloud(),batches=server.batches;
 partial.tables.locations[0].source_block_text='HIDDEN-FINANCIAL-STALE';await assert.rejects(store.saveDataset(partial),/Source location fields/);assert.equal(server.batches,batches);assert(!JSON.stringify(idbData.get('current')).includes('HIDDEN-FINANCIAL'));
});
test('restored full visibility requires a full pull before a projected location can be edited',async()=>{
 await connected(locationFixture());server.role='editor';server.feePolicy=restrictedPolicy(1);const partial=await store.pullFromCloud(),batches=server.batches;
 partial.tables.locations[0].notes='Do not replace hidden fields';server.feePolicy={version:2,owner:false,estimate:true,actual:true,source_archive_allowed:true};
 await assert.rejects(store.saveDataset(partial),/Visibility changed/);assert.equal(server.batches,batches);assert.equal(store.getCloudStatus().readyForEdits,false);assert.equal(server.records.get('locations:position-000').payload.source_block_text,'HIDDEN-FINANCIAL-CELL-97531');
 const full=await store.pullFromCloud();assert.equal(full.tables.locations[0].source_block_text,'HIDDEN-FINANCIAL-CELL-97531');full.tables.locations[0].notes='Full context edit';await store.saveDataset(full);assert.equal(server.records.get('locations:position-000').payload.source_block_text,'HIDDEN-FINANCIAL-CELL-97531');
});
test('location projection denial, malformed rows and mid-page policy changes fail closed without a raw-row fallback',async()=>{
 for(const failure of ['denied','raw','foreign','cursor','policy']){
  await connected(locationFixture());server.role='editor';server.feePolicy=restrictedPolicy(1);await store.pullFromCloud();
  if(failure==='denied')server.locationError=true;
  else server.locationResponse=()=>{const row=projectLocation(server.records.get('locations:position-000'));if(failure==='raw')row.payload.source_block_text='HIDDEN-FINANCIAL';if(failure==='foreign')row.colony_id='foreign';return {visibility:failure==='policy'?restrictedPolicy(2):server.feePolicy,rows:[row],next_offset:failure==='cursor'?0:null};};
  await assert.rejects(store.pullFromCloud(),/permission|projected location|page cursor|visibility changed/i);assert.equal(idbData.get('current'),undefined,failure);assert.equal(store.getCloudStatus().readyForEdits,false,failure);
 }
});
test('permission changes during saves never cache full location return values and require a fresh pull',async()=>{
 await connected(locationFixture());const full=await store.loadDataset();full.tables.locations[0].notes='Before restriction';server.role='editor';server.onSave=()=>{server.feePolicy=restrictedPolicy(1);};
 await assert.rejects(store.saveDataset(full),/visibility changed/i);assert.equal(idbData.get('current'),undefined);assert.equal(store.getCloudStatus().readyForEdits,false);
 server.onSave=null;const partial=await store.pullFromCloud();assert.equal(partial.tables.locations[0].notes,'Before restriction');assert(!JSON.stringify(partial).includes('HIDDEN-FINANCIAL'));
 partial.tables.locations[0].notes='Policy changed again';server.onSave=rows=>{rows.find(r=>r.entity_type==='locations').payload.source_block_text='HIDDEN-FINANCIAL-MALFORMED-RETURN';};
 await assert.rejects(store.saveDataset(partial),/Invalid projected location/);assert.equal(idbData.get('current'),undefined);assert.equal(store.getCloudStatus().readyForEdits,false);
});
test('client restricted location keys remain identical to the server allowlist',async()=>{
 const sql=await readFile(new URL('../supabase/lac-fee-visibility.sql',import.meta.url),'utf8'),js=await readFile(new URL('../web/data-store.js',import.meta.url),'utf8');
 const sqlKeys=[...sql.match(/managed_location_keys\(\)[\s\S]*?as \$\$select array\[([\s\S]*?)\]\$\$/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
 const clientKeys=[...js.match(/const MANAGED_LOCATION_KEYS=new Set\(\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);assert.deepEqual(clientKeys.sort(),sqlKeys.sort());
});
test('owner fee visibility saves preserve default visibility and reject nonowner UI escalation',async()=>{
 await connected();const levels={low:{estimate:true,actual:false},high:{estimate:false,actual:true},max:{estimate:true,actual:true}};
 const p=await store.saveLacFeeVisibility({version:0,levels});assert.equal(p.version,1);assert.deepEqual(p.levels,levels);assert.equal(p.source_archive_allowed,true);
 server.role='editor';await assert.rejects(store.saveLacFeeVisibility({version:1,levels}),/Only the owner/);
});

test('Brainbot RPCs remain owner-only and transient; actual corrections invalidate stale edit state',async()=>{
 await connected();server.brainbotReply={principal:{principal_id:'test-principal',role:'manager',acronym:'BB'},settings:{version:1},runs:[],issues:[],last_run:null};
 const before=structuredClone(idbData.get('current'));assert.equal((await store.getBrainbotStatus()).principal.acronym,'BB');
 assert.equal((await store.saveBrainbotSettings({version:1,enabled:true})).settings.version,1);await store.reviewBrainbotIssue({issue_id:'issue',version:1,status:'acknowledged',note:'Reviewed'});assert.deepEqual(idbData.get('current'),before);
 server.brainbotReply={...server.brainbotReply,last_run:{fixed_count:1}};await store.runBrainbot();assert.equal(store.getCloudStatus().readyForEdits,false);
 server.role='manager';for(const action of [()=>store.getBrainbotStatus(),()=>store.runBrainbot(),()=>store.saveBrainbotSettings({}),()=>store.reviewBrainbotIssue({})])await assert.rejects(action(),/Only the owner/);
});
test('Brainbot never returns a private response after account switch or malformed service result',async()=>{
 await connected();server.brainbotReply={principal:{role:'manager'},settings:{version:1},runs:[],issues:[]};
 server.onBrainbot=()=>{const s=JSON.parse(sessionStorage.getItem('mouse-colony.session.v1'));s.user.id='ffffffff-ffff-4fff-8fff-ffffffffffff';sessionStorage.setItem('mouse-colony.session.v1',JSON.stringify(s));};
 await assert.rejects(store.getBrainbotStatus(),/account or colony changed/);
 await connected();server.brainbotReply={principal:{role:'owner'},settings:{version:1},runs:[],issues:[]};await assert.rejects(store.getBrainbotStatus(),/not confirmed/);
});

test('password reset requests use only the configured gateway and return no resolved email or delivery claim',async()=>{
 await fresh();server.recoveryReply={accepted:true,email:'PRIVATE lookup@example.org',message:'PRIVATE provider'};
 const result=await store.requestPasswordReset(' Lab.User ');assert.equal(result.accepted,true);assert(!JSON.stringify(result).includes('PRIVATE'));assert(!JSON.stringify(result).includes('lookup@example.org'));assert.equal(store.getCloudStatus().signedIn,false);
 const call=server.calls.at(-1);assert.equal(call.url,'https://test.supabase.co/functions/v1/username-sign-in');assert.deepEqual(JSON.parse(call.options.body),{action:'recover',identifier:'Lab.User'});assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');assert.equal(call.options.headers.Authorization,'Bearer '+jwt('anon'));
 server.recoveryStatus=429;await assert.rejects(store.requestPasswordReset('name@example.org'),/Wait one hour/);server.recoveryStatus=503;await assert.rejects(store.requestPasswordReset('name@example.org'),/temporarily unavailable/);
 const n=server.calls.length;for(const id of ['',null,'bad id','x'.repeat(300)])await assert.rejects(store.requestPasswordReset(id),/valid username or email/);assert.equal(server.calls.length,n);
});
test('recovery stays isolated until the exact new password and fresh membership verify; no global logout or stored password',async()=>{
 await connected();idbData.set('active',{index:{cells:['private source']}});callbackPage(callbackHash(callbackToken(),'recovery'));
 const status=await store.consumeAuthCallback();assert.equal(status.passwordRecovery,true);assert.equal(status.readyForEdits,false);assert.equal(store.getCloudStatus().passwordRecovery,true);assert.equal(idbData.get('current'),undefined);assert.equal(idbData.get('active'),undefined);assert.equal(await store.loadDataset(),null);
 assert.equal(JSON.parse(sessionStorage.getItem('mouse-colony.session.v1')).passwordRecovery,true);const n=server.calls.length;await assert.rejects(store.pullFromCloud(),/Finish resetting/);await assert.rejects(store.updateAccountPassword('long-password-for-recovery'),/recovery form/);assert.equal(server.calls.length,n);
 const password=' New private recovery password 71! ';const before=server.calls.length,result=await store.completePasswordRecovery(password);assert.equal(result.updated,true);assert.equal(result.signedIn,true);assert.equal(store.getCloudStatus().signedIn,true);assert.equal(store.getCloudStatus().passwordRecovery,false);assert.equal(store.getCloudStatus().passwordRecoveryUpdated,false);assert.equal(store.getCloudStatus().role,'owner');assert.equal(store.getCloudStatus().readyForEdits,false);
 const calls=server.calls.slice(before);assert.equal(calls.length,3);assert(calls[0].url.endsWith('/user'));assert(calls[1].url.includes('grant_type=password'));assert.deepEqual(JSON.parse(calls[1].options.body),{email:'demo@example.test',password});assert.equal(calls[1].options.cache,'no-store');assert.equal(calls[1].options.redirect,'error');assert(calls[2].url.includes('/memberships?'));assert.equal(calls[2].options.headers.Authorization,'Bearer access');
 const update=server.calls.findLast(c=>c.options.method==='PUT');assert.deepEqual(JSON.parse(update.options.body),{password});assert.equal(update.options.redirect,'error');assert.equal(update.options.cache,'no-store');assert(!JSON.stringify(result).includes(password));assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes(password));assert(!server.calls.slice(before).some(c=>c.url.endsWith('/auth/v1/logout')));
 await assert.rejects(store.completePasswordRecovery(password),/valid password reset link/);
});
test('recovery update failure is not success and never echoes a rejected password',async()=>{
 await fresh();callbackPage(callbackHash(callbackToken(),'recovery'));await store.consumeAuthCallback();
 server.passwordStatus=422;server.passwordReply={message:'PRIVATE supplied password'};await assert.rejects(store.completePasswordRecovery('long-recovery-password'),e=>/not confirmed/.test(e.message)&&!e.message.includes('PRIVATE'));assert.equal(store.getCloudStatus().passwordRecovery,true);
 for(const p of ['short','x'.repeat(129),null])await assert.rejects(store.completePasswordRecovery(p),/12 and 128/);
 server.passwordStatus=null;server.passwordNetworkFailure=true;await assert.rejects(store.completePasswordRecovery('long-recovery-password'),/not confirmed/);assert.equal(store.getCloudStatus().passwordRecovery,true);await store.signOut();
});
test('password-save success plus failed sign-in stays restricted and retry only verifies the saved password',async()=>{
 for(const failure of ['credentials','network','missing-session','other-user','anonymous','unverified','inactive','unknown-role']){
  await fresh();callbackPage(callbackHash(callbackToken(),'recovery'));await store.consumeAuthCallback();
  const valid={access_token:'verified-access',refresh_token:'verified-refresh',expires_in:3600,user:{id:uid,email:'demo@example.test',email_confirmed_at:'2026-01-01'}};
  if(failure==='credentials'){server.passwordGrantStatus=400;server.passwordGrantReply={message:'PRIVATE rejected credential'};}
  if(failure==='network')server.passwordGrantNetworkFailure=true;
  if(failure==='missing-session')server.passwordGrantReply={user:valid.user};
  if(failure==='other-user')server.passwordGrantReply={...valid,user:{...valid.user,id:cid}};
  if(failure==='anonymous')server.passwordGrantReply={...valid,user:{...valid.user,is_anonymous:true}};
  if(failure==='unverified')server.passwordGrantReply={...valid,user:{...valid.user,email_confirmed_at:null}};
  if(failure==='inactive')server.active=false;
  if(failure==='unknown-role')server.role='superadmin';
  await assert.rejects(store.completePasswordRecovery(' new recovery password '),e=>/password was saved, but sign-in could not be verified/.test(e.message)&&!e.message.includes('PRIVATE'),failure);
  assert.equal(store.getCloudStatus().passwordRecovery,true,failure);assert.equal(store.getCloudStatus().passwordRecoveryUpdated,true);assert.equal(await store.loadDataset(),null);assert.equal(idbData.get('current'),undefined);
  await assert.rejects(store.pullFromCloud(),/Finish resetting/);
  const before=server.calls.length;server.passwordGrantReply=valid;server.passwordGrantStatus=200;server.passwordGrantNetworkFailure=false;server.active=true;server.role='owner';
  const result=await store.completePasswordRecovery(' new recovery password ');assert.equal(result.signedIn,true);
  const retry=server.calls.slice(before);assert(!retry.some(c=>c.options.method==='PUT'||c.url.endsWith('/logout')),failure);assert.deepEqual(JSON.parse(retry[0].options.body),{email:'demo@example.test',password:' new recovery password '});
  assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes('new recovery password'));
 }
});
test('saved-password retry state survives session serialization; pending eligible users only receive setup access',async()=>{
 await fresh();callbackPage(callbackHash(callbackToken(),'recovery'));await store.consumeAuthCallback();server.passwordGrantNetworkFailure=true;
 await assert.rejects(store.completePasswordRecovery('saved-password-to-verify'),/password was saved/);
 // Rehydrating an expired recovery session still skips another password update.
 const key='mouse-colony.session.v1',saved=JSON.parse(sessionStorage.getItem(key));saved.expires_at=1;sessionStorage.setItem(key,JSON.stringify(saved));
 server.passwordGrantNetworkFailure=false;server.memberships=[];server.myProfile={eligible:true,setup_required:true,member:{member_id:'member'}};
 const before=server.calls.length;assert.equal((await store.completePasswordRecovery('saved-password-to-verify')).signedIn,true);assert.equal(store.getCloudStatus().role,'pending');assert.equal(store.getCloudStatus().setupRequired,true);assert.equal(store.getCloudStatus().exportLevel,null);assert(!server.calls.slice(before).some(c=>c.options.method==='PUT'));
});
test('delayed recovery update, password grant, and membership cannot restore or erase another account action',async()=>{
 for(const stage of ['update','grant','membership'])for(const action of ['logout','configure','new-login']){
  await fresh();callbackPage(callbackHash(callbackToken(),'recovery'));await store.consumeAuthCallback();
  const baseFetch=fetch;let release,started,first=true;const waiting=new Promise(r=>started=r);
  globalThis.fetch=async(url,options)=>{
   const target=stage==='update'?url.endsWith('/auth/v1/user')&&options.method==='PUT':stage==='grant'?url.includes('grant_type=password'):url.includes('/memberships?');
   if(target&&first){first=false;started();await new Promise(r=>release=r);}
   return baseFetch(url,options);
  };
  const pending=store.completePasswordRecovery('new-password-to-verify'),rejected=assert.rejects(pending,/account or cloud configuration changed|account or colony changed/);await waiting;
  if(action==='logout')await store.signOut();else if(action==='configure')store.configureCloud({url:'https://another.supabase.co',anonKey:jwt('anon'),colonyId:cid});else await store.signIn('demo@example.test','normal-password');
  const current=sessionStorage.getItem('mouse-colony.session.v1');release();await rejected;assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),current,stage+' '+action);assert.equal(store.getCloudStatus().passwordRecovery,false);
 }
});
test('delayed callbacks cannot restore sessions after sign-out/config change or erase a newer sign-in',async()=>{
 for(const action of ['logout','configure','new-login','new-login-error']){
  await fresh();callbackPage(callbackHash(callbackToken(),'recovery'));const baseFetch=fetch;let release,started;const waiting=new Promise(r=>started=r);
  globalThis.fetch=async(url,options)=>{if(url.endsWith('/auth/v1/user')){started();await new Promise(r=>release=r);if(action==='new-login-error')return response({message:'late failure'},401);}return baseFetch(url,options);};
  const pending=store.consumeAuthCallback();const rejected=assert.rejects(pending,/account or cloud configuration changed/);await waiting;
  if(action==='logout')await store.signOut();else if(action==='configure')store.configureCloud({url:'https://another.supabase.co',anonKey:jwt('anon'),colonyId:cid});else await store.signIn('demo@example.test','test-password');
  const current=sessionStorage.getItem('mouse-colony.session.v1');release();await rejected;assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),current);assert.equal(store.getCloudStatus().passwordRecovery,false);
 }
});
test('a stale callback waiting on membership cannot clear a newer authorized session',async()=>{
 await fresh();callbackPage(callbackHash());const baseFetch=fetch;let release,started;const waiting=new Promise(r=>started=r);let first=true;
 globalThis.fetch=async(url,options)=>{if(url.includes('/memberships?')&&first){first=false;started();await new Promise(r=>release=r);return response({message:'late failure'},403);}return baseFetch(url,options);};
 const pending=store.consumeAuthCallback(),rejected=assert.rejects(pending,/account or cloud configuration changed/);await waiting;await store.signIn('demo@example.test','test-password');const saved=sessionStorage.getItem('mouse-colony.session.v1');release();await rejected;assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),saved);
});

test('local backup uses server High boundary, dedicated guarded pages, and integrity envelope',async()=>{
 installServer();configure();await store.signIn('demo@example.test','password');server.exportLevel='high';
 const backup=await store.getLocalBackup();assert.equal(backup.full_workspace,false);assert.equal(backup.restore_mode,'reviewed_merge_only');assert.equal(backup.permission.cutoff_date,'2020-10-14');assert.deepEqual(Object.keys(backup.sections),['current_housing','history']);
 const pages=server.calls.filter(c=>c.url.endsWith('/export_local_backup_records')).map(c=>JSON.parse(c.options.body));assert.equal(pages.length,4);assert.equal(pages[0].p_limit,1);assert.equal(pages[1].p_from_date,null);assert.equal(pages[2].p_from_date,'2020-10-14');assert.equal(pages[3].p_limit,1);assert(pages.slice(1).every(page=>page.p_expected_revision==='42'));assert(!server.calls.some(c=>c.url.endsWith('/rpc/export_records')));
 const {integrity,...body}=backup;assert.equal(integrity.value,createHash('sha256').update(JSON.stringify(body)).digest('hex'));
 server.exportLevel='low';const before=server.calls.length;await assert.rejects(store.getLocalBackup(),/permission/);assert(!server.calls.slice(before).some(c=>c.url.includes('export_local_backup_records')));
});
test('local backup rejects changes in revision or revoked permission across sections',async()=>{
 for(const change of ['revision','level','account']){
  installServer();configure();await store.signIn('demo@example.test','password');server.exportLevel='high';let pages=0;
  server.exportResponse=body=>{pages++;if(pages===2&&change==='level')server.exportLevel='low';if(pages===2&&change==='account'){const key='mouse-colony.session.v1',s=JSON.parse(sessionStorage.getItem(key));s.user.id='33333333-3333-4333-8333-333333333333';sessionStorage.setItem(key,JSON.stringify(s));}return {rows:[],next_offset:null,export_level:'high',cutoff_date:'2020-10-14',as_of_date:'2026-10-14',snapshot_revision:change==='revision'?String(pages):'1',fee_visibility:{version:0,owner:true,estimate:true,actual:true,source_archive_allowed:true},from_date:body.p_from_date,to_date:body.p_to_date,scope:body.p_scope};};
  await assert.rejects(store.getLocalBackup(),/changed|permission/);
 }
});


test('local backup rejects policy changes across sections and after the final grant',async()=>{
 for(const level of ['high','max'])for(const stage of ['section','final-grant']){
  await connected();server.exportLevel=level;const baseFetch=fetch;let grants=0,pages=0;
  globalThis.fetch=async(url,options)=>{
   if(url.endsWith('/rpc/get_local_backup_permission')&&++grants===2&&stage==='final-grant')server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
   if(url.endsWith('/rpc/export_local_backup_records')&&++pages===3&&stage==='section')server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
   // A full backup has only boundary probes; change during the raw read instead.
   if(level==='max'&&stage==='section'&&url.includes('/entity_records?'))server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
   return baseFetch(url,options);
  };
  await assert.rejects(store.getLocalBackup(),/visibility changed|requires access/,level+' '+stage);
 }
});
test('Max local backup rejects a redacted workspace and any write during raw pagination',async()=>{
 await connected();server.exportLevel='max';server.feePolicy={version:1,owner:false,estimate:true,actual:false,source_archive_allowed:false};
 const before=server.calls.length;await assert.rejects(store.getLocalBackup(),/requires access to source and fee data/);
 assert(!server.calls.slice(before).some(call=>call.url.includes('/entity_records?')));
 await connected();server.exportLevel='max';const baseFetch=fetch;
 globalThis.fetch=async(url,options)=>{const result=await baseFetch(url,options);if(url.includes('/entity_records?'))server.exportRevision='43';return result;};
 await assert.rejects(store.getLocalBackup(),/Data or fee visibility changed/);
});
test('Max local backup returns a verified complete envelope and never treats missing policy as unrestricted',async()=>{
 await connected();server.exportLevel='max';const backup=await store.getLocalBackup();
 assert.equal(backup.full_workspace,true);assert.equal(backup.restore_mode,'workspace');assert(backup.sections.workspace.tables.mice.length>0);
 assert.deepEqual(Object.keys(backup.sections),['workspace']);assert.equal(backup.sections.workspace.source_archive_restricted,undefined);
 const pages=server.calls.filter(call=>call.url.endsWith('/export_local_backup_records')).map(call=>JSON.parse(call.options.body));assert.equal(pages.length,2);assert.equal(pages[1].p_expected_revision,'42');
 server.exportResponse=()=>({rows:[],next_offset:null,export_level:'max',cutoff_date:null,as_of_date:'2026-10-14',snapshot_revision:'42'});
 await assert.rejects(store.getLocalBackup(),/Fee visibility could not be verified/);
});
test('local backup rejects an old response after a newer sign-in to the same account',async()=>{
 await connected();server.exportLevel='max';const baseFetch=fetch;let probes=0;
 globalThis.fetch=async(url,options)=>{const result=await baseFetch(url,options);if(url.endsWith('/export_local_backup_records')&&++probes===2)await store.signIn('demo@example.test','new-session-password');return result;};
 await assert.rejects(store.getLocalBackup(),/account changed/);assert.equal(store.getCloudStatus().signedIn,true);
});
test('explicit local demo backup remains complete and makes no cloud backup requests',async()=>{
 await fresh();await store.saveDataset(createSyntheticDataset(),{localOnly:true,localKind:'demo'});const before=server.calls.length;
 const backup=await store.getLocalBackup();assert.equal(backup.full_workspace,true);assert.equal(backup.permission.level,'max');assert.equal(backup.sections.workspace.tables.mice.length,3);
 assert.equal(server.calls.length,before);
});

test('selected archive fetch reads manifest first and only referenced chunk payloads with three bounded workers',async()=>{
 const data=createSyntheticDataset();data.tables.parallel_history=Array.from({length:12},(_,i)=>({id:i,text:String.fromCharCode(65+i).repeat(140000)}));
 const before=await connected(data),orphan=(await encodeArchive({...data,tables:{orphan_history:[{text:'UNREFERENCED-ARCHIVE-PAYLOAD'}]}})).find(isArchiveChunk);
 server.records.set(`archive:${orphan.entity_id}`,{...orphan,colony_id:cid,version:7});
 const originalFetch=fetch,archiveQueries=[];let inFlight=0,maximum=0;
 globalThis.fetch=async(url,options)=>{const parsed=new URL(url),query=parsed.searchParams;if(parsed.pathname.endsWith('/entity_records')&&query.get('entity_type')==='eq.archive'){
  archiveQueries.push(query);if(query.get('entity_id')?.startsWith('in.(')){
   assert.deepEqual(idbData.get('current'),before,'an unfinished pull must not publish partial history');inFlight++;maximum=Math.max(maximum,inFlight);
   try{await new Promise(resolve=>setTimeout(resolve,2));return await originalFetch(url,options);}finally{inFlight--;}
  }
 }return originalFetch(url,options);};
 const loaded=await store.pullFromCloud();assert.deepEqual(loaded,before);assert.equal(maximum,3);
 const payloadQueries=archiveQueries.filter(query=>query.get('select').includes('payload'));
 assert.equal(payloadQueries[0].get('entity_id'),'eq.reconstruction');assert(payloadQueries.every(query=>Number(query.get('limit'))<=3));
 const chunkQueries=payloadQueries.slice(1);assert(chunkQueries.length>3);assert(chunkQueries.every(query=>query.get('entity_id').startsWith('in.(')&&!query.get('entity_id').includes(orphan.entity_id)));
 assert(archiveQueries.some(query=>!query.get('select').includes('payload')&&query.get('limit')==='1000'));
 assert.equal(archiveQueries.at(-1).get('entity_id'),'eq.reconstruction');assert(!archiveQueries.at(-1).get('select').includes('payload'));
});

test('an archive retry reuses an unreferenced immutable chunk with its recorded version',async()=>{
 const data=createSyntheticDataset();data.tables.retry_history=[{text:'previous archive'}];const before=await connected(data),change=structuredClone(before);change.tables.retry_history=[{text:'staged new archive'}];
 server.failBatch=server.batches+2;await assert.rejects(store.saveDataset(change),/not confirmed/);server.failBatch=null;
 const newChunk=(await encodeArchive(change)).find(row=>row.payload.table==='retry_history'),staged=server.records.get(`archive:${newChunk.entity_id}`);assert(staged);
 const oldVersion=staged.version;assert.deepEqual((await store.pullFromCloud()).tables.retry_history,before.tables.retry_history);
 const start=server.calls.length;await store.saveDataset(change);
 const writes=server.calls.slice(start).filter(call=>call.url.endsWith('/rpc/save_records')).flatMap(call=>JSON.parse(call.options.body).p_changes);
 assert.equal(writes.find(row=>row.entity_id===newChunk.entity_id).expected_version,oldVersion);assert.deepEqual((await store.pullFromCloud()).tables.retry_history,change.tables.retry_history);
});

test('selected archive batches reduce only confirmed timeout pages without omitting chunks',async()=>{
 const data=createSyntheticDataset();data.tables.slow_history=Array.from({length:7},(_,i)=>({id:i,text:String.fromCharCode(65+i).repeat(140000)}));const before=await connected(data),originalFetch=fetch,limits=[],start=server.calls.length;
 globalThis.fetch=async(url,options)=>{const query=new URL(url).searchParams;if(query.get('entity_id')?.startsWith('in.(')){
  const n=Number(query.get('limit'));limits.push(n);if(n>1)return response({code:'57014',message:'canceling statement due to statement timeout'},500);
 }return originalFetch(url,options);};
 assert.deepEqual(await store.pullFromCloud(),before);assert(limits.includes(3));assert(limits.includes(1));
 const ids=server.calls.slice(start).filter(call=>new URL(call.url).searchParams.get('entity_id')?.startsWith('in.(')).map(call=>new URL(call.url).searchParams.get('entity_id'));
 assert(ids.every(value=>/^in\.\(chunk:[a-f0-9]{64}\)$/.test(value)),'each successful fallback page selects one literal chunk ID');
});

test('selected archive rejects unknown descriptors and references before issuing chunk reads',async()=>{
 for(const scenario of ['format','table','id','descriptor']){
  const before=await connected(),head=server.records.get('archive:reconstruction');
  if(scenario==='format')head.payload.archive_format='unknown-format';
  if(scenario==='table')head.payload.archive_tables.mice={row_count:0,chunk_ids:[]};
  if(scenario==='id')head.payload.archive_tables.unknown={row_count:1,chunk_ids:['chunk:bad,entity_type.eq.mice']};
  if(scenario==='descriptor')head.payload.archive_tables.unknown={row_count:-1,chunk_ids:[]};
  const start=server.calls.length;await assert.rejects(store.pullFromCloud(),/not supported|Invalid archive/);
  assert.deepEqual(idbData.get('current'),before);assert.equal(store.getCloudStatus().readyForEdits,false);
  assert(!server.calls.slice(start).some(call=>new URL(call.url).searchParams.get('entity_id')?.startsWith('in.(')));
 }
});

test('missing, corrupt, duplicate or unrelated selected chunks fail closed and preserve the verified snapshot',async()=>{
 for(const failure of ['missing-index','missing-response','corrupt','duplicate','foreign-colony','version','archived','unknown-id']){
  const data=createSyntheticDataset();data.tables.guard_history=Array.from({length:4},(_,i)=>({id:i,text:String.fromCharCode(65+i).repeat(140000)}));
  const before=await connected(data),originalFetch=fetch;let changed=false;
  if(failure==='missing-index'){const id=server.records.get('archive:reconstruction').payload.archive_tables.guard_history.chunk_ids[0];server.records.delete(`archive:${id}`);}
  globalThis.fetch=async(url,options)=>{const query=new URL(url).searchParams,reply=await originalFetch(url,options);if(!changed&&query.get('entity_id')?.startsWith('in.(')){
   changed=true;const rows=await reply.json();
   if(failure==='missing-response')rows.pop();
   if(failure==='corrupt')rows[0].payload.rows[0]={tampered:true};
   if(failure==='duplicate')rows[1]=rows[0];
   if(failure==='foreign-colony')rows[0].colony_id=uid;
   if(failure==='version')rows[0].version++;
   if(failure==='archived')rows[0].archived=true;
   if(failure==='unknown-id')rows[0].entity_id='chunk:'+'0'.repeat(64);
   return response(rows);
  }return reply;};
  await assert.rejects(store.pullFromCloud(),/missing|Missing|invalid|checksum/);assert.deepEqual(idbData.get('current'),before);assert.equal(store.getCloudStatus().readyForEdits,false);
 }
});

test('a replaced manifest or changed account during selected archive reads cannot publish old data',async()=>{
 for(const failure of ['manifest','account']){
  const data=createSyntheticDataset();data.tables.guard_history=Array.from({length:4},(_,i)=>({id:i,text:String.fromCharCode(65+i).repeat(140000)}));
  const before=await connected(data),originalFetch=fetch;let changed=false;
  globalThis.fetch=async(url,options)=>{const query=new URL(url).searchParams,reply=await originalFetch(url,options);if(!changed&&query.get('entity_id')?.startsWith('in.(')){
   changed=true;if(failure==='manifest')server.records.get('archive:reconstruction').version++;else await store.signOut();
  }return reply;};
  await assert.rejects(store.pullFromCloud(),/manifest changed|account or colony changed/);
  if(failure==='manifest'){assert.deepEqual(idbData.get('current'),before);assert.equal(store.getCloudStatus().readyForEdits,false);}else{assert.equal(idbData.get('current'),undefined);assert.equal(store.getCloudStatus().signedIn,false);}
 }
});

test('temporary refresh failures preserve the session without authorizing reads or writes; reconnect recovers',async()=>{
 for(const failure of ['network','unavailable','rate-limit','unreadable']){
  const before=await connected(),key='mouse-colony.session.v1',oldSession=JSON.parse(sessionStorage.getItem(key));oldSession.expires_at=1;sessionStorage.setItem(key,JSON.stringify(oldSession));
  const savedSession=sessionStorage.getItem(key),originalFetch=fetch;let refreshCalls=0,recordCalls=0;
  globalThis.fetch=async(url,options)=>{const parsed=new URL(url);if(parsed.pathname.endsWith('/token')&&parsed.searchParams.get('grant_type')==='refresh_token'){
   refreshCalls++;if(failure==='network')throw new TypeError('Network unavailable');
   if(failure==='unreadable')return new Response('upstream unavailable',{status:502});
   return response({message:failure==='rate-limit'?'Rate limited':'Cloud temporarily unavailable'},failure==='rate-limit'?429:503);
  }if(parsed.pathname.endsWith('/entity_records'))recordCalls++;return originalFetch(url,options);};
  await assert.rejects(store.pullFromCloud(),/Network|temporarily|Rate limited|unreadable/);
  assert.equal(refreshCalls,1);assert.equal(recordCalls,0);assert.equal(sessionStorage.getItem(key),savedSession);assert.equal(store.getCloudStatus().readyForEdits,false);
  assert.deepEqual(idbData.get('current'),before);await assert.rejects(store.saveDataset(before),/Pull the latest/);
  globalThis.fetch=originalFetch;assert.deepEqual(await store.pullFromCloud(),before);assert.equal(store.getCloudStatus().readyForEdits,true);
 }
});

test('explicit refresh rejection still clears the session and prevents shared access',async()=>{
 for(const status of [400,401,403]){
  const before=await connected(),key='mouse-colony.session.v1',oldSession=JSON.parse(sessionStorage.getItem(key));oldSession.expires_at=1;sessionStorage.setItem(key,JSON.stringify(oldSession));
  const originalFetch=fetch;let recordCalls=0;
  globalThis.fetch=async(url,options)=>{const parsed=new URL(url);if(parsed.pathname.endsWith('/token'))return response({message:'Invalid refresh token'},status);if(parsed.pathname.endsWith('/entity_records'))recordCalls++;return originalFetch(url,options);};
  await assert.rejects(store.pullFromCloud(),/Invalid refresh|expired|permission/);assert.equal(sessionStorage.getItem(key),null);assert.equal(store.getCloudStatus().signedIn,false);assert.equal(recordCalls,0);assert.deepEqual(idbData.get('current'),before);
 }
});

test('a stalled archive header or body returns a bounded retry error without caching partial history or replaying reads',async()=>{
 for(const stage of ['headers','body']){
  const before=await connected(),oldMark=localStorage.getItem('mouse-colony.cloud-cache-context.v1'),originalFetch=fetch,originalTimeout=setTimeout;let archiveCalls=0,signal;
  globalThis.setTimeout=(callback,delay,...args)=>originalTimeout(callback,delay===30000?5:delay,...args);
  globalThis.fetch=async(url,options)=>{const parsed=new URL(url);if(parsed.pathname.endsWith('/entity_records')&&parsed.searchParams.get('entity_type')==='eq.archive'){
   archiveCalls++;signal=options.signal;if(stage==='headers')return new Promise(()=>{});
   return {ok:true,status:200,text:()=>new Promise(()=>{})};
  }return originalFetch(url,options);};
  try{
   await assert.rejects(store.pullFromCloud(),/Cloud connection timed out/);
   assert.equal(archiveCalls,1);assert.equal(signal.aborted,true);assert.deepEqual(idbData.get('current'),before);assert.equal(localStorage.getItem('mouse-colony.cloud-cache-context.v1'),oldMark);assert.equal(store.getCloudStatus().readyForEdits,false);
  }finally{globalThis.setTimeout=originalTimeout;globalThis.fetch=originalFetch;}
  assert.deepEqual(await store.pullFromCloud(),before);
 }
});

test('a stalled refresh retains its expired session but grants no data until a successful live retry',async()=>{
 const before=await connected(),key='mouse-colony.session.v1',session=JSON.parse(sessionStorage.getItem(key));session.expires_at=1;sessionStorage.setItem(key,JSON.stringify(session));
 const expected=sessionStorage.getItem(key),originalFetch=fetch,originalTimeout=setTimeout;let refreshCalls=0;
 globalThis.setTimeout=(callback,delay,...args)=>originalTimeout(callback,delay===30000?5:delay,...args);
 globalThis.fetch=async(url,options)=>{if(new URL(url).pathname.endsWith('/token')){refreshCalls++;return new Promise(()=>{});}return originalFetch(url,options);};
 try{await assert.rejects(store.pullFromCloud(),/Cloud connection timed out/);assert.equal(refreshCalls,1);assert.equal(sessionStorage.getItem(key),expected);assert.equal(store.getCloudStatus().readyForEdits,false);assert.deepEqual(idbData.get('current'),before);}
 finally{globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimeout;}
 assert.deepEqual(await store.pullFromCloud(),before);
});

test('a stalled first password sign-in returns without persisting unverified credentials',async()=>{
 await fresh();const originalFetch=fetch,originalTimeout=setTimeout;
 globalThis.setTimeout=(callback,delay,...args)=>originalTimeout(callback,delay===30000?5:delay,...args);
 globalThis.fetch=async()=>new Promise(()=>{});
 try{await assert.rejects(store.signIn('demo@example.test','test-password'),/Cloud connection timed out/);assert.equal(store.getCloudStatus().signedIn,false);assert.equal(sessionStorage.getItem('mouse-colony.session.v1'),null);assert.equal(idbData.get('current'),undefined);}
 finally{globalThis.fetch=originalFetch;globalThis.setTimeout=originalTimeout;}
 await store.signIn('demo@example.test','test-password');assert.equal(store.getCloudStatus().signedIn,true);
});
