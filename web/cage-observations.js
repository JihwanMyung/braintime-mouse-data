/* Literal Animal Sheet cage observations. This module never assigns a mouse to
 * a cage, invents an SID, or changes a saved record. */
const text=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const active=value=>value&&!value.app_archived_at&&value.archived!==true;
const date=value=>{const raw=text(value),match=raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:T.*|\s+00:00:00)?$/);if(!match)return null;const iso=`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;return Number.isFinite(Date.parse(iso+'T00:00:00Z'))&&new Date(iso+'T00:00:00Z').toISOString().slice(0,10)===iso?iso:null;};
const hole=value=>/^(?:0|[1-9]\d?)(?:\.0+)?$/.test(text(value))&&Number(value)<=99?Number(value):null;
const sex=value=>/^(?:male|m)$/i.test(text(value))?'Male':/^(?:female|f)$/i.test(text(value))?'Female':null;
const tagSex=tag=>{const match=text(tag).match(/(?:-|\s)([MF])\s*-?\s*\d+[A-Za-z]?$/);return match?match[1]==='M'?'Male':'Female':null;};
// Only the delimiter before an explicit terminal sex/SID can vary. Genotype
// spelling, primes, parentheses and internal separators remain unchanged.
const identifierKey=value=>text(value).replace(/^(.*?)(?:\s+|-)([MF]\d+)$/,'$1-$2');
const lifecycle=value=>/\b(?:dead|died|ended|sacrificed|removed|euthanized|transfer(?:red)?)\b/i.test(text(value));
const shorthand=value=>/^[('’′)]*(?:(?:AD|WT|P|B|E|F|V|M|32|96)[('’′)]*)+$/.test(value);
const validCell=value=>/^[A-Z]{1,3}[1-9]\d{0,5}$/.test(text(value));
const column=value=>[...value].reduce((total,ch)=>total*26+ch.charCodeAt(0)-64,0);
const coordinate=(row,col)=>{let s='';for(let n=col;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s+row;};
const empty=()=>({schemaVersion:1,animals:[],startedDate:null,intensityLux:null,managerName:null,managerCell:null,startedCell:null,intensityCell:null});
function fallbackObservation(position){
 const result=empty(),tags=[...(Array.isArray(position.source_observed_tags)?position.source_observed_tags:[])];
 for(const line of text(position.source_block_text).split('\n')){const m=line.match(/^[A-Z]+\d+:\s*(.+)$/);if(m&&tagSex(m[1]))tags.push(m[1]);}
 result.animals=[...new Set(tags.map(text).filter(v=>v&&!date(v)&&!/^=|^\d+(?:\.\d+)?$|\$/.test(v)))].slice(0,100).map((tag,i)=>cleanAnimal({tag,sourceCell:null,requiresReview:true},position,i)).filter(Boolean);
 return result;
}
function cleanAnimal(value,position,index){
 if(!object(value))return null;
 const tag=text(value.tag).slice(0,240);if(!tag)return null;
 const sourceCell=validCell(value.sourceCell)?text(value.sourceCell):null,left=hole(value.left),right=hole(value.right),ear=left!==null&&right!==null?`L${left}R${right}`:text(value.earMark).match(/^L(\d{1,2})R(\d{1,2})$/)?.[0]??null;
 const note=text(value.note).slice(0,2000);
 return {key:`${text(position.location_id)||text(position.source_cell)||'position'}:${sourceCell||index}`,tag,note,dateOfBirth:date(value.dateOfBirth),earMark:ear,left:left??(ear?Number(ear.match(/^L(\d+)/)[1]):null),right:right??(ear?Number(ear.match(/R(\d+)$/)[1]):null),sex:sex(value.sex)||tagSex(tag),sourceCell,requiresReview:value.requiresReview===true||lifecycle(tag+' '+note)};
}
function structuredObservation(value,position){
 if(!object(value)||value.schemaVersion!==1||!Array.isArray(value.animals))return null;
 const result=empty();result.animals=value.animals.slice(0,100).map((a,i)=>cleanAnimal(a,position,i)).filter(Boolean);
 result.startedDate=date(value.startedDate);result.intensityLux=typeof value.intensityLux==='number'&&Number.isFinite(value.intensityLux)&&value.intensityLux>=0&&value.intensityLux<=1000000?value.intensityLux:null;
 for(const key of ['managerCell','startedCell','intensityCell'])result[key]=validCell(value[key])?text(value[key]):null;
 result.managerName=text(value.managerName).slice(0,160)||null;
 return result;
}
/** Read the current cage grid by its retained coordinates. Older or
 * unusual layouts remain literal observations, never guessed identities. */
export function cageObservations(position={}){
 const structured=structuredObservation(position.source_cage_observation,position);if(structured)return structured;
 const result=empty(),anchor=text(position.source_cell).match(/^([A-Z]{1,3})([1-9]\d{0,5})$/),range=text(position.source_block_range).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
 if(!anchor)return fallbackObservation(position);
 const row=Number(anchor[2]),col=column(anchor[1]),end=range?Number(range[4]):row+6,width=range?column(range[3])-column(range[1])+1:6;
 // The right-side five-column SPF templates do not share the six-column data layout.
 if(![6,7,8].includes(width)||end-row<6||end-row>7)return fallbackObservation(position);
 const cells=new Map(),comments=new Map();
 for(const line of text(position.source_block_text).split('\n')){const m=line.match(/^([A-Z]{1,3}[1-9]\d{0,5})( comment)?:\s*(.*)$/);if(m)(m[2]?comments:cells).set(m[1],m[3]);}
 // Wider grids merge the animal tag across two/three columns; the final five
 // columns remain note, DOB, left, right and weeks, in that order.
 const noteCol=col+width-5,dobCol=col+width-4,leftCol=col+width-3,rightCol=col+width-2;
 const at=(r,c)=>cells.get(coordinate(r,c))??'',managerCell=coordinate(row-1,leftCol),manager=at(row-1,leftCol);
 if(manager&&!/^(?:mating|genotyping|fixed|male|female|sex|age|dob|date of birth|\(wk\)|weeks?|LD|DD|LL|LP\d+|SP\d+|CLOSE(?:D)?|GUEST)$/i.test(manager)&&!/^\d/.test(manager)){result.managerName=manager.slice(0,160);result.managerCell=managerCell;}
 for(let r=row+1;r<end;r++){
  const sourceCell=coordinate(r,col),tag=at(r,col);if(!tag||date(tag)||/^=|^(?:\(wk\)|weeks?|experiment)$/i.test(tag))continue;
  const note=[at(r,noteCol),comments.get(sourceCell)].filter(Boolean).join('\n');
  const animal=cleanAnimal({tag,note,dateOfBirth:at(r,dobCol),left:at(r,leftCol),right:at(r,rightCol),sourceCell},position,r);if(animal)result.animals.push(animal);
 }
 const startedCell=coordinate(end,col),intensityCell=coordinate(end,noteCol),lux=at(end,noteCol).match(/^\s*(\d+(?:\.\d+)?)\s*(?:lux|lx)\s*$/i);
 result.startedDate=date(at(end,col));result.startedCell=result.startedDate?startedCell:null;
 result.intensityLux=lux&&Number(lux[1])<=1000000?Number(lux[1]):null;result.intensityCell=result.intensityLux!==null?intensityCell:null;
 return result;
}
export function todayTaipei(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function ageWeeks(dob,asOf=todayTaipei()){
 const born=date(dob),today=date(asOf);if(!born||!today||born>today)return null;return Math.floor((Date.parse(today+'T00:00:00Z')-Date.parse(born+'T00:00:00Z'))/604800000);
}
const override=(mouse,key)=>mouse?.cage_sheet_overrides?.[key]===true;
const historical=row=>row?.history_read_only===true||row?.source_historical===true||/^historical_(?:snapshot|assignment)_projection$/.test(row?.record_origin||'');
const currentPosition=position=>active(position)&&position.source_current!==false&&!historical(position)&&Boolean(text(position.location_id));
// Only sanitized observations enter this fingerprint. Capture timestamps are
// excluded so an unchanged daily import does not invalidate an explicit edit.
// Location, row, original identity and observed details must all still agree.
const observationFingerprint=(position,animal,observations)=>JSON.stringify([
 text(position.location_id),animal.sourceCell,animal.tag,animal.note,animal.dateOfBirth,
 animal.earMark,animal.sex,animal.requiresReview,observations.startedDate
]);
function linkedMice(mice,position,animal,observations){
 if(!currentPosition(position)||!animal.sourceCell)return [];
 const fingerprint=observationFingerprint(position,animal,observations);
 return mice.filter(mouse=>!historical(mouse)&&Array.isArray(mouse.cage_sheet_source_links)&&mouse.cage_sheet_source_links.some(link=>
  object(link)&&link.schema_version===1&&link.mouse_sid===text(mouse.mouse_sid)&&link.location_id===text(position.location_id)&&link.source_cell===animal.sourceCell&&link.source_fingerprint===fingerprint));
}
/** Retain deliberate Mouse-editor values and already verified cage links.
 * This is a pure record transformation; source positions and assignments never
 * change. A rename binds only one unique current observation. Any changed source
 * details invalidate that binding rather than identifying a new occupant. */
export function prepareMouseCageSheetEdit(dataset,before,after){
 const result=structuredClone(after);
 if(!object(before)||!object(after)||!text(before.mouse_sid)||text(before.mouse_sid)!==text(after.mouse_sid)||historical(before)||dataset?.history_projection?.read_only===true)return result;
 const fields=['comment','ear_mark','date_of_birth','physical_tag'],changed=fields.filter(field=>text(before[field])!==text(after[field]));
 if(!changed.length)return result;
 result.cage_sheet_overrides={...(object(before.cage_sheet_overrides)?before.cage_sheet_overrides:{}),...(object(after.cage_sheet_overrides)?after.cage_sheet_overrides:{}),...Object.fromEntries(changed.map(field=>[field,true]))};
 if(!changed.includes('physical_tag'))return result;
 const id=text(before.mouse_sid),mice=dataset?.tables?.mice||[];
 // Stable SID uniqueness is required before retaining a prior verification.
 if(mice.filter(mouse=>active(mouse)&&text(mouse.mouse_sid)===id).length!==1)return result;
 const original={...dataset,tables:{...dataset.tables,mice:mice.map(mouse=>text(mouse.mouse_sid)===id?before:mouse)}};
 const positions=(dataset?.tables?.locations||[]).filter(currentPosition),matches=[];
 for(const position of positions){
  if(positions.filter(other=>text(other.location_id)===text(position.location_id)).length!==1)continue;
  const observations=cageObservations(position),rows=cageSheetAnimals(original,{position});
  for(const row of rows.filter(row=>row.matchStatus==='matched'&&row.mouseSid===id)){
   const animal=observations.animals.find(animal=>animal.sourceCell===row.sourceCell&&animal.tag===(row.sourceTag||row.tag));
   if(animal)matches.push({schema_version:1,mouse_sid:id,location_id:text(position.location_id),source_cell:animal.sourceCell,source_tag:animal.tag,source_fingerprint:observationFingerprint(position,animal,observations)});
  }
 }
 // Multiple observations do not establish which cage currently holds a mouse.
 // Do not preserve an old binding when the current evidence is no longer unique.
 result.cage_sheet_source_links=matches.length===1?matches:[];
 return result;
}
function managedRow(mouse,locationId){
 const id=text(mouse.mouse_sid),tag=text(mouse.physical_tag)||id;
 // SoftMouse keeps the genotype/sex prefix separately from its numeric SID.
 const displayTag=/[-\s][MF]$/.test(tag)&&/^\d+$/.test(id)?tag+id:shorthand(tag)&&sex(mouse.sex)&&/^\d+$/.test(id)?`${tag}-${sex(mouse.sex)[0]}${id}`:tag;
 return {key:'mouse:'+id,tag:displayTag,mouseSid:id,dateOfBirth:date(mouse.date_of_birth),earMark:text(mouse.ear_mark)||null,note:text(mouse.comment),sourceNote:'',sex:sex(mouse.sex),sourceCell:null,locationId,matchStatus:'registered'};
}
/** Join only literal unique identifiers. Numeric suffixes and genotype
 * similarity never establish identity, and source rows never move cages. */
export function cageSheetAnimals(dataset,item={}){
 const position=item.position||{},locationId=text(position.location_id)||null;
 const observations=cageObservations(position),mice=(dataset?.tables?.mice||[]).filter(active),index=new Map();
 for(const mouse of mice){const tag=text(mouse.physical_tag),id=text(mouse.mouse_sid);if(!id||!tag)continue;const identifiers=[{value:tag,requiresDob:false}];if(/[-\s][MF]$/.test(tag)&&/^\d+$/.test(id))identifiers.push({value:tag+id,requiresDob:false});if(shorthand(tag)&&sex(mouse.sex)&&/^\d+$/.test(id))identifiers.push({value:`${tag}-${sex(mouse.sex)[0]}${id}`,requiresDob:true});for(const {value,requiresDob} of identifiers){const key=identifierKey(value),matches=index.get(key)||[];if(!matches.some(m=>m.mouse===mouse))matches.push({mouse,requiresDob});index.set(key,matches);}}
 const sourceCounts=new Map();for(const animal of observations.animals){const key=identifierKey(animal.tag);sourceCounts.set(key,(sourceCounts.get(key)||0)+1);}
 const rows=observations.animals.map(animal=>{
  const key=identifierKey(animal.tag),literal=(animal.sourceCell?index.get(key)||[]:[]).filter(m=>!m.requiresDob||(animal.dateOfBirth&&(animal.dateOfBirth===date(m.mouse.date_of_birth)||override(m.mouse,'date_of_birth')))).map(m=>m.mouse),retained=dataset?.history_projection?.read_only===true?[]:linkedMice(mice,position,animal,observations),candidates=[...new Set([...literal,...retained])],unique=candidates.length===1&&sourceCounts.get(key)===1?candidates[0]:null;
  const conflicting=unique&&(unique.state==='Ended'||animal.requiresReview||(animal.sex&&sex(unique.sex)&&animal.sex!==sex(unique.sex))||(animal.dateOfBirth&&date(unique.date_of_birth)&&animal.dateOfBirth!==date(unique.date_of_birth)&&!override(unique,'date_of_birth')));
  const status=candidates.length>1||sourceCounts.get(key)>1?'ambiguous':conflicting?'conflict':unique?'matched':'unlinked',mouse=status==='matched'?unique:null;
  const take=(key,source,stored)=>mouse&&override(mouse,key)?stored:source??stored;
  return {...animal,tag:mouse&&override(mouse,'physical_tag')?managedRow(mouse,locationId).tag:animal.tag,sourceTag:animal.tag,mouseSid:mouse?text(mouse.mouse_sid):null,dateOfBirth:take('date_of_birth',animal.dateOfBirth,mouse?date(mouse.date_of_birth):null),earMark:take('ear_mark',animal.earMark,mouse?text(mouse.ear_mark)||null:null),note:mouse&&override(mouse,'comment')?text(mouse.comment):animal.note||text(mouse?.comment),sourceNote:animal.note,sex:animal.sex||sex(mouse?.sex),locationId,matchStatus:status};
 }).filter(row=>{
  if(row.matchStatus!=='matched')return true;
  const mouse=mice.find(m=>text(m.mouse_sid)===row.mouseSid);
  if(!override(mouse,'cage_sid'))return true;
  const assigned=(dataset.tables.cages||[]).find(c=>active(c)&&text(c.cage_sid)===text(mouse.cage_sid));
  // A deliberate transfer supersedes the old grid display, while the imported
  // observation remains intact for history and review. Never hide an uncertain match.
  return Boolean(assigned&&locationId&&text(assigned.location_id)===locationId);
 });
 if(item.cage){const residents=(item.mice||[]).filter(active).map(mouse=>{
  const saved=managedRow(mouse,locationId),matches=rows.filter(row=>row.matchStatus==='matched'&&row.mouseSid===saved.mouseSid);
  return matches.length===1?{...matches[0],key:saved.key}:saved;
 });
  // Registering a cage for one explicitly transferred animal must not erase
  // other literal occupants, nor silently assign them to the new cage.
  if(locationId&&text(item.cage.cage_sheet_source_location_id)===locationId){
   const residentIds=new Set(residents.map(row=>row.mouseSid));
   return [...residents,...rows.filter(row=>!row.mouseSid||!residentIds.has(row.mouseSid))];
  }
  return residents;
 }
 return rows;
}
