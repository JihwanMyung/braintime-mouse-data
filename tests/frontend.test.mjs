import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as model from '../web/model.js';
import { renderHousing, sourceListedAnimals, scheduleApplies } from '../web/husbandry.js';
const elements=new Map();
function element(id){if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,open:false,classList:{toggle(){}},addEventListener(){},focus(){},setSelectionRange(){},showModal(){this.open=true},close(){this.open=false},appendChild(){},click(){}});return elements.get(id)}
const fakeDocument={getElementById:element,addEventListener(){},createElement(tag){return element('created-'+tag)},body:{appendChild(){}}};
globalThis.document=fakeDocument;
assert.deepEqual(sourceListedAnimals({source_block_text:"A1: PB'-M123\nA2: EB-F456\nB2: 2026-01-01T00:00:00\nA3 comment: M999 was moved"}),["PB'-M123",'EB-F456']);
assert(scheduleApplies({start_date:'2026-10-14',timezone:'Asia/Taipei'},new Date('2026-10-13T23:00:00Z')));
assert(!scheduleApplies({start_date:'2026-10-15'},new Date('2026-10-13T23:00:00Z')));
assert(!scheduleApplies({start_date:'2026-10-01',end_date:'2026-10-14',interval_semantics:'next phase start'},new Date('2026-10-13T23:00:00Z')));
let saved=model.createSyntheticDataset();saved.demo=true;
const store={loadDataset:async()=>structuredClone(saved),saveDataset:async next=>{saved=structuredClone(next)},clearDataset:async()=>{saved=null},getCloudStatus:()=>({mode:'local',configured:false,signedIn:false})};
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const context={console,model,store,PUBLIC_CONFIG:{},history:{loadHistoryIndex:async()=>null,clearHistoryIndex:async()=>{}},renderHousing,scheduleApplies,document:fakeDocument,window:{addEventListener(){},print(){context.printed=true}},location:{hash:'',protocol:'file:'},navigator:{},crypto:webcrypto,setTimeout,clearTimeout,URL,Blob,FormData,MouseEvent:class{},Date,structuredClone,assert};
vm.createContext(context);vm.runInContext(source,context);await new Promise(resolve=>setTimeout(resolve,10));
vm.runInContext(`
assert($('main').innerHTML.includes('Recently born'));
for(const name of ['mice','matings','litters','cages','family','archive','settings','housing']){route=name;detail=null;render();assert($('main').innerHTML.length>50,name+' renders');}
route='settings';detail=null;render();assert($('main').innerHTML.includes('email-link-request'));assert($('main').innerHTML.includes('Password sign-in'));
route='mice';detail={type:'mice',id:dataset.tables.mice[0].mouse_sid};render();assert($('main').innerHTML.includes('Source provenance'));
openEditor('mice',null);assert($('record-dialog').open);assert($('record-fields').innerHTML.includes('Recorded dam IDs'));assert(editor.record.sex==='Unknown');
const current=dataset.tables.mice[2];current.dam_sids=[dataset.tables.mice[1].mouse_sid,'UNKNOWN-CANDIDATE'];
assert(parentHTML(current).includes('Recorded alternatives'));
assert(familySVG(current).includes('width:100%'));
const move=makeCageEvent(current,'SYN-C1','2025-05-06','Synthetic test');assert(move.old_cage_sid==='SYN-C1');assert(move.event_date==='2025-05-06');
dataset.tables.rooms.push({room_id:'ROOM-DEMO',name:'Demo room'});dataset.tables.racks.push({rack_id:'RACK-DEMO',room_id:'ROOM-DEMO',name:'Demo rack'});dataset.tables.locations.push({location_id:'POS-DEMO',room_id:'ROOM-DEMO',rack_id:'RACK-DEMO',label:'A1',row:1,column:1,source_block_text:'Synthetic source tag'});dataset.tables.light_events.push({event_id:'LIGHT-DEMO',location_id:'POS-DEMO',start_date:'2020-01-01',protocol:'T23',cycle_hours:23,lights_on:'07:00',evidence_status:'recorded_schedule_unverified'});route='housing';detail=null;render();assert($('main').innerHTML.includes('Unlinked'));assert($('main').innerHTML.includes('Synthetic source tag'));assert($('main').innerHTML.includes('Link cage'));assert($('main').innerHTML.includes('On 07:00'));assert($('main').innerHTML.includes('Unverified'));assert($('main').innerHTML.includes('<details class="compact-details source-position-details">'));assert(!$('main').innerHTML.includes('Position 1, 1'));assert($('main').innerHTML.indexOf('Demo room <')<$('main').innerHTML.indexOf('Cages without a room'));assert($('main').innerHTML.includes('<details class="panel unassigned-cages">'));

assert(familySVG(current).includes('stroke-dasharray'));
assert(!parentHTML(current).includes('recorded_single_parent'));
route='mice';detail=null;query='';filters={};renderTable();assert(currentRows.length===dataset.tables.mice.length);
filters={state:'Stock'};renderTable();assert(currentRows.every(r=>r.state==='Stock'));
printCards([dataset.tables.mice[0].mouse_sid]);assert($('print-area').innerHTML.includes('Generated'));assert($('print-area').innerHTML.includes('Protocol'));assert($('print-preview').open);assert($('print-area').innerHTML.includes('Light record'));action('system-print');
`,context);
assert(context.printed,'print triggered');
const shell=fs.readFileSync(new URL('../web/sw.js',import.meta.url),'utf8');
assert(shell.includes('!allowed.has(event.request.url)'),'service worker exact shell allowlist');
assert(!shell.includes('supabase.co'),'no cloud API route cached');
for(const filename of ['app.js','data-store.js','model.js']){const code=fs.readFileSync(new URL('../web/'+filename,import.meta.url),'utf8');for(const match of code.matchAll(/from ['"](\.\/[^'"]+\.js)['"]/g))assert(shell.includes(match[1]),'Offline shell includes '+match[1]);}
const manifest=JSON.parse(fs.readFileSync(new URL('../web/manifest.webmanifest',import.meta.url),'utf8'));
for(const icon of manifest.icons)assert(fs.existsSync(new URL('../web/'+icon.src.slice(2),import.meta.url)));

let configuredDefaults=null;
const publicExample={url:'https://example.supabase.co',anonKey:'sb_publishable_example',colonyId:'00000000-0000-4000-8000-000000000001'};
const onboardingStore={loadDataset:async()=>null,getCloudStatus:()=>({mode:'local',configured:Boolean(configuredDefaults),signedIn:false}),configureCloud:config=>{configuredDefaults={...config}}};
const onboardingContext={...context,store:onboardingStore,PUBLIC_CONFIG:publicExample,location:{hash:'',protocol:'file:'}};
vm.createContext(onboardingContext);vm.runInContext(source,onboardingContext);await new Promise(resolve=>setTimeout(resolve,10));
assert.deepEqual(configuredDefaults,publicExample,'Public defaults configure a fresh browser');
assert(element('main').innerHTML.includes('Sign in'),'Fresh configured browser offers sign-in');

const callbackCalls=[];let callbackPulled=false;
const callbackStore={getCloudStatus:()=>({mode:callbackPulled?'cloud':'local',configured:true,signedIn:true}),consumeAuthCallback:async()=>{callbackCalls.push('callback');return {signedIn:true}},loadDataset:async()=>{callbackCalls.push('load');return null},pullFromCloud:async()=>{callbackCalls.push('pull');callbackPulled=true;return model.createSyntheticDataset()}};
const callbackContext={...context,store:callbackStore,PUBLIC_CONFIG:publicExample,location:{hash:'',protocol:'https:',href:'https://example.test/app/'}};
vm.createContext(callbackContext);vm.runInContext(source,callbackContext);await new Promise(resolve=>setTimeout(resolve,10));
assert.deepEqual(callbackCalls,['callback','load','pull'],'Auth callback precedes local loading and empty device opens shared colony');
assert(element('main').innerHTML.includes('Recently born'));
let localPulls=0;
const retainedStore={...callbackStore,getCloudStatus:()=>({mode:'local',configured:true,signedIn:true}),loadDataset:async()=>model.createSyntheticDataset(),pullFromCloud:async()=>{localPulls++;return model.createSyntheticDataset()}};
const retainedContext={...context,store:retainedStore,PUBLIC_CONFIG:publicExample,location:{hash:'',protocol:'https:',href:'https://example.test/app/'}};
vm.createContext(retainedContext);vm.runInContext(source,retainedContext);await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(localPulls,0,'Auth callback preserves an existing local working dataset');
assert(element('main').innerHTML.includes('Load shared colony'));

console.log('PASS: frontend synthetic rendering, current candidate pedigree, editor, table filters, print card, housing, manifest assets and shell-only cache checks. Browser inspection remains separate.');
