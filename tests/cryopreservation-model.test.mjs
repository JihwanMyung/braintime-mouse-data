import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCryoActivity,validateCryoRecord,cryoSourceLotId,cryoInventory,cryoLots,cryoActivities} from '../web/cryopreservation-model.js';

const clone=structuredClone;
function fixture() {
  const sourceKey='cryo-source:["CS-TEST",["B1","B2"]]';
  const lot={event_id:cryoSourceLotId(sourceKey),event_type:'cryopreservation_lot',event_date:'2026-10-14',record_origin:'app_created',
    source_case_key:sourceKey,source_reported_quantity:10,source_reported_unit:'straws',source_snapshot_date:'2023-10-19',
    source_snapshots:[{batch_ids:['B1','B2'],reported_remaining:10},{batch_ids:['B1','B2'],reported_remaining:10}],
    cryopreservation:{schema_version:1,case_id:'CS-TEST',label:'Example case',strain:'Example',batch_ids:['B1','B2'],frozen_date:'2022-09-22',
      material:'unknown',status:'unreviewed',manager:null,storage_location:{facility:null,tank:null,canister:null,position:null},donor_mouse_sids:[],
      quantity:null,quantity_unit:'straws',quantity_as_of_date:null,activity_revision:0,last_activity_id:null}};
  const dataset={tables:{mice:[{mouse_sid:'001',sex:'Male'},{mouse_sid:'002',sex:'Unknown'}],husbandry_events:[lot]}};
  return {lot,dataset};
}
function apply(dataset,pair) {
  const next=clone(dataset);next.tables.husbandry_events=next.tables.husbandry_events.filter(r=>r.event_id!==pair.lot.event_id);next.tables.husbandry_events.push(pair.lot,pair.event);return next;
}
function stocktake(base=fixture(),quantity=10,extra={}) {
  const pair=buildCryoActivity(base.lot,{activity_type:'stocktake',event_date:'2026-10-14',quantity,quantity_unit:'straws',...extra},base.dataset);
  return {...pair,dataset:apply(base.dataset,pair)};
}

test('source cases retain combined batch IDs, repeated reported counts and unknown current stock',()=>{
  const {lot,dataset}=fixture(),before=clone(lot);
  assert.deepEqual(validateCryoRecord(lot,dataset).errors,[]);
  assert.deepEqual(cryoInventory(lot),{quantity:null,unit:'straws',asOfDate:null,status:'unreviewed',known:false,reportedQuantity:10,reportedUnit:'straws'});
  assert.deepEqual(lot.cryopreservation.batch_ids,['B1','B2']);assert.deepEqual(lot,before);
  const blank=clone(lot);blank.source_reported_quantity=null;assert.equal(cryoInventory(blank).reportedQuantity,null);
});

test('source identities are deterministic, bounded, and duplicate sources cannot create separate inventory',()=>{
  const {lot,dataset}=fixture();assert.equal(cryoSourceLotId(lot.source_case_key),lot.event_id);
  const other={...clone(lot),event_id:'OTHER'};assert(validateCryoRecord(other,dataset).errors.some(e=>/already has a lot/.test(e)));
  dataset.tables.husbandry_events[0].app_archived_at='2026-10-14T00:00:00Z';assert(validateCryoRecord(other,dataset).errors.some(e=>/already has a lot/.test(e)));
  assert.throws(()=>cryoSourceLotId('x'.repeat(200)),/identifier limit/);
  assert.doesNotThrow(()=>validateCryoRecord({...lot,source_case_key:'x'.repeat(200)},dataset));
});

test('a dated stocktake creates a versioned atomic pair and never rewrites source evidence',()=>{
  const original=fixture(),before=clone(original),result=stocktake(original,8);
  assert.equal(result.lot.cryopreservation.quantity,8);assert.equal(result.lot.cryopreservation.activity_revision,1);
  assert.equal(result.lot.cryopreservation.last_activity_id,result.event.event_id);
  assert.equal(result.event.cryopreservation_event.before.quantity,null);assert.equal(result.event.cryopreservation_event.after.quantity,8);
  assert.deepEqual(result.lot.source_snapshots,original.lot.source_snapshots);assert.deepEqual(original,before);
  assert.deepEqual(validateCryoRecord(result.lot,result.dataset,original.lot).errors,[]);
  assert.deepEqual(validateCryoRecord(result.event,result.dataset).errors,[]);
  assert(validateCryoRecord(result.lot,original.dataset,original.lot).errors.some(e=>/atomically/.test(e)));
  assert(validateCryoRecord(result.event,original.dataset).errors.some(e=>/same transaction/.test(e)));
});

test('usage and deposits calculate exact balances; an unknown opening balance stays unknown',()=>{
  const known=stocktake(fixture(),8),used=buildCryoActivity(known.lot,{activity_type:'use',event_date:'2026-10-15',quantity:3},known.dataset);
  assert.equal(used.lot.cryopreservation.quantity,5);assert.equal(used.lot.cryopreservation.activity_revision,2);
  const deposited=buildCryoActivity(used.lot,{activity_type:'deposit',event_date:'2026-10-16',quantity:2},apply(known.dataset,used));assert.equal(deposited.lot.cryopreservation.quantity,7);
  const base=fixture(),unknown=buildCryoActivity(base.lot,{activity_type:'use',event_date:'2026-10-14',quantity:2},base.dataset);
  assert.equal(unknown.lot.cryopreservation.quantity,null);assert.equal(unknown.lot.cryopreservation.quantity_as_of_date,null);
  assert.equal(unknown.lot.source_reported_quantity,10);
});

test('negative balances, fractional counts, coercible values and implicit unit conversions are rejected',()=>{
  const known=stocktake(fixture(),3);
  for(const q of [4,-1,0,1.5,'2',true,NaN,Infinity])assert.throws(()=>buildCryoActivity(known.lot,{activity_type:'use',event_date:'2026-10-15',quantity:q},known.dataset));
  assert.throws(()=>buildCryoActivity(known.lot,{activity_type:'use',event_date:'2026-10-15',quantity:1,quantity_unit:'vials'},known.dataset),/Units differ/);
  const recounted=buildCryoActivity(known.lot,{activity_type:'stocktake',event_date:'2026-10-15',quantity:2,quantity_unit:'vials'},known.dataset);assert.equal(recounted.lot.cryopreservation.quantity_unit,'vials');
});

test('empty stock is explicit zero and availability status needs a manager and storage',()=>{
  assert.equal(stocktake(fixture(),0,{status:'depleted'}).lot.cryopreservation.quantity,0);
  assert.throws(()=>stocktake(fixture(),5,{status:'depleted'}),/zero balance/);
  assert.throws(()=>stocktake(fixture(),0,{status:'stored'}),/zero current balance/);
  assert.throws(()=>stocktake(fixture(),5,{status:'stored'}),/manager/);
  const stored=stocktake(fixture(),5,{status:'stored',manager:'Example manager',storage_location:{facility:'Facility A',tank:'T1',canister:null,position:null}});
  assert.equal(stored.lot.cryopreservation.status,'stored');
});

test('recovery is an explicit observation, optional consumed quantity, and exact mouse links only',()=>{
  const known=stocktake(fixture(),10);
  const recovery=buildCryoActivity(known.lot,{activity_type:'recovery',event_date:'2026-10-15',quantity:2,recovery_status:'recovered',recovered_mouse_sids:['002']},known.dataset);
  assert.equal(recovery.lot.cryopreservation.quantity,8);assert.deepEqual(recovery.event.cryopreservation_event.recovered_mouse_sids,['002']);assert.equal(known.dataset.tables.mice.length,2);
  const noQuantity=buildCryoActivity(known.lot,{activity_type:'recovery',event_date:'2026-10-15',recovery_status:'attempted'},known.dataset);assert.equal(noQuantity.lot.cryopreservation.quantity,10);
  assert.throws(()=>buildCryoActivity(known.lot,{activity_type:'recovery',event_date:'2026-10-15',recovery_status:'recovered',recovered_mouse_sids:['missing']},known.dataset),/does not exist/);
  assert.throws(()=>buildCryoActivity(known.lot,{activity_type:'recovery',event_date:'2026-10-15',recovered_mouse_sids:['001']},known.dataset),/recorded recovered outcome/);
});

test('activity corrections append new stocktakes; facts, dates and archival cannot rewrite balance',()=>{
  const known=stocktake(),event=clone(known.event);event.notes='Clarified note';assert.deepEqual(validateCryoRecord(event,known.dataset,known.event).errors,[]);
  for(const change of [r=>r.event_date='2026-10-15',r=>r.cryopreservation_event.quantity=9,r=>r.app_archived_at='2026-10-14T00:00:00Z']){const edited=clone(known.event);change(edited);assert(validateCryoRecord(edited,known.dataset,known.event).errors.length);}
  const corrected=buildCryoActivity(known.lot,{activity_type:'stocktake',event_date:'2026-10-15',quantity:9,notes:'Corrected prior count after recount'},known.dataset);
  const next=apply(known.dataset,corrected);assert.equal(cryoActivities(next,known.lot.event_id).length,2);assert.equal(corrected.event.cryopreservation_event.before.quantity,10);assert.equal(corrected.lot.cryopreservation.quantity,9);
});

test('stale drafts and dates before freezing or prior activity are rejected',()=>{
  const base=fixture(),known=stocktake(base);
  assert.throws(()=>buildCryoActivity(base.lot,{activity_type:'use',event_date:'2026-10-15',quantity:1},known.dataset),/lot changed/);
  for(const d of ['2022-09-21','2026-10-13','2026-02-30',null,20261015])assert.throws(()=>buildCryoActivity(known.lot,{activity_type:'note',event_date:d},known.dataset));
});

test('tampered activity math and unmatched revision anchors are rejected independently of builder',()=>{
  const base=fixture(),known=stocktake(base),tampered=clone(known.event);tampered.cryopreservation_event.quantity=9;
  assert(validateCryoRecord(tampered,known.dataset).errors.some(e=>/balances/.test(e)));
  const lot=clone(known.lot);lot.cryopreservation.activity_revision=3;assert(validateCryoRecord(lot,known.dataset,base.lot).errors.length);
});

test('manager/location changes can be recorded with captured before and after storage',()=>{
  const known=stocktake(),move=buildCryoActivity(known.lot,{activity_type:'relocation',event_date:'2026-10-15',storage_location:{facility:'Other site',tank:'T2',canister:'C1',position:'4'},manager:'New manager'},known.dataset);
  assert.equal(move.event.cryopreservation_event.before.storage_location.tank,null);assert.equal(move.event.cryopreservation_event.after.storage_location.tank,'T2');assert.equal(move.lot.cryopreservation.quantity,10);
  assert.throws(()=>buildCryoActivity(known.lot,{activity_type:'relocation',event_date:'2026-10-15'},known.dataset),/changed storage/);
  const managerOnly=buildCryoActivity(known.lot,{activity_type:'relocation',event_date:'2026-10-15',manager:'New manager'},known.dataset);assert.equal(managerOnly.lot.cryopreservation.manager,'New manager');
  for(const [field,value]of [['manager','Undated change'],['storage_location',{facility:'Other'}],['status','closed']]){const undated=clone(known.lot);undated.cryopreservation[field]=value;assert(validateCryoRecord(undated,known.dataset,known.lot).errors.some(e=>/dated activity/.test(e)));}
});

test('source provenance is immutable; archived lot restores do not consume inventory',()=>{
  const base=fixture(),changed=clone(base.lot);changed.source_reported_quantity=0;assert(validateCryoRecord(changed,base.dataset,base.lot).errors.some(e=>/provenance/.test(e)));
  const hidden=clone(base.lot);hidden.app_archived_at='2026-10-14T00:00:00Z';assert(validateCryoRecord(hidden,base.dataset,base.lot).errors.some(e=>/zero balance/.test(e)));
  const depleted=stocktake(fixture(),0,{status:'depleted'}),archived=clone(depleted.lot);archived.app_archived_at='2026-10-14T00:00:00Z';assert.deepEqual(validateCryoRecord(archived,depleted.dataset,depleted.lot).errors,[]);
  const dataset=apply(depleted.dataset,{lot:archived,event:{event_id:'ignore'}});assert.equal(cryoLots(dataset).length,0);assert.equal(cryoLots(dataset,{includeArchived:true}).length,1);
  assert.throws(()=>buildCryoActivity(archived,{activity_type:'note',event_date:'2026-10-15'},dataset),/Restore/);
});

test('malformed payloads fail cleanly while unchanged legacy lot problems remain warnings',()=>{
  const base=fixture();
  for(const value of [null,[],true,{}, {schema_version:2}, {...base.lot.cryopreservation,label:{toString:null}},{...base.lot.cryopreservation,storage_location:{tank:3}},{...base.lot.cryopreservation,quantity:'10'}]){
    const bad={...base.lot,cryopreservation:value};assert.doesNotThrow(()=>validateCryoRecord(bad,base.dataset));assert(validateCryoRecord(bad,base.dataset).errors.length);
  }
  const legacy=clone(base.lot);legacy.cryopreservation.frozen_date='2022-99-01';const note={...clone(legacy),notes:'Unrelated clarification'};
  assert.deepEqual(validateCryoRecord(note,base.dataset,legacy).errors,[]);assert(validateCryoRecord(note,base.dataset,legacy).warnings.length);
  const retyped={...base.lot,event_type:'Observation'};assert(validateCryoRecord(retyped,base.dataset,base.lot).errors.length);
});
