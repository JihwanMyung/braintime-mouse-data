import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDataset, validateRecord } from '../web/model.js';
import { discoverGenotypes } from '../web/genotype-catalog.js';

let instance=0;
const locus={id:'test-locus',name:'Assay locus',kind:'flox',chromosome:'1',alleles:['+','fl']};
const call=(alleles=['+','fl'],evidence='confirmed')=>({alleles,evidence});
const profile=(calls={'test-locus':call()},loci=[locus])=>({schema_version:1,loci:structuredClone(loci),calls:structuredClone(calls),recorded_at:'2025-01-01T00:00:00Z',notes:'Assay record'});
const mouse=(id,sex,extras={})=>({mouse_sid:id,sex,state:'Stock',genotype:'Untouched source text',date_of_birth:'2025-01-01',physical_tag:`Tag-${id}`,genetic_profile:profile(),...extras});
const scenario=()=>({loci:[structuredClone(locus)],sire:{id:'M1',sex:'Male',calls:{'test-locus':call()}},dam:{id:'F1',sex:'Female',calls:{'test-locus':call()}},targets:{'test-locus':{mode:'exact',alleles:['fl','fl']}},sex:'Any',independentAssortment:false,desiredCount:1,confidence:0.95,litterSize:6});
const plan=(value=scenario(),id='PLAN-SAVED')=>({event_id:id,event_type:'breeding_plan',event_date:'2025-01-02',record_origin:'app_created',notes:'Recorded cross',breeding_plan:{schema_version:1,name:'Recorded cross',scenario:structuredClone(value),created_at:'2025-01-02T00:00:00Z'}});

async function harness(t,tables={},overrides={}) {
  const {renderBreedingPlanner}=await import(`../web/breeding-planner.js?test=${++instance}`);
  const container={innerHTML:'',querySelectorAll(){return []},querySelector(selector){if(selector==='[data-planner-ranking]')return {remove:()=>{container.innerHTML=container.innerHTML.replace(/<div data-planner-ranking>[\s\S]*?<\/details><\/div>/,'')}};return null}};
  let dataset=normalizeDataset({tables:{mice:[mouse('M1','Male'),mouse('F1','Female')],husbandry_events:[plan()],...tables}});
  const saves=[],messages=[];
  const hooks={canEdit:()=>true,isCloud:()=>false,validate:validateRecord,toast:(message,error)=>messages.push({message,error}),openMouse:id=>messages.push({opened:id}),save:async next=>{dataset=structuredClone(next);saves.push(dataset);renderBreedingPlanner(container,dataset,hooks)},...overrides};
  renderBreedingPlanner(container,dataset,hooks);
  return {container,saves,messages,hooks,get dataset(){return dataset},
    async click(action,meta={}){await container.onclick({target:{closest:()=>({dataset:{plannerAction:action,...meta},disabled:false})}})},
    change(field,value,meta={}){container.onchange({target:{value,checked:Boolean(value),dataset:{plannerField:field,...meta}}})},
    input(field,value,meta={}){container.oninput({target:{value,dataset:{plannerField:field,...meta}}})},
    render(next=dataset){dataset=next;renderBreedingPlanner(container,dataset,hooks)},
    async load(id='PLAN-SAVED'){await this.click('load-plan',{id})},
    async savePlan(name='Saved test cross'){this.input('plan-name',name);await this.click('save-plan')}
  };
}

// These tests exercise real delegated UI handlers, genetics and model validation.
test('example is hypothetical, independent assortment must be acknowledged, and readonly users can calculate',async t=>{
  const h=await harness(t,{}, {canEdit:()=>false});
  assert.match(h.container.innerHTML,/Illustrative example · no colony parents assumed/);
  assert.doesNotMatch(h.container.innerHTML,/data-planner-action="save-plan"/);
  await h.click('calculate');assert.match(h.container.innerHTML,/Explicitly confirm independent assortment/);
  h.change('independent',true);await h.click('calculate');
  assert.match(h.container.innerHTML,/Target probability/);assert.equal((h.container.innerHTML.match(/data-outcome-row/g)||[]).length,27);
  await h.click('save-plan');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Edit access is required/);
});

test('saved parent snapshots recalculate and saving creates only a planning event',async t=>{
  const h=await harness(t);await h.load();
  assert.match(h.container.innerHTML,/Recalculated from saved parent-genotype snapshots/);
  assert.match(h.container.innerHTML,/>25%<\/strong>/);
  const originalMice=structuredClone(h.dataset.tables.mice);await h.savePlan('New cross');
  assert.equal(h.saves.length,1);assert.deepEqual(h.dataset.tables.mice,originalMice);
  assert.equal(h.dataset.tables.matings.length,0);assert.equal(h.dataset.tables.litters.length,0);
  const event=h.dataset.tables.husbandry_events.at(-1);assert.match(event.event_id,/^PLAN-/);assert.equal(event.event_type,'breeding_plan');assert.equal(event.breeding_plan.name,'New cross');assert.equal(event.breeding_plan.scenario.targets['test-locus'].mode,'exact');
});

test('reviewed genotype save preserves unrelated loci, source text and provenance',async t=>{
  const other={id:'other-locus',name:'Unrelated locus',kind:'other',chromosome:'2',alleles:['a','b']};
  const original=mouse('M1','Male',{source_filename:'Synthetic export.xlsx',source_row:7,genetic_profile:profile({'test-locus':call(),'other-locus':call(['a','b'])},[locus,other])});
  const h=await harness(t,{mice:[original,mouse('F1','Female')]});await h.load();await h.click('tab',{tab:'genotypes'});h.change('profile-mouse','M1');
  h.change('call','fl',{mode:'profile',role:'profile',locus:locus.id,index:'0'});
  assert.match(h.container.innerHTML,/<option value="inferred" selected>/);
  h.change('call','confirmed',{mode:'profile',role:'profile',locus:locus.id,index:'evidence'});h.input('profile-notes','Reviewed assay');await h.click('save-profile');
  assert.equal(h.saves.length,1);const saved=h.dataset.tables.mice[0];
  assert.deepEqual(saved.genetic_profile.calls[locus.id],call(['fl','fl']));assert.deepEqual(saved.genetic_profile.calls[other.id],original.genetic_profile.calls[other.id]);assert.deepEqual(saved.genetic_profile.loci.find(row=>row.id===other.id),other);
  assert.equal(saved.genotype,original.genotype);assert.equal(saved.source_filename,original.source_filename);assert.equal(saved.source_row,7);assert.equal(saved.genetic_profile.notes,'Reviewed assay');
});

test('missing, mismatched and unsupported profiles never become confirmed or wild type',async t=>{
  const h=await harness(t,{mice:[mouse('M1','Male',{genetic_profile:null}),mouse('F1','Female'),mouse('M2','Male',{genetic_profile:{...profile(),schema_version:99}}),mouse('M3','Male',{genetic_profile:profile({'test-locus':call()},[{...locus,name:'Different interpretation'}])})]});
  await h.load();h.change('parent','M1',{role:'sire'});await h.click('calculate');assert.match(h.container.innerHTML,/genotype evidence is unknown/);
  await h.click('tab',{tab:'candidates'});await h.click('rank');assert.match(h.container.innerHTML,/0 eligible pairs/);assert.match(h.container.innerHTML,/unsupported genotype profile version/);assert.match(h.container.innerHTML,/saved locus definition differs/);
});

test('editing real-parent alleles detaches the animal and downgrades previous confirmation',async t=>{
  const h=await harness(t);await h.load();h.change('call','fl',{mode:'cross',role:'sire',locus:locus.id,index:'0'});
  assert.match(h.container.innerHTML,/Edited calls are now a hypothetical sire/);await h.savePlan();
  const saved=h.dataset.tables.husbandry_events.at(-1).breeding_plan.scenario;
  assert.equal(saved.sire.id,undefined);assert.equal(saved.sire.calls[locus.id].evidence,'inferred');assert.deepEqual(h.dataset.tables.mice[0].genetic_profile.calls[locus.id],call());
});

test('candidate ranking respects Stock and confirmed calls, shows parent context and clears stale results',async t=>{
  const h=await harness(t,{mice:[mouse('M1','Male',{sire_sids:['P1']}),mouse('F1','Female',{sire_sids:['P1','P2']}),mouse('M2','Male',{genetic_profile:profile({'test-locus':call(['+','fl'],'inferred')})}),mouse('M3','Male',{state:'Ended'}),mouse('M4','Male',{app_archived_at:'2025-01-01'})],matings:[{mating_sid:'B1',state:'Active',male_sids:['M1'],female_sids:['F1']}]});
  await h.load();await h.click('tab',{tab:'candidates'});await h.click('rank');
  assert.match(h.container.innerHTML,/1 eligible pairs/);assert.match(h.container.innerHTML,/Tag-M1/);assert.match(h.container.innerHTML,/DOB 2025-01-01/);assert.match(h.container.innerHTML,/Active mating: B1/);assert.match(h.container.innerHTML,/Shared recorded parent: P1/);assert.match(h.container.innerHTML,/Parent fields contain alternatives/);assert.match(h.container.innerHTML,/inferred calls are excluded/);
  h.input('candidate-search','absent');assert.doesNotMatch(h.container.innerHTML,/data-planner-action="use-pair"/);
  await h.click('use-pair',{sire:'M1',dam:'F1'});assert.match(h.container.innerHTML,/Compare candidates again/);
  h.change('candidate-search','');await h.click('rank');await h.load();await h.click('tab',{tab:'candidates'});assert.doesNotMatch(h.container.innerHTML,/1 eligible pairs/);
});

test('source catalogue additions start unknown and explicit source suggestions remain inferred',async t=>{
  const h=await harness(t,{mice:[mouse('100','Male',{genotype:'Bmal1(fl/+)',genetic_profile:null}),mouse('200','Female',{genotype:'Bmal1',genetic_profile:null})],historical_observations:[{observation_id:'OBS1',raw_text:'M100: source note including cage mates',source_title:'Synthetic sheet',source_sheet:'Room',source_cell:'A1',source_url:'https://example.org/source'}]});
  const entry=discoverGenotypes(h.dataset).find(row=>row.name==='Bmal1');assert(entry);
  assert.doesNotMatch(h.container.innerHTML,/Illustrative example · no colony parents assumed/);assert.match(h.container.innerHTML,/data-planner-catalogue open/);
  await h.click('clear-loci');await h.click('catalogue-locus',{locus:entry.id});h.change('parent','100',{role:'sire'});h.change('parent','200',{role:'dam'});
  assert.match(h.container.innerHTML,/Linked Animal Sheet excerpts \(1\)/);assert.match(h.container.innerHTML,/They do not confirm this animal/);
  await h.click('source-parent',{role:'sire'});assert.match(h.container.innerHTML,/loaded as inferred/);
  await h.click('calculate');assert.match(h.container.innerHTML,/Dam, Bmal1: genotype evidence is unknown/);assert.equal(h.saves.length,0);
  await h.click('tab',{tab:'genotypes'});h.change('profile-mouse','100');await h.click('source-profile');await h.click('save-profile');
  assert.equal(h.saves.length,1);assert.equal(h.dataset.tables.mice[0].genetic_profile.calls[entry.id].evidence,'inferred');assert.equal(h.dataset.tables.mice[0].genotype,'Bmal1(fl/+)');
});

test('readonly genotype editor and malformed imported profiles stay safe',async t=>{
  const h=await harness(t,{mice:[mouse('M1','Male',{genetic_profile:{schema_version:1,loci:{bad:true},calls:7,notes:[]}})]},{canEdit:()=>false,initialMouseId:'M1'});
  assert.match(h.container.innerHTML,/Read only/);assert.doesNotMatch(h.container.innerHTML,/data-planner-action="save-profile"/);
  await h.click('save-profile');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Edit access is required/);
});

test('profile drafts refresh after a dataset reload instead of overwriting newer calls',async t=>{
  const h=await harness(t);await h.load();await h.click('tab',{tab:'genotypes'});h.change('profile-mouse','M1');h.input('profile-notes','Old unsaved draft');
  const fresh=structuredClone(h.dataset);fresh.tables.mice[0].genetic_profile.calls[locus.id]=call(['fl','fl']);fresh.tables.mice[0].genetic_profile.notes='New shared assay';h.render(fresh);
  assert.match(h.container.innerHTML,/Genotype editor refreshed/);assert.match(h.container.innerHTML,/New shared assay/);assert.doesNotMatch(h.container.innerHTML,/Old unsaved draft/);
  await h.click('save-profile');assert.deepEqual(h.dataset.tables.mice[0].genetic_profile.calls[locus.id],call(['fl','fl']));assert.equal(h.dataset.tables.mice[0].genetic_profile.notes,'New shared assay');
});

test('locus interpretation changes invalidate confirmed calls and displayed results',async t=>{
  const h=await harness(t);await h.load();assert.match(h.container.innerHTML,/planner-results/);
  h.change('locus','New interpretation',{locus:locus.id,key:'name'});assert.doesNotMatch(h.container.innerHTML,/planner-results/);
  await h.click('calculate');assert.match(h.container.innerHTML,/genotype evidence is unknown/);
  await h.savePlan();assert.equal(h.saves.length,0);
});

test('large outcome tables show at most64 rows, reused offspring are inferred hypothetical calls',async t=>{
  const s=scenario();s.loci=Array.from({length:6},(_,index)=>({...locus,id:'L'+index,name:'Locus '+index,chromosome:String(index+1)}));s.independentAssortment=true;s.targets={};
  for(const role of ['sire','dam'])s[role].calls=Object.fromEntries(s.loci.map(locus=>[locus.id,call()]));
  const h=await harness(t,{husbandry_events:[plan(s)]});await h.load();assert.equal((h.container.innerHTML.match(/data-outcome-row/g)||[]).length,64);assert.match(h.container.innerHTML,/Showing 64 of 729/);
  await h.click('offspring',{role:'sire',index:'0'});await h.savePlan();
  const saved=h.dataset.tables.husbandry_events.at(-1).breeding_plan.scenario;assert.equal(saved.sire.id,undefined);assert(Object.values(saved.sire.calls).every(row=>row.evidence==='inferred'));assert.equal(h.dataset.tables.mice.length,2);
});

test('untrusted labels are escaped and loading an optional history index preserves the scenario',async t=>{
  const h=await harness(t,{mice:[mouse('M1','Male',{genotype:'<script>unsafe()</script>',physical_tag:'<b>tag</b>'}),mouse('F1','Female')]});await h.load();
  assert.match(h.container.innerHTML,/&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);assert.doesNotMatch(h.container.innerHTML,/<script>unsafe/);
  h.input('plan-name','Keep this draft');h.hooks.historyIndex={sources:[{title:'Synthetic source',url:'https://example.org'}],sheets:[{title:'Legends',source_index:0,sheet_id:1}],cells:[[0,'A1','Vip-Cre',null,null,null]]};h.render();
  assert.match(h.container.innerHTML,/Keep this draft/);assert.match(h.container.innerHTML,/Vip-Cre/);assert.match(h.container.innerHTML,/>25%<\/strong>/);
});

test('direct mouse review uses saved locus definitions and never fills hypothetical parents',async t=>{
  const h=await harness(t,{}, {initialMouseId:'M1'});
  assert.match(h.container.innerHTML,/Assay locus/);assert.doesNotMatch(h.container.innerHTML,/Example floxed locus/);
  assert.match(h.container.innerHTML,/<option value="confirmed" selected>/);
  await h.click('tab',{tab:'cross'});await h.click('calculate');assert.match(h.container.innerHTML,/Sire, Assay locus: genotype evidence is unknown/);
});

test('refreshed archived or corrected-sex parents are detached from current scenarios',async t=>{
  const h=await harness(t);await h.load();h.change('parent','M1',{role:'sire'});
  const fresh=structuredClone(h.dataset);fresh.tables.mice[0].sex='Female';h.render(fresh);
  assert.match(h.container.innerHTML,/selected sire is no longer eligible/);await h.click('calculate');assert.match(h.container.innerHTML,/Sire, Assay locus: genotype evidence is unknown/);
  assert.doesNotMatch(h.container.innerHTML,/<option value="M1" selected>/);
});

test('failed persistence retains genotype draft and does not replace the source dataset',async t=>{
  const h=await harness(t,{}, {save:async()=>{throw new Error('Synthetic version conflict')}});await h.load();await h.click('tab',{tab:'genotypes'});h.change('profile-mouse','M1');h.input('profile-notes','Unsaved reviewed notes');await h.click('save-profile');
  assert.match(h.container.innerHTML,/Synthetic version conflict/);assert.match(h.container.innerHTML,/Unsaved reviewed notes/);assert.equal(h.dataset.tables.mice[0].genetic_profile.notes,'Assay record');assert.doesNotMatch(h.container.innerHTML,/aria-busy="true"/);
});

test('direct mouse review rejects malformed chromosome objects without coercing source data',async t=>{
  const broken=mouse('M1','Male',{genetic_profile:profile({'test-locus':call()},[{...locus,chromosome:{toString:null}}])});
  const h=await harness(t,{mice:[broken]},{initialMouseId:'M1'});
  assert.match(h.container.innerHTML,/Add loci in Cross planner/);assert.equal(h.saves.length,0);assert.deepEqual(h.dataset.tables.mice[0].genetic_profile.loci[0].chromosome,{toString:null});
});
