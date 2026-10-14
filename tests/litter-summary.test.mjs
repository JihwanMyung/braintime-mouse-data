import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLitters } from '../web/litter-summary.js';

const asOf='2026-10-14';
const summarize=data=>summarizeLitters(data,{asOf});
const data=(mice=[],extra={})=>({tables:{mice:mice.map((mouse,index)=>({mouse_sid:`M${index}`,state:'Stock',...mouse})),litters:[],cages:[],...extra}});
const birthAtAge=age=>new Date(Date.parse(`${asOf}T00:00:00Z`)-age*86400000).toISOString().slice(0,10);
const ageMouse=age=>({date_of_birth:birthAtAge(age)});

function managed() {
  return data([
    {mouse_sid:'PUP',...ageMouse(21),wean_date:asOf,dam_sids:['DAM'],cage_sid:'PUP-CAGE',litter_sid:'L1'},
    {mouse_sid:'DAM',...ageMouse(200),sex:'Female',cage_sid:'DAM-CAGE'},
  ],{cages:[{cage_sid:'PUP-CAGE',state:'Active'},{cage_sid:'DAM-CAGE',state:'Active'}],litters:[{litter_sid:'L1',date_of_birth:birthAtAge(21),state:'Weaned',wean_date:asOf}]});
}

test('age boundaries use calendar days and cumulative under-three-week count',()=>{
  const summary=summarize(data([0,6,7,20,21,22].map(ageMouse)));
  assert.equal(summary.livingMice,6);assert.equal(summary.newborn,2);assert.equal(summary.preWeaningAge,4);assert.equal(summary.weaningAge,2);assert.equal(summary.unknownAge,0);
  assert.equal(summary.weanedAndSeparated,0);assert.equal(summary.unconfirmedWeanedAndSeparated,2);
});

test('missing invalid and future birth dates are excluded from age buckets',()=>{
  const summary=summarize(data([{},...['2026-02-30','2026-10-15','14/10/2026','2026-10-14T00:00:00Z',42].map(date_of_birth=>({date_of_birth})),ageMouse(1)]));
  assert.equal(summary.livingMice,7);assert.equal(summary.unknownAge,6);assert.equal(summary.newborn,1);assert.equal(summary.weaningAge,0);
});

test('counts only current nonarchived Stock mice and never reported litter size',()=>{
  const summary=summarize(data([ageMouse(1),{...ageMouse(1),state:'Ended'},{...ageMouse(1),archived:true},{...ageMouse(1),app_archived_at:asOf},{...ageMouse(1),state:'Unknown'}],{litters:[{litter_sid:'ONLY-LITTER',date_of_birth:asOf,size_reported:'10',state:'Unweaned'}]}));
  assert.equal(summary.livingMice,1);assert.equal(summary.newborn,1);assert.equal(summary.unknownCurrent,0);
});

test('deduplicates mouse IDs without hiding birth or status conflicts',()=>{
  const d=data([{mouse_sid:'SAME',...ageMouse(6)},{mouse_sid:'SAME',...ageMouse(6)},{mouse_sid:'BIRTH',...ageMouse(6)},{mouse_sid:'BIRTH',...ageMouse(7)},{mouse_sid:'STATE',...ageMouse(6)},{mouse_sid:'STATE',...ageMouse(6),state:'Ended'},{mouse_sid:'ARCHIVE',...ageMouse(6)},{mouse_sid:'ARCHIVE',...ageMouse(6),archived:true}]);
  const summary=summarize(d);assert.equal(summary.livingMice,2);assert.equal(summary.newborn,1);assert.equal(summary.unknownAge,1);assert.equal(summary.unknownCurrent,2);
  assert.deepEqual(summarize({tables:{mice:[...d.tables.mice].reverse()}}),summary);
});

test('birth uncertainty includes one blank duplicate and numeric IDs deduplicate',()=>{
  const summary=summarize(data([{mouse_sid:42,...ageMouse(6)},{mouse_sid:' 42 ',...ageMouse(6)},{mouse_sid:'BLANK',...ageMouse(1)},{mouse_sid:'BLANK'}]));
  assert.equal(summary.livingMice,2);assert.equal(summary.newborn,1);assert.equal(summary.unknownAge,1);
});

test('requires both recorded weaning and current separation from the recorded dam',()=>{
  const fixture=managed();assert.equal(summarize(fixture).weanedAndSeparated,1);
  for(const update of [d=>d.tables.mice[0].cage_sid='DAM-CAGE',d=>{delete d.tables.mice[0].wean_date;delete d.tables.litters[0].wean_date;d.tables.litters[0].state='Unweaned';},d=>{d.tables.mice[0].dam_sids=[];d.tables.litters[0].dam_sids=['DAM'];},d=>d.tables.mice[0].dam_sids=['DAM','OTHER'],d=>d.tables.mice[1].state='Ended',d=>d.tables.mice[1].sex='Unknown',d=>d.tables.cages[0].state='Inactive',d=>d.tables.cages[1].archived=true,d=>d.tables.mice[1].cage_sid='MISSING']) {
    const copy=structuredClone(fixture);update(copy);assert.equal(summarize(copy).weanedAndSeparated,0);
  }
});

test('matching current litter supports missing individual weaning date but not parentage',()=>{
  const d=managed();delete d.tables.mice[0].wean_date;
  assert.equal(summarize(d).weanedAndSeparated,1);
  delete d.tables.litters[0].wean_date;assert.equal(summarize(d).weanedAndSeparated,1);
  d.tables.litters[0].archived=true;assert.equal(summarize(d).weanedAndSeparated,0);
});

test('future invalid and contradictory weaning evidence does not confirm management',()=>{
  for(const update of [d=>d.tables.mice[0].wean_date='2026-10-15',d=>d.tables.mice[0].wean_date='2026-02-30',d=>d.tables.mice[0].wean_date=birthAtAge(22),d=>d.tables.litters[0].wean_date='2026-10-15',d=>d.tables.litters[0].wean_date='2026-02-30',d=>d.tables.litters[0].state='Unweaned',d=>d.tables.litters[0].date_of_birth=birthAtAge(22)]) {
    const d=managed();update(d);assert.equal(summarize(d).weanedAndSeparated,0);
  }
});

test('conflicting duplicate weaning cage and dam information cannot confirm management',()=>{
  for(const update of [d=>d.tables.mice.push({...d.tables.mice[0],wean_date:'2026-10-13'}),d=>d.tables.mice.push({...d.tables.mice[0],cage_sid:'OTHER'}),d=>d.tables.mice.push({...d.tables.mice[0],dam_sids:['OTHER']}),d=>d.tables.mice.push({...d.tables.mice[1],cage_sid:'OTHER'}),d=>d.tables.litters.push({...d.tables.litters[0],state:'Unweaned'}),d=>d.tables.cages.push({...d.tables.cages[0],archived:true})]) {
    const d=managed();update(d);assert.equal(summarize(d).weanedAndSeparated,0);
  }
});

test('historical dam cages cage tags and source observations never establish separation',()=>{
  const d=managed();delete d.tables.mice[1].cage_sid;d.tables.litters[0].dam_cage_sid='DAM-CAGE';d.tables.mice[1].cage_tag='DAM-CAGE';d.tables.locations=[{source_observed_mouse_sids:['DAM'],source_observed_cage_sids:['DAM-CAGE']}];
  assert.equal(summarize(d).weanedAndSeparated,0);
});

test('known management does not make under-three-week animals part of older cohort',()=>{
  const d=managed();d.tables.mice[0].date_of_birth=birthAtAge(20);d.tables.litters[0].date_of_birth=birthAtAge(20);
  const summary=summarize(d);assert.equal(summary.preWeaningAge,1);assert.equal(summary.weaningAge,1);assert.equal(summary.weanedAndSeparated,0);
});

test('calendar arithmetic covers leap dates without elapsed-clock drift',()=>{
  const d=data([{date_of_birth:'2024-02-29'}]);
  assert.equal(summarizeLitters(d,{asOf:'2024-03-06'}).newborn,1);
  assert.equal(summarizeLitters(d,{asOf:'2024-03-07'}).newborn,0);
  assert.equal(summarizeLitters(d,{asOf:'2024-03-21'}).weaningAge,1);
});

test('pure summary handles empty data and validates injected day',()=>{
  const d=managed(),before=structuredClone(d);assert.deepEqual(summarize(d),summarize(d));assert.deepEqual(d,before);
  assert.deepEqual(summarize(null),{asOf,livingMice:0,newborn:0,preWeaningAge:0,weaningAge:0,unknownAge:0,unknownCurrent:0,weanedAndSeparated:0,unconfirmedWeanedAndSeparated:0});
  for(const date of ['2026-02-30',null,123])assert.throws(()=>summarizeLitters(d,{asOf:date}),/valid YYYY-MM-DD/);
});
