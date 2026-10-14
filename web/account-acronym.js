/* Self-service display ID only. Authentication names, passwords and historical
 * experiment operator values remain separate. */
const mounts=new WeakMap(),CODE=/^[A-Z][A-Z0-9_-]{0,11}$/;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function normalizeAccountAcronym(value){return typeof value==='string'?value.trim().toUpperCase():''}
export function validateAccountAcronym(value){return CODE.test(value)?[]:['Use 1–12 characters, starting with a letter, then uppercase letters, numbers, underscores or hyphens.']}
export async function renderAccountAcronym(container,hooks={}){
 const state={profile:null,draft:'',busy:false,error:'',notice:''};mounts.set(container,state);
 const current=()=>mounts.get(container)===state&&container.isConnected!==false;
 container.onsubmit=null;container.oninput=null;container.onclick=null;
 container.innerHTML='<p class="small muted" role="status">Loading your lab ID…</p>';
 function paint(){if(!current())return;const p=state.profile?.member;if(!state.profile?.eligible||!p){container.innerHTML=state.error?`<p class="small" role="status">${esc(state.error)}</p>`:'';return}container.innerHTML=`<section class="panel"><div class="panel-head"><h2>Your lab ID</h2></div><form id="account-acronym-form" class="form-stack panel-body"><p class="small">${esc(p.name||'Your profile')}${p.username?` · ${esc(p.username)}`:''}</p><div class="field"><label for="account-acronym">Acronym</label><input id="account-acronym" name="acronym" value="${esc(state.draft)}" autocomplete="off" autocapitalize="characters" spellcheck="false" pattern="[A-Za-z][A-Za-z0-9_\\-]{0,11}" minlength="1" maxlength="12" required${state.busy?' disabled':''}><small>Your registered default: ${esc(p.acronym||'Not assigned')}. Uppercase letters, numbers, underscores or hyphens.</small></div><p class="small">Keep your lab ID consistent across animal and experiment logs. Changing it updates your profile and future entries; earlier recorded IDs remain unchanged.</p>${state.error?`<p class="alert error" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p class="small" role="status">${esc(state.notice)}</p>`:''}<div class="settings-actions"><button class="button primary" type="submit"${state.busy?' disabled':''}>${state.busy?'Saving…':'Save lab ID'}</button><button class="button secondary" type="button" data-account-acronym-refresh${state.busy?' disabled':''}>Reload profile</button></div></form></section>`}
 async function load(){const profile=await hooks.getProfile();if(!current())return false;if(!profile?.eligible||!profile.member){state.profile=null;state.error='A current registered profile is needed to set your lab ID.';paint();return false}if(!Number.isInteger(profile.member.version)||!profile.member.person_id)throw new Error('Your profile version is unavailable. Reload Settings.');state.profile=profile;state.draft=profile.member.acronym||'';paint();return true}
 try{if(!await load())return}catch(error){if(current()){state.error=error.message||'Your lab ID is unavailable.';paint()}return}
 container.oninput=event=>{if(current()&&!state.busy&&event.target.name==='acronym')state.draft=event.target.value};
 container.onclick=async event=>{if(!event.target.closest?.('[data-account-acronym-refresh]')||!current()||state.busy)return;event.preventDefault?.();await renderAccountAcronym(container,hooks)};
 container.onsubmit=async event=>{
  if(event.target.id!=='account-acronym-form')return;event.preventDefault();event.stopPropagation?.();if(!current()||state.busy||!state.profile?.eligible)return;
  state.draft=event.target.elements?.namedItem('acronym')?.value??state.draft;const acronym=normalizeAccountAcronym(state.draft),errors=validateAccountAcronym(acronym);state.error='';state.notice='';if(errors.length){state.error=errors.join(' ');paint();return}
  if(acronym===(state.profile.member.acronym||'')){state.draft=acronym;state.notice='Your lab ID is unchanged.';paint();return}
  const before=state.profile.member;state.busy=true;paint();let committed=false;
  try{
   const latest=await hooks.getProfile();if(!current())return;
   if(!latest?.eligible||latest.member?.person_id!==before.person_id){state.profile=null;throw new Error('Your account or current profile changed. Reload Settings.');}
   if(latest.member.version!==before.version)throw new Error('Your profile changed. Reload the profile before saving your lab ID.');
   const result=await hooks.saveAcronym({acronym,version:before.version});committed=true;if(!current())return;
   const confirmed=result?.member?result:await hooks.getProfile();if(!current())return;
   if(confirmed?.eligible===false||confirmed?.member?.person_id!==before.person_id||confirmed.member.acronym!==acronym||!Number.isInteger(confirmed.member.version)||confirmed.member.version<=before.version){state.profile=null;throw new Error('The saved lab ID could not be confirmed. Reload Settings before trying again.');}
   state.profile={...confirmed,eligible:true};state.draft=acronym;state.notice='Your lab ID was saved. Earlier recorded IDs are unchanged.';
   try{await hooks.onSaved?.(confirmed)}catch(error){state.notice='Your lab ID was saved. The user directory could not refresh; reload Settings.'}
  }catch(error){if(current()){state.error=error?.message||'Your lab ID could not be saved.';if(!committed&&['42501','401','403'].includes(String(error?.code||error?.status||'')))state.profile=null}}
  finally{state.busy=false;paint()}
 };
}
