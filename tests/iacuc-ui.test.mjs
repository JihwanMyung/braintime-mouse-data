import test from 'node:test';
import assert from 'node:assert/strict';
import {renderIacuc,iacucHelpHTML} from '../web/iacuc.js';

const clone=structuredClone;
const protocol=(id='P1',overrides={})=>({event_id:id,event_type:'iacuc_protocol',event_date:'2026-01-01',iacuc_protocol:{schema_version:1,protocol_id:id,number:'LAC2026-001',aliases:[],title:'Circadian experiment',pi:'PI',status:'approved',start_date:'2026-01-01',end_date:'2026-12-31',approved_animals:100,allocations:[{approved:100,portal_used:12}],source_url:'https://example.test/protocol',source_accessed_at:'2026-10-15',document:{text:'Original <script>do not run</script>'},sections:{aims:'Determine biological timing'},notes:null,...overrides}});
const base=()=>({tables:{husbandry_events:[protocol()],mice:[{mouse_sid:'M1',physical_tag:'P1',state:'Stock',date_of_birth:'2026-01-01'},{mouse_sid:'M2',physical_tag:'B2',state:'Stock',date_of_birth:'2026-02-01'}],cages:[{cage_sid:'C1',cage_tag:'Cage 1'}],matings:[],litters:[]}});
function harness(dataset=base(),overrides={}){
  const container={innerHTML:''},saves=[],messages=[];let current=dataset;
  const hooks={canEdit:()=>true,nowDate:()=> '2026-10-15',save:async next=>{current=clone(next);saves.push(current);renderIacuc(container,current,hooks);},toast:x=>messages.push(x),openMouse:id=>messages.push({mouse:id}),openCage:id=>messages.push({cage:id}),...overrides};
  renderIacuc(container,current,hooks);
  return {container,hooks,saves,messages,get dataset(){return current;},click(action,id=''){container.onclick({preventDefault(){},target:{closest:()=>({dataset:{iacucAction:action,id}})}});},
    set(key,value){assert.ok(container.innerHTML.includes(`data-iacuc-field="${key}"`),`Missing field ${key}`);container.oninput({target:{dataset:{iacucField:key},value}});},
    multi(key,values){container.onchange({target:{dataset:{iacucField:key},multiple:true,selectedOptions:values.map(value=>({value}))}});},
    check(key,checked){container.onchange({target:{dataset:{iacucField:key},type:'checkbox',checked}});},
    async save(design=false){await container.onsubmit({preventDefault(){},submitter:design?{dataset:{iacucSave:'true'}}:null,target:{hasAttribute:key=>key===(design?'data-iacuc-design-form':'data-iacuc-form')}});},
    render(next=current){current=next;renderIacuc(container,current,hooks);}
  };
}

test('protocol source text is escaped, portal counts stay separate, and imported approval cannot be edited',async()=>{
  const h=harness(),before=clone(h.dataset);
  assert.match(h.container.innerHTML,/Original &lt;script&gt;do not run&lt;\/script&gt;/);
  assert.match(h.container.innerHTML,/Confirmed used/);assert.match(h.container.innerHTML,/Identified births/);assert.match(h.container.innerHTML,/Portal reported used/);
  assert.match(h.container.innerHTML,/Missing history is not zero use/);
  assert.doesNotMatch(h.container.innerHTML,/data-iacuc-action="edit-protocol"/);
  h.click('edit-protocol','P1');assert.match(h.container.innerHTML,/read-only/);
  await h.save();assert.equal(h.saves.length,0);assert.deepEqual(h.dataset,before);
});

test('Use as draft makes a distinct unapproved proposal and preserves the source document',async()=>{
  const h=harness(),source=clone(h.dataset.tables.husbandry_events[0]);h.click('copy-protocol','P1');
  assert.match(h.container.innerHTML,/DRAFT-2026-10-15/);h.set('number','DRAFT-CIRCADIAN-2');h.set('title','Revised circadian proposal');h.set('section_aims','New proposed aim');await h.save();
  assert.equal(h.saves.length,1);const rows=h.dataset.tables.husbandry_events;
  assert.deepEqual(rows.find(r=>r.event_id==='P1'),source);
  const draft=rows.find(r=>r.event_id!=='P1');assert.equal(draft.iacuc_protocol.status,'draft');assert.equal(draft.iacuc_protocol.approved_animals,null);
  assert.equal(draft.iacuc_protocol.document,null);assert.equal(draft.iacuc_protocol.source_url,null);assert.equal(draft.iacuc_protocol.start_date,null);
  assert.equal(draft.iacuc_protocol.protocol_id,draft.event_id);assert.equal(draft.iacuc_protocol.sections.aims,'New proposed aim');
});

test('local draft fields persist across errors and a valid draft uses model validation',async()=>{
  const h=harness();h.click('new-protocol');h.set('number','DRAFT-1');h.set('title','Local plan');h.set('start_date','2026-12-31');h.set('end_date','2026-01-01');await h.save();
  assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Check the protocol start and end dates/);assert.match(h.container.innerHTML,/value="Local plan"/);
  h.set('end_date','2027-01-01');await h.save();assert.equal(h.saves.length,1);
  const draft=h.dataset.tables.husbandry_events.find(r=>r.iacuc_protocol?.number==='DRAFT-1');h.click('edit-protocol',draft.event_id);h.set('title','Updated local draft');await h.save();
  assert.equal(h.dataset.tables.husbandry_events.filter(r=>r.event_id===draft.event_id).length,1);
  assert.equal(h.dataset.tables.husbandry_events.find(r=>r.event_id===draft.event_id).iacuc_protocol.title,'Updated local draft');
});

test('assignments require exact records and confirmation; assigning a cage does not imply used animals',async()=>{
  const h=harness();h.click('new-assignment');h.set('entity_type','cages');h.set('entity_id','C1');await h.save();
  let row=h.dataset.tables.husbandry_events.find(r=>r.event_type==='iacuc_assignment');assert.equal(row.iacuc_assignment.evidence_status,'unresolved');assert.equal(row.iacuc_assignment.entity_id,'C1');
  h.click('tab','assignments');assert.match(h.container.innerHTML,/Review \/ confirm/);h.click('review-assignment',row.event_id);h.set('evidence_status','confirmed');await h.save();
  row=h.dataset.tables.husbandry_events.find(r=>r.event_id===row.event_id);assert.equal(row.iacuc_assignment.evidence_status,'confirmed');
  h.click('open','P1');assert.match(h.container.innerHTML,/<span>Confirmed used<\/span><strong>0<\/strong>/);assert.match(h.container.innerHTML,/<span>Recorded cages<\/span><strong>1<\/strong>/);
});

test('record-detail assignment opens the right entity once and requires an explicit protocol',async()=>{
  const h=harness(base(),{initialEntity:{entity_type:'cages',entity_id:'C1'}});
  assert.match(h.container.innerHTML,/Protocol assignment/);assert.match(h.container.innerHTML,/<option value="C1" selected>/);assert.match(h.container.innerHTML,/<option value="" selected>Choose protocol/);
  await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Select an existing protocol/);
  h.click('cancel');h.click('new-assignment');assert.match(h.container.innerHTML,/<option value="mice" selected>/);assert.doesNotMatch(h.container.innerHTML,/<option value="C1" selected>/);
});

test('source assignment review preserves source evidence and is not confirmed merely by opening',async()=>{
  const data=base();data.tables.husbandry_events.push({event_id:'A1',event_type:'iacuc_assignment',event_date:'2026-10-01',source_file_id:'source-1',source_raw:'P(?)',iacuc_assignment:{schema_version:1,protocol_id:'P1',entity_type:'mice',entity_id:'M1',valid_from:'2026-10-01',valid_to:null,purpose:'housing',evidence_status:'source',notes:'Prefix needs verification'}});
  const h=harness(data);h.click('tab','assignments');h.click('review-assignment','A1');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/<option value="source" selected>/);
  h.set('evidence_status','confirmed');h.set('notes','Identity and protocol verified');await h.save();
  const row=h.dataset.tables.husbandry_events.find(r=>r.event_id==='A1');assert.equal(row.source_raw,'P(?)');assert.equal(row.source_file_id,'source-1');assert.equal(row.iacuc_assignment.evidence_status,'confirmed');
});

test('usage keeps unknown counts separate and rejects unknown IDs',async()=>{
  const h=harness();h.click('new-usage');h.multi('mouse_sids',['missing']);h.set('evidence_status','confirmed');await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Unknown mouse SID/);
  h.multi('mouse_sids',['M1']);h.set('unregistered_count','3');await h.save();assert.equal(h.saves.length,1);
  const usage=h.dataset.tables.husbandry_events.find(r=>r.event_type==='iacuc_usage');assert.deepEqual(usage.iacuc_usage.mouse_sids,['M1']);assert.equal(usage.iacuc_usage.unregistered_count,3);
  h.click('open','P1');assert.match(h.container.innerHTML,/<span>Confirmed used<\/span><strong>1<\/strong>/);assert.match(h.container.innerHTML,/unidentified count observation/);
});

test('designer uses biological N, supplies the breeding target, and saves reproducible calculations',async()=>{
  const h=harness();h.click('tab','designer');h.set('design_title','SCN primary contrast');h.set('design_mean1','0');h.set('design_mean2','10');h.set('design_sd','20');h.set('design_technicalReplicates','5');h.click('calculate');
  assert.match(h.container.innerHTML,/<strong>64 \/ 64<\/strong>/);assert.match(h.container.innerHTML,/name="breeding_target"[^>]*value="128"/);
  h.set('breeding_genotype_percent','25');h.set('breeding_sex_percent','50');h.set('breeding_survival_percent','90');h.set('breeding_litterSize','6');h.set('breeding_littersPerPair','3');h.click('calculate-breeding');await h.save(true);
  assert.equal(h.saves.length,1);const p=h.dataset.tables.husbandry_events.find(r=>r.event_type==='iacuc_design').iacuc_design;
  assert.equal(p.inputs.sd,20);assert.equal(p.inputs.technicalReplicates,5);assert.equal(p.results.n1,64);assert.equal(p.breeding_inputs.target,128);assert.equal(p.breeding_inputs.genotypeProbability,.25);
  assert.ok(p.breeding_results.confidence_offspring>p.breeding_results.expected_offspring);assert.equal(p.protocol_id,'P1');
});

test('manual breeding target survives recalculation and a partial probability input cannot save a false estimate',async()=>{
  const h=harness();h.click('tab','designer');h.set('design_title','Manual target');h.set('design_mean1','0');h.set('design_mean2','1');h.set('design_sd','1');h.set('breeding_target','20');h.click('calculate');assert.match(h.container.innerHTML,/name="breeding_target"[^>]*value="20"/);
  h.set('breeding_genotype_percent','50');await h.save(true);assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Sex probability must be supplied/);
  h.set('breeding_sex_percent','100');h.set('breeding_survival_percent','100');await h.save(true);assert.equal(h.saves.length,1);assert.equal(h.dataset.tables.husbandry_events.at(-1).iacuc_design.breeding_inputs.target,20);
});

test('paired designer requires a difference SD or an explicit correlation and uses complete pairs',()=>{
  const h=harness();h.click('tab','designer');h.set('design_design','paired');h.set('design_mean1','0');h.set('design_mean2','.5');h.click('calculate');assert.match(h.container.innerHTML,/Paired planning needs SD of differences/);
  h.set('design_pairedVariance','correlation');h.set('design_sd1','1');h.set('design_sd2','1');h.set('design_correlation','.5');h.click('calculate');assert.match(h.container.innerHTML,/Analyzed complete pairs<\/span><strong>34<\/strong>/);
});

test('readonly users can inspect and calculate but cannot save or confirm',async()=>{
  const h=harness(base(),{canEdit:()=>false});assert.doesNotMatch(h.container.innerHTML,/New protocol draft/);h.click('new-protocol');assert.match(h.container.innerHTML,/edit access is required/);
  h.click('tab','designer');h.set('design_mean1','0');h.set('design_mean2','1');h.set('design_sd','1');h.click('calculate');assert.match(h.container.innerHTML,/Sample-size result/);assert.doesNotMatch(h.container.innerHTML,/Save design to protocol/);await h.save(true);assert.equal(h.saves.length,0);
});

test('Enter in the designer calculates rather than silently saving; edits invalidate the displayed result',async()=>{
  const h=harness();h.click('tab','designer');h.set('design_title','Keyboard plan');h.set('design_mean1','0');h.set('design_mean2','1');h.set('design_sd','1');
  await h.container.onsubmit({preventDefault(){},target:{hasAttribute:key=>key==='data-iacuc-design-form'}});
  assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Sample-size result/);
  const display={innerHTML:'Old result'};h.container.querySelector=selector=>selector==='[data-iacuc-results]'?display:null;
  h.set('design_mean2','2');assert.match(display.innerHTML,/Inputs changed/);
});

test('failed writes preserve draft, busy writes cannot duplicate, and external refresh closes stale editors',async()=>{
  let release,rejectWrite;const h=harness(base(),{save:()=>new Promise((resolve,reject)=>{release=resolve;rejectWrite=reject;})});h.click('new-protocol');h.set('number','DRAFT-FAIL');h.set('title','Keep this');const pending=h.save();await h.save();assert.match(h.container.innerHTML,/Saving…/);rejectWrite(new Error('Network unavailable'));await pending;assert.match(h.container.innerHTML,/Network unavailable/);assert.match(h.container.innerHTML,/value="Keep this"/);
  h.render(clone(h.dataset));assert.match(h.container.innerHTML,/Data refreshed/);assert.doesNotMatch(h.container.innerHTML,/data-iacuc-form/);
});

test('source links reject executable URLs and Help includes primary statistical references',()=>{
  const data=base();data.tables.husbandry_events[0].iacuc_protocol.source_url='javascript:alert(1)';const h=harness(data);assert.doesNotMatch(h.container.innerHTML,/href="javascript:/);
  assert.match(iacucHelpHTML(),/eda.nc3rs.org.uk/);assert.match(iacucHelpHTML(),/arriveguidelines.org/);assert.match(iacucHelpHTML(),/not IACUC|do not grant animal-use approval/);
});
