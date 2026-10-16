/* Best-effort app activity only. Identity and timestamps are assigned by the server. */
export function createAccessActivity({app,sections,record,getContext,uuid=()=>globalThis.crypto.randomUUID(),setTimer=(fn,delay)=>setTimeout(fn,delay),clearTimer=timer=>clearTimeout(timer)}={}){
 const allowed=new Set(sections||[]),pending=new Map(),retryDelays=[1000,3000];let identity='',sessionId=null,lastPage=null;
 const context=()=>{try{const value=getContext?.();return value?.signedIn&&value.mode==='cloud'&&!value.passwordRecovery&&!value.setupRequired&&value.role!=='pending'&&['owner','manager','editor','viewer'].includes(value.role)&&value.url&&value.colonyId&&value.email?JSON.stringify([value.url,value.colonyId,value.email,value.role]):'';}catch{return '';}};
 const current=job=>{if(pending.get(job.key)!==job||identity!==job.identity||sessionId!==job.payload.sessionId)return false;if(context()!==job.identity){reset();return false;}return true;};
 const finish=job=>{if(job.timer!==null)clearTimer(job.timer);if(pending.get(job.key)===job)pending.delete(job.key);};
 function attempt(job){
  if(!current(job)){finish(job);return;}job.timer=null;job.attempts++;
  const settled=result=>{
   // Retry only an unconfirmed delivery, using the same server-idempotent UUID.
   // Debouncing and rate limiting are deliberate server decisions, not failures.
   if(!current(job)||result?.recorded===true||['duplicate','debounced','rate_limited'].includes(result?.reason)||job.attempts>retryDelays.length){finish(job);return;}
   try{job.timer=setTimer(()=>attempt(job),retryDelays[job.attempts-1]);}catch{finish(job);}
  };
  try{Promise.resolve(record(job.payload)).then(settled,()=>settled(null));}catch{settled(null);}
 }
 function send(event,page){
  const key=`${event}:${page}`;if(pending.has(key)||typeof record!=='function')return;
  try{const job={key,identity,payload:{app,event,page,sessionId,eventId:uuid()},attempts:0,timer:null};pending.set(key,job);attempt(job);}catch{/* Activity cannot block normal use. */}
 }
 function reset(){for(const job of pending.values())finish(job);identity='';sessionId=null;lastPage=null;}
 function observe(page){const actor=context();if(!actor){reset();return;}if(!allowed.has(page))return;if(actor!==identity){reset();try{sessionId=uuid();}catch{return;}identity=actor;lastPage=page;send('session_start',page);return;}if(page!==lastPage){lastPage=page;send('page_view',page);}}
 function signOut(page){if(context()&&context()===identity&&sessionId)send('sign_out',allowed.has(page)?page:lastPage);reset();}
 return {observe,signOut,reset};
}
