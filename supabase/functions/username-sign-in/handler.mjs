// Passwords are forwarded only to this project's Auth service and never logged.
export function createHandler({env,fetchImpl=fetch,defer}) {
 return async request=>{
  const base=env.get('SUPABASE_URL'),key=env.get('SUPABASE_SERVICE_ROLE_KEY'),anon=env.get('SUPABASE_ANON_KEY'),colony=env.get('USER_MANAGEMENT_COLONY_ID'),app=env.get('USER_MANAGEMENT_APP_URL');
  let origin;try{origin=new URL(app).origin;if(new URL(base).protocol!=='https:'||!key||!anon||!colony)throw Error();}catch{return Response.json({message:'Username sign-in is not configured.'},{status:503});}
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
  if(request.headers.get('origin')===origin)Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'apikey, authorization, content-type'});
  const reply=(body,status=200)=>Response.json(body,{status,headers});
  if(request.headers.get('origin')&&request.headers.get('origin')!==origin)return reply({message:'Open the configured app.'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply({message:'Use POST.'},405);
  const denied=()=>reply({message:'Username or password is incorrect, or colony access is unavailable.'},401);
  try{
   if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))return reply({message:'Send JSON.'},415);
   const reader=request.body?.getReader();if(!reader)return denied();let bytes=0,parts=[];
   for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2048){await reader.cancel();return reply({message:'Request too large.'},413);}parts.push(value);}
   const data=new Uint8Array(bytes);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}
   let body;try{body=JSON.parse(new TextDecoder().decode(data));}catch{return denied();}
   const call=async(path,{admin=true,method='GET',body:payload}={})=>{
    const auth=admin?key:anon;const response=await fetchImpl(base+path,{method,cache:'no-store',redirect:'error',headers:{apikey:auth,Authorization:'Bearer '+auth,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(15000)});
    let value=null;try{value=await response.json();}catch{}return {ok:response.ok,status:response.status,value};
   };
   if(body?.action==='recover'){
    if(typeof defer!=='function')return reply({message:'Password recovery is temporarily unavailable.'},503);
    if(Object.keys(body).some(k=>!['action','identifier'].includes(k))||typeof body.identifier!=='string')return reply({message:'Enter your username or email.'},400);
    const identifier=body.identifier.trim().toLowerCase();
    if(identifier.length>254||!(/^[a-z][a-z0-9_.-]{2,31}$/.test(identifier)||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)))return reply({message:'Enter a valid username or email.'},400);
    let redirect;try{redirect=new URL(app);if(redirect.protocol!=='https:'||redirect.username||redirect.password||redirect.search||redirect.hash)throw Error();}catch{return reply({message:'Password recovery is temporarily unavailable.'},503);}
    const accepted=()=>reply({accepted:true,message:'If this account is eligible, check its registered email and spam folder for a password reset link.'},202);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identifier)),hash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
    const rate=await call('/rest/v1/rpc/consume_password_recovery_attempt',{method:'POST',body:{p_colony_id:colony,p_identifier_hash:hash}});
    if(!rate.ok)return reply({message:'Password recovery is temporarily unavailable.'},503);
    if(rate.value!==true)return reply({message:'Too many recovery requests. Wait one hour before trying again.'},429);
    const account=await call('/rest/v1/rpc/resolve_colony_password_recovery',{method:'POST',body:{p_colony_id:colony,p_identifier:identifier}});
    if(!account.ok)return reply({message:'Password recovery is temporarily unavailable.'},503);
    // Queue one background task for every accepted lookup. Mail-server latency
    // and delivery errors cannot reveal account existence through the response.
    defer(Promise.resolve().then(async()=>{
     if(typeof account.value?.email==='string'&&typeof account.value?.user_id==='string'){
      // Fixed configured return URL, never a client-supplied redirect or email.
      try{await call('/auth/v1/recover?redirect_to='+encodeURIComponent(redirect.href),{admin:false,method:'POST',body:{email:account.value.email}});}catch{/* Do not expose account-specific delivery outcomes. */}
     }
    }));
    return accepted();
   }
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['username','password'].includes(k)))return denied();
   const username=typeof body.username==='string'?body.username.trim().toLowerCase():'';
   if(!/^[a-z][a-z0-9_.-]{2,31}$/.test(username)||typeof body.password!=='string'||body.password.length<1||body.password.length>128)return denied();
   // The service-only atomic counter supplements Supabase Auth's own limits.
   const throttle=await call('/rest/v1/rpc/consume_username_login_attempt',{method:'POST',body:{p_colony_id:colony,p_username:username}});
   if(!throttle.ok)return reply({message:'Sign-in is temporarily unavailable.'},503);
   if(throttle.value!==true)return reply({message:'Too many attempts. Wait 10 minutes before trying again.'},429);
   const result=await call('/rest/v1/lab_members?select=linked_user_id,email&colony_id=eq.'+colony+'&username=eq.'+encodeURIComponent(username)+'&status=eq.current&archived=eq.false&limit=1');
   const person=result.value?.[0];if(!result.ok||!person?.linked_user_id||!person?.email)return denied();
   const allowed=await call('/rest/v1/memberships?select=active&colony_id=eq.'+colony+'&user_id=eq.'+person.linked_user_id+'&limit=1');
   if(!allowed.ok||allowed.value?.[0]?.active!==true)return denied();
   const auth=await call('/auth/v1/token?grant_type=password',{admin:false,method:'POST',body:{email:person.email,password:body.password}});
   if(!auth.ok||typeof auth.value?.access_token!=='string'||!auth.value.access_token||typeof auth.value.refresh_token!=='string'||!auth.value.refresh_token||auth.value?.user?.id!==person.linked_user_id||!auth.value.user.email_confirmed_at||auth.value.user.is_anonymous)return denied();
   return reply(auth.value);
  }catch{return reply({message:'Sign-in could not be confirmed. Please try again later.'},503);}
 };
}
