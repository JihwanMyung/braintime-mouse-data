import {parseAnimalSheetWorkbook,SOURCE_ID_PATTERN,SOURCE_SHEETS} from './source.mjs';
import {planAnimalSheetMerge} from './merge.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const enc=value=>b64(new TextEncoder().encode(JSON.stringify(value)));
class ImportFailure extends Error{constructor(code){super(code);this.code=code}}
const fail=code=>{throw new ImportFailure(code)};
const BORDER_BOX=Object.freeze({sheetId:1250760483,startRow:14,endRow:22,startColumn:45,endColumn:51,range:'AT15:AY22'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// A separate, small formatting read must never replace the cells containing
// animal tags, dates, notes or formulas from the main current-map capture.
export function mergeSPFBorderSupplement(workbook,supplement){
 if(supplement?.spreadsheetId!==workbook?.spreadsheetId||!Array.isArray(supplement?.sheets)||supplement.sheets.length!==1)fail('source_schema_changed');
 const part=supplement.sheets[0],sheet=workbook.sheets?.find(s=>s.properties?.sheetId===BORDER_BOX.sheetId);
 if(!sheet||part.properties?.sheetId!==BORDER_BOX.sheetId||part.properties.title!==sheet.properties.title||!Array.isArray(part.data)||part.data.length>48)fail('source_schema_changed');
 const original=new Map(),overlay=new Map(),validOffset=n=>Number.isInteger(n)&&n>=0;
 for(const data of sheet.data??[]){
  const sr=data.startRow??0,sc=data.startColumn??0;if(!validOffset(sr)||!validOffset(sc)||!Array.isArray(data.rowData??[]))fail('source_schema_changed');
  for(let r=Math.max(BORDER_BOX.startRow,sr);r<Math.min(BORDER_BOX.endRow,sr+(data.rowData??[]).length);r++){
   const row=data.rowData[r-sr],values=row?.values??[];if(!Array.isArray(values))fail('source_schema_changed');
   for(let c=Math.max(BORDER_BOX.startColumn,sc);c<Math.min(BORDER_BOX.endColumn,sc+values.length);c++){
    const cell=values[c-sc],key=r+','+c;if(!object(cell)||original.has(key))fail('source_schema_changed');original.set(key,cell);
   }
  }
 }
 for(const data of part.data){
  const sr=data.startRow??0,sc=data.startColumn??0,rows=data.rowData??[];
  if(!validOffset(sr)||!validOffset(sc)||sr<BORDER_BOX.startRow||sr>=BORDER_BOX.endRow||sc<BORDER_BOX.startColumn||sc>=BORDER_BOX.endColumn||!Array.isArray(rows)||sr+rows.length>BORDER_BOX.endRow)fail('source_schema_changed');
  for(let ri=0;ri<rows.length;ri++){const cells=rows[ri]?.values??[];if(!Array.isArray(cells)||sc+cells.length>BORDER_BOX.endColumn)fail('source_schema_changed');
   for(let ci=0;ci<cells.length;ci++){
    const cell=cells[ci],key=(sr+ri)+','+(sc+ci);if(!object(cell)||Object.keys(cell).some(k=>k!=='effectiveFormat')||cell.effectiveFormat!==undefined&&(!object(cell.effectiveFormat)||Object.keys(cell.effectiveFormat).some(k=>k!=='borders'))||overlay.has(key))fail('source_schema_changed');
    overlay.set(key,cell.effectiveFormat?.borders??null);
   }
  }
 }
 sheet.data??=[];
 for(const [key,borders]of overlay){
  if(borders===null)continue;if(!object(borders)||Object.keys(borders).some(k=>!['top','bottom','left','right'].includes(k)))fail('source_schema_changed');
  let cell=original.get(key);
  if(!cell){const [startRow,startColumn]=key.split(',').map(Number);cell={};sheet.data.push({startRow,startColumn,rowData:[{values:[cell]}]});original.set(key,cell);}
  if(cell.effectiveFormat?.borders!==undefined)fail('source_schema_changed');
  cell.effectiveFormat={...(cell.effectiveFormat??{}),borders};
 }
 return workbook;
}
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
   const readGoogle=async(url,limit)=>{
    const response=await fetchImpl(url,{method:'GET',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+access},signal:AbortSignal.timeout(60000)});
    if(response.status===403||response.status===404)fail('source_access_denied');if(!response.ok)fail('source_read_failed');
    return boundedJSON(response,limit,'source_too_large');
   };
   const endpoint='https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(sourceId);
   const metadata=await readGoogle(endpoint+'?fields='+encodeURIComponent('spreadsheetId,sheets(properties(sheetId,title))'),1000000);
   if(metadata.spreadsheetId!==sourceId)fail('source_schema_changed');
   const titles=SOURCE_SHEETS.map(def=>{
    const matches=metadata.sheets?.filter(sheet=>sheet.properties?.sheetId===def.sheetId)||[];
    if(matches.length!==1||typeof matches[0].properties.title!=='string'||!matches[0].properties.title)fail('source_schema_changed');
    return matches[0].properties.title;
   });
   const fields='spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,gridProperties),merges,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,note,effectiveFormat(numberFormat),userEnteredFormat(numberFormat)))))';
   const query=new URLSearchParams({includeGridData:'true',fields});
   for(const title of titles)query.append('ranges',"'"+title.replaceAll("'","''")+"'");
   // A daily import needs only current maps, never every historical worksheet.
   // Bound the current response before parsing and avoid a second deep copy.
   const rawWorkbook=await readGoogle(endpoint+'?'+query,8000000),valuesCaptured=now().toISOString();
   if(rawWorkbook.spreadsheetId!==sourceId||rawWorkbook.sheets?.length!==SOURCE_SHEETS.length||SOURCE_SHEETS.some(def=>rawWorkbook.sheets.filter(sheet=>sheet.properties?.sheetId===def.sheetId).length!==1))fail('source_schema_changed');
   const spfTitle=titles[SOURCE_SHEETS.findIndex(def=>def.sheetId===BORDER_BOX.sheetId)];
   const borderFields='spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(effectiveFormat(borders)))))';
   const borderRange="'"+spfTitle.replaceAll("'","''")+"'!"+BORDER_BOX.range;
   const borderQuery=new URLSearchParams({includeGridData:'true',fields:borderFields,ranges:borderRange});
   const borderSupplement=await readGoogle(endpoint+'?'+borderQuery,100000),captured=now().toISOString();
   mergeSPFBorderSupplement(rawWorkbook,borderSupplement);
   // Preserve the separately captured border response and both request scopes.
   // These are source observations, not an atomic Google revision guarantee.
   rawWorkbook.source_capture={schema_version:1,mode:'current_values_and_targeted_borders',values:{fields,ranges:query.getAll('ranges')},borders:{fields:borderFields,range:borderRange,response:borderSupplement}};
   const workbook={...rawWorkbook,sheets:rawWorkbook.sheets.map(sheet=>({...sheet,merges:sheet.merges||[]}))};
   const dataset={tables:{}};for(const row of context.records)(dataset.tables[row.entity_type]??=[]).push(row.payload);
   let parsed,plan;try{parsed=await parse(workbook,{capturedAt:captured,expectedSourceId:sourceId,dataset,managerDirectory:context.manager_directory||[]})}catch{fail('source_schema_changed')}
   try{plan=await merge(parsed,context.records,context.previous_baseline||{})}catch{fail('source_merge_failed')}
   if(!plan||!Array.isArray(plan.changes)||!Array.isArray(plan.historyRecords)||!Array.isArray(plan.conflicts)||!plan.nextBaseline)fail('source_merge_failed');
   plan.summary={...plan.summary,source_coverage:parsed.coverage,source_issue_count:parsed.issues?.length||0,source_capture:{values_captured_at:valuesCaptured,borders_captured_at:captured,atomic_revision:false}};
   return reply(await rpc('commit_animal_sheet_import',{p_colony_id:colony,p_job_id:jobId,p_token:token,p_baseline_revision:context.baseline_revision,p_captured_at:captured,p_content_hash:parsed.content_hash,p_raw_workbook:rawWorkbook,p_plan:plan}));
  }catch(error){
   const code=error instanceof ImportFailure?error.code:'import_failed';
   if(token&&rpc)try{await rpc('fail_animal_sheet_import',{p_colony_id:colony,p_job_id:jobId,p_token:token,p_error_code:code})}catch{}
   // Never return native spreadsheet data, Google errors, credentials or raw SQL.
   return reply({status:'failed',code,job_id:jobId||null},code==='invalid_request'?400:503);
  }
 };
}
