import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyntheticDataset,validateRecord} from '../web/model.js';
import {validateGeneticProfile} from '../web/genotype-schema.js';

const locus={id:'gene-a',name:'Gene A',kind:'flox',chromosome:'unknown',alleles:['+','fl']};
const profile=()=>({schema_version:1,loci:[structuredClone(locus)],calls:{'gene-a':{alleles:['fl','+'],evidence:'confirmed'}},notes:'Synthetic assay reviewed'});
const scenario=()=>({loci:[structuredClone(locus)],sire:{sex:'Male',calls:{'gene-a':{alleles:['fl','+'],evidence:'confirmed'}}},dam:{sex:'Female',calls:{'gene-a':{alleles:['fl','+'],evidence:'confirmed'}}},targets:{'gene-a':{mode:'exact',alleles:['fl','fl']}},sex:'Any',independentAssortment:true,desiredCount:2,confidence:0.95,litterSize:6});

test('structured calls preserve original text and source provenance',()=>{
 const d=createSyntheticDataset(),m=d.tables.mice[0];m.genotype='Unmodified source label';m.source_record_id='synthetic-source';
 const before=structuredClone(d),draft={...m,genetic_profile:profile()};
 assert.deepEqual(validateRecord('mice',draft,d,m.mouse_sid).errors,[]);
 assert.equal(draft.genotype,m.genotype);assert.equal(draft.source_record_id,m.source_record_id);assert.deepEqual(d,before);
 assert(validateRecord('mice',{...draft,source_record_id:'rewritten'},d,m.mouse_sid).errors.some(x=>/provenance/.test(x)));
});
test('profiles reject malformed, duplicate or contradictory declared calls',()=>{
 const p=profile();assert.deepEqual(validateGeneticProfile(p),[]);
 for(const change of [p=>p.schema_version=2,p=>p.loci.push({...locus}),p=>p.calls['gene-a'].alleles=['fl'],p=>p.calls['gene-a'].alleles=['null','+'],p=>p.calls['gene-a'].evidence='positive',p=>p.calls.other={alleles:[],evidence:'unknown'},p=>p.loci[0].id='__proto__',p=>p.loci[0].chromosome=1,p=>p.loci[0].chromosome=['1']]){
  const draft=profile();change(draft);assert(validateGeneticProfile(draft).length);
 }
 const unknown=profile();unknown.calls['gene-a']={alleles:[],evidence:'unknown'};assert.deepEqual(validateGeneticProfile(unknown),[]);
});
test('old profiles are retained on unrelated edits but invalid changes are rejected',()=>{
 const d=createSyntheticDataset(),m=d.tables.mice[0];m.genetic_profile={schema_version:99,legacy:'retained'};
 assert.deepEqual(validateRecord('mice',{...m,comment:'unrelated'},d,m.mouse_sid).errors,[]);
 assert(validateRecord('mice',{...m,genetic_profile:{schema_version:99,legacy:'changed'}},d,m.mouse_sid).errors.length);
});
test('saved plans validate prediction inputs without creating mice or matings',()=>{
 const d=createSyntheticDataset(),before=structuredClone(d);
 const event={event_id:'PLAN-SYNTHETIC',event_type:'breeding_plan',event_date:'2026-10-14',record_origin:'app_created',breeding_plan:{schema_version:1,name:'Synthetic target',scenario:scenario()}};
 assert(validateRecord('husbandry_events',{event_id:'PLAN-BAD',event_type:'breeding_plan'},d).errors.length);
 assert.deepEqual(validateRecord('husbandry_events',event,d).errors,[]);assert.deepEqual(d,before);
 event.breeding_plan.scenario.sire.calls['gene-a'].alleles=['unknown','unknown'];assert(validateRecord('husbandry_events',event,d).errors.length);
 event.breeding_plan.scenario=scenario();d.tables.husbandry_events.push(structuredClone(event));
 assert(validateRecord('husbandry_events',{...event,event_type:'Observation'},d,event.event_id).errors.some(x=>/retain/.test(x)));
});
