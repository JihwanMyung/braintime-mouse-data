const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

// Integrity detects damaged files; it is not a signature or proof of provenance.
// The caller must retain the normal local-import preview and confirmation.
export async function datasetFromLocalBackup(parsed){
 if(!object(parsed))throw new Error('Expected a reconstructed JSON with tables.mice.');
 if(parsed.kind!=='braintime-local-backup'){
  if(!object(parsed.tables)||!Array.isArray(parsed.tables.mice))throw new Error('Expected a reconstructed JSON with tables.mice.');
  return parsed;
 }
 if(parsed.full_workspace!==true||parsed.permission?.level!=='max')throw new Error('This is a partial backup. It cannot replace the workspace; its records require a reviewed merge.');
 if(parsed.schema_version!==1||parsed.application!=='mouse-data'||parsed.restore_mode!=='workspace'||!object(parsed.permission)||parsed.permission.cutoff_date!==null||!date(parsed.permission.as_of_date)||!object(parsed.sections)||Object.keys(parsed.sections).join(',')!=='workspace'||!object(parsed.sections.workspace)||parsed.sections.workspace.source_archive_restricted||!object(parsed.sections.workspace.tables)||!Array.isArray(parsed.sections.workspace.tables.mice))throw new Error('The full backup format could not be verified.');
 const {integrity,...envelope}=parsed;
 if(!object(integrity)||integrity.algorithm!=='SHA-256'||integrity.encoding!=='JSON.stringify of envelope without integrity'||!/^([0-9a-f]{64})$/.test(integrity.value||''))throw new Error('The backup integrity check is missing or unsupported.');
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(envelope)));
 const actual=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
 if(actual!==integrity.value)throw new Error('The backup integrity check failed. Use an unchanged backup file.');
 return parsed.sections.workspace;
}
