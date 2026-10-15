/* Family-tree classification is descriptive. Only reviewed structured calls are
 * confirmed; source notation and tag primes never establish assay verification.
 * Omitted loci are unrecorded, never wild type. No archive prose is attributed
 * to a mouse. Ai32/Ai96 retain their shared Rosa26 locus. */
import {mouseLineAssignments,parseCompactStrainNotation} from './mouse-summary.js?v=39';
import {getStrainRegistry,canonicalLocusName,canonicalStrainName,explicitCreName,strainNameAliases,strainNamingWarning,legacyVgatCreName} from './strain-registry.js?v=36';
import {discoverGenotypes,sourceProfile} from './genotype-catalog.js?v=36';
import {validateGeneticProfile} from './genotype-schema.js?v=24';
const str=value=>typeof value==='string'?value:'';
const archived=row=>Boolean(row?.app_archived_at)||row?.archived===true;
const unique=values=>[...new Set(values)];
const sorted=values=>[...values].sort((a,b)=>a.localeCompare(b));
const pairKey=pair=>JSON.stringify(sorted(pair));
const wild=value=>/^(?:\+|-|wt|wild[- ]?type|negative|neg|absent)$/i.test(str(value).trim());
const flox=value=>/^(?:fl|f|flox|floxed|(?:Bmal1|Meis1|Vgat)[- ]flox)$/i.test(str(value).trim());
const normalize=value=>str(value).trim().toLowerCase().replace(/[^a-z0-9]/g,'');
const codes=['P','E','B','F','V','AD','A','32','Vg','Gt','96'];
const aliases={P:['PER2::LUC','PER2:LUC'],E:['Bmal1-ELuc'],B:['Bmal1-flox','Bmal1'],F:['FoxJ1-Cre','FoxJ-Cre'],V:['Vip-Cre'],AD:['APP/PS1'],A:['Avp-Cre'],'32':['Ai32'],Vg:['Vgat-flox','Vgat','Vgat-Cre'],Gt:['GAD67-tTA','GAD67-tTA2'],'96':['Ai96']};
const byName=new Map(Object.entries(aliases).flatMap(([code,names])=>names.map(name=>[normalize(name),code])));
const codeFor=value=>codes.includes(str(value).trim())?str(value).trim():byName.get(normalize(value))||null;
const rosa=locus=>['rosa26','gtrosa26sor'].includes(normalize(locus?.name))||normalize(locus?.id)==='rosa26';
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const sexOf=mouse=>/^(?:male|m)$/i.test(str(mouse.sex).trim())?'male':/^(?:female|f)$/i.test(str(mouse.sex).trim())?'female':'';
function compactEvidence(mouse,values) {
  const result=new Map();
  for(const [value,isTag] of [[mouse.physical_tag,true],...values.map(value=>[value,false])]) {
    const alternatives=str(value).split(/\s+or\s+/i).map(part=>parseCompactStrainNotation(part,{physicalTag:isTag}));
    if(alternatives.some(value=>value===null))continue;
    for(const code of unique(alternatives.flat().map(item=>item.code))) {
      const found=alternatives.flat().filter(item=>item.code===code),allPresent=alternatives.every(items=>items.some(item=>item.code===code&&item.presence==='present'));
      const item={code,presence:allPresent?'present':'uncertain',dosage:found.every(item=>item.dosage==='homozygous')?'homozygous':'unknown',dosageUncertain:found.some(item=>item.dosageUncertain),evidence:allPresent&&found.every(item=>item.evidence==='recorded')?'recorded':'uncertain'};
      const old=result.get(code);if(old){item.presence=old.presence==='uncertain'||item.presence==='uncertain'?'uncertain':'present';item.dosage=old.dosage==='homozygous'||item.dosage==='homozygous'?'homozygous':'unknown';item.dosageUncertain||=old.dosageUncertain;item.evidence=old.evidence==='uncertain'||item.evidence==='uncertain'?'uncertain':'recorded';}if(item.dosageUncertain)item.dosage='unknown';result.set(code,item);
    }
  }
  return result;
}
function sourceNotation(value) {
  return str(value).replace(/(^|[;,\s+])((?:AD|Vg|Gt|32|96|[PEBFVA]))\s*\(([^()]*)\)/g,(full,before,code,body)=>body.includes('/')?`${before}${aliases[code][0]}(${body})`:full);
}
function standardLoci(registry) {
  const loci=registry.filter(item=>!['32','96'].includes(item.key)).map(item=>({id:`family:${item.key}`,name:aliases[item.key][0],kind:['B','Vg'].includes(item.key)?'flox':'other',chromosome:'unknown',alleles:['+',...(['B','Vg'].includes(item.key)?['fl']:[aliases[item.key][0]])],sourceLabels:aliases[item.key]}));
  loci.push({id:'rosa26',name:'Gt(ROSA)26Sor',kind:'reporter',chromosome:'6',alleles:['+','Ai32','Ai96'],sourceLabels:['Ai32','Ai96']});return loci;
}
function shorthand(trait) {
  if(trait.code.startsWith('locus:')) {
    if(trait.alleles?.length===2)return `${trait.name}[${sorted(trait.alleles).join('/')}]${trait.presence==='uncertain'?'?':''}`;
    return trait.presence==='absent'?`${trait.name}−`:trait.presence==='uncertain'?`(${trait.name})`:trait.name;
  }
  if(rosa(trait.locus)&&trait.alleles?.length===2&&trait.alleles.every(allele=>['32','96'].includes(codeFor(allele)))&&trait.alleles[0]!==trait.alleles[1])return sorted(trait.alleles.map(codeFor)).join('/');
  const base=trait.presence==='absent'?`${trait.code}−`:trait.code+(trait.dosageUncertain?'(′)':trait.dosage==='homozygous'?'′':trait.dosage==='heterozygous'?'/+':'');
  return trait.presence==='uncertain'?`(${base})`:base;
}
function fromPair(code,locus,call,registry) {
  const known=registry.find(item=>item.key===code),custom=code.startsWith('locus:');
  const trait={code,name:known?.name||canonicalLocusName(locus),presence:'uncertain',dosage:'unknown',evidence:'uncertain',locus,declaredAlleles:Array.isArray(locus.alleles)?locus.alleles.filter(allele=>typeof allele==='string'):[]};
  if(!['confirmed','inferred'].includes(call?.evidence)||!Array.isArray(call.alleles)||call.alleles.length!==2||!Array.isArray(locus.alleles)||!call.alleles.every(allele=>typeof allele==='string'&&locus.alleles.includes(allele)&&!/^(?:\?|unknown|undetermined|not[ -]?tested|untested|n\/?a)$/i.test(allele.trim())))return trait;
  const mutant=allele=>custom?!/^(?:\+|wt|wild[- ]?type)$/i.test(allele):['B','Vg'].includes(code)?flox(allele):codeFor(allele)===code;
  const valid=call.alleles.every(allele=>(!custom||allele!=='-')&&(wild(allele)||mutant(allele)||rosa(locus)&&['32','96'].includes(codeFor(allele))));
  if(!valid)return trait;
  const copies=call.alleles.filter(mutant).length;
  return {...trait,presence:copies?'present':'absent',dosage:copies===0?'unknown':copies===2&&call.alleles[0]===call.alleles[1]?'homozygous':'heterozygous',evidence:call.evidence,alleles:[...call.alleles]};
}
function profileTraits(profile,registry) {
  const result=new Map();if(profile?.schema_version!==1||!Array.isArray(profile.loci))return result;
  const invalid=validateGeneticProfile(profile).length>0;
  for(const locus of profile.loci) {
    if(!locus||typeof locus.id!=='string'||!locus.id||['__proto__','prototype','constructor'].includes(locus.id)||typeof locus.name!=='string')continue;
    const known=legacyVgatCreName(locus.name)&&locus.kind!=='flox'?null:codeFor(locus.name)||(explicitCreName(locus.name)?null:codeFor(locus.id)),keys=rosa(locus)?['32','96']:known?[known]:[`locus:${locus.id}`];
    for(const code of keys) {
      const trait=fromPair(code,locus,invalid||locus.kind==='cre'&&legacyVgatCreName(locus.name)?null:profile.calls?.[locus.id],registry),old=result.get(code);
      if(!old)result.set(code,trait);
      else if(old.evidence==='confirmed'&&trait.evidence!=='confirmed')continue;
      else if(trait.evidence==='confirmed'&&old.evidence!=='confirmed')result.set(code,trait);
      else if(old.presence!==trait.presence||pairKey(old.alleles||[])!==pairKey(trait.alleles||[]))result.set(code,{...trait,presence:'uncertain',dosage:'unknown',evidence:'uncertain',alleles:undefined});
    }
  }
  const r32=result.get('32'),r96=result.get('96');
  if(r32?.presence==='present'&&r96?.presence==='present'&&(!rosa(r32.locus)||!rosa(r96.locus)||r32.locus.id!==r96.locus.id))for(const code of ['32','96'])result.set(code,{...result.get(code),presence:'uncertain',dosage:'unknown',evidence:'uncertain',alleles:undefined,sharedLocusConflict:true});
  return result;
}
function explicitNamedStatuses(values,registry) {
  const result=new Map();
  for(const item of registry) {
    const statuses=[];
    for(const value of values)for(const alias of aliases[item.key])for(const match of value.matchAll(new RegExp(`(?:^|[^A-Za-z0-9_:-])${escape(alias)}(?=$|[^A-Za-z0-9_:-])\\s*(?:\\(([^()]*)\\)|([+?-](?:\\s*\\/\\s*[+?-])?|negative|neg|absent|unknown|untested)(?=$|[\\s,;]))`,'gi'))) {
      const body=(match[1]??match[2]??'').trim(),tokens=body.split('/').map(value=>value.trim());
      if(/\?|unknown|untested/i.test(body))statuses.push('uncertain');
      // Gene-only minus notation may describe a different disrupted allele,
      // so it cannot establish absence of the floxed allele.
      else if(legacyVgatCreName(alias)&&!tokens.includes('fl'))statuses.push('uncertain');
      else if(['B','Vg'].includes(item.key)&&tokens.includes('-'))statuses.push('uncertain');
      else if(['B','Vg'].includes(item.key)&&tokens.every(wild)||!['B','Vg'].includes(item.key)&&tokens.every(value=>/^(?:-|WT|wild[- ]?type|negative|neg|absent)$/i.test(value)))statuses.push('absent');
    }
    if(statuses.length)result.set(item.key,statuses.includes('uncertain')?'uncertain':'absent');
  }
  return result;
}
function classify(mouse,genes,loci,registry) {
  const values=[str(mouse.genotype),str(mouse.mouseline),...genes.map(row=>str(row.gene_value))].filter(value=>!/^\s*=/.test(value)),compactCalls=compactEvidence(mouse,values);
  const normalizedMouse={...mouse,genotype:sourceNotation(mouse.genotype)},normalizedGenes=genes.map(row=>({...row,mouse_sid:mouse.mouse_sid,gene_value:sourceNotation(row.gene_value)}));
  const safeDataset={tables:{mouse_genes:normalizedGenes}},parsed=sourceProfile(normalizedMouse,loci,safeDataset);
  const rawMouse={...normalizedMouse,genetic_profile:undefined},assignments=mouseLineAssignments(rawMouse,normalizedGenes),named=explicitNamedStatuses(values.map(sourceNotation),registry),traits=new Map();
  for(const reference of registry) {
    const code=reference.key,tag=compactCalls.get(code),status=assignments[code],explicit=named.get(code);
    if(status||explicit)traits.set(code,{code,name:reference.name,presence:status==='uncertain'||explicit==='uncertain'?'uncertain':status?'present':'absent',dosage:tag?.dosage||'unknown',dosageUncertain:tag?.dosageUncertain||false,evidence:status==='uncertain'||explicit==='uncertain'||tag?.dosageUncertain?'uncertain':'recorded'});
  }
  for(const locus of loci) {
    const known=legacyVgatCreName(locus.name)&&locus.kind!=='flox'?null:codeFor(locus.name)||(explicitCreName(locus.name)?null:codeFor(locus.id)),keys=rosa(locus)?['32','96']:known?[known]:[`locus:${locus.id}`],call=parsed.calls[locus.id];
    for(const code of keys) {
      if(call) {
        const proposed=fromPair(code,locus,call,registry),old=traits.get(code);
        if(old?.presence==='uncertain')traits.set(code,{...proposed,presence:'uncertain',dosage:'unknown',evidence:'uncertain',alleles:undefined});else traits.set(code,proposed);
      } else if(code.startsWith('locus:')&&values.some(value=>new RegExp(`(?:^|[^A-Za-z0-9_:-])(?:${[...strainNameAliases(locus.name),...(locus.sourceLabels||[])].map(escape).join('|')})(?=$|[^A-Za-z0-9_:-])`,'i').test(value)))traits.set(code,fromPair(code,locus,null,registry));
    }
  }
  const contextual=values.some(value=>/^\s*(?:previously|formerly|historical|old|sire|dam|parents?)\b/i.test(value));
  if(contextual)for(const [code,trait] of traits)traits.set(code,{...trait,presence:'uncertain',dosage:'unknown',evidence:'uncertain',alleles:undefined});
  const reviewed=profileTraits(mouse.genetic_profile,registry);
  for(const [code,trait] of reviewed) {
    const sourceAlias=code.startsWith('locus:')?[...traits.values()].find(old=>old.code.startsWith('locus:')&&old.code!==code&&normalize(canonicalStrainName(old.name))===normalize(canonicalStrainName(trait.name))):null;
    const old=traits.get(code)||sourceAlias;if(sourceAlias)traits.delete(sourceAlias.code);
    if(trait.evidence==='inferred'&&old&&(old.presence==='uncertain'||old.presence!==trait.presence||old.alleles&&pairKey(old.alleles)!==pairKey(trait.alleles||[])))traits.set(code,{...trait,presence:'uncertain',dosage:'unknown',evidence:'uncertain',alleles:undefined});else traits.set(code,trait);
  }
  const warnings=contextual?['Contextual or historical genotype prose requires review before use as a current allele call.']:[];
  for(const locus of [...loci,...(Array.isArray(mouse.genetic_profile?.loci)?mouse.genetic_profile.loci:[])]){const warning=strainNamingWarning(locus);if(warning&&[...traits.values()].some(trait=>trait.locus?.id===locus.id))warnings.push(warning);}
  if(['32','96'].every(code=>traits.get(code)?.presence==='present')&&!['32','96'].every(code=>reviewed.get(code)?.alleles?.length===2&&rosa(reviewed.get(code)?.locus))) {
    for(const code of ['32','96'])traits.set(code,{...traits.get(code),dosage:'unknown',evidence:'uncertain',alleles:undefined,dosageUncertain:true});
    warnings.push('Ai32 and Ai96 share Rosa26. Review one two-allele call before planning this combination.');
  }
  if([...reviewed.values()].some(trait=>trait.sharedLocusConflict))warnings.push('Ai32 and Ai96 cannot be treated as independent loci. Review one Rosa26 allele pair.');
  if(compactCalls.has('WT'))traits.set('WT',{...compactCalls.get('WT'),name:'Wild type (recorded)',dosage:'unknown'});
  if(values.some(value=>/^\s*WT\s*\(\s*\+\s*\/\s*\+\s*\)\s*$/i.test(value)))traits.set('WT',{code:'WT',name:'Wild type (recorded)',presence:'present',dosage:'unknown',evidence:'recorded'});
  if(traits.has('WT')&&[...traits.values()].some(trait=>trait.code!=='WT'&&trait.presence==='present')) {traits.set('WT',{...traits.get('WT'),presence:'uncertain',evidence:'uncertain'});warnings.push('The broad WT label conflicts with a recorded variant; review its intended scope.');}
  for(const warning of parsed.warnings)if(!/no explicit source genotype|Source-parsed calls/.test(warning)&&loci.some(locus=>values.some(value=>[...strainNameAliases(locus.name),...(locus.sourceLabels||[])].some(label=>value.toLowerCase().includes(label.toLowerCase())))))warnings.push(warning);
  const order=new Map(registry.map((item,index)=>[item.key,index])),list=[...traits.values()].sort((a,b)=>(order.get(a.code)??100)-(order.get(b.code)??100)||a.name.localeCompare(b.name)).map(trait=>({...trait,shorthand:shorthand(trait)}));
  const confirmed=list.length>0&&list.every(trait=>trait.evidence==='confirmed'&&trait.presence!=='uncertain'),unresolved=!list.length||list.some(trait=>trait.evidence==='uncertain'||trait.presence==='uncertain'||trait.presence==='present'&&trait.dosage==='unknown'&&trait.code!=='WT');
  const evidenceLabel=confirmed?'Confirmed':unresolved?'Needs review':list.some(trait=>trait.evidence==='inferred')?'Inferred':'Recorded';
  const combinationKey=JSON.stringify(list.map(trait=>[trait.code,trait.presence,trait.dosage,Boolean(trait.dosageUncertain),trait.code.startsWith('locus:')&&trait.alleles?sorted(trait.alleles):rosa(trait.locus)&&trait.alleles?sorted(trait.alleles.map(allele=>codeFor(allele)||'+')):null,trait.code.startsWith('locus:')?trait.locus?.id||null:null]));
  return {mouse,id:String(mouse.mouse_sid),label:str(mouse.physical_tag)||String(mouse.mouse_sid),traits:list,shorthand:unique(list.map(trait=>trait.shorthand)).join(' · ')||'Unclassified',combinationKey,confirmed,unclassified:list.length===0,unresolved,evidenceLabel,warnings:unique(warnings)};
}

export function buildFamilyGenotypes(dataset,{scope='current',includeArchived=false}={}) {
  if(!['current','all'].includes(scope))throw new Error('Family genotype scope must be current or all.');
  const registry=getStrainRegistry(dataset),genes=new Map(),seen=new Set(),mice=[];
  for(const row of dataset?.tables?.mouse_genes||[])if(row&&row.mouse_sid!=null&&!archived(row)){const id=String(row.mouse_sid);if(!genes.has(id))genes.set(id,[]);genes.get(id).push(row);}
  for(const mouse of dataset?.tables?.mice||[])if(mouse&&mouse.mouse_sid!=null&&String(mouse.mouse_sid).trim()&&(includeArchived||!archived(mouse))&&(scope==='all'||mouse.state==='Stock')){const id=String(mouse.mouse_sid);if(!seen.has(id)){seen.add(id);mice.push(mouse);}}
  const discoveryData={tables:{mice:mice.map(mouse=>({...mouse,genotype:sourceNotation(mouse.genotype)})),mouse_genes:[...genes.values()].flat().filter(row=>seen.has(String(row.mouse_sid))).map(row=>({...row,gene_value:sourceNotation(row.gene_value)}))}};
  const loci=standardLoci(registry);for(const locus of discoverGenotypes(discoveryData))if(!codeFor(locus.name)&&!rosa(locus))loci.push(locus);
  const animals=mice.map(mouse=>classify(mouse,genes.get(String(mouse.mouse_sid))||[],loci,registry));
  const totals=new Map(registry.map(item=>[item.key,{code:item.key,name:item.name,present:0,absent:0,uncertain:0,male:0,female:0,confirmed:0,insertionType:item.insertionType}])),combinations=new Map();
  for(const animal of animals) {
    const sex=sexOf(animal.mouse);
    for(const trait of animal.traits){let row=totals.get(trait.code);if(!row){row={code:trait.code,name:trait.name,present:0,absent:0,uncertain:0,male:0,female:0,confirmed:0};totals.set(trait.code,row);}row[trait.presence]++;if(trait.presence==='present'&&sex)row[sex]++;if(trait.presence==='present'&&trait.evidence==='confirmed')row.confirmed++;if(trait.locus)row.locus=trait.locus;if(trait.declaredAlleles)row.declaredAlleles=unique([...(row.declaredAlleles||[]),...trait.declaredAlleles]);}
    let group=combinations.get(animal.combinationKey);if(!group){group={key:animal.combinationKey,label:animal.shorthand,count:0,male:0,female:0,confirmed:0,animalIds:[],traits:animal.traits,evidenceLabel:animal.evidenceLabel,unresolved:animal.unresolved};combinations.set(animal.combinationKey,group);}group.count++;if(sex)group[sex]++;if(animal.confirmed)group.confirmed++;group.animalIds.push(animal.id);group.unresolved||=animal.unresolved;if(group.evidenceLabel!==animal.evidenceLabel)group.evidenceLabel='Mixed evidence';
  }
  return {scope,includeArchived,total:animals.length,confirmed:animals.filter(animal=>animal.confirmed).length,unclassified:animals.filter(animal=>animal.unclassified).length,unresolved:animals.filter(animal=>animal.unresolved).length,animals,traits:[...totals.values()],combinations:[...combinations.values()].sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label)||a.key.localeCompare(b.key))};
}
export function filterFamilyAnimals(animals,{codes:chosen=[],match='all',combinationKey='',sex='',evidence='',search='',includeUncertain=true}={}) {
  const wanted=unique(chosen),needle=str(search).trim().toLowerCase();
  return (animals||[]).filter(animal=>{
    if(combinationKey&&animal.combinationKey!==combinationKey)return false;
    if(sex&&sexOf(animal.mouse)!==(sex.toLowerCase()==='unknown'?'':sex.toLowerCase()))return false;
    if(evidence==='confirmed'&&!animal.confirmed)return false;
    if(['uncertain','unresolved'].includes(evidence)&&!animal.unresolved)return false;
    if(evidence==='unclassified'&&!animal.unclassified)return false;
    if(['inferred','recorded'].includes(evidence)&&!animal.traits.some(trait=>trait.evidence===evidence))return false;
    if(wanted.length){const accepted=code=>animal.traits.some(trait=>trait.code===code&&(trait.presence==='present'||includeUncertain&&trait.presence==='uncertain'));if(!(match==='any'?wanted.some(accepted):wanted.every(accepted)))return false;}
    return !needle||[animal.id,animal.label,animal.shorthand,animal.mouse.genotype,animal.mouse.cage_sid,animal.mouse.cage_tag,...animal.traits.map(trait=>trait.name)].some(value=>str(value).toLowerCase().includes(needle));
  });
}
