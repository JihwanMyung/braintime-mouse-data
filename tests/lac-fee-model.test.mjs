import test from 'node:test';
import assert from 'node:assert/strict';
import {blankLacFeeOptions,blankLacFeeMonth,feeMonthBounds,buildLacFeeOptions,buildLacFeeMonth,buildLacFeeActualMonthCorrection,calculateLacFeeMonth,compareLacFees,getLacFeeOptions,listLacFeeMonths,validateLacFeeRecord} from '../web/lac-fee-model.js';
const clone=structuredClone;
const base=()=>({tables:{rooms:[{room_id:'C',name:'Mouse clean room'},{room_id:'R',name:'Rat room'},{room_id:'S',name:'SPF'},{room_id:'A',name:'Animal Beh'}],racks:[{rack_id:'RL',room_id:'R'}],locations:[],cages:[{cage_sid:'C1',room_id:'C'},{cage_sid:'R1',room_id:'R',rack_id:'RL'},{cage_sid:'S1',room_id:'S'},{cage_sid:'A1',room_id:'A'}],mice:[...['C1','C1','R1','S1','S1','S1','A1'].map((cage_sid,i)=>({mouse_sid:'M'+i,cage_sid,state:'Stock'})),{mouse_sid:'ENDED',cage_sid:'S1',state:'Ended'}],husbandry_events:[]}});
const options=(date='2024-01-01')=>{const p=blankLacFeeOptions(date);p.excluded_room_ids=['A'];p.groups.forEach((g,i)=>Object.assign(g,{room_ids:[['C','R','S'][i]],rate:[2,3,1][i],rate_reference:'Test rate schedule'}));p.groups[1].rack_ids=['RL'];return p};
const configured=(date)=>buildLacFeeOptions(options(date),base()).dataset;
function monthly(month,amount=232){const p=blankLacFeeMonth(month),bounds=feeMonthBounds(month);p.actual_total=amount;p.actual_date=bounds.end;p.invoice_reference='Synthetic invoice';p.lines.forEach((l,i)=>Object.assign(l,{quantity:[bounds.days,bounds.days,bounds.days*3][i],evidence_start:bounds.start,evidence_end:bounds.end,evidence_reference:'Dated invoice quantity'}));return p}

test('billing month calendar includes leap days and rejects invalid months',()=>{assert.equal(feeMonthBounds('2024-02').days,29);assert.equal(feeMonthBounds('2025-02').days,28);assert.equal(feeMonthBounds('2026-04').days,30);assert.equal(feeMonthBounds('2026-13'),null);assert.equal(feeMonthBounds('2026-2'),null)});

const correctionOptions={now:'2026-10-16T00:00:00.000Z',sourceEventId:'CORRECTED-OCTOBER',targetEventId:'ASSIGNED-SEPTEMBER',reason:'Owner confirmed that this October charge covers September usage.'};
function correctionSource(dataset=configured('2026-10-14'),actual=14041){
 const p=snapshotMonth('2026-10','2026-10-14');p.actual_total=actual;p.actual_date='2026-10-14';p.invoice_reference='Original invoice source';p.notes='Original snapshot note';
 return buildLacFeeMonth(p,dataset,null,{eventId:'ORIGINAL-OCTOBER',sourceRecord:{source_actual_observation:{source_id:'SOURCE-INVOICE',description:'October source label',billing_month:'2026-10'},source_actual_date_basis:'source_review_observation_date',source_snapshot:{snapshot_date:'2026-10-14'},source_billing_month_basis:'explicit_description'}});
}

test('usage-month correction preserves original evidence and moves actuals with two cross-linked immutable records',()=>{
 const built=correctionSource(),before=clone(built.dataset),original=clone(built.record);
 const result=buildLacFeeActualMonthCorrection(built.dataset,built.record,'2026-09',correctionOptions),source=result.sourceRecord,target=result.targetRecord;
 assert.deepEqual(built.dataset,before);assert.deepEqual(built.record,original);
 assert.equal(result.dataset.tables.husbandry_events.length,before.tables.husbandry_events.length+2);
 assert.deepEqual(result.records,[source,target]);
 assert.equal(source.lac_fee_month.month,'2026-10');assert.equal(source.lac_fee_month.revision,1);assert.equal(source.lac_fee_month.supersedes_event_id,original.event_id);
 for(const key of ['actual_total','actual_date','invoice_reference','paid_date'])assert.equal(source.lac_fee_month[key],null);
 assert.equal(source.lac_fee_month.actual_basis,'recorded_charge');assert(source.lac_fee_month.lines.every(line=>line.actual_amount===null));
 assert.deepEqual(source.lac_fee_month.lines,original.lac_fee_month.lines);assert.deepEqual(source.source_snapshot,original.source_snapshot);
 assert.equal(target.lac_fee_month.month,'2026-09');assert.equal(target.event_date,'2026-09-01');assert.equal(target.lac_fee_month.revision,0);
 assert.equal(target.lac_fee_month.actual_total,14041);assert.equal(target.lac_fee_month.actual_date,'2026-10-14');assert.equal(target.lac_fee_month.paid_date,null);
 assert(target.lac_fee_month.lines.every(line=>line.quantity===null&&line.evidence_start===null&&line.evidence_end===null));
 assert.deepEqual(target.source_actual_observation,original.source_actual_observation);assert.equal(target.source_actual_date_basis,'source_review_observation_date');
 for(const record of result.records){assert.equal(record.source_actual_month_correction.actual_source_id,'SOURCE-INVOICE');assert.equal(record.source_actual_month_correction.original_event_id,original.event_id);assert.equal(record.source_actual_month_correction.source_revision_event_id,source.event_id);assert.equal(record.source_actual_month_correction.target_revision_event_id,target.event_id);assert.match(record.lac_fee_month.notes,/Owner-confirmed usage-month correction/);assert.deepEqual(validateLacFeeRecord(record,result.dataset).errors,[]);}
 const october=calculateLacFeeMonth(result.dataset,'2026-10',{nowDate:'2026-10-16'}),september=calculateLacFeeMonth(result.dataset,'2026-09',{nowDate:'2026-10-16'});
 assert.equal(october.estimate,248);assert.equal(october.actual,null);assert.equal(october.comparison.difference,null);
 assert.equal(september.actual,14041);assert.equal(september.estimate,null);assert.equal(september.comparison.difference,null);assert.equal(september.comparison.absolute_percent,null);
});

test('usage-month correction preserves genuine zero and explicitly confirmed payment dates',()=>{
 const built=correctionSource(configured(),0),p=clone(built.record.lac_fee_month);p.actual_basis='confirmed_paid';p.paid_date='2026-10-08';p.lines[0].actual_amount=0;
 const revised=buildLacFeeMonth(p,built.dataset,built.record),before=clone(revised.dataset),result=buildLacFeeActualMonthCorrection(revised.dataset,revised.record,'2026-09',correctionOptions);
 assert.deepEqual(revised.dataset,before);assert.equal(result.targetRecord.lac_fee_month.actual_total,0);assert.equal(result.targetRecord.lac_fee_month.lines[0].actual_amount,0);
 assert.equal(result.targetRecord.lac_fee_month.actual_basis,'confirmed_paid');assert.equal(result.targetRecord.lac_fee_month.paid_date,'2026-10-08');assert.equal(result.sourceRecord.lac_fee_month.paid_date,null);
});

test('target quantities and references survive while transferred group charges are recorded only once',()=>{
 const september=monthly('2026-09',null);september.actual_date=null;september.invoice_reference=null;september.notes='September occupancy evidence';
 const first=buildLacFeeMonth(september,configured()),built=correctionSource(first.dataset),p=clone(built.record.lac_fee_month);
 p.lines[0].actual_amount=10;p.lines[0].evidence_reference='Original first charge';p.lines[1].actual_amount=0;
 p.lines.push({...p.lines[0],actual_amount:5,evidence_reference:'Original second charge'});
 const revised=buildLacFeeMonth(p,built.dataset,built.record),before=clone(first.record),result=buildLacFeeActualMonthCorrection(revised.dataset,revised.record,'2026-09',correctionOptions),target=result.targetRecord.lac_fee_month;
 assert.deepEqual(target.lines.slice(0,before.lac_fee_month.lines.length),before.lac_fee_month.lines);
 assert.equal(target.revision,1);assert.equal(target.supersedes_event_id,before.event_id);
 const charges=target.lines.filter(line=>line.actual_amount!==null);
 assert.deepEqual(charges.map(line=>[line.group_key,line.actual_amount,line.quantity,line.evidence_start,line.evidence_end]),[['clean_room',15,null,null,null],['rat_locobox',0,null,null,null]]);
 assert.match(charges[0].evidence_reference,/Original first charge\nOriginal second charge/);
 const resultMonth=calculateLacFeeMonth(result.dataset,'2026-09',{nowDate:'2026-10-16'});
 assert.equal(resultMonth.estimate,240);assert.equal(resultMonth.groups[0].actual,15);assert.equal(resultMonth.groups[1].actual,0);
 assert.equal(resultMonth.comparison.difference,240-14041);
});

test('usage-month correction refuses existing actuals including zero, currency conflicts and ambiguous target revisions',()=>{
 for(const field of ['total','group']){
  const p=blankLacFeeMonth('2026-09');p.actual_date='2026-10-01';p.invoice_reference='Existing';if(field==='total')p.actual_total=0;else p.lines[0].actual_amount=0;
  const built=correctionSource(buildLacFeeMonth(p,configured()).dataset),before=clone(built.dataset);
  assert.throws(()=>buildLacFeeActualMonthCorrection(built.dataset,built.record,'2026-09',correctionOptions),/already has an actual amount/);assert.deepEqual(built.dataset,before);
 }
 const foreign=blankLacFeeMonth('2026-09');foreign.currency='USD';let built=correctionSource(buildLacFeeMonth(foreign,configured()).dataset);
 assert.throws(()=>buildLacFeeActualMonthCorrection(built.dataset,built.record,'2026-09',correctionOptions),/different currency/);
 const empty=buildLacFeeMonth(blankLacFeeMonth('2026-09'),configured());empty.dataset.tables.husbandry_events.push({...clone(empty.record),event_id:'DUPLICATE-SEPTEMBER'});built=correctionSource(empty.dataset);
 assert.throws(()=>buildLacFeeActualMonthCorrection(built.dataset,built.record,'2026-09',correctionOptions),/Conflicting monthly/);
});

test('usage-month correction rejects stale sources, repeated or same-month moves and incomplete amounts',()=>{
 const built=correctionSource(),before=clone(built.dataset);
 for(const month of ['2026-10','2026-13',null])assert.throws(()=>buildLacFeeActualMonthCorrection(built.dataset,built.record,month,correctionOptions),/different valid usage month/);
 const changed=clone(built.record);changed.lac_fee_month.actual_total=99;
 assert.throws(()=>buildLacFeeActualMonthCorrection(built.dataset,changed,'2026-09',correctionOptions),/records changed/);
 const result=buildLacFeeActualMonthCorrection(built.dataset,built.record,'2026-09',correctionOptions);
 assert.throws(()=>buildLacFeeActualMonthCorrection(result.dataset,built.record,'2026-08'),/newer monthly fee revision/);
 assert.throws(()=>buildLacFeeActualMonthCorrection(result.dataset,result.sourceRecord,'2026-08'),/no actual amount/);
 assert.throws(()=>buildLacFeeActualMonthCorrection(built.dataset,built.record,'2026-09',{...correctionOptions,targetEventId:built.record.event_id}),/distinct and new/);
 assert.deepEqual(built.dataset,before);
});

test('second-record validation failure leaves the entire original workspace unchanged',()=>{
 const target=blankLacFeeMonth('2026-09');target.notes='x'.repeat(10000);
 const built=correctionSource(buildLacFeeMonth(target,configured()).dataset),before=clone(built.dataset);
 assert.throws(()=>buildLacFeeActualMonthCorrection(built.dataset,built.record,'2026-09',correctionOptions),/notes must be text/);
 assert.deepEqual(built.dataset,before);assert(!built.dataset.tables.husbandry_events.some(record=>record.event_id===correctionOptions.sourceEventId));
});

test('current projection counts occupied cages for clean and rat rooms, mice for SPF, and excludes Ani Beh',()=>{const d=configured(),before=clone(d),r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2024-02-10'});assert.equal(r.basis,'current_snapshot_projection');assert.deepEqual(r.groups.map(g=>g.quantity),[29,29,87]);assert.deepEqual(r.groups.map(g=>g.charge),[58,87,87]);assert.equal(r.estimate,232);assert.equal(r.excluded_mice,1);assert.equal(r.actual,null);assert.equal(r.comparison.status,'unknown');assert.equal(r.groups[0].actual,null);assert.deepEqual(d,before)});

test('monthly rates use monthly counts rather than multiplying by calendar days',()=>{const p=options();p.groups.forEach(g=>g.rate_period='month');const d=buildLacFeeOptions(p,base()).dataset,r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2024-02-10'});assert.deepEqual(r.groups.map(g=>g.quantity),[1,1,3]);assert.equal(r.estimate,8)});

test('rates and exact mappings are never inferred from room labels; unknowns do not become zero',()=>{const p=blankLacFeeOptions('2024-01-01'),d=buildLacFeeOptions(p,base()).dataset,r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2024-02-10'});assert.equal(r.estimate,null);assert(r.groups.every(g=>g.quantity===null&&g.charge===null));assert(r.warnings.some(w=>/Ani Beh/.test(w)));const known=options();known.groups[0].rate=null;const missing=calculateLacFeeMonth(buildLacFeeOptions(known,base()).dataset,'2024-02',{nowDate:'2024-02-10'});assert.equal(missing.estimate,null);assert.equal(missing.groups[0].rate,null);assert.equal(missing.partial_estimate,174)});

test('current occupancy is never projected into a historical month without dated evidence',()=>{const d=configured(),r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2026-10-14'});assert.equal(r.basis,'historical_evidence');assert.equal(r.estimate,null);assert(r.groups.every(g=>g.quantity===null));const saved=buildLacFeeMonth(monthly('2024-02'),d).dataset,h=calculateLacFeeMonth(saved,'2024-02',{nowDate:'2026-10-14'});assert.equal(h.estimate,232);assert.equal(h.comparison.status,'within_target');assert.equal(h.actual,232)});

test('actual comparisons report signed difference and use actual as denominator at 5% and 10% boundaries',()=>{assert.deepEqual(compareLacFees(105,100),{difference:5,absolute_percent:5,status:'within_target'});assert.equal(compareLacFees(110,100).status,'within_maximum');assert.equal(compareLacFees(110.01,100).status,'above_maximum');const lower=compareLacFees(94,100);assert.equal(lower.difference,-6);assert.equal(lower.absolute_percent,6);assert.equal(compareLacFees(1,0).status,'zero_actual_mismatch');assert.equal(compareLacFees(1,0).absolute_percent,null);assert.equal(compareLacFees(0,0).absolute_percent,0);assert.equal(compareLacFees(null,100).status,'unknown')});

test('historical evidence gaps, overlaps and incompatible units leave the estimate unknown',()=>{const d=configured(),p=monthly('2024-02');p.lines[0].evidence_end='2024-02-15';const partial=calculateLacFeeMonth(buildLacFeeMonth(p,d).dataset,'2024-02',{nowDate:'2026-10-14'});assert.equal(partial.estimate,null);assert.match(partial.groups[0].reason,/full billing month/);const overlap=monthly('2024-02');overlap.lines.push(clone(overlap.lines[0]));assert.equal(calculateLacFeeMonth(buildLacFeeMonth(overlap,d).dataset,'2024-02',{nowDate:'2026-10-14'}).estimate,null);const mismatch=monthly('2024-02');mismatch.lines[0].quantity_unit='cage_month';assert.match(calculateLacFeeMonth(buildLacFeeMonth(mismatch,d).dataset,'2024-02',{nowDate:'2026-10-14'}).groups[0].reason,/differs/)});

test('adjacent dated occupancy totals may be summed without extrapolating missing days',()=>{const p=monthly('2024-02');p.lines[0]={...p.lines[0],quantity:15,evidence_kind:'dated_occupancy',evidence_end:'2024-02-15'};p.lines.push({...p.lines[0],quantity:14,evidence_start:'2024-02-16',evidence_end:'2024-02-29'});const r=calculateLacFeeMonth(buildLacFeeMonth(p,configured()).dataset,'2024-02',{nowDate:'2026-10-14'});assert.equal(r.estimate,232)});

test('options are effective-dated and rate changes within a historical month require review',()=>{let d=configured('2024-02-01');assert.equal(getLacFeeOptions(d,'2024-01-31'),null);const changed=options('2024-02-15');changed.groups[0].rate=5;d=buildLacFeeOptions(changed,d).dataset;d=buildLacFeeMonth(monthly('2024-02'),d).dataset;const r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2026-10-14'});assert.equal(r.estimate,null);assert(r.warnings.some(w=>/changed during/.test(w)))});

test('fee revisions append and preserve source provenance; stale and in-place edits are rejected',()=>{const first=buildLacFeeMonth(monthly('2024-02'),configured(),null,{sourceRecord:{source_invoice:'SOURCE',source_rows:[4]}}),before=clone(first.dataset),second=buildLacFeeMonth({...first.record.lac_fee_month,actual_total:250},first.dataset,first.record);assert.deepEqual(first.dataset,before);assert.equal(second.record.source_invoice,'SOURCE');assert.equal(second.record.lac_fee_month.revision,1);assert.equal(second.record.lac_fee_month.supersedes_event_id,first.record.event_id);assert.equal(listLacFeeMonths(second.dataset)[0].event_id,second.record.event_id);assert.equal(second.dataset.tables.husbandry_events.filter(r=>r.lac_fee_month).length,2);assert.throws(()=>buildLacFeeMonth(monthly('2024-02'),second.dataset,first.record),/newer/);const altered=clone(first.record);altered.lac_fee_month.actual_total=999;assert(validateLacFeeRecord(altered,first.dataset,first.record).errors.some(e=>/immutable/.test(e)))});

test('invalid unit assignments, exclusions, unsupported historical claims and tolerances fail validation',()=>{let p=options();p.groups[2].unit='cage';assert.throws(()=>buildLacFeeOptions(p,base()),/SPF fees use mice/);p=options();p.excluded_room_ids.push('C');assert.throws(()=>buildLacFeeOptions(p,base()),/exclusions/);p=options();p.maximum_percent=11;assert.throws(()=>buildLacFeeOptions(p,base()),/at most 10/);p=options();p.target_percent=9;p.maximum_percent=5;assert.throws(()=>buildLacFeeOptions(p,base()),/target/);const m=monthly('2024-02');m.lines[0].evidence_reference=null;assert.throws(()=>buildLacFeeMonth(m,configured()),/source reference/);m.lines[0].quantity_unit='mouse_day';assert.throws(()=>buildLacFeeMonth(m,configured()),/units/);assert.throws(()=>buildLacFeeMonth({month:null,actual_total:10},configured()),/billing month/)});

function snapshotMonth(month,date){const p=monthly(month);p.lines.forEach((l,i)=>Object.assign(l,{evidence_kind:'snapshot_projection',snapshot_count:[1,1,3][i],evidence_start:date,evidence_end:date,evidence_reference:'Dated Animal Sheet snapshot'}));return p}
test('historical snapshots retain their evidence and actual charges without estimating full-month usage',()=>{
 const d=buildLacFeeMonth(snapshotMonth('2024-02','2024-02-20'),configured()).dataset,before=clone(d),r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2026-10-14'});
 assert.equal(r.basis,'snapshot_projection');assert.equal(r.estimate,null);assert.equal(r.partial_estimate,0);assert.equal(r.actual,232);assert.equal(r.comparison.status,'unknown');assert.equal(r.comparison.absolute_percent,null);
 assert(r.groups.every(g=>g.charge===null&&g.quantity===null&&/full billing month/.test(g.reason)));assert(r.groups.every(g=>g.snapshot_date==='2024-02-20'));assert.deepEqual(d,before);
 const current=calculateLacFeeMonth(d,'2024-02',{nowDate:'2024-02-20'});assert.equal(current.estimate,232);
 assert.equal(calculateLacFeeMonth(d,'2024-02',{nowDate:'2024-03-01'}).estimate,null,'the same snapshot expires as a monthly forecast when the month ends');
});
test('current snapshot forecasts may use a rate documented on their snapshot date without backdating the rate',()=>{const d=buildLacFeeMonth(snapshotMonth('2024-02','2024-02-20'),configured('2024-02-20')).dataset,r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2024-02-20'});assert.equal(r.estimate,232);assert(r.groups.every(g=>g.rate_effective_from==='2024-02-20'));assert.equal(getLacFeeOptions(d,'2024-02-01'),null);const old=snapshotMonth('2024-02','2024-02-19'),missing=calculateLacFeeMonth(buildLacFeeMonth(old,configured('2024-02-20')).dataset,'2024-02',{nowDate:'2024-02-20'});assert.equal(missing.estimate,null)});
test('snapshot dates and count-to-unit arithmetic are checked; a different month never supplies a snapshot',()=>{let p=snapshotMonth('2024-02','2024-02-20');p.lines[0].quantity=28;assert.throws(()=>buildLacFeeMonth(p,configured()),/times calendar month days/);p=snapshotMonth('2024-02','2024-02-20');p.lines[0].evidence_end='2024-02-21';assert.throws(()=>buildLacFeeMonth(p,configured()),/one exact observation date/);p=snapshotMonth('2024-02','2024-01-20');assert.throws(()=>buildLacFeeMonth(p,configured()),/within their billing month/);p=snapshotMonth('2024-02','2024-02-20');p.lines[0].snapshot_count=1.5;assert.throws(()=>buildLacFeeMonth(p,configured()),/whole cages or mice/)});
test('multiple snapshots and mixed snapshots/intervals remain ambiguous instead of being summed',()=>{for(const kind of ['snapshot_projection','dated_occupancy']){const p=snapshotMonth('2024-02','2024-02-20');p.lines.push({...p.lines[0],evidence_kind:kind});const r=calculateLacFeeMonth(buildLacFeeMonth(p,configured()).dataset,'2024-02',{nowDate:'2026-10-14'});assert.equal(r.estimate,null);assert.match(r.groups[0].reason,/mixing snapshots and occupancy intervals is ambiguous/)}});

test('source formula placeholders remain provisional and explicitly ambiguous quantities never become estimated usage',()=>{const p=snapshotMonth('2024-02','2024-02-20');p.lines[2].quantity_basis='source_formula';p.lines[2].quantity_note='SPF range includes placeholder labels';let d=buildLacFeeMonth(p,configured()).dataset,r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2024-02-20'});assert.equal(r.estimate,232);assert.match(r.groups[2].reason,/not independently confirmed/);assert.equal(r.groups[2].quantity_note,p.lines[2].quantity_note);p.lines[2].quantity_basis='ambiguous';d=buildLacFeeMonth(p,configured()).dataset;r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2024-02-20'});assert.equal(r.estimate,null);assert.equal(r.groups[2].quantity,null);assert.equal(r.comparison.status,'unknown');assert.equal(d.tables.husbandry_events.at(-1).lac_fee_month.lines[2].quantity,87)});
test('an unknown current-month source snapshot never falls back to projecting current inventory',()=>{const p=blankLacFeeMonth('2024-02');p.lines.forEach(l=>Object.assign(l,{evidence_kind:'snapshot_projection',quantity_basis:'ambiguous',quantity_note:'Source row count needs review'}));const r=calculateLacFeeMonth(buildLacFeeMonth(p,configured()).dataset,'2024-02',{nowDate:'2024-02-20'});assert.notEqual(r.basis,'current_snapshot_projection');assert.equal(r.estimate,null);assert(r.groups.every(g=>g.quantity===null))});

test('snapshot-only observed rates never carry forward into later snapshots or calendar months',()=>{const p=options('2024-02-20');p.rate_scope='snapshot_only';const d=buildLacFeeOptions(p,base()).dataset;assert(getLacFeeOptions(d,'2024-02-20'));assert.equal(getLacFeeOptions(d,'2024-02-21'),null);assert.equal(getLacFeeOptions(d,'2024-03-01'),null);const good=buildLacFeeMonth(snapshotMonth('2024-02','2024-02-20'),d).dataset;assert.equal(calculateLacFeeMonth(good,'2024-02',{nowDate:'2024-02-21'}).estimate,232);const later=buildLacFeeMonth(snapshotMonth('2024-02','2024-02-21'),d).dataset;assert.equal(calculateLacFeeMonth(later,'2024-02',{nowDate:'2024-02-21'}).estimate,null)});

test('confirmed payments require an explicit paid date while legacy actuals remain recorded charges',()=>{
 const p=blankLacFeeMonth('2026-10');p.actual_total=100;p.actual_date='2026-10-15';p.invoice_reference='Synthetic invoice';delete p.actual_basis;let d=buildLacFeeMonth(p,base()).dataset;assert.equal(calculateLacFeeMonth(d,'2026-10',{nowDate:'2026-10-15'}).actual_basis,'recorded_charge');p.actual_basis='confirmed_paid';assert.throws(()=>buildLacFeeMonth(p,base()),/payment date/);p.paid_date='2026-02-30';assert.throws(()=>buildLacFeeMonth(p,base()),/payment date/);p.paid_date='2026-10-15';d=buildLacFeeMonth(p,base()).dataset;assert.equal(calculateLacFeeMonth(d,'2026-10',{nowDate:'2026-10-15'}).actual_basis,'confirmed_paid');p.actual_basis='recorded_charge';assert.throws(()=>buildLacFeeMonth(p,base()),/requires confirmed paid/);
});


test('historical formula-only quantities and snapshot-only rates cannot establish monthly charges',()=>{
 const p=monthly('2024-02');p.lines[0].quantity_basis='source_formula';
 const r=calculateLacFeeMonth(buildLacFeeMonth(p,configured()).dataset,'2024-02',{nowDate:'2026-10-15'});
 assert.equal(r.estimate,null);assert.equal(r.groups[0].charge,null);assert.match(r.groups[0].reason,/Source-formula quantities need review/);assert.equal(r.actual,232);assert.equal(r.comparison.absolute_percent,null);
 const rate=options('2024-02-01');rate.rate_scope='snapshot_only';
 const d=buildLacFeeMonth(monthly('2024-02'),buildLacFeeOptions(rate,base()).dataset).dataset;
 const snapshotRate=calculateLacFeeMonth(d,'2024-02',{nowDate:'2026-10-15'});
 assert.equal(snapshotRate.estimate,null);assert(snapshotRate.groups.every(g=>g.charge===null&&/snapshot-only rate/.test(g.reason)));
});

test('future observations and missing evidence types cannot authorize a fee estimate',()=>{
 const future=buildLacFeeMonth(snapshotMonth('2024-02','2024-02-20'),configured()).dataset;
 assert.equal(calculateLacFeeMonth(future,'2024-02',{nowDate:'2024-02-19'}).estimate,null);
 const d=buildLacFeeMonth(monthly('2024-02'),configured()).dataset;
 delete d.tables.husbandry_events.at(-1).lac_fee_month.lines[0].evidence_kind;
 const r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2026-10-15'});
 assert.equal(r.estimate,null);assert.match(r.groups[0].reason,/evidence type/);
});


test('conflicting applicable rates and unsupported quantity certainty leave historical fees unavailable',()=>{
 let d=configured();const duplicate=clone(d.tables.husbandry_events[0]);duplicate.event_id+='-duplicate';duplicate.lac_fee_options.groups[0].rate=99;d.tables.husbandry_events.push(duplicate);
 d=buildLacFeeMonth(monthly('2024-02'),d).dataset;
 let r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2026-10-15'});
 assert.equal(r.estimate,null);assert(r.groups.every(g=>g.charge===null));assert(r.warnings.some(w=>/Conflicting billing rates/.test(w)));assert.equal(r.actual,232);
 const d2=buildLacFeeMonth(monthly('2024-02'),configured()).dataset;d2.tables.husbandry_events.at(-1).lac_fee_month.lines[0].quantity_basis='unreviewed';
 r=calculateLacFeeMonth(d2,'2024-02',{nowDate:'2026-10-15'});assert.equal(r.estimate,null);assert.equal(r.groups[0].charge,null);assert.match(r.groups[0].reason,/certainty is unsupported/);
});


test('conflicting monthly records never contribute arbitrary group charges or partial totals',()=>{
 const d=buildLacFeeMonth(monthly('2024-02'),configured()).dataset,duplicate=clone(d.tables.husbandry_events.at(-1));duplicate.event_id+='-duplicate';duplicate.lac_fee_month.lines[0].quantity=999;d.tables.husbandry_events.push(duplicate);
 const r=calculateLacFeeMonth(d,'2024-02',{nowDate:'2026-10-15'});
 assert.equal(r.estimate,null);assert.equal(r.partial_estimate,0);assert(r.groups.every(g=>g.charge===null));assert.equal(r.comparison.status,'unknown');
});
