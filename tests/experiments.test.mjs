import test from 'node:test';
import assert from 'node:assert/strict';
import {buildExperiment,buildExperimentSample} from '../web/experiment-model.js';

let serial=0;
const clone=structuredClone;
const confirmed=id=>({mouse_sid:id,raw_identifier:id,link_status:'confirmed',candidate_sids:[],role:null,notes:null});
const base=()=>({tables:{mice:[{mouse_sid:'M1',physical_tag:'P1',genotype:'P',state:'Stock'},{mouse_sid:'M2',physical_tag:'B1',genotype:'B',state:'Stock'}],husbandry_events:[],experiment_sources:[{source_id:'SOURCE-1',date:'2024-01-10',assays:['LumiCycle'],raw_identifiers:['P1','Old tag'],tissue:'SCN',storage:'-80 °C',workbook_title:'Experiment Sheet 2024',sheet_name:'LumiCycle',range:'A2:F2',source_url:'https://example.test/sheet',raw_values:{A2:'P1',B2:'<script>raw source</script>'},provenance:[{source_url:'https://example.test/sheet',sheet_name:'LumiCycle',range:'A2:F2',snapshot_date:'2024-06-01'}]}]}});
const decode=s=>String(s??'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function fakeContainer(){
  let html='',controls=[];
  const attrs=s=>Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2])]));
  const matches=(c,selector)=>selector.startsWith('#')?c.id===selector.slice(1):selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)?(()=>{const [,k,v]=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return Object.hasOwn(c.attributes,k)&&(v===undefined||c.attributes[k]===v)})():false;
  const form={id:'experiment-form',get controls(){return controls},querySelectorAll:selector=>controls.filter(c=>matches(c,selector))};
  return {get innerHTML(){return html},set innerHTML(value){html=value;controls=[...html.matchAll(/<input\b([^>]*)>|<(select|textarea)\b([^>]*)>([\s\S]*?)<\/\2>/g)].map(m=>{const tag=m[2]||'input',a=attrs(m[1]||m[3]),options=tag==='select'?[...m[4].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(o=>({...attrs(o[1]),selected:/\sselected(?:\s|$)/.test(o[1])})):[];return {attributes:a,id:a.id,name:a.name,type:a.type||'text',tagName:tag.toUpperCase(),value:tag==='select'?(options.find(x=>x.selected)?.value??options[0]?.value??''):tag==='textarea'?decode(m[4]):a.value??'',checked:/\schecked(?:\s|$)/.test(m[1]||''),dataset:Object.fromEntries(Object.entries(a).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v])),selectionStart:0,focus(){},setSelectionRange(){}}})},querySelector(selector){return selector==='#experiment-form'?(html.includes('id="experiment-form"')?form:null):controls.find(c=>matches(c,selector))??null},querySelectorAll:selector=>controls.filter(c=>matches(c,selector)),get controls(){return controls}};
}
class FakeFormData {
  constructor(form){this.values=form.controls.filter(c=>c.name&&(!(c.type==='checkbox')||c.checked)).map(c=>[c.name,c.value]);}
  has(key){return this.values.some(([name])=>name===key)}get(key){return this.values.find(([name])=>name===key)?.[1]??null}getAll(key){return this.values.filter(([name])=>name===key).map(([,value])=>value)}
}
async function harness(t,dataset=base(),overrides={}) {
  const original=globalThis.FormData;globalThis.FormData=FakeFormData;t.after(()=>{globalThis.FormData=original});
  const {renderExperiments}=await import(`../web/experiments.js?test=${++serial}`),container=fakeContainer(),saves=[],messages=[];
  let current=dataset;
  const hooks={canEdit:()=>true,toast:(message,error)=>messages.push({message,error}),openMouse:id=>messages.push({mouse:id}),save:async next=>{current=clone(next);saves.push(current);renderExperiments(container,current,hooks)},...overrides};
  renderExperiments(container,current,hooks);
  return {container,hooks,saves,messages,get dataset(){return current},
    async click(action,id=''){await container.onclick({preventDefault(){},target:{closest:()=>({dataset:{expAction:action,id}})}})},
    set(name,value){const c=container.querySelector(`[name="${name}"]`);assert(c,`Missing field ${name}`);c.value=value},
    check(name,values){for(const c of container.controls.filter(x=>x.name===name))c.checked=c.type==='checkbox'&&(Array.isArray(values)?values.includes(c.value):values)},
    input(selector,value){const c=container.querySelector(selector);assert(c,`Missing input ${selector}`);c.value=value},
    async save(){await container.onsubmit({preventDefault(){},target:{id:'experiment-form'}})},
    filter(name,value){container.onchange({target:{name,value}})},
    render(next=current){current=next;renderExperiments(container,current,hooks)}
  };
}

test('new experiment preserves fields across participant controls and saves confirmed links',async t=>{
  const h=await harness(t);await h.click('new');h.set('title','SCN qPCR');h.check('assays',['qPCR']);h.set('event_date','2026-10-14');h.set('operator','Researcher A');h.input('#exp-add-mouse','M1');await h.click('add-mouse');
  assert.match(h.container.innerHTML,/value="SCN qPCR"/);assert.match(h.container.innerHTML,/value="Researcher A"/);await h.save();
  assert.equal(h.saves.length,1);const record=h.dataset.tables.husbandry_events[0];assert.deepEqual(record.experiment.assays,['qPCR']);assert.equal(record.experiment.participants[0].mouse_sid,'M1');assert.equal(record.experiment.status,'planned');
});

test('source review retains original values and candidate identities until explicitly confirmed',async t=>{
  const h=await harness(t);await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/&lt;script&gt;raw source&lt;\/script&gt;/);await h.click('review','SOURCE-1');
  assert.match(h.container.innerHTML,/Possible matches, verify before confirming/);h.input('[data-resolve="0"]','M1');await h.click('resolve','0');await h.save();
  assert.equal(h.saves.length,1);const record=h.dataset.tables.husbandry_events[0];assert.equal(record.event_date,'2024-01-10');assert.equal(record.source_id,'SOURCE-1');assert.deepEqual(record.source_raw_values,h.dataset.tables.experiment_sources[0].raw_values);
  assert.equal(record.experiment.participants[0].link_status,'confirmed');assert.equal(record.experiment.participants[1].link_status,'unresolved');assert.match(record.experiment.notes,/-80/);assert.equal(record.experiment.status,'unreviewed');
  await h.click('review','SOURCE-1');assert.match(h.container.innerHTML,/already has a reviewed experiment/);assert.equal(h.saves.length,1);
});

test('editing retains source provenance and appends dated before and after revisions',async t=>{
  const h=await harness(t);await h.click('review','SOURCE-1');await h.save();const old=clone(h.dataset.tables.husbandry_events[0]);
  await h.click('edit',old.event_id);h.set('title','Reviewed clock experiment');h.set('revision_date','2026-10-14');h.set('revision_notes','Checked notebook');await h.save();
  assert.equal(h.saves.length,2);const record=h.dataset.tables.husbandry_events.find(r=>r.event_id===old.event_id),revision=h.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment_revision');
  assert.equal(record.experiment.title,'Reviewed clock experiment');assert.deepEqual(record.source_raw_values,old.source_raw_values);assert.equal(revision.experiment_revision.before.payload.title,old.experiment.title);assert.equal(revision.experiment_revision.after.payload.title,record.experiment.title);assert.match(h.container.innerHTML,/Checked notebook/);
});

test('read-only users can inspect sources but cannot open or submit record edits',async t=>{
  const h=await harness(t,base(),{canEdit:()=>false});assert.doesNotMatch(h.container.innerHTML,/data-exp-action="new"/);await h.click('source','SOURCE-1');assert.doesNotMatch(h.container.innerHTML,/data-exp-action="review"/);
  await h.click('new');assert.match(h.container.innerHTML,/Read &amp; write access is required/);await h.click('review','SOURCE-1');await h.save();assert.equal(h.saves.length,0);
});

test('save failure keeps entered fields available and prevents success claims',async t=>{
  const h=await harness(t,base(),{save:async()=>{throw new Error('Version conflict, reload')}});await h.click('new');h.set('title','Unsaved assay');h.check('assays',['WB']);await h.save();
  assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Version conflict, reload/);assert.match(h.container.innerHTML,/value="Unsaved assay"/);assert.match(h.container.innerHTML,/id="experiment-form"/);assert.equal(h.messages.length,0);
});

test('refreshing dataset closes stale draft and a forged save cannot write it',async t=>{
  const h=await harness(t);await h.click('new');h.set('title','Stale assay');h.render(clone(h.dataset));assert.match(h.container.innerHTML,/Records refreshed/);await h.save();assert.equal(h.saves.length,0);
});

test('collect sample does not infer pooling from a multi-animal experiment',async t=>{
  const first=buildExperiment({title:'Many animals',assays:['CSF'],participants:[confirmed('M1'),confirmed('M2')],event_date:'2026-10-14'},base());
  const h=await harness(t,first.dataset);await h.click('sample-from',first.record.event_id);h.set('label','CSF specimen');await h.save();
  assert.equal(h.saves.length,1);const specimen=h.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment_sample');assert.equal(specimen.experiment_sample.pooled,false);assert.deepEqual(specimen.experiment_sample.donors,[]);assert.equal(specimen.experiment_sample.experiment_id,first.record.event_id);assert.equal(specimen.experiment_sample.storage.temperature_c,-70);
});

test('collecting from a historical reviewed experiment retains its date and leaves temperature unasserted',async t=>{
  const d=base();d.tables.experiment_sources[0].operator='Recorded operator';d.tables.experiment_sources[0].project='Clock project';d.tables.experiment_sources[0].protocol='LD12:12';const h=await harness(t,d);
  await h.click('review','SOURCE-1');assert.match(h.container.innerHTML,/value="Recorded operator"/);assert.match(h.container.innerHTML,/value="Clock project"/);await h.save();const exp=h.dataset.tables.husbandry_events[0];
  await h.click('sample-from',exp.event_id);h.set('label','Historical specimen');await h.save();const specimen=h.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment_sample');assert.equal(specimen.event_date,'2024-01-10');assert.equal(specimen.experiment_sample.storage.temperature_c,null);assert.equal(specimen.experiment_sample.operator,'Recorded operator');
});

test('source history labels observations and displays recovered coverage without counting them as experiments',async t=>{
  const d=base();d.tables.experiment_sources[0].kind='instrument_channel';d.tables.experiment_source_coverage=[{total_source_workbooks:52,sheets:698,preparation_contexts:821}];const h=await harness(t,d);await h.click('tab','sources');assert.match(h.container.innerHTML,/52 source workbooks/);assert.match(h.container.innerHTML,/698 Experiment Sheet tabs/);assert.match(h.container.innerHTML,/Instrument channel/);assert.match(h.container.innerHTML,/Observations require review/);assert.match(h.container.innerHTML,/<span>Experiments<\/span><strong>0<\/strong>/);
});

test('source history starts with newest valid event dates, leaves unknown dates last, and preserves stable ties and source order',async t=>{
  const d=base(),template=d.tables.experiment_sources[0];d.tables.experiment_sources=[
    {...clone(template),source_id:'UNKNOWN',date:null,raw_identifiers:['Unknown row']},
    {...clone(template),source_id:'OLDER',date:'2022-01-01',raw_identifiers:['Older row']},
    {...clone(template),source_id:'NEWER-FIRST',date:'2026-01-01',raw_identifiers:['Newer first row']},
    {...clone(template),source_id:'NEWER-SECOND',date:'2026-01-01',raw_identifiers:['Newer second row']},
    {...clone(template),source_id:'INVALID',date:'2026-02-30',raw_identifiers:['Invalid date row']}];
  const before=clone(d.tables.experiment_sources),h=await harness(t,d);await h.click('tab','sources');const html=h.container.innerHTML,labels=['Newer first row','Newer second row','Older row','Unknown row','Invalid date row'];
  for(let i=1;i<labels.length;i++)assert(html.indexOf(labels[i-1])<html.indexOf(labels[i]),`${labels[i-1]} should precede ${labels[i]}`);
  assert.deepEqual(h.dataset.tables.experiment_sources,before);
});

test('source inspection shows extracted sampling date, phase and time without interpreting or changing them',async t=>{
  const d=base(),s=d.tables.experiment_sources[0];s.sampling_date='2024-01-09';s.phase='ZT 6 (recorded)';s.time='10:30 approximate';const before=clone(d);const h=await harness(t,d);await h.click('source','SOURCE-1');
  assert.match(h.container.innerHTML,/<dt>Sampling date<\/dt><dd>2024-01-09<\/dd>/);assert.match(h.container.innerHTML,/<dt>Phase as recorded<\/dt><dd>ZT 6 \(recorded\)<\/dd>/);assert.match(h.container.innerHTML,/<dt>Time as recorded<\/dt><dd>10:30 approximate<\/dd>/);assert.deepEqual(h.dataset,before);assert.equal(h.saves.length,0);
});

test('WB and IHC specimen names are presented as sample labels without inventing animal participants',async t=>{
  const d=base(),s=d.tables.experiment_sources[0];s.identifier_kind='sample_label';s.kind='assay_run';s.assays=['WB'];s.raw_identifiers=['P1'];const h=await harness(t,d);
  await h.click('tab','sources');assert.match(h.container.innerHTML,/Sample label/);await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/Sample identifiers \(not animal IDs\)/);
  await h.click('review','SOURCE-1');assert.doesNotMatch(h.container.innerHTML,/Possible matches, verify/);assert.match(h.container.innerHTML,/Source sample labels \(link reviewed specimens\): P1/);await h.save();
  const record=h.dataset.tables.husbandry_events[0];assert.deepEqual(record.experiment.participants,[]);assert.deepEqual(record.source_observation.raw_identifiers,['P1']);
});

test('collecting a historical assay specimen uses its sampling date, not its later assay date',async t=>{
  const d=base(),s=d.tables.experiment_sources[0];s.identifier_kind='sample_label';s.kind='assay_run';s.assays=['IF/IHC'];s.date='2024-03-10';s.sampling_date='2024-01-20';const h=await harness(t,d);
  await h.click('review','SOURCE-1');await h.save();const exp=h.dataset.tables.husbandry_events[0];assert.equal(exp.event_date,'2024-03-10');await h.click('sample-from',exp.event_id);h.set('label','Earlier tissue');await h.save();
  assert.equal(h.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment_sample').event_date,'2024-01-20');
});

test('historical assay specimens without sampling dates keep collection date unknown',async t=>{
  const d=base(),s=d.tables.experiment_sources[0];s.kind='assay_run';s.identifier_kind='sample_label';s.assays=['WB'];const h=await harness(t,d);await h.click('review','SOURCE-1');await h.save();const exp=h.dataset.tables.husbandry_events[0];
  await h.click('sample-from',exp.event_id);h.set('label','Undated tissue');await h.save();assert.equal(h.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment_sample').event_date,null);
});

test('Other method filter includes source spelling and review retains the normalized method',async t=>{
  const d=base();d.tables.experiment_sources[0].assays=['Other'];const h=await harness(t,d);await h.click('tab','sources');h.filter('assay','other');assert.match(h.container.innerHTML,/SOURCE-1/);await h.click('review','SOURCE-1');await h.save();assert.deepEqual(h.dataset.tables.husbandry_events[0].experiment.assays,['other']);
});

test('specimens and derived aliquots retain lineage and later assays trace to donor mice',async t=>{
  const parent=buildExperimentSample({label:'SCN parent',donors:[confirmed('M1')],event_date:'2026-10-14'},base());const h=await harness(t,parent.dataset);
  await h.click('new-sample');h.set('label','RNA aliquot');h.set('event_date','2026-10-14');h.input('#exp-parent',parent.record.event_id);await h.click('add-parent');await h.save();
  const child=h.dataset.tables.husbandry_events.find(r=>r.experiment_sample?.label==='RNA aliquot');assert(child);assert.match(h.container.innerHTML,/Confirmed donors through parent samples/);assert.match(h.container.innerHTML,/P1 · M1/);
  await h.click('new');h.set('title','RNA qPCR');h.set('event_date','2026-10-14');h.check('assays',['qPCR']);h.input('#exp-use-sample',child.event_id);await h.click('add-use');await h.save();
  assert.equal(h.saves.length,2);assert.match(h.container.innerHTML,/Confirmed donors through samples/);assert.match(h.container.innerHTML,/P1 · M1/);
});

test('storage edits preserve an auditable previous freezer and inventory stays unknown',async t=>{
  const parent=buildExperimentSample({label:'Stored tissue',donors:[confirmed('M1')],event_date:'2026-10-14',storage:{temperature_c:-70,freezer:'F1'}},base());const h=await harness(t,parent.dataset);
  await h.click('edit',parent.record.event_id);h.set('storage_freezer','F2');h.set('revision_date','2026-10-14');await h.save();
  const specimen=h.dataset.tables.husbandry_events.find(r=>r.event_id===parent.record.event_id),revision=h.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment_revision');assert.equal(specimen.experiment_sample.quantity,null);assert.equal(revision.experiment_revision.before.payload.storage.freezer,'F1');assert.equal(revision.experiment_revision.after.payload.storage.freezer,'F2');
});

test('source review cannot duplicate an archived managed experiment',async t=>{
  const parent=buildExperiment({title:'Previously reviewed',assays:['LumiCycle'],event_date:null},base(),null,{sourceRecord:{source_id:'SOURCE-1'}});parent.record.archived=true;
  const h=await harness(t,parent.dataset);await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/Open reviewed experiment/);await h.click('open',parent.record.event_id);assert.match(h.container.innerHTML,/Archived record/);await h.click('review','SOURCE-1');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/already has a reviewed experiment/);
});

test('filters compare confirmed mouse associations and source matches stay labelled as candidates',async t=>{
  const first=buildExperiment({title:'Known assay',assays:['IMG'],participants:[confirmed('M1')],event_date:'2026-10-14'},base());const h=await harness(t,first.dataset);
  h.filter('mouse','M2');assert.match(h.container.innerHTML,/No matching records/);h.filter('mouse','M1');assert.match(h.container.innerHTML,/Known assay/);
  await h.click('tab','sources');assert.match(h.container.innerHTML,/Possible source matches, not confirmed participation/);assert.match(h.container.innerHTML,/SOURCE-1/);
});

test('separate procedure timings, assay time and entrainment duration save and render distinctly',async t=>{
  const h=await harness(t);await h.click('new');h.set('title','Timed SCN experiment');h.check('assays',['LumiCycle']);h.set('event_date','2026-10-14');
  h.set('decapitation_at','2026-10-14T09:00:00+08:00');h.set('decapitation_circadian_time','2');h.set('decapitation_time_basis','ZT');h.set('sampling_at','2026-10-14T09:04:00+08:00');h.set('sampling_circadian_time','2.0667');h.set('sampling_time_basis','ZT');h.set('started_at','2026-10-14T11:00:00+08:00');h.set('circadian_time','4');h.set('time_basis','ZT');h.set('entrainment_scheme','LP1');h.set('entrainment_duration_days','30');await h.save();
  assert.equal(h.saves.length,1);const p=h.dataset.tables.husbandry_events[0].experiment;assert.equal(p.decapitation_circadian_time,'2');assert.equal(p.sampling_circadian_time,'2.0667');assert.equal(p.circadian_time,'4');assert.equal(p.entrainment.duration_basis,'recorded');assert.match(h.container.innerHTML,/LP1 \(30\)/);assert.match(h.container.innerHTML,/<h3>Decapitation<\/h3>/);assert.match(h.container.innerHTML,/<h3>Exact sampling<\/h3>/);assert.match(h.container.innerHTML,/Assay started/);
});

test('collect sample inherits only explicit sampling and decapitation timing, never assay start or phase',async t=>{
  const built=buildExperiment({title:'Timed experiment',assays:['LumiCycle'],participants:[confirmed('M1')],event_date:'2026-10-14',started_at:'2026-10-14T11:00:00+08:00',circadian_time:'4',time_basis:'ZT',decapitation_at:'2026-10-14T09:00:00+08:00',decapitation_circadian_time:'2',decapitation_time_basis:'ZT',sampling_at:'2026-10-14T09:03:00+08:00',sampling_circadian_time:'2.05',sampling_time_basis:'ZT',entrainment:{scheme:'LD',duration_days:20,duration_basis:'recorded'}},base());
  const h=await harness(t,built.dataset);await h.click('sample-from',built.record.event_id);h.set('label','SCN');await h.save();const sample=h.dataset.tables.husbandry_events.find(r=>r.experiment_sample).experiment_sample;assert.equal(sample.collection_at,'2026-10-14T09:03:00+08:00');assert.equal(sample.circadian_time,'2.05');assert.equal(sample.decapitation_circadian_time,'2');assert.equal(sample.entrainment.duration_days,20);
  const undated=buildExperiment({title:'Run only',assays:['LumiCycle'],event_date:'2026-10-14',started_at:'2026-10-14T11:00:00+08:00',circadian_time:'4',time_basis:'ZT'},h.dataset);h.render(undated.dataset);await h.click('sample-from',undated.record.event_id);h.set('label','No collection clock');await h.save();const unknown=h.dataset.tables.husbandry_events.find(r=>r.experiment_sample?.label==='No collection clock').experiment_sample;assert.equal(unknown.collection_at,null);assert.equal(unknown.circadian_time,null);assert.equal(unknown.time_basis,'unknown');
});

function reference(h){h.set('entrainment_scheme','LD');h.set('entrainment_reference_at','2026-10-14T07:00:00+08:00');h.set('entrainment_reference_phase','0');h.set('entrainment_period_hours','24');h.set('entrainment_phase_basis','ZT')}

test('phase calculation previews without overwriting observation; explicit application retains provenance and manual changes reset it',async t=>{
  const h=await harness(t);await h.click('new-sample');h.set('label','SCN');h.set('event_date','2026-10-14');h.set('collection_at','2026-10-14T10:30:00+08:00');h.set('circadian_time','2');h.set('time_basis','ZT');reference(h);await h.click('calculate-phase','sampling');assert.equal(h.container.querySelector('[name="circadian_time"]').value,'2');assert.match(h.container.innerHTML,/ZT 3.5.*Calculated estimate/);await h.click('apply-phase','sampling');assert.equal(h.container.querySelector('[name="circadian_time"]').value,'3.5');await h.save();let p=h.dataset.tables.husbandry_events.find(r=>r.experiment_sample).experiment_sample;assert.equal(p.circadian_time_source,'calculated');assert.match(h.container.innerHTML,/Calculated estimate/);
  const id=h.dataset.tables.husbandry_events[0].event_id;await h.click('edit',id);h.set('circadian_time','3.4');await h.save();p=h.dataset.tables.husbandry_events.find(r=>r.event_id===id).experiment_sample;assert.equal(p.circadian_time_source,'recorded');assert.equal(p.circadian_time,'3.4');
});

test('phase cannot be calculated without reference and stale preview requires recalculation',async t=>{
  const h=await harness(t);await h.click('new');h.set('sampling_at','2026-10-14T10:00:00+08:00');await h.click('calculate-phase','sampling');assert.doesNotMatch(h.container.innerHTML,/data-exp-action="apply-phase"/);assert.equal(h.container.querySelector('[name="sampling_circadian_time"]').value,'');reference(h);await h.click('calculate-phase','sampling');h.set('entrainment_reference_at','2026-10-14T08:00:00+08:00');await h.click('apply-phase','sampling');assert.match(h.container.innerHTML,/Calculate the phase again/);assert.equal(h.container.querySelector('[name="sampling_circadian_time"]').value,'');await h.click('calculate-phase','sampling');await h.click('apply-phase','sampling');assert.equal(h.container.querySelector('[name="sampling_circadian_time"]').value,'2');
});

test('duration calculation stops at decapitation before later in-vitro sampling and date edits retain manual duration origin',async t=>{
  const h=await harness(t);await h.click('new');h.set('title','Duration');h.check('assays',['IMG']);h.set('event_date','2026-10-14');h.set('entrainment_scheme','LP1');h.set('entrainment_start_date','2026-09-14');h.set('decapitation_at','2026-10-14T10:00:00+08:00');h.set('sampling_at','2026-10-17T10:00:00+08:00');await h.click('calculate-duration');assert.equal(h.container.querySelector('[name="entrainment_duration_days"]').value,'30');await h.save();assert.equal(h.saves.length,1);const record=h.dataset.tables.husbandry_events[0];assert.equal(record.experiment.entrainment.duration_basis,'date_difference');assert.match(h.container.innerHTML,/LP1 \(30\)/);await h.click('edit',record.event_id);h.set('entrainment_duration_days','29');await h.save();assert.equal(h.dataset.tables.husbandry_events.find(r=>r.event_id===record.event_id).experiment.entrainment.duration_basis,'recorded');
});

test('light history requires explicit selection and supplies no reference phase or date',async t=>{
  const d=base();d.tables.light_events=[{event_id:'LIGHT1',protocol:'LP2',cycle_hours:24,timezone:'Asia/Taipei',start_date:'2026-09-01',end_date:null,mouse_sid:'M1'}];const h=await harness(t,d);await h.click('new');h.set('event_date','2026-10-14');assert.equal(h.container.querySelector('[name="entrainment_scheme"]').value,'unknown');h.input('#exp-light-history','LIGHT1');await h.click('use-light-history');assert.equal(h.container.querySelector('[name="entrainment_scheme"]').value,'LP2');assert.equal(h.container.querySelector('[name="entrainment_period_hours"]').value,'24');assert.equal(h.container.querySelector('[name="entrainment_reference_at"]').value,'');assert.equal(h.container.querySelector('[name="entrainment_reference_phase"]').value,'');
});

test('source timing evidence is shown separately and does not populate managed animal events',async t=>{
  const d=base();d.tables.experiment_sources[0].raw_values={sample:{'Decapitation time':'10:30','-70ºC sampling time':'14:00'},preparation:{Comments:'Decap time is the mother mouse time'}};const h=await harness(t,d);await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/Decapitation label/);assert.match(h.container.innerHTML,/Sampling timing/);assert.match(h.container.innerHTML,/qualify or correct/);await h.click('review','SOURCE-1');assert.equal(h.container.querySelector('[name="decapitation_at"]').value,'');assert.equal(h.container.querySelector('[name="sampling_at"]').value,'');await h.save();assert.match(h.container.innerHTML,/Timing &amp; entrainment as recorded/);
});


test('multi-animal experiment timing is not assigned to a specimen donor implicitly',async t=>{
  const built=buildExperiment({title:'Two donor experiments',assays:['IMG'],participants:[confirmed('M1'),confirmed('M2')],event_date:'2026-10-14',decapitation_at:'2026-10-14T09:00:00+08:00',sampling_at:'2026-10-14T09:10:00+08:00',sampling_circadian_time:'2',sampling_time_basis:'ZT',entrainment:{scheme:'LP1',duration_days:30,duration_basis:'recorded'}},base());
  const h=await harness(t,built.dataset);await h.click('sample-from',built.record.event_id);h.set('label','Individual donor specimen');assert.equal(h.container.querySelector('[name="decapitation_at"]').value,'');assert.equal(h.container.querySelector('[name="collection_at"]').value,'');assert.equal(h.container.querySelector('[name="entrainment_scheme"]').value,'unknown');await h.save();const sample=h.dataset.tables.husbandry_events.find(r=>r.experiment_sample).experiment_sample;assert.deepEqual(sample.donors,[]);assert.match(sample.notes,/Confirm each donor/);
});

test('experiment user acronyms display resolved names, preserve raw values and search full names',async t=>{
  const d=base();d.tables.experiment_sources[0].operator='JM';const h=await harness(t,d);await h.click('new');assert.match(h.container.innerHTML,/<label for="exp-operator">User<\/label>/);assert.match(h.container.innerHTML,/<option value="JM">Jihwan Myung<\/option>/);h.set('title','Acronym experiment');h.check('assays',['qPCR']);h.set('operator','JM');await h.save();assert.equal(h.dataset.tables.husbandry_events[0].experiment.operator,'JM');assert.match(h.container.innerHTML,/<dt>User<\/dt><dd>JM · Jihwan Myung<\/dd>/);
  await h.click('back');const search=h.container.querySelector('[name="search"]');search.value='Jihwan Myung';h.container.oninput({target:search});assert.match(h.container.innerHTML,/Acronym experiment/);await h.click('tab','sources');assert.match(h.container.innerHTML,/SOURCE-1/);await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/<dt>User<\/dt><dd>JM · Jihwan Myung<\/dd>/);assert.equal(h.dataset.tables.experiment_sources[0].operator,'JM');
});

test('source full-name search cache refreshes when historical-user visibility is revoked',async t=>{
 const d=base();d.tables.experiment_sources[0].operator='ZZ';d.tables.husbandry_events.push({event_id:'USER-ACRONYM-ZZ',event_type:'user_acronym_definition',event_date:'2026-10-14',user_acronym:{code:'ZZ',name:'Private Synthetic Name',notes:'',name_status:'full',historical:true}});let owner=true;const h=await harness(t,d,{includeHistoricalUsers:()=>owner});await h.click('tab','sources');let search=h.container.querySelector('[name="search"]');search.value='Private Synthetic Name';h.container.oninput({target:search});assert.match(h.container.innerHTML,/SOURCE-1/);owner=false;h.render();assert.doesNotMatch(h.container.innerHTML,/data-id="SOURCE-1"/);assert.match(h.container.innerHTML,/No matching source observations/);
});

test('current directory changes invalidate source full-name search without changing recorded IDs',async t=>{
 const {setLabUserDirectory,getLabUserDirectoryVersion}=await import('../web/user-acronyms.js?v=23');t.after(()=>setLabUserDirectory([]));setLabUserDirectory([{code:'ZZ',name:'Original Directory Name'}]);
 const d=base();d.tables.experiment_sources[0].operator='ZZ';const original=structuredClone(d),h=await harness(t,d);await h.click('tab','sources');let search=h.container.querySelector('[name="search"]');search.value='Original Directory Name';h.container.oninput({target:search});assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);
 const version=getLabUserDirectoryVersion();setLabUserDirectory([{code:'ZZ',name:'Changed Directory Name'}]);assert(getLabUserDirectoryVersion()>version);h.render();assert.match(h.container.innerHTML,/No matching source observations/);search=h.container.querySelector('[name="search"]');search.value='Changed Directory Name';h.container.oninput({target:search});assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);
 setLabUserDirectory([{code:'NEW',name:'Changed Directory Name'}]);h.render();assert.match(h.container.innerHTML,/No matching source observations/);assert.deepEqual(h.dataset,original);assert.equal(h.dataset.tables.experiment_sources[0].operator,'ZZ');assert.equal(h.saves.length,0);
 setLabUserDirectory([{code:'ZZ',name:'Changed Directory Name'}]);h.render();assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);setLabUserDirectory([]);h.render();assert.match(h.container.innerHTML,/No matching source observations/);
});
