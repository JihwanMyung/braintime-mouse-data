import test from 'node:test';
import assert from 'node:assert/strict';
import {projectAnimalSheet,createAnimalSheetXlsx,createWorkbookXlsx,animalSheetPrintHTML} from '../web/animal-sheet-export.js';

const capturedAt='2026-10-14T16:30:00Z'; // October 15 in Taipei.
const fixture=()=>({tables:{
  rooms:[{room_id:'R1',name:'Main & room'},{room_id:'R2',name:'Empty room'}],
  racks:[{rack_id:'K1',room_id:'R1',name:'Rack A'},{rack_id:'K2',room_id:'R1',name:'Empty rack'}],
  locations:[{location_id:'P1',room_id:'R1',rack_id:'K1',label:'A1',row:0,column:0,record_origin:'app_created'},
    {location_id:'P2',room_id:'R1',rack_id:'K1',label:'A2',row:0,column:3,record_origin:'app_created'},
    {location_id:'P3',room_id:'R1',rack_id:'K1',label:'B1',row:2,column:0,source_observed_mouse_sids:['old-roster'],source_observed_tags:['M99']},
    {location_id:'P4',room_id:'R1',rack_id:'K1',label:'Inactive linked',row:2,column:3,record_origin:'app_created'}],
  cages:[{cage_sid:'001',cage_tag:'Cage A',state:'Active',location_id:'P1',listed_mouse_sids:['old-roster']},
    {cage_sid:'002',state:'Inactive',location_id:'P4'},{cage_sid:'historical',state:'Inactive'}],
  mice:[{mouse_sid:'0001',physical_tag:'M01',sex:'Male',state:'Stock',cage_sid:'001',owner:'Alex (Me)',genotype:'Gene(+/-)',date_of_birth:'2026-09-01'},
    {mouse_sid:'0002',state:'Stock',cage_sid:'001',owner:'Bea',date_of_birth:'2026-09-02'},
    {mouse_sid:'old-roster',state:'Ended',cage_sid:'001',genotype:'DO NOT CALL CURRENT'},
    {mouse_sid:'archived',state:'Stock',cage_sid:'001',app_archived_at:'2026-10-01'},
    {mouse_sid:'derived-resident',state:'Stock',cage_sid:'unknown-cage',owner:'Alex'},
    {mouse_sid:'uncaged',state:'Stock',cage_sid:null}],
  light_events:[{event_id:'L1',room_id:'R1',start_date:'2026-10-15',protocol:'LD',cycle_hours:24,light_hours:0,intensity_lux:0,lights_on:'08:00',lights_off:'08:00',timezone:'Asia/Taipei'},
    {event_id:'exclusive',location_id:'P1',start_date:'2026-01-01',end_date:'2026-10-15',interval_semantics:'exclusive',protocol:'OLD'},
    {event_id:'inclusive',location_id:'P1',start_date:'2026-10-15',end_date:'2026-10-15',protocol:'NEW',evidence_status:'planned'},
    {event_id:'undated',location_id:'P1',protocol:'UNKNOWN'},
    {event_id:'future',location_id:'P1',start_date:'2026-12-01',protocol:'FUTURE'}],
  husbandry_events:[{event_id:'H1',cage_sid:'001',event_date:'2026-10-01',event_type:'observation'},
    {event_id:'H2',cage_sid:'001',event_date:'2020-01-01',event_type:'observation'}]
}});

function entries(blob){return blob.arrayBuffer().then(buffer=>{
  const b=new Uint8Array(buffer),v=new DataView(buffer),out=new Map();let at=0;
  while(v.getUint32(at,true)===0x04034b50){
    assert.equal(v.getUint16(at+8,true),0,'ZIP method is stored');
    const size=v.getUint32(at+18,true),nameLength=v.getUint16(at+26,true),extra=v.getUint16(at+28,true),name=new TextDecoder().decode(b.subarray(at+30,at+30+nameLength)),start=at+30+nameLength+extra;
    out.set(name,new TextDecoder().decode(b.subarray(start,start+size)));at=start+size;
  }
  assert.equal(v.getUint32(at,true),0x02014b50);assert.equal(v.getUint32(b.length-22,true),0x06054b50);
  assert.equal(v.getUint16(b.length-14,true),out.size);return out;
});}

test('current map preserves Stock only, explicit empty positions, source evidence, inactive links and empty hierarchy',()=>{
  const d=fixture(),before=structuredClone(d),p=projectAnimalSheet(d,{capturedAt});
  assert.deepEqual(d,before);assert.equal(p.counts.mice,4);assert.equal(p.counts.cages,3);
  assert.equal(p.rows.find(r=>r.locationId==='P2').state,'Empty position');
  assert.equal(p.rows.find(r=>r.locationId==='P3').state,'Unlinked source position');
  assert.deepEqual(p.rows.find(r=>r.locationId==='P3').mice,[]);
  assert.equal(p.rows.find(r=>r.locationId==='P4').state,'Inactive');
  assert.ok(p.rows.find(r=>r.cageId==='unknown-cage').cage._derived);
  assert.equal(p.rows.find(r=>r.kind==='unassigned').mice[0].mouse_sid,'uncaged');
  assert.ok(p.groups.some(g=>g.rackId==='K2'&&g.items.length===0));
  assert.ok(p.groups.some(g=>g.roomId==='R2'&&g.items.length===0));
  assert.ok(!p.rows.some(r=>r.cageId==='historical'));
  assert.deepEqual(p.rows.find(r=>r.cageId==='001').mice.map(m=>m.mouse_sid),['0001','0002']);
});

test('manager resolution uses all current residents even when export selects one mouse',()=>{
  const p=projectAnimalSheet(fixture(),{capturedAt,mouseIds:['0001']});
  assert.equal(p.counts.mice,1);assert.equal(p.counts.cages,1);assert.equal(p.counts.positions,1);
  const row=p.rows[0];assert.equal(row.totalStockCount,2);assert.equal(row.manager.status,'conflict');assert.deepEqual(row.manager.candidates,['Alex','Bea']);
  assert.match(animalSheetPrintHTML(p),/1 selected \/ 2 total/);
  const uncaged=projectAnimalSheet(fixture(),{capturedAt,mouseIds:['uncaged']});assert.equal(uncaged.rows[0].kind,'unassigned');
});

test('withdrawn source grids are absent from the current board and export without hiding registered animals',()=>{
  const d=fixture();for(const position of d.tables.locations)if(['P1','P3','P4'].includes(position.location_id))position.source_current=false;
  const before=structuredClone(d),p=projectAnimalSheet(d,{capturedAt}),resident=p.rows.find(r=>r.cageId==='001');
  assert.equal(p.counts.mice,4);assert.equal(p.counts.positions,1);assert.equal(resident.mice.length,2);
  assert.equal(resident.locationId,'');assert.equal(resident.position,null);assert.equal(resident.row,null);assert.equal(resident.column,null);
  assert.equal(resident.positionName,'Position needs review');assert.match(resident.warnings.join(' '),/withdrawn position A1/);
  assert.ok(!p.rows.some(r=>['P1','P3','P4'].includes(r.locationId)));assert.ok(!p.rows.some(r=>r.cageId==='002'));
  assert.deepEqual(p.sheets.find(s=>s.name==='locations').rows.slice(1).map(row=>row[0]),['P2']);
  assert.equal(p.rows.find(r=>r.cageId==='001').cage.location_id,'P1','raw assignment remains available for correction');
  assert.deepEqual(d,before);
});

test('scope filters intersect exactly and retain leading zeros',()=>{
  const d=fixture();
  assert.equal(projectAnimalSheet(d,{capturedAt,roomId:'R1',rackId:'K1',cageIds:['001']}).counts.mice,2);
  assert.equal(projectAnimalSheet(d,{capturedAt,cageIds:['1']}).counts.mice,0);
  assert.equal(projectAnimalSheet(d,{capturedAt,roomId:'R2',cageIds:['001']}).counts.cages,0);
  assert.equal(projectAnimalSheet(d,{capturedAt,mouseIds:['uncaged'],cageIds:['001']}).counts.mice,0);
});

test('schedule applicability respects local date, exclusive end, unknown dates, overlap and numeric zero',()=>{
  const row=projectAnimalSheet(fixture(),{capturedAt}).rows.find(r=>r.cageId==='001');
  assert.deepEqual(row.applicableLights.map(e=>e.event_id),['L1','inclusive']);
  assert.deepEqual(row.undatedLights.map(e=>e.event_id),['undated']);
  assert.ok(row.warnings.some(w=>w.includes('Overlapping')));
  const html=animalSheetPrintHTML(projectAnimalSheet(fixture(),{capturedAt}));
  assert.match(html,/light 0 h/);assert.match(html,/0 lux/);assert.match(html,/Exposure unverified/);assert.match(html,/Planned/);
  assert.doesNotMatch(html,/FUTURE|DO NOT CALL CURRENT/);
});

test('dangling, archived, conflicting and duplicate housing links are retained with review warnings',()=>{
  const d=fixture();d.tables.rooms[0].archived=true;
  d.tables.cages[0].room_id='R2';d.tables.cages[0].rack_id='missing';d.tables.cages[0].app_archived_at='2026-10-01';
  d.tables.cages.push({cage_sid:'another',state:'Active',location_id:'P1'});
  const p=projectAnimalSheet(d,{capturedAt}),r=p.rows.find(r=>r.cageId==='001');
  assert.equal(r.roomId,'R2');assert.equal(r.rackId,'missing');assert.equal(r.mice.length,2);
  assert.match(r.warnings.join(';'),/Unknown rack/);assert.match(r.warnings.join(';'),/room references disagree/);
  assert.match(r.warnings.join(';'),/archived cage/);assert.match(r.warnings.join(';'),/Multiple cages/);
  assert.match(p.rows.find(r=>r.cageId==='another').warnings.join(';'),/room is archived/);
});

test('date range limits supporting records without claiming a historical housing reconstruction',()=>{
  const p=projectAnimalSheet(fixture(),{capturedAt,dateFrom:'2026-09-01',dateTo:'2026-10-14',entityTypes:['mice','locations','husbandry_events']});
  assert.equal(p.counts.mice,4);
  assert.equal(p.sheets.find(s=>s.name==='mice').rows.length,3);
  assert.equal(p.sheets.find(s=>s.name==='locations').rows.length,5);
  assert.deepEqual(p.sheets.find(s=>s.name==='husbandry events').rows.slice(1).map(row=>row[0]),['H1']);
  assert.ok(p.warnings.some(w=>w.includes('not past occupancy')));
  assert.throws(()=>projectAnimalSheet(fixture(),{dateFrom:'2026-02-30'}),/date range/);
  assert.throws(()=>projectAnimalSheet(fixture(),{dateFrom:'2026-10-15',dateTo:'2026-10-14'}),/date range/);
  assert.throws(()=>projectAnimalSheet(fixture(),{entityTypes:['raw_secret_table']}),/supported entity/);
});

test('invalid time zones use the server Taipei fallback explicitly and import dates never become event dates',()=>{
  const d=fixture();d.tables.light_events=[{event_id:'invalid-zone',location_id:'P1',start_date:'2026-10-15',timezone:'Not/AZone',protocol:'LD'}];
  d.tables.husbandry_events.push({event_id:'undated-import',cage_sid:'001',app_created_at:'2026-10-01T00:00:00Z',created_date:'2026-10-01'});
  const p=projectAnimalSheet(d,{capturedAt,dateFrom:'2026-01-01',dateTo:'2026-10-15',entityTypes:['husbandry_events']});
  assert.equal(p.rows.find(r=>r.cageId==='001').applicableLights[0].event_id,'invalid-zone');
  assert.match(animalSheetPrintHTML(p),/Invalid zone Not\/AZone; date interpreted in Asia\/Taipei/);
  assert.deepEqual(p.sheets.find(s=>s.name==='husbandry events').rows.slice(1).map(r=>r[0]),['H1']);
});

test('rack-specific lighting stays in that rack, including records without a room ID',()=>{
  const d=fixture();d.tables.locations.push({location_id:'P5',room_id:'R1',rack_id:'K2',label:'Second rack',row:0,column:0,record_origin:'app_created'});
  d.tables.light_events=[{event_id:'rack-and-room',room_id:'R1',rack_id:'K1',start_date:'2026-01-01'},
    {event_id:'rack-only',rack_id:'K1',start_date:'2026-01-01'},
    {event_id:'other-rack',room_id:'R1',rack_id:'K2',start_date:'2026-01-01'}];
  const all=projectAnimalSheet(d,{capturedAt});
  assert.deepEqual(all.rows.find(r=>r.locationId==='P1').applicableLights.map(e=>e.event_id),['rack-and-room','rack-only']);
  assert.deepEqual(all.rows.find(r=>r.locationId==='P5').applicableLights.map(e=>e.event_id),['other-rack']);
  const scoped=projectAnimalSheet(d,{capturedAt,rackId:'K1'});
  assert.deepEqual(scoped.sheets.find(s=>s.name==='light events').rows.slice(1).map(r=>r[0]),['rack-and-room','rack-only']);
});

test('rack form preserves coordinate zero and sparse row/column geometry without inventing positions',()=>{
  const d=fixture();d.tables.locations=d.tables.locations.filter(p=>p.location_id!=='P4');d.tables.cages=d.tables.cages.filter(c=>c.cage_sid!=='002');
  const p=projectAnimalSheet(d,{capturedAt}),html=animalSheetPrintHTML(p);
  assert.match(html,/Recorded row 0/);assert.match(html,/Recorded column 0/);assert.match(html,/Recorded column 3/);
  assert.match(html,/No position record/);assert.match(html,/Unlinked source position/);
  const form=p.sheets.find(s=>s.name==='Animal Sheet');assert.equal(form.widths.length,12);assert.ok(form.merges.length>5);
  assert.ok(form.rows.some(row=>String(row[0]).includes('Recorded row 0')));
});

test('real OOXML workbook packages strings literally, Unicode, booleans and numbers without formulas',async()=>{
  const blob=createWorkbookXlsx({capturedAt,title:'QA <literal>',sheets:[{name:'IDs / 記錄',rows:[['ID','Text','Count','Flag'],['0007','=HYPERLINK("https://invalid")',0,false],['鼠 & <tag>','+SUM(1,2)',1,true]]}]});
  assert.equal(blob.type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const files=await entries(blob),sheet=files.get('xl/worksheets/sheet1.xml');
  assert.match(sheet,/<c r="A2" s="0" t="inlineStr"><is><t xml:space="preserve">0007<\/t>/);
  assert.match(sheet,/=HYPERLINK\(&quot;https:\/\/invalid&quot;\)/);assert.doesNotMatch(sheet,/<f[ >]/);
  assert.match(sheet,/鼠 &amp; &lt;tag&gt;/);assert.match(sheet,/<c r="C2" s="0"><v>0<\/v>/);assert.match(sheet,/t="b"><v>0<\/v>/);
  assert.match(files.get('xl/workbook.xml'),/IDs   記錄/);assert.match(files.get('docProps/core.xml'),/QA &lt;literal&gt;/);
  assert.ok(files.has('[Content_Types].xml'));assert.ok(files.has('xl/styles.xml'));
});

test('worksheet names are legal and unique and large-cell data loss is rejected',async()=>{
  const files=await entries(createWorkbookXlsx({sheets:[{name:'a/b',rows:[['x']]},{name:'a:b',rows:[['y']]},{name:'A B',rows:[['z']]}]}));
  assert.match(files.get('xl/workbook.xml'),/name="a b"/);assert.match(files.get('xl/workbook.xml'),/name="a b \(2\)"/);assert.match(files.get('xl/workbook.xml'),/name="A B \(3\)"/);
  assert.throws(()=>createWorkbookXlsx({sheets:[{name:'Long',rows:[['x'.repeat(32768)]]}]}),/cell A1.*32,767.*JSON/);
  assert.throws(()=>createWorkbookXlsx({sheets:[{rows:[Array(16385).fill('')]}]}),/column limit/);
  assert.throws(()=>createWorkbookXlsx({sheets:[]}),/at least one/);
});

test('full current workbook and generic history print work without DOM or external library',async()=>{
  const p=projectAnimalSheet(fixture(),{capturedAt}),files=await entries(createAnimalSheetXlsx(p));
  assert.equal([...files.keys()].filter(name=>name.startsWith('xl/worksheets/')).length,p.sheets.length);
  assert.match(files.get('xl/worksheets/sheet2.xml'),/<mergeCells/);assert.match(files.get('xl/worksheets/sheet2.xml'),/fitToWidth="1"/);
  const html=animalSheetPrintHTML({title:'History',capturedAt,sheets:[{name:'events',rows:[['ID','notes'],['001','<script>alert(1)</script>']]}]},{logoUrl:'javascript:alert(1)'});
  assert.doesNotMatch(html,/<script>|src="javascript:/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Save as PDF/);
});

test('print breaks large uncaged cohorts into continued cards without dropping mice',()=>{
  const d={tables:{mice:Array.from({length:21},(_,i)=>({mouse_sid:`X${String(i).padStart(2,'0')}`,state:'Stock'}))}};
  const html=animalSheetPrintHTML(projectAnimalSheet(d,{capturedAt}));
  assert.equal((html.match(/class="cage"/g)||[]).length,3);assert.equal((html.match(/\(continued\)/g)||[]).length,2);
  for(const mouse of d.tables.mice)assert.ok(html.includes(`<b>${mouse.mouse_sid}</b>`));
});
