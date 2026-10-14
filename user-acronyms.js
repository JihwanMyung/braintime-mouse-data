/* User acronyms are display metadata. Original experiment operator values and
 * authentication accounts are never rewritten by this registry. */
const NAME_STATUSES=['full','given_name','unresolved'];
const TYPE='user_acronym_definition',CODE=/^[A-Z][A-Z0-9_-]{0,11}$/,cache=new WeakMap(),mounts=new WeakMap();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),archived=r=>Boolean(r?.app_archived_at)||r?.archived===true;
const eventId=code=>'USER-ACRONYM-'+code;
const dateValid=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const localDate=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parts=value=>{if(typeof value!=='string')return [];const tokens=value.trim().split(/\s*[/+&,;]\s*/);return tokens.length&&tokens.every(v=>CODE.test(v))?[...new Set(tokens)]:[]};
const events=d=>Array.isArray(d?.tables?.husbandry_events)?d.tables.husbandry_events:[];
const sources=d=>Array.isArray(d?.tables?.experiment_sources)?d.tables.experiment_sources:[];
const defaultRow=()=>({code:'JM',name:'Jihwan Myung',notes:'Confirmed by Jihwan Myung.',name_status:'full',historical:false,resolved:true,source:'default',observed_count:0,record:null});
let currentDirectory=[],directoryVersion=0;
// A minimal authenticated directory, kept in memory only. Historical contacts
// and names never enter this shared guide or the colony dataset.
export function setLabUserDirectory(rows=[]){const next=Array.isArray(rows)?rows.filter(r=>CODE.test(r?.code||'')&&typeof r.name==='string').map(r=>({code:r.code,name:r.name})):[];if(JSON.stringify(next)!==JSON.stringify(currentDirectory)){currentDirectory=next;directoryVersion++;}}
export function getLabUserDirectoryVersion(){return directoryVersion;}

export function validateUserAcronym(record,old=null){
 const relevant=record?.event_type===TYPE||record?.user_acronym!==undefined||old?.event_type===TYPE||old?.user_acronym!==undefined;if(!relevant)return [];
 const errors=[],p=record?.user_acronym;if(record?.event_type!==TYPE)errors.push('A user acronym must retain its user_acronym_definition event type.');
 if(!object(p))return [...errors,'A user acronym definition is required.'];
 if(typeof p.code!=='string'||!CODE.test(p.code))errors.push('Use 1–12 uppercase letters, digits, underscores or hyphens for the acronym, starting with a letter.');
 if(!NAME_STATUSES.includes(p.name_status??'full'))errors.push('Choose full name, given name only, or unresolved.');
 if(p.name_status!=='unresolved'&&(typeof p.name!=='string'||!p.name.trim()||p.name.length>200))errors.push('Enter the recorded user name (up to 200 characters).');
 if(p.name_status==='unresolved'&&p.name!=null&&p.name!=='')errors.push('An unresolved user name must remain blank.');
 if(p.historical!=null&&typeof p.historical!=='boolean')errors.push('Historical user visibility must be true or false.');
 if(p.notes!=null&&(typeof p.notes!=='string'||p.notes.length>2000))errors.push('User acronym notes must be text of at most 2,000 characters.');
 if(record.event_id!==eventId(p.code))errors.push('A user acronym must use its stable acronym ID.');
 if(old?.user_acronym?.code&&old.user_acronym.code!==p.code)errors.push('A saved user acronym cannot change.');
 if(old?.event_id&&old.event_id!==record.event_id)errors.push('A saved user acronym ID cannot change.');
 if(!dateValid(record.event_date))errors.push('A valid user-acronym definition date is required.');
 return errors;
}

function registry(dataset){
 const h=events(dataset),s=sources(dataset),prior=dataset&&cache.get(dataset);if(prior&&prior.h===h&&prior.s===s&&prior.hLength===h.length&&prior.sLength===s.length)return prior;
 const map=new Map([['JM',defaultRow()]]),saved=new Map();
 for(const record of h){if(record?.event_type!==TYPE||archived(record)||validateUserAcronym(record).length)continue;const p=record.user_acronym,prev=saved.get(p.code);if(!prev||String(record.app_modified_at||record.event_date)>=String(prev.app_modified_at||prev.event_date))saved.set(p.code,record)}
 for(const [code,record] of saved){const p=record.user_acronym;map.set(code,{code,name:p.name,notes:p.notes??'',name_status:p.name_status??'full',historical:p.historical===true,resolved:!!p.name&&p.name_status!=='unresolved',source:'defined',observed_count:0,record})}
 const observe=value=>{for(const code of parts(value)){if(!map.has(code))map.set(code,{code,name:null,notes:'',name_status:'unresolved',historical:true,resolved:false,source:'observed',observed_count:0,record:null});map.get(code).observed_count++}};
 for(const record of h){observe(record.experiment?.operator);observe(record.experiment_sample?.operator);if(record.event_type!==TYPE)observe(record.operator)}
 for(const source of s)observe(source.operator);
 const result={h,s,hLength:h.length,sLength:s.length,map,rows:[...map.values()].sort((a,b)=>a.code.localeCompare(b.code))};if(object(dataset))cache.set(dataset,result);return result;
}
/** Cached for immutable dataset snapshots; source observations are scanned once. */
export function getUserAcronyms(dataset,{includeHistorical=false}={}){const rows=registry(dataset).rows.filter(row=>includeHistorical||!row.historical);if(!includeHistorical&&!rows.some(row=>row.code==='JM'))rows.push(defaultRow());for(const user of currentDirectory){const index=rows.findIndex(r=>r.code===user.code),row={...defaultRow(),...user,source:'directory',notes:'',record:null};if(index<0)rows.push(row);else rows[index]=row;}return rows.sort((a,b)=>a.code.localeCompare(b.code))}
export function userLabel(value,dataset,{includeHistorical=false}={}){if(value==null)return null;const raw=String(value),codes=parts(raw),map=new Map(getUserAcronyms(dataset,{includeHistorical}).map(row=>[row.code,row]));if(!codes.length||!codes.some(code=>map.get(code)?.resolved))return raw;return raw+' · '+codes.map(code=>map.get(code)?.name||code).join(' / ')}
export function userAcronymHelpHTML(dataset,options={}){const rows=getUserAcronyms(dataset,options);return `<h3>User acronyms</h3><p>User identifies the person recorded for an experiment or sample. The owner maintains current names in Settings → Lab members. Original codes are retained.</p><div class="table-scroll"><table><thead><tr><th>Acronym</th><th>User</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.code)}</td><td>${esc(row.name||'Name not yet confirmed')}${row.name_status==='given_name'?' <span class="badge">Given name only</span>':''}</td></tr>`).join('')}</tbody></table></div>`}
export function buildUserAcronym(dataset,input,options={}){
 const code=typeof input?.code==='string'?input.code.trim().toUpperCase():input?.code,next=structuredClone(dataset||{tables:{}});next.tables??={};next.tables.husbandry_events??=[];
 const matches=next.tables.husbandry_events.filter(r=>r.event_id===eventId(code));if(matches.length>1)throw new Error('Duplicate user acronyms must be resolved before editing.');const old=matches[0];
 if(old&&old.event_type!==TYPE)throw new Error('The user acronym ID is already used by another record.');if(old&&archived(old))throw new Error('This user acronym is archived. Restore it before editing.');
 const now=options.now===undefined?new Date():new Date(options.now);if(!Number.isFinite(now.getTime()))throw new Error('A valid modification time is required.');
 const record={...old,event_id:eventId(code),event_type:TYPE,event_date:options.eventDate??localDate(now),record_origin:old?.record_origin||'app_created',app_created_at:old?.app_created_at||now.toISOString(),app_modified_at:now.toISOString(),user_acronym:{code,name:typeof input.name==='string'?input.name.trim():input.name,notes:typeof input.notes==='string'?input.notes.trim():input.notes??'',name_status:input.name_status??old?.user_acronym?.name_status??'full',historical:input.historical??old?.user_acronym?.historical??false}};
 const errors=validateUserAcronym(record,old);if(errors.length)throw new Error(errors.join(' '));const index=next.tables.husbandry_events.findIndex(r=>r.event_id===record.event_id);if(index<0)next.tables.husbandry_events.push(record);else next.tables.husbandry_events[index]=record;return {record,dataset:next};
}
export const buildUserAcronymDefinition=buildUserAcronym;
const values=row=>({code:row?.code??'',name:row?.name??'',notes:row?.notes??'',name_status:row?.name_status??'full',historical:row?.historical??false});
const signature=row=>JSON.stringify(row?{...values(row),record:row.record}:null);
export function renderUserAcronyms(container,dataset,hooks={}){
 let state=mounts.get(container);if(!state){state={drafts:new Map(),busy:false,error:'',notice:''};mounts.set(container,state)}state.context={dataset,hooks};
 const data=()=>state.context.dataset,api=()=>state.context.hooks,canEdit=()=>api().canEdit?.()===true,includeHistorical=()=>typeof api().includeHistorical==='function'?api().includeHistorical()===true:api().includeHistorical===true,visible=()=>getUserAcronyms(data(),{includeHistorical:includeHistorical()});
 function input(code,key,value,disabled){return key==='notes'?`<textarea aria-label="Notes for ${esc(code)}" data-user-code="${esc(code)}" data-user-field="notes" maxlength="2000" rows="2"${disabled}>${esc(value)}</textarea>`:`<input aria-label="${key==='name'?'Name':'New acronym'}${code==='__new'?'':' for '+esc(code)}" data-user-code="${esc(code)}" data-user-field="${key}" value="${esc(value)}" maxlength="${key==='code'?12:200}"${disabled}>`}
 function statusInput(code,p,disabled){return `<select aria-label="Name completeness for ${esc(code)}" data-user-code="${esc(code)}" data-user-field="name_status"${disabled}>${NAME_STATUSES.map(value=>`<option value="${value}"${value===p.name_status?' selected':''}>${{full:'Full name',given_name:'Given name only',unresolved:'Name not confirmed'}[value]}</option>`).join('')}</select>`}
 function paint(){const editable=canEdit(),disabled=state.busy?' disabled':'';container.innerHTML=`<section class="panel" aria-labelledby="user-acronyms-title"${state.busy?' aria-busy="true"':''}><div class="panel-head"><h2 id="user-acronyms-title">User acronyms</h2>${editable?'':'<span class="badge">Read only</span>'}</div>${state.error?`<p class="alert error" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p class="banner" role="status">${esc(state.notice)}</p>`:''}<div class="table-scroll"><table><thead><tr><th>Acronym</th><th>User</th><th>Notes</th>${editable?'<th></th>':''}</tr></thead><tbody>${visible().map(row=>{const p=state.drafts.get(row.code)?.values||values(row);return `<tr><td><strong>${esc(row.code)}</strong>${row.resolved?'':'<div class="small muted">Name not yet confirmed</div>'}</td>${editable?`<td>${input(row.code,'name',p.name,disabled)}${statusInput(row.code,p,disabled)}</td><td>${input(row.code,'notes',p.notes,disabled)}</td><td><button type="button" class="button secondary" data-user-action="save" data-user-code="${esc(row.code)}"${disabled}>Save ${esc(row.code)}</button></td>`:`<td>${esc(row.name||'Name not yet confirmed')}</td><td>${esc(row.notes)}</td>`}</tr>`}).join('')}${editable?(()=>{const p=state.drafts.get('__new')?.values||values(null);return `<tr><td>${input('__new','code',p.code,disabled)}</td><td>${input('__new','name',p.name,disabled)}${statusInput('__new',p,disabled)}</td><td>${input('__new','notes',p.notes,disabled)}</td><td><button type="button" class="button secondary" data-user-action="save" data-user-code="__new"${disabled}>Add acronym</button></td></tr>`})():''}</tbody></table></div></section>`}
 function update(target){if(state.busy||!canEdit())return;const code=target.dataset?.userCode,key=target.dataset?.userField;if(!['name','notes','name_status',...(code==='__new'?['code']:[])].includes(key))return;const row=visible().find(r=>r.code===code);if(!row&&code!=='__new')return;let draft=state.drafts.get(code);if(!draft){draft={values:values(row),baseline:signature(row)};state.drafts.set(code,draft)}draft.values[key]=target.value;state.error='';state.notice=''}
 container.oninput=event=>update(event.target);container.onchange=event=>update(event.target);
 container.onclick=async event=>{const target=event.target.closest('[data-user-action]');if(!target||target.disabled||state.busy||target.dataset.userAction!=='save')return;event.preventDefault?.();state.error='';state.notice='';try{if(!canEdit())throw new Error('Edit access is required.');const code=target.dataset.userCode,row=visible().find(r=>r.code===code);if(!row&&code!=='__new')throw new Error('Choose an acronym from the registry.');const draft=state.drafts.get(code)||{values:values(row),baseline:signature(row)};state.busy=true;paint();const refreshed=await api().reloadDataset?.();if(refreshed?.tables)state.context.dataset=refreshed;if(!canEdit())throw new Error('Edit access is required.');const latest=visible().find(r=>r.code===code);if(signature(latest)!==draft.baseline)throw new Error('This user acronym changed while you were editing. Reopen Settings before saving.');if(code==='__new'&&getUserAcronyms(data(),{includeHistorical:true}).some(r=>r.code===draft.values.code.trim().toUpperCase()))throw new Error('This acronym is already registered. Ask the owner if it is not visible.');const built=buildUserAcronym(data(),draft.values);if(typeof api().saveDataset!=='function')throw new Error('Saving is unavailable. Reopen Settings.');await api().saveDataset(built.dataset);state.context.dataset=built.dataset;state.drafts.delete(code);state.notice=`${built.record.user_acronym.code} user acronym saved.`;api().toast?.(state.notice)}catch(error){state.error=error?.message||'The user acronym could not be saved.';api().toast?.(state.error,true)}finally{state.busy=false;paint()}};
 paint();
}
