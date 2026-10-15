import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCageHistory,getCageHistoryDates} from '../web/cage-history.js';
import {projectAnimalSheet} from '../web/animal-sheet-export.js';
const today='2026-10-15';
const options={today};
const data=()=>({as_of_local_date:today,tables:{mice:[{mouse_sid:'M1',state:'Stock',cage_sid:'NOW',physical_tag:'CURRENT-TAG',genotype:'P′',ear_mark:'L0R1',manager:'Current user',sex:'Male',date_of_birth:'2020-01-01'},{mouse_sid:'M2',state:'Ended',cage_sid:'OLD',sex:'Female',date_of_birth:'2020-02-01',end_date:'2023-06-01'}],cages:[{cage_sid:'NOW',state:'Active',cage_tag:'Today',location_id:'TODAY'},{cage_sid:'OLD',state:'Inactive',cage_tag:'Renamed later',manager:'Future manager'}],rooms:[{room_id:'R',name:'Renamed now'}],racks:[{rack_id:'K',room_id:'R',name:'Current rack'}],locations:[{location_id:'TODAY',room_id:'R',rack_id:'K',label:'Current position'}],husbandry_events:[],light_events:[]}});
const snapshot=(id,date='2023-01-01',extra={})=>({event_id:id,event_type:'animal_sheet_cage_snapshot',event_date:date,source_cage_snapshot:{schema_version:1,snapshot_date:date,date_basis:'date_in_workbook_title_not_verified_capture',workbook_id:'BOOK-'+date,title:'Animal snapshot',sheet_id:7,sheet_name:'Historical room sheet',source_url:'https://docs.google.com/spreadsheets/d/book/edit#gid=7&range=A5',source_header_cell:'A5',source_range:'A5:F12',cage_label:'L1',body:[{cell:'A6',raw:'P-M999'},{cell:'D4',raw:'Historical user'}],manager_name:'Historical user',...extra}});
const move=(id,date,cage='OLD',extra={})=>({event_id:id,event_type:'cage_assignment',event_date:date,mouse_sid:'M1',cage_sid:cage,...extra});
const location=(id,date,extra={})=>({event_id:id,event_type:'cage_location_assignment',event_date:date,cage_sid:'OLD',cage_tag:'Original cage',room_id:'R',rack_id:'K',location_id:'P',room_label:'Room at the time',rack_label:'Rack at the time',position_label:'A1',...extra});

test('current is the original dataset and history never alters or includes present-day occupants by default',()=>{
 const d=data(),before=structuredClone(d);assert.equal(projectCageHistory(d,'current',options).dataset,d);assert.equal(projectCageHistory(d,null,options).readOnly,false);
 const p=projectCageHistory(d,'2022-01-01',options);assert.equal(p.basis,'unavailable');assert.equal(p.readOnly,true);for(const t of ['mice','cages','locations','rooms','racks'])assert.deepEqual(p.dataset.tables[t],[]);assert.deepEqual(d,before);assert.match(p.warnings.join(' '),/not been projected backward/);
});
test('strict dates reject impossible and future dates',()=>{
 for(const at of ['2026-02-30','2026-10-16','2023-1-1','bad'])assert.throws(()=>projectCageHistory(data(),at,options),/valid historical date/);
 assert.throws(()=>projectCageHistory(data(),'2023-01-01',{today:'bad'}),/current date/);
});
test('nearest earlier snapshot remains source only and retains title-date uncertainty',()=>{
 const d=data();d.tables.husbandry_events=[snapshot('S1'),snapshot('FUTURE','2024-01-01')];const p=projectCageHistory(d,'2023-05-01',options);
 assert.equal(p.snapshotDate,'2023-01-01');assert.equal(p.basis,'source_snapshot');assert.equal(p.dataset.tables.locations.length,1);assert.equal(p.dataset.tables.mice.length,0);assert.equal(p.dataset.tables.cages.length,0);assert.equal(p.dataset.tables.locations[0].source_observed_tags[0],'P-M999');assert.equal(p.dataset.tables.locations[0].source_manager_name,'Historical user');assert.match(p.warnings.join(' '),/Changes between/);assert.match(p.warnings.join(' '),/workbook titles/);assert.equal(p.coverage.completeCensus,false);assert.doesNotMatch(JSON.stringify(p.dataset.tables.locations),/FUTURE/);
});
test('date matches do not claim exact occupancy or a complete census; all empty blocks are preserved',()=>{
 const d=data();d.tables.husbandry_events=[snapshot('S1'),snapshot('S2','2023-01-01',{source_header_cell:'H5',source_range:'H5:M12',cage_label:'L2',body:[],coverage_complete:true})];const p=projectCageHistory(d,'2023-01-01',options);
 assert.equal(p.dataset.tables.locations.length,2);assert.equal(p.dataset.tables.locations[1].source_block_text,'');assert.equal(p.dataset.history_projection.complete_census,false);assert.match(p.warnings.join(' '),/unverified/);assert.doesNotMatch(p.warnings.join(' '),/Nearest earlier/);
});
test('a newer duplicate specialized snapshot replaces a manager-only fallback without assigning candidate SIDs',()=>{
 const d=data();d.tables.husbandry_events=[{event_id:'MAN',event_type:'source_manager_observation',event_date:'2023-01-01',source_evidence:{workbook_id:'BOOK-2023-01-01',snapshot_date:'2023-01-01',sheet_id:7,sheet_name:'Historical room sheet',source_header_cell:'A5'},source_cage_label:'L1',source_body:[{cell:'A6',raw:'WRONG'}],candidate_cage_sid:'NOW',exact_mouse_sids:['M1'],manager:'Fallback'},snapshot('FULL')];const p=projectCageHistory(d,'2023-01-01',options);
 assert.equal(p.dataset.tables.locations.length,1);assert.equal(p.dataset.tables.locations[0].source_event_id,'FULL');assert.equal(p.dataset.tables.mice.length,0);assert.equal(p.dataset.tables.cages.length,0);
});
test('current source positions are eligible only from their capture date, never editable manager/notes backward',()=>{
 const d=data();Object.assign(d.tables.locations[0],{source_snapshot_date:'2026-10-14',source_file_id:'B',source_sheet:'Source',source_cell:'A1',source_label:'L2',source_block_text:'A2: P-M22',manager:'Updated today',notes:'Updated today'});
 assert.equal(projectCageHistory(d,'2026-10-13',options).dataset.tables.locations.length,0);
 const p=projectCageHistory(d,'2026-10-14',options);assert.equal(p.dataset.tables.locations.length,1);assert.equal(p.dataset.tables.locations[0].source_manager_name,null);assert.doesNotMatch(JSON.stringify(p.dataset.tables.locations),/Updated today|Current position|Renamed now/);
});
test('assignment history uses only earlier explicit targets, never future old_cage_sid or present-day cage',()=>{
 const d=data();d.tables.husbandry_events=[move('A','2022-01-01'),move('B','2024-01-01','NOW',{event_type:'cage_move',old_cage_sid:'OLD'})];
 assert.equal(projectCageHistory(d,'2021-12-31',options).dataset.tables.mice.length,0);
 const m=projectCageHistory(d,'2023-01-01',options).dataset.tables.mice[0];assert.equal(m.cage_sid,'OLD');assert.equal(m.state,'Stock');assert.equal(m.physical_tag,null);assert.equal(m.genotype,null);assert.equal(m.ear_mark,null);assert.equal(m.manager,null);assert.equal(m.sex,'Male');assert.equal(m.history_assignment_date,'2022-01-01');
});
test('ended records can appear historically but known birth/end boundaries exclude them',()=>{
 const d=data();d.tables.husbandry_events=[move('M2','2020-01-01','OLD',{mouse_sid:'M2'})];
 assert.equal(projectCageHistory(d,'2020-01-31',options).dataset.tables.mice.length,0);
 assert.equal(projectCageHistory(d,'2021-01-01',options).dataset.tables.mice[0].mouse_sid,'M2');
 assert.equal(projectCageHistory(d,'2023-06-01',options).dataset.tables.mice.length,0);
});
test('same-day contradictory moves remain unknown instead of sorting by UUID or app timestamp',()=>{
 const d=data();d.tables.husbandry_events=[move('Z','2022-01-01','OLD',{app_created_at:'2026-01-01T00:00:00Z'}),move('A','2022-01-01','NOW',{app_created_at:'2026-02-01T00:00:00Z'})];const p=projectCageHistory(d,'2023-01-01',options);assert.equal(p.dataset.tables.mice.length,0);assert.match(p.warnings.join(' '),/contradictory/);
 d.tables.husbandry_events[1].cage_sid='OLD';assert.equal(projectCageHistory(d,'2023-01-01',options).dataset.tables.mice.length,1);
});
test('explicitly unassigned mouse stays unassigned, without falling back to a previous cage',()=>{
 const d=data();d.tables.husbandry_events=[move('A','2022-01-01'),move('B','2022-02-01',null,{event_type:'cage_move',old_cage_sid:'OLD'})];const p=projectCageHistory(d,'2023-01-01',options);assert.equal(p.dataset.tables.mice[0].cage_sid,null);assert.equal(p.dataset.tables.cages.length,0);
});
test('captured old room/rack/position names survive current renames and only dated applicable lights remain',()=>{
 const d=data();d.tables.husbandry_events=[location('LOC','2022-01-01'),move('M','2022-01-01')];d.tables.light_events=[{event_id:'OLD',location_id:'P',start_date:'2021-01-01',end_date:'2023-02-01',protocol:'DD'},{event_id:'FUTURE',location_id:'P',start_date:'2024-01-01',protocol:'LL'},{event_id:'UNKNOWN',location_id:'P',protocol:'LD'}];const p=projectCageHistory(d,'2023-01-01',options);
 assert.equal(p.dataset.tables.rooms[0].name,'Room at the time');assert.equal(p.dataset.tables.racks[0].name,'Rack at the time');assert.equal(p.dataset.tables.locations[0].label,'A1');assert.deepEqual(p.dataset.tables.light_events.map(x=>x.event_id),['OLD']);
 const sheet=projectAnimalSheet(p.dataset,{capturedAt:'2023-01-01T12:00:00+08:00',entityTypes:[]});assert.equal(sheet.counts.mice,1);assert.equal(sheet.rows[0].applicableLights[0].event_id,'OLD');
});
test('missing captured labels use IDs, never present day structure labels',()=>{
 const d=data();d.tables.husbandry_events=[location('L','2022-01-01',{room_label:null,rack_label:null,position_label:null})];const p=projectCageHistory(d,'2023-01-01',options);assert.equal(p.dataset.tables.rooms[0].name,'R');assert.equal(p.dataset.tables.racks[0].name,'K');assert.equal(p.dataset.tables.locations[0].label,'P');assert.equal(p.dataset.tables.cages[0].history_occupancy_unknown,true);
});
test('snapshot sources and managed assignments remain separate rather than matching shared cage labels',()=>{
 const d=data();d.tables.husbandry_events=[snapshot('S','2023-01-01',{cage_label:'Original cage'}),location('L','2022-01-01'),move('M','2022-01-01')];const p=projectCageHistory(d,'2023-03-01',options);assert.equal(p.basis,'snapshot_and_dated_assignments');assert.equal(p.dataset.tables.locations.length,2);assert.equal(p.dataset.tables.mice.length,1);assert.equal(p.dataset.tables.cages.length,1);assert.equal(p.dataset.tables.cages[0].location_id,'P');
});
test('missing records, archived events, invalid dates and unsupported raw historical cell hints never fabricate occupancy',()=>{
 const d=data();d.tables.historical_observations=[{source_snapshot_date:'2020-01-01',raw_text:'Move M1 to cage NOW',cage_sids:['NOW'],mouse_sids:['M1']}];d.tables.husbandry_events=[move('ARCH','2020-01-01','OLD',{app_archived_at:'2026-01-01'}),move('BAD','2020-02-30'),move('MISSING','2020-01-01','OLD',{mouse_sid:'MISSING'})];const p=projectCageHistory(d,'2021-01-01',options);assert.equal(p.dataset.tables.mice.length,0);assert.equal(p.dataset.tables.cages.length,0);assert.match(p.warnings.join(' '),/missing mouse record/);
});
test('available dates are stable unique actual evidence dates, independent of array order',()=>{
 const d=data();d.tables.husbandry_events=[snapshot('S','2023-01-01'),move('M','2022-01-01'),move('M2','2022-01-01'),move('BAD','wrong')];assert.deepEqual(getCageHistoryDates(d),['2022-01-01','2023-01-01']);const before=structuredClone(d);projectCageHistory(d,'2023-05-01',options);assert.deepEqual(d,before);
});


test('financially restricted metadata-only source snapshots do not expose missing details or fabricate occupancy',()=>{
 const d=data();d.source_archive_restricted=true;d.tables.husbandry_events=[{event_id:'S',event_type:'animal_sheet_cage_snapshot',event_date:'2023-01-01'}];const p=projectCageHistory(d,'2024-01-01',options);assert.equal(p.dataset.tables.locations.length,0);assert.equal(p.dataset.tables.mice.length,0);assert.match(p.warnings.join(' '),/withheld by the current data-visibility/);assert.deepEqual(getCageHistoryDates(d),[]);
});

test('a dated off-rack cage remains visible as occupancy-unknown history without making it active',()=>{
 const d=data();d.tables.husbandry_events=[location('REMOVAL','2023-01-01',{room_id:null,rack_id:null,location_id:null,room_label:null,rack_label:null,position_label:null,location_label:null})];
 const h=projectCageHistory(d,'2023-02-01',options),p=projectAnimalSheet(h.dataset,{capturedAt:'2023-02-01T12:00:00+08:00',entityTypes:[]});
 assert.equal(h.dataset.tables.cages[0].state,'History recorded');assert.equal(p.rows.length,1);assert.equal(p.rows[0].mice.length,0);assert.match(p.rows[0].warnings.join(' '),/occupancy.*unknown|unknown.*occupancy/i);
 const current={...h.dataset,history_projection:undefined};assert.equal(projectAnimalSheet(current,{entityTypes:[]}).rows.length,0);
});

const sourcePosition=(day,raw,extra={})=>({location_id:'SOURCE-P1',record_origin:'current_google_sheet_map',source_file_id:'DAILY-BOOK',source_title:'Daily Animal Sheet',source_sheet:'Room source',source_sheet_id:99,source_cell:'A5',source_block_range:'A4:F12',source_label:'A1',source_snapshot_date:day,source_last_seen_at:day+'T02:00:00Z',source_block_text:'A6: '+raw,source_observed_tags:[raw],source_manager_name:'Recorded keeper',source_manager_acronym:'RK',...extra});
const sourceChange=(id,before,after,extra={})=>({event_id:id,event_type:'animal_sheet_source_change',event_date:'2026-10-15',source_file_id:'DAILY-BOOK',source_capture_at:'2026-10-15T02:00:00Z',animal_sheet_change:{schema_version:1,action:'updated',entity_type:'locations',entity_id:'SOURCE-P1',before,after,observation_date:'2026-10-15',effective_date:null,...extra}});

test('daily source changes retain each before/after capture date without using later import or effective dates',()=>{
 const d=data(),old=sourcePosition('2023-01-01','OLD-M1'),next=sourcePosition('2023-02-01','NEXT-F2');d.tables.locations=[next];d.tables.husbandry_events=[sourceChange('CHANGE',old,next,{effective_date:'2020-01-01'})];const original=structuredClone(d);
 assert.deepEqual(getCageHistoryDates(d),['2023-01-01','2023-02-01']);
 const before=projectCageHistory(d,'2023-01-15',options);assert.equal(before.snapshotDate,'2023-01-01');assert.equal(before.dataset.tables.locations.length,1);assert.match(before.dataset.tables.locations[0].source_block_text,/OLD-M1/);assert.doesNotMatch(before.dataset.tables.locations[0].source_block_text,/NEXT-F2/);assert.equal(before.dataset.tables.mice.length,0);assert.equal(before.dataset.tables.cages.length,0);assert.match(before.warnings.join(' '),/partial source observations/);
 const after=projectCageHistory(d,'2023-02-01',options);assert.equal(after.dataset.tables.locations.length,1);assert.match(after.dataset.tables.locations[0].source_block_text,/NEXT-F2/);assert.deepEqual(d,original);
});
test('same capture in daily before/after records and the current location is deduplicated',()=>{
 const d=data(),a=sourcePosition('2023-01-01','P-M1');d.tables.locations=[a];d.tables.husbandry_events=[sourceChange('A',a,a),sourceChange('B',a,a)];const h=projectCageHistory(d,'2023-01-01',options);assert.equal(h.coverage.sourceBlocks,1);assert.equal(h.dataset.tables.locations.length,1);
});
test('same-day captures select actual latest source timestamp and do not carry a manager through an explicitly blank label',()=>{
 const d=data(),early=sourcePosition('2023-01-01','EARLY-M1'),late=sourcePosition('2023-01-01','LATE-F2',{source_last_seen_at:'2023-01-01T08:00:00Z',source_manager_name:null,source_manager_acronym:null});d.tables.husbandry_events=[sourceChange('LATE',early,late),sourceChange('EARLY',null,early)];const h=projectCageHistory(d,'2023-01-01',options);assert.equal(h.dataset.tables.locations.length,1);assert.match(h.dataset.tables.locations[0].source_block_text,/LATE-F2/);assert.equal(h.dataset.tables.locations[0].source_manager_name,null);assert.equal(h.dataset.tables.locations[0].source_capture_at,'2023-01-01T08:00:00Z');
});
test('withdrawals keep their last actual before snapshot and do not invent an empty board at the import date',()=>{
 const d=data(),before=sourcePosition('2023-01-01','P-M1');d.tables.husbandry_events=[sourceChange('WITHDRAW',before,null,{action:'withdrawn'})];const h=projectCageHistory(d,'2023-03-01',options);assert.equal(h.snapshotDate,'2023-01-01');assert.equal(h.dataset.tables.locations.length,1);assert.match(h.warnings.join(' '),/Changes between/);assert.deepEqual(getCageHistoryDates(d),['2023-01-01']);
 d.tables.husbandry_events.push(sourceChange('WITHDRAW-CONFLICT',before,{...before,source_current:false},{action:'conflict',conflict_reason:'large_layout_loss_requires_review'}));assert.deepEqual(getCageHistoryDates(d),['2023-01-01']);
});

test('a withdrawn source grid is excluded now but its captured layout remains in the dated board and export',()=>{
 const d=data(),before=sourcePosition('2023-01-01','P-M1',{source_current:true,row:4,column:1,label:'A1'});
 d.tables.locations=[{...before,source_current:false}];d.tables.cages=[];d.tables.mice=[];
 d.tables.husbandry_events=[sourceChange('WITHDRAW',before,{...before,source_current:false},{action:'withdrawn'})];
 const original=structuredClone(d),current=projectAnimalSheet(projectCageHistory(d,'current',options).dataset,{entityTypes:['locations']});
 assert.equal(current.counts.positions,0);assert.equal(current.rows.length,0);assert.equal(current.sheets.find(s=>s.name==='locations').rows.length,1);
 const history=projectCageHistory(d,'2023-01-01',options),dated=projectAnimalSheet(history.dataset,{capturedAt:'2023-01-01T12:00:00+08:00',entityTypes:['locations']});
 assert.equal(history.readOnly,true);assert.equal(history.dataset.tables.locations[0].source_current,true);assert.equal(dated.counts.positions,1);
 assert.match(dated.rows[0].position.source_block_text,/P-M1/);assert.equal(dated.sheets.find(s=>s.name==='locations').rows.length,2);assert.deepEqual(d,original);
});
test('conflicting incoming observations are labeled unverified without assigning source mouse/cage references',()=>{
 const d=data(),after=sourcePosition('2023-02-01','P-M1',{source_observed_mouse_sids:['M1'],source_observed_cage_sids:['NOW']});d.tables.husbandry_events=[sourceChange('CONFLICT',sourcePosition('2023-01-01','OLD-F2'),after,{action:'conflict',conflict_reason:'app_edited_source_fields'})];const h=projectCageHistory(d,'2023-02-01',options);assert.equal(h.dataset.tables.mice.length,0);assert.equal(h.dataset.tables.cages.length,0);assert.equal(h.dataset.tables.locations[0].source_import_conflict,'app_edited_source_fields');assert.match(h.dataset.tables.locations[0].source_block_text,/Unverified incoming source observation/);assert.match(h.warnings.join(' '),/not applied/);
});
test('source changes with missing dates, mismatched IDs or non-source payloads never use the import date as fallback',()=>{
 for(const altered of [{source_snapshot_date:null},{source_snapshot_date:'2023-02-30'},{location_id:'OTHER'},{source_file_id:'OTHER'},{record_origin:'app_created'}]){const d=data();d.tables.husbandry_events=[sourceChange('INVALID',null,sourcePosition('2023-01-01','P-M1',altered))];assert.deepEqual(getCageHistoryDates(d),[]);assert.equal(projectCageHistory(d,'2026-10-15',options).dataset.tables.locations.length,0);}
 const d=data();d.tables.husbandry_events=[sourceChange('ROOM',null,sourcePosition('2023-01-01','P-M1'),{entity_type:'rooms'})];assert.deepEqual(getCageHistoryDates(d),[]);
});
