import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAccountSetup,clearAccountSetup} from '../web/account-setup.js';
const profile=()=>({eligible:true,setup_required:true,registration_allowed:true,member:{person_id:'PERSON',name:'<Name>',email:'person@example.org',phone:'0123456',category:'phd',acronym:'NP',username:null,version:3}});
const decode=value=>String(value||'').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const attributes=source=>Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)]));
function view(){
 let html='',form=null,nodes=new Map();
 const container={isConnected:true,get innerHTML(){return html;},set innerHTML(value){html=value;nodes=new Map([...value.matchAll(/\bid="([^"]+)"/g)].map(([,id])=>[id,{textContent:'',hidden:false}]));
  const found=value.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/);form=null;if(!found)return;
  const fields={};for(const [,attrs] of found[2].matchAll(/<input\b([^>]*)>/g)){const props=attributes(attrs);if(props.name)fields[props.name]={value:props.value||'',disabled:false,required:/\brequired\b/.test(attrs),type:props.type||'text'};}
  for(const [,attrs,body] of found[2].matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)){const props=attributes(attrs),options=[...body.matchAll(/<option\b([^>]*)>/g)].map(([,a])=>({props:attributes(a),selected:/\bselected\b/.test(a)}));if(props.name)fields[props.name]={value:(options.find(o=>o.selected)||options[0])?.props.value||'',disabled:false,type:'select'};}
  const button={disabled:false,textContent:''};form={id:attributes(found[1]).id,fields,button,elements:{namedItem:key=>fields[key]},querySelector:()=>button};
 },querySelector:selector=>nodes.get(selector.slice(1))||null,querySelectorAll:selector=>selector==='input[type="password"]'?Object.values(form?.fields||{}).filter(f=>f.type==='password'):[]};
 return {container,get form(){return form;},get status(){return nodes.get('setup-status');},submit:()=>container.onsubmit({target:form,preventDefault(){},stopPropagation(){}}),fillCredentials(){form.fields.username.value='lab.user';form.fields.password.value='long-account-password';form.fields.confirmation.value='long-account-password';}};
}
const nextProfile=(before,fields)=>({...before,member:{...before.member,...fields,version:before.member.version+1}});
function hooksFor(before=profile(),extra={}){return {getProfile:async()=>before,saveProfile:async fields=>nextProfile(before,fields),complete:async username=>({...before,setup_required:false,member:{...before.member,username}}),...extra};}

test('first-time setup prefills escaped editable details and shows credentials only for eligible members',async()=>{
 const ui=view();await renderAccountSetup(ui.container,hooksFor());assert.match(ui.container.innerHTML,/&lt;Name&gt;/);assert.equal(ui.form.fields.name.value,'<Name>');assert.equal(ui.form.fields.phone.value,'0123456');assert.equal(ui.form.fields.category.value,'phd');assert.equal(ui.form.fields.acronym.value,'NP');assert.equal(ui.form.fields.password.value,'');
 const pending={...profile(),eligible:false,setup_required:false,reason:'profile_required',member:{...profile().member,person_id:null,version:0,name:'',phone:null}};
 await renderAccountSetup(ui.container,hooksFor(pending));assert.equal(ui.form.id,'account-registration');assert.match(ui.container.innerHTML,/Submit for approval/);assert.doesNotMatch(ui.container.innerHTML,/name="username"|type="password"|intended_role|export_level/);
});
test('first-time details save before credentials using current version, without role or email fields',async()=>{
 const before=profile(),ui=view(),calls=[];let completed=0;
 await renderAccountSetup(ui.container,hooksFor(before,{saveProfile:async(fields,version)=>{calls.push(['profile',fields,version]);return nextProfile(before,fields);},complete:async(id,password)=>{calls.push(['complete',id,password]);return {...before,setup_required:false,member:{...before.member,username:id}};},onComplete:async()=>completed++}));
 ui.fillCredentials();ui.form.fields.name.value='New Name';ui.form.fields.phone.value='0987654';const secretFields=[ui.form.fields.password,ui.form.fields.confirmation];await ui.submit();
 assert.deepEqual(calls[0],['profile',{name:'New Name',phone:'0987654',category:'phd',acronym:'NP'},3]);assert.deepEqual(calls[1],['complete','lab.user','long-account-password']);assert.equal(completed,1);assert.ok(secretFields.every(f=>f.value===''));assert.match(ui.container.innerHTML,/Username: <strong>lab.user/);assert.match(ui.container.innerHTML,/Edit details/);assert.doesNotMatch(ui.container.innerHTML,/type="password"/);
});
test('password mismatch makes no profile or credential write',async()=>{
 let writes=0;const ui=view();await renderAccountSetup(ui.container,hooksFor(profile(),{saveProfile:async()=>writes++,complete:async()=>writes++}));ui.fillCredentials();ui.form.fields.confirmation.value='different';await ui.submit();assert.equal(writes,0);assert.match(ui.status.textContent,/Passwords do not match/);
});
test('registration request collects only self details and never calls credential setup',async()=>{
 const before={eligible:false,setup_required:false,registration_allowed:true,reason:'profile_required',member:{name:'',email:'verified@example.org',phone:null,acronym:null,category:'unknown',version:0}};const ui=view();let calls=0;
 await renderAccountSetup(ui.container,hooksFor(before,{saveProfile:async(fields,version)=>{calls++;assert.equal(version,0);return {...nextProfile(before,fields),reason:'approval_pending'};},complete:async()=>assert.fail('Unapproved user must not set credentials')}));ui.form.fields.name.value='New Applicant';ui.form.fields.phone.value='123456';ui.form.fields.acronym.value='na';await ui.submit();assert.equal(calls,1);assert.match(ui.container.innerHTML,/Submitted for approval/);assert.match(ui.container.innerHTML,/Awaiting approval/);assert.doesNotMatch(ui.container.innerHTML,/type="password"|name="username"/);assert.equal(ui.form.fields.acronym.value,'NA');
});
test('failed profile save preserves details and never changes credentials',async()=>{
 const ui=view();let complete=0;await renderAccountSetup(ui.container,hooksFor(profile(),{saveProfile:async()=>{throw Error('Profile changed. Reload.');},complete:async()=>complete++}));ui.fillCredentials();ui.form.fields.name.value='Preserved';const fields=ui.form.fields;await ui.submit();assert.equal(complete,0);assert.equal(ui.form.fields.name.value,'Preserved');assert.equal(fields.password.value,'');assert.equal(fields.confirmation.value,'');assert.match(ui.status.textContent,/Profile changed/);
});
test('a credential retry uses the profile version returned by the prior save',async()=>{
 const before=profile(),ui=view(),versions=[];let complete=0;
 await renderAccountSetup(ui.container,hooksFor(before,{saveProfile:async(fields,version)=>{versions.push(version);return {...before,member:{...before.member,...fields,version:version+1}};},complete:async()=>{complete++;throw Error('Username unavailable');}}));
 ui.fillCredentials();await ui.submit();ui.fillCredentials();ui.form.fields.name.value='Edited after retry';await ui.submit();assert.deepEqual(versions,[3,4]);assert.equal(complete,2);assert.equal(ui.form.fields.name.value,'Edited after retry');
});
test('verification retry sends no password or repeated profile write and keeps the confirmed username',async()=>{
 const before=profile(),ui=view(),calls=[];
 await renderAccountSetup(ui.container,hooksFor(before,{saveProfile:async fields=>{calls.push(['profile']);return nextProfile(before,fields);},complete:async(id,password)=>{calls.push(['complete',id,password]);if(calls.length===2)throw Object.assign(Error('Account saved. Retry verification.'),{setupStage:'verification',accountSaved:true,passwordSaved:true});return {...before,setup_required:false,member:{...before.member,username:id}};}}));
 ui.fillCredentials();await ui.submit();assert.equal(ui.form.button.textContent,'Retry verification');assert.equal(ui.form.fields.username.disabled,true);assert.equal(ui.form.fields.password.value,'');assert.equal(ui.container.querySelector('#setup-password-fields').hidden,true);
 ui.form.fields.username.value='different';await ui.submit();assert.deepEqual(calls,[['profile'],['complete','lab.user','long-account-password'],['complete','lab.user',undefined]]);assert.match(ui.container.innerHTML,/>lab.user</);
});
test('password-saved username failure retries the chosen username without replaying password',async()=>{
 const ui=view(),calls=[];await renderAccountSetup(ui.container,hooksFor(profile(),{complete:async(id,password)=>{calls.push([id,password]);if(calls.length===1)throw Object.assign(Error('Username unavailable'),{setupStage:'username',passwordSaved:true});}}));ui.fillCredentials();await ui.submit();assert.equal(ui.form.button.textContent,'Finish setup');ui.form.fields.username.value='another.user';await ui.submit();assert.deepEqual(calls,[['lab.user','long-account-password'],['another.user',undefined]]);
});
test('completed accounts edit details only, preserving separately managed acronym and access',async()=>{
 const before={...profile(),setup_required:false,member:{...profile().member,username:'owner',effective_role:'owner',effective_export_level:'max'}};const ui=view(),writes=[];
 await renderAccountSetup(ui.container,hooksFor(before,{saveProfile:async(fields,version)=>{writes.push([fields,version]);return nextProfile(before,fields);}}));assert.equal(ui.form.id,'account-details');assert.equal(ui.form.fields.acronym,undefined);assert.equal(ui.form.fields.password,undefined);ui.form.fields.phone.value='999';await ui.submit();assert.deepEqual(writes,[[{name:'<Name>',phone:'999',category:'phd'},3]]);assert.match(ui.container.innerHTML,/owner/);assert.doesNotMatch(ui.container.innerHTML,/intended_role|export_level|type="password"/);
});
test('profile timeout offers an explicit retry and stale results cannot replace a newer account',async()=>{
 const ui=view();let count=0;await renderAccountSetup(ui.container,hooksFor(profile(),{getProfile:async()=>{if(++count===1)throw Error('Profile request timed out');return profile();}}));assert.match(ui.container.innerHTML,/Retry profile/);ui.container.onclick({target:{closest:()=>({})}});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(ui.form.id,'first-account-setup');
 let release;const first=renderAccountSetup(ui.container,{getProfile:()=>new Promise(resolve=>release=resolve)});await renderAccountSetup(ui.container,hooksFor({...profile(),setup_required:false,member:{...profile().member,username:'new.account'}}));release(profile());await first;assert.match(ui.container.innerHTML,/new.account/);assert.doesNotMatch(ui.container.innerHTML,/first-account-setup/);
});
test('remount or signout during profile save clears secrets and blocks the subsequent credential write',async()=>{
 const ui=view();let release,complete=0;await renderAccountSetup(ui.container,hooksFor(profile(),{saveProfile:()=>new Promise(resolve=>release=resolve),complete:async()=>complete++}));ui.fillCredentials();const fields=ui.form.fields,pending=ui.submit();await new Promise(resolve=>setTimeout(resolve,0));clearAccountSetup(ui.container);release(nextProfile(profile(),{}));await pending;assert.equal(complete,0);assert.equal(fields.password.value,'');assert.equal(fields.confirmation.value,'');assert.equal(ui.container.innerHTML,'');assert.equal(ui.container.onsubmit,null);
});
test('duplicate submissions are blocked while saving profile or credentials',async()=>{
 const ui=view();let release,writes=0;await renderAccountSetup(ui.container,hooksFor(profile(),{saveProfile:async fields=>{writes++;await new Promise(resolve=>release=resolve);return nextProfile(profile(),fields);}}));ui.fillCredentials();const first=ui.submit();await ui.submit();assert.equal(writes,1);release();await first;assert.equal(writes,1);
});
test('unconfirmed profile save cannot proceed to credentials and forbidden self profile clears private state',async()=>{
 const ui=view();let writes=0;await renderAccountSetup(ui.container,hooksFor(profile(),{saveProfile:async()=>profile(),complete:async()=>writes++}));ui.fillCredentials();ui.form.fields.name.value='Changed name';await ui.submit();assert.equal(writes,0);assert.match(ui.status.textContent,/not confirmed/);
 await renderAccountSetup(ui.container,hooksFor(profile(),{saveProfile:async()=>{throw Object.assign(Error('Access denied'),{status:403});}}));ui.fillCredentials();await ui.submit();assert.match(ui.container.innerHTML,/Sign in again/);assert.doesNotMatch(ui.container.innerHTML,/person@example|0123456|type="password"/);
});

test('a verified unchanged profile response may retain its version without blocking setup',async()=>{
 const before=profile(),ui=view();let calls=0;await renderAccountSetup(ui.container,hooksFor(before,{saveProfile:async()=>before,complete:async()=>{calls++;}}));ui.fillCredentials();await ui.submit();assert.equal(calls,1);assert.match(ui.container.innerHTML,/Account ready/);
});
