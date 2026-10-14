import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRecords,projectionRequests,MANAGED_TABS,scheduleApplies} from '../supabase/functions/sync-animal-sheet/projection.mjs';
const record=(entity_type,payload,archived=false)=>({entity_type,payload,archived});
test('projection separates current occupancy, uncertain protocols and reference sheets',()=>{
 const grids=projectRecords([
  record('mice',{mouse_sid:'001',state:'Stock',physical_tag:'=HYPERLINK("bad")',ear_mark:'L0R1',cage_sid:'C1',dam_sids:['2','3']}),
  record('mice',{mouse_sid:'002',state:'Ended',cage_sid:'C1'}),
  record('mice',{mouse_sid:'003',state:'Stock',cage_sid:'C1'},true),
  record('cages',{cage_sid:'C1',state:'Active',location_id:'P1'}),
  record('rooms',{room_id:'R1',name:'Behaviour'}),record('racks',{rack_id:'RK1',name:'Left'}),
  record('locations',{location_id:'P1',room_id:'R1',rack_id:'RK1',label:'L7'}),
  record('light_events',{event_id:'E1',protocol:'T23',cycle_hours:23,evidence_status:'source observation',source_file:'History.xlsx'}),
 ],'2026-10-14T00:00:00Z');
 assert.equal(grids[1].length,2);assert.equal(grids[1][1][0],'001');
 assert.deepEqual(['Room','Rack','Position'].map(name=>grids[1][1][grids[1][0].indexOf(name)]),['Behaviour','Left','L7']);
 assert.equal(grids[1][1][grids[1][0].indexOf('Ear marking')],'L0R1');
 assert.equal(grids[2][1][7],1);assert.equal(grids[3][1][4],undefined);
 assert.equal(grids[3][1][7],23);
 const requests=projectionRequests(grids,[]);
 assert.equal(requests.filter(r=>r.addSheet).length,5);
 const animal=requests.find(r=>r.updateCells?.range.sheetId===MANAGED_TABS[1].id);
 assert.deepEqual(animal.updateCells.rows[1].values[1],{userEnteredValue:{stringValue:'=HYPERLINK("bad")'}});
 assert.ok(requests.every(r=>!r.deleteSheet));
 assert.equal(animal.updateCells.fields,'userEnteredValue');
});
test('physical map keeps unlinked positions and candidate notes without creating cage or animal links',()=>{
 const records=[record('rooms',{room_id:'R1',name:'Room'}),record('racks',{rack_id:'K1',room_id:'R1',name:'Left'}),
  record('locations',{location_id:'P1',room_id:'R1',rack_id:'K1',label:'L1',source_observed_tags:['0009'],source_candidate_mouse_sids:['009'],source_candidate_cage_sids:['C9'],source_block_text:'=literal source note',evidence_status:'source_position_unlinked'}),
  record('locations',{location_id:'P2',room_id:'R1',rack_id:'K1',label:'L2'}),record('cages',{cage_sid:'C9',location_id:'P2',cage_tag:'0009'}),record('mice',{mouse_sid:'009',state:'Stock',cage_sid:'C9'})];
 const grids=projectRecords(records,'2026-10-13T23:00:00Z'),map=grids[4];assert.equal(map.length,3);
 const unlinked=map.find(r=>r[3]==='P1'),linked=map.find(r=>r[3]==='P2');
 assert.deepEqual(unlinked[6],[]);assert.deepEqual(unlinked[8],[]);assert.deepEqual(unlinked[10],['009']);assert.equal(unlinked[11],'0009');assert.deepEqual(unlinked[13],['C9']);
 assert.deepEqual(linked[6],['C9']);assert.deepEqual(linked[8],['009']);
 const req=projectionRequests(grids,[]).find(r=>r.updateCells?.range.sheetId===MANAGED_TABS[4].id).updateCells;
 assert.equal(req.range.endRowIndex,req.rows.length);assert(req.rows.every(r=>r.values.length===req.range.endColumnIndex));assert.equal(req.rows[1].values[17].userEnteredValue.stringValue,'=literal source note');
});
test('map lighting uses local dates, explicit interval boundaries and preserves concurrent uncertainty',()=>{
 const now='2026-10-13T23:00:00Z',common={room_id:'R1',location_id:'P1',timezone:'Asia/Taipei',actual_exposure_verified:false};
 const lights=[{event_id:'current',start_date:'2026-10-14',protocol:'LD',intensity_lux:0,evidence_status:'recorded_schedule_unverified'},
  {event_id:'planned',start_date:'2026-10-14',protocol:'DD',evidence_status:'planned_schedule_unverified'},
  {event_id:'future',start_date:'2026-10-15',protocol:'LL'},
  {event_id:'old',start_date:'2026-10-01',end_date:'2026-10-14',interval_semantics:'end boundary is next phase start',protocol:'T23'},
  {event_id:'expired',start_date:'2026-10-01',end_date:'2026-10-13',protocol:'T22'},
  {event_id:'unknown',start_date:null,protocol:'Room clock',lights_on:'07:00'}].map(e=>record('light_events',{...common,...e}));
 const grid=projectRecords([record('locations',{location_id:'P1',room_id:'R1',label:'L1'}),...lights],now)[4];
 assert(grid[0][15].includes('2026-10-14'));const row=grid[1];
 assert(row[15].includes('current:'));assert(row[15].includes('planned:'));assert(row[15].includes('intensity 0 lux'));assert(row[15].includes('actual exposure: unverified'));assert(row[15].includes('planned_schedule_unverified'));
 for(const id of ['future','old','expired','unknown'])assert(!row[15].includes(`${id}:`));assert(row[16].includes('unknown:'));
 assert.equal(scheduleApplies({...common,start_date:'2026-10-01',end_date:'2026-10-14'},now),true);
 assert.equal(scheduleApplies({...common,start_date:'invalid'},now),false);
});
test('existing copied source tabs are never addressed; ID/title collisions stop',()=>{
 const grids=projectRecords([],'now');
 const original={properties:{sheetId:1717598677,title:' ',gridProperties:{rowCount:105,columnCount:119}}};
 const requests=projectionRequests(grids,[original]);
 assert.ok(!JSON.stringify(requests).includes('1717598677'));
 assert.throws(()=>projectionRequests(grids,[{properties:{sheetId:MANAGED_TABS[0].id,title:'Important source'}}]),/unexpected/);
 assert.throws(()=>projectionRequests(grids,[{properties:{sheetId:123,title:MANAGED_TABS[0].title}}]),/unexpected/);
});
