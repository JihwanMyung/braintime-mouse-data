import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCE_SHEETS,parseAnimalSheetWorkbook as parseSource,sourceHash,a1} from '../supabase/functions/import-animal-sheet/source.mjs';
const ANIMAL_SOURCE_ID='SYNTHETIC_ANIMAL_SOURCE_0000000000000001';
const parseAnimalSheetWorkbook=(workbook,options)=>parseSource(workbook,{expectedSourceId:ANIMAL_SOURCE_ID,...options});
const capturedAt='2026-10-15T02:00:00Z';
function workbook(){const sheets=SOURCE_SHEETS.map(d=>({properties:{sheetId:d.sheetId,title:d.kind,gridProperties:{rowCount:80,columnCount:40}},merges:[],data:[{rowData:[]}]}));return {spreadsheetId:ANIMAL_SOURCE_ID,properties:{title:'Synthetic Animal Sheet',timeZone:'Asia/Taipei'},sheets}}
function put(s,row,col,value,extra={}){const rows=s.data[0].rowData;while(rows.length<row)rows.push({values:[]});const values=rows[row-1].values;while(values.length<col)values.push({});values[col-1]={effectiveValue:{[typeof value==='number'?'numberValue':'stringValue']:value},...extra}}
function slot(s,row,col,label){put(s,row,col,label);s.merges.push({sheetId:s.properties.sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:col-1,endColumnIndex:col+4})}
function fixture(){const w=workbook();for(let i=0;i<3;i++)slot(w.sheets[0],7,2+i*6,'L'+(i+1));slot(w.sheets[1],7,2,'CAL-E1');slot(w.sheets[1],60,2,'B1');slot(w.sheets[2],7,2,'SPF-E1');return w}

test('known source layouts generate deterministic IDs and source observations without mouse/cage writes',async()=>{const w=fixture(),before=structuredClone(w);put(w.sheets[0],8,2,'TAG-1');put(w.sheets[0],9,2,'Mouse SID 3');put(w.sheets[0],10,2,'Mouse SID 999');put(w.sheets[0],11,3,'TAG-2');const d={tables:{mice:[{mouse_sid:'1',physical_tag:'TAG-1'},{mouse_sid:'2',physical_tag:'TAG-1'},{mouse_sid:'3',physical_tag:'TAG-2'}]}};const result=await parseAnimalSheetWorkbook(w,{capturedAt,dataset:d}),location=result.records.find(r=>r.entity_type==='locations'&&r.payload.source_cell==='B7'&&r.payload.source_sheet_id===SOURCE_SHEETS[0].sheetId);assert.equal(result.records.filter(r=>r.entity_type==='rooms').length,4);assert.equal(location.entity_id,'loc_'+(await sourceHash(ANIMAL_SOURCE_ID+'|1717598677|B7')).slice(0,20));assert.deepEqual(location.payload.source_candidate_mouse_sids,['1','2']);assert.deepEqual(location.payload.source_observed_mouse_sids,['3']);assert.deepEqual(location.payload.source_unresolved_explicit_mouse_sids,['999']);assert.deepEqual(location.payload.source_observed_cage_sids,[]);assert.equal(location.payload.source_current,true);assert.equal(location.payload.source_last_seen_at,capturedAt.replace('Z','.000Z'));assert(result.records.every(r=>!['mice','cages'].includes(r.entity_type)));assert.equal(d.tables.mice[0].mouse_sid,'1');assert.deepEqual(w.sheets[0].merges,before.sheets[0].merges)});
test('dated light schedule stays literal, blank protocols do not carry forward and next boundary is exclusive',async()=>{const w=fixture(),s=w.sheets[0];for(let i=0;i<3;i++)put(s,20,3+i,'L'+(i+1));put(s,20,6,'T(h)');put(s,20,7,'On');put(s,21,2,'2026-10-01');put(s,21,3,'T22');put(s,21,6,22);put(s,21,7,'07:10');put(s,22,2,'2026-10-02');put(s,23,2,'2026-10-20');put(s,23,3,'DD');const r=await parseAnimalSheetWorkbook(w,{capturedAt}),lights=r.records.filter(x=>x.entity_type==='light_events');assert.equal(lights.length,2);assert.equal(lights[0].payload.cycle_hours,22);assert.equal(lights[0].payload.lights_on,'07:10');assert.equal(lights[0].payload.end_date,'2026-10-20');assert.equal(lights[0].payload.interval_semantics,'end boundary is next phase start');assert.equal(lights[1].payload.evidence_status,'planned_schedule_unverified');assert.equal(lights[1].payload.cycle_hours,null);assert(lights.every(l=>l.payload.cage_sid===null&&l.payload.actual_exposure_verified===false))});
test('dates and times require declared types or explicit literal values; room clocks remain undated',async()=>{const w=fixture(),s=w.sheets[1];put(s,2,4,0.25,{effectiveFormat:{numberFormat:{type:'TIME'}}});put(s,2,5,'18:00');put(s,56,4,0.5);put(s,56,5,0.75);const r=await parseAnimalSheetWorkbook(w,{capturedAt}),lights=r.records.filter(x=>x.entity_type==='light_events');assert.equal(lights.length,1);assert.equal(lights[0].payload.lights_on,'06:00');assert.equal(lights[0].payload.start_date,null);assert.equal(lights[0].payload.end_date,null);assert.equal(lights[0].payload.cycle_hours,null)});
test('duplicate physical labels remain review issues instead of guessed location references',async()=>{const w=fixture(),s=w.sheets[0];slot(s,30,2,'L1');for(let i=0;i<3;i++)put(s,20,3+i,'L'+(i+1));put(s,21,2,'2026-10-01');put(s,21,3,'LD');const r=await parseAnimalSheetWorkbook(w,{capturedAt});assert(r.issues.some(i=>i.code==='duplicate_current_position_label'));const e=r.records.find(x=>x.entity_type==='light_events');assert.equal(e.payload.location_id,null);assert.equal(e.payload.requires_review,true)});
test('partial or changed source layout fails closed before any merge',async()=>{for(const mutate of [w=>w.spreadsheetId='other',w=>w.sheets.pop(),w=>delete w.sheets[0].merges,w=>w.sheets[0].merges=[],w=>delete w.sheets[0].data]){const w=fixture();mutate(w);await assert.rejects(parseAnimalSheetWorkbook(w,{capturedAt}))}assert.equal(a1(9,53),'BA9')});
test('source snapshot hashes are deterministic and raw notes/formulas cannot become executable values',async()=>{const w=fixture();put(w.sheets[0],8,2,'<script>raw</script>',{note:'=HYPERLINK("https://example.invalid")',userEnteredValue:{formulaValue:'=unsafe()'}});const r=await parseAnimalSheetWorkbook(w,{capturedAt}),again=await parseAnimalSheetWorkbook(w,{capturedAt:'2026-10-16T02:00:00Z'});assert.equal(r.content_hash,again.content_hash);const l=r.records.find(x=>x.entity_type==='locations');assert.match(l.payload.source_block_text,/<script>raw<\/script>/);assert.match(l.payload.source_block_text,/HYPERLINK/);assert.equal(l.payload.evidence_status,'source_position_unlinked')});

test('manager extraction uses the exact bounded header row and supplied aliases, never neighbor or generic labels',async()=>{const w=fixture(),s=w.sheets[0];put(s,6,5,'Researcher A');put(s,6,13,'Outside first block');put(s,6,8,'Mating');put(s,6,14,'GUEST');const r=await parseAnimalSheetWorkbook(w,{capturedAt,managerDirectory:[{code:'AA',name:'Synthetic Researcher Alpha',aliases:['Researcher A']}]});const locs=r.records.filter(r=>r.entity_type==='locations'&&r.payload.source_sheet_id===SOURCE_SHEETS[0].sheetId).map(r=>r.payload);assert.equal(locs[0].source_manager_name,'Synthetic Researcher Alpha');assert.equal(locs[0].source_manager_acronym,'AA');assert.equal(locs[0].source_manager_evidence_refs[0].source_cell,'E6');assert.equal(locs[1].source_manager_status,'not_recorded');assert.equal(locs[2].source_manager_raw,'GUEST');assert.equal(locs[2].source_manager_name,null);assert.equal(locs[2].source_manager_status,'unresolved')});
test('multiple header people or ambiguous aliases remain unresolved and blank manager cells are never filled from neighbors',async()=>{const w=fixture(),s=w.sheets[0];put(s,6,3,'A');put(s,6,5,'B');const directory=[{code:'A',name:'Synthetic Alpha'},{code:'B',name:'Synthetic Beta'}],r=await parseAnimalSheetWorkbook(w,{capturedAt,managerDirectory:directory}),locs=r.records.filter(r=>r.entity_type==='locations'&&r.payload.source_sheet_id===SOURCE_SHEETS[0].sheetId).map(r=>r.payload);assert.equal(locs[0].source_manager_status,'ambiguous');assert.equal(locs[0].source_manager_name,null);assert.equal(locs[1].source_manager_raw,null);assert.equal(locs[1].source_manager_status,'not_recorded');const noDirectory=await parseAnimalSheetWorkbook(w,{capturedAt});assert.equal(noDirectory.records.find(r=>r.entity_type==='locations').payload.source_manager_status,'unresolved')});

test('source is explicitly configured, matches the fetched workbook and remains part of stable IDs',async()=>{
 const w=fixture();await assert.rejects(()=>parseSource(w,{capturedAt}),/Unexpected source workbook/);
 const alternative='SYNTHETIC_ANIMAL_SOURCE_0000000000000002';await assert.rejects(()=>parseSource(w,{capturedAt,expectedSourceId:alternative}),/Unexpected source workbook/);
 const original=await parseSource(w,{capturedAt,expectedSourceId:ANIMAL_SOURCE_ID});w.spreadsheetId=alternative;
 const other=await parseSource(w,{capturedAt,expectedSourceId:alternative});assert.equal(other.source_id,alternative);
 const a=original.records.find(r=>r.entity_type==='locations'),b=other.records.find(r=>r.entity_type==='locations');
 assert.notEqual(a.entity_id,b.entity_id);assert.equal(b.entity_id,'loc_'+(await sourceHash(`${alternative}|${b.payload.source_sheet_id}|${b.payload.source_cell}`)).slice(0,20));
 assert(other.records.every(r=>r.payload.source_file_id===alternative));
});

function borderedGrid(sheet,row,col,bodyRows=5){
 sheet.merges.push({sheetId:sheet.properties.sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:col-1,endColumnIndex:col+5});
 const border=(r,c,side)=>{const rows=sheet.data[0].rowData;while(rows.length<r)rows.push({values:[]});const cells=rows[r-1].values;while(cells.length<c)cells.push({});const cell=cells[c-1];cell.effectiveFormat??={};cell.effectiveFormat.borders??={};cell.effectiveFormat.borders[side]={style:'SOLID_THICK'};};
 const end=row+bodyRows+1;
 for(let c=col;c<col+6;c++){border(row,c,'top');border(row,c,'bottom');border(end,c,'bottom');}
 for(let r=row;r<=end;r++){border(r,col,'left');border(r,col+5,'right');}
 return end;
}
const locations=result=>result.records.filter(r=>r.entity_type==='locations').map(r=>r.payload);

test('complete blank SPF cage grids retain physical coordinates, empty body and explicit border provenance',async()=>{
 const w=fixture(),s=w.sheets[2];borderedGrid(s,7,14);slot(s,26,2,'SPF-F1');borderedGrid(s,26,20,6);
 const before=structuredClone(w),result=await parseAnimalSheetWorkbook(w,{capturedAt}),blank=locations(result).filter(p=>p.source_grid_basis);
 assert.equal(result.parser_version,2);assert.equal(blank.length,2);assert.deepEqual(w,before);
 for(const p of blank){assert.equal(p.source_grid_basis,'border_verified_cage_grid');assert.equal(p.source_grid_label_status,'unlabelled');assert.equal(p.source_label,'');assert.equal(p.label,'Unlabelled grid '+p.source_cell);assert.equal(p.room_id,'room_sheet_spf');assert.equal(p.source_current,true);assert.deepEqual(p.source_observed_tags,[]);assert.equal(p.location_id,'loc_'+(await sourceHash(`${ANIMAL_SOURCE_ID}|1250760483|${p.source_cell}`)).slice(0,20));assert.equal(p.rack_id,locations(result).find(x=>x.source_sheet_id===1250760483&&!x.source_grid_basis).rack_id);}
 assert.deepEqual(blank.map(p=>p.source_grid_boundary_range),['N7:S13','T26:Y33']);
 // Later labelled source uses the same coordinate-derived ID, never a new grid.
 put(s,7,14,'SPF-E2',{effectiveFormat:s.data[0].rowData[6].values[13].effectiveFormat});
 const labelled=locations(await parseAnimalSheetWorkbook(w,{capturedAt})).find(p=>p.source_cell==='N7'&&p.source_sheet_id===1250760483);
 assert.equal(labelled.location_id,blank[0].location_id);assert.equal(labelled.label,'SPF-E2');
});

test('blank merges, notes, formulas, partial borders and non-SPF grids cannot create phantom capacity',async()=>{
 const mutations=[
  (w,s)=>{delete s.data[0].rowData[6].values[13].effectiveFormat.borders.top;},
  (w,s)=>{s.data[0].rowData[12].values[16].effectiveFormat.borders.bottom.style='DOTTED';},
  (w,s)=>{delete s.data[0].rowData[9].values[18].effectiveFormat.borders.right;},
  (w,s)=>{s.data[0].rowData[6].values[13].note='Storage notes';},
  (w,s)=>{s.data[0].rowData[6].values[13].userEnteredValue={formulaValue:'=""'};},
  (w,s)=>{s.data[0].rowData[6].values[13].effectiveValue={stringValue:'Notes'};},
  (w,s)=>{s.data[0].rowData[6].values[1].effectiveValue={stringValue:'Unrecognised peer'};slot(s,40,2,'SPF-E9');},
  (w,s)=>{s.merges.at(-1).endRowIndex++;},
  (w,s)=>{for(const row of s.data[0].rowData)for(const cell of row.values??[])if(cell.effectiveFormat)delete cell.effectiveFormat.borders;},
 ];
 for(const mutate of mutations){const w=fixture(),s=w.sheets[2];borderedGrid(s,7,14);mutate(w,s);assert.equal(locations(await parseAnimalSheetWorkbook(w,{capturedAt})).filter(p=>p.source_grid_basis).length,0);}
 for(const index of [0,1]){const w=fixture();borderedGrid(w.sheets[index],7,14);assert.equal(locations(await parseAnimalSheetWorkbook(w,{capturedAt})).filter(p=>p.source_grid_basis).length,0);}
 const w=fixture();borderedGrid(w.sheets[2],15,14);assert.equal(locations(await parseAnimalSheetWorkbook(w,{capturedAt})).filter(p=>p.source_grid_basis).length,0);
});

test('new blank grid discoveries use ordinary additive merge and preserve existing observations and history',async()=>{
 const {planAnimalSheetMerge}=await import('../supabase/functions/import-animal-sheet/merge.mjs');
 const w=fixture(),before=await parseAnimalSheetWorkbook(w,{capturedAt}),current=before.records.map(r=>({...structuredClone(r),version:1,archived:false}));
 const baseline={schema_version:1,source_id:ANIMAL_SOURCE_ID,entries:before.records.map(r=>({...structuredClone(r),source_present:true}))};
 borderedGrid(w.sheets[2],7,14);const after=await parseAnimalSheetWorkbook(w,{capturedAt}),plan=await planAnimalSheetMerge(after,current,baseline);
 assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].entity_type,'locations');assert.equal(plan.changes[0].expected_version,0);assert.equal(plan.conflicts.length,0);assert.equal(plan.summary.updated,0);assert.equal(plan.summary.withdrawn,0);assert.equal(plan.historyRecords.length,1);assert.equal(plan.historyRecords[0].payload.animal_sheet_change.action,'added');
 assert.deepEqual(current,before.records.map(r=>({...r,version:1,archived:false})));
});
