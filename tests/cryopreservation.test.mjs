import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDataset,validateRecord} from '../web/model.js';
import {cryoSourceLotId,buildCryoActivity} from '../web/cryopreservation-model.js';
import {discoverCryoSources} from '../web/cryo-sources.js';

let serial=0;
function sourceIndex() {
  const headings=['案件編號','品系','遺傳背景','基改方式','基因名稱','合子型','來源','麥管批號','冷凍日期','結餘管數','製表人 / 發行人','實驗鼠種原庫服務'];
  const sources=[{title:'Synthetic source 2023',url:'https://example.test/source',snapshot_date:'2023-01-01',snapshot_date_basis:'date_in_title'},{title:'Synthetic source 2024',url:'https://example.test/source-2',snapshot_date:'2024-01-01',snapshot_date_basis:'date_in_title'}],sheets=sources.map((_,source_index)=>({source_index,title:'Cryopreservation',sheet_id:9})),cells=[];
  for(let sheet=0;sheet<2;sheet++){
    const rows={1:['Cryopreservation information'],2:headings,3:['CASE-A','Synthetic strain M99','Background','Knock-in','Raw gene text','Raw zygosity','Origin','BATCH-A, BATCH-B','2022-01-01',sheet===0?10:null,'Source preparer','00123'],5:['Strains to transfer'],6:[1,'Historical planned line','TAG-PLANNED','M & F']};
    for(const [row,values] of Object.entries(rows))values.forEach((value,column)=>{if(value!==null)cells.push([sheet,`${String.fromCharCode(65+column)}${row}`,value,value,null,'General',null])});
  }
  return {sources,sheets,cells};
}
const lot=(id='CRYO-TEST',quantity=null)=>({event_id:id,event_type:'cryopreservation_lot',event_date:'2025-01-01',record_origin:'app_created',cryopreservation:{schema_version:1,label:'Synthetic lot',case_id:'CASE-MANUAL',strain:'Synthetic strain',background:null,modification_method:null,gene:null,zygosity:null,origin:null,batch_ids:['B1','B2'],frozen_date:'2022-01-01',material:'unknown',status:quantity===0?'depleted':'unreviewed',manager:'Keeper',storage_location:{facility:'Bank',tank:'Tank 1',canister:'C1',position:'P1'},quantity,quantity_unit:'straws',quantity_as_of_date:quantity===null?null:'2025-01-01',activity_revision:0,last_activity_id:null,donor_mouse_sids:[]}});
async function harness(t,tables={},overrides={}) {
  const {renderCryopreservation}=await import(`../web/cryopreservation.js?test=${++serial}`);
  const container={innerHTML:'',querySelectorAll(){return []}};let dataset=normalizeDataset({tables:{mice:[{mouse_sid:'DONOR-1',sex:'Male',state:'Stock'}],...tables}});const saves=[],messages=[],checks=[];
  const hooks={historyIndex:sourceIndex(),canEdit:()=>true,isCloud:()=>false,validate:(type,draft,base,id)=>{checks.push({draft:structuredClone(draft),base:structuredClone(base),id});return validateRecord(type,draft,base,id)},toast:(message,error)=>messages.push({message,error}),openMouse:id=>messages.push({opened:id}),save:async next=>{dataset=structuredClone(next);saves.push(dataset);renderCryopreservation(container,dataset,hooks)},...overrides};
  renderCryopreservation(container,dataset,hooks);
  return {container,hooks,saves,messages,checks,get dataset(){return dataset},
    async click(action,meta={}){await container.onclick({target:{closest:()=>({dataset:{cryoAction:action,...meta},disabled:false})}})},
    field(key,value){container.oninput({target:{value,tagName:'INPUT',dataset:{cryoField:'editor',key}}})},
    change(key,value){container.onchange({target:{value,tagName:'SELECT',dataset:{cryoField:'editor',key}}})},
    filter(key,value){container.onchange({target:{value,dataset:{cryoField:'filter',key}}})},
    search(value){container.onchange({target:{value,dataset:{cryoField:'search'}}})},
    render(next=dataset){dataset=next;renderCryopreservation(container,dataset,hooks)},
    source(){return discoverCryoSources(dataset,hooks.historyIndex).groups[0]},
    async activity(type,quantity='',status=''){await this.click('activity',{id:dataset.tables.husbandry_events.find(row=>row.event_type==='cryopreservation_lot').event_id});this.change('activity_type',type);this.field('event_date','2025-06-01');this.field('quantity',quantity);if(status)this.change('status',status)}
  };
}

test('source cases preserve combined batches, historical count date and separate historical transfer plans',async t=>{
  const h=await harness(t);assert.match(h.container.innerHTML,/BATCH-A, BATCH-B/);assert.match(h.container.innerHTML,/Source report: 10 straws · 2023-01-01/);assert.doesNotMatch(h.container.innerHTML,/Source report: 10 straws · 2024-01-01/);assert.match(h.container.innerHTML,/Historical count, current stock unverified/);
  await h.click('tab',{tab:'plans'});assert.match(h.container.innerHTML,/Source transfer plans/);assert.match(h.container.innerHTML,/do not establish currently pending work/);assert.match(h.container.innerHTML,/Historical planned line/);assert.doesNotMatch(h.container.innerHTML,/data-cryo-action="review-source"/);assert.equal(h.saves.length,0);
});

test('explicit source review creates one unknown-stock lot, preserving source and no inferred donors',async t=>{
  const h=await harness(t),source=h.source();await h.click('review-source',{id:source.id});h.field('quantity','99');h.field('source_reported_quantity','99');await h.click('save');
  assert.equal(h.saves.length,1);const saved=h.dataset.tables.husbandry_events[0];assert.equal(saved.event_id,cryoSourceLotId(source.id));assert.equal(saved.cryopreservation.quantity,null);assert.deepEqual(saved.cryopreservation.batch_ids,['BATCH-A','BATCH-B']);assert.deepEqual(saved.cryopreservation.donor_mouse_sids,[]);assert.equal(saved.cryopreservation.material,'unknown');assert.equal(saved.cryopreservation.manager,null);assert.equal(saved.source_reported_quantity,10);assert.equal(saved.source_reported_quantity_source.snapshot_date,'2023-01-01');assert.deepEqual(saved.source_snapshots,source.source_snapshots);
  await h.click('review-source',{id:source.id});assert.match(h.container.innerHTML,/already has a managed record/);assert.equal(h.saves.length,1);
});

test('stocktake and final use atomically save lot revisions and immutable dated events',async t=>{
  const h=await harness(t,{husbandry_events:[lot()]});await h.activity('stocktake','5','stored');await h.click('save');
  assert.equal(h.saves.length,1);let current=h.dataset.tables.husbandry_events.find(row=>row.event_type==='cryopreservation_lot');assert.equal(current.cryopreservation.quantity,5);assert.equal(current.cryopreservation.activity_revision,1);
  let event=h.dataset.tables.husbandry_events.find(row=>row.event_type==='cryopreservation_event');assert.equal(current.cryopreservation.last_activity_id,event.event_id);assert.equal(event.cryopreservation_event.before.quantity,null);assert.equal(event.cryopreservation_event.after.quantity,5);
  const anchorCheck=h.checks.find(row=>row.draft.event_type==='cryopreservation_lot');assert.equal(anchorCheck.base.tables.husbandry_events.find(row=>row.event_id===current.event_id).cryopreservation.quantity,null);assert(anchorCheck.base.tables.husbandry_events.some(row=>row.event_id===event.event_id));
  await h.activity('use','5','depleted');assert.match(h.container.innerHTML,/Resulting status/);await h.click('save');
  assert.equal(h.saves.length,2);current=h.dataset.tables.husbandry_events.find(row=>row.event_type==='cryopreservation_lot');assert.equal(current.cryopreservation.quantity,0);assert.equal(current.cryopreservation.status,'depleted');assert.equal(current.cryopreservation.activity_revision,2);
  await h.click('tab',{tab:'history'});assert.match(h.container.innerHTML,/5 straws → 0 straws/);assert.match(h.container.innerHTML,/Recorded count: 5 straws/);assert.match(h.container.innerHTML,/Synthetic lot/);
});

test('unknown opening stock stays unknown through use and history records the explicit amount',async t=>{
  const h=await harness(t,{husbandry_events:[lot()]});await h.activity('use','2');await h.click('save');assert.equal(h.saves.length,1);assert.equal(h.dataset.tables.husbandry_events[0].cryopreservation.quantity,null);
  await h.click('tab',{tab:'history'});assert.match(h.container.innerHTML,/Unknown → Unknown/);assert.match(h.container.innerHTML,/Recorded count: 2 straws/);
});

test('overdraws are rejected and failed cloud saves preserve the activity draft',async t=>{
  const h=await harness(t,{husbandry_events:[lot('CRYO-TEST',2)]});await h.activity('use','3');await h.click('save');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/exceeds the recorded current stock/);
  h.hooks.save=async()=>{throw new Error('Synthetic version conflict')};h.field('quantity','1');await h.click('save');assert.match(h.container.innerHTML,/Synthetic version conflict/);assert.match(h.container.innerHTML,/cryo-editor/);assert.equal(h.dataset.tables.husbandry_events[0].cryopreservation.quantity,2);assert.doesNotMatch(h.container.innerHTML,/aria-busy="true"/);
});

test('metadata edits validate against the original record and cannot alter source provenance',async t=>{
  const h=await harness(t),source=h.source();await h.click('review-source',{id:source.id});await h.click('save');const original=structuredClone(h.dataset.tables.husbandry_events[0]);h.checks.length=0;
  await h.click('edit',{id:original.event_id});h.field('label','Reviewed label');h.field('source_reported_quantity','999');h.field('manager','Unrecorded manager');await h.click('save');
  const saved=h.dataset.tables.husbandry_events[0];assert.equal(saved.cryopreservation.label,'Reviewed label');assert.equal(saved.source_reported_quantity,10);assert.deepEqual(saved.source_snapshots,original.source_snapshots);assert.equal(saved.cryopreservation.manager,null);assert.equal(h.checks[0].base.tables.husbandry_events[0].cryopreservation.label,original.cryopreservation.label);
});

test('manager and storage changes are dated, and recovered animals must be exact existing IDs',async t=>{
  const h=await harness(t,{husbandry_events:[lot()]});await h.activity('relocation');h.field('manager','New keeper');h.field('storage_tank','Tank 2');await h.click('save');assert.equal(h.saves.length,1);
  await h.click('tab',{tab:'history'});assert.match(h.container.innerHTML,/Manager: Keeper → New keeper/);assert.match(h.container.innerHTML,/Tank 1/);assert.match(h.container.innerHTML,/Tank 2/);
  await h.activity('recovery');h.change('recovery_status','recovered');h.field('recovered_mouse_sids','ABSENT');await h.click('save');assert.equal(h.saves.length,1);assert.match(h.container.innerHTML,/mouse ABSENT does not exist/);
  h.field('recovered_mouse_sids','DONOR-1');await h.click('save');assert.equal(h.saves.length,2);assert.equal(h.dataset.tables.mice.length,1);await h.click('tab',{tab:'history'});assert.match(h.container.innerHTML,/Recovery: recovered/);
});

test('readonly users can browse source and history but cannot open or save management drafts',async t=>{
  const h=await harness(t,{husbandry_events:[lot()]},{canEdit:()=>false});assert.doesNotMatch(h.container.innerHTML,/data-cryo-action="new"|data-cryo-action="review-source"/);await h.click('view',{id:'CRYO-TEST'});assert.doesNotMatch(h.container.innerHTML,/data-cryo-action="edit"|data-cryo-action="activity"/);
  await h.click('activity',{id:'CRYO-TEST'});assert.match(h.container.innerHTML,/Edit access is required/);await h.click('save');assert.equal(h.saves.length,0);
});

test('partial source evidence does not fabricate inventory and the loader need not return an index',async t=>{
  let loads=0;const h=await harness(t,{historical_observations:[{source_sheet:'Cryopreservation',source_cell:'A1',raw_text:'Partial <script>not executable</script>',source_title:'Partial source'}]},{historyIndex:null,loadHistory:async()=>{loads++}});
  assert.match(h.container.innerHTML,/Partial source references/);assert.match(h.container.innerHTML,/No cryopreservation records match/);assert.match(h.container.innerHTML,/&lt;script&gt;/);await h.click('load-history');assert.equal(loads,1);assert.equal(h.saves.length,0);
});

test('search/manager/storage filters work and a refreshed dataset invalidates an unsaved draft',async t=>{
  const h=await harness(t,{husbandry_events:[lot()]});h.filter('manager','Keeper');assert.match(h.container.innerHTML,/Synthetic lot/);assert.doesNotMatch(h.container.innerHTML,/CASE-A<\/strong>/);h.filter('storage','Tank 2');assert.match(h.container.innerHTML,/No cryopreservation records match/);h.filter('storage','');h.filter('manager','');h.search('BATCH-A');assert.match(h.container.innerHTML,/CASE-A/);h.search('');
  await h.click('edit',{id:'CRYO-TEST'});h.field('label','Unsaved');h.render(structuredClone(h.dataset));await h.click('save');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Reopen this draft/);
});
