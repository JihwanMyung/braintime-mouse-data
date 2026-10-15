import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,googleReadToken,mergeSPFBorderSupplement} from '../functions/import-animal-sheet/handler.mjs';
import {SOURCE_SHEETS,parseAnimalSheetWorkbook} from '../functions/import-animal-sheet/source.mjs';
const ANIMAL_SOURCE_ID='SYNTHETIC_ANIMAL_SOURCE_0000000000000001';
const colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',job='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',token='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const vars={SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'SERVER-ONLY',SHEET_COLONY_ID:colony,ANIMAL_SOURCE_SPREADSHEET_ID:ANIMAL_SOURCE_ID,SHEET_SYNC_SECRET:'S'.repeat(64),GOOGLE_SERVICE_ACCOUNT_JSON:'SYNTHETIC ACCOUNT'};
const raw={spreadsheetId:ANIMAL_SOURCE_ID,properties:{title:'PRIVATE WORKBOOK'},sheets:SOURCE_SHEETS.map(s=>({properties:{sheetId:s.sheetId,title:`Current ${s.kind}`},data:[{rowData:[]}]}))};
const context={token,baseline_revision:2,source_spreadsheet_id:ANIMAL_SOURCE_ID,records:[{entity_type:'mice',entity_id:'M1',payload:{mouse_sid:'M1',physical_tag:'P1'},version:1,archived:false}],previous_baseline:{entries:[]}};
const parsed={content_hash:'a'.repeat(64),coverage:{sheets:3},issues:[]},plan={changes:[],historyRecords:[],conflicts:[],nextBaseline:{entries:[]},summary:{unchanged:1}};
function fixture(options={}){
 const calls=[],state={parseCalls:[],mergeCalls:[],...options};
 const fetchImpl=async(url,init)=>{calls.push({url,init,body:init.body?JSON.parse(init.body):null});
  if(url.includes('/claim_animal_sheet_import'))return Response.json(state.context===undefined?context:state.context);
  if(url.startsWith('https://sheets.googleapis.com/')){
   const override=state.googleResponse?.(url);if(override)return override;
   const input=state.raw??raw;
   if(new URL(url).searchParams.getAll('ranges').some(r=>r.endsWith('!AT15:AY22')))return Response.json(state.border??{spreadsheetId:input.spreadsheetId,sheets:[{properties:input.sheets.find(s=>s.properties.sheetId===1250760483)?.properties,data:[{startRow:14,startColumn:45,rowData:[]}]}]});
   return Response.json(input);
  }
  if(url.includes('/commit_animal_sheet_import'))return state.commitResponse?.()??Response.json({job_id:job,status:'completed',summary:{unchanged:1},snapshot_id:colony});
  if(url.includes('/fail_animal_sheet_import'))return new Response(null,{status:204});throw Error('Unexpected URL');};
 const handler=createHandler({env:{get:k=>({...vars,...state.vars})[k]},fetchImpl,tokenProvider:async()=>{if(state.tokenError)throw Error('PRIVATE credential failure');return 'GOOGLE-ONLY'},parse:async(w,options)=>{state.parseCalls.push({w,options});if(state.parseError)throw Error('PRIVATE parser failure');return parsed;},merge:async(...args)=>{state.mergeCalls.push(args);if(state.mergeError)throw Error('PRIVATE merge failure');return structuredClone(plan);},now:()=>new Date('2026-10-14T18:00:00Z')});
 return {handler,state,calls};
}
const request=(body={job_id:job},secret=vars.SHEET_SYNC_SECRET)=>new Request('https://test.supabase.co/functions/v1/import-animal-sheet',{method:'POST',headers:{'x-sync-secret':secret,'Content-Type':'application/json'},body:JSON.stringify(body)});
await test('only server-secret POST requests execute and malformed input never fetches',async()=>{
 for(const req of [new Request('https://test.supabase.co'),request({},'bad'),request({job_id:job,unexpected:true}),request({job_id:'bad'}),request({job_id:'x'.repeat(2000)})]){const f=fixture(),r=await f.handler(req);assert([400,401,405].includes(r.status));assert.equal(f.calls.length,0);}
 for(const changed of [{SUPABASE_URL:'https://test.supabase.co/evil'},{SUPABASE_URL:'https://user:pass@test.supabase.co'},{SHEET_COLONY_ID:'bad'},{ANIMAL_SOURCE_SPREADSHEET_ID:'other'}]){const f=fixture({vars:changed}),r=await f.handler(request());assert.equal(r.status,503);assert.equal(f.calls.length,0);}
});
await test('successful import reads only current sheets after small ID-to-title lookup, preserves raw snapshot and scopes tokens to their services',async()=>{
 const f=fixture(),response=await f.handler(request());assert.equal(response.status,200);const value=await response.json();assert.equal(value.status,'completed');
 const google=f.calls.filter(c=>c.url.startsWith('https://sheets.googleapis.com/'));assert.equal(google.length,3);assert.equal(google[0].init.method,'GET');assert.equal(google[0].init.headers.Authorization,'Bearer GOOGLE-ONLY');assert(!JSON.stringify(google).includes('SERVER-ONLY'));assert(google[0].url.includes(ANIMAL_SOURCE_ID));
 const fields=new URL(google[1].url).searchParams.get('fields');for(const field of ['note','userEnteredValue','effectiveValue','numberFormat','merges'])assert(fields.includes(field));
 assert(!fields.includes('borders'));assert(new URL(google[2].url).searchParams.get('fields').includes('borders'));assert(!new URL(google[2].url).searchParams.get('fields').includes('note'));assert.deepEqual(new URL(google[2].url).searchParams.getAll('ranges'),["'Current spf'!AT15:AY22"]);
 assert.deepEqual(new URL(google[1].url).searchParams.getAll('ranges'),SOURCE_SHEETS.map(s=>`'Current ${s.kind}'`));
 const db=f.calls.filter(c=>c.url.includes('/rest/v1/'));assert(db.every(c=>c.init.headers.Authorization==='Bearer SERVER-ONLY'));assert(db.every(c=>c.init.redirect==='error'));assert(!JSON.stringify(db).includes('GOOGLE-ONLY'));
 assert(f.state.parseCalls[0].w.sheets.every(s=>Array.isArray(s.merges)));assert.equal(f.state.parseCalls[0].options.dataset.tables.mice[0].physical_tag,'P1');
 const commit=db.find(c=>c.url.includes('/commit_'));const {source_capture,...capturedRaw}=commit.body.p_raw_workbook;assert.deepEqual(capturedRaw,raw);assert.equal(source_capture.mode,'current_values_and_targeted_borders');assert.equal(source_capture.borders.response.sheets[0].properties.sheetId,1250760483);assert.equal(commit.body.p_plan.summary.source_capture.atomic_revision,false);assert(!('merges' in commit.body.p_raw_workbook.sheets[0]));assert.equal(commit.body.p_token,token);assert.equal(commit.body.p_baseline_revision,2);assert.equal(commit.body.p_plan.summary.source_issue_count,0);
 assert(!JSON.stringify(value).includes('PRIVATE'));assert(!JSON.stringify(value).includes('SERVER'));assert.equal(response.headers.get('Cache-Control'),'no-store');
});
await test('unchanged raw hash still reparses manager and animal references; duplicate delivery does no Google work',async()=>{
 const f=fixture({context:{...context,last_content_hash:parsed.content_hash}});await f.handler(request());assert.equal(f.state.parseCalls.length,1);assert.equal(f.state.mergeCalls.length,1);
 const duplicate=fixture({context:null}),r=await duplicate.handler(request());assert.equal(r.status,202);assert.equal(duplicate.calls.length,1);
});
await test('source access/schema/size failures are sanitized and reported to the claimed job',async()=>{
 for(const [options,code]of [[{googleResponse:()=>Response.json({error:'PRIVATE upstream'}, {status:403})},'source_access_denied'],[{googleResponse:()=>new Response('oversize',{headers:{'content-length':'24000001'}})},'source_too_large'],[{raw:{...raw,sheets:[]}},'source_schema_changed'],[{parseError:true},'source_schema_changed'],[{mergeError:true},'source_merge_failed'],[{tokenError:true},'import_failed']]){
  const f=fixture(options),r=await f.handler(request()),value=await r.json();assert.equal(r.status,503);assert.equal(value.code,code);assert(!JSON.stringify(value).includes('PRIVATE'));assert.equal(f.calls.some(c=>c.url.includes('/commit_')),false);assert.equal(f.calls.at(-1).body.p_error_code,code);
 }
});
await test('CAS failure records a sanitized conflict and uncertain completed delivery can safely retry',async()=>{
 const f=fixture({commitResponse:()=>Response.json({code:'40001',message:'PRIVATE db details'},{status:400})}),r=await f.handler(request());assert.equal((await r.json()).code,'commit_conflict');assert.equal(f.calls.at(-1).body.p_error_code,'commit_conflict');assert.equal(f.calls.at(-1).body.p_token,token);
});
await test('configured workbook must match database and fetched response before parsing',async()=>{
 const alternative='SYNTHETIC_ANIMAL_SOURCE_0000000000000002';
 for(const options of [{vars:{ANIMAL_SOURCE_SPREADSHEET_ID:alternative}},{context:{...context,source_spreadsheet_id:alternative}}]){
  const f=fixture(options),r=await f.handler(request());assert.equal((await r.json()).code,'database_response_invalid');assert.equal(f.state.parseCalls.length,0);assert(!f.calls.some(c=>c.url.startsWith('https://sheets.googleapis.com/')));
 }
 const mismatch=fixture({raw:{...raw,spreadsheetId:alternative}});assert.equal((await (await mismatch.handler(request())).json()).code,'source_schema_changed');assert.equal(mismatch.state.parseCalls.length,0);
 const configured=fixture({vars:{ANIMAL_SOURCE_SPREADSHEET_ID:alternative},context:{...context,source_spreadsheet_id:alternative},raw:{...raw,spreadsheetId:alternative}});assert.equal((await configured.handler(request())).status,200);assert.equal(configured.state.parseCalls[0].options.expectedSourceId,alternative);
});
await test('Google OAuth assertion requests only spreadsheet read access and never sends its private key',async()=>{
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const bytes=new Uint8Array(await crypto.subtle.exportKey('pkcs8',keys.privateKey)),privateKey='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(bytes).toString('base64')+'\n-----END PRIVATE KEY-----';
 let claim;const result=await googleReadToken(JSON.stringify({client_email:'sync@example.iam.gserviceaccount.com',private_key:privateKey}),async(url,init)=>{assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(init.redirect,'error');assert.equal(init.method,'POST');const assertion=init.body.get('assertion');claim=JSON.parse(Buffer.from(assertion.split('.')[1],'base64url'));assert(!assertion.includes('PRIVATE KEY'));return Response.json({access_token:'google-token'});},new Date('2026-10-15T00:00:00Z'));
 assert.equal(result,'google-token');assert.equal(claim.scope,'https://www.googleapis.com/auth/spreadsheets.readonly');assert.equal(claim.exp-claim.iat,3600);assert.equal(claim.aud,'https://oauth2.googleapis.com/token');
});

await test('oversized current maps fail before parse and duplicate or extra current sheets fail closed',async()=>{
 // Injecting a valid metadata response followed by oversized grid response never commits.
 let n=0;const f=fixture({googleResponse:()=>++n===1?Response.json(raw):new Response('oversize',{headers:{'content-length':'8000001'}})});
 assert.equal((await(await f.handler(request())).json()).code,'source_too_large');assert.equal(f.state.parseCalls.length,0);
 const g=fixture({raw:{...raw,sheets:[...raw.sheets,raw.sheets[0]]}});
 assert.equal((await(await g.handler(request())).json()).code,'source_schema_changed');assert.equal(g.state.parseCalls.length,0);
});

function splitCapture(){
 const w=structuredClone(raw);for(const [i,sheet]of w.sheets.entries()){
  const row=i===2?14:6,label=['L1','CAL-A1','SPF-D1'][i];sheet.properties.gridProperties={rowCount:80,columnCount:71};
  sheet.merges=[{sheetId:sheet.properties.sheetId,startRowIndex:row,endRowIndex:row+1,startColumnIndex:1,endColumnIndex:7}];
  sheet.data=[{startRow:row,startColumn:1,rowData:[{values:[{effectiveValue:{stringValue:label}}]}]}];
 }
 const spf=w.sheets[2];spf.merges.push({sheetId:1250760483,startRowIndex:14,endRowIndex:15,startColumnIndex:45,endColumnIndex:51});
 spf.data.push({startRow:14,startColumn:45,rowData:[{values:[{}]}]},{startRow:15,startColumn:45,rowData:[{values:[{effectiveValue:{stringValue:'P-M12'},note:'Original animal note',userEnteredValue:{formulaValue:'="P-M12"'},effectiveFormat:{numberFormat:{type:'TEXT'}}}]}]},{startRow:16,startColumn:45,rowData:[{values:[{effectiveValue:{numberValue:46000},effectiveFormat:{numberFormat:{type:'DATE',pattern:'yyyy/mm/dd'}},formattedValue:'2025/12/09'}]}]});
 const thick={style:'SOLID_THICK'},header={effectiveFormat:{borders:{top:thick,bottom:thick,left:thick,right:thick}}};
 const body=Array.from({length:6},(_,r)=>({values:Array.from({length:6},(_,c)=>({effectiveFormat:{borders:{...(c===0?{left:thick}:{}),...(c===5?{right:thick}:{}),...(r===5?{bottom:thick}:{})}}}))}));
 const supplement={spreadsheetId:ANIMAL_SOURCE_ID,sheets:[{properties:{sheetId:1250760483,title:spf.properties.title},data:[{startRow:14,startColumn:45,rowData:[{values:[header]}]},{startRow:15,startColumn:45,rowData:body}]}]};return {w,supplement};
}
await test('targeted border reads merge multiple data ranges without replacing values, formulas, notes or date formats',async()=>{
 const {w,supplement}=splitCapture(),animal=structuredClone(w.sheets[2].data[2].rowData[0].values[0]),date=structuredClone(w.sheets[2].data[3].rowData[0].values[0]);
 mergeSPFBorderSupplement(w,supplement);
 const mergedAnimal=w.sheets[2].data[2].rowData[0].values[0],mergedDate=w.sheets[2].data[3].rowData[0].values[0];
 assert.deepEqual({...mergedAnimal,effectiveFormat:{numberFormat:mergedAnimal.effectiveFormat.numberFormat}},animal);
 assert.deepEqual({...mergedDate,effectiveFormat:{numberFormat:mergedDate.effectiveFormat.numberFormat}},date);
 const parsed=await parseAnimalSheetWorkbook(w,{expectedSourceId:ANIMAL_SOURCE_ID,capturedAt:'2026-10-15T02:00:00Z'}),position=parsed.records.find(r=>r.entity_type==='locations'&&r.payload.source_cell==='AT15');
 assert(position);assert.equal(position.payload.source_grid_boundary_range,'AT15:AY21');assert.match(position.payload.source_block_text,/AT16: P-M12/);assert.match(position.payload.source_block_text,/Original animal note/);assert.deepEqual(position.payload.source_observed_tags,['P-M12']);
 const again=splitCapture();mergeSPFBorderSupplement(again.w,again.supplement);assert.equal((await parseAnimalSheetWorkbook(again.w,{expectedSourceId:ANIMAL_SOURCE_ID,capturedAt:'2026-10-16T02:00:00Z'})).content_hash,parsed.content_hash);
});
await test('border identity, coordinates, duplicate overlays and unexpected value fields fail before any commit',async()=>{
 for(const mutate of [
  s=>s.spreadsheetId='SYNTHETIC_OTHER_WORKBOOK_00000000000',s=>s.sheets[0].properties.sheetId=495325388,s=>s.sheets[0].properties.title='Wrong sheet',
  s=>s.sheets[0].data[0].startColumn=44,s=>s.sheets[0].data[1].rowData.push({values:[]},{values:[]}),s=>s.sheets[0].data.push(structuredClone(s.sheets[0].data[0])),
  s=>s.sheets[0].data[0].rowData[0].values[0].note='Do not overwrite',s=>s.sheets[0].data[0].rowData[0].values[0].effectiveFormat.numberFormat={type:'NUMBER'},
 ]){const {w,supplement}=splitCapture();mutate(supplement);assert.throws(()=>mergeSPFBorderSupplement(w,supplement),{code:'source_schema_changed'});}
 const input=splitCapture();input.w.sheets[2].data.push(structuredClone(input.w.sheets[2].data[2]));assert.throws(()=>mergeSPFBorderSupplement(input.w,input.supplement),{code:'source_schema_changed'});
 let n=0;const f=fixture({googleResponse:()=>++n<=2?Response.json(raw):new Response('oversize',{headers:{'content-length':'100001'}})});assert.equal((await(await f.handler(request())).json()).code,'source_too_large');assert.equal(f.state.parseCalls.length,0);assert(!f.calls.some(c=>c.url.includes('/commit_')));
});
