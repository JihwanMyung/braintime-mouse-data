/* Desired offspring targets only. This bridge never supplies parental calls. */
import { rankPairs } from './genetics.js?v=24';
import { discoverGenotypes } from './genotype-catalog.js?v=24';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
const unique=values=>[...new Set(values)];
const norm=value=>typeof value==='string'?value.toLowerCase().replace(/[^a-z0-9]/g,''):'';
const fields=locus=>({id:locus.id,name:locus.name,kind:locus.kind,chromosome:locus.chromosome,alleles:[...locus.alleles]});
const signature=locus=>JSON.stringify([locus.id,locus.name,locus.kind,locus.chromosome,[...locus.alleles].sort()]);
const config=(loci,targets)=>({loci,targets,sex:'Any',independentAssortment:true,desiredCount:1,confidence:0.95,litterSize:6});
const definition=(id,name,kind,allele,aliases=[],chromosome='unknown')=>({locus:{id,name,kind,chromosome,alleles:['+',allele]},allele,aliases:[id,name,...aliases].map(norm)});
const definitions={
  P:definition('per2-luc','PER2::LUC','reporter','PER2::LUC'),
  E:definition('bmal1-eluc','Bmal1-ELuc','reporter','Bmal1-ELuc'),
  B:definition('bmal1','Bmal1','flox','fl',['Bmal1-flox']),
  F:definition('foxj1-cre','FoxJ1-Cre','cre','FoxJ1-Cre'),
  V:definition('vip-cre','Vip-Cre','cre','Vip-Cre'),
  AD:definition('app-ps1','APP/PS1','other','APP/PS1',['Tg(APPswe,PSEN1dE9)85Dbo']),
  A:definition('avp-cre','Avp-Cre','cre','Avp-Cre'),
  Vg:definition('vgat','Vgat','flox','fl',['Vgat-flox']),
  Gt:definition('gad67-tta','GAD67-tTA','other','GAD67-tTA',['GAD67-tTA2'])
};
for(const code of ['32','96'])definitions[code]={locus:{id:'rosa26',name:'Gt(ROSA)26Sor',kind:'reporter',chromosome:'6',alleles:['+','Ai32','Ai96']},allele:'Ai'+code,aliases:['rosa26','gtrosa26sor','ai'+code]};
const entryFor=code=>Object.hasOwn(definitions,code)?definitions[code]:null;

function matchesCode(locus,code) {
  const entry=entryFor(code);if(!entry||!object(locus))return false;
  if(['B','Vg'].includes(code)&&locus.kind!=='flox')return false;
  if(locus.id===code||locus.name===code)return true;
  const names=[locus.id,locus.name].map(norm);
  return names.some(name=>entry.aliases.includes(name));
}

function variantFor(locus,selection) {
  if(selection.allele!==undefined)return locus.alleles.includes(selection.allele)?selection.allele:null;
  const entry=entryFor(selection.code);
  if(entry){
    const match=locus.alleles.filter(allele=>norm(allele)===norm(entry.allele));
    if(match.length===1)return match[0];
    if(['32','96'].includes(selection.code))return null;
  }
  const variants=locus.alleles.filter(allele=>!['+','-','wt','wildtype'].includes(allele==='+'||allele==='-'?allele:norm(allele)));
  return variants.length===1?variants[0]:null;
}

/** Validate a target-only draft without requiring or inventing parent genotypes. */
export function validateFamilyTargetDraft(draft) {
  if(!object(draft))return ['A target draft is required.'];
  const errors=Array.isArray(draft.errors)?draft.errors.filter(value=>typeof value==='string'):[];
  if(!Array.isArray(draft.loci)||!object(draft.targets))return unique([...errors,'A target draft needs loci and desired offspring targets.']);
  errors.push(...rankPairs(config(draft.loci,draft.targets),[]).errors);
  if(draft.loci.some(locus=>typeof locus?.id==='string'&&!Object.hasOwn(draft.targets,locus.id)))errors.push('Each target locus needs a desired offspring target.');
  return unique(errors);
}

function structuredDefinitions(dataset) {
  const found=[];
  for(const mouse of dataset?.tables?.mice||[]){
    const profile=mouse?.genetic_profile;
    if(profile?.schema_version!==1||!Array.isArray(profile.loci))continue;
    for(const locus of profile.loci){
      if(!object(locus))continue;
      const call=object(profile.calls)?profile.calls[locus.id]:null;
      const confirmed=call?.evidence==='confirmed'&&Array.isArray(call.alleles)&&call.alleles.length===2&&Array.isArray(locus.alleles)&&call.alleles.every(allele=>locus.alleles.includes(allele));
      found.push({locus,confirmed});
    }
  }
  return found;
}

function sourceContext(dataset) {
  const tables=object(dataset?.tables)?dataset.tables:{};
  const clean={tables:Object.fromEntries(['mice','mouse_genes','historical_observations','locations'].map(type=>[type,Array.isArray(tables[type])?tables[type].filter(object):[]])),sources:Array.isArray(dataset?.sources)?dataset.sources.filter(object):[]};
  return {structured:structuredDefinitions(clean).map(row=>({locus:clone(row.locus),confirmed:row.confirmed})),catalogue:discoverGenotypes(clean)};
}

function chooseDefinition(selection,structured,catalogue,notices,errors) {
  const code=selection.code,entry=entryFor(code);
  if(object(selection.locus))return clone(selection.locus);
  const requested=typeof selection.locus==='string'?selection.locus:!entry?code.replace(/^locus:/,''):null;
  const candidates=structured.filter(row=>requested?row.locus.id===requested:matchesCode(row.locus,code));
  if(candidates.length){
    const confirmed=candidates.filter(row=>row.confirmed),preferred=!requested&&confirmed.length?confirmed:candidates;
    const valid=preferred.filter(row=>!rankPairs(config([row.locus],{}),[]).errors.length);
    if(valid.length!==preferred.length){errors.push(`${code}: its saved locus definition needs review before planning.`);return null;}
    const distinct=new Map(valid.map(row=>[signature(row.locus),row.locus]));
    if(distinct.size>1){errors.push(`${code}: saved locus definitions disagree. Select one exact locus definition before planning.`);return null;}
    const locus=[...distinct.values()][0];
    if(confirmed.length&&candidates.length>confirmed.length&&candidates.some(row=>!Array.isArray(row.locus.alleles)||signature(row.locus)!==signature(locus)))notices.push(`${code}: using its confirmed locus definition; incompatible profiles need review before candidate comparison.`);
    return fields(locus);
  }
  if(!entry){
    const discovered=catalogue.filter(locus=>locus.id===requested&&locus.kind==='flox'&&!rankPairs(config([locus],{}),[]).errors.length);
    if(discovered.length===1){notices.push(`${discovered[0].name}: review the source-derived locus definition before choosing parents.`);return fields(discovered[0]);}
    errors.push(`${code||'Custom locus'}: no unambiguous saved locus and allele definition. Review the genotype profile before planning.`);return null;
  }
  if(code==='AD'){errors.push('AD (APP/PS1): record an explicit inherited insertion locus and its alleles in Genotypes before planning. The strain label alone does not define a single-locus model.');return null;}
  const discovered=catalogue.filter(locus=>matchesCode(locus,code)&&!rankPairs(config([locus],{}),[]).errors.length&&variantFor(locus,selection));
  if(discovered.length===1)return fields(discovered[0]);
  notices.push(`${code}: review the locus and allele definition before choosing parents.`);
  return clone(entry.locus);
}

/** One render can reuse one immutable resolution snapshot for many target rows. */
export function createFamilyTargetResolver(dataset={}) {
  const {structured,catalogue}=sourceContext(dataset),cache=new Map();
  return code=>{
    if(typeof code!=='string'||!code.trim())return {locus:null,alleles:[],error:'Choose a strain code or saved locus ID.'};
    if(cache.has(code))return clone(cache.get(code));
    const errors=[],notices=[],selection={code},locus=chooseDefinition(selection,structured,catalogue,notices,errors);
    if(locus)errors.push(...rankPairs(config([locus],{}),[]).errors);
    const result=errors.length||!locus?{locus:null,alleles:[],error:unique(errors).join(' ')}:{locus:fields(locus),alleles:[...locus.alleles],allele:variantFor(locus,selection)};
    cache.set(code,result);return clone(result);
  };
}

/** Available exact allele-pair choices use the same definition as draft creation. */
export function familyTargetOptions(code,dataset={}) {return createFamilyTargetResolver(dataset)(code);}

const pairKey=pair=>JSON.stringify([...pair].sort());
function targetFor(locus,requests,errors) {
  const pairs=locus.alleles.flatMap((a,index)=>locus.alleles.slice(index).map(b=>[a,b]));
  const matches=(pair,request)=>{
    if(request.pair)return pairKey(pair)===pairKey(request.pair);
    const copies=pair.filter(allele=>allele===request.allele).length;
    return request.mode==='carrier'?copies>0:request.mode==='homozygous'?copies===2:request.mode==='heterozygous'?copies===1:copies===0;
  };
  const allowed=pairs.filter(pair=>requests.every(request=>matches(pair,request)));
  if(!allowed.length){errors.push(`${locus.name}: these targets conflict with a two-copy locus. Revise the requested allele combinations.`);return null;}
  if(allowed.length===1)return {mode:'exact',alleles:allowed[0]};
  // A carrier target is retained only if it represents the entire allowed set.
  // Negative or one-copy constraints at a multiallelic locus are not silently
  // relaxed to a carrier or narrowed to an arbitrary wild-type partner.
  const allowedKeys=allowed.map(pairKey).sort();
  for(const allele of locus.alleles){
    const carrierKeys=pairs.filter(pair=>pair.includes(allele)).map(pairKey).sort();
    if(JSON.stringify(carrierKeys)===JSON.stringify(allowedKeys))return {mode:'carrier',allele};
  }
  errors.push(`${locus.name}: these targets allow several distinct allele pairs. Choose an exact pair; the planner cannot represent this partial multiallelic constraint.`);
  return null;
}

/** Convert explicit user target choices into a draft; source calls are untouched.
 * Heterozygous means exactly one copy of the selected allele. Absence means zero
 * copies, not missing data. Two requested Rosa26 reporters occupy one locus.
 */
export function familyTargetDraft(selection,dataset={}) {
  const errors=[],notices=[],loci=[],targets={},groups=new Map();
  if(!Array.isArray(selection))return {loci,targets,notice:'',errors:['Choose one or more genotype targets.']};
  const {structured,catalogue}=sourceContext(dataset);
  for(const request of selection){
    if(!object(request)||typeof request.code!=='string'||!request.code.trim()){errors.push('Each target needs a strain code or a saved locus ID.');continue;}
    if(request.mode==='any')continue;
    if(!['carrier','homozygous','heterozygous','absent','exact'].includes(request.mode)){errors.push(`${request.code}: choose carrier, heterozygous, homozygous or absent.`);continue;}
    const locus=chooseDefinition(request,structured,catalogue,notices,errors);if(!locus)continue;
    const definitionErrors=rankPairs(config([locus],{}),[]).errors;
    if(definitionErrors.length){errors.push(...definitionErrors);continue;}
    const declaredPair=Array.isArray(request.pair)?request.pair:null;
    if(request.pair!==undefined&&(!declaredPair||declaredPair.length!==2||declaredPair.some(allele=>!locus.alleles.includes(allele)))){errors.push(`${locus.name}: an exact pair needs two declared allele names.`);continue;}
    if(request.mode==='exact'&&!declaredPair){errors.push(`${locus.name}: choose an exact pair of alleles.`);continue;}
    const allele=variantFor(locus,request);
    if(!declaredPair&&!allele){errors.push(`${request.code}: choose the exact target allele in ${locus.name}.`);continue;}
    const group=groups.get(locus.id);
    if(group&&signature(group.locus)!==signature(locus)){errors.push(`${locus.name}: target selections use incompatible definitions of the same locus.`);continue;}
    if(!group)groups.set(locus.id,{locus,requests:[]});
    groups.get(locus.id).requests.push({mode:request.mode,allele,pair:declaredPair});
  }
  // A pair of reporter-specific saved IDs may conceal one physical locus.
  const rosa=[...groups.values()].filter(({locus})=>['32','96'].some(code=>matchesCode(locus,code)));
  if(rosa.length>1)errors.push('Ai32 and Ai96 belong to one Rosa26 locus. Harmonize the saved locus definition instead of modeling independent reporter loci.');
  for(const {locus,requests} of groups.values()){
    loci.push(fields(locus));const target=targetFor(locus,requests,errors);if(target)targets[locus.id]=target;
  }
  if(!loci.length&&!errors.length)errors.push('Choose at least one genotype target.');
  if(loci.length>6)errors.push('A cross supports at most six loci. Narrow the target to six loci or fewer.');
  if(!errors.length)errors.push(...validateFamilyTargetDraft({loci,targets}));
  const notice=unique(['Target draft from Family tree. Choose parents and review their allele calls before calculating.',...notices]).join(' ');
  return {loci,targets,notice,errors:unique(errors)};
}
