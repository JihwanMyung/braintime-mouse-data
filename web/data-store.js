import {clearHistoryIndex} from './history-index.js';
import { projectLocoboxExport } from './locobox-export.js?v=24';
import { PUBLIC_CONFIG } from './config.js';
import { validateManagerPermissions } from './permissions.js';
import { normalizeDataset, ID_FIELDS } from './model.js?v=73';
import {encodeArchive,decodeArchive,isArchiveChunk,partitionChanges,MAX_RPC_BYTES,utf8Size,ARCHIVE_MANIFEST_FORMAT} from './archive-format.js?v=48';

const CONFIG_KEY='mouse-colony.cloud.v1',SESSION_KEY='mouse-colony.session.v1',MODE_KEY='mouse-colony.mode.v1',DEMO_KEY='mouse-colony.trusted-demo.v1';
const CLOUD_CACHE_KEY='mouse-colony.cloud-cache-context.v1';
const SOURCE_PROJECTION_VERSION=2;
// Keep aligned with colony_private.managed_location_keys(). Raw Sheet blocks
// can include financial cells and must never enter a restricted cache or save.
const MANAGED_LOCATION_KEYS=new Set(['location_id','room_id','rack_id','label','row','column','capacity','locobox_id','active','state','manager','manager_acronym','notes','app_created_at','app_updated_at','app_modified_at','app_archived_at','archived','record_origin','evidence_status','requires_review','source_current','source_last_seen_at','source_snapshot_date','source_label_conflict','source_manager_name','source_manager_acronym','source_manager_status','source_observed_mouse_sids','source_observed_cage_sids','source_candidate_mouse_sids','source_candidate_cage_sids','source_unresolved_explicit_mouse_sids','source_observed_tags','source_cage_observation']);
const MANAGED=Object.keys(ID_FIELDS);
const clone=value=>structuredClone(value);
let feeVisibility=null,feeVisibilityContext=null;
let authGeneration=0;
const guardedCacheWrites=new Set(),CACHE_WRITE_KEY='current-cloud-write',BASELINE_CACHE_KEY='current-cloud-baseline';
const BASELINE_CACHE_VERSION=1,MAX_BASELINE_RECORDS=250000,MAX_BASELINE_BYTES=32*1024*1024;
let versions=new Map(),baseline=null,baselineIdentity=null,synced=false,refreshPromise=null,statusMessage='',pendingEmail=null,pullGeneration=0;
const memory=new Map();
const activeDatasetSaves=new Set();
const READ_DEPENDENCY_TYPES=new Set(['mice','cages','locations','rooms','racks']);
function getStorage(kind,key){try{return globalThis[kind]?.getItem(key)??null;}catch{return memory.get(`${kind}:${key}`)??null;}}
function setStorage(kind,key,value){try{if(!globalThis[kind])throw Error();value===null?globalThis[kind].removeItem(key):globalThis[kind].setItem(key,value);}catch{value===null?memory.delete(`${kind}:${key}`):memory.set(`${kind}:${key}`,value);}}
function readJSON(kind,key){try{return JSON.parse(getStorage(kind,key)||'null');}catch{return null;}}
const configuration=()=>readJSON('localStorage',CONFIG_KEY);
const session=()=>readJSON('sessionStorage',SESSION_KEY);
const pendingAccount=s=>s?.role==='pending'||s?.setupRequired===true;
const setupProfileAllowed=p=>!!p?.member&&(p.eligible===true&&p.setup_required===true||p.eligible!==true&&p.registration_allowed===true);
const mode=()=>getStorage('localStorage',MODE_KEY)==='cloud'?'cloud':'local';
function setMode(value){setStorage('localStorage',MODE_KEY,value);}
function invalidate(){synced=false;baseline=null;baselineIdentity=null;versions=new Map();}
function saveSession(s){setStorage('sessionStorage',SESSION_KEY,s?JSON.stringify(s):null);}
function stable(value){if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')}}`;return JSON.stringify(value);}
function advanceAuthGeneration(){authGeneration++;for(const cancel of guardedCacheWrites)cancel();return authGeneration;}
function beginAuthAction(){const generation=advanceAuthGeneration(),config=stable(configuration());const current=()=>generation===authGeneration&&stable(configuration())===config;return {current,check(){if(!current())throw new Error('The account or cloud configuration changed. Start sign-in again.');}};}

let dbPromise,dbHandle;
function storageTimeout(operation){const error=new Error(`Browser storage stopped responding while ${operation}. Close other Mouse Data tabs, then try again.`);error.storageTimeout=true;return error;}
function closeDatabase(db){try{db.close();}catch{}if(dbHandle===db){dbHandle=null;dbPromise=null;}}
function database(){
  if(!globalThis.indexedDB)return Promise.reject(new Error('Local database storage is unavailable in this browser.'));
  if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open('mouse-colony',1);let settled=false;
    const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>fail(storageTimeout('opening the saved workspace')),30000);
    request.onupgradeneeded=()=>{if(settled){try{request.transaction?.abort();}catch{}return;}if(!request.result.objectStoreNames.contains('datasets'))request.result.createObjectStore('datasets');};
    request.onerror=()=>fail(new Error('Unable to open the local colony database.'));
    request.onsuccess=()=>{if(settled){try{request.result.close();}catch{}return;}settled=true;clearTimeout(timer);dbHandle=request.result;dbHandle.onversionchange=()=>closeDatabase(request.result);resolve(request.result);};
    request.onblocked=()=>fail(new Error('Close older colony tabs before updating local storage.'));
  }).catch(e=>{dbPromise=null;throw e;});
  return dbPromise;
}
async function discardCloudWrite(id){
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('datasets','readwrite'),store=tx.objectStore('datasets'),request=store.get(CACHE_WRITE_KEY);let settled=false;
    const finish=(error=null)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>{const error=storageTimeout('checking the cloud cache');try{tx.abort();}catch{}finish(error);closeDatabase(db);},30000);
    request.onsuccess=()=>{if(!settled&&request.result?.id===id){store.delete('current');store.delete(CACHE_WRITE_KEY);store.delete(BASELINE_CACHE_KEY);}};
    tx.oncomplete=()=>finish();tx.onerror=tx.onabort=()=>finish(new Error('Unable to clear a cancelled cloud cache write.'));
  });
}
function ownCacheWrite(mark){
  const c=configuration(),s=session();
  return !!s?.access_token&&mark.url===c?.url&&mark.colony===c?.colonyId&&mark.user===s.user?.id;
}
async function local(action,value,{check,cacheWrite,syncBaseline=null,readBaseline=false}={}){
  const db=await database();check?.();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('datasets',action==='get'?'readonly':'readwrite'),store=tx.objectStore('datasets');
    const request=action==='get'?store.get('current'):action==='delete'?store.delete('current'):store.put(clone(value),'current');
    // The sidecar and dataset commit atomically. It never enters a dataset/export.
    const markRequest=action==='get'?store.get(CACHE_WRITE_KEY):cacheWrite?store.put(cacheWrite,CACHE_WRITE_KEY):store.delete(CACHE_WRITE_KEY);
    const baselineRequest=action==='get'?(readBaseline?store.get(BASELINE_CACHE_KEY):null):syncBaseline?store.put(syncBaseline,BASELINE_CACHE_KEY):store.delete(BASELINE_CACHE_KEY);
    let result,mark,savedBaseline,guardError,settled=false;
    const cleanup=()=>{clearTimeout(timer);guardedCacheWrites.delete(cancel);};
    const fail=error=>{if(settled)return;settled=true;cleanup();reject(error);};
    const cancel=()=>{if(settled)return;try{check?.();}catch(error){guardError=error;try{tx.abort();}catch{/* A committed write is removed by its own ID below. */}}};
    const timer=setTimeout(()=>{guardError=storageTimeout(action==='get'?'reading the saved workspace':'saving the workspace');try{tx.abort();}catch{}fail(guardError);closeDatabase(db);},30000);
    if(check)guardedCacheWrites.add(cancel);
    request.onsuccess=()=>{if(settled)return;result=request.result;cancel();};
    markRequest.onsuccess=()=>{if(settled)return;if(action==='get')mark=markRequest.result;cancel();};
    if(baselineRequest)baselineRequest.onsuccess=()=>{if(settled)return;if(action==='get')savedBaseline=baselineRequest.result;cancel();};
    tx.oncomplete=()=>{
      if(settled)return;settled=true;cleanup();
      try{
        check?.();if(guardError)throw guardError;
        if(action==='get'&&mark&&(!ownCacheWrite(mark)||mark.id!==readJSON('localStorage',CLOUD_CACHE_KEY)?.write_id)){
          // A matching but not-yet-published write may still be finishing. Hide it.
          // A previous account's write can be discarded by ID without touching a newer cache.
          if(!ownCacheWrite(mark)&&typeof mark.id==='string')void discardCloudWrite(mark.id).then(()=>resolve(null),()=>resolve(null));
          else resolve(null);
        }else resolve(readBaseline?{data:result??null,baseline:savedBaseline??null,mark:mark??null}:result??null);
      }
      catch(error){if(cacheWrite)void discardCloudWrite(cacheWrite.id).then(()=>reject(error),()=>reject(error));else reject(error);}
    };
    tx.onerror=()=>fail(guardError||new Error('Local database write failed. No save was confirmed.'));
    tx.onabort=()=>fail(guardError||new Error('Local database transaction was cancelled.'));
  });
}
export async function loadDataset(){
 if(session()?.passwordRecovery||pendingAccount(session()))return null;
 const generation=authGeneration;
 const d=await local('get');if(!d||generation!==authGeneration||session()?.passwordRecovery||pendingAccount(session()))return null;
 if(mode()==='cloud'||readJSON('localStorage',CLOUD_CACHE_KEY)){
  const c=configuration(),u=session()?.user?.id,previous=readJSON('localStorage',CLOUD_CACHE_KEY);
  if(!u||!c||(previous&&(previous.url!==c.url||previous.colony!==c.colonyId||previous.user!==u))){await local('delete');return null;}
  const policy=await refreshFeeVisibility({notify:false});
  if(!policy.source_archive_allowed&&!currentRestrictedCache(d,previous,policy))return pullFromCloud();
  if(policy.source_archive_allowed&&d.source_archive_restricted)return pullFromCloud();
 }
 if(generation!==authGeneration||session()?.passwordRecovery||pendingAccount(session()))return null;
 return normalizeDataset(d);
}
export async function clearDataset(){await local('delete');setStorage('localStorage',CLOUD_CACHE_KEY,null);setStorage('localStorage',DEMO_KEY,null);setMode('local');invalidate();statusMessage='Local dataset cleared.';}

function publicKey(key){
  if(typeof key!=='string'||!key.trim())throw new Error('A Supabase publishable or anon key is required.');
  if(key.startsWith('sb_secret_'))throw new Error('Secret and service-role keys must never be entered in the app.');
  if(key.startsWith('sb_publishable_'))return key;
  try{
    const part=key.split('.')[1];
    const claims=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));
    if(claims.role!=='anon')throw new Error();
  }catch{throw new Error('Use only the public anon or publishable key, never a service-role key.');}
  return key;
}
export function configureCloud({url,anonKey,colonyId}){
  const u=new URL(url);
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw new Error('Supabase URL must use HTTPS.');
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('Enter the Supabase project URL without credentials or a path.');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(colonyId??''))throw new Error('A valid colony UUID is required.');
  const config={url:u.origin,anonKey:publicKey(anonKey.trim()),colonyId};advanceAuthGeneration();
  setStorage('localStorage',DEMO_KEY,null);setStorage('localStorage',CONFIG_KEY,JSON.stringify(config));saveSession(null);pendingEmail=null;setMode('local');invalidate();statusMessage='Cloud configured. Sign in to connect.';
}
export function getCloudStatus(){
  const c=configuration(),s=session();
  return {configured:Boolean(c),signedIn:Boolean(s?.access_token),passwordRecovery:s?.passwordRecovery===true,passwordRecoveryUpdated:s?.passwordRecovery===true&&s?.passwordRecoveryUpdated===true,email:s?.user?.email??null,name:typeof s?.user?.user_metadata?.full_name==='string'?s.user.user_metadata.full_name:null,pendingEmail,message:statusMessage||(mode()==='cloud'&&!synced?'Pull cloud data before editing.':mode()==='cloud'?'Cloud connected.':'Changes are saved on this device.'),mode:mode(),readyForEdits:s?.passwordRecovery!==true&&!pendingAccount(s)&&(mode()==='local'||synced),colonyId:c?.colonyId??null,role:s?.role??null,permissions:s?.permissions??{},username:s?.username??null,setupRequired:s?.setupRequired===true,exportLevel:s?.role==='owner'?'max':s?.exportLevel??null,url:c?.url??'',anonKey:c?.anonKey??'',historyPath:c?.historyPath??null};
}
async function responseJSON(response){const text=await response.text();if(!text)return null;try{return JSON.parse(text);}catch{throw new Error('The cloud server returned an unreadable response.');}}
// Bound both headers and body reads. A stalled connection must return control
// to the sign-in/retry screen; it must never silently replay a write.
async function cloudJSON(url,options={}){
  const controller=new AbortController();let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
    const error=new Error('Cloud connection timed out. Retry when the connection is available.');
    error.connectionUnavailable=true;reject(error);controller.abort();
  },30000);});
  try{return await Promise.race([(async()=>{
    const response=await fetch(url,{...options,signal:controller.signal});
    return {response,result:await responseJSON(response)};
  })(),deadline]);}
  finally{clearTimeout(timer);}
}
function apiError(response,body){
  const message=body?.message||body?.error_description||body?.msg||body?.error||`Cloud request failed (${response.status}).`;
  if(response.status===409||body?.code==='40001')return Object.assign(new Error('This record changed in another session. Pull the latest cloud data and review your edit before trying again.'),{status:response.status});
  if(response.status===401)return Object.assign(new Error('The cloud session expired or sign-in was rejected. Sign in again.'),{status:401});
  if(response.status===403||body?.code==='42501')return Object.assign(new Error('Your account does not have permission for this cloud operation.'),{status:403});
  const error=Object.assign(new Error(String(message)),{status:response.status});
  // A cancelled query is not necessarily a timeout. Retry only this exact,
  // server-confirmed read failure, never network errors or permission failures.
  if(body?.code==='57014'&&message==='canceling statement due to statement timeout')error.statementTimeout=true;
  return error;
}
async function authRequest(route,body,token){
  const c=configuration();if(!c)throw new Error('Configure the cloud project first.');publicKey(c.anonKey);
  const {response,result}=await cloudJSON(`${c.url}/auth/v1/${route}`,{method:'POST',headers:{apikey:c.anonKey,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
  if(!response.ok){
    const message=result?.message||result?.error_description||result?.msg;
    if(route==='verify'&&message)throw new Error(String(message));
    const error=apiError(response,result);
    if(route==='token?grant_type=refresh_token'&&[400,401,403].includes(response.status))error.sessionRejected=true;
    throw error;
  }
  return result;
}
function normalizeSession(s){if(!s?.access_token||!s?.refresh_token)throw new Error('The server did not return a complete session.');return {...s,expires_at:s.expires_at??Math.floor(Date.now()/1000)+(s.expires_in??3600)};}
async function accessToken(){
  let s=session();if(!s?.access_token)throw new Error('Sign in before using cloud data.');
  if(s.expires_at<=Date.now()/1000+60){
    const generation=authGeneration,config=stable(configuration());const current=()=>generation===authGeneration&&config===stable(configuration())&&session()?.user?.id===s.user?.id;
    if(!refreshPromise)refreshPromise=authRequest('token?grant_type=refresh_token',{refresh_token:s.refresh_token}).then(result=>{if(!current())throw new Error('The account changed during session refresh.');const next={...normalizeSession(result),passwordRecovery:s.passwordRecovery===true,passwordRecoveryUpdated:s.passwordRecoveryUpdated===true,role:s.role,permissions:s.permissions,username:s.username,setupRequired:s.setupRequired,exportLevel:s.exportLevel};saveSession(next);return next;}).catch(e=>{if(current()){invalidate();if(e.sessionRejected===true)saveSession(null);else statusMessage='Cloud connection unavailable. Reconnect before editing.';}throw e;}).finally(()=>{refreshPromise=null;});
    s=await refreshPromise;
  }
  return s.access_token;
}
async function request(route,{method='GET',body}={}){
  if(session()?.passwordRecovery)throw new Error('Finish resetting your password before opening colony data.');
  const c=configuration();if(!c)throw new Error('Configure the cloud project first.');publicKey(c.anonKey);
  const token=await accessToken();
  const {response,result}=await cloudJSON(`${c.url}/rest/v1/${route}`,{method,cache:'no-store',redirect:'error',headers:{apikey:c.anonKey,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(method==='POST'?{Prefer:'return=representation'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok)throw apiError(response,result);return result;
}
async function membership(action){
  const c=configuration(),s=session();
  if(!s?.user?.id)throw new Error('The signed-in user is unavailable. Sign in again.');
  const rows=await request(`memberships?select=role,active,export_level,permissions&user_id=eq.${encodeURIComponent(s.user.id)}&colony_id=eq.${encodeURIComponent(c.colonyId)}`);
  if(!Array.isArray(rows)||rows.length!==1||rows[0].active!==true||!['owner','manager','editor','viewer'].includes(rows[0].role))throw new Error('This account is not an active member of the configured colony.');
  if(configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==s.user.id)throw new Error('The cloud account or colony changed. Sign in again.');
  action?.check();
  saveSession({...session(),role:rows[0].role,permissions:rows[0].permissions||{},setupRequired:false,exportLevel:rows[0].role==='owner'?'max':rows[0].export_level||'low'});return rows[0].role;
}
// A live, data-free access check for the internal tools portal. Cached roles
// alone never unlock the portal; no animal records or roster are requested.
export async function verifyCloudMembership(){
  const initial=session(),c=configuration();
  if(!c||!initial?.user?.id)throw new Error('Sign in to open lab tools.');
  if(initial.passwordRecovery)throw new Error('Finish resetting your password before opening lab tools.');
  if(initial.setupRequired||initial.role==='pending')throw new Error('Finish your account setup before opening lab tools.');
  const action=beginAuthAction(),token=await accessToken();action.check();
  const {response,result:user}=await cloudJSON(`${c.url}/auth/v1/user`,{headers:{apikey:publicKey(c.anonKey),Authorization:`Bearer ${token}`},cache:'no-store',redirect:'error'});
  action.check();
  if(!response.ok||user?.id!==initial.user.id||user.is_anonymous||!user.email_confirmed_at)throw new Error('Your sign-in could not be verified. Sign in again.');
  await membership(action);action.check();
  return getCloudStatus();
}
// Shared lab-tool transport; authorization and history limits are enforced again by each RPC.
const REAGENT_ACTIONS=new Set(['list','save','history','sources','observations','import','record_usage','access','set_access',
 'order_search','order_list','order_submit','order_transition','order_locations','order_set_location','order_import_offers']);
export async function callReagents(action,args={}){
 if(!REAGENT_ACTIONS.has(action)||!args||Array.isArray(args)||typeof args!=='object')throw new Error('Unsupported reagent operation.');
 const generation=authGeneration,c=configuration(),identity=session()?.user?.id;
 const denied=message=>Object.assign(new Error(message),{reagentsAccessChanged:true});
 if(!c||!identity||session()?.setupRequired||session()?.role==='pending'||session()?.passwordRecovery)throw denied('Sign in and complete your account before opening Reagents.');
 const check=()=>{if(generation!==authGeneration||configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==identity)throw denied('Your account changed. Reopen Reagents.');};
 try{await membership({check});check();}catch(error){error.reagentsAccessChanged=true;throw error;}
 try{const result=await request('rpc/reagents_'+action,{method:'POST',body:{...args,p_colony_id:c.colonyId}});check();return result;}
 catch(error){check();if(/session expired|sign.in|permission for this cloud operation/i.test(error.message))error.reagentsAccessChanged=true;throw error;}
}
async function establishMembershipOrSetup(action){
  const c=configuration(),s=session();
  const rows=await request(`memberships?select=role,active,export_level,permissions&user_id=eq.${encodeURIComponent(s.user.id)}&colony_id=eq.${encodeURIComponent(c.colonyId)}`);
  action?.check();if(!Array.isArray(rows))throw new Error('Unable to verify colony access.');
  if(rows.length){await membership();return;}
  const profile=await request('rpc/get_my_lab_member',{method:'POST',body:{p_colony_id:c.colonyId}});
  action?.check();if(!setupProfileAllowed(profile))throw new Error('This account is not an active member of the configured colony.');
  saveSession({...session(),role:'pending',setupRequired:true});
}
export async function signIn(email,password){
  if(typeof email!=='string'||typeof password!=='string'||!email.trim()||!password)throw new Error('Enter your email or username and password.');
  const action=beginAuthAction();saveSession(null);invalidate();let result;
  if(email.includes('@'))result=await authRequest('token?grant_type=password',{email:email.trim(),password});
  else {
    const c=configuration();if(!c)throw new Error('Configure the cloud project first.');
    const defaultGateway=c.url===PUBLIC_CONFIG.url&&c.colonyId===PUBLIC_CONFIG.colonyId?PUBLIC_CONFIG.usernameAnonKey:null;
    const anonKey=publicKey(c.anonKey.startsWith('sb_publishable_')&&defaultGateway?defaultGateway:c.anonKey);
    if(anonKey.startsWith('sb_publishable_'))throw new Error('Username sign-in requires the project’s public legacy anon key. Use your email to sign in, or ask the owner to update the app configuration.');
    const {response,result:reply}=await cloudJSON(`${c.url}/functions/v1/username-sign-in`,{method:'POST',cache:'no-store',redirect:'error',headers:{apikey:anonKey,Authorization:`Bearer ${anonKey}`,'Content-Type':'application/json'},body:JSON.stringify({username:email.trim(),password})});
    result=reply;if(!response.ok)throw new Error(result?.message||'Username sign-in was rejected.');
  }
  action.check();saveSession(normalizeSession(result));invalidate();
  try{await establishMembershipOrSetup(action);action.check();statusMessage='Signed in.';}catch(e){if(action.current()){saveSession(null);statusMessage=e.message;}throw e;}
  return getCloudStatus();
}
function emailAddress(email){
  if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email.trim()))throw new Error('Enter a valid email address.');
  return email.trim();
}
export async function requestEmailCode(email){
  const address=emailAddress(email),action=beginAuthAction();
  // Supabase's email template must include {{ .Token }} for the code entry flow.
  await authRequest('otp',{email:address,create_user:false});action.check();
  pendingEmail=address;statusMessage='Email code requested. Check your inbox and enter the code.';
  return {email:address,message:statusMessage};
}
function appEmailRedirect(redirectTo){
  const app=globalThis.location;
  let redirect;try{redirect=new URL(redirectTo);}catch{throw new Error('A valid app return URL is required.');}
  const local=['localhost','127.0.0.1','[::1]'].includes(redirect.hostname);
  if(!app?.origin||redirect.origin!==app.origin||redirect.username||redirect.password||redirect.search||redirect.hash||(redirect.protocol!=='https:'&&!(local&&redirect.protocol==='http:')))throw new Error('The sign-in link must return to this app without query parameters or a fragment.');
  return redirect.href;
}
export async function requestEmailLink(email,redirectTo){
  const address=emailAddress(email),redirect=appEmailRedirect(redirectTo),action=beginAuthAction();
  await authRequest(`otp?redirect_to=${encodeURIComponent(redirect)}`,{email:address,create_user:false});action.check();
  pendingEmail=address;statusMessage='Sign-in link requested. Open the link from your email on the device you want to use.';
  return {email:address,message:statusMessage};
}
/** Explicit registration only. Email verification creates no lab membership. */
export async function requestRegistrationEmail(email){
  const address=emailAddress(email),app=globalThis.location;
  const redirect=appEmailRedirect(app?.origin&&app?.pathname?app.origin+app.pathname:''),action=beginAuthAction();
  await authRequest(`otp?redirect_to=${encodeURIComponent(redirect)}`,{email:address,create_user:true});action.check();
  pendingEmail=address;statusMessage='Verification email requested. Open the link to submit your registration.';
  return {email:address,message:statusMessage};
}
export async function consumeAuthCallback(){
  const location=globalThis.location,fragment=new URLSearchParams((location?.hash??'').replace(/^#/,''));
  if(!['access_token','refresh_token','error','error_description','error_code'].some(key=>fragment.has(key)))return null;
  const action=beginAuthAction();
  // Remove credentials from the address and history before doing any asynchronous
  // work. Never place callback tokens in logs, DOM text, or persistent storage.
  try{globalThis.history.replaceState(globalThis.history.state,'',`${location.pathname}${location.search}`);}
  catch{saveSession(null);invalidate();throw new Error('Unable to clear the sign-in callback from the address. Close this tab and request a new link.');}
  saveSession(null);invalidate();
  try{
    if(fragment.has('error')||fragment.has('error_code'))throw new Error('This sign-in link is invalid or has expired. Request a new link.');
    const c=configuration();if(!c)throw new Error('Configure this app’s cloud project, then request a new sign-in link.');
    publicKey(c.anonKey);
    const access=fragment.get('access_token'),refresh=fragment.get('refresh_token'),type=fragment.get('type');
    if(!access||!refresh||(fragment.get('token_type')??'bearer').toLowerCase()!=='bearer'||(type&&!['magiclink','invite','signup','recovery','email'].includes(type)))throw new Error('The sign-in callback is incomplete or unsupported. Request a new link.');
    let claims;
    try{claims=JSON.parse(atob(access.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));}catch{throw new Error('The sign-in token is invalid. Request a new link.');}
    if(claims.iss!==`${c.url}/auth/v1`||claims.role!=='authenticated'||!(Array.isArray(claims.aud)?claims.aud:[claims.aud]).includes('authenticated')||typeof claims.sub!=='string'||!Number.isFinite(claims.exp)||claims.exp<=Date.now()/1000)throw new Error('This sign-in link is expired or belongs to a different cloud project.');
    const headers={apikey:c.anonKey,Authorization:`Bearer ${access}`};
    const {response:verified,result:user}=await cloudJSON(`${c.url}/auth/v1/user`,{headers,cache:'no-store'});
    action.check();if(!verified.ok)throw new Error('The cloud project rejected this sign-in link. Request a new link.');
    action.check();
    if(user?.id!==claims.sub||user.is_anonymous)throw new Error('The cloud project could not verify this account.');
    const {response:membershipResponse,result:rows}=await cloudJSON(`${c.url}/rest/v1/memberships?select=role,active,export_level,permissions&user_id=eq.${encodeURIComponent(user.id)}&colony_id=eq.${encodeURIComponent(c.colonyId)}`,{headers,cache:'no-store'});
    action.check();if(!membershipResponse.ok)throw new Error('Unable to verify colony membership. Sign in again or contact the colony owner.');
    action.check();
    let pendingSetup=false;
    if(Array.isArray(rows)&&rows.length===0){
      const {response:profileResponse,result:profile}=await cloudJSON(`${c.url}/rest/v1/rpc/get_my_lab_member`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({p_colony_id:c.colonyId})});
      action.check();pendingSetup=profileResponse.ok&&setupProfileAllowed(profile);
    }
    if(!pendingSetup&&(!Array.isArray(rows)||rows.length!==1||rows[0].active!==true||!['owner','manager','editor','viewer'].includes(rows[0].role)))throw new Error('This account is not an active member of the configured colony.');
    const member=rows[0]||{role:'pending',permissions:{},export_level:null};
    action.check();
    if(type==='recovery'){await local('delete');await clearHistoryIndex();action.check();setStorage('localStorage',CLOUD_CACHE_KEY,null);}
    // A local JWT decode only checks scope; the current project's Auth endpoint
    // authenticates the token. Persist only after that and membership both pass.
    saveSession({access_token:access,refresh_token:refresh,token_type:'bearer',expires_at:claims.exp,user,role:member.role,passwordRecovery:type==='recovery',permissions:type==='recovery'?{}:member.permissions||{},setupRequired:pendingSetup,exportLevel:pendingSetup?null:member.role==='owner'?'max':member.export_level||'low'});
    pendingEmail=null;statusMessage=type==='recovery'?'Set a new password to finish account recovery.':'Signed in. Pull the shared colony to continue.';
    return {...getCloudStatus(),needsPasswordSetup:pendingSetup||type==='invite'||type==='recovery'};
  }catch(error){
    if(!action.current())throw new Error('The account or cloud configuration changed. Start sign-in again.');
    saveSession(null);invalidate();
    statusMessage=error instanceof TypeError?'The sign-in link could not be verified because the cloud is unreachable. Request a new link when connected.':error.message;
    throw new Error(statusMessage);
  }
}
export async function verifyEmailCode(email,token){
  const address=emailAddress(email),code=typeof token==='string'?token.trim():'';
  if(!/^\d{6,10}$/.test(code))throw new Error('Enter the numeric verification code from your email.');
  const action=beginAuthAction();saveSession(null);invalidate();const result=normalizeSession(await authRequest('verify',{email:address,token:code,type:'email'}));
  action.check();saveSession(result);invalidate();
  try{await establishMembershipOrSetup(action);action.check();pendingEmail=null;statusMessage='Signed in. Pull the shared colony to continue.';}
  catch(e){if(action.current()){saveSession(null);invalidate();statusMessage=e.message;}throw e;}
  return getCloudStatus();
}
export async function signOut(){
  advanceAuthGeneration();const s=session(),wasCloud=mode()==='cloud'||Boolean(readJSON('localStorage',CLOUD_CACHE_KEY));saveSession(null);pendingEmail=null;setMode('local');invalidate();feeVisibility=null;feeVisibilityContext=null;if(wasCloud){await local('delete');setStorage('localStorage',CLOUD_CACHE_KEY,null);await clearHistoryIndex();}statusMessage=wasCloud?'Signed out. Shared data cleared from this device.':'Signed out. Local data is retained.';
  if(s?.access_token)try{await authRequest('logout',null,s.access_token);}catch{/* Local credentials are already removed even if the server is unreachable. */}
}

export async function updateAccountPassword(password) {return updateAccountPasswordVerified(password);}
async function updateAccountPasswordVerified(password,verifiedSetup=null) {
  const c=configuration(),signedIn=session(),generation=authGeneration;
  if(!c)throw new Error('Configure the cloud project first.');
  if(!signedIn?.access_token||!signedIn.user?.id)throw new Error('Sign in before changing your account password.');
  if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('Use an account password between 12 and 128 characters.');
  if(signedIn.passwordRecovery)throw new Error('Use the password recovery form to finish resetting your password.');
  if(signedIn.role==='pending'){
    const verified=verifiedSetup?.actor===signedIn.user.id&&verifiedSetup.generation===generation&&verifiedSetup.url===c.url&&verifiedSetup.colonyId===c.colonyId;
    if(!verified){const mine=await getMyLabMember();if(!mine?.eligible||!mine.setup_required)throw new Error('Your account is not eligible for first-time setup.');}
  }else await membership();
  const token=await accessToken(),current=configuration();
  if(current?.url!==c.url||current.colonyId!==c.colonyId||session()?.user?.id!==signedIn.user.id)throw new Error('The cloud account or colony changed. Sign in again before changing your password.');
  let response,result;
  try {
    ({response,result}=await cloudJSON(`${c.url}/auth/v1/user`,{method:'PUT',cache:'no-store',redirect:'error',headers:{apikey:publicKey(c.anonKey),Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({password})}));
  }catch(error){const safe=new Error('The account-password update was not confirmed. Check your connection before trying again.');safe.connectionUnavailable=error?.connectionUnavailable===true||error instanceof TypeError;throw safe;}
  if(generation!==authGeneration||configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==signedIn.user.id)throw new Error('The account changed. Sign in again before changing your password.');
  if(!response.ok) {
    if(response.status===401||response.status===403)throw apiError(response,null);
    // Do not echo an Auth error body, which could contain a rejected credential.
    throw new Error('The account-password update was rejected. Use a different password or sign in again if a recent login is required.');
  }
  if(result?.id!==signedIn.user.id)throw new Error('The server did not confirm the account-password update for your signed-in user.');
  // Auth responses are deliberately not persisted; only the existing session remains.
  return {user_id:result.id,message:'Account password updated.'};
}

export async function updateAccountProfile(name) {
  const c=configuration(),signedIn=session();
  if(!c)throw new Error('Configure the cloud project first.');
  if(!signedIn?.access_token||!signedIn.user?.id)throw new Error('Sign in before updating your account profile.');
  if(typeof name!=='string'||!name.trim()||name.trim().length>120)throw new Error('Enter a name between 1 and 120 characters.');
  const fullName=name.trim();
  await membership();
  const token=await accessToken(),current=configuration();
  if(current?.url!==c.url||current.colonyId!==c.colonyId||session()?.user?.id!==signedIn.user.id)throw new Error('The cloud account or colony changed. Sign in again before updating your profile.');
  let response;
  try {
    // GoTrue merges the supplied user metadata; no ownership or access role is sent.
    response=await fetch(`${c.url}/auth/v1/user`,{method:'PUT',cache:'no-store',redirect:'error',headers:{apikey:publicKey(c.anonKey),Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({data:{full_name:fullName}})});
  }catch{throw new Error('The profile update was not confirmed. Check your connection before trying again.');}
  const result=await responseJSON(response);
  if(!response.ok)throw apiError(response,result);
  if(result?.id!==signedIn.user.id||result.user_metadata?.full_name!==fullName)throw new Error('The server did not confirm the new name for your signed-in user.');
  const activeSession=session(),activeConfig=configuration();
  if(activeSession?.user?.id!==signedIn.user.id||activeConfig?.url!==c.url||activeConfig.colonyId!==c.colonyId)throw new Error('Your account changed while saving. Sign in again to load the updated profile.');
  saveSession({...activeSession,user:result});
  return {user_id:result.id,name:fullName,message:'Account profile updated.'};
}
const feeRecord=r=>r?.entity_type==='husbandry_events'&&(/^(lac_fee|fee|fees|billing)_/.test(r.payload?.event_type||'')||['animal_sheet_cage_snapshot','animal_sheet_source_change'].includes(r.payload?.event_type)||['source_cage_snapshot','animal_sheet_change','lac_fee_options','lac_fee_month','fee_options','fee_month','fee_actual','fees','billing','billing_options','billing_month'].some(k=>Object.hasOwn(r.payload||{},k)));
function checkedFeeVisibility(value){
 if(!value||!Number.isInteger(value.version)||value.version<0||typeof value.owner!=='boolean'||typeof value.estimate!=='boolean'||typeof value.actual!=='boolean'||value.source_archive_allowed!==(value.estimate&&value.actual))throw new Error('Fee visibility could not be verified. Reconnect before loading financial data.');
 return value;
}
function validCageObservation(value){
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),keys=(v,list)=>object(v)&&Object.keys(v).length===list.length&&list.every(k=>Object.hasOwn(v,k));
 const nullable=(v,fn)=>v===null||fn(v),text=(v,max)=>typeof v==='string'&&v.length<=max,cell=v=>nullable(v,x=>typeof x==='string'&&/^[A-Z]{1,3}[1-9]\d{0,5}$/.test(x));
 const date=v=>nullable(v,x=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;const ms=Date.parse(x+'T00:00:00Z');return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===x;});
 if(!keys(value,['schemaVersion','animals','startedDate','intensityLux','managerName','managerCell','startedCell','intensityCell'])||value.schemaVersion!==1||!Array.isArray(value.animals)||value.animals.length>100||!date(value.startedDate)||!nullable(value.intensityLux,x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1000000)||!nullable(value.managerName,x=>text(x,160))||!['managerCell','startedCell','intensityCell'].every(k=>cell(value[k])))return false;
 return value.animals.every(a=>keys(a,['key','tag','note','dateOfBirth','earMark','left','right','sex','sourceCell','requiresReview'])&&text(a.key,512)&&a.key.length>0&&text(a.tag,240)&&a.tag.length>0&&text(a.note,2000)&&date(a.dateOfBirth)&&nullable(a.earMark,x=>typeof x==='string'&&/^L\d{1,2}R\d{1,2}$/.test(x))&&['left','right'].every(k=>nullable(a[k],x=>Number.isInteger(x)&&x>=0&&x<=99))&&nullable(a.sex,x=>['Male','Female'].includes(x))&&cell(a.sourceCell)&&typeof a.requiresReview==='boolean'&&(a.earMark===null||a.left===null||a.right===null||a.earMark===`L${a.left}R${a.right}`));
}
function managedLocationPayload(payload){return payload&&typeof payload==='object'&&!Array.isArray(payload)&&Object.keys(payload).every(key=>MANAGED_LOCATION_KEYS.has(key))&&(!Object.hasOwn(payload,'source_cage_observation')||payload.source_cage_observation===null||validCageObservation(payload.source_cage_observation));}
function currentRestrictedCache(data,mark,policy){
 return data?.source_archive_restricted===true&&data.source_projection_version===SOURCE_PROJECTION_VERSION&&mark?.source_projection_version===SOURCE_PROJECTION_VERSION&&mark.estimate===policy.estimate&&mark.actual===policy.actual&&(data.tables?.locations||[]).every(managedLocationPayload);
}
function sameFeeVisibility(a,b){return a.version===b.version&&a.estimate===b.estimate&&a.actual===b.actual&&a.source_archive_allowed===b.source_archive_allowed;}
function checkedManagedLocation(row,colonyId){
 if(row?.entity_type!=='locations'||row.colony_id!==colonyId||typeof row.entity_id!=='string'||!row.entity_id||!Number.isInteger(row.version)||row.version<1||typeof row.archived!=='boolean'||!managedLocationPayload(row.payload)||row.payload.location_id!==row.entity_id||Boolean(row.payload.app_archived_at)!==row.archived)throw new Error('Invalid projected location record. Pull the latest cloud data.');
 return row;
}
async function refreshFeeVisibility({notify=true}={}){
 const generation=authGeneration,context=exportContext(),c=configuration();if(!c||!session()?.access_token)throw new Error('Sign in before loading shared fee visibility.');
 const check=()=>{if(generation!==authGeneration)throw new Error('The account or colony changed during loading. Open the shared colony again.');checkExportContext(context);};
 const value=checkedFeeVisibility(await request('rpc/get_lac_fee_visibility',{method:'POST',body:{p_colony_id:c.colonyId}}));check();
 const previousPolicy=feeVisibility,changed=feeVisibilityContext!==context||!feeVisibility||feeVisibility.estimate!==value.estimate||feeVisibility.actual!==value.actual;
 feeVisibility=value;feeVisibilityContext=context;
 // A projected baseline cannot become a full replacement when access expands.
 // Reload the previously withheld fields before allowing another cloud edit.
 if(previousPolicy?.source_archive_allowed===false&&value.source_archive_allowed)invalidate();
 if(!value.source_archive_allowed){
  const cached=await local('get',undefined,{check});check();const mark=readJSON('localStorage',CLOUD_CACHE_KEY),validCache=currentRestrictedCache(cached,mark,value)&&mark.url===c.url&&mark.colony===c.colonyId&&mark.user===session()?.user?.id;
  if(changed||!validCache){
  check();invalidate();if(!validCache)await local('delete',undefined,{check});check();
  await clearHistoryIndex({check,registerCancel:cancel=>{guardedCacheWrites.add(cancel);return()=>guardedCacheWrites.delete(cancel);}});check();
  if(notify&&globalThis.dispatchEvent&&globalThis.CustomEvent)globalThis.dispatchEvent(new CustomEvent('lac-fee-visibility-changed',{detail:{estimate:value.estimate,actual:value.actual,source_archive_allowed:false}}));
  }
 }
 return clone(value);
}
export async function getLacFeeVisibility(){
 if(mode()==='local'&&(!configuration()||getStorage('localStorage',DEMO_KEY)==='true'))return {version:0,owner:false,estimate:true,actual:true,source_archive_allowed:true,local:true};
 await membership();return refreshFeeVisibility();
}
export async function saveLacFeeVisibility({version,levels}){
 await membership();const context=exportContext(),c=configuration();
 if(session()?.role!=='owner')throw new Error('Only the owner can change fee visibility.');
 const value=checkedFeeVisibility(await request('rpc/save_lac_fee_visibility',{method:'POST',body:{p_colony_id:c.colonyId,p_version:version,p_levels:levels}}));checkExportContext(context);feeVisibility=value;feeVisibilityContext=context;return clone(value);
}
async function readCloudPage(read,limit,check){
  while(true){
    check();
    try{const page=await read(limit);check();return {page,limit};}
    catch(error){
      check();
      if(error.statementTimeout!==true||limit<=1)throw error;
      // Keep the same cursor/offset: the failed query returned no usable records.
      // Retain the smaller page size for the rest of this stream.
      limit=Math.max(1,Math.floor(limit/2));
    }
  }
}
// A verified baseline can save network traffic, never authorize access.
// Membership and visibility are checked anew before any of these rows are reused.
function persistentIdentity(){const s=session();return stable({configuration:configuration(),user:s?.user?.id,role:s?.role,permissions:s?.permissions,exportLevel:s?.exportLevel});}
function syncIdentity(){return stable({generation:authGeneration,identity:persistentIdentity()});}
async function cacheDigest(value){
  const bytes=new TextEncoder().encode(stable(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
}
async function mapBounded(values,fn,check){
  const result=new Array(values.length);let next=0,failure=null;
  async function worker(){try{while(true){check();if(failure)throw failure;const index=next++;if(index>=values.length)return;result[index]=await fn(values[index],index);check();}}catch(error){failure??=error;throw error;}}
  await Promise.all(Array.from({length:Math.min(16,values.length)},()=>worker()));check();return result;
}
const ordinaryManagedRecord=row=>MANAGED.includes(row?.entity_type)&&row.entity_type!=='locations'&&!feeRecord(row);
async function baselineEnvelope(rows,writeId,check,recordVersions=versions){
  const policy=clone(feeVisibility),identity=persistentIdentity();
  if(!policy.source_archive_allowed)rows=rows.filter(ordinaryManagedRecord);
  if(rows.length>MAX_BASELINE_RECORDS)return null;
  const entries=await mapBounded(rows,async row=>{
    const version=row.version??recordVersions.get(recordKey(row));
    if(!Number.isSafeInteger(version)||version<1)throw new Error('The saved cloud version could not be verified. Pull again.');
    // Archive IDs are already SHA-256 hashes of their canonical payloads.
    return [row.entity_type,row.entity_id,version,row.archived,isArchiveChunk(row)?row.entity_id.slice(6):await cacheDigest(row.payload)];
  },check);
  const body={schema_version:BASELINE_CACHE_VERSION,projection_version:SOURCE_PROJECTION_VERSION,write_id:writeId,identity,policy,entries};
  if(utf8Size(body)>MAX_BASELINE_BYTES)return null;
  const sha256=await cacheDigest(body);check();
  if(identity!==persistentIdentity()||stable(policy)!==stable(feeVisibility))throw new Error('Cloud access changed while preparing the saved workspace. Pull again.');
  return {...body,sha256};
}
async function persistedBaseline(policy,check){
  const snapshot=await local('get',undefined,{check,readBaseline:true});check();
  const envelope=snapshot?.baseline,mark=readJSON('localStorage',CLOUD_CACHE_KEY);
  if(!snapshot?.data||!envelope||envelope.schema_version!==BASELINE_CACHE_VERSION||envelope.projection_version!==SOURCE_PROJECTION_VERSION||typeof envelope.write_id!=='string'||envelope.write_id!==snapshot.mark?.id||envelope.write_id!==mark?.write_id||envelope.sha256!==mark?.baseline_sha256||envelope.identity!==persistentIdentity()||stable(envelope.policy)!==stable(policy)||!Array.isArray(envelope.entries)||envelope.entries.length>MAX_BASELINE_RECORDS)return null;
  if(policy.source_archive_allowed?snapshot.data.source_archive_restricted:!currentRestrictedCache(snapshot.data,mark,policy))return null;
  try{
    const {sha256,...body}=envelope;
    if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||utf8Size(body)>MAX_BASELINE_BYTES||await cacheDigest(body)!==sha256)return null;check();
    const indexed=new Map();
    for(const entry of envelope.entries){
      if(!Array.isArray(entry)||entry.length!==5||![...MANAGED,'archive'].includes(entry[0])||typeof entry[1]!=='string'||!entry[1]||!Number.isSafeInteger(entry[2])||entry[2]<1||typeof entry[3]!=='boolean'||typeof entry[4]!=='string'||!/^[a-f0-9]{64}$/.test(entry[4]))return null;
      if(!policy.source_archive_allowed&&['archive','locations'].includes(entry[0]))return null;
      const key=recordKey({entity_type:entry[0],entity_id:entry[1]});if(indexed.has(key))return null;indexed.set(key,entry);
    }
    // Reconstruct from the same atomically saved workspace. Normalization can
    // legitimately add defaults: mismatched rows are fetched afresh, not guessed.
    const candidates=await entityRecords(snapshot.data);check();const records=new Map(),knownVersions=new Map();
    await mapBounded(candidates,async row=>{
      if(!policy.source_archive_allowed&&!ordinaryManagedRecord(row))return;
      const key=recordKey(row),entry=indexed.get(key);if(!entry||entry[3]!==row.archived)return;
      const digest=isArchiveChunk(row)?row.entity_id.slice(6):await cacheDigest(row.payload);if(digest!==entry[4])return;
      records.set(key,row);knownVersions.set(key,entry[2]);
    },check);
    return {records,versions:knownVersions,identity:syncIdentity(),policy:clone(policy)};
  }catch(error){check();return null;}
}
function checkedCloudRecord(row,type,c,payload=true){
  // PostgreSQL btrim(id) excludes only ordinary spaces, not tabs/NBSP.
  if(!row||typeof row.colony_id!=='string'||row.colony_id.toLowerCase()!==c.colonyId.toLowerCase()||row.entity_type!==type||typeof row.entity_id!=='string'||!row.entity_id.length||row.entity_id.startsWith(' ')||row.entity_id.endsWith(' ')||[...row.entity_id].length>200||!Number.isSafeInteger(row.version)||row.version<1||typeof row.archived!=='boolean'||payload&&(!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||type!=='archive'&&row.payload[ID_FIELDS[type]]!==row.entity_id))throw new Error('Cloud page contains an invalid or unrelated record.');
  return row;
}
function reusableRecord(reuse,row,c){
  const key=recordKey(row),cached=reuse?.records.get(key);
  if(!cached||reuse.versions.get(key)!==row.version||cached.archived!==row.archived)return null;
  return checkedCloudRecord({...cached,colony_id:c.colonyId,version:row.version},row.entity_type,c);
}
async function managedVersionIndex(type,c,check){
  const index=new Map();let cursor=null,limit=1000;
  while(true){
    const loaded=await readCloudPage(size=>{
      const query=new URLSearchParams({select:'colony_id,entity_type,entity_id,version,archived',colony_id:`eq.${c.colonyId}`,entity_type:`eq.${type}`,order:'entity_id.asc',limit:String(size)});
      if(cursor!==null)query.set('entity_id',`gt.${cursor}`);return request(`entity_records?${query}`);
    },limit,check);const page=loaded.page;limit=loaded.limit;
    if(!Array.isArray(page)||page.length>limit)throw new Error('Cloud records were not returned as a valid page.');
    for(const row of page){checkedCloudRecord(row,type,c,false);if(index.has(row.entity_id))throw new Error('Cloud page cursor did not advance. Pull again.');index.set(row.entity_id,row);}
    if(page.length<limit)break;cursor=page.at(-1).entity_id;
  }
  return index;
}
async function incrementalManaged(type,c,check,reuse,restricted=false){
  const index=await managedVersionIndex(type,c,check),rows=new Map(),pending=[],reused=new Set();
  for(const row of index.values()){const cached=reusableRecord(reuse,row,c);if(cached&&(!restricted||ordinaryManagedRecord(cached))){rows.set(row.entity_id,cached);reused.add(row.entity_id);}else pending.push(row);}
  let next=0,failure=null;
  const active=()=>{check();if(failure)throw failure;};
  async function worker(){try{while(true){active();const expected=pending[next++];if(!expected)return;
    // An equality parameter keeps punctuation and Unicode IDs literal. Fetching
    // only changed records also avoids a large repeated historical payload.
    const query=new URLSearchParams({select:'colony_id,entity_type,entity_id,payload,version,archived',colony_id:`eq.${c.colonyId}`,entity_type:`eq.${type}`,entity_id:`eq.${expected.entity_id}`,limit:'1'});
    const page=(await readCloudPage(()=>request(`entity_records?${query}`),1,active)).page;
    if(!Array.isArray(page)||page.length!==1)throw new Error('A changed cloud record is missing. Pull again.');
    const row=checkedCloudRecord(page[0],type,c);if(row.entity_id!==expected.entity_id||row.version!==expected.version||row.archived!==expected.archived)throw new Error('A cloud record changed during loading. Pull again.');
    rows.set(row.entity_id,row);
  }}catch(error){failure??=error;throw error;}}
  await Promise.all(Array.from({length:Math.min(3,pending.length)},()=>worker()));check();
  // Never silently merge against an index that changed while payloads arrived.
  const final=await managedVersionIndex(type,c,check);
  if(final.size!==index.size||[...index].some(([id,row])=>final.get(id)?.version!==row.version||final.get(id)?.archived!==row.archived))throw new Error('Cloud records changed during loading. Pull again.');
  const result=[...index.keys()].map(id=>rows.get(id)).filter(row=>!restricted||ordinaryManagedRecord(row));result.reused=result.filter(row=>reused.has(row.entity_id)).length;return result;
}
// Only the manifest-selected chunks are needed to reconstruct a workspace.
// Keep a small version index for old immutable chunks so a later archive edit
// can safely reuse a previously staged chunk without blindly recreating it.
async function selectedArchive(c,check,onLoaded,reuse=null){
  const fields='colony_id,entity_type,entity_id,payload,version,archived';
  const query=(select,limit,filter)=>new URLSearchParams({select,colony_id:`eq.${c.colonyId}`,entity_type:'eq.archive',order:'entity_id.asc',limit:String(limit),...(filter?{entity_id:filter}:{})});
  const valid=(row,payload=false)=>{
    if(!row||typeof row.colony_id!=='string'||row.colony_id.toLowerCase()!==c.colonyId.toLowerCase()||row.entity_type!=='archive'||typeof row.entity_id!=='string'||!(row.entity_id==='reconstruction'||/^chunk:[a-f0-9]{64}$/.test(row.entity_id))||!Number.isSafeInteger(row.version)||row.version<1||typeof row.archived!=='boolean'||payload&&(!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)))throw new Error('Cloud page contains an invalid or unrelated archive record.');
    return row;
  };
  let headPage=(await readCloudPage(size=>request(`entity_records?${query(reuse?'colony_id,entity_type,entity_id,version,archived':fields,size,'eq.reconstruction')}`),1,check)).page;
  if(!Array.isArray(headPage)||headPage.length!==1)throw new Error('Cloud import is incomplete: its reconstruction manifest is missing or duplicated. Finish or retry the initial upload before pulling.');
  const headIndex=valid(headPage[0],!reuse);let head=reuse?reusableRecord(reuse,headIndex,c):headIndex;const headReused=Boolean(reuse&&head);
  if(!head){
    headPage=(await readCloudPage(size=>request(`entity_records?${query(fields,size,'eq.reconstruction')}`),1,check)).page;
    if(!Array.isArray(headPage)||headPage.length!==1)throw new Error('The reconstruction manifest changed during loading. Pull again.');
    head=valid(headPage[0],true);if(head.version!==headIndex.version||head.archived!==headIndex.archived)throw new Error('The reconstruction manifest changed during loading. Pull again.');
  }
  if(head.entity_id!=='reconstruction'||head.archived)throw new Error('The reconstruction manifest is invalid or archived.');
  const metadata=head.payload,ids=new Set();
  if(metadata.archive_format&&metadata.archive_format!==ARCHIVE_MANIFEST_FORMAT)throw new Error('This reconstruction archive format is not supported.');
  if(metadata.archive_format===ARCHIVE_MANIFEST_FORMAT){
    if(!metadata.archive_tables||typeof metadata.archive_tables!=='object'||Array.isArray(metadata.archive_tables))throw new Error('The reconstruction chunk manifest is invalid.');
    for(const [table,descriptor] of Object.entries(metadata.archive_tables)){
      if(Object.hasOwn(ID_FIELDS,table)||!descriptor||!Number.isSafeInteger(descriptor.row_count)||descriptor.row_count<0||!Array.isArray(descriptor.chunk_ids))throw new Error(`Invalid archive descriptor for ${table}.`);
      for(const id of descriptor.chunk_ids){if(typeof id!=='string'||!/^chunk:[a-f0-9]{64}$/.test(id))throw new Error(`Invalid archive chunk reference for ${table}.`);ids.add(id);}
    }
  }
  onLoaded(1);
  const indexed=new Map();let cursor=null,limit=1000;
  while(true){
    const loaded=await readCloudPage(size=>request(`entity_records?${query('colony_id,entity_type,entity_id,version,archived',size,cursor===null?null:`gt.${cursor}`)}`),limit,check);const page=loaded.page;limit=loaded.limit;
    if(!Array.isArray(page)||page.length>limit)throw new Error('The archive version index is invalid.');
    for(const row of page){valid(row);if(indexed.has(row.entity_id))throw new Error('The archive version cursor did not advance.');indexed.set(row.entity_id,row);}
    if(page.length<limit)break;cursor=page.at(-1).entity_id;
  }
  if(indexed.get('reconstruction')?.version!==head.version)throw new Error('The reconstruction manifest changed during loading. Pull again.');
  for(const id of ids)if(!indexed.has(id)||indexed.get(id).archived)throw new Error(`Missing or invalid archive chunk ${id}; pull was not saved.`);
  const ordered=[...ids].sort(),chunks=new Map(),needed=[];
  for(const id of ordered){const cached=reusableRecord(reuse,indexed.get(id),c);if(cached){chunks.set(id,cached);onLoaded(1);}else needed.push(id);}
  const batches=[];for(let i=0;i<needed.length;i+=3)batches.push(needed.slice(i,i+3));
  let nextBatch=0,failure=null;
  const active=()=>{check();if(failure)throw failure;};
  async function worker(){
    try{while(true){active();const batch=batches[nextBatch++];if(!batch)return;let offset=0,size=batch.length;
      while(offset<batch.length){
        const loaded=await readCloudPage(n=>request(`entity_records?${query(fields,n,`in.(${batch.slice(offset,offset+n).join(',')})`)}`),Math.min(size,batch.length-offset),active);size=loaded.limit;
        const wanted=batch.slice(offset,offset+size),page=loaded.page,seen=new Set();
        if(!Array.isArray(page)||page.length!==wanted.length)throw new Error('A referenced archive chunk is missing; pull was not saved.');
        for(const row of page){valid(row,true);if(!wanted.includes(row.entity_id)||seen.has(row.entity_id)||row.archived||row.version!==indexed.get(row.entity_id)?.version)throw new Error('A referenced archive chunk is invalid or changed; pull was not saved.');seen.add(row.entity_id);chunks.set(row.entity_id,row);}
        active();onLoaded(page.length);offset+=size;
      }
    }}catch(error){failure??=error;throw error;}
  }
  // Three small requests at a time bound load and memory while avoiding one
  // serial network round trip for every three archive blocks.
  await Promise.all(Array.from({length:Math.min(3,batches.length)},()=>worker()));check();
  const finalPage=(await readCloudPage(size=>request(`entity_records?${query('colony_id,entity_type,entity_id,version,archived',size,'eq.reconstruction')}`),1,check)).page;
  if(!Array.isArray(finalPage)||finalPage.length!==1)throw new Error('The reconstruction manifest changed during loading. Pull again.');
  const finalHead=valid(finalPage[0]);if(finalHead.entity_id!=='reconstruction'||finalHead.archived||finalHead.version!==head.version)throw new Error('The reconstruction manifest changed during loading. Pull again.');
  const result=[head,...ordered.map(id=>chunks.get(id))];result.reused=Number(headReused)+ordered.length-needed.length;result.archive_versions=[...indexed.values()].map(row=>[`archive:${row.entity_id}`,row.version]);return result;
}
async function allRecords(onProgress=null,{referencedArchive=false,reuse=null,allowPersisted=false,checkScope=null}={}){
  const generation=authGeneration,context=exportContext(),c=configuration(),policy=await refreshFeeVisibility({notify:false});const result=[];
  const check=()=>{checkScope?.();if(generation!==authGeneration)throw new Error('The account or colony changed during loading. Open the shared colony again.');checkExportContext(context);};
  let reusable=referencedArchive&&reuse?.identity===syncIdentity()&&stable(reuse.policy)===stable(policy)?reuse:null;
  if(!reusable&&referencedArchive&&allowPersisted)reusable=await persistedBaseline(policy,check);check();
  let recordsLoaded=0,archiveBlocksLoaded=0,recordsReused=0,archiveBlocksReused=0;
  const progress=phase=>{check();onProgress?.({phase,recordsLoaded,archiveBlocksLoaded});};
  try{
  // Keep healthy reads efficient; only a confirmed timeout reduces a page.
  // Archive chunks are larger, so their initial page remains much smaller.
  // Bound every page with the primary key before RLS evaluates its payload.
  // OFFSET repeatedly scans all preceding rows and can time out even at LIMIT 1.
  for(const type of [...MANAGED,...(policy.source_archive_allowed&&!referencedArchive?['archive']:[])]){
    // Restricted locations always come from the sanitized projection RPC.
    if(!policy.source_archive_allowed&&type==='locations')continue;
    if(reusable&&type!=='archive'){progress('records');const rows=await incrementalManaged(type,c,check,reusable,!policy.source_archive_allowed);result.push(...rows);recordsLoaded+=rows.length;recordsReused+=rows.reused;progress('records');continue;}
    let cursor=null,limit=type==='archive'?3:1000;const seen=new Set();
    progress(type==='archive'?'archive':'records');
    while(true){
      const loaded=await readCloudPage(size=>{
        const query=new URLSearchParams({select:'colony_id,entity_type,entity_id,payload,version,archived',colony_id:`eq.${c.colonyId}`,entity_type:`eq.${type}`,order:'entity_id.asc',limit:String(size)});
        // A top-level gt value is literal PostgREST text. URL encoding protects
        // punctuation, quotes and Unicode without changing the stored ID.
        if(cursor!==null)query.set('entity_id',`gt.${cursor}`);
        return request(`entity_records?${query}`);
      },limit,check);
      const page=loaded.page;limit=loaded.limit;
      if(!Array.isArray(page)||page.length>limit)throw new Error('Cloud records were not returned as a valid page.');
      for(const row of page){
        checkedCloudRecord(row,type,c);
        if(seen.has(row.entity_id))throw new Error('Cloud page cursor did not advance. Pull again.');
        seen.add(row.entity_id);
      }
      if(type==='archive')archiveBlocksLoaded+=page.length;else recordsLoaded+=page.length;
      progress(type==='archive'?'archive':'records');
      result.push(...(policy.source_archive_allowed?page:page.filter(r=>r.entity_type!=='locations'&&!feeRecord(r))));if(page.length<limit)break;
      cursor=page.at(-1).entity_id;
    }
  }
  if(policy.source_archive_allowed&&referencedArchive){
    progress('archive');const archive=await selectedArchive(c,check,count=>{archiveBlocksLoaded+=count;progress('archive');},reusable);
    result.push(...archive);result.archive_versions=archive.archive_versions;archiveBlocksReused=archive.reused;
  }
  if(!policy.source_archive_allowed){
   let offset=0,limit=250;while(true){const loaded=await readCloudPage(size=>request('rpc/get_lac_fee_records',{method:'POST',body:{p_colony_id:c.colonyId,p_offset:offset,p_limit:size}}),limit,check);const page=loaded.page;limit=loaded.limit;
    const nextPolicy=checkedFeeVisibility(page?.visibility);if(nextPolicy.version!==policy.version||nextPolicy.estimate!==policy.estimate||nextPolicy.actual!==policy.actual||!Array.isArray(page.rows))throw new Error('Fee visibility changed while loading. Pull again.');
    if(page.rows.some(r=>!feeRecord(r)||r.colony_id!==c.colonyId))throw new Error('Invalid projected fee records.');result.push(...page.rows);
    if(page.next_offset===null)break;if(!Number.isInteger(page.next_offset)||page.next_offset<=offset)throw new Error('Invalid fee page cursor.');offset=page.next_offset;
   }
   offset=0;limit=250;while(true){const loaded=await readCloudPage(size=>request('rpc/get_managed_locations',{method:'POST',body:{p_colony_id:c.colonyId,p_offset:offset,p_limit:size}}),limit,check);const page=loaded.page;limit=loaded.limit;
    const nextPolicy=checkedFeeVisibility(page?.visibility);if(!sameFeeVisibility(nextPolicy,policy)||!Array.isArray(page.rows))throw new Error('Fee visibility changed while loading locations. Pull again.');
    for(const row of page.rows)result.push(checkedManagedLocation(row,c.colonyId));
    if(page.next_offset===null)break;if(!Number.isInteger(page.next_offset)||page.next_offset<=offset)throw new Error('Invalid location page cursor.');offset=page.next_offset;
   }
  }
  progress('verifying');
  checkExportContext(context);const finalPolicy=await refreshFeeVisibility({notify:false});if(!sameFeeVisibility(finalPolicy,policy))throw new Error('Fee visibility changed while loading. Pull again.');
  result.fee_visibility=policy;result.sync_summary={recordsDownloaded:result.filter(row=>row.entity_type!=='archive').length-recordsReused,recordsReused,archiveBlocksDownloaded:result.filter(row=>row.entity_type==='archive').length-archiveBlocksReused,archiveBlocksReused};return result;
  }catch(error){
    // An older read must not clear a workspace created by a later sign-in.
    const check=()=>{checkScope?.();if(generation!==authGeneration)throw error;checkExportContext(context);};
    try{check();invalidate();if(!policy.source_archive_allowed)await local('delete',undefined,{check});}catch{/* The newer account owns its cache. */}
    throw error;
  }
}
const recordKey=r=>`${r.entity_type}:${r.entity_id}`;
async function entityRecords(dataset){
  const data=normalizeDataset(dataset),records=[],seen=new Set();
  for(const type of MANAGED)for(const value of data.tables[type]){
    const id=value[ID_FIELDS[type]];
    if(typeof id!=='string'||!id.trim())throw new Error(`Every ${type} record requires a text identifier.`);
    const payload=clone(value);delete payload._version;
    const r={entity_type:type,entity_id:id,payload,archived:Boolean(payload.app_archived_at)};
    if(seen.has(recordKey(r)))throw new Error(`Duplicate cloud identifier: ${id}.`);seen.add(recordKey(r));records.push(r);
  }
  if(!data.source_archive_restricted){const archiveData={...data};delete archiveData._cloud_read_context;delete archiveData.fee_visibility;delete archiveData.source_archive_restricted;records.push(...await encodeArchive(archiveData));}
  return records;
}
async function assemble(rows){
  const partial=rows.fee_visibility?.source_archive_allowed===false;
  if(!partial&&!rows.some(r=>r.entity_type==='archive'&&r.entity_id==='reconstruction'))throw new Error('Cloud import is incomplete: its reconstruction manifest is missing. Finish or retry the initial upload before pulling.');
  const data=partial?{tables:{},source_archive_restricted:true,source_projection_version:SOURCE_PROJECTION_VERSION}:await decodeArchive(rows);
  data.tables??={};for(const type of MANAGED)data.tables[type]=[];
  const seen=new Set();
  for(const r of rows){
    if(!MANAGED.includes(r.entity_type))continue;
    if(seen.has(recordKey(r)))throw new Error('Cloud response contains duplicate record IDs.');seen.add(recordKey(r));
    if(r.payload?.[ID_FIELDS[r.entity_type]]!==r.entity_id)throw new Error(`Cloud payload identifier does not match record ${r.entity_id}.`);
    if(Boolean(r.payload.app_archived_at)!==Boolean(r.archived))throw new Error(`Archive status differs from payload for ${r.entity_id}.`);
    data.tables[r.entity_type].push(clone(r.payload));
  }
  if(partial)data.fee_visibility=rows.fee_visibility;return normalizeDataset(data);
}
function rememberCloudCache(writeId,baselineHash){const c=configuration();setStorage('localStorage',CLOUD_CACHE_KEY,JSON.stringify({url:c.url,colony:c.colonyId,user:session()?.user?.id,estimate:feeVisibility?.estimate,actual:feeVisibility?.actual,source_projection_version:SOURCE_PROJECTION_VERSION,...(writeId?{write_id:writeId}:{}),...(baselineHash?{baseline_sha256:baselineHash}:{})}));}
function remember(rows){versions=new Map([...(rows.archive_versions||[]),...rows.map(r=>[recordKey(r),r.version])]);baseline=new Map(rows.map(r=>[recordKey(r),r]));baselineIdentity=syncIdentity();synced=true;}
export async function pullFromCloud({onProgress,forceFull=false}={}){
  const reuse=!forceFull&&synced&&baseline&&baselineIdentity===syncIdentity()?{records:baseline,versions,identity:baselineIdentity,policy:clone(feeVisibility)}:null;
  const pull=++pullGeneration;invalidate();
  const generation=authGeneration,context=exportContext(),config=stable(configuration());
  const check=()=>{if(pull!==pullGeneration||generation!==authGeneration||config!==stable(configuration())||context!==exportContext())throw new Error('The account or colony changed during loading. Open the shared colony again.');};
  const progress=value=>{check();if(typeof onProgress==='function'){try{onProgress(Object.freeze({...value}));}catch{/* Presentation cannot interrupt a verified read. */}}};
  progress({phase:'access',recordsLoaded:0,archiveBlocksLoaded:0});
  await membership({check});check();
  const rows=await allRecords(progress,{referencedArchive:true,reuse,allowPersisted:!forceFull,checkScope:check});check();if(!rows.length)throw new Error('The cloud colony is empty. Import and upload a dataset first.');
  const data=await assemble(rows);check();
  const c=configuration(),cacheWrite={id:crypto.randomUUID(),url:c.url,colony:c.colonyId,user:session().user.id};
  try{
    progress({phase:'saving',recordsLoaded:rows.filter(row=>row.entity_type!=='archive').length,archiveBlocksLoaded:rows.filter(row=>row.entity_type==='archive').length});
    const syncBaseline=await baselineEnvelope(rows,cacheWrite.id,check);check();
    await local('put',data,{check,cacheWrite,syncBaseline});check();
    rememberCloudCache(cacheWrite.id,syncBaseline?.sha256);remember(rows);setStorage('localStorage',DEMO_KEY,null);setMode('cloud');const counts=rows.sync_summary;statusMessage=`Cloud connected. Downloaded ${counts.recordsDownloaded} records and ${counts.archiveBlocksDownloaded} history blocks; reused ${counts.recordsReused} records and ${counts.archiveBlocksReused} history blocks.`;return clone(data);
  }catch(error){const cleanup=discardCloudWrite(cacheWrite.id).catch(()=>{});if(error.storageTimeout!==true)await cleanup;throw error;}
}
async function writeAtomic(pending,{checkScope}={}){
  checkScope?.();
  if(!pending.length)return [];
  if(pending.length>500)throw new Error('A cloud edit may change at most 500 records. Split this edit into smaller operations.');
  const c=configuration();
  const body={p_colony_id:c.colonyId,p_changes:pending.map(([r,expected])=>({...r,expected_version:expected}))};
  if(utf8Size(body)>MAX_RPC_BYTES)throw new Error('This atomic edit exceeds the 1MB cloud request limit. Split it into smaller operations.');
  try{
    const rows=await request('rpc/save_records',{method:'POST',body});
    const expected=new Set(pending.map(([r])=>recordKey(r)));
    if(!Array.isArray(rows)||rows.length!==pending.length||rows.some(r=>!expected.delete(recordKey(r))||!Number.isInteger(r.version))||expected.size)throw new Error('The cloud save did not return a verifiable version for every record.');
    checkScope?.();return rows;
  }catch(e){
    // A delayed save must not invalidate a newer verified pull/account.
    try{checkScope?.();}catch{throw e;}
    invalidate();statusMessage=`${e.message} Cloud save was not confirmed; pull the latest data before retrying.`;throw new Error(statusMessage);
  }
}
async function requireEditor(){const role=await membership();if(role==='viewer')throw new Error('Your colony role is viewer; cloud changes require editor or owner access.');}
export async function pushToCloud(dataset){
  await requireEditor();if(!(await refreshFeeVisibility()).source_archive_allowed||dataset.source_archive_restricted)throw new Error('Full financial visibility and an unredacted dataset are required for an initial upload.');
  const incoming=await entityRecords(dataset),existing=await allRecords(),byId=new Map(existing.map(r=>[recordKey(r),r]));
  for(const r of incoming){const old=byId.get(recordKey(r));if(old&&(stable(old.payload)!==stable(r.payload)||Boolean(old.archived)!==r.archived))throw new Error(`Cloud record ${r.entity_type}/${r.entity_id} already contains different data. Pull and review it; initial upload will not overwrite it.`);}
  const pending=incoming.filter(r=>!byId.has(recordKey(r))).sort((a,b)=>(a.entity_id==='reconstruction'?1:0)-(b.entity_id==='reconstruction'?1:0));
  statusMessage=`Uploading ${pending.length} new cloud records…`;
  let completed=0;
  try{for(const batch of partitionChanges(pending.map(r=>({...r,expected_version:0})))){await writeAtomic(batch.map(({expected_version,...r})=>[r,expected_version]));completed+=batch.length;statusMessage=`Uploaded ${completed} of ${pending.length} records.`;}}
  catch(e){throw new Error(`${e.message} Initial upload confirmed ${completed} records before this batch. Retry upload to skip identical records; no local import was replaced.`);}
  return pullFromCloud();
}
/** One explicit dataset save per account epoch. Never queue a stale whole dataset. */
export async function saveDataset(dataset,options={}){
  if(pendingAccount(session())||session()?.passwordRecovery)throw new Error('Complete your account setup before changing colony data.');
  const scope=stable({generation:authGeneration,context:exportContext()});
  if(activeDatasetSaves.has(scope))throw new Error('Another save is in progress. Wait for it to finish, then review and save your changes again.');
  activeDatasetSaves.add(scope);
  try{return await saveDatasetOnce(dataset,options);}
  finally{activeDatasetSaves.delete(scope);}
}
async function saveDatasetOnce(dataset,{localOnly=false,localKind=null,readDependencies=[]}={}){
  if(!Array.isArray(readDependencies)||readDependencies.length>500)throw new Error('Invalid save dependencies. Reload and review the changes.');
  const dependencyKeys=new Set();
  for(const dependency of readDependencies){
    if(!dependency||typeof dependency!=='object'||Array.isArray(dependency)||Object.keys(dependency).length!==2||!READ_DEPENDENCY_TYPES.has(dependency.type)||typeof dependency.id!=='string'||!dependency.id||dependency.id.trim()!==dependency.id||dependency.id.length>200)throw new Error('Invalid save dependencies. Reload and review the changes.');
    dependencyKeys.add(`${dependency.type}:${dependency.id}`);
  }
  const data=normalizeDataset(dataset);
  if(localOnly||mode()==='local'){
    const generation=authGeneration,context=exportContext();
    const check=()=>{if(generation!==authGeneration||context!==exportContext()||pendingAccount(session())||session()?.passwordRecovery)throw new Error('The account changed while saving. Review your changes again.');};
    await local('put',data,{check});check();setStorage('localStorage',CLOUD_CACHE_KEY,null);if(localOnly){setStorage('localStorage',DEMO_KEY,localKind==='demo'?'true':null);setMode('local');invalidate();}statusMessage='Saved on this device.';return;
  }
  if(!synced||!baseline)throw new Error('Pull the latest cloud data before editing.');
  const context=exportContext(),savePullGeneration=pullGeneration,saveAuthGeneration=authGeneration;
  const ownsSave=()=>savePullGeneration===pullGeneration&&saveAuthGeneration===authGeneration&&context===exportContext();
  const checkSaveEpoch=()=>{if(!ownsSave())throw new Error('The account or shared data changed while saving. Pull again.');};
  await requireEditor();checkSaveEpoch();const policy=await refreshFeeVisibility();checkSaveEpoch();if(!synced||!baseline)throw new Error('Visibility changed. Pull the latest cloud data before editing.');
  if(!policy.source_archive_allowed&&(data.source_archive_restricted!==true||data.source_projection_version!==SOURCE_PROJECTION_VERSION||!data.tables.locations.every(managedLocationPayload)))throw new Error('Source location fields require full financial visibility. Pull the latest cloud data before editing.');
  const incoming=await entityRecords(data),map=new Map(incoming.map(r=>[recordKey(r),r]));
  for(const [k,r] of baseline)if(!map.has(k)&&!isArchiveChunk(r))throw new Error(`Record ${r.entity_id} was removed. Archive records instead of deleting them.`);
  const pending=incoming.filter(r=>{const old=baseline.get(recordKey(r));return !old||stable(old.payload)!==stable(r.payload)||old.archived!==r.archived;}).map(r=>[r,versions.get(recordKey(r))??0]);
  // Lock/check unchanged records on which a move was validated, in the same
  // transaction as its mutations. save_record returns exact no-ops unchanged.
  const pendingKeys=new Set(pending.map(([r])=>recordKey(r)));
  for(const key of dependencyKeys){
    const row=baseline.get(key),version=versions.get(key);
    if(!row||!Number.isInteger(version)||version<1)throw new Error('A move dependency is missing from the verified data. Pull again before saving.');
    if(!pendingKeys.has(key))pending.push([row,version]);
  }
  if(!policy.source_archive_allowed&&pending.some(([r])=>r.entity_type==='archive'||feeRecord(r)))throw new Error('Both estimate and actual visibility are required to edit fees or source archives.');
  const chunks=pending.filter(([r])=>isArchiveChunk(r)),atomic=pending.filter(([r])=>!isArchiveChunk(r));
  if(atomic.length>500||utf8Size({p_colony_id:configuration().colonyId,p_changes:atomic.map(([r,expected_version])=>({...r,expected_version}))})>MAX_RPC_BYTES)throw new Error('This atomic edit is too large. Split it into smaller operations.');
  // Immutable chunks can be staged before committing the manifest. A failed
  // final transaction leaves old data authoritative and new chunks unreferenced.
  const saved=[];
  for(const batch of partitionChanges(chunks.map(([r,expected_version])=>({...r,expected_version}))))saved.push(...await writeAtomic(batch.map(({expected_version,...r})=>[r,expected_version]),{checkScope:checkSaveEpoch}));
  saved.push(...await writeAtomic(atomic,{checkScope:checkSaveEpoch}));
  try{
   checkSaveEpoch();const finalPolicy=await refreshFeeVisibility();checkSaveEpoch();
   if(!sameFeeVisibility(finalPolicy,policy)||!synced)throw new Error('Fee visibility changed during save. Pull the latest cloud data.');
   for(const row of saved){
    if(!policy.source_archive_allowed&&row.entity_type==='locations')checkedManagedLocation(row,configuration().colonyId);
    // Server projections, including returned versions, are authoritative. Never
    // retain an earlier full-access location payload after a restricted save.
    map.set(recordKey(row),row);
    if(row.entity_type==='locations'){const index=data.tables.locations.findIndex(location=>location.location_id===row.entity_id);if(index>=0)data.tables.locations[index]=clone(row.payload);}
   }
  }catch(error){if(ownsSave()){invalidate();if(!policy.source_archive_allowed)await local('delete',undefined,{check:checkSaveEpoch});}throw new Error(`${error.message} Cloud writes may have completed; pull again before editing.`);}
  const generation=authGeneration,identity=syncIdentity(),nextVersions=new Map(versions);
  for(const r of saved)nextVersions.set(recordKey(r),r.version);
  const check=()=>{checkExportContext(context);if(generation!==authGeneration||identity!==syncIdentity()||savePullGeneration!==pullGeneration||!synced)throw new Error('Your account or shared data changed while saving the local copy.');};
  const c=configuration(),cacheWrite={id:crypto.randomUUID(),url:c.url,colony:c.colonyId,user:session().user.id};
  try{const syncBaseline=await baselineEnvelope([...map.values()],cacheWrite.id,check,nextVersions);check();await local('put',data,{check,cacheWrite,syncBaseline});check();rememberCloudCache(cacheWrite.id,syncBaseline?.sha256);}
  catch(e){if(ownsSave())invalidate();const cleanup=discardCloudWrite(cacheWrite.id).catch(()=>{});if(e.storageTimeout!==true)await cleanup;throw new Error(`${e.message} Cloud writes completed; pull again to restore the local copy.`);}
  versions=nextVersions;baseline=map;baselineIdentity=syncIdentity();statusMessage='Saved to cloud and this device.';
}
export async function getAuditLog({limit=100,before=null}={}){
  const c=configuration();await membership();
  const n=Math.max(1,Math.min(500,Math.floor(Number(limit)||100)));
  if(before!==null&&!/^\d+$/.test(String(before)))throw new Error('Invalid audit cursor.');
  return request(`audit_log?select=audit_id,colony_id,entity_type,entity_id,operation,actor_id,occurred_at,before_record,after_record&colony_id=eq.${encodeURIComponent(c.colonyId)}&order=audit_id.desc&limit=${n}${before===null?'':`&audit_id=lt.${before}`}`);
}

const exportDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function checkedExportPermission(value){
  if(!value||!['low','high','max'].includes(value.level)||!exportDate(value.as_of_date)||value.full_history!==(value.level==='max')||(value.level==='max'?value.cutoff_date!==null:!exportDate(value.cutoff_date)))throw new Error('Export permission could not be verified. Reload and try again.');
  return value;
}
function exportContext(){const c=configuration();return stable({url:c?.url,colony:c?.colonyId,user:session()?.user?.id,mode:mode(),demo:getStorage('localStorage',DEMO_KEY)});}
function checkExportContext(context){if(exportContext()!==context)throw new Error('Your account or colony changed. Reopen Export.');}
async function localExportDataset(){
  // A configured real colony always rechecks server permission, including after
  // sign-out. Do not load or refresh its cached dataset to make this decision.
  if(mode()!=='local'||configuration()&&getStorage('localStorage',DEMO_KEY)!=='true')return null;
  return await loadDataset();
}
function localExportPermission(){return {level:'max',cutoff_date:null,as_of_date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),full_history:true,local:true};}
export async function getExportPermission(){
  const context=exportContext(),localData=await localExportDataset();checkExportContext(context);
  if(localData)return localExportPermission();
  const c=configuration();if(!c)throw new Error('Open a workspace before exporting.');
  const value=checkedExportPermission(await request('rpc/get_export_permission',{method:'POST',body:{p_colony_id:c.colonyId}}));
  checkExportContext(context);if(session())saveSession({...session(),exportLevel:value.level});
  return {...value,local:false};
}
export async function assertFullExportPermission(){
  const context=exportContext(),localData=await localExportDataset();checkExportContext(context);
  if(localData)return localExportPermission();
  const c=configuration();if(!c)throw new Error('Open a workspace before exporting.');
  const value=checkedExportPermission(await request('rpc/assert_full_export_permission',{method:'POST',body:{p_colony_id:c.colonyId}}));
  checkExportContext(context);if(value.level!=='max')throw new Error('Full-history permission is required for a full backup or source archive.');
  return {...value,local:false};
}
function exportRecordDate(type,row){
  const keys={mice:['end_date','date_of_birth'],matings:['disbanded_date','set_up_date'],litters:['end_date','wean_date','date_of_birth'],cages:['end_date','set_up_date'],light_events:['end_date','start_date'],husbandry_events:['event_date']}[type]||[];
  if(type==='husbandry_events'&&row.event_type==='cryopreservation_lot')return [row.cryopreservation?.quantity_as_of_date,row.cryopreservation?.frozen_date].find(exportDate)||null;
  return keys.map(key=>row[key]).find(exportDate)||null;
}
// Match the server's bounded experiment report projection. Full preservation
// backups use a different, Max-only path and retain provenance and revisions.
function experimentExportFields(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  const result={};
  for(const key of keys){const v=value[key];
    if(typeof v==='string')result[key]=[...v].slice(0,2048).join('');
    else if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))result[key]=v;
    else if(Array.isArray(v))result[key]=v.filter(item=>typeof item==='string').slice(0,100).map(item=>[...item].slice(0,200).join(''));
  }
  return result;
}
function experimentExportRows(value,keys){
  const rows=Array.isArray(value)?value:[],items=rows.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)).slice(0,100).map(item=>experimentExportFields(item,keys));
  if(keys.includes('candidate_sids'))for(const [i,item] of rows.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)).slice(0,100).entries()){const candidates=Array.isArray(item.candidate_sids)?item.candidate_sids:[];items[i].candidate_count=candidates.length;items[i].candidates_truncated=(items[i].candidate_sids||[]).length<candidates.length;}
  return {items,total:rows.length,truncated:items.length<rows.length};
}
const IACUC_EXPORT_FIELDS={"inputs":["design","variance","mean1","mean2","effect","sd","sd1","sd2","sdDifference","correlation","alpha","power","allocationRatio","experimentalUnit","animalsPerUnit","technicalReplicates","attrition","maxUnitsPerGroup","n1","n2","target","genotypeProbability","sexProbability","survivalProbability","confidence","maxOffspring","litterSize","littersPerPair"],"results":["status","method","approximate","n1","n2","achieved_power","previous_power","df","critical","noncentrality","standard_error","alpha","target_power","effect","sd_difference","power","sidedness","usable_probability","expected_offspring","expected_offspring_rounded","confidence_offspring","achieved_probability","previous_probability","expected_litters","confidence_litters","expected_pairs","confidence_pairs","expected_unusable_at_confidence_count","breeder_animals","errors","warnings","assumptions"],"cluster":["animalsPerCage","icc","cages_per_group","approximate","power_recomputed","attrition_basis","whole_cage_loss_modeled"],"allocation":["rule","requested_ratio","actual_ratio"],"adjustment":["analyzed_units_per_group","independent_equivalent_units_per_group","experimental_unit","recruited_units_per_group","animals_per_group","total_animals","animals_per_unit","technical_replicates","measurement_count","attrition","attrition_basis","design_effect"],"maximum_checked":["n1","n2","power","offspring","probability"],"protocol":["schema_version","protocol_id","number","aliases","title","title_en","pi","status","start_date","end_date","approved_animals"],"assignment":["schema_version","protocol_id","entity_type","entity_id","purpose","valid_from","valid_to","evidence_status"],"usage":["schema_version","protocol_id","category","mouse_sids","unregistered_count","event_date","experiment_id","litter_sid","evidence_status"],"design":["schema_version","protocol_id","label","title","method","calculated_at"],"allocations":["id","species","strain","approved","portal_used","portal_pending","portal_remaining"]};
function iacucNumericArrays(value,keys){const result={};for(const key of keys)if(Array.isArray(value?.[key]))result[key]=value[key].filter(v=>typeof v==='number'&&Number.isFinite(v)).slice(0,100);return result;}
function iacucDesignPart(value,part){const result=experimentExportFields(value,IACUC_EXPORT_FIELDS[part]);if(!value||typeof value!=='object')return result;
 if(part==='inputs'){if(value.cluster&&typeof value.cluster==='object'&&!Array.isArray(value.cluster))result.cluster=experimentExportFields(value.cluster,IACUC_EXPORT_FIELDS.cluster);}
 else{for(const key of ['allocation','maximum_checked'])if(value[key]&&typeof value[key]==='object'&&!Array.isArray(value[key]))result[key]=experimentExportFields(value[key],IACUC_EXPORT_FIELDS[key]);
  if(value.adjustment&&typeof value.adjustment==='object'&&!Array.isArray(value.adjustment)){result.adjustment={...experimentExportFields(value.adjustment,IACUC_EXPORT_FIELDS.adjustment),...iacucNumericArrays(value.adjustment,['analyzed_units_per_group','independent_equivalent_units_per_group','recruited_units_per_group','animals_per_group','cages_per_group'])};if(value.adjustment.cluster&&typeof value.adjustment.cluster==='object'&&!Array.isArray(value.adjustment.cluster))result.adjustment.cluster={...experimentExportFields(value.adjustment.cluster,IACUC_EXPORT_FIELDS.cluster),...iacucNumericArrays(value.adjustment.cluster,['cages_per_group'])};}
 }return result;
}
function projectIacucExport(row){const type=row.event_type,key=type.slice(6),p=row[type]||{},result=experimentExportFields(row,['event_id','event_type','event_date']),nested=experimentExportFields(p,IACUC_EXPORT_FIELDS[key]||[]);result[type]=nested;
 if(key==='protocol'){const rows=experimentExportRows(p.allocations,IACUC_EXPORT_FIELDS.allocations);Object.assign(nested,{allocations:rows.items,allocation_count:rows.total,allocations_truncated:rows.truncated});}
 if(key==='usage'){nested.mouse_count=Array.isArray(p.mouse_sids)?p.mouse_sids.length:0;nested.mouse_sids_truncated=nested.mouse_count>(nested.mouse_sids||[]).length;}
 if(key==='design')for(const [target,part]of [['breeding_inputs','inputs'],['breeding_results','results']])if(p[target]&&typeof p[target]==='object'&&!Array.isArray(p[target]))nested[target]=iacucDesignPart(p[target],part);
 if(key==='design')for(const part of ['inputs','results']){nested[part]=iacucDesignPart(p[part],part);for(const section of ['sample_size','breeding'])if(p[part]?.[section]&&typeof p[part][section]==='object'&&!Array.isArray(p[part][section]))nested[part][section]=iacucDesignPart(p[part][section],part);}
 return result;
}
function projectExperimentExport(row){
  if(['iacuc_protocol','iacuc_assignment','iacuc_usage','iacuc_design'].includes(row.event_type))return projectIacucExport(row);
  if(['lac_fee_options','lac_fee_month'].includes(row.event_type)){
    const type=row.event_type,p=row[type]||{},result=experimentExportFields(row,['event_id','event_type','event_date']);
    const keys=type==='lac_fee_options'?['schema_version','effective_from','currency','target_percent','maximum_percent','excluded_room_ids','revision']:['schema_version','month','currency','actual_total','actual_date','actual_basis','paid_date','invoice_reference','revision'];
    const field=type==='lac_fee_options'?'groups':'lines',rows=experimentExportRows(p[field],type==='lac_fee_options'?['key','label','unit','room_ids','rack_ids','rate','rate_period','rate_reference']:['group_key','quantity','quantity_unit','evidence_kind','evidence_start','evidence_end','evidence_reference','quantity_basis','quantity_note','snapshot_count','actual_amount']);
    result[type]={...experimentExportFields(p,keys),[field]:rows.items,[field+'_count']:rows.total,[field+'_truncated']:rows.truncated};return result;
  }
  if(!['experiment','experiment_sample','experiment_revision'].includes(row.event_type))return clone(row);
  const result=experimentExportFields(row,['event_id','event_type','event_date']);
  const entrainmentFields=['scheme','light_event_id','reference_at','reference_phase','phase_basis','phase_scale','period_hours','timezone','start_date','end_date','duration_days','duration_basis'];
  const referenceFields=['mouse_sid','raw_identifier','link_status','candidate_sids','role'];
  if(row.event_type==='experiment'){
    const p=row.experiment||{},participants=experimentExportRows(p.participants,referenceFields),usages=experimentExportRows(p.sample_usages,['sample_id','purpose','amount','unit','disposition']);
    result.experiment={...experimentExportFields(p,['schema_version','title','assays','status','project','operator','protocol','started_at','ended_at','timezone','circadian_time','time_basis','circadian_time_source','decapitation_at','decapitation_circadian_time','decapitation_time_basis','decapitation_circadian_time_source','sampling_at','sampling_circadian_time','sampling_time_basis','sampling_circadian_time_source','result_urls']),entrainment:experimentExportFields(p.entrainment,entrainmentFields),participants:participants.items,participant_count:participants.total,participants_truncated:participants.truncated,sample_usages:usages.items,sample_usage_count:usages.total,sample_usages_truncated:usages.truncated};
    result.experiment.result_urls=(Array.isArray(p.result_urls)?p.result_urls:[]).filter(url=>typeof url==='string').slice(0,30).map(url=>[...url].slice(0,2048).join(''));
  }else if(row.event_type==='experiment_sample'){
    const p=row.experiment_sample||{},donors=experimentExportRows(p.donors,referenceFields);
    result.experiment_sample={...experimentExportFields(p,['schema_version','label','experiment_id','parent_sample_ids','pooled','tissue','material','collection_at','timezone','circadian_time','time_basis','circadian_time_source','decapitation_at','decapitation_circadian_time','decapitation_time_basis','decapitation_circadian_time_source','status','quantity','quantity_unit','quantity_as_of_date','operator','project','protocol']),entrainment:experimentExportFields(p.entrainment,entrainmentFields),donors:donors.items,donor_count:donors.total,donors_truncated:donors.truncated,parent_sample_count:Array.isArray(p.parent_sample_ids)?p.parent_sample_ids.length:0,parent_samples_truncated:Array.isArray(p.parent_sample_ids)&&p.parent_sample_ids.length>(experimentExportFields(p,['parent_sample_ids']).parent_sample_ids||[]).length,storage:experimentExportFields(p.storage,['temperature_c','facility','freezer','rack','box','position'])};
  }
  return result;
}
function currentExportRecord(type,row,data){
  const present=r=>!r.app_archived_at&&r.archived!==true;
  if(!present(row))return false;
  if(type==='mice')return row.state==='Stock';
  if(['rooms','racks','locations'].includes(type))return true;
  if(type==='cages')return ['active','occupied'].includes(String(row.state).toLowerCase())||data.tables.mice.some(r=>present(r)&&r.state==='Stock'&&r.cage_sid===row.cage_sid)||data.tables.locations.some(r=>present(r)&&row.location_id&&r.location_id===row.location_id);
  if(type==='light_events'){
    let today;try{today=new Intl.DateTimeFormat('en-CA',{timeZone:row.timezone||'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}catch{today=localExportPermission().as_of_date;}
    return exportDate(row.start_date)&&row.start_date<=today&&(row.end_date==null||exportDate(row.end_date)&&(/next phase start|exclusive/i.test(row.interval_semantics||'')?row.end_date>today:row.end_date>=today));
  }
  return false;
}
export async function getExportRecords(options={}){return readExportRecords(options,'export_records');}
async function readExportRecords({scope='current_housing',fromDate=null,toDate=null,entityTypes=null}={},rpcName,boundary=null){
  if(!['current_housing','history'].includes(scope))throw new Error('Choose current housing or historical records.');
  if(entityTypes!==null&&(!Array.isArray(entityTypes)||!entityTypes.length||entityTypes.some(type=>!MANAGED.includes(type))))throw new Error('Choose supported record types to export.');
  for(const value of [fromDate,toDate])if(value!==null&&!exportDate(value))throw new Error('Choose valid export dates.');
  const context=exportContext(),permission=await getExportPermission();checkExportContext(context);
  const end=toDate||permission.as_of_date,start=fromDate||permission.cutoff_date;
  if(end>permission.as_of_date||start&&start>end)throw new Error('The export date range is invalid.');
  if(scope==='history'&&permission.cutoff_date&&start<permission.cutoff_date)throw new Error('This date range exceeds your export level.');
  const localData=permission.local?await localExportDataset():null;
  checkExportContext(context);
  if(permission.local){
    if(!localData)throw new Error('The workspace changed. Reopen Export.');
    const data=normalizeDataset({tables:{}});let excluded=0;
    for(const type of MANAGED){data.tables[type]=(entityTypes&&!entityTypes.includes(type)?[]:localData.tables[type]||[]).filter(row=>{
      if(scope!=='history')return currentExportRecord(type,row,localData);
      if(type==='husbandry_events'&&row.event_type==='locobox_revision')return false;
      if(type==='husbandry_events'&&row.event_type==='locobox_protocol')return Boolean(projectLocoboxExport(row,{fromDate:start,toDate:end,includeUndated:!start}));
      const date=exportRecordDate(type,row);
      if(!date){if(start){excluded++;return false}return true}
      return (!start||date>=start)&&date<=end;
    }).map(row=>type==='husbandry_events'?(row.event_type==='locobox_protocol'?projectLocoboxExport(row,{fromDate:start,toDate:end,includeUndated:!start}):projectExperimentExport(row)):clone(row));}
    return {dataset:data,metadata:{...permission,export_level:permission.level,scope,from_date:scope==='history'?start:null,to_date:scope==='history'?end:null,excluded_undated:excluded,snapshot_revision:'local',captured_at:new Date().toISOString()}};
  }
  const c=configuration(),rows=[],seen=new Set();let offset=0,metadata=null;
  while(true){
    const page=await request('rpc/'+rpcName,{method:'POST',body:{p_colony_id:c.colonyId,p_scope:scope,p_from_date:scope==='history'?start:null,p_to_date:scope==='history'?end:null,p_entity_types:entityTypes,p_offset:offset,p_limit:250,...(boundary?{p_expected_revision:boundary.snapshot_revision}:{})}});
    if(!page||!Array.isArray(page.rows)||page.rows.length>250||!['low','high','max'].includes(page.export_level)||!exportDate(page.as_of_date)||typeof page.snapshot_revision!=='string')throw new Error('The server returned an unverifiable export page.');
    if(page.export_level!==permission.level||page.cutoff_date!==permission.cutoff_date||page.as_of_date!==permission.as_of_date)throw new Error('Your export permission changed. Reopen Export and try again.');
    if(page.fee_visibility){checkedFeeVisibility(page.fee_visibility);if(metadata?.fee_visibility&&stable(page.fee_visibility)!==stable(metadata.fee_visibility))throw new Error('Fee visibility changed while exporting. Reopen Export.');}
    if(boundary&&(page.snapshot_revision!==boundary.snapshot_revision||!sameFeeVisibility(checkedFeeVisibility(page.fee_visibility),boundary.fee_visibility)))throw new Error('Data or fee visibility changed while backing up. Try again.');
    if(metadata&&page.snapshot_revision!==metadata.snapshot_revision)throw new Error('Colony data changed while exporting. Try again for a consistent snapshot.');
    checkExportContext(context);
    metadata??={...page,rows:undefined,local:false,scope};
    for(const row of page.rows){
      const key=recordKey(row);
      if(!MANAGED.includes(row.entity_type)||typeof row.entity_id!=='string'||!row.payload||row.payload[ID_FIELDS[row.entity_type]]!==row.entity_id||seen.has(key))throw new Error('The export contains an invalid or duplicate record.');
      seen.add(key);rows.push(row);
    }
    if(page.next_offset===null)break;
    if(!Number.isSafeInteger(page.next_offset)||page.next_offset!==offset+page.rows.length||page.next_offset<=offset||page.next_offset>100000)throw new Error('Export pagination could not be verified. Narrow the selected records.');
    offset=page.next_offset;
  }
  const final=await getExportPermission();checkExportContext(context);
  if(final.local||final.level!==permission.level||final.cutoff_date!==permission.cutoff_date||final.as_of_date!==permission.as_of_date)throw new Error('Your export permission changed. Reopen Export and try again.');
  if(metadata?.fee_visibility){const finalFee=await refreshFeeVisibility();checkExportContext(context);if(stable(finalFee)!==stable(metadata.fee_visibility))throw new Error('Fee visibility changed while exporting. Reopen Export.');}
  const data=normalizeDataset({tables:{}});for(const row of rows)data.tables[row.entity_type].push({...clone(row.payload),export_record_date:row.record_date??null});
  return {dataset:data,metadata:{...metadata,row_count:rows.length}};
}
export async function getLocalBackup(){
  const context=exportContext(),generation=authGeneration;
  const check=()=>{checkExportContext(context);if(generation!==authGeneration)throw new Error('Your account changed. Reopen Export.');};
  const authorize=async()=>{
    const localData=await localExportDataset();check();
    if(localData)return localExportPermission();
    const c=configuration();if(!c)throw new Error('Open a workspace before backing up.');
    const grant=checkedExportPermission(await request('rpc/get_local_backup_permission',{method:'POST',body:{p_colony_id:c.colonyId}}));
    check();if(!['high','max'].includes(grant.level))throw new Error('Local backup is unavailable for this account.');
    return {...grant,local:false};
  };
  const permission=await authorize(),sections={},revisions={};
  // A one-row projected read supplies the colony-wide audit revision and policy;
  // its row is discarded. Bracket all full/raw or bounded reads with this fence.
  const readBoundary=async expected=>{
    const c=configuration(),page=await request('rpc/export_local_backup_records',{method:'POST',body:{p_colony_id:c.colonyId,p_scope:'current_housing',p_entity_types:['rooms'],p_offset:0,p_limit:1,p_expected_revision:expected?.snapshot_revision??null}});check();
    if(!page||!Array.isArray(page.rows)||page.rows.length>1||typeof page.snapshot_revision!=='string'||!/^\d{1,100}$/.test(page.snapshot_revision))throw new Error('Backup snapshot could not be verified.');
    if(page.export_level!==permission.level||page.cutoff_date!==permission.cutoff_date||page.as_of_date!==permission.as_of_date)throw new Error('Backup permission changed. No file was prepared.');
    const result={snapshot_revision:page.snapshot_revision,fee_visibility:checkedFeeVisibility(page.fee_visibility)};
    if(expected&&(result.snapshot_revision!==expected.snapshot_revision||!sameFeeVisibility(result.fee_visibility,expected.fee_visibility)))throw new Error('Data or fee visibility changed while backing up. Try again.');
    return result;
  };
  const boundary=permission.local?null:await readBoundary();
  if(permission.level==='max'&&boundary&&!boundary.fee_visibility.source_archive_allowed)throw new Error('Full workspace backup requires access to source and fee data.');
  if(permission.level==='max'){sections.workspace=await getFullExportBackup();if(sections.workspace.source_archive_restricted)throw new Error('Full workspace backup requires access to source and fee data.');}
  else{
    for(const scope of ['current_housing','history']){
      const result=await readExportRecords({scope,fromDate:scope==='history'?permission.cutoff_date:null,toDate:scope==='history'?permission.as_of_date:null},'export_local_backup_records',boundary);
      check();
      if(result.metadata.export_level!==permission.level||result.metadata.cutoff_date!==permission.cutoff_date||result.metadata.as_of_date!==permission.as_of_date)throw new Error('Backup permission changed. Try again.');
      sections[scope]={metadata:result.metadata,tables:result.dataset.tables};revisions[scope]=result.metadata.snapshot_revision;
    }
    if(!revisions.current_housing||revisions.current_housing!==revisions.history)throw new Error('Data changed while backing up. Try again for a consistent backup.');
  }
  const final=await authorize();check();
  for(const key of ['level','cutoff_date','as_of_date','local'])if(final[key]!==permission[key])throw new Error('Backup permission changed. No file was prepared.');
  if(boundary)await readBoundary(boundary);
  const payload={kind:'braintime-local-backup',schema_version:1,application:'mouse-data',created_at:new Date().toISOString(),full_workspace:permission.level==='max',restore_mode:permission.level==='max'?'workspace':'reviewed_merge_only',permission:{level:permission.level,cutoff_date:permission.cutoff_date,as_of_date:permission.as_of_date},sections};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)));
  check();return {...payload,integrity:{algorithm:'SHA-256',encoding:'JSON.stringify of envelope without integrity',value:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')}};
}
export async function getFullExportBackup(){
  const context=exportContext(),permission=await assertFullExportPermission();checkExportContext(context);
  let data;
  if(permission.local)data=await localExportDataset();
  else {const rows=await allRecords();checkExportContext(context);data=await assemble(rows);}
  checkExportContext(context);if(!data)throw new Error('No workspace is available to back up.');
  const final=await assertFullExportPermission();checkExportContext(context);
  if(final.local!==permission.local)throw new Error('The workspace changed. Reopen Export.');
  return {...data,app_backup_at:new Date().toISOString(),export_permission:{level:permission.level,as_of_date:permission.as_of_date}};
}
export async function getFullSourceExport(localLoader){
  const context=exportContext(),c=configuration();
  // Source history has separate storage and must never inherit a demo's grant.
  const authorize=async()=>{
    if(!c)return assertFullExportPermission();
    const value=checkedExportPermission(await request('rpc/assert_full_export_permission',{method:'POST',body:{p_colony_id:c.colonyId}}));
    checkExportContext(context);if(value.level!=='max')throw new Error('Full-history permission is required for a full source archive.');
    return value;
  };
  await authorize();checkExportContext(context);
  const index=c?await downloadHistoryIndex():await localLoader();checkExportContext(context);
  if(!index)throw new Error('No full source archive is loaded. Open Source archive to load it first.');
  await authorize();checkExportContext(context);return index;
}

/** User administration is authenticated here and independently authorized by the Edge function. */
export async function manageColonyUsers(action,payload={}) {
  const c=configuration(),signedIn=session();
  if(!c)throw new Error('Configure the cloud project first.');
  if(!signedIn?.access_token||!signedIn.user?.id)throw new Error('Sign in before managing colony users.');
  if(signedIn.role!=='owner')throw new Error('Only an active colony owner can manage users.');
  const allowed={list:[],invite:['email','role','export_level','permissions'],invite_preregistered:['person_id','version'],create_preregistered_link:['person_id','version'],update_access:['user_id','role','active','export_level','permissions']};
  if(!Object.hasOwn(allowed,action))throw new Error('Unsupported user-management action.');
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!allowed[action].includes(k)))throw new Error('Unexpected user-management fields. Colony and invitation return URLs are configured by the app and server.');
  const fields={};
  if(action==='invite_preregistered'||action==='create_preregistered_link') {
    if(typeof payload.person_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.person_id)||!Number.isSafeInteger(payload.version)||payload.version<1)throw new Error('Refresh Members and choose a saved preregistered member.');
    fields.person_id=payload.person_id;fields.version=payload.version;
  }
  if(action==='invite')fields.email=emailAddress(payload.email);
  if(action==='invite'||action==='update_access') {
    if(!['viewer','editor','manager'].includes(payload.role))throw new Error('Choose viewer or editor access. Owner accounts cannot be changed here.');
    fields.role=payload.role;
    if(payload.permissions!==undefined){const errors=validateManagerPermissions(payload.permissions);if(errors.length)throw new Error(errors.join(' '));fields.permissions=payload.permissions;}
    if(payload.export_level!==undefined){if(!['low','high','max'].includes(payload.export_level))throw new Error('Choose Low, High or Max export access.');fields.export_level=payload.export_level;}
  }
  if(action==='update_access') {
    if(typeof payload.user_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.user_id))throw new Error('Choose a valid colony user.');
    if(payload.user_id===signedIn.user.id)throw new Error('You cannot change your own access here.');
    if(typeof payload.active!=='boolean')throw new Error('User access must be explicitly enabled or disabled.');
    fields.user_id=payload.user_id;fields.active=payload.active;
  }
  if(await membership()!=='owner')throw new Error('Only an active colony owner can manage users.');
  const token=await accessToken(),current=configuration();
  if(current?.url!==c.url||current.colonyId!==c.colonyId||session()?.user?.id!==signedIn.user.id)throw new Error('The cloud account or colony changed. Reload the user list before continuing.');
  let response;
  try {
    response=await fetch(`${c.url}/functions/v1/manage-colony-users`,{method:'POST',cache:'no-store',redirect:'error',headers:{apikey:publicKey(c.anonKey),Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...fields,action,colony_id:c.colonyId})});
  }catch{throw new Error('The user-management request was not confirmed. Reload the user list before retrying.');}
  const result=await responseJSON(response);
  if(configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==signedIn.user.id)throw new Error('The cloud account or colony changed while the request was running. Its result is uncertain; refresh Members before continuing.');
  if(!response.ok) {
    const partialMessage=result?.invitation_sent===true&&typeof result.message==='string';
    const error=!partialMessage&&(response.status===401||response.status===403)?apiError(response,result):new Error(typeof result?.message==='string'?result.message:`User management failed (${response.status}).`);
    if(typeof result?.code==='string')error.code=result.code;
    if(result?.invitation_sent===true)error.invitationSent=true;
    throw error;
  }
  if(action==='create_preregistered_link') {
    if(!result||result.person_id!==fields.person_id||result.email_sent!==false||result.delivery_status!=='not_sent'||result.link_kind!=='invitation'||result.expires_at!==null)throw new Error('The invitation link could not be verified. Refresh Members.');
    let link;
    try{link=new URL(result.invitation_link);}catch{throw new Error('The invitation link could not be verified. Refresh Members.');}
    const expectedOrigin=new URL(c.url).origin,keys=[...link.searchParams.keys()];
    const redirect=link.searchParams.get('redirect_to');
    if(link.protocol!=='https:'||link.origin!==expectedOrigin||link.username||link.password||link.hash||link.pathname!=='/auth/v1/verify'||keys.length!==3||new Set(keys).size!==3||keys.some(k=>!['token','type','redirect_to'].includes(k))||!/^[a-zA-Z0-9_-]{20,256}$/.test(link.searchParams.get('token')||'')||link.searchParams.get('type')!=='invite'||redirect!=='https://braintimelab.github.io/mouse-data/')throw new Error('The invitation link could not be verified. Refresh Members.');
    return {person_id:fields.person_id,invitation_link:link.href,link_kind:result.link_kind,expires_at:null,email_sent:false,delivery_status:'not_sent'};
  }
  if(!result||typeof result!=='object'||(action==='list'?!Array.isArray(result.users):action==='invite_preregistered'?result.person_id!==fields.person_id||result.email_sent!==true:!result.user||typeof result.user!=='object'))throw new Error('The server did not return a verifiable user-management result. Reload the user list before retrying.');
  return result;
}

export async function inviteLabMember(payload){return manageColonyUsers('invite_preregistered',payload);}
export async function createLabMemberInvitationLink(payload){return manageColonyUsers('create_preregistered_link',payload);}

const ACCESS_PAGES={mouse:['overview','mice','matings','litters','cages','family','planner','experiments','iacuc','housing','locobox','cryo','fees','archive','brainbot','settings'],reagents:['inventory','safety','usage','orders','vendors','equipment','history','review','settings']};
// Authenticated app activity is best effort and contains only allowlisted labels.
// Capture the current token before sign-out clears it; never delay sign-out for logging.
export function recordAppAccess(payload){
 const c=configuration(),s=session(),idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!c||!s?.access_token||!s.user?.id||s.passwordRecovery||s.setupRequired||!['owner','manager','editor','viewer'].includes(s.role)||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!['app','event','page','sessionId','eventId'].includes(k))||!['mouse','reagents'].includes(payload.app)||!['session_start','page_view','sign_out'].includes(payload.event)||!ACCESS_PAGES[payload.app]?.includes(payload.page)||!idPattern.test(payload.sessionId||'')||!idPattern.test(payload.eventId||''))return Promise.resolve(null);
 const body={p_colony_id:c.colonyId,p_app:payload.app,p_event:payload.event,p_page:payload.page,p_session_id:payload.sessionId,p_event_id:payload.eventId};
 try{return Promise.resolve(fetch(`${c.url}/rest/v1/rpc/record_app_access`,{method:'POST',cache:'no-store',redirect:'error',keepalive:true,headers:{apikey:c.anonKey,Authorization:`Bearer ${s.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(body),...(typeof globalThis.AbortSignal?.timeout==='function'?{signal:globalThis.AbortSignal.timeout(5000)}:{})})).then(async response=>{if(!response.ok)return null;const result=await responseJSON(response);return result&&typeof result.recorded==='boolean'&&['recorded','duplicate','debounced','rate_limited'].includes(result.reason)?result:null;}).catch(()=>null);}catch{return Promise.resolve(null);}
}

export async function listAppAccess(filters={}){
 const c=configuration(),s=session(),generation=authGeneration;
 const denied=()=>Object.assign(new Error('Only the database owner can read access logs.'),{code:'42501'});
 if(!c||!s?.user?.id||s.passwordRecovery||s.role!=='owner')throw denied();
 if(!filters||typeof filters!=='object'||Array.isArray(filters)||Object.keys(filters).some(k=>!['app','userId','event','from','to','before','limit'].includes(k)))throw new Error('Unsupported access log filters.');
 const value={app:null,userId:null,event:null,from:null,to:null,before:null,limit:50,...filters};
 const time=v=>v===null||typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
 if(value.app!==null&&!['mouse','reagents'].includes(value.app)||value.userId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.userId)||value.event!==null&&!['session_start','page_view','sign_out'].includes(value.event)||!time(value.from)||!time(value.to)||value.from&&value.to&&Date.parse(value.from)>=Date.parse(value.to)||value.before!==null&&!(typeof value.before==='string'&&/^[1-9]\d*$/.test(value.before)&&value.before.length<=19)||!Number.isInteger(value.limit)||value.limit<1||value.limit>50)throw new Error('Choose valid access log filters.');
 const check=()=>{if(generation!==authGeneration||configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==s.user.id)throw new Error('The account changed. Reopen Access logs.');if(session()?.role!=='owner')throw denied();};
 if(await membership({check})!=='owner')throw denied();check();
 const result=await request('rpc/list_app_access',{method:'POST',body:{p_colony_id:c.colonyId,p_app:value.app,p_user_id:value.userId,p_event:value.event,p_from:value.from,p_to:value.to,p_before:value.before,p_limit:value.limit}});
 check();if(!result||!Array.isArray(result.events)||result.events.length>value.limit||typeof result.has_more!=='boolean')throw new Error('Access logs could not be verified.');return result;
}

const HISTORY_BUCKET='colony-history';
function historyIndex(value){
  if(!value||typeof value!=='object'||!Array.isArray(value.sources)||!Array.isArray(value.sheets)||!Array.isArray(value.cells))throw new Error('A history index must contain sources, sheets, and cells arrays.');
  return value;
}
function historyPath(path){
  const c=configuration();if(!c)throw new Error('Configure the cloud project first.');
  const prefix=`${c.colonyId}/history/`,name=typeof path==='string'&&path.startsWith(prefix)?path.slice(prefix.length):'';
  if(!/^[a-f0-9]{64}\.json$/.test(name))throw new Error('History path must identify a SHA-256 JSON archive in the configured colony.');
  return name.slice(0,64);
}
async function sha256(text){
  if(!globalThis.crypto?.subtle)throw new Error('Secure hashing is unavailable. Open the app over HTTPS or localhost.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function rememberHistory(path){const c=configuration();if(c)setStorage('localStorage',CONFIG_KEY,JSON.stringify({...c,historyPath:path}));}
async function storageRequest(route,{method='GET',body}={}){
  const c=configuration();if(!c)throw new Error('Configure the cloud project first.');publicKey(c.anonKey);
  const token=await accessToken();
  // Private authenticated Storage route; never create a public or signed link.
  return fetch(`${c.url}/storage/v1/${route}`,{method,cache:'no-store',redirect:'error',headers:{apikey:c.anonKey,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body});
}
export async function fetchHistoryArchive(path){
  const expected=historyPath(path);await membership();
  const response=await storageRequest(`object/authenticated/${HISTORY_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`);
  if(!response.ok)throw apiError(response,await responseJSON(response));
  const text=await response.text();
  if(await sha256(text)!==expected)throw new Error('History archive checksum does not match its filename. It was not loaded.');
  let data;try{data=JSON.parse(text);}catch{throw new Error('The history archive is not valid JSON.');}
  historyIndex(data);rememberHistory(path);return data;
}
export async function uploadHistoryIndex(index){
  historyIndex(index);await requireEditor();if(!(await refreshFeeVisibility()).source_archive_allowed)throw new Error('Full financial visibility is required to upload a source archive.');
  const text=JSON.stringify(index),digest=await sha256(text),path=`${configuration().colonyId}/history/${digest}.json`;
  const response=await storageRequest(`object/${HISTORY_BUCKET}/${path}`,{method:'POST',body:text});
  if(!response.ok){
    const error=await responseJSON(response);
    // Storage returns 400 or 409 for an existing immutable object. Verify the
    // bytes before treating a repeated upload as successful.
    if(response.status!==409&&!(response.status===400&&/duplicate|already exists/i.test(String(error?.message??error?.error??''))))throw apiError(response,error);
  }
  await fetchHistoryArchive(path);
  return {bucket:HISTORY_BUCKET,path,sha256:digest,bytes:new TextEncoder().encode(text).length,cellCount:index.cells.length};
}
export async function downloadHistoryIndex(){
  await membership();const c=configuration(),prefix=`${c.colonyId}/history`;
  // Immutable versions can be discovered on a new device without local config.
  let offset=0;
  while(true){
    const response=await storageRequest(`object/list/${HISTORY_BUCKET}`,{method:'POST',body:JSON.stringify({prefix,limit:100,offset,sortBy:{column:'created_at',order:'desc'}})});
    const rows=await responseJSON(response);if(!response.ok)throw apiError(response,rows);
    if(!Array.isArray(rows))throw new Error('The history archive list was not returned as a list.');
    const first=rows.find(r=>/^[a-f0-9]{64}\.json$/.test(r.name??''));
    if(first)return fetchHistoryArchive(`${prefix}/${first.name}`);
    if(rows.length<100)throw new Error('No history archive has been uploaded for this colony.');
    offset+=rows.length;
  }
}


// Private roster never enters the colony dataset, IndexedDB, backups or exports.
export async function listLabMembers(){
 if(await membership()!=='owner')throw new Error('Only the owner can view lab-member records.');
 return request('rpc/list_lab_members',{method:'POST',body:{p_colony_id:configuration().colonyId}});
}
export async function listCageManagers(){
 const config=configuration(),actor=session()?.user?.id;
 if(!config||!actor)throw new Error('Sign in to load cage managers.');
 const result=await request('rpc/list_cage_managers',{method:'POST',body:{p_colony_id:config.colonyId}});
 if(configuration()?.url!==config.url||configuration()?.colonyId!==config.colonyId||session()?.user?.id!==actor)throw new Error('Account changed. Reload cage managers.');
 if(!Array.isArray(result?.managers))throw new Error('Cage manager list is unavailable.');
 // Keep the contact-free directory in memory only, never in colony records/cache.
 return {managers:result.managers.filter(row=>row&&typeof row.person_id==='string'&&typeof row.name==='string'&&['current','historical'].includes(row.status)).map(row=>({person_id:row.person_id,name:row.name,acronym:typeof row.acronym==='string'?row.acronym:null,nickname:typeof row.nickname==='string'?row.nickname:null,status:row.status}))};
}
export async function saveLabMember(person){
 if(await membership()!=='owner')throw new Error('Only the owner can edit lab-member records.');
 return request('rpc/save_lab_member',{method:'POST',body:{p_colony_id:configuration().colonyId,p_person:person}});
}
export async function approveLabMemberEmail(payload){
 const keys=['request_person_id','request_version','target_person_id','target_version'];
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==keys.length||Object.keys(payload).some(key=>!keys.includes(key)))throw new Error('Select the registered email and existing member before approving.');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(typeof payload.request_person_id!=='string'||typeof payload.target_person_id!=='string'||!uuid.test(payload.request_person_id)||!uuid.test(payload.target_person_id)||payload.request_person_id===payload.target_person_id||!Number.isSafeInteger(payload.request_version)||payload.request_version<1||!Number.isSafeInteger(payload.target_version)||payload.target_version<1)throw new Error('Refresh Members and select the current records.');
 const c=configuration(),actor=session()?.user?.id,generation=authGeneration;
 const check=()=>{if(generation!==authGeneration||configuration()?.url!==c?.url||configuration()?.colonyId!==c?.colonyId||session()?.user?.id!==actor)throw new Error('The account or colony changed. Refresh Members before continuing.');};
 if(!c||!actor)throw new Error('Sign in as the owner before approving an email.');
 if(await membership({check})!=='owner')throw Object.assign(new Error('Only the owner can approve a member email.'),{status:403});
 check();
 let result;
 try{result=await request('rpc/approve_lab_member_email',{method:'POST',body:{p_colony_id:c.colonyId,p_request_person_id:payload.request_person_id,p_request_version:payload.request_version,p_target_person_id:payload.target_person_id,p_target_version:payload.target_version}});}
 catch(error){check();if(error.status===409)error.code='40001';throw error;}
 check();
 const member=result?.member,merged=result?.merged_request;
 if(member?.person_id!==payload.target_person_id||member.status!=='current'||member.archived!==false||member.linked_user_id||!Number.isSafeInteger(member.version)||member.version<=payload.target_version||!Array.isArray(member.secondary_emails)||merged?.person_id!==payload.request_person_id||merged.archived!==true||!Number.isSafeInteger(merged.version)||merged.version<=payload.request_version||result.setup_required!==true)throw new Error('The email approval result could not be confirmed. Refresh Members before trying again.');
 return result;
}
function applyMyLabProfile(result){
 const active=session();if(active)saveSession({...active,username:result?.member?.username||null,setupRequired:setupProfileAllowed(result)});
}
export async function getMyLabMember(){
 const c=configuration(),actor=session()?.user?.id,generation=authGeneration;
 if(!c||!actor)throw new Error('Sign in before loading your registered profile.');
 const result=await request('rpc/get_my_lab_member',{method:'POST',body:{p_colony_id:c.colonyId}});
 if(generation!==authGeneration||configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==actor)throw new Error('The account changed. Sign in again.');
 applyMyLabProfile(result);return result;
}
export async function saveMyLabProfile(fields,version){
 const c=configuration(),actor=session()?.user?.id,generation=authGeneration;
 if(!c||!actor||session()?.passwordRecovery)throw new Error('Sign in before saving your profile.');
 if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(key=>!['name','phone','acronym','category'].includes(key)))throw new Error('Only your name, phone, acronym and category can be changed here.');
 if(!Number.isSafeInteger(version)||version<0)throw new Error('Reload your current profile before saving.');
 const profile={};
 for(const [key,value] of Object.entries(fields)){
  if(value!==null&&typeof value!=='string')throw new Error('Enter valid profile details.');
  profile[key]=typeof value==='string'?value.trim():null;
 }
 if(typeof profile.name!=='string'||!profile.name||profile.name.length>200)throw new Error('Enter your name (up to 200 characters).');
 if(profile.phone!=null&&profile.phone.length>80)throw new Error('Use a phone number up to 80 characters.');
 if(profile.acronym){profile.acronym=profile.acronym.toUpperCase();if(!/^[A-Z][A-Z0-9_-]{0,11}$/.test(profile.acronym))throw new Error('Use an acronym beginning with a letter, up to 12 letters, numbers, underscores or hyphens.');}
 if(profile.category!==undefined&&!['undergraduate','masters','phd','postdoc','visiting_student','visiting_faculty','principal_investigator','other','unknown'].includes(profile.category))throw new Error('Choose a valid member category.');
 const result=await request('rpc/submit_my_lab_profile',{method:'POST',body:{p_colony_id:c.colonyId,p_profile:profile,p_expected_version:version}});
 if(generation!==authGeneration||configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==actor)throw new Error('The account changed. Reload your profile.');
 if(!result?.member||result.member.name!==profile.name||!Number.isSafeInteger(result.member.version)||result.member.version<1||result.member.version<version)throw new Error('Your profile save was not confirmed. Reload your profile.');
 applyMyLabProfile(result);return result;
}
export async function getLabUserDirectory(){return request('rpc/get_lab_user_directory',{method:'POST',body:{p_colony_id:configuration().colonyId}});}
export async function updateMyLabAcronym({acronym,version}={}){
 const c=configuration(),actor=session()?.user?.id,code=typeof acronym==='string'?acronym.trim().toUpperCase():'';
 if(!c||!actor)throw new Error('Sign in before changing your acronym.');
 if(!/^[A-Z][A-Z0-9_-]{0,11}$/.test(code))throw new Error('Use 1–12 letters, numbers, underscores or hyphens, beginning with a letter.');
 if(!Number.isSafeInteger(version)||version<1)throw new Error('Reload your current profile before changing your acronym.');
 const result=await request('rpc/update_my_lab_acronym',{method:'POST',body:{p_colony_id:c.colonyId,p_acronym:code,p_expected_version:version}});
 if(configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==actor)throw new Error('The account changed. Reload your current profile.');
 if(result?.eligible!==true||result.member?.acronym!==code||!Number.isSafeInteger(result.member?.version)||result.member.version<version)throw new Error('Your acronym change was not confirmed. Reload your profile.');
 return result;
}
export async function completeAccountSetup(username,password){
 const id=typeof username==='string'?username.trim().toLowerCase():'';
 if(!/^[a-z][a-z0-9_.-]{2,31}$/.test(id))throw new Error('Use 3–32 characters: start with a letter, then letters, numbers, dots, underscores or hyphens.');
  const c=configuration(),actor=session()?.user?.id,generation=authGeneration;
  const check=()=>{if(generation!==authGeneration||configuration()?.url!==c?.url||configuration()?.colonyId!==c?.colonyId||session()?.user?.id!==actor)throw new Error('The account changed. Sign in again.');};
  const complete=result=>result?.eligible===true&&result.setup_required===false&&result.member?.username===id;
  let mine;try{mine=await getMyLabMember();}catch(error){check();const safe=new Error('Account profile check failed. '+error.message);safe.setupStage='profile';if(error.status===401||error.status===403)safe.status=error.status;throw safe;}
  check();if(!mine?.eligible)throw new Error('Ask the owner to register your verified email first.');
  let result=mine;
  if(mine.setup_required===false){
    if(!complete(mine))throw new Error('Account setup is already complete. Sign in with your registered username.');
    // A previous claim may have committed even if its response or final
    // verification timed out. Recovery must not change the password again.
  }else{
    if(password!==undefined){
      try{await updateAccountPasswordVerified(password,{actor,generation,url:c.url,colonyId:c.colonyId});}
      catch(error){check();error.setupStage='password';throw error;}
    }
    else if(!mine.has_password)throw new Error('Set your own account password first.');
    check();
    try{result=await request('rpc/complete_lab_member_setup',{method:'POST',body:{p_colony_id:c.colonyId,p_username:id}});}
    catch(error){
      check();let reconciled=null;
      // Read-only reconciliation, never replay the password or claim write.
      try{reconciled=await getMyLabMember();}catch{/* Keep the original failure. */}
      check();
      if(complete(reconciled))result=reconciled;
      else{const safe=new Error((password!==undefined?'Your password was saved. ':'')+'Username setup was not confirmed: '+error.message);safe.setupStage='username';safe.passwordSaved=password!==undefined;if(error.status===401||error.status===403)safe.status=error.status;throw safe;}
    }
  }
  check();if(!complete(result))throw new Error('Account setup was not confirmed. Reload Settings.');
  try{await membership();}catch(error){check();const safe=new Error('Account saved. Sign-in verification failed: '+error.message+' Retry verification.');safe.setupStage='verification';safe.accountSaved=true;safe.passwordSaved=true;if(error.status===401||error.status===403)safe.status=error.status;throw safe;}
  check();
 saveSession({...session(),username:id,setupRequired:false});return result;
}

/** Inbound Animal Sheet refresh is queued server-side, never with a browser secret. */
export async function startAnimalSheetImport(){
 const c=configuration(),actor=session()?.user?.id;if(!c||!actor)throw new Error('Sign in before refreshing from Animal Sheet.');
 await membership();const current=session();
 if(current.role==='viewer'||current.role==='manager'&&(current.permissions?.imports===false||current.permissions?.housing===false))throw new Error('Import and housing permissions are required.');
 if(configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==actor)throw new Error('The account changed. Reopen Settings.');
 const result=await request('rpc/request_animal_sheet_import',{method:'POST',body:{p_colony_id:c.colonyId}});
 if(configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==actor)throw new Error('The account changed. Reopen Settings to check the refresh status.');
 return result;
}
export async function getAnimalSheetImportStatus(){
 const c=configuration(),actor=session()?.user?.id;if(!c||!actor)throw new Error('Sign in to view Animal Sheet refresh status.');
 const result=await request('rpc/get_animal_sheet_import_status',{method:'POST',body:{p_colony_id:c.colonyId}});
 if(configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==actor)throw new Error('The account changed. Reopen Settings.');return result;
}
export async function getAnimalSheetImportConflicts({offset=0,limit=100}={}){
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('Choose a valid conflict page.');
 const c=configuration(),actor=session()?.user?.id;if(!c||!actor)throw new Error('Sign in to review Animal Sheet differences.');
 const result=await request('rpc/get_animal_sheet_import_conflicts',{method:'POST',body:{p_colony_id:c.colonyId,p_offset:offset,p_limit:limit}});
 if(configuration()?.url!==c.url||configuration()?.colonyId!==c.colonyId||session()?.user?.id!==actor)throw new Error('The account changed. Reopen Settings.');return result;
}


// Braintime Bot owner controls are transient and never enter shared colony backups.
async function brainbotRequest(name,body={}){
 const context=exportContext(),c=configuration();
 if(!c||!session()?.user?.id)throw new Error('Sign in before opening Braintime Bot.');
 if(await membership()!=='owner')throw new Error('Only the owner can manage Braintime Bot.');
 checkExportContext(context);
 const result=await request('rpc/'+name,{method:'POST',body:{p_colony_id:c.colonyId,...body}});
 checkExportContext(context);
 if(!result||!Number.isSafeInteger(result.settings?.version)||result.settings.version<0||!Array.isArray(result.runs)||!Array.isArray(result.issues)||result.principal?.role!=='manager')throw new Error('Braintime Bot status was not confirmed. Reload the monitoring page.');
 return result;
}
export function getBrainbotStatus(){return brainbotRequest('get_brainbot_status');}
export function saveBrainbotSettings(settings){return brainbotRequest('save_brainbot_settings',{p_settings:settings});}
export async function runBrainbot(){const result=await brainbotRequest('run_brainbot');if(result.last_run?.fixed_count>0)invalidate();return result;}
export function reviewBrainbotIssue({issue_id,version,status,note=null}){return brainbotRequest('review_brainbot_issue',{p_issue_id:issue_id,p_version:version,p_status:status,p_note:note});}


export async function requestPasswordReset(identifier){
 const c=configuration();if(!c)throw new Error('Configure the cloud project first.');
 const value=typeof identifier==='string'?identifier.trim():'';
 if(value.length>254||!(/^[a-z][a-z0-9_.-]{2,31}$/i.test(value)||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))throw new Error('Enter a valid username or email.');
 const action=beginAuthAction(),gateway=c.url===PUBLIC_CONFIG.url&&c.colonyId===PUBLIC_CONFIG.colonyId?PUBLIC_CONFIG.usernameAnonKey:null;
 const anonKey=publicKey(c.anonKey.startsWith('sb_publishable_')&&gateway?gateway:c.anonKey);
 if(anonKey.startsWith('sb_publishable_'))throw new Error('Password recovery requires this project’s public legacy anon gateway key. Ask the owner to update the app configuration.');
 const response=await fetch(`${c.url}/functions/v1/username-sign-in`,{method:'POST',cache:'no-store',redirect:'error',headers:{apikey:anonKey,Authorization:`Bearer ${anonKey}`,'Content-Type':'application/json'},body:JSON.stringify({action:'recover',identifier:value})});
 const result=await responseJSON(response);action.check();
 if(!response.ok)throw new Error(response.status===429?'Too many recovery requests. Wait one hour before trying again.':'Password recovery is temporarily unavailable. Try again later or contact the owner.');
 if(result?.accepted!==true)throw new Error('The recovery request was not confirmed. Try again later.');
 return {accepted:true,message:'If this account is eligible, check its registered email and spam folder for a password reset link.'};
}
export async function completePasswordRecovery(password){
 const c=configuration(),signedIn=session();if(!c||!signedIn?.passwordRecovery||!signedIn.user?.id)throw new Error('Open a valid password reset link first.');
 if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('Use a password between 12 and 128 characters.');
 const action=beginAuthAction(),context=exportContext();
 const check=()=>{action.check();checkExportContext(context);if(!session()?.passwordRecovery)throw new Error('Password recovery changed. Sign in again.');};
 const email=signedIn.user.email;
 if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email))throw new Error('The reset account could not be verified. Request a new reset link.');
 if(!signedIn.passwordRecoveryUpdated){
  const token=await accessToken();check();
  let response;try{response=await fetch(`${c.url}/auth/v1/user`,{method:'PUT',cache:'no-store',redirect:'error',headers:{apikey:publicKey(c.anonKey),Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({password})});}catch{check();throw new Error('The password update was not confirmed. Check your connection before trying again.');}
  const result=await responseJSON(response);check();
  if(!response.ok||result?.id!==signedIn.user.id)throw new Error('The password update was not confirmed. Use a different password or request a new reset link.');
  // A nonsecret marker makes verification retries safe, including after reload.
  // Never store the password or send another password update for a retry.
  saveSession({...session(),passwordRecoveryUpdated:true});
 }
 try{
  // Authenticate normally with the password just entered. The recovery token
  // remains restricted until a new session and current membership both pass.
  const response=await fetch(`${c.url}/auth/v1/token?grant_type=password`,{method:'POST',cache:'no-store',redirect:'error',headers:{apikey:publicKey(c.anonKey),'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  const result=await responseJSON(response);check();
  if(!response.ok||result?.user?.id!==signedIn.user.id||result.user.is_anonymous||!result.user.email_confirmed_at)throw new Error('verification');
  const next=normalizeSession(result),headers={apikey:publicKey(c.anonKey),Authorization:`Bearer ${next.access_token}`};
  const memberResponse=await fetch(`${c.url}/rest/v1/memberships?select=role,active,export_level,permissions&user_id=eq.${encodeURIComponent(signedIn.user.id)}&colony_id=eq.${encodeURIComponent(c.colonyId)}`,{headers,cache:'no-store',redirect:'error'});
  const rows=await responseJSON(memberResponse);check();
  if(!memberResponse.ok||!Array.isArray(rows))throw new Error('membership');
  let pendingSetup=false;
  if(rows.length===0){
   const profileResponse=await fetch(`${c.url}/rest/v1/rpc/get_my_lab_member`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},cache:'no-store',redirect:'error',body:JSON.stringify({p_colony_id:c.colonyId})});
   const profile=await responseJSON(profileResponse);check();pendingSetup=profileResponse.ok&&setupProfileAllowed(profile);
  }
  if(!pendingSetup&&(rows.length!==1||rows[0].active!==true||!['owner','manager','editor','viewer'].includes(rows[0].role)))throw new Error('membership');
  const member=rows[0]||{role:'pending',permissions:{},export_level:null};check();
  saveSession({...next,passwordRecovery:false,passwordRecoveryUpdated:false,role:member.role,permissions:pendingSetup?{}:member.permissions||{},setupRequired:pendingSetup,exportLevel:pendingSetup?null:member.role==='owner'?'max':member.export_level||'low'});
  pendingEmail=null;invalidate();statusMessage='Password saved and sign-in verified.';
  // Do not call global logout here: it would revoke the newly verified session.
  return {updated:true,signedIn:true,message:statusMessage};
 }catch(error){
  check();
  throw new Error('Your password was saved, but sign-in could not be verified. Re-enter the password you just saved to retry, or return to sign in and request a new reset link.');
 }
}
