import test from 'node:test';
import assert from 'node:assert/strict';
import {getUserAcronyms,userLabel,userAcronymHelpHTML,buildUserAcronymDefinition,validateUserAcronym,renderUserAcronyms} from '../web/user-acronyms.js';
const base=()=>({tables:{mice:[{mouse_sid:'M1'}],husbandry_events:[],experiment_sources:[]}});
const all={includeHistorical:true};
const build=(dataset,code,name,extra={})=>buildUserAcronymDefinition(dataset,{code,name,notes:'',...extra},{now:'2026-10-14T01:00:00Z'});

test('JM is explicitly named while observed acronym-like users remain unresolved without guesses',()=>{
 const d=base();d.tables.experiment_sources=[{operator:'JM'},{operator:'AB/CD'},{operator:'Full Person Name'},{operator:'JM (reviewed)'},{operator:'<script>'},{operator:'12:30'}];
 assert.deepEqual(getUserAcronyms(d).map(x=>x.code),['JM']);const rows=getUserAcronyms(d,all);assert.deepEqual(rows.map(x=>x.code),['AB','CD','JM']);assert.equal(rows.find(x=>x.code==='JM').name,'Jihwan Myung');assert.equal(rows.find(x=>x.code==='AB').name,null);assert.equal(rows.find(x=>x.code==='AB').resolved,false);assert.equal(userLabel('JM',d),'JM · Jihwan Myung');assert.equal(userLabel('AB',d),'AB');assert.equal(userLabel('Full Person Name',d),'Full Person Name');
});

test('historical definitions and given-name status are visible only when explicitly requested',()=>{
 const d=build(base(),'ZZ','Synthetic First',{historical:true,name_status:'given_name'}).dataset;
 assert.equal(userLabel('ZZ',d),'ZZ');assert.equal(userLabel('ZZ',d,all),'ZZ · Synthetic First');assert.doesNotMatch(userAcronymHelpHTML(d),/Synthetic First|<td>ZZ/);assert.match(userAcronymHelpHTML(d,all),/Synthetic First.*Given name only/);assert.equal(getUserAcronyms(d,all).find(r=>r.code==='ZZ').name_status,'given_name');
});

test('stable-ID definitions preserve original operators and source provenance when edited',()=>{
 const original=base();original.tables.husbandry_events.push({event_id:'EXP1',event_type:'experiment',experiment:{operator:'ZZ'}});const first=build(original,'zz','Synthetic Name');assert.equal(first.record.event_id,'USER-ACRONYM-ZZ');assert.deepEqual(original.tables.husbandry_events,[{event_id:'EXP1',event_type:'experiment',experiment:{operator:'ZZ'}}]);first.record.source_evidence={range:'B4'};first.dataset.tables.husbandry_events.find(r=>r.event_id===first.record.event_id).source_evidence={range:'B4'};
 const next=build(first.dataset,'ZZ','Revised Name');assert.equal(next.dataset.tables.husbandry_events[0].experiment.operator,'ZZ');assert.deepEqual(next.record.source_evidence,{range:'B4'});assert.equal(next.dataset.tables.husbandry_events.filter(r=>r.event_type==='user_acronym_definition').length,1);assert.equal(next.record.app_created_at,first.record.app_created_at);assert.deepEqual(validateUserAcronym(next.record,first.record),[]);
});

test('validation rejects malformed names, IDs, types and renamed codes',()=>{
 const first=build(base(),'AB','Synthetic Person');for(const input of [{code:'1A',name:'Number first'},{code:'A'.repeat(13),name:'Too long'},{code:'AB',name:''},{code:'AB',name:'A',name_status:'guessed'},{code:'AB',name:'A',historical:'yes'}])assert.throws(()=>buildUserAcronymDefinition(base(),input));
 const renamed=structuredClone(first.record);renamed.user_acronym.code='CD';renamed.event_id='USER-ACRONYM-CD';assert(validateUserAcronym(renamed,first.record).some(e=>/cannot change/.test(e)));assert(validateUserAcronym({...first.record,event_type:'other'},first.record).some(e=>/retain/.test(e)));assert(validateUserAcronym({...first.record,event_id:'random'}).some(e=>/stable/));assert.doesNotThrow(()=>build(base(),'AB',null,{name_status:'unresolved'}));
});

test('one registry scan serves repeated labels and a new immutable snapshot refreshes definitions',()=>{
 let reads=0;const d=base();d.tables.experiment_sources=Array.from({length:3000},()=>({get operator(){reads++;return 'ZZ'}}));for(let i=0;i<100;i++)userLabel('JM',d);assert.equal(reads,3000);const updated=build({...d,tables:{...d.tables,experiment_sources:[{operator:'ZZ'}]}},'ZZ','Synthetic Person').dataset;assert.equal(userLabel('ZZ',updated),'ZZ · Synthetic Person');assert.equal(userLabel('ZZ',d),'ZZ');
});

function harness(dataset=base(),overrides={}){const container={innerHTML:''},saves=[],messages=[];let current=dataset;const hooks={canEdit:()=>true,includeHistorical:true,reloadDataset:async()=>current,saveDataset:async next=>{current=next;saves.push(structuredClone(next))},toast:(message,error)=>messages.push({message,error}),...overrides};renderUserAcronyms(container,current,hooks);return {container,hooks,saves,messages,get dataset(){return current},field(code,key,value){container.oninput({target:{value,dataset:{userCode:code,userField:key}}})},async save(code){await container.onclick({target:{closest:()=>({dataset:{userAction:'save',userCode:code}})}})},render(next=current){current=next;renderUserAcronyms(container,current,hooks)}}}

test('Settings resolves observed codes, adds new codes and retains unrelated refreshed data',async()=>{
 const d=base();d.tables.experiment_sources=[{operator:'ZZ'}];const h=harness(d);assert.match(h.container.innerHTML,/Name not yet confirmed/);h.field('ZZ','name','Synthetic First');h.field('ZZ','name_status','given_name');h.hooks.reloadDataset=async()=>({...d,tables:{...d.tables,mice:[{mouse_sid:'M2'}]}});await h.save('ZZ');assert.equal(h.saves.length,1);assert.equal(h.dataset.tables.mice[0].mouse_sid,'M2');assert.equal(getUserAcronyms(h.dataset,all).find(r=>r.code==='ZZ').name,'Synthetic First');
 h.hooks.reloadDataset=async()=>h.dataset;h.field('__new','code','AB');h.field('__new','name','Another Person');await h.save('__new');assert.equal(h.saves.length,2);assert.equal(userLabel('AB',h.dataset),'AB · Another Person');
});

test('read-only and hidden historical rows reject forged edits; permission loss during refresh blocks writes',async()=>{
 const d=build(base(),'ZZ','Private Historical Name',{historical:true}).dataset,h=harness(d,{canEdit:()=>false,includeHistorical:false});assert.doesNotMatch(h.container.innerHTML,/Private Historical Name|<input/);await h.save('JM');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Edit access/);
 const hidden=harness(d,{includeHistorical:false});hidden.field('ZZ','name','Unauthorized');await hidden.save('ZZ');assert.equal(hidden.saves.length,0);assert.doesNotMatch(hidden.container.innerHTML,/Private Historical Name/);
 let editable=true;const revoked=harness(base(),{canEdit:()=>editable,reloadDataset:async()=>{editable=false;return base()}});revoked.field('JM','notes','Draft');await revoked.save('JM');assert.equal(revoked.saves.length,0);assert.match(revoked.container.innerHTML,/Edit access/);
});

test('concurrent definition changes reject stale drafts and failed saves retain escaped input',async()=>{
 const h=harness();h.field('JM','notes','Local note');h.hooks.reloadDataset=async()=>build(base(),'JM','Other recorded name').dataset;await h.save('JM');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/changed while you were editing/);assert.match(h.container.innerHTML,/Local note/);
 const failed=harness(base(),{saveDataset:async()=>{throw new Error('<script>Unavailable</script>')}});failed.field('__new','code','AB');failed.field('__new','name','<script>Person</script>');failed.field('__new','notes','</textarea><script>bad</script>');await failed.save('__new');assert.equal(failed.saves.length,0);assert.match(failed.container.innerHTML,/&lt;script&gt;Unavailable/);assert.match(failed.container.innerHTML,/&lt;script&gt;Person/);assert.doesNotMatch(failed.container.innerHTML,/<script>/);
});

test('a private historical JM definition cannot suppress the explicit public JM guide entry',()=>{
 const d=build(base(),'JM','Private historical label',{historical:true}).dataset;assert.equal(userLabel('JM',d),'JM · Jihwan Myung');assert.equal(userLabel('JM',d,all),'JM · Private historical label');assert.doesNotMatch(userAcronymHelpHTML(d),/Private historical label/);
});

test('current custom IDs support the shared one-to-twelve character acronym scheme',()=>{const d=build(build(base(),'A','One-letter User').dataset,'J_M-2','Custom Code User').dataset;assert.equal(userLabel('A',d),'A · One-letter User');assert.equal(userLabel('J_M-2',d),'J_M-2 · Custom Code User');assert.throws(()=>build(d,'A'.repeat(13),'Too Long'))});

test('directory revision tracks semantic display changes without mutating submitted profile data',async()=>{const {setLabUserDirectory,getLabUserDirectoryVersion}=await import('../web/user-acronyms.js');const rows=[{code:'ZZ',name:'Synthetic Current User',email:'private@example.test'}],before=structuredClone(rows);try{const initial=getLabUserDirectoryVersion();setLabUserDirectory(rows);assert(getLabUserDirectoryVersion()>initial);const version=getLabUserDirectoryVersion();setLabUserDirectory(structuredClone(rows));assert.equal(getLabUserDirectoryVersion(),version);assert.deepEqual(rows,before);assert.equal(userLabel('ZZ',base()),'ZZ · Synthetic Current User');setLabUserDirectory([]);assert(getLabUserDirectoryVersion()>version);assert.equal(userLabel('ZZ',base()),'ZZ')}finally{setLabUserDirectory([])}});
