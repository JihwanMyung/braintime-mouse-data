import test from 'node:test';
import assert from 'node:assert/strict';
import {renderUserManagement} from '../web/user-management.js';

const initialUsers=()=>[
  {user_id:'OWNER',email:'owner@example.invalid',name:'Lab owner',role:'owner',active:true,status:'active'},
  {user_id:'EDITOR',email:'editor@example.invalid',name:'<b>Test & editor</b>',role:'editor',export_level:'high',active:true,status:'active'},
  {user_id:'VIEWER',email:'reader@example.invalid',name:'Reader',role:'viewer',active:false,status:'disabled'}
];
async function mount(handler) {
  const container={innerHTML:''},calls=[];
  let users=initialUsers();
  const request=async(action,payload={})=>{
    calls.push({action,payload:structuredClone(payload)});
    if(handler)return handler(action,payload,{users,setUsers:value=>{users=value}});
    if(action==='list')return {users:structuredClone(users)};
    if(action==='update_access'){
      const user=users.find(row=>row.user_id===payload.user_id);
      Object.assign(user,payload,{status:payload.active?'active':'disabled'});
      return {user,message:'Access updated.'};
    }
    if(action==='invite'){
      users.push({user_id:'INVITED',email:payload.email,role:payload.role,export_level:payload.export_level,active:true,status:'invited'});
      return {user:users.at(-1),email_sent:true,message:'Invitation sent.'};
    }
    throw new Error('Unexpected action');
  };
  await renderUserManagement(container,{manageColonyUsers:request});
  return {container,calls};
}
const click=(container,action,userId)=>container.onclick({target:{closest:()=>({dataset:{userAction:action,userId}})}});
function invite(container,email,role='viewer',exportLevel='low') {
  return container.onsubmit({target:{hasAttribute:name=>name==='data-user-invite',elements:{namedItem:name=>({value:name==='invite-email'?email:name==='invite-role'?role:exportLevel})}},preventDefault(){},stopPropagation(){}});
}
const row=(html,text)=>[...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(match=>match[1]).find(value=>value.includes(text));

test('user management loads only the user list and protects owners',async()=>{
  const {container,calls}=await mount();
  assert.deepEqual(calls,[{action:'list',payload:{}}]);
  assert.match(container.innerHTML,/Read only/);
  assert.match(container.innerHTML,/Read &amp; write/);
  assert.match(container.innerHTML,/&lt;b&gt;Test &amp; editor&lt;\/b&gt;/);
  assert.doesNotMatch(container.innerHTML,/<b>Test/);
  assert.match(row(container.innerHTML,'owner@example.invalid'),/Protected owner/);
  assert.doesNotMatch(row(container.innerHTML,'owner@example.invalid'),/data-user-action|data-user-role/);
  await click(container,'deactivate','OWNER');
  await click(container,'save-access','OWNER');
  assert.equal(calls.length,1,'forged owner actions cannot leave the component');
});

test('invitation validates the explicit email and access, then accurately reports no-email access grants',async()=>{
  const {container,calls}=await mount(async(action,payload,{users})=>{
    if(action==='list')return {users};
    assert.equal(action,'invite');
    return {user:{user_id:'EXISTING'},email_sent:false,message:'Access granted to the existing account. No invitation email was sent.'};
  });
  await invite(container,'invalid-email');
  assert.equal(calls.length,1);
  assert.match(container.innerHTML,/Enter a valid email address/);
  await invite(container,'person@example.invalid','owner');
  assert.equal(calls.length,1);
  await invite(container,' person@example.invalid ','editor');
  assert.deepEqual(calls[1],{action:'invite',payload:{email:'person@example.invalid',role:'editor',export_level:'low'}});
  assert.equal(calls[2].action,'list');
  assert.match(container.innerHTML,/No invitation email was sent/);
  assert.doesNotMatch(container.innerHTML,/Invitation sent\./);
  assert.match(container.innerHTML,/name="invite-email"[^>]*value=""/);
});

test('access changes require Save and inactive accounts can be reactivated',async()=>{
  const {container,calls}=await mount();
  container.onchange({target:{dataset:{userRole:'EDITOR'},value:'viewer'}});
  assert.equal(calls.length,1,'selecting access remains a local draft');
  await click(container,'save-access','EDITOR');
  assert.deepEqual(calls[1],{action:'update_access',payload:{user_id:'EDITOR',role:'viewer',export_level:'high',active:true}});
  await click(container,'deactivate','EDITOR');
  assert.deepEqual(calls[3],{action:'update_access',payload:{user_id:'EDITOR',role:'viewer',export_level:'high',active:false}});
  await click(container,'reactivate','VIEWER');
  assert.deepEqual(calls[5],{action:'update_access',payload:{user_id:'VIEWER',role:'viewer',export_level:'low',active:true}});
  assert.match(row(container.innerHTML,'reader@example.invalid'),/>Active<\/span>/);
});

test('failed invitations retain the draft and report a partially sent invitation safely',async()=>{
  const {container,calls}=await mount(async(action,payload,{users})=>{
    if(action==='list')return {users};
    const error=new Error('Membership could not be saved <retry>.');error.invitationSent=true;throw error;
  });
  await invite(container,'person@example.invalid','viewer');
  assert.equal(calls.length,2);
  assert.match(container.innerHTML,/Membership could not be saved &lt;retry&gt;/);
  assert.match(container.innerHTML,/An invitation email was sent\. Refresh the list before retrying/);
  assert.match(container.innerHTML,/value="person@example.invalid"/);
  assert.doesNotMatch(container.innerHTML,/class="button primary" disabled/);
});

test('a refresh failure after a successful mutation is not presented as a failed invitation',async()=>{
  let lists=0;
  const {container}=await mount(async(action,payload,{users})=>{
    if(action==='list'){if(++lists>1)throw new Error('Network unavailable.');return {users}}
    return {email_sent:true,message:'Invitation sent.'};
  });
  await invite(container,'person@example.invalid');
  assert.match(container.innerHTML,/Invitation sent\./);
  assert.match(container.innerHTML,/The change was saved, but the user list could not refresh/);
});

test('user list errors can be retried and unavailable accounts remain protected',async()=>{
  let lists=0;
  const {container,calls}=await mount(async(action,payload,{users})=>{
    assert.equal(action,'list');
    if(++lists===1)throw new Error('Connection unavailable.');
    users.push({user_id:'UNAVAILABLE',email:'missing@example.invalid',role:'viewer',active:false,status:'unavailable'});
    return {users};
  });
  assert.match(container.innerHTML,/Connection unavailable/);
  await click(container,'refresh');
  assert.match(container.innerHTML,/owner@example.invalid/);
  assert.doesNotMatch(row(container.innerHTML,'missing@example.invalid'),/data-user-action|data-user-role/);
  await click(container,'reactivate','UNAVAILABLE');
  assert.equal(calls.length,2);
});

test('export level is independent of read/write, with low invitation default and protected owner max',async()=>{
  const {container,calls}=await mount();
  assert.match(container.innerHTML,/name="invite-export-level"[^>]*><option value="low" selected>Low \(past 3 years\)/);
  assert.match(container.innerHTML,/High \(past 6 years\)/);assert.match(container.innerHTML,/Max \(full history\)/);
  const owner=row(container.innerHTML,'owner@example.invalid');assert.match(owner,/>Max<\/span>/);assert.doesNotMatch(owner,/data-user-export-level/);
  container.onchange({target:{dataset:{userExportLevel:'OWNER'},value:'low'}});await click(container,'save-access','OWNER');assert.equal(calls.length,1);
  await invite(container,'read-all@example.invalid','viewer','max');
  assert.deepEqual(calls[1],{action:'invite',payload:{email:'read-all@example.invalid',role:'viewer',export_level:'max'}});
  assert.match(container.innerHTML,/name="invite-export-level"[^>]*><option value="low" selected>/,'each subsequent new invitation starts at low');
});

test('changing export level alone requires Save and sends role plus level together',async()=>{
  const {container,calls}=await mount();
  container.onchange({target:{dataset:{userExportLevel:'EDITOR'},value:'max'}});
  assert.equal(calls.length,1);assert.match(row(container.innerHTML,'editor@example.invalid'),/<option value="max" selected>/);
  await click(container,'save-access','EDITOR');assert.deepEqual(calls[1],{action:'update_access',payload:{user_id:'EDITOR',role:'editor',export_level:'max',active:true}});
  container.onchange({target:{dataset:{userRole:'VIEWER'},value:'editor'}});container.onchange({target:{dataset:{userExportLevel:'VIEWER'},value:'high'}});
  await click(container,'save-access','VIEWER');assert.deepEqual(calls[3],{action:'update_access',payload:{user_id:'VIEWER',role:'editor',export_level:'high',active:false}});
});

test('active toggles preserve stored export permissions and do not apply unsaved level drafts',async()=>{
  const {container,calls}=await mount();
  container.onchange({target:{dataset:{userExportLevel:'EDITOR'},value:'max'}});container.onchange({target:{dataset:{userRole:'EDITOR'},value:'viewer'}});
  await click(container,'deactivate','EDITOR');assert.deepEqual(calls[1],{action:'update_access',payload:{user_id:'EDITOR',role:'editor',export_level:'high',active:false}});
  await click(container,'reactivate','VIEWER');assert.deepEqual(calls[3],{action:'update_access',payload:{user_id:'VIEWER',role:'viewer',export_level:'low',active:true}},'missing legacy permission defaults to low');
});

test('invalid export levels are rejected and failed permission updates retain the reviewed draft',async()=>{
  const {container,calls}=await mount(async(action,payload,{users})=>{if(action==='list')return {users};throw new Error('Permission update failed.');});
  await invite(container,'person@example.invalid','viewer','unlimited');assert.equal(calls.length,1);assert.match(container.innerHTML,/Choose Low, High or Max/);
  container.onchange({target:{dataset:{userExportLevel:'EDITOR'},value:'max'}});await click(container,'save-access','EDITOR');assert.equal(calls.length,2);assert.match(container.innerHTML,/Permission update failed/);assert.match(row(container.innerHTML,'editor@example.invalid'),/<option value="max" selected>/);
  container.onchange({target:{dataset:{userExportLevel:'EDITOR'},value:'administrator'}});await click(container,'save-access','EDITOR');assert.equal(calls.at(-1).payload.export_level,'max','invalid control values do not replace a valid draft');
});
