#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeArchive, partitionChanges, canonicalStringify } from '../web/archive-format.js';
import { buildAdminCsv, checkedUuid, partitionAdminCsv } from './admin-csv.mjs';
const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
if(args.includes('--help')) {
 console.log('node scripts/import-reconstruction.mjs --dataset /absolute/dataset.json [--apply] [--report import-report.json]\nOffline admin CSV: --export-csv /private/initial-import.csv --colony-id VERIFIED_UUID --owner-user-id VERIFIED_AUTH_UUID\nDry run is offline by default. For --apply set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_ACCESS_TOKEN (signed-in user JWT), COLONY_ID. Never use a service-role key.');process.exit(0);
}
const path=resolve(option('--dataset','../outputs/reconstruction_2026-10-14/dataset.json'));
const data=JSON.parse(await readFile(path,'utf8'));
const keys={mice:'mouse_sid',matings:'mating_sid',litters:'litter_sid',cages:'cage_sid',rooms:'room_id',racks:'rack_id',locations:'location_id',light_events:'event_id',husbandry_events:'event_id'};
const entries=[];const seen=new Set();
for(const [type,key] of Object.entries(keys)) for(const payload of data.tables?.[type]||[]) {
 const id=payload[key];if(typeof id!=='string'||!id.trim())throw new Error(`Missing string identifier for ${type}`);
 const k=`${type}\u0000${id}`;if(seen.has(k))throw new Error(`Duplicate identifier: ${type}/${id}`);seen.add(k);
 entries.push({entity_type:type,entity_id:id,payload,expected_version:0,archived:false});
}
entries.push(...(await encodeArchive(data)).map(e=>({...e,expected_version:0})));
const report={dataset:path,total_records:entries.length,counts:Object.fromEntries([...Object.keys(keys),'archive'].map(k=>[k,entries.filter(x=>x.entity_type===k).length])),mode:args.includes('--apply')?'apply':'offline_dry_run',created:0,identical:0,conflicts:[],batches_completed:0};
if(args.includes('--export-csv')){
 if(args.includes('--apply'))throw new Error('--export-csv and --apply are mutually exclusive. CSV export never connects to Supabase.');
 const csvOption=option('--export-csv');if(!csvOption||csvOption.startsWith('--'))throw new Error('--export-csv requires an explicit output filename.');
 const csvPath=resolve(csvOption);
 const colony=checkedUuid(option('--colony-id'),'--colony-id'),owner=checkedUuid(option('--owner-user-id'),'--owner-user-id');
 const csv=buildAdminCsv(entries,colony,owner);
 const metadata={...report,mode:'offline_admin_csv_export',csv_path:csvPath,colony_id:colony,owner_user_id:owner,
  csv_bytes:Buffer.byteLength(csv),csv_sha256:createHash('sha256').update(csv).digest('hex'),
  import_mode:'INSERT only; target colony must be empty. Do not upsert or overwrite existing records.',
  prerequisites:['Confirm colony_id exists in the target project.','Confirm owner_user_id is the verified Auth user and active owner of this colony.'],
  audit_behavior:'CSV sets no Auth identity or JWT claims. The audit trigger records the actual server auth.uid(), null in an admin context without Auth claims. created_by/updated_by identify the supplied responsible owner.',
  transaction_note:'The manifest is the final CSV row, but Table Editor may batch imports. Verify exact counts and manifest/chunk integrity after import; partial imports are not completion.'};
 await writeFile(csvPath,csv,{encoding:'utf8',mode:0o600,flag:'wx'});
 if(args.includes('--csv-batches')){
  const batchOption=option('--csv-batches');if(!batchOption||batchOption.startsWith('--'))throw new Error('--csv-batches requires an explicit directory.');
  const dir=resolve(batchOption);await mkdir(dir,{recursive:true,mode:0o700});
  metadata.csv_batches=[];
  for(const [i,batch] of partitionAdminCsv(entries,colony,owner).entries()){
   const name=`batch-${String(i+1).padStart(3,'0')}${batch.manifest?'-MANIFEST-LAST':''}.csv`,out=resolve(dir,name);
   await writeFile(out,batch.csv,{encoding:'utf8',mode:0o600,flag:'wx'});
   metadata.csv_batches.push({file:out,rows:batch.records.length,bytes:Buffer.byteLength(batch.csv),sha256:createHash('sha256').update(batch.csv).digest('hex'),manifest:batch.manifest,records:batch.records});
  }
 }
 await writeFile(csvPath+'.metadata.json',JSON.stringify(metadata,null,2),{encoding:'utf8',mode:0o600,flag:'wx'});
 console.log(JSON.stringify(metadata,null,2));process.exit(0);
}
if(!args.includes('--apply')){console.log(JSON.stringify(report,null,2));process.exit(0);}
const {SUPABASE_URL:base,SUPABASE_PUBLISHABLE_KEY:key,SUPABASE_ACCESS_TOKEN:token,COLONY_ID:colony}=process.env;
if(!base||!key||!token||!colony)throw new Error('Missing required environment settings. Run --help.');
const url=new URL(base);if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Use HTTPS for hosted Supabase.');
const jwtBody=(s)=>{try{return JSON.parse(Buffer.from(s.split('.')[1],'base64url'));}catch{return {};}};
if(key.startsWith('sb_secret_')||jwtBody(key).role==='service_role'||jwtBody(token).role==='service_role')throw new Error('Service/secret credentials are forbidden; use a publishable key plus signed-in user access token.');
const user=jwtBody(token).sub;if(!user)throw new Error('Access token must identify a signed-in user.');
async function request(path,options={}) {
 const response=await fetch(new URL(`/rest/v1/${path}`,url),{...options,headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(options.headers||{})}});
 const body=await response.json().catch(()=>null);if(!response.ok){const error=new Error(body?.message||`Supabase HTTP ${response.status}`);error.code=body?.code;throw error;}return body;
}
const members=await request(`memberships?colony_id=eq.${encodeURIComponent(colony)}&user_id=eq.${encodeURIComponent(user)}&select=role,active`);
if(!members.some(x=>x.active&&['owner','editor'].includes(x.role)))throw new Error('Active owner/editor membership is required.');
const existing=new Map();
for(const [filter,pageSize] of [['neq.archive',500],['eq.archive',3]]) {
 for(let offset=0;;offset+=pageSize){const rows=await request(`entity_records?colony_id=eq.${encodeURIComponent(colony)}&entity_type=${filter}&select=entity_type,entity_id,payload,archived,version&order=entity_type.asc,entity_id.asc&limit=${pageSize}&offset=${offset}`);for(const row of rows)existing.set(`${row.entity_type}\u0000${row.entity_id}`,row);if(rows.length<pageSize)break;}
}
const stable=canonicalStringify;
const insert=[];
for(const e of entries){const old=existing.get(`${e.entity_type}\u0000${e.entity_id}`);if(!old)insert.push(e);else if(!old.archived&&stable(old.payload)===stable(e.payload))report.identical++;else report.conflicts.push({entity_type:e.entity_type,entity_id:e.entity_id,existing_version:old.version,reason:'Existing record differs; retained without overwrite.'});}
try{
 for(const batch of partitionChanges(insert)){
  const saved=await request('rpc/save_records',{method:'POST',body:JSON.stringify({p_colony_id:colony,p_changes:batch})});
  if(!Array.isArray(saved)||saved.length!==batch.length)throw new Error('Import response was incomplete; the batch may have committed. Rerun to reconcile without overwriting.');
  const expected=new Map(batch.map(e=>[`${e.entity_type}\u0000${e.entity_id}`,e]));
  for(const row of saved){const id=`${row.entity_type}\u0000${row.entity_id}`,e=expected.get(id);
   if(!e||row.colony_id!==colony||row.version!==1||row.archived!==e.archived||stable(row.payload)!==stable(e.payload))throw new Error('Import response did not match the requested records. Rerun to reconcile without overwriting.');
   expected.delete(id);
  }
  report.created+=saved.length;report.batches_completed++;console.log(`Imported ${report.created}/${insert.length} new records; existing edits retained.`);
 }
}catch(error){report.error={message:error.message,code:error.code};report.note='A database-rejected batch rolls back. If the response was lost or incomplete, that batch may have committed. Earlier completed batches remain; rerun to reconcile safely without overwriting.';process.exitCode=1;}
if(report.conflicts.length&&!report.error)process.exitCode=2;
await writeFile(resolve(option('--report','import-report.json')),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
