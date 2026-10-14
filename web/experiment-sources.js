// Imported observations are evidence. Exact tag matches remain candidates until
// reviewed. Caches follow immutable snapshots; replaced arrays or changed lengths
// also invalidate them during incremental source loading.
const sourceCaches=new WeakMap(),mouseCaches=new WeakMap();
const EMPTY=Object.freeze([]),array=x=>Array.isArray(x)?x:EMPTY;
const normalized=value=>String(value??'').normalize('NFKC').replace(/[′’]/g,"'").trim().toLowerCase();
const url=value=>{try{const result=new URL(value);return ['http:','https:'].includes(result.protocol)?result.href:null}catch{return null}};
function sheetUrl(fileId,sheetId,range,fallback) {
  if(typeof fileId==='string'&&/^[A-Za-z0-9_-]+$/.test(fileId)&&/^\d+$/.test(String(sheetId??''))) {
    const base=`https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/edit?gid=${encodeURIComponent(sheetId)}#gid=${encodeURIComponent(sheetId)}`;
    return base+(typeof range==='string'&&range?'&range='+encodeURIComponent(range):'');
  }
  return url(fallback);
}
function catalogState(dataset) {
  if(!dataset||typeof dataset!=='object')return {input:[],catalog:[],contexts:[],rows:[],byId:new Map(),byContext:new Map()};
  const rows=array(dataset.tables?.experiment_sources),catalog=array(dataset.tables?.experiment_source_catalog),contexts=array(dataset.tables?.experiment_source_contexts);
  let cache=sourceCaches.get(dataset);
  if(!cache||cache.input!==rows||cache.inputLength!==rows.length||cache.catalog!==catalog||cache.catalogLength!==catalog.length||cache.contexts!==contexts||cache.contextLength!==contexts.length) {
    cache={input:rows,inputLength:rows.length,catalog,catalogLength:catalog.length,contexts,contextLength:contexts.length,
      byId:new Map(catalog.map((r,i)=>[r?.file_id??r?.workbook_id,{...r,catalog_index:i}])),byContext:new Map(contexts.map(r=>[r?.context_id,r])),rows:null};
    sourceCaches.set(dataset,cache);
  }
  return cache;
}
function reference(tuple,cache,fallback={}) {
  if(!Array.isArray(tuple))return null;
  const [index,sheetId,sheetName,range]=tuple,catalog=cache.catalog[index];if(!catalog)return null;
  const fileId=catalog.file_id??catalog.workbook_id;
  return {workbook_id:fileId??null,workbook_title:catalog.title??catalog.workbook_title??null,sheet_id:sheetId??null,sheet_name:sheetName??null,range:range??null,
    snapshot_date:catalog.snapshot_date??null,archive_sha256:catalog.archive_sha256??null,
    source_url:sheetUrl(fileId,sheetId,range,catalog.url??catalog.source_url??fallback.source_url)};
}
function primarySource(source,cache) {
  const ref=reference(source.provenance_refs?.[0],cache,source),catalog=cache.byId.get(source.workbook_id);
  const fileId=source.workbook_id??ref?.workbook_id,sheetId=source.sheet_id??ref?.sheet_id,range=source.range??ref?.range;
  return {...source,workbook_id:fileId??null,sheet_id:sheetId??null,sheet_name:source.sheet_name??ref?.sheet_name??null,range:range??null,
    workbook_title:source.workbook_title??source.title??ref?.workbook_title??catalog?.title??null,
    snapshot_date:source.snapshot_date??ref?.snapshot_date??catalog?.snapshot_date??null,
    archive_sha256:source.archive_sha256??ref?.archive_sha256??catalog?.archive_sha256??null,
    source_url:sheetUrl(fileId,sheetId,range,source.source_url??ref?.source_url??catalog?.url)};
}
/** Only primary display metadata is cached for all observations. */
export function experimentSources(dataset) {
  const cache=catalogState(dataset);if(!cache.rows)cache.rows=cache.input.filter(row=>row&&typeof row.source_id==='string').map(row=>primarySource(row,cache));return cache.rows;
}
/** Large shared preparation context and all references expand on inspect/review. */
export function hydrateExperimentSource(source,dataset) {
  if(!source)return null;
  const cache=catalogState(dataset),primary=primarySource(source,cache),context=cache.byContext.get(source.context_id);
  const provenance=array(source.provenance).length?structuredClone(source.provenance).map(r=>Object.hasOwn(r,'source_url')?{...r,source_url:url(r.source_url)}:r):array(source.provenance_refs).map(tuple=>reference(tuple,cache,source)).filter(Boolean);
  const rawValues=structuredClone(source.raw_values??{});if(context?.values)rawValues.preparation=structuredClone(context.values);
  return {...primary,raw_values:rawValues,provenance};
}
export function sourceAnimalCandidates(identifier,dataset) {
  const key=normalized(identifier);if(!key||!dataset||typeof dataset!=='object')return [];
  const mice=array(dataset.tables?.mice);let cache=mouseCaches.get(dataset);
  if(!cache||cache.input!==mice||cache.length!==mice.length) {
    const index=new Map();
    for(const mouse of mice)for(const alias of new Set([mouse?.mouse_sid,mouse?.physical_tag,mouse?.alternate_id].map(normalized).filter(Boolean))) {
      const matches=index.get(alias)??[];if(!matches.some(existing=>existing.mouse_sid===mouse.mouse_sid))matches.push(mouse);index.set(alias,matches);
    }
    cache={input:mice,length:mice.length,index};mouseCaches.set(dataset,cache);
  }
  return [...(cache.index.get(key)??[])];
}
export function sourceParticipants(source,dataset) {
  // WB/IHC names identify specimens, not animals. Preserve them as source sample
  // labels until the user links or registers the corresponding specimen.
  if(source?.identifier_kind==='sample_label')return [];
  return [...new Set(array(source?.raw_identifiers).filter(value=>typeof value==='string'&&value.trim()))].map(raw=>({mouse_sid:null,raw_identifier:raw,link_status:'unresolved',candidate_sids:sourceAnimalCandidates(raw,dataset).map(mouse=>mouse.mouse_sid),role:null,notes:null}));
}
export function reviewedSourceMap(dataset) {
  // Archival never turns reviewed evidence into a new experiment to import.
  const result=new Map();for(const record of array(dataset?.tables?.husbandry_events))if(record?.event_type==='experiment'&&record.source_id)result.set(record.source_id,record);return result;
}
export function sourceProvenance(source,dataset) {
  const expanded=hydrateExperimentSource(source,dataset);
  return {record_origin:'reviewed_experiment_sheet',source_id:source.source_id,source_title:expanded.workbook_title??null,source_sheet:expanded.sheet_name??null,source_range:expanded.range??null,
    source_url:expanded.source_url??null,source_sha256:source.content_hash??expanded.archive_sha256??null,source_snapshot_date:expanded.snapshot_date??null,
    source_refs:structuredClone(expanded.provenance??[]),source_raw_values:structuredClone(expanded.raw_values??{}),source_observation:structuredClone(source)};
}
