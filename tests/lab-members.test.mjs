import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLabMembers,validateLabMemberDraft,clearLabMembers,verifiedInvitationLink} from '../web/lab-members.js';
const clone=structuredClone;
const member=(id,extra={})=>({person_id:id,colony_id:'COLONY',version:3,name:'Synthetic Person',email:null,phone:null,acronym:'SP',category:'unknown',status:'current',intended_role:'editor',export_level:'low',notes:null,provenance:{source:'Historical record <sheet>',range:'B3'},archived:false,username:null,linked_user_id:null,...extra});
const initial=()=>[member('CURRENT',{name:'Current person',email:'current@example.invalid',category:'phd',username:'current.user',linked_user_id:'AUTH1',membership_active:true}),member('HISTORICAL',{name:'Historical person',email:'history@example.invalid',phone:'+886 555 001',status:'historical'}),member('REVIEW',{name:'Uncertain person',acronym:'UP',status:'review'})];
async function harness(overrides={}){const container={innerHTML:''},calls=[],messages=[];let members=initial();const hooks={listMembers:async()=>{calls.push({action:'list'});return {members:clone(members)}},saveMember:async person=>{calls.push({action:'save',person:clone(person)});const index=members.findIndex(m=>m.person_id===person.person_id),old=index<0?member('NEW',{version:0,provenance:{}}):members[index],next={...old,...person,person_id:person.person_id||'NEW',version:old.version+1};if(next.linked_user_id)next.membership_active=old.membership_active&&next.status==='current'&&!next.archived;if(index<0)members.push(next);else members[index]=next;return {member:clone(next)}},toast:(message,error)=>messages.push({message,error}),...overrides};await renderLabMembers(container,hooks);return {container,hooks,calls,messages,get members(){return members},setMembers(next){members=next},field(key,value){container.oninput({target:{value,checked:value===true,dataset:{memberField:key}}})},async click(action,id=''){await container.onclick({target:{closest:()=>({dataset:{memberAction:action,memberId:id}})},preventDefault(){}})},async submit(values={}){await container.onsubmit({target:{hasAttribute:key=>key==='data-lab-member-form',elements:{namedItem:key=>Object.hasOwn(values,key)?{value:values[key],checked:values[key]===true}:null}},preventDefault(){},stopPropagation(){}})}}}

test('owner RPC load separates current, historical and review tabs and displays account identity',async()=>{
 const h=await harness();assert.deepEqual(h.calls,[{action:'list'}]);assert.match(h.container.innerHTML,/Current person/);assert.match(h.container.innerHTML,/@current.user/);assert.doesNotMatch(h.container.innerHTML,/Historical person|history@example.invalid/);assert.match(h.container.innerHTML,/Current \(1\)/);await h.click('tab','historical');assert.match(h.container.innerHTML,/Historical person/);assert.match(h.container.innerHTML,/\+886 555 001/);await h.click('edit','HISTORICAL');assert.match(h.container.innerHTML,/Source provenance/);assert.match(h.container.innerHTML,/Historical record &lt;sheet&gt;/);assert.match(h.container.innerHTML,/deactivates its access/);
});

test('preregistration defaults to current editor and saves without contact email or account creation',async()=>{
 const h=await harness();await h.click('new');assert.match(h.container.innerHTML,/value="editor" selected/);assert.match(h.container.innerHTML,/Preregistration sends no email/);h.field('name','New member');h.field('acronym','nm');h.field('category','masters');await h.submit();const call=h.calls.find(c=>c.action==='save');assert.deepEqual(call.person,{person_id:null,version:0,name:'New member',email:null,phone:null,acronym:'NM',category:'masters',status:'current',intended_role:'editor',export_level:'low',notes:null,cage_manager_eligible:false});assert.match(h.container.innerHTML,/Email needed/);assert.match(h.container.innerHTML,/Member saved. No email was sent/);assert(!h.calls.some(c=>/invite|auth|email/.test(c.action)));
});

test('editing submits exact CAS version while preserving provenance and server account fields by omission',async()=>{
 const h=await harness();await h.click('edit','CURRENT');h.field('status','historical');h.field('intended_role','viewer');h.field('export_level','high');h.field('notes','Checked roster');await h.submit({email:' Current@Example.Invalid '});assert.equal(h.calls.filter(c=>c.action==='save').length,0);assert.match(h.container.innerHTML,/lose access.*immediately/);await h.click('confirm-transition');const p=h.calls.find(c=>c.action==='save').person;assert.equal(p.person_id,'CURRENT');assert.equal(p.version,3);assert.equal(p.email,'current@example.invalid');assert.equal(p.status,'historical');assert.equal(p.intended_role,'viewer');assert.equal(p.export_level,'high');for(const key of ['username','linked_user_id','provenance','created_at','created_by','effective_role','membership_active','archived'])assert.equal(Object.hasOwn(p,key),false,key+' must stay server-owned or preserved');assert.deepEqual(h.members.find(m=>m.person_id==='CURRENT').provenance,initial()[0].provenance);assert.match(h.container.innerHTML,/Current person/);assert.match(h.container.innerHTML,/Historical \(2\)/);
});

test('invalid email and privilege values block RPC submission while blank contacts are allowed',async()=>{
 const h=await harness();await h.click('new');h.field('name','Member');h.field('email','not-an-email');await h.submit();assert.equal(h.calls.filter(c=>c.action==='save').length,0);assert.match(h.container.innerHTML,/valid email/);h.field('email','');h.field('export_level','unlimited');await h.submit();assert.match(h.container.innerHTML,/Low, High or Max/);h.field('export_level','low');h.field('intended_role','owner');await h.submit();assert.equal(h.calls.filter(c=>c.action==='save').length,0);assert.match(h.container.innerHTML,/Read only, Read &amp; write or Manager/);assert(validateLabMemberDraft({name:'A',email:null,phone:null,acronym:null,category:'unknown',status:'review',intended_role:'editor',export_level:'low',notes:null}).length===0);
});

test('CAS conflicts preserve the draft and do not claim a save or discard entered notes',async()=>{
 const h=await harness({saveMember:async()=>{throw Object.assign(new Error('Stale'),{code:'40001'})}});await h.click('edit','CURRENT');h.field('notes','Local draft');await h.submit();assert.match(h.container.innerHTML,/changed while you were editing/);assert.match(h.container.innerHTML,/Local draft/);assert.doesNotMatch(h.container.innerHTML,/Member saved/);assert.equal(h.messages.at(-1).error,true);
});

test('denied list access never exposes forms, contacts, or a usable forged save action',async()=>{
 let saves=0;const h=await harness({listMembers:async()=>{throw Object.assign(new Error('permission denied'),{code:'42501'})},saveMember:async()=>{saves++}});assert.match(h.container.innerHTML,/Only the database owner/);assert.doesNotMatch(h.container.innerHTML,/Current person|data-lab-member-form|Preregister member<\/button>/);await h.click('new');await h.submit({name:'Forged'});assert.equal(saves,0);
});

test('authorization loss on save clears the private member list and draft',async()=>{
 const h=await harness({saveMember:async()=>{throw Object.assign(new Error('Owner access required'),{code:'42501'})}});await h.click('edit','CURRENT');await h.submit();assert.match(h.container.innerHTML,/Only the database owner/);assert.doesNotMatch(h.container.innerHTML,/Current person|current@example.invalid|data-lab-member-form/);
});

test('successful save followed by refresh failure reports committed state without a duplicate editable draft',async()=>{
 const h=await harness();await h.click('edit','CURRENT');h.field('notes','Saved');h.hooks.listMembers=async()=>{throw new Error('Disconnected')};await h.submit();assert.equal(h.calls.filter(c=>c.action==='save').length,1);assert.match(h.container.innerHTML,/member was saved, but the roster could not refresh/);assert.doesNotMatch(h.container.innerHTML,/data-lab-member-form/);
});

test('unsafe member names, notes and provenance are escaped',async()=>{
 const h=await harness({listMembers:async()=>({members:[member('UNSAFE',{name:'<script>Person</script>',notes:'</textarea><script>bad</script>',provenance:{text:'<script>source</script>'}})]})});assert.match(h.container.innerHTML,/&lt;script&gt;Person/);await h.click('edit','UNSAFE');assert.match(h.container.innerHTML,/&lt;\/textarea&gt;&lt;script&gt;bad/);assert.match(h.container.innerHTML,/&lt;script&gt;source/);assert.doesNotMatch(h.container.innerHTML,/<script>/);
});

test('owner access and Max are displayed as protected instead of editable member privileges',async()=>{
 const h=await harness({listMembers:async()=>({members:[member('OWNER',{effective_role:'owner',effective_export_level:'max',linked_user_id:'OWNER-AUTH',username:'lab.owner'})]})});assert.match(h.container.innerHTML,/Max · full history/);await h.click('edit','OWNER');assert.match(h.container.innerHTML,/owner retains Owner access and Max/);assert.match(h.container.innerHTML,/<select id="member-intended_role"[^>]* disabled>/);assert.match(h.container.innerHTML,/<select id="member-export_level"[^>]* disabled>/);
});

test('a pending old owner fetch cannot overwrite a newer unauthorized mount',async()=>{
 const container={innerHTML:''};let release;const old=renderLabMembers(container,{listMembers:()=>new Promise(resolve=>{release=resolve})});await renderLabMembers(container,{listMembers:async()=>{throw Object.assign(new Error('Denied'),{code:'42501'})}});release({members:initial()});await old;assert.match(container.innerHTML,/Only the database owner/);assert.doesNotMatch(container.innerHTML,/current@example.invalid|Current person/);
});


test('owner preregistration may designate Manager and full historical export independently',async()=>{
 const h=await harness();await h.click('new');h.field('name','Manager member');h.field('email','manager@example.invalid');h.field('intended_role','manager');h.field('export_level','max');await h.submit();const p=h.calls.find(c=>c.action==='save').person;assert.equal(p.intended_role,'manager');assert.equal(p.export_level,'max');assert.match(h.container.innerHTML,/Manager/);assert.match(h.container.innerHTML,/Max · full history/);
});


test('owner quick moves require review, preserve identity and source history, and keep returned accounts inactive',async()=>{
 const h=await harness(),before=clone(h.members[0]);assert.match(h.container.innerHTML,/Move to Historical/);await h.click('move-historical','CURRENT');assert.equal(h.calls.filter(c=>c.action==='save').length,0);assert.match(h.container.innerHTML,/lose access.*immediately/);assert.match(h.container.innerHTML,/same person record/);await h.click('cancel-transition');assert.equal(h.calls.filter(c=>c.action==='save').length,0);assert.match(h.container.innerHTML,/Current person/);
 await h.click('move-historical','CURRENT');await h.click('confirm-transition');let call=h.calls.find(c=>c.action==='save');assert.deepEqual(call.person,{person_id:'CURRENT',version:3,status:'historical'});let saved=h.members.find(m=>m.person_id==='CURRENT');assert.equal(saved.membership_active,false);assert.equal(saved.username,before.username);assert.deepEqual(saved.provenance,before.provenance);assert.match(h.container.innerHTML,/Moved to Historical/);assert.match(h.container.innerHTML,/Move to Current/);
 await h.click('move-current','CURRENT');assert.match(h.container.innerHTML,/remains inactive until.*Reactivate/);await h.click('confirm-transition');call=h.calls.filter(c=>c.action==='save').at(-1);assert.deepEqual(call.person,{person_id:'CURRENT',version:4,status:'current'});saved=h.members.find(m=>m.person_id==='CURRENT');assert.equal(saved.membership_active,false);assert.deepEqual(saved.provenance,before.provenance);assert.equal(saved.person_id,before.person_id);assert.match(h.container.innerHTML,/Account remains inactive; Reactivate it in User management/);assert(!h.calls.some(c=>/invite|email|auth/.test(c.action)));
});
test('returning an unclaimed historical member permits setup without creating or inviting an account',async()=>{
 const h=await harness();await h.click('tab','historical');await h.click('move-current','HISTORICAL');assert.match(h.container.innerHTML,/may complete account setup/);await h.click('confirm-transition');const saved=h.members.find(m=>m.person_id==='HISTORICAL');assert.equal(saved.status,'current');assert.equal(saved.linked_user_id,null);assert.equal(saved.username,null);assert.equal(h.calls.filter(c=>c.action==='save').length,1);assert.match(h.container.innerHTML,/No email was sent/);
});
test('owner and archived member moves are hidden and forged actions cannot submit',async()=>{
 const h=await harness({listMembers:async()=>({members:[member('OWNER',{effective_role:'owner'}),member('ARCHIVED',{archived:true})]})});assert.doesNotMatch(h.container.innerHTML,/data-member-action="move-/);await h.click('move-historical','OWNER');await h.click('confirm-transition');await h.click('move-historical','ARCHIVED');await h.click('confirm-transition');assert.equal(h.calls.filter(c=>c.action==='save').length,0);
 const denied=await harness({listMembers:async()=>{throw Object.assign(new Error('Denied'),{code:'42501'})}});await denied.click('move-historical','CURRENT');await denied.click('confirm-transition');assert.equal(denied.calls.filter(c=>c.action==='save').length,0);
});
test('stale or denied transition results do not claim a move, and disabled self-acronym syntax stays editable',async()=>{
 const stale=await harness({saveMember:async()=>{throw Object.assign(new Error('Stale'),{code:'40001'})}});await stale.click('move-historical','CURRENT');await stale.click('confirm-transition');assert.match(stale.container.innerHTML,/changed while you were editing/);assert.doesNotMatch(stale.container.innerHTML,/Moved to Historical/);await stale.click('cancel-transition');assert.match(stale.container.innerHTML,/Current person/);
 const h=await harness({saveMember:async()=>{throw Object.assign(new Error('Owner access required'),{code:'42501'})}});await h.click('move-historical','CURRENT');await h.click('confirm-transition');assert.doesNotMatch(h.container.innerHTML,/Current person|current@example.invalid|confirm-transition/);
 for(const acronym of ['J','M-G_2'])assert.deepEqual(validateLabMemberDraft({...initial()[0],acronym}),[]);
});

test('source-backed nicknames are displayed and searchable without changing the canonical name',async()=>{
 const h=await harness({listMembers:async()=>({members:[member('ALIAS',{name:'Canonical name',provenance:{aliases:['Nickname','<script>alias</script>'],nickname:'Prior nickname'}})]})});assert.match(h.container.innerHTML,/<strong>Canonical name \(Prior nickname\)<\/strong>/);assert.match(h.container.innerHTML,/Nickname/);assert.match(h.container.innerHTML,/Prior nickname/);assert.doesNotMatch(h.container.innerHTML,/<script>/);h.container.oninput({target:{id:'member-search',value:'Nickname',selectionStart:8}});assert.match(h.container.innerHTML,/Canonical name/);h.container.oninput({target:{id:'member-search',value:'Missing',selectionStart:7}});assert.doesNotMatch(h.container.innerHTML,/Canonical name/);assert.equal(h.calls.filter(c=>c.action==='save').length,0);
});

test('Historical cage-manager checkbox saves a strict boolean independently of account access',async()=>{
 const h=await harness();await h.click('edit','HISTORICAL');
 assert.match(h.container.innerHTML,/type="checkbox"[^>]*> Show in cage manager list/);
 assert.doesNotMatch(h.container.innerHTML,/type="checkbox"[^>]* checked/);
 h.field('cage_manager_eligible',true);await h.submit();
 let saved=h.calls.filter(call=>call.action==='save').at(-1).person;
 assert.equal(saved.cage_manager_eligible,true);assert.equal(saved.status,'historical');
 assert.equal(saved.intended_role,'editor');assert.equal(saved.export_level,'low');
 await h.click('edit','HISTORICAL');assert.match(h.container.innerHTML,/type="checkbox" checked/);
 await h.submit({cage_manager_eligible:false});saved=h.calls.filter(call=>call.action==='save').at(-1).person;
 assert.equal(saved.cage_manager_eligible,false);assert.equal(saved.intended_role,'editor');
 assert(!h.calls.some(call=>/invite|auth/.test(call.action)));
});

test('cage-manager eligibility stays preserved on ordinary edits and is hidden outside unarchived Historical records',async()=>{
 for(const extra of [{status:'current'},{status:'review'},{status:'historical',archived:true}]){
  const h=await harness({listMembers:async()=>({members:[member('KEEP',{...extra,cage_manager_eligible:true})]})});
  await h.click('edit','KEEP');assert.doesNotMatch(h.container.innerHTML,/Show in cage manager list/);
  h.field('name','Edited person');h.field('cage_manager_eligible',false);await h.submit({cage_manager_eligible:false});
  assert.equal(h.calls.find(call=>call.action==='save').person.cage_manager_eligible,true);
 }
 const h=await harness();await h.click('edit','CURRENT');assert.doesNotMatch(h.container.innerHTML,/Show in cage manager list/);
 await h.submit();assert.equal(h.calls.find(call=>call.action==='save').person.cage_manager_eligible,false);
});

test('changing membership in the editor reveals Historical eligibility without changing access or bypassing transition review',async()=>{
 const h=await harness();await h.click('edit','CURRENT');h.field('notes','Draft retained');
 h.container.onchange({target:{value:'historical',dataset:{memberField:'status'}}});
 assert.match(h.container.innerHTML,/Show in cage manager list/);assert.match(h.container.innerHTML,/Draft retained/);
 h.container.onchange({target:{checked:true,value:'on',dataset:{memberField:'cage_manager_eligible'}}});
 await h.submit();assert.equal(h.calls.filter(call=>call.action==='save').length,0);
 assert.match(h.container.innerHTML,/lose access.*immediately/);await h.click('confirm-transition');
 const saved=h.calls.find(call=>call.action==='save').person;
 assert.equal(saved.cage_manager_eligible,true);assert.equal(saved.intended_role,'editor');assert.equal(saved.export_level,'low');
 assert.equal(h.members.find(person=>person.person_id==='CURRENT').membership_active,false);
 await h.click('edit','CURRENT');h.container.onchange({target:{value:'current',dataset:{memberField:'status'}}});
 assert.doesNotMatch(h.container.innerHTML,/Show in cage manager list/);await h.submit();await h.click('confirm-transition');
 assert.equal(h.calls.filter(call=>call.action==='save').at(-1).person.cage_manager_eligible,true);
 assert.equal(h.members.find(person=>person.person_id==='CURRENT').membership_active,false);
});

test('quick membership moves leave cage-manager choice untouched and stale saves retain the checked draft',async()=>{
 const h=await harness();h.setMembers([member('FLAG',{cage_manager_eligible:true})]);await h.click('refresh');
 await h.click('move-historical','FLAG');await h.click('confirm-transition');
 assert.deepEqual(h.calls.find(call=>call.action==='save').person,{person_id:'FLAG',version:3,status:'historical'});
 assert.equal(h.members[0].cage_manager_eligible,true);
 const stale=await harness({saveMember:async()=>{throw Object.assign(new Error('Stale'),{code:'40001'});}});
 await stale.click('edit','HISTORICAL');stale.field('cage_manager_eligible',true);await stale.submit();
 assert.match(stale.container.innerHTML,/changed while you were editing/);assert.match(stale.container.innerHTML,/type="checkbox" checked/);
 for(const value of ['true','false',1,null])assert(validateLabMemberDraft({...initial()[1],cage_manager_eligible:value}).some(message=>message.includes('cage manager list')));
});

const invitee=(extra={})=>member('INVITEE',{name:'New colleague',email:'new@example.invalid',intended_role:'editor',export_level:'high',...extra});
test('invitation requires review of the saved recipient and access, then an explicit send',async()=>{
 const sent=[];const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async payload=>{sent.push(payload);return {person_id:'INVITEE',email_sent:true,message:'Queued'}}});
 assert.match(h.container.innerHTML,/Invite by email/);assert.equal(sent.length,0);await h.click('invite','INVITEE');assert.match(h.container.innerHTML,/Invite New colleague\?/);assert.match(h.container.innerHTML,/<strong>new@example.invalid<\/strong>/);assert.match(h.container.innerHTML,/Read &amp; write/);assert.match(h.container.innerHTML,/High · past 6 years/);assert.match(h.container.innerHTML,/chooses their own username and password/);assert.equal(sent.length,0);await h.click('cancel-invitation');assert.equal(sent.length,0);
 await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.deepEqual(sent,[{person_id:'INVITEE',version:3}]);assert.match(h.container.innerHTML,/Email request accepted for new@example.invalid/);assert.match(h.container.innerHTML,/Resend invitation/);await h.click('invite','INVITEE');assert.match(h.container.innerHTML,/already accepted this session/);assert.equal(sent.length,1);await h.click('cancel-invitation');await h.click('refresh');assert.doesNotMatch(h.container.innerHTML,/Resend invitation|Invitation sent/);
});

test('invitation eligibility excludes owner, claimed, archived, historical, review and invalid email records',async()=>{
 const records=[invitee({person_id:'OWNER',effective_role:'owner'}),invitee({person_id:'CLAIMED',linked_user_id:'AUTH'}),invitee({person_id:'ARCHIVED',archived:true}),invitee({person_id:'HISTORICAL',status:'historical'}),invitee({person_id:'REVIEW',status:'review'}),invitee({person_id:'NOEMAIL',email:''}),invitee({person_id:'INVALID',email:'broken'}),invitee({person_id:'BADACCESS',intended_role:'owner'}),invitee({person_id:'BADLEVEL',export_level:'unlimited'})];let sends=0;
 const h=await harness({listMembers:async()=>({members:records}),inviteMember:async()=>{sends++}});assert.doesNotMatch(h.container.innerHTML,/data-member-action="invite"/);for(const m of records){await h.click('invite',m.person_id);await h.click('confirm-invitation')}assert.equal(sends,0);
 const unavailable=await harness({listMembers:async()=>({members:[invitee()]})});assert.doesNotMatch(unavailable.container.innerHTML,/data-member-action="invite"/);await unavailable.click('invite','INVITEE');assert.doesNotMatch(unavailable.container.innerHTML,/Send invitation/);
});

test('invitation pending state blocks duplicate sends, edits, navigation and refresh',async()=>{
 let resolve,sends=0;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:()=>{sends++;return new Promise(r=>{resolve=r})}});await h.click('invite','INVITEE');const pending=h.click('confirm-invitation');assert.match(h.container.innerHTML,/Sending…/);assert.match(h.container.innerHTML,/aria-busy="true"/);await h.click('confirm-invitation');await h.click('edit','INVITEE');await h.click('cancel-invitation');await h.click('refresh');assert.equal(sends,1);assert.match(h.container.innerHTML,/Sending…/);resolve({person_id:'INVITEE',email_sent:true});await pending;assert.match(h.container.innerHTML,/Email request accepted/);
});

test('uncertain or mismatched invitation responses do not claim success or automatically retry',async()=>{
 for(const result of [null,{person_id:'INVITEE',email_sent:false},{person_id:'WRONG',email_sent:true},{person_id:'INVITEE',email_sent:true,email:'wrong@example.invalid'}]){let sends=0;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{sends++;return result}});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.equal(sends,1);assert.match(h.container.innerHTML,/Invitation delivery was not confirmed/);assert.match(h.container.innerHTML,/no automatic retry was made/);assert.doesNotMatch(h.container.innerHTML,/Invitation sent|Resend invitation|data-member-action="confirm-invitation"/);await h.click('confirm-invitation');assert.equal(sends,1)}
});

test('invitation failures preserve readable errors and authorization loss clears private roster',async()=>{
 for(const failure of [new Error('SMTP not configured'),Object.assign(new Error('Stale member'),{code:'40001'})]){const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{throw failure}});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.match(h.container.innerHTML,/SMTP not configured|changed while you were editing/);assert.match(h.container.innerHTML,/Invitation delivery was not confirmed/);assert.doesNotMatch(h.container.innerHTML,/Invitation sent/)}
 let sends=0;const denied=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{sends++;throw Object.assign(new Error('Owner access required'),{code:'42501'})}});await denied.click('invite','INVITEE');await denied.click('confirm-invitation');assert.match(denied.container.innerHTML,/Only the database owner/);assert.doesNotMatch(denied.container.innerHTML,/New colleague|new@example.invalid|Send invitation/);await denied.click('invite','INVITEE');await denied.click('confirm-invitation');assert.equal(sends,1);
});

test('invitation confirmation and success escape recipient display data',async()=>{
 const h=await harness({listMembers:async()=>({members:[invitee({name:'<img src=x onerror=bad()>',email:'<x>@example.invalid',provenance:{nickname:'<script>Nickname</script>'}})]}),inviteMember:async()=>({person_id:'INVITEE',email_sent:true})});await h.click('invite','INVITEE');assert.match(h.container.innerHTML,/&lt;img/);assert.match(h.container.innerHTML,/&lt;script&gt;Nickname/);assert.match(h.container.innerHTML,/&lt;x&gt;@example.invalid/);assert.doesNotMatch(h.container.innerHTML,/<img|<script>/);await h.click('confirm-invitation');assert.match(h.container.innerHTML,/Email request accepted for &lt;x&gt;@example.invalid/);assert.doesNotMatch(h.container.innerHTML,/<img|<script>/);
});

test('stale invite completion cannot overwrite a new mount or leak recipient details',async()=>{
 let resolve;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:()=>new Promise(r=>{resolve=r})});await h.click('invite','INVITEE');const pending=h.click('confirm-invitation');await renderLabMembers(h.container,{listMembers:async()=>{throw Object.assign(new Error('Denied'),{code:'42501'})}});resolve({person_id:'INVITEE',email_sent:true});await pending;assert.match(h.container.innerHTML,/Only the database owner/);assert.doesNotMatch(h.container.innerHTML,/new@example.invalid|Invitation sent/);assert.equal(h.messages.length,0);
});

test('saving and moving a member never call the invitation hook',async()=>{
 let sends=0;const h=await harness({inviteMember:async()=>{sends++}});await h.click('new');h.field('name','New colleague');h.field('email','new@example.invalid');await h.submit();await h.click('move-historical','NEW');await h.click('confirm-transition');await h.click('move-current','NEW');await h.click('confirm-transition');assert.equal(sends,0);assert.match(h.container.innerHTML,/No email was sent/);
});

test('an accepted email followed by a registration recheck failure is distinct from an uncertain send',async()=>{
 let sends=0;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{sends++;throw Object.assign(new Error('The email service accepted the invitation, but registration could not be reconfirmed.'),{invitationSent:true,code:'invitation_sent_registration_unconfirmed'})}});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.match(h.container.innerHTML,/Email request accepted; registration status could not be reconfirmed/);assert.match(h.container.innerHTML,/Refresh Members before sending again/);assert.match(h.container.innerHTML,/Resend invitation/);assert.doesNotMatch(h.container.innerHTML,/Invitation delivery was not confirmed/);await h.click('confirm-invitation');assert.equal(sends,1);
});

test('saving a changed recipient clears the prior email session resend flag after roster reload',async()=>{
 const h=await harness({inviteMember:async()=>({person_id:'INVITEE',email_sent:true})});h.setMembers([invitee()]);await h.click('refresh');await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.match(h.container.innerHTML,/Resend invitation/);await h.click('edit','INVITEE');h.field('email','updated@example.invalid');await h.submit();assert.match(h.container.innerHTML,/updated@example.invalid/);assert.doesNotMatch(h.container.innerHTML,/Resend invitation/);await h.click('invite','INVITEE');assert.match(h.container.innerHTML,/<strong>updated@example.invalid<\/strong>/);assert.doesNotMatch(h.container.innerHTML,/already accepted this session/);
});

const manualURL='https://njhetwortngnniyrhcfk.supabase.co/auth/v1/verify?token=synthetic-token-1234567890&type=invite&redirect_to=https%3A%2F%2Fbraintimelab.github.io%2Fmouse-data%2F';
const manualResult=(extra={})=>({person_id:'INVITEE',invitation_link:manualURL,link_kind:'invitation',expires_at:null,email_sent:false,delivery_status:'not_sent',...extra});
test('manual setup link validates provider origin, exact callback and single token query without accepting login URLs',()=>{
 assert.equal(verifiedInvitationLink(manualResult()),manualURL);assert.equal(verifiedInvitationLink(manualResult({invitation_link:manualURL.replace('type=invite','type=magiclink'),link_kind:'sign_in_link'})),null);
 for(const url of ['javascript:alert(1)','https://braintimelab.github.io/mouse-data/',manualURL.replace('njhetwortngnniyrhcfk','otherproject'),manualURL.replace('/auth/v1/verify','/auth/x/../v1/verify'),manualURL+'&token=other-token-1234567890',manualURL+'&extra=yes',manualURL+'#access_token=secret',manualURL.replace('type=invite','type=magiclink'),manualURL.replace('braintimelab.github.io','example.invalid'),manualURL.replace('token=synthetic-token-1234567890','token=short')])assert.equal(verifiedInvitationLink(manualResult({invitation_link:url})),null);
});
test('explicit Create setup link is available without mail service and produces clickable copyable setup without email',async()=>{
 const generated=[];const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async p=>(generated.push(p),manualResult())});assert.match(h.container.innerHTML,/Create setup link/);assert.doesNotMatch(h.container.innerHTML,/data-member-action="invite"/);assert.equal(generated.length,0);await h.click('create-link','INVITEE');assert.deepEqual(generated,[{person_id:'INVITEE',version:3}]);assert.match(h.container.innerHTML,/Open account setup/);assert.match(h.container.innerHTML,/readonly autocomplete="off"/);assert.match(h.container.innerHTML,/rel="noopener noreferrer" referrerpolicy="no-referrer"/);assert.match(h.container.innerHTML,/Copy setup link/);assert.match(h.container.innerHTML,/No email was sent/);assert.equal(h.messages.some(m=>m.message.includes('synthetic-token')),false);await h.click('close-link');assert.doesNotMatch(h.container.innerHTML,/synthetic-token|member-setup-link/);assert.match(h.container.innerHTML,/Create setup link/);
});
test('manual copy requires a click, keeps bearer URL out of notices, and fallback permits field copying',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'navigator'),copied=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async text=>copied.push(text)}}});try{const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async()=>manualResult()});await h.click('create-link','INVITEE');assert.equal(copied.length,0);await h.click('copy-link');assert.deepEqual(copied,[manualURL]);assert.match(h.container.innerHTML,/Setup link copied/);assert.equal(h.messages.length,0);globalThis.navigator.clipboard.writeText=async()=>{throw new Error('Blocked')};await h.click('copy-link');assert.match(h.container.innerHTML,/Select the link field and copy it manually/);}finally{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;}
});
test('failed email offers manual setup without automatically creating or resending a link',async()=>{
 let sends=0,links=0;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{sends++;throw new Error('Email service unavailable')},createInvitationLink:async()=>{links++;return manualResult()}});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.equal(sends,1);assert.equal(links,0);assert.match(h.container.innerHTML,/Use Create setup link to share manually/);await h.click('create-link','INVITEE');assert.equal(sends,1);assert.equal(links,1);assert.match(h.container.innerHTML,/Open account setup/);
});
test('accepted email plus changed registration is a success with warning, not a delivery or retry claim',async()=>{
 const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>({person_id:'INVITEE',email_sent:true,delivery_status:'accepted',delivery_confirmed:false,registration_status:'changed'})});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.match(h.container.innerHTML,/Email request accepted/);assert.match(h.container.innerHTML,/Delivery is not confirmed/);assert.match(h.container.innerHTML,/Refresh Members to check registration/);assert.doesNotMatch(h.container.innerHTML,/role="alert"|Invitation sent|delivered/);
});
test('manual generation eligibility excludes existing, inactive and incomplete accounts',async()=>{
 for(const extra of [{linked_user_id:'AUTH'},{status:'historical'},{status:'review'},{archived:true},{effective_role:'owner'},{email:''}]){let calls=0;const h=await harness({listMembers:async()=>({members:[invitee(extra)]}),createInvitationLink:async()=>{calls++;return manualResult()}});assert.doesNotMatch(h.container.innerHTML,/data-member-action="create-link"/);await h.click('create-link','INVITEE');assert.equal(calls,0);}
});
test('unverified manual results never become links or echo token-bearing error messages',async()=>{
 for(const result of [manualResult({person_id:'WRONG'}),manualResult({email_sent:true}),manualResult({delivery_status:'accepted'}),manualResult({invitation_link:'https://evil.invalid/?token=synthetic-token-1234567890'})]){const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async()=>result});await h.click('create-link','INVITEE');assert.match(h.container.innerHTML,/Could not create a verified/);assert.doesNotMatch(h.container.innerHTML,/synthetic-token|Open account setup/);}
 const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async()=>{throw new Error(manualURL)}});await h.click('create-link','INVITEE');assert.doesNotMatch(h.container.innerHTML,/synthetic-token|supabase.co/);
});
test('closing during generation discards a late link without replacing current roster',async()=>{
 let resolve;const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:()=>new Promise(r=>resolve=r)});const pending=h.click('create-link','INVITEE');assert.match(h.container.innerHTML,/Creating setup link/);await h.click('close-link');assert.match(h.container.innerHTML,/New colleague/);resolve(manualResult());await pending;assert.doesNotMatch(h.container.innerHTML,/synthetic-token|Open account setup/);assert.match(h.container.innerHTML,/Create setup link/);
});
test('sign-out or role-change disposal clears bearer URLs and rejects pending generation results',async()=>{
 const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async()=>manualResult()});await h.click('create-link','INVITEE');clearLabMembers(h.container);assert.equal(h.container.innerHTML,'');assert.equal(h.container.onclick,null);
 let resolve;const pendingHost=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:()=>new Promise(r=>resolve=r)});const pending=pendingHost.click('create-link','INVITEE');clearLabMembers(pendingHost.container);resolve(manualResult());await pending;assert.equal(pendingHost.container.innerHTML,'');assert.equal(pendingHost.messages.length,0);
});
test('owner authorization loss during link creation removes recipient and manual controls',async()=>{
 const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async()=>{throw Object.assign(new Error('Owner access required'),{code:'42501'})}});await h.click('create-link','INVITEE');assert.match(h.container.innerHTML,/Only the database owner/);assert.doesNotMatch(h.container.innerHTML,/New colleague|new@example.invalid|Create setup link|Open account setup/);
});


test('verified accounts receive a concise manual-link restriction without generating a sign-in token',async()=>{
 const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async()=>{throw Object.assign(new Error('Provider details are not exposed'),{code:'manual_link_unavailable'})}});await h.click('create-link','INVITEE');assert.match(h.container.innerHTML,/already has a verified account/);assert.match(h.container.innerHTML,/password sign-in or email recovery/);assert.doesNotMatch(h.container.innerHTML,/Open account setup|Provider details/);
});


test('expired authorization clears a pending setup link and contradictory email status never claims acceptance',async()=>{
 const expired=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async()=>{throw Object.assign(new Error('Expired'),{status:401})}});await expired.click('create-link','INVITEE');assert.doesNotMatch(expired.container.innerHTML,/New colleague|new@example.invalid|Create setup link/);
 const unknown=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>({person_id:'INVITEE',email_sent:true,delivery_status:'unknown'})});await unknown.click('invite','INVITEE');await unknown.click('confirm-invitation');assert.doesNotMatch(unknown.container.innerHTML,/Email request accepted/);assert.match(unknown.container.innerHTML,/delivery was not confirmed/);
});


test('accepted email followed by explicit owner revocation clears private state but preserves generic acceptance',async()=>{
 const h=await harness({listMembers:async()=>({members:[invitee()]}),createInvitationLink:async()=>manualResult(),inviteMember:async()=>({person_id:'INVITEE',email_sent:true,delivery_status:'accepted',delivery_confirmed:false,registration_status:'unverified',access_revoked:true})});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.match(h.container.innerHTML,/Email request accepted/);assert.match(h.container.innerHTML,/Delivery is not confirmed/);assert.match(h.container.innerHTML,/Sign in again/);assert.doesNotMatch(h.container.innerHTML,/New colleague|new@example.invalid|data-member-action="create-link"|Resend invitation/);assert.equal(h.messages.some(m=>m.message.includes('new@example.invalid')),false);
});

const emailRequest=(extra={})=>member('REQUEST',{name:'Requested scientist',email:'registered@example.invalid',status:'review',version:2,provenance:{registration_method:'verified_self_request'},...extra});
const emailTarget=(extra={})=>member('TARGET',{name:'Existing scientist',email:'original@example.invalid',version:7,intended_role:'manager',export_level:'max',secondary_emails:['earlier@example.invalid'],...extra});
const approvedEmail=(extra={})=>({member:{...emailTarget(),version:8,email:'registered@example.invalid',secondary_emails:['earlier@example.invalid','original@example.invalid']},merged_request:{person_id:'REQUEST',version:3,archived:true},setup_required:true,...extra});
const chooseEmailTarget=(h,value='TARGET')=>h.container.onchange({target:{id:'member-email-target',value}});
async function startEmailApproval(h){await h.click('tab','review');await h.click('approve-email','REQUEST');}

test('email approval requires explicit member choice and confirmation, retains contact and access, and never sends an invitation',async()=>{
 const approvals=[];let invitations=0;const h=await harness({approveMemberEmail:async payload=>{approvals.push(payload);const result=approvedEmail();h.setMembers([result.member,{...emailRequest(),...result.merged_request,email:null,provenance:{email_approval:{merged_into_person_id:'11111111-1111-4111-8111-111111111111'}}}]);return result;},inviteMember:async()=>{invitations++}});
 h.setMembers([emailRequest(),emailTarget()]);await h.click('refresh');await startEmailApproval(h);
 assert.match(h.container.innerHTML,/Registered email: <strong>registered@example.invalid<\/strong>/);assert.match(h.container.innerHTML,/<option value="">Choose a Current member<\/option>/);assert.doesNotMatch(h.container.innerHTML,/<option value="TARGET" selected/);assert.match(h.container.innerHTML,/data-member-action="confirm-email-approval"[^>]* disabled/);await h.click('confirm-email-approval');assert.equal(approvals.length,0);
 chooseEmailTarget(h);assert.match(h.container.innerHTML,/registered@example.invalid<\/strong> → <strong>Existing scientist/);assert.match(h.container.innerHTML,/<dt>Secondary email<\/dt><dd>original@example.invalid/);assert.match(h.container.innerHTML,/<dt>Access retained<\/dt><dd>Manager/);assert.match(h.container.innerHTML,/Max · full history/);assert.equal(approvals.length,0);await h.click('cancel-email-approval');assert.equal(approvals.length,0);
 await h.click('approve-email','REQUEST');chooseEmailTarget(h);await h.click('confirm-email-approval');assert.deepEqual(approvals,[{request_person_id:'REQUEST',request_version:2,target_person_id:'TARGET',target_version:7}]);assert.equal(invitations,0);assert.match(h.container.innerHTML,/Email approved. No email was sent/);assert.match(h.container.innerHTML,/Review \(0\)/);assert.match(h.container.innerHTML,/data-member-id="current" aria-pressed="true"/);assert.match(h.container.innerHTML,/Secondary email: original@example.invalid/);assert.match(h.container.innerHTML,/Existing scientist/);assert.doesNotMatch(h.container.innerHTML,/Requested scientist|member-email-approval-title/);
});

test('email approval offers only explicit eligible unclaimed Current destinations and rejects forged selections',async()=>{
 let approvals=0;const blocked=[emailTarget({person_id:'OWNER',effective_role:'owner'}),emailTarget({person_id:'CLAIMED',linked_user_id:'AUTH'}),emailTarget({person_id:'USERNAME',username:'already'}),emailTarget({person_id:'ARCHIVED',archived:true}),emailTarget({person_id:'HISTORY',status:'historical'}),emailTarget({person_id:'REVIEW',status:'review'}),emailTarget({person_id:'INACTIVE',membership_active:false}),emailTarget({person_id:'NOEMAIL',email:null}),emailTarget({person_id:'INVALID',email:'bad'}),emailTarget({person_id:'SAME',email:'registered@example.invalid'}),emailTarget({person_id:'BADROLE',intended_role:'owner'}),emailTarget({person_id:'BADLEVEL',export_level:'unlimited'}),emailTarget({person_id:'BADVERSION',version:null})];
 const h=await harness({listMembers:async()=>({members:[emailRequest(),emailTarget(),...blocked]}),approveMemberEmail:async()=>{approvals++}});await startEmailApproval(h);assert.match(h.container.innerHTML,/<option value="TARGET">/);for(const target of blocked){assert.doesNotMatch(h.container.innerHTML,new RegExp('<option value="'+target.person_id+'"'));chooseEmailTarget(h,target.person_id);await h.click('confirm-email-approval');}chooseEmailTarget(h,'unknown');await h.click('confirm-email-approval');assert.equal(approvals,0);
});

test('only self-request Review rows offer email approval and no missing hook or denied roster can be used',async()=>{
 for(const extra of [{status:'current'},{status:'historical'},{archived:true},{linked_user_id:'AUTH'},{username:'claimed'},{effective_role:'owner'},{email:'broken'},{email:null},{version:null},{provenance:{}},{provenance:{registration_method:'owner_approved_membership'}}]){let approvals=0;const h=await harness({listMembers:async()=>({members:[emailRequest(extra),emailTarget()]}),approveMemberEmail:async()=>{approvals++}});await h.click('tab','review');assert.doesNotMatch(h.container.innerHTML,/data-member-action="approve-email"/);await h.click('approve-email','REQUEST');chooseEmailTarget(h);await h.click('confirm-email-approval');assert.equal(approvals,0);assert.doesNotMatch(h.container.innerHTML,/member-email-approval-title/);}
 const missing=await harness({listMembers:async()=>({members:[emailRequest(),emailTarget()]})});await startEmailApproval(missing);assert.doesNotMatch(missing.container.innerHTML,/member-email-approval-title|data-member-action="approve-email"/);
 let approvals=0;const denied=await harness({listMembers:async()=>{throw Object.assign(new Error('Denied'),{status:403})},approveMemberEmail:async()=>{approvals++}});await startEmailApproval(denied);chooseEmailTarget(denied);await denied.click('confirm-email-approval');assert.equal(approvals,0);
});

test('pending email approval blocks duplicate confirmation, changed selection and unrelated actions',async()=>{
 let release;const approvals=[];const h=await harness({listMembers:async()=>({members:[emailRequest(),emailTarget(),emailTarget({person_id:'OTHER'})]}),approveMemberEmail:payload=>{approvals.push(payload);return new Promise(resolve=>release=resolve)}});await startEmailApproval(h);chooseEmailTarget(h);const pending=h.click('confirm-email-approval');assert.match(h.container.innerHTML,/Approving…/);assert.match(h.container.innerHTML,/aria-busy="true"/);chooseEmailTarget(h,'OTHER');await h.click('confirm-email-approval');await h.click('cancel-email-approval');await h.click('edit','TARGET');await h.click('tab','current');await h.click('refresh');assert.equal(approvals.length,1);assert.equal(approvals[0].target_person_id,'TARGET');assert.match(h.container.innerHTML,/member-email-approval-title/);release(approvedEmail());await pending;assert.match(h.container.innerHTML,/Email approved/);
});

test('unconfirmed email approval responses never show success and require fresh roster before retry',async()=>{
 for(const result of [null,approvedEmail({setup_required:false}),approvedEmail({member:{...approvedEmail().member,person_id:'OTHER'}}),approvedEmail({member:{...approvedEmail().member,email:'other@example.invalid'}}),approvedEmail({member:{...approvedEmail().member,version:7}}),approvedEmail({member:{...approvedEmail().member,archived:undefined}}),approvedEmail({member:{...approvedEmail().member,intended_role:'editor'}}),approvedEmail({member:{...approvedEmail().member,export_level:'high'}}),approvedEmail({member:{...approvedEmail().member,secondary_emails:[]}}),approvedEmail({member:{...approvedEmail().member,linked_user_id:'UNEXPECTED'}}),approvedEmail({merged_request:{person_id:'OTHER',version:3,archived:true}}),approvedEmail({merged_request:{person_id:'REQUEST',version:2,archived:true}})]){let approvals=0;const h=await harness({listMembers:async()=>({members:[emailRequest(),emailTarget()]}),approveMemberEmail:async()=>{approvals++;return result}});await startEmailApproval(h);chooseEmailTarget(h);await h.click('confirm-email-approval');assert.match(h.container.innerHTML,/Approval could not be confirmed/);assert.doesNotMatch(h.container.innerHTML,/Email approved|registered@example.invalid|data-member-action="confirm-email-approval"/);await h.click('confirm-email-approval');assert.equal(approvals,1);}
});

test('email approval version conflicts and authorization loss clear private state and need explicit refresh',async()=>{
 for(const error of [Object.assign(new Error('Changed'),{code:'40001'}),Object.assign(new Error('Unauthorized'),{status:401}),Object.assign(new Error('Denied'),{code:'42501'}),new Error('Network interrupted')]){let approvals=0;const h=await harness({listMembers:async()=>({members:[emailRequest(),emailTarget()]}),approveMemberEmail:async()=>{approvals++;throw error}});await startEmailApproval(h);chooseEmailTarget(h);await h.click('confirm-email-approval');assert.match(h.container.innerHTML,/Member details changed|Only the database owner|Approval could not be confirmed/);assert.doesNotMatch(h.container.innerHTML,/registered@example.invalid|original@example.invalid|Existing scientist|data-member-action="approve-email"/);await h.click('approve-email','REQUEST');await h.click('confirm-email-approval');assert.equal(approvals,1);await h.click('refresh');assert.match(h.container.innerHTML,/Requested scientist/);}
});

test('committed email approval with refresh failure is distinguished and cannot be resubmitted',async()=>{
 let approvals=0;const h=await harness({listMembers:async()=>({members:[emailRequest(),emailTarget()]}),approveMemberEmail:async()=>{approvals++;h.hooks.listMembers=async()=>{throw new Error('Disconnected')};return approvedEmail()}});await startEmailApproval(h);chooseEmailTarget(h);await h.click('confirm-email-approval');assert.match(h.container.innerHTML,/Email approved, but the roster could not refresh/);assert.doesNotMatch(h.container.innerHTML,/registered@example.invalid|member-email-approval-title/);await h.click('confirm-email-approval');assert.equal(approvals,1);
});

test('late email approval cannot overwrite an unauthorized remount or leave private contacts after disposal',async()=>{
 for(const dispose of [false,true]){let release;const h=await harness({listMembers:async()=>({members:[emailRequest(),emailTarget()]}),approveMemberEmail:()=>new Promise(resolve=>release=resolve)});await startEmailApproval(h);chooseEmailTarget(h);const pending=h.click('confirm-email-approval');if(dispose)clearLabMembers(h.container);else await renderLabMembers(h.container,{listMembers:async()=>{throw Object.assign(new Error('Denied'),{code:'42501'})}});release(approvedEmail());await pending;assert.doesNotMatch(h.container.innerHTML,/Email approved|registered@example.invalid|original@example.invalid/);assert.equal(h.messages.length,0);if(dispose)assert.equal(h.container.innerHTML,'');}
});

test('secondary owner contacts are escaped, searchable and read-only in the member editor',async()=>{
 const h=await harness({listMembers:async()=>({members:[emailTarget({secondary_emails:['earlier@example.invalid','<script>@example.invalid','bad',null]})]})});assert.match(h.container.innerHTML,/Secondary email: earlier@example.invalid/);assert.match(h.container.innerHTML,/&lt;script&gt;@example.invalid/);assert.doesNotMatch(h.container.innerHTML,/<script>/);h.container.oninput({target:{id:'member-search',value:'earlier@example.invalid',selectionStart:23}});assert.match(h.container.innerHTML,/Existing scientist/);await h.click('edit','TARGET');assert.match(h.container.innerHTML,/Secondary email: earlier@example.invalid/);assert.doesNotMatch(h.container.innerHTML,/data-member-field="secondary_emails"/);
});

test('email approval escapes all displayed names and addresses and never automatically matches equal names',async()=>{
 const name='<script>Same name</script>',request=emailRequest({name}),target=emailTarget({name});const h=await harness({listMembers:async()=>({members:[request,target]}),approveMemberEmail:async()=>approvedEmail()});await startEmailApproval(h);assert.doesNotMatch(h.container.innerHTML,/<option value="TARGET" selected|<script>/);chooseEmailTarget(h);assert.match(h.container.innerHTML,/&lt;script&gt;Same name&lt;\/script&gt;/);assert.doesNotMatch(h.container.innerHTML,/<script>/);
});

test('only merged archived email requests leave the Review queue; other archived and Historical records remain',async()=>{
 const h=await harness({listMembers:async()=>({members:[emailTarget(),emailRequest({archived:true,email:null,provenance:{email_approval:{merged_into_person_id:'11111111-1111-4111-8111-111111111111'}}}),emailRequest({person_id:'UNMERGED',name:'Unmerged archived request',archived:true}),emailRequest({person_id:'INVALID-MERGE',name:'Invalid merge reference',archived:true,provenance:{email_approval:{merged_into_person_id:'not-an-id'}}}),member('OLD',{name:'Historical person',status:'historical',archived:true})]})});assert.match(h.container.innerHTML,/Review \(2\)/);await h.click('tab','review');assert.doesNotMatch(h.container.innerHTML,/Requested scientist/);assert.match(h.container.innerHTML,/Unmerged archived request|Invalid merge reference/);await h.click('tab','historical');assert.match(h.container.innerHTML,/Historical person/);
});
