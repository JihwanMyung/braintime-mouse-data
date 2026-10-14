import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAccountSetup} from '../web/account-setup.js';
const profile=()=>({eligible:true,setup_required:true,member:{name:'<Name>',email:'person@example.org',acronym:'NP',username:null}});
function view(){const status={textContent:''},button={disabled:false},fields={username:{value:'lab.user'},password:{value:'long-account-password'},confirmation:{value:'long-account-password'}},form={id:'first-account-setup',elements:{namedItem:key=>fields[key]},querySelector:()=>button};return{status,button,fields,form,container:{innerHTML:'',isConnected:true,querySelector:()=>status},event:{target:form,preventDefault(){},stopPropagation(){}}};}
await test('setup form escapes identity text and does not render passwords or hidden ineligible profiles',async()=>{
 const v=view();await renderAccountSetup(v.container,{getProfile:async()=>profile()});assert(v.container.innerHTML.includes('&lt;Name&gt;'));assert(v.container.innerHTML.includes('type="password"'));assert(!v.container.innerHTML.includes('long-account-password'));
 await renderAccountSetup(v.container,{getProfile:async()=>({eligible:false,member:null})});assert.equal(v.container.innerHTML,'');
});
await test('password mismatch does not submit and successful save clears both secret fields',async()=>{
 const v=view();let calls=0,completed=0;await renderAccountSetup(v.container,{getProfile:async()=>profile(),complete:async(user,password)=>{calls++;assert.equal(user,'lab.user');assert.equal(password,'long-account-password');},onComplete:async()=>completed++});
 v.fields.confirmation.value='different';await v.container.onsubmit(v.event);assert.equal(calls,0);assert.match(v.status.textContent,/do not match/);
 v.fields.confirmation.value=v.fields.password.value;await v.container.onsubmit(v.event);assert.equal(calls,1);assert.equal(completed,1);assert.equal(v.fields.password.value,'');assert.equal(v.fields.confirmation.value,'');assert.equal(v.button.disabled,false);
});
await test('failed setup clears secrets, preserves readable error, and duplicate submit is blocked',async()=>{
 const v=view();let release,calls=0;await renderAccountSetup(v.container,{getProfile:async()=>profile(),complete:async()=>{calls++;await new Promise(resolve=>{release=resolve;});throw Error('Username unavailable');}});
 const first=v.container.onsubmit(v.event);await new Promise(resolve=>setTimeout(resolve,0));await v.container.onsubmit(v.event);assert.equal(calls,1);release();await first;assert.equal(v.fields.password.value,'');assert.equal(v.fields.confirmation.value,'');assert.equal(v.status.textContent,'Username unavailable');
});
await test('stale profile requests cannot overwrite a newer render and completed accounts show username',async()=>{
 const v=view();let release;const first=renderAccountSetup(v.container,{getProfile:()=>new Promise(resolve=>{release=resolve;})});await renderAccountSetup(v.container,{getProfile:async()=>({...profile(),setup_required:false,member:{username:'registered',acronym:'JM'}})});release(profile());await first;assert(v.container.innerHTML.includes('registered'));assert(!v.container.innerHTML.includes('first-account-setup'));
});
