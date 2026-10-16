import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildCageManagerChoices,cageManagerValue} from '../web/cage-managers.js';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const line=name=>source.split('\n').find(value=>value.startsWith(`function ${name}(`)||value.startsWith(`async function ${name}(`));
const validation=source.slice(source.indexOf('async function validateEditorCageManager('),source.indexOf('\nasync function saveDraft('));
const roster=[{person_id:'current',name:'Current Caretaker',status:'current'},{person_id:'historical',name:'Selected Historical',status:'historical'}];
function fixture({manager='Current Caretaker',draftManager='Selected Historical'}={}){
 const elements=new Map(),element=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,hidden:true,innerHTML:'',textContent:'',close(){}});return elements.get(id);};
 const record={cage_sid:'C1',manager,state:'Active'},dataset={tables:{cages:[record],mice:[{mouse_sid:'M1',manager:'Animal Caretaker'}],husbandry_events:[]}};
 const context={editor:{type:'cages',id:'C1',record},dataset,busy:false,account:'original',allowed:true,roster,loads:0,saves:0,toasts:[],navigated:[],draft:{...record,manager:draftManager},cloud:{mode:'cloud'},$:element,clone:structuredClone,now:()=> '2026-10-16T00:00:00Z',entity:{cages:{id:'cage_sid'}},housingKeys:{rooms:'room_id',racks:'rack_id',locations:'location_id'},buildCageManagerChoices,cageManagerValue};
 context.cageSheetContext=()=>context.account;context.canEditRecords=()=>context.allowed;
 context.loadCageManagerOptions=async()=>{context.loads++;context.started?.();if(context.wait)await context.wait;if(context.directoryError)throw context.directoryError;return context.roster;};
 context.showDraft=()=>({draft:context.draft,validation:{errors:[]}});context.showToast=(...args)=>context.toasts.push(args);
 context.refreshCloud=async()=>{};context.navigate=(...args)=>context.navigated.push(args);
 context.store={saveDataset:async data=>{context.saves++;context.saved=structuredClone(data)},loadDataset:async()=>context.saved};
 context.currentCageManagers=()=>context.roster;context.cageManagerOptionsHTML=value=>`options:${value}`;
 vm.createContext(context);vm.runInContext([validation,line('saveDraft'),line('loadEditorCageManagers')].join('\n'),context);
 context.save=()=>context.saveDraft({preventDefault(){}});return context;
}

test('record editor refreshes manager eligibility before saving a changed assignment without changing animal responsibility',async()=>{
 const context=fixture();await context.save();assert.equal(context.loads,1);assert.equal(context.saves,1);assert.equal(context.saved.tables.cages[0].manager,'Selected Historical');assert.equal(context.saved.tables.mice[0].manager,'Animal Caretaker');
});
test('withdrawn historical choice or failed directory cannot save a new manager, while the draft remains available',async()=>{
 for(const fail of ['withdrawn','offline']){
  const context=fixture();if(fail==='withdrawn')context.roster=roster.slice(0,1);else context.directoryError=Error('Manager directory unavailable');
  await context.save();assert.equal(context.saves,0);assert.equal(context.editor.record.manager,'Current Caretaker');assert.equal(context.draft.manager,'Selected Historical');assert.equal(context.$('form-errors').hidden,false);assert.match(context.$('form-errors').textContent,/manager list|unavailable/);assert.equal(context.busy,false);
 }
});
test('account, editor or housing access changes during the directory lookup block save',async()=>{
 for(const mutate of [context=>context.account='another',context=>context.editor={...context.editor},context=>context.allowed=false]){
  const context=fixture();let started,release;const began=new Promise(resolve=>started=resolve);context.started=started;context.wait=new Promise(resolve=>release=resolve);
  const saving=context.save();await began;mutate(context);release();await saving;assert.equal(context.saves,0);assert.match(context.$('form-errors').textContent,/Account or editor changed/);
 }
});
test('unchanged legacy manager and explicit unassignment save without a directory request',async()=>{
 for(const manager of ['Legacy caretaker','']){
  const context=fixture({manager:'Legacy caretaker',draftManager:manager});context.directoryError=Error('Offline');await context.save();assert.equal(context.loads,0);assert.equal(context.saves,1);assert.equal(context.saved.tables.cages[0].manager,manager);
 }
 const denied=fixture({manager:'Legacy caretaker',draftManager:'Legacy caretaker'});denied.allowed=false;await denied.save();assert.equal(denied.saves,0);
});
test('failed editor directory fetch leaves manager selection disabled and ignores late responses after the editor changes',async()=>{
 const context=fixture();context.directoryError=Error('Offline');await context.loadEditorCageManagers();assert.equal(context.$('field-manager').disabled,true);assert.equal(context.toasts.length,1);
 const pending=fixture();let started,release;const began=new Promise(resolve=>started=resolve);pending.started=started;pending.wait=new Promise(resolve=>release=resolve);
 const loading=pending.loadEditorCageManagers();await began;pending.editor={...pending.editor};pending.$('field-manager').innerHTML='new editor';release();await loading;assert.equal(pending.$('field-manager').innerHTML,'new editor');
});
test('collecting cage edits preserves unchanged aliases and own empty values, and stores explicit unassignment as an empty string',()=>{
 const context=fixture();context.fieldDefs={cages:[['cage_sid','SID'],['manager','Manager','manager'],['comment','Comment']]};context.cageLocationRefs=()=>({});context.cageRecords=()=>[];context.managerFor=(_type,record)=>({name:Object.hasOwn(record,'manager')?record.manager:record.owner});
 context.ids=value=>[value];context.formValues={cage_sid:'C1',manager:'',comment:'Edited note'};context.FormData=class{get(key){return context.formValues[key]}};
 vm.runInContext(line('collectDraft'),context);
 let draft=context.collectDraft();assert.equal(draft.manager,'');assert.equal(draft.comment,'Edited note');
 delete context.editor.record.manager;context.editor.record.owner='Current';context.formValues.manager='Current Caretaker';draft=context.collectDraft();assert.equal(Object.hasOwn(draft,'manager'),false);assert.equal(draft.owner,'Current');
 context.editor.record.manager='';context.formValues.manager='';assert.equal(context.collectDraft().manager,'');
 context.editor.record.manager='Legacy caretaker';context.$('field-manager').disabled=true;context.formValues.manager='';assert.equal(context.collectDraft().manager,'Legacy caretaker');
});
