/* Private full-cell archive stored in IndexedDB, never in the app-shell cache. */
const DATABASE='colony-private-history-v1';
let memory;
async function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DATABASE,1);request.onupgradeneeded=()=>request.result.createObjectStore('indexes');request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result)})}
async function transact(action,value,{check,registerCancel}={}){
 const db=await database();try{check?.();}catch(error){db.close();throw error;}
 return new Promise((resolve,reject)=>{
  const tx=db.transaction('indexes',action==='get'?'readonly':'readwrite'),store=tx.objectStore('indexes');
  const request=action==='get'?store.get('active'):action==='put'?store.put(value,'active'):store.delete('active');let result,guardError;
  const cancel=()=>{try{check?.();}catch(error){guardError=error;try{tx.abort();}catch{/* A completed transaction cannot delete a later write. */}}};
  const unregister=registerCancel?.(cancel),finish=()=>{unregister?.();db.close();};
  request.onsuccess=()=>{result=request.result;cancel();};
  tx.oncomplete=()=>{finish();try{check?.();if(guardError)throw guardError;resolve(result);}catch(error){reject(error);}};
  tx.onerror=tx.onabort=()=>{finish();reject(guardError||tx.error||new Error('The history-cache transaction was cancelled.'));};
 });
}
export function validateHistoryIndex(index){if(!index||!Array.isArray(index.sources)||!Array.isArray(index.sheets)||!Array.isArray(index.cells))throw new Error('Expected a compact source-cell index with sources, sheets and cells arrays.');for(const cell of index.cells){if(!Array.isArray(cell)||!Number.isInteger(cell[0])||cell[0]<0||cell[0]>=index.sheets.length||typeof cell[1]!=='string')throw new Error('A source-cell entry has an invalid sheet index or cell coordinate.')}for(const sheet of index.sheets)if(!Number.isInteger(sheet.source_index)||sheet.source_index<0||sheet.source_index>=index.sources.length)throw new Error('A worksheet has an invalid source reference.');return index}
export async function loadHistoryIndex(){if(memory!==undefined)return memory;memory=await transact('get')||null;return memory}
export async function saveHistoryIndex(index,filename='history_cells.json',options={}){options.check?.();validateHistoryIndex(index);const next={index,filename,imported_at:new Date().toISOString()};await transact('put',next,options);options.check?.();memory=next;return memory}
export async function clearHistoryIndex(options={}){await transact('delete',undefined,options);options.check?.();memory=null}
export function searchHistoryIndex(index,query='',offset=0,limit=50){const tokens=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean),rows=[];let total=0;const sourceText=index.sources.map(s=>[s.title,s.snapshot_date].filter(Boolean).join(' ').toLocaleLowerCase()),sheetText=index.sheets.map(s=>[sourceText[s.source_index],s.title,s.export_title].filter(Boolean).join(' '));for(const cell of index.cells){if(tokens.length){const haystack=[sheetText[cell[0]],...cell.slice(1).filter(v=>v!==null&&v!==undefined)].join(' ').toLocaleLowerCase();if(!tokens.every(t=>haystack.includes(t)))continue}if(total>=offset&&rows.length<limit){const sheet=index.sheets[cell[0]],source=index.sources[sheet.source_index];let url=source.url||'';if(/^https:\/\//i.test(url)&&sheet.sheet_id!==null&&sheet.sheet_id!==undefined)url=url.split('#')[0]+`#gid=${encodeURIComponent(sheet.sheet_id)}&range=${encodeURIComponent(cell[1])}`;rows.push({source_title:source.title,source_snapshot_date:source.snapshot_date,source_sheet:sheet.title||sheet.export_title,source_cell:cell[1],raw_value:cell[2],cached_value:cell[3],formula:cell[4],number_format:cell[5],comment:cell[6]??null,source_url:url})}total++}return {total,rows}}
