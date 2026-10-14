import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLocobox,locoboxHelpHTML} from '../web/locobox.js';
import {blankLocoboxProtocol,blankLocoboxPhase,blankLocoboxTreatment,buildLocoboxProtocol} from '../web/locobox-model.js';
const clone=structuredClone;
const base=()=>({tables:{cages:[{cage_sid:'C1',cage_tag:'Cage one',location_id:'L1'},{cage_sid:'C2',cage_tag:'Cage two'}],locations:[{location_id:'L1',label:'Locobox position'}],mice:[{mouse_sid:'M1',physical_tag:'P1',cage_sid:'C1',state:'Stock'}],light_events:[{event_id:'LIGHT1',location_id:'L1',protocol:'LP1',start_date:'2020-01-01',lights_on:null,lights_off:null,source_url:'https://example.test/source'}],husbandry_events:[]}});
function withSource(){const p={...blankLocoboxProtocol(),title:'Source cohort',status:'source',evidence_status:'source',source_cage_label:'Unresolved cohort',location_id:'L1',phases:[{...blankLocoboxPhase(),scheme:'LP1',start_date:'2020-01-01',schedule_details:'<script>literal source</script>',treatments:[{...blankLocoboxTreatment(),name:'Tamoxifen IP',status:'cancelled',notes:'Cancelled in source'}]}]};return buildLocoboxProtocol(p,base(),null,{eventId:'S1',sourceRecord:{source_url:'https://example.test/record',source_raw_values:{A1:'Original'}}}).dataset;}
function harness(dataset=base(),overrides={}){const container={innerHTML:''},saves=[],messages=[];let current=dataset;const hooks={canEdit:()=>true,save:async next=>{current=clone(next);saves.push(current);renderLocobox(container,current,hooks);},toast:x=>messages.push(x),openCage:id=>messages.push({cage:id}),openMouse:id=>messages.push({mouse:id}),...overrides};renderLocobox(container,current,hooks);return {container,hooks,saves,messages,get dataset(){return current;},click(action,id=''){container.onclick({preventDefault(){},target:{closest:()=>({dataset:{locoAction:action,id}})}});},set(key,value){assert.ok(container.innerHTML.includes(`data-loco-field="${key}"`),`Missing ${key}`);container.oninput({target:{dataset:{locoField:key},value}});},async save(){await container.onsubmit({preventDefault(){},target:{hasAttribute:key=>key==='data-locobox-form'}});},render(next=current){current=next;renderLocobox(container,current,hooks);}};}

test('cage context starts a linked planned protocol without inventing schedule times',async()=>{
 const h=harness(base(),{initialCage:'C1'});h.click('new');h.set('title','New cage light plan');h.set('p0_scheme','LP1');h.set('p0_start_date','2026-10-15');await h.save();
 assert.equal(h.saves.length,1);const p=h.dataset.tables.husbandry_events[0].locobox_protocol;assert.equal(p.cage_sid,'C1');assert.equal(p.link_status,'confirmed');assert.equal(p.status,'planned');assert.equal(p.phases[0].lights_on,null);assert.equal(p.phases[0].cycle_hours,null);assert.match(h.container.innerHTML,/Some timing or source details remain unknown/);
});
test('physical position context finds source records without a fabricated cage association',()=>{
 const h=harness(withSource(),{initialLocationId:'L1'});h.click('tab','sources');assert.match(h.container.innerHTML,/Source cohort/);h.click('open','S1');assert.match(h.container.innerHTML,/Unresolved cohort/);assert.match(h.container.innerHTML,/Cage link: unresolved/);assert.doesNotMatch(h.container.innerHTML,/data-loco-action="cage"/);
});
test('review creates a separate planned record and preserves cancelled treatments plus raw provenance',async()=>{
 const h=harness(withSource()),original=clone(h.dataset.tables.husbandry_events[0]);h.click('tab','sources');h.click('open','S1');assert.match(h.container.innerHTML,/&lt;script&gt;literal source&lt;\/script&gt;/);h.click('edit','S1');assert.match(h.container.innerHTML,/read-only/);h.click('review','S1');h.set('title','Reviewed cohort');h.set('cage_sid','C1');assert.match(h.container.innerHTML,/<option value="unresolved" selected>/);h.set('link_status','confirmed');await h.save();
 assert.equal(h.saves.length,1);assert.deepEqual(h.dataset.tables.husbandry_events.find(r=>r.event_id==='S1'),original);const reviewed=h.dataset.tables.husbandry_events.find(r=>r.event_id!=='S1');assert.equal(reviewed.locobox_protocol.status,'planned');assert.equal(reviewed.locobox_protocol.phases[0].treatments[0].status,'cancelled');assert.equal(reviewed.source_locobox_event_id,'S1');assert.deepEqual(reviewed.source_raw_values,{A1:'Original'});
});
test('phase and treatment controls preserve entered values and require explicit dose units',async()=>{
 const h=harness(base(),{initialCage:'C1'});h.click('new');h.set('title','Drug timeline');h.set('p0_start_date','2026-10-01');h.set('p0_end_date','2026-10-10');h.set('p0_lights_on','08:00');h.set('p0_scheme','DD');assert.doesNotMatch(h.container.innerHTML,/name="p0_lights_on"[^>]*value="08:00"/);
 h.click('add-treatment','0');h.set('p0_t0_name','Drug A');h.set('p0_t0_dose','10');h.set('p0_t0_start_date','2026-10-02');h.click('add-phase');assert.match(h.container.innerHTML,/value="Drug timeline"/);assert.match(h.container.innerHTML,/value="Drug A"/);h.set('p1_start_date','2026-10-10');await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/dose requires its unit/);
 h.set('p0_t0_dose_unit','mg/kg');h.set('p0_t0_route','IP');await h.save();assert.equal(h.saves.length,1);const p=h.dataset.tables.husbandry_events[0].locobox_protocol;assert.equal(p.phases.length,2);assert.equal(p.phases[0].treatments[0].dose,10);assert.equal(p.phases[0].treatments[0].status,'planned');
});
test('duration calculation is explicit and chronological errors retain the editable draft',async()=>{
 const h=harness();h.click('new');h.set('title','Duration test');h.set('p0_start_date','2026-01-01');h.set('p0_end_date','2026-02-01');h.click('duration','0');assert.match(h.container.innerHTML,/name="p0_duration_days"[^>]*value="31"/);h.click('add-phase');h.set('p1_start_date','2025-12-01');await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/chronological/);assert.match(h.container.innerHTML,/value="Duration test"/);
});
test('managed edits append history and do not change current resident biological state',async()=>{
 const h=harness(base(),{initialCage:'C1'});h.click('new');h.set('title','Saved timeline');h.set('p0_start_date','2026-10-15');await h.save();const before=clone(h.dataset.tables.mice),record=h.dataset.tables.husbandry_events[0];h.click('edit',record.event_id);h.set('p0_schedule_details','New measured schedule');await h.save();
 assert.deepEqual(h.dataset.tables.mice,before);const rev=h.dataset.tables.husbandry_events.find(r=>r.event_type==='locobox_revision');assert.equal(rev.locobox_revision.before.phases[0].schedule_details,null);assert.equal(rev.locobox_revision.after.phases[0].schedule_details,'New measured schedule');assert.match(h.container.innerHTML,/Saved revisions \(1\)/);assert.match(h.container.innerHTML,/Current cage residents \(not historical exposure\)/);
});
test('measured phase remains distinct and refuses clock-only timestamps',async()=>{
 const h=harness();h.click('new');h.set('title','Measured CT');h.set('p0_m_phase_hours','6');h.set('p0_m_basis','CT');h.set('p0_m_measured_at','14:00');h.set('p0_m_method','Activity onset');await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/UTC offset/);h.set('p0_m_measured_at','2026-10-15T14:00:00+08:00');await h.save();assert.equal(h.saves.length,1);assert.match(h.container.innerHTML,/Measured CT 6/);
});
test('related evidence uses source links and groups position history as unconfirmed exposure',()=>{
 const h=harness(base(),{initialCage:'C1'});h.click('tab','evidence');assert.match(h.container.innerHTML,/Light history \(1\)/);assert.match(h.container.innerHTML,/historical cage exposure unconfirmed/);assert.match(h.container.innerHTML,/href="https:\/\/example.test\/source"/);assert.match(h.container.innerHTML,/Local lights on \/ off<\/dt><dd>Unknown \/ Unknown/);
});
test('readonly access and changed permissions block all mutation paths',async()=>{
 const h=harness(withSource(),{canEdit:()=>false});assert.doesNotMatch(h.container.innerHTML,/New cage protocol/);h.click('new');assert.match(h.container.innerHTML,/Housing edit access is required/);h.click('review','S1');await h.save();assert.equal(h.saves.length,0);
 const w=harness();w.click('new');w.set('title','Draft');w.hooks.canEdit=()=>false;await w.save();assert.equal(w.saves.length,0);assert.match(w.container.innerHTML,/edit access is required/);
});
test('save errors retain drafts, duplicate submission is suppressed, and refresh closes stale editors',async()=>{
 let reject;const h=harness(base(),{save:()=>new Promise((_,r)=>{reject=r;})});h.click('new');h.set('title','Preserved draft');const pending=h.save();await h.save();assert.match(h.container.innerHTML,/Saving…/);reject(new Error('Cloud conflict'));await pending;assert.match(h.container.innerHTML,/Cloud conflict/);assert.match(h.container.innerHTML,/value="Preserved draft"/);h.render(clone(h.dataset));assert.match(h.container.innerHTML,/Data refreshed/);assert.doesNotMatch(h.container.innerHTML,/data-locobox-form/);
});
test('new cage and location hooks replace prior context on the same container',()=>{
 const h=harness(base(),{initialCage:'C1'});h.hooks.initialCage=null;h.hooks.initialLocationId='L1';h.render();assert.match(h.container.innerHTML,/<option value="L1" selected>/);h.hooks.initialLocationId=null;h.hooks.initialCage='C2';h.render();h.click('new');assert.match(h.container.innerHTML,/<option value="C2" selected>/);
});
test('Help distinguishes delivery from a drug title and rejects executable source links',()=>{
 const d=withSource();d.tables.husbandry_events[0].source_url='javascript:alert(1)';const h=harness(d);h.click('tab','sources');h.click('open','S1');assert.doesNotMatch(h.container.innerHTML,/href="javascript:/);assert.match(locoboxHelpHTML(),/not evidence that every animal received it/);
});
test('large source sets paginate and related treatment text stays distinguishable and searchable',()=>{
 const d=withSource(),template=d.tables.husbandry_events[0];
 d.tables.husbandry_events=Array.from({length:56},(_,i)=>({...clone(template),event_id:'S'+i,source_kind:i===55?'related_treatment_text':'experiment_locobox_group',locobox_protocol:{...clone(template.locobox_protocol),protocol_id:'S'+i,title:i===55?'Related treatment source: cancelled diet':'Source group '+i}}));
 const h=harness(d);h.click('tab','sources');assert.match(h.container.innerHTML,/56 source observations · Page 1 of 2/);assert.equal((h.container.innerHTML.match(/data-loco-action="open"/g)||[]).length,50);h.click('next-page');assert.equal((h.container.innerHTML.match(/data-loco-action="open"/g)||[]).length,6);
 h.set('source_kind','related_treatment_text');assert.match(h.container.innerHTML,/1 source observations · Page 1 of 1/);assert.match(h.container.innerHTML,/does not establish Locobox treatment/);assert.match(h.container.innerHTML,/Related treatment source: cancelled diet/);h.set('search','missing');assert.match(h.container.innerHTML,/No matching protocols/);
});
test('source_refs url links are supported and unlinked position context remains in a new plan',async()=>{
 const d=withSource();d.tables.husbandry_events[0].source_url=null;d.tables.husbandry_events[0].source_refs=[{url:'https://example.test/legacy-sheet'},{url:'javascript:alert(1)'}];const h=harness(d,{initialLocationId:'L1'});h.click('tab','sources');h.click('open','S1');assert.match(h.container.innerHTML,/href="https:\/\/example.test\/legacy-sheet"/);assert.doesNotMatch(h.container.innerHTML,/href="javascript:/);h.click('new');h.set('title','Position plan');await h.save();const p=h.dataset.tables.husbandry_events.find(r=>r.event_id!=='S1').locobox_protocol;assert.equal(p.location_id,'L1');assert.equal(p.cage_sid,null);assert.equal(p.link_status,'unresolved');
});
test('repeated same-cage navigation resets manual filters through the explicit context key',()=>{
 const h=harness(base(),{initialCage:'C1',initialContextKey:1});h.set('filter_cage','C2');h.hooks.initialContextKey=2;h.render();h.click('new');assert.match(h.container.innerHTML,/<option value="C1" selected>/);
});
test('review keeps source notes while staying planned and withdrawn evidence remains visibly historical',async()=>{
 const d=withSource();d.tables.husbandry_events[0].source_current=false;d.tables.husbandry_events[0].locobox_protocol.notes='Recorded source notes: cancelled cohort';const h=harness(d);h.click('tab','sources');h.click('open','S1');assert.match(h.container.innerHTML,/Withdrawn source observation, retained as history/);h.click('review','S1');await h.save();const p=h.dataset.tables.husbandry_events.find(r=>r.event_id!=='S1').locobox_protocol;assert.equal(p.notes,'Recorded source notes: cancelled cohort');assert.equal(p.status,'planned');assert.equal(p.evidence_status,'planned');assert.equal(p.link_status,'unresolved');
});
test('source history opens immediately when there are no managed protocols and tabs show context counts',()=>{
 const d=withSource();d.tables.rooms=[{room_id:'R1',name:'Rat room'}];d.tables.racks=[{rack_id:'RK1',name:'Rack 1'}];Object.assign(d.tables.locations[0],{room_id:'R1',rack_id:'RK1'});const h=harness(d);assert.match(h.container.innerHTML,/Source observations \(1\)/);assert.match(h.container.innerHTML,/Managed protocols \(0\)/);assert.match(h.container.innerHTML,/Source cohort/);assert.match(h.container.innerHTML,/Locobox position · Rat room · Rack 1/);
});
test('a selected exact cage exposes the standalone Locobox label without granting edit access',()=>{
 const printed=[],h=harness(base(),{initialCage:'C1',canEdit:()=>false,printLabel:id=>printed.push(id)});assert.match(h.container.innerHTML,/Print Locobox label/);h.click('print','C1');assert.deepEqual(printed,['C1']);assert.doesNotMatch(h.container.innerHTML,/New cage protocol/);h.set('filter_cage','');assert.doesNotMatch(h.container.innerHTML,/Print Locobox label/);
});
