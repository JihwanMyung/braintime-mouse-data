/* Pure physical cage movements. SIDs and source observations never change. */
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
 function location(id){
  const value=locations.get(id);if(!active(value))throw new Error(`Position ${id} is missing or archived.`);
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

/** Plans explicit slot changes; applyCageSheetDrafts supplies fresh-data conflict and permission checks. */
export function planCageMove(dataset,cageSid,destinationLocationId,options={}){
 const ctx=context(dataset),id=textId(cageSid,'cage SID'),cage=ctx.cage(id),source=ctx.oldPosition(cage);
 const destination=destinationLocationId===null||destinationLocationId===undefined||destinationLocationId===''?null:ctx.location(textId(destinationLocationId,'destination position'));
 const common={cage_sid:id,source_location_id:source?.location_id??null,destination_location_id:destination?.location_id??null,other_cage_sid:null,warnings:[]};
 if((source?.location_id??null)===(destination?.location_id??null))return {...common,kind:'noop',changes:[],summary:destination?`Cage ${id} is already at ${destination.label}.`:`Cage ${id} is already off the rack.`};
 if(!destination)return {...common,kind:'remove',changes:movement(cage,null),summary:`Remove cage ${id} from ${source.label}. Keep its tag and all animal records.`};
 const occupied=ctx.occupants(String(destination.location_id));
 if(occupied.length>1)throw new Error(`Position ${destination.label} has multiple current cage assignments. Resolve them before moving cages.`);
 if(!occupied.length)return {...common,kind:'move',changes:movement(cage,destination),summary:`Move cage ${id} from ${source?.label||'off rack'} to ${destination.label}. Its tag becomes ${destination.label}.`};
 if(!source)throw new Error(`Position ${destination.label} is occupied. Choose an empty position for a cage that is off the rack.`);
 const other=ctx.cage(String(occupied[0].cage_sid));ctx.oldPosition(other);
 return {...common,kind:'swap',other_cage_sid:String(other.cage_sid),changes:[...movement(cage,destination),...movement(other,source)],summary:`Swap cage ${id} (${source.label}) with cage ${other.cage_sid} (${destination.label}). Cage SIDs and animal identities stay the same.`};
}
export function planCageRemoval(dataset,cageSid,options={}){return planCageMove(dataset,cageSid,null,options);}

/** Recheck affected slots against freshly loaded data before applying cell drafts. */
export function validateCageMovementOccupancy(dataset,changes){
 const selected=Array.from(changes||[]).filter(c=>c.type==='cages'&&c.field==='location_id'&&(c.value??null)!==(dataset?.tables?.cages||[]).find(r=>String(r.cage_sid)===String(c.id))?.location_id);
 if(!selected.length)return true;
 const ctx=context(dataset),destinations=new Set(),updates=new Map();
 for(const change of selected){const cage=ctx.cage(String(change.id));ctx.oldPosition(cage);if(present(change.value)){const position=ctx.location(textId(change.value,'destination position'));destinations.add(String(position.location_id));}updates.set(String(cage.cage_sid),change.value??null);}
 const next={...dataset,tables:{...dataset.tables,cages:dataset.tables.cages.map(c=>updates.has(String(c.cage_sid))?{...c,location_id:updates.get(String(c.cage_sid))}:c)}},final=context(next);
 for(const id of destinations)if(final.occupants(id).length>1)throw new Error(`Position ${ctx.location(id).label} became occupied or has multiple current cages. Reload and review the move before syncing.`);
 return true;
}
