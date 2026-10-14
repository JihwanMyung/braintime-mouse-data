/* Best-effort app activity only. Identity and timestamps are assigned by the server. */
export function createAccessActivity({app,sections,record,getContext,uuid=()=>globalThis.crypto.randomUUID()}={}){
 const allowed=new Set(sections||[]);let identity='',sessionId=null,lastPage=null;
 const context=()=>{const value=getContext?.();return value?.signedIn&&value.mode==='cloud'&&!value.passwordRecovery&&!value.setupRequired&&value.role!=='pending'&&['owner','manager','editor','viewer'].includes(value.role)&&value.url&&value.colonyId&&value.email?`${value.url}|${value.colonyId}|${value.email}`:'';};
 const send=(event,page)=>{try{const result=record?.({app,event,page,sessionId,eventId:uuid()});Promise.resolve(result).catch(()=>{});}catch{/* Activity cannot block normal use. */}};
 function reset(){identity='';sessionId=null;lastPage=null;}
 function observe(page){const actor=context();if(!actor){reset();return;}if(!allowed.has(page))return;if(actor!==identity){try{sessionId=uuid();}catch{reset();return;}identity=actor;lastPage=page;send('session_start',page);return;}if(page!==lastPage){lastPage=page;send('page_view',page);}}
 function signOut(page){if(context()&&context()===identity&&sessionId)send('sign_out',allowed.has(page)?page:lastPage);reset();}
 return {observe,signOut,reset};
}
