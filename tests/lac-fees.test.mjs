import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLacFees,lacFeeHelpHTML} from '../web/lac-fees.js';
import {blankLacFeeOptions,buildLacFeeOptions,buildLacFeeMonth,blankLacFeeMonth,listLacFeeMonths} from '../web/lac-fee-model.js';
const base=()=>({tables:{mice:[{mouse_sid:'M1',state:'Stock',cage_sid:'C1'}],cages:[{cage_sid:'C1',room_id:'C'}],rooms:[{room_id:'C',name:'Clean'},{room_id:'R',name:'Rat'},{room_id:'S',name:'SPF'},{room_id:'A',name:'Ani Beh'}],racks:[],husbandry_events:[]}});
const configured=()=>{const p=blankLacFeeOptions('2026-01-01');p.excluded_room_ids=['A'];p.groups.forEach((g,i)=>Object.assign(g,{room_ids:[['C','R','S'][i]],rate:[12,15,6.5][i],rate_reference:'Synthetic rate source'}));return buildLacFeeOptions(p,base()).dataset};
function harness(dataset=configured(),overrides={}){const container={innerHTML:''},saves=[],messages=[];let current=dataset;const hooks={canEdit:()=>true,nowDate:()=> '2026-10-14',save:async next=>{current=structuredClone(next);saves.push(current);renderLacFees(container,current,hooks)},toast:message=>messages.push(message),...overrides};renderLacFees(container,current,hooks);return {container,hooks,saves,messages,get dataset(){return current},field(key,value){container.oninput({target:{dataset:{feeField:key},value}})},multi(key,values){container.onchange({target:{dataset:{feeField:key},multiple:true,selectedOptions:values.map(value=>({value}))}})},click(action,id=''){container.onclick({target:{closest:()=>({dataset:{feeAction:action,id}})},preventDefault(){}})},async save(){await container.onsubmit({target:{hasAttribute:key=>key==='data-lac-fee-form'},preventDefault(){}})},render(next=current){current=next;renderLacFees(container,current,hooks)}}}

test('monthly view uses compact dated cards and unavailable historical comparisons stay unknown',()=>{
 const h=harness();assert.match(h.container.innerHTML,/Estimated fee · NT\$/);assert.match(h.container.innerHTML,/<strong>372<\/strong>/);assert.match(h.container.innerHTML,/31 cage-days/);
 assert.match(h.container.innerHTML,/Previous month · NT\$/);assert.match(h.container.innerHTML,/Oct 2026/);assert.match(h.container.innerHTML,/Sep 2026/);
 assert.doesNotMatch(h.container.innerHTML,/Evidence|Dated historical evidence|Not comparable|Current snapshot projection|Estimate limitations/);
 h.field('selected_month','2026-09');assert.match(h.container.innerHTML,/Estimated fee · NT\$<\/span><strong>–<\/strong><small class="fee-unavailable">Unavailable<\/small>/);assert.match(h.container.innerHTML,/Aug 2026/);assert.doesNotMatch(h.container.innerHTML,/No dated quantity evidence|Current snapshot projection/);
});

test('read-only users can view estimates and history but cannot forge fee edits',async()=>{const h=harness(configured(),{canEdit:()=>false});assert.doesNotMatch(h.container.innerHTML,/data-fee-action="edit-month"|data-fee-action="edit-options"/);h.click('edit-options');assert.match(h.container.innerHTML,/Fee edit access is required/);await h.save();assert.equal(h.saves.length,0);h.click('tab','history');assert.match(h.container.innerHTML,/Billing options/)});

test('billing options save exact mappings and source rates as a new immutable revision',async()=>{const h=harness(),before=structuredClone(h.dataset.tables.husbandry_events[0]);h.click('edit-options');h.field('effective_from','2026-10-14');h.field('g0_rate','13');h.field('g0_rate_reference','New documented rate');h.multi('g1_room_ids',['R']);h.multi('excluded_room_ids',['A']);await h.save();assert.equal(h.saves.length,1);const rows=h.dataset.tables.husbandry_events.filter(r=>r.lac_fee_options);assert.equal(rows.length,2);assert.deepEqual(rows[0],before);assert.equal(rows[1].lac_fee_options.groups[0].rate,13);assert.equal(rows[1].lac_fee_options.effective_from,'2026-10-14');assert.equal(rows[1].lac_fee_options.supersedes_event_id,rows[0].event_id);assert.match(h.container.innerHTML,/Saved as a new fee revision/)});

test('record invoice defaults to previous usage month without manufacturing historical occupancy',async()=>{
 const h=harness();h.click('edit-invoice');assert.match(h.container.innerHTML,/name="month"[^>]*value="2026-09"/);h.field('actual_total','1000');h.field('actual_date','2026-10-05');h.field('invoice_reference','Invoice for September');await h.save();
 assert.equal(h.saves.length,1);const p=h.dataset.tables.husbandry_events.find(r=>r.lac_fee_month).lac_fee_month;assert.equal(p.month,'2026-09');assert.equal(p.actual_date,'2026-10-05');assert.equal(p.lines[0].quantity,null);
 assert.match(h.container.innerHTML,/Previous month · NT\$<\/span><strong>1,000<\/strong>/);assert.match(h.container.innerHTML,/Difference · Sep 2026<\/span><strong>–<\/strong>/);
});

test('dated quantity entry enables comparison and flags tolerance rather than adjusting rates',async()=>{const h=harness();h.click('edit-invoice');h.field('actual_total','100');h.field('actual_date','2026-10-05');h.field('invoice_reference','September invoice');for(let i=0;i<3;i++){h.field('l'+i+'_quantity',i===0?'30':'0');h.field('l'+i+'_evidence_reference','September billed quantities')}await h.save();assert.equal(h.saves.length,1);assert.match(h.container.innerHTML,/Above maximum tolerance/);assert.match(h.container.innerHTML,/<strong>\+260<\/strong>/);assert.match(h.container.innerHTML,/<strong>260%<\/strong>/);assert.equal(h.dataset.tables.husbandry_events[0].lac_fee_options.groups[0].rate,12)});

test('fee save failures retain typed draft and refreshed data prevents stale saves',async()=>{const h=harness(configured(),{save:async()=>{throw new Error('Network failed')}});h.click('edit-month');h.field('notes','Local invoice check');await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Network failed/);assert.match(h.container.innerHTML,/Local invoice check/);h.render(structuredClone(h.dataset));assert.match(h.container.innerHTML,/Fee data refreshed/);await h.save();assert.equal(h.saves.length,0)});

test('new fee setup leaves rates and mappings unknown until the user enters them',async()=>{const h=harness(base());assert.match(h.container.innerHTML,/<strong>–<\/strong><small class="fee-unavailable">Unavailable<\/small>/);h.click('tab','options');assert.match(h.container.innerHTML,/No billing options are recorded/);h.click('edit-options');assert.match(h.container.innerHTML,/name="g0_rate"[^>]*value=""/);assert.doesNotMatch(h.container.innerHTML,/value="12"/);h.field('g0_rate','12');await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/source or formula reference/);assert.match(lacFeeHelpHTML(),/Usage month is independent of its payment date/);assert.match(lacFeeHelpHTML(),/rates are never adjusted to force agreement/)});

test('source provenance and notes are shown as escaped text in immutable history',()=>{const p=blankLacFeeMonth('2026-09');p.notes='<script>note</script>';const d=buildLacFeeMonth(p,configured(),null,{sourceRecord:{source_note:'<script>source</script>'}}).dataset,h=harness(d);h.click('tab','history');assert.match(h.container.innerHTML,/&lt;script&gt;note/);assert.match(h.container.innerHTML,/&lt;script&gt;source/);assert.doesNotMatch(h.container.innerHTML,/<script>/)});

test('past snapshots retain observed counts and actual fees while estimates stay unavailable',async()=>{
 const h=harness();h.click('edit-invoice');for(let i=0;i<3;i++){h.field('l'+i+'_evidence_kind','snapshot_projection');assert.match(h.container.innerHTML,new RegExp('name="l'+i+'_evidence_start"[^>]*value=""'));h.field('l'+i+'_evidence_start','2026-09-20');h.field('l'+i+'_snapshot_count',i===0?'2':'0');h.field('l'+i+'_evidence_reference','Animal Sheet snapshot');h.click('project-snapshot',String(i))}h.field('actual_total','700');h.field('actual_date','2026-10-04');h.field('invoice_reference','September invoice');await h.save();
 assert.equal(h.saves.length,1);const p=h.dataset.tables.husbandry_events.find(r=>r.lac_fee_month).lac_fee_month;assert.equal(p.lines[0].quantity,60);assert.equal(p.lines[0].evidence_end,'2026-09-20');assert.equal(p.lines[0].snapshot_count,2);
 assert.match(h.container.innerHTML,/Previous month · NT\$<\/span><strong>700<\/strong>/);assert.match(h.container.innerHTML,/Difference · Sep 2026<\/span><strong>–<\/strong>/);assert.doesNotMatch(h.container.innerHTML,/<strong>720<\/strong>|Within target|Snapshot evidence/);
 h.field('selected_month','2026-09');assert.match(h.container.innerHTML,/Estimated fee · NT\$<\/span><strong>–<\/strong><small class="fee-unavailable">Unavailable<\/small>/);assert.equal((h.container.innerHTML.match(/<td>–<\/td>/g)||[]).length,9);
 h.click('tab','history');assert.match(h.container.innerHTML,/Latest estimated fee · NT\$: <strong>–<\/strong><small class="fee-unavailable">Unavailable<\/small>/);assert.match(h.container.innerHTML,/actual_total&quot;: 700/);
});

test('snapshot projections are never silently regenerated when the entered count changes',async()=>{const h=harness();h.field('selected_month','2026-09');h.click('edit-month');h.field('l0_evidence_kind','snapshot_projection');h.field('l0_evidence_start','2026-09-20');h.field('l0_snapshot_count','2');h.field('l0_evidence_reference','Snapshot');h.click('project-snapshot','0');h.field('l0_snapshot_count','3');await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/times calendar month days/);h.click('project-snapshot','0');await h.save();assert.equal(h.saves.length,1);assert.equal(h.dataset.tables.husbandry_events.find(r=>r.lac_fee_month).lac_fee_month.lines[0].quantity,90)});

test('malformed shared option scalars are escaped in options and do not enter compact monthly view',()=>{const d=configured();d.tables.husbandry_events[0].lac_fee_options.target_percent='<img src=x onerror=alert(1)>';const h=harness(d);assert.doesNotMatch(h.container.innerHTML,/<img/);h.click('tab','options');assert.doesNotMatch(h.container.innerHTML,/<img/);assert.match(h.container.innerHTML,/&lt;img/)});

test('source caveats and notes stay in history without cluttering the monthly view',()=>{
 const p=blankLacFeeMonth('2026-10');p.notes='SPF placeholder counts are provisional <script>';const d=buildLacFeeMonth(p,configured(),null,{sourceRecord:{source_caveats:['Formula quantity is not a confirmed animal count.']}}).dataset,h=harness(d);
 assert.doesNotMatch(h.container.innerHTML,/Estimate limitations|placeholder counts|Formula quantity|Evidence|<script>/);h.click('tab','history');assert.match(h.container.innerHTML,/SPF placeholder counts are provisional &lt;script&gt;/);assert.match(h.container.innerHTML,/Formula quantity is not a confirmed animal count/);assert.doesNotMatch(h.container.innerHTML,/<script>/);
});

test('revoking fee edit access closes the open draft',()=>{let canEdit=true;const h=harness(configured(),{canEdit:()=>canEdit});h.click('edit-month');canEdit=false;h.render();assert.doesNotMatch(h.container.innerHTML,/data-lac-fee-form/);assert.match(h.container.innerHTML,/edit access is no longer available/)});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const visibility=(extra={})=>({version:4,owner:false,estimate:true,actual:true,source_archive_allowed:true,...extra});
const levels=()=>({low:{estimate:true,actual:true},high:{estimate:true,actual:true},max:{estimate:true,actual:true}});
function withInvoice(){const p=blankLacFeeMonth('2026-09');p.actual_total=9473;p.actual_date='2026-10-14';p.invoice_reference='PRIVATE INVOICE 9473';p.notes='PRIVATE ACTUAL NOTES';return buildLacFeeMonth(p,configured(),null,{sourceRecord:{source_note:'PRIVATE SOURCE'}}).dataset;}
test('fee access fails closed while loading and when the permission service fails',async()=>{
 let resolve;const h=harness(withInvoice(),{getVisibility:()=>new Promise(r=>{resolve=r})});assert.match(h.container.innerHTML,/Loading fee access/);assert.doesNotMatch(h.container.innerHTML,/9,473|PRIVATE/);resolve(visibility());await settle();assert.match(h.container.innerHTML,/9,473/);h.hooks.getVisibility=async()=>{throw new Error('Permission lookup failed')};h.render();await settle();assert.match(h.container.innerHTML,/Permission lookup failed/);assert.doesNotMatch(h.container.innerHTML,/9,473|PRIVATE|data-lac-fee-form/);
});
test('estimate-only visibility hides actual amounts, differences and free-text source history, and forbids fee editing',async()=>{
 const h=harness(withInvoice(),{getVisibility:async()=>visibility({actual:false,source_archive_allowed:false})});await settle();assert.match(h.container.innerHTML,/Estimated fee/);assert.doesNotMatch(h.container.innerHTML,/Previous month · NT\$|Difference ·|9,473|9473|PRIVATE|data-fee-action="edit-month"/);h.click('tab','history');assert.doesNotMatch(h.container.innerHTML,/9473|actual_total|actual_amount|PRIVATE/);h.click('tab','options');assert.doesNotMatch(h.container.innerHTML,/Synthetic rate source|PRIVATE/);h.click('edit-month');await h.save();assert.equal(h.saves.length,0);
});
test('actual-only visibility hides estimates, source rates and derived comparisons even if a stale dataset contains them',async()=>{
 const h=harness(withInvoice(),{getVisibility:async()=>visibility({estimate:false,source_archive_allowed:false})});await settle();assert.match(h.container.innerHTML,/Previous month · NT\$/);assert.match(h.container.innerHTML,/9,473/);assert.doesNotMatch(h.container.innerHTML,/Estimated fee|Difference ·|Error ·|Synthetic rate source|PRIVATE/);h.click('tab','history');assert.match(h.container.innerHTML,/9473/);assert.doesNotMatch(h.container.innerHTML,/quantity|rate_reference|Synthetic rate source|PRIVATE/);h.click('tab','options');assert.doesNotMatch(h.container.innerHTML,/Synthetic rate source|Mapping missing/);
});
test('owner visibility matrix saves the exact revision and shows difference only when both flags are enabled',async()=>{
 const calls=[],h=harness(withInvoice(),{getVisibility:async()=>visibility({owner:true,levels:levels()}),saveVisibility:async input=>{calls.push(input);return visibility({version:5,owner:true,levels:input.levels})}});await settle();h.click('tab','visibility');assert.match(h.container.innerHTML,/Fee visibility/);h.container.onchange({target:{dataset:{feeVisibility:'low:actual'},checked:false}});assert.match(h.container.innerHTML,/<td>Hidden<\/td>/);await h.container.onsubmit({target:{hasAttribute:k=>k==='data-lac-fee-visibility-form'},preventDefault(){}});assert.equal(calls.length,1);assert.equal(calls[0].version,4);assert.equal(calls[0].levels.low.actual,false);assert.equal(calls[0].levels.max.actual,true);assert.match(h.container.innerHTML,/Fee visibility saved/);h.click('tab','month');assert.match(h.container.innerHTML,/9,473/);
});
test('nonowners cannot forge a visibility save and stale policy errors preserve their proposed owner settings',async()=>{
 let saves=0;const h=harness(configured(),{getVisibility:async()=>visibility(),saveVisibility:async()=>{saves++}});await settle();h.click('tab','visibility');await h.container.onsubmit({target:{hasAttribute:k=>k==='data-lac-fee-visibility-form'},preventDefault(){}});assert.equal(saves,0);assert.match(h.container.innerHTML,/Only the database owner/);
 const owner=harness(configured(),{getVisibility:async()=>visibility({owner:true,levels:levels()}),saveVisibility:async()=>{throw new Error('Settings changed; reload')}});await settle();owner.click('tab','visibility');owner.container.onchange({target:{dataset:{feeVisibility:'high:estimate'},checked:false}});await owner.container.onsubmit({target:{hasAttribute:k=>k==='data-lac-fee-visibility-form'},preventDefault(){}});assert.match(owner.container.innerHTML,/Settings changed; reload/);assert.doesNotMatch(owner.container.innerHTML,/data-fee-visibility="high:estimate"[^>]* checked/);
});
test('old fee access responses cannot restore data after a newer account context denies it',async()=>{
 let resolve;const h=harness(withInvoice(),{getVisibility:()=>new Promise(r=>{resolve=r})});h.hooks.getVisibility=async()=>visibility({estimate:false,actual:false});h.render();await settle();assert.match(h.container.innerHTML,/not available at your access level/);resolve(visibility({owner:true,levels:levels()}));await settle();assert.doesNotMatch(h.container.innerHTML,/9,473|PRIVATE|Fee visibility/);
});
test('previous-month charges show paid status only with an explicit payment date',async()=>{
 const h=harness(withInvoice());assert.match(h.container.innerHTML,/Previous month · NT\$/);assert.doesNotMatch(h.container.innerHTML,/Paid 2026-/);h.click('edit-invoice');h.field('actual_basis','confirmed_paid');await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/payment date/);h.field('paid_date','2026-10-15');await h.save();assert.equal(h.saves.length,1);assert.match(h.container.innerHTML,/Previous month · NT\$/);assert.match(h.container.innerHTML,/Paid 2026-10-15/);h.click('edit-invoice');h.field('actual_basis','recorded_charge');await h.save();assert.equal(h.saves.length,2);assert.doesNotMatch(h.container.innerHTML,/Paid 2026-10-15/);
});

test('a delayed owner policy save cannot restore owner-only controls after a new permission context',async()=>{
 let finish;const h=harness(withInvoice(),{getVisibility:async()=>visibility({owner:true,levels:levels()}),saveVisibility:()=>new Promise(resolve=>{finish=resolve})});await settle();h.click('tab','visibility');const pending=h.container.onsubmit({target:{hasAttribute:k=>k==='data-lac-fee-visibility-form'},preventDefault(){}});await settle();h.hooks.getVisibility=async()=>visibility({estimate:false,actual:false,source_archive_allowed:false});h.render();await settle();finish(visibility({version:5,owner:true,levels:levels()}));await pending;assert.match(h.container.innerHTML,/Fee access changed/);assert.doesNotMatch(h.container.innerHTML,/data-lac-fee-visibility-form|9,473|PRIVATE/);
});


test('month dropdown includes current and past months, gaps, and older recorded months in reverse order',()=>{
 const old=blankLacFeeMonth('2018-12'),d=buildLacFeeMonth(old,configured()).dataset,h=harness(d);
 assert.match(h.container.innerHTML,/<label for="fee-selected_month">Month<\/label><select id="fee-selected_month"[^>]*data-fee-field="selected_month"/);
 const options=[...h.container.innerHTML.matchAll(/<option value="(\d{4}-\d{2})"/g)].map(match=>match[1]);
 assert.equal(options[0],'2026-10');assert.equal(options.at(-1),'2018-12');assert.equal(options.length,95);
 assert.ok(options.includes('2026-09'));assert.ok(options.includes('2020-02'));
 assert.match(h.container.innerHTML,/<option value="2026-10" selected>2026-10 · Current<\/option>/);
 h.container.onchange({target:{dataset:{feeField:'selected_month'},value:'2026-09'}});
 assert.match(h.container.innerHTML,/<option value="2026-09" selected>/);assert.match(h.container.innerHTML,/<strong>–<\/strong><small class="fee-unavailable">Unavailable<\/small>/);
 assert.doesNotMatch(h.container.innerHTML,/No dated quantity evidence/);assert.equal(h.saves.length,0);
 h.click('tab','history');h.container.onchange({target:{dataset:{feeField:'selected_month'},value:'2018-12'}});
 assert.match(h.container.innerHTML,/<option value="2018-12" selected>/);assert.match(h.container.innerHTML,/Estimated fee · NT\$/);
 assert.doesNotMatch(h.container.innerHTML,/Latest estimated fee/);
});

test('month dropdown offers recent months even before historical invoices are recorded',()=>{
 const h=harness();const options=[...h.container.innerHTML.matchAll(/<option value="(\d{4}-\d{2})"/g)].map(match=>match[1]);
 assert.equal(options.length,36);assert.equal(options[0],'2026-10');assert.equal(options.at(-1),'2023-11');
});

test('current dated snapshot projections remain usable with their month and detailed provenance in history',()=>{
 const p=blankLacFeeMonth('2026-10');for(const [i,line] of p.lines.entries())Object.assign(line,{evidence_kind:'snapshot_projection',snapshot_count:i===0?2:0,quantity:i===0?62:0,evidence_start:'2026-10-10',evidence_end:'2026-10-10',evidence_reference:'Synthetic current snapshot'});
 const h=harness(buildLacFeeMonth(p,configured()).dataset);assert.match(h.container.innerHTML,/<strong>744<\/strong>/);assert.match(h.container.innerHTML,/Oct 2026/);assert.doesNotMatch(h.container.innerHTML,/occupancy changes not known|monthly usage unavailable/);
 h.click('tab','history');assert.match(h.container.innerHTML,/Synthetic current snapshot/);assert.match(h.container.innerHTML,/snapshot_projection/);
});

test('unavailable estimates do not hide a previous-month recorded zero or invent zero for missing groups',()=>{
 const p=blankLacFeeMonth('2026-09');Object.assign(p,{actual_total:0,actual_date:'2026-10-05',invoice_reference:'Synthetic zero invoice'});p.lines[0].actual_amount=0;
 const h=harness(buildLacFeeMonth(p,configured()).dataset);assert.match(h.container.innerHTML,/Previous month · NT\$<\/span><strong>0<\/strong>/);assert.match(h.container.innerHTML,/<td>372<\/td><td>0<\/td>/);
 assert.equal((h.container.innerHTML.match(/<td>–<\/td>/g)||[]).length,2);
 h.field('selected_month','2026-09');assert.match(h.container.innerHTML,/Estimated fee · NT\$<\/span><strong>–<\/strong><small class="fee-unavailable">Unavailable<\/small>/);
 h.click('tab','history');assert.match(h.container.innerHTML,/Latest estimated fee · NT\$: <strong>–<\/strong><small class="fee-unavailable">Unavailable<\/small>/);assert.match(h.container.innerHTML,/actual_total&quot;: 0/);
 assert.match(lacFeeHelpHTML(),/Past estimates stay Unavailable until quantities are reviewed as Recorded/);
});

test('current fee presentation uses SHLAC room labels while preserving recorded historical labels',()=>{
 const data=configured(),oldLabels=['Mouse clean room','Rat room locobox','SPF room'];
 data.tables.husbandry_events[0].lac_fee_options.groups.forEach((group,index)=>{group.label=oldLabels[index]});
 const before=structuredClone(data),h=harness(data);
 const currentLabels=['SHLAC Conventional','SHLAC Rat room','SHLAC SPF'];
 for(const label of currentLabels)assert.ok(h.container.innerHTML.includes('<td>'+label+'</td>'));
 for(const label of oldLabels)assert.ok(!h.container.innerHTML.includes('<td>'+label+'</td>'));
 h.click('tab','options');for(const label of currentLabels)assert.ok(h.container.innerHTML.includes('<td>'+label+'</td>'));
 h.click('edit-options');for(const label of currentLabels)assert.ok(h.container.innerHTML.includes('<legend>'+label+' ·'));
 h.click('cancel');h.click('tab','history');for(const label of oldLabels)assert.ok(h.container.innerHTML.includes(label));
 assert.deepEqual(data,before);assert.equal(h.saves.length,0);
 assert.match(lacFeeHelpHTML(),/SHLAC Conventional and SHLAC Rat room charges count cages\. SHLAC SPF charges count mice/);
});


test('late fee visibility success or failure cannot repaint a page after navigation',async()=>{
 for(const fail of [false,true]){
  let current=true,resolve,reject;
  const h=harness(withInvoice(),{isCurrent:()=>current,getVisibility:()=>new Promise((yes,no)=>{resolve=yes;reject=no})});
  assert.match(h.container.innerHTML,/Loading fee access/);
  current=false;h.container.innerHTML='<section>Settings stays visible</section>';
  if(fail)reject(new Error('Late permission failure'));else resolve(visibility());
  await settle();assert.equal(h.container.innerHTML,'<section>Settings stays visible</section>');
 }
});

test('returning to fees keeps the new page when an older visibility response completes',async()=>{
 let finishOld;
 const h=harness(withInvoice(),{getVisibility:()=>new Promise(resolve=>{finishOld=resolve}),isCurrent:()=>false});
 renderLacFees(h.container,h.dataset,{getVisibility:async()=>visibility({estimate:false,actual:false}),isCurrent:()=>true});
 await settle();const current=h.container.innerHTML;assert.match(current,/not available at your access level/);
 finishOld(visibility({owner:true,levels:levels()}));await settle();assert.equal(h.container.innerHTML,current);
});

test('a completed fee save can update the current remounted fee view without leaving it busy',async()=>{
 let h;
 h=harness(configured(),{isCurrent:()=>true,save:async next=>{
  renderLacFees(h.container,next,{canEdit:()=>true,isCurrent:()=>true,nowDate:()=> '2026-10-14'});
 }});
 h.click('edit-month');h.field('notes','Verified remount');await h.save();
 assert.match(h.container.innerHTML,/Saved as a new fee revision/);
 assert.doesNotMatch(h.container.innerHTML,/data-lac-fee-form| disabled/);
});


function withDatedQuantities(month,count,actual=null){
 const p=blankLacFeeMonth(month),start=month+'-01',end=month==='2026-09'?'2026-09-30':'2026-10-31';
 Object.assign(p,{actual_total:actual,actual_date:actual==null?null:'2026-10-05',invoice_reference:actual==null?null:'Synthetic invoice'});
 p.lines.forEach((line,i)=>Object.assign(line,{quantity:i===0?count:0,evidence_start:start,evidence_end:end,evidence_reference:'Reviewed full-month usage'}));
 return p;
}

test('difference and error compare only the previous usage month while the first card shows selected month',()=>{
 const september=buildLacFeeMonth(withDatedQuantities('2026-09',10,100),configured()).dataset;
 const h=harness(buildLacFeeMonth(withDatedQuantities('2026-10',100,9999),september).dataset);
 assert.match(h.container.innerHTML,/Estimated fee · NT\$<\/span><strong>1,200<\/strong>/);
 assert.match(h.container.innerHTML,/Previous month · NT\$<\/span><strong>100<\/strong>/);
 assert.match(h.container.innerHTML,/Difference · Sep 2026<\/span><strong>\+20<\/strong>/);
 assert.match(h.container.innerHTML,/Error · Sep 2026<\/span><strong>20%<\/strong>/);
 assert.doesNotMatch(h.container.innerHTML,/<strong>\+1,100<\/strong>|<strong>9,999<\/strong>|1,100%/);
 h.field('selected_month','2026-09');
 assert.match(h.container.innerHTML,/Estimated fee · NT\$<\/span><strong>120<\/strong>/);
 assert.match(h.container.innerHTML,/Previous month · NT\$<\/span><strong>–<\/strong>/);
 assert.match(h.container.innerHTML,/Difference · Aug 2026<\/span><strong>–<\/strong>/);
});

test('monthly error rounds 42.63 percent to a whole percent without rounding the monetary difference',()=>{
 const data=configured();data.tables.husbandry_events[0].lac_fee_options.groups[0].rate=14.263;
 const h=harness(buildLacFeeMonth(withDatedQuantities('2026-09',10,100),data).dataset);
 assert.match(h.container.innerHTML,/Error · Sep 2026<\/span><strong>43%<\/strong>/);
 assert.doesNotMatch(h.container.innerHTML,/<strong>\d+\.\d+%<\/strong>/);
 assert.match(h.container.innerHTML,/Difference · Sep 2026<\/span><strong>\+42\.63<\/strong>/);
});

test('record invoice defaults to December for a selected January and quantity editing stays in January',()=>{
 const h=harness(configured(),{nowDate:()=> '2027-01-08'});h.click('edit-invoice');
 assert.match(h.container.innerHTML,/name="month"[^>]*value="2026-12"/);
 assert.match(h.container.innerHTML,/name="l0_evidence_start"[^>]*value="2026-12-01"/);
 assert.match(h.container.innerHTML,/name="l0_evidence_end"[^>]*value="2026-12-31"/);
 h.click('cancel');h.click('edit-month');assert.match(h.container.innerHTML,/name="month"[^>]*value="2027-01"/);
});

function misassignedInvoice(){
 const target=buildLacFeeMonth(withDatedQuantities('2026-09',30),configured()).dataset;
 const p=withDatedQuantities('2026-10',62,100);p.lines[0].actual_amount=100;
 return buildLacFeeMonth(p,target,null,{sourceRecord:{source_note:'Original October charge entry'}});
}

test('correct usage month saves both linked immutable revisions in one operation and preserves occupancy',async()=>{
 const built=misassignedInvoice(),before=structuredClone(built.dataset),h=harness(built.dataset);
 h.click('tab','history');assert.match(h.container.innerHTML,new RegExp('data-fee-action="correct-month" data-id="'+built.record.event_id+'"'));
 h.click('correct-month',built.record.event_id);assert.match(h.container.innerHTML,/name="target_month"[^>]*value="2026-09"/);await h.save();
 assert.equal(h.saves.length,1);const rows=h.dataset.tables.husbandry_events,originalCount=before.tables.husbandry_events.length;
 assert.equal(rows.length,originalCount+2);assert.deepEqual(rows.slice(0,originalCount),before.tables.husbandry_events);assert.deepEqual(built.dataset,before);
 const revisions=listLacFeeMonths(h.dataset),source=revisions.find(r=>r.lac_fee_month.month==='2026-10'),target=revisions.find(r=>r.lac_fee_month.month==='2026-09');
 assert.equal(source.lac_fee_month.actual_total,null);assert.equal(source.lac_fee_month.lines[0].actual_amount,null);assert.equal(source.lac_fee_month.lines[0].quantity,62);
 assert.equal(target.lac_fee_month.actual_total,100);assert.equal(target.lac_fee_month.actual_date,'2026-10-05');assert.equal(target.lac_fee_month.lines[0].quantity,30);
 assert.equal(target.source_actual_month_correction.original_event_id,built.record.event_id);assert.equal(source.source_actual_month_correction.target_revision_event_id,target.event_id);assert.equal(target.source_actual_month_correction.source_revision_event_id,source.event_id);
 assert.doesNotMatch(h.container.innerHTML,/data-lac-fee-form/);assert.match(h.container.innerHTML,/Saved as a new fee revision/);
});

test('failed usage-month correction leaves original records intact and keeps the chosen draft',async()=>{
 const built=misassignedInvoice(),before=structuredClone(built.dataset),attempts=[];
 const h=harness(built.dataset,{save:async next=>{attempts.push(next);throw new Error('Atomic save rejected')}});
 h.click('correct-month',built.record.event_id);h.field('target_month','2026-08');await h.save();
 assert.equal(attempts.length,1);assert.equal(attempts[0].tables.husbandry_events.length,before.tables.husbandry_events.length+2);
 assert.deepEqual(h.dataset,before);assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Atomic save rejected/);assert.match(h.container.innerHTML,/name="target_month"[^>]*value="2026-08"/);assert.match(h.container.innerHTML,/data-lac-fee-form/);
});

test('read-only viewers cannot forge a usage-month correction and target charges cannot be overwritten',async()=>{
 const built=misassignedInvoice(),readOnly=harness(built.dataset,{canEdit:()=>false});readOnly.click('tab','history');assert.doesNotMatch(readOnly.container.innerHTML,/data-fee-action="correct-month"/);readOnly.click('correct-month',built.record.event_id);await readOnly.save();assert.equal(readOnly.saves.length,0);assert.match(readOnly.container.innerHTML,/Fee edit access is required/);
 const target=listLacFeeMonths(built.dataset).find(r=>r.lac_fee_month.month==='2026-09'),p=structuredClone(target.lac_fee_month);Object.assign(p,{actual_total:500,actual_date:'2026-10-06',invoice_reference:'Existing September charge'});
 const h=harness(buildLacFeeMonth(p,built.dataset,target).dataset);h.click('correct-month',built.record.event_id);await h.save();
 assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/target usage month already has an actual amount/);assert.match(h.container.innerHTML,/name="target_month"[^>]*value="2026-09"/);
});
