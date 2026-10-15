import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOverview } from '../web/overview-summary.js';
import { buildCageSummaryOptions, getCageSummaryOptions } from '../web/cage-summary-options.js';

const asOf='2026-10-14';
const summarize=dataset=>summarizeOverview(dataset,{asOf});
const fixture=()=>({tables:{
  mice:[
    {mouse_sid:'M1',sex:'Male',state:'Stock',cage_sid:'C1'},
    {mouse_sid:'M2',sex:'Female',state:'Stock',cage_sid:'C1'},
    {mouse_sid:'M3',sex:'Female',state:'Ended',cage_sid:'OLD'},
  ],
  matings:[{mating_sid:'B1',state:'Active',set_up_date:'2026-08-01',male_sids:['M1'],female_sids:['M2'],cage_sid:'OLD'}],
  litters:[{litter_sid:'L1',state:'Unweaned',date_of_birth:'2026-10-01'}],
  cages:[{cage_sid:'C1',state:'Active'},{cage_sid:'C2',state:'Active'},{cage_sid:'OLD',state:'Inactive'}],
  rooms:[],racks:[],locations:[],husbandry_events:[],
}});

test('overview uses current cohorts and current participant cages rather than historical references',()=>{
  const data=fixture();
  data.tables.matings.push({mating_sid:'OLD-B',state:'Inactive',male_sids:['M3'],female_sids:['M2']});
  data.tables.litters.push({litter_sid:'OLD-L',state:'Weaned',date_of_birth:'2020-01-01'});
  const result=summarize(data);
  assert.equal(result.livingMice,2);assert.equal(result.activeGroups,1);
  assert.deepEqual(result.breedingCages,{count:1,unknown:false,unresolvedGroups:0});
  assert.deepEqual(result.unweanedLitters,{count:1,unknown:false});
  assert.deepEqual(result.cagesInUse,{count:1,unknown:false});
});

test('cages in use counts current living assignments and flags missing mouse assignments',()=>{
  const data=fixture();
  data.tables.cages.push({cage_sid:'EMPTY',state:'Active'});
  assert.deepEqual(summarize(data).cagesInUse,{count:1,unknown:false});
  data.tables.mice[1].cage_sid=null;
  assert.deepEqual(summarize(data).cagesInUse,{count:1,unknown:true});
  data.tables.mice[0].cage_sid=null;
  assert.deepEqual(summarize(data).cagesInUse,{count:0,unknown:true});
});

test('registered dates and archives do not erase independently observed current mixed-sex housing',()=>{
  const data=fixture();
  for(const [key,value] of [['set_up_date','2026-10-15'],['disbanded_date',asOf],['app_archived_at','2026-10-01']]) {
    const copy=structuredClone(data);copy.tables.matings[0][key]=value;
    const result=summarize(copy);assert.equal(result.activeGroups,1);assert.equal(result.registeredActiveGroups,0);assert.deepEqual(result.breedingCages,{count:1,unknown:false,unresolvedGroups:0});
  }
  data.tables.matings[0].set_up_date=asOf;data.tables.matings[0].disbanded_date='2026-10-15';
  assert.equal(summarize(data).breedingCages.count,1);
});

test('split or missing current members cannot make the historical mating cage current',()=>{
  const data=fixture();data.tables.mice[1].cage_sid='C2';
  assert.deepEqual(summarize(data).breedingCages,{count:0,unknown:true,unresolvedGroups:1});
  data.tables.mice[1].cage_sid=null;
  assert.equal(summarize(data).breedingCages.count,0);
  delete data.tables.matings[0].male_sids;
  assert.equal(summarize(data).breedingCages.unknown,true);
});

test('a confirmed pair still counts when another member location is unresolved',()=>{
  const data=fixture();data.tables.matings[0].female_sids.push('MISSING');
  assert.deepEqual(summarize(data).breedingCages,{count:1,unknown:true,unresolvedGroups:1});
});

test('breeding cages count distinct physical cages across active groups and deduplicate records',()=>{
  const data=fixture();data.tables.matings.push({...structuredClone(data.tables.matings[0]),mating_sid:'B2'},structuredClone(data.tables.matings[0]));
  data.tables.mice.push(structuredClone(data.tables.mice[0]));data.tables.cages.push(structuredClone(data.tables.cages[0]));
  const result=summarize(data);assert.equal(result.activeGroups,1);assert.equal(result.registeredActiveGroups,2);assert.equal(result.breedingCages.count,1);assert.equal(result.breedingCages.unknown,false);
});

test('conflicting duplicates and archived or missing cages remain unresolved',()=>{
  for(const update of [
    data=>data.tables.mice.push({...data.tables.mice[0],cage_sid:'C2'}),
    data=>data.tables.cages.push({...data.tables.cages[0],location_id:'different'}),
    data=>{data.tables.cages[0].app_archived_at='2026-10-01'},
    data=>{data.tables.cages[0].state='Inactive'},
    data=>{data.tables.cages=[]},
  ]) {
    const data=fixture();update(data);assert.deepEqual(summarize(data).breedingCages,{count:0,unknown:true,unresolvedGroups:1});
  }
});

test('ended, archived or incorrectly sexed group members cannot confirm a breeding pair',()=>{
  for(const update of [mouse=>{mouse.state='Ended'},mouse=>{mouse.archived=true},mouse=>{mouse.sex='Male'}]) {
    const data=fixture();update(data.tables.mice[1]);assert.equal(summarize(data).breedingCages.count,0);assert.equal(summarize(data).breedingCages.unknown,true);
  }
});

test('malformed registry dates stay unresolved while independent current cohabitation remains',()=>{
  const data=fixture();data.tables.matings[0].disbanded_date='not a date';
  const result=summarize(data);assert.equal(result.activeGroups,1);assert.equal(result.breedingCages.count,1);assert.equal(result.breedingCages.unknown,true);
});

test('unweaned counts require current state and valid dates, not all historical litter rows',()=>{
  const data=fixture();data.tables.litters=[
    {litter_sid:'CURRENT',state:'Unweaned',date_of_birth:asOf,wean_date:'2026-10-30'},
    {litter_sid:'WEANED',state:'Unweaned',date_of_birth:'2026-10-01',wean_date:asOf},
    {litter_sid:'ENDED',state:'Unweaned',date_of_birth:'2026-10-01',end_date:asOf},
    {litter_sid:'FUTURE',state:'Unweaned',date_of_birth:'2026-10-15'},
    {litter_sid:'ARCHIVED',state:'Unweaned',date_of_birth:'2026-10-01',archived:true},
    {litter_sid:'OLD',state:'Weaned',date_of_birth:'2020-10-01'},
    {litter_sid:'OLD2',state:'Ended',date_of_birth:'2020-10-01'},
  ];
  assert.deepEqual(summarize(data).unweanedLitters,{count:1,unknown:false});
});

test('unknown litter state, malformed birth or conflicting duplicates cannot be presented as certain zero',()=>{
  for(const litter of [{litter_sid:'L2',state:'Unweaned'},{litter_sid:'L2',state:'Unweaned',date_of_birth:'2026-02-30'},{litter_sid:'L2',date_of_birth:'2026-10-01'},{litter_sid:'L1',state:'Weaned',date_of_birth:'2026-10-01'}]) {
    const data=fixture();data.tables.litters.push(litter);assert.equal(summarize(data).unweanedLitters.unknown,true);
  }
});

function locoboxFixture() {
  const data=fixture();
  data.tables.rooms=[{room_id:'BEH',name:'Animal Beh'},{room_id:'RAT',name:'Rat Room'}];
  data.tables.locations=[{location_id:'P1',room_id:'BEH',locobox_id:'BOX1'},{location_id:'P2',room_id:'RAT',locobox_id:'BOX1'},{location_id:'P3',room_id:'BEH',locobox_id:'BOX1'}];
  data.tables.cages[0].location_id='P1';data.tables.cages[1].location_id='P2';
  data.tables.mice.push({mouse_sid:'M4',sex:'Male',state:'Stock',cage_sid:'C2'});
  const options=getCageSummaryOptions(data);
  options.groups.beh={room_ids:['BEH'],capacity:8,locobox_mode:'box_id'};
  options.groups.rat={room_ids:['RAT'],capacity:8,locobox_mode:'box_id'};
  return buildCageSummaryOptions(data,options,{now:'2026-10-14T00:00:00.000Z',eventDate:asOf}).dataset;
}

test('occupied locoboxes combine Beh and Rat with physical-box grouping scoped to room',()=>{
  const data=locoboxFixture();
  data.tables.cages.push({cage_sid:'C3',state:'Active',location_id:'P3'});
  data.tables.mice.push({mouse_sid:'M5',sex:'Female',state:'Stock',cage_sid:'C3'});
  assert.deepEqual(summarize(data).locoboxes,{count:2,unknown:false});
});

test('locobox uncertainty propagates unlinked source positions, missing cages and invalid unit mappings',()=>{
  for(const update of [
    data=>{data.tables.locations[2].evidence_status='source_position_unlinked'},
    data=>{data.tables.mice[0].cage_sid='MISSING'},
    data=>{data.tables.mice[0].cage_sid=null},
    data=>{data.tables.husbandry_events[0].cage_summary_options.groups.beh.locobox_mode='invalid'},
    data=>{data.tables.husbandry_events[0].cage_summary_options.groups.rat.room_ids=['MISSING']},
  ]) {
    const data=locoboxFixture();update(data);assert.equal(summarize(data).locoboxes.unknown,true);
  }
});

test('summary is pure, deterministic and validates its date',()=>{
  const data=fixture(),before=structuredClone(data);assert.deepEqual(summarize(data),summarize(data));assert.deepEqual(data,before);
  assert.equal(summarizeOverview(null,{asOf}).livingMice,0);
  for(const date of ['2026-02-30',null,123])assert.throws(()=>summarizeOverview(data,{asOf:date}),/valid YYYY-MM-DD/);
});


test('overview includes current Animal Sheet box estimates and applies Ani Beh storage exclusions',()=>{
  let data={tables:{rooms:[{room_id:'BEH',name:'Ani Beh'},{room_id:'RAT',name:'Rat room'}],cages:[],mice:[],locations:[{location_id:'B1',room_id:'BEH',record_origin:'current_google_sheet_map',source_current:true,source_snapshot_date:asOf,source_observed_tags:['P-M123']},{location_id:'R1',room_id:'RAT',record_origin:'current_google_sheet_map',source_current:true,source_snapshot_date:asOf,source_observed_tags:['P-F456']}],husbandry_events:[]}};
  assert.equal(summarize(data).locoboxes.count,2);assert.equal(summarize(data).locoboxes.estimated,true);
  const options=getCageSummaryOptions(data);options.groups.beh.temporary_storage_location_ids=['B1'];
  data=buildCageSummaryOptions(data,options,{now:'2026-10-14T00:00:00Z'}).dataset;
  assert.equal(summarize(data).locoboxes.count,1);assert.equal(summarize(data).locoboxes.estimated,true);
  assert.equal(summarizeOverview(data,{asOf:'2026-10-13'}).locoboxes.count,0);
});
