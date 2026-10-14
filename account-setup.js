const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mounts=new WeakMap();
export async function renderAccountSetup(container,hooks){
 const mount={};mounts.set(container,mount);const current=()=>mounts.get(container)===mount&&container.isConnected!==false;
 container.innerHTML='<p class="small muted" role="status">Checking your registered profile…</p>';
 try{
  const profile=await hooks.getProfile();if(!current())return;
  if(!profile?.eligible){container.innerHTML='';return;}
  const p=profile.member;
  if(!profile.setup_required){container.innerHTML=`<p class="small">Username: <strong>${esc(p.username)}</strong> · User: <strong>${esc(p.acronym||'Not assigned')}</strong></p>`;return;}
  container.innerHTML=`<section class="panel"><div class="panel-head"><h2>Finish your account</h2></div><form id="first-account-setup" class="form-stack panel-body"><p class="small">${esc(p.name)} · ${esc(p.email)}</p><p class="small">Lab ID: <strong>${esc(p.acronym||'Not assigned')}</strong>. Keep it consistent across animal and experiment logs. You can review it in Settings → Your lab ID after setup.</p><div class="field"><label for="setup-username">Choose your username</label><input id="setup-username" name="username" autocomplete="username" pattern="[A-Za-z][A-Za-z0-9_.\\-]{2,31}" minlength="3" maxlength="32" required><small>3–32 characters. Letters, numbers, dots, underscores and hyphens.</small></div><div class="field"><label for="setup-password">Choose your app password</label><input id="setup-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><div class="field"><label for="setup-confirm">Confirm password</label><input id="setup-confirm" name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div><button class="button primary" type="submit">Save username &amp; password</button><p role="status" id="setup-status"></p></form></section>`;
  container.onsubmit=async event=>{
   if(event.target.id!=='first-account-setup')return;event.preventDefault();event.stopPropagation?.();
   const form=event.target,username=form.elements.namedItem('username'),password=form.elements.namedItem('password'),confirm=form.elements.namedItem('confirmation'),status=container.querySelector('#setup-status'),button=form.querySelector('button');
   if(button.disabled)return;if(password.value!==confirm.value){status.textContent='Passwords do not match.';return;}
   button.disabled=true;status.textContent='Saving your account…';
   try{await hooks.complete(username.value,password.value);if(current()){status.textContent='Account ready.';await hooks.onComplete?.();}}catch(error){if(current())status.textContent=error.message||'Account setup could not complete.';}
   finally{password.value='';confirm.value='';button.disabled=false;}
  };
 }catch(error){if(current())container.innerHTML=`<p class="small" role="status">${esc(error.message||'Profile setup is unavailable.')}</p>`;}
}
