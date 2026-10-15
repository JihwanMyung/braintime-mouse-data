import {parseAnimalSheetWorkbook,SOURCE_ID_PATTERN,SOURCE_SHEETS} from './source.mjs';
import {planAnimalSheetMerge} from './merge.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const enc=value=>b64(new TextEncoder().encode(JSON.stringify(value)));
class ImportFailure extends Error{constructor(code){super(code);this.code=code}}
const fail=code=>{throw new ImportFailure(code)};
export async function googleReadToken(accountJSON,fetchImpl=fetch,now=new Date()){
 let account;try{account=JSON.parse(accountJSON);if(!account.client_email||!account.private_key)throw Error()}catch{fail('google_auth_failed')}
 try{
  const instant=Math.floor(now.getTime()/1000),data=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iss:account.client_email,scope:'https://www.googleapis.com/auth/spreadsheets.readonly',aud:'https://oauth2.googleapis.com/token',iat:instant,exp:instant+3600});
  const der=Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(data));
  const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:data+'.'+b64(new Uint8Array(sig))}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)fail('google_auth_failed');const value=await response.json();if(typeof value.access_token!=='string'||!value.access_token)fail('google_auth_failed');return value.access_token;
 }catch{fail('google_auth_failed')}
}
async function boundedJSON(response,limit,code){
 const declared=Number(response.headers.get('content-length')||0);if(declared>limit)fail(code);
 const reader=response.body?.getReader();if(!reader)fail(code);let size=0,parts=[];
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();fail(code)}parts.push(value)}
 const data=new Uint8Array(size);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length}try{return JSON.parse(new TextDecoder().decode(data))}catch{fail(code)}
}
export function createHandler({env,fetchImpl=fetch,parse=parseAnimalSheetWorkbook,merge=planAnimalSheetMerge,tokenProvider=googleReadToken,now=()=>new Date()}){
 return async request=>{
  const reply=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(request.method!=='POST')return reply({status:'method_not_allowed'},405);
  const secret=env.get('SHEET_SYNC_SECRET');if(!secret||secret.length<32||request.headers.get('x-sync-secret')!==secret)return reply({status:'unauthorized'},401);
  let colony,jobId,token,rpc;
  try{
   const base=new URL(env.get('SUPABASE_URL')),key=env.get('SUPABASE_SERVICE_ROLE_KEY'),sourceId=env.get('ANIMAL_SOURCE_SPREADSHEET_ID');colony=env.get('SHEET_COLONY_ID');
   if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!key||!UUID.test(colony||'')||typeof sourceId!=='string'||!SOURCE_ID_PATTERN.test(sourceId))fail('not_configured');
   const body=await boundedJSON(request,1024,'invalid_request');if(!body||Object.keys(body).some(k=>k!=='job_id')||!UUID.test(body.job_id||''))fail('invalid_request');jobId=body.job_id;
   rpc=async(name,payload)=>{
    const response=await fetchImpl(base.origin+'/rest/v1/rpc/'+name,{method:'POST',cache:'no-store',redirect:'error',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(90000)});
    const result=response.status===204?null:await boundedJSON(response,16000000,'database_response_invalid');
    if(!response.ok)fail(result?.code==='40001'?'commit_conflict':'commit_failed');return result;
   };
   const context=await rpc('claim_animal_sheet_import',{p_colony_id:colony,p_job_id:jobId});
   if(!context)return reply({status:'already_running_or_finished',job_id:jobId},202);
   token=context.token;if(!UUID.test(token||'')||context.source_spreadsheet_id!==sourceId||!Array.isArray(context.records)||!Number.isInteger(context.baseline_revision))fail('database_response_invalid');
   const access=await tokenProvider(env.get('GOOGLE_SERVICE_ACCOUNT_JSON'),fetchImpl,now());
   // Only GET the original source. The existing outbound function owns its
   // separate output workbook and is never invoked or modified here.
   const fields='spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,gridProperties),merges,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,note,effectiveFormat(numberFormat,borders),userEnteredFormat(numberFormat)))))';
   const url='https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(sourceId)+'?includeGridData=true&fields='+encodeURIComponent(fields);
   const response=await fetchImpl(url,{method:'GET',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+access},signal:AbortSignal.timeout(60000)});
   if(response.status===403||response.status===404)fail('source_access_denied');if(!response.ok)fail('source_read_failed');
   const rawWorkbook=await boundedJSON(response,24000000,'source_too_large'),workbook=structuredClone(rawWorkbook),captured=now().toISOString();
   // Google omits empty repeated merge metadata. Normalize that omission only;
   // never fabricate missing grid data or required worksheets.
   for(const sheet of workbook.sheets||[])if(!sheet.merges)sheet.merges=[];
   if(workbook.spreadsheetId!==sourceId||SOURCE_SHEETS.some(def=>!workbook.sheets?.some(sheet=>sheet.properties?.sheetId===def.sheetId)))fail('source_schema_changed');
   const dataset={tables:{}};for(const row of context.records)(dataset.tables[row.entity_type]??=[]).push(row.payload);
   let parsed,plan;try{parsed=await parse(workbook,{capturedAt:captured,expectedSourceId:sourceId,dataset,managerDirectory:context.manager_directory||[]})}catch{fail('source_schema_changed')}
   try{plan=await merge(parsed,context.records,context.previous_baseline||{})}catch{fail('source_merge_failed')}
   if(!plan||!Array.isArray(plan.changes)||!Array.isArray(plan.historyRecords)||!Array.isArray(plan.conflicts)||!plan.nextBaseline)fail('source_merge_failed');
   plan.summary={...plan.summary,source_coverage:parsed.coverage,source_issue_count:parsed.issues?.length||0};
   return reply(await rpc('commit_animal_sheet_import',{p_colony_id:colony,p_job_id:jobId,p_token:token,p_baseline_revision:context.baseline_revision,p_captured_at:captured,p_content_hash:parsed.content_hash,p_raw_workbook:rawWorkbook,p_plan:plan}));
  }catch(error){
   const code=error instanceof ImportFailure?error.code:'import_failed';
   if(token&&rpc)try{await rpc('fail_animal_sheet_import',{p_colony_id:colony,p_job_id:jobId,p_token:token,p_error_code:code})}catch{}
   // Never return native spreadsheet data, Google errors, credentials or raw SQL.
   return reply({status:'failed',code,job_id:jobId||null},code==='invalid_request'?400:503);
  }
 };
}
