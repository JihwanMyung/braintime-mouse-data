import { buildCryoActivity, cryoSourceLotId } from './cryopreservation-model.js?v=24';
import { discoverCryoSources } from './cryo-sources.js?v=24';

const mounts=new WeakMap();
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const date=()=>{const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`};
const text=value=>typeof value==='string'?value:'';
const ids=value=>text(value).split(',').map(value=>value.trim()).filter(Boolean);
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const statuses={unreviewed:'Needs review',stored:'Stored',depleted:'Depleted',transferred:'Transferred',closed:'Closed'};
const materials={unknown:'Unknown',sperm:'Sperm',embryo:'Embryos',other:'Other'};
const actions={stocktake:'Stocktake / count correction',deposit:'Deposit',use:'Use',discard:'Discard',transfer_out:'Transfer out',transfer_in:'Transfer in',recovery:'Recovery',relocation:'Location / manager update',status_change:'Status change',note:'Note'};
const quantityActions=new Set(['stocktake','deposit','use','discard','transfer_out','transfer_in','recovery']);
const storageFields=['facility','tank','canister','position'];
const title=value=>value.slice(0,1).toUpperCase()+value.slice(1);
const unitLabel=value=>value||'unit unspecified';
const quantity=(value,unit)=>value===null||value===undefined?'Unknown':`${esc(value)} ${esc(unitLabel(unit))}`;
const location=value=>storageFields.map(field=>text(value?.[field])).filter(Boolean).join(' / ')||'Not assigned';
const option=(value,label,selected)=>`<option value="${esc(value)}"${String(value)===String(selected)?' selected':''}>${esc(label)}</option>`;
const button=(action,label,meta='',style='secondary')=>`<button type="button" class="button ${style}" data-cryo-action="${action}" ${meta}>${label}</button>`;
const url=value=>{try{const parsed=new URL(value);return ['https:','http:'].includes(parsed.protocol)?parsed.href:null}catch{return null}};
const alerts=(values,kind='amber')=>values?.length?`<div class="alert ${kind}"${kind==='error'?' role="alert"':''}><ul>${[...new Set(values)].map(value=>`<li>${esc(value)}</li>`).join('')}</ul></div>`:'';
const label=lot=>lot?.cryopreservation?.label||lot?.cryopreservation?.case_id||lot?.event_id||'Cryopreservation lot';
const sourceReport=record=>{const value=record.source_reported_quantity??record.reported_remaining,unit=record.source_reported_unit||record.quantity_unit||'straws',when=record.source_reported_quantity_source?.snapshot_date||record.reported_quantity_source?.snapshot_date||record.source_snapshot_date;return `${quantity(value,unit)} · ${esc(when||'Snapshot date unknown')}`};

export function renderCryopreservation(container,dataset,hooks) {
  let state=mounts.get(container);
  if(!state){state={tab:'inventory',search:'',status:'',manager:'',storage:'',selected:'',editor:null,busy:false,error:'',notice:'',warnings:[],discovery:null,discoveryDataset:null,discoveryIndex:null};mounts.set(container,state)}
  const changed=state.discoveryDataset!==null&&state.discoveryDataset!==dataset;
  state.context={dataset,hooks};
  const data=()=>state.context.dataset;
  const api=()=>state.context.hooks;
  const canEdit=()=>api().canEdit?.()===true;
  const records=()=>data().tables?.husbandry_events||[];
  const lots=()=>records().filter(row=>row.event_type==='cryopreservation_lot'&&object(row.cryopreservation));
  const findLot=id=>lots().find(row=>row.event_id===id);
  const groups=()=>state.discovery?.groups||[];
  if(state.discoveryDataset!==dataset||state.discoveryIndex!==(hooks.historyIndex||null)){state.discovery=discoverCryoSources(dataset,hooks.historyIndex||null);state.discoveryDataset=dataset;state.discoveryIndex=hooks.historyIndex||null}
  if(changed&&state.editor&&!state.busy){state.editor.stale=true;state.error='The dataset changed while this draft was open. Reopen the record before saving.'}

  function sourcesHTML(record) {
    const snapshots=record.source_snapshots||[],sources=record.sources||snapshots.map(snapshot=>snapshot.source).filter(Boolean),planned=record.status==='planned_transfer';
    if(!snapshots.length&&!sources.length)return '';
    return `<details class="compact-details cryo-source-details"><summary>Source evidence (${snapshots.length||sources.length})</summary><div class="panel-body">${sources.map(source=>{const href=url(source.url),name=[source.title,source.sheet,source.cell].filter(Boolean).join(' · ');return `<p class="small">${href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(name||'Source')}</a>`:esc(name||'Source unavailable')} · ${esc(source.snapshot_date||'Date unknown')}</p>`}).join('')}${snapshots.length&&!planned?`<div class="table-scroll"><table><thead><tr><th>Snapshot</th><th>Reported count</th><th>Batches</th></tr></thead><tbody>${snapshots.map(snapshot=>`<tr><td>${esc(snapshot.source?.snapshot_date||snapshot.source_snapshot_date||'Unknown')}</td><td>${quantity(snapshot.reported_remaining??snapshot.source_reported_quantity,snapshot.quantity_unit||'straws')}</td><td>${esc((snapshot.batch_ids||[]).join(', ')||snapshot.batch_ids_raw||'Unknown')}</td></tr>`).join('')}</tbody></table></div>`:''}${planned?'<p class="small muted">Historical transfer plan; current intent and completion are unverified.</p>':`<p class="small muted">Historical counts do not establish current stock. Batch lists are retained together; counts are not allocated to individual batches.</p><p class="small">Prepared / issued: ${esc(record.source_prepared_by||record.prepared_by||'Not recorded')} · Service reference: ${esc(record.source_service_reference||record.service_reference||'Not recorded')}</p>`}</div></details>`;
  }
  function filterRow(values,fields={}) {
    const query=state.search.trim().toLowerCase();
    return (!query||values.map(value=>typeof value==='object'?JSON.stringify(value):String(value??'')).join(' ').toLowerCase().includes(query))&&(!state.status||fields.status===state.status)&&(!state.manager||(state.manager==='__unassigned'?!fields.manager:fields.manager===state.manager))&&(!state.storage||String(fields.storage||'').toLowerCase().includes(state.storage.toLowerCase()));
  }
  function inventoryHTML() {
    const all=lots(),linked=new Set(all.map(row=>row.source_case_key).filter(Boolean));
    const managed=all.filter(row=>{const c=row.cryopreservation;return filterRow([label(row),c.case_id,c.strain,c.gene,c.zygosity,c.batch_ids,c.manager,c.storage_location,c.donor_mouse_sids],{status:archived(row)?'archived':c.status,manager:c.manager||'',storage:location(c.storage_location)})});
    const pending=groups().filter(group=>!linked.has(group.id)&&filterRow([group.case_id,group.strain,group.gene,group.zygosity,group.batch_ids],{status:'source',manager:'',storage:''}));
    const managers=[...new Set(all.map(row=>row.cryopreservation.manager).filter(Boolean))].sort();
    return `<div class="cryo-summary"><div class="stat"><span>Managed lots</span><strong>${all.filter(row=>!archived(row)).length}</strong></div><div class="stat"><span>Source records awaiting review</span><strong>${groups().filter(row=>!linked.has(row.id)).length}</strong></div><div class="stat"><span>Current quantity unknown</span><strong>${all.filter(row=>!archived(row)&&row.cryopreservation.quantity==null).length+groups().filter(row=>!linked.has(row.id)).length}</strong></div></div><section class="panel"><div class="panel-body"><div class="form-grid"><div class="field"><label>Status<select data-cryo-field="filter" data-key="status">${option('','All statuses',state.status)}${option('source','Source record',state.status)}${Object.entries(statuses).map(([value,name])=>option(value,name,state.status)).join('')}${option('archived','Archived',state.status)}</select></label></div><div class="field"><label>Manager<select data-cryo-field="filter" data-key="manager">${option('','All managers',state.manager)}${option('__unassigned','Needs manager',state.manager)}${managers.map(value=>option(value,value,state.manager)).join('')}</select></label></div><div class="field"><label>Storage filter<input value="${esc(state.storage)}" data-cryo-field="filter" data-key="storage" placeholder="Facility, tank, canister or position"></label></div></div>${canEdit()?`<div class="settings-actions">${button('new','New cryopreservation record','', 'primary')}</div>`:''}</div><div class="table-scroll"><table><thead><tr><th>Case / strain</th><th>Batches</th><th>Current quantity</th><th>Status / material</th><th>Manager / storage</th><th></th></tr></thead><tbody>${managed.map(row=>{const c=row.cryopreservation;return `<tr><td><strong>${esc(label(row))}</strong><div>${esc(c.strain||'Strain unknown')}</div>${row.source_reported_quantity!=null?`<div class="small muted">Source report: ${sourceReport(row)}</div>`:''}</td><td>${esc((c.batch_ids||[]).join(', ')||'Unknown')}</td><td>${quantity(c.quantity,c.quantity_unit)}<div class="small muted">${c.quantity_as_of_date?'As of '+esc(c.quantity_as_of_date):'No current stocktake'}</div></td><td><span class="badge${c.status==='unreviewed'?' amber':''}">${esc(archived(row)?'Archived':statuses[c.status]||c.status)}</span><div class="small">${esc(materials[c.material]||'Unknown')}</div></td><td>${esc(c.manager||'Needs manager')}<div class="small muted">${esc(location(c.storage_location))}</div></td><td>${button('view','View',`data-id="${esc(row.event_id)}"`)}</td></tr>`}).join('')}${pending.map(group=>`<tr><td><strong>${esc(group.case_id||'Source case')}</strong><div>${esc(group.strain||'Strain unknown')}</div><div class="small muted">Source report: ${sourceReport(group)}</div></td><td>${esc((group.batch_ids||[]).join(', ')||'Not recorded')}</td><td>Unknown<div class="small muted">Historical count, current stock unverified</div></td><td><span class="badge amber">Source record</span><div class="small">Material unknown</div></td><td>Not assigned</td><td>${button('source','View source',`data-id="${esc(group.id)}"`)}${canEdit()?button('review-source','Review',`data-id="${esc(group.id)}"`):''}</td></tr>`).join('')}${!managed.length&&!pending.length?'<tr><td colspan="6">No cryopreservation records match.</td></tr>':''}</tbody></table></div></section>`;
  }
  function detailHTML() {
    if(!state.selected)return '';
    const lot=findLot(state.selected),group=groups().find(row=>row.id===state.selected);
    if(!lot&&!group)return '';
    const c=lot?.cryopreservation||group;
    const cells=[['Case',c.case_id],['Strain',c.strain],['Background',c.background],['Modification method',c.modification_method],['Gene (recorded text)',c.gene],['Zygosity (recorded text)',c.zygosity],['Origin',c.origin],['Batches',(c.batch_ids||[]).join(', ')],['Frozen',c.frozen_date],['Material',materials[c.material]||'Unknown']];
    return `<section class="panel cryo-detail"><div class="panel-head"><h2>${esc(lot?label(lot):group.case_id||'Source case')}</h2>${button('close-detail','Close')}</div><div class="panel-body"><dl class="keyvals">${cells.map(([key,value])=>`<dt>${esc(key)}</dt><dd>${esc(value||'Unknown')}</dd>`).join('')}${lot?`<dt>Current quantity</dt><dd>${quantity(c.quantity,c.quantity_unit)}${c.quantity_as_of_date?' · '+esc(c.quantity_as_of_date):''}</dd><dt>Manager</dt><dd>${esc(c.manager||'Not assigned')}</dd><dt>Storage</dt><dd>${esc(location(c.storage_location))}</dd><dt>Donor mice</dt><dd>${(c.donor_mouse_sids||[]).map(id=>button('open-mouse',esc(id),`data-id="${esc(id)}"`)).join(' ')||'Not recorded'}</dd>`:''}<dt>Historical source report</dt><dd>${sourceReport(lot||group)}</dd></dl>${alerts(group?.warnings||lot?.source_warnings)}${sourcesHTML(lot||group)}${canEdit()?`<div class="settings-actions">${lot&&!archived(lot)?`${button('activity','Record activity',`data-id="${esc(lot.event_id)}"`,'primary')}${button('edit','Edit details',`data-id="${esc(lot.event_id)}"`)}`:!lot?button('review-source','Review source record',`data-id="${esc(group.id)}"`,'primary'):''}</div>`:''}${lot?historyTable(lot.event_id):''}</div></section>`;
  }
  function activityData(record) {return record.cryopreservation_event||record.cryopreservation||record}
  function historyTable(lotId='') {
    const events=records().filter(row=>row.event_type==='cryopreservation_event').filter(row=>{const activity=activityData(row);return (!lotId||(activity.lot_id)===lotId)&&(!state.search||[row.event_date,row.notes,JSON.stringify(activity)].join(' ').toLowerCase().includes(state.search.toLowerCase()))}).sort((a,b)=>String(b.event_date).localeCompare(String(a.event_date))||String(b.app_created_at).localeCompare(String(a.app_created_at)));
    return `<div class="table-scroll"><table><thead><tr><th>Date / case</th><th>Activity</th><th>Quantity before → after</th><th>Details</th></tr></thead><tbody>${events.map(row=>{const activity=activityData(row),parent=findLot(activity.lot_id),before=activity.before||{},after=activity.after||{};return `<tr><td>${esc(row.event_date)}<div>${parent?button('view',esc(label(parent)),`data-id="${esc(parent.event_id)}"`):esc(activity.lot_id||'Unknown lot')}</div></td><td>${esc(actions[activity.activity_type]||activity.activity_type||'Activity')}${activity.quantity!=null?`<div class="small">Recorded count: ${quantity(activity.quantity,activity.quantity_unit)}</div>`:''}</td><td>${quantity(before.quantity,before.quantity_unit)} → ${quantity(after.quantity,after.quantity_unit)}</td><td>${esc(row.notes||activity.notes||'')}<div class="small muted">${JSON.stringify(before.storage_location)!==JSON.stringify(after.storage_location)?'Storage: '+esc(location(before.storage_location))+' → '+esc(location(after.storage_location)):''}</div>${before.manager!==after.manager?`<div class="small muted">Manager: ${esc(before.manager||'Not assigned')} → ${esc(after.manager||'Not assigned')}</div>`:''}${before.status!==after.status?`<div class="small muted">Status: ${esc(statuses[before.status]||before.status||'Unknown')} → ${esc(statuses[after.status]||after.status||'Unknown')}</div>`:''}${activity.recovery_status&&activity.recovery_status!=='not_recorded'?`<div class="small">Recovery: ${esc(activity.recovery_status.replaceAll('_',' '))}</div>`:''}${(activity.recovered_mouse_sids||[]).map(id=>button('open-mouse',esc(id),`data-id="${esc(id)}"`)).join(' ')}</td></tr>`}).join('')||'<tr><td colspan="4">No recorded cryopreservation activities.</td></tr>'}</tbody></table></div>`;
  }
  function plansHTML() {
    const plans=(state.discovery.plans||[]).filter(row=>!state.search||[row.strain,row.tag_text,row.sex_text].join(' ').toLowerCase().includes(state.search.toLowerCase()));
    return `<section class="panel"><div class="panel-head"><h2>Source transfer plans</h2><span class="badge">${plans.length}</span></div><p class="small muted panel-body">Historical source plans do not establish currently pending work, frozen material, completed transfer or current inventory.</p><div class="table-scroll"><table><thead><tr><th>Strain</th><th>Recorded tags</th><th>Recorded sex</th><th>Source</th></tr></thead><tbody>${plans.map(row=>`<tr><td>${esc(row.strain||'Unknown')}</td><td>${esc(row.tag_text||'Not recorded')}</td><td>${esc(row.sex_text||'Not recorded')}</td><td>${sourcesHTML(row)}</td></tr>`).join('')||'<tr><td colspan="4">No planned transfer rows in the loaded sources.</td></tr>'}</tbody></table></div></section>`;
  }
  function input(key,name,value,type='text',attributes='') {return `<div class="field"><label>${name}<input type="${type}" value="${esc(value??'')}" data-cryo-field="editor" data-key="${key}" ${attributes}></label></div>`}
  function select(key,name,value,choices) {return `<div class="field"><label>${name}<select data-cryo-field="editor" data-key="${key}">${choices.map(([id,label])=>option(id,label,value)).join('')}</select></label></div>`}
  function editorHTML() {
    const editor=state.editor;if(!editor)return '';
    const value=editor.values,isActivity=editor.kind==='activity',isNew=!editor.original;
    const storage=()=>storageFields.map(field=>input('storage_'+field,title(field),value['storage_'+field])).join('');
    const fields=isActivity?`${select('activity_type','Activity',value.activity_type,Object.entries(actions))}${input('event_date','Effective date',value.event_date,'date','required')}${quantityActions.has(value.activity_type)?`${input('quantity',value.activity_type==='stocktake'?'Current total count':value.activity_type==='recovery'?'Consumed count (optional)':'Count',value.quantity,'number','min="0" step="1"')}${select('quantity_unit','Unit',value.quantity_unit,[['','Unknown'],...['straws','vials','embryos','aliquots','other'].map(unit=>[unit,title(unit)])])}`:''}${(value.activity_type==='status_change'||quantityActions.has(value.activity_type))?select('status','Resulting status',value.status,[['','Keep current status'],...Object.entries(statuses)]):''}${value.activity_type==='relocation'?`${input('manager','Manager',value.manager)}${storage()}`:''}${value.activity_type==='recovery'?`${select('recovery_status','Recovery result',value.recovery_status,[['not_recorded','Not recorded'],['attempted','Attempted'],['recovered','Recovered'],['not_recovered','Not recovered']])}${input('recovered_mouse_sids','Recovered mouse IDs (optional)',value.recovered_mouse_sids)}`:''}`:`${input('label','Label',value.label,'text','maxlength="160" required')}${input('case_id','Case ID',value.case_id)}${input('strain','Strain',value.strain)}${input('background','Background',value.background)}${input('modification_method','Modification method (recorded text)',value.modification_method)}${input('gene','Gene (recorded text)',value.gene)}${input('zygosity','Zygosity (recorded text)',value.zygosity)}${input('origin','Origin',value.origin)}${input('batch_ids','Batch IDs, separated by commas',value.batch_ids)}${input('frozen_date','Frozen date',value.frozen_date,'date')}${select('material','Material',value.material,Object.entries(materials))}${input('donor_mouse_sids','Donor mouse IDs (optional, exact IDs)',value.donor_mouse_sids)}${isNew?`${select('quantity_unit','Inventory unit',value.quantity_unit,[['','Unknown'],...['straws','vials','embryos','aliquots','other'].map(unit=>[unit,title(unit)])])}${input('manager','Manager',value.manager)}${storage()}`:''}`;
    return `<section class="panel cryo-editor"><div class="panel-head"><h2>${isActivity?'Record activity':isNew?'Review cryopreservation record':'Edit cryopreservation details'}</h2>${button('cancel-editor','Cancel')}</div><div class="panel-body">${editor.stale?alerts(['The record changed. Close and reopen this draft before saving.'],'error'):''}${editor.source?`<p class="small muted">Historical report: ${sourceReport(editor.source)}. Current quantity starts unknown; record a dated stocktake after saving.</p>${alerts(editor.source.warnings)}`:''}${isActivity?`<p class="small">${esc(label(editor.original))} · current quantity ${quantity(editor.original.cryopreservation.quantity,editor.original.cryopreservation.quantity_unit)}</p><p class="small muted">A stocktake records an absolute count. Other quantity activities record the amount added or removed. An unknown starting balance stays unknown until a stocktake.</p>`:!isNew?'<p class="small muted">Record stock, status, storage and manager changes as dated activities.</p>':'<p class="small muted">No donor animal or current quantity is inferred from source labels.</p>'}<div class="form-grid">${fields}</div><div class="field"><label>Notes<textarea data-cryo-field="editor" data-key="notes">${esc(value.notes||'')}</textarea></label></div>${state.warnings.length?alerts(state.warnings):''}${editor.preview?`<details class="compact-details" open><summary>Draft review</summary><pre>${esc(editor.preview)}</pre></details>`:''}<div class="settings-actions">${button('review-draft','Review draft')}${button('save',api().isCloud?.()?'Save to colony':'Save locally',editor.stale?'disabled':'','primary')}</div></div></section>`;
  }
  function sourceStatusHTML() {
    const partials=state.discovery.partials||[];
    return `${api().historyLoading?'<p class="banner" role="status">Loading cryopreservation source archive…</p>':''}${api().historyError?alerts([api().historyError],'error'):''}${!api().historyLoading&&!state.discovery.coverage?.full_index_available?`<p class="banner">Full source rows are not loaded. Partial references do not establish inventory. ${button('load-history','Load source archive')}</p>`:''}${partials.length?`<details class="panel"><summary>Partial source references (${partials.length})</summary><div class="panel-body">${partials.slice(0,20).map(row=>`<p class="small">${esc([row.title,row.sheet,row.cell].filter(Boolean).join(' · '))}</p><pre>${esc(row.text)}</pre>`).join('')}${partials.length>20?'<p class="small muted">First 20 references shown. Load the full archive for complete source rows.</p>':''}</div></details>`:''}${state.discovery.warnings?.length?`<details class="compact-details"><summary>Source review notes (${state.discovery.warnings.length})</summary>${alerts(state.discovery.warnings)}</details>`:''}`;
  }
  function paint() {
    const tabs=[['inventory','Inventory'],['history','History'],['plans','Source transfer plans']];
    container.innerHTML=`<div class="cryopreservation"${state.busy?' aria-busy="true"':''}><div class="cryo-tabs archive-tabs" role="tablist" aria-label="Cryopreservation">${tabs.map(([value,name])=>`<button role="tab" aria-selected="${state.tab===value}" class="${state.tab===value?'active':''}" data-cryo-action="tab" data-tab="${value}">${name}</button>`).join('')}</div>${alerts(state.error?[state.error]:[],'error')}${state.notice?`<p class="banner" role="status">${esc(state.notice)}</p>`:''}<div class="field"><label for="cryo-search">Search cryopreservation</label><input id="cryo-search" value="${esc(state.search)}" data-cryo-field="search" placeholder="Case, strain, batch, manager or notes"></div>${editorHTML()}${detailHTML()}${sourceStatusHTML()}${state.tab==='inventory'?inventoryHTML():state.tab==='history'?`<section class="panel"><div class="panel-head"><h2>Activity history</h2></div>${historyTable()}</section>`:plansHTML()}<details class="panel"><summary>Cryopreservation help</summary><div class="panel-body"><p>Source cases and planned transfers are historical observations. Reviewing a source creates one managed record for its complete batch list. Historical remaining counts never become current quantities automatically.</p><p>Use a dated stocktake to establish or correct a balance. Usage, transfer, recovery and storage changes add history and update the same lot together. Recovery records do not create animals or establish material viability. Use Closed status to retire a record without deleting its history.</p><p>Genetic labels remain recorded text. Enter donor or recovered animal IDs only when the identity is established.</p></div></details></div>`;
    if(state.busy)container.querySelectorAll?.('button,input,select,textarea').forEach(node=>node.disabled=true);
  }
  function openLot(source=null,original=null) {
    if(!canEdit())throw new Error('Edit access is required.');
    const record=original?.cryopreservation||source||{},storage=record.storage_location||{};
    state.editor={kind:'lot',source,original:original?clone(original):null,stale:false,values:{label:record.label||record.case_id||record.strain||'',case_id:record.case_id||'',strain:record.strain||'',background:record.background||'',modification_method:record.modification_method||'',gene:record.gene||'',zygosity:record.zygosity||'',origin:record.origin||'',batch_ids:(record.batch_ids||[]).join(', '),frozen_date:record.frozen_date||'',material:record.material||'unknown',quantity_unit:record.quantity_unit||'straws',manager:record.manager||'',donor_mouse_sids:(record.donor_mouse_sids||[]).join(', '),...Object.fromEntries(storageFields.map(field=>['storage_'+field,storage[field]||''])),notes:original?.notes||''}};
    state.warnings=[];
  }
  function openActivity(lot) {
    if(!canEdit())throw new Error('Edit access is required.');if(!lot||archived(lot))throw new Error('Choose an active managed record.');
    const c=lot.cryopreservation;state.editor={kind:'activity',original:clone(lot),stale:false,values:{activity_type:'stocktake',event_date:date(),quantity:'',quantity_unit:c.quantity_unit||'',status:'',manager:c.manager||'',...Object.fromEntries(storageFields.map(field=>['storage_'+field,c.storage_location?.[field]||''])),recovery_status:'not_recorded',recovered_mouse_sids:'',notes:''}};state.warnings=[];
  }
  function draftRecords() {
    const editor=state.editor;if(!editor)throw new Error('Open a draft first.');if(editor.stale)throw new Error('Reopen this draft from the current record before saving.');
    const v=editor.values,storage=Object.fromEntries(storageFields.map(field=>[field,text(v['storage_'+field]).trim()||null]));
    if(editor.kind==='activity') {
      const input={activity_type:v.activity_type,event_date:v.event_date,quantity:quantityActions.has(v.activity_type)&&v.quantity!==''?Number(v.quantity):null,quantity_unit:v.quantity_unit||null,notes:text(v.notes).trim()};
      if(v.status)input.status=v.status;
      if(v.activity_type==='relocation'){input.manager=text(v.manager).trim()||null;input.storage_location=storage}
      if(v.activity_type==='recovery'){input.recovery_status=v.recovery_status;input.recovered_mouse_sids=ids(v.recovered_mouse_sids)}
      const built=buildCryoActivity(editor.original,input,data());return [built.lot,built.event];
    }
    const now=new Date().toISOString(),source=editor.source;
    const record=editor.original?clone(editor.original):{event_id:source?cryoSourceLotId(source.id):'CRYO-'+crypto.randomUUID(),event_type:'cryopreservation_lot',event_date:date(),record_origin:'app_created',app_created_at:now,cryopreservation:{schema_version:1,quantity:null,quantity_as_of_date:null,activity_revision:0,last_activity_id:null,status:'unreviewed'}};
    const c=record.cryopreservation;
    for(const key of ['label','case_id','strain','background','modification_method','gene','zygosity','origin'])c[key]=text(v[key]).trim()||null;
    c.batch_ids=ids(v.batch_ids);c.frozen_date=v.frozen_date||null;c.material=v.material;c.donor_mouse_sids=ids(v.donor_mouse_sids);
    if(!editor.original){c.manager=text(v.manager).trim()||null;c.storage_location=storage;c.quantity_unit=v.quantity_unit||null}
    record.notes=text(v.notes).trim();record.app_modified_at=now;
    if(source){record.source_case_key=source.id;record.source_reported_quantity=source.reported_remaining??null;record.source_reported_unit=source.quantity_unit||'straws';record.source_reported_quantity_source=clone(source.reported_quantity_source||null);record.source_snapshot_date=source.source_snapshot_date||null;record.source_snapshot_date_basis=source.source_snapshot_date_basis||null;record.source_snapshots=clone(source.source_snapshots||[]);record.source_warnings=clone(source.warnings||[]);record.source_prepared_by=source.prepared_by||null;record.source_service_reference=source.service_reference||null}
    return [record];
  }
  function review() {
    const updates=draftRecords(),next=clone(data());next.tables.husbandry_events??=[];state.warnings=[];
    for(const record of updates){const index=next.tables.husbandry_events.findIndex(row=>row.event_id===record.event_id);if(index>=0)next.tables.husbandry_events[index]=record;else next.tables.husbandry_events.push(record)}
    for(const record of updates){
      const original=records().find(row=>row.event_id===record.event_id),baseline=clone(data());
      baseline.tables.husbandry_events??=[];
      for(const related of updates.filter(row=>row.event_id!==record.event_id)){const index=baseline.tables.husbandry_events.findIndex(row=>row.event_id===related.event_id);if(index>=0)baseline.tables.husbandry_events[index]=related;else baseline.tables.husbandry_events.push(related)}
      const checked=api().validate('husbandry_events',record,baseline,original?record.event_id:null);if(checked.errors?.length)throw new Error(checked.errors.join(' '));state.warnings.push(...(checked.warnings||[]));
    }
    state.editor.preview=JSON.stringify(updates.map(row=>row.cryopreservation||activityData(row)),null,2);return {updates,next};
  }
  async function save() {
    if(!canEdit())throw new Error('Edit access is required.');const {updates,next}=review();state.busy=true;paint();
    try{const previous=data();await api().save(next);if(data()===previous)state.context.dataset=next;state.selected=updates[0].event_id;state.editor=null;state.warnings=[];state.notice='Cryopreservation record and history saved.';api().toast?.(state.notice)}finally{state.busy=false}
  }
  function update(target,repaint) {
    const field=target.dataset?.cryoField;if(!field)return;
    if(field==='search'){state.search=target.value;if(repaint)paint();return}
    if(field==='filter'){state[target.dataset.key]=target.value;if(repaint)paint();return}
    if(field==='editor'&&state.editor&&canEdit()){state.editor.values[target.dataset.key]=target.value;state.editor.preview=null;state.error='';if(repaint&&target.dataset.key==='activity_type'){state.editor.values.quantity='';state.editor.values.status='';paint()}}
  }
  container.oninput=event=>{if(event.target.tagName==='SELECT')return;update(event.target,false)};
  container.onchange=event=>update(event.target,true);
  container.onclick=async event=>{
    const target=event.target.closest('[data-cryo-action]');if(!target||target.disabled||state.busy)return;const meta=target.dataset;state.error='';state.notice='';
    try{
      if(meta.cryoAction==='tab'){state.tab=meta.tab;state.selected=''}
      else if(meta.cryoAction==='new')openLot();
      else if(meta.cryoAction==='view'){state.selected=meta.id;state.tab='inventory'}
      else if(meta.cryoAction==='source')state.selected=meta.id;
      else if(meta.cryoAction==='review-source'){const source=groups().find(row=>row.id===meta.id);if(!source)throw new Error('Source case is unavailable.');if(lots().some(row=>row.source_case_key===source.id))throw new Error('This source case already has a managed record. Open that record instead.');openLot(source)}
      else if(meta.cryoAction==='edit')openLot(null,findLot(meta.id));
      else if(meta.cryoAction==='activity')openActivity(findLot(meta.id));
      else if(meta.cryoAction==='close-detail')state.selected='';
      else if(meta.cryoAction==='cancel-editor'){state.editor=null;state.warnings=[]}
      else if(meta.cryoAction==='review-draft')review();
      else if(meta.cryoAction==='save')await save();
      else if(meta.cryoAction==='open-mouse'){api().openMouse?.(meta.id);return}
      else if(meta.cryoAction==='load-history'){await api().loadHistory?.();return}
    }catch(error){state.error=error?.message||'The action could not be completed.';api().toast?.(state.error,true)}
    paint();
  };
  paint();
}
