import test from 'node:test';
import assert from 'node:assert/strict';
import {mouseManager,cageManager,normalizeDataset,validateRecord} from '../web/model.js';

const mouse=(id,fields={})=>({mouse_sid:id,sex:'Unknown',state:'Stock',cage_sid:'C1',...fields});
const dataset=(mice=[],cages=[{cage_sid:'C1'}])=>normalizeDataset({tables:{mice,cages}});

test('mouse manager uses recorded owner, removes only contextual Me, and never uses creator',()=>{
  const record=mouse('M1',{owner:'  Demo Keeper (Me)  ',creator:'Other Person',source_record_id:'source:1'}),before=structuredClone(record);
  assert.deepEqual(mouseManager(record),{name:'Demo Keeper',source:'owner',status:'assigned',candidates:['Demo Keeper'],incomplete:false,missing:false,conflict:false});
  assert.deepEqual(record,before);
  assert.equal(mouseManager({creator:'Other Person',key_contact:'Contact'}).status,'missing');
  assert.equal(mouseManager({owner:'Name (Member)'}).name,'Name (Member)');
});

test('an explicit manager overrides source ownership without modifying provenance',()=>{
  const record=mouse('M1',{manager:' New Keeper ',owner:'Old Keeper (Me)',source_record_id:'original'}),before=structuredClone(record);
  assert.equal(mouseManager(record).name,'New Keeper');assert.equal(mouseManager(record).source,'manager');
  assert.deepEqual(record,before);
  const d=dataset([record]);assert.deepEqual(normalizeDataset(d).tables.mice[0],record);
});

test('explicit empty assignments block imported and resident fallbacks',()=>{
  for(const manager of [null,'','   ']){
    const r={manager,owner:'Imported Keeper'};
    assert.equal(mouseManager(r).status,'missing');assert.equal(mouseManager(r).source,'manager');
    assert.equal(cageManager({cage_sid:'C1',...r},[mouse('M1',{manager:'Resident Keeper'})]).status,'missing');
  }
  assert.equal(mouseManager({owner:'Imported Keeper'}).status,'assigned');
});

test('cage assignment then imported cage owner take precedence over resident disagreement',()=>{
  const mice=[mouse('M1',{manager:'First'}),mouse('M2',{manager:'Second'})];
  assert.equal(cageManager({cage_sid:'C1',owner:'Cage Keeper'},mice).name,'Cage Keeper');
  assert.equal(cageManager({cage_sid:'C1',owner:'Cage Keeper',manager:'Assigned Keeper'},mice).name,'Assigned Keeper');
});

test('cage manager uses unanimous current residents and excludes ended, archived and other cages',()=>{
  const mice=[mouse('M1',{manager:'Keeper'}),mouse('M2',{owner:'Keeper (Me)'}),mouse('M3',{manager:'Wrong',state:'Ended'}),mouse('M4',{manager:'Wrong',app_archived_at:'2026-10-14'}),mouse('M5',{manager:'Wrong',archived:true}),mouse('M6',{manager:'Wrong',cage_sid:'C2'}),mouse('M7',{manager:'Wrong',state:null})];
  const before=structuredClone(mice),resolved=cageManager({cage_sid:'C1'},mice);
  assert.equal(resolved.name,'Keeper');assert.equal(resolved.source,'residents');assert.equal(resolved.status,'assigned');
  assert.deepEqual(mice,before);assert.equal(cageManager({cage_sid:'C2'},[]).status,'missing');
});

test('different resident managers are explicit conflicts, including more than two candidates',()=>{
  const r=cageManager({cage_sid:'C1'},[mouse('M1',{owner:'Third'}),mouse('M2',{manager:'First'}),mouse('M3',{manager:'Second'})]);
  assert.equal(r.name,null);assert.equal(r.status,'conflict');assert.equal(r.conflict,true);assert.deepEqual(r.candidates,['First','Second','Third']);
});

test('partly unknown resident managers do not establish a cage-wide assignment',()=>{
  const r=cageManager({cage_sid:'C1'},[mouse('M1',{manager:'Keeper'}),mouse('M2',{creator:'Keeper'})]);
  assert.equal(r.name,null);assert.equal(r.status,'missing');assert.equal(r.incomplete,true);assert.deepEqual(r.candidates,['Keeper']);
  assert.equal(cageManager({},[mouse('M1',{cage_sid:undefined,manager:'Keeper'})]).status,'missing');
});

test('new mice need a manager; cages allow explicit unassigned responsibility',()=>{
  const d=dataset();
  assert.match(validateRecord('mice',mouse('M1'),d).errors.join(' '),/Assign a manager/);
  assert.deepEqual(validateRecord('mice',mouse('M1',{manager:'Keeper'}),d).errors,[]);
  assert.deepEqual(validateRecord('mice',mouse('M1',{owner:'Imported Keeper'}),d).errors,[]);
  assert.deepEqual(validateRecord('cages',{cage_sid:'C2'},d).errors,[]);
  assert.match(validateRecord('cages',{cage_sid:'C2'},d).warnings.join(' '),/No manager/);
  assert.deepEqual(validateRecord('cages',{cage_sid:'C2',manager:'Keeper'},d).errors,[]);
});

test('historical missing assignment permits unrelated edits with a warning',()=>{
  const original=mouse('M1'),d=dataset([original]);
  const result=validateRecord('mice',{...original,comment:'Reviewed'},d,'M1');
  assert.deepEqual(result.errors,[]);assert.match(result.warnings.join(' '),/No manager is recorded/);
  const cageResult=validateRecord('cages',{cage_sid:'C1',comment:'Reviewed'},d,'C1');
  assert.deepEqual(cageResult.errors,[]);assert.match(cageResult.warnings.join(' '),/Some resident mice/);
});

test('cages can be unassigned while mice still require a manager and historical empty overrides stay editable',()=>{
  const old=mouse('M1',{owner:'Imported Keeper'}),d=dataset([old],[{cage_sid:'C1',owner:'Imported Keeper'}]);
  for(const manager of [null,'',' ']){
    assert.match(validateRecord('mice',{...old,manager},d,'M1').errors.join(' '),/Assign a manager/);
    assert.deepEqual(validateRecord('cages',{...d.tables.cages[0],manager},d,'C1').errors,[]);
  }
  assert.deepEqual(validateRecord('mice',{...old,manager:'New Keeper'},d,'M1').errors,[]);
  const historical={...old,manager:null},historicalData=dataset([historical]);
  assert.deepEqual(validateRecord('mice',{...historical,comment:'Reviewed'},historicalData,'M1').errors,[]);
});

test('invalid manager objects are rejected rather than treated as names',()=>{
  const d=dataset();
  for(const manager of [123,['Keeper'],{name:'Keeper'},false])assert.match(validateRecord('mice',mouse('M1',{manager}),d).errors.join(' '),/Manager must be a name/);
});
