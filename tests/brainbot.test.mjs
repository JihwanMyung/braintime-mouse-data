import test from 'node:test';
import assert from 'node:assert/strict';
import {renderBrainbot,validateBrainbotSettings,brainbotHelpHTML} from '../web/brainbot.js';
import {defaultManagerPermissions} from '../web/permissions.js';
const clone=structuredClone;
const issue=(id='I1',extra={})=>({issue_id:id,code:'CAGE_LOCATION_CONFLICT',severity:'warning',entity_type:'cages',entity_id:'C1',title:'Cage room differs from assigned position',details:{recorded_room:'R1',position_room:'R2'},status:'open',version:2,first_seen_at:'2026-10-14T02:00:00Z',last_seen_at:'2026-10-15T02:00:00Z',resolution_note:null,...extra});
const run=(id='R1',extra={})=>({run_id:id,trigger:'manual',status:'completed',started_at:'2026-10-15T02:00:00Z',finished_at:'2026-10-15T02:00:01Z',checked_count:12,fixed_count:1,issue_count:1,error_code:null,changes:[{entity_type:'cages',entity_id:'C2',fields:['room_id'],before_version:4,after_version:5}],...extra});
const initial=()=>({principal:{principal_id:'BB-PRINCIPAL',name:'Braintime / Brainbot Bot',acronym:'BB',role:'manager',permissions:defaultManagerPermissions()},settings:{version:3,enabled:false,daily_time:'03:00',timezone:'Asia/Taipei',automatic_corrections:false},schedule_active:false,last_run:null,runs:[],issues:[issue(),issue('I2',{status:'acknowledged',title:'Reviewed old issue'}),issue('I3',{status:'resolved',title:'Resolved old issue'})],issue_total:3});
async function harness(overrides={}){const container={innerHTML:''},calls=[],toasts=[],opened=[];let data=initial();const hooks={context:'OWNER:max',currentContext:()=>'OWNER:max',canManage:()=>true,getStatus:async()=>{calls.push({action:'get'});return clone(data)},saveSettings:async payload=>{calls.push({action:'save',payload:clone(payload)});data.settings={...data.settings,...payload,version:payload.version+1};delete data.settings.permissions;data.principal.permissions=clone(payload.permissions);return clone(data)},runChecks:async()=>{calls.push({action:'run'});const r=run('RUN-NEW');data.last_run=r;data.runs.unshift(r);return clone(data)},reviewIssue:async payload=>{calls.push({action:'review',payload:clone(payload)});const i=data.issues.find(i=>i.issue_id===payload.issue_id);Object.assign(i,{status:payload.status,resolution_note:payload.note,version:i.version+1});return clone(data)},openEntity:(type,id)=>opened.push([type,id]),toast:(message,error)=>toasts.push({message,error}),...overrides};const cleanup=await renderBrainbot(container,hooks);return {container,hooks,calls,toasts,opened,cleanup,get data(){return data},async click(action,id=''){await container.onclick?.({target:{closest:()=>({dataset:{bbAction:action,bbId:id}})},preventDefault(){}})},field(key,value){container.onchange?.({target:{value,checked:value,dataset:{bbField:key}}})},permission(key,value){container.onchange?.({target:{checked:value,dataset:{bbPermission:key}}})},filter(value){container.onchange?.({target:{id:'bb-filter',value,dataset:{}}})},note(value){container.oninput?.({target:{id:'bb-review-note',value,dataset:{}}})},async submit(kind='settings',values={},status){await container.onsubmit?.({target:{hasAttribute:k=>k===`data-bb-${kind}-form`,elements:{namedItem:key=>Object.hasOwn(values,key)?{value:values[key],checked:values[key]}:null}},submitter:status?{dataset:{bbReviewStatus:status}}:undefined,preventDefault(){},stopPropagation(){}})}};}

test('actual owner status shows internal manager identity and no invented successful runs',async()=>{
 const h=await harness();assert.deepEqual(h.calls,[{action:'get'}]);assert.match(h.container.innerHTML,/Manager service/);assert.match(h.container.innerHTML,/>Owner<\/span>/);assert.match(h.container.innerHTML,/Daily checks off/);assert.match(h.container.innerHTML,/Not run yet/);assert.doesNotMatch(h.container.innerHTML,/Checks completed/);assert.match(h.container.innerHTML,/Cage room differs/);assert.doesNotMatch(h.container.innerHTML,/Reviewed old issue|Resolved old issue/);
});
test('daily enabled without a live scheduler remains visibly inactive',async()=>{
 const d=initial();d.settings.enabled=true;const h=await harness({getStatus:async()=>d});assert.match(h.container.innerHTML,/server schedule inactive/);assert.match(h.container.innerHTML,/Daily execution has not been confirmed/);assert.doesNotMatch(h.container.innerHTML,/Daily at 03:00/);
});
test('settings save uses CAS, explicit daily time and manager capabilities without account calls',async()=>{
 const h=await harness();await h.click('tab','settings');h.field('enabled',true);h.field('daily_time','06:45');h.field('automatic_corrections',true);h.permission('imports',false);await h.submit();const p=h.calls.find(c=>c.action==='save').payload;assert.equal(p.version,3);assert.equal(p.enabled,true);assert.equal(p.daily_time,'06:45');assert.equal(p.automatic_corrections,true);assert.equal(p.permissions.imports,false);assert.equal(Object.hasOwn(p,'timezone'),false);assert.match(h.container.innerHTML,/settings saved/);assert.equal(h.data.settings.version,4);assert(!h.calls.some(c=>/mail|invite|account/.test(c.action)));
});
test('invalid settings and unrecognized permission fields never reach server',async()=>{
 const h=await harness();await h.click('tab','settings');h.field('daily_time','24:15');await h.submit();assert.match(h.container.innerHTML,/00:00 and 23:59/);assert.equal(h.calls.filter(c=>c.action==='save').length,0);const d={version:0,enabled:false,automatic_corrections:false,daily_time:'03:00',permissions:defaultManagerPermissions()};assert.deepEqual(validateBrainbotSettings(d),[]);assert(validateBrainbotSettings({...d,permissions:{...d.permissions,owner:true}}).length);assert(validateBrainbotSettings({...d,enabled:'true'}).length);
});
test('stale settings save preserves entered fields and does not claim success',async()=>{
 const h=await harness({saveSettings:async()=>{throw Object.assign(new Error('stale'),{code:'40001'})}});await h.click('tab','settings');h.field('daily_time','05:10');await h.submit();assert.match(h.container.innerHTML,/Refresh Braintime Bot/);assert.match(h.container.innerHTML,/value="05:10"/);assert.doesNotMatch(h.container.innerHTML,/settings saved/);
});
test('manual checks run with daily schedule disabled and report only newly recorded activity',async()=>{
 const h=await harness();await h.click('check');assert.equal(h.calls.filter(c=>c.action==='run').length,1);assert.match(h.container.innerHTML,/Checks completed: 12 records, 1 findings, 1 corrections/);await h.click('tab','activity');assert.match(h.container.innerHTML,/completed/);await h.click('run-detail','RUN-NEW');assert.match(h.container.innerHTML,/room_id/);assert.match(h.container.innerHTML,/4 → 5/);assert.match(h.container.innerHTML,/Recorded corrections/);await h.click('entity',JSON.stringify(['cages','C2']));assert.deepEqual(h.opened,[['cages','C2']]);
});
test('a stale run response cannot be presented as a successful new run',async()=>{
 const d=initial();d.last_run=run();d.runs=[d.last_run];const h=await harness({getStatus:async()=>clone(d),runChecks:async()=>clone(d)});await h.click('check');assert.match(h.container.innerHTML,/new manual run was not confirmed/);assert.doesNotMatch(h.container.innerHTML,/Checks completed|data-bb-settings-form/);
});
test('recorded failed runs remain failures with their actual error and no synthetic corrections',async()=>{
 const d=initial();d.last_run=run('FAILED',{status:'failed',error_code:'23505',fixed_count:0,changes:[]});d.runs=[d.last_run];const h=await harness({runChecks:async()=>clone(d)});await h.click('check');assert.match(h.container.innerHTML,/check failed/);assert.doesNotMatch(h.container.innerHTML,/Checks completed/);await h.click('tab','activity');assert.match(h.container.innerHTML,/23505/);await h.click('run-detail','FAILED');assert.match(h.container.innerHTML,/No corrections recorded/);
});
test('issue review requires a note and submits only typed CAS fields',async()=>{
 const h=await harness();await h.click('issue','I1');assert.match(h.container.innerHTML,/Finding details/);await h.submit('review',{},'acknowledged');assert.equal(h.calls.filter(c=>c.action==='review').length,0);assert.match(h.container.innerHTML,/Enter a review note/);h.note('Checked cage position today.');await h.submit('review',{},'acknowledged');assert.deepEqual(h.calls.find(c=>c.action==='review').payload,{issue_id:'I1',version:2,status:'acknowledged',note:'Checked cage position today.'});assert.match(h.container.innerHTML,/Issue marked reviewed/);assert.match(h.container.innerHTML,/Recorded review note/);assert.doesNotMatch(h.container.innerHTML,/data-bb-review-status="acknowledged"/);
});
test('resolution remains an owner review record, separate from corrections and later rechecking',async()=>{
 const h=await harness();await h.click('issue','I1');await h.submit('review',{note:'Corrected after physical review.'},'resolved');assert.equal(h.calls.filter(c=>c.action==='review').length,1);assert.equal(h.data.issues[0].status,'resolved');assert.match(h.container.innerHTML,/next check verifies whether it remains/);assert.doesNotMatch(h.container.innerHTML,/data-bb-review-status="resolved"/);await h.click('close-issue');h.filter('resolved');assert.match(h.container.innerHTML,/Cage room differs/);
});
test('denied loads and forged actions expose no settings or private findings',async()=>{
 let mutations=0;const h=await harness({getStatus:async()=>{throw Object.assign(new Error('Owner access required'),{code:'42501'})},saveSettings:async()=>mutations++,runChecks:async()=>mutations++,reviewIssue:async()=>mutations++});assert.match(h.container.innerHTML,/unavailable for this account/);assert.doesNotMatch(h.container.innerHTML,/Cage room differs|data-bb-settings-form|Run checks/);await h.click('check');await h.click('tab','settings');await h.submit();await h.submit('review',{note:'forged'},'resolved');assert.equal(mutations,0);
});
test('authorization loss during a mutation clears findings and editable drafts',async()=>{
 const h=await harness({saveSettings:async()=>{throw Object.assign(new Error('Denied'),{status:403})}});await h.click('tab','settings');await h.submit();assert.match(h.container.innerHTML,/unavailable for this account/);assert.doesNotMatch(h.container.innerHTML,/data-bb-settings-form|Cage room differs|Manager service/);
});
test('malformed server status fails closed, including missing capability and fake principal role',async()=>{
 for(const patch of [d=>{d.principal.role='owner'},d=>{delete d.principal.permissions.housing},d=>{d.settings.enabled='true'},d=>{d.issues[0].version='2'},d=>{d.issue_total=0}]){const d=initial();patch(d);const h=await harness({getStatus:async()=>d});assert.match(h.container.innerHTML,/could not be verified/);assert.doesNotMatch(h.container.innerHTML,/Cage room differs|Run checks/);}
});
test('stale async response from a previous mount cannot expose its owner status',async()=>{
 const container={innerHTML:''};let release;const pending=renderBrainbot(container,{getStatus:()=>new Promise(resolve=>release=resolve)});await renderBrainbot(container,{getStatus:async()=>{throw Object.assign(new Error('Denied'),{code:'42501'})}});release(initial());await pending;assert.match(container.innerHTML,/unavailable for this account/);assert.doesNotMatch(container.innerHTML,/Cage room differs|Manager service/);
});
test('context changes prevent actions and delayed mutation responses from crossing account/route',async()=>{
 let context='OWNER:max',release,saves=0;const h=await harness({currentContext:()=>context,saveSettings:()=>{saves++;return new Promise(resolve=>release=resolve)}});await h.click('tab','settings');const pending=h.submit();context='OTHER';await h.click('check');const d=initial();d.settings.version=4;release(d);await pending;assert.equal(saves,1);assert.equal(h.calls.filter(c=>c.action==='run').length,0);assert.doesNotMatch(h.container.innerHTML,/settings saved/);
});
test('untrusted issue data, run errors and entity details are escaped',async()=>{
 const d=initial();d.issues=[issue('X',{title:'<script>danger</script>',details:{text:'<img src=x onerror=bad>'},entity_id:'C<1'})];d.issue_total=1;d.principal.name='<img src=x onerror=bad>';const h=await harness({getStatus:async()=>d});assert.match(h.container.innerHTML,/&lt;script&gt;danger/);assert.doesNotMatch(h.container.innerHTML,/<script>|<img src/);await h.click('issue','X');assert.match(h.container.innerHTML,/&lt;img src=x onerror=bad&gt;/);assert.doesNotMatch(h.container.innerHTML,/<img src/);
});
test('search, status filters, server list limits and cleanup are visible and reversible',async()=>{
 const d=initial();d.issue_total=250;const h=await harness({getStatus:async()=>clone(d)});assert.match(h.container.innerHTML,/Showing 3 of 250/);h.filter('all');assert.match(h.container.innerHTML,/Reviewed old issue/);h.container.oninput({target:{id:'bb-search',value:'missing finding',dataset:{},selectionStart:15}});assert.doesNotMatch(h.container.innerHTML,/Cage room differs|Reviewed old issue/);h.cleanup();assert.equal(h.container.innerHTML,'');assert.equal(h.container.onclick,null);
});
test('help describes actual limited fixes and distinguishes the bot from a human account',()=>{const html=brainbotHelpHTML();assert.match(html,/internal manager service identity/);assert.match(html,/no human sign-in account/);assert.match(html,/blank room or rack ID/);assert.match(html,/reopens/);assert.doesNotMatch(html,/sends.*email|guarantee/);});


test('an uninitialized installation permits a null principal only at settings version zero',async()=>{
 const fresh=initial();fresh.principal.principal_id=null;fresh.settings.version=0;const h=await harness({getStatus:async()=>clone(fresh)});assert.match(h.container.innerHTML,/pending setup/);await h.click('tab','settings');assert.match(h.container.innerHTML,/data-bb-settings-form/);fresh.settings.version=1;const rejected=await harness({getStatus:async()=>clone(fresh)});assert.match(rejected.container.innerHTML,/could not be verified/);assert.doesNotMatch(rejected.container.innerHTML,/Run checks/);
});


test('correction details show only escaped changed-field values, not unrelated payloads',async()=>{
 const d=initial();d.last_run=run('VALUES',{changes:[{entity_type:'cages',entity_id:'C1',fields:['room_id','rack_id','room_id'],before_version:4,after_version:5,before:{room_id:null,secret_owner_contact:'DO-NOT-DISPLAY-BEFORE',genotype:'PRIVATE-GENOTYPE'},after:{room_id:'R2 <img onerror=bad>',rack_id:'K2',secret_owner_contact:'DO-NOT-DISPLAY-AFTER',genotype:'PRIVATE-GENOTYPE'}}]});d.runs=[d.last_run];
 const h=await harness({getStatus:async()=>clone(d)});await h.click('tab','activity');await h.click('run-detail','VALUES');assert.match(h.container.innerHTML,/<summary>Before \/ After<\/summary>/);assert.match(h.container.innerHTML,/<code>null<\/code>/);assert.match(h.container.innerHTML,/Not present/);assert.match(h.container.innerHTML,/R2 &lt;img onerror=bad&gt;/);assert.match(h.container.innerHTML,/<code>K2<\/code>/);assert.doesNotMatch(h.container.innerHTML,/DO-NOT-DISPLAY|PRIVATE-GENOTYPE|secret_owner_contact|<img onerror/);assert.equal((h.container.innerHTML.match(/<th>room_id<\/th>/g)||[]).length,1);
});
test('legacy correction records with no snapshots say unavailable instead of inventing previous values',async()=>{
 const d=initial();d.last_run=run();d.runs=[d.last_run];const h=await harness({getStatus:async()=>clone(d)});await h.click('tab','activity');await h.click('run-detail','R1');assert.match(h.container.innerHTML,/Snapshot unavailable/);assert.doesNotMatch(h.container.innerHTML,/<code>null<\/code>/);
});

test('eligible read-only users can inspect findings and activity but cannot forge owner actions',async()=>{
 const d=initial();d.last_run=run();d.runs=[d.last_run];
 const h=await harness({context:'VIEWER:high',currentContext:()=>'VIEWER:high',canManage:()=>false,getStatus:async()=>clone(d)});
 assert.match(h.container.innerHTML,/>Read only<\/span>/);assert.doesNotMatch(h.container.innerHTML,/Owner only|\bHigh\b|\bLow\b|\bMax\b|Run checks|data-bb-id="settings"/);
 assert.match(h.container.innerHTML,/Cage room differs/);await h.click('issue','I1');assert.match(h.container.innerHTML,/Finding details/);assert.doesNotMatch(h.container.innerHTML,/data-bb-review-form|Mark reviewed|Resolve<\/button>/);
 h.note('forged note');await h.submit('review',{note:'forged note'},'resolved');await h.click('check');await h.click('tab','settings');h.field('enabled',true);h.permission('imports',true);await h.submit('settings');await h.click('reset-settings');
 assert(!h.calls.some(c=>['run','save','review'].includes(c.action)));assert.doesNotMatch(h.container.innerHTML,/data-bb-settings-form|data-bb-review-form|Run checks/);
 await h.click('tab','activity');await h.click('run-detail','R1');assert.match(h.container.innerHTML,/Recorded corrections/);await h.click('entity',JSON.stringify(['cages','C2']));assert.deepEqual(h.opened,[['cages','C2']]);
});

test('missing, nonboolean or failing management hooks default to read-only',async()=>{
 for(const canManage of [undefined,()=>undefined,()=>'true',()=>{throw Error('Unavailable');}]){
  const h=await harness({canManage});assert.match(h.container.innerHTML,/>Read only<\/span>/);await h.click('check');await h.click('tab','settings');await h.submit();assert(!h.calls.some(c=>c.action==='run'||c.action==='save'));assert.doesNotMatch(h.container.innerHTML,/data-bb-settings-form|Run checks/);
 }
});

test('loss of management permission removes editable drafts and blocks retained form submissions',async()=>{
 let allowed=true;const h=await harness({canManage:()=>allowed});await h.click('tab','settings');h.field('daily_time','07:45');assert.match(h.container.innerHTML,/data-bb-settings-form/);allowed=false;
 await h.submit('settings',{daily_time:'07:45',enabled:true});assert.equal(h.calls.filter(c=>c.action==='save').length,0);assert.match(h.container.innerHTML,/>Read only<\/span>/);assert.doesNotMatch(h.container.innerHTML,/data-bb-settings-form|07:45|Run checks/);
 await h.click('issue','I1');await h.submit('review',{note:'forged'},'resolved');assert.equal(h.calls.filter(c=>c.action==='review').length,0);
});

test('late mutation response cannot claim success after management permission changes',async()=>{
 let allowed=true,release;const h=await harness({canManage:()=>allowed,saveSettings:()=>new Promise(resolve=>release=resolve)});await h.click('tab','settings');const pending=h.submit();allowed=false;const d=initial();d.settings.version++;release(d);await pending;
 assert.match(h.container.innerHTML,/>Read only<\/span>/);assert.doesNotMatch(h.container.innerHTML,/settings saved|data-bb-settings-form|Run checks/);assert.equal(h.toasts.length,0);
});

test('fresh server management denial overrides a stale local owner hook',async()=>{
 const d={...initial(),can_manage:false},h=await harness({canManage:()=>true,getStatus:async()=>clone(d)});
 assert.match(h.container.innerHTML,/>Read only<\/span>/);assert.doesNotMatch(h.container.innerHTML,/Run checks|data-bb-id="settings"/);await h.click('check');await h.submit();assert(!h.calls.some(c=>c.action==='run'||c.action==='save'));
 const invalid=await harness({getStatus:async()=>({...initial(),can_manage:'true'})});assert.match(invalid.container.innerHTML,/access could not be verified/);assert.doesNotMatch(invalid.container.innerHTML,/Cage room differs|Run checks/);
});
