/* Runtime discovery only. Source labels are evidence, not a strain registry.
 * No private colony records are included in this module.
 * Ai32 and Ai96 are alternative Gt(ROSA)26Sor alleles:
 * https://www.jax.org/strain/012569  https://www.jax.org/strain/024106
 */
import {canonicalStrainName,strainNameAliases,FLOX_STRAIN_NAMES,strainNamingWarning,explicitCreName,legacyVgatCreName} from './strain-registry.js?v=36';
const string=value=>typeof value==='string'?value:'';
const unique=values=>[...new Set(values)];
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const NAME_PATTERN=/(?:PER\d\s*:{1,2}\s*LUC|Bmal1-ELuc|[A-Za-z][A-Za-z0-9]*-(?:Cre(?:ERT?2?)?|tTA\d*)|Ai\d+|APP\s*\/\s*PS1|(?:Bmal1|Meis1|Vgat)(?:[- ]+flox(?:ed)?)?)/gi;
const GENERIC_CALL=/(?:^|[,;\n])\s*([A-Za-z][A-Za-z0-9_:./-]{1,60})\s*\([^()]*\)/g;
const IGNORED_NAMES=new Set(['wt','wildtype','wild-type','unknown','none','na','n/a','null']);
const evidenceText=value=>value.split('\n').map(line=>/^\s*PER\d\s*:{1,2}\s*LUC/i.test(line)?line:line.replace(/^\s*\$?[A-Z]{1,3}\$?\d+(?:\s+comment)?\s*:\s+/,'' )).filter(line=>!/^\s*=/.test(line)).join('\n');
const PUBLIC_IDS=new Map(['PER2::LUC','Bmal1-ELuc','Avp-Cre','Vip-Cre','FoxJ1-Cre','GAD67-tTA','Bmal1','Meis1','Vgat','APP/PS1'].map(name=>[name,name.toLowerCase().replace(/[^a-z0-9]+/g,'-')]));
for(const name of FLOX_STRAIN_NAMES)PUBLIC_IDS.set(name,name.slice(0,-5).toLowerCase());
const catalogId=name=>['Ai32','Ai96'].includes(name)?'rosa26':PUBLIC_IDS.get(name)||`locus:${name}`;
const sheetIndexes=new WeakMap();

function canonicalName(value) {
  const name=string(value).trim().replace(/\s*:\s*:\s*|\s*:\s*/g,'::').replace(/\s*\/\s*/g,'/');
  if(/^per\d::luc$/i.test(name))return name.toUpperCase();
  const common={'bmal1-eluc':'Bmal1-ELuc','avp-cre':'Avp-Cre','vip-cre':'Vip-Cre','foxj1-cre':'FoxJ1-Cre','gad67-tta':'GAD67-tTA','bmal1':'Bmal1','meis1':'Meis1','vgat':'Vgat','app/ps1':'APP/PS1'};
  if(FLOX_STRAIN_NAMES.includes(canonicalStrainName(name))||canonicalStrainName(name)==='FoxJ1-Cre')return canonicalStrainName(name);
  if(common[name.toLowerCase()])return common[name.toLowerCase()];
  if(/^ai\d+$/i.test(name))return 'Ai'+name.slice(2);
  return name;
}

function namedMentions(text,structured=false) {
  text=evidenceText(text);
  const found=new Map();
  const add=label=>{const name=canonicalName(label);if(name&&!IGNORED_NAMES.has(name.toLowerCase()))found.set(JSON.stringify([name,label.trim()]),{name,label:label.trim()});};
  for(const match of text.matchAll(NAME_PATTERN)) {
    const before=text[match.index-1]||'',after=text[match.index+match[0].length]||'';
    // Uppercase AI13 etc. in archived cell references are not Ai reporter names.
    if(!structured&&/^ai\d+$/i.test(match[0])&&!/^Ai\d+$/.test(match[0])&&!/^\s*\(\s*(?:[+-]|fl\b|WT\b)/i.test(text.slice(match.index+match[0].length)))continue;
    if(!/[A-Za-z0-9_]/.test(before)&&!/[A-Za-z0-9_-]/.test(after))add(match[0]);
  }
  if(structured) {
    for(const match of text.matchAll(GENERIC_CALL))add(match[1]);
    for(const token of text.split(/[,;\n]/))if(/^[A-Za-z][A-Za-z0-9_:./-]{1,60}$/.test(token.trim()))add(token.trim());
  }
  return [...found.values()];
}

function sourceOf(row={},fallback={}) {
  return {title:string(row.source_title||row.source_filename||fallback.source_title||fallback.source_filename)||'Loaded colony data',sheet:string(row.source_sheet||fallback.source_sheet),cell:string(row.source_cell)||(row.source_row?`row ${row.source_row}`:string(fallback.source_cell)||(fallback.source_row?`row ${fallback.source_row}`:'')),url:safeUrl(row.source_url||fallback.source_url)};
}
function safeUrl(value) {try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:'';}catch{return '';}}
const sourceKey=source=>JSON.stringify([source.title,source.sheet,source.cell,source.url]);
const pairKey=pair=>JSON.stringify([...pair].sort());

function entries(dataset,historyIndex) {
  const rows=[],tables=dataset?.tables||{},mice=new Map((tables.mice||[]).map(mouse=>[mouse.mouse_sid,mouse]));
  const exports=new Map((dataset?.sources||[]).map(source=>[`${source.source_filename}|${source.sheet}`,source]));
  for(const [index,row] of (tables.mouse_genes||[]).entries()) {
    const mouse=mice.get(row.mouse_sid)||{},source=sourceOf(row,mouse);
    if(row.source_column&&mouse.source_row) {
      const headers=exports.get(`${mouse.source_filename}|${mouse.source_sheet}`)?.headers||[],index=headers.indexOf(row.source_column);
      let column=/^[A-Z]{1,3}$/.test(row.source_column)?row.source_column:'';
      if(index>=0){column='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))column=String.fromCharCode(65+(n-1)%26)+column;}
      source.cell=column?`${column}${mouse.source_row}`:`row ${mouse.source_row} · ${row.source_column}`;
    }
    rows.push({text:string(row.gene_value),structured:true,source,key:`gene:${row.source_record_id||row.mouse_sid||index}:${row.source_column||row.gene_column||index}`});
  }
  for(const [index,row] of (tables.mice||[]).entries())rows.push({text:string(row.genotype),structured:true,source:sourceOf(row),key:`mouse:${row.mouse_sid||index}`});
  for(const type of ['historical_observations','locations'])for(const [index,row] of (tables[type]||[]).entries()) {
    const source=sourceOf(row),text=string(type==='locations'?row.source_block_text:row.raw_text);
    rows.push({text,structured:false,source,key:source.cell?`source:${sourceKey(source)}`:`${type}:${index}`});
  }
  if(historyIndex&&Array.isArray(historyIndex.cells)&&Array.isArray(historyIndex.sheets)&&Array.isArray(historyIndex.sources))for(const cell of historyIndex.cells) {
    if(!Array.isArray(cell))continue;
    const sheet=historyIndex.sheets[cell[0]],file=historyIndex.sources[sheet?.source_index];
    if(!sheet||!file)continue;
    let url=safeUrl(file.url);
    if(url&&sheet.sheet_id!==null&&sheet.sheet_id!==undefined)url=url.split('#')[0]+`#gid=${encodeURIComponent(sheet.sheet_id)}&range=${encodeURIComponent(cell[1])}`;
    const source={title:string(file.title)||'Loaded source archive',sheet:string(sheet.title||sheet.export_title),cell:string(cell[1]),url};
    rows.push({text:unique([cell[2],cell[3],cell[6]].filter(value=>typeof value==='string')).join('\n'),structured:false,source,key:`source:${sourceKey(source)}`});
  }
  return rows;
}

/** Occurrences counts distinct evidence entries, not animals or verified alleles.
 * An optional loaded compact history index supplies exact legend-cell provenance.
 */
export function discoverGenotypes(dataset,historyIndex=null) {
  const found=new Map();
  for(const row of entries(dataset,historyIndex))for(const {name,label} of namedMentions(row.text,row.structured)) {
    const id=catalogId(name);
    if(!id)continue;
    let item=found.get(id);
    if(!item){item={id,name:id==='rosa26'?'Gt(ROSA)26Sor':name,kind:id==='rosa26'||/::LUC$|-ELuc$/i.test(name)?'reporter':/-Cre(?:ERT?2?)?$/i.test(name)?'cre':'other',chromosome:id==='rosa26'?'6':'unknown',alleles:['+'],sourceLabels:[],occurrences:0,sources:[],_names:new Set(),_entries:new Set(),_sources:new Set(),_strains:new Map(),_flox:false};found.set(id,item);}
    item._names.add(name);item.sourceLabels=unique([...item.sourceLabels,label,name]);
    if(!item._entries.has(row.key)){item._entries.add(row.key);item.occurrences++;}
    const sk=sourceKey(row.source);if(!item._sources.has(sk)){item._sources.add(sk);item.sources.push(row.source);}
    if(id==='rosa26'){
      let strain=item._strains.get(name);if(!strain){strain={name,allele:name,sourceLabels:[],occurrences:0,sources:[],_entries:new Set(),_sources:new Set()};item._strains.set(name,strain);}
      strain.sourceLabels=unique([...strain.sourceLabels,label,name]);
      if(!strain._entries.has(row.key)){strain._entries.add(row.key);strain.occurrences++;}
      if(!strain._sources.has(sk)){strain._sources.add(sk);strain.sources.push(row.source);}
    }
    const explicit=new RegExp(`(?:^|[^A-Za-z0-9_:-])${escape(label)}\\s*\\(\\s*fl\\s*\\/|(?:^|[^A-Za-z0-9_:-])${escape(label)}\\s*\\([^()]*\\/\\s*fl\\s*\\)`,'i');
    if(item.kind==='other'&&(FLOX_STRAIN_NAMES.includes(name)||explicit.test(row.text)))item._flox=true;
  }
  return [...found.values()].map(item=>{
    if(item._flox){item.kind='flox';item.alleles.push('fl');}
    else item.alleles.push(...item._names);
    if(item.id==='rosa26')item.alleles=['+','Ai32','Ai96'];
    const {_names,_entries,_sources,_strains,_flox,...publicItem}=item;
    if(_strains.size)publicItem.strains=[..._strains.values()].map(({_entries,_sources,...strain})=>strain).sort((a,b)=>a.name.localeCompare(b.name));
    const warning=strainNamingWarning(item);if(warning){publicItem.reviewRequired=true;publicItem.reviewWarning=warning;}
    publicItem.sourceLabels.sort((a,b)=>a.localeCompare(b));return publicItem;
  }).sort((a,b)=>a.name.localeCompare(b.name));
}

/** Separate selectable strain rows, while retaining one shared physical locus
 * and unchanged saved IDs for inheritance. Unobserved reporters get no row. */
export function catalogueStrains(loci){return (loci||[]).flatMap(locus=>locus.id==='rosa26'&&Array.isArray(locus.strains)?locus.strains.map(strain=>({...locus,...strain,locusName:locus.name})):locus);}

function labelsFor(locus) {
  return unique([...(locus.sourceLabels||[]),...strainNameAliases(locus.name),...(locus.id==='rosa26'||locus.name==='Gt(ROSA)26Sor'?['Ai32','Ai96']:[])].filter(value=>typeof value==='string'&&value.trim()));
}
function parsePair(label,body,locus,warnings) {
  const name=canonicalName(label),tokens=body.trim().split('/').map(value=>value.trim());
  const legacy=legacyVgatCreName(label),warning=strainNamingWarning(label);if(warning){warnings.push(warning);if(!legacy)return null;}
  if(explicitCreName(label)&&!legacy&&locus.kind==='flox'){warnings.push(`${label}: a Cre construct cannot supply a floxed-allele call.`);return null;}
  if(tokens.length!==2){warnings.push(`${name}: source notation does not specify two alleles; review zygosity.`);return null;}
  const normalized=tokens.map(value=>/^(?:wt|wild[- ]?type)$/i.test(value)?'WT':value.toLowerCase()==='fl'?'fl':value);
  if(legacy&&(locus.kind!=='flox'||!normalized.includes('fl'))){warnings.push('Vgat-flox: legacy Cre notation does not establish a floxed-allele pair.');return null;}
  if(name==='APP/PS1'){warnings.push('APP/PS1: verify the constituent alleles and whether they form one inherited insertion before assigning a single-locus genotype.');return null;}
  // Gene-only +/- cannot identify a specific mutant allele, unlike a named construct.
  if(FLOX_STRAIN_NAMES.includes(name)||locus.kind==='flox'||normalized.includes('fl')&&!/-(?:Cre(?:ERT?2?)?|tTA\d*|ELuc)$/i.test(name)&&!/^Ai\d+$|^PER\d::LUC$/i.test(name)) {
    if(normalized.some(value=>!['+','WT','fl'].includes(value))){warnings.push(`${name}: gene-variant semantics are ambiguous; identify the mutant allele before planning.`);return null;}
    return normalized.map(value=>value==='WT'?'+':value);
  }
  if(!/-(?:Cre(?:ERT?2?)?|tTA\d*|ELuc)$|^Ai\d+$|^PER\d::LUC$/i.test(name)){warnings.push(`${name}: gene-variant semantics are ambiguous; identify the allele rather than interpreting + as a named construct.`);return null;}
  if(normalized.every(value=>['+','-','WT'].includes(value)))return normalized.map(value=>value==='+'?name:'+');
  warnings.push(`${name}: source allele notation is incompatible with this named construct; review the source.`);return null;
}

function sheetEvidenceFor(mouse,dataset) {
  if(!dataset||typeof dataset!=='object'||typeof mouse?.mouse_sid!=='string')return [];
  const observations=dataset.tables?.historical_observations||[],locations=dataset.tables?.locations||[];
  let cached=sheetIndexes.get(dataset);
  if(!cached||cached.observations!==observations||cached.locations!==locations||cached.length!==observations.length+locations.length) {
    const records=[...observations.map(row=>({text:string(row.raw_text),...sourceOf(row)})),...locations.map(row=>({text:string(row.source_block_text),...sourceOf(row)}))],bySid=new Map();
    for(const record of records)for(const sid of unique([...record.text.matchAll(/(?:^|[^A-Za-z0-9])(?:M|F)(\d+)(?=$|[^A-Za-z0-9])/g)].map(match=>match[1]))) {
      if(!bySid.has(sid))bySid.set(sid,[]);bySid.get(sid).push(record);
    }
    cached={observations,locations,length:observations.length+locations.length,records,bySid};sheetIndexes.set(dataset,cached);
  }
  const found=[...(cached.bySid.get(mouse.mouse_sid)||[])],tag=string(mouse.physical_tag).trim();
  // Most source tags contain M/F + SID. Also support an explicitly recorded
  // alternative tag prefix without interpreting untagged numbers as mouse IDs.
  if(tag&&!/^[MF]$/.test(tag)) {
    const full=tag.endsWith(mouse.mouse_sid)?tag:tag+mouse.mouse_sid;
    if(!new RegExp(`(?:M|F)${escape(mouse.mouse_sid)}$`).test(full)) {
      const matcher=new RegExp(`(?:^|[^A-Za-z0-9])${escape(full)}(?=$|[^A-Za-z0-9])`);
      for(const record of cached.records)if(matcher.test(record.text))found.push(record);
    }
  }
  const seen=new Set();return found.filter(record=>{const key=sourceKey(record)+record.text;if(seen.has(key))return false;seen.add(key);return true;});
}

/** Suggest only explicit, unambiguous name(z1/z2) entries for this animal.
 * Archive prose, cage mates and incomplete labels never become animal calls.
 * Imported strings remain inferred even when their notation is parseable.
 */
export function sourceProfile(mouse,loci,dataset) {
  const rows=(dataset?.tables?.mouse_genes||[]).filter(row=>mouse?.mouse_sid!==undefined&&row.mouse_sid===mouse.mouse_sid);
  const texts=unique([string(mouse?.genotype),...rows.map(row=>string(row.gene_value))].filter(Boolean));
  const sourceText=texts.join('; '),calls={},warnings=[];
  for(const value of texts)for(const {label} of namedMentions(value,true)){const warning=strainNamingWarning(label);if(warning)warnings.push(warning);}
  for(const locus of Array.isArray(loci)?loci:[]) {
    if(!locus||typeof locus.id!=='string')continue;
    if(['__proto__','constructor','prototype'].includes(locus.id)){warnings.push('Reserved object names cannot identify a locus.');continue;}
    const parsed=[],seenMatches=new Set();let mentioned=false,unresolved=false;
    for(const label of labelsFor(locus)) {
      // A label may contain punctuation (PER2::LUC), but may not match a prefix
      // of a different construct (Bmal1 must not consume Bmal1-ELuc).
      const pattern=new RegExp(`(?:^|[^A-Za-z0-9_:-])(${escape(label)})(?=$|[^A-Za-z0-9_:-])(?:\\s*\\(([^()]*)\\))?`,'gi');
      for(const text of texts)for(const match of evidenceText(text).matchAll(pattern)) {
        mentioned=true;const key=`${legacyVgatCreName(match[1])?'legacy:':''}${canonicalName(match[1])}:${match[2]??''}`;
        if(seenMatches.has(key))continue;seenMatches.add(key);
        if(match[2]===undefined){unresolved=true;warnings.push(`${canonicalName(match[1])}: name/presence alone does not establish zygosity; no wild-type or transmission default is assumed.`);continue;}
        const pair=parsePair(match[1],match[2],locus,warnings);
        if(!pair){unresolved=true;continue;}
        if(!pair.every(value=>(locus.alleles||[]).includes(value))){unresolved=true;warnings.push(`${canonicalName(match[1])}: the parsed alleles are not declared for this locus; review the allele catalog.`);continue;}
        parsed.push({name:canonicalName(match[1]),alleles:pair});
      }
    }
    const reporters=unique(parsed.map(call=>call.name).filter(name=>['Ai32','Ai96'].includes(name)));
    if(reporters.length>1) {
      unresolved=true;
      const copies=parsed.reduce((maximum,call)=>Math.max(maximum,call.alleles.filter(allele=>allele===call.name).length),0);
      warnings.push(copies===2?'Ai32/Ai96: source claims involving two reporter alleles conflict with a two-copy Rosa26 model; reconcile the source before planning.':'Ai32/Ai96: separate positive/negative labels share one Rosa26 locus; review the two alleles explicitly before inferring a compound heterozygote.');
    }
    const pairs=unique(parsed.map(call=>pairKey(call.alleles)));
    if(pairs.length>1){unresolved=true;warnings.push(`${locus.name||locus.id}: conflicting source allele pairs; no call was selected.`);}
    if(!unresolved&&pairs.length===1)calls[locus.id]={alleles:[...parsed[0].alleles],evidence:'inferred'};
    else if(!mentioned)warnings.push(`${locus.name||locus.id}: no explicit source genotype; unknown is not wild type.`);
  }
  if(Object.keys(calls).length)warnings.push('Source-parsed calls are inferred, not assay-verified. Review the exact strain, allele identity and zygosity before confirming them.');
  const sheetEvidence=sheetEvidenceFor(mouse,dataset);
  if(sheetEvidence.length)warnings.push('Linked sheet excerpts contain this explicit tagged mouse ID. They may describe cage mates, historical states or comments; no genotype calls were inferred from them.');
  return {calls,warnings:unique(warnings),sourceText,sheetEvidence};
}
