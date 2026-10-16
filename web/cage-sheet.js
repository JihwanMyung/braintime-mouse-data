import { planCageMove, planCageRemoval, validateCageMovementOccupancy, planMouseMove, planMouseMoveToPosition, validateMouseMoveDrafts, buildMouseMoveEvent, getMouseMoveReadDependencies } from './cage-movement.js?v=62';
import { sortRooms } from './room-order.js?v=24';
import { projectAnimalSheet } from './animal-sheet-export.js?v=48';
import { mouseManager, validateRecord, buildCageLocationEvent } from './model.js?v=48';
import { lightClock, sourceListedAnimals } from './husbandry.js?v=62';
import { cageObservations, cageSheetAnimals, ageWeeks, todayTaipei } from './cage-observations.js?v=62';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const keys={mice:'mouse_sid',cages:'cage_sid',locations:'location_id'};
const fields={mice:['cage_sid','physical_tag','ear_mark','sex','date_of_birth','genotype','manager','comment'],cages:['cage_tag','manager','cage_type','cage_protocol','location_id','comment'],locations:['notes','manager']};
const equal=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const record=(data,type,id)=>(data?.tables?.[type]||[]).find(r=>String(r[keys[type]])===String(id));
const draftKey=(type,id,field)=>JSON.stringify([type,String(id),field]);
const active=r=>r&&!r.app_archived_at&&!r.archived;
const currentOverrides=r=>r?.cage_sheet_overrides&&typeof r.cage_sheet_overrides==='object'&&!Array.isArray(r.cage_sheet_overrides)?r.cage_sheet_overrides:{};
const projectionCages=data=>{const occupied=new Set((data.tables.mice||[]).filter(m=>active(m)&&m.state==='Stock').map(m=>String(m.cage_sid)));return (data.tables.cages||[]).filter(c=>active(c)&&(occupied.has(String(c.cage_sid))||/^(Active|Occupied)$/i.test(c.state||''))).sort((a,b)=>String(a.cage_tag||a.cage_sid).localeCompare(String(b.cage_tag||b.cage_sid),undefined,{numeric:true}));};
let state={context:null,drafts:new Map(),room:'',rack:'',search:'',saving:false,selectedCage:null,selectedMouse:null,newCageIds:new Map(),message:'',error:false};

export function clearCageSheetDrafts(){clearTimeout(state.searchTimer);state={context:null,drafts:new Map(),room:'',rack:'',search:'',saving:false,selectedCage:null,selectedMouse:null,newCageIds:new Map(),message:'',error:false};}
export function hasCageSheetDrafts(){return state.drafts.size>0;}

/** Apply only explicit edits to fresh records. Unrelated remote edits survive. */
export function applyCageSheetDrafts(dataset,drafts,{canEdit=()=>true,at=new Date().toISOString()}={}){
  const changes=Array.from(drafts),conflicts=[],updates=new Map();
  if(changes.some(c=>c.type==='mice'&&c.field==='cage_sid')&&(!canEdit('mice')||!canEdit('cages')))throw new Error('Mouse and housing edit permission is required to move mice.');
  validateMouseMoveDrafts(dataset,changes);
  const created=changes.filter(c=>c.type==='cages'&&c.field==='$create');
  if(created.length&&!canEdit('cages'))throw new Error('Cage edit permission is required to create a cage.');
  const fresh={...dataset,tables:{...dataset.tables,cages:[...(dataset.tables.cages||[])]}};
  const inserted=[];
  for(const change of created){if(!record(fresh,'cages',change.id)){const cage={...change.value,app_created_at:at,app_modified_at:at};fresh.tables.cages.push(cage);inserted.push(cage);}}
  validateCageMovementOccupancy(fresh,changes);
  for(const change of changes){
    const {type,id,field,base,value}=change;
    if(type==='cages'&&field==='$create')continue;
    if(!keys[type]||!fields[type].includes(field))throw new Error('Unsupported Animal Sheet cell.');
    if(type==='mice'&&field==='date_of_birth'&&value&&value>todayTaipei(new Date(at)))throw new Error('DOB cannot be in the future.');
    if(!canEdit(type))throw new Error(`You do not have permission to edit ${type}.`);
    const current=record(fresh,type,id);
    if(!active(current))throw new Error(`${type} ${id} is missing or archived. Reload the sheet.`);
    if(change.sourceMatch&&!(field==='cage_sid'&&equal(current[field],value))&&!(change.sourceFill===true&&equal(current[field],value)&&currentOverrides(current)[field]===true)){
      const match=change.sourceMatch,position=record(dataset,'locations',match.locationId),rows=position?cageSheetAnimals(dataset,{position}):[];
      if(!rows.some(row=>row.mouseSid===String(id)&&row.tag===match.tag&&row.sourceCell===match.sourceCell))throw new Error('Animal match changed. Reload the sheet before editing this mouse.');
    }
    if(!equal(current[field],base)&&!equal(current[field],value)){conflicts.push(`${type} ${id}: ${field.replaceAll('_',' ')}`);continue;}
    if(equal(current[field],value)&&!(change.overrideSource===true&&currentOverrides(current)[field]!==true))continue;
    const key=JSON.stringify([type,String(id)]),next=updates.get(key)||{...current};
    next[field]=value;updates.set(key,next);
  }
  if(conflicts.length)throw new Error(`Changed by another editor: ${conflicts.join('; ')}. Your draft is kept. Review or discard it before saving.`);
  const tables={...fresh.tables},date=todayTaipei(new Date(at));
  // Apply housing before mouse assignments so simultaneous moves use the final cage tag.
  const ordered=[...updates].sort(([a],[b])=>(JSON.parse(a)[0]==='mice')-(JSON.parse(b)[0]==='mice'));
  for(const [key,next] of ordered){
    const [type,id]=JSON.parse(key),before=record(fresh,type,id);
    if(type==='cages'&&changes.some(c=>c.type===type&&String(c.id)===id&&c.field==='location_id')){
      const position=record(fresh,'locations',next.location_id);
      if(next.location_id&&!active(position))throw new Error(`Position ${next.location_id} is unavailable.`);
      next.room_id=position?.room_id||null;next.rack_id=position?.rack_id||null;
      next.room=(tables.rooms||[]).find(r=>r.room_id===next.room_id)?.name||null;
      next.rack=(tables.racks||[]).find(r=>r.rack_id===next.rack_id)?.name||null;
      next.location=position?.label||null;
    }
    const assignment=type==='mice'?changes.find(c=>c.type===type&&String(c.id)===id&&c.field==='cage_sid'):null;
    if(assignment){
      const cage=record({tables},'cages',next.cage_sid);
      if(!active(cage))throw new Error(`Cage ${next.cage_sid} is unavailable.`);
      next.cage_tag=cage.cage_tag||null;
    }
    if(type==='mice'){
      const explicit=changes.filter(c=>c.type==='mice'&&String(c.id)===id&&['comment','ear_mark','date_of_birth','cage_sid'].includes(c.field));
      if(explicit.length)next.cage_sheet_overrides={...currentOverrides(before),...Object.fromEntries(explicit.map(c=>[c.field,true]))};
    }
    next.app_modified_at=at;
    const {errors}=validateRecord(type,next,{...fresh,tables},id);
    if(errors.length)throw new Error(`${type} ${id}: ${errors.join(' ')}`);
    tables[type]=tables[type].map(r=>String(r[keys[type]])===id?next:r);
    if(type==='cages'&&!inserted.some(c=>String(c.cage_sid)===id)&&!equal(before?.location_id,next.location_id))tables.husbandry_events=[...(tables.husbandry_events||[]),buildCageLocationEvent(next,before,date,{...fresh,tables},'Moved in Cages.')];
    if(assignment){const event=buildMouseMoveEvent(dataset,{...dataset,tables},assignment,{at});if(event)tables.husbandry_events=[...(tables.husbandry_events||[]),event];}
  }
  for(const cage of inserted){
    const final=record({tables},'cages',cage.cage_sid),{errors}=validateRecord('cages',final,{...fresh,tables},cage.cage_sid);
    if(errors.length)throw new Error(`Cage ${cage.cage_sid}: ${errors.join(' ')}`);
    tables.husbandry_events=[...(tables.husbandry_events||[]),buildCageLocationEvent(final,null,date,{...fresh,tables},'Created for an explicit mouse move in Cages.')];
  }
  // A renamed cage must remain consistent with its current resident mouse records.
  const renamed=[...updates].filter(([k,r])=>JSON.parse(k)[0]==='cages'&&!equal(record(fresh,'cages',r.cage_sid)?.cage_tag,r.cage_tag)).map(([,r])=>r);
  if(renamed.length){
    const names=new Map(renamed.map(c=>[String(c.cage_sid),c.cage_tag||null]));
    tables.mice=(tables.mice||[]).map(m=>{
      if(!active(m)||m.state!=='Stock'||!names.has(String(m.cage_sid))||equal(m.cage_tag,names.get(String(m.cage_sid))))return m;
      if(!canEdit('mice'))throw new Error('Changing a cage tag also requires permission to update its mouse records.');
      return {...m,cage_tag:names.get(String(m.cage_sid)),app_modified_at:at};
    });
  }
  return {...dataset,tables};
}

export function renderCageSheet(host,dataset,hooks={}){
  hooks={...hooks,readOnly:hooks.readOnly===true||dataset?.history_projection?.read_only===true};
  const accountContext=String(hooks.context||'local');
  const context=accountContext+'|'+(hooks.readOnly?'history:'+String(hooks.selectedDate||'unknown'):'current');
  const captureOptions=hooks.selectedDate?{capturedAt:`${hooks.selectedDate}T12:00:00+08:00`}:{};
  const statusLabel=hooks.readOnly?`Historical evidence as of ${hooks.selectedDate||'the selected date'} · read only`:'Current cage assignments';
  if(state.context!==context){clearCageSheetDrafts();state.context=context;}
  const canEdit=type=>!hooks.readOnly&&!state.saving&&hooks.canEdit?.(type)===true;
  const canMoveMice=()=>canEdit('mice')&&canEdit('cages');
  const compact=hooks.layout!=='detailed';
  function preview(){const tables={...dataset.tables,cages:[...(dataset.tables.cages||[])]};for(const d of state.drafts.values())if(d.type==='cages'&&d.field==='$create'&&!tables.cages.some(c=>String(c.cage_sid)===String(d.id)))tables.cages.push({...d.value});for(const type of ['cages','mice','locations'])tables[type]=(tables[type]||[]).map(r=>{const edits=[...state.drafts.values()].filter(d=>d.type===type&&d.field!=='$create'&&String(d.id)===String(r[keys[type]]));if(!edits.length)return r;const next={...r};for(const d of edits)next[d.field]=d.value;if(type==='mice'){if(edits.some(d=>d.field==='cage_sid')){next.cage_tag=(tables.cages||[]).find(c=>String(c.cage_sid)===String(next.cage_sid))?.cage_tag||null;next.cage_sheet_overrides={...currentOverrides(next),cage_sid:true};}const fields=edits.filter(d=>['comment','ear_mark','date_of_birth'].includes(d.field));if(fields.length)next.cage_sheet_overrides={...currentOverrides(next),...Object.fromEntries(fields.map(d=>[d.field,true]))};}if(type==='cages'&&edits.some(d=>d.field==='location_id')){const p=(tables.locations||[]).find(p=>p.location_id===next.location_id);next.room_id=p?.room_id||null;next.rack_id=p?.rack_id||null;next.room=null;next.rack=null;next.location=p?.label||null;}return next;});return {...dataset,tables};}
  let viewDataset=preview(),inlineEditor=null,drag=null;
  const registeredCage=id=>{const cage=record(viewDataset,'cages',id);return active(cage)&&!cage._derived&&!cage.history_read_only&&!cage.source_historical&&/^(Active|Occupied)$/i.test(cage.state||'')?cage:null;};
  const animalRows=new Map(),asOf=hooks.selectedDate||todayTaipei();
  function canMoveCage(id){const cage=registeredCage(id);if(!cage||state.drafts.has(draftKey('cages',id,'$create')))return false;const position=record(viewDataset,'locations',cage.location_id),mice=(viewDataset.tables.mice||[]).filter(m=>active(m)&&m.state==='Stock'&&String(m.cage_sid)===String(id));return !cageSheetAnimals(viewDataset,{cage,position,mice}).some(row=>!row.mouseSid||!mice.some(m=>String(m.mouse_sid)===row.mouseSid));}
  const cageChoices=projectionCages(dataset);
  const val=(type,id,field,fallback='')=>{const key=draftKey(type,id,field);return state.drafts.has(key)?state.drafts.get(key).value:(record(dataset,type,id)||state.drafts.get(draftKey(type,id,'$create'))?.value)?.[field]??fallback;};
  let projection=projectAnimalSheet(viewDataset,{entityTypes:[],...captureOptions});
  const rooms=sortRooms([...new Map(projection.groups.filter(g=>g.roomId).map(g=>[g.roomId,{room_id:g.roomId,name:g.roomName}])).values()]).map(r=>[r.room_id,r.name]);
  const racks=[...new Map(projection.groups.filter(g=>g.rackId&&(!state.room||g.roomId===state.room)).map(g=>[g.rackId,g.rackName]))];
  const input=(type,id,field,label,options={})=>{
    const value=val(type,id,field,options.fallback),pending=state.drafts.has(draftKey(type,id,field));
    const attrs=`data-sheet-type="${type}" data-sheet-id="${esc(id)}" data-sheet-field="${field}" aria-label="${esc(label)}"${canEdit(type)&&!(type==='cages'&&state.drafts.has(draftKey(type,id,'$create')))?'':' disabled'}${pending?' class="sheet-pending"':''}`;
    if(options.choices)return `<select ${attrs}>${options.choices.map(([v,n,disabled])=>`<option value="${esc(v)}"${String(value)===String(v)?' selected':''}${disabled?' disabled':''}>${esc(n)}</option>`).join('')}</select>`;
    if(options.multiline)return `<textarea ${attrs} rows="2" placeholder="${esc(options.placeholder||'Notes')}">${esc(value)}</textarea>`;
    return `<input ${attrs} type="${options.type||'text'}" value="${esc(value)}" placeholder="${esc(options.placeholder||'—')}"${field==='ear_mark'?' maxlength="160"':''}>`;
  };
  const select=(id,label,items,value)=>`<label class="sr-only" for="${id}">${label}</label><select id="${id}"><option value="">${label}</option>${items.map(([v,n])=>`<option value="${esc(v)}"${v===value?' selected':''}>${esc(n)}</option>`).join('')}</select>`;
  function card(item){
    const cage=item.cage,id=item.cageId,position=item.position,positionId=position?.location_id;
    const realCage=cage&&!cage._derived,movableCage=realCage&&canMoveCage(id),sourceAnimals=!cage&&position?sourceListedAnimals(position):[];
    const printTarget=realCage?`data-sheet-label="${esc(id)}"`:positionId?`data-sheet-position-label="${esc(positionId)}"`:'';
    const printName=realCage?`cage ${cage.cage_tag||id}`:`position ${item.positionName}`;
    const printButton=!hooks.readOnly&&printTarget?`<button type="button" class="sheet-print-label" ${printTarget} title="${esc('Print label for '+printName)}" aria-label="${esc('Print label for '+printName)}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6zM17 12h1"/></svg><span>Print label</span></button>`:'';
    const observations=position?cageObservations(position):{animals:[]},started=observations.startedDate||cage?.start_date||cage?.set_up_date||null;
    const elapsed=ageWeeks(started,asOf),manager=position?(state.drafts.has(draftKey('locations',positionId,'manager'))?val('locations',positionId,'manager'):position.app_modified_at&&position.manager?position.manager:observations.managerName||position.manager||position.source_manager_name||position.source_manager_acronym||item.manager?.name):item.manager?.name;
    const lux=observations.intensityLux;
    const schedule=item.applicableLights.map(e=>`${e.protocol||'?'} · ${lightClock(e).label}`).join(' / ');
    const summary=[manager?`<span class="sheet-manager" title="Manager">${esc(manager)}</span>`:'',started?`<time datetime="${esc(started)}" title="Started ${esc(started)}${elapsed!==null?' · '+elapsed+' weeks':''}">${esc(started)}${elapsed!==null?` · ${elapsed}wk`:''}</time>`:'',lux!==null&&lux!==undefined?`<span title="Light intensity">${esc(lux)} lux</span>`:''].filter(Boolean).join('');
    const positionOptions=[['','Unassigned'],...(dataset.tables.locations||[]).filter(p=>active(p)&&p.source_current!==false).map(p=>[String(p.location_id),`${(dataset.tables.rooms||[]).find(r=>r.room_id===p.room_id)?.name||p.room_id||''} / ${(dataset.tables.racks||[]).find(r=>r.rack_id===p.rack_id)?.name||p.rack_id||''} / ${p.label||p.location_id}`])];
    if(item.withdrawnPosition)positionOptions.push([String(item.withdrawnPosition.location_id),`${item.withdrawnPosition.label||item.withdrawnPosition.location_id} (withdrawn)`,true]);
    return `<article class="sheet-cage${compact?' sheet-compact':''}${realCage?'':' sheet-source'}${state.selectedCage===id?' sheet-selected':''}" data-cage="${esc(id)}"${realCage&&registeredCage(id)?` data-sheet-mouse-destination="${esc(id)}"`:""} data-sheet-slot="${esc(positionId||'')}" tabindex="0" aria-label="${esc(item.positionName)}${cage?' cage '+esc(id):' position'}"><header><div class="sheet-cage-heading">${canEdit('cages')&&movableCage?`<button type="button" class="text-button sheet-cage-handle" draggable="true" data-sheet-drag-cage="${esc(id)}" aria-label="Move cage ${esc(item.positionName)}" title="Drag cage or choose a destination">⠿</button>`:""}<strong>${esc(item.positionName)}</strong>${printButton}</div><div class="sheet-cage-summary">${summary}</div></header>
      ${compact?'<details class="sheet-edit-details"><summary>Cage details</summary>':''}<div class="sheet-cage-meta">${!hooks.readOnly&&!cage&&positionId?`<label class="sheet-wide">Link cage<select data-sheet-link="${esc(positionId)}" aria-label="Link cage to ${esc(item.positionName)}"${canEdit('cages')?'':' disabled'}><option value="">Choose a registered cage…</option>${cageChoices.map(c=>`<option value="${esc(c.cage_sid)}"${val('cages',c.cage_sid,'location_id')===positionId?' selected':''}>${esc(c.cage_tag||c.cage_sid)} · SID ${esc(c.cage_sid)}</option>`).join('')}</select></label>`:''}${realCage?`<label>Cage${input('cages',id,'cage_tag','Cage tag '+id)}</label><label>Manager${input('cages',id,'manager','Cage manager '+id,{fallback:item.manager.name||''})}</label><label class="sheet-wide">Position${input('cages',id,'location_id','Cage position '+id,{choices:positionOptions})}</label><label>Type${input('cages',id,'cage_type','Cage type '+id)}</label><label>IACUC${input('cages',id,'cage_protocol','Cage IACUC '+id)}</label>`:positionId?`<label class="sheet-wide">Manager${input('locations',positionId,'manager','Position manager '+positionId,{fallback:position.source_manager_name||position.source_manager_acronym||''})}</label>`:''}</div>${compact?'</details>':''}
      ${compact?compactAnimals(item):`<div class="table-scroll"><table class="sheet-mice"><thead><tr><th>Animal</th><th>Sex</th><th>Born</th><th>Genotype</th><th>Ear</th><th>User</th></tr></thead><tbody>${item.mice.map(m=>`<tr><td>${hooks.readOnly?`<span>SID ${esc(m.mouse_sid)}</span>`:`<button type="button" class="text-button" data-sheet-open-mouse="${esc(m.mouse_sid)}">${esc(m.mouse_sid)} ↗</button>`}${input('mice',m.mouse_sid,'physical_tag','Animal tag '+m.mouse_sid)}</td><td>${input('mice',m.mouse_sid,'sex','Sex '+m.mouse_sid,{choices:[['Unknown','?'],['Male','♂'],['Female','♀']]})}</td><td>${input('mice',m.mouse_sid,'date_of_birth','Birth date '+m.mouse_sid,{type:'date'})}</td><td>${input('mice',m.mouse_sid,'genotype','Genotype '+m.mouse_sid)}</td><td>${input('mice',m.mouse_sid,'ear_mark','Ear mark '+m.mouse_sid,{placeholder:'L0R1'})}</td><td>${input('mice',m.mouse_sid,'manager','Mouse manager '+m.mouse_sid,{fallback:mouseManager(m).name||''})}</td></tr>`).join('')||`<tr><td colspan="6" class="sheet-empty">${sourceAnimals.length?esc(sourceAnimals.join(' · ')):(hooks.readOnly?'No animal assignments recorded':'No current mouse assignments')}${sourceAnimals.length?'<span class="small muted">Mouse links need review.</span>':''}</td></tr>`}</tbody></table></div>`}
      <div class="sheet-light"><span>${esc(schedule||'Light schedule not recorded')}</span>${!hooks.readOnly?`<button type="button" class="text-button" data-sheet-locobox="${esc(id)}" data-sheet-position="${esc(positionId||'')}">◷ Entrainment / treatment</button>`:''}</div>
      ${compact?'<details class="sheet-edit-details"><summary>Notes</summary>':''}${realCage?input('cages',id,'comment','Cage notes '+id,{multiline:true}):positionId?input('locations',positionId,'notes','Position notes '+positionId,{multiline:true}):''}${compact?'</details>':''}
      ${!cage&&position?.source_block_text?`<details class="sheet-source-details"><summary>Animal Sheet source</summary><pre>${esc(position.source_block_text)}</pre></details>`:''}
      ${item.warnings.length?`<details class="sheet-source-details"><summary>Review ${item.warnings.length} ${item.warnings.length===1?'note':'notes'}</summary>${item.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}
      <footer>${canEdit('cages')&&movableCage?`<button type="button" class="text-button" data-sheet-move="${esc(id)}" title="Select cage to move or swap">↔ Move</button><button type="button" class="text-button" data-sheet-remove="${esc(id)}" title="Remove cage from rack; keep animal records">− Remove</button>`:canEdit('cages')&&!realCage&&positionId?`<button type="button" class="text-button" data-sheet-new="${esc(positionId)}">＋ New cage</button>`:''}${state.selectedMouse&&canMoveMice()&&((realCage&&registeredCage(id))||(!cage&&positionId&&canEdit('cages')))?`<button type="button" class="text-button" data-sheet-mouse-destination-button="${esc(realCage?id:'')}" data-sheet-mouse-position-button="${esc(positionId||'')}">Move mouse here</button>`:''}${state.selectedCage&&positionId?`<button type="button" class="text-button" data-sheet-destination="${esc(positionId)}">${cage?'⇄ Swap here':'↳ Move here'}</button>`:''}${cage&&!hooks.readOnly?`<button type="button" class="text-button" data-sheet-open-cage="${esc(id)}">Animals ↗</button>`:''}</footer></article>`;
  }
  function compactAnimals(item){
    const rows=cageSheetAnimals(viewDataset,item);
    return `<div class="sheet-compact-animals">${rows.map((row,index)=>{
      const key=JSON.stringify([item.locationId||item.cageId||'unassigned',row.key||row.mouseSid||row.tag,index]),mouseSid=row.mouseSid?String(row.mouseSid):null;
      const mouse=mouseSid?record(viewDataset,'mice',mouseSid):null;
      const sourceCageSid=mouse?.cage_sid??null;
      const sourcePosition=item.position,sourceMatch=row.matchStatus==='matched'?{locationId:row.locationId,tag:row.tag,sourceCell:row.sourceCell}:null;
      let draggable=false;
      if(mouse&&canMoveMice()&&active(mouse)&&mouse.state==='Stock'&&!mouse.history_read_only&&!mouse.source_historical&&['matched','registered'].includes(row.matchStatus)){
        if(sourceMatch&&sourcePosition&&active(sourcePosition)&&sourcePosition.source_current!==false&&!sourcePosition.history_read_only&&!sourcePosition.source_historical)draggable=true;
        else if(item.cage&&!item.cage._derived&&String(item.cageId)===String(sourceCageSid)){try{planMouseMove(viewDataset,mouseSid,sourceCageSid,{sourceCageSid});draggable=true;}catch{}}
      }
      animalRows.set(key,{...row,mouseSid,sourceCageSid,sourceMatch,draggable});
      const weeks=ageWeeks(row.dateOfBirth,asOf),editable=mouseSid&&canEdit('mice'),note=row.note||'';
      const unavailable=!mouseSid?(row.matchStatus==='ambiguous'?'Multiple mouse matches; editing unavailable.':'Mouse record not linked; editing unavailable.'):'';
      const attrs=`data-sheet-animal="${esc(key)}"`;
      return `<div class="sheet-compact-mouse" data-sheet-animal-row="${esc(key)}"><div class="sheet-animal-line"><button type="button" class="sheet-animal-tag text-button" ${attrs}${draggable?` draggable="true" data-sheet-drag-mouse="${esc(key)}"`:""} data-sheet-edit-animal="note" title="${esc([note,unavailable].filter(Boolean).join(' · ')||'Animal notes')}"${hooks.readOnly?' disabled':''}>${esc(row.tag||mouseSid||'—')}</button><button type="button" class="sheet-animal-ear text-button" ${attrs} data-sheet-edit-animal="ear" title="${esc(editable?'Edit left / right earmark':unavailable||row.earMark||'Ear mark not recorded')}"${editable?'':' disabled'}>${esc(row.earMark||'—')}</button><button type="button" class="sheet-animal-age text-button" ${attrs} data-sheet-edit-animal="dob" title="${esc(row.dateOfBirth?'DOB '+row.dateOfBirth:'DOB not recorded')}"${editable?'':' disabled'}>${weeks===null?'—':weeks+'wk'}</button></div><div class="sheet-animal-editor" data-sheet-inline-editor="${esc(key)}" hidden></div></div>`;
    }).join('')||`<div class="sheet-empty">${hooks.readOnly?'Occupancy unknown':'—'}</div>`}</div>`;
  }
  function editorNode(key){return [...(host.querySelectorAll?.('[data-sheet-inline-editor]')||[])].find(node=>node.dataset.sheetInlineEditor===key);}
  function updateDraftControls(){
    const syncButton=host.querySelector('#cage-sheet-sync');if(syncButton){syncButton.disabled=state.saving||!state.drafts.size;syncButton.querySelector('span').textContent=state.saving?'Saving…':`Save changes${state.drafts.size?' · '+state.drafts.size:''}`;}
    const discard=host.querySelector('#cage-sheet-discard');if(discard)discard.disabled=state.saving||!state.drafts.size;
    const status=host.querySelector('#cage-sheet-status');if(status){status.textContent=state.message|| (state.drafts.size?`${state.drafts.size} pending edits · not yet saved`:statusLabel);status.className=state.error?'alert error':'small muted';}
  }
  async function finishInlineEditor(){
    if(!inlineEditor||state.saving)return;
    if(inlineEditor.invalid){state.message=inlineEditor.invalid;state.error=true;updateDraftControls();return;}
    const ending=inlineEditor,node=editorNode(ending.key);inlineEditor=null;
    if(node){node.hidden=true;node.innerHTML='';}
    if(state.drafts.size){state.message='Pending changes.';updateDraftControls();}
    return false;
  }
  async function openAnimalEditor(key,mode){
    if(state.saving||hooks.readOnly)return;
    if(inlineEditor){if(inlineEditor.key===key&&inlineEditor.mode===mode){await finishInlineEditor();return;}const saved=await finishInlineEditor();if(saved||inlineEditor||state.saving)return;}
    const row=animalRows.get(key),node=editorNode(key);if(!row||!node)return;
    const editable=row.mouseSid&&canEdit('mice');
    if(mode!=='note'&&!editable)return;
    inlineEditor={key,mode};
    const baseAttrs=`data-sheet-type="mice" data-sheet-id="${esc(row.mouseSid||'')}"`;
    let content='';
    if(mode==='note'){
      const value=row.mouseSid&&state.drafts.has(draftKey('mice',row.mouseSid,'comment'))?val('mice',row.mouseSid,'comment'):row.note;
      content=editable?`<label>Note<textarea ${baseAttrs} data-sheet-field="comment" aria-label="Note for ${esc(row.tag)}" rows="2">${esc(value)}</textarea></label>`:`<p>${esc(row.note||row.sourceNote||'No note recorded.')}</p>`;
      if(row.sourceNote&&row.sourceNote!==value)content+=`<details><summary>Original note</summary><p>${esc(row.sourceNote)}</p></details>`;
      if(row.draggable)content+=`<button type="button" class="text-button" data-sheet-move-mouse="${esc(key)}">Move mouse</button>`;
      if(row.mouseSid)content+=`<button type="button" class="text-button" data-sheet-open-mouse="${esc(row.mouseSid)}">Open mouse ↗</button>`;
    }else if(mode==='ear'){
      const mark=String(state.drafts.has(draftKey('mice',row.mouseSid,'ear_mark'))?val('mice',row.mouseSid,'ear_mark'):row.earMark||''),parsed=mark.match(/^L(\d+)R(\d+)$/i);
      const pending=state.drafts.has(draftKey('mice',row.mouseSid,'ear_mark'));
      content=`${mark&&!parsed?`<p class="small">Current: ${esc(mark)}</p>`:''}<div class="sheet-ear-dials"><label>L<input type="number" inputmode="numeric" min="0" max="99" step="1" data-sheet-ear-side="L" data-sheet-ear-id="${esc(row.mouseSid)}" aria-label="Left ear holes for ${esc(row.tag)}" value="${parsed?esc(parsed[1]):''}"${pending?' class="sheet-pending"':''}></label><label>R<input type="number" inputmode="numeric" min="0" max="99" step="1" data-sheet-ear-side="R" data-sheet-ear-id="${esc(row.mouseSid)}" aria-label="Right ear holes for ${esc(row.tag)}" value="${parsed?esc(parsed[2]):''}"${pending?' class="sheet-pending"':''}></label></div>`;
    }else content=`<label>DOB<input ${baseAttrs} data-sheet-field="date_of_birth" type="date" max="${esc(todayTaipei())}" aria-label="Date of birth for ${esc(row.tag)}" value="${esc(state.drafts.has(draftKey('mice',row.mouseSid,'date_of_birth'))?val('mice',row.mouseSid,'date_of_birth'):row.dateOfBirth||'')}"></label>`;
    node.innerHTML=content+'<button type="button" class="text-button sheet-editor-done" data-sheet-editor-done="true">Done</button>';node.hidden=false;
    node.querySelector?.('textarea,input')?.focus?.();
  }
  function rackHTML(group){
    if(!compact)return `<div class="sheet-rack">${group.items.map(card).join('')}</div>`;
    const placed=group.items.filter(i=>Number.isFinite(i.row)&&Number.isFinite(i.column)),unplaced=group.items.filter(i=>!Number.isFinite(i.row)||!Number.isFinite(i.column));
    const columns=[...new Set(placed.map(i=>i.column))].sort((a,b)=>a-b),rows=[...new Set(placed.map(i=>i.row))].sort((a,b)=>a-b),slots=new Map();
    for(const item of placed){const key=JSON.stringify([item.row,item.column]);if(!slots.has(key))slots.set(key,[]);slots.get(key).push(item);}
    return `${placed.length?`<div class="sheet-physical-scroll"><div class="sheet-physical-rack" style="grid-template-columns:repeat(${columns.length},minmax(190px,1fr))">${rows.flatMap(row=>columns.map(column=>{const entries=slots.get(JSON.stringify([row,column]));return entries?`<div class="sheet-physical-slot">${entries.map(card).join('')}</div>`:'<div class="sheet-unregistered" aria-label="No registered position"></div>'})).join('')}</div></div>`:''}${unplaced.length?`<div class="sheet-rack sheet-unpositioned">${unplaced.map(card).join('')}</div>`:''}`;
  }
  function stage(plan){
    for(const change of plan.changes){const key=draftKey(change.type,change.id,change.field),base=state.drafts.has(key)?state.drafts.get(key).base:(record(dataset,change.type,change.id)||state.drafts.get(draftKey(change.type,change.id,'$create'))?.value)?.[change.field]??null;if(equal(base,change.value))state.drafts.delete(key);else{const prior=state.drafts.get(key),original=record(dataset,change.type,change.id);const mouseMove=change.mouseMove?{...change.mouseMove,sourceCageSid:base,identity:prior?.mouseMove?.identity||Object.fromEntries(['physical_tag','sex','date_of_birth'].map(field=>[field,original?.[field]??null]))}:null;state.drafts.set(key,{...change,base,...(mouseMove?{mouseMove}:{}),...(prior?.sourceMatch?{sourceMatch:prior.sourceMatch}:{})});}}
    for(const [key,draft] of state.drafts)if(draft.sourceFill===true&&!state.drafts.has(draftKey('mice',draft.id,'cage_sid')))state.drafts.delete(key);
    pruneCreatedCages();state.selectedCage=null;state.selectedMouse=null;state.error=false;state.message=plan.summary+' Pending changes.';paint();
  }
  function pruneCreatedCages(){const view=preview();for(const [key,draft] of state.drafts){if(draft.type!=='cages'||draft.field!=='$create')continue;if(!(view.tables.mice||[]).some(m=>active(m)&&m.state==='Stock'&&String(m.cage_sid)===String(draft.id)))for(const [otherKey,other] of state.drafts)if(other.type==='cages'&&String(other.id)===String(draft.id))state.drafts.delete(otherKey);}}
  function move(destination,cageSid=state.selectedCage){try{if(!canMoveCage(cageSid))throw new Error('Assign the remaining animals before moving this whole cage.');if(!canEdit('cages'))throw new Error('Housing edit permission is required.');stage(planCageMove(viewDataset,cageSid,destination));}catch(error){state.message=error.message;state.error=true;paint();}}
  function mousePlan(destination,selection,positionId=null){
    if(!canMoveMice())throw new Error('Mouse and housing edit permission is required to move mice.');
    const options={sourceCageSid:selection.sourceCageSid,...(selection.sourceMatch?{sourceMatch:selection.sourceMatch}:{})};
    if(destination)return planMouseMove(viewDataset,selection.mouseSid,destination,options);
    if(!canEdit('cages'))throw new Error('Cage edit permission is required to use this position.');
    if(!state.newCageIds.has(positionId))state.newCageIds.set(positionId,'CAGE-'+crypto.randomUUID());
    return planMouseMoveToPosition(viewDataset,selection.mouseSid,positionId,{...options,cageSid:state.newCageIds.get(positionId)});
  }
  function moveMouse(destination,selection=state.selectedMouse,positionId=null){
    try{
      if(!canMoveMice()||!selection)throw new Error('Mouse and housing edit permission is required to move mice.');
      const plan=mousePlan(destination,selection,positionId);
      if(selection.sourceMatch)for(const change of plan.changes)if(change.type==='mice')change.sourceMatch=selection.sourceMatch;
      stage(plan);
    }catch(error){state.message=error.message;state.error=true;paint();}
  }
  function paint(){
    inlineEditor=null;animalRows.clear();viewDataset=preview();projection=projectAnimalSheet(viewDataset,{entityTypes:[],...captureOptions});
    const query=state.search.toLowerCase().trim();
    const groups=projection.groups.filter(g=>(!state.room||g.roomId===state.room)&&(!state.rack||g.rackId===state.rack)).map(g=>({...g,items:g.items.filter(item=>!query||JSON.stringify([g.roomName,g.rackName,item.positionName,item.cage,item.mice,item.position]).toLowerCase().includes(query))})).filter(g=>g.items.length);
    host.innerHTML=`<style>${styles}</style><section class="cage-sheet${hooks.readOnly?' sheet-historical':''}" aria-label="Animal Sheet cage view"><div class="toolbar sheet-toolbar"><input id="cage-sheet-search" type="search" class="search" aria-label="Find cages or animals" placeholder="Find cage, animal, genotype, manager…" value="${esc(state.search)}"><div class="filters">${select('cage-sheet-room','All rooms',rooms,state.room)}${select('cage-sheet-rack','All racks',racks,state.rack)}</div>${!hooks.readOnly?`<button id="cage-sheet-sync" type="button" class="button primary"${state.saving||!state.drafts.size?' disabled':''} title="Save pending edits to the main mouse database"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2M18 3l3 3-3 3"/></svg><span>${state.saving?'Saving…':`Save changes${state.drafts.size?' · '+state.drafts.size:''}`}</span></button><button type="button" class="button secondary" id="cage-sheet-discard"${!state.drafts.size||state.saving?' disabled':''}>Discard</button>`:''}<button type="button" class="text-button" id="cage-sheet-help">Help</button></div>${state.selectedCage||state.selectedMouse?`<div class="sheet-move-notice">Moving ${state.selectedMouse?'mouse '+esc(state.selectedMouse.tag):'cage '+esc(state.selectedCage)} · choose a destination in any room. <button type="button" class="text-button" id="cage-sheet-cancel-move">Cancel move</button></div>`:''}<p id="cage-sheet-status" class="${state.error?'alert error':'small muted'}" role="status">${esc(state.message|| (state.drafts.size?`${state.drafts.size} pending edits · not yet saved`:statusLabel))}</p>${groups.map(g=>{
      const content=rackHTML(g),title=`${g.roomName} / ${g.rackName}`;
      return g.roomId||g.rackId?`<section class="panel"><div class="panel-head"><h2>${esc(title)}</h2><span>${g.items.length} cages / positions</span></div>${content}</section>`:`<details class="panel"${query?' open':''}><summary class="panel-head">${esc(title)} · ${g.items.length}</summary>${content}</details>`;
    }).join('')||'<div class="empty">No cages match.</div>'}</section>`;
    if(host.querySelector('#cage-sheet-sync'))host.querySelector('#cage-sheet-sync').onclick=sync;
    if(host.querySelector('#cage-sheet-cancel-move'))host.querySelector('#cage-sheet-cancel-move').onclick=()=>{state.selectedCage=null;state.selectedMouse=null;paint();};
    if(host.querySelector('#cage-sheet-discard'))host.querySelector('#cage-sheet-discard').onclick=async()=>{if(await hooks.confirm?.('Discard pending changes?')){state.drafts.clear();state.selectedCage=null;state.selectedMouse=null;state.newCageIds.clear();state.message='Changes discarded.';state.error=false;paint();}};
    host.querySelector('#cage-sheet-help').onclick=()=>hooks.help?.();
    host.querySelector('#cage-sheet-room').onchange=e=>{state.room=e.target.value;state.rack='';renderCageSheet(host,dataset,hooks);};
    host.querySelector('#cage-sheet-rack').onchange=e=>{state.rack=e.target.value;paint();};
    host.querySelector('#cage-sheet-search').oninput=e=>{state.search=e.target.value;const caret=e.target.selectionStart;clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>{paint();const input=host.querySelector('#cage-sheet-search');input.focus();input.setSelectionRange(caret,caret);},180);};
  }
  async function sync(){
    if(state.saving||!state.drafts.size)return;
    if(inlineEditor?.invalid){state.message=inlineEditor.invalid;state.error=true;updateDraftControls();return;}
    const pending=[...state.drafts.values()],token=state.context;state.saving=true;state.message='Saving…';state.error=false;paint();
    try{
      const fresh=await hooks.loadFresh();
      if(state.context!==token||String(hooks.currentContext?.()||accountContext)!==accountContext)throw new Error('Account or colony changed. Reload this sheet.');
      const next=applyCageSheetDrafts(fresh,pending,{canEdit:type=>hooks.canEdit?.(type)===true});
      await hooks.save(next,{readDependencies:getMouseMoveReadDependencies(fresh,pending)});
      if(state.context!==token)return;
      dataset=next;state.drafts.clear();state.message='Changes saved.';state.saving=false;
      if(hooks.saved)hooks.saved(state.message);else paint();
    }catch(error){if(state.context===token){state.message=error.message||'Save failed. Your draft is kept.';state.error=true;state.saving=false;paint();}}
  }
  host.oninput=event=>{
    let t=event.target,{sheetType:type,sheetId:id,sheetField:field}=t.dataset||{},value;
    const linking=t.dataset.sheetLink;
    if(linking){if(t.value&&canEdit('cages'))move(linking,t.value);return;}
    if(t.dataset.sheetEarSide){
      id=t.dataset.sheetEarId;type='mice';field='ear_mark';if(!canEdit(type))return;
      const node=inlineEditor&&editorNode(inlineEditor.key),left=node?.querySelector('[data-sheet-ear-side="L"]')?.value,right=node?.querySelector('[data-sheet-ear-side="R"]')?.value;
      if(!/^\d+$/.test(left??'')||!/^\d+$/.test(right??'')||Number(left)>99||Number(right)>99){if(inlineEditor)inlineEditor.invalid='Enter left and right hole counts from 0 to 99.';return;}
      value=`L${Number(left)}R${Number(right)}`;
    }
    if(!field||!canEdit(type)||(type==='cages'&&state.drafts.has(draftKey(type,id,'$create'))))return;
    if(type==='cages'&&field==='location_id'){move(t.value||null,id);return;}
    value??=t.value.trim()||null;
    if(field==='date_of_birth'&&value&&value>todayTaipei()){state.message='DOB cannot be in the future.';if(inlineEditor)inlineEditor.invalid=state.message;state.error=true;updateDraftControls();return;}
    if(inlineEditor)inlineEditor.invalid=null;
    const key=draftKey(type,id,field),original=state.drafts.has(key)?state.drafts.get(key).base:record(dataset,type,id)?.[field];
    const row=inlineEditor?animalRows.get(inlineEditor.key):null,sourceMatch=row?.matchStatus==='matched'?{locationId:row.locationId,tag:row.tag,sourceCell:row.sourceCell}:null;
    const overrideSource=Boolean(sourceMatch&&['comment','ear_mark','date_of_birth'].includes(field)&&currentOverrides(record(dataset,type,id))[field]!==true);
    if(equal(original,value)&&!overrideSource)state.drafts.delete(key);else state.drafts.set(key,{type,id,field,base:original??null,value,...(sourceMatch?{sourceMatch}:{}),...(overrideSource?{overrideSource:true}:{})});
    t.classList.toggle('sheet-pending',state.drafts.has(key));state.message='';state.error=false;updateDraftControls();
  };
  host.onfocusout=event=>{
    if(!inlineEditor)return;
    const node=editorNode(inlineEditor.key);if(!node?.contains?.(event.target)||node.contains(event.relatedTarget))return;
    // Defer until click handlers have opened another control or finished this editor.
    const current=inlineEditor;setTimeout(()=>{if(inlineEditor===current&&!node.contains(globalThis.document?.activeElement))finishInlineEditor();},0);
  };
  host.onclick=async event=>{
    const editButton=event.target.closest('[data-sheet-edit-animal]');
    if(editButton)return openAnimalEditor(editButton.dataset.sheetAnimal,editButton.dataset.sheetEditAnimal);
    if(event.target.closest('[data-sheet-editor-done]')){await finishInlineEditor();if(!inlineEditor)paint();return;}
    if(inlineEditor){const node=editorNode(inlineEditor.key);if(node&&!node.contains(event.target)){const saved=await finishInlineEditor();if(saved||inlineEditor)return;}}
    const mouseCommand=event.target.closest('[data-sheet-move-mouse],[data-sheet-mouse-destination-button]');
    if(mouseCommand){if(!canMoveMice())return;const d=mouseCommand.dataset;if(d.sheetMoveMouse){const row=animalRows.get(d.sheetMoveMouse);if(row?.draggable){state.selectedMouse={...row};state.selectedCage=null;paint();}}else moveMouse(d.sheetMouseDestinationButton,state.selectedMouse,d.sheetMousePositionButton||null);return;}
    const command=event.target.closest('[data-sheet-move],[data-sheet-drag-cage],[data-sheet-remove],[data-sheet-destination],[data-sheet-new]');
    if(command){if(!canEdit('cages'))return;const d=command.dataset;if(d.sheetMove||d.sheetDragCage){const id=d.sheetMove||d.sheetDragCage;if(!canMoveCage(id))return;state.selectedCage=id;state.selectedMouse=null;paint();}else if(d.sheetRemove){try{stage(planCageRemoval(viewDataset,d.sheetRemove));}catch(error){state.message=error.message;state.error=true;paint();}}else if(d.sheetDestination)move(d.sheetDestination);else if(d.sheetNew){if(state.drafts.size){state.message='Save or discard pending edits before creating a cage.';paint();}else hooks.newCage?.(d.sheetNew);}return;}
    if(!event.target.closest('button,input,select,textarea,a,summary,details')&&!hooks.readOnly){const cage=event.target.closest('.sheet-cage');if(cage){if(state.selectedMouse&&(cage.dataset.sheetMouseDestination||cage.dataset.sheetSlot))moveMouse(cage.dataset.sheetMouseDestination,state.selectedMouse,cage.dataset.sheetSlot);else if(state.selectedCage&&cage.dataset.sheetSlot)move(cage.dataset.sheetSlot);else if(canMoveCage(cage.dataset.cage)&&canEdit('cages')){state.selectedCage=cage.dataset.cage;state.selectedMouse=null;paint();}return;}}
    if(hooks.readOnly)return;
    const t=event.target.closest('[data-sheet-open-cage],[data-sheet-open-mouse],[data-sheet-label],[data-sheet-position-label],[data-sheet-locobox]');if(!t)return;
    if(t.hasAttribute('data-sheet-label')||t.hasAttribute('data-sheet-position-label')){
      if(state.drafts.size){state.message='Save or discard pending edits before printing.';state.error=false;paint();return;}
      if(t.hasAttribute('data-sheet-label'))hooks.printLabel?.(t.dataset.sheetLabel);else hooks.printPositionLabel?.(t.dataset.sheetPositionLabel);
    }else if(t.hasAttribute('data-sheet-open-cage'))hooks.openCage?.(t.dataset.sheetOpenCage);else if(t.hasAttribute('data-sheet-open-mouse')){if(inlineEditor){finishInlineEditor().then(()=>{if(!state.drafts.size)hooks.openMouse?.(t.dataset.sheetOpenMouse);});}else if(!state.drafts.size)hooks.openMouse?.(t.dataset.sheetOpenMouse);else{state.message='Save or discard pending edits before opening the mouse.';updateDraftControls();}}else hooks.openLocobox?.(t.dataset.sheetLocobox||null,t.dataset.sheetPosition||null);};
  function clearDragHighlight(){for(const node of host.querySelectorAll?.('.sheet-drop-target')||[])node.classList.remove('sheet-drop-target');}
  function dropPlan(target,selection=drag){
    if(!selection||hooks.readOnly||state.saving)return null;
    const cage=target.closest('.sheet-cage');if(!cage)return null;
    if(selection.kind==='mouse'){
      if(!canMoveMice()||(!cage.dataset.sheetMouseDestination&&!cage.dataset.sheetSlot))return null;
      mousePlan(cage.dataset.sheetMouseDestination,selection.row,cage.dataset.sheetSlot);
      return {kind:'mouse',destination:cage.dataset.sheetMouseDestination,positionId:cage.dataset.sheetSlot,cage};
    }
    if(!canEdit('cages')||!cage.dataset.sheetSlot)return null;
    planCageMove(viewDataset,selection.id,cage.dataset.sheetSlot);
    return {kind:'cage',destination:cage.dataset.sheetSlot,cage};
  }
  host.ondragstart=event=>{
    drag=null;
    const target=event.target.closest('[data-sheet-drag-mouse],[data-sheet-drag-cage]');
    if(!target||hooks.readOnly||state.saving||inlineEditor?.invalid){event.preventDefault();return;}
    if(target.dataset.sheetDragMouse){const row=animalRows.get(target.dataset.sheetDragMouse);if(!row?.draggable||!canMoveMice()){event.preventDefault();return;}drag={kind:'mouse',row:{...row}};}
    else if(canMoveCage(target.dataset.sheetDragCage)&&canEdit('cages'))drag={kind:'cage',id:target.dataset.sheetDragCage};
    if(!drag){event.preventDefault();return;}
    finishInlineEditor();
    if(event.dataTransfer){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-braintime-cage-move',drag.kind);}
  };
  host.ondragover=event=>{
    clearDragHighlight();try{const plan=dropPlan(event.target);if(!plan)return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';plan.cage.classList?.add('sheet-drop-target');}catch{}
  };
  host.ondrop=event=>{
    const selection=drag;drag=null;clearDragHighlight();
    try{const plan=dropPlan(event.target,selection);if(!plan)return;event.preventDefault();if(plan.kind==='mouse')moveMouse(plan.destination,selection.row,plan.positionId);else move(plan.destination,selection.id);}catch(error){state.message=error.message;state.error=true;paint();}
  };
  host.ondragend=()=>{drag=null;clearDragHighlight();};
  host.onkeydown=event=>{if(['Enter',' '].includes(event.key)&&event.target.matches('.sheet-cage')){event.preventDefault();event.target.click();}};
  paint();
}

export function cageSheetHelpHTML(){return '<p>Drag a verified mouse tag to a cage, or drag a cage handle to move or swap positions. For touch, choose <strong>Move mouse</strong> from its tag or <strong>Move</strong> on a cage, then choose a destination.</p><p>Choose a tag, earmark, or age to edit notes, ear holes, or DOB. All edits wait for <strong>Save changes</strong>; <strong>Discard</strong> cancels them. Uncertain and historical animals cannot be moved. An unlinked destination creates a cage when saved.</p><p><strong>Print label</strong> opens the three card formats. Original Animal Sheet observations are preserved.</p>';}

const styles=`.sheet-cage-handle{cursor:grab;flex-shrink:0;font-size:16px!important}.sheet-cage-handle:active,[data-sheet-drag-mouse]:active{cursor:grabbing}[data-sheet-drag-mouse]{cursor:grab}.sheet-cage-heading>strong{margin-right:auto}.sheet-drop-target{outline:3px solid #286ca6;outline-offset:-3px;background:#eef6fc}.sheet-dragging{opacity:.6}.sheet-compact .sheet-cage-summary{font-size:10px;gap:3px 6px;justify-content:flex-start}.sheet-cage-summary time{font-size:9px;white-space:nowrap}.sheet-manager{font-weight:600}.sheet-compact .sheet-animal-line{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:3px;align-items:center}.sheet-compact .sheet-animal-line>button{font-size:10px;line-height:1.35;padding:3px 0;min-height:24px}.sheet-compact .sheet-animal-tag{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sheet-compact .sheet-animal-ear,.sheet-compact .sheet-animal-age{white-space:nowrap;color:#303b43}.sheet-animal-line>button:disabled{opacity:1;color:inherit;cursor:default}.sheet-animal-editor{border:1px solid #acc3d5;background:#f4f8fb;padding:6px;font-size:11px}.sheet-animal-editor[hidden]{display:none}.sheet-animal-editor p{margin:3px 0;white-space:pre-wrap;overflow-wrap:anywhere}.sheet-animal-editor label{display:flex;gap:5px;align-items:center}.sheet-animal-editor textarea,.sheet-animal-editor input{background:#fff;border-color:#9db6c8}.sheet-animal-editor .sheet-editor-done{display:block;margin:3px 0 0 auto}.sheet-ear-dials{display:flex;gap:10px}.sheet-ear-dials label{flex:1}.sheet-ear-dials input{width:58px}.sheet-animal-editor input[type=date]{max-width:145px}.sheet-animal-editor .text-button{font-size:11px}.sheet-physical-scroll{overflow-x:auto;padding:8px}.sheet-physical-rack{display:grid;gap:6px;align-items:stretch}.sheet-physical-slot{min-width:0}.sheet-unregistered{background:repeating-linear-gradient(45deg,#fafafa,#fafafa 4px,#f4f4f4 4px,#f4f4f4 8px);min-height:60px}.sheet-compact>header{padding:5px;font-size:11px;gap:4px}.sheet-compact>header .text-button{font-size:10px}.sheet-compact .sheet-cage-summary>span{font-size:9px}.sheet-compact-animals{padding:3px}.sheet-compact-mouse{border-bottom:1px solid #d8e0e6;padding:2px 0}.sheet-animal-line{display:flex;min-width:0;align-items:center}.sheet-animal-line select{max-width:37px}.sheet-animal-line .text-button{padding:0 3px}.sheet-compact input,.sheet-compact select{font-size:11px;padding:3px}.sheet-compact-mouse details{font-size:9px;padding:1px 3px}.sheet-compact-mouse details summary{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sheet-compact-mouse details label{display:flex;align-items:center}.sheet-edit-details{font-size:10px;padding:3px 6px}.sheet-compact .sheet-light{font-size:9px;padding:4px;display:block}.sheet-compact .sheet-light .text-button{font-size:9px;padding:2px;display:block}.sheet-compact .sheet-empty{font-size:11px;padding:7px!important}.sheet-compact footer{flex-wrap:wrap;gap:4px}.sheet-compact footer button{font-size:9px!important}.sheet-selected{outline:3px solid #286ca6;outline-offset:0}.sheet-move-notice{position:sticky;top:65px;z-index:3;background:#e1effa;border:1px solid #286ca6;border-radius:5px;padding:10px;margin:6px 0}.sheet-cage[tabindex]:focus{outline:2px solid #286ca6}.sheet-cage{cursor:default}.sheet-cage:has(input:focus){cursor:auto}.sheet-toolbar{position:sticky;top:0;background:var(--bg,#fff);z-index:3;padding:10px 0}.sheet-toolbar svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;vertical-align:middle}.sheet-rack{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px}.sheet-cage{border:1px solid #a9b5bf;border-radius:6px;overflow:hidden;background:#fff;color:#111;min-width:0}.sheet-cage>header{display:flex;gap:10px;align-items:center;justify-content:space-between;background:#e7f0f7;padding:9px 10px;border-bottom:1px solid #a9b5bf;flex-wrap:wrap}.sheet-compact>header{padding:5px;gap:4px}.sheet-source>header{background:#f5f2e9}.sheet-cage-heading,.sheet-cage-summary{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;min-width:0}.sheet-cage-heading>strong{overflow-wrap:anywhere}.sheet-cage-summary{flex-wrap:wrap}.sheet-cage .sheet-print-label{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex-shrink:0;min-height:32px;padding:5px 7px;border:1px solid #7d9bb2;border-radius:5px;background:#fff;color:#194f7a;font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}.sheet-cage .sheet-print-label:hover{background:#f2f7fb}.sheet-cage .sheet-print-label:focus-visible{outline:2px solid #216aa0;outline-offset:2px}.sheet-print-label svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.sheet-compact .sheet-print-label{font-size:10px;gap:4px;padding:4px 6px}@media(pointer:coarse){.sheet-cage .sheet-print-label{min-height:44px;min-width:44px}}.sheet-cage-meta{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:7px}.sheet-cage-meta label{display:flex;gap:5px;align-items:center;font-size:11px;font-weight:600}.sheet-wide{grid-column:1/-1}.sheet-cage input,.sheet-cage select,.sheet-cage textarea{min-width:0;width:100%;font:inherit;font-size:12px;border:1px solid transparent;border-radius:2px;padding:5px;background:transparent;color:#111}.sheet-cage input:hover,.sheet-cage select:hover,.sheet-cage textarea:hover{border-color:#a9b5bf}.sheet-cage input:focus,.sheet-cage select:focus,.sheet-cage textarea:focus{border-color:#216aa0;background:#fff;outline:2px solid #c9e2f4}.sheet-cage input:disabled,.sheet-cage select:disabled,.sheet-cage textarea:disabled{opacity:1;-webkit-text-fill-color:#111}.sheet-mice{width:100%;table-layout:fixed;font-size:12px}.sheet-mice th,.sheet-mice td{padding:3px;border:1px solid #ced7df;white-space:normal;vertical-align:top}.sheet-mice th{background:#f2f5f7}.sheet-mice th:first-child{width:19%}.sheet-mice th:nth-child(2){width:8%}.sheet-mice th:nth-child(3){width:22%}.sheet-mice th:nth-child(4){width:23%}.sheet-mice th:nth-child(5){width:12%}.sheet-mice td .text-button{font-size:10px;padding:0 4px}.sheet-pending{background:#fff2b5!important;box-shadow:inset 3px 0 #d2a100}.sheet-light{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:7px;font-size:11px;border-top:1px solid #ced7df}.sheet-light .text-button{font-size:11px}.sheet-cage>footer{display:flex;justify-content:space-between;padding:4px 8px;border-top:1px solid #ced7df}.sheet-cage>footer button{font-size:11px}.sheet-empty{text-align:center;padding:12px!important}.sheet-empty span{display:block}.sheet-source-details{padding:6px 9px;font-size:11px}.sheet-source-details pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto}.sheet-cage>textarea{border-top:1px solid #ced7df}.cage-view-menu{display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-bottom:10px}.cage-view-menu select{width:auto}@media(max-width:1100px){.sheet-rack{grid-template-columns:1fr}}@media(max-width:600px){.sheet-rack{padding:5px}.sheet-toolbar{position:static}.sheet-mice{min-width:560px}.sheet-light{align-items:flex-start;flex-direction:column}}`;
