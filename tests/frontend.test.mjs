import {datasetFromLocalBackup} from '../web/local-backup.js';
import {backupViewerLinkHTML} from '../web/config.js';
import {createAccessActivity} from '../web/access-activity.js';
import {renderAccessLogs} from '../web/access-logs.js';
import { isLegacySite, migrationNoticeHTML, movedAccountHTML } from '../web/site-migration.js';
import { projectCageHistory, getCageHistoryDates } from '../web/cage-history.js';
import { projectAnimalSheet } from '../web/animal-sheet-export.js';
import { compareRooms, sortRooms } from '../web/room-order.js';
import { cageSheetHelpHTML } from '../web/cage-sheet.js';
import { renderLocobox, locoboxHelpHTML } from '../web/locobox.js';
import { renderIacuc, iacucHelpHTML } from '../web/iacuc.js';
import { protocolsForEntity } from '../web/iacuc-model.js';
import { renderAnimalSheetImport, animalSheetImportHelpHTML } from '../web/animal-sheet-import.js';
import { renderLacFees, lacFeeHelpHTML } from '../web/lac-fees.js';
import { userAcronymHelpHTML, setLabUserDirectory } from '../web/user-acronyms.js';
import { normalizeManagerPermissions } from '../web/permissions.js';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as model from '../web/model.js';
import { renderExperiments, experimentHelpHTML } from '../web/experiments.js';
import { experimentsForMouse, samplesForMouse } from '../web/experiment-model.js';
import { renderFamilyExplorer, familyHelpHTML } from '../web/family-explorer.js';
import { buildFamilyGenotypes } from '../web/family-genotypes.js';
import { MOUSE_LINE_GROUPS, summarizeMice, mouseLineAssignments } from '../web/mouse-summary.js';
import { summarizeLitters } from '../web/litter-summary.js';
import { summarizeOverview } from '../web/overview-summary.js';
import { summarizeCages } from '../web/cage-summary.js';
import { CAGE_SUMMARY_GROUPS, getCageSummaryOptionsStatus } from '../web/cage-summary-options.js';
import { summarizeBreeding } from '../web/breeding-summary.js';
import { getBreedingOptions, getBreedingOptionsStatus } from '../web/breeding-options.js';
import { getStrainRegistry, strainNamingHelpHTML } from '../web/strain-registry.js';
import { renderHousing, sourceListedAnimals, scheduleApplies, lightClock } from '../web/husbandry.js';
const elements=new Map();
function element(id){if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,open:false,classList:{toggle(){}},addEventListener(){},focus(){},setSelectionRange(){},showModal(){this.open=true},close(){this.open=false},appendChild(){},click(){}});return elements.get(id)}
const documentListeners=new Map();
const fakeDocument={getElementById:element,addEventListener(type,handler){documentListeners.set(type,handler)},createElement(tag){return element('created-'+tag)},body:{appendChild(){}}};
globalThis.document=fakeDocument;
assert.deepEqual(sourceListedAnimals({source_block_text:"A1: PB'-M123\nA2: EB-F456\nB2: 2026-01-01T00:00:00\nA3 comment: M999 was moved"}),["PB'-M123",'EB-F456']);
assert(scheduleApplies({start_date:'2026-10-14',timezone:'Asia/Taipei'},new Date('2026-10-13T23:00:00Z')));
assert(!scheduleApplies({start_date:'2026-10-15'},new Date('2026-10-13T23:00:00Z')));
assert(!scheduleApplies({start_date:'2026-10-01',end_date:'2026-10-14',interval_semantics:'next phase start'},new Date('2026-10-13T23:00:00Z')));
let saved=model.createSyntheticDataset();saved.demo=true;
const store={loadDataset:async()=>structuredClone(saved),saveDataset:async next=>{saved=structuredClone(next)},clearDataset:async()=>{saved=null},getCloudStatus:()=>({mode:'local',configured:false,signedIn:false})};
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const labelRenders=[],cageSheetRenders=[],brainbotRenders=[];
const context={console,datasetFromLocalBackup,backupViewerLinkHTML,createAccessActivity,renderAccessLogs,isLegacySite,migrationNoticeHTML,movedAccountHTML,brainbotRenders,renderBrainbot:async(container,hooks)=>{brainbotRenders.push({container,hooks});},brainbotHelpHTML:()=>'Brainbot',projectCageHistory,getCageHistoryDates,projectAnimalSheet,compareRooms,sortRooms,cageSheetHelpHTML,cageSheetRenders,renderCageSheet:(container,sheetDataset,hooks)=>{cageSheetRenders.push({container,sheetDataset,hooks});container.innerHTML="Animal Sheet cage view";},clearCageSheetDrafts:()=>{},hasCageSheetDrafts:()=>false,labelRenders,renderCageLabelEditor:(container,labelDataset,hooks)=>{labelRenders.push({container,labelDataset,hooks});container.innerHTML='Cage label editor';},renderLocobox,locoboxHelpHTML,renderIacuc,iacucHelpHTML,protocolsForEntity,renderAnimalSheetImport,animalSheetImportHelpHTML,lightClock,renderLacFees,lacFeeHelpHTML,userAcronymHelpHTML,setLabUserDirectory,normalizeManagerPermissions,renderLabMembers:async()=>{},renderAccountAcronym:async()=>{},renderAccountSetup:async()=>{},model,store,renderExperiments,experimentHelpHTML,experimentsForMouse,samplesForMouse,renderFamilyExplorer,familyHelpHTML,buildFamilyGenotypes,MOUSE_LINE_GROUPS,summarizeMice,mouseLineAssignments,getStrainRegistry,strainNamingHelpHTML,summarizeLitters,summarizeOverview,summarizeCages,CAGE_SUMMARY_GROUPS,getCageSummaryOptionsStatus,renderCageSummaryOptions:()=>{},summarizeBreeding,getBreedingOptions,getBreedingOptionsStatus,renderBreedingOptions:()=>{},renderStrainManagement:async()=>{},PUBLIC_CONFIG:{},history:{loadHistoryIndex:async()=>null,clearHistoryIndex:async()=>{}},renderHousing,scheduleApplies,renderUserManagement:async()=>{},renderExportCenter:async()=>{},renderCryopreservation:(container)=>{container.innerHTML='<section>Cryopreservation inventory, dated source balances and history</section>'},renderBreedingPlanner:(container)=>{container.innerHTML='<section>Breeding planner: independent autosomal crosses, genotypes and saved plans</section>'},document:fakeDocument,window:{addEventListener(){},print(){context.printed=true}},location:{hash:'',protocol:'file:'},navigator:{},crypto:webcrypto,setTimeout,clearTimeout,URL,Blob,FormData,MouseEvent:class{},Date,structuredClone,assert};
vm.createContext(context);vm.runInContext(source,context);await new Promise(resolve=>setTimeout(resolve,10));
vm.runInContext(`
assert($('main').innerHTML.includes('Recently born'));
assert(strainLegendHTML().includes('Meis1-flox has no confirmed shorthand'));
assert(strainLegendHTML().includes('Vgat-CRE is a legacy lab name for Vgat-flox'));
const initialOverview=overviewStatsHTML();
for(const key of ['living','groups','litters','cages','breedingCages','locoboxes'])assert(initialOverview.includes('data-overview-count="'+key+'"'));
assert(!initialOverview.includes('Cage references'));assert(!initialOverview.includes('total mating records'));assert(!initialOverview.includes('Linked history preserved'));
const overviewDataset=dataset;dataset=structuredClone(dataset);
dataset.tables.mice.push({mouse_sid:'OLD-M',physical_tag:'Historical animal only',state:'Ended',date_of_birth:localDate()});
dataset.tables.matings.push({mating_sid:'OLD-B',state:'Inactive'},{mating_sid:'FUTURE-B',state:'Active',set_up_date:'2999-01-01'});
dataset.tables.litters.push({litter_sid:'OLD-L',state:'Weaned',date_of_birth:'2020-01-01'});
dataset.tables.cages.push({cage_sid:'OLD-C',state:'Inactive'});
renderOverview();assert(overviewStatsHTML()===initialOverview,'historical records do not inflate current activity');assert(!$('main').innerHTML.includes('Historical animal only'),'recent births include living animals only');
showHelp(false,false,false,true);assert($('help-dialog').innerHTML.includes('class="source-disclosure" open><summary>Current Animal Overview counts'));$('help-dialog').close();
dataset=overviewDataset;renderOverview();
route='litters';detail=null;query='';filters={};renderTable();
const litterHTML=litterSummaryHTML();
for(const key of ['newborn','preWeaning','weaningAge'])assert(litterHTML.includes('data-litter-count="'+key+'"'));
assert($('main').innerHTML.indexOf('litter-summary-heading')<$('main').innerHTML.indexOf('table-search'));
assert(litterHTML.includes('recorded weaning &amp; separate cages'));
filters={state:'Ended'};query='no matching litter';renderTable();assert(currentRows.length===0);assert($('main').innerHTML.includes(litterHTML),'mouse age totals do not change with litter filters');
const litterDataset=dataset;dataset=structuredClone(dataset);dataset.tables.mice[0].date_of_birth=localDate();renderTable();assert(litterSummaryHTML()!==litterHTML,'age totals update from current mouse records');dataset=litterDataset;
showHelp(false,false,false,false,true);assert($('help-dialog').innerHTML.includes('class="source-disclosure" open><summary>Litter ages &amp; weaning'));assert($('help-dialog').innerHTML.includes('includes the newborn group'));$('help-dialog').close();
route='mice';query='';filters={};renderTable();assert(!$('main').innerHTML.includes('litter-summary-heading'));


for(const name of ['mice','matings','litters','cages','family','archive','settings','housing','planner','cryo']){route=name;detail=null;render();assert($('main').innerHTML.length>50,name+' renders');}
route='settings';detail=null;render();assert($('main').innerHTML.includes('email-link-request'));assert($('main').innerHTML.includes('id="cloud-login"'));assert($('main').innerHTML.indexOf('id="cloud-login"')<$('main').innerHTML.indexOf('Sign in with an email link'));assert($('main').innerHTML.includes('<details class="source-disclosure"><summary>Sign in with an email link'));assert($('main').innerHTML.includes('id="password-reset-request"'));
assert(!$('main').innerHTML.includes('Read-only backup'));
PUBLIC_CONFIG.backupViewerUrl='https://backup.example/';renderSettings();assert($('main').innerHTML.includes('href="https://backup.example/" target="_blank" rel="noopener noreferrer"'));assert(!cloud.signedIn);
PUBLIC_CONFIG.backupViewerUrl='';renderSettings();assert(!$('main').innerHTML.includes('Read-only backup'));
route='mice';detail={type:'mice',id:dataset.tables.mice[0].mouse_sid};render();assert($('main').innerHTML.includes('Source provenance'));
openEditor('mice',null);assert($('record-dialog').open);assert($('record-fields').innerHTML.includes('Recorded dam IDs'));assert(editor.record.sex==='Unknown');
const current=dataset.tables.mice[2];current.dam_sids=[dataset.tables.mice[1].mouse_sid,'UNKNOWN-CANDIDATE'];
assert(parentHTML(current).includes('Recorded alternatives'));
assert(familySVG(current).includes('width:100%'));
const move=makeCageEvent(current,'SYN-C1','2025-05-06','Synthetic test');assert(move.old_cage_sid==='SYN-C1');assert(move.event_date==='2025-05-06');
dataset.tables.rooms.push({room_id:'ROOM-DEMO',name:'Demo room'});dataset.tables.racks.push({rack_id:'RACK-DEMO',room_id:'ROOM-DEMO',name:'Demo rack'});dataset.tables.locations.push({location_id:'POS-DEMO',room_id:'ROOM-DEMO',rack_id:'RACK-DEMO',label:'A1',row:1,column:1,source_block_text:'Synthetic source tag'});dataset.tables.light_events.push({event_id:'LIGHT-DEMO',location_id:'POS-DEMO',start_date:'2020-01-01',protocol:'T23',cycle_hours:23,lights_on:'07:00',evidence_status:'recorded_schedule_unverified'});route='housing';detail=null;render();assert($('main').innerHTML.includes('Unlinked'));assert($('main').innerHTML.includes('Synthetic source tag'));assert($('main').innerHTML.includes('Link cage'));assert($('main').innerHTML.includes('On 07:00'));assert($('main').innerHTML.includes('Unverified'));assert($('main').innerHTML.includes('<details class="compact-details source-position-details">'));assert(!$('main').innerHTML.includes('Position 1, 1'));assert($('main').innerHTML.indexOf('Demo room <')<$('main').innerHTML.indexOf('Cages without a room'));assert($('main').innerHTML.includes('<details class="panel unassigned-cages">'));

assert(familySVG(current).includes('stroke-dasharray'));
assert(!parentHTML(current).includes('recorded_single_parent'));
route='mice';detail=null;query='';filters={};renderTable();assert(currentRows.length===dataset.tables.mice.length);
const colonySummary=mouseSummaryHTML();
assert($('main').innerHTML.indexOf('mouse-summary-heading')<$('main').innerHTML.indexOf('table-search'));
for(const key of ['alive','sex','P','E','B','F','V','AD'])assert(colonySummary.includes('data-mouse-count="'+key+'"'));
filters={state:'Ended',archived:true};query='no matching animal';renderTable();assert(currentRows.length===0);assert($('main').innerHTML.includes(colonySummary),'colony totals stay independent of table filters');
query='';filters={state:'Stock'};renderTable();assert(currentRows.every(r=>r.state==='Stock'));
const priorState=dataset.tables.mice[0].state;dataset.tables.mice[0].state='Ended';renderTable();assert(!$('main').innerHTML.includes(colonySummary),'current totals update after records change');dataset.tables.mice[0].state=priorState;
route='cages';query='';filters={};renderTable();assert(!$('main').innerHTML.includes('id="mouse-summary-heading"'));
const cageHTML=cageSummaryHTML();
assert($('main').innerHTML.indexOf('cage-summary-heading')<$('main').innerHTML.indexOf('table-search'));
for(const key of ['cages','beh','rat','clean','spf'])assert(cageHTML.includes('data-cage-count="'+key+'"'));
assert(cageHTML.includes('data-action="cage-summary-options"'));assert(cageHTML.includes('Set total capacity')||cageHTML.includes('Choose room in Options'));
filters={state:'Inactive'};query='no matching cage';renderTable();assert(currentRows.length===0);assert($('main').innerHTML.includes(cageHTML));
const cageMouseState=dataset.tables.mice[2].state;dataset.tables.mice[2].state='Ended';renderTable();assert(!$('main').innerHTML.includes(cageHTML));dataset.tables.mice[2].state=cageMouseState;
const assignedCages=dataset.tables.mice.map(mouse=>mouse.cage_sid);dataset.tables.mice.forEach(mouse=>{mouse.cage_sid=null});
assert(/data-cage-count="cages"[\\s\\S]*?<dd>— \\/ [0-9]+<\\/dd>/.test(cageSummaryHTML()),'unknown cage assignments are not zero use');
dataset.tables.mice[0].cage_sid=assignedCages[0];assert(/data-cage-count="cages"[\\s\\S]*?<dd>≥1 \\/ [0-9]+<\\/dd>/.test(cageSummaryHTML()),'partly known occupancy is a minimum');
dataset.tables.mice.forEach((mouse,i)=>{mouse.cage_sid=assignedCages[i]});
showHelp(false,false,true);assert($('help-dialog').innerHTML.includes('class="source-disclosure" open><summary>Cage usage &amp; capacity'));assert($('help-dialog').innerHTML.includes('confirmed minimum'));$('help-dialog').close();
route='mice';filters={};query='';renderTable();assert(!$('main').innerHTML.includes('cage-summary-heading'));
route='matings';query='';filters={};renderTable();const breedingHTML=breedingSummaryHTML();
assert($('main').innerHTML.indexOf('breeding-summary-heading')<$('main').innerHTML.indexOf('table-search'));
for(const key of ['total','male','female','maleFertile','femaleFertile','genotyped'])assert(breedingHTML.includes('data-breeding-count="'+key+'"'));
assert(breedingHTML.includes('8–52 weeks'));assert(breedingHTML.includes('8–32 weeks'));assert(breedingHTML.includes('data-action="breeding-options"'));
filters={state:'Inactive'};query='no matching group';renderTable();assert(currentRows.length===0);assert($('main').innerHTML.includes(breedingHTML));
breedingScope='active';renderTable();assert($('main').innerHTML.includes('<option value="active" selected>'));assert($('main').innerHTML.includes('Active breeders'));breedingScope='living';
showHelp(false,true);assert($('help-dialog').innerHTML.includes('class="source-disclosure" open><summary>Breeding counts &amp; age options'));assert($('help-dialog').innerHTML.includes('not a fertility diagnosis'));$('help-dialog').close();
route='mice';query='';filters={};renderTable();assert(!$('main').innerHTML.includes('breeding-summary-heading'));

const previousDataset=dataset;dataset=structuredClone(dataset);dataset.tables.mice[0].physical_tag="P(')B'(V)-M001";dataset.tables.mice[0].genotype=null;
filters={_strain_code:'recorded:P'};renderTable();assert(currentRows.some(row=>row.mouse_sid===dataset.tables.mice[0].mouse_sid));
filters={_strain_code:'uncertain:V'};renderTable();assert(currentRows.length===1);assert($('main').innerHTML.includes('title="Vip-Cre · Undetermined until genotyping"'));
filters={_strain_code:'recorded:V'};renderTable();assert(currentRows.length===0);
assert(strainLegendHTML().includes('AD'));assert(strainLegendHTML().includes('homozygous'));assert(strainLegendHTML().includes('Transgenic (random insertion)'));
showHelp(true);assert($('help-dialog').innerHTML.includes('class="source-disclosure" open><summary>Current mouse counts'));assert($('help-dialog').innerHTML.includes('Strain acronyms &amp; insertion types'));$('help-dialog').close();
dataset=previousDataset;filters={};renderTable();

printCards([dataset.tables.mice[0].mouse_sid]);assert($('print-area').innerHTML.includes('Generated'));assert($('print-area').innerHTML.includes('IACUC'));assert($('print-preview').open);assert($('print-area').innerHTML.includes('Light record'));action('system-print');
`,context);
assert(context.printed,'print triggered');
vm.runInContext(`
const managedMouse=dataset.tables.mice[0],managedCage=dataset.tables.cages[0];
managedMouse.owner='Imported owner (Me)';managedMouse.manager='Animal keeper';managedCage.owner='Cage keeper (Me)';
route='mice';detail={type:'mice',id:managedMouse.mouse_sid};render();assert($('main').innerHTML.includes('Animal keeper'));assert($('main').innerHTML.includes('Cage keeper'));
printCards([managedMouse.mouse_sid]);assert($('print-area').innerHTML.includes('Mouse manager'));assert($('print-area').innerHTML.includes('Cage manager'));assert($('print-area').innerHTML.includes('Animal keeper'));assert($('print-area').innerHTML.includes('Cage keeper'));
printCageCards([managedCage.cage_sid]);assert($('print-area').innerHTML.includes('Cage keeper'));assert($('print-area').innerHTML.includes('Animal keeper'));assert($('print-area').innerHTML.includes(managedMouse.mouse_sid));
route='cages';detail=null;query='Cage keeper';filters={};renderTable();assert(currentRows.some(c=>c.cage_sid===managedCage.cage_sid));
openEditor('cages',managedCage.cage_sid);assert($('record-fields').innerHTML.includes('value="Cage keeper"'));assert($('record-fields').innerHTML.includes('Recorded SoftMouse owner'));
const OriginalFormData=FormData;let enteredManager='Cage keeper';FormData=class{get(k){return k==='manager'?enteredManager:editor.record[k]??''}};
const unchanged=collectDraft();assert(!Object.hasOwn(unchanged,'manager'));assert(unchanged.owner==='Cage keeper (Me)');
enteredManager='New keeper';const changed=collectDraft();assert(changed.manager==='New keeper');assert(changed.owner==='Cage keeper (Me)');
enteredManager='';assert(model.validateRecord('cages',collectDraft(),dataset,managedCage.cage_sid).errors.some(x=>/manager/i.test(x)));FormData=OriginalFormData;
route='settings';detail=null;cloud={signedIn:true,role:'owner'};renderSettings();assert($('main').innerHTML.includes('id="user-management"'));
cloud={signedIn:true,role:'editor'};renderSettings();assert(!$('main').innerHTML.includes('id="user-management"'));
cloud={signedIn:true,role:'viewer'};renderSettings();assert(!$('main').innerHTML.includes('id="user-management"'));
cloud={signedIn:false,role:'owner'};renderSettings();assert(!$('main').innerHTML.includes('id="user-management"'));
cloud={mode:'cloud',signedIn:true,role:'viewer'};cloudReady=true;route='mice';detail={type:'mice',id:managedMouse.mouse_sid};render();assert($('add-button').hidden);assert(!$('main').innerHTML.includes('data-action="edit"'));assert(!$('main').innerHTML.includes('data-action="archive-record"'));assert($('main').innerHTML.includes('Print ID card'));
route='overview';detail=null;render();assert(!$('main').innerHTML.includes('data-action="new-mice"'));
route='settings';renderSettings();assert($('main').innerHTML.includes('account-new-password'));assert($('main').innerHTML.includes('account-name'));assert(!$('main').innerHTML.includes('Upload local records'));
for(const profile of [{loci:{}},{loci:[null]},{loci:[{id:'bad',name:'Bad'}],calls:{bad:{alleles:'fl',evidence:'confirmed'}}},{loci:[{id:'odd',name:{toString:null}}],calls:{odd:{alleles:[{toString:null},'+'],evidence:'confirmed'}}}]){managedMouse.genetic_profile=profile;assert.doesNotThrow(()=>alleleSummary(managedMouse));route='mice';detail={type:'mice',id:managedMouse.mouse_sid};assert.doesNotThrow(()=>render());}delete managedMouse.genetic_profile;
managedCage.location='Recorded room / rack';assert(cageHousing(managedCage).housing.includes('Recorded room / rack'));
cloud={mode:'local'};
`,context);

await vm.runInContext(`(async()=>{
const cage=dataset.tables.cages[0];cage.location_id='POS-DEMO';delete cage.room_id;delete cage.rack_id;
dataset.tables.rooms.push({room_id:'ROOM-NEW',name:'New housing room'});
dataset.tables.racks.push({rack_id:'RACK-NEW',room_id:'ROOM-NEW',name:'New rack'});
dataset.tables.locations.push({location_id:'POS-NEW',room_id:'ROOM-NEW',rack_id:'RACK-NEW',label:'B2'});
openEditor('cages',cage.cage_sid);
assert($('record-fields').innerHTML.includes('<select id="field-room_id"'));
assert($('record-fields').innerHTML.includes('Demo room / Demo rack'));
assert($('record-fields').innerHTML.includes('cage-change-date'));
assert(!cageLocationOptions('racks',cageLocationRefs(cage)).includes('New rack'));
assert(columnValue(cage,'_housing').includes('Demo room / Demo rack / A1'));
const Original=FormData;let formValues={...cage,...cageLocationRefs(cage),manager:'Cage keeper'};
FormData=class{get(k){return formValues[k]??''}};
const unchanged=collectDraft();assert(!Object.hasOwn(unchanged,'room_id'));assert(!Object.hasOwn(unchanged,'rack_id'));assert(unchanged.location_id==='POS-DEMO');
$('field-room_id').value='ROOM-NEW';$('field-rack_id').value='RACK-DEMO';$('field-location_id').value='POS-DEMO';$('field-room_id').onchange();
assert($('field-rack_id').value==='');assert($('field-location_id').value==='');assert(!$('field-rack_id').innerHTML.includes('Demo rack'));
formValues={...formValues,room_id:'ROOM-NEW',rack_id:'RACK-NEW',location_id:'POS-NEW'};$('cage-change-date').value='2026-10-14';
const before=dataset.tables.husbandry_events.length;
await saveDraft({preventDefault(){}});
assert(!editor,'successful save closes editor');assert(dataset.tables.husbandry_events.length===before+1);
const move=dataset.tables.husbandry_events.at(-1);assert(move.event_type==='cage_location_assignment');assert(move.old_location_id==='POS-DEMO');assert(move.location_id==='POS-NEW');assert(move.event_date==='2026-10-14');
assert(move.old_location_label.includes('Demo rack'));assert(move.location_label.includes('New rack'));
assert(dataset.tables.cages[0].location==='Recorded room / rack','original text retained');
openEditor('cages',cage.cage_sid);formValues={...dataset.tables.cages[0],location:'Corrected source location',manager:'Cage keeper'};$('cage-change-date').value='2026-10-14';
await saveDraft({preventDefault(){}});assert(!editor);assert(dataset.tables.husbandry_events.length===before+2,'legacy location edits also create dated evidence');
FormData=Original;
const confirmOriginal=confirmAction;confirmAction=async()=>true;
const destination=dataset.tables.cages[1];destination.location_id='POS-DEMO';destination.manager='Test caretaker';
dataset.tables.rooms.find(r=>r.room_id==='ROOM-DEMO').app_archived_at='2026-10-14T00:00:00Z';
selectedMice.clear();selectedMice.add(dataset.tables.mice[0].mouse_sid);$('bulk-cage-id').value=destination.cage_sid;$('bulk-move-date').value='2026-10-14';$('bulk-move-notes').value='';
await assert.rejects(()=>bulkCage(),/archived/i);assert(dataset.tables.mice[0].cage_sid===cage.cage_sid,'invalid bulk move leaves dataset unchanged');selectedMice.clear();
destination.app_archived_at='2026-10-14T00:00:00Z';detail={type:'cages',id:destination.cage_sid};
await assert.rejects(()=>archiveRecord(),/archived/i);assert(destination.app_archived_at,'invalid restore leaves record archived');
confirmAction=confirmOriginal;
})()`,context);

// Exercise the actual app wiring, including delayed private-roster responses.
await vm.runInContext(`(async()=>{
const originalStatus=store.getCloudStatus,originalList=store.listLabMembers,originalPermission=store.getExportPermission,originalFullPermission=store.assertFullExportPermission,originalExportRecords=store.getExportRecords;
const initialData=dataset;let rosterCalls=0;
const owner={mode:'cloud',signedIn:true,role:'owner',url:'https://example.supabase.co',colonyId:'synthetic-colony',email:'owner@example.test'};
store.getCloudStatus=()=>({...cloud});
store.getExportPermission=async()=>({level:'max',full_history:true,cutoff_date:null,as_of_date:'2026-10-15',local:cloud.mode!=='cloud'});store.assertFullExportPermission=()=>store.getExportPermission();
store.listLabMembers=async()=>{rosterCalls++;return {members:[]}};
cloud={mode:'local',signedIn:false};
printCageCards([dataset.tables.cages[0].cage_sid]);
assert($('print-preview').innerHTML.includes('data-action="lac-cage-label"'));
assert($('print-preview').innerHTML.includes('data-id="'+dataset.tables.cages[0].cage_sid+'"'));
await action('lac-cage-label',{dataset:{id:dataset.tables.cages[0].cage_sid}});
assert(!$('print-preview').open,'choosing Design 2 closes the compact preview');
assert($('cage-label-dialog').open);assert(labelRenders.at(-1).hooks.initialCage===dataset.tables.cages[0].cage_sid);
assert(labelRenders.at(-1).hooks.allowFullLocoboxHistory===true,'local full history requires the explicit full export gate');
assert(rosterCalls===0,'local labels do not fetch private contacts');labelRenders.at(-1).hooks.onClose();
// Every current Cages view reaches the same format picker without creating data.
const oldCageUI={route,detail,cageView,cageDate,query,filters};route='cages';detail=null;cageDate='';query='';filters={};cageView='table';
renderCages();assert($('main').innerHTML.includes('<th>Label</th>'));assert($('main').innerHTML.includes('aria-label="Print label for cage'));
await action('lac-cage-label',{dataset:{id:'SYN-C1'}});assert(labelRenders.at(-1).hooks.initialCage==='SYN-C1');labelRenders.at(-1).hooks.onClose();
cageView='rack';renderCages();const printHooks=cageSheetRenders.at(-1).hooks;
assert(typeof printHooks.printPositionLabel==='function');
const tablesBefore=JSON.stringify(dataset.tables);await printHooks.printPositionLabel('SOURCE-POS');
let positionLabel=labelRenders.at(-1);assert(positionLabel.hooks.initialPosition==='SOURCE-POS');assert(positionLabel.hooks.initialCage==='');assert(JSON.stringify(dataset.tables)===tablesBefore,'source printing never creates cage/animal records');positionLabel.hooks.onClose();
const originalDraftCheck=hasCageSheetDrafts,beforePending=labelRenders.length;hasCageSheetDrafts=()=>true;
await openCageLabel('SYN-C1');await openCageLabel(null,'front','SOURCE-POS');assert(labelRenders.length===beforePending);assert($('toast').textContent.includes('Sync or discard'));
hasCageSheetDrafts=originalDraftCheck;
const sourcePosition={location_id:'SOURCE-POS',label:'L7',source_current:true,source_snapshot_date:'2026-10-16'};dataset.tables.locations.push(sourcePosition);
await printHooks.printPositionLabel('SOURCE-POS');positionLabel=labelRenders.at(-1);
positionLabel.hooks.onOriginalPreview('',{positionId:'SOURCE-POS',draft:{cage_label:'L7',animal_ids:'PB-M123\\nPB-M456',contact_name:'Test manager',room_code:'Test room'}});
assert($('print-preview').innerHTML.includes('Source labels'));assert($('print-preview').innerHTML.includes('PB-M123'));assert($('print-preview').innerHTML.includes('data-position-id="SOURCE-POS"'));assert(!$('print-preview').innerHTML.includes('0 Stock mice'));
await action('lac-cage-label',{dataset:{positionId:'SOURCE-POS'}});assert(labelRenders.at(-1).hooks.initialPosition==='SOURCE-POS');labelRenders.at(-1).hooks.onClose();
dataset.tables.locations.pop();({route,detail,cageView,cageDate,query,filters}=oldCageUI);

for(const state of [{...owner,role:'editor'},{...owner,role:'manager'},{...owner,role:'viewer'},{...owner,signedIn:false}]){cloud=state;await openCageLabel('SYN-C1');assert(labelRenders.at(-1).hooks.members.length===0);labelRenders.at(-1).hooks.onClose();}
assert(rosterCalls===0,'only a signed-in owner may fetch the private roster');
const privateRows=[{name:'Current User',acronym:'CU',phone:'000-0000',email:'current@example.test',status:'current',archived:false,notes:'private note',provenance:{source:'private'}},{name:'Former User',phone:'999-9999',status:'historical'},{name:'Review User',phone:'888-8888',status:'review'},{name:'Archived User',phone:'777-7777',status:'current',archived:true}];
store.listLabMembers=async()=>{rosterCalls++;return {members:privateRows}};cloud={...owner};
await openCageLabel('SYN-C1');const first=labelRenders.at(-1);assert(first.hooks.members.length===1);
assert(JSON.stringify(Object.keys(first.hooks.members[0]).sort())===JSON.stringify(['acronym','archived','name','phone','status']));
assert(first.hooks.members[0].phone==='000-0000');assert(privateRows[0].email==='current@example.test','private roster object is unchanged');
first.hooks.onPreview({documentHTML:'<p>000-0000</p>'});assert($('export-print-frame').srcdoc.includes('000-0000'));
first.hooks.onClose();assert(!$('cage-label-dialog').open);assert($('cage-label-dialog').innerHTML==='');assert($('export-print-frame').srcdoc==='');assert(first.hooks.members.length===0,'close releases contact values');
await openCageLabel('SYN-C1');assert(labelRenders.at(-1).hooks.initialContextKey!==first.hooks.initialContextKey,'same-cage reopening starts a fresh draft');labelRenders.at(-1).hooks.onClose();
let finish;store.listLabMembers=()=>new Promise(resolve=>{finish=resolve});
const beforeClosed=labelRenders.length,closedRequest=openCageLabel('SYN-C1');$('cage-label-close').onclick();finish({members:privateRows});await closedRequest;
assert(labelRenders.length===beforeClosed,'closed dialogs ignore late contact results');assert($('cage-label-dialog').innerHTML==='');
let finishOld,finishNew;store.listLabMembers=()=>new Promise(resolve=>{if(!finishOld)finishOld=resolve;else finishNew=resolve});
const oldRequest=openCageLabel('SYN-C1'),newRequest=openCageLabel('SYN-C2');finishNew({members:privateRows});await newRequest;const newest=labelRenders.at(-1);finishOld({members:privateRows});await oldRequest;
assert(labelRenders.at(-1)===newest&&newest.hooks.initialCage==='SYN-C2','late first request cannot replace newer cage');newest.hooks.onClose();
for(const change of [()=>{cloud={...cloud,colonyId:'other-colony'}},()=>{cloud={...cloud,url:'https://other.supabase.co'}},()=>{cloud={...cloud,email:'different@example.test'}},()=>{cloud={...cloud,role:'viewer'}},()=>{dataset=structuredClone(dataset)}]){
 cloud={...owner};store.listLabMembers=()=>new Promise(resolve=>{finish=resolve});const before=labelRenders.length,pending=openCageLabel('SYN-C1');change();finish({members:privateRows});await pending;assert(labelRenders.length===before,'changed identity or dataset drops contact response');assert(!$('cage-label-dialog').open);dataset=initialData;
}
cloud={...owner};store.listLabMembers=async()=>({members:privateRows});await openCageLabel('SYN-C1');const oldHooks=labelRenders.at(-1).hooks;oldHooks.onPreview({documentHTML:'<p>000-0000</p>'});
cloud={...owner,role:'viewer'};await refreshCloud();assert(!$('cage-label-dialog').open);assert(!$('export-print-dialog').open);assert($('export-print-frame').srcdoc==='');assert.throws(()=>oldHooks.onPreview({documentHTML:'<p>stale</p>'}),/Workspace or account changed/);
cloud={...owner};await openCageLabel('SYN-C1');labelRenders.at(-1).hooks.onPreview({documentHTML:'<p>000-0000</p>'});
let finishPermission,privatePrints=0;store.getExportPermission=()=>new Promise(resolve=>{finishPermission=resolve});$('export-print-frame').contentWindow={focus(){},print(){privatePrints++}};
const printPending=$('export-print-start').onclick();cloud={...owner,role:'viewer'};finishPermission({level:'low'});await printPending;
assert(privatePrints===0,'identity changes during permission checks prevent printing');assert($('export-print-frame').srcdoc==='');
// History arrives through the authorized export pipeline, separately from current identity fields.
cloud={...owner,role:'viewer'};let boundedCalls=0,fullGateCalls=0;
const bounded={tables:{husbandry_events:[{event_id:'AUTHORIZED',event_type:'locobox_protocol',locobox_protocol:{phases:[]}}]}};
const low={level:'low',full_history:false,cutoff_date:'2023-10-15',as_of_date:'2026-10-15',local:false};
store.getExportPermission=async()=>({...low});store.getExportRecords=async options=>{boundedCalls++;assert(options.scope==='history');assert(JSON.stringify(options.entityTypes)===JSON.stringify(['husbandry_events']));return {dataset:bounded,metadata:{...low,export_level:'low'}}};store.assertFullExportPermission=async()=>{fullGateCalls++;throw new Error('Denied')};
await openCageLabel('SYN-C1','locobox');let allowed=labelRenders.at(-1).hooks;assert(allowed.locoboxDataset===bounded);assert(!allowed.allowFullLocoboxHistory);assert(allowed.initialSide==='locobox');assert(boundedCalls===1&&fullGateCalls===0);allowed.onClose();
store.getExportRecords=async()=>{throw new Error('Denied')};await openCageLabel('SYN-C1');allowed=labelRenders.at(-1).hooks;assert(allowed.locoboxDataset===null&&!allowed.allowFullLocoboxHistory,'failed history authorization offers blank handwriting only');allowed.onClose();
const max={...low,level:'max',full_history:true,cutoff_date:null};store.getExportPermission=async()=>max;store.assertFullExportPermission=async()=>{fullGateCalls++;return {...max}};
await openCageLabel('SYN-C1');allowed=labelRenders.at(-1).hooks;assert(allowed.allowFullLocoboxHistory&&allowed.locoboxDataset===null);assert(fullGateCalls===1,'Max raw history requires its dedicated server gate');allowed.onPreview({documentHTML:'<p>Approved full history</p>'});
let printsAfterDowngrade=0;$('export-print-frame').contentWindow={focus(){},print(){printsAfterDowngrade++}};store.getExportPermission=async()=>({...low});await $('export-print-start').onclick();assert(printsAfterDowngrade===0);assert($('toast').textContent.includes('Export permission changed'));
allowed.onClose();store.getExportPermission=async()=>max;store.assertFullExportPermission=async()=>{throw new Error('Denied')};await openCageLabel('SYN-C1');allowed=labelRenders.at(-1).hooks;assert(!allowed.allowFullLocoboxHistory&&allowed.locoboxDataset===null);allowed.onClose();
store.getCloudStatus=originalStatus;store.listLabMembers=originalList;store.getExportPermission=originalPermission;store.assertFullExportPermission=originalFullPermission;store.getExportRecords=originalExportRecords;cloud={mode:'local'};dataset=initialData;
})()`,context);

// Actual app routing must keep historical evidence read-only and BB owner-only.
vm.runInContext(`
{
 const previous={dataset,route,detail,cloud,cageDate,cageView};
 dataset=model.createSyntheticDataset();route='cages';detail=null;cloud={mode:'local',signedIn:false};cageView='rack';cageDate='';
 dataset.tables.husbandry_events.push({event_id:'SYN-HISTORY',event_type:'animal_sheet_cage_snapshot',event_date:'2020-01-02',source_cage_snapshot:{schema_version:1,snapshot_date:'2020-01-02',date_basis:'captured_date',workbook_id:'synthetic-workbook',sheet_id:'1',sheet_name:'Synthetic room',source_header_cell:'A1',cage_label:'SYN-OLD',body:[{cell:'A2',raw:'P-M0001'}]}});
 render();assert($('main').innerHTML.includes('id="cage-date"'));assert($('main').innerHTML.includes('2020-01-02'));
 const currentHook=cageSheetRenders.at(-1).hooks;assert(!currentHook.readOnly);assert(currentHook.canEdit('cages'));
 setCageDate('2020-01-02');const historic=cageSheetRenders.at(-1);
 assert(historic.hooks.readOnly&&historic.hooks.selectedDate==='2020-01-02');assert(!historic.hooks.canEdit('cages'));assert(!historic.hooks.openCage&&!historic.hooks.openMouse&&!historic.hooks.printLabel&&!historic.hooks.printPositionLabel&&!historic.hooks.openLocobox);
 assert(historic.sheetDataset.history_projection.read_only);assert(historic.sheetDataset.tables.mice.length===0,'present-day mice are never projected backward');assert($('main').innerHTML.includes('Historical view · Read only'));assert($('add-button').hidden);assert(currentHook.context!==historic.hooks.context);
 const pending=hasCageSheetDrafts;hasCageSheetDrafts=()=>true;setCageDate('');assert(cageDate==='2020-01-02');assert($('toast').textContent.includes('Sync or discard'));hasCageSheetDrafts=pending;
 cageView='table';render();assert($('main').innerHTML.includes('SYN-OLD'));assert(!$('main').innerHTML.includes('data-action="edit"'));
 setCageDate('');cageView='rack';render();assert(!cageSheetRenders.at(-1).hooks.readOnly);
 for(const denied of [{mode:'local',signedIn:true,role:'owner'},{mode:'cloud',signedIn:false,role:'owner'},...['viewer','editor','manager','pending'].map(role=>({mode:'cloud',signedIn:true,role}))]){
  cloud=denied;route='brainbot';const before=brainbotRenders.length;render();assert(!($('navigation').innerHTML.includes('data-route="brainbot"')));assert($('main').innerHTML.includes('only to the signed-in database owner'));assert(brainbotRenders.length===before);
 }
 cloud={mode:'cloud',signedIn:true,role:'owner',colonyId:'synthetic-colony',email:'owner@example.test'};const before=brainbotRenders.length;render();assert($('navigation').innerHTML.includes('data-route="brainbot"'));assert(brainbotRenders.length===before+1);
 dataset=previous.dataset;route=previous.route;detail=previous.detail;cloud=previous.cloud;cageDate=previous.cageDate;cageView=previous.cageView;
}
`,context);

// The Cages shortcut reuses import controls without starting work on open.
await vm.runInContext(`(async()=>{
 const previous={dataset,route,detail,cloud,cageDate,cageView,cloudReady,renderAnimalSheetImport,hasCageSheetDrafts,pull:store.pullFromCloud,status:store.getCloudStatus};
 let mounted=null,starts=0,pulls=0,disposed=0;
 renderAnimalSheetImport=async(container,hooks)=>{mounted=hooks;return ()=>disposed++;};
 store.startAnimalSheetImport=async()=>{starts++;return {job_id:'synthetic-job'};};
 dataset=model.createSyntheticDataset();route='cages';detail=null;cageDate='';cloudReady=true;
 cloud={mode:'cloud',signedIn:true,role:'owner',colonyId:'synthetic-colony',email:'owner@example.test'};
 store.getCloudStatus=async()=>({...cloud});
 for(const view of ['rack','sheet','table']){cageView=view;render();assert($('main').innerHTML.includes('data-action="cage-import"'),'shortcut in '+view);}
 await action('cage-import');assert(mounted&&$('cage-import-dialog').open);assert(starts===0,'opening does not start an import');assert(mounted.canImport());
 hasCageSheetDrafts=()=>true;assert(!mounted.canImport());await assert.rejects(mounted.start(),/Sync or discard/);hasCageSheetDrafts=previous.hasCageSheetDrafts;
 await mounted.start();assert(starts===1);
 store.pullFromCloud=async()=>{pulls++;const fresh=model.createSyntheticDataset();fresh.tables.cages[0].cage_tag='IMPORTED-CAGE';return fresh;};
 await mounted.onComplete();assert(pulls===1&&route==='cages'&&!cageDate);assert(dataset.tables.cages[0].cage_tag==='IMPORTED-CAGE');assert($('main').innerHTML.includes('IMPORTED-CAGE'));
 const old=mounted;cloud={...cloud,colonyId:'another-colony'};assert(!old.canImport());await assert.rejects(old.start(),/Reopen/);await assert.rejects(old.onComplete(),/Reopen/);assert(pulls===1);
 $('cage-import-close').onclick();assert(disposed===1&&!$('cage-import-dialog').open);
 mounted=null;hasCageSheetDrafts=()=>true;await openCageSheetImport();assert(!mounted&&$('toast').textContent.includes('Sync or discard'));hasCageSheetDrafts=previous.hasCageSheetDrafts;
 cageDate='2020-01-02';assert(cageViewMenuHTML().includes('disabled title="Select Current to import"'));await openCageSheetImport();assert(!mounted);cageDate='';
 for(const denied of [{mode:'local',signedIn:true,role:'owner'},{mode:'cloud',signedIn:false,role:'owner'},...['viewer','pending'].map(role=>({mode:'cloud',signedIn:true,role})),{mode:'cloud',signedIn:true,role:'manager',permissions:{housing:true,imports:false}},{mode:'cloud',signedIn:true,role:'manager',permissions:{housing:false,imports:true}}]){cloud=denied;assert(!cageViewMenuHTML().includes('data-action="cage-import"'));await openCageSheetImport();assert(!mounted);}
 cloud={mode:'cloud',signedIn:true,role:'manager',permissions:{housing:true,imports:true}};assert(canImportAnimalsSheet());
 dataset=previous.dataset;route=previous.route;detail=previous.detail;cloud=previous.cloud;cageDate=previous.cageDate;cageView=previous.cageView;cloudReady=previous.cloudReady;renderAnimalSheetImport=previous.renderAnimalSheetImport;hasCageSheetDrafts=previous.hasCageSheetDrafts;store.pullFromCloud=previous.pull;store.getCloudStatus=previous.status;
})()`,context);

// Recovery takes precedence over every route, including a direct settings refresh.
await vm.runInContext(`(async()=>{
 const previous={cloud,route,dataset,cloudReady};
 cloud={mode:'cloud',configured:true,signedIn:true,role:'owner',passwordRecovery:true};cloudReady=true;
 for(const name of ['mice','settings','brainbot']){route=name;render();assert($('main').innerHTML.includes('id="password-recovery"'));assert(!$('navigation').innerHTML);assert(!canEditRecords('mice')&&!canWriteCloud());assert($('export-button').disabled);}
 renderSettings();assert($('main').innerHTML.includes('id="password-recovery"'));assert(!$('main').innerHTML.includes('user-management'));
 await assert.rejects(action('cloud-push'),/Complete or cancel password recovery/);
 cloud=previous.cloud;route=previous.route;dataset=previous.dataset;cloudReady=previous.cloudReady;
})()`,context);
const submitHandler=documentListeners.get('submit');
const submitButton={disabled:false};
const submitEvent=id=>({target:{id,querySelector:()=>submitButton},preventDefault(){}});
let recoveryRequests=[];store.requestPasswordReset=async identifier=>{recoveryRequests.push(identifier);return {message:'If this ID or email has an active account, a reset link will be sent to its registered email.'}};
element('reset-identifier').value='  unknown-id  ';submitHandler(submitEvent('password-reset-request'));await new Promise(resolve=>setTimeout(resolve,0));
assert.deepEqual(recoveryRequests,['unknown-id']);assert(element('password-reset-status').textContent.startsWith('If this ID or email'));assert(!submitButton.disabled);
const beforeRecoveryStatus=store.getCloudStatus;store.getCloudStatus=()=>({mode:'cloud',configured:true,signedIn:true,role:'owner',passwordRecovery:true,email:'member@example.test'});vm.runInContext('cloud=store.getCloudStatus();renderPasswordRecovery();',context);
assert(element('main').innerHTML.includes('id="recovery-account"'));assert(element('main').innerHTML.includes('Save password &amp; sign in'));assert(element('main').innerHTML.includes('id="recovery-show-password" type="checkbox"'));assert(!element('main').innerHTML.includes(' checked'));
const changeHandler=documentListeners.get('change');element('recovery-password').type='password';element('recovery-confirm').type='password';
changeHandler({target:{id:'recovery-show-password',checked:true}});assert.equal(element('recovery-password').type,'text');assert.equal(element('recovery-confirm').type,'text');
changeHandler({target:{id:'recovery-show-password',checked:false}});assert.equal(element('recovery-password').type,'password');
let passwordChanges=0;store.completePasswordRecovery=async()=>{passwordChanges++;throw new Error('Reset link has expired. Request a new reset link.');};
element('recovery-password').value='synthetic-password';element('recovery-confirm').value='different';submitHandler(submitEvent('password-recovery'));assert.equal(passwordChanges,0);assert.equal(element('password-recovery-status').textContent,'Passwords do not match.');
element('recovery-confirm').value='synthetic-password';submitHandler(submitEvent('password-recovery'));await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(passwordChanges,1);assert(element('password-recovery-status').textContent.includes('expired'));assert.equal(element('recovery-password').value,'');assert.equal(element('recovery-confirm').value,'');assert(!submitButton.disabled);

// Saved-but-unverified retries change only the verification UI, remain concealed,
// and never load data until the normal sign-in path confirms success.
store.getCloudStatus=()=>({mode:'cloud',configured:true,signedIn:true,role:'owner',passwordRecovery:true,passwordRecoveryUpdated:true,email:'member@example.test'});
vm.runInContext('cloud=store.getCloudStatus();renderPasswordRecovery();',context);
assert(element('main').innerHTML.includes('Verify password &amp; sign in'));assert(!element('main').innerHTML.includes('id="recovery-confirm"'));assert(element('main').innerHTML.includes('autocomplete="current-password"'));
let resolveRecovery;store.completePasswordRecovery=()=>{passwordChanges++;return new Promise(resolve=>resolveRecovery=resolve);};
element('recovery-password').value='saved-new-password';submitHandler(submitEvent('password-recovery'));submitHandler(submitEvent('password-recovery'));await new Promise(resolve=>setTimeout(resolve,0));assert.equal(passwordChanges,2,'duplicate submit is ignored while pending');
let verifiedPulls=0;store.getCloudStatus=()=>({mode:'cloud',configured:true,signedIn:true,role:'owner',passwordRecovery:false,email:'member@example.test'});store.pullFromCloud=async()=>{verifiedPulls++;return model.createSyntheticDataset()};
resolveRecovery({updated:true,signedIn:true});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(verifiedPulls,1);assert.equal(vm.runInContext('route',context),'overview');assert.equal(element('recovery-password').value,'');assert.equal(element('recovery-password').type,'password');assert(!element('recovery-show-password').checked);assert(!submitButton.disabled);
store.getCloudStatus=beforeRecoveryStatus;delete store.pullFromCloud;

// The previous site retains local records and old callbacks while new account
// entry points use the fixed new address.
let legacySignedIn=false,legacyPulls=0,legacyClears=0;const legacySignIns=[];
const legacyDataset=model.createSyntheticDataset();
const legacyStore={getCloudStatus:()=>({mode:'local',configured:true,signedIn:legacySignedIn,role:legacySignedIn?'owner':null}),consumeAuthCallback:async()=>null,loadDataset:async()=>legacyDataset,signIn:async(email,password)=>{legacySignIns.push([email,password]);legacySignedIn=true;},pullFromCloud:async()=>{legacyPulls++;throw Error('Local migration must not replace records');},clearDataset:async()=>{legacyClears++;},getLabUserDirectory:async()=>({users:[]})};
const legacyLocation=new URL('https://jihwanmyung.github.io/braintime-mouse-data/?next=https://untrusted.example/#settings');
const legacyContext={...context,store:legacyStore,location:legacyLocation};
vm.createContext(legacyContext);vm.runInContext(source,legacyContext);await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(element('site-migration-notice').hidden,false);
assert(element('site-migration-notice').innerHTML.includes('https://braintimelab.github.io/mouse-data/'));
assert(!element('site-migration-notice').innerHTML.includes('untrusted.example'));
assert(element('main').innerHTML.includes('id="legacy-local-login"'));
for(const id of ['cloud-login','password-reset-request','email-link-request','first-login-request','user-management'])assert(!element('main').innerHTML.includes('id="'+id+'"'));
assert(element('main').innerHTML.includes('Export &amp; backup'));
const legacySubmit=documentListeners.get('submit');
legacySubmit(submitEvent('password-reset-request'));assert.equal(legacySignIns.length,0);
element('legacy-login-email').value='member@example.org';element('legacy-login-password').value='synthetic-legacy-password';
legacySubmit(submitEvent('legacy-local-login'));await new Promise(resolve=>setTimeout(resolve,10));
assert.deepEqual(legacySignIns,[['member@example.org','synthetic-legacy-password']]);
assert.equal(element('legacy-login-password').value,'');assert.equal(legacyPulls,0);assert.equal(legacyClears,0);
assert.equal(vm.runInContext('dataset.tables.mice[0].mouse_sid',legacyContext),legacyDataset.tables.mice[0].mouse_sid);
assert(!element('main').innerHTML.includes('id="user-management"'));

const legacyRecoveryCalls=[];let legacyRecoveryComplete=false;
const legacyRecoveryStore={getCloudStatus:()=>({mode:'local',configured:true,signedIn:!legacyRecoveryComplete,role:'owner',passwordRecovery:!legacyRecoveryComplete}),consumeAuthCallback:async()=>({signedIn:true,passwordRecovery:true,needsPasswordSetup:true}),loadDataset:async()=>null,completePasswordRecovery:async password=>{legacyRecoveryCalls.push(password);legacyRecoveryComplete=true;}};
const legacyRecoveryContext={...context,store:legacyRecoveryStore,location:new URL('https://jihwanmyung.github.io/braintime-mouse-data/#access_token=PRIVATE_TOKEN&type=recovery')};
vm.createContext(legacyRecoveryContext);vm.runInContext(source,legacyRecoveryContext);await new Promise(resolve=>setTimeout(resolve,10));
assert(element('main').innerHTML.includes('id="password-recovery"'));assert(element('site-migration-notice').innerHTML.includes('Finish this password reset here'));assert(!element('site-migration-notice').innerHTML.includes('PRIVATE_TOKEN'));
element('recovery-password').value='synthetic-new-password';element('recovery-confirm').value='synthetic-new-password';
documentListeners.get('submit')(submitEvent('password-recovery'));await new Promise(resolve=>setTimeout(resolve,10));
assert.deepEqual(legacyRecoveryCalls,['synthetic-new-password']);
assert(!element('main').innerHTML.includes('id="cloud-login"'));assert(element('main').innerHTML.includes('https://braintimelab.github.io/mouse-data/'));
assert.equal(element('recovery-password').value,'');

const shell=fs.readFileSync(new URL('../web/sw.js',import.meta.url),'utf8');
assert(shell.includes('!allowed.has(event.request.url)'),'service worker exact shell allowlist');
assert(!shell.includes('supabase.co'),'no cloud API route cached');
for(const filename of ['app.js','data-store.js','model.js']){const code=fs.readFileSync(new URL('../web/'+filename,import.meta.url),'utf8');for(const match of code.matchAll(/from ['"](\.\/[^'"]+\.js(?:\?v=\d+)?)['"]/g))assert(shell.includes(match[1]),'Offline shell includes '+match[1]);}
const manifest=JSON.parse(fs.readFileSync(new URL('../web/manifest.webmanifest',import.meta.url),'utf8'));
for(const icon of manifest.icons)assert(fs.existsSync(new URL('../web/'+icon.src.slice(2),import.meta.url)));

let configuredDefaults=null;
const publicExample={url:'https://example.supabase.co',anonKey:'sb_publishable_example',colonyId:'00000000-0000-4000-8000-000000000001'};
const onboardingStore={loadDataset:async()=>null,getCloudStatus:()=>({mode:'local',configured:Boolean(configuredDefaults),signedIn:false}),configureCloud:config=>{configuredDefaults={...config}}};
const onboardingContext={...context,store:onboardingStore,PUBLIC_CONFIG:publicExample,location:{hash:'',protocol:'file:'}};
vm.createContext(onboardingContext);vm.runInContext(source,onboardingContext);await new Promise(resolve=>setTimeout(resolve,10));
assert.deepEqual(configuredDefaults,publicExample,'Public defaults configure a fresh browser');
assert(element('main').innerHTML.includes('Sign in'),'Fresh configured browser offers sign-in');

const callbackCalls=[];let callbackPulled=false;
const callbackStore={getCloudStatus:()=>({mode:callbackPulled?'cloud':'local',configured:true,signedIn:true}),consumeAuthCallback:async()=>{callbackCalls.push('callback');return {signedIn:true}},loadDataset:async()=>{callbackCalls.push('load');return null},pullFromCloud:async()=>{callbackCalls.push('pull');callbackPulled=true;return model.createSyntheticDataset()}};
const callbackContext={...context,store:callbackStore,PUBLIC_CONFIG:publicExample,location:{hash:'',protocol:'https:',href:'https://example.test/app/'}};
vm.createContext(callbackContext);vm.runInContext(source,callbackContext);await new Promise(resolve=>setTimeout(resolve,10));
assert.deepEqual(callbackCalls,['callback','load','pull'],'Auth callback precedes local loading and empty device opens shared colony');
assert(element('main').innerHTML.includes('Recently born'));
// Local mode reports editable for genuine local work. It does not establish
// that a newly signed-in browser already has a shared snapshot.
for(const hasCallback of [false,true]){
 let imported=false,pulls=0;
 const freshSignedInStore={getCloudStatus:()=>({mode:imported?'cloud':'local',configured:true,signedIn:true,readyForEdits:true,role:'owner',email:'owner@example.test',url:'https://example.supabase.co',colonyId:publicExample.colonyId}),consumeAuthCallback:async()=>hasCallback?{signedIn:true}:null,loadDataset:async()=>null,pullFromCloud:async()=>{pulls++;imported=true;return model.createSyntheticDataset();},getLacFeeVisibility:async()=>({}),getLabUserDirectory:async()=>({users:[]})};
 const freshSignedInContext={...context,store:freshSignedInStore,PUBLIC_CONFIG:publicExample,location:new URL('https://braintimelab.github.io/mouse-data/#overview')};
 vm.createContext(freshSignedInContext);vm.runInContext(source,freshSignedInContext);await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(pulls,1,'fresh signed-in local mode must pull its first cloud snapshot');
 assert.equal(vm.runInContext('cloudReady',freshSignedInContext),true);
 assert.equal(vm.runInContext('route',freshSignedInContext),'overview');
 assert(element('main').innerHTML.includes('Recently born'));assert(!element('toast').textContent.includes('Access changed during reconnect'));
}
let localPulls=0;
const retainedStore={...callbackStore,getCloudStatus:()=>({mode:'local',configured:true,signedIn:true}),loadDataset:async()=>model.createSyntheticDataset(),pullFromCloud:async()=>{localPulls++;return model.createSyntheticDataset()}};
const retainedContext={...context,store:retainedStore,PUBLIC_CONFIG:publicExample,location:{hash:'',protocol:'https:',href:'https://example.test/app/'}};
vm.createContext(retainedContext);vm.runInContext(source,retainedContext);await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(localPulls,0,'Auth callback preserves an existing local working dataset');
assert(element('main').innerHTML.includes('Load shared colony'));

let recoveryPulls=0;
const recoveryStore={...callbackStore,getCloudStatus:()=>({mode:'cloud',configured:true,signedIn:true,passwordRecovery:true}),consumeAuthCallback:async()=>({signedIn:true,passwordRecovery:true}),loadDataset:async()=>null,pullFromCloud:async()=>{recoveryPulls++;throw new Error('Recovery must not pull colony data')}};
const recoveryContext={...context,store:recoveryStore,PUBLIC_CONFIG:publicExample,location:{hash:'',protocol:'https:',href:'https://example.test/app/'}};
vm.createContext(recoveryContext);vm.runInContext(source,recoveryContext);await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(recoveryPulls,0);assert(element('main').innerHTML.includes('id="password-recovery"'));

// A slow initial reconnect must paint immediately without exposing the cached
// snapshot, enabling edits, or allowing another UI request to start a pull.
const startupCache=model.createSyntheticDataset();startupCache.tables.mice[0].physical_tag='CACHED-PRIVATE-MARKER';
let finishStartup,failStartup,startupPulled=0,startupVerified=false,startupProgressHook;
const startupEvents=new Map(),startupStatus={mode:'cloud',configured:true,signedIn:true,role:'owner',email:'owner@example.test',url:'https://test.supabase.co',colonyId:'synthetic-colony'};
const startupStore={getCloudStatus:()=>({...startupStatus,readyForEdits:startupVerified}),getLacFeeVisibility:async()=>({}),consumeAuthCallback:async()=>null,loadDataset:async()=>structuredClone(startupCache),getLabUserDirectory:async()=>({users:[]}),pullFromCloud:({onProgress}={})=>{startupPulled++;startupProgressHook=onProgress;return new Promise((resolve,reject)=>{finishStartup=value=>{startupVerified=true;resolve(value)};failStartup=reject;});}};
const bootContext=()=>({...context,store:startupStore,PUBLIC_CONFIG:publicExample,location:new URL('https://braintimelab.github.io/mouse-data/#overview'),window:{addEventListener:(name,handler)=>startupEvents.set(name,handler)}});
const slowContext=bootContext();vm.createContext(slowContext);vm.runInContext(source,slowContext);
assert(element('main').innerHTML.includes('Loading Braintime Mouse Data'));
await new Promise(resolve=>setTimeout(resolve,0));assert.equal(startupPulled,1);assert.equal(element('navigation').innerHTML,'');assert(!element('main').innerHTML.includes('CACHED-PRIVATE-MARKER'));assert.equal(element('export-button').disabled,true);
assert.equal(vm.runInContext('canEditRecords()',slowContext),false);assert.equal(vm.runInContext('canWriteCloud()',slowContext),false);
assert(element('main').innerHTML.includes('data-action="reload-workspace"'));let loadingReloads=0;slowContext.location.reload=()=>{loadingReloads++;};await vm.runInContext("action('reload-workspace')",slowContext);assert.equal(loadingReloads,1);assert.equal(startupPulled,1,'reload action does not launch another pull inside the old document');
await vm.runInContext("action('cloud-pull');action('help');action('import');navigate('mice');",slowContext);
assert.equal(startupPulled,1);assert.equal(slowContext.location.hash,'#mice');assert(element('main').innerHTML.includes('Loading Braintime Mouse Data'));
startupProgressHook({phase:'archive',recordsLoaded:1000,archiveBlocksLoaded:3});assert(element('main').innerHTML.includes('Loading archived history'));assert(element('main').innerHTML.includes('1,000 records · 3 archive blocks'));
await startupEvents.get('lac-fee-visibility-changed')();assert.equal(startupPulled,1,'startup owns permission-triggered reload');
const freshStartup=model.createSyntheticDataset();freshStartup.tables.mice[0].physical_tag='FRESH-VERIFIED-MARKER';finishStartup(freshStartup);await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(vm.runInContext('startupLoading',slowContext),false);assert.equal(vm.runInContext('route',slowContext),'mice');assert.equal(vm.runInContext('canEditRecords()',slowContext),true);assert(element('main').innerHTML.includes('FRESH-VERIFIED-MARKER'));assert(!element('main').innerHTML.includes('CACHED-PRIVATE-MARKER'));

startupVerified=false;const failedContext=bootContext();vm.createContext(failedContext);vm.runInContext(source,failedContext);await new Promise(resolve=>setTimeout(resolve,0));failStartup(Error('canceling statement due to statement timeout'));await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(vm.runInContext('dataset',failedContext),null);assert.equal(vm.runInContext('route',failedContext),'settings');assert.equal(vm.runInContext('canEditRecords()',failedContext),false);assert(!element('main').innerHTML.includes('CACHED-PRIVATE-MARKER'));assert.equal(startupCache.tables.mice[0].physical_tag,'CACHED-PRIVATE-MARKER');

startupVerified=false;const switchedContext=bootContext();vm.createContext(switchedContext);vm.runInContext(source,switchedContext);await new Promise(resolve=>setTimeout(resolve,0));startupStatus.email='other@example.test';finishStartup(freshStartup);await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(vm.runInContext('dataset',switchedContext),null);assert(!element('main').innerHTML.includes('FRESH-VERIFIED-MARKER'));assert(element('main').innerHTML.includes('Connection settings'));assert.equal(vm.runInContext('canEditRecords()',switchedContext),false);

startupStatus.email='owner@example.test';startupVerified=true;const pullsBeforeVerifiedCache=startupPulled,alreadyVerified=bootContext();vm.createContext(alreadyVerified);vm.runInContext(source,alreadyVerified);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(startupPulled,pullsBeforeVerifiedCache,'a permission-checked load that already completed the pull is not pulled a second time');

const deniedBoot=bootContext();deniedBoot.store={...startupStore,getLacFeeVisibility:async()=>{throw Error('Permission could not be verified')}};vm.createContext(deniedBoot);vm.runInContext(source,deniedBoot);await new Promise(resolve=>setTimeout(resolve,10));assert(element('main').innerHTML.includes('Connection settings'));assert.equal(vm.runInContext('dataset',deniedBoot),null);assert.equal(vm.runInContext('startupLoading',deniedBoot),false);
assert(element('main').innerHTML.includes('data-action="retry-startup"'));deniedBoot.store.getLacFeeVisibility=async()=>({});await vm.runInContext("action('retry-startup')",deniedBoot);assert.equal(vm.runInContext('startupLoading',deniedBoot),false);assert.equal(vm.runInContext('cloudReady',deniedBoot),true,'retry rechecks the permitted workspace after a recoverable startup failure');

// Manual reload uses the same visible progress gate and preserves retry errors.
let manualCalls=0,finishManual,failManual,manualProgress,manualVerified=true;
const manualStatus={...startupStatus,email:'owner@example.test'},manualOld=model.createSyntheticDataset();manualOld.tables.mice[0].physical_tag='PRESERVED-LOCAL-SNAPSHOT';
const manualStore={...startupStore,getCloudStatus:()=>({...manualStatus,readyForEdits:manualVerified}),loadDataset:async()=>structuredClone(manualOld),pullFromCloud:({onProgress}={})=>{manualCalls++;manualProgress=onProgress;manualVerified=false;return new Promise((resolve,reject)=>{finishManual=value=>{manualVerified=true;resolve(value)};failManual=reject;});}};
const manualContext={...context,store:manualStore,PUBLIC_CONFIG:publicExample,location:new URL('https://braintimelab.github.io/mouse-data/#settings')};vm.createContext(manualContext);vm.runInContext(source,manualContext);await new Promise(resolve=>setTimeout(resolve,10));
// Duplicate clicks during the replacement confirmation cannot open another pull.
const confirmation=vm.runInContext("action('cloud-pull')",manualContext),confirmHandler=element('confirm-accept').onclick;
assert.equal(manualCalls,0);assert.equal(vm.runInContext('manualPullPending',manualContext),true);await vm.runInContext("action('cloud-pull')",manualContext);assert.equal(element('confirm-accept').onclick,confirmHandler);element('confirm-cancel').onclick();await confirmation;assert.equal(manualCalls,0);assert.equal(vm.runInContext('manualPullPending',manualContext),false);assert.equal(vm.runInContext('dataset.tables.mice[0].physical_tag',manualContext),'PRESERVED-LOCAL-SNAPSHOT');assert.equal(vm.runInContext('cloudReady',manualContext),true);
const loadingManual=vm.runInContext("action('cloud-pull')",manualContext);element('confirm-accept').onclick();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(manualCalls,1);assert(element('main').innerHTML.includes('aria-busy="true"'));assert.equal(vm.runInContext('canEditRecords()',manualContext),false);assert.equal(element('export-button').disabled,true);await vm.runInContext("action('cloud-pull')",manualContext);assert.equal(manualCalls,1);
manualProgress({phase:'archive',recordsLoaded:2000,archiveBlocksLoaded:7});assert(element('main').innerHTML.includes('2,000 records · 7 archive blocks'));vm.runInContext('renderSettings()',manualContext);assert(element('main').innerHTML.includes('Loading archived history'));
failManual(Error('Failed to fetch <server detail>'));await loadingManual;assert.equal(vm.runInContext('startupLoading',manualContext),false);assert.equal(vm.runInContext('manualPullPending',manualContext),false);assert.equal(vm.runInContext('route',manualContext),'settings');assert.equal(vm.runInContext('cloudReady',manualContext),false);assert.equal(vm.runInContext('dataset.tables.mice[0].physical_tag',manualContext),'PRESERVED-LOCAL-SNAPSHOT');assert(element('main').innerHTML.includes('id="cloud-load-error"'));assert(element('main').innerHTML.includes('Failed to fetch &lt;server detail&gt;'));assert(element('main').innerHTML.includes('Retry loading'));vm.runInContext('renderSettings()',manualContext);assert(element('main').innerHTML.includes('Failed to fetch &lt;server detail&gt;'),'error remains after Settings rerender instead of disappearing with toast');
const retryManual=vm.runInContext("action('cloud-pull')",manualContext);element('confirm-accept').onclick();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(manualCalls,2);const manualFresh=model.createSyntheticDataset();manualFresh.tables.mice[0].physical_tag='NEW-VERIFIED-SNAPSHOT';finishManual(manualFresh);await retryManual;assert.equal(vm.runInContext('route',manualContext),'overview');assert.equal(vm.runInContext('cloudReady',manualContext),true);assert.equal(vm.runInContext('cloudLoadError',manualContext),'');assert.equal(vm.runInContext('dataset.tables.mice[0].physical_tag',manualContext),'NEW-VERIFIED-SNAPSHOT');assert.equal(vm.runInContext('canEditRecords()',manualContext),true);
// Even a successful transport cannot publish data after the account changes.
const swappedManual=vm.runInContext("action('cloud-pull')",manualContext);element('confirm-accept').onclick();await new Promise(resolve=>setTimeout(resolve,0));manualStatus.email='other@example.test';finishManual(manualFresh);await swappedManual;assert.equal(vm.runInContext('dataset',manualContext),null);assert.equal(vm.runInContext('cloudReady',manualContext),false);assert(element('main').innerHTML.includes('Access changed during reconnect'));assert(!element('main').innerHTML.includes('NEW-VERIFIED-SNAPSHOT'));

// A fresh device with no snapshot starts loading immediately, with no replacement confirmation.
manualStatus.email='owner@example.test';const freshDevicePull=vm.runInContext("action('cloud-pull')",manualContext);assert.equal(manualCalls,4);assert(element('main').innerHTML.includes('aria-busy="true"'));finishManual(manualFresh);await freshDevicePull;assert.equal(vm.runInContext('cloudReady',manualContext),true);

// A slow fee access lookup must never replace the page selected afterward.
for(const fail of [false,true]){
 let finishFee,failFee;
 const routeStore={loadDataset:async()=>model.createSyntheticDataset(),getCloudStatus:()=>({mode:'local',configured:true,signedIn:false}),getLacFeeVisibility:()=>new Promise((resolve,reject)=>{finishFee=resolve;failFee=reject;})};
 const routeContext={...context,store:routeStore,PUBLIC_CONFIG:{},location:new URL('https://braintimelab.github.io/mouse-data/#overview')};
 vm.createContext(routeContext);vm.runInContext(source,routeContext);await new Promise(resolve=>setTimeout(resolve,10));
 vm.runInContext("navigate('fees');",routeContext);assert.match(element('main').innerHTML,/Loading fee access/);
 vm.runInContext("navigate('settings');",routeContext);const settingsHTML=element('main').innerHTML;
 assert.equal(element('page-title').textContent,'Settings');assert.equal(routeContext.location.hash,'#settings');assert.match(settingsHTML,/settings-grid/);
 if(fail)failFee(new Error('Late permission failure'));else finishFee({version:1,owner:false,estimate:true,actual:true,source_archive_allowed:true});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(element('main').innerHTML,settingsHTML,'late fee result preserves the selected Settings body');
 assert.equal(element('main').onclick,null,'navigation keeps obsolete fee handlers cleared');
}

console.log('PASS: frontend synthetic rendering, current candidate pedigree, editor, table filters, print card, housing, manifest assets and shell-only cache checks. Browser inspection remains separate.');
