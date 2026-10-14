import test from 'node:test';
import assert from 'node:assert/strict';
import {blankLocoboxProtocol,blankLocoboxPhase,blankLocoboxTreatment,buildLocoboxProtocol,validateLocoboxRecord,listLocoboxProtocols,locoboxEvidence} from '../web/locobox-model.js';
const base=()=>({tables:{cages:[{cage_sid:'C1',location_id:'L1'}],locations:[{location_id:'L1',label:'Box 1'}],mice:[{mouse_sid:'M1',cage_sid:'C1'}],light_events:[],husbandry_events:[]}});
const input=()=>({...blankLocoboxProtocol(),title:'Sequential light and treatment',cage_sid:'C1',link_status:'confirmed',phases:[{...blankLocoboxPhase(),scheme:'LD',start_date:'2026-01-01',end_date:'2026-02-01',cycle_hours:24,light_hours:12,lights_on:'07:00',lights_off:'19:00'}]});
const saved=(p=input(),d=base())=>buildLocoboxProtocol(p,d,null,{eventId:'LOC1',now:'2026-10-15T12:00:00+08:00'});

test('blank fields stay unknown and an LD/LP name does not invent an exact schedule',()=>{
 const p=input();p.phases=[{...blankLocoboxPhase(),scheme:'LP1'}];const b=saved(p);
 assert.equal(b.record.event_date,null);assert.equal(b.record.locobox_protocol.phases[0].lights_on,null);assert.equal(b.record.locobox_protocol.phases[0].cycle_hours,null);
 assert.match(b.warnings.join(' '),/does not specify a complete exact schedule/);assert.deepEqual(base().tables.husbandry_events,[]);
});
test('sequential phases use exclusive boundaries and reject overlap or reversed ordering',()=>{
 const p=input();p.phases[0].end_time='10:00';p.phases.push({...blankLocoboxPhase(),scheme:'DD',start_date:'2026-02-01',start_time:'10:00'});assert.equal(saved(p).record.locobox_protocol.phases.length,2);
 p.phases[1].start_time='09:59';assert.throws(()=>saved(p),/overlap/);p.phases[1].start_time='10:00';p.phases[1].start_date='2025-12-01';assert.throws(()=>saved(p),/chronological/);
});
test('unknown ends remain explicit uncertainty, with no automatic next-phase filling',()=>{
 const p=input();p.phases[0].end_date=null;p.phases.push({...blankLocoboxPhase(),scheme:'DD',start_date:'2026-02-01'});const b=saved(p);
 assert.equal(b.record.locobox_protocol.phases[0].end_date,null);assert.match(b.warnings.join(' '),/no recorded end/);
});
test('clock, timezone and impossible schedules fail without silently fixing source values',()=>{
 for(const patch of [{start_time:'25:00'},{timezone:'bad/zone'},{cycle_hours:12,light_hours:13},{scheme:'DD',light_hours:12},{scheme:'LL',light_hours:12},{lights_on:'7:00'}]){const p=input();Object.assign(p.phases[0],patch);assert.throws(()=>saved(p));}
 const p=input();p.phases[0].start_date=null;p.phases[0].start_time='07:00';assert.throws(()=>saved(p),/requires its date/);
});
test('dose, concentration, treatment status and phase interval are validated separately',()=>{
 const p=input(),t={...blankLocoboxTreatment(),name:'Vehicle control',status:'planned',dose:0,dose_unit:'mg/kg',route:'IP',start_date:'2026-01-10'};p.phases[0].treatments=[t];assert.equal(saved(p).record.locobox_protocol.phases[0].treatments[0].status,'planned');
 t.dose_unit=null;assert.throws(()=>saved(p),/dose requires its unit/);t.dose_unit='mg/kg';t.concentration=2;assert.throws(()=>saved(p),/concentration requires its unit/);t.concentration_unit='mg/mL';t.start_date='2025-12-31';assert.throws(()=>saved(p),/outside their phase/);
 t.start_date='2026-01-10';t.status='cancelled';assert.equal(saved(p).record.locobox_protocol.phases[0].treatments[0].status,'cancelled');
});
test('measured phase requires its own offset timestamp and method, never inherits a light clock',()=>{
 const p=input();p.phases[0].measured_phase.phase_hours=6;assert.throws(()=>saved(p),/measurement method/);
 Object.assign(p.phases[0].measured_phase,{measured_at:'2026-01-10T13:00:00+08:00',basis:'CT',method:'Activity onset reference'});assert.equal(saved(p).record.locobox_protocol.phases[0].measured_phase.phase_hours,6);
 p.phases[0].measured_phase.measured_at='2026-01-10T13:00';assert.throws(()=>saved(p),/UTC offset/);
});
test('calculated duration is actual calendar date difference; recorded durations remain distinct',()=>{
 const p=input();Object.assign(p.phases[0],{duration_days:31,duration_basis:'date_difference'});assert.equal(saved(p).record.locobox_protocol.phases[0].duration_days,31);
 p.phases[0].duration_days=30;assert.throws(()=>saved(p),/must equal end date minus start date/);p.phases[0].duration_basis='recorded';assert.equal(saved(p).record.locobox_protocol.phases[0].duration_days,30);
});
test('active protocols require recorded evidence and an explicitly confirmed exact cage',()=>{
 const p=input();p.status='active';assert.throws(()=>saved(p),/recorded evidence/);p.evidence_status='recorded';assert.equal(saved(p).record.locobox_protocol.status,'active');p.link_status='unresolved';assert.throws(()=>saved(p),/confirmed cage/);
 p.status='planned';p.cage_sid='missing';assert.throws(()=>saved(p),/existing cage/);
});
test('edits preserve immutable source evidence and append dated before/after snapshots',()=>{
 const b=buildLocoboxProtocol(input(),base(),null,{eventId:'LOC1',now:'2026-10-15T12:00:00+08:00',sourceRecord:{source_raw_values:{A1:'Original'}}}),before=structuredClone(b.dataset),next=structuredClone(b.record.locobox_protocol);next.phases[0].lights_on='06:00';
 const edit=buildLocoboxProtocol(next,b.dataset,b.record,{now:'2026-10-16T12:00:00+08:00'}),rev=edit.dataset.tables.husbandry_events.find(r=>r.event_type==='locobox_revision');
 assert.deepEqual(b.dataset,before);assert.equal(rev.locobox_revision.before.phases[0].lights_on,'07:00');assert.equal(rev.locobox_revision.after.phases[0].lights_on,'06:00');assert.equal(rev.event_date,'2026-10-16');assert.deepEqual(edit.record.source_raw_values,{A1:'Original'});
 const changed=structuredClone(edit.record);changed.source_raw_values.A1='Rewritten';assert.match(validateLocoboxRecord(changed,edit.dataset,edit.record).errors.join(' '),/Preserve the original/);
 const changedRev=structuredClone(rev);changedRev.locobox_revision.before.title='Changed';assert.match(validateLocoboxRecord(changedRev,edit.dataset,rev).errors.join(' '),/append-only/);
});
test('source observations cannot be overwritten, stale records and duplicate IDs are rejected',()=>{
 const p=input();p.status='source';p.evidence_status='source';const b=saved(p);const next=structuredClone(p);next.title='Edited';assert.throws(()=>buildLocoboxProtocol(next,b.dataset,b.record),/read-only/);
 assert.throws(()=>buildLocoboxProtocol(input(),b.dataset,null,{eventId:'LOC1'}),/already exists/);
 const stale=structuredClone(b.record);stale.locobox_protocol.title='Stale';assert.throws(()=>buildLocoboxProtocol(p,b.dataset,stale),/changed/);
});
test('position context remains a candidate and unrelated current residents do not create historical evidence',()=>{
 const d=base();d.tables.light_events=[{event_id:'L1',location_id:'L1',protocol:'LP1',start_date:'2020-01-01'},{event_id:'L2',cage_sid:'C1',protocol:'DD'},{event_id:'L3',mouse_sid:'M1',protocol:'LD'}];const evidence=locoboxEvidence(d,{cageSid:'C1'});
 assert.equal(evidence.length,2);assert.match(evidence.find(x=>x.record.event_id==='L1').relationship,/unconfirmed/);assert.match(evidence.find(x=>x.record.event_id==='L2').relationship,/Explicit cage/);
 const b=saved({...input(),location_id:'L1'},d);assert.equal(listLocoboxProtocols(b.dataset,{locationId:'L1'}).length,1);assert.equal(listLocoboxProtocols(b.dataset,{cageSid:'missing'}).length,0);
});
test('a sequential cage timeline requires one timezone instead of silently comparing different wall clocks',()=>{
 const d={tables:{cages:[],locations:[],husbandry_events:[]}},p={...blankLocoboxProtocol(),title:'Cross-zone plan',phases:[{...blankLocoboxPhase(),start_date:'2026-10-01',end_date:'2026-10-02',timezone:'Asia/Taipei'},{...blankLocoboxPhase(),start_date:'2026-10-02',timezone:'America/New_York'}]};
 assert.throws(()=>buildLocoboxProtocol(p,d),/one timezone per timeline/);
});
