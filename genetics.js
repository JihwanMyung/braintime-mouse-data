/**
 * Pure autosomal Mendelian planning. No colony records are read or modified.
 * Background: JAX, Strategies for Creating Complex Breeding Schemes:
 * https://resources.jax.org/husbandry/strategies-for-creating-complex-breeding-schemes
 * Cre-specific limits:
 * https://www.jax.org/news-and-insights/jax-blog/2012/november/breeding-strategies-for-tissue-specific-knockout-mice
 */
const KINDS=new Set(['cre','flox','reporter','other']);
const CONFIDENCES=new Set([0.8,0.9,0.95,0.99]);
const UNKNOWN_ALLELES=new Set(['?','unknown','undetermined','not tested','untested']);
const RESERVED_IDS=new Set(['__proto__','prototype','constructor']);
const MAX_PAIRS=2500;
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&Boolean(value.trim());
const label=value=>text(value)&&value.length<=160;
const own=(object,field)=>isObject(object)&&Object.hasOwn(object,field);
const unique=values=>[...new Set(values)];
const compare=(a,b)=>a<b?-1:a>b?1:0;
const validAllele=value=>label(value)&&value===value.trim()&&!UNKNOWN_ALLELES.has(value.toLowerCase());

function validateConfig(scenario) {
  const errors=[],warnings=[];
  if(!isObject(scenario))return {errors:['A breeding scenario object is required.'],warnings};
  if(!Array.isArray(scenario.loci)||scenario.loci.length<1||scenario.loci.length>6)errors.push('Choose between 1 and 6 autosomal loci.');
  const loci=Array.isArray(scenario.loci)?scenario.loci:[],seen=new Set(),chromosomes=new Map();
  for(const [index,locus] of loci.entries()) {
    if(!isObject(locus)){errors.push(`Locus ${index+1} must be an object.`);continue;}
    const label=text(locus.name)?locus.name:`Locus ${index+1}`;
    if(!text(locus.id)||locus.id.length>160)errors.push(`${label}: a text locus ID of at most 160 characters is required.`);
    else if(RESERVED_IDS.has(locus.id))errors.push(`${label}: locus IDs cannot use reserved object names.`);
    else if(seen.has(locus.id))errors.push(`Locus ID ${locus.id} is duplicated. Represent alternative alleles of one locus together.`);
    seen.add(locus.id);
    if(!text(locus.name)||locus.name.length>160)errors.push(`${label}: a locus name of at most 160 characters is required.`);
    if(!KINDS.has(locus.kind))errors.push(`${label}: kind must be cre, flox, reporter or other.`);
    if(typeof locus.chromosome!=='string'||!(/^(?:[1-9]|1[0-9])$/.test(locus.chromosome)||locus.chromosome==='unknown'))errors.push(`${label}: only autosomes 1–19 or unknown are supported; X/Y and other inheritance models are unsupported.`);
    else if(locus.chromosome!=='unknown') {
      if(chromosomes.has(locus.chromosome))errors.push(`${label} and ${chromosomes.get(locus.chromosome)} are separate loci on chromosome ${locus.chromosome}. Linkage is unsupported; do not model them as independent.`);
      else chromosomes.set(locus.chromosome,label);
    }
    if(!Array.isArray(locus.alleles)||locus.alleles.length<1||locus.alleles.length>6)errors.push(`${label}: declare 1–6 distinct allele names.`);
    else {
      if(locus.alleles.some(allele=>!validAllele(allele)))errors.push(`${label}: allele names must be known, nonempty text of at most 160 characters without surrounding spaces; unknown states are not alleles.`);
      if(new Set(locus.alleles).size!==locus.alleles.length)errors.push(`${label}: allele names are duplicated.`);
    }
  }
  if(loci.length>1&&scenario.independentAssortment!==true)errors.push('Explicitly confirm independent assortment before combining multiple loci.');
  if(loci.length>1&&loci.some(locus=>locus?.chromosome==='unknown'))warnings.push('Some chromosome locations are unknown. Independent assortment is an explicit planning assumption, not established linkage information.');
  if(!['Any','Male','Female'].includes(scenario.sex))errors.push('Target sex must be Any, Male or Female.');
  if(!Number.isInteger(scenario.desiredCount)||scenario.desiredCount<1||scenario.desiredCount>100)errors.push('Desired count must be an integer from 1 to 100.');
  if(!CONFIDENCES.has(scenario.confidence))errors.push('Confidence must be 0.8, 0.9, 0.95 or 0.99.');
  if(typeof scenario.litterSize!=='number'||!Number.isFinite(scenario.litterSize)||scenario.litterSize<1||scenario.litterSize>20)errors.push('Nominal litter size must be a number from 1 to 20.');
  if(scenario.targets!==undefined&&!isObject(scenario.targets))errors.push('Targets must be an object keyed by locus ID.');
  if(isObject(scenario.targets))for(const [id,target] of Object.entries(scenario.targets)) {
    const locus=loci.find(locus=>locus?.id===id),label=text(locus?.name)?locus.name:id;
    if(!locus){errors.push(`Target locus ${id} is not configured.`);continue;}
    if(!isObject(target)||!['any','carrier','exact'].includes(target.mode)){errors.push(`${label}: target mode must be any, carrier or exact.`);continue;}
    const known=allele=>validAllele(allele)&&Array.isArray(locus.alleles)&&locus.alleles.includes(allele);
    if(target.mode==='carrier'&&!known(target.allele))errors.push(`${label}: choose a declared allele for the carrier target.`);
    if(target.mode==='exact'&&(!Array.isArray(target.alleles)||target.alleles.length!==2||!target.alleles.every(known)))errors.push(`${label}: an exact target requires two declared allele names.`);
  }
  return {errors:unique(errors),warnings:unique(warnings)};
}

function validateParent(parent,role,loci,{confirmedOnly=false}={}) {
  const errors=[],warnings=[],label=role==='Male'?'Sire':'Dam';
  if(!isObject(parent))return {errors:[`${label}: a parent with explicit genotype calls is required.`],warnings};
  if(parent.sex!==role)errors.push(`${label} sex must be ${role}.`);
  if(parent.id!==undefined&&!text(parent.id))errors.push(`${label}: an identifier, when supplied, must be nonempty text.`);
  if(!isObject(parent.calls))return {errors:[...errors,`${label}: genotype calls are missing.`],warnings};
  for(const locus of loci) {
    if(!isObject(locus)||!text(locus.id))continue;
    const description=`${label}, ${text(locus.name)?locus.name:locus.id}`,call=own(parent.calls,locus.id)?parent.calls[locus.id]:null;
    if(!isObject(call)){errors.push(`${description}: a genotype call is missing.`);continue;}
    if(call.evidence==='unknown')errors.push(`${description}: genotype evidence is unknown; no probability can be assigned.`);
    else if(!['confirmed','inferred'].includes(call.evidence))errors.push(`${description}: evidence must be confirmed, inferred or unknown.`);
    else if(call.evidence==='inferred') {
      if(confirmedOnly)errors.push(`${description}: inferred calls are excluded from candidate ranking; confirmed evidence is required.`);
      else warnings.push(`${description}: this genotype is inferred. The prediction is conditional on that unconfirmed call.`);
    }
    if(!Array.isArray(call.alleles)||call.alleles.length!==2||call.alleles.some(allele=>!validAllele(allele)||!Array.isArray(locus.alleles)||!locus.alleles.includes(allele)))errors.push(`${description}: exactly two known, declared alleles are required; no wild-type default is assumed.`);
  }
  return {errors,warnings};
}

export function validateScenario(scenario) {
  const result=validateConfig(scenario);
  if(!isObject(scenario))return result;
  const loci=Array.isArray(scenario.loci)?scenario.loci:[];
  for(const [parent,sex] of [[scenario.sire,'Male'],[scenario.dam,'Female']]) {
    const checked=validateParent(parent,sex,loci);result.errors.push(...checked.errors);result.warnings.push(...checked.warnings);
  }
  if(text(scenario.sire?.id)&&scenario.sire.id===scenario.dam?.id)result.errors.push('The sire and dam cannot have the same animal ID.');
  return {errors:unique(result.errors),warnings:unique(result.warnings)};
}

function assumptionsFor(scenario) {
  return [
    'Probabilities describe conception genotypes under diploid autosomal Mendelian segregation with equal transmission of each parental allele.',
    ...(scenario.loci.length>1?['All configured loci are assumed to assort independently; linkage, recombination fractions and haplotype phase are not modeled.']:[]),
    'Genotype outcome probabilities sum to one. Target matching in that table concerns genotype only; a requested sex contributes a separate 1/2 factor to the total target probability.',
    'The binomial count assumes independent offspring with the same target probability; the expected count is a mean, not a guarantee.',
    'Litter estimates divide by the supplied nominal litter size. Litter variation, pregnancy, fertility, survival and time to breeding are not modeled.',
    'Cre or reporter inheritance does not establish recombination, reporter expression, induction, penetrance or experimental suitability. Strain-specific germline effects, viability and fertility require separate review.',
    'Alternative reporter alleles at the same insertion locus must be configured as alleles of one locus, not independent loci.'
  ];
}

const canonicalPair=(alleles,locus)=>[...alleles].sort((a,b)=>locus.alleles.indexOf(a)-locus.alleles.indexOf(b));
function matches(alleles,target,locus) {
  if(!target||target.mode==='any')return true;
  if(target.mode==='carrier')return alleles.includes(target.allele);
  const exact=canonicalPair(target.alleles,locus);
  return alleles[0]===exact[0]&&alleles[1]===exact[1];
}

function locusOutcomes(locus,sire,dam,target) {
  const combined=new Map();
  for(const paternal of sire.calls[locus.id].alleles)for(const maternal of dam.calls[locus.id].alleles) {
    const alleles=canonicalPair([paternal,maternal],locus),key=JSON.stringify(alleles);
    const prior=combined.get(key);
    if(prior)prior.probability+=0.25;
    else combined.set(key,{alleles,probability:0.25,meetsTarget:matches(alleles,target,locus)});
  }
  return [...combined.values()].sort((a,b)=>compare(JSON.stringify(a.alleles),JSON.stringify(b.alleles)));
}

// Log-sum-exp avoids overflow of combinations and loss of tiny lower-tail terms.
function probabilityAtLeast(n,required,p) {
  if(required>n)return 0;
  if(p===1)return 1;
  if(p===0)return 0;
  const logP=Math.log(p),logQ=Math.log1p(-p);
  let term=n*logQ,sum=term;
  for(let k=1;k<required;k++) {
    term+=Math.log(n-k+1)-Math.log(k)+logP-logQ;
    const maximum=Math.max(sum,term);
    sum=maximum+Math.log1p(Math.exp(Math.min(sum,term)-maximum));
  }
  return Math.max(0,Math.min(1,-Math.expm1(Math.min(0,sum))));
}

function planningCounts(p,scenario) {
  if(p===0)return {expectedPups:null,confidencePups:null,expectedLitters:null,confidenceLitters:null};
  const required=scenario.desiredCount,expectedPups=required/p;
  let lower=required-1,upper=Math.max(required,Math.ceil(expectedPups));
  while(probabilityAtLeast(upper,required,p)<scenario.confidence)upper*=2;
  while(upper-lower>1) {
    const middle=Math.floor((lower+upper)/2);
    if(probabilityAtLeast(middle,required,p)>=scenario.confidence)upper=middle;else lower=middle;
  }
  return {expectedPups,confidencePups:upper,expectedLitters:expectedPups/scenario.litterSize,confidenceLitters:Math.ceil(upper/scenario.litterSize)};
}

function computeCross(scenario,expanded=true,countCache=null) {
  let outcomes=expanded?[{calls:{},probability:1,meetsTarget:true}]:[],genotypeTargetProbability=1,outcomeCount=1;
  for(const locus of scenario.loci) {
    const target=own(scenario.targets,locus.id)?scenario.targets[locus.id]:null;
    const perLocus=locusOutcomes(locus,scenario.sire,scenario.dam,target);
    genotypeTargetProbability*=perLocus.filter(outcome=>outcome.meetsTarget).reduce((sum,outcome)=>sum+outcome.probability,0);
    outcomeCount*=perLocus.length;
    if(expanded)outcomes=outcomes.flatMap(prior=>perLocus.map(outcome=>({calls:{...prior.calls,[locus.id]:[...outcome.alleles]},probability:prior.probability*outcome.probability,meetsTarget:prior.meetsTarget&&outcome.meetsTarget})));
  }
  const sexProbability=scenario.sex==='Any'?1:0.5,targetProbability=genotypeTargetProbability*sexProbability;
  let counts=countCache?.get(targetProbability);
  if(!counts){counts=planningCounts(targetProbability,scenario);countCache?.set(targetProbability,counts);}
  return {targetProbability,genotypeTargetProbability,sexProbability,...counts,outcomes,outcomeCount};
}

function noPrediction(errors,warnings) {
  return {errors,warnings,targetProbability:null,genotypeTargetProbability:null,sexProbability:null,expectedPups:null,confidencePups:null,expectedLitters:null,confidenceLitters:null,outcomes:[],outcomeCount:0,assumptions:[]};
}

export function predictCross(scenario) {
  const {errors,warnings}=validateScenario(scenario);
  if(errors.length)return noPrediction(errors,warnings);
  const result=computeCross(scenario);
  if(result.targetProbability===0)warnings.push('The requested target cannot be produced by this cross under the configured assumptions. Count estimates are unavailable.');
  return {errors,warnings,...result,assumptions:assumptionsFor(scenario)};
}

/** Rank only supplied, eligible candidates; this is not a global biological optimum. */
export function rankPairs(config,candidates) {
  const checked=validateConfig(config),result={pairs:[],excluded:[],errors:[...checked.errors],warnings:[...checked.warnings],assumptions:[]};
  if(!Array.isArray(candidates))result.errors.push('Candidates must be an array of animals with explicit genotype calls.');
  if(result.errors.length)return result;
  result.assumptions=[...assumptionsFor(config),'Ranking compares only the supplied eligible candidates and the requested genotype probability. It does not assess age, relatedness, fertility, welfare or breeding permission.'];
  const sires=[],dams=[],seen=new Set();
  for(const candidate of candidates) {
    const reasons=[],id=text(candidate?.id)?candidate.id:null;
    if(!id)reasons.push('A nonempty text animal ID is required.');
    else if(seen.has(id))result.errors.push(`Candidate ID ${id} is duplicated; rankings require unique animal IDs.`);
    seen.add(id);
    if(!['Male','Female'].includes(candidate?.sex))reasons.push('A recorded Male or Female sex is required.');
    const record=candidate?.record;
    if(candidate?.app_archived_at||candidate?.archived===true||record?.app_archived_at||record?.archived===true)reasons.push('Archived animals are excluded.');
    if(candidate?.state==='Ended'||record?.state==='Ended')reasons.push('Ended animals are excluded.');
    if(isObject(candidate)&&['Male','Female'].includes(candidate.sex))reasons.push(...validateParent(candidate,candidate.sex,config.loci,{confirmedOnly:true}).errors);
    if(reasons.length)result.excluded.push({id,reason:unique(reasons).join(' ')});
    else (candidate.sex==='Male'?sires:dams).push(candidate);
  }
  if(result.errors.length){result.errors=unique(result.errors);return result;}
  const pairCount=sires.length*dams.length;
  if(pairCount>MAX_PAIRS){result.errors.push(`The supplied candidates produce ${pairCount} pairs, exceeding the ${MAX_PAIRS}-pair limit. Narrow the candidates before ranking.`);return result;}
  if(!pairCount){result.warnings.push('No eligible sire–dam pairs remain after requiring confirmed calls at every configured locus.');return result;}
  if(result.excluded.length)result.warnings.push(`${result.excluded.length} candidate(s) were excluded; inspect their reasons before interpreting the ranking.`);
  const counts=new Map();
  for(const sire of sires)for(const dam of dams) {
    const prediction=computeCross({...config,sire,dam},false,counts),{outcomes,...summary}=prediction;
    result.pairs.push({sireId:sire.id,damId:dam.id,...summary,warnings:prediction.targetProbability===0?['This pair cannot produce the requested target under the configured assumptions.']:[]});
  }
  result.pairs.sort((a,b)=>b.targetProbability-a.targetProbability||compare(a.sireId,b.sireId)||compare(a.damId,b.damId));
  if(result.pairs.every(pair=>pair.targetProbability===0))result.warnings.push('None of the supplied eligible pairs can produce the requested target under the configured assumptions.');
  return result;
}
