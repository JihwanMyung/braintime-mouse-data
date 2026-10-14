import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLabMembers,validateLabMemberDraft} from '../web/lab-members.js';
const clone=structuredClone;
const member=(id,extra={})=>({person_id:id,colony_id:'COLONY',version:3,name:'Synthetic Person',email:null,phone:null,acronym:'SP',category:'unknown',status:'current',intended_role:'editor',export_level:'low',notes:null,provenance:{source:'Historical record <sheet>',range:'B3'},archived:false,username:null,linked_user_id:null,...extra});
const initial=()=>[member('CURRENT',{name:'Current person',email:'current@example.invalid',category:'phd',username:'current.user',linked_user_id:'AUTH1',membership_active:true}),member('HISTORICAL',{name:'Historical person',email:'history@example.invalid',phone:'+886 555 001',status:'historical'}),member('REVIEW',{name:'Uncertain person',acronym:'UP',status:'review'})];
async function harness(overrides={}){const container={innerHTML:''},calls=[],messages=[];let members=initial();const hooks={listMembers:async()=>{calls.push({action:'list'});return {members:clone(members)}},saveMember:async person=>{calls.push({action:'save',person:clone(person)});const index=members.findIndex(m=>m.person_id===person.person_id),old=index<0?member('NEW',{version:0,provenance:{}}):members[index],next={...old,...person,person_id:person.person_id||'NEW',version:old.version+1};if(index<0)members.push(next);else members[index]=next;return {member:clone(next)}},toast:(message,error)=>messages.push({message,error}),...overrides};await renderLabMembers(container,hooks);return {container,hooks,calls,messages,get members(){return members},setMembers(next){members=next},field(key,value){container.oninput({target:{value,dataset:{memberField:key}}})},async click(action,id=''){await container.onclick({target:{closest:()=>({dataset:{memberAction:action,memberId:id}})},preventDefault(){}})},async submit(values={}){await container.onsubmit({target:{hasAttribute:key=>key==='data-lab-member-form',elements:{namedItem:key=>Object.hasOwn(values,key)?{value:values[key]}:null}},preventDefault(){},stopPropagation(){}})}}}

test('owner RPC load separates current, historical and review tabs and displays account identity',async()=>{
 const h=await harness();assert.deepEqual(h.calls,[{action:'list'}]);assert.match(h.container.innerHTML,/Current person/);assert.match(h.container.innerHTML,/@current.user/);assert.doesNotMatch(h.container.innerHTML,/Historical person|history@example.invalid/);assert.match(h.container.innerHTML,/Current \(1\)/);await h.click('tab','historical');assert.match(h.container.innerHTML,/Historical person/);assert.match(h.container.innerHTML,/\+886 555 001/);await h.click('edit','HISTORICAL');assert.match(h.container.innerHTML,/Source provenance/);assert.match(h.container.innerHTML,/Historical record &lt;sheet&gt;/);assert.match(h.container.innerHTML,/deactivates its access/);
});

test('preregistration defaults to current editor and saves without contact email or account creation',async()=>{
 const h=await harness();await h.click('new');assert.match(h.container.innerHTML,/value="editor" selected/);assert.match(h.container.innerHTML,/Preregistration sends no email/);h.field('name','New member');h.field('acronym','nm');h.field('category','masters');await h.submit();const call=h.calls.find(c=>c.action==='save');assert.deepEqual(call.person,{person_id:null,version:0,name:'New member',email:null,phone:null,acronym:'NM',category:'masters',status:'current',intended_role:'editor',export_level:'low',notes:null});assert.match(h.container.innerHTML,/Email needed/);assert.match(h.container.innerHTML,/Member saved. No email was sent/);assert(!h.calls.some(c=>/invite|auth|email/.test(c.action)));
});

test('editing submits exact CAS version while preserving provenance and server account fields by omission',async()=>{
 const h=await harness();await h.click('edit','CURRENT');h.field('status','historical');h.field('intended_role','viewer');h.field('export_level','high');h.field('notes','Checked roster');await h.submit({email:' Current@Example.Invalid '});const p=h.calls.find(c=>c.action==='save').person;assert.equal(p.person_id,'CURRENT');assert.equal(p.version,3);assert.equal(p.email,'current@example.invalid');assert.equal(p.status,'historical');assert.equal(p.intended_role,'viewer');assert.equal(p.export_level,'high');for(const key of ['username','linked_user_id','provenance','created_at','created_by','effective_role','membership_active','archived'])assert.equal(Object.hasOwn(p,key),false,key+' must stay server-owned or preserved');assert.deepEqual(h.members.find(m=>m.person_id==='CURRENT').provenance,initial()[0].provenance);assert.match(h.container.innerHTML,/Current person/);assert.match(h.container.innerHTML,/Historical \(2\)/);
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
