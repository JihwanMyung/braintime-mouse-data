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
  await h.click('review','SOURCE-1');assert.match(h.container.innerHTML,/already has an experiment record/);assert.equal(h.saves.length,1);
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
  const d=base();d.tables.experiment_sources[0].kind='instrument_channel';d.tables.experiment_source_coverage=[{total_source_workbooks:52,sheets:698,preparation_contexts:821}];const h=await harness(t,d);await h.click('tab','sources');assert.match(h.container.innerHTML,/52 source workbooks/);assert.match(h.container.innerHTML,/698 Experiment Sheet tabs/);assert.match(h.container.innerHTML,/Instrument channel/);assert.match(h.container.innerHTML,/Observations require review/);assert.match(h.container.innerHTML,/<span>Managed experiments<\/span><strong>0<\/strong>/);
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
  const h=await harness(t,parent.dataset);await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/Open reviewed experiment/);await h.click('open',parent.record.event_id);assert.match(h.container.innerHTML,/Archived record/);await h.click('review','SOURCE-1');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/already has an experiment record/);
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
 const {setLabUserDirectory,getLabUserDirectoryVersion}=await import('../web/user-acronyms.js?v=24');t.after(()=>setLabUserDirectory([]));setLabUserDirectory([{code:'ZZ',name:'Original Directory Name'}]);
 const d=base();d.tables.experiment_sources[0].operator='ZZ';const original=structuredClone(d),h=await harness(t,d);await h.click('tab','sources');let search=h.container.querySelector('[name="search"]');search.value='Original Directory Name';h.container.oninput({target:search});assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);
 const version=getLabUserDirectoryVersion();setLabUserDirectory([{code:'ZZ',name:'Changed Directory Name'}]);assert(getLabUserDirectoryVersion()>version);h.render();assert.match(h.container.innerHTML,/No matching source observations/);search=h.container.querySelector('[name="search"]');search.value='Changed Directory Name';h.container.oninput({target:search});assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);
 setLabUserDirectory([{code:'NEW',name:'Changed Directory Name'}]);h.render();assert.match(h.container.innerHTML,/No matching source observations/);assert.deepEqual(h.dataset,original);assert.equal(h.dataset.tables.experiment_sources[0].operator,'ZZ');assert.equal(h.saves.length,0);
 setLabUserDirectory([{code:'ZZ',name:'Changed Directory Name'}]);h.render();assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);setLabUserDirectory([]);h.render();assert.match(h.container.innerHTML,/No matching source observations/);
});


test('imported evidence is the initial list when no managed experiments exist and remains unconfirmed',async t=>{
  const d=base(),before=clone(d),h=await harness(t,d);
  assert.match(h.container.innerHTML,/data-id="sources" aria-pressed="true"/);
  assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);
  assert.match(h.container.innerHTML,/<span>Managed experiments<\/span><strong>0<\/strong>/);
  assert.match(h.container.innerHTML,/<span>Imported records<\/span><strong>1<\/strong>/);
  assert.match(h.container.innerHTML,/<span>Possible source matches<\/span><strong>1<\/strong>/);
  assert.match(h.container.innerHTML,/<span>Confirmed animals<\/span><strong>0<\/strong>/);
  assert.match(h.container.innerHTML,/Possible exact-identifier match/);
  await h.click('mouse','M1');assert.deepEqual(h.messages,[{mouse:'M1'}]);
  assert.equal(h.saves.length,0);assert.deepEqual(h.dataset,before);
});

test('empty managed lists link to source history and reset unrelated filters while preserving the animal',async t=>{
  const h=await harness(t);await h.click('tab','experiments');h.filter('mouse','M1');h.filter('from','2026-01-01');h.filter('assay','WB');
  assert.match(h.container.innerHTML,/No matching records/);assert.match(h.container.innerHTML,/View Source history/);
  await h.click('browse-sources');assert.match(h.container.innerHTML,/data-id="sources" aria-pressed="true"/);assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);
  assert.equal(h.container.querySelector('[name="mouse"]').value,'M1');assert.equal(h.container.querySelector('[name="from"]').value,'');assert.equal(h.container.querySelector('[name="assay"]').value,'');
});

test('mouse entry without confirmed use opens only its possible source matches',async t=>{
  const d=buildExperiment({title:'Other animal experiment',assays:['IMG'],participants:[confirmed('M2')],event_date:'2026-10-14'},base()).dataset;
  d.tables.experiment_sources.push({...clone(d.tables.experiment_sources[0]),source_id:'OTHER-SOURCE',raw_identifiers:['B1']});
  const h=await harness(t,d,{initialMouseId:'M1'});
  assert.match(h.container.innerHTML,/data-id="sources" aria-pressed="true"/);assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);assert.doesNotMatch(h.container.innerHTML,/data-id="OTHER-SOURCE"/);
  assert.match(h.container.innerHTML,/Possible source matches, not confirmed participation/);
  assert.match(h.container.innerHTML,/<span>Possible source matches<\/span><strong>1<\/strong>/);
  assert.equal(h.saves.length,0);
});

test('mouse entry retains confirmed experiment or specimen history before possible sources',async t=>{
  const d=buildExperiment({title:'Confirmed procedure',assays:['IMG'],participants:[confirmed('M1')],event_date:'2026-10-14'},base()).dataset;
  const h=await harness(t,d,{initialMouseId:'M1'});assert.match(h.container.innerHTML,/data-id="experiments" aria-pressed="true"/);assert.match(h.container.innerHTML,/Confirmed procedure/);assert.match(h.container.innerHTML,/Possible source matches \(1\)/);
  const sampled=buildExperimentSample({label:'Confirmed donor specimen',donors:[confirmed('M1')],event_date:'2026-10-14'},base()).dataset;
  const h2=await harness(t,sampled,{initialMouseId:'M1'});assert.match(h2.container.innerHTML,/data-id="samples" aria-pressed="true"/);assert.match(h2.container.innerHTML,/Confirmed donor specimen/);
});

test('reused identifiers show ambiguous candidates and each observation counts once',async t=>{
  const d=base();d.tables.mice.push({mouse_sid:'M3',physical_tag:'P1',state:'Ended'});d.tables.experiment_sources[0].raw_identifiers=['P1','M1','<script>untrusted</script>'];const before=clone(d);
  const h=await harness(t,d,{canEdit:()=>false});assert.match(h.container.innerHTML,/Possible exact-identifier matches \(ambiguous\)/);assert.match(h.container.innerHTML,/data-exp-action="mouse" data-id="M1"/);assert.match(h.container.innerHTML,/data-exp-action="mouse" data-id="M3"/);
  assert.match(h.container.innerHTML,/<span>Possible source matches<\/span><strong>1<\/strong>/);assert.match(h.container.innerHTML,/&lt;script&gt;untrusted&lt;\/script&gt;/);assert.doesNotMatch(h.container.innerHTML,/<script>untrusted/);
  await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/Exact identifier matches only; participation requires confirmation/);assert.doesNotMatch(h.container.innerHTML,/data-exp-action="review"/);assert.deepEqual(h.dataset,before);assert.equal(h.saves.length,0);
});

test('specimen labels never show mouse candidates or count as possible animal matches',async t=>{
  const d=base();d.tables.experiment_sources[0].identifier_kind='sample_label';const h=await harness(t,d);
  assert.match(h.container.innerHTML,/Sample label/);assert.doesNotMatch(h.container.innerHTML,/data-exp-action="mouse"/);assert.match(h.container.innerHTML,/<span>Possible source matches<\/span><strong>0<\/strong>/);
  await h.click('source','SOURCE-1');assert.doesNotMatch(h.container.innerHTML,/Possible animal matches/);
});

test('restricted source archives hide cached evidence and report Restricted instead of zero',async t=>{
  const d=base(),h=await harness(t,d);assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);await h.click('source','SOURCE-1');
  d.source_archive_restricted=true;h.render(d);
  assert.match(h.container.innerHTML,/Source archive restricted for this account/);assert.match(h.container.innerHTML,/<span>Imported records<\/span><strong>Restricted<\/strong>/);assert.match(h.container.innerHTML,/<span>Possible source matches<\/span><strong>Restricted<\/strong>/);
  assert.doesNotMatch(h.container.innerHTML,/Experiment Sheet 2024|data-id="SOURCE-1"|P1 · M1|0 records/);
  await h.click('source','SOURCE-1');await h.click('review','SOURCE-1');assert.doesNotMatch(h.container.innerHTML,/id="experiment-form"/);assert.equal(h.saves.length,0);
  await h.click('tab','experiments');assert.match(h.container.innerHTML,/Managed experiments and samples remain available/);assert.doesNotMatch(h.container.innerHTML,/View Source history/);
});

test('a loaded empty archive is distinct from restricted access',async t=>{
  const d=base();d.tables.experiment_sources=[];const h=await harness(t,d);
  assert.match(h.container.innerHTML,/No imported source observations are available in this dataset/);assert.match(h.container.innerHTML,/<span>Imported records<\/span><strong>0<\/strong>/);assert.doesNotMatch(h.container.innerHTML,/Source archive restricted/);
});

test('source match totals refresh when the mouse index is replaced',async t=>{
  const d=base(),h=await harness(t,d);assert.match(h.container.innerHTML,/<span>Possible source matches<\/span><strong>1<\/strong>/);
  d.tables.mice=[{mouse_sid:'M9',physical_tag:'Other',state:'Stock'}];h.render(d);assert.match(h.container.innerHTML,/<span>Possible source matches<\/span><strong>0<\/strong>/);assert.doesNotMatch(h.container.innerHTML,/data-exp-action="mouse" data-id="M1"/);
});


test('a source-review draft closes when archive access becomes restricted',async t=>{
  const d=base(),h=await harness(t,d);await h.click('review','SOURCE-1');assert.match(h.container.innerHTML,/id="experiment-form"/);
  d.source_archive_restricted=true;h.render(d);assert.doesNotMatch(h.container.innerHTML,/id="experiment-form"|Experiment Sheet 2024/);assert.match(h.container.innerHTML,/Source archive restricted/);
  await h.save();assert.equal(h.saves.length,0);
});


const contextSupplement=(extra={})=>({source_id:'SUPPLEMENT-1',kind:'source_matrix_review',evidence_kind:'instrument_block_recovery',evidence_title:'LumiCycle preparation and channel context',contextual_correction_for_source_ids:['SOURCE-1'],requires_manual_block_review:true,date:'2024-01-10',assays:['LumiCycle'],raw_identifiers:['P1'],animal_link_status:'unresolved',review_status:'unreviewed',raw_values:{'Evidence title':'LumiCycle preparation and channel context','Review warning':'Unreviewed context; verify animal identity and distinct decapitation, sampling and preparation times.','Block boundary reason':'Original preparation and channels require separate review.'},...extra});

test('context supplements have meaningful titles and reciprocal links without replacing original evidence',async t=>{
  const d=base();d.tables.experiment_sources.push(contextSupplement());const before=clone(d),h=await harness(t,d);
  assert.match(h.container.innerHTML,/LumiCycle preparation and channel context/);assert.match(h.container.innerHTML,/Instrument block context/);assert.match(h.container.innerHTML,/Context supplement/);
  await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/Context &amp; timing supplements/);assert.match(h.container.innerHTML,/do not replace or invalidate the whole original observation/);assert.match(h.container.innerHTML,/data-exp-action="source" data-id="SUPPLEMENT-1"/);assert.match(h.container.innerHTML,/&lt;script&gt;raw source/);
  await h.click('source','SUPPLEMENT-1');assert.match(h.container.innerHTML,/<h2>LumiCycle preparation and channel context<\/h2>/);assert.match(h.container.innerHTML,/Related original observations/);assert.match(h.container.innerHTML,/data-exp-action="source" data-id="SOURCE-1"/);assert.match(h.container.innerHTML,/Unreviewed context; verify animal identity/);
  assert.equal(h.saves.length,0);assert.deepEqual(h.dataset,before);
});

test('specimen context stays a specimen label during inspection and review',async t=>{
  const d=base();d.tables.experiment_sources=[contextSupplement({evidence_kind:'sample_processing_context',evidence_title:'Nanodrop specimen processing',identifier_kind:'sample_label',contextual_correction_for_source_ids:[],assays:['qPCR']})];const h=await harness(t,d);
  assert.match(h.container.innerHTML,/Sample processing context/);assert.match(h.container.innerHTML,/Sample label/);assert.doesNotMatch(h.container.innerHTML,/data-exp-action="mouse"/);assert.match(h.container.innerHTML,/<span>Possible source matches<\/span><strong>0<\/strong>/);
  await h.click('source','SUPPLEMENT-1');assert.doesNotMatch(h.container.innerHTML,/Possible animal matches/);await h.click('review','SUPPLEMENT-1');assert.match(h.container.innerHTML,/value="Nanodrop specimen processing"/);await h.save();
  const record=h.dataset.tables.husbandry_events.find(r=>r.event_type==='experiment');assert.deepEqual(record.experiment.participants,[]);assert.equal(record.experiment.status,'unreviewed');assert.equal(record.experiment.sampling_at,null);assert.equal(record.source_observation.identifier_kind,'sample_label');
});

test('supplement references escape titles, deduplicate originals and do not invent missing source links',async t=>{
  const d=base();d.tables.experiment_sources.push(contextSupplement({evidence_title:'<img src=x onerror=unsafe>',contextual_correction_for_source_ids:['SOURCE-1','SOURCE-1','MISSING','SUPPLEMENT-1',null]}));const h=await harness(t,d);
  await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/&lt;img src=x onerror=unsafe&gt;/);assert.doesNotMatch(h.container.innerHTML,/<img src=x/);
  await h.click('source','SUPPLEMENT-1');assert.equal((h.container.innerHTML.match(/data-exp-action="source" data-id="SOURCE-1"/g)||[]).length,1);assert.match(h.container.innerHTML,/MISSING · Original observation unavailable/);assert.doesNotMatch(h.container.innerHTML,/data-exp-action="source" data-id="MISSING"|data-exp-action="source" data-id="SUPPLEMENT-1"/);
});

test('a previously reviewed experiment surfaces new source supplements without rewriting its record',async t=>{
  const d=base(),source=clone(d.tables.experiment_sources[0]);const built=buildExperiment({title:'Existing reviewed record',assays:['LumiCycle'],event_date:'2024-01-10'},d,null,{sourceRecord:{source_id:source.source_id,source_observation:source,source_raw_values:source.raw_values}});
  built.dataset.tables.experiment_sources.push(contextSupplement());const before=clone(built.dataset),h=await harness(t,built.dataset);await h.click('open',built.record.event_id);
  assert.match(h.container.innerHTML,/Preserved source/);assert.match(h.container.innerHTML,/data-exp-action="source" data-id="SUPPLEMENT-1"/);assert.deepEqual(h.dataset,before);assert.equal(h.saves.length,0);
  h.dataset.source_archive_restricted=true;h.render();assert.doesNotMatch(h.container.innerHTML,/data-id="SUPPLEMENT-1"/);
});


function compactSourceDraft(dataset=base()){
 const source=dataset.tables.experiment_sources[0];return buildExperiment({title:'Imported channel observation',status:'unreviewed',assays:['LumiCycle'],event_date:'2024-01-10',participants:[{mouse_sid:null,raw_identifier:'P1',link_status:'unresolved',candidate_sids:['M1'],role:null,notes:null}]},dataset,null,{eventId:'DRAFT-1',sourceRecord:{record_origin:'imported_experiment_sheet_draft',source_id:source.source_id,source_ref:{schema_version:1,table:'experiment_sources',source_id:source.source_id,source_fingerprint:'synthetic-fingerprint',storage:'immutable_source_archive'},source_observation:{source_id:source.source_id,kind:'instrument_channel',date:source.date,raw_identifiers:clone(source.raw_identifiers)},source_draft:{generator:'experiment-source-drafts-v2-compact',review_status:'unreviewed'}}});
}

test('generated drafts remain in Needs source review and open their existing record instead of duplicating it',async t=>{
 const built=compactSourceDraft(),h=await harness(t,built.dataset);assert.match(h.container.innerHTML,/data-id="sources" aria-pressed="true"/);await h.click('tab','experiments');assert.match(h.container.innerHTML,/Source draft/);assert.match(h.container.innerHTML,/<span>Needs source review<\/span><strong>1<\/strong>/);
 await h.click('tab','sources');h.filter('filter-status','reviewed');assert.match(h.container.innerHTML,/No matching source observations/);h.filter('filter-status','unreviewed');assert.match(h.container.innerHTML,/data-id="SOURCE-1"/);assert.match(h.container.innerHTML,/Needs review/);
 await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/Open experiment draft/);assert.match(h.container.innerHTML,/Review draft/);assert.doesNotMatch(h.container.innerHTML,/Open reviewed experiment|Review as experiment/);
 await h.click('review','SOURCE-1');assert.match(h.container.innerHTML,/already has an experiment record/);assert.equal(h.saves.length,0);
 await h.click('edit','DRAFT-1');h.set('notes','Checked original context only');await h.save();assert.equal(h.dataset.tables.husbandry_events.filter(r=>r.event_type==='experiment').length,1);assert.equal(h.dataset.tables.husbandry_events.find(r=>r.event_id==='DRAFT-1').experiment.status,'unreviewed');assert.match(h.container.innerHTML,/<span>Needs source review<\/span><strong>1<\/strong>/);
 await h.click('edit','DRAFT-1');h.set('status','completed');await h.save();assert.match(h.container.innerHTML,/<span>Needs source review<\/span><strong>0<\/strong>/);assert.equal(h.dataset.tables.husbandry_events.find(r=>r.event_id==='DRAFT-1').source_draft.review_status,'unreviewed');
 await h.click('source','SOURCE-1');assert.match(h.container.innerHTML,/Open reviewed experiment/);
});

test('compact drafts hydrate archived timing only for inspection without expanding or altering stored records',async t=>{
 const d=base();d.tables.experiment_sources[0].raw_values={Decap:'09:00',Sampling:'09:03',Entrainment:'LP1 (30)'};const built=compactSourceDraft(d),before=clone(built.dataset),h=await harness(t,built.dataset);
 await h.click('open','DRAFT-1');assert.match(h.container.innerHTML,/Preserved source/);assert.match(h.container.innerHTML,/09:00|09:03/);assert.match(h.container.innerHTML,/LP1 \(30\)/);assert.deepEqual(h.dataset,before);
 await h.click('edit','DRAFT-1');assert.equal(h.container.querySelector('[name="sampling_at"]').value,'');assert.equal(h.container.querySelector('[name="decapitation_at"]').value,'');h.set('notes','Review note');await h.save();const saved=h.dataset.tables.husbandry_events.find(r=>r.event_id==='DRAFT-1');assert.equal(saved.source_raw_values,undefined);assert.deepEqual(saved.source_ref,before.tables.husbandry_events[0].source_ref);assert.equal(saved.experiment.sampling_at,null);
});

test('compact draft evidence reports unavailable or restricted rather than empty raw values',async t=>{
 const built=compactSourceDraft();built.dataset.tables.experiment_sources=[];const h=await harness(t,built.dataset);await h.click('open','DRAFT-1');assert.match(h.container.innerHTML,/Original source evidence is unavailable/);assert.doesNotMatch(h.container.innerHTML,/<summary>Original source values/);
 h.dataset.source_archive_restricted=true;h.render();assert.match(h.container.innerHTML,/Source archive restricted for this account/);assert.doesNotMatch(h.container.innerHTML,/Original source evidence is unavailable/);
});

test('compact source reference inconsistencies do not hydrate a different original record',async t=>{
 const built=compactSourceDraft();built.record.source_ref.source_id='OTHER-SOURCE';const h=await harness(t,built.dataset);await h.click('open','DRAFT-1');assert.match(h.container.innerHTML,/Original source reference is inconsistent/);assert.doesNotMatch(h.container.innerHTML,/&lt;script&gt;raw source/);
});

test('coverage displays the latest appended report while retaining older coverage data',async t=>{
 const d=base();d.tables.experiment_source_coverage=[{total_source_workbooks:52,sheets:698,preparation_contexts:1524},{total_source_workbooks:53,sheets:700,preparation_contexts:1800}];const before=clone(d.tables.experiment_source_coverage),h=await harness(t,d);assert.match(h.container.innerHTML,/53 source workbooks/);assert.match(h.container.innerHTML,/700 Experiment Sheet tabs/);assert.doesNotMatch(h.container.innerHTML,/52 source workbooks/);assert.deepEqual(h.dataset.tables.experiment_source_coverage,before);
});

test('repeated managed searches preserve results and restriction changes invalidate raw-source search',async t=>{
 const built=compactSourceDraft(),d=built.dataset;d.tables.husbandry_events[0].source_raw_values={private_test:'hidden-evidence-phrase'};const h=await harness(t,d);await h.click('tab','experiments');
 const search=value=>{const input=h.container.querySelector('[name="search"]');input.value=value;h.container.oninput({target:input})};
 search('hidden-evidence-phrase');assert.match(h.container.innerHTML,/Imported channel observation/);search('hidden-evidence');assert.match(h.container.innerHTML,/Imported channel observation/);
 d.source_archive_restricted=true;h.render(d);assert.match(h.container.innerHTML,/No matching records/);search('Imported channel');assert.match(h.container.innerHTML,/Imported channel observation/);
});

test('compact draft detail translates review flags without exposing technical metadata or confirming animals',async t=>{
 const built=compactSourceDraft();built.record.source_draft.flags=['identity_and_completion_unreviewed','candidate_birth_after_source_date','ambiguous_animal_candidates','unmatched_animal_identifier','event_date_unknown','specimen_labels_are_not_animal_identifiers','assay_result_not_verified','planning_or_template_text_with_recorded_result_needs_review','same_source_cell_has_other_observations_not_merged','one_source_observation_not_one_biological_event','no_current_specimen_stock_claim','candidate_birth_after_source_date','<img src=x onerror=unsafe>'];
 const before=clone(built.dataset),h=await harness(t,built.dataset);await h.click('open','DRAFT-1');const html=h.container.innerHTML;
 assert.match(html,/<h3>Review needed<\/h3>/);assert.equal((html.match(/A candidate was born after the source date/g)||[]).length,1);
 for(const text of ['An identifier matches several animals','An animal identifier has no match','The event date is unknown','specimen labels, not animal IDs','assay result has not been verified','Planning or template text','Other observations share these source cells','not necessarily a separate experiment','completion are unconfirmed','current specimen stock','Additional source checks need review'])assert(html.includes(text),text);
 assert.doesNotMatch(html,/candidate_birth_after_source_date|source_fingerprint|experiment-source-drafts|<img src=x|&lt;img src=x/);
 assert.match(html,/<span>Confirmed animals<\/span><strong>0<\/strong>/);assert.deepEqual(h.dataset,before);assert.equal(h.saves.length,0);
});

test('unresolved participant details link saved candidate mice without promoting or inventing identities',async t=>{
 const built=compactSourceDraft();built.record.experiment.participants[0].candidate_sids=['M1','M1','M2','MISSING'];built.record.experiment.participants[0].raw_identifier='<untrusted tag>';
 const before=clone(built.dataset),h=await harness(t,built.dataset,{canEdit:()=>false});await h.click('open','DRAFT-1');
 assert.match(h.container.innerHTML,/Unresolved: &lt;untrusted tag&gt;/);assert.match(h.container.innerHTML,/Possible matches, verify before confirming \(ambiguous\) · Unconfirmed/);
 for(const id of ['M1','M2'])assert.equal((h.container.innerHTML.match(new RegExp(`data-exp-action="mouse" data-id="${id}"`,'g'))||[]).length,1);
 assert.doesNotMatch(h.container.innerHTML,/data-exp-action="mouse" data-id="MISSING"|Confirm SID/);assert.match(h.container.innerHTML,/Some saved candidates are unavailable/);
 await h.click('mouse','M1');assert.deepEqual(h.messages,[{mouse:'M1'}]);assert.deepEqual(h.dataset,before);assert.equal(h.saves.length,0);assert.equal(built.record.experiment.participants[0].mouse_sid,null);
});

test('participant editor offers candidate record links while confirmation remains explicit',async t=>{
 const built=compactSourceDraft(),h=await harness(t,built.dataset);await h.click('edit','DRAFT-1');
 assert.match(h.container.innerHTML,/Possible matches, verify before confirming · Unconfirmed/);assert.match(h.container.innerHTML,/data-exp-action="mouse" data-id="M1"/);assert.match(h.container.innerHTML,/Confirm SID/);
 await h.click('mouse','M1');assert.equal(h.saves.length,0);assert.equal(h.dataset.tables.husbandry_events[0].experiment.participants[0].link_status,'unresolved');
 h.input('[data-resolve="0"]','M1');await h.click('resolve','0');assert.doesNotMatch(h.container.innerHTML,/Possible matches, verify before confirming/);await h.save();assert.equal(h.dataset.tables.husbandry_events.find(r=>r.event_id==='DRAFT-1').experiment.participants[0].link_status,'confirmed');
});

test('unmatched and specimen identifiers remain unconfirmed with no candidate donor links',async t=>{
 const built=compactSourceDraft();built.record.experiment.participants[0].candidate_sids=[];built.record.source_draft.flags=['unmatched_animal_identifier'];const h=await harness(t,built.dataset);await h.click('open','DRAFT-1');
 assert.match(h.container.innerHTML,/No matching animal recorded. Identity remains unconfirmed/);assert.doesNotMatch(h.container.innerHTML,/data-exp-action="mouse"/);
 // Defensive rendering: even a legacy sample-label record with candidate IDs
 // cannot present those specimen labels as inferred donors.
 const next=clone(h.dataset),r=next.tables.husbandry_events[0];r.source_observation.identifier_kind='sample_label';r.experiment.participants[0].candidate_sids=['M1'];r.source_draft.flags=['specimen_labels_are_not_animal_identifiers'];h.render(next);
 assert.match(h.container.innerHTML,/These are specimen labels, not animal IDs/);assert.match(h.container.innerHTML,/Specimen label, not an animal ID. No donor is inferred/);assert.doesNotMatch(h.container.innerHTML,/data-exp-action="mouse"/);
 await h.click('edit','DRAFT-1');assert.doesNotMatch(h.container.innerHTML,/data-exp-action="mouse"/);assert.equal(h.saves.length,0);
});

test('import warnings remain historical after explicit status review and ordinary records have no import warnings',async t=>{
 const built=compactSourceDraft();built.record.source_draft.flags=['identity_and_completion_unreviewed','candidate_birth_after_source_date'];built.record.experiment.status='completed';const before=clone(built.dataset),h=await harness(t,built.dataset);await h.click('open','DRAFT-1');
 assert.match(h.container.innerHTML,/<summary>Warnings recorded at import<\/summary>/);assert.doesNotMatch(h.container.innerHTML,/<h3>Review needed<\/h3>/);assert.match(h.container.innerHTML,/class="badge blue">completed/);assert.deepEqual(h.dataset,before);
 const ordinary=buildExperiment({title:'Manual planned experiment',assays:['qPCR'],event_date:'2026-10-14'},base()),other=await harness(t,ordinary.dataset);await other.click('open',ordinary.record.event_id);assert.doesNotMatch(other.container.innerHTML,/Review needed|Warnings recorded at import/);
});

test('unreviewed source draft rows show recorded identifiers and unique possible matches instead of zero-use counts',async t=>{
 const built=compactSourceDraft();built.record.source_observation.raw_identifiers=['P1','P1','<animal tag>','Other','Fourth'];built.record.experiment.participants.push({mouse_sid:null,raw_identifier:'Other',link_status:'unresolved',candidate_sids:['M1','M2','M2','MISSING'],role:null,notes:null});
 const before=clone(built.dataset),h=await harness(t,built.dataset);await h.click('tab','experiments');const html=h.container.innerHTML;
 assert.match(html,/Recorded animal identifiers/);assert.match(html,/<span title="P1">P1<\/span>/);assert.match(html,/&lt;animal tag&gt;/);assert.match(html,/<summary>1 more<\/summary>/);assert.match(html,/Fourth/);
 assert.match(html,/<span class="badge amber">Unconfirmed<\/span>/);assert.match(html,/2 possible animal matches/);assert.doesNotMatch(html,/0 animals · 0 samples|<animal tag>/);
 assert.match(html,/<span>Confirmed animals<\/span><strong>0<\/strong>/);assert.deepEqual(h.dataset,before);assert.equal(h.saves.length,0);
});

test('source draft sample labels remain specimen evidence and never imply candidate animal use',async t=>{
 const built=compactSourceDraft();built.record.source_observation.identifier_kind='sample_label';built.record.source_observation.raw_identifiers=['WB-SCN-01','P1'];
 const before=clone(built.dataset),h=await harness(t,built.dataset);await h.click('tab','experiments');assert.match(h.container.innerHTML,/Recorded sample labels/);assert.match(h.container.innerHTML,/WB-SCN-01/);assert.match(h.container.innerHTML,/<span class="badge amber">Unconfirmed<\/span>/);
 assert.doesNotMatch(h.container.innerHTML,/possible animal match|Recorded animal identifiers|0 animals · 0 samples/);assert.deepEqual(h.dataset,before);assert.equal(h.saves.length,0);
});

test('draft rows fall back to participant identifiers and show honest missing identifiers without hydrating source archive',async t=>{
 const built=compactSourceDraft();delete built.record.source_observation.raw_identifiers;built.dataset.tables.experiment_sources=[];
 const h=await harness(t,built.dataset);await h.click('tab','experiments');assert.match(h.container.innerHTML,/<span title="P1">P1<\/span>/);assert.match(h.container.innerHTML,/1 possible animal match/);assert.doesNotMatch(h.container.innerHTML,/0 animals · 0 samples/);
 const next=clone(h.dataset);next.tables.husbandry_events[0].experiment.participants=[];h.render(next);assert.match(h.container.innerHTML,/Identifiers not recorded/);assert.match(h.container.innerHTML,/<span class="badge amber">Unconfirmed<\/span>/);assert.doesNotMatch(h.container.innerHTML,/possible animal match|0 animals · 0 samples/);
});

test('reviewed records retain confirmed counts and partially linked drafts show explicit confirmed associations',async t=>{
 const built=compactSourceDraft();built.record.experiment.participants=[confirmed('M1')];const h=await harness(t,built.dataset);await h.click('tab','experiments');
 assert.match(h.container.innerHTML,/Recorded animal identifiers/);assert.match(h.container.innerHTML,/1 confirmed animal/);assert.doesNotMatch(h.container.innerHTML,/possible animal match/);
 const next=clone(h.dataset);next.tables.husbandry_events[0].experiment.status='completed';h.render(next);assert.match(h.container.innerHTML,/1 animals · 0 samples/);assert.doesNotMatch(h.container.innerHTML,/Recorded animal identifiers|<span class="badge amber">Unconfirmed<\/span>/);
 const ordinary=buildExperiment({title:'Manual unreviewed record',status:'unreviewed',assays:['qPCR'],participants:[confirmed('M1')],event_date:'2026-10-14'},base()),other=await harness(t,ordinary.dataset);assert.match(other.container.innerHTML,/1 animals · 0 samples/);assert.doesNotMatch(other.container.innerHTML,/Recorded animal identifiers/);
});

test('only generated unreviewed drafts default to Source history so newer unsupported source records remain visible',async t=>{
 const built=compactSourceDraft();built.dataset.tables.experiment_sources.push({...clone(built.dataset.tables.experiment_sources[0]),source_id:'LATEST-SOURCE',kind:'instrument_channel',date:'2026-10-05',sheet_name:'Current imaging'});const before=clone(built.dataset),h=await harness(t,built.dataset);
 assert.match(h.container.innerHTML,/data-id="sources" aria-pressed="true"/);assert.match(h.container.innerHTML,/2026-10-05/);assert.match(h.container.innerHTML,/data-exp-action="source" data-id="LATEST-SOURCE"/);assert.match(h.container.innerHTML,/<span>Managed experiments<\/span><strong>1<\/strong>/);assert.deepEqual(h.dataset,before);
 await h.click('tab','experiments');h.render(clone(h.dataset));assert.match(h.container.innerHTML,/data-id="experiments" aria-pressed="true"/);assert.match(h.container.innerHTML,/Imported channel observation/);
});

test('a manual or reviewed experiment retains the Experiments default even with source drafts',async t=>{
 for(const reviewStatus of ['planned','in_progress','completed','cancelled']){
  const built=compactSourceDraft(),reviewed=clone(built.record);reviewed.event_id='REVIEWED';reviewed.source_id='SOURCE-REVIEWED';reviewed.experiment.status=reviewStatus;built.dataset.tables.husbandry_events.push(reviewed);
  const h=await harness(t,built.dataset);assert.match(h.container.innerHTML,/data-id="experiments" aria-pressed="true"/);
 }
 const built=compactSourceDraft(),manual=clone(built.record);manual.event_id='MANUAL';delete manual.record_origin;delete manual.source_id;delete manual.source_draft;built.dataset.tables.husbandry_events.push(manual);
 const h=await harness(t,built.dataset);assert.match(h.container.innerHTML,/data-id="experiments" aria-pressed="true"/);
});

test('explicit record and mouse entry take precedence over the source-draft default',async t=>{
 const built=compactSourceDraft(),h=await harness(t,built.dataset,{initialRecordId:'DRAFT-1'});assert.match(h.container.innerHTML,/<h2>Imported channel observation<\/h2>/);assert.match(h.container.innerHTML,/Preserved source/);await h.click('back');assert.match(h.container.innerHTML,/data-id="experiments" aria-pressed="true"/);
 const linked=compactSourceDraft();linked.record.experiment.participants=[confirmed('M1')];const byMouse=await harness(t,linked.dataset,{initialMouseId:'M1'});assert.match(byMouse.container.innerHTML,/data-id="experiments" aria-pressed="true"/);assert.match(byMouse.container.innerHTML,/Imported channel observation/);
});
