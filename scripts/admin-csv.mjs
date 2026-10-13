/** Offline, insert-only CSV for an explicitly authorized database administrator.
 * This does not set JWT claims, create users/memberships, or bypass constraints.
 */
export const ADMIN_CSV_COLUMNS=Object.freeze(['colony_id','entity_type','entity_id','payload','version','archived','created_by','updated_by']);
export function checkedUuid(value,label){
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value))throw new Error(`${label} must be an explicit, nonzero UUID verified in the target Supabase project.`);
 return value.toLowerCase();
}
const field=value=>`"${String(value).replaceAll('"','""')}"`;
const recordLine=(entry,colony,owner)=>[colony,entry.entity_type,entry.entity_id,JSON.stringify(entry.payload),1,Boolean(entry.archived),owner,owner].map(field).join(',');
export function buildAdminCsv(entries,colonyId,ownerUserId){
 const colony=checkedUuid(colonyId,'--colony-id'),owner=checkedUuid(ownerUserId,'--owner-user-id');
 const manifests=entries.filter(e=>e.entity_type==='archive'&&e.entity_id==='reconstruction');
 if(manifests.length!==1||entries.at(-1)!==manifests[0])throw new Error('Exactly one reconstruction manifest must be the final record.');
 const seen=new Set();
 const lines=[ADMIN_CSV_COLUMNS.join(',')];
 for(const entry of entries){
  const id=`${entry.entity_type}\u0000${entry.entity_id}`;if(seen.has(id))throw new Error(`Duplicate import ID: ${entry.entity_type}/${entry.entity_id}`);seen.add(id);
  if(typeof entry.entity_id!=='string'||!entry.entity_id)throw new Error('Every import record needs a string ID.');
  lines.push(recordLine(entry,colony,owner));
 }
 return lines.join('\r\n')+'\r\n';
}

/** Exact CSV byte bounds; the manifest is always a separate final upload. */
export function partitionAdminCsv(entries,colonyId,ownerUserId,{maxBytes=1000000,maxRecords=500}={}){
 const colony=checkedUuid(colonyId,'--colony-id'),owner=checkedUuid(ownerUserId,'--owner-user-id');
 if(entries.at(-1)?.entity_type!=='archive'||entries.at(-1)?.entity_id!=='reconstruction')throw new Error('Final manifest is required.');
 const header=ADMIN_CSV_COLUMNS.join(',')+'\r\n',headBytes=Buffer.byteLength(header),files=[];
 let lines=[],records=[],bytes=headBytes;
 const flush=()=>{if(records.length){files.push({csv:header+lines.join(''),records:[...records],manifest:false});lines=[];records=[];bytes=headBytes;}};
 for(const entry of entries.slice(0,-1)){
  const line=recordLine(entry,colony,owner)+'\r\n',size=Buffer.byteLength(line);
  if(headBytes+size>maxBytes)throw new Error(`One CSV row exceeds the batch byte limit: ${entry.entity_type}/${entry.entity_id}`);
  if(records.length&&(bytes+size>maxBytes||records.length>=maxRecords))flush();
  lines.push(line);records.push({entity_type:entry.entity_type,entity_id:entry.entity_id});bytes+=size;
 }
 flush();const manifest=entries.at(-1),manifestCsv=header+recordLine(manifest,colony,owner)+'\r\n';
 if(Buffer.byteLength(manifestCsv)>maxBytes)throw new Error('Manifest exceeds CSV batch byte limit.');
 files.push({csv:manifestCsv,records:[{entity_type:manifest.entity_type,entity_id:manifest.entity_id}],manifest:true});
 return files;
}
