import { buildCageManagerChoices, cageManagerShortName, cageManagerValue } from './cage-managers.js?v=73';
import { cageSlotMoveEligibility, planCageSlotMove, planCageMove, planCageRemoval, validateCageMovementOccupancy, planMouseMove, planMouseMoveToPosition, validateMouseMoveDrafts, buildMouseMoveEvent, getMouseMoveReadDependencies } from './cage-movement.js?v=78';
import { sortRooms } from './room-order.js?v=24';
import { projectAnimalSheet } from './animal-sheet-export.js?v=48';
import { mouseManager, validateRecord, buildCageLocationEvent } from './model.js?v=76';
import { lightClock, sourceListedAnimals } from './husbandry.js?v=63';
import { cageObservations, cageSheetAnimals, ageWeeks, todayTaipei } from './cage-observations.js?v=70';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const keys={mice:'mouse_sid',cages:'cage_sid',locations:'location_id'};
const fields={mice:['cage_sid','physical_tag','ear_mark','sex','date_of_birth','genotype','manager','comment','note_color'],cages:['cage_tag','manager','cage_type','cage_protocol','location_id','comment','start_date'],locations:['notes','manager']};
const equal=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const record=(data,type,id)=>(data?.tables?.[type]||[]).find(r=>String(r[keys[type]])===String(id));
const draftKey=(type,id,field)=>JSON.stringify([type,String(id),field]);
const active=r=>r&&!r.app_archived_at&&!r.archived;
const noteColors=['none','green','red'];
const noteColor=value=>noteColors.includes(value)?value:'green';
const currentOverrides=r=>r?.cage_sheet_overrides&&typeof r.cage_sheet_overrides==='object'&&!Array.isArray(r.cage_sheet_overrides)?r.cage_sheet_overrides:{};
const projectionCages=data=>{const occupied=new Set((data.tables.mice||[]).filter(m=>active(m)&&m.state==='Stock').map(m=>String(m.cage_sid)));return (data.tables.cages||[]).filter(c=>active(c)&&(occupied.has(String(c.cage_sid))||/^(Active|Occupied)$/i.test(c.state||''))).sort((a,b)=>String(a.cage_tag||a.cage_sid).localeCompare(String(b.cage_tag||b.cage_sid),undefined,{numeric:true}));};
let renderSequence=0;
let state={context:null,drafts:new Map(),room:'',rack:'',search:'',saving:false,selectedCage:null,selectedSlot:null,newCageIds:new Map(),message:'',error:false};

export function clearCageSheetDrafts(){clearTimeout(state.searchTimer);state={context:null,drafts:new Map(),room:'',rack:'',search:'',saving:false,selectedCage:null,selectedSlot:null,newCageIds:new Map(),message:'',error:false};}
export function hasCageSheetDrafts(){return state.drafts.size>0;}

/** Apply only explicit edits to fresh records. Unrelated remote edits survive. */
export function applyCageSheetDrafts(dataset,drafts,{canEdit=()=>true,at=new Date().toISOString()}={}){
  const changes=Array.from(drafts),conflicts=[],updates=new Map();
  if(changes.some(c=>c.type==='mice'&&c.field==='cage_sid')&&(!canEdit('mice')||!canEdit('cages')||!canEdit('locations')))throw new Error('Mouse and housing edit permission is required to move mice.');
  validateMouseMoveDrafts(dataset,changes);
  const created=changes.filter(c=>c.type==='cages'&&c.field==='$create');
  if(created.length&&!canEdit('cages'))throw new Error('Cage edit permission is required to create a cage.');
  const fresh={...dataset,tables:{...dataset.tables,cages:[...(dataset.tables.cages||[])]}};
  const inserted=[];
  for(const change of created){if(!record(fresh,'cages',change.id)){const cage={...change.value,app_created_at:at,app_modified_at:at};fresh.tables.cages.push(cage);inserted.push(cage);}}
  validateCageMovementOccupancy(dataset,changes);
  for(const change of changes){
    const {type,id,field,base,value}=change;
    if(type==='cages'&&field==='$create')continue;
    if(!keys[type]||!fields[type].includes(field))throw new Error('Unsupported Animal Sheet cell.');
    if(type==='mice'&&field==='note_color'&&!noteColors.includes(value))throw new Error('Choose None, Green or Red for the note light.');
    if(type==='mice'&&field==='date_of_birth'&&value&&value>todayTaipei(new Date(at)))throw new Error('DOB cannot be in the future.');
    if(!canEdit(type))throw new Error(`You do not have permission to edit ${type}.`);
    const current=record(fresh,type,id);
    if(!active(current))throw new Error(`${type} ${id} is missing or archived. Reload the sheet.`);
    if(change.sourceMatch&&!(field==='cage_sid'&&equal(current[field],value))&&!((change.sourceFill===true||change.wholeCageFill===true)&&equal(current[field],value)&&currentOverrides(current)[field]===true)){
      const match=change.sourceMatch,position=record(dataset,'locations',match.locationId),rows=position?cageSheetAnimals(dataset,{position}):[];
      if(!rows.some(row=>row.mouseSid===String(id)&&(row.sourceTag||row.tag)===match.tag&&row.sourceCell===match.sourceCell))throw new Error('Animal match changed. Reload the sheet before editing this mouse.');
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
  // Moved and renamed cages keep resident tags and explicit source overrides consistent.
  const relocated=new Set([...updates].filter(([k,r])=>JSON.parse(k)[0]==='cages'&&!equal(record(fresh,'cages',r.cage_sid)?.location_id,r.location_id)).map(([,r])=>String(r.cage_sid)));
  const renamed=[...updates].filter(([k,r])=>JSON.parse(k)[0]==='cages'&&(!equal(record(fresh,'cages',r.cage_sid)?.cage_tag,r.cage_tag)||relocated.has(String(r.cage_sid)))).map(([,r])=>r);
  if(renamed.length){
    const names=new Map(renamed.map(c=>[String(c.cage_sid),c.cage_tag||null]));
    tables.mice=(tables.mice||[]).map(m=>{
      if(!active(m)||m.state!=='Stock'||!names.has(String(m.cage_sid))||equal(m.cage_tag,names.get(String(m.cage_sid)))&&(!relocated.has(String(m.cage_sid))||currentOverrides(m).cage_sid===true))return m;
      if(!canEdit('mice'))throw new Error('Changing a cage tag also requires permission to update its mouse records.');
      return {...m,cage_tag:names.get(String(m.cage_sid)),...(relocated.has(String(m.cage_sid))?{cage_sheet_overrides:{...currentOverrides(m),cage_sid:true}}:{}),app_modified_at:at};
    });
  }
  // Saving a changed slot also fences concurrent occupancy edits at that slot.
  // Source observations remain intact; an already applied retry changes nothing.
  const affectedPositions=new Set(),rememberPosition=id=>{if(id)affectedPositions.add(String(id));};
  for(const cage of tables.cages||[]){
    const before=record(dataset,'cages',cage.cage_sid);
    if(!before||!equal(before.location_id,cage.location_id)){rememberPosition(before?.location_id);rememberPosition(cage.location_id);}
  }
  for(const mouse of tables.mice||[]){
    const before=record(dataset,'mice',mouse.mouse_sid);
    if(!before||equal(before.cage_sid,mouse.cage_sid))continue;
    rememberPosition(record(dataset,'cages',before.cage_sid)?.location_id);rememberPosition(record({tables},'cages',mouse.cage_sid)?.location_id);
    for(const change of changes)if(change.type==='mice'&&String(change.id)===String(mouse.mouse_sid)&&change.field==='cage_sid')rememberPosition(change.sourceMatch?.locationId);
  }
  if(affectedPositions.size){
    if(!canEdit('locations'))throw new Error('Housing edit permission is required to update cage positions.');
    tables.locations=(tables.locations||[]).map(position=>affectedPositions.has(String(position.location_id))?{...position,app_modified_at:new Date(Math.max(Date.parse(at),Number.isFinite(Date.parse(position.app_modified_at))?Date.parse(position.app_modified_at)+1:0)).toISOString()}:position);
  }
  return {...dataset,tables};
}

export function renderCageSheet(host,dataset,hooks={}){
  const renderToken=++renderSequence;let importing=false,managers=hooks.managers||[],managersLoading=typeof hooks.loadManagers==='function',managersError=false;
  hooks={...hooks,readOnly:hooks.readOnly===true||dataset?.history_projection?.read_only===true};
  const accountContext=String(hooks.context||'local');
  const context=accountContext+'|'+(hooks.readOnly?'history:'+String(hooks.selectedDate||'unknown'):'current');
  const captureOptions=hooks.selectedDate?{capturedAt:`${hooks.selectedDate}T12:00:00+08:00`}:{};
  const statusLabel=hooks.readOnly?`Historical evidence as of ${hooks.selectedDate||'the selected date'} · read only`:'Current cage assignments';
  if(state.context!==context){clearCageSheetDrafts();state.context=context;}
  const canEdit=type=>!hooks.readOnly&&!state.saving&&!importing&&![...state.drafts.values()].some(d=>d.cageSlotMove)&&hooks.canEdit?.(type)===true;
  const canImport=()=>!hooks.readOnly&&hooks.canImport?.()===true&&typeof hooks.importFromSheet==='function';
  const importTitle=()=>state.drafts.size?'Save or discard changes before importing.':'Animal sheet → Mouse Data';
  const canMoveMice=()=>canEdit('mice')&&canEdit('cages')&&canEdit('locations');
  const compact=hooks.layout!=='detailed';
  function preview(){const tables={...dataset.tables,cages:[...(dataset.tables.cages||[])]};for(const d of state.drafts.values())if(d.type==='cages'&&d.field==='$create'&&!tables.cages.some(c=>String(c.cage_sid)===String(d.id)))tables.cages.push({...d.value});for(const type of ['cages','mice','locations'])tables[type]=(tables[type]||[]).map(r=>{const edits=[...state.drafts.values()].filter(d=>d.type===type&&d.field!=='$create'&&String(d.id)===String(r[keys[type]]));if(!edits.length)return r;const next={...r};for(const d of edits)next[d.field]=d.value;if(type==='mice'){if(edits.some(d=>d.field==='cage_sid')){next.cage_tag=(tables.cages||[]).find(c=>String(c.cage_sid)===String(next.cage_sid))?.cage_tag||null;next.cage_sheet_overrides={...currentOverrides(next),cage_sid:true};}const fields=edits.filter(d=>['comment','ear_mark','date_of_birth'].includes(d.field));if(fields.length)next.cage_sheet_overrides={...currentOverrides(next),...Object.fromEntries(fields.map(d=>[d.field,true]))};}if(type==='cages'&&edits.some(d=>d.field==='location_id')){const p=(tables.locations||[]).find(p=>p.location_id===next.location_id);next.room_id=p?.room_id||null;next.rack_id=p?.rack_id||null;next.room=null;next.rack=null;next.location=p?.label||null;}return next;});const moved=new Set([...state.drafts.values()].filter(d=>d.type==='cages'&&d.field==='location_id'&&!equal(d.base,d.value)).map(d=>String(d.id)));tables.mice=(tables.mice||[]).map(m=>active(m)&&m.state==='Stock'&&moved.has(String(m.cage_sid))?{...m,cage_tag:(tables.cages||[]).find(c=>String(c.cage_sid)===String(m.cage_sid))?.cage_tag||null,cage_sheet_overrides:{...currentOverrides(m),cage_sid:true}}:m);return {...dataset,tables};}
  let viewDataset=preview(),inlineEditor=null,drag=null,suppressMouseClickUntil=0;
  const dragPlans=new Map();
  const registeredCage=id=>{const cage=record(viewDataset,'cages',id);return active(cage)&&!cage._derived&&!cage.history_read_only&&!cage.source_historical&&/^(Active|Occupied)$/i.test(cage.state||'')?cage:null;};
  const animalRows=new Map(),asOf=hooks.selectedDate||todayTaipei();
  function canMoveCage(id){const cage=registeredCage(id);if(!cage||state.drafts.has(draftKey('cages',id,'$create')))return false;const position=record(viewDataset,'locations',cage.location_id),mice=(viewDataset.tables.mice||[]).filter(m=>active(m)&&m.state==='Stock'&&String(m.cage_sid)===String(id));return !cageSheetAnimals(viewDataset,{cage,position,mice}).some(row=>!row.mouseSid||!mice.some(m=>String(m.mouse_sid)===row.mouseSid));}
  function verifySlotSource(source){
    if(state.drafts.size)throw new Error('Save or discard pending changes before moving another whole cage.');
    if(!canMoveMice())throw new Error('Mouse and housing edit permission is required.');
    return cageSlotMoveEligibility(viewDataset,source);
  }
  function slotPlan(source,destination){
    verifySlotSource(source);
    const newCageIds={};for(const id of [source,destination]){if(!state.newCageIds.has(id))state.newCageIds.set(id,'CAGE-'+crypto.randomUUID());newCageIds[id]=state.newCageIds.get(id);}
    return planCageSlotMove(viewDataset,source,destination,{newCageIds});
  }
  const movableSlots=new Map(),cageRowsCache=new Map();
  const cageRows=item=>{const key=JSON.stringify([item.position?.location_id||item.locationId,item.cageId||item.cage?.cage_sid]);if(!cageRowsCache.has(key))cageRowsCache.set(key,cageSheetAnimals(viewDataset,item));return cageRowsCache.get(key);};
  function slotStatus(item){
    const positionId=item.position?.location_id;
    if(movableSlots.has(positionId||item.cageId))return movableSlots.get(positionId||item.cageId);
    const cage=item.cage&&!item.cage._derived?item.cage:null,rows=cageRows(item),position=item.position;
    let reason='';
    if(hooks.readOnly)reason='Historical cages are read only.';
    else if(state.drafts.size)reason='Save or discard pending changes before moving a whole cage.';
    else if(!canMoveMice())reason='Mouse and housing edit permission is required.';
    else if(position&&(position.source_current===false||position.history_read_only||position.source_historical))reason='This is not a current rack position.';
    else if(!positionId&&!canMoveCage(item.cageId))reason='This cage needs a verified current assignment.';
    else if(!cage&&!rows.length)reason='This position is empty.';
    else if(cage&&!registeredCage(item.cageId))reason='Choose a current active cage.';
    else if(positionId){try{cageSlotMoveEligibility(viewDataset,positionId);}catch(error){reason=error.message;}}
    const status={canMove:!reason,reason:reason||'Drag cage or choose Move.'};movableSlots.set(positionId||item.cageId,status);return status;
  }
  const cageChoices=projectionCages(dataset);
  const val=(type,id,field,fallback='')=>{const key=draftKey(type,id,field);return state.drafts.has(key)?state.drafts.get(key).value:(record(dataset,type,id)||state.drafts.get(draftKey(type,id,'$create'))?.value)?.[field]??fallback;};
  let projection=projectAnimalSheet(viewDataset,{entityTypes:[],...captureOptions});
  const rooms=sortRooms([...new Map(projection.groups.filter(g=>g.roomId).map(g=>[g.roomId,{room_id:g.roomId,name:g.roomName}])).values()]).map(r=>[r.room_id,r.name]);
  const racks=[...new Map(projection.groups.filter(g=>g.rackId&&(!state.room||g.roomId===state.room)).map(g=>[g.rackId,g.rackName]))];
  const input=(type,id,field,label,options={})=>{
    const raw=field==='manager'&&Object.hasOwn(record(viewDataset,type,id)||{},'manager')?record(viewDataset,type,id).manager:val(type,id,field,options.fallback),value=options.managerSelect?cageManagerValue(managers,raw):raw,pending=state.drafts.has(draftKey(type,id,field));
    const attrs=`data-sheet-type="${type}" data-sheet-id="${esc(id)}" data-sheet-field="${field}" aria-label="${esc(label)}"${canEdit(type)&&(!options.managerSelect||!managersLoading&&!managersError)&&!(type==='cages'&&state.drafts.has(draftKey(type,id,'$create')))?'':' disabled'}${pending||options.managerSelect?` class="${options.managerSelect?'sheet-manager-select ':''}${pending?'sheet-pending':''}"`:''}`;
    if(options.choices)return `<select ${attrs}>${options.choices.map(([v,n,disabled])=>`<option value="${esc(v)}"${String(value)===String(v)?' selected':''}${disabled?' disabled':''}>${esc(n)}</option>`).join('')}</select>`;
    if(options.multiline)return `<textarea ${attrs} rows="2" placeholder="${esc(options.placeholder||'Notes')}">${esc(value)}</textarea>`;
    return `<input ${attrs} type="${options.type||'text'}" value="${esc(value)}" placeholder="${esc(options.placeholder||'—')}"${field==='ear_mark'?' maxlength="160"':''}>`;
  };
  const select=(id,label,items,value)=>`<label class="sr-only" for="${id}">${label}</label><select id="${id}"><option value="">${label}</option>${items.map(([v,n])=>`<option value="${esc(v)}"${v===value?' selected':''}>${esc(n)}</option>`).join('')}</select>`;
  function card(item){
    const cage=item.cage,id=item.cageId,position=item.position,positionId=position?.location_id;
    const realCage=cage&&!cage._derived,moveStatus=slotStatus(item),movableCage=moveStatus.canMove,sourceAnimals=!cage&&position?sourceListedAnimals(position):[];
    const occupied=realCage||cageRows(item).length>0,selected=positionId?state.selectedSlot===positionId:state.selectedCage===id;
    const dragAttrs=movableCage?`${positionId?` data-sheet-drag-slot="${esc(positionId)}"`:''}${realCage?` data-sheet-drag-cage="${esc(id)}"`:''}`:'';
    const printTarget=realCage?`data-sheet-label="${esc(id)}"`:positionId?`data-sheet-position-label="${esc(positionId)}"`:'';
    const printName=realCage?`cage ${cage.cage_tag||id}`:`position ${item.positionName}`;
    const printButton=!hooks.readOnly&&printTarget?`<button type="button" class="sheet-print-label" ${printTarget} title="${esc('Print label for '+printName)}" aria-label="${esc('Print label for '+printName)}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6zM17 12h1"/></svg><span>Print label</span></button>`:'';
    const observations=position?cageObservations(position):{animals:[]},started=cage?.start_date||cage?.set_up_date||observations.startedDate||null;
    const elapsed=ageWeeks(started,asOf),manager=realCage?(Object.hasOwn(cage,'manager')?cage.manager:item.manager?.name):position&&Object.hasOwn(position,'manager')?position.manager:observations.managerName||position?.source_manager_name||position?.source_manager_acronym||item.manager?.name;
    const managerType=realCage?'cages':'locations',managerId=realCage?id:positionId;
    const managerControl=hooks.readOnly||!managerId?`<span class="sheet-manager" title="Manager">${esc(cageManagerShortName(managers,manager))}</span>`:input(managerType,managerId,'manager','Manager for '+item.positionName,{fallback:manager||'',managerSelect:true,choices:buildCageManagerChoices(managers,manager)});
    const lux=observations.intensityLux;
    const schedule=item.applicableLights.map(e=>`${e.protocol||'?'} · ${lightClock(e).label}`).join(' / ');
    const summary=[managerControl,started?`<time datetime="${esc(started)}" title="Started ${esc(started)}${elapsed!==null?' · '+elapsed+' weeks':''}">${esc(started)}${elapsed!==null?` · ${elapsed}wk`:''}</time>`:'',lux!==null&&lux!==undefined?`<span title="Light intensity">${esc(lux)} lux</span>`:''].filter(Boolean).join('');
    const positionOptions=[['','Unassigned'],...(dataset.tables.locations||[]).filter(p=>active(p)&&p.source_current!==false).map(p=>[String(p.location_id),`${(dataset.tables.rooms||[]).find(r=>r.room_id===p.room_id)?.name||p.room_id||''} / ${(dataset.tables.racks||[]).find(r=>r.rack_id===p.rack_id)?.name||p.rack_id||''} / ${p.label||p.location_id}`])];
    if(item.withdrawnPosition)positionOptions.push([String(item.withdrawnPosition.location_id),`${item.withdrawnPosition.label||item.withdrawnPosition.location_id} (withdrawn)`,true]);
    return `<div class="sheet-slot-frame${selected?' sheet-move-origin':''}" data-sheet-slot-frame="${esc(positionId||'')}" data-sheet-slot-label="${esc(item.positionName)}"><div class="sheet-slot-outline" aria-hidden="true"><span>${esc(item.positionName)}</span></div><article class="sheet-cage${compact?' sheet-compact':''}${realCage?'':' sheet-source'}${selected?' sheet-selected':''}" data-cage="${esc(id)}"${realCage&&registeredCage(id)?` data-sheet-mouse-destination="${esc(id)}"`:""} data-sheet-slot="${esc(positionId||'')}" tabindex="0" aria-label="${esc(item.positionName)}${cage?' cage '+esc(id):' position'}"><header${movableCage?` draggable="true"${dragAttrs} class="sheet-cage-drag-region"`:""} title="${esc(moveStatus.reason)}"><div class="sheet-cage-heading">${movableCage?`<button type="button" class="text-button sheet-cage-handle" draggable="true"${dragAttrs}${positionId?` data-sheet-move-slot="${esc(positionId)}"`:""}${realCage?` data-sheet-move="${esc(id)}"`:""} aria-label="Move cage ${esc(item.positionName)}" title="Drag cage or choose a destination">⠿</button>`:""}<strong>${esc(item.positionName)}</strong>${printButton}</div><div class="sheet-cage-summary">${summary}</div></header>
      ${compact?'<details class="sheet-edit-details"><summary>Cage details</summary>':''}<div class="sheet-cage-meta">${!hooks.readOnly&&!cage&&positionId?`<label class="sheet-wide">Link cage<select data-sheet-link="${esc(positionId)}" aria-label="Link cage to ${esc(item.positionName)}"${canEdit('cages')?'':' disabled'}><option value="">Choose a registered cage…</option>${cageChoices.map(c=>`<option value="${esc(c.cage_sid)}"${val('cages',c.cage_sid,'location_id')===positionId?' selected':''}>${esc(c.cage_tag||c.cage_sid)} · SID ${esc(c.cage_sid)}</option>`).join('')}</select></label>`:''}${realCage?`<label>Cage${input('cages',id,'cage_tag','Cage tag '+id)}</label><label class="sheet-wide">Position${input('cages',id,'location_id','Cage position '+id,{choices:positionOptions})}</label><label>Type${input('cages',id,'cage_type','Cage type '+id)}</label><label>IACUC${input('cages',id,'cage_protocol','Cage IACUC '+id)}</label>`:''}</div>${compact?'</details>':''}
      ${compact?compactAnimals(item):`<div class="table-scroll"><table class="sheet-mice"><thead><tr><th>Animal</th><th>Sex</th><th>Born</th><th>Genotype</th><th>Ear</th><th>User</th></tr></thead><tbody>${item.mice.map(m=>`<tr><td>${hooks.readOnly?`<span>SID ${esc(m.mouse_sid)}</span>`:`<button type="button" class="text-button" data-sheet-open-mouse="${esc(m.mouse_sid)}">${esc(m.mouse_sid)} ↗</button>`}${input('mice',m.mouse_sid,'physical_tag','Animal tag '+m.mouse_sid)}</td><td>${input('mice',m.mouse_sid,'sex','Sex '+m.mouse_sid,{choices:[['Unknown','?'],['Male','♂'],['Female','♀']]})}</td><td>${input('mice',m.mouse_sid,'date_of_birth','Birth date '+m.mouse_sid,{type:'date'})}</td><td>${input('mice',m.mouse_sid,'genotype','Genotype '+m.mouse_sid)}</td><td>${input('mice',m.mouse_sid,'ear_mark','Ear mark '+m.mouse_sid,{placeholder:'L0R1'})}</td><td>${input('mice',m.mouse_sid,'manager','Mouse manager '+m.mouse_sid,{fallback:mouseManager(m).name||''})}</td></tr>`).join('')||`<tr><td colspan="6" class="sheet-empty">${sourceAnimals.length?esc(sourceAnimals.join(' · ')):(hooks.readOnly?'No animal assignments recorded':'No current mouse assignments')}${sourceAnimals.length?'<span class="small muted">Mouse links need review.</span>':''}</td></tr>`}</tbody></table></div>`}
      <div class="sheet-light"><span>${esc(schedule||'Light schedule not recorded')}</span>${!hooks.readOnly?`<button type="button" class="text-button" data-sheet-locobox="${esc(id)}" data-sheet-position="${esc(positionId||'')}">◷ Entrainment / treatment</button>`:''}</div>
      ${compact?'<details class="sheet-edit-details"><summary>Notes</summary>':''}${realCage?input('cages',id,'comment','Cage notes '+id,{multiline:true}):positionId?input('locations',positionId,'notes','Position notes '+positionId,{multiline:true}):''}${compact?'</details>':''}
      ${!cage&&position?.source_block_text?`<details class="sheet-source-details"><summary>Animal Sheet source</summary><pre>${esc(position.source_block_text)}</pre></details>`:''}
      ${item.warnings.length?`<details class="sheet-source-details"><summary>Review ${item.warnings.length} ${item.warnings.length===1?'note':'notes'}</summary>${item.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}
      <footer>${movableCage?`<button type="button" class="text-button" ${positionId?`data-sheet-move-slot="${esc(positionId)}"`:""}${realCage?` data-sheet-move="${esc(id)}"`:""} title="Select cage to move or swap">↔ Move</button>${realCage?`<button type="button" class="text-button" data-sheet-remove="${esc(id)}" title="Remove cage from rack; keep animal records">− Remove</button>`:""}`:canEdit('cages')&&occupied?`<button type="button" class="text-button" disabled title="${esc(moveStatus.reason)}">↔ Move</button>`:canEdit('cages')&&!realCage&&positionId?`<button type="button" class="text-button" data-sheet-new="${esc(positionId)}">＋ New cage</button>`:''}${(state.selectedCage||state.selectedSlot)&&positionId&&!selected?`<button type="button" class="text-button" data-sheet-destination="${esc(positionId)}">${occupied?'⇄ Swap here':'↳ Move here'}</button>`:''}${cage&&!hooks.readOnly?`<button type="button" class="text-button" data-sheet-open-cage="${esc(id)}">Animals ↗</button>`:''}</footer></article></div>`;
  }
  function compactAnimals(item){
    const rows=cageRows(item);
    return `<div class="sheet-compact-animals">${rows.map((row,index)=>{
      const key=JSON.stringify([item.locationId||item.cageId||'unassigned',row.key||row.mouseSid||row.tag,index]),mouseSid=row.mouseSid?String(row.mouseSid):null;
      const mouse=mouseSid?record(viewDataset,'mice',mouseSid):null;
      const sourceCageSid=mouse?.cage_sid??null;
      const sourcePosition=item.position,sourceMatch=row.matchStatus==='matched'?{locationId:row.locationId,tag:row.sourceTag||row.tag,sourceCell:row.sourceCell}:null;
      let draggable=false;
      if(mouse&&canMoveMice()&&active(mouse)&&mouse.state==='Stock'&&!mouse.history_read_only&&!mouse.source_historical&&['matched','registered'].includes(row.matchStatus)){
        if(sourceMatch&&sourcePosition&&active(sourcePosition)&&sourcePosition.source_current!==false&&!sourcePosition.history_read_only&&!sourcePosition.source_historical)draggable=true;
        else if(item.cage&&!item.cage._derived&&String(item.cageId)===String(sourceCageSid)){try{planMouseMove(viewDataset,mouseSid,sourceCageSid,{sourceCageSid});draggable=true;}catch{}}
      }
      animalRows.set(key,{...row,mouseSid,sourceCageSid,sourceMatch,draggable});
      const weeks=ageWeeks(row.dateOfBirth,asOf),editable=mouseSid&&canEdit('mice'),note=String(row.note||'').trim(),color=note?noteColor(mouse?.note_color):'none';
      const noteEditable=editable&&active(mouse)&&!mouse.history_read_only&&!mouse.source_historical&&['matched','registered'].includes(row.matchStatus);
      const unavailable=hooks.readOnly?'Historical view':!mouseSid?(row.matchStatus==='ambiguous'?'Multiple mouse matches; editing unavailable.':'Mouse record not linked; editing unavailable.'):'';
      const attrs=`data-sheet-animal="${esc(key)}"`,openable=mouseSid&&active(mouse)&&!hooks.readOnly&&!mouse.history_read_only&&!mouse.source_historical&&['matched','registered'].includes(row.matchStatus);
      return `<div class="sheet-compact-mouse" data-sheet-animal-row="${esc(key)}"><div class="sheet-animal-line"><button type="button" class="sheet-animal-tag sheet-animal-badge" ${attrs}${openable?` data-sheet-open-mouse="${esc(mouseSid)}" aria-label="Open ${esc(row.tag||mouseSid)} in Mice"`:""}${draggable?` draggable="true" data-sheet-drag-mouse="${esc(key)}"`:""} title="${esc([note,unavailable].filter(Boolean).join(' · ')||'Open mouse details')}"${openable?'':' disabled'}>${esc(row.tag||mouseSid||'—')}</button><button type="button" class="sheet-note-light sheet-note-${color}" ${attrs} data-sheet-edit-animal="note" title="${esc(note||'No note')}" aria-label="${noteEditable?'Edit':'View'} note for ${esc(row.tag||mouseSid||'mouse')} · ${color==='none'?'light off':color}"><span aria-hidden="true"></span></button><button type="button" class="sheet-animal-ear text-button" ${attrs} data-sheet-edit-animal="ear" title="${esc(editable?'Edit left / right earmark':unavailable||row.earMark||'Ear mark not recorded')}"${editable?'':' disabled'}>${esc(row.earMark||'—')}</button><button type="button" class="sheet-animal-age text-button" ${attrs} data-sheet-edit-animal="dob" title="${esc(row.dateOfBirth?'DOB '+row.dateOfBirth:'DOB not recorded')}"${editable?'':' disabled'}>${weeks===null?'—':weeks+'wk'}</button></div><div class="sheet-animal-editor" data-sheet-inline-editor="${esc(key)}" hidden></div></div>`;
    }).join('')||`<div class="sheet-empty">${hooks.readOnly?'Occupancy unknown':'—'}</div>`}</div>`;
  }
  function editorNode(key){return [...(host.querySelectorAll?.('[data-sheet-inline-editor]')||[])].find(node=>node.dataset.sheetInlineEditor===key);}
  function updateDraftControls(){
    const syncButton=host.querySelector('#cage-sheet-sync');if(syncButton){syncButton.disabled=state.saving||importing||!state.drafts.size;syncButton.querySelector('span').textContent=state.saving?'Saving…':`Save to Mouse Data${state.drafts.size?' · '+state.drafts.size:''}`;}
    const discard=host.querySelector('#cage-sheet-discard');if(discard)discard.disabled=state.saving||importing||!state.drafts.size;
    const importButton=host.querySelector('#cage-sheet-import');if(importButton){importButton.disabled=state.saving||importing||!!state.drafts.size||!canImport();importButton.title=importTitle();}
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
    if(state.saving||(hooks.readOnly&&mode!=='note'))return;
    if(inlineEditor){if(inlineEditor.key===key&&inlineEditor.mode===mode){await finishInlineEditor();return;}const saved=await finishInlineEditor();if(saved||inlineEditor||state.saving)return;}
    const row=animalRows.get(key),node=editorNode(key);if(!row||!node)return;
    const mouse=row.mouseSid?record(viewDataset,'mice',row.mouseSid):null,editable=row.mouseSid&&canEdit('mice')&&active(mouse)&&!mouse.history_read_only&&!mouse.source_historical&&['matched','registered'].includes(row.matchStatus);
    if(!['note','ear','dob'].includes(mode)||(!editable&&mode!=='note'))return;
    inlineEditor={key,mode};
    const baseAttrs=`data-sheet-type="mice" data-sheet-id="${esc(row.mouseSid||'')}"`;
    let content='';
    if(mode==='note'){
      const note=state.drafts.has(draftKey('mice',row.mouseSid,'comment'))?val('mice',row.mouseSid,'comment'):row.note||'',color=noteColor(val('mice',row.mouseSid,'note_color'));
      content=editable?`<label class="sheet-note-editor-label">Note<textarea ${baseAttrs} data-sheet-field="comment" rows="3" aria-label="Note for ${esc(row.tag)}">${esc(note)}</textarea></label><label>Light<select ${baseAttrs} data-sheet-field="note_color" aria-label="Note light for ${esc(row.tag)}">${noteColors.map(value=>`<option value="${value}"${color===value?' selected':''}>${value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select></label>`:`<p class="sheet-readonly-note">${esc(note||'No note')}</p>`;
    }else if(mode==='ear'){
      const mark=String(state.drafts.has(draftKey('mice',row.mouseSid,'ear_mark'))?val('mice',row.mouseSid,'ear_mark'):row.earMark||''),parsed=mark.match(/^L(\d+)R(\d+)$/i);
      const pending=state.drafts.has(draftKey('mice',row.mouseSid,'ear_mark'));
      content=`${mark&&!parsed?`<p class="small">Current: ${esc(mark)}</p>`:''}<div class="sheet-ear-dials"><label>L<input type="number" inputmode="numeric" min="0" max="99" step="1" data-sheet-ear-side="L" data-sheet-ear-id="${esc(row.mouseSid)}" aria-label="Left ear holes for ${esc(row.tag)}" value="${parsed?esc(parsed[1]):''}"${pending?' class="sheet-pending"':''}></label><label>R<input type="number" inputmode="numeric" min="0" max="99" step="1" data-sheet-ear-side="R" data-sheet-ear-id="${esc(row.mouseSid)}" aria-label="Right ear holes for ${esc(row.tag)}" value="${parsed?esc(parsed[2]):''}"${pending?' class="sheet-pending"':''}></label></div>`;
    }else content=`<label>DOB<input ${baseAttrs} data-sheet-field="date_of_birth" type="date" max="${esc(todayTaipei())}" aria-label="Date of birth for ${esc(row.tag)}" value="${esc(state.drafts.has(draftKey('mice',row.mouseSid,'date_of_birth'))?val('mice',row.mouseSid,'date_of_birth'):row.dateOfBirth||'')}"></label>`;
    node.innerHTML=content+'<button type="button" class="text-button sheet-editor-done" data-sheet-editor-done="true">Done</button>';node.hidden=false;
    node.querySelector?.('textarea,input,select,button')?.focus?.();
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
    for(const [key,draft] of state.drafts)if(draft.sourceFill===true&&!draft.wholeCageFill&&!state.drafts.has(draftKey('mice',draft.id,'cage_sid')))state.drafts.delete(key);
    pruneCreatedCages();state.selectedCage=null;state.selectedSlot=null;state.error=false;state.message=plan.summary+' Pending changes.';paint();
  }
  function pruneCreatedCages(){const view=preview();for(const [key,draft] of state.drafts){if(draft.type!=='cages'||draft.field!=='$create')continue;if(!(view.tables.mice||[]).some(m=>active(m)&&m.state==='Stock'&&String(m.cage_sid)===String(draft.id)))for(const [otherKey,other] of state.drafts)if(other.type==='cages'&&String(other.id)===String(draft.id))state.drafts.delete(otherKey);}}
  function move(destination,cageSid=state.selectedCage,options={}){try{if(!canMoveCage(cageSid))throw new Error('Assign the remaining animals before moving this whole cage.');if(!canEdit('cages'))throw new Error('Housing edit permission is required.');stage(planCageMove(viewDataset,cageSid,destination,options));}catch(error){state.message=error.message;state.error=true;paint();}}
  function moveSlot(destination,source=state.selectedSlot){try{stage(slotPlan(source,destination));}catch(error){state.message=error.message;state.error=true;paint();}}
  function mousePlan(destination,selection,positionId=null){
    if(!canMoveMice())throw new Error('Mouse and housing edit permission is required to move mice.');
    const options={sourceCageSid:selection.sourceCageSid,...(selection.sourceMatch?{sourceMatch:selection.sourceMatch}:{})};
    if(destination)return planMouseMove(viewDataset,selection.mouseSid,destination,options);
    if(!canEdit('cages'))throw new Error('Cage edit permission is required to use this position.');
    if(!state.newCageIds.has(positionId))state.newCageIds.set(positionId,'CAGE-'+crypto.randomUUID());
    return planMouseMoveToPosition(viewDataset,selection.mouseSid,positionId,{...options,cageSid:state.newCageIds.get(positionId)});
  }
  function moveMouse(destination,selection,positionId=null){
    try{
      if(!canMoveMice()||!selection)throw new Error('Mouse and housing edit permission is required to move mice.');
      const plan=mousePlan(destination,selection,positionId);
      if(selection.sourceMatch)for(const change of plan.changes)if(change.type==='mice')change.sourceMatch=selection.sourceMatch;
      stage(plan);
    }catch(error){state.message=error.message;state.error=true;paint();}
  }
  function paint(){
    inlineEditor=null;dragPlans.clear();animalRows.clear();movableSlots.clear();cageRowsCache.clear();viewDataset=preview();projection=projectAnimalSheet(viewDataset,{entityTypes:[],...captureOptions});
    const query=state.search.toLowerCase().trim();
    const groups=projection.groups.filter(g=>(!state.room||g.roomId===state.room)&&(!state.rack||g.rackId===state.rack)).map(g=>({...g,items:g.items.filter(item=>!query||JSON.stringify([g.roomName,g.rackName,item.positionName,item.cage,item.mice,item.position]).toLowerCase().includes(query))})).filter(g=>g.items.length);
    host.innerHTML=`<style>${styles}</style><section class="cage-sheet${hooks.readOnly?' sheet-historical':''}" aria-label="Animal Sheet cage view"><div class="toolbar sheet-toolbar"><input id="cage-sheet-search" type="search" class="search" aria-label="Find cages or animals" placeholder="Find cage, animal, genotype, manager…" value="${esc(state.search)}"><div class="filters">${select('cage-sheet-room','All rooms',rooms,state.room)}${select('cage-sheet-rack','All racks',racks,state.rack)}</div>${!hooks.readOnly?`<div class="sheet-transfer-actions"><button id="cage-sheet-sync" type="button" class="button primary"${state.saving||importing||!state.drafts.size?' disabled':''} title="Cage edits → Mouse Data"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg><span>${state.saving?'Saving…':`Save to Mouse Data${state.drafts.size?' · '+state.drafts.size:''}`}</span></button>${canImport()?`<button id="cage-sheet-import" type="button" class="button secondary"${state.saving||importing||state.drafts.size?' disabled':''} title="${esc(importTitle())}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg><span>${importing?'Opening…':'Import from Animal sheet'}</span></button>`:''}</div><button type="button" class="button secondary" id="cage-sheet-discard"${!state.drafts.size||state.saving||importing?' disabled':''}>Discard</button>`:''}${managersError?'<button type="button" class="text-button" id="cage-sheet-managers-retry">Reload manager list</button>':''}<button type="button" class="text-button" id="cage-sheet-help">Help</button></div>${state.selectedCage||state.selectedSlot?`<div class="sheet-move-notice">Moving cage ${esc(state.selectedSlot?record(viewDataset,'locations',state.selectedSlot)?.label||state.selectedSlot:state.selectedCage)} · choose a destination in any room. <button type="button" class="text-button" id="cage-sheet-cancel-move">Cancel move</button></div>`:''}<p id="cage-sheet-status" class="${state.error?'alert error':'small muted'}" role="status">${esc(state.message|| (state.drafts.size?`${state.drafts.size} pending edits · not yet saved`:statusLabel))}</p>${groups.map(g=>{
      const content=rackHTML(g),title=`${g.roomName} / ${g.rackName}`;
      return g.roomId||g.rackId?`<section class="panel"><div class="panel-head"><h2>${esc(title)}</h2><span>${g.items.length} cages / positions</span></div>${content}</section>`:`<details class="panel"${query?' open':''}><summary class="panel-head">${esc(title)} · ${g.items.length}</summary>${content}</details>`;
    }).join('')||'<div class="empty">No cages match.</div>'}</section>`;
    if(host.querySelector('#cage-sheet-managers-retry'))host.querySelector('#cage-sheet-managers-retry').onclick=loadManagers;
    if(host.querySelector('#cage-sheet-sync'))host.querySelector('#cage-sheet-sync').onclick=sync;
    if(host.querySelector('#cage-sheet-import'))host.querySelector('#cage-sheet-import').onclick=importFromSheet;
    if(host.querySelector('#cage-sheet-cancel-move'))host.querySelector('#cage-sheet-cancel-move').onclick=()=>{state.selectedCage=null;state.selectedSlot=null;paint();};
    if(host.querySelector('#cage-sheet-discard'))host.querySelector('#cage-sheet-discard').onclick=async()=>{if(await hooks.confirm?.('Discard pending changes?')){state.drafts.clear();state.selectedCage=null;state.selectedSlot=null;state.newCageIds.clear();state.message='Changes discarded.';state.error=false;paint();}};
    host.querySelector('#cage-sheet-help').onclick=()=>hooks.help?.();
    host.querySelector('#cage-sheet-room').onchange=e=>{state.room=e.target.value;state.rack='';renderCageSheet(host,dataset,hooks);};
    host.querySelector('#cage-sheet-rack').onchange=e=>{state.rack=e.target.value;paint();};
    host.querySelector('#cage-sheet-search').oninput=e=>{state.search=e.target.value;const caret=e.target.selectionStart;clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>{paint();const input=host.querySelector('#cage-sheet-search');input.focus();input.setSelectionRange(caret,caret);},180);};
  }
  async function importFromSheet(){
    if(renderToken!==renderSequence||!canImport()||state.saving||importing||state.drafts.size)return;
    const token=state.context;
    if(String(hooks.currentContext?.()||accountContext)!==accountContext)return;
    importing=true;paint();
    try{await hooks.importFromSheet();}
    catch(error){if(state.context===token&&renderToken===renderSequence){state.message=error.message||'Import failed.';state.error=true;}}
    finally{importing=false;if(state.context===token&&renderToken===renderSequence)paint();}
  }
  async function sync(){
    if(state.saving||importing||!state.drafts.size)return;
    if(inlineEditor?.invalid){state.message=inlineEditor.invalid;state.error=true;updateDraftControls();return;}
    const pending=[...state.drafts.values()],token=state.context;state.saving=true;state.message='Saving…';state.error=false;paint();
    try{
      const fresh=await hooks.loadFresh();
      if(state.context!==token||String(hooks.currentContext?.()||accountContext)!==accountContext)throw new Error('Account or colony changed. Reload this sheet.');
      if(pending.some(change=>change.field==='manager'&&!change.positionManager&&['cages','locations'].includes(change.type))&&typeof hooks.loadManagers==='function'){
        const latest=await hooks.loadManagers();if(state.context!==token||renderToken!==renderSequence||String(hooks.currentContext?.()||accountContext)!==accountContext)throw new Error('Account or colony changed. Reload this sheet.');managers=Array.isArray(latest)?latest:latest?.managers||[];
        for(const change of pending.filter(change=>change.field==='manager'&&!change.positionManager&&['cages','locations'].includes(change.type)&&change.value))if(!buildCageManagerChoices(managers,'').some(([value,,disabled])=>!disabled&&value===change.value))throw new Error('Selected manager is no longer in the manager list. Choose again.');
      }
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
    if(linking){if(t.value&&canEdit('cages'))move(linking,t.value,{linkSourcePosition:true});return;}
    if(t.dataset.sheetEarSide){
      id=t.dataset.sheetEarId;type='mice';field='ear_mark';if(!canEdit(type))return;
      const node=inlineEditor&&editorNode(inlineEditor.key),left=node?.querySelector('[data-sheet-ear-side="L"]')?.value,right=node?.querySelector('[data-sheet-ear-side="R"]')?.value;
      if(!/^\d+$/.test(left??'')||!/^\d+$/.test(right??'')||Number(left)>99||Number(right)>99){if(inlineEditor)inlineEditor.invalid='Enter left and right hole counts from 0 to 99.';return;}
      value=`L${Number(left)}R${Number(right)}`;
    }
    if(!field||!canEdit(type)||(type==='cages'&&state.drafts.has(draftKey(type,id,'$create'))))return;
    if(type==='cages'&&field==='location_id'){move(t.value||null,id);return;}
    if(field==='manager'&&['cages','locations'].includes(type)){
      if(managersLoading||managersError)return;
      value=t.value.trim();
      if(value&&!buildCageManagerChoices(managers,'').some(([name,,disabled])=>!disabled&&name===value))return;
    }else value??=t.value.trim()||null;
    if(field==='note_color'&&!noteColors.includes(value)){state.message='Choose None, Green or Red for the note light.';if(inlineEditor)inlineEditor.invalid=state.message;state.error=true;updateDraftControls();return;}
    if(field==='date_of_birth'&&value&&value>todayTaipei()){state.message='DOB cannot be in the future.';if(inlineEditor)inlineEditor.invalid=state.message;state.error=true;updateDraftControls();return;}
    if(inlineEditor)inlineEditor.invalid=null;
    const key=draftKey(type,id,field),original=state.drafts.has(key)?state.drafts.get(key).base:record(dataset,type,id)?.[field];
    const row=inlineEditor?animalRows.get(inlineEditor.key):null,sourceMatch=row?.matchStatus==='matched'?{locationId:row.locationId,tag:row.sourceTag||row.tag,sourceCell:row.sourceCell}:null;
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
    if(event.target.closest('[data-sheet-open-mouse]')&&(drag||Date.now()<suppressMouseClickUntil)){event.preventDefault?.();return;}
    const editButton=event.target.closest('[data-sheet-edit-animal]');
    if(editButton)return openAnimalEditor(editButton.dataset.sheetAnimal,editButton.dataset.sheetEditAnimal);
    if(event.target.closest('[data-sheet-editor-done]')){await finishInlineEditor();if(!inlineEditor)paint();return;}
    if(inlineEditor){const node=editorNode(inlineEditor.key);if(node&&!node.contains(event.target)){const saved=await finishInlineEditor();if(saved||inlineEditor)return;}}
    const command=event.target.closest('[data-sheet-move],[data-sheet-move-slot],[data-sheet-remove],[data-sheet-destination],[data-sheet-new]');
    if(command){if(!canEdit('cages'))return;const d=command.dataset;if(d.sheetMoveSlot){try{verifySlotSource(d.sheetMoveSlot);state.selectedSlot=d.sheetMoveSlot;state.selectedCage=null;paint();}catch(error){state.message=error.message;state.error=true;paint();}}else if(d.sheetMove){if(!canMoveCage(d.sheetMove))return;state.selectedCage=d.sheetMove;state.selectedSlot=null;paint();}else if(d.sheetRemove){try{stage(planCageRemoval(viewDataset,d.sheetRemove));}catch(error){state.message=error.message;state.error=true;paint();}}else if(d.sheetDestination){if(state.selectedSlot)moveSlot(d.sheetDestination);else move(d.sheetDestination);}else if(d.sheetNew){if(state.drafts.size){state.message='Save or discard pending edits before creating a cage.';paint();}else hooks.newCage?.(d.sheetNew);}return;}
    if(!event.target.closest('button,input,select,textarea,a,summary,details,.sheet-animal-editor')&&!hooks.readOnly){const cage=event.target.closest('.sheet-cage');if(cage){if((state.selectedCage||state.selectedSlot)&&cage.dataset.sheetSlot){if(state.selectedSlot)moveSlot(cage.dataset.sheetSlot);else move(cage.dataset.sheetSlot);}else if(cage.dataset.sheetSlot){try{verifySlotSource(cage.dataset.sheetSlot);state.selectedSlot=cage.dataset.sheetSlot;state.selectedCage=null;paint();}catch(error){state.message=error.message;state.error=true;updateDraftControls();}}else if(canMoveCage(cage.dataset.cage)&&canEdit('cages')){state.selectedCage=cage.dataset.cage;state.selectedSlot=null;paint();}return;}}
    if(hooks.readOnly)return;
    const t=event.target.closest('[data-sheet-open-cage],[data-sheet-open-mouse],[data-sheet-label],[data-sheet-position-label],[data-sheet-locobox]');if(!t)return;
    if(t.hasAttribute('data-sheet-label')||t.hasAttribute('data-sheet-position-label')){
      if(state.drafts.size){state.message='Save or discard pending edits before printing.';state.error=false;paint();return;}
      if(t.hasAttribute('data-sheet-label'))hooks.printLabel?.(t.dataset.sheetLabel);else hooks.printPositionLabel?.(t.dataset.sheetPositionLabel);
    }else if(t.hasAttribute('data-sheet-open-cage'))hooks.openCage?.(t.dataset.sheetOpenCage);else if(t.hasAttribute('data-sheet-open-mouse')){
      if(state.saving||importing)return;
      const mouse=record(viewDataset,'mice',t.dataset.sheetOpenMouse),row=t.dataset.sheetAnimal?animalRows.get(t.dataset.sheetAnimal):null;
      if(!active(mouse)||mouse.history_read_only||mouse.source_historical||(t.dataset.sheetAnimal&&(!row||row.mouseSid!==String(mouse.mouse_sid)||!['matched','registered'].includes(row.matchStatus))))return;
      if(state.drafts.size){state.message='Save or discard pending edits before opening the mouse.';state.error=false;updateDraftControls();return;}
      hooks.openMouse?.(String(mouse.mouse_sid));
    }else hooks.openLocobox?.(t.dataset.sheetLocobox||null,t.dataset.sheetPosition||null);};
  function clearDragHighlight(){for(const node of host.querySelectorAll?.('.sheet-drop-target,.sheet-slot-destination')||[]){node.classList.remove('sheet-drop-target','sheet-slot-destination');if(node.dataset)delete node.dataset.sheetDropCue;}}
  function clearDragOrigin(){for(const node of host.querySelectorAll?.('.sheet-dragging,.sheet-drag-origin')||[])node.classList.remove('sheet-dragging','sheet-drag-origin');}
  function dropPlan(target,selection=drag){
    if(!selection||hooks.readOnly||state.saving)return null;
    const cage=target.closest('.sheet-cage');if(!cage)return null;
    if(selection.kind==='mouse'){
      if(!canMoveMice()||(!cage.dataset.sheetMouseDestination&&!cage.dataset.sheetSlot))return null;
      mousePlan(cage.dataset.sheetMouseDestination,selection.row,cage.dataset.sheetSlot);
      return {kind:'mouse',destination:cage.dataset.sheetMouseDestination,positionId:cage.dataset.sheetSlot,cage};
    }
    if(!canEdit('cages')||!cage.dataset.sheetSlot)return null;
    const key=JSON.stringify([selection.id,selection.positionId,cage.dataset.sheetSlot]);
    if(!dragPlans.has(key)){try{dragPlans.set(key,selection.positionId?slotPlan(selection.positionId,cage.dataset.sheetSlot):planCageMove(viewDataset,selection.id,cage.dataset.sheetSlot));}catch(error){dragPlans.set(key,{error});}}
    const plan=dragPlans.get(key);if(plan.error)throw plan.error;
    if(plan.kind==='noop')return null;
    return {kind:'cage',destination:cage.dataset.sheetSlot,cage,cue:plan.kind==='swap'?'Swap':'Move'};
  }
  host.ondragstart=event=>{
    drag=null;dragPlans.clear();clearDragOrigin();clearDragHighlight();
    const target=event.target.closest('[data-sheet-drag-mouse],[data-sheet-drag-slot],[data-sheet-drag-cage]');
    const control=event.target.closest('button,input,select,textarea,a,summary,details,.sheet-animal-editor');
    if(!target||hooks.readOnly||state.saving||inlineEditor?.invalid||(control&&!control.dataset?.sheetDragMouse&&!control.dataset?.sheetDragCage&&!control.dataset?.sheetDragSlot)){event.preventDefault();return;}
    if(target.dataset.sheetDragMouse){const row=animalRows.get(target.dataset.sheetDragMouse);if(!row?.draggable||!canMoveMice()){event.preventDefault();return;}drag={kind:'mouse',row:{...row}};}
    else if(target.dataset.sheetDragSlot){try{verifySlotSource(target.dataset.sheetDragSlot);drag={kind:'cage',positionId:target.dataset.sheetDragSlot};}catch(error){state.message=error.message;state.error=true;updateDraftControls();}}
    else if(canMoveCage(target.dataset.sheetDragCage)&&canEdit('cages'))drag={kind:'cage',id:target.dataset.sheetDragCage};
    if(!drag){event.preventDefault();return;}
    suppressMouseClickUntil=Date.now()+400;finishInlineEditor();
    const cage=event.target.closest('.sheet-cage'),frame=event.target.closest('.sheet-slot-frame');
    if(drag.kind==='cage'){cage?.classList?.add('sheet-dragging');frame?.classList?.add('sheet-drag-origin');}
    if(event.dataTransfer){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-braintime-cage-move',drag.kind);if(drag.kind==='cage'&&cage&&event.dataTransfer.setDragImage)event.dataTransfer.setDragImage(cage,Math.min((cage.getBoundingClientRect?.().width||160)/2,80),20);}
  };
  host.ondragover=event=>{
    clearDragHighlight();try{const plan=dropPlan(event.target);if(!plan)return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';plan.cage.classList?.add('sheet-drop-target');if(plan.kind==='cage'){const frame=event.target.closest('.sheet-slot-frame');frame?.classList?.add('sheet-slot-destination');if(frame?.dataset)frame.dataset.sheetDropCue=plan.cue;}}catch{}
  };
  host.ondragleave=event=>{if(!host.contains?.(event.relatedTarget))clearDragHighlight();};
  host.ondrop=event=>{
    const selection=drag;if(selection)suppressMouseClickUntil=Date.now()+400;drag=null;clearDragHighlight();clearDragOrigin();
    try{const plan=dropPlan(event.target,selection);if(!plan)return;event.preventDefault();if(plan.kind==='mouse')moveMouse(plan.destination,selection.row,plan.positionId);else if(selection.positionId)moveSlot(plan.destination,selection.positionId);else move(plan.destination,selection.id);}catch(error){state.message=error.message;state.error=true;paint();}
  };
  host.ondragend=()=>{suppressMouseClickUntil=Date.now()+400;drag=null;dragPlans.clear();clearDragHighlight();clearDragOrigin();};
  host.onkeydown=event=>{if(['Enter',' '].includes(event.key)&&event.target.matches('.sheet-cage')){event.preventDefault();event.target.click();}};
  async function loadManagers(){
    if(typeof hooks.loadManagers!=='function')return;
    managersLoading=true;managersError=false;paint();
    try{const result=await hooks.loadManagers();if(renderToken!==renderSequence||state.context!==context)return;managers=Array.isArray(result)?result:result?.managers||[];}
    catch{if(renderToken!==renderSequence||state.context!==context)return;managers=[];managersError=true;}
    finally{if(renderToken===renderSequence&&state.context===context){managersLoading=false;paint();}}
  }
  paint();
  if(typeof hooks.loadManagers==='function'&&!hooks.readOnly)void loadManagers();
}

export function cageSheetHelpHTML(){return '<p>Drag a verified mouse tag to a cage, or drag a cage header to move or swap positions. The faint outline and number mark the fixed rack slot. Choose <strong>Move</strong> on a cage to select its destination without dragging.</p><p>Click a mouse badge to open its Mice record and edit the tag or other details. Click the note light to read or edit a note and choose None, Green or Red. Click an earmark or age to edit ear holes or DOB. All edits wait for <strong>Save to Mouse Data</strong>; <strong>Discard</strong> cancels them. <strong>Import from Animal sheet</strong> brings sheet updates into Mouse Data. Uncertain and historical animals cannot be moved. An unlinked destination creates a cage when saved.</p><p><strong>Print label</strong> opens the three card formats. Original Animal Sheet observations are preserved.</p>';}

const styles=`.sheet-slot-frame{position:relative;min-width:0;height:100%}.sheet-slot-outline{position:absolute;inset:0;border:2px dashed #91a0ac;border-radius:6px;background:#f5f6f1d9;display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;z-index:1;color:#697985;font-size:32px;font-weight:700}.sheet-drag-origin>.sheet-slot-outline,.sheet-slot-destination>.sheet-slot-outline,.sheet-move-origin>.sheet-slot-outline{opacity:1}.sheet-move-origin>.sheet-slot-outline{background:#f5f6f19c}.sheet-move-origin>.sheet-cage>header,.sheet-move-origin>.sheet-cage>footer,.sheet-move-origin .sheet-animal-editor{position:relative;z-index:2}.sheet-drag-origin>.sheet-cage{opacity:.15}.sheet-slot-destination>.sheet-slot-outline{border-color:#286ca6;background:#eef6fcbd}.sheet-slot-destination:after{content:attr(data-sheet-drop-cue);position:absolute;right:8px;top:8px;z-index:2;border-radius:4px;background:#286ca6;color:#fff;padding:3px 7px;font-size:11px}.sheet-cage-drag-region{cursor:grab}.sheet-cage-drag-region:active{cursor:grabbing}.sheet-cage-drag-region button,.sheet-cage-drag-region select,.sheet-cage-drag-region input{cursor:pointer}.sheet-cage .sheet-manager-select{width:auto;max-width:100%;flex:0 1 auto;min-width:50px;font-size:11px;font-weight:600;border:1px solid #a9b5bf;background:#fff;padding:2px 4px;min-height:28px}.sheet-compact .sheet-manager-select{font-size:10px;max-width:125px}@media(pointer:coarse){.sheet-cage .sheet-manager-select{min-height:36px}}.sheet-cage-handle{cursor:grab;flex-shrink:0;font-size:16px!important}.sheet-cage-handle:active,[data-sheet-drag-mouse]:active{cursor:grabbing}[data-sheet-drag-mouse]{cursor:grab}.sheet-cage-heading>strong{margin-right:auto}.sheet-drop-target{outline:3px solid #286ca6;outline-offset:-3px;background:#eef6fc}.sheet-dragging{opacity:.6}.sheet-compact .sheet-cage-summary{font-size:10px;gap:3px 6px;justify-content:flex-start}.sheet-cage-summary time{font-size:9px;white-space:nowrap}.sheet-manager{font-weight:600}.sheet-compact .sheet-animal-line{display:grid;grid-template-columns:minmax(0,1fr) 20px auto auto;gap:3px;align-items:center}.sheet-compact .sheet-animal-line>button{font-size:10px;line-height:1.35;padding:3px 0;min-height:24px}.sheet-compact .sheet-note-light{display:flex;align-items:center;justify-content:center;width:20px;min-width:20px;border:0;background:transparent;border-radius:4px;cursor:pointer}.sheet-note-light span{display:block;width:10px;height:10px;border:1px solid #7d8790;border-radius:50%;background:#fff}.sheet-note-green span{border-color:#256b3f;background:#3d9859;box-shadow:0 0 3px #3d985955}.sheet-note-red span{border-color:#923535;background:#ce4545;box-shadow:0 0 3px #ce454555}.sheet-note-light:hover{background:#edf2f6}.sheet-note-light:focus-visible{outline:2px solid #216aa0;outline-offset:1px}@media(pointer:coarse){.sheet-compact .sheet-animal-line>button{min-height:32px}.sheet-compact .sheet-animal-line{grid-template-columns:minmax(0,1fr) 26px auto auto}.sheet-compact .sheet-note-light{width:26px;min-width:26px}}.sheet-animal-editor .sheet-note-editor-label{display:block}.sheet-note-editor-label textarea{display:block;resize:vertical;min-height:60px}.sheet-animal-editor select{background:#fff;border-color:#9db6c8;max-width:100px}.sheet-compact .sheet-animal-tag{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sheet-compact .sheet-animal-badge{display:block;width:100%;min-width:0;border:1px solid #bed0de;border-radius:4px;background:#eef5fa;color:#194f7a;padding:2px 4px;font:inherit;font-size:10px;font-weight:600;cursor:pointer}.sheet-compact .sheet-animal-badge:hover:not(:disabled){background:#dfeef8;border-color:#7199b7}.sheet-compact .sheet-animal-badge:focus-visible{outline:2px solid #216aa0;outline-offset:1px}.sheet-compact .sheet-animal-badge[draggable=true]{cursor:grab}.sheet-compact .sheet-animal-badge[draggable=true]:active{cursor:grabbing}.sheet-compact .sheet-animal-badge:disabled{background:#f5f5f2;border-color:#ddd;color:#555}.sheet-compact .sheet-animal-ear,.sheet-compact .sheet-animal-age{white-space:nowrap;color:#303b43}.sheet-animal-line>button:disabled{opacity:1;color:inherit;cursor:default}.sheet-animal-editor{border:1px solid #acc3d5;background:#f4f8fb;padding:6px;font-size:11px}.sheet-animal-editor[hidden]{display:none}.sheet-animal-editor p{margin:3px 0;white-space:pre-wrap;overflow-wrap:anywhere}.sheet-animal-editor label{display:flex;gap:5px;align-items:center}.sheet-animal-editor textarea,.sheet-animal-editor input{background:#fff;border-color:#9db6c8}.sheet-animal-editor .sheet-editor-done{display:block;margin:3px 0 0 auto}.sheet-ear-dials{display:flex;gap:10px}.sheet-ear-dials label{flex:1}.sheet-ear-dials input{width:58px}.sheet-animal-editor input[type=date]{max-width:145px}.sheet-animal-editor .text-button{font-size:11px}.sheet-physical-scroll{overflow-x:auto;padding:8px}.sheet-physical-rack{display:grid;gap:6px;align-items:stretch}.sheet-physical-slot{min-width:0}.sheet-unregistered{background:repeating-linear-gradient(45deg,#fafafa,#fafafa 4px,#f4f4f4 4px,#f4f4f4 8px);min-height:60px}.sheet-compact>header{padding:5px;font-size:11px;gap:4px}.sheet-compact>header .text-button{font-size:10px}.sheet-compact .sheet-cage-summary>span{font-size:9px}.sheet-compact-animals{padding:3px}.sheet-compact-mouse{border-bottom:1px solid #d8e0e6;padding:2px 0}.sheet-animal-line{display:flex;min-width:0;align-items:center}.sheet-animal-line select{max-width:37px}.sheet-animal-line .text-button{padding:0 3px}.sheet-compact input,.sheet-compact select{font-size:11px;padding:3px}.sheet-compact-mouse details{font-size:9px;padding:1px 3px}.sheet-compact-mouse details summary{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sheet-compact-mouse details label{display:flex;align-items:center}.sheet-edit-details{font-size:10px;padding:3px 6px}.sheet-compact .sheet-light{font-size:9px;padding:4px;display:block}.sheet-compact .sheet-light .text-button{font-size:9px;padding:2px;display:block}.sheet-compact .sheet-empty{font-size:11px;padding:7px!important}.sheet-compact footer{flex-wrap:wrap;gap:4px}.sheet-compact footer button{font-size:9px!important}.sheet-selected{outline:3px solid #286ca6;outline-offset:0}.sheet-move-notice{position:sticky;top:65px;z-index:3;background:#e1effa;border:1px solid #286ca6;border-radius:5px;padding:10px;margin:6px 0}.sheet-cage[tabindex]:focus{outline:2px solid #286ca6}.sheet-cage{cursor:default}.sheet-cage:has(input:focus){cursor:auto}.sheet-toolbar{position:sticky;top:0;background:var(--bg,#fff);z-index:3;padding:10px 0}.sheet-transfer-actions{display:flex;align-items:center;gap:10px;flex:0 1 auto;width:max-content;max-width:100%;flex-wrap:wrap}.sheet-transfer-actions>.button{flex:0 0 auto}.sheet-toolbar svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;vertical-align:middle}.sheet-rack{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px}.sheet-cage{border:1px solid #a9b5bf;border-radius:6px;overflow:hidden;background:#fff;color:#111;min-width:0}.sheet-cage>header{display:flex;gap:10px;align-items:center;justify-content:space-between;background:#e7f0f7;padding:9px 10px;border-bottom:1px solid #a9b5bf;flex-wrap:wrap}.sheet-compact>header{padding:5px;gap:4px}.sheet-source>header{background:#f5f2e9}.sheet-cage-heading,.sheet-cage-summary{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;min-width:0}.sheet-cage-heading>strong{overflow-wrap:anywhere}.sheet-cage-summary{flex-wrap:wrap}.sheet-cage .sheet-print-label{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex-shrink:0;min-height:32px;padding:5px 7px;border:1px solid #7d9bb2;border-radius:5px;background:#fff;color:#194f7a;font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}.sheet-cage .sheet-print-label:hover{background:#f2f7fb}.sheet-cage .sheet-print-label:focus-visible{outline:2px solid #216aa0;outline-offset:2px}.sheet-print-label svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.sheet-compact .sheet-print-label{font-size:10px;gap:4px;padding:4px 6px}@media(pointer:coarse){.sheet-cage .sheet-print-label{min-height:44px;min-width:44px}}.sheet-cage-meta{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:7px}.sheet-cage-meta label{display:flex;gap:5px;align-items:center;font-size:11px;font-weight:600}.sheet-wide{grid-column:1/-1}.sheet-cage input,.sheet-cage select,.sheet-cage textarea{min-width:0;width:100%;font:inherit;font-size:12px;border:1px solid transparent;border-radius:2px;padding:5px;background:transparent;color:#111}.sheet-cage input:hover,.sheet-cage select:hover,.sheet-cage textarea:hover{border-color:#a9b5bf}.sheet-cage input:focus,.sheet-cage select:focus,.sheet-cage textarea:focus{border-color:#216aa0;background:#fff;outline:2px solid #c9e2f4}.sheet-cage input:disabled,.sheet-cage select:disabled,.sheet-cage textarea:disabled{opacity:1;-webkit-text-fill-color:#111}.sheet-mice{width:100%;table-layout:fixed;font-size:12px}.sheet-mice th,.sheet-mice td{padding:3px;border:1px solid #ced7df;white-space:normal;vertical-align:top}.sheet-mice th{background:#f2f5f7}.sheet-mice th:first-child{width:19%}.sheet-mice th:nth-child(2){width:8%}.sheet-mice th:nth-child(3){width:22%}.sheet-mice th:nth-child(4){width:23%}.sheet-mice th:nth-child(5){width:12%}.sheet-mice td .text-button{font-size:10px;padding:0 4px}.sheet-pending{background:#fff2b5!important;box-shadow:inset 3px 0 #d2a100}.sheet-light{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:7px;font-size:11px;border-top:1px solid #ced7df}.sheet-light .text-button{font-size:11px}.sheet-cage>footer{display:flex;justify-content:space-between;padding:4px 8px;border-top:1px solid #ced7df}.sheet-cage>footer button{font-size:11px}.sheet-empty{text-align:center;padding:12px!important}.sheet-empty span{display:block}.sheet-source-details{padding:6px 9px;font-size:11px}.sheet-source-details pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto}.sheet-cage>textarea{border-top:1px solid #ced7df}.cage-view-menu{display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-bottom:10px}.cage-view-menu select{width:auto}@media(max-width:1100px){.sheet-rack{grid-template-columns:1fr}}@media(max-width:600px){.sheet-rack{padding:5px}.sheet-toolbar{position:static}.sheet-mice{min-width:560px}.sheet-light{align-items:flex-start;flex-direction:column}}`;
