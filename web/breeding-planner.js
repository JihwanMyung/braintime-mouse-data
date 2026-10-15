import { predictCross, validateScenario, rankPairs } from './genetics.js?v=24';
import { discoverGenotypes, sourceProfile } from './genotype-catalog.js?v=24';
import { validateFamilyTargetDraft } from './family-targets.js?v=24';

const mounts=new WeakMap();
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const unknown=()=>({alleles:[],evidence:'unknown'});
const locusFields=locus=>({id:locus.id,name:locus.name,kind:locus.kind,chromosome:locus.chromosome,alleles:[...locus.alleles]});
const localDate=()=>{const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`};
const pct=value=>value==null?'Unavailable':`${Number((value*100).toPrecision(4))}%`;
const number=value=>value==null?'Unavailable':new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(value);
const list=(items,kind='amber')=>items?.length?`<div class="alert ${kind}"${kind==='error'?' role="alert"':''}><ul>${[...new Set(items)].map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:'';
const option=(value,label,selected)=>`<option value="${esc(value)}"${String(value)===String(selected)?' selected':''}>${esc(label)}</option>`;
const url=value=>{try{const parsed=new URL(value);return ['https:','http:'].includes(parsed.protocol)?parsed.href:null}catch{return null}};
const button=(action,label,data='',style='secondary')=>`<button type="button" class="button ${style}" data-planner-action="${action}" ${data}>${label}</button>`;
const ids=record=>[...(Array.isArray(record?.sire_sids)?record.sire_sids:[]),...(Array.isArray(record?.dam_sids)?record.dam_sids:[])];

function reviewedCall(record,locus) {
  const profile=record?.genetic_profile;
  if(profile&&profile.schema_version!==1)return {call:unknown(),reason:`${locus.name}: unsupported genotype profile version; review before reuse.`};
  const definition=Array.isArray(profile?.loci)?profile.loci.find(row=>row?.id===locus.id):null;
  const value=object(profile?.calls)?profile.calls[locus.id]:null;
  const sameDefinition=definition&&['name','kind','chromosome'].every(key=>definition[key]===locus[key])&&Array.isArray(definition.alleles)&&definition.alleles.length===locus.alleles.length&&definition.alleles.every(allele=>locus.alleles.includes(allele));
  if(!value)return {call:unknown(),reason:`${locus.name}: no structured call.`};
  if(!sameDefinition)return {call:unknown(),reason:`${locus.name}: saved locus definition differs or is missing; review it before reuse.`};
  if(!object(value)||!['confirmed','inferred','unknown'].includes(value.evidence)||!Array.isArray(value.alleles)||value.alleles.length!==2||value.alleles.some(allele=>typeof allele!=='string'||!locus.alleles.includes(allele)))return {call:unknown(),reason:`${locus.name}: no usable reviewed allele pair.`};
  return {call:clone(value),reason:''};
}

function exampleScenario() {
  const loci=[{id:'example-cre',name:'Example Cre',kind:'cre',chromosome:'unknown',alleles:['+','Cre']},{id:'example-flox',name:'Example floxed locus',kind:'flox',chromosome:'unknown',alleles:['+','fl']},{id:'example-reporter',name:'Example reporter',kind:'reporter',chromosome:'unknown',alleles:['+','reporter']}];
  const calls=Object.fromEntries(loci.map(locus=>[locus.id,{alleles:[...locus.alleles],evidence:'inferred'}]));
  return {loci,sire:{sex:'Male',calls:clone(calls)},dam:{sex:'Female',calls:clone(calls)},targets:Object.fromEntries(loci.map(locus=>[locus.id,{mode:'carrier',allele:locus.alleles[1]}])),sex:'Any',independentAssortment:false,desiredCount:1,confidence:0.95,litterSize:6};
}

/** UI-only drafting. A calculation never creates a mating, litter or animal. */
export function renderBreedingPlanner(container,dataset,hooks) {
  let state=mounts.get(container);
  const freshMount=!state;
  if(!state){state={tab:'cross',scenario:exampleScenario(),illustrative:true,result:null,ranking:null,profileId:'',profileCalls:{},profileNotes:'',planName:'',loadedPlan:'',error:'',notice:'',sourceWarnings:[],busy:false,candidateSearch:'',catalogue:[],catalogueDataset:null,sourceCache:new Map(),catalogueOpen:false};mounts.set(container,state)}
  const datasetChanged=state.catalogueDataset!==null&&state.catalogueDataset!==dataset;
  state.context={container,dataset,hooks};
  const data=()=>state.context.dataset;
  const api=()=>state.context.hooks;
  const mice=()=>data().tables?.mice||[];
  const mouse=id=>mice().find(row=>row.mouse_sid===id);
  const canEdit=()=>api().canEdit?.()===true;
  const disabled=()=>state.busy?' disabled':'';
  const currentCalls=(record,locus)=>reviewedCall(record,locus).call;
  const call=(owner,id)=>owner.calls[id]||(owner.calls[id]=unknown());
  const invalidate=()=>{state.result=null;state.ranking=null;state.error='';state.notice='';state.loadedPlan='';container.querySelector?.('.planner-results')?.remove();container.querySelector?.('[data-planner-ranking]')?.remove()};
  if(state.catalogueDataset!==dataset||state.catalogueHistory!==(hooks.historyIndex||null)){state.catalogue=discoverGenotypes(dataset,hooks.historyIndex||null);state.catalogueDataset=dataset;state.catalogueHistory=hooks.historyIndex||null;state.sourceCache.clear()}
  if(freshMount&&state.catalogue.length&&!dataset.synthetic&&!dataset.demo&&!dataset.is_demo){state.scenario.loci=[];state.scenario.targets={};state.scenario.sire.calls={};state.scenario.dam.calls={};state.illustrative=false;state.catalogueOpen=true}
  if(datasetChanged){
    state.ranking=null;
    if(!state.loadedPlan){state.result=null;for(const role of ['sire','dam'])if(state.scenario[role].id){
      const record=mouse(state.scenario[role].id),valid=record&&!archived(record)&&record.sex===(role==='sire'?'Male':'Female');
      if(!valid){delete state.scenario[role].id;state.notice=`The selected ${role} is no longer eligible for that role. Choose a parent again.`}
      for(const locus of state.scenario.loci)state.scenario[role].calls[locus.id]=currentCalls(valid?record:null,locus);
    }}
    if(state.profileId){loadProfile(state.profileId);if(!state.busy)state.notice='Genotype editor refreshed from the current dataset. Review before saving.'}
  }

  function loadProfile(id) {
    state.profileId=id;const record=mouse(id);
    state.profileCalls=object(record?.genetic_profile?.calls)?clone(record.genetic_profile.calls):{};state.profileNotes=typeof record?.genetic_profile?.notes==='string'?record.genetic_profile.notes:'';state.sourceWarnings=[];
    for(const locus of state.scenario.loci){const checked=reviewedCall(record,locus);state.profileCalls[locus.id]=checked.call;if(record?.genetic_profile&&checked.reason)state.sourceWarnings.push(checked.reason)}
  }
  if(hooks.initialTargetDraft!==undefined&&hooks.initialTargetDraft!==null){
    const draft=hooks.initialTargetDraft,errors=validateFamilyTargetDraft(draft);
    if(errors.length)state.error='Family tree target needs review: '+errors.join(' ');
    else{
      invalidate();
      state.scenario={loci:clone(draft.loci),targets:clone(draft.targets),sire:{sex:'Male',calls:{}},dam:{sex:'Female',calls:{}},sex:'Any',independentAssortment:false,desiredCount:1,confidence:0.95,litterSize:6};
      for(const role of ['sire','dam'])state.scenario[role].calls=Object.fromEntries(state.scenario.loci.map(locus=>[locus.id,unknown()]));
      state.tab='cross';state.illustrative=false;state.catalogueOpen=false;state.sourceWarnings=[];state.planName='';state.profileId='';state.profileCalls={};state.profileNotes='';state.candidateSearch='';
      state.notice=typeof draft.notice==='string'&&draft.notice.trim()?draft.notice:'Target draft from Family tree. Choose parents and review their allele calls before calculating.';
    }
  } else if(hooks.initialMouseId){
    const profile=mouse(hooks.initialMouseId)?.genetic_profile;
    const loci=profile?.schema_version===1&&Array.isArray(profile.loci)?profile.loci.filter(locus=>object(locus)&&typeof locus.id==='string'&&typeof locus.name==='string'&&['cre','flox','reporter','other'].includes(locus.kind)&&typeof locus.chromosome==='string'&&/^(?:unknown|[1-9]|1[0-9])$/.test(locus.chromosome)&&Array.isArray(locus.alleles)&&locus.alleles.length>0&&locus.alleles.length<=6&&locus.alleles.every(allele=>typeof allele==='string'&&allele.trim()===allele&&allele)):[];
    state.scenario.loci=clone(loci.slice(0,6));state.scenario.targets=Object.fromEntries(state.scenario.loci.map(locus=>[locus.id,{mode:'any'}]));for(const role of ['sire','dam'])state.scenario[role]={sex:role==='sire'?'Male':'Female',calls:Object.fromEntries(state.scenario.loci.map(locus=>[locus.id,unknown()]))};state.illustrative=false;state.catalogueOpen=!loci.length;invalidate();
    state.tab='genotypes';loadProfile(hooks.initialMouseId);
  }

  function sourceFor(record) {
    const key=JSON.stringify([record?.mouse_sid,state.scenario.loci]);
    if(!state.sourceCache.has(key))state.sourceCache.set(key,sourceProfile(record,state.scenario.loci,data()));
    return state.sourceCache.get(key);
  }
  function sourceDetails(record) {
    const evidence=sourceFor(record).sheetEvidence||[];
    if(!evidence.length)return '';
    return `<details class="compact-details planner-source-evidence"><summary>Linked Animal Sheet excerpts (${evidence.length})</summary><p class="small muted">Historical excerpts may include cage mates or comments. They do not confirm this animal’s genotype.</p>${evidence.slice(0,8).map(item=>{const href=url(item.url),label=[item.title,item.sheet,item.cell].filter(Boolean).join(' · ');return `<div class="planner-source-excerpt"><p class="small">${href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label||'Source')}</a>`:esc(label)}</p><pre>${esc(item.text)}</pre></div>`}).join('')}${evidence.length>8?'<p class="small muted">First eight excerpts shown. See Source archive for the complete history.</p>':''}</details>`;
  }

  function parentSelect(role) {
    const selected=state.scenario[role].id||'',sex=role==='sire'?'Male':'Female',record=mouse(selected);
    const choices=mice().filter(row=>row.sex===sex&&!archived(row));
    const missing=selected&&!choices.some(row=>row.mouse_sid===selected)?option(selected,`${selected} · saved parent`,selected):'';
    return `<div class="planner-parent panel"><div class="panel-body"><div class="field"><label for="planner-${role}">${role==='sire'?'Sire':'Dam'} · ${sex}</label><select id="planner-${role}" data-planner-field="parent" data-role="${role}">${option('','Hypothetical parent',selected)}${missing}${choices.map(row=>option(row.mouse_sid,`${row.mouse_sid}${(row.physical_tag||row.mouse_tag)?' · '+(row.physical_tag||row.mouse_tag):''} · ${row.state||'State unknown'}`,selected)).join('')}</select></div>${record?`<p class="small"><strong>Source genotype:</strong> ${esc(record.genotype||'Unknown')}</p>${sourceDetails(record)}<div class="settings-actions">${button('source-parent','Use source suggestions',`data-role="${role}"`)}${button('open-mouse','View mouse',`data-id="${esc(selected)}"`)}</div>`:'<p class="small muted">Hypothetical calls remain part of this scenario.</p>'}</div></div>`;
  }

  function alleleSelect(locus,value,attributes,label) {
    const extra=value&&!locus.alleles.includes(value)?option(value,`${value} (outside configured alleles)`,value):'';
    return `<select aria-label="${esc(label)}" ${attributes}>${option('','Unknown',value)}${extra}${locus.alleles.map(allele=>option(allele,allele,value)).join('')}</select>`;
  }
  function callEditor(locus,owner,mode='cross',locked=false) {
    const value=mode==='profile'?(state.profileCalls[locus.id]||unknown()):call(state.scenario[owner],locus.id),label=mode==='profile'?'Genotype':owner==='sire'?'Sire':'Dam';
    const attributes=`data-planner-field="call" data-mode="${mode}" data-role="${owner}" data-locus="${esc(locus.id)}"${locked?' disabled':''}`;
    return `<fieldset class="planner-call"><legend>${esc(label)}</legend><div class="planner-call-alleles">${[0,1].map(index=>alleleSelect(locus,value.alleles?.[index]||'',`${attributes} data-index="${index}"`,`${locus.name}, ${label}, allele ${index+1}`)).join('')}</div><label>Evidence<select ${attributes} data-index="evidence" aria-label="${esc(locus.name+', '+label+', evidence')}">${['unknown','inferred','confirmed'].map(evidence=>option(evidence,{unknown:'Unknown',inferred:'Inferred / hypothetical',confirmed:'Confirmed'}[evidence],value.evidence)).join('')}</select></label></fieldset>`;
  }
  function targetEditor(locus) {
    const target=state.scenario.targets[locus.id]||{mode:'any'},attributes=`data-planner-field="target" data-locus="${esc(locus.id)}"`;
    return `<fieldset class="planner-call"><legend>Desired offspring</legend><select aria-label="${esc(locus.name+' target mode')}" ${attributes} data-key="mode">${[['any','Any genotype'],['carrier','Carries allele'],['exact','Exact genotype']].map(([value,label])=>option(value,label,target.mode)).join('')}</select>${target.mode==='carrier'?alleleSelect(locus,target.allele||'',`${attributes} data-key="allele"`,`${locus.name} target allele`):target.mode==='exact'?`<div class="planner-call-alleles">${[0,1].map(index=>alleleSelect(locus,target.alleles?.[index]||'',`${attributes} data-key="alleles" data-index="${index}"`,`${locus.name} target allele ${index+1}`)).join('')}</div>`:''}</fieldset>`;
  }
  function locusEditor(locus,index) {
    return `<section class="panel planner-locus"><div class="panel-head"><h3>Locus ${index+1}</h3>${button('remove-locus','Remove',`data-locus="${esc(locus.id)}"`)}</div><div class="panel-body"><div class="form-grid"><div class="field"><label for="planner-name-${index}">Name</label><input id="planner-name-${index}" value="${esc(locus.name)}" maxlength="120" data-planner-field="locus" data-locus="${esc(locus.id)}" data-key="name"></div><div class="field"><label>Available alleles, separated by commas<input value="${esc(locus.alleles.join(', '))}" data-planner-field="locus" data-locus="${esc(locus.id)}" data-key="alleles" aria-label="${esc(locus.name+' available alleles')}"></label></div><div class="field"><label>Type<select data-planner-field="locus" data-locus="${esc(locus.id)}" data-key="kind">${['cre','flox','reporter','other'].map(kind=>option(kind,{cre:'Cre',flox:'Floxed allele',reporter:'Reporter',other:'Other autosomal locus'}[kind],locus.kind)).join('')}</select></label></div><div class="field"><label>Chromosome<select data-planner-field="locus" data-locus="${esc(locus.id)}" data-key="chromosome">${option('unknown','Unknown',locus.chromosome)}${Array.from({length:19},(_,i)=>option(String(i+1),String(i+1),locus.chromosome)).join('')}</select></label></div></div><div class="planner-parent-grid">${callEditor(locus,'sire')}${callEditor(locus,'dam')}${targetEditor(locus)}</div>${locus.kind==='cre'&&locus.alleles.includes('+')?button('negative-control','Set Cre-negative control target',`data-locus="${esc(locus.id)}"`):''}</div></section>`;
  }
  function planningInputs() {
    return `<section class="panel"><div class="panel-body"><div class="form-grid"><div class="field"><label>Target sex<select data-planner-field="config" data-key="sex">${['Any','Male','Female'].map(value=>option(value,value,state.scenario.sex)).join('')}</select></label></div><div class="field"><label>Desired offspring count<input type="number" min="1" max="100" step="1" value="${esc(state.scenario.desiredCount)}" data-planner-field="config" data-key="desiredCount"></label></div><div class="field"><label>Planning confidence<select data-planner-field="config" data-key="confidence">${[0.8,0.9,0.95,0.99].map(value=>option(value,pct(value),state.scenario.confidence)).join('')}</select></label></div><div class="field"><label>Nominal litter size<input type="number" min="1" max="20" step="0.5" value="${esc(state.scenario.litterSize)}" data-planner-field="config" data-key="litterSize"></label></div></div><label class="check"><input type="checkbox" data-planner-field="independent"${state.scenario.independentAssortment?' checked':''}> I explicitly assume these loci assort independently.</label></div></section>`;
  }
  function catalogue() {
    return `<details class="panel planner-catalog" data-planner-catalogue${state.catalogueOpen?' open':''}><summary>Genotypes from colony sources <span class="badge">${state.catalogue.length}</span></summary><div class="panel-body"><p class="small muted">Add a locus, then review its allele calls. Source labels are not confirmed genotypes.</p><div class="settings-actions">${button('clear-loci','Start with an empty cross')}${button('example','Load illustrative example')}</div>${state.catalogue.length?`<div class="table-scroll"><table><thead><tr><th>Locus / source labels</th><th>Evidence</th><th></th></tr></thead><tbody>${state.catalogue.map(locus=>`<tr><td><strong>${esc(locus.name)}</strong><div class="small muted">${esc((locus.sourceLabels||[]).join(', '))}</div></td><td>${esc(locus.occurrences||0)} source mentions${(locus.sources||[]).slice(0,3).map(source=>{const href=url(source.url);const label=[source.title,source.sheet,source.cell].filter(Boolean).join(' · ');return `<div class="small">${href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label||'Source')}</a>`:esc(label)}</div>`}).join('')}</td><td>${button('catalogue-locus',state.scenario.loci.some(row=>row.id===locus.id)?'Already added':'Add locus',`data-locus="${esc(locus.id)}"${state.scenario.loci.some(row=>row.id===locus.id)||state.scenario.loci.length>=6?' disabled':''}`)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No recognizable locus labels in this dataset. Add a custom locus.</p>'}</div></details>`;
  }
  function resultHTML() {
    const result=state.result;if(!result)return '';
    if(result.errors.length)return list(result.errors,'error');
    const visible=result.outcomes.slice(0,64);
    return `<section class="planner-results" aria-live="polite"><div class="planner-stats">${[['Target probability',pct(result.targetProbability)],['Expected pups, mean',number(result.expectedPups)],[`${pct(state.scenario.confidence)} confidence pups`,number(result.confidencePups)],['Nominal litters, mean / confidence',`${number(result.expectedLitters)} / ${number(result.confidenceLitters)}`]].map(([label,value])=>`<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div><p class="small muted">Counts are planning estimates. Litter estimates use the nominal size above. ${state.scenario.sex!=='Any'?`Total target probability includes a 1/2 ${esc(state.scenario.sex.toLowerCase())} factor.`:''}</p>${result.warnings.length?`<p class="small muted">Conditional estimate; review unconfirmed calls and assumptions.</p><details class="compact-details"><summary>Review assumptions (${result.warnings.length})</summary>${list(result.warnings)}</details>`:''}<section class="panel"><div class="panel-head"><h3>Genotype outcomes</h3><span class="small muted">Showing ${visible.length} of ${result.outcomeCount}</span></div><div class="table-scroll"><table><thead><tr>${state.scenario.loci.map(locus=>`<th>${esc(locus.name)}</th>`).join('')}<th>Probability</th><th>Genotype target</th><th>Next cross</th></tr></thead><tbody>${visible.map((outcome,index)=>`<tr data-outcome-row>${state.scenario.loci.map(locus=>`<td>${esc(outcome.calls[locus.id].join(' / '))}</td>`).join('')}<td>${pct(outcome.probability)}</td><td>${outcome.meetsTarget?'<span class="badge">Matches</span>':'Other'}</td><td><div class="settings-actions">${button('offspring','Use as sire',`data-role="sire" data-index="${index}"`)}${button('offspring','Use as dam',`data-role="dam" data-index="${index}"`)}</div></td></tr>`).join('')}</tbody></table></div></section><details class="compact-details"><summary>Calculation assumptions</summary>${list(result.assumptions)}</details></section>`;
  }
  function savePlanHTML() {
    return canEdit()?`<section class="panel"><div class="panel-body"><div class="field"><label for="planner-plan-name">Plan name</label><input id="planner-plan-name" maxlength="160" value="${esc(state.planName)}" data-planner-field="plan-name" placeholder="Name this cross"></div><div class="settings-actions">${button('save-plan',api().isCloud?.()?'Save plan to colony':'Save plan locally','', 'primary')}</div></div></section>`:'';
  }
  function crossHTML() {
    return `${state.loadedPlan?`<p class="banner">Recalculated from saved parent-genotype snapshots: ${esc(state.loadedPlan)}. Reselect parents to use their current reviewed profiles.</p>`:''}${catalogue()}<div class="planner-parent-grid">${parentSelect('sire')}${parentSelect('dam')}</div><div class="planner-loci">${state.scenario.loci.map(locusEditor).join('')}</div><div class="settings-actions">${button('add-locus','Add custom locus',state.scenario.loci.length>=6?'disabled':'')}</div>${planningInputs()}<div class="settings-actions">${button('calculate','Calculate cross','', 'primary')}</div>${resultHTML()}${savePlanHTML()}`;
  }
  function animalSummary(id,sex) {
    const record=mouse(id);if(!record)return esc(id);
    const dob=record.date_of_birth,now=new Date(),born=dob?new Date(`${String(dob).slice(0,10)}T00:00:00`):null;
    const age=born&&Number.isFinite(+born)&&now>=born?`${Math.floor((now-born)/604800000)} weeks`:null;
    const matings=(data().tables?.matings||[]).filter(row=>!archived(row)&&String(row.state||row.status).toLowerCase()==='active'&&[...(row.male_sids||[]),...(row.female_sids||[])].includes(id));
    return `${button('open-mouse',esc((record.physical_tag||record.mouse_tag)?`${id} · ${record.physical_tag||record.mouse_tag}`:id),`data-id="${esc(id)}"`)}<div class="small">${esc(sex)} · DOB ${esc(dob||'unknown')}${age?' · '+age:''}</div><div class="small muted">${matings.length?'Active mating: '+esc(matings.map(row=>row.mating_sid).join(', ')):'No active mating recorded'}</div>`;
  }
  function relationship(sireId,damId) {
    const sire=mouse(sireId),dam=mouse(damId),sireParents=ids(sire),damParents=ids(dam),shared=sireParents.filter(id=>damParents.includes(id));
    const direct=sireParents.includes(damId)||damParents.includes(sireId),uncertain=[sire,dam].some(record=>(record?.sire_sids?.length||0)>1||(record?.dam_sids?.length||0)>1);
    const descriptions=[];if(direct)descriptions.push('Recorded parent–offspring relationship');if(shared.length)descriptions.push(`Shared recorded parent: ${shared.join(', ')}`);
    if(uncertain)descriptions.push('Parent fields contain alternatives; relationship may be uncertain');
    const coverage=[sire,dam].every(record=>Array.isArray(record?.sire_sids)&&record.sire_sids.length&&Array.isArray(record?.dam_sids)&&record.dam_sids.length);
    return descriptions.length?`<span class="badge amber">Pedigree review</span><div class="small">${esc(descriptions.join('. '))}</div>`:`<span class="small muted">${coverage?'No direct/shared parent link found':'Parentage incomplete; relatedness unknown'}</span>`;
  }
  function candidatesHTML() {
    const ranking=state.ranking,stock=mice().filter(row=>row.state==='Stock'&&!archived(row));
    return `<section class="panel"><div class="panel-body"><h2>Colony candidates</h2><p class="small muted">${stock.length} active Stock animals. Only confirmed calls at every configured locus enter the ranking. Targets and assumptions come from Cross planner.</p><div class="field"><label for="planner-candidate-search">Narrow candidates by ID, tag, line or source genotype</label><input id="planner-candidate-search" data-planner-field="candidate-search" value="${esc(state.candidateSearch)}" placeholder="Optional search"></div><div class="settings-actions">${button('rank','Compare candidate pairs','', 'primary')}</div></div></section>${ranking?`<div data-planner-ranking>${list(ranking.errors,'error')}${list(ranking.warnings)}<section class="panel"><div class="panel-head"><h3>Highest expected target frequency</h3><span class="small muted">${ranking.pairs.length} eligible pairs</span></div><p class="small muted panel-body">Review age, pedigree, active matings and strain-specific constraints before choosing breeders.</p><div class="table-scroll"><table><thead><tr><th>Sire</th><th>Dam</th><th>Target / confidence pups</th><th>Pedigree</th><th></th></tr></thead><tbody>${ranking.pairs.slice(0,100).map(pair=>`<tr><td>${animalSummary(pair.sireId,'Male')}</td><td>${animalSummary(pair.damId,'Female')}</td><td>${pct(pair.targetProbability)}<div class="small muted">${number(pair.confidencePups)} pups at ${pct(state.scenario.confidence)}</div></td><td>${relationship(pair.sireId,pair.damId)}</td><td>${button('use-pair','Plan this pair',`data-sire="${esc(pair.sireId)}" data-dam="${esc(pair.damId)}"`)}</td></tr>`).join('')||'<tr><td colspan="5">No eligible pairs.</td></tr>'}</tbody></table></div>${ranking.pairs.length>100?'<p class="small muted panel-body">Showing the first 100 pairs. Narrow the search to compare fewer animals.</p>':''}</section><details class="panel"><summary>Excluded candidates (${ranking.excluded.length})</summary><div class="table-scroll"><table><thead><tr><th>Animal</th><th>Reason</th></tr></thead><tbody>${ranking.excluded.slice(0,100).map(row=>`<tr><td>${button('open-mouse',esc(row.id),`data-id="${esc(row.id)}"`)}</td><td>${esc(row.reason)}</td></tr>`).join('')}</tbody></table></div>${ranking.excluded.length>100?'<p class="small muted panel-body">First 100 exclusions shown.</p>':''}</details></div>`:''}`;
  }
  function plansHTML() {
    const plans=(data().tables?.husbandry_events||[]).filter(row=>!archived(row)&&row.event_type==='breeding_plan'&&row.breeding_plan).sort((a,b)=>String(b.event_date).localeCompare(String(a.event_date)));
    return `<section class="panel"><div class="panel-head"><h2>Saved plans</h2><span class="badge">${plans.length}</span></div><p class="small muted panel-body">Loading recalculates recorded parent-genotype snapshots, which may differ from current profiles. Reselect parents deliberately to refresh their calls. Plans do not create matings or offspring.</p><div class="table-scroll"><table><thead><tr><th>Plan</th><th>Saved</th><th>Parents</th><th></th></tr></thead><tbody>${plans.map(row=>`<tr><td>${esc(row.breeding_plan.name||row.notes)}</td><td>${esc(row.event_date)}</td><td>${esc(row.breeding_plan.scenario?.sire?.id||'Hypothetical sire')} × ${esc(row.breeding_plan.scenario?.dam?.id||'Hypothetical dam')}</td><td>${button('load-plan','Load and recalculate',`data-id="${esc(row.event_id)}"`)}</td></tr>`).join('')||'<tr><td colspan="4">No saved plans.</td></tr>'}</tbody></table></div></section>`;
  }
  function genotypesHTML() {
    const record=mouse(state.profileId),locked=!canEdit()||archived(record);
    return `${catalogue()}<section class="panel"><div class="panel-body"><div class="field"><label for="planner-profile-mouse">Mouse</label><select id="planner-profile-mouse" data-planner-field="profile-mouse">${option('','Choose a mouse',state.profileId)}${mice().map(row=>option(row.mouse_sid,`${row.mouse_sid}${(row.physical_tag||row.mouse_tag)?' · '+(row.physical_tag||row.mouse_tag):''} · ${row.sex||'Unknown'}`,state.profileId)).join('')}</select></div>${record?`<p><strong>Source genotype:</strong> ${esc(record.genotype||'Unknown')}</p>${sourceDetails(record)}<p class="small muted">Review the loci configured in Cross planner. Missing calls stay unknown. The source genotype text is preserved.</p><div class="settings-actions">${!locked?button('source-profile','Use source suggestions'):''}${button('open-mouse','View mouse',`data-id="${esc(record.mouse_sid)}"`)}</div>${state.scenario.loci.length?`<div class="planner-loci">${state.scenario.loci.map(locus=>`<section class="planner-locus"><h3>${esc(locus.name)}</h3>${callEditor(locus,'profile','profile',locked)}</section>`).join('')}</div>`:'<p class="muted">Add loci in Cross planner before reviewing calls.</p>'}<div class="field"><label for="planner-profile-notes">Genotype evidence / notes</label><textarea id="planner-profile-notes" data-planner-field="profile-notes"${locked?' readonly':''}>${esc(state.profileNotes)}</textarea></div>${!locked?`<div class="settings-actions">${button('save-profile',api().isCloud?.()?'Save reviewed genotypes to colony':'Save reviewed genotypes locally','', 'primary')}</div>`:'<p class="small muted">Read only</p>'}`:'<p class="muted">Choose an existing animal to review its structured allele calls.</p>'}</div></section>`;
  }
  function helpHTML() {
    return `<details class="panel planner-help"><summary>Planner help and scientific limits</summary><div class="panel-body"><p>This tool models diploid autosomal Mendelian segregation. Multiple loci require an explicit independent-assortment assumption; linked loci, sex-linked inheritance, copy number and recombination phase are not modeled. Keep alternative alleles at the same insertion locus together.</p><p>Source suggestions and hypothetical offspring remain inferred until reviewed. Genotype does not establish Cre recombination, reporter expression, viability, fertility or experimental suitability. Expected pups are a mean; confidence counts use a binomial model. Litter estimates use a nominal size and do not predict pregnancies or timing.</p><p>Calculating and loading plans changes no animals. Saving reviewed genotypes updates only the structured profile; saving a plan creates a planning record.</p><p><a href="https://resources.jax.org/husbandry/strategies-for-creating-complex-breeding-schemes" target="_blank" rel="noopener noreferrer">JAX: complex breeding schemes</a> · <a href="https://www.jax.org/news-and-insights/jax-blog/2012/november/breeding-strategies-for-tissue-specific-knockout-mice" target="_blank" rel="noopener noreferrer">JAX: Cre-lox breeding considerations</a></p></div></details>`;
  }
  function paint() {
    const tabs=[['cross','Cross planner'],['candidates','Colony candidates'],['plans','Saved plans'],['genotypes','Genotypes']];
    container.innerHTML=`<div class="breeding-planner"${state.busy?' aria-busy="true"':''}><div class="planner-tabs archive-tabs" role="tablist" aria-label="Planning">${tabs.map(([value,label])=>`<button type="button" role="tab" aria-selected="${state.tab===value}" class="${state.tab===value?'active':''}" data-planner-action="tab" data-tab="${value}">${label}</button>`).join('')}</div>${list(state.error?[state.error]:[],'error')}${state.notice?`<p class="banner" role="status">${esc(state.notice)}</p>`:''}${list(state.sourceWarnings)}${state.illustrative?'<p class="banner">Illustrative example · no colony parents assumed. Choose colony loci before recording real genotype calls.</p>':''}<div role="tabpanel">${({cross:crossHTML,candidates:candidatesHTML,plans:plansHTML,genotypes:genotypesHTML}[state.tab]||crossHTML)()}</div>${helpHTML()}</div>`;
    const catalogueElement=container.querySelector?.('[data-planner-catalogue]');if(catalogueElement)catalogueElement.ontoggle=event=>{state.catalogueOpen=event.target.open};
    if(state.busy)container.querySelectorAll?.('button,input,select,textarea').forEach(node=>node.disabled=true);
  }
  function selectParent(role,id) {
    const record=mouse(id),parent={sex:role==='sire'?'Male':'Female',calls:{}};
    if(id)parent.id=id;
    for(const locus of state.scenario.loci)parent.calls[locus.id]=currentCalls(record,locus);
    state.scenario[role]=parent;state.illustrative=false;invalidate();
  }
  function addLocus(locus) {
    if(state.scenario.loci.length>=6)throw new Error('A cross supports at most six loci. Remove a locus first.');
    if(state.scenario.loci.some(row=>row.id===locus.id))throw new Error('That locus is already in this cross.');
    state.scenario.loci.push(locusFields(locus));state.scenario.targets[locus.id]={mode:'any'};
    for(const role of ['sire','dam'])state.scenario[role].calls[locus.id]=unknown();
    state.illustrative=false;invalidate();
  }
  function applySuggestions(id,targetCalls) {
    const record=mouse(id);if(!record)throw new Error('Choose a mouse first.');
    const suggestion=sourceFor(record);
    let count=0;
    for(const locus of state.scenario.loci){const proposed=suggestion.calls?.[locus.id];if(proposed?.evidence==='inferred'&&targetCalls[locus.id]?.evidence!=='confirmed'){targetCalls[locus.id]={alleles:[...(proposed.alleles||[])],evidence:'inferred'};count++}}
    state.sourceWarnings=suggestion.warnings||[];state.notice=count?`${count} source suggestion(s) loaded as inferred. Review before saving; confirmed calls were retained.`:'No new explicit allele suggestions. Missing calls remain unknown.';
  }
  function review(type,record,id) {
    const check=api().validate(type,record,data(),id);if(check.errors?.length)throw new Error(check.errors.join(' '));return check;
  }
  async function persist(next,message) {
    state.busy=true;paint();
    try{const previous=data();await api().save(next);if(data()===previous)state.context.dataset=next;state.notice=message;api().toast?.(message);state.ranking=null}
    finally{state.busy=false}
  }
  async function saveProfile() {
    if(!canEdit())throw new Error('Edit access is required to save genotypes.');
    const original=mouse(state.profileId);if(!original||archived(original))throw new Error('Choose an active mouse record.');
    if(!state.scenario.loci.length)throw new Error('Add a locus before saving reviewed genotypes.');
    const record=clone(original),old=object(record.genetic_profile)?record.genetic_profile:{},loci=new Map((Array.isArray(old.loci)?old.loci:[]).filter(locus=>object(locus)&&typeof locus.id==='string').map(locus=>[locus.id,clone(locus)])),calls=object(old.calls)?clone(old.calls):{};
    for(const locus of state.scenario.loci){loci.set(locus.id,locusFields(locus));const value=clone(state.profileCalls[locus.id]||unknown());calls[locus.id]=value.evidence==='unknown'?{...value,alleles:value.alleles?.length===2&&value.alleles.every(Boolean)?value.alleles:[]}:value}
    const now=new Date().toISOString();record.genetic_profile={...old,schema_version:1,loci:[...loci.values()],calls,recorded_at:now,notes:state.profileNotes};record.app_modified_at=now;
    review('mice',record,record.mouse_sid);const next=clone(data());next.tables.mice[next.tables.mice.findIndex(row=>row.mouse_sid===record.mouse_sid)]=record;
    await persist(next,'Reviewed genotype profile saved.');
  }
  async function savePlan() {
    if(!canEdit())throw new Error('Edit access is required to save plans.');
    const checked=validateScenario(state.scenario);if(checked.errors.length)throw new Error(checked.errors.join(' '));
    const name=state.planName.trim();if(!name||name.length>160)throw new Error('Enter a plan name of 1–160 characters.');
    const now=new Date().toISOString(),record={event_id:'PLAN-'+crypto.randomUUID(),event_type:'breeding_plan',event_date:localDate(),record_origin:'app_created',notes:name,app_created_at:now,app_modified_at:now,breeding_plan:{schema_version:1,name,scenario:clone(state.scenario),created_at:now}};
    review('husbandry_events',record,null);const next=clone(data());next.tables.husbandry_events??=[];next.tables.husbandry_events.push(record);await persist(next,'Breeding plan saved.');
  }
  function update(target,repaint) {
    const field=target.dataset?.plannerField;if(!field)return;
    const meta=target.dataset,value=target.value;
    if(field==='plan-name'){state.planName=value;return}
    if(field==='profile-notes'){if(canEdit())state.profileNotes=value;return}
    if(field==='candidate-search'){state.candidateSearch=value;state.ranking=null;container.querySelector?.('[data-planner-ranking]')?.remove();if(repaint)paint();return}
    if(field==='parent'){selectParent(meta.role,value);state.sourceWarnings=[]}
    else if(field==='profile-mouse'){loadProfile(value);state.error='';state.notice=''}
    else if(field==='independent'){state.scenario.independentAssortment=Boolean(target.checked);invalidate()}
    else if(field==='config'){state.scenario[meta.key]=meta.key==='sex'?value:Number(value);invalidate()}
    else if(field==='locus'){
      const locus=state.scenario.loci.find(row=>row.id===meta.locus);if(!locus)return;
      const next=meta.key==='alleles'?value.split(',').map(allele=>allele.trim()).filter(Boolean):value;
      if(JSON.stringify(locus[meta.key])!==JSON.stringify(next)){
        locus[meta.key]=next;for(const role of ['sire','dam']){state.scenario[role].calls[locus.id]=unknown();delete state.scenario[role].id}state.profileCalls[locus.id]=unknown();
        state.illustrative=false;invalidate();state.notice='Locus definition changed. Review its parent calls and genotype evidence again.';
      }
    } else if(field==='call'){
      if(meta.mode==='profile'&&!canEdit())return;
      const calls=meta.mode==='profile'?state.profileCalls:state.scenario[meta.role].calls,current=calls[meta.locus]||(calls[meta.locus]=unknown());
      if(meta.index==='evidence')current.evidence=value;else{const alleles=[current.alleles?.[0]||'',current.alleles?.[1]||''];if(alleles[Number(meta.index)]!==value&&current.evidence==='confirmed')current.evidence='inferred';alleles[Number(meta.index)]=value;current.alleles=alleles}
      if(meta.mode!=='profile'){const selectedId=state.scenario[meta.role].id;delete state.scenario[meta.role].id;invalidate();state.illustrative=false;if(selectedId)state.notice=`Edited calls are now a hypothetical ${meta.role}; ${selectedId}'s stored genotype is unchanged.`}else{state.error='';state.notice=''}
    } else if(field==='target'){
      const current=state.scenario.targets[meta.locus]||(state.scenario.targets[meta.locus]={mode:'any'});
      if(meta.key==='mode')state.scenario.targets[meta.locus]=value==='carrier'?{mode:value,allele:''}:value==='exact'?{mode:value,alleles:['','']}:{mode:'any'};
      else if(meta.key==='alleles'){current.alleles??=['',''];current.alleles[Number(meta.index)]=value}else current.allele=value;
      invalidate();
    }
    if(repaint)paint();
  }
  container.oninput=event=>{const field=event.target.dataset?.plannerField,key=event.target.dataset?.key;if(['parent','profile-mouse','independent','call','target'].includes(field)||(field==='config'&&['sex','confidence'].includes(key))||(field==='locus'&&['kind','chromosome'].includes(key)))return;update(event.target,false)};
  container.onchange=event=>update(event.target,true);
  container.onclick=async event=>{
    const target=event.target.closest('[data-planner-action]');if(!target||target.disabled||state.busy)return;
    const meta=target.dataset,action=meta.plannerAction;state.error='';state.notice='';
    try{
      if(action==='tab'){state.tab=meta.tab;state.sourceWarnings=[]}
      else if(action==='open-mouse'){api().openMouse?.(meta.id);return}
      else if(action==='calculate')state.result=predictCross(state.scenario);
      else if(action==='add-locus')addLocus({id:'locus-'+crypto.randomUUID(),name:'New locus',kind:'other',chromosome:'unknown',alleles:['+','variant']});
      else if(action==='catalogue-locus'){const locus=state.catalogue.find(row=>row.id===meta.locus);if(locus)addLocus(locus)}
      else if(action==='remove-locus'){state.scenario.loci=state.scenario.loci.filter(row=>row.id!==meta.locus);for(const role of ['sire','dam'])delete state.scenario[role].calls[meta.locus];delete state.scenario.targets[meta.locus];invalidate()}
      else if(action==='clear-loci'){state.scenario.loci=[];state.scenario.targets={};for(const role of ['sire','dam'])state.scenario[role].calls={};state.illustrative=false;invalidate()}
      else if(action==='example'){state.scenario=exampleScenario();state.illustrative=true;state.sourceWarnings=[];invalidate()}
      else if(action==='negative-control'){const locus=state.scenario.loci.find(row=>row.id===meta.locus);if(locus?.kind==='cre'&&locus.alleles.includes('+')){state.scenario.targets[locus.id]={mode:'exact',alleles:['+','+']};invalidate()}}
      else if(action==='source-parent'){invalidate();applySuggestions(state.scenario[meta.role].id,state.scenario[meta.role].calls)}
      else if(action==='source-profile'){if(!canEdit())throw new Error('Edit access is required to review genotypes.');applySuggestions(state.profileId,state.profileCalls)}
      else if(action==='save-profile')await saveProfile();
      else if(action==='save-plan')await savePlan();
      else if(action==='load-plan'){
        const plan=(data().tables?.husbandry_events||[]).find(row=>row.event_id===meta.id&&!archived(row))?.breeding_plan;if(!plan)throw new Error('Saved plan is unavailable.');
        const checked=validateScenario(plan.scenario);if(checked.errors.length)throw new Error('Saved scenario needs review: '+checked.errors.join(' '));
        state.scenario=clone(plan.scenario);state.planName=plan.name;state.loadedPlan=plan.name;state.illustrative=false;state.result=predictCross(state.scenario);state.ranking=null;state.tab='cross';state.sourceWarnings=[];
      } else if(action==='rank'){
        const query=state.candidateSearch.trim().toLowerCase(),candidates=mice().filter(row=>row.state==='Stock'&&!archived(row)&&(!query||[row.mouse_sid,row.mouse_tag,row.physical_tag,row.mouseline,row.line,row.genotype].some(value=>String(value||'').toLowerCase().includes(query))));
        const reasons=new Map();state.ranking=rankPairs(state.scenario,candidates.map(row=>{const calls={};for(const locus of state.scenario.loci){const checked=reviewedCall(row,locus);calls[locus.id]=checked.call;if(checked.reason)reasons.set(row.mouse_sid,[...(reasons.get(row.mouse_sid)||[]),checked.reason])}return {id:row.mouse_sid,sex:row.sex,calls,record:row}}));
        for(const excluded of state.ranking.excluded)if(reasons.has(excluded.id))excluded.reason=reasons.get(excluded.id).join(' ')+ ' '+excluded.reason;
      } else if(action==='use-pair'){if(!state.ranking?.pairs.some(pair=>pair.sireId===meta.sire&&pair.damId===meta.dam))throw new Error('Compare candidates again before selecting this pair.');selectParent('sire',meta.sire);selectParent('dam',meta.dam);state.tab='cross';state.result=predictCross(state.scenario)}
      else if(action==='offspring'){
        const outcome=state.result?.outcomes[Number(meta.index)];if(!outcome)return;
        state.scenario[meta.role]={sex:meta.role==='sire'?'Male':'Female',calls:Object.fromEntries(Object.entries(outcome.calls).map(([id,alleles])=>[id,{alleles:[...alleles],evidence:'inferred'}]))};
        invalidate();state.illustrative=false;state.notice=`Hypothetical offspring loaded as ${meta.role}. Calls remain inferred; no animal was created.`;
      }
    }catch(error){state.error=error?.message||'The action could not be completed.';api().toast?.(state.error,true)}
    paint();
  };
  paint();
}
