/* Owner-only interface. Authorization is enforced by the server for every request. */
import {MANAGER_PERMISSION_LABELS,defaultManagerPermissions,normalizeManagerPermissions} from './permissions.js?v=24';
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const mounts=new WeakMap();
const editableRoles=new Set(['viewer','editor','manager']);
const exportLevels=new Set(['low','high','max']);
const exportName=level=>({low:'Low (past 3 years)',high:'High (past 6 years)',max:'Max (full history)'}[level]||'Low (past 3 years)');
const savedExportLevel=user=>user.role==='owner'?'max':exportLevels.has(user.export_level)?user.export_level:'low';
const exportOptions=selected=>[...exportLevels].map(level=>`<option value="${level}"${level===selected?' selected':''}>${exportName(level)}</option>`).join('');
const accessName=role=>({owner:'Owner',viewer:'Read only',editor:'Read & write',manager:'Manager'}[role]||'Unavailable');
const statusName=status=>({active:'Active',invited:'Invited',disabled:'Inactive',unavailable:'Unavailable'}[status]||'Unknown');
const errorMessage=error=>error?.message||'The request could not be completed. Try again.';

export async function renderUserManagement(container,hooks) {
  const state={users:[],email:'',inviteRole:'viewer',inviteExportLevel:'low',roles:new Map(),levels:new Map(),permissions:new Map(),invitePermissions:defaultManagerPermissions(),loading:true,busy:false,authorized:false,error:'',notice:''};
  mounts.set(container,state);
  const current=()=>mounts.get(container)===state;
  const protectedUser=user=>user.role==='owner'||!editableRoles.has(user.role)||user.status==='unavailable';
  const request=(action,payload={})=>hooks.manageColonyUsers(action,payload);
  const disabled=()=>state.loading||state.busy?' disabled':'';

  const savedPermissions=user=>user.role==='manager'?normalizeManagerPermissions(user.permissions):defaultManagerPermissions();
  const selectedPermissions=user=>state.permissions.get(user.user_id)||savedPermissions(user);
  const permissionChanged=user=>JSON.stringify(selectedPermissions(user))!==JSON.stringify(savedPermissions(user));
  function permissionFields(permissions,userId=null){return `<fieldset class="compact-details"><legend>Manager permissions</legend><div class="exp-methods">${Object.entries(MANAGER_PERMISSION_LABELS).map(([key,label])=>`<label><input type="checkbox" ${userId?`data-user-permission="${key}" data-user-id="${escapeHTML(userId)}"`:`data-invite-permission="${key}" name="invite-permission-${key}"`}${permissions[key]?' checked':''}${disabled()}> ${escapeHTML(label)}</label>`).join('')}</div><p class="small muted">User administration, the historical roster and permission settings remain owner-only.</p></fieldset>`}

  function userRow(user) {
    const id=escapeHTML(user.user_id),role=state.roles.get(user.user_id)||user.role,level=state.levels.get(user.user_id)||savedExportLevel(user),locked=protectedUser(user),pending=role!==user.role||level!==savedExportLevel(user)||(role==='manager'&&permissionChanged(user));
    const access=locked?`<span class="badge">${escapeHTML(accessName(user.role))}</span>`:`<select aria-label="Access for ${escapeHTML(user.email||user.name||'user')}" data-user-role="${id}"${disabled()}><option value="viewer"${role==='viewer'?' selected':''}>Read only</option><option value="editor"${role==='editor'?' selected':''}>Read &amp; write</option><option value="manager"${role==='manager'?' selected':''}>Manager</option></select>${role==='manager'?permissionFields(selectedPermissions(user),user.user_id):''}`;
    const exportAccess=locked?`<span class="badge">${user.role==='owner'?'Max':exportName(level)}</span>`:`<select aria-label="Export level for ${escapeHTML(user.email||user.name||'user')}" data-user-export-level="${id}"${disabled()}>${exportOptions(level)}</select>`;
    const actions=locked?`<span class="small muted">${user.role==='owner'?'Protected owner':'Unavailable'}</span>`:`<div class="settings-actions"><button class="button secondary" data-user-action="save-access" data-user-id="${id}"${disabled()||(!pending?' disabled':'')}>Save access</button><button class="button secondary" data-user-action="${user.active?'deactivate':'reactivate'}" data-user-id="${id}"${disabled()}>${user.active?'Deactivate':'Reactivate'}</button></div>`;
    return `<tr><td>${escapeHTML(user.name||'Not set')}</td><td>${escapeHTML(user.email||'Unavailable')}</td><td>${access}</td><td>${exportAccess}</td><td><span class="badge${user.active?'':' amber'}">${escapeHTML(statusName(user.status))}</span></td><td>${actions}</td></tr>`;
  }

  function paint() {
    if(!current())return;
    container.innerHTML=`<section class="panel user-management" aria-labelledby="user-management-title"><div class="panel-head"><h2 id="user-management-title">User management</h2><button class="button secondary" data-user-action="refresh"${disabled()}>Refresh</button></div><div class="dialog-content"><div class="alert error" role="alert"${state.error?'':' hidden'}>${escapeHTML(state.error)}</div><div class="banner" role="status"${state.notice?'':' hidden'}>${escapeHTML(state.notice)}</div>${state.authorized?`<form data-user-invite><div class="form-grid"><div class="field"><label for="user-admin-email">Email address</label><input id="user-admin-email" name="invite-email" type="email" autocomplete="email" required maxlength="254" placeholder="name@example.org" value="${escapeHTML(state.email)}"${disabled()}></div><div class="field"><label for="user-admin-invite-role">Access</label><select id="user-admin-invite-role" name="invite-role"${disabled()}><option value="viewer"${state.inviteRole==='viewer'?' selected':''}>Read only</option><option value="editor"${state.inviteRole==='editor'?' selected':''}>Read &amp; write</option><option value="manager"${state.inviteRole==='manager'?' selected':''}>Manager</option></select></div><div class="field"><label for="user-admin-invite-export-level">Export level</label><select id="user-admin-invite-export-level" name="invite-export-level"${disabled()}>${exportOptions(state.inviteExportLevel)}</select></div></div>${state.inviteRole==='manager'?permissionFields(state.invitePermissions):''}<details class="compact-details"><summary>About export levels</summary><p class="small muted">Export level sets the available history window. Read/write access controls editing separately. New users start at Low; the owner retains Max.</p></details><div class="settings-actions"><button type="submit" class="button primary"${disabled()}>Invite user</button></div></form>`:''}</div><div class="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Export level</th><th>Status</th><th>Manage</th></tr></thead><tbody>${state.users.map(userRow).join('')}</tbody></table>${state.loading?'<div class="empty" role="status">Loading users…</div>':!state.users.length?'<div class="empty">No users to display.</div>':''}</div></section>`;
  }

  async function reload() {
    state.authorized=false;state.users=[];paint();
    const result=await request('list');
    if(!result||!Array.isArray(result.users))throw new Error('The user list could not be read. Refresh to try again.');
    state.users=result.users;state.authorized=true;
    state.roles.clear();
    state.levels.clear();
    state.permissions.clear();
  }

  async function refresh() {
    if(state.busy)return;
    state.loading=true;state.error='';paint();
    try {await reload()}catch(error){state.error=errorMessage(error)}
    finally {state.loading=false;paint()}
  }

  async function change(action,payload) {
    if(state.busy||state.loading)return;
    state.busy=true;state.error='';state.notice='';paint();
    let saved=false;
    try {
      const result=await request(action,payload);
      saved=true;
      state.notice=result?.message||(action==='invite'?(result?.email_sent?'Invitation sent.':'Access granted. No invitation email was sent.'):'Access updated.');
      if(action==='invite'){state.email='';state.inviteExportLevel='low';state.invitePermissions=defaultManagerPermissions()}
      await reload();
    } catch(error) {
      if(String(error?.code)==='42501'||Number(error?.status)===403){state.authorized=false;state.users=[]}
      state.error=(saved?'The change was saved, but the user list could not refresh. ':'')+errorMessage(error);
      if(!saved&&(error?.invitationSent===true||error?.invitation_sent===true))state.error+=' An invitation email was sent. Refresh the list before retrying.';
    } finally {state.busy=false;paint()}
  }

  container.oninput=event=>{if(event.target.id==='user-admin-email')state.email=event.target.value};
  container.onchange=event=>{
    const target=event.target;
    if(target.id==='user-admin-email')state.email=target.value;
    if(target.id==='user-admin-invite-role'&&editableRoles.has(target.value)){state.inviteRole=target.value;paint()}
    if(target.dataset?.invitePermission&&Object.hasOwn(MANAGER_PERMISSION_LABELS,target.dataset.invitePermission)&&state.inviteRole==='manager')state.invitePermissions[target.dataset.invitePermission]=target.checked===true;
    if(target.dataset?.userPermission&&Object.hasOwn(MANAGER_PERMISSION_LABELS,target.dataset.userPermission)){const user=state.users.find(row=>row.user_id===target.dataset.userId);if(user&&!protectedUser(user)&&(state.roles.get(user.user_id)||user.role)==='manager'){state.permissions.set(user.user_id,{...selectedPermissions(user),[target.dataset.userPermission]:target.checked===true});paint()}}
    if(target.id==='user-admin-invite-export-level'&&exportLevels.has(target.value))state.inviteExportLevel=target.value;
    if(target.dataset?.userRole&&editableRoles.has(target.value)){
      const user=state.users.find(row=>row.user_id===target.dataset.userRole);
      if(user&&!protectedUser(user)){state.roles.set(user.user_id,target.value);paint()}
    }
    if(target.dataset?.userExportLevel&&exportLevels.has(target.value)){
      const user=state.users.find(row=>row.user_id===target.dataset.userExportLevel);
      if(user&&!protectedUser(user)){state.levels.set(user.user_id,target.value);paint()}
    }
  };
  container.onsubmit=async event=>{
    if(!event.target.hasAttribute('data-user-invite')||!current()||!state.authorized)return;
    event.preventDefault();event.stopPropagation?.();
    state.email=String(event.target.elements?.namedItem('invite-email')?.value??state.email).trim();
    const role=event.target.elements?.namedItem('invite-role')?.value??state.inviteRole;
    const level=event.target.elements?.namedItem('invite-export-level')?.value??state.inviteExportLevel;
    if(!/^[^\s@]+@[^\s@]+$/.test(state.email)||state.email.length>254){state.error='Enter a valid email address.';paint();return}
    if(!editableRoles.has(role)){state.error='Choose Read only, Read & write or Manager access.';paint();return}
    if(!exportLevels.has(level)){state.error='Choose Low, High or Max export access.';paint();return}
    state.inviteRole=role;
    state.inviteExportLevel=level;
    await change('invite',{email:state.email,role,export_level:level,...(role==='manager'?{permissions:{...state.invitePermissions}}:{})});
  };
  container.onclick=async event=>{
    const target=event.target.closest('[data-user-action]');
    if(!target||state.busy||state.loading)return;
    const action=target.dataset.userAction;
    if(action==='refresh'){await refresh();return}
    if(!current()||!state.authorized)return;
    const user=state.users.find(row=>row.user_id===target.dataset.userId);
    if(!user||protectedUser(user))return;
    if(action==='save-access'){
      const role=state.roles.get(user.user_id)||user.role,level=state.levels.get(user.user_id)||savedExportLevel(user);
      if((role!==user.role||level!==savedExportLevel(user)||(role==='manager'&&permissionChanged(user)))&&editableRoles.has(role)&&exportLevels.has(level))await change('update_access',{user_id:user.user_id,role,export_level:level,active:Boolean(user.active),...(role==='manager'?{permissions:{...selectedPermissions(user)}}:{})});
    } else if(action==='deactivate'||action==='reactivate') {
      await change('update_access',{user_id:user.user_id,role:user.role,export_level:savedExportLevel(user),active:action==='reactivate',...(user.role==='manager'?{permissions:savedPermissions(user)}:{})});
    }
  };
  await refresh();
}
