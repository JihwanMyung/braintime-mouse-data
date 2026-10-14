import { projectAnimalSheet, createAnimalSheetXlsx, createWorkbookXlsx, animalSheetPrintHTML } from './animal-sheet-export.js?v=24';

const mounts=new WeakMap();
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const active=row=>!row.app_archived_at&&row.archived!==true;
const scopeNames={'animal-sheet':'Current Animal Sheet',records:'Records and history',backup:'Full workspace backup','source-archive':'Full source archive'};
const typeNames={mice:'Mice',matings:'Matings',litters:'Litters',cages:'Cages',rooms:'Rooms',racks:'Racks',locations:'Positions',light_events:'Light history',husbandry_events:'Experiments, fees & husbandry'};
const idFields={mice:'mouse_sid',matings:'mating_sid',litters:'litter_sid',cages:'cage_sid',rooms:'room_id',racks:'rack_id',locations:'location_id',light_events:'event_id',husbandry_events:'event_id'};
const levelNames={low:'Low (past 3 years)',high:'High (past 6 years)',max:'Max (full history)'};
const formatNames={xlsx:'Excel workbook (.xlsx)',csv:'CSV (.csv)',json:'JSON (.json)',pdf:'PDF (print / save)'};
const formats=scope=>scope==='animal-sheet'?['xlsx','pdf']:scope==='records'?['xlsx','csv','json']:['json'];
const option=(value,label,selected,disabled=false)=>`<option value="${esc(value)}"${value===selected?' selected':''}${disabled?' disabled':''}>${esc(label)}</option>`;
const textValue=value=>value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):value;
const csvCell=value=>{let text=String(textValue(value));if(typeof value!=='number'&&(/^[\u0000-\u0020]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text)))text="'"+text;return '"'+text.replaceAll('"','""')+'"'};
const rawScope=scope=>scope==='backup'||scope==='source-archive';
const canFull=permission=>permission?.level==='max'&&permission.full_history===true;
const permissionKey=permission=>JSON.stringify([permission.level,permission.cutoff_date,permission.as_of_date,permission.full_history,Boolean(permission.local)]);
const countsFor=dataset=>Object.entries(dataset?.tables||{}).filter(([,rows])=>Array.isArray(rows)).map(([type,rows])=>({label:typeNames[type]||type,count:rows.length}));
const sumCounts=counts=>counts.reduce((sum,row)=>sum+row.count,0);
const scalarRows=rows=>{const headers=[...new Set(rows.flatMap(row=>Object.keys(row)))].sort();return [headers,...rows.map(row=>headers.map(key=>textValue(row[key]))) ]};
function experimentColumns(record) {
  const type=record.event_type;
  if(type==='locobox_protocol'&&object(record[type])){
    const {[type]:payload,...result}=record;
    for(const [key,value]of Object.entries(payload))result['locobox_'+key]=value;
    return result;
  }
  if(['lac_fee_options','lac_fee_month'].includes(type)&&object(record[type])){
    const {[type]:payload,...result}=record;
    for(const [key,value]of Object.entries(payload))result['fee_'+key]=value;
    return result;
  }
  if(!['experiment','experiment_sample'].includes(type)||!object(record[type]))return record;
  const {[type]:payload,...result}=record;
  const timingColumns={decapitation_at:'decapitation_clock_time',decapitation_circadian_time:'decapitation_circadian_time',decapitation_time_basis:'decapitation_time_basis',sampling_at:'sampling_clock_time',sampling_circadian_time:'sampling_circadian_time',sampling_time_basis:'sampling_time_basis',decapitation_circadian_time_source:'decapitation_circadian_time_source',sampling_circadian_time_source:'sampling_circadian_time_source',timezone:'timing_timezone',...(type==='experiment_sample'?{collection_at:'sampling_clock_time',circadian_time:'sampling_circadian_time',time_basis:'sampling_time_basis',circadian_time_source:'sampling_circadian_time_source'}:{})};
  for(const [key,value] of Object.entries(payload)) {
    if(key==='operator')result[type==='experiment'?'experiment_user':'sample_user']=value;
    else if(Object.hasOwn(timingColumns,key))result[timingColumns[key]]=value;
    else if(key==='entrainment'&&object(value))for(const [field,item] of Object.entries(value))result['entrainment_'+field]=item;
    else if(key==='storage'&&object(value))for(const [field,item] of Object.entries(value))result['storage_'+field]=item;
    else result[type+'_'+key]=value;
  }
  const references=type==='experiment'?payload.participants:payload.donors;
  result.confirmed_mouse_sids=(Array.isArray(references)?references:[]).filter(row=>row.link_status==='confirmed'&&typeof row.mouse_sid==='string').map(row=>row.mouse_sid);
  result.unresolved_animal_identifiers=(Array.isArray(references)?references:[]).filter(row=>row.link_status!=='confirmed'&&typeof row.raw_identifier==='string').map(row=>row.raw_identifier);
  return result;
}
function experimentProjectionWarnings(tables) {
  const count=(tables.husbandry_events||[]).filter(row=>{
    const p=row.experiment||row.experiment_sample;
    return p&&(p.participants_truncated||p.sample_usages_truncated||p.donors_truncated||p.parent_samples_truncated||[...(p.participants||[]),...(p.donors||[])].some(link=>link.candidates_truncated));
  }).length;
  const fees=(tables.husbandry_events||[]).filter(row=>row.lac_fee_month?.lines_truncated||row.lac_fee_options?.groups_truncated).length;
  const locobox=(tables.husbandry_events||[]).filter(row=>row.locobox_protocol&&(row.export_event_date_withheld||row.locobox_protocol.phases_truncated||(row.locobox_protocol.phases||[]).some(p=>p.export_interval_clipped||p.treatments_truncated||(p.treatments||[]).some(t=>t.export_interval_clipped)))).length;
  return [...(locobox?[`${locobox} Locobox protocols have intervals clipped to this report window or bounded lists. Withheld boundaries are not inferred start/end dates; flags identify omissions. Complete source records and revision snapshots require a Max backup.`]:[]),...(count?[`${count} experiment or specimen records contain more animal/sample links than this bounded report includes. Exported lists show their total and truncation flags. Full preservation backups require Max.`]:[]),...(fees?[`${fees} fee records contain more evidence lines or billing groups than this bounded report includes. Exported lists show their total and truncation flags. Full preservation backups require Max.`]:[])];
}

function checkedPermission(value) {
  if(!object(value)||!Object.hasOwn(levelNames,value.level)||!validDate(value.as_of_date))throw new Error('Export permission could not be verified. Reconnect and try again.');
  if(value.level!=='max'&&!validDate(value.cutoff_date))throw new Error('The export history boundary is unavailable. Reconnect and try again.');
  if(value.cutoff_date!=null&&(!validDate(value.cutoff_date)||value.cutoff_date>value.as_of_date))throw new Error('The export date boundary is invalid.');
  return {...value,cutoff_date:value.cutoff_date||null};
}

/** Official export workflows always read fresh authorization and fresh records. */
export async function renderExportCenter(container,dataset,hooks,options={}) {
  const opts={...(hooks.initialOptions||{}),...options};
  const state={scope:Object.hasOwn(scopeNames,opts.scope)?opts.scope:'animal-sheet',format:'xlsx',roomId:opts.roomId||'',rackId:opts.rackId||'',cageId:opts.cageId||'',selectedMouseIds:[...new Set((opts.selectedMouseIds||[]).filter(id=>typeof id==='string'&&id))],selectedOnly:Boolean(opts.selectedMouseIds?.length),entityTypes:new Set((opts.entityTypes||Object.keys(typeNames)).filter(type=>Object.hasOwn(typeNames,type))),fromDate:opts.fromDate??null,toDate:opts.toDate??null,permission:null,loading:true,busy:false,preview:null,error:'',notice:'',closed:false};
  state.format=formats(state.scope).includes(opts.format)?opts.format:formats(state.scope)[0];
  mounts.set(container,state);
  const current=()=>mounts.get(container)===state&&!state.closed&&container.isConnected!==false;
  const rows=type=>Array.isArray(dataset?.tables?.[type])?dataset.tables[type]:[];
  const locationFor=cage=>rows('locations').find(row=>row.location_id===cage.location_id);
  const cageRack=cage=>cage.rack_id||locationFor(cage)?.rack_id||'';
  const cageRoom=cage=>cage.room_id||locationFor(cage)?.room_id||rows('racks').find(row=>row.rack_id===cageRack(cage))?.room_id||'';
  const configKey=()=>JSON.stringify([state.scope,state.format,state.roomId,state.rackId,state.cageId,state.selectedOnly,state.selectedMouseIds,[...state.entityTypes].sort(),state.fromDate,state.toDate]);
  const clearPreview=()=>{state.preview=null;state.error='';state.notice=''};
  const disabled=()=>state.loading||state.busy?' disabled':'';

  function roomFilters() {
    const rooms=rows('rooms').filter(active),racks=rows('racks').filter(row=>active(row)&&(!state.roomId||row.room_id===state.roomId));
    const stock=rows('mice').filter(row=>active(row)&&row.state==='Stock'),stockCages=new Set(stock.map(row=>row.cage_sid));
    const available=new Map(rows('cages').map(row=>[row.cage_sid,row]));
    for(const mouse of stock)if(mouse.cage_sid&&!available.has(mouse.cage_sid))available.set(mouse.cage_sid,{cage_sid:mouse.cage_sid,cage_tag:mouse.cage_tag||`${mouse.cage_sid} (derived from current animals)`});
    const cages=[...available.values()].filter(row=>(stockCages.has(row.cage_sid)||(active(row)&&(/^(Active|Occupied)$/i.test(row.state||'')||locationFor(row)&&active(locationFor(row)))))&&(!state.roomId||cageRoom(row)===state.roomId)&&(!state.rackId||cageRack(row)===state.rackId));
    if(state.roomId&&!rooms.some(row=>row.room_id===state.roomId))rooms.push({room_id:state.roomId,name:`${state.roomId} (selected room)`});
    if(state.rackId&&!racks.some(row=>row.rack_id===state.rackId))racks.push({rack_id:state.rackId,name:`${state.rackId} (selected rack)`});
    if(state.cageId&&!cages.some(row=>row.cage_sid===state.cageId))cages.push({cage_sid:state.cageId,cage_tag:`${state.cageId} (selected cage, no current match)`});
    return `<div class="form-grid"><div class="field"><label>Room<select data-export-field="roomId"${disabled()}>${option('','All rooms',state.roomId)}${rooms.map(row=>option(row.room_id,row.name||row.room_id,state.roomId)).join('')}</select></label></div><div class="field"><label>Rack<select data-export-field="rackId"${disabled()}>${option('','All racks',state.rackId)}${racks.map(row=>option(row.rack_id,row.name||row.rack_id,state.rackId)).join('')}</select></label></div><div class="field"><label>Cage<select data-export-field="cageId"${disabled()}>${option('','All current cages',state.cageId)}${cages.map(row=>option(row.cage_sid,row.cage_tag||row.cage_sid,state.cageId)).join('')}</select></label></div></div>${state.selectedMouseIds.length?`<label class="checkbox-label"><input type="checkbox" data-export-field="selectedOnly"${state.selectedOnly?' checked':''}${disabled()}>Selected animals only (${state.selectedMouseIds.length})</label>`:''}<p class="small muted">Current animals are included regardless of birth date.</p>`;
  }
  function historyFilters() {
    const permission=state.permission,min=permission?.cutoff_date||'',max=permission?.as_of_date||'';
    return `<div class="form-grid"><div class="field"><label>From date, inclusive<input type="date" data-export-field="fromDate" value="${esc(state.fromDate||'')}"${min?` min="${esc(min)}"`:''}${max?` max="${esc(max)}"`:''}${disabled()}></label></div><div class="field"><label>To date, inclusive<input type="date" data-export-field="toDate" value="${esc(state.toDate||'')}"${min?` min="${esc(min)}"`:''}${max?` max="${esc(max)}"`:''}${disabled()}></label></div></div><fieldset class="export-entities"><legend>Records to include</legend>${Object.entries(typeNames).map(([type,name])=>`<label class="checkbox-label"><input type="checkbox" data-export-type="${type}"${state.entityTypes.has(type)?' checked':''}${disabled()}>${name}</label>`).join('')}</fieldset>`;
  }
  function previewHTML() {
    const preview=state.preview;if(!preview)return '<p class="small muted">Preview the selected scope before exporting.</p>';
    return `<section class="export-preview" aria-live="polite"><h3>${esc(scopeNames[preview.scope])}</h3><p><strong>${preview.total.toLocaleString()}</strong> ${preview.unit}</p>${preview.range?`<p class="small muted">${esc(preview.range)}</p>`:''}<div class="table-scroll"><table><thead><tr><th>Included</th><th>Count</th></tr></thead><tbody>${preview.counts.map(row=>`<tr><td>${esc(row.label)}</td><td>${row.count.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>${preview.warnings.length?`<details class="compact-details"><summary>Scope notes (${preview.warnings.length})</summary><ul>${preview.warnings.map(value=>`<li>${esc(value)}</li>`).join('')}</ul></details>`:''}</section>`;
  }
  function paint() {
    if(!current())return;
    const permission=state.permission,full=canFull(permission),exportDisabled=Boolean(disabled())||!state.preview;
    container.innerHTML=`<div class="dialog-heading"><div><h2>Export</h2><span class="small muted">${state.loading?'Checking export permission…':permission?esc(levelNames[permission.level])+(permission.local?' · Local demo':''):'Permission unavailable'}</span></div><button type="button" class="icon-button" data-export-action="close" aria-label="Close export dialog">×</button></div><div class="dialog-content export-center"${state.busy?' aria-busy="true"':''}>${state.error?`<div class="alert error" role="alert">${esc(state.error)}</div>`:''}${state.notice?`<p class="banner" role="status">${esc(state.notice)}</p>`:''}<div class="form-grid"><div class="field"><label>Export scope<select data-export-field="scope"${disabled()}>${Object.entries(scopeNames).map(([scope,name])=>option(scope,name,state.scope,rawScope(scope)&&!full)).join('')}</select></label></div><div class="field"><label>File format<select data-export-field="format"${disabled()}>${formats(state.scope).map(format=>option(format,formatNames[format],state.format)).join('')}</select></label></div></div>${state.scope==='animal-sheet'?roomFilters():state.scope==='records'?historyFilters():`<p class="small muted">${state.scope==='backup'?'Complete workspace dataset, including source metadata.':'Complete source-cell archive, including recorded values, formulas and comments.'} Requires Max.</p>`}${previewHTML()}<details class="compact-details"><summary>Export help</summary><p class="small muted">Low includes the past 3 years, High the past 6 years, and Max full history. The server supplies the exact inclusive cutoff. Current Animal Sheets describe present housing and include current animals with older birth dates.</p><p class="small muted">Export levels govern these official export workflows separately from read/write access. They do not revoke data already viewed or copied. Backups and full source archives require Max. PDF uses the browser’s print or Save as PDF workflow; XLSX preserves text identifiers.</p></details></div><div class="dialog-actions"><button type="button" class="button secondary" data-export-action="refresh"${disabled()}>Recheck permission</button><button type="button" class="button secondary" data-export-action="preview"${disabled()||(!permission?' disabled':'')}>Preview scope</button><button type="button" class="button primary" data-export-action="export"${exportDisabled?' disabled':''}>${state.format==='pdf'?'Open print / PDF preview':'Export '+state.format.toUpperCase()}</button></div>`;
  }
  async function permission() {
    const result=checkedPermission(await hooks.getPermission());if(!current())throw new Error('Export dialog was closed.');state.permission=result;
    if(state.fromDate===null)state.fromDate=result.cutoff_date||'';
    if(state.toDate===null)state.toDate=result.as_of_date;
    return result;
  }
  function validateSelection(grant) {
    if(!Object.hasOwn(scopeNames,state.scope)||!formats(state.scope).includes(state.format))throw new Error('Choose a supported export scope and format.');
    if(rawScope(state.scope)&&!canFull(grant))throw new Error('Max export access is required for a full backup or source archive.');
    if(state.scope==='records') {
      if(!state.entityTypes.size)throw new Error('Choose at least one record type.');
      if(state.fromDate&&!validDate(state.fromDate)||!validDate(state.toDate))throw new Error('Choose valid export dates.');
      if(grant.cutoff_date&&(!state.fromDate||state.fromDate<grant.cutoff_date))throw new Error(`Your export history starts on ${grant.cutoff_date}. Choose that date or later.`);
      if(state.toDate>grant.as_of_date)throw new Error(`The latest available export date is ${grant.as_of_date}.`);
      if(state.fromDate&&state.fromDate>state.toDate)throw new Error('From date must be on or before To date.');
    }
  }
  function projectionOptions(grant,metadata) {return {capturedAt:metadata.captured_at||grant.as_of_date,roomId:state.roomId,rackId:state.rackId,cageIds:state.cageId?[state.cageId]:[],mouseIds:state.selectedOnly?state.selectedMouseIds:[]}}
  function historyPayload(result,grant) {
    if(!object(result?.dataset)||!object(result.dataset.tables))throw new Error('Export records could not be read.');
    const tables=Object.fromEntries([...state.entityTypes].map(type=>[type,Array.isArray(result.dataset.tables[type])?result.dataset.tables[type]:[]]));
    return {metadata:{...(object(result.metadata)?result.metadata:{}),scope:'history',from_date:state.fromDate||null,to_date:state.toDate,export_level:grant.level,as_of_date:grant.as_of_date},tables};
  }
  async function collect(grant) {
    validateSelection(grant);
    if(state.scope==='backup') {
      const payload=await hooks.getBackup();if(!object(payload)||!object(payload.tables))throw new Error('The complete workspace backup is unavailable.');
      const counts=countsFor(payload);return {payload,counts,total:sumCounts(counts),unit:'records',warnings:[],range:'Full workspace history'};
    }
    if(state.scope==='source-archive') {
      const payload=await hooks.getSourceArchive();if(!object(payload)||!Array.isArray(payload.cells)||!Array.isArray(payload.sheets)||!Array.isArray(payload.sources))throw new Error('The full source archive is unavailable.');
      return {payload,counts:[{label:'Source files',count:payload.sources.length},{label:'Sheets',count:payload.sheets.length},{label:'Cells',count:payload.cells.length}],total:payload.cells.length,unit:'source cells',warnings:[],range:'Full source archive'};
    }
    const result=await hooks.getRecords({scope:state.scope==='animal-sheet'?'current_housing':'history',fromDate:state.scope==='records'?(state.fromDate||null):null,toDate:state.scope==='records'?state.toDate:null,entityTypes:state.scope==='records'?[...state.entityTypes]:['mice','cages','rooms','racks','locations','light_events']});
    if(!object(result?.dataset)||!object(result.dataset.tables))throw new Error('Fresh export records are unavailable.');
    const metadata=result.metadata,expectedScope=state.scope==='animal-sheet'?'current_housing':'history';
    if(!object(metadata)||metadata.export_level!==grant.level||(metadata.cutoff_date??null)!==grant.cutoff_date||metadata.as_of_date!==grant.as_of_date||metadata.scope!==expectedScope||(metadata.from_date??null)!==(state.scope==='records'?(state.fromDate||null):null)||(metadata.to_date??null)!==(state.scope==='records'?state.toDate:null)||Boolean(metadata.local)!==Boolean(grant.local))throw new Error('Export permission or scope changed while records were loading. Recheck permission and preview again.');
    if(state.scope==='animal-sheet') {
      const projection=projectAnimalSheet(result.dataset,projectionOptions(grant,metadata));
      const counts=Object.entries(projection.counts||{}).filter(([,value])=>typeof value==='number'&&Number.isFinite(value)).map(([key,count])=>({label:key.replaceAll('_',' '),count}));
      const total=Number.isFinite(projection.counts?.mice)?projection.counts.mice:0;
      return {projection,counts,total,unit:state.selectedOnly?'selected current animals':'current animals',warnings:Array.isArray(projection.warnings)?projection.warnings:[],range:(state.selectedOnly?'Selected animals · ':'')+'Current housing · birth date unrestricted'};
    }
    const payload=historyPayload(result,grant),counts=countsFor({tables:payload.tables});return {payload,counts,total:sumCounts(counts),unit:'records',warnings:[...(Array.isArray(result.metadata?.warnings)?result.metadata.warnings:[]),...experimentProjectionWarnings(payload.tables),...(Number(result.metadata?.excluded_undated)>0?[`${Number(result.metadata.excluded_undated).toLocaleString()} undated records were excluded from this date-limited export.`]:[])],range:`${state.fromDate||'Earliest permitted date'} to ${state.toDate}, inclusive`};
  }
  function historySheets(payload) {
    const metadata=[['Export scope','Records and history'],['From date',payload.metadata.from_date||'Full permitted history'],['To date',payload.metadata.to_date],['Export level',payload.metadata.export_level],['As of date',payload.metadata.as_of_date]];
    return [{name:'Export information',rows:[['Field','Value'],...metadata],frozenRows:1},...Object.entries(payload.tables).map(([type,records])=>({name:typeNames[type],rows:records.length?scalarRows(records.map(experimentColumns)):[['No matching records']],frozenRows:1,autoFilter:records.length>0}))];
  }
  function historyCSV(payload) {
    const combined=Object.entries(payload.tables).flatMap(([type,records])=>records.map(record=>({entity_type:type,record_id:record[idFields[type]]??'',...experimentColumns(record)})));
    if(!combined.length)return '"entity_type","record_id"\r\n';
    const keys=['entity_type','record_id',...[...new Set(combined.flatMap(record=>Object.keys(record)))].filter(key=>!['entity_type','record_id'].includes(key)).sort()];
    return '\uFEFF'+[keys.map(csvCell).join(','),...combined.map(record=>keys.map(key=>csvCell(record[key])).join(','))].join('\r\n')+'\r\n';
  }
  async function deliver(collected,grant) {
    const stem=state.scope==='animal-sheet'?'braintime-animal-sheet':state.scope==='records'?'braintime-records-history':state.scope==='backup'?'braintime-workspace-backup':'braintime-source-archive';
    if(state.format==='pdf'){await hooks.print(animalSheetPrintHTML(collected.projection),{permission:{...grant},scope:'current_housing',fromDate:null,toDate:null});return}
    let blob;
    if(state.format==='xlsx')blob=state.scope==='animal-sheet'?createAnimalSheetXlsx(collected.projection):createWorkbookXlsx({title:'Braintime records and history',capturedAt:collected.payload.metadata.captured_at||grant.as_of_date,sheets:historySheets(collected.payload)});
    else if(state.format==='csv')blob=new Blob([historyCSV(collected.payload)],{type:'text/csv;charset=utf-8'});
    else blob=new Blob([JSON.stringify(collected.payload)],{type:'application/json'});
    await hooks.download(blob,`${stem}-${grant.as_of_date}.${state.format}`);
  }
  async function perform(action) {
    if(state.loading||state.busy)return;
    if(action==='export'&&(!state.preview||state.preview.config!==configKey())){state.error='Preview the selected scope before exporting.';paint();return}
    state.busy=true;state.error='';state.notice='';paint();
    try {
      const grant=await permission();validateSelection(grant);
      if(action==='export'&&state.preview.permission!==permissionKey(grant)){state.preview=null;throw new Error('Export access or its date window changed. Preview the updated scope before exporting.');}
      if(action==='refresh'){state.preview=null;return}
      const collected=await collect(grant);if(!current())return;
      const summary={scope:state.scope,counts:collected.counts,total:collected.total,unit:collected.unit,warnings:collected.warnings,range:collected.range,config:configKey(),permission:permissionKey(grant)};
      if(action==='preview')state.preview=summary;
      else {await deliver(collected,grant);if(!current())return;state.preview=summary;state.notice=state.format==='pdf'?'Print / PDF preview opened.':'Export prepared.';hooks.toast?.(state.notice)}
    }catch(error){state.error=error?.message||'Export could not be completed.';state.preview=null;hooks.toast?.(state.error,true)}
    finally{state.busy=false;paint()}
  }
  container.oninput=event=>{if(state.loading||state.busy)return;const field=event.target.dataset?.exportField;if(['fromDate','toDate'].includes(field)){state[field]=event.target.value;clearPreview();container.querySelector?.('.export-preview')?.remove()}};
  container.onchange=event=>{
    if(state.loading||state.busy)return;const target=event.target,field=target.dataset?.exportField,type=target.dataset?.exportType;
    if(type&&Object.hasOwn(typeNames,type)){if(target.checked)state.entityTypes.add(type);else state.entityTypes.delete(type);clearPreview();paint();return}
    if(!field)return;clearPreview();
    if(field==='scope'&&Object.hasOwn(scopeNames,target.value)){state.scope=target.value;if(!formats(state.scope).includes(state.format))state.format=formats(state.scope)[0]}
    else if(field==='format'&&formats(state.scope).includes(target.value))state.format=target.value;
    else if(['fromDate','toDate','roomId','rackId','cageId'].includes(field)){state[field]=target.value;if(field==='roomId'){state.rackId='';state.cageId=''}if(field==='rackId')state.cageId=''}
    else if(field==='selectedOnly')state.selectedOnly=Boolean(target.checked);
    paint();
  };
  container.onclick=async event=>{const target=event.target.closest('[data-export-action]');if(!target||target.disabled)return;const action=target.dataset.exportAction;if(action==='close'){state.closed=true;hooks.close?.();return}if(['preview','export','refresh'].includes(action))await perform(action)};
  paint();
  try{await permission()}catch(error){state.error=error?.message||'Export permission is unavailable.'}finally{state.loading=false;paint()}
}
