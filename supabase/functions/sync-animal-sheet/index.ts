import {projectRecords,projectionRequests} from './projection.mjs';
const required=(name:string)=>{const v=Deno.env.get(name);if(!v?.trim())throw new Error(`Missing ${name}`);return v;};
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const enc=(v:unknown)=>b64(new TextEncoder().encode(JSON.stringify(v)));
async function googleToken() {
  const account=JSON.parse(required('GOOGLE_SERVICE_ACCOUNT_JSON'));
  const now=Math.floor(Date.now()/1000);
  const data=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iss:account.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
  const der=Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(data));
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:data+'.'+b64(new Uint8Array(sig))}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Google authentication failed (${response.status})`);
  return (await response.json()).access_token;
}
Deno.serve(async req=>{
  if(req.method!=='POST')return new Response('POST required',{status:405});
  if(req.headers.get('x-sync-secret')!==Deno.env.get('SHEET_SYNC_SECRET')||!Deno.env.get('SHEET_SYNC_SECRET'))return new Response('Unauthorized',{status:401});
  let token:string|null=null,writeAttempted=false;
  let rpc:(name:string,payload:unknown)=>Promise<any>;
  let colony='';
  try {
    const url=required('SUPABASE_URL'),key=required('SUPABASE_SERVICE_ROLE_KEY');
    colony=required('SHEET_COLONY_ID');const sheet=required('GOOGLE_OUTPUT_SHEET_ID').trim();
    const sourceSheet=required('ANIMAL_SOURCE_SPREADSHEET_ID').trim();
    // Refuse the original lab workbook, even if accidentally configured.
    if(sheet===sourceSheet)throw new Error('The source workbook cannot be a sync destination.');
    rpc=async(name,payload)=>{const r=await fetch(url+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Database ${name} failed (${r.status})`);return r.status===204?null:r.json();};
    token=await rpc('claim_sheet_sync',{p_colony_id:colony});
    if(!token)return Response.json({status:'already_running_or_needs_recovery'},{status:202});
    const snapshot=await rpc('sheet_sync_snapshot',{p_colony_id:colony,p_token:token});
    if(!snapshot)throw new Error('Sync lock lost.');
    const access=await googleToken();
    const base='https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(sheet);
    const header={Authorization:'Bearer '+access,'Content-Type':'application/json'};
    const meta=await fetch(base+'?fields=sheets.properties',{headers:header,signal:AbortSignal.timeout(20000)});
    if(!meta.ok)throw new Error(`Output workbook read failed (${meta.status})`);
    const grids=projectRecords(snapshot.records,snapshot.captured_at,'Database snapshot refreshed automatically');
    const requests=projectionRequests(grids,(await meta.json()).sheets);
    const body=JSON.stringify({requests});
    if(new TextEncoder().encode(body).length>8_000_000)throw new Error('Projection exceeds configured request size; split design requires review.');
    writeAttempted=true;
    const result=await fetch(base+':batchUpdate',{method:'POST',headers:header,body,signal:AbortSignal.timeout(60000)});
    if(!result.ok)throw new Error(`Google write failed (${result.status}); inspect before unlocking.`);
    await rpc('finish_sheet_sync',{p_colony_id:colony,p_token:token,p_success:true});
    return Response.json({status:'ok',captured_at:snapshot.captured_at});
  } catch(error) {
    const message=error instanceof Error?error.message:'Sync failed';
    if(token&&!writeAttempted)try {await rpc!('finish_sheet_sync',{p_colony_id:colony,p_token:token,p_success:false,p_error:message});}catch{}
    // On an uncertain write, keep the durable lock. Never overlap a retry with a delayed write.
    console.error(message);
    return Response.json({status:writeAttempted?'write_outcome_needs_review':'failed',message},{status:500});
  }
});
