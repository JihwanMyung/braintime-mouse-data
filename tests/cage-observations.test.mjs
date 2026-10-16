import test from 'node:test';
import assert from 'node:assert/strict';
import {cageObservations,cageSheetAnimals,prepareMouseCageSheetEdit,ageWeeks,todayTaipei} from '../web/cage-observations.js';
const position=()=>({location_id:'POS',source_cell:'T7',source_block_range:'T6:Y13',source_block_text:"W6: Researcher A\nT7: L7\nY8: (wk)\nT10: PB'-M101\nU10: Protocol note\nV10: 2026-07-23\nW10: 1\nX10: 1\nY10: 12\nT11: PB'-M102\nV11: 2026-07-23\nW11: 0\nX11: 0\nT12: PB'-M103\nV12: 2026-07-22\nW12: 0\nX12: 2\nT13: 2025-12-29\nU13: 150 lux\nV13: 41 wks\nW13: $\nX13: 123.45"});
const dataset=()=>({tables:{mice:[{mouse_sid:'101',physical_tag:"PB'-M",sex:'Male',date_of_birth:'2026-07-23',state:'Stock',cage_sid:'OLD',comment:'Older note'},{mouse_sid:'102',physical_tag:"PB'-M",sex:'Male',date_of_birth:'2026-07-23',state:'Stock'},{mouse_sid:'103',physical_tag:"PB'-M",sex:'Male',date_of_birth:'2026-07-22',state:'Stock'}]}});
test('six-column grid reads per-animal notes, DOB and explicit zero ear holes without fee/footer leakage',()=>{
 const p=position(),before=structuredClone(p),out=cageObservations(p);
 assert.equal(out.managerName,'Researcher A');assert.equal(out.managerCell,'W6');assert.equal(out.startedDate,'2025-12-29');assert.equal(out.intensityLux,150);assert.equal(out.startedCell,'T13');assert.equal(out.intensityCell,'U13');
 assert.deepEqual(out.animals.map(a=>[a.tag,a.earMark,a.sex]),[["PB'-M101",'L1R1','Male'],["PB'-M102",'L0R0','Male'],["PB'-M103",'L0R2','Male']]);
 assert.equal(out.animals[0].note,'Protocol note');assert.equal(out.animals[0].dateOfBirth,'2026-07-23');assert.equal(out.animals[0].sourceCell,'T10');assert.equal(out.animals[0].key,'POS:T10');assert.equal(out.animals.length,3);assert(!JSON.stringify(out).includes('123.45'));assert.deepEqual(p,before);
});
test('stored sanitized observations take precedence without requiring private raw text',()=>{
 const parsed=cageObservations(position()),p={location_id:'POS',source_cage_observation:parsed,source_block_text:'incorrect'};assert.deepEqual(cageObservations(p),parsed);
 p.source_cage_observation.animals[0].fee=300;p.source_cage_observation.cost=400;assert(!JSON.stringify(cageObservations(p)).includes('fee'));assert(!JSON.stringify(cageObservations(p)).includes('cost'));
});
test('unsupported grids, malformed dates, incomplete ears and ambiguous footer dates are not guessed',()=>{
 const p=position();p.source_block_range='T6:X13';const fallback=cageObservations(p).animals;assert.equal(fallback.length,3);assert(fallback.every(r=>r.sourceCell===null&&r.dateOfBirth===null&&r.earMark===null));assert(cageSheetAnimals(dataset(),{position:p}).every(r=>r.mouseSid===null&&r.matchStatus==='unlinked'));
 p.source_block_range='T6:Y13';p.source_block_text=p.source_block_text.replace('W10: 1','W10: ').replace('V10: 2026-07-23','V10: 2026-02-30').replace('T13: 2025-12-29','T13: Experiment').replace('V13: 41 wks','V13: 2025-12-29');
 const out=cageObservations(p);assert.equal(out.animals[0].earMark,null);assert.equal(out.animals[0].left,null);assert.equal(out.animals[0].right,1);assert.equal(out.animals[0].dateOfBirth,null);assert.equal(out.startedDate,null);assert.equal(out.intensityLux,150);
});
test('seven-row body uses retained footer boundary and source annotations remain reviewable',()=>{
 const p={location_id:'SPF',source_cell:'B26',source_block_range:'B25:G33',source_block_text:"E25: Mating\nB26: SPF-F1\nB32: P(')B'-F200\nC32: Study note\nD32: 2026-08-01\nE32: 0\nF32: 1\nB32 comment: transferred previously\nB33: 2026-08-10\nC33: 200 lx"},out=cageObservations(p);
 assert.equal(out.managerName,null);assert.equal(out.animals.length,1);assert.equal(out.animals[0].sex,'Female');assert.equal(out.animals[0].requiresReview,true);assert.match(out.animals[0].note,/Study note\ntransferred previously/);assert.equal(out.startedDate,'2026-08-10');
});
test('wider merged animal-tag columns keep note, DOB and ears aligned from the right edge',()=>{
 for(const [range,header,raw] of [
  ['AL15:AS22','AL16',"AQ15: Researcher A\nAL16: CAL-B7\nAL17: B'-M101\nAO17: Note wide\nAP17: 2026-06-01\nAQ17: 1\nAR17: 0\nAS17: 20\nAL22: 2026-06-03\nAO22: 150 lux"],
  ['AW6:BC13','AW7',"BA6: Researcher A\nAW7: CAR-A1\nAW8: B' M-101\nAY8: Note wide\nAZ8: 2026-06-01\nBA8: 1\nBB8: 0\nBC8: 20\nAW13: 2026-06-03\nAY13: 150 lux"]]){
  const result=cageObservations({location_id:'WIDE',source_cell:header,source_block_range:range,source_block_text:raw});assert.equal(result.animals[0].note,'Note wide');assert.equal(result.animals[0].dateOfBirth,'2026-06-01');assert.equal(result.animals[0].earMark,'L1R0');assert.equal(result.animals[0].sex,'Male');assert.equal(result.managerName,'Researcher A');assert.equal(result.startedDate,'2026-06-03');assert.equal(result.intensityLux,150);
 }
});
test('age uses complete weeks and Taipei date rather than stale spreadsheet formulas',()=>{
 assert.equal(todayTaipei(new Date('2026-10-15T16:01:00Z')),'2026-10-16');assert.equal(ageWeeks('2026-07-23','2026-10-16'),12);assert.equal(ageWeeks('2026-10-10','2026-10-16'),0);assert.equal(ageWeeks('2026-10-10','2026-10-17'),1);assert.equal(ageWeeks('2026-10-17','2026-10-16'),null);assert.equal(ageWeeks('2026-02-30','2026-10-16'),null);
});
test('exact composite identity joins do not move cages or alter source data',()=>{
 const d=dataset(),p=position(),before=structuredClone({d,p}),rows=cageSheetAnimals(d,{position:p});assert.deepEqual(rows.map(r=>r.mouseSid),['101','102','103']);assert(rows.every(r=>r.matchStatus==='matched'));assert.equal(rows[0].note,'Protocol note');assert.equal(rows[0].sourceNote,'Protocol note');assert.equal(rows[0].earMark,'L1R1');assert.deepEqual({d,p},before);
});
test('numeric suffix, conflicting DOB/sex, ended mice and duplicate identifiers never give editable links',()=>{
 for(const mutate of [d=>d.tables.mice[0].physical_tag="EB'-M",d=>d.tables.mice[0].date_of_birth='2026-07-24',d=>d.tables.mice[0].sex='Female',d=>d.tables.mice[0].state='Ended',d=>d.tables.mice.push({...d.tables.mice[0],mouse_sid:'OTHER',physical_tag:"PB'-M101"})]){
  const d=dataset();mutate(d);const row=cageSheetAnimals(d,{position:position()})[0];assert.equal(row.mouseSid,null);assert(['unlinked','conflict','ambiguous'].includes(row.matchStatus));
 }
 const p=position();p.source_block_text=p.source_block_text.replace("T11: PB'-M102","T11: PB'-M101");assert(cageSheetAnimals(dataset(),{position:p}).slice(0,2).every(r=>r.matchStatus==='ambiguous'&&r.mouseSid===null));
});
test('deliberate mouse edits override the imported DOB, ear mark and note while retaining source note',()=>{
 const d=dataset(),m=d.tables.mice[0];m.date_of_birth='2026-07-24';m.ear_mark='L2R2';m.comment='Edited note';m.cage_sheet_overrides={date_of_birth:true,ear_mark:true,comment:true};
 const row=cageSheetAnimals(d,{position:position()})[0];assert.equal(row.mouseSid,'101');assert.equal(row.dateOfBirth,'2026-07-24');assert.equal(row.earMark,'L2R2');assert.equal(row.note,'Edited note');assert.equal(row.sourceNote,'Protocol note');
 m.comment='';m.ear_mark='';m.date_of_birth='';const blank=cageSheetAnimals(d,{position:position()})[0];assert.equal(blank.note,'');assert.equal(blank.earMark,null);assert.equal(blank.dateOfBirth,null);
});
test('registered cages overlay uniquely agreeing source details for actual residents without adopting extra animals',()=>{
 const d=dataset(),m=d.tables.mice[0];m.ear_mark='L3R2';const before=structuredClone(d),rows=cageSheetAnimals(d,{cage:{cage_sid:'OLD'},mice:[m],position:position()});assert.equal(rows.length,1);assert.equal(rows[0].matchStatus,'matched');assert.equal(rows[0].tag,"PB'-M101");assert.equal(rows[0].earMark,'L1R1');assert.equal(rows[0].note,'Protocol note');assert.equal(rows[0].sourceNote,'Protocol note');assert.equal(rows[0].key,'mouse:101');assert.equal(rows[0].sourceCell,'T10');assert.deepEqual(d,before);
 m.cage_sheet_overrides={ear_mark:true,comment:true};const overridden=cageSheetAnimals(d,{cage:{cage_sid:'OLD'},mice:[m],position:position()})[0];assert.equal(overridden.earMark,'L3R2');assert.equal(overridden.note,'Older note');assert.equal(overridden.sourceNote,'Protocol note');
 m.date_of_birth='2026-07-24';const conflicted=cageSheetAnimals(d,{cage:{cage_sid:'OLD'},mice:[m],position:position()})[0];assert.equal(conflicted.matchStatus,'registered');assert.equal(conflicted.note,'Older note');assert.equal(conflicted.earMark,'L3R2');assert.equal(conflicted.sourceCell,null);
});
test('exact genotype, recorded sex and SID combination requires DOB agreement and never accepts changed genotypes',()=>{
 const d=dataset(),m=d.tables.mice[0];m.physical_tag="PB'";let row=cageSheetAnimals(d,{position:position()})[0];assert.equal(row.mouseSid,'101');assert.equal(row.matchStatus,'matched');
 m.date_of_birth='2026-07-24';assert.equal(cageSheetAnimals(d,{position:position()})[0].mouseSid,null);
 m.cage_sheet_overrides={date_of_birth:true};row=cageSheetAnimals(d,{position:position()})[0];assert.equal(row.mouseSid,'101');assert.equal(row.dateOfBirth,'2026-07-24');
 delete m.cage_sheet_overrides;m.date_of_birth='';assert.equal(cageSheetAnimals(d,{position:position()})[0].mouseSid,null);
 m.date_of_birth='2026-07-23';m.physical_tag="(P)B'";assert.equal(cageSheetAnimals(d,{position:position()})[0].mouseSid,null);
 m.physical_tag="PB'";m.sex='Unknown';assert.equal(cageSheetAnimals(d,{position:position()})[0].mouseSid,null);
 m.physical_tag='Named line';m.sex='Male';const p=position();p.source_block_text=p.source_block_text.replace("PB'-M101",'Named line-M101');assert.equal(cageSheetAnimals(d,{position:p})[0].mouseSid,null);
});
test('unsupported old templates retain literal source tags without guessing fields or editable identities',()=>{
 const p={location_id:'OLD',source_observed_tags:["PB'-M101",'2026-01-01','123.45','$300']},out=cageObservations(p);assert.equal(out.animals.length,1);assert.equal(out.animals[0].tag,"PB'-M101");assert.equal(out.animals[0].dateOfBirth,null);assert.equal(cageSheetAnimals(dataset(),{position:p})[0].mouseSid,null);
});
test('only the delimiter before terminal sex/SID is normalized for registered and unlinked positions',()=>{
 const d=dataset(),m=d.tables.mice[0],p=position();m.physical_tag="PB' M";
 const source=cageSheetAnimals(d,{position:p})[0],registered=cageSheetAnimals(d,{cage:{cage_sid:'OLD'},mice:[m],position:p})[0];assert.equal(source.mouseSid,'101');assert.equal(registered.mouseSid,'101');assert.equal(registered.matchStatus,'matched');assert.equal(registered.earMark,'L1R1');assert.equal(registered.note,'Protocol note');assert.equal(registered.sourceCell,source.sourceCell);assert.equal(registered.tag,source.tag);
 for(const tag of ["PB'-M M","(P)B' M","PB’ M"]){m.physical_tag=tag;const rows=cageSheetAnimals(d,{position:p}),saved=cageSheetAnimals(d,{cage:{cage_sid:'OLD'},mice:[m],position:p})[0];assert.equal(rows[0].mouseSid,null);assert.equal(saved.matchStatus,'registered');assert.equal(saved.earMark,null);assert.equal(saved.note,'Older note');}
 m.physical_tag="PB'-M";p.source_block_text=p.source_block_text.replace("PB'-M101","PB' M101");assert.equal(cageSheetAnimals(d,{position:p})[0].mouseSid,'101');
});
test('delimiter-equivalent duplicate source tags cannot create a unique overlay',()=>{
 const d=dataset(),p=position();p.source_block_text=p.source_block_text.replace("PB'-M102","PB' M101");const rows=cageSheetAnimals(d,{position:p});assert.equal(rows[0].matchStatus,'ambiguous');assert.equal(rows[1].matchStatus,'ambiguous');const registered=cageSheetAnimals(d,{cage:{cage_sid:'OLD'},mice:[d.tables.mice[0]],position:p})[0];assert.equal(registered.matchStatus,'registered');assert.equal(registered.note,'Older note');assert.equal(registered.sourceNote,'');
});

test('explicit transfers suppress only uniquely matched old grid rows and preserve imported evidence',()=>{
 const d=dataset(),p=position(),original=structuredClone(p);d.tables.cages=[{cage_sid:'NEW',location_id:'NEXT'}];
 Object.assign(d.tables.mice[0],{cage_sid:'NEW',cage_sheet_overrides:{cage_sid:true}});
 const old=cageSheetAnimals(d,{position:p});assert.deepEqual(old.map(r=>r.mouseSid),['102','103']);assert.deepEqual(p,original);
 const target=cageSheetAnimals(d,{position:{location_id:'NEXT'},cage:d.tables.cages[0],mice:[d.tables.mice[0]]});assert.equal(target[0].mouseSid,'101');
 d.tables.mice.push({...d.tables.mice[0],mouse_sid:'OTHER',physical_tag:"PB'-M101"});assert.equal(cageSheetAnimals(d,{position:p})[0].matchStatus,'ambiguous');
});
test('staged cage registration retains unassigned source occupants without silently adopting them',()=>{
 const d=dataset(),p=position(),cage={cage_sid:'NEW',location_id:'POS',cage_sheet_source_location_id:'POS'},m={mouse_sid:'104',physical_tag:'E-M104',state:'Stock',cage_sid:'NEW',cage_sheet_overrides:{cage_sid:true}};
 d.tables.mice.push(m);d.tables.cages=[cage];const before=structuredClone(d);
 const rows=cageSheetAnimals(d,{position:p,cage,mice:[m]});assert.deepEqual(rows.map(r=>r.mouseSid),['104','101','102','103']);assert.deepEqual(d,before);
 d.tables.mice[1].physical_tag='Unknown';assert.equal(cageSheetAnimals(d,{position:p,cage,mice:[m]}).find(r=>r.tag==="PB'-M102").matchStatus,'unlinked');
 const moved={...cage,location_id:'NEXT'};assert.equal(cageSheetAnimals(d,{position:{...p,location_id:'NEXT'},cage:moved,mice:[m]}).length,1);
});

const editableDataset=()=>{const d=dataset();d.tables.locations=[position()];return d;};
function editMouse(d,patch){const before=d.tables.mice[0],after=prepareMouseCageSheetEdit(d,before,{...before,...patch});d.tables.mice[0]=after;return after;}
test('Mouse editor fields override source details and a renamed tag keeps only its verified SID link',()=>{
 const d=editableDataset(),original=structuredClone(d),before=d.tables.mice[0],draft={...before,physical_tag:'Updated-M101',date_of_birth:'2026-07-24',ear_mark:'L2R0',comment:'Updated note'};
 const after=prepareMouseCageSheetEdit(d,before,draft);assert.deepEqual(d,original);assert.equal(draft.cage_sheet_overrides,undefined);
 assert.deepEqual(after.cage_sheet_overrides,{comment:true,ear_mark:true,date_of_birth:true,physical_tag:true});assert.equal(after.cage_sheet_source_links.length,1);assert.equal(after.cage_sheet_source_links[0].source_tag,"PB'-M101");
 d.tables.mice[0]=after;const row=cageSheetAnimals(d,{position:d.tables.locations[0]})[0];assert.equal(row.matchStatus,'matched');assert.equal(row.mouseSid,'101');assert.equal(row.tag,'Updated-M101');assert.equal(row.sourceTag,"PB'-M101");assert.equal(row.note,'Updated note');assert.equal(row.sourceNote,'Protocol note');assert.equal(row.earMark,'L2R0');assert.equal(row.dateOfBirth,'2026-07-24');assert.equal(after.cage_sid,'OLD');assert.deepEqual(d.tables.locations,original.tables.locations);
 // A second rename retains the same literal observation, not an invented tag alias.
 const again=editMouse(d,{physical_tag:'Second-M101'});assert.deepEqual(again.cage_sheet_source_links,after.cage_sheet_source_links);assert.equal(cageSheetAnimals(d,{position:d.tables.locations[0]})[0].tag,'Second-M101');
});
test('Mouse editor marking preserves existing overrides, deliberate blanks and DOB-only edits',()=>{
 const d=editableDataset(),m=d.tables.mice[0];m.ear_mark='L1R1';m.cage_sheet_overrides={ear_mark:true,cage_sid:false};
 const after=editMouse(d,{comment:'',ear_mark:'',date_of_birth:'2026-07-24'});assert.deepEqual(after.cage_sheet_overrides,{ear_mark:true,cage_sid:false,comment:true,date_of_birth:true});assert.equal(after.cage_sheet_source_links,undefined);
 const row=cageSheetAnimals(d,{position:d.tables.locations[0]})[0];assert.equal(row.mouseSid,'101');assert.equal(row.note,'');assert.equal(row.earMark,null);assert.equal(row.dateOfBirth,'2026-07-24');
 const unchanged=prepareMouseCageSheetEdit(d,after,{...after,manager:'Another keeper'});assert.deepEqual(unchanged.cage_sheet_overrides,after.cage_sheet_overrides);
});
test('renames never bind uncertain, duplicated, stale or historical observations',()=>{
 for(const mutate of [
  d=>d.tables.mice[0].date_of_birth='2026-07-24',
  d=>d.tables.mice[0].sex='Female',
  d=>d.tables.mice[0].state='Ended',
  d=>d.tables.locations[0].source_block_text=d.tables.locations[0].source_block_text.replace('Protocol note','Transferred previously'),
  d=>d.tables.locations[0].source_current=false,
  d=>d.tables.locations[0].history_read_only=true,
  d=>d.tables.locations[0].source_historical=true,
  d=>d.tables.locations.push({...d.tables.locations[0],location_id:'OTHER'}),
  d=>d.tables.locations.push({...d.tables.locations[0]}),
  d=>d.tables.mice.push({...d.tables.mice[0],mouse_sid:'OTHER',physical_tag:"PB'-M101"})
 ]){const d=editableDataset();mutate(d);const after=editMouse(d,{physical_tag:'Renamed-M101'});assert.deepEqual(after.cage_sheet_source_links,[]);}
 const d=editableDataset();d.history_projection={read_only:true};const before=d.tables.mice[0],after=prepareMouseCageSheetEdit(d,before,{...before,physical_tag:'Renamed-M101'});assert.equal(after.cage_sheet_source_links,undefined);assert.equal(after.cage_sheet_overrides,undefined);
});
test('retained links fail closed when a source observation changes or appears in another location',()=>{
 const original=editableDataset();editMouse(original,{physical_tag:'Renamed-M101'});
 for(const mutate of [
  p=>p.location_id='NEW',p=>p.source_current=false,p=>p.history_read_only=true,p=>p.source_historical=true,
  p=>p.source_block_text=p.source_block_text.replace("PB'-M101","PB'-M999"),
  p=>p.source_block_text=p.source_block_text.replace('Protocol note','Another observation'),
  p=>p.source_block_text=p.source_block_text.replace('V10: 2026-07-23','V10: 2026-07-24'),
  p=>p.source_block_text=p.source_block_text.replace('W10: 1','W10: 2'),
  p=>p.source_block_text=p.source_block_text.replace('T13: 2025-12-29','T13: 2026-01-01')
 ]){const d=structuredClone(original);mutate(d.tables.locations[0]);const row=cageSheetAnimals(d,{position:d.tables.locations[0]})[0];assert.equal(row.mouseSid,null);assert.equal(row.matchStatus,'unlinked');}
 const d=structuredClone(original);d.tables.locations[0].source_snapshot_date='2026-10-17';d.tables.locations[0].source_last_seen_at='2026-10-17T01:00:00Z';assert.equal(cageSheetAnimals(d,{position:d.tables.locations[0]})[0].mouseSid,'101');
 // Sanitized lower-privilege source projections retain the same link.
 const projected={location_id:'POS',source_cage_observation:cageObservations(d.tables.locations[0])};assert.equal(cageSheetAnimals(d,{position:projected})[0].mouseSid,'101');
 d.history_projection={read_only:true};assert.equal(cageSheetAnimals(d,{position:projected})[0].mouseSid,null);
});
test('stored links cannot override a competing literal identity or duplicate source tags',()=>{
 const original=editableDataset();editMouse(original,{physical_tag:'Renamed-M101'});
 const d=structuredClone(original);d.tables.mice.push({mouse_sid:'OTHER',physical_tag:"PB'-M101",sex:'Male',date_of_birth:'2026-07-23'});assert.equal(cageSheetAnimals(d,{position:d.tables.locations[0]})[0].matchStatus,'ambiguous');
 const duplicate=structuredClone(original);duplicate.tables.locations[0].source_block_text=duplicate.tables.locations[0].source_block_text.replace("PB'-M102","PB'-M101");assert.equal(cageSheetAnimals(duplicate,{position:duplicate.tables.locations[0]})[0].matchStatus,'ambiguous');
 const wrongSid=structuredClone(original);wrongSid.tables.mice[0].mouse_sid='OTHER';assert.equal(cageSheetAnimals(wrongSid,{position:wrongSid.tables.locations[0]})[0].mouseSid,null);
});
test('explicit transfer still suppresses a renamed mouse only at its old source position',()=>{
 const d=editableDataset();editMouse(d,{physical_tag:'Renamed-M101'});d.tables.cages=[{cage_sid:'NEW',location_id:'NEXT'}];d.tables.mice[0].cage_sid='NEW';d.tables.mice[0].cage_sheet_overrides.cage_sid=true;
 assert.deepEqual(cageSheetAnimals(d,{position:d.tables.locations[0]}).map(row=>row.mouseSid),['102','103']);
 const next=cageSheetAnimals(d,{position:{location_id:'NEXT'},cage:d.tables.cages[0],mice:[d.tables.mice[0]]});assert.equal(next[0].tag,'Renamed-M101');assert.equal(next[0].mouseSid,'101');assert.equal(next[0].sourceCell,null);
});
