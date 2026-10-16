const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const mounts=new WeakMap();
const categories=[['unknown','Choose category'],['undergraduate','Undergraduate'],['masters',"Master’s student"],['phd','PhD student'],['postdoc','Postdoc'],['visiting_student','Visiting student'],['visiting_faculty','Visiting faculty'],['principal_investigator','Principal investigator'],['other','Other']];
const detailKeys=['name','phone','category','acronym'];
const normalized=(value,key)=>key==='category'?String(value||'unknown'):key==='acronym'?(String(value||'').trim().toUpperCase()||null):(String(value||'').trim()||(key==='name'?'':null));
function clearPasswords(container){for(const field of container.querySelectorAll?.('input[type="password"]')||[])field.value='';}
export function clearAccountSetup(container){if(!container)return;clearPasswords(container);mounts.delete(container);container.onsubmit=null;container.onclick=null;container.innerHTML='';}

export async function renderAccountSetup(container,hooks){
 clearAccountSetup(container);
 const mount={profile:null,busy:false,load:0,savedProfile:false,resume:null};mounts.set(container,mount);
 const current=()=>mounts.get(container)===mount&&container.isConnected!==false;
 const status=message=>{if(current()){const node=container.querySelector('#setup-status');if(node)node.textContent=message;}};
 const details=(member,{acronym=false}={})=>`<div class="field"><label for="setup-name">Name</label><input id="setup-name" name="name" autocomplete="name" maxlength="200" required value="${esc(member.name||'')}"></div><div class="field"><label for="setup-phone">Phone</label><input id="setup-phone" name="phone" type="tel" autocomplete="tel" maxlength="80" value="${esc(member.phone||'')}"></div><div class="field"><label for="setup-category">Category</label><select id="setup-category" name="category">${categories.map(([value,label])=>`<option value="${value}"${value===(member.category||'unknown')?' selected':''}>${label}</option>`).join('')}</select></div>${acronym?`<div class="field"><label for="setup-acronym">Lab ID</label><input id="setup-acronym" name="acronym" maxlength="12" pattern="[A-Za-z][A-Za-z0-9_\\-]{0,11}" value="${esc(member.acronym||'')}"></div>`:''}`;
 function paint(message=''){
  if(!current())return;
  const profile=mount.profile,member=profile?.member||{};
  if(!profile?.eligible&&profile?.registration_allowed!==true){container.innerHTML='<p class="small" role="status">Contact the owner about account access.</p>';return;}
  const pending=!profile.eligible,setup=profile.eligible&&profile.setup_required===true;
  if(!pending&&!setup){
   container.innerHTML=`<p class="small">Username: <strong>${esc(member.username||'Not set')}</strong></p><details class="source-disclosure" open><summary>Edit details</summary><form id="account-details" class="form-stack" style="margin-top:14px">${details(member)}<button type="submit" class="button secondary">Save details</button><p id="setup-status" role="status">${esc(message)}</p><button type="button" class="text-button" id="setup-profile-retry" data-account-retry="true" hidden>Retry profile</button></form></details>`;return;
  }
  container.innerHTML=`<section class="panel"><div class="panel-head"><h2>${pending?'Registration':'Finish your account'}</h2></div><form id="${pending?'account-registration':'first-account-setup'}" class="form-stack panel-body"><p class="small">${esc(member.email||'')}</p>${profile.reason==='approval_pending'?'<p class="small">Awaiting approval.</p>':''}${details(member,{acronym:true})}${setup?`<div class="field"><label for="setup-username">Username</label><input id="setup-username" name="username" autocomplete="username" pattern="[A-Za-z][A-Za-z0-9_.\\-]{2,31}" minlength="3" maxlength="32" required value="${esc(member.username||'')}"><small>3–32 letters, numbers, dots, underscores or hyphens.</small></div><div id="setup-password-fields"><div class="field"><label for="setup-password">Password</label><input id="setup-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><div class="field"><label for="setup-confirm">Confirm password</label><input id="setup-confirm" name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div></div>`:''}<button type="submit" class="button primary">${pending?'Submit for approval':'Save account'}</button><p id="setup-status" role="status">${esc(message)}</p><button type="button" class="text-button" id="setup-profile-retry" data-account-retry="true" hidden>Retry profile</button></form></section>`;
 }
 async function load(){
  const sequence=++mount.load;mount.busy=true;clearPasswords(container);container.innerHTML='<p class="small muted" role="status">Loading your profile…</p>';
  try{const profile=await hooks.getProfile();if(!current()||sequence!==mount.load)return;mount.profile=profile;mount.savedProfile=false;mount.resume=null;paint();}
  catch(error){if(current()&&sequence===mount.load)container.innerHTML=`<p class="small" role="status">${esc(error.message||'Profile unavailable.')}</p><button type="button" class="button secondary" data-account-retry="true">Retry profile</button>`;}
  finally{if(current()&&sequence===mount.load)mount.busy=false;}
 }
 function readDetails(form,includeAcronym){
  const fields=includeAcronym?detailKeys:detailKeys.filter(key=>key!=='acronym'),result={};
  for(const key of fields)result[key]=normalized(form.elements.namedItem(key)?.value,key);
  if(!result.name||result.name.length>200)throw new Error('Enter your name (up to 200 characters).');
  if((result.phone||'').length>80)throw new Error('Phone must be 80 characters or fewer.');
  if(!categories.some(([value])=>value===result.category))throw new Error('Choose a category.');
  if(includeAcronym&&result.acronym&&!/^[A-Z][A-Z0-9_-]{0,11}$/.test(result.acronym))throw new Error('Lab ID: start with a letter, then use up to 12 letters, numbers, underscores or hyphens.');
  return result;
 }
 async function saveDetails(fields){
  const before=mount.profile,version=before?.member?.version;
  if(!Number.isSafeInteger(version)||version<0)throw new Error('Reload your profile before saving.');
  if(mount.savedProfile&&Object.entries(fields).every(([key,value])=>normalized(before.member[key],key)===value))return;
  const next=await hooks.saveProfile(fields,version);if(!current())return;
  if(!next?.member||!Number.isSafeInteger(next.member.version)||next.member.version<version||Object.entries(fields).some(([key,value])=>normalized(next.member[key],key)!==value))throw new Error('Profile save was not confirmed. Retry profile before continuing.');
  mount.profile=next;mount.savedProfile=true;
 }
 container.onclick=event=>{if(event.target.closest?.('[data-account-retry]')&&!mount.busy)void load();};
 container.onsubmit=async event=>{
  const form=event.target;if(!['first-account-setup','account-registration','account-details'].includes(form.id))return;
  event.preventDefault();event.stopPropagation?.();if(!current()||mount.busy)return;
  const setup=form.id==='first-account-setup',pending=form.id==='account-registration',button=form.querySelector('button[type="submit"]')||form.querySelector('button');
  const username=form.elements.namedItem('username'),password=form.elements.namedItem('password'),confirmation=form.elements.namedItem('confirmation');
  let fields,id,phase='profile';
  try{
   fields=readDetails(form,setup||pending);
   if(setup){id=mount.resume?.kind==='verification'?mount.resume.username:String(username?.value||'').trim().toLowerCase();if(!/^[a-z][a-z0-9_.-]{2,31}$/.test(id))throw new Error('Choose a username with 3–32 characters, beginning with a letter.');
    if(!mount.resume){if(password.value!==confirmation.value)throw new Error('Passwords do not match.');if(password.value.length<12||password.value.length>128)throw new Error('Password must contain 12–128 characters.');}}
  }catch(error){status(error.message);return;}
  mount.busy=true;if(button)button.disabled=true;status('Saving…');
  try{
   if(!mount.resume)await saveDetails(fields);
   if(!current())return;
   phase='account';
   if(!setup){paint(pending?'Submitted for approval.':'Details saved.');await hooks.onProfileSaved?.(mount.profile);return;}
   if(mount.profile?.eligible!==true){clearPasswords(container);paint('Awaiting approval.');return;}
   const result=await hooks.complete(id,mount.resume?undefined:password.value);if(!current())return;
   clearPasswords(container);mount.resume=null;mount.profile=result?.member?result:{...mount.profile,setup_required:false,member:{...mount.profile.member,username:id}};
   paint('Account ready.');await hooks.onComplete?.();
  }catch(error){
   if(!current())return;
   if(error.status===401||error.status===403){clearAccountSetup(container);container.innerHTML='<p class="small" role="status">Sign in again to continue.</p>';return;}
   status(error.message||'Could not save. Please retry.');
   if(phase==='profile'||error.setupStage==='profile'){const retry=container.querySelector('#setup-profile-retry');if(retry)retry.hidden=false;}
   if(setup&&error.passwordSaved===true){
    mount.resume={kind:error.accountSaved===true?'verification':'username',username:id};
    if(username&&mount.resume.kind==='verification')username.disabled=true;
    for(const field of [password,confirmation])if(field){field.value='';field.disabled=true;field.required=false;}
    const section=container.querySelector('#setup-password-fields');if(section)section.hidden=true;
    if(button)button.textContent=mount.resume.kind==='verification'?'Retry verification':'Finish setup';
   }
  }finally{
   if(password)password.value='';if(confirmation)confirmation.value='';
   if(current()){mount.busy=false;if(button)button.disabled=false;}
  }
 };
 await load();
}
