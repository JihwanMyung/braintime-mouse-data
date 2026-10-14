import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRecord} from '../web/model.js';
import {projectAnimalSheet,animalSheetPrintHTML} from '../web/animal-sheet-export.js';
import {projectRecords} from '../supabase/functions/sync-animal-sheet/projection.mjs';
const mouse={mouse_sid:'SYN-M',physical_tag:'P-M7',sex:'Male',state:'Stock',cage_sid:'SYN-C',manager:'Synthetic keeper'};
const dataset={tables:{mice:[mouse],cages:[{cage_sid:'SYN-C',cage_tag:'Synthetic cage',state:'Active',manager:'Synthetic keeper'}]}};
test('ear marking is optional independent identification with a 160 Unicode character limit',()=>{
 for(const value of [undefined,null,'','L0R1','Left notch; right hole','🐭'.repeat(160)]){
  const draft={...mouse,...(value===undefined?{}:{ear_mark:value})};assert.deepEqual(validateRecord('mice',draft,dataset,'SYN-M').errors,[]);assert.equal(draft.physical_tag,'P-M7');
 }
 for(const value of [4,true,{},[], 'x'.repeat(161),'🐭'.repeat(161)])assert.match(validateRecord('mice',{...mouse,ear_mark:value},dataset,'SYN-M').errors.join(' '),/Ear marking/);
});
test('Animal Sheet tables, spreadsheet map, PDF and managed sync retain explicit marks without inferring from tags',()=>{
 const marked={...mouse,ear_mark:'L0R1 <synthetic>'},data={tables:{...dataset.tables,mice:[marked]}},copy=structuredClone(data);
 const p=projectAnimalSheet(data,{capturedAt:'2026-10-15T01:00:00Z'}),mice=p.sheets.find(s=>s.rows[0]?.includes('ear_mark'));
 assert(mice);assert.equal(mice.rows[1][mice.rows[0].indexOf('ear_mark')],marked.ear_mark);
 assert(p.sheets.find(s=>s.name==='Animal Sheet').rows.some(row=>row.some(v=>typeof v==='string'&&v.includes('Ear: L0R1 <synthetic>'))));
 const html=animalSheetPrintHTML(p);assert.match(html,/Ear: L0R1 &lt;synthetic&gt;/);assert(!html.includes('L0R1 <synthetic>'));
 const records=Object.entries(data.tables).flatMap(([entity_type,rows])=>rows.map(payload=>({entity_type,payload,archived:false})));
 const grids=projectRecords(records,'2026-10-15T01:00:00Z');assert.equal(grids[1][0][2],'Ear marking');assert.equal(grids[1][1][2],marked.ear_mark);
 assert.deepEqual(data,copy);const empty=projectRecords([{entity_type:'mice',payload:mouse,archived:false}],'2026-10-15');assert.equal(empty[1][1][2],undefined);
});
