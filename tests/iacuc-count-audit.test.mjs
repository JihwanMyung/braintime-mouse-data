import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIacuc} from '../web/iacuc-model.js';
const protocol={event_id:'P1',event_type:'iacuc_protocol',iacuc_protocol:{schema_version:1,protocol_id:'P1',number:'SYNTHETIC-1',status:'approved',start_date:'2026-01-01',end_date:'2027-01-01'}};
const options={today:'2026-10-15'};
function fixture(){return {tables:{mice:[{mouse_sid:'M1',state:'Stock',date_of_birth:'2026-01-01'},{mouse_sid:'M2',state:'Stock',date_of_birth:'2026-01-01'}],cages:[],matings:[],litters:[],husbandry_events:[structuredClone(protocol)]}}}
const experiment=(id,mouse,day)=>({event_id:id,event_type:'experiment',event_date:day,experiment:{status:'completed',protocol:'SYNTHETIC-1',participants:[{mouse_sid:mouse,link_status:'confirmed'}]}});
await test('future completed/usage/birth dates are review issues, not current animal-use totals',()=>{
 const d=fixture();d.tables.husbandry_events.push(experiment('PAST','M1','2026-10-01'),experiment('FUTURE','M2','2026-12-01'),{event_id:'FUTURE-USE',event_type:'iacuc_usage',event_date:'2026-12-02',iacuc_usage:{protocol_id:'P1',category:'used',mouse_sids:['M2'],event_date:'2026-12-02',evidence_status:'confirmed',unregistered_count:0}});
 d.tables.mice.push({mouse_sid:'FUTURE-PUP',date_of_birth:'2026-12-01',litter_sid:'L-FUTURE'});d.tables.litters.push({litter_sid:'L-FUTURE',date_of_birth:'2026-12-01',protocol:'SYNTHETIC-1'});
 const s=summarizeIacuc(d,'P1',options);assert.equal(s.used,1);assert.equal(s.bred,0);assert(s.issues.some(i=>/future/i.test(i.reason)));
});
await test('a litter inherits its recorded mating protocol without inferring offspring from reported totals',()=>{
 const d=fixture();d.tables.matings.push({mating_sid:'MATING1',protocol:'SYNTHETIC-1',state:'Active'});d.tables.litters.push({litter_sid:'L1',mating_sid:'MATING1',date_of_birth:'2026-10-01',size_reported:4});d.tables.mice.push({mouse_sid:'PUP1',litter_sid:'L1',date_of_birth:'2026-10-01'});
 const s=summarizeIacuc(d,'P1',options);assert.equal(s.bred,1);assert.deepEqual(s.bredIds,['PUP1']);assert(s.unidentified.some(i=>i.source==='litter:L1'&&i.count===3));
});
await test('repeated experiments and explicit usage deduplicate a real mouse while anonymous counts remain separate',()=>{
 const d=fixture();d.tables.husbandry_events.push(experiment('E1','M1','2026-10-01'),experiment('E2','M1','2026-10-02'),{event_id:'USE',event_type:'iacuc_usage',event_date:'2026-10-03',iacuc_usage:{protocol_id:'P1',category:'used',mouse_sids:['M1'],event_date:'2026-10-03',evidence_status:'confirmed',unregistered_count:3}});
 const s=summarizeIacuc(d,'P1',options);assert.equal(s.used,1);assert.equal(s.uniqueRecordedAnimals,1);assert.equal(s.unidentified[0].count,3);
});
