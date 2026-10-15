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

test('verified manager aliases survive unrelated header annotations and parsed rows exclude footer costs',async()=>{
 const w=fixture(),s=w.sheets[0];s.merges[0].endColumnIndex++;put(s,6,2,'Cell culture');put(s,6,5,'Researcher A');put(s,8,2,"PB'-M101");put(s,8,3,'Protocol note');put(s,8,4,'2026-07-23');put(s,8,5,0);put(s,8,6,1);put(s,8,7,12);put(s,13,2,'2025-12-29');put(s,13,3,'150 lux');put(s,13,5,'$');put(s,13,6,123.45);
 const r=await parseAnimalSheetWorkbook(w,{capturedAt,managerDirectory:[{name:'Synthetic Alpha',aliases:['Researcher A'],code:'AA'}]}),p=r.records.find(r=>r.entity_type==='locations').payload;
 assert.equal(p.source_manager_name,'Synthetic Alpha');assert.equal(p.source_manager_status,'resolved');assert.match(p.source_block_text,/123\.45/);assert.equal(p.source_cage_observation.animals[0].tag,"PB'-M101");assert.equal(p.source_cage_observation.animals[0].earMark,'L0R1');assert.equal(p.source_cage_observation.animals[0].dateOfBirth,'2026-07-23');assert.equal(p.source_cage_observation.startedDate,'2025-12-29');assert.equal(p.source_cage_observation.intensityLux,150);assert(!JSON.stringify(p.source_cage_observation).includes('123.45'));assert(r.records.every(r=>!['mice','cages'].includes(r.entity_type)));
});
test('a known name cannot hide another unrecognized possible manager in the same header',async()=>{
 const w=fixture(),s=w.sheets[0];put(s,6,3,'Unknown colleague');put(s,6,5,'Researcher A');const r=await parseAnimalSheetWorkbook(w,{capturedAt,managerDirectory:[{name:'Synthetic Alpha',aliases:['Researcher A'],code:'AA'}]}),p=r.records.find(r=>r.entity_type==='locations').payload;assert.equal(p.source_manager_name,null);assert.equal(p.source_manager_status,'unresolved');
});

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

function confirmedBlankFixture(){const w=fixture(),s=w.sheets[2];s.properties.gridProperties.columnCount=71;slot(s,15,2,'SPF-D1');return w}

test('only the owner-confirmed unnamed SPF grid is retained with border and coordinate provenance',async()=>{
 const w=confirmedBlankFixture(),s=w.sheets[2];borderedGrid(s,15,46);slot(s,26,2,'SPF-F1');borderedGrid(s,26,59,6);borderedGrid(s,26,65,6);
 const before=structuredClone(w),result=await parseAnimalSheetWorkbook(w,{capturedAt}),blank=locations(result).filter(p=>p.source_grid_basis);
 assert.equal(result.parser_version,4);assert.equal(blank.length,1);assert.deepEqual(w,before);
 const p=blank[0];assert.equal(p.source_grid_basis,'owner_confirmed_physical_grid');assert.equal(p.source_grid_confirmation,'owner_physical_layout_2026-10-15');assert.equal(p.source_grid_border_verified,true);assert.equal(p.source_grid_label_status,'unlabelled');assert.equal(p.source_label,'');assert.equal(p.label,'Unlabelled grid AT15');assert.equal(p.room_id,'room_sheet_spf');assert.equal(p.source_current,true);assert.deepEqual(p.source_observed_tags,[]);assert.equal(p.location_id,'loc_'+(await sourceHash(`${ANIMAL_SOURCE_ID}|1250760483|AT15`)).slice(0,20));assert.equal(p.source_grid_boundary_range,'AT15:AY21');
 put(s,15,46,'SPF-D8',{effectiveFormat:s.data[0].rowData[14].values[45].effectiveFormat});
 const labelled=locations(await parseAnimalSheetWorkbook(w,{capturedAt})).find(p=>p.source_cell==='AT15'&&p.source_sheet_id===1250760483);
 assert.equal(labelled.location_id,p.location_id);assert.equal(labelled.label,'SPF-D8');
});

test('templates, notes, formulas, partial borders and non-SPF grids cannot create phantom capacity',async()=>{
 const mutations=[
  (w,s)=>{delete s.data[0].rowData[14].values[45].effectiveFormat.borders.top;},
  (w,s)=>{s.data[0].rowData[20].values[48].effectiveFormat.borders.bottom.style='DOTTED';},
  (w,s)=>{delete s.data[0].rowData[17].values[50].effectiveFormat.borders.right;},
  (w,s)=>{s.data[0].rowData[14].values[45].note='Storage notes';},
  (w,s)=>{s.data[0].rowData[14].values[45].userEnteredValue={formulaValue:'=""'};},
  (w,s)=>{s.data[0].rowData[14].values[45].effectiveValue={stringValue:'Notes'};},
  (w,s)=>{s.data[0].rowData[14].values[1].effectiveValue={stringValue:'Unrecognised peer'};},
  (w,s)=>{s.merges.at(-1).endRowIndex++;},
  (w,s)=>{for(const row of s.data[0].rowData)for(const cell of row.values??[])if(cell.effectiveFormat)delete cell.effectiveFormat.borders;},
 ];
 for(const mutate of mutations){const w=confirmedBlankFixture(),s=w.sheets[2];borderedGrid(s,15,46);mutate(w,s);assert.equal(locations(await parseAnimalSheetWorkbook(w,{capturedAt})).filter(p=>p.source_grid_basis).length,0);}
 for(const index of [0,1]){const w=fixture();slot(w.sheets[index],15,2,'SPF-D1');borderedGrid(w.sheets[index],15,46);assert.equal(locations(await parseAnimalSheetWorkbook(w,{capturedAt})).filter(p=>p.source_grid_basis).length,0);}
 const w=confirmedBlankFixture();borderedGrid(w.sheets[2],15,52);assert.equal(locations(await parseAnimalSheetWorkbook(w,{capturedAt})).filter(p=>p.source_grid_basis).length,0);
});

test('native merged-anchor borders establish only the actual outer edge of the confirmed SPF slot',async()=>{
 const w=confirmedBlankFixture(),s=w.sheets[2];borderedGrid(s,15,46);
 // Google CellData stores AT15:AY15 and AX21:AY21 outlines on their anchors.
 s.data[0].rowData[14].values[45].effectiveFormat.borders.right={style:'SOLID_THICK'};
 for(let c=46;c<51;c++)delete s.data[0].rowData[14].values[c].effectiveFormat;
 s.merges.push({sheetId:s.properties.sheetId,startRowIndex:20,endRowIndex:21,startColumnIndex:49,endColumnIndex:51});
 s.data[0].rowData[20].values[49].effectiveFormat.borders.right={style:'SOLID_THICK'};
 delete s.data[0].rowData[20].values[50].effectiveFormat;
 assert.equal(locations(await parseAnimalSheetWorkbook(w,{capturedAt})).filter(p=>p.source_grid_basis).length,1);
 // A conflicting explicit border is authoritative; absent merge metadata or
 // a merge extending beyond the confirmed block cannot supply a boundary.
 const conflicting=structuredClone(w);conflicting.sheets[2].data[0].rowData[14].values[46].effectiveFormat={borders:{top:{style:'DOTTED'}}};
 assert.equal(locations(await parseAnimalSheetWorkbook(conflicting,{capturedAt})).filter(p=>p.source_grid_basis).length,0);
 for(const mutate of [x=>x.merges.pop(),x=>{x.merges.at(-1).endColumnIndex++;},x=>{x.merges.at(-1).endRowIndex++;}]){
  const invalid=structuredClone(w);mutate(invalid.sheets[2]);assert.equal(locations(await parseAnimalSheetWorkbook(invalid,{capturedAt})).filter(p=>p.source_grid_basis).length,0);
 }
});

test('confirmed35 Conventional and20 SPF physical slots preserve right-side labels and withdraw only explicit CLOSE slots',async()=>{
 const {planAnimalSheetMerge}=await import('../supabase/functions/import-animal-sheet/merge.mjs');
 const w=fixture(),con=w.sheets[1],spf=w.sheets[2];con.merges=[];con.data=[{rowData:[]}];con.properties.gridProperties.columnCount=92;spf.merges=[];spf.data=[{rowData:[]}];spf.properties.gridProperties.columnCount=71;
 for(const [i,row]of [7,16,25,34,45].entries())for(let j=0;j<7;j++)slot(con,row,2+j*6,`CAL-${String.fromCharCode(65+i)}${j+1}`);
 for(let j=0;j<7;j++)slot(con,7,49+j*6,`CAR-A${j+1}`);
 for(const [row,letter]of [[15,'D'],[26,'F']])for(let j=0;j<7;j++)slot(spf,row,2+j*6,`SPF-${letter}${j+1}`);
 slot(spf,26,46,'SPF-E1');slot(spf,26,52,'SPF-E2');for(let j=0;j<3;j++){slot(spf,41,2+j*6,`SPF-E${j+1}`);put(spf,41,7+j*6,'on');}put(spf,38,2,'Right (3)');
 const before=await parseAnimalSheetWorkbook(w,{capturedAt});
 for(let j=0;j<7;j++)put(con,44,2+j*6,'CLOSE');borderedGrid(spf,15,46);borderedGrid(spf,26,59,6);borderedGrid(spf,26,65,6);
 const after=await parseAnimalSheetWorkbook(w,{capturedAt}),loc=locations(after);
 assert.equal(loc.filter(p=>p.room_id==='room_sheet_conventional').length,35);assert.equal(loc.filter(p=>p.room_id==='room_sheet_spf').length,20);assert.equal(loc.filter(p=>p.room_id==='room_sheet_spf'&&p.row===41).length,3);assert.equal(after.issues.filter(i=>i.code==='explicitly_closed_position').length,7);
 const current=before.records.map(r=>({...structuredClone(r),version:1,archived:false})),baseline={schema_version:1,source_id:ANIMAL_SOURCE_ID,entries:before.records.map(r=>({...structuredClone(r),source_present:true}))},plan=await planAnimalSheetMerge(after,current,baseline);
 assert.equal(plan.summary.added,1);assert.equal(plan.summary.withdrawn,7);assert.equal(plan.summary.updated,0);assert.equal(plan.conflicts.length,0);assert.equal(plan.changes.filter(r=>r.payload.source_current===false).length,7);assert(plan.changes.every(r=>r.archived===false));assert.equal(plan.historyRecords.filter(r=>r.payload.animal_sheet_change.action==='withdrawn').length,7);
 assert.deepEqual(current,before.records.map(r=>({...r,version:1,archived:false})));
 // A closure mentioned in animal notes cannot close another physical position.
 const other=confirmedBlankFixture();put(other.sheets[2],16,2,'CLOSE');assert(locations(await parseAnimalSheetWorkbook(other,{capturedAt})).some(p=>p.source_cell==='B15'&&p.source_sheet_id===1250760483));
});
