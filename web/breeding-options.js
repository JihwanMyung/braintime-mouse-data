/* Shared breeding-age windows. Age alone does not establish fertility. */
export const DEFAULT_BREEDING_OPTIONS=Object.freeze({schema_version:1,male_min_weeks:8,male_max_weeks:52,female_min_weeks:8,female_max_weeks:32});
const EVENT_ID='BREEDING-OPTIONS';
const fields=['male_min_weeks','male_max_weeks','female_min_weeks','female_max_weeks'];
const editableFields=new Set(fields);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const relevant=record=>record?.event_id===EVENT_ID||record?.event_type==='breeding_options'||record?.breeding_options!==undefined;
const records=dataset=>(dataset?.tables?.husbandry_events||[]).filter(relevant);
const dateValid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const eventDate=now=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const values=value=>Object.fromEntries(fields.map(field=>[field,value[field]]));
const stable=value=>Array.isArray(value)?value.map(stable):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const signature=dataset=>JSON.stringify(stable(records(dataset)));

export function validateBreedingOptions(record,old=null) {
  if(!relevant(record)&&!relevant(old))return [];
  const errors=[];
  if(record?.event_type!=='breeding_options')errors.push('Breeding options must retain their breeding_options event type.');
  if(record?.event_id!==EVENT_ID)errors.push('Breeding options must use their stable BREEDING-OPTIONS ID.');
  if(old?.event_id&&old.event_id!==record?.event_id)errors.push('The saved breeding-options ID cannot change.');
  const value=record?.breeding_options;
  if(!object(value))return [...errors,'Breeding age options are required.'];
  if(value.schema_version!==1)errors.push('Unsupported breeding-options version.');
  for(const sex of ['male','female']) {
    const min=value[`${sex}_min_weeks`],max=value[`${sex}_max_weeks`],label=sex==='male'?'Male':'Female';
    if(typeof min!=='number'||typeof max!=='number'||!Number.isFinite(min)||!Number.isFinite(max)||min<=0||max<=0||min>260||max>260)errors.push(`${label} ages must be numbers greater than 0 and at most 260 weeks.`);
    else if(min>max)errors.push(`${label} minimum age must not exceed its maximum age.`);
  }
  if(!dateValid(record?.event_date))errors.push('A valid breeding-options date is required.');
  return errors;
}

export function getBreedingOptionsStatus(dataset) {
  const matches=records(dataset);
  if(!matches.length)return 'default';
  const record=matches.length===1?matches[0]:null;
  return record&&!archived(record)&&!validateBreedingOptions(record).length?'saved':'invalid';
}

export function getBreedingOptions(dataset) {
  return getBreedingOptionsStatus(dataset)==='saved'?{schema_version:1,...values(records(dataset)[0].breeding_options)}:{...DEFAULT_BREEDING_OPTIONS};
}

export function buildBreedingOptions(dataset,input,options={}) {
  const next=structuredClone(dataset||{tables:{}});
  next.tables??={};next.tables.husbandry_events??=[];
  const matches=records(next);
  if(matches.length>1)throw new Error('Duplicate breeding options must be resolved before editing.');
  const original=matches[0];
  if(original&&original.event_type!=='breeding_options')throw new Error('The breeding-options ID is already used by another record.');
  if(original&&original.event_id!==EVENT_ID)throw new Error('The existing breeding options must use their stable BREEDING-OPTIONS ID before editing.');
  if(original&&archived(original))throw new Error('These breeding options are archived. Restore them before editing.');
  const clock=options.now===undefined?new Date():new Date(options.now);
  if(Number.isNaN(clock.getTime()))throw new Error('A valid modification time is required.');
  const record={...original,event_id:EVENT_ID,event_type:'breeding_options',event_date:options.eventDate??eventDate(clock),record_origin:original?.record_origin||'app_created',app_created_at:original?.app_created_at||clock.toISOString(),app_modified_at:clock.toISOString(),breeding_options:{...original?.breeding_options,schema_version:1,...values(input||{})}};
  const errors=validateBreedingOptions(record,original);
  if(errors.length)throw new Error(errors.join(' '));
  const index=next.tables.husbandry_events.findIndex(row=>row.event_id===EVENT_ID);
  if(index<0)next.tables.husbandry_events.push(record);else next.tables.husbandry_events[index]=record;
  return {record,dataset:next};
}

const mounts=new WeakMap();
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function renderBreedingOptions(container,dataset,hooks) {
  let state=mounts.get(container);
  if(!state){state={draft:null,busy:false,error:'',notice:''};mounts.set(container,state)}
  state.context={dataset,hooks};
  const data=()=>state.context.dataset;
  const api=()=>state.context.hooks;
  const canEdit=()=>api().canEdit?.()===true;
  const current=()=>mounts.get(container)===state;
  const draft=()=>state.draft??(state.draft={values:values(getBreedingOptions(data())),baseline:signature(data())});

  function paint() {
    if(!current())return;
    const editable=canEdit(),disabled=state.busy?' disabled':'',value=(editable&&state.draft?.values)||getBreedingOptions(data());
    container.innerHTML=`<section class="panel breeding-options" aria-labelledby="breeding-options-title"${state.busy?' aria-busy="true"':''}><div class="panel-head"><h2 id="breeding-options-title">Breeding age</h2>${editable?'':'<span class="badge">Read only</span>'}</div>${getBreedingOptionsStatus(data())==='invalid'?'<p class="alert error" role="alert">Saved age options could not be used. Default ranges are shown.</p>':''}${state.error?`<p class="alert error" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p class="banner" role="status">${esc(state.notice)}</p>`:''}${editable?'<form data-breeding-options-form novalidate>':''}<div class="table-scroll"><table><thead><tr><th>Sex</th><th>Minimum (weeks)</th><th>Maximum (weeks)</th></tr></thead><tbody>${['male','female'].map(sex=>{const label=sex==='male'?'Male':'Female';return `<tr><th scope="row">${label}</th>${['min','max'].map(bound=>{const field=`${sex}_${bound}_weeks`;return `<td>${editable?`<input type="number" inputmode="decimal" min="0" max="260" step="any" required aria-label="${label} ${bound==='min'?'minimum':'maximum'} age in weeks" data-breeding-option="${field}" name="${field}" value="${esc(value[field])}"${disabled}>`:esc(value[field])}</td>`}).join('')}</tr>`}).join('')}</tbody></table></div>${editable?`<div class="form-actions panel-body"><button type="submit" class="button primary"${disabled}>Save options</button><button type="button" class="button secondary" data-breeding-options-action="defaults"${disabled}>Restore defaults</button></div></form>`:''}<details class="compact-details panel-body"><summary>Help &amp; references</summary><p>Age alone does not confirm fertility. Adjust these shared windows for strain, health and breeding performance. Both limits are included; missing or invalid birth dates are excluded.</p><p>Defaults: males 8–52 weeks; females 8–32 weeks. These use an 8-week start and approximate upper limits of one year for males and 7–8 months for females.</p><p><a href="https://www.jax.org/jax-mice-and-services/customer-support/technical-support/breeding-and-husbandry-support/colony-planning" target="_blank" rel="noopener noreferrer">JAX colony planning</a> · <a href="https://resources.jax.org/therapeutic-area-essentials/jax-handbook-genetically-standardized-mice" target="_blank" rel="noopener noreferrer">JAX handbook, pp. 242–244</a></p></details></section>`;
  }

  function update(target) {
    if(state.busy||!canEdit())return;
    const field=target.dataset?.breedingOption;
    if(!editableFields.has(field))return;
    draft().values[field]=target.value;state.error='';state.notice='';
  }

  container.oninput=event=>update(event.target);
  container.onchange=event=>update(event.target);
  container.onclick=event=>{
    const target=event.target.closest('[data-breeding-options-action]');
    if(!target||target.disabled||state.busy||!canEdit())return;
    if(target.dataset.breedingOptionsAction!=='defaults')return;
    draft().values=values(DEFAULT_BREEDING_OPTIONS);state.error='';state.notice='Defaults restored in this form. Save options to apply.';paint();
  };
  container.onsubmit=async event=>{
    if(!event.target.matches('[data-breeding-options-form]'))return;
    event.preventDefault();
    if(state.busy)return;
    state.error='';state.notice='';
    try {
      if(!canEdit())throw new Error('Edit access is required.');
      const editing=draft();
      const input=Object.fromEntries(fields.map(field=>{const value=editing.values[field];return [field,typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN]}));
      // Validate before refreshing so an invalid draft never starts a cloud save.
      buildBreedingOptions(data(),input);
      state.busy=true;paint();
      const refreshed=await api().reloadDataset?.();
      if(refreshed?.tables)state.context.dataset=refreshed;
      if(!canEdit())throw new Error('Edit access is required.');
      if(signature(data())!==editing.baseline)throw new Error('Breeding options changed while you were editing. Reopen Options before saving.');
      const built=buildBreedingOptions(data(),input);
      if(typeof api().saveDataset!=='function')throw new Error('Saving is unavailable. Reopen Options.');
      await api().saveDataset(built.dataset);
      state.context.dataset=built.dataset;state.draft=null;
      state.notice='Breeding age options saved.';api().toast?.(state.notice);
    }catch(error){state.error=error?.message||'Breeding options could not be saved.';api().toast?.(state.error,true)}
    finally{state.busy=false;paint()}
  };
  paint();
}
