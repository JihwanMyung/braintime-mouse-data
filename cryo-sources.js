/* Read-only reconstruction of cryopreservation source tables.
 * Reported historical balances are never current, verified inventory.
 * A case with several batch IDs retains one aggregate count.
 */
const text=value=>value===null||value===undefined?'':String(value);
const clean=value=>text(value).trim();
const unique=values=>[...new Set(values)];
const normalizeHeader=value=>clean(value).toLowerCase().replace(/[\s_/-]+/g,'');
const HEADERS={
  case_id:['案件編號','Case ID','Case number'],strain:['品系','Strain','Line'],background:['遺傳背景','Genetic background','Background'],
  modification_method:['基改方式','Modification method'],gene:['基因名稱','Gene','Gene names','Genotype'],zygosity:['合子型','Zygosity'],origin:['來源','Origin'],
  batch_ids_raw:['麥管批號','Straw batch','Straw batch IDs','Batch IDs'],frozen_date:['冷凍日期','Freezing date','Frozen date'],
  reported_remaining:['結餘管數','Remaining straws','Remaining quantity'],prepared_by:['製表人 / 發行人','Prepared by','Preparer / issuer'],service_reference:['實驗鼠種原庫服務','Service reference']
};
const FIELD_BY_HEADER=new Map(Object.entries(HEADERS).flatMap(([field,labels])=>labels.map(label=>[normalizeHeader(label),field])));
const isCryoSheet=name=>/cryo|冷凍|凍存/i.test(text(name));
const isTransfer=value=>/^strains?\s+to\s+transfer\b|待轉移品系|預計轉移品系/i.test(clean(value));
const columnNumber=column=>[...column].reduce((sum,char)=>sum*26+char.charCodeAt(0)-64,0);
const sourceIdentity=source=>JSON.stringify([source.file_id||source.title,source.sheet,source.cell,source.snapshot_date,source.archive_sha256||'']);
const observationIdentity=record=>sourceIdentity(record.source)+JSON.stringify({...record,source:undefined});
const safeUrl=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:'';}catch{return '';}};

function date(value) {
  const match=/^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(clean(value));
  if(!match)return null;
  const parsed=new Date(`${match[1]}T00:00:00Z`);return Number.isFinite(+parsed)&&parsed.toISOString().slice(0,10)===match[1]?match[1]:null;
}
function quantity(value) {
  if(value===null||value===undefined||clean(value)==='')return null;
  if(typeof value!=='number'&&!/^\d+(?:\.0+)?$/.test(clean(value)))return null;
  const number=Number(value);return Number.isSafeInteger(number)&&number>=0?number:null;
}
function cellValue(cell) {
  if(!cell)return null;
  const raw=cell[2];return typeof raw==='string'&&raw.trim().startsWith('=')?cell[3]??null:raw??cell[3]??null;
}
function sourceFor(file,sheet,cell) {
  let url=safeUrl(file.url);
  if(url&&sheet.sheet_id!==null&&sheet.sheet_id!==undefined)url=url.split('#')[0]+`#gid=${encodeURIComponent(sheet.sheet_id)}&range=${encodeURIComponent(cell)}`;
  return {title:text(file.title)||'Loaded source archive',sheet:text(sheet.title||sheet.export_title),cell,url,file_id:text(file.file_id),archive_sha256:text(file.archive_sha256),snapshot_date:date(file.snapshot_date),snapshot_date_basis:text(file.snapshot_date_basis)||'unknown'};
}
const stableOrder=(a,b)=>text(a.source.snapshot_date).localeCompare(text(b.source.snapshot_date))||sourceIdentity(a.source).localeCompare(sourceIdentity(b.source));
const contentKey=cells=>JSON.stringify([...cells].sort((a,b)=>a[1].localeCompare(b[1])).map(cell=>cell.slice(1)));

function rowRecord(row,columns,source) {
  const value=field=>cellValue(row.get(columns.get(field)));
  const record={case_id:clean(value('case_id')),strain:text(value('strain')),background:text(value('background')),modification_method:text(value('modification_method')),gene:text(value('gene')),zygosity:text(value('zygosity')),origin:text(value('origin')),batch_ids_raw:text(value('batch_ids_raw')),frozen_date:date(value('frozen_date')),reported_remaining:quantity(value('reported_remaining')),reported_remaining_raw:value('reported_remaining'),quantity_unit:'straws',prepared_by:text(value('prepared_by')),service_reference:clean(value('service_reference')),material:null,storage_location:null,source,warnings:[]};
  record.batch_ids=unique(record.batch_ids_raw.split(/[,;，；]/).map(value=>value.trim()).filter(Boolean));
  record.raw_cells=[...row.values()].map(cell=>({cell:cell[1],raw_value:cell[2]??null,cached_value:cell[3]??null,formula:cell[4]??null,number_format:cell[5]??null,comment:cell[6]??null}));
  if(clean(value('frozen_date'))&&!record.frozen_date)record.warnings.push('The source freezing date could not be parsed; inspect the original cell.');
  if(clean(record.reported_remaining_raw)!==''&&record.reported_remaining===null)record.warnings.push('The source count is not a nonnegative whole number; no quantity was inferred.');
  if(typeof value('service_reference')==='number'&&!Number.isSafeInteger(value('service_reference')))record.warnings.push('The numeric service reference may have lost precision in the source export.');
  return record;
}

function parseSheet(file,sheet,cells) {
  const rows=new Map();
  for(const cell of cells){const match=/^([A-Z]+)(\d+)$/.exec(text(cell[1]));if(!match)continue;const row=Number(match[2]);if(!rows.has(row))rows.set(row,new Map());rows.get(row).set(match[1],cell);}
  const ordered=[...rows].sort((a,b)=>a[0]-b[0]);let headerRow=null,columns=null,transferRow=null;
  for(const [number,row] of ordered) {
    if([...row.values()].some(cell=>isTransfer(cellValue(cell))))transferRow=transferRow===null?number:Math.min(transferRow,number);
    if(headerRow!==null)continue;
    const candidate=new Map();for(const [column,cell] of row){const field=FIELD_BY_HEADER.get(normalizeHeader(cellValue(cell)));if(field)candidate.set(field,column);}
    if(candidate.has('case_id')&&candidate.has('strain')){headerRow=number;columns=candidate;}
  }
  const observations=[],plans=[];
  if(headerRow!==null)for(const [number,row] of ordered) {
    if(number<=headerRow||transferRow!==null&&number>=transferRow)continue;
    const caseId=clean(cellValue(row.get(columns.get('case_id'))));if(!caseId||caseId===clean(cellValue(rows.get(headerRow).get(columns.get('case_id')))))continue;
    const maxColumn=[...row.keys()].sort((a,b)=>columnNumber(b)-columnNumber(a))[0];
    const source=sourceFor(file,sheet,`${columns.get('case_id')}${number}:${maxColumn}${number}`),record=rowRecord(row,columns,source);
    if(record.strain)observations.push(record);
  }
  if(transferRow!==null)for(const [number,row] of ordered) {
    if(number<=transferRow)continue;
    const order=cellValue(row.get('A')),strain=text(cellValue(row.get('B')));
    if(quantity(order)===null||!strain.trim())continue;
    plans.push({strain,tag_text:text(cellValue(row.get('C'))),sex_text:text(cellValue(row.get('D'))),source_order:order,source:sourceFor(file,sheet,`A${number}:D${number}`)});
  }
  return {observations,plans,recognized:headerRow!==null||transferRow!==null};
}

function groupCases(observations) {
  const groups=new Map();
  for(const observation of observations) {
    const key=JSON.stringify([observation.case_id,[...observation.batch_ids].sort()]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(observation);
  }
  const caseGroupCounts=new Map();for(const snapshots of groups.values())caseGroupCounts.set(snapshots[0].case_id,(caseGroupCounts.get(snapshots[0].case_id)||0)+1);
  return [...groups].map(([key,records])=>{
    const seen=new Set(),snapshots=records.filter(record=>{const id=observationIdentity(record);if(seen.has(id))return false;seen.add(id);return true;}).sort(stableOrder),latest=snapshots.at(-1);
    const withCounts=snapshots.filter(record=>record.reported_remaining!==null),newestCount=withCounts.at(-1),newestDate=newestCount?.source.snapshot_date;
    const tiedCounts=withCounts.filter(record=>record.source.snapshot_date===newestDate),candidates=unique(tiedCounts.map(record=>record.reported_remaining));
    const {source,raw_cells,...fields}=latest,warnings=unique(snapshots.flatMap(record=>record.warnings));
    if(candidates.length>1)warnings.push('Equally dated sources report different remaining counts; no single balance was selected.');
    else if(unique(withCounts.map(record=>record.reported_remaining)).length>1)warnings.push('Reported balances change between snapshots. The latest dated report is shown; the difference is not interpreted as usage.');
    if(caseGroupCounts.get(latest.case_id)>1)warnings.push('This case appears with different full batch lists. Reconcile these source groups before treating them as separate stock.');
    if(!latest.batch_ids.length)warnings.push('No batch identifiers were recorded.');
    if(!withCounts.length)warnings.push('No remaining-straw count was recorded; blank is not zero.');
    return {...fields,id:`cryo-source:${key}`,status:'source_recorded',reported_remaining:candidates.length===1?candidates[0]:null,reported_quantity_candidates:candidates,reported_quantity_source:candidates.length===1?newestCount.source:null,source_snapshot_date:source.snapshot_date,source_snapshot_date_basis:source.snapshot_date_basis,source_snapshots:snapshots,sources:snapshots.map(record=>record.source),warnings};
  }).sort((a,b)=>a.case_id.localeCompare(b.case_id)||a.id.localeCompare(b.id));
}

function groupPlans(observations) {
  const plans=new Map();
  for(const row of observations){const key=JSON.stringify([row.strain,row.tag_text,row.sex_text]);if(!plans.has(key))plans.set(key,[]);plans.get(key).push(row);}
  return [...plans].map(([key,records])=>{
    const seen=new Set(),snapshots=records.filter(record=>{const id=observationIdentity(record);if(seen.has(id))return false;seen.add(id);return true;}).sort(stableOrder),latest=snapshots.at(-1),{source,...fields}=latest;
    return {...fields,id:`cryo-plan:${key}`,status:'planned_transfer',source_snapshot_date:source.snapshot_date,source_snapshot_date_basis:source.snapshot_date_basis,source_snapshots:snapshots,sources:snapshots.map(record=>record.source)};
  }).sort((a,b)=>a.source_order-b.source_order||a.strain.localeCompare(b.strain));
}

function partialSources(dataset,covered) {
  const partials=[],seen=new Set();
  for(const row of dataset?.tables?.historical_observations||[]) {
    if(!isCryoSheet(row.source_sheet))continue;
    const source={title:text(row.source_title||row.source_filename),sheet:text(row.source_sheet),cell:text(row.source_cell),url:safeUrl(row.source_url),file_id:text(row.source_file_id),archive_sha256:text(row.source_archive_sha256),snapshot_date:date(row.source_snapshot_date),snapshot_date_basis:text(row.source_snapshot_date_basis)||'unknown'};
    if(covered.has(JSON.stringify([source.file_id||source.title,source.sheet])))continue;
    const id=`cryo-partial:${sourceIdentity(source)}`,identity=id+text(row.raw_text);if(seen.has(identity))continue;seen.add(identity);
    partials.push({id,text:text(row.raw_text),...source,source_snapshot_date:source.snapshot_date,source_snapshot_date_basis:source.snapshot_date_basis,status:'partial_source_excerpt',case_id:null,batch_ids:[],reported_remaining:null,material:null,storage_location:null});
  }
  return partials;
}

/** Pure discovery. Does not create lots, assign donors or alter balances.
 * Sources are deduplicated by exact case + complete batch list, never by strain.
 */
export function discoverCryoSources(dataset,historyIndex=null) {
  const valid=Boolean(historyIndex&&Array.isArray(historyIndex.sources)&&Array.isArray(historyIndex.sheets)&&Array.isArray(historyIndex.cells));
  const targetSheets=new Map(),covered=new Set(),versions=new Set(),observations=[],planObservations=[];let sourceSheetCount=0;
  if(valid) {
    historyIndex.sheets.forEach((sheet,index)=>{if(isCryoSheet(sheet?.title||sheet?.export_title)&&historyIndex.sources[sheet.source_index])targetSheets.set(index,[]);});
    for(const cell of historyIndex.cells)if(Array.isArray(cell)&&targetSheets.has(cell[0]))targetSheets.get(cell[0]).push(cell);
    for(const [index,cells] of targetSheets) {
      const sheet=historyIndex.sheets[index],file=historyIndex.sources[sheet.source_index],parsed=parseSheet(file,sheet,cells);
      if(!parsed.recognized)continue;sourceSheetCount++;versions.add(contentKey(cells));
      covered.add(JSON.stringify([text(file.file_id)||text(file.title),text(sheet.title||sheet.export_title)]));
      observations.push(...parsed.observations);planObservations.push(...parsed.plans);
    }
  }
  const groups=groupCases(observations),plans=groupPlans(planObservations),partials=partialSources(dataset,covered),warnings=[];
  if(groups.length)warnings.push('Remaining counts are historical source reports, not verified current inventory. Source snapshot dates may be copy/export dates rather than inventory checks.','A count attached to several batch IDs is one case-level aggregate; it is not assigned to each batch.','Material, storage location, availability and donor identities are not inferred from batch prefixes, line names or historical link candidates.');
  if(plans.length)warnings.push('Strains to transfer are plans, not completed cryopreservation or available frozen stock.');
  if(partials.length)warnings.push('The available historical excerpts omit case IDs, counts or table context. Load the full-cell archive for structured cases; excerpts are not imported as inventory.');
  return {groups,plans,partials,warnings,coverage:{source_sheet_count:sourceSheetCount,distinct_content_versions:versions.size,case_observation_count:observations.length,unique_case_count:new Set(groups.map(group=>group.case_id)).size,group_count:groups.length,plan_observation_count:planObservations.length,unique_plan_count:plans.length,partial_record_count:partials.length,full_index_available:valid}};
}
