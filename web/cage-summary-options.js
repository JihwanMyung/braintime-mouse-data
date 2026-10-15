/* Shared room mapping and verified physical capacity for the cage summary. */
export const CAGE_SUMMARY_GROUPS=Object.freeze([
  Object.freeze({key:'beh',label:'Animal Beh locobox',unit:'locoboxes'}),
  Object.freeze({key:'rat',label:'Rat room locobox',unit:'locoboxes'}),
  Object.freeze({key:'clean',label:'Clean room',unit:'cages'}),
  Object.freeze({key:'spf',label:'SPF room',unit:'cages'})
]);
const EVENT_ID='CAGE-SUMMARY-OPTIONS';
const groupKeys=new Set(CAGE_SUMMARY_GROUPS.map(group=>group.key));
const boxGroups=new Set(['beh','rat']);
const modes=new Set(['unknown','cage','position','box_id']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const relevant=record=>record?.event_id===EVENT_ID||record?.event_type==='cage_summary_options'||record?.cage_summary_options!==undefined;
const records=dataset=>(dataset?.tables?.husbandry_events||[]).filter(relevant);
const rooms=dataset=>(dataset?.tables?.rooms||[]).filter(room=>!archived(room));
const dateValid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const localDate=now=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const stable=value=>Array.isArray(value)?value.map(stable):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const signature=dataset=>JSON.stringify(stable(records(dataset)));
const values=value=>({schema_version:1,groups:Object.fromEntries(CAGE_SUMMARY_GROUPS.map(({key})=>[key,{room_ids:[...(value?.groups?.[key]?.room_ids||[])],capacity:value?.groups?.[key]?.capacity,...(boxGroups.has(key)?{locobox_mode:value?.groups?.[key]?.locobox_mode==='unknown'?'cage':value?.groups?.[key]?.locobox_mode}:{}),...(key==='beh'?{temporary_storage_location_ids:[...(value?.groups?.beh?.temporary_storage_location_ids||[])]}:{})}]))});

function defaultOptions(dataset) {
  const result={schema_version:1,groups:Object.fromEntries(CAGE_SUMMARY_GROUPS.map(({key})=>[key,{room_ids:[],capacity:null,...(boxGroups.has(key)?{locobox_mode:'cage'}:{}),...(key==='beh'?{temporary_storage_location_ids:[]}:{})}]))};
  const match={beh:/^(?:sh\s+)?(?:ani|animal)\s+beh$/i,rat:/^rat\s+room(?:\s*\d+|\s*\(\s*locoboxes\s*\)(?:\s*,\s*rat\s+room\s*\d+)?)?$/i,clean:/^(?:shlac[-\s]*)?clean\s+room(?:\s*\d+)?$/i,spf:/^(?:shlac[-\s]*)?spf(?:\s*,?\s*room\s*\d*)?$/i};
  const eligible=rooms(dataset);
  for(const room of eligible) {
    if(typeof room.room_id!=='string'||!room.room_id.trim()||eligible.filter(other=>other.room_id===room.room_id).length!==1)continue;
    const name=String(room.name||'').trim().replace(/\s+/g,' '),matches=CAGE_SUMMARY_GROUPS.filter(({key})=>match[key].test(name));
    if(matches.length===1)result.groups[matches[0].key].room_ids.push(room.room_id);
  }
  return result;
}

function positionReference(dataset,id) {
  const tables=dataset?.tables||{},matches=(tables.locations||[]).filter(position=>position.location_id===id);
  if(matches.length!==1||archived(matches[0]))return null;
  const position=matches[0];let rack=null;
  if(position.rack_id!==undefined&&position.rack_id!==null&&position.rack_id!==''){
    const racks=(tables.racks||[]).filter(row=>row.rack_id===position.rack_id);
    if(racks.length!==1||archived(racks[0]))return null;
    rack=racks[0];
  }
  const roomIds=[...new Set([position.room_id,rack?.room_id].filter(value=>value!==undefined&&value!==null&&value!==''))];
  if(roomIds.length!==1||typeof roomIds[0]!=='string'||!roomIds[0].trim())return null;
  const matchingRooms=(tables.rooms||[]).filter(room=>room.room_id===roomIds[0]);
  if(matchingRooms.length!==1||archived(matchingRooms[0]))return null;
  return {position,rack,room:matchingRooms[0]};
}

function roomReferenceErrors(dataset,value) {
  const active=rooms(dataset),errors=[];
  for(const {key,label} of CAGE_SUMMARY_GROUPS)for(const id of value?.groups?.[key]?.room_ids||[]) {
    const matches=active.filter(room=>room.room_id===id);
    if(matches.length!==1)errors.push(`${label}: select an existing, unarchived room with a unique ID (${id}).`);
  }
  for(const id of value?.groups?.beh?.temporary_storage_location_ids||[]) {
    const reference=positionReference(dataset,id);
    if(!reference||!value.groups.beh.room_ids.includes(reference.room.room_id))errors.push(`Ani Beh temporary storage: select an existing, unarchived position with a unique ID and consistent room/rack references in the selected Ani Beh rooms (${id}).`);
  }
  return errors;
}

export function validateCageSummaryOptions(record,old=null) {
  if(!relevant(record)&&!relevant(old))return [];
  const errors=[];
  if(record?.event_type!=='cage_summary_options')errors.push('Cage options must retain their cage_summary_options event type.');
  if(record?.event_id!==EVENT_ID)errors.push('Cage options must use their stable CAGE-SUMMARY-OPTIONS ID.');
  if(old?.event_id&&old.event_id!==record?.event_id)errors.push('The saved cage-options ID cannot change.');
  const value=record?.cage_summary_options;
  if(!object(value))return [...errors,'Cage summary options are required.'];
  if(value.schema_version!==1)errors.push('Unsupported cage-options version.');
  if(!object(value.groups))return [...errors,'Cage summary groups are required.'];
  const assigned=new Set();
  for(const {key,label} of CAGE_SUMMARY_GROUPS) {
    const group=value.groups[key];
    if(!object(group)){errors.push(`${label} options are required.`);continue}
    if(!Array.isArray(group.room_ids)||group.room_ids.some(id=>typeof id!=='string'||!id.trim()))errors.push(`${label}: room IDs must be an array of nonempty strings.`);
    else for(const id of group.room_ids){if(assigned.has(id))errors.push(`${label}: a room can be assigned only once across the summary groups.`);assigned.add(id)}
    if(group.capacity!==null&&(!Number.isInteger(group.capacity)||group.capacity<0||group.capacity>100000))errors.push(`${label}: capacity must be a whole number from 0 to 100000, or blank for unknown.`);
    if(boxGroups.has(key)&&!modes.has(group.locobox_mode))errors.push(`${label}: choose a supported locobox counting mode.`);
    if(key==='beh'&&group.temporary_storage_location_ids!==undefined){
      const ids=group.temporary_storage_location_ids;
      if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length)errors.push('Ani Beh temporary storage position IDs must be an array of unique nonempty strings.');
    }
  }
  if(!dateValid(record?.event_date))errors.push('A valid cage-options date is required.');
  return errors;
}

export function getCageSummaryOptionsStatus(dataset) {
  const matches=records(dataset);
  if(!matches.length)return 'default';
  const record=matches.length===1?matches[0]:null;
  return record&&!archived(record)&&!validateCageSummaryOptions(record).length&&!roomReferenceErrors(dataset,record.cage_summary_options).length?'saved':'invalid';
}

export function getCageSummaryOptions(dataset) {
  return getCageSummaryOptionsStatus(dataset)==='saved'?values(records(dataset)[0].cage_summary_options):defaultOptions(dataset);
}

export function buildCageSummaryOptions(dataset,input,options={}) {
  const next=structuredClone(dataset||{tables:{}});
  next.tables??={};next.tables.husbandry_events??=[];
  const matches=records(next);
  if(matches.length>1)throw new Error('Duplicate cage options must be resolved before editing.');
  const original=matches[0];
  if(original&&original.event_type!=='cage_summary_options')throw new Error('The cage-options ID is already used by another record.');
  if(original&&original.event_id!==EVENT_ID)throw new Error('The existing cage options must use their stable CAGE-SUMMARY-OPTIONS ID before editing.');
  if(original&&archived(original))throw new Error('These cage options are archived. Restore them before editing.');
  const clock=options.now===undefined?new Date():new Date(options.now);
  if(Number.isNaN(clock.getTime()))throw new Error('A valid modification time is required.');
  const groupValues=Object.fromEntries(CAGE_SUMMARY_GROUPS.map(({key})=>[key,{...original?.cage_summary_options?.groups?.[key],room_ids:structuredClone(input?.groups?.[key]?.room_ids),capacity:input?.groups?.[key]?.capacity,...(boxGroups.has(key)?{locobox_mode:input?.groups?.[key]?.locobox_mode}:{}),...(key==='beh'?{temporary_storage_location_ids:structuredClone(input?.groups?.beh?.temporary_storage_location_ids===undefined?original?.cage_summary_options?.groups?.beh?.temporary_storage_location_ids??[]:input.groups.beh.temporary_storage_location_ids)}:{})}]));
  const record={...original,event_id:EVENT_ID,event_type:'cage_summary_options',event_date:options.eventDate??localDate(clock),record_origin:original?.record_origin||'app_created',app_created_at:original?.app_created_at||clock.toISOString(),app_modified_at:clock.toISOString(),cage_summary_options:{...original?.cage_summary_options,schema_version:1,groups:{...original?.cage_summary_options?.groups,...groupValues}}};
  const errors=validateCageSummaryOptions(record,original);
  if(errors.length)throw new Error(errors.join(' '));
  const references=roomReferenceErrors(next,record.cage_summary_options);
  if(references.length)throw new Error(references.join(' '));
  const index=next.tables.husbandry_events.findIndex(row=>row.event_id===EVENT_ID);
  if(index<0)next.tables.husbandry_events.push(record);else next.tables.husbandry_events[index]=record;
  return {record,dataset:next};
}

const mounts=new WeakMap();
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const modeLabels={cage:'One LocoBox per occupied cage',position:'One box per registered position',box_id:'Group positions by Locobox ID'};

export function renderCageSummaryOptions(container,dataset,hooks) {
  let state=mounts.get(container);
  if(!state){state={draft:null,busy:false,error:'',notice:''};mounts.set(container,state)}
  state.context={dataset,hooks};
  const data=()=>state.context.dataset,api=()=>state.context.hooks;
  const canEdit=()=>api().canEdit?.()===true;
  const current=()=>mounts.get(container)===state;
  const draft=()=>state.draft??(state.draft={values:getCageSummaryOptions(data()),baseline:signature(data())});

  function storagePositions(group,editable,disabled) {
    const selected=group.temporary_storage_location_ids||[],choices=new Map();
    const label=reference=>[reference.room.name||reference.room.room_id,reference.rack?.name||reference.rack?.rack_id||'No rack',reference.position.label||reference.position.location_id].join(' / ');
    for(const position of data()?.tables?.locations||[]){
      const reference=positionReference(data(),position.location_id);
      if(reference&&group.room_ids.includes(reference.room.room_id))choices.set(position.location_id,label(reference));
    }
    for(const id of selected)if(!choices.has(id)){
      const reference=positionReference(data(),id);
      choices.set(id,(reference?label(reference):id)+' · Review position or room');
    }
    const entries=[...choices].sort((a,b)=>a[1].localeCompare(b[1],undefined,{numeric:true}));
    return `<div class="field"><div role="group" aria-label="Ani Beh temporary storage positions"><details><summary>Temporary storage (${selected.length} selected)</summary><p class="small muted">Selected positions are excluded from the LocoBox count.</p>${editable?(entries.length?`<div class="cage-summary-room-list">${entries.map(([id,text])=>`<label class="cage-summary-room-choice"><input type="checkbox" data-cage-summary-group="beh" data-cage-summary-field="temporary_storage_location_ids" data-location-id="${esc(id)}" value="${esc(id)}"${selected.includes(id)?' checked':''}${disabled}> <span>${esc(text)}</span></label>`).join('')}</div>`:'<p class="subtle">No positions in the selected Ani Beh rooms.</p>'):`<p>${entries.filter(([id])=>selected.includes(id)).map(([,text])=>esc(text)).join('<br>')||'None selected'}</p>`}</details></div></div>`;
  }

  function paint() {
    if(!current())return;
    const editable=canEdit(),disabled=state.busy?' disabled':'',value=(editable&&state.draft?.values)||getCageSummaryOptions(data()),available=rooms(data());
    container.innerHTML=`<section class="panel cage-summary-options" aria-labelledby="cage-summary-options-title"${state.busy?' aria-busy="true"':''}><div class="panel-head"><h2 id="cage-summary-options-title">Cage capacity</h2>${editable?'':'<span class="badge">Read only</span>'}</div>${getCageSummaryOptionsStatus(data())==='invalid'?'<p class="alert error" role="alert">Saved cage options could not be used. Check room assignments and capacities before saving.</p>':''}${state.error?`<p class="alert error" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p class="banner" role="status">${esc(state.notice)}</p>`:''}${editable?'<form data-cage-summary-options-form novalidate>':''}<div class="panel-body cage-summary-options-grid">${CAGE_SUMMARY_GROUPS.map(({key,label,unit})=>{const group=value.groups[key];return `<fieldset><legend>${esc(label)}</legend><div class="cage-summary-room-list" role="group" aria-label="${esc(label)} rooms">${editable?(available.length?available.map(room=>`<label class="cage-summary-room-choice"><input type="checkbox" data-cage-summary-group="${key}" data-cage-summary-field="room_ids" data-room-id="${esc(room.room_id)}" value="${esc(room.room_id)}"${group.room_ids.includes(room.room_id)?' checked':''}${disabled}> <span>${esc(room.name||room.room_id)}</span></label>`).join(''):'<p class="subtle">Add rooms in Housing to assign them here.</p>'):`<p>${group.room_ids.map(id=>esc(available.find(room=>room.room_id===id)?.name||id)).join(', ')||'No rooms assigned'}</p>`}</div><div class="field"><label for="cage-summary-${key}-capacity">Total capacity (${boxGroups.has(key)?unit:'cage slots'})</label>${editable?`<input id="cage-summary-${key}-capacity" type="number" inputmode="numeric" min="0" max="100000" step="1" name="${key}_capacity" data-cage-summary-group="${key}" data-cage-summary-field="capacity" value="${esc(group.capacity??'')}" placeholder="Not set"${disabled}>`:`<p>${group.capacity===null?'Not set':esc(group.capacity)} ${unit}</p>`}</div>${boxGroups.has(key)?`<div class="field"><label for="cage-summary-${key}-mode">Count locoboxes by</label>${editable?`<select id="cage-summary-${key}-mode" name="${key}_locobox_mode" data-cage-summary-group="${key}" data-cage-summary-field="locobox_mode"${disabled}>${Object.entries(modeLabels).map(([mode,text])=>`<option value="${mode}"${group.locobox_mode===mode?' selected':''}>${text}</option>`).join('')}</select>`:`<p>${esc(modeLabels[group.locobox_mode])}</p>`}</div>`:''}${key==='beh'?storagePositions(group,editable,disabled):''}</fieldset>`}).join('')}</div>${editable?`<div class="form-actions panel-body"><button type="submit" class="button primary"${disabled}>Save options</button></div></form>`:''}<details class="compact-details panel-body"><summary>Help</summary><p>These shared options map each summary group to one or more rooms. A room can belong to only one group. Suggested room assignments use explicit room names; verify them before saving.</p><p>For Ani Beh and Rat room, enter the number of physical locoboxes. The default is one LocoBox per occupied cage. Rat room cages are LocoBoxes; Ani Beh temporary storage positions are excluded. If your layout groups cages differently, choose one box per position or enter a shared Locobox ID on positions in Housing. Positions in the same room with the same Locobox ID represent one box.</p><p>For Clean room and SPF room, capacity means cage slots, not mice per cage. Leave capacity blank when unknown; zero explicitly means no capacity. Empty formatted cells in an Animal Sheet do not establish capacity.</p></details></section>`;
  }

  function update(target) {
    if(state.busy||!canEdit())return;
    const key=target.dataset?.cageSummaryGroup,field=target.dataset?.cageSummaryField;
    if(!groupKeys.has(key)||!['room_ids','capacity','locobox_mode','temporary_storage_location_ids'].includes(field))return;
    if(field==='locobox_mode'&&!boxGroups.has(key)||field==='temporary_storage_location_ids'&&key!=='beh')return;
    const group=draft().values.groups[key];
    if(field==='room_ids'){
      const id=target.dataset?.roomId;
      if(typeof id!=='string'||!rooms(data()).some(room=>room.room_id===id))return;
      group.room_ids=target.checked?[...new Set([...group.room_ids,id])]:group.room_ids.filter(room=>room!==id);
    }else if(field==='temporary_storage_location_ids'){
      const id=target.dataset?.locationId,reference=typeof id==='string'?positionReference(data(),id):null;
      if(typeof id!=='string'||(target.checked&&(!reference||!group.room_ids.includes(reference.room.room_id))))return;
      group.temporary_storage_location_ids=target.checked?[...new Set([...group.temporary_storage_location_ids,id])]:group.temporary_storage_location_ids.filter(location=>location!==id);
    }else group[field]=target.value;
    state.error='';state.notice='';
    if(field==='room_ids')paint();
  }
  container.oninput=event=>update(event.target);
  container.onchange=event=>update(event.target);
  container.onsubmit=async event=>{
    if(!event.target.matches('[data-cage-summary-options-form]'))return;
    event.preventDefault();
    if(state.busy)return;
    state.error='';state.notice='';
    try {
      if(!canEdit())throw new Error('Edit access is required.');
      const editing=draft(),input=structuredClone(editing.values);
      for(const {key} of CAGE_SUMMARY_GROUPS){const raw=input.groups[key].capacity;input.groups[key].capacity=raw===null||typeof raw==='string'&&raw.trim()===''?null:typeof raw==='number'?raw:typeof raw==='string'?Number(raw):NaN}
      buildCageSummaryOptions(data(),input);
      state.busy=true;paint();
      const refreshed=await api().reloadDataset?.();
      if(refreshed?.tables)state.context.dataset=refreshed;
      if(!canEdit())throw new Error('Edit access is required.');
      if(signature(data())!==editing.baseline)throw new Error('Cage options changed while you were editing. Reopen Options before saving.');
      const built=buildCageSummaryOptions(data(),input);
      if(typeof api().saveDataset!=='function')throw new Error('Saving is unavailable. Reopen Options.');
      await api().saveDataset(built.dataset);
      state.context.dataset=built.dataset;state.draft=null;
      state.notice='Cage capacity options saved.';api().toast?.(state.notice);
    }catch(error){state.error=error?.message||'Cage options could not be saved.';api().toast?.(state.error,true)}
    finally{state.busy=false;paint()}
  };
  paint();
}
