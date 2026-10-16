/* Pure physical cage movements. SIDs and source observations never change. */
import {cageSheetAnimals, cageObservations} from './cage-observations.js?v=70';
const present=v=>v!==null&&v!==undefined&&v!=='';
const active=r=>r&&!r.app_archived_at&&!r.archived;
const textId=(v,label)=>{if(typeof v!=='string'||!v||v.trim()!==v)throw new Error(`Choose a valid ${label}.`);return v;};
function index(rows,key){const result=new Map();for(const row of rows||[]){const id=row?.[key];if(!present(id))continue;if(result.has(String(id)))throw new Error(`Duplicate ${key} ${id}; review the database before moving cages.`);result.set(String(id),row);}return result;}
function context(dataset){
 const tables=dataset?.tables||{},cages=index(tables.cages,'cage_sid'),locations=index(tables.locations,'location_id'),rooms=index(tables.rooms,'room_id'),racks=index(tables.racks,'rack_id');
 const currentResidents=new Set((tables.mice||[]).filter(m=>active(m)&&m.state==='Stock'&&present(m.cage_sid)).map(m=>String(m.cage_sid)));
 const current=c=>active(c)&&(!/^(Ended|Inactive)$/i.test(c.state||'')||currentResidents.has(String(c.cage_sid)));
 const occupants=id=>[...cages.values()].filter(c=>current(c)&&String(c.location_id||'')===id);
 function cage(id){const value=cages.get(id);if(!value||!active(value)||value._derived)throw new Error(`Cage ${id} is missing, archived or not registered.`);if(/^(Ended|Inactive)$/i.test(value.state||''))throw new Error(`Cage ${id} is ${value.state.toLowerCase()}; review its current status before moving it.`);return value;}
 function location(id,{destination=false}={}){
  const value=locations.get(id);if(!active(value))throw new Error(`Position ${id} is missing or archived.`);
  if(destination&&value.source_current===false)throw new Error(`Position ${value.label||id} has been withdrawn. Choose a current position.`);
  const room=rooms.get(String(value.room_id||'')),rack=racks.get(String(value.rack_id||''));
  if(!active(room)||!active(rack)||String(rack.room_id||'')!==String(room.room_id))throw new Error(`Position ${id} needs an active room and a rack in that room.`);
  if(typeof value.label!=='string'||!value.label.trim())throw new Error(`Position ${id} needs a label before it can name a cage.`);
  return value;
 }
 function oldPosition(value){
  if(!present(value.location_id))return null;
  const id=String(value.location_id),position=location(id);
  for(const field of ['room_id','rack_id'])if(present(value[field])&&String(value[field])!==String(position[field]))throw new Error(`Cage ${value.cage_sid} has inconsistent ${field.replace('_',' ')} and position references. Review them before moving it.`);
  const current=occupants(id);if(current.length!==1||String(current[0].cage_sid)!==String(value.cage_sid))throw new Error(`Position ${position.label} has multiple current cage assignments. Resolve them before moving cages.`);
  return position;
 }
 return {cage,location,oldPosition,occupants};
}
const cell=(cage,field,value)=>({type:'cages',id:String(cage.cage_sid),field,base:cage[field]??null,value});
const movement=(cage,position)=>[cell(cage,'location_id',position?.location_id??null),...(position?[cell(cage,'cage_tag',position.label)]:[])].filter(c=>(c.base??null)!==(c.value??null));
// An explicit source-card assignment, including Unassigned, can become the
// cage's assignment when that card is linked or registered. Source names alone
// never establish a new assignment, and ordinary moves do not adopt slot staff.
const positionManager=position=>Object.hasOwn(position,'manager')&&typeof position.manager==='string'?{manager:position.manager}:{};
function positionWithManagerDraft(position,drafts){
 const edits=drafts.filter(c=>c.type==='locations'&&c.id===position?.location_id&&c.field==='manager');
 if(!edits.length)return position;
 const [edit]=edits;
 if(edits.length!==1||!active(position)||typeof edit.value!=='string'||!same(position.manager,edit.base)&&!same(position.manager,edit.value))throw new Error('Changed by another editor: the source position manager changed. Review the draft before saving.');
 return {...position,manager:edit.value};
}

/** Plans explicit slot changes; applyCageSheetDrafts supplies fresh-data conflict and permission checks. */
export function planCageMove(dataset,cageSid,destinationLocationId,options={}){
 const ctx=context(dataset),id=textId(cageSid,'cage SID'),cage=ctx.cage(id),source=ctx.oldPosition(cage);
 const destination=destinationLocationId===null||destinationLocationId===undefined||destinationLocationId===''?null:ctx.location(textId(destinationLocationId,'destination position'),{destination:true});
 const common={cage_sid:id,source_location_id:source?.location_id??null,destination_location_id:destination?.location_id??null,other_cage_sid:null,warnings:[]};
 if((source?.location_id??null)===(destination?.location_id??null))return {...common,kind:'noop',changes:[],summary:destination?`Cage ${id} is already at ${destination.label}.`:`Cage ${id} is already off the rack.`};
 if(!destination)return {...common,kind:'remove',changes:movement(cage,null),summary:`Remove cage ${id} from ${source.label}. Keep its tag and all animal records.`};
 const occupied=ctx.occupants(String(destination.location_id));
 if(occupied.length>1)throw new Error(`Position ${destination.label} has multiple current cage assignments. Resolve them before moving cages.`);
 if(!occupied.length){
  const changes=movement(cage,destination),assignment=positionManager(destination);
  if(options.linkSourcePosition===true&&!Object.hasOwn(cage,'manager')&&Object.hasOwn(assignment,'manager'))changes.push({...cell(cage,'manager',assignment.manager),positionManager:{locationId:destination.location_id}});
  return {...common,kind:'move',changes,summary:`Move cage ${id} from ${source?.label||'off rack'} to ${destination.label}. Its tag becomes ${destination.label}.`};
 }
 if(!source)throw new Error(`Position ${destination.label} is occupied. Choose an empty position for a cage that is off the rack.`);
 ctx.location(String(source.location_id),{destination:true});
 const other=ctx.cage(String(occupied[0].cage_sid));ctx.oldPosition(other);
 return {...common,kind:'swap',other_cage_sid:String(other.cage_sid),changes:[...movement(cage,destination),...movement(other,source)],summary:`Swap cage ${id} (${source.label}) with cage ${other.cage_sid} (${destination.label}). Cage SIDs and animal identities stay the same.`};
}
export function planCageRemoval(dataset,cageSid,options={}){return planCageMove(dataset,cageSid,null,options);}

/** Recheck affected slots against freshly loaded data before applying cell drafts. */
export function validateCageMovementOccupancy(dataset,changes){
 const drafts=Array.from(changes||[]);
 for(const change of drafts.filter(c=>c.positionManager)){
  const locationId=change.positionManager.locationId,position=positionWithManagerDraft((dataset.tables.locations||[]).find(p=>p.location_id===locationId),drafts),cage=(dataset.tables.cages||[]).find(c=>String(c.cage_sid)===String(change.id));
  if(change.type!=='cages'||change.field!=='manager'||change.base!==null||typeof change.value!=='string'||!active(position)||position.source_current===false||historical(position)||!Object.hasOwn(positionManager(position),'manager')||position.manager!==change.value||!cage||Object.hasOwn(cage,'manager')&&cage.manager!==change.value)throw new Error('The source position manager changed. Reload before linking its cage.');
 }
 const selected=drafts.filter(c=>c.type==='cages'&&c.field==='location_id'&&(c.value??null)!==(dataset?.tables?.cages||[]).find(r=>String(r.cage_sid)===String(c.id))?.location_id);
 if(!selected.length)return true;
 const ctx=context(dataset),destinations=new Set(),updates=new Map();
 for(const change of selected){const cage=ctx.cage(String(change.id));ctx.oldPosition(cage);if(present(change.value)){const position=ctx.location(textId(change.value,'destination position'),{destination:true});destinations.add(String(position.location_id));}updates.set(String(cage.cage_sid),change.value??null);}
 const next={...dataset,tables:{...dataset.tables,cages:dataset.tables.cages.map(c=>updates.has(String(c.cage_sid))?{...c,location_id:updates.get(String(c.cage_sid))}:c)}},final=context(next);
 for(const id of destinations)if(final.occupants(id).length>1)throw new Error(`Position ${ctx.location(id).label} became occupied or has multiple current cages. Reload and review the move before syncing.`);
 return true;
}

const historical=r=>r?.history_read_only===true||r?.source_historical===true||/^historical_(?:snapshot|assignment)_projection$/.test(r?.record_origin||'');
const identityFields=['physical_tag','sex','date_of_birth'];
const mouseIdentity=mouse=>Object.fromEntries(identityFields.map(field=>[field,mouse[field]??null]));
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

function mouseMoveContext(dataset,mouseSid,targetCageSid,{sourceMatch=null,targetDataset=dataset}={}){
 if(dataset?.history_projection?.read_only===true)throw new Error('Historical cage views are read only. Return to current cages before moving a mouse.');
 const tables=dataset?.tables||{},mice=index(tables.mice,'mouse_sid'),ctx=context(dataset),mouse=mice.get(textId(mouseSid,'mouse SID'));
 if(!active(mouse)||mouse?._derived||historical(mouse)||mouse.state!=='Stock')throw new Error(`Mouse ${mouseSid} is missing, archived or not a current registered Stock animal.`);
 const checkCage=(id,{destination=false}={})=>{
  const data=destination?targetDataset:dataset,tables=data.tables||{},ctx=context(data),cage=ctx.cage(textId(id,'cage SID'));
  if(historical(cage)||destination&&!/^(Active|Occupied)$/i.test(cage.state||''))throw new Error(`Cage ${id} is not a current active registered cage.`);
  const position=ctx.oldPosition(cage);
  if(position){
   if(destination)ctx.location(String(position.location_id),{destination:true});
   const room=(tables.rooms||[]).find(r=>String(r.room_id)===String(position.room_id)),rack=(tables.racks||[]).find(r=>String(r.rack_id)===String(position.rack_id));
   if([position,room,rack].some(historical))throw new Error(`Cage ${id} has historical housing. Choose current housing.`);
  }else{
   const room=present(cage.room_id)?(tables.rooms||[]).find(r=>String(r.room_id)===String(cage.room_id)):null;
   const rack=present(cage.rack_id)?(tables.racks||[]).find(r=>String(r.rack_id)===String(cage.rack_id)):null;
   if(present(cage.room_id)&&(!active(room)||historical(room))||present(cage.rack_id)&&(!active(rack)||historical(rack)||!active(room)||String(rack.room_id)!==String(room.room_id)))throw new Error(`Cage ${id} needs consistent active housing before moving a mouse.`);
  }
  return cage;
 };
 let sourceObservation=null;
 if(sourceMatch){
  if(typeof sourceMatch!=='object'||Array.isArray(sourceMatch)||typeof sourceMatch.tag!=='string'||!sourceMatch.tag||typeof sourceMatch.sourceCell!=='string'||!/^\$?[A-Z]+\$?[1-9]\d*$/i.test(sourceMatch.sourceCell))throw new Error('The source observation is not an exact editable animal match.');
  textId(sourceMatch.locationId,'source position');
  if(!(mouse.cage_sid===targetCageSid&&mouse.cage_sheet_overrides?.cage_sid===true)){
   const position=ctx.location(sourceMatch.locationId,{destination:true});
   sourceObservation=cageSheetAnimals(dataset,{position}).find(row=>row.matchStatus==='matched'&&row.mouseSid===mouseSid&&(row.sourceTag||row.tag)===sourceMatch.tag&&row.sourceCell===sourceMatch.sourceCell);
   if(historical(position)||!sourceObservation)throw new Error('Animal match changed. Reload the sheet before moving this mouse.');
  }
 }
 const target=checkCage(targetCageSid,{destination:true});
 // A current, unique sheet observation can be moved even when the old recorded
 // cage SID has no registered cage. That old ID remains in the dated event.
 const source=present(mouse.cage_sid)?sourceMatch?(tables.cages||[]).find(row=>String(row.cage_sid)===String(mouse.cage_sid))||null:checkCage(String(mouse.cage_sid)):null;
 return {mouse,source,target,sourceObservation};
}

const sourceFieldValues=row=>({ear_mark:row?.earMark??null,date_of_birth:row?.dateOfBirth??null,comment:row?.sourceNote||null});
const blank=value=>value===null||value===undefined||typeof value==='string'&&!value.trim();

/** Stage a registered mouse's explicit cage assignment, without changing any record. */
export function planMouseMove(dataset,mouseSid,destinationCageSid,{sourceCageSid,effectiveDate=null,sourceMatch=null,targetDataset=dataset}={}){
 const id=textId(mouseSid,'mouse SID'),destination=textId(destinationCageSid,'destination cage SID'),{mouse,source,target,sourceObservation}=mouseMoveContext(dataset,id,destination,{sourceMatch,targetDataset}),old=mouse.cage_sid??null;
 if(sourceCageSid!==undefined&&!same(sourceCageSid,old))throw new Error('This animal is not currently assigned to the displayed source cage. Reload and review its identity before moving it.');
 if(effectiveDate!==null&&!validDate(effectiveDate))throw new Error('Choose a valid effective move date (YYYY-MM-DD).');
 const common={mouse_sid:id,source_cage_sid:old,destination_cage_sid:destination,warnings:[],readDependencies:movementDependencies(dataset,{mouse,source,target},sourceMatch)};
 if(old===destination)return {...common,kind:'noop',changes:[],summary:`Mouse ${mouse.physical_tag||id} is already in cage ${target.cage_tag||destination}.`};
 const mouseMove={schemaVersion:1,mouseSid:id,sourceCageSid:old,destinationCageSid:destination,identity:mouseIdentity(mouse),effectiveDate};
 const matched=sourceMatch?{locationId:sourceMatch.locationId,tag:sourceMatch.tag,sourceCell:sourceMatch.sourceCell}:null;
 const changes=[{type:'mice',id,field:'cage_sid',base:old,value:destination,mouseMove,...(matched?{sourceMatch:matched}:{})}];
 if(sourceObservation)for(const [field,value] of Object.entries(sourceFieldValues(sourceObservation)))if(blank(mouse[field])&&!blank(value)&&mouse.cage_sheet_overrides?.[field]!==true)changes.push({type:'mice',id,field,base:mouse[field]??null,value,sourceMatch:{...matched},sourceFill:true,overrideSource:true});
 return {...common,kind:'mouse_move',changes,summary:`Move mouse ${mouse.physical_tag||id} from ${source?.cage_tag||old||'unassigned'} to cage ${target.cage_tag||destination}.`};
}

const createdCageFields=['cage_sid','cage_tag','state','record_origin','location_id','room_id','rack_id','cage_sheet_source_location_id'];
function createdCage(position,id){return {cage_sid:id,cage_tag:position.label,state:'Active',record_origin:'app_created',location_id:position.location_id,room_id:position.room_id,rack_id:position.rack_id,cage_sheet_source_location_id:position.location_id,...positionManager(position)};}

/** An unlinked destination is registered only on Save, using the supplied stable SID. */
export function planMouseMoveToPosition(dataset,mouseSid,locationId,{cageSid,...options}={}){
 const ctx=context(dataset),position=ctx.location(textId(locationId,'destination position'),{destination:true}),occupants=ctx.occupants(locationId);
 if(historical(position))throw new Error('Historical positions cannot receive a mouse.');
 if(occupants.length>1)throw new Error(`Position ${position.label} has multiple current cages. Resolve them before moving a mouse.`);
 if(occupants.length===1)return {...planMouseMove(dataset,mouseSid,String(occupants[0].cage_sid),options),destination_location_id:locationId};
 const id=textId(cageSid,'new cage SID');if((dataset.tables.cages||[]).some(c=>String(c.cage_sid)===id))throw new Error('The new cage SID is already registered. Choose a new SID.');
 const record=createdCage(position,id),projected={...dataset,tables:{...dataset.tables,cages:[...(dataset.tables.cages||[]),record]}},plan=planMouseMove(projected,mouseSid,id,options),creation={type:'cages',id,field:'$create',base:null,value:record};
 return {...plan,kind:'mouse_move',destination_location_id:locationId,changes:[creation,...plan.changes],readDependencies:plan.readDependencies.filter(dep=>!(dep.type==='cages'&&dep.id===id)),summary:`Create cage ${position.label} and ${plan.summary[0].toLowerCase()+plan.summary.slice(1)}`};
}

// Whole source cards are movable only after every displayed animal has one
// verified current identity. Source observations remain at their original slots.
function slotGroup(dataset,locationId,{checkOtherPositions=true}={}){
 if(dataset?.history_projection?.read_only===true)throw new Error('Historical cage views are read only.');
 const ctx=context(dataset),position=ctx.location(textId(locationId,'cage position'),{destination:true});
 const t=dataset.tables||{},rack=(t.racks||[]).find(r=>r.rack_id===position.rack_id),room=(t.rooms||[]).find(r=>r.room_id===position.room_id);
 if([position,rack,room].some(historical))throw new Error('Historical positions cannot be moved.');
 const occupants=ctx.occupants(locationId);if(occupants.length>1)throw new Error(`Position ${position.label} has multiple current cages.`);
 const cage=occupants[0]||null;
 if(cage){ctx.cage(String(cage.cage_sid));ctx.oldPosition(cage);if(historical(cage)||! /^(Active|Occupied)$/i.test(cage.state||''))throw new Error('Choose a current active cage.');}
 const mice=(t.mice||[]).filter(m=>active(m)&&m.state==='Stock'&&cage&&String(m.cage_sid)===String(cage.cage_sid)),sourceRows=cageSheetAnimals(dataset,{position});
 const rows=cage?cageSheetAnimals(dataset,{position,cage,mice}):sourceRows,seen=new Set();
 for(const row of rows){
  const mouse=(t.mice||[]).find(m=>String(m.mouse_sid)===row.mouseSid);
  if(!row.mouseSid||!['matched','registered'].includes(row.matchStatus)||!active(mouse)||mouse.state!=='Stock'||mouse._derived||historical(mouse)||seen.has(row.mouseSid))throw new Error(`Review the unmatched animals in ${position.label} before moving the whole cage.`);
  seen.add(row.mouseSid);
  if(row.matchStatus==='matched')for(const [field,value] of Object.entries(sourceFieldValues(row))){
   if(mouse.cage_sheet_overrides?.[field]===true||blank(value)||blank(mouse[field]))continue;
   const stored=typeof mouse[field]==='string'?mouse[field].trim():mouse[field];
   if(!same(stored,value))throw new Error(`Review and save ${field==='comment'?'the note':field==='ear_mark'?'the earmark':'DOB'} for ${row.tag} before moving cage ${position.label}; its sheet and saved values differ.`);
  }
  if(cage&&!mice.some(m=>String(m.mouse_sid)===row.mouseSid))throw new Error(`Assign every animal in ${position.label} before moving the whole cage.`);
 }
 // A registered cage must not mask unresolved source occupants at its slot.
 if(cage&&sourceRows.some(row=>!row.mouseSid||!mice.some(m=>String(m.mouse_sid)===row.mouseSid)))throw new Error(`Review the unmatched animals in ${position.label} before moving the whole cage.`);
 if(!cage&&checkOtherPositions)for(const other of (t.locations||[]).filter(p=>active(p)&&p.source_current!==false&&!historical(p)&&p.location_id!==locationId)){
  if(cageSheetAnimals(dataset,{position:other}).some(row=>row.mouseSid&&seen.has(row.mouseSid)))throw new Error(`An animal in ${position.label} is also listed at another position. Review it before moving the cage.`);
 }
 const animals=rows.map(row=>{const mouse=(t.mice||[]).find(m=>String(m.mouse_sid)===row.mouseSid);return {mouseSid:row.mouseSid,tag:row.sourceTag||row.tag,sourceCell:row.sourceCell,matchStatus:row.matchStatus,identity:mouseIdentity(mouse),cageSid:mouse.cage_sid??null};}).sort((a,b)=>a.mouseSid.localeCompare(b.mouseSid));
 const snapshot={locationId,roomId:position.room_id,rackId:position.rack_id,label:position.label,cageSid:cage?.cage_sid??null,animals,observation:cageObservations(position),manager:positionManager(position)};
 return {position,cage,rows,animals,snapshot};
}
const slotCreation=(source,destination,id)=>{
 const record=createdCage(destination,id);delete record.manager;
 const observation=cageObservations(source),literalManager=observation.managerName||source.source_manager_name||source.source_manager_acronym;
 const manager=Object.hasOwn(source,'manager')?positionManager(source):typeof literalManager==='string'&&literalManager.trim()?{manager:literalManager.trim()}:{};
 return {...record,cage_sheet_source_location_id:source.location_id,...manager,...(observation.startedDate?{start_date:observation.startedDate}:{})};
};
const changeIdentity=change=>Object.fromEntries(['type','id','field','base','value','mouseMove','sourceMatch','sourceFill','overrideSource','sourceCage','wholeCageFill'].filter(key=>Object.hasOwn(change,key)).map(key=>[key,change[key]]));
function buildSlotMove(dataset,sourceLocationId,destinationLocationId,newCageIds={}){
 const source=slotGroup(dataset,sourceLocationId);
 if(!source.cage&&!source.rows.length)throw new Error('This position is empty. Choose a cage to move.');
 if(sourceLocationId===destinationLocationId)return {kind:'noop',changes:[],summary:`Cage is already at ${source.position.label}.`};
 const destination=slotGroup(dataset,destinationLocationId);
 const groups=[source,...(destination.cage||destination.rows.length?[destination]:[])],targets=[destination.position,source.position],allIds=new Set();
 for(const group of groups)for(const animal of group.animals){if(allIds.has(animal.mouseSid))throw new Error('The same animal appears in both cages. Review their assignments.');allIds.add(animal.mouseSid);}
 const changes=[],newCages=[],finalCages=(dataset.tables.cages||[]).map(c=>({...c}));
 groups.forEach((group,i)=>{
  if(group.cage){const moves=movement(group.cage,targets[i]);changes.push(...moves);if(blank(group.cage.start_date)&&blank(group.cage.set_up_date)&&group.snapshot.observation.startedDate)changes.push({...cell(group.cage,'start_date',group.snapshot.observation.startedDate),wholeCageFill:true});const value=finalCages.find(c=>c.cage_sid===group.cage.cage_sid);Object.assign(value,{location_id:targets[i].location_id,cage_tag:targets[i].label,room_id:targets[i].room_id,rack_id:targets[i].rack_id});group.targetCageSid=String(group.cage.cage_sid);}
  else{
   const id=textId(newCageIds[group.position.location_id],'new cage SID');
   if(finalCages.some(c=>String(c.cage_sid)===id)||newCages.some(c=>c.cage_sid===id))throw new Error('The new cage SID is already registered. Choose a new SID.');
   const value=slotCreation(group.position,targets[i],id);newCages.push(value);group.targetCageSid=id;
   changes.push({type:'cages',id,field:'$create',base:null,value,sourceCage:{locationId:group.position.location_id}});
  }
 });
 const projected={...dataset,tables:{...dataset.tables,cages:[...finalCages,...newCages]}};
 for(const group of groups)for(const row of group.rows){
  const match=row.matchStatus==='matched'?{locationId:group.position.location_id,tag:row.sourceTag||row.tag,sourceCell:row.sourceCell}:null;
  if(!group.cage)changes.push(...planMouseMove(dataset,row.mouseSid,group.targetCageSid,{sourceMatch:match,targetDataset:projected}).changes);
  else if(match){
   const mouse=(dataset.tables.mice||[]).find(m=>String(m.mouse_sid)===row.mouseSid);
   for(const [field,value] of Object.entries(sourceFieldValues(row)))if(blank(mouse[field])&&!blank(value)&&mouse.cage_sheet_overrides?.[field]!==true)changes.push({type:'mice',id:row.mouseSid,field,base:mouse[field]??null,value,sourceMatch:match,overrideSource:true,wholeCageFill:true});
  }
 }
 const proof={schemaVersion:1,sourceLocationId,destinationLocationId,newCageIds:Object.fromEntries(groups.filter(g=>!g.cage).map(g=>[g.position.location_id,g.targetCageSid])),groups:[source.snapshot,destination.snapshot]};
 return {kind:groups.length===2?'swap':'move',source_location_id:sourceLocationId,destination_location_id:destinationLocationId,cage_sid:groups[0].targetCageSid,other_cage_sid:groups[1]?.targetCageSid??null,changes:changes.map(change=>({...change,cageSlotMove:proof})),summary:groups.length===2?`Swap cages at ${source.position.label} and ${destination.position.label}.`:`Move cage ${source.position.label} to ${destination.position.label}.`};
}
/** Cheap presentation eligibility; a drop and Save still validate other slots. */
export function cageSlotMoveEligibility(dataset,locationId){
 const group=slotGroup(dataset,locationId,{checkOtherPositions:false});
 if(!group.cage&&!group.rows.length)throw new Error('This position is empty. Choose a cage to move.');
 return {locationId,cageSid:group.cage?.cage_sid??null,animalCount:group.rows.length};
}
/** Stage complete source-backed groups without altering imported snapshots. */
export function planCageSlotMove(dataset,sourceLocationId,destinationLocationId,{newCageIds={}}={}){
 return buildSlotMove(dataset,sourceLocationId,destinationLocationId,newCageIds);
}
function validateSlotMoveDrafts(dataset,drafts){
 const proofs=[...new Map(drafts.filter(c=>c.cageSlotMove).map(c=>[JSON.stringify(c.cageSlotMove),c.cageSlotMove])).values()];
 for(const proof of proofs){
  if(!proof||proof.schemaVersion!==1||!Array.isArray(proof.groups)||proof.groups.length!==2||!proof.newCageIds||typeof proof.newCageIds!=='object'||Array.isArray(proof.newCageIds))throw new Error('The whole-cage move guard is invalid.');
  const associated=drafts.filter(c=>same(c.cageSlotMove,proof)),complete=associated.length>0&&associated.every(c=>{
   const record=(dataset.tables[c.type]||[]).find(r=>String(r[{cages:'cage_sid',mice:'mouse_sid'}[c.type]])===String(c.id));
   return c.field==='$create'?record&&Object.entries(c.value).every(([key,value])=>same(record[key],value)):record&&same(record[c.field],c.value);
  });
  if(complete)continue;
  const fresh=buildSlotMove(dataset,proof.sourceLocationId,proof.destinationLocationId,proof.newCageIds);
  if(!same(fresh.changes[0]?.cageSlotMove,proof))throw new Error('The cage occupants or source details changed. Reload before moving the whole cage.');
  const expected=fresh.changes.map(changeIdentity),actual=associated.map(changeIdentity);
  if(expected.length!==actual.length||expected.some(change=>!actual.some(candidate=>same(candidate,change))))throw new Error('The whole-cage move is incomplete. Reload and move the complete cage again.');
 }
 if(drafts.some(c=>(c.sourceCage||c.wholeCageFill)&&!c.cageSlotMove))throw new Error('Source cage registration requires a complete whole-cage move.');
}

function projectedCages(dataset,changes){
 const drafts=Array.from(changes||[]),cageChanges=drafts.filter(c=>c?.type==='cages'&&['location_id','cage_tag'].includes(c.field));
 let projected=dataset;
 if(cageChanges.length){
  validateCageMovementOccupancy(dataset,cageChanges);
  projected={...dataset,tables:{...dataset.tables,cages:(dataset?.tables?.cages||[]).map(cage=>{
   const edits=cageChanges.filter(change=>String(change.id)===String(cage.cage_sid));if(!edits.length)return cage;
   const next={...cage};for(const change of edits){if(!same(cage[change.field],change.base)&&!same(cage[change.field],change.value))throw new Error('Changed by another editor: cage placement changed. Review the draft before saving.');next[change.field]=change.value;}
   if(edits.some(change=>change.field==='location_id')){const p=(dataset.tables.locations||[]).find(row=>row.location_id===next.location_id);next.room_id=p?.room_id??null;next.rack_id=p?.rack_id??null;}
   return next;
  })}};
 }
 const creations=drafts.filter(c=>c?.type==='cages'&&c.field==='$create'),seen=new Set();
 for(const change of creations){
  const id=textId(change.id,'new cage SID'),value=change.value;
  if(seen.has(id)||change.base!==null||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(field=>!createdCageFields.includes(field)&&!['manager','start_date'].includes(field))||createdCageFields.some(field=>!Object.hasOwn(value,field))||value.cage_sid!==id)throw new Error('The new cage draft is invalid. Choose the destination again.');seen.add(id);
  const ctx=context(projected),position=positionWithManagerDraft(ctx.location(textId(value.location_id,'destination position'),{destination:true}),drafts);
  const source=change.sourceCage?positionWithManagerDraft(ctx.location(textId(change.sourceCage.locationId,'source position'),{destination:true}),drafts):null;
  const expected=source?slotCreation(source,position,id):createdCage(position,id),fields=Object.keys(expected);
  if(historical(position)||Object.keys(value).length!==fields.length||fields.some(field=>!Object.hasOwn(value,field)||!same(value[field],expected[field])))throw new Error('The destination changed. Reload before creating its cage.');
  const existing=(projected.tables.cages||[]).find(row=>String(row.cage_sid)===id),occupants=ctx.occupants(position.location_id);
  if(existing&&(fields.some(field=>!Object.hasOwn(existing,field)||!same(existing[field],value[field]))||!active(existing)||historical(existing)))throw new Error('The new cage SID is already in use. Review the draft before saving.');
  if(occupants.some(c=>String(c.cage_sid)!==id))throw new Error('The destination became occupied. Review the move before saving.');
  if(!existing)projected={...projected,tables:{...projected.tables,cages:[...(projected.tables.cages||[]),{...value}]}};
 }
 return projected;
}

/** Validate staged mouse moves against fresh records; unrelated field edits remain mergeable. */
export function validateMouseMoveDrafts(dataset,changes){
 const drafts=Array.from(changes||[]);validateSlotMoveDrafts(dataset,drafts);const projected=projectedCages(dataset,drafts);
 const seen=new Set();
 for(const change of drafts){
  if(change?.type!=='mice'||change.field!=='cage_sid')continue;
  const proof=change.mouseMove,id=textId(change.id,'mouse SID'),destination=textId(change.value,'destination cage SID');
  if(seen.has(id))throw new Error(`Mouse ${id} has multiple staged cage moves. Keep one destination before saving.`);seen.add(id);
  if(!proof||proof.schemaVersion!==1||proof.mouseSid!==id||proof.destinationCageSid!==destination||!Object.hasOwn(proof,'sourceCageSid')||!same(proof.sourceCageSid,change.base)||!proof.identity||typeof proof.identity!=='object'||Array.isArray(proof.identity)||Object.keys(proof.identity).length!==identityFields.length||identityFields.some(field=>!Object.hasOwn(proof.identity,field))||proof.effectiveDate!==null&&!validDate(proof.effectiveDate))throw new Error('The staged mouse move has no valid identity guard. Reload and choose the move again.');
  const {mouse,sourceObservation}=mouseMoveContext(dataset,id,destination,{sourceMatch:change.sourceMatch,targetDataset:projected});
  const alreadyApplied=mouse.cage_sid===destination&&mouse.cage_sheet_overrides?.cage_sid===true;
  if(identityFields.some(field=>{
   if(same(mouse[field],proof.identity[field]))return false;
   const edits=drafts.filter(c=>c.type==='mice'&&c.id===id&&c.field===field);
   return !alreadyApplied||edits.length!==1||!same(edits[0].base,proof.identity[field])||!same(mouse[field],edits[0].value);
  }))throw new Error('Animal identity fields changed. Reload and review the mouse before saving this move.');
  if(!same(mouse.cage_sid,proof.sourceCageSid)&&!same(mouse.cage_sid,destination))throw new Error('Changed by another editor: the mouse cage assignment changed. Your draft is kept; review it before saving.');
  for(const fill of drafts.filter(c=>c.type==='mice'&&c.id===id&&c.sourceFill===true)){
   if(!['ear_mark','date_of_birth','comment'].includes(fill.field)||!blank(fill.base)||blank(fill.value)||!same(fill.sourceMatch,change.sourceMatch))throw new Error('The source observation fill is not a valid part of this mouse move.');
   if(alreadyApplied&&mouse.cage_sheet_overrides?.[fill.field]===true&&same(mouse[fill.field],fill.value))continue;
   if(!sourceObservation||!same(sourceFieldValues(sourceObservation)[fill.field],fill.value))throw new Error('Animal source details changed. Reload and review the move before saving.');
  }
 }
 if(drafts.some(c=>c.sourceFill===true&&!seen.has(String(c.id))))throw new Error('Source observation fills require their staged mouse move.');
 return true;
}

function movementDependencies(dataset,{mouse,source,target},sourceMatch){
 const t=dataset.tables||{},deps=new Map(),keys={mice:'mouse_sid',cages:'cage_sid',locations:'location_id',racks:'rack_id',rooms:'room_id'};
 const add=(type,id)=>{if(present(id)&&(t[type]||[]).some(row=>String(row[keys[type]])===String(id)))deps.set(type+':'+id,{type,id:String(id)});};
 const housing=record=>{if(!record)return;const location=(t.locations||[]).find(row=>row.location_id===record.location_id),rackId=record.rack_id??location?.rack_id,rack=(t.racks||[]).find(row=>row.rack_id===rackId);add('locations',record.location_id);add('racks',rackId);add('rooms',record.room_id??location?.room_id??rack?.room_id);};
 add('mice',mouse.mouse_sid);for(const cage of [source,target]){add('cages',cage?.cage_sid);housing(cage);}if(sourceMatch)housing({location_id:sourceMatch.locationId});
 return [...deps.values()];
}

/** Fresh no-op dependencies must join the same atomic save as changed records. */
export function getMouseMoveReadDependencies(dataset,changes){
 const drafts=Array.from(changes||[]);validateMouseMoveDrafts(dataset,drafts);const projected=projectedCages(dataset,drafts),deps=new Map();
 for(const change of drafts.filter(c=>c.type==='mice'&&c.field==='cage_sid')){
  const records=mouseMoveContext(dataset,change.id,change.value,{sourceMatch:change.sourceMatch,targetDataset:projected});
  for(const dep of movementDependencies(projected,records,change.sourceMatch))if((dataset.tables[dep.type]||[]).some(row=>String(row[{mice:'mouse_sid',cages:'cage_sid',locations:'location_id',racks:'rack_id',rooms:'room_id'}[dep.type]])===dep.id))deps.set(dep.type+':'+dep.id,dep);
 }
 // Whole-cage moves depend on both the old path and the destination path, too.
 for(const change of drafts.filter(c=>c.type==='cages'&&['location_id','$create'].includes(c.field))){
  const old=(dataset.tables.cages||[]).find(row=>String(row.cage_sid)===String(change.id)),next=(projected.tables.cages||[]).find(row=>String(row.cage_sid)===String(change.id));
  for(const [view,cage] of [[dataset,old],[projected,next]])if(cage)for(const dep of movementDependencies(view,{mouse:{},source:null,target:cage},null))if((dataset.tables[dep.type]||[]).some(row=>String(row[{mice:'mouse_sid',cages:'cage_sid',locations:'location_id',racks:'rack_id',rooms:'room_id'}[dep.type]])===dep.id))deps.set(dep.type+':'+dep.id,dep);
 }
 for(const change of drafts.filter(c=>c.type==='mice'&&c.sourceMatch)){
  const mouse=(dataset.tables.mice||[]).find(row=>String(row.mouse_sid)===String(change.id));
  if(mouse)for(const dep of movementDependencies(dataset,{mouse,source:null,target:null},change.sourceMatch))deps.set(dep.type+':'+dep.id,dep);
 }
 // Whole-card proof checks include every group animal and both physical slots.
 // Current source positions are read guards because a duplicate sighting would
 // invalidate a source-only group even when its own slot is unchanged.
 for(const change of drafts.filter(c=>c.cageSlotMove)){
  const proof=change.cageSlotMove;
  for(const group of proof.groups){
   for(const dep of movementDependencies(dataset,{mouse:{},source:null,target:null},{locationId:group.locationId}))deps.set(dep.type+':'+dep.id,dep);
   for(const animal of group.animals||[])deps.set('mice:'+animal.mouseSid,{type:'mice',id:animal.mouseSid});
   if(group.cageSid)deps.set('cages:'+group.cageSid,{type:'cages',id:group.cageSid});
  }
  for(const position of (dataset.tables.locations||[]).filter(p=>active(p)&&p.source_current!==false&&!historical(p)))deps.set('locations:'+position.location_id,{type:'locations',id:position.location_id});
 }
 // A linked cage keeps its manager if moved again before Save. Its original
 // source position remains a read dependency even when it is not the final slot.
 for(const change of drafts.filter(c=>c.positionManager)){
  for(const dep of movementDependencies(dataset,{mouse:{},source:null,target:null},{locationId:change.positionManager.locationId}))deps.set(dep.type+':'+dep.id,dep);
 }
 return [...deps.values()];
}

function cagePath(dataset,cage){
 const t=dataset?.tables||{},position=(t.locations||[]).find(r=>present(cage?.location_id)&&r.location_id===cage.location_id),rackId=cage?.rack_id??position?.rack_id??null,rack=(t.racks||[]).find(r=>r.rack_id===rackId),roomId=cage?.room_id??position?.room_id??rack?.room_id??null,room=(t.rooms||[]).find(r=>r.room_id===roomId);
 const room_label=room?.name||room?.label||roomId||null,rack_label=rack?.name||rack?.label||rackId||null,position_label=position?.label||cage?.location_id||null;
 return {room_id:roomId,rack_id:rackId,location_id:cage?.location_id??null,room_label,rack_label,position_label,location_label:[room_label,rack_label,position_label].filter(present).join(' / ')||null};
}

/** Create one dated event after the guarded assignment has been applied to a draft dataset. */
export function buildMouseMoveEvent(before,after,change,{at=new Date().toISOString(),eventId}={}){
 // The complete batch validator checks creation and source matches before this
 // helper is called. Recheck the identity/CAS guard with the final target view.
 const proof=change.mouseMove,{mouse:old,sourceObservation}=mouseMoveContext(before,change.id,change.value,{sourceMatch:change.sourceMatch,targetDataset:after});
 if(!proof||proof.schemaVersion!==1||proof.mouseSid!==change.id||proof.destinationCageSid!==change.value||!same(proof.sourceCageSid,change.base)||proof.effectiveDate!==null&&!validDate(proof.effectiveDate))throw new Error('The mouse move identity guard changed.');
 const id=change.id;
 if(same(old.cage_sid,change.value))return null;
 if(identityFields.some(field=>!same(old[field],proof.identity?.[field])))throw new Error('The mouse move identity guard changed.');
 if(!same(old.cage_sid,proof.sourceCageSid))throw new Error('The mouse cage assignment changed.');
 const {mouse,target}=mouseMoveContext(after,id,change.value);
 if(mouse.cage_sid!==change.value)throw new Error('Apply the mouse cage draft before recording its move.');
 const instant=new Date(at);if(Number.isNaN(instant.getTime()))throw new Error('Choose a valid save time.');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(instant),date=change.mouseMove.effectiveDate||today;
 if(date>today||validDate(mouse.date_of_birth)&&date<mouse.date_of_birth)throw new Error('The effective move date must be on or after DOB and no later than today.');
 const previous=(before.tables.cages||[]).find(row=>row.cage_sid===old.cage_sid),currentPath=cagePath(after,target),oldPath=cagePath(before,previous);
 const sourceContext=sourceObservation?{source_observation:{location_id:change.sourceMatch.locationId,tag:sourceObservation.sourceTag||sourceObservation.tag,source_cell:sourceObservation.sourceCell,...sourceFieldValues(sourceObservation)}}:{};
 return {event_id:eventId===undefined?`MOVE-${crypto.randomUUID()}`:textId(eventId,'movement event ID'),record_origin:'app_created',event_type:present(old.cage_sid)?'cage_move':'cage_assignment',mouse_sid:id,old_cage_sid:old.cage_sid??null,cage_sid:target.cage_sid,cage_tag:target.cage_tag??null,event_date:date,...currentPath,...Object.fromEntries(Object.entries(oldPath).map(([key,value])=>['old_'+key,value])),...sourceContext,notes:'Moved from the editable Animal Sheet view.',app_created_at:at,app_modified_at:at};
}
