import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLabMembers,validateLabMemberDraft} from '../web/lab-members.js';
const clone=structuredClone;
const member=(id,extra={})=>({person_id:id,colony_id:'COLONY',version:3,name:'Synthetic Person',email:null,phone:null,acronym:'SP',category:'unknown',status:'current',intended_role:'editor',export_level:'low',notes:null,provenance:{source:'Historical record <sheet>',range:'B3'},archived:false,username:null,linked_user_id:null,...extra});
const initial=()=>[member('CURRENT',{name:'Current person',email:'current@example.invalid',category:'phd',username:'current.user',linked_user_id:'AUTH1',membership_active:true}),member('HISTORICAL',{name:'Historical person',email:'history@example.invalid',phone:'+886 555 001',status:'historical'}),member('REVIEW',{name:'Uncertain person',acronym:'UP',status:'review'})];
async function harness(overrides={}){const container={innerHTML:''},calls=[],messages=[];let members=initial();const hooks={listMembers:async()=>{calls.push({action:'list'});return {members:clone(members)}},saveMember:async person=>{calls.push({action:'save',person:clone(person)});const index=members.findIndex(m=>m.person_id===person.person_id),old=index<0?member('NEW',{version:0,provenance:{}}):members[index],next={...old,...person,person_id:person.person_id||'NEW',version:old.version+1};if(next.linked_user_id)next.membership_active=old.membership_active&&next.status==='current'&&!next.archived;if(index<0)members.push(next);else members[index]=next;return {member:clone(next)}},toast:(message,error)=>messages.push({message,error}),...overrides};await renderLabMembers(container,hooks);return {container,hooks,calls,messages,get members(){return members},setMembers(next){members=next},field(key,value){container.oninput({target:{value,dataset:{memberField:key}}})},async click(action,id=''){await container.onclick({target:{closest:()=>({dataset:{memberAction:action,memberId:id}})},preventDefault(){}})},async submit(values={}){await container.onsubmit({target:{hasAttribute:key=>key==='data-lab-member-form',elements:{namedItem:key=>Object.hasOwn(values,key)?{value:values[key]}:null}},preventDefault(){},stopPropagation(){}})}}}

test('owner RPC load separates current, historical and review tabs and displays account identity',async()=>{
 const h=await harness();assert.deepEqual(h.calls,[{action:'list'}]);assert.match(h.container.innerHTML,/Current person/);assert.match(h.container.innerHTML,/@current.user/);assert.doesNotMatch(h.container.innerHTML,/Historical person|history@example.invalid/);assert.match(h.container.innerHTML,/Current \(1\)/);await h.click('tab','historical');assert.match(h.container.innerHTML,/Historical person/);assert.match(h.container.innerHTML,/\+886 555 001/);await h.click('edit','HISTORICAL');assert.match(h.container.innerHTML,/Source provenance/);assert.match(h.container.innerHTML,/Historical record &lt;sheet&gt;/);assert.match(h.container.innerHTML,/deactivates its access/);
});

test('preregistration defaults to current editor and saves without contact email or account creation',async()=>{
 const h=await harness();await h.click('new');assert.match(h.container.innerHTML,/value="editor" selected/);assert.match(h.container.innerHTML,/Preregistration sends no email/);h.field('name','New member');h.field('acronym','nm');h.field('category','masters');await h.submit();const call=h.calls.find(c=>c.action==='save');assert.deepEqual(call.person,{person_id:null,version:0,name:'New member',email:null,phone:null,acronym:'NM',category:'masters',status:'current',intended_role:'editor',export_level:'low',notes:null});assert.match(h.container.innerHTML,/Email needed/);assert.match(h.container.innerHTML,/Member saved. No email was sent/);assert(!h.calls.some(c=>/invite|auth|email/.test(c.action)));
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

const invitee=(extra={})=>member('INVITEE',{name:'New colleague',email:'new@example.invalid',intended_role:'editor',export_level:'high',...extra});
test('invitation requires review of the saved recipient and access, then an explicit send',async()=>{
 const sent=[];const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async payload=>{sent.push(payload);return {person_id:'INVITEE',email_sent:true,message:'Queued'}}});
 assert.match(h.container.innerHTML,/Invite by email/);assert.equal(sent.length,0);await h.click('invite','INVITEE');assert.match(h.container.innerHTML,/Invite New colleague\?/);assert.match(h.container.innerHTML,/<strong>new@example.invalid<\/strong>/);assert.match(h.container.innerHTML,/Read &amp; write/);assert.match(h.container.innerHTML,/High · past 6 years/);assert.match(h.container.innerHTML,/chooses their own username and password/);assert.equal(sent.length,0);await h.click('cancel-invitation');assert.equal(sent.length,0);
 await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.deepEqual(sent,[{person_id:'INVITEE',version:3}]);assert.match(h.container.innerHTML,/Invitation sent to new@example.invalid/);assert.match(h.container.innerHTML,/Resend invitation/);await h.click('invite','INVITEE');assert.match(h.container.innerHTML,/already sent during this session/);assert.equal(sent.length,1);await h.click('cancel-invitation');await h.click('refresh');assert.doesNotMatch(h.container.innerHTML,/Resend invitation|Invitation sent/);
});

test('invitation eligibility excludes owner, claimed, archived, historical, review and invalid email records',async()=>{
 const records=[invitee({person_id:'OWNER',effective_role:'owner'}),invitee({person_id:'CLAIMED',linked_user_id:'AUTH'}),invitee({person_id:'ARCHIVED',archived:true}),invitee({person_id:'HISTORICAL',status:'historical'}),invitee({person_id:'REVIEW',status:'review'}),invitee({person_id:'NOEMAIL',email:''}),invitee({person_id:'INVALID',email:'broken'}),invitee({person_id:'BADACCESS',intended_role:'owner'}),invitee({person_id:'BADLEVEL',export_level:'unlimited'})];let sends=0;
 const h=await harness({listMembers:async()=>({members:records}),inviteMember:async()=>{sends++}});assert.doesNotMatch(h.container.innerHTML,/data-member-action="invite"/);for(const m of records){await h.click('invite',m.person_id);await h.click('confirm-invitation')}assert.equal(sends,0);
 const unavailable=await harness({listMembers:async()=>({members:[invitee()]})});assert.doesNotMatch(unavailable.container.innerHTML,/data-member-action="invite"/);await unavailable.click('invite','INVITEE');assert.doesNotMatch(unavailable.container.innerHTML,/Send invitation/);
});

test('invitation pending state blocks duplicate sends, edits, navigation and refresh',async()=>{
 let resolve,sends=0;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:()=>{sends++;return new Promise(r=>{resolve=r})}});await h.click('invite','INVITEE');const pending=h.click('confirm-invitation');assert.match(h.container.innerHTML,/Sending…/);assert.match(h.container.innerHTML,/aria-busy="true"/);await h.click('confirm-invitation');await h.click('edit','INVITEE');await h.click('cancel-invitation');await h.click('refresh');assert.equal(sends,1);assert.match(h.container.innerHTML,/Sending…/);resolve({person_id:'INVITEE',email_sent:true});await pending;assert.match(h.container.innerHTML,/Invitation sent/);
});

test('uncertain or mismatched invitation responses do not claim success or automatically retry',async()=>{
 for(const result of [null,{person_id:'INVITEE',email_sent:false},{person_id:'WRONG',email_sent:true},{person_id:'INVITEE',email_sent:true,email:'wrong@example.invalid'}]){let sends=0;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{sends++;return result}});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.equal(sends,1);assert.match(h.container.innerHTML,/Invitation delivery was not confirmed/);assert.match(h.container.innerHTML,/no automatic retry was made/);assert.doesNotMatch(h.container.innerHTML,/Invitation sent|Resend invitation|data-member-action="confirm-invitation"/);await h.click('confirm-invitation');assert.equal(sends,1)}
});

test('invitation failures preserve readable errors and authorization loss clears private roster',async()=>{
 for(const failure of [new Error('SMTP not configured'),Object.assign(new Error('Stale member'),{code:'40001'})]){const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{throw failure}});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.match(h.container.innerHTML,/SMTP not configured|changed while you were editing/);assert.match(h.container.innerHTML,/Invitation delivery was not confirmed/);assert.doesNotMatch(h.container.innerHTML,/Invitation sent/)}
 let sends=0;const denied=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{sends++;throw Object.assign(new Error('Owner access required'),{code:'42501'})}});await denied.click('invite','INVITEE');await denied.click('confirm-invitation');assert.match(denied.container.innerHTML,/Only the database owner/);assert.doesNotMatch(denied.container.innerHTML,/New colleague|new@example.invalid|Send invitation/);await denied.click('invite','INVITEE');await denied.click('confirm-invitation');assert.equal(sends,1);
});

test('invitation confirmation and success escape recipient display data',async()=>{
 const h=await harness({listMembers:async()=>({members:[invitee({name:'<img src=x onerror=bad()>',email:'<x>@example.invalid',provenance:{nickname:'<script>Nickname</script>'}})]}),inviteMember:async()=>({person_id:'INVITEE',email_sent:true})});await h.click('invite','INVITEE');assert.match(h.container.innerHTML,/&lt;img/);assert.match(h.container.innerHTML,/&lt;script&gt;Nickname/);assert.match(h.container.innerHTML,/&lt;x&gt;@example.invalid/);assert.doesNotMatch(h.container.innerHTML,/<img|<script>/);await h.click('confirm-invitation');assert.match(h.container.innerHTML,/Invitation sent to &lt;x&gt;@example.invalid/);assert.doesNotMatch(h.container.innerHTML,/<img|<script>/);
});

test('stale invite completion cannot overwrite a new mount or leak recipient details',async()=>{
 let resolve;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:()=>new Promise(r=>{resolve=r})});await h.click('invite','INVITEE');const pending=h.click('confirm-invitation');await renderLabMembers(h.container,{listMembers:async()=>{throw Object.assign(new Error('Denied'),{code:'42501'})}});resolve({person_id:'INVITEE',email_sent:true});await pending;assert.match(h.container.innerHTML,/Only the database owner/);assert.doesNotMatch(h.container.innerHTML,/new@example.invalid|Invitation sent/);assert.equal(h.messages.length,0);
});

test('saving and moving a member never call the invitation hook',async()=>{
 let sends=0;const h=await harness({inviteMember:async()=>{sends++}});await h.click('new');h.field('name','New colleague');h.field('email','new@example.invalid');await h.submit();await h.click('move-historical','NEW');await h.click('confirm-transition');await h.click('move-current','NEW');await h.click('confirm-transition');assert.equal(sends,0);assert.match(h.container.innerHTML,/No email was sent/);
});

test('an accepted email followed by a registration recheck failure is distinct from an uncertain send',async()=>{
 let sends=0;const h=await harness({listMembers:async()=>({members:[invitee()]}),inviteMember:async()=>{sends++;throw Object.assign(new Error('The email service accepted the invitation, but registration could not be reconfirmed.'),{invitationSent:true,code:'invitation_sent_registration_unconfirmed'})}});await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.match(h.container.innerHTML,/Email accepted; registration status could not be reconfirmed/);assert.match(h.container.innerHTML,/Refresh Members before sending again/);assert.match(h.container.innerHTML,/Resend invitation/);assert.doesNotMatch(h.container.innerHTML,/Invitation delivery was not confirmed/);await h.click('confirm-invitation');assert.equal(sends,1);
});

test('saving a changed recipient clears the prior email session resend flag after roster reload',async()=>{
 const h=await harness({inviteMember:async()=>({person_id:'INVITEE',email_sent:true})});h.setMembers([invitee()]);await h.click('refresh');await h.click('invite','INVITEE');await h.click('confirm-invitation');assert.match(h.container.innerHTML,/Resend invitation/);await h.click('edit','INVITEE');h.field('email','updated@example.invalid');await h.submit();assert.match(h.container.innerHTML,/updated@example.invalid/);assert.doesNotMatch(h.container.innerHTML,/Resend invitation/);await h.click('invite','INVITEE');assert.match(h.container.innerHTML,/<strong>updated@example.invalid<\/strong>/);assert.doesNotMatch(h.container.innerHTML,/already sent during this session/);
});
