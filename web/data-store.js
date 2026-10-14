import { normalizeDataset, ID_FIELDS } from './model.js?v=21';
import {encodeArchive,decodeArchive,isArchiveChunk,partitionChanges,MAX_RPC_BYTES,utf8Size} from './archive-format.js';

const CONFIG_KEY='mouse-colony.cloud.v1',SESSION_KEY='mouse-colony.session.v1',MODE_KEY='mouse-colony.mode.v1',DEMO_KEY='mouse-colony.trusted-demo.v1';
const MANAGED=Object.keys(ID_FIELDS);
const clone=value=>structuredClone(value);
let versions=new Map(),baseline=null,synced=false,refreshPromise=null,statusMessage='',pendingEmail=null;
const memory=new Map();
function getStorage(kind,key){try{return globalThis[kind]?.getItem(key)??null;}catch{return memory.get(`${kind}:${key}`)??null;}}
function setStorage(kind,key,value){try{if(!globalThis[kind])throw Error();value===null?globalThis[kind].removeItem(key):globalThis[kind].setItem(key,value);}catch{value===null?memory.delete(`${kind}:${key}`):memory.set(`${kind}:${key}`,value);}}
function readJSON(kind,key){try{return JSON.parse(getStorage(kind,key)||'null');}catch{return null;}}
const configuration=()=>readJSON('localStorage',CONFIG_KEY);
const session=()=>readJSON('sessionStorage',SESSION_KEY);
const mode=()=>getStorage('localStorage',MODE_KEY)==='cloud'?'cloud':'local';
function setMode(value){setStorage('localStorage',MODE_KEY,value);}
function invalidate(){synced=false;baseline=null;versions=new Map();}
function saveSession(s){setStorage('sessionStorage',SESSION_KEY,s?JSON.stringify(s):null);}
function stable(value){if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')}}`;return JSON.stringify(value);}

let dbPromise;
function database(){
  if(!globalThis.indexedDB)return Promise.reject(new Error('Local database storage is unavailable in this browser.'));
  if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
    const request=indexedDB.open('mouse-colony',1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('datasets'))request.result.createObjectStore('datasets');};
    request.onerror=()=>reject(new Error('Unable to open the local colony database.'));
    request.onsuccess=()=>resolve(request.result);
    request.onblocked=()=>reject(new Error('Close older colony tabs before updating local storage.'));
  }).catch(e=>{dbPromise=null;throw e;});
  return dbPromise;
}
async function local(action,value){
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('datasets',action==='get'?'readonly':'readwrite'),store=tx.objectStore('datasets');
    const request=action==='get'?store.get('current'):action==='delete'?store.delete('current'):store.put(clone(value),'current');
    let result;
    request.onsuccess=()=>{result=request.result;};
    tx.oncomplete=()=>resolve(result??null);
    tx.onerror=()=>reject(new Error('Local database write failed. No save was confirmed.'));
    tx.onabort=()=>reject(new Error('Local database transaction was cancelled.'));
  });
}
export async function loadDataset(){const d=await local('get');return d?normalizeDataset(d):null;}
export async function clearDataset(){await local('delete');setStorage('localStorage',DEMO_KEY,null);setMode('local');invalidate();statusMessage='Local dataset cleared.';}

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
  const config={url:u.origin,anonKey:publicKey(anonKey.trim()),colonyId};
  setStorage('localStorage',DEMO_KEY,null);setStorage('localStorage',CONFIG_KEY,JSON.stringify(config));saveSession(null);pendingEmail=null;setMode('local');invalidate();statusMessage='Cloud configured. Sign in to connect.';
}
export function getCloudStatus(){
  const c=configuration(),s=session();
  return {configured:Boolean(c),signedIn:Boolean(s?.access_token),email:s?.user?.email??null,name:typeof s?.user?.user_metadata?.full_name==='string'?s.user.user_metadata.full_name:null,pendingEmail,message:statusMessage||(mode()==='cloud'&&!synced?'Pull cloud data before editing.':mode()==='cloud'?'Cloud connected.':'Changes are saved on this device.'),mode:mode(),readyForEdits:mode()==='local'||synced,colonyId:c?.colonyId??null,role:s?.role??null,exportLevel:s?.role==='owner'?'max':s?.exportLevel??null,url:c?.url??'',anonKey:c?.anonKey??'',historyPath:c?.historyPath??null};
}
async function responseJSON(response){const text=await response.text();if(!text)return null;try{return JSON.parse(text);}catch{throw new Error('The cloud server returned an unreadable response.');}}
function apiError(response,body){
  const message=body?.message||body?.error_description||body?.msg||body?.error||`Cloud request failed (${response.status}).`;
  if(response.status===409||body?.code==='40001')return new Error('This record changed in another session. Pull the latest cloud data and review your edit before trying again.');
  if(response.status===401)return new Error('The cloud session expired or sign-in was rejected. Sign in again.');
  if(response.status===403||body?.code==='42501')return new Error('Your account does not have permission for this cloud operation.');
  return new Error(String(message));
}
async function authRequest(route,body,token){
  const c=configuration();if(!c)throw new Error('Configure the cloud project first.');publicKey(c.anonKey);
  const response=await fetch(`${c.url}/auth/v1/${route}`,{method:'POST',headers:{apikey:c.anonKey,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
  const result=await responseJSON(response);
  if(!response.ok){
    const message=result?.message||result?.error_description||result?.msg;
    if(route==='verify'&&message)throw new Error(String(message));
    throw apiError(response,result);
  }
  return result;
}
function normalizeSession(s){if(!s?.access_token||!s?.refresh_token)throw new Error('The server did not return a complete session.');return {...s,expires_at:s.expires_at??Math.floor(Date.now()/1000)+(s.expires_in??3600)};}
async function accessToken(){
  let s=session();if(!s?.access_token)throw new Error('Sign in before using cloud data.');
  if(s.expires_at<=Date.now()/1000+60){
    if(!refreshPromise)refreshPromise=authRequest('token?grant_type=refresh_token',{refresh_token:s.refresh_token}).then(result=>{const next={...normalizeSession(result),role:s.role,exportLevel:s.exportLevel};saveSession(next);return next;}).catch(e=>{saveSession(null);invalidate();throw e;}).finally(()=>{refreshPromise=null;});
    s=await refreshPromise;
  }
  return s.access_token;
}
async function request(route,{method='GET',body}={}){
  const c=configuration();if(!c)throw new Error('Configure the cloud project first.');publicKey(c.anonKey);
  const token=await accessToken();
  const response=await fetch(`${c.url}/rest/v1/${route}`,{method,headers:{apikey:c.anonKey,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(method==='POST'?{Prefer:'return=representation'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await responseJSON(response);if(!response.ok)throw apiError(response,result);return result;
}
async function membership(){
  const c=configuration(),s=session();
  if(!s?.user?.id)throw new Error('The signed-in user is unavailable. Sign in again.');
  const rows=await request(`memberships?select=role,active,export_level&user_id=eq.${encodeURIComponent(s.user.id)}&colony_id=eq.${encodeURIComponent(c.colonyId)}`);
  if(!Array.isArray(rows)||rows.length!==1||rows[0].active!==true||!['owner','editor','viewer'].includes(rows[0].role))throw new Error('This account is not an active member of the configured colony.');
  saveSession({...session(),role:rows[0].role,exportLevel:rows[0].role==='owner'?'max':rows[0].export_level||'low'});return rows[0].role;
}
export async function signIn(email,password){
  if(typeof email!=='string'||typeof password!=='string'||!email.trim()||!password)throw new Error('Enter your email and password.');
  const s=normalizeSession(await authRequest('token?grant_type=password',{email:email.trim(),password}));
  saveSession(s);invalidate();
  try{await membership();statusMessage='Signed in. Pull existing cloud data or upload the local dataset.';}catch(e){statusMessage=e.message;throw e;}
  return getCloudStatus();
}
function emailAddress(email){
  if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email.trim()))throw new Error('Enter a valid email address.');
  return email.trim();
}
export async function requestEmailCode(email){
  const address=emailAddress(email);
  // Supabase's email template must include {{ .Token }} for the code entry flow.
  await authRequest('otp',{email:address,create_user:false});
  pendingEmail=address;statusMessage='Email code requested. Check your inbox and enter the code.';
  return {email:address,message:statusMessage};
}
export async function requestEmailLink(email,redirectTo){
  const address=emailAddress(email),app=globalThis.location;
  let redirect;try{redirect=new URL(redirectTo);}catch{throw new Error('A valid app return URL is required.');}
  const local=['localhost','127.0.0.1','[::1]'].includes(redirect.hostname);
  if(!app?.origin||redirect.origin!==app.origin||redirect.username||redirect.password||redirect.search||redirect.hash||(redirect.protocol!=='https:'&&!(local&&redirect.protocol==='http:')))throw new Error('The sign-in link must return to this app without query parameters or a fragment.');
  await authRequest(`otp?redirect_to=${encodeURIComponent(redirect.href)}`,{email:address,create_user:false});
  pendingEmail=address;statusMessage='Sign-in link requested. Open the link from your email on the device you want to use.';
  return {email:address,message:statusMessage};
}
export async function consumeAuthCallback(){
  const location=globalThis.location,fragment=new URLSearchParams((location?.hash??'').replace(/^#/,''));
  if(!['access_token','refresh_token','error','error_description','error_code'].some(key=>fragment.has(key)))return null;
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
    const verified=await fetch(`${c.url}/auth/v1/user`,{headers,cache:'no-store'});
    if(!verified.ok)throw new Error('The cloud project rejected this sign-in link. Request a new link.');
    const user=await responseJSON(verified);
    if(user?.id!==claims.sub||user.is_anonymous)throw new Error('The cloud project could not verify this account.');
    const membershipResponse=await fetch(`${c.url}/rest/v1/memberships?select=role,active,export_level&user_id=eq.${encodeURIComponent(user.id)}&colony_id=eq.${encodeURIComponent(c.colonyId)}`,{headers,cache:'no-store'});
    if(!membershipResponse.ok)throw new Error('Unable to verify colony membership. Sign in again or contact the colony owner.');
    const rows=await responseJSON(membershipResponse);
    if(!Array.isArray(rows)||rows.length!==1||rows[0].active!==true||!['owner','editor','viewer'].includes(rows[0].role))throw new Error('This account is not an active member of the configured colony.');
    // A local JWT decode only checks scope; the current project's Auth endpoint
    // authenticates the token. Persist only after that and membership both pass.
    saveSession({access_token:access,refresh_token:refresh,token_type:'bearer',expires_at:claims.exp,user,role:rows[0].role,exportLevel:rows[0].role==='owner'?'max':rows[0].export_level||'low'});
    pendingEmail=null;statusMessage='Signed in. Pull the shared colony to continue.';
    return {...getCloudStatus(),needsPasswordSetup:type==='invite'||type==='recovery'};
  }catch(error){
    saveSession(null);invalidate();
    statusMessage=error instanceof TypeError?'The sign-in link could not be verified because the cloud is unreachable. Request a new link when connected.':error.message;
    throw new Error(statusMessage);
  }
}
export async function verifyEmailCode(email,token){
  const address=emailAddress(email),code=typeof token==='string'?token.trim():'';
  if(!/^\d{6,10}$/.test(code))throw new Error('Enter the numeric verification code from your email.');
  const result=normalizeSession(await authRequest('verify',{email:address,token:code,type:'email'}));
  saveSession(result);invalidate();
  try{await membership();pendingEmail=null;statusMessage='Signed in. Pull the shared colony to continue.';}
  catch(e){saveSession(null);invalidate();statusMessage=e.message;throw e;}
  return getCloudStatus();
}
export async function signOut(){
  const s=session();saveSession(null);pendingEmail=null;setMode('local');invalidate();statusMessage='Signed out. Local data is retained.';
  if(s?.access_token)try{await authRequest('logout',null,s.access_token);}catch{/* Local credentials are already removed even if the server is unreachable. */}
}

export async function updateAccountPassword(password) {
  const c=configuration(),signedIn=session();
  if(!c)throw new Error('Configure the cloud project first.');
  if(!signedIn?.access_token||!signedIn.user?.id)throw new Error('Sign in before changing your account password.');
  if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('Use an account password between 12 and 128 characters.');
  await membership();
  const token=await accessToken(),current=configuration();
  if(current?.url!==c.url||current.colonyId!==c.colonyId||session()?.user?.id!==signedIn.user.id)throw new Error('The cloud account or colony changed. Sign in again before changing your password.');
  let response;
  try {
    response=await fetch(`${c.url}/auth/v1/user`,{method:'PUT',cache:'no-store',redirect:'error',headers:{apikey:publicKey(c.anonKey),Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({password})});
  }catch{throw new Error('The account-password update was not confirmed. Check your connection before trying again.');}
  const result=await responseJSON(response);
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
async function allRecords(){
  const c=configuration();const result=[];
  // Archive chunks have much larger payloads than individual mice. Keep those
  // responses bounded instead of putting hundreds of chunks on a 1,000-row page.
  for(const [filter,limit] of [['neq.archive',1000],['eq.archive',3]]){
    let offset=0;
    while(true){
      const page=await request(`entity_records?select=colony_id,entity_type,entity_id,payload,version,archived&colony_id=eq.${encodeURIComponent(c.colonyId)}&entity_type=${filter}&order=entity_type.asc,entity_id.asc&limit=${limit}&offset=${offset}`);
      if(!Array.isArray(page))throw new Error('Cloud records were not returned as a list.');
      result.push(...page);if(page.length<limit)break;offset+=page.length;
    }
  }
  return result;
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
  records.push(...await encodeArchive(data));
  return records;
}
async function assemble(rows){
  if(!rows.some(r=>r.entity_type==='archive'&&r.entity_id==='reconstruction'))throw new Error('Cloud import is incomplete: its reconstruction manifest is missing. Finish or retry the initial upload before pulling.');
  const data=await decodeArchive(rows);
  data.tables??={};for(const type of MANAGED)data.tables[type]=[];
  const seen=new Set();
  for(const r of rows){
    if(!MANAGED.includes(r.entity_type))continue;
    if(seen.has(recordKey(r)))throw new Error('Cloud response contains duplicate record IDs.');seen.add(recordKey(r));
    if(r.payload?.[ID_FIELDS[r.entity_type]]!==r.entity_id)throw new Error(`Cloud payload identifier does not match record ${r.entity_id}.`);
    if(Boolean(r.payload.app_archived_at)!==Boolean(r.archived))throw new Error(`Archive status differs from payload for ${r.entity_id}.`);
    data.tables[r.entity_type].push(clone(r.payload));
  }
  return normalizeDataset(data);
}
function remember(rows){versions=new Map(rows.map(r=>[recordKey(r),r.version]));baseline=new Map(rows.map(r=>[recordKey(r),r]));synced=true;}
export async function pullFromCloud(){
  await membership();
  const rows=await allRecords();if(!rows.length)throw new Error('The cloud colony is empty. Import and upload a dataset first.');
  const data=await assemble(rows);await local('put',data);remember(rows);setStorage('localStorage',DEMO_KEY,null);setMode('cloud');statusMessage='Cloud data pulled and saved on this device.';return clone(data);
}
async function writeAtomic(pending){
  if(!pending.length)return [];
  if(pending.length>500)throw new Error('A cloud edit may change at most 500 records. Split this edit into smaller operations.');
  const c=configuration();
  const body={p_colony_id:c.colonyId,p_changes:pending.map(([r,expected])=>({...r,expected_version:expected}))};
  if(utf8Size(body)>MAX_RPC_BYTES)throw new Error('This atomic edit exceeds the 1MB cloud request limit. Split it into smaller operations.');
  try{
    const rows=await request('rpc/save_records',{method:'POST',body});
    const expected=new Set(pending.map(([r])=>recordKey(r)));
    if(!Array.isArray(rows)||rows.length!==pending.length||rows.some(r=>!expected.delete(recordKey(r))||!Number.isInteger(r.version))||expected.size)throw new Error('The cloud save did not return a verifiable version for every record.');
    return rows;
  }catch(e){invalidate();statusMessage=`${e.message} Cloud save was not confirmed; pull the latest data before retrying.`;throw new Error(statusMessage);}
}
async function requireEditor(){const role=await membership();if(role==='viewer')throw new Error('Your colony role is viewer; cloud changes require editor or owner access.');}
export async function pushToCloud(dataset){
  await requireEditor();
  const incoming=await entityRecords(dataset),existing=await allRecords(),byId=new Map(existing.map(r=>[recordKey(r),r]));
  for(const r of incoming){const old=byId.get(recordKey(r));if(old&&(stable(old.payload)!==stable(r.payload)||Boolean(old.archived)!==r.archived))throw new Error(`Cloud record ${r.entity_type}/${r.entity_id} already contains different data. Pull and review it; initial upload will not overwrite it.`);}
  const pending=incoming.filter(r=>!byId.has(recordKey(r))).sort((a,b)=>(a.entity_id==='reconstruction'?1:0)-(b.entity_id==='reconstruction'?1:0));
  statusMessage=`Uploading ${pending.length} new cloud records…`;
  let completed=0;
  try{for(const batch of partitionChanges(pending.map(r=>({...r,expected_version:0})))){await writeAtomic(batch.map(({expected_version,...r})=>[r,expected_version]));completed+=batch.length;statusMessage=`Uploaded ${completed} of ${pending.length} records.`;}}
  catch(e){throw new Error(`${e.message} Initial upload confirmed ${completed} records before this batch. Retry upload to skip identical records; no local import was replaced.`);}
  return pullFromCloud();
}
export async function saveDataset(dataset,{localOnly=false,localKind=null}={}){
  const data=normalizeDataset(dataset);
  if(localOnly||mode()==='local'){
    await local('put',data);if(localOnly){setStorage('localStorage',DEMO_KEY,localKind==='demo'?'true':null);setMode('local');invalidate();}statusMessage='Saved on this device.';return;
  }
  if(!synced||!baseline)throw new Error('Pull the latest cloud data before editing.');
  await requireEditor();
  const incoming=await entityRecords(data),map=new Map(incoming.map(r=>[recordKey(r),r]));
  for(const [k,r] of baseline)if(!map.has(k)&&!isArchiveChunk(r))throw new Error(`Record ${r.entity_id} was removed. Archive records instead of deleting them.`);
  const pending=incoming.filter(r=>{const old=baseline.get(recordKey(r));return !old||stable(old.payload)!==stable(r.payload)||old.archived!==r.archived;}).map(r=>[r,versions.get(recordKey(r))??0]);
  const chunks=pending.filter(([r])=>isArchiveChunk(r)),atomic=pending.filter(([r])=>!isArchiveChunk(r));
  if(atomic.length>500||utf8Size({p_colony_id:configuration().colonyId,p_changes:atomic.map(([r,expected_version])=>({...r,expected_version}))})>MAX_RPC_BYTES)throw new Error('This atomic edit is too large. Split it into smaller operations.');
  // Immutable chunks can be staged before committing the manifest. A failed
  // final transaction leaves old data authoritative and new chunks unreferenced.
  const saved=[];
  for(const batch of partitionChanges(chunks.map(([r,expected_version])=>({...r,expected_version}))))saved.push(...await writeAtomic(batch.map(({expected_version,...r})=>[r,expected_version])));
  saved.push(...await writeAtomic(atomic));
  try{await local('put',data);}catch(e){invalidate();throw new Error(`${e.message} Cloud writes completed; pull again to restore the local copy.`);}
  for(const r of saved)versions.set(recordKey(r),r.version);
  baseline=map;statusMessage='Saved to cloud and this device.';
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
  const data=await loadDataset();
  // A configured real colony always rechecks server permission, including after
  // sign-out. Demo and unconfigured private workspaces contain user-owned data.
  return mode()==='local'&&data&&(!configuration()||getStorage('localStorage',DEMO_KEY)==='true')?data:null;
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
  checkExportContext(context);if(value.level!=='max')throw new Error('Max export level is required for a full backup or source archive.');
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
function projectExperimentExport(row){
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
export async function getExportRecords({scope='current_housing',fromDate=null,toDate=null,entityTypes=null}={}){
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
      if(scope!=='history')return currentExportRecord(type,row,localData);const date=exportRecordDate(type,row);
      if(!date){if(start){excluded++;return false}return true}
      return (!start||date>=start)&&date<=end;
    }).map(row=>type==='husbandry_events'?projectExperimentExport(row):clone(row));}
    return {dataset:data,metadata:{...permission,export_level:permission.level,scope,from_date:scope==='history'?start:null,to_date:scope==='history'?end:null,excluded_undated:excluded,snapshot_revision:'local',captured_at:new Date().toISOString()}};
  }
  const c=configuration(),rows=[],seen=new Set();let offset=0,metadata=null;
  while(true){
    const page=await request('rpc/export_records',{method:'POST',body:{p_colony_id:c.colonyId,p_scope:scope,p_from_date:scope==='history'?start:null,p_to_date:scope==='history'?end:null,p_entity_types:entityTypes,p_offset:offset,p_limit:250}});
    if(!page||!Array.isArray(page.rows)||page.rows.length>250||!['low','high','max'].includes(page.export_level)||!exportDate(page.as_of_date)||typeof page.snapshot_revision!=='string')throw new Error('The server returned an unverifiable export page.');
    if(page.export_level!==permission.level||page.cutoff_date!==permission.cutoff_date||page.as_of_date!==permission.as_of_date)throw new Error('Your export permission changed. Reopen Export and try again.');
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
  const data=normalizeDataset({tables:{}});for(const row of rows)data.tables[row.entity_type].push({...clone(row.payload),export_record_date:row.record_date??null});
  return {dataset:data,metadata:{...metadata,row_count:rows.length}};
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
    checkExportContext(context);if(value.level!=='max')throw new Error('Max export level is required for a full source archive.');
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
  const allowed={list:[],invite:['email','role','export_level'],update_access:['user_id','role','active','export_level']};
  if(!Object.hasOwn(allowed,action))throw new Error('Unsupported user-management action.');
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!allowed[action].includes(k)))throw new Error('Unexpected user-management fields. Colony and invitation return URLs are configured by the app and server.');
  const fields={};
  if(action==='invite')fields.email=emailAddress(payload.email);
  if(action==='invite'||action==='update_access') {
    if(!['viewer','editor'].includes(payload.role))throw new Error('Choose viewer or editor access. Owner accounts cannot be changed here.');
    fields.role=payload.role;
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
  if(!response.ok) {
    const partialMessage=result?.invitation_sent===true&&typeof result.message==='string';
    const error=!partialMessage&&(response.status===401||response.status===403)?apiError(response,result):new Error(typeof result?.message==='string'?result.message:`User management failed (${response.status}).`);
    if(typeof result?.code==='string')error.code=result.code;
    if(result?.invitation_sent===true)error.invitationSent=true;
    throw error;
  }
  if(!result||typeof result!=='object'||(action==='list'?!Array.isArray(result.users):!result.user||typeof result.user!=='object'))throw new Error('The server did not return a verifiable user-management result. Reload the user list before retrying.');
  return result;
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
  historyIndex(index);await requireEditor();
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
