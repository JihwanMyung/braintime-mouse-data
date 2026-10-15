import { getStrainRegistry, buildStrainDefinition, INSERTION_TYPES, strainNamingHelpHTML } from './strain-registry.js?v=36';

const mounts=new WeakMap();
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const editableFields=new Set(['insertion_type','stock_reference','notes']);
const values=row=>({code:row.key,insertion_type:row.insertionType,stock_reference:row.stockReference||'',notes:row.notes||''});
const signature=row=>JSON.stringify(values(row));

export function renderStrainManagement(container,dataset,hooks) {
  let state=mounts.get(container);
  if(!state){state={drafts:new Map(),busy:false,error:'',notice:''};mounts.set(container,state)}
  state.context={dataset,hooks};
  const data=()=>state.context.dataset;
  const api=()=>state.context.hooks;
  const canEdit=()=>api().canEdit?.()===true;
  const current=()=>mounts.get(container)===state;

  function paint() {
    if(!current())return;
    const editable=canEdit(),disabled=state.busy?' disabled':'';
    container.innerHTML=`<section class="panel strain-management" aria-labelledby="strain-management-title"${state.busy?' aria-busy="true"':''}><div class="panel-head"><h2 id="strain-management-title">Strain registry</h2>${editable?'':'<span class="badge">Read only</span>'}</div>${state.error?`<p class="alert error" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p class="banner" role="status">${esc(state.notice)}</p>`:''}<div class="table-scroll"><table><thead><tr><th>Code / strain</th><th>Modification</th><th>Stock reference</th><th>Notes</th>${editable?'<th></th>':''}</tr></thead><tbody>${getStrainRegistry(data()).map(row=>{
      const value=state.drafts.get(row.key)?.values||values(row),code=esc(row.key),label=esc(`${row.key} (${row.name})`),meta=`data-strain-code="${code}"`;
      return `<tr><td><strong>${code}</strong><div>${esc(row.name)}</div></td>${editable?`<td><select aria-label="Modification for ${label}" data-strain-field="insertion_type" ${meta}${disabled}>${INSERTION_TYPES.map(({value:key,label:name})=>`<option value="${key}"${key===value.insertion_type?' selected':''}>${esc(name)}</option>`).join('')}</select></td><td><input aria-label="Stock reference for ${label}" data-strain-field="stock_reference" ${meta} value="${esc(value.stock_reference)}" maxlength="500"${disabled}></td><td><textarea aria-label="Notes for ${label}" data-strain-field="notes" ${meta} maxlength="2000" rows="2"${disabled}>${esc(value.notes)}</textarea></td><td><button type="button" class="button secondary" data-strain-action="save" ${meta}${disabled}>Save ${code}</button></td>`:`<td>${esc(INSERTION_TYPES.find(row=>row.value===value.insertion_type)?.label||'Unknown')}</td><td>${esc(value.stock_reference||'Not recorded')}</td><td>${esc(value.notes||'')}</td>`}</tr>`;
    }).join('')}</tbody></table></div><details class="compact-details panel-body"><summary>Strain names &amp; modification types</summary>${strainNamingHelpHTML()}<p>Transgenic: random insertion of an introduced construct. Knock-in: targeted modification at a defined genomic locus, including conditional floxed alleles. Unknown: the local stock has not been classified.</p><p>These properties describe the strain. An individual mouse still needs its own genotype call. Prime (′) means homozygous; parentheses mean undetermined until genotyping.</p></details></section>`;
  }

  function update(target) {
    if(state.busy||!canEdit())return;
    const code=target.dataset?.strainCode,field=target.dataset?.strainField;
    if(!editableFields.has(field))return;
    const row=getStrainRegistry(data()).find(row=>row.key===code);if(!row)return;
    let draft=state.drafts.get(code);
    if(!draft){draft={values:values(row),baseline:signature(row)};state.drafts.set(code,draft)}
    draft.values[field]=target.value;state.error='';state.notice='';
  }

  container.oninput=event=>update(event.target);
  container.onchange=event=>update(event.target);
  container.onclick=async event=>{
    const target=event.target.closest('[data-strain-action]');if(!target||target.disabled||state.busy)return;
    if(target.dataset.strainAction!=='save')return;
    state.error='';state.notice='';
    try {
      if(!canEdit())throw new Error('Edit access is required.');
      const code=target.dataset.strainCode,row=getStrainRegistry(data()).find(row=>row.key===code);
      if(!row)throw new Error('Choose a strain from the registry.');
      const draft=state.drafts.get(code)||{values:values(row),baseline:signature(row)};
      state.busy=true;paint();
      const refreshed=await api().reloadDataset?.();
      if(refreshed?.tables)state.context.dataset=refreshed;
      if(!canEdit())throw new Error('Edit access is required.');
      const latest=getStrainRegistry(data()).find(row=>row.key===code);
      if(signature(latest)!==draft.baseline)throw new Error('This strain changed while you were editing. Reopen the strain registry before saving.');
      const built=buildStrainDefinition(data(),draft.values);
      if(typeof api().saveDataset!=='function')throw new Error('Saving is unavailable. Reopen the strain registry.');
      await api().saveDataset(built.dataset);
      state.context.dataset=built.dataset;state.drafts.delete(code);
      state.notice=`${code} strain definition saved.`;api().toast?.(state.notice);
    }catch(error){state.error=error?.message||'The strain definition could not be saved.';api().toast?.(state.error,true)}
    finally{state.busy=false;paint()}
  };
  paint();
}
