import {ID_FIELDS} from './model.js';

export const ARCHIVE_MANIFEST_FORMAT='colony-archive-manifest-v1';
export const ARCHIVE_CHUNK_FORMAT='colony-archive-chunk-v1';
export const MAX_ARCHIVE_PAYLOAD_BYTES=250000;
export const MAX_RPC_BYTES=1000000;
const encoder=new TextEncoder();
export const utf8Size=value=>encoder.encode(typeof value==='string'?value:canonicalStringify(value)).length;
export const isArchiveChunk=record=>record.entity_type==='archive'&&/^chunk:[a-f0-9]{64}$/.test(record.entity_id??'');
export function canonicalStringify(value){
  if(Array.isArray(value))return `[${value.map(v=>canonicalStringify(v)??'null').join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function digest(text){
  if(!globalThis.crypto?.subtle)throw new Error('Secure hashing requires HTTPS or localhost.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
const record=(id,payload)=>({entity_type:'archive',entity_id:id,payload,archived:false});

/** Content-addressed table chunks are immutable; the versioned manifest selects a snapshot. */
export async function encodeArchive(dataset){
  const metadata={...dataset,tables:{}},manifest={},chunks=[],seenChunks=new Set();
  for(const [table,value] of Object.entries(dataset.tables??{})){
    if(Object.hasOwn(ID_FIELDS,table))continue;
    if(!Array.isArray(value)){Object.defineProperty(metadata.tables,table,{value,enumerable:true,writable:true,configurable:true});continue;}
    const descriptor={row_count:value.length,chunk_ids:[]};Object.defineProperty(manifest,table,{value:descriptor,enumerable:true});
    let rows=[],texts=[];
    const empty={format:ARCHIVE_CHUNK_FORMAT,table,rows:[]},overhead=utf8Size(empty);
    let bytes=overhead;
    async function flush(){
      if(!rows.length)return;
      const payload={format:ARCHIVE_CHUNK_FORMAT,table,rows};
      const encoded=`{"format":${JSON.stringify(ARCHIVE_CHUNK_FORMAT)},"rows":[${texts.join(',')}],"table":${JSON.stringify(table)}}`;
      const id=`chunk:${await digest(encoded)}`;
      descriptor.chunk_ids.push(id);if(!seenChunks.has(id)){chunks.push(record(id,payload));seenChunks.add(id);}rows=[];texts=[];bytes=overhead;
    }
    for(const row of value){
      const text=canonicalStringify(row)??'null',size=utf8Size(text);
      if(overhead+size>MAX_ARCHIVE_PAYLOAD_BYTES)throw new Error(`One ${table} source row exceeds the ${MAX_ARCHIVE_PAYLOAD_BYTES}-byte archive chunk limit; no data was uploaded.`);
      if(bytes+size+(rows.length?1:0)>MAX_ARCHIVE_PAYLOAD_BYTES)await flush();
      bytes+=size+(rows.length?1:0);rows.push(row);texts.push(text);
    }
    await flush();
  }
  metadata.archive_format=ARCHIVE_MANIFEST_FORMAT;metadata.archive_tables=manifest;
  if(utf8Size(metadata)>MAX_ARCHIVE_PAYLOAD_BYTES)throw new Error('Reconstruction metadata exceeds the 250,000-byte limit; no data was uploaded.');
  return [...chunks,record('reconstruction',metadata)];
}

/** Reject missing, duplicate, truncated or corrupted referenced chunks before exposing data. */
export async function decodeArchive(records){
  const candidates=records.filter(r=>r.entity_type==='archive'&&r.entity_id==='reconstruction');
  if(candidates.length!==1)throw new Error('Exactly one reconstruction manifest is required.');
  const head=candidates[0];if(head.archived)throw new Error('The reconstruction manifest cannot be archived.');
  const metadata=structuredClone(head.payload);
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw new Error('The reconstruction archive is invalid.');
  if(metadata.archive_format&&metadata.archive_format!==ARCHIVE_MANIFEST_FORMAT)throw new Error('This reconstruction archive format is not supported.');
  if(metadata.archive_format!==ARCHIVE_MANIFEST_FORMAT)return metadata;
  if(!metadata.archive_tables||typeof metadata.archive_tables!=='object'||Array.isArray(metadata.archive_tables))throw new Error('The reconstruction chunk manifest is invalid.');
  const byId=new Map();
  for(const r of records.filter(isArchiveChunk)){
    if(byId.has(r.entity_id))throw new Error('Duplicate archive chunk received.');byId.set(r.entity_id,r);
  }
  metadata.tables??={};
  for(const [table,descriptor] of Object.entries(metadata.archive_tables)){
    if(Object.hasOwn(ID_FIELDS,table)||!descriptor||!Number.isSafeInteger(descriptor.row_count)||descriptor.row_count<0||!Array.isArray(descriptor.chunk_ids))throw new Error(`Invalid archive descriptor for ${table}.`);
    const rows=[];
    for(const id of descriptor.chunk_ids){
      const chunk=byId.get(id),p=chunk?.payload;
      if(!chunk||chunk.archived||p?.format!==ARCHIVE_CHUNK_FORMAT||p.table!==table||!Array.isArray(p.rows))throw new Error(`Missing or invalid archive chunk ${id}; pull was not saved.`);
      const text=canonicalStringify(p);
      if(utf8Size(text)>MAX_ARCHIVE_PAYLOAD_BYTES||`chunk:${await digest(text)}`!==id)throw new Error(`Archive chunk checksum mismatch: ${id}; pull was not saved.`);
      for(const row of p.rows)rows.push(row);
    }
    if(rows.length!==descriptor.row_count)throw new Error(`Archive row count mismatch for ${table}; pull was not saved.`);
    Object.defineProperty(metadata.tables,table,{value:rows,enumerable:true,writable:true,configurable:true});
  }
  delete metadata.archive_format;delete metadata.archive_tables;return metadata;
}

/** Bound both change count and the complete RPC envelope, including its colony UUID. */
export function partitionChanges(changes,{maxBytes=MAX_RPC_BYTES,maxRecords=200}={}){
  const batches=[];let batch=[],bytes=utf8Size({p_colony_id:'00000000-0000-0000-0000-000000000000',p_changes:[]});
  const overhead=bytes;
  for(const change of changes){
    const size=utf8Size(change);
    if(overhead+size>maxBytes)throw new Error(`Record ${change.entity_type}/${change.entity_id} exceeds the RPC size limit.`);
    if(batch.length&&(batch.length>=maxRecords||bytes+size+1>maxBytes)){batches.push(batch);batch=[];bytes=overhead;}
    bytes+=size+(batch.length?1:0);batch.push(change);
  }
  if(batch.length)batches.push(batch);return batches;
}
