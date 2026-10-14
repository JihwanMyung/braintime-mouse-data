/**
 * Prospective planning, not protocol approval or a global animal-number optimum.
 * No records, dates, animal outcomes, or permissions are changed by this module.
 * Power integrates P(reject | chi-square denominator) for a noncentral t variable.
 * The Welch route substitutes Satterthwaite df and is explicitly an approximation.
 */
export const IACUC_PLANNING_REFERENCES=Object.freeze([
  {id:'nc3rs-sample-size',title:'NC3Rs EDA: Group and sample size',url:'https://eda.nc3rs.org.uk/experimental-design-group'},
  {id:'nc3rs-unit',title:'NC3Rs EDA: Experimental unit',url:'https://eda.nc3rs.org.uk/experimental-design-unit'},
  {id:'arrive-sample-size',title:'ARRIVE 2a: Sample size',url:'https://arriveguidelines.org/arrive-guidelines/sample-size/2a/explanation'},
  {id:'arrive-unit',title:'ARRIVE 1b: Experimental unit',url:'https://arriveguidelines.org/arrive-guidelines/study-design/1b/explanation'},
  {id:'r-power',title:'R stats: Power calculations for t tests',url:'https://stat.ethz.ch/R-manual/R-devel/library/stats/html/power.t.test.html'},
  {id:'r-t',title:'R stats: Student t distribution',url:'https://stat.ethz.ch/R-manual/R-devel/library/stats/html/TDist.html'},
  {id:'r-binomial',title:'R stats: Binomial distribution',url:'https://stat.ethz.ch/R-manual/R-devel/library/stats/html/Binomial.html'},
  {id:'cluster',title:'CONSORT extension: Cluster randomised trials, design effect',url:'https://www.bmj.com/content/345/bmj.e5661'},
]);

const MAX_UNITS=1_000_000,MAX_OFFSPRING=10_000_000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const present=x=>x!==undefined&&x!==null;
const clamp=x=>Math.max(0,Math.min(1,x));
const int=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
const LN2=Math.log(2),LNPI=Math.log(Math.PI);
const LANCZOS=[676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
function logGamma(z) {
  if(z<.5)return LNPI-Math.log(Math.sin(Math.PI*z))-logGamma(1-z);
  z-=1;let x=.99999999999980993;
  for(let i=0;i<LANCZOS.length;i++)x+=LANCZOS[i]/(z+i+1);
  const t=z+7.5;
  return .5*Math.log(2*Math.PI)+(z+.5)*Math.log(t)-t+Math.log(x);
}
function betaFraction(a,b,x) {
  const tiny=1e-300,eps=3e-14;let c=1,d=1-(a+b)*x/(a+1);
  if(Math.abs(d)<tiny)d=tiny;d=1/d;let h=d;
  for(let m=1;m<=2000;m++) {
    let aa=m*(b-m)*x/((a+2*m-1)*(a+2*m));
    d=1+aa*d;if(Math.abs(d)<tiny)d=tiny;c=1+aa/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;h*=d*c;
    aa=-(a+m)*(a+b+m)*x/((a+2*m)*(a+2*m+1));
    d=1+aa*d;if(Math.abs(d)<tiny)d=tiny;c=1+aa/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;const step=d*c;h*=step;
    if(Math.abs(step-1)<eps)return h;
  }
  throw new Error('Incomplete-beta calculation did not converge.');
}
function regularizedBeta(x,a,b) {
  if(x<=0)return 0;if(x>=1)return 1;
  const front=Math.exp(logGamma(a+b)-logGamma(a)-logGamma(b)+a*Math.log(x)+b*Math.log1p(-x));
  return clamp(x<(a+1)/(a+b+2)?front*betaFraction(a,b,x)/a:1-front*betaFraction(b,a,1-x)/b);
}
// Normal tails use the incomplete gamma Q(1/2,x²/2), avoiding a low-accuracy erf fit.
function normalCDF(x) {
  if(x===0)return .5;if(x>39)return 1;if(x< -39)return 0;
  const z=x*x/2,a=.5,front=Math.exp(-z+a*Math.log(z)-.5*LNPI);let q;
  if(z<a+1) {
    let term=1/a,sum=term,ap=a;
    for(let k=1;k<500;k++){ap+=1;term*=z/ap;sum+=term;if(Math.abs(term)<Math.abs(sum)*2e-15)break;}
    q=1-front*sum;
  } else {
    let b=z+1-a,c=1e300,d=1/b,h=d;
    for(let k=1;k<500;k++) {
      const an=-k*(k-a);b+=2;d=an*d+b;if(Math.abs(d)<1e-300)d=1e-300;c=b+an/c;if(Math.abs(c)<1e-300)c=1e-300;
      d=1/d;const step=d*c;h*=step;if(Math.abs(step-1)<2e-15)break;
    }
    q=front*h;
  }
  return clamp(x<0?.5*q:1-.5*q);
}
function tUpperTail(t,df) {return .5*regularizedBeta(df/(df+t*t),df/2,.5);}
function tCritical(alpha,df) {
  let lo=0,hi=1;while(tUpperTail(hi,df)>alpha/2){hi*=2;if(hi>1e9)throw new Error('Critical-value search exceeded its limit.');}
  for(let k=0;k<65;k++){const mid=(lo+hi)/2;if(tUpperTail(mid,df)>alpha/2)lo=mid;else hi=mid;}
  return (lo+hi)/2;
}
function adaptiveSimpson(fn,a,b,tolerance,depth=20) {
  const mid=(a+b)/2,fa=fn(a),fb=fn(b),fm=fn(mid),initial=(b-a)*(fa+4*fm+fb)/6;
  function refine(a,b,fa,fm,fb,whole,tol,leftDepth) {
    const m=(a+b)/2,l=(a+m)/2,r=(m+b)/2,fl=fn(l),fr=fn(r);
    const first=(m-a)*(fa+4*fl+fm)/6,second=(b-m)*(fm+4*fr+fb)/6,diff=first+second-whole;
    if(Math.abs(diff)<=15*tol)return first+second+diff/15;
    if(leftDepth===0)throw new Error('Power integration did not reach the required numerical tolerance.');
    return refine(a,m,fa,fl,fm,first,tol/2,leftDepth-1)+refine(m,b,fm,fr,fb,second,tol/2,leftDepth-1);
  }
  return refine(a,b,fa,fm,fb,initial,tolerance,depth);
}
function noncentralTPower(df,ncp,alpha) {
  const critical=tCritical(alpha,df);
  if(ncp===0)return {power:alpha,critical,df,ncp};
  const delta=Math.abs(ncp),mode=Math.sqrt(Math.max(0,df-1)),norm=(1-df/2)*LN2-logGamma(df/2);
  const modeLog=mode===0?norm:norm+(df-1)*Math.log(mode)-mode*mode/2;
  const log1pMinusX=z=>{
    if(Math.abs(z)>.1)return Math.log1p(z)-z;
    let power=z*z,sum=-power/2;
    for(let k=3;k<40;k++){power*=z;const term=(k%2?1:-1)*power/k;sum+=term;if(Math.abs(term)<Math.abs(sum)*1e-16)break;}
    return sum;
  };
  const lower=Math.max(0,mode-12),upper=mode+12;
  const integrand=x=>{
    if(x<0||x===0&&df>1)return 0;
    const offset=x-mode;
    const density=Math.exp(mode===0?norm-x*x/2:modeLog+(df-1)*log1pMinusX(offset/mode)-offset*offset/2);
    const cut=critical*x/Math.sqrt(df);
    return density*(normalCDF(delta-cut)+normalCDF(-delta-cut));
  };
  // Split around the chi density mode so broad intervals cannot miss its peak.
  // x=t^4 removes the fractional-power endpoint singularity for low Welch df.
  let start=lower,total=0;
  const transitions=[-8,-4,0,4,8].map(z=>(delta+z)*Math.sqrt(df)/critical);
  if(lower===0){
    const breaks=[...new Set([0,1,...transitions.filter(x=>x>0&&x<1).map(x=>x**.25)])].sort((a,b)=>a-b);
    for(let k=1;k<breaks.length;k++)total+=adaptiveSimpson(t=>t===0?0:integrand(t**4)*4*t**3,breaks[k-1],breaks[k],1e-11/breaks.length);
    start=1;
  }
  const steps=Math.ceil((upper-start)/.5),breaks=[...new Set([...Array.from({length:steps+1},(_,k)=>start+(upper-start)*k/steps),...transitions.filter(x=>x>start&&x<upper)])].sort((a,b)=>a-b);
  for(let k=1;k<breaks.length;k++)total+=adaptiveSimpson(integrand,breaks[k-1],breaks[k],2e-10/breaks.length);
  if(!finite(total)||total< -1e-8||total>1+1e-8)throw new Error('Power integration returned an invalid probability.');
  return {power:clamp(total),critical,df,ncp};
}

function validateContinuous(input,planning) {
  const errors=[],warnings=[];
  if(!object(input))return {errors:['A planning object is required.'],warnings,config:null};
  const c={design:'independent',variance:'pooled',alpha:.05,power:.8,allocationRatio:1,experimentalUnit:'animal',technicalReplicates:1,attrition:0,maxUnitsPerGroup:MAX_UNITS,...input};
  if(!['independent','paired'].includes(c.design))errors.push('Design must be independent or paired.');
  if(present(c.sidedness)&&c.sidedness!=='two-sided')errors.push('Only two-sided tests are supported.');
  if(!finite(c.alpha)||c.alpha<1e-6||c.alpha>.5)errors.push('Alpha must be a number from 0.000001 to 0.5.');
  if(planning&&(!finite(c.power)||c.power<=c.alpha||c.power>=1))errors.push('Target power must be greater than alpha and less than 1.');
  if(!finite(c.allocationRatio)||c.allocationRatio<.01||c.allocationRatio>100)errors.push('Allocation ratio n2/n1 must be from 0.01 to 100.');
  if(c.design==='paired'&&c.allocationRatio!==1)errors.push('Paired designs require allocation ratio 1.');
  if(!int(c.maxUnitsPerGroup,2,MAX_UNITS))errors.push(`Search limit must be an integer from 2 to ${MAX_UNITS}.`);
  const hasMeans=present(c.mean1)||present(c.mean2);
  if(hasMeans) {
    if(!finite(c.mean1)||!finite(c.mean2))errors.push('Supply both group means as finite numbers.');
    else {
      const derived=c.mean2-c.mean1;
      if(present(c.effect)&&(!finite(c.effect)||Math.abs(Math.abs(c.effect)-Math.abs(derived))>1e-10*Math.max(1,Math.abs(derived))))errors.push('Supplied effect must agree with the difference between the two means.');
      c.effect=derived;
    }
  } else if(!finite(c.effect))errors.push('Supply two means or an explicit mean difference (effect).');
  if(!finite(c.effect))errors.push('The mean difference must be finite.');
  if(c.design==='paired') {
    if(present(c.sdDifference)) {
      if(!finite(c.sdDifference)||c.sdDifference<=0)errors.push('SD of paired differences must be positive.');
      if(present(c.correlation)||present(c.sd1)||present(c.sd2))errors.push('Use either SD of differences or both marginal SDs and correlation, not both routes.');
    } else {
      if(!finite(c.sd1)||c.sd1<=0||!finite(c.sd2)||c.sd2<=0||!finite(c.correlation)||c.correlation< -1||c.correlation>1)errors.push('Paired planning needs SD of differences, or positive SDs for both measurements and an explicit correlation from -1 to 1.');
      else c.sdDifference=Math.sqrt(c.sd1*c.sd1+c.sd2*c.sd2-2*c.correlation*c.sd1*c.sd2);
      if(c.sdDifference===0)errors.push('The supplied paired variance is zero; a t-test power calculation is undefined.');
    }
    if(present(c.sd))errors.push('A common marginal SD cannot substitute for SD of paired differences.');
    if(c.variance!=='pooled')errors.push('The variance option does not apply to paired differences.');
  } else if(c.variance==='pooled') {
    if(!finite(c.sd)||c.sd<=0)errors.push('A positive common SD is required for the pooled t-test model.');
    if(present(c.sd1)||present(c.sd2)||present(c.sdDifference)||present(c.correlation))errors.push('Use common SD for pooled independent planning; choose Welch explicitly for unequal group SDs.');
  } else if(c.variance==='welch') {
    if(!finite(c.sd1)||c.sd1<=0||!finite(c.sd2)||c.sd2<=0)errors.push('Welch planning requires positive SDs for both groups.');
    if(present(c.sd)||present(c.sdDifference)||present(c.correlation))errors.push('Welch planning uses the two group SDs only.');
    warnings.push('Welch power uses a noncentral-t/Satterthwaite approximation with population SDs; it is not the exact power of the random-df Welch test.');
  } else errors.push('Variance method must be pooled or welch.');
  if(!['animal','cage','litter','custom'].includes(c.experimentalUnit))errors.push('Experimental unit must be animal, cage, litter or custom.');
  if(c.experimentalUnit==='animal') {
    if(present(c.animalsPerUnit)&&c.animalsPerUnit!==1)errors.push('An animal experimental unit contains exactly one animal.');
    c.animalsPerUnit=1;
  } else if(!int(c.animalsPerUnit,1,10000))errors.push('Specify a positive integer animals per experimental unit (at most 10000).');
  if(!int(c.technicalReplicates,1,100000))errors.push('Technical replicates must be a positive integer (at most 100000).');
  if(!finite(c.attrition)||c.attrition<0||c.attrition>=1)errors.push('Attrition must be a fraction from 0 up to, but not including, 1.');
  if(present(c.cluster)) {
    if(!object(c.cluster)||!int(c.cluster.animalsPerCage,2,10000)||!finite(c.cluster.icc)||c.cluster.icc<0||c.cluster.icc>1)errors.push('Cluster inflation needs an integer animals per cage of 2–10000 and ICC from 0 to 1.');
    if(c.design!=='independent'||c.experimentalUnit!=='animal')errors.push('Cluster inflation is supported only for independent animal-level planning, not paired designs or SDs already measured between cages.');
    warnings.push('Cage design-effect inflation is approximate. It does not recalculate cluster-level degrees of freedom or power; use a dedicated cluster design for a final justification.');
  }
  if(!planning) {
    if(!int(c.n1,2,MAX_UNITS))errors.push(`n1 must be an integer from 2 to ${MAX_UNITS}.`);
    if(c.design==='independent'&&!int(c.n2,2,MAX_UNITS))errors.push(`n2 must be an integer from 2 to ${MAX_UNITS}.`);
    if(c.design==='paired'&&present(c.n2)&&c.n2!==c.n1)errors.push('For paired power n1 is the complete-pair count; n2, if supplied, must equal n1.');
  }
  warnings.push('Assumed or guessed means and SDs do not establish a biologically meaningful effect or uncertainty in those assumptions; examine sensitivity scenarios.');
  if(c.experimentalUnit!=='animal')warnings.push('Means and SDs must describe independent experimental units, for example cage means; animal-level SDs cannot be substituted.');
  if(c.technicalReplicates>1)warnings.push('Technical replicates are subsamples and do not increase the independent sample size.');
  return {errors:[...new Set(errors)],warnings,config:c};
}
function modelPower(c,n1,n2) {
  let se,df;
  if(c.design==='paired'){se=c.sdDifference/Math.sqrt(n1);df=n1-1;}
  else if(c.variance==='pooled'){se=c.sd*Math.sqrt(1/n1+1/n2);df=n1+n2-2;}
  else {
    const v1=c.sd1*c.sd1/n1,v2=c.sd2*c.sd2/n2;
    se=Math.sqrt(v1+v2);df=(v1+v2)**2/(v1*v1/(n1-1)+v2*v2/(n2-1));
  }
  if(!finite(se)||se<=0||!finite(df))throw new Error('SDs or effect are outside the supported numerical scale.');
  const ncp=Math.abs(c.effect)/se;
  if(!finite(ncp))throw new Error('The standardized effect is outside the supported numerical scale.');
  const result=noncentralTPower(df,ncp,c.alpha);
  return {...result,standard_error:se};
}
function method(c) {return c.design==='paired'?'paired_noncentral_t':c.variance==='welch'?'welch_satterthwaite_approximation':'pooled_noncentral_t';}
const COMMON_LIMITATIONS=[
  'One prespecified continuous primary contrast with approximately normal independent errors; no multiplicity, repeated-measures model, non-normal outcome, interaction or sequential stopping is modeled.',
  'This is the minimum integer size along the specified allocation rule under supplied assumptions, not a global or biological optimum and not IACUC approval.',
  'Attrition adjustment is a conservative rounded expected retention allowance, not a probability guarantee that enough units survive or remain analyzable.',
];

/** Power at supplied analyzed n1/n2; paired n1 counts complete pairs. */
export function continuousPower(input) {
  const checked=validateContinuous(input,false),base={errors:checked.errors,warnings:checked.warnings,power:null,method:checked.config?method(checked.config):null};
  if(base.errors.length)return base;
  try{return {...base,...modelPower(checked.config,checked.config.n1,checked.config.n2),sidedness:'two-sided',approximate:checked.config.variance==='welch'};}
  catch(error){return {...base,errors:[error.message]};}
}

/** n2 = ceil(allocationRatio*n1); smallest n1 meeting power within the search bound. */
export function planContinuousSampleSize(input) {
  const checked=validateContinuous(input,true),c=checked.config;
  const base={errors:checked.errors,warnings:checked.warnings,status:'invalid',method:c?method(c):null,assumptions:[...COMMON_LIMITATIONS],n1:null,n2:null,achieved_power:null,allocation:null,adjustment:null};
  if(base.errors.length)return base;
  if(c.effect===0)return {...base,status:'unattainable',errors:['Zero mean difference cannot attain power above alpha.']};
  const n2For=n=>c.design==='paired'?null:Math.ceil(c.allocationRatio*n);
  const minimum=c.design==='paired'?2:Math.max(2,Math.ceil(2/c.allocationRatio));
  const maximum=c.design==='paired'?c.maxUnitsPerGroup:Math.min(c.maxUnitsPerGroup,Math.floor(c.maxUnitsPerGroup/c.allocationRatio));
  if(minimum>maximum)return {...base,status:'limit',errors:['Allocation ratio leaves no supported group sizes within the search limit.']};
  try {
    const cache=new Map(),at=n=>{if(!cache.has(n))cache.set(n,modelPower(c,n,n2For(n)));return cache.get(n);};
    let low=minimum-1,high=minimum;
    while(at(high).power<c.power&&high<maximum){low=high;high=Math.min(maximum,high*2);}
    if(at(high).power<c.power)return {...base,status:'limit',errors:[`Target power was not reached within ${c.maxUnitsPerGroup} units per group.`],maximum_checked:{n1:high,n2:n2For(high),power:at(high).power}};
    while(high-low>1){const mid=Math.floor((high+low)/2);if(at(mid).power>=c.power)high=mid;else low=mid;}
    const n1=high,n2=n2For(high),groups=c.design==='paired'?[n1]:[n1,n2],result=at(n1);
    const designEffect=c.cluster?1+(c.cluster.animalsPerCage-1)*c.cluster.icc:1;
    const inflated=groups.map(n=>Math.ceil(n*designEffect));
    const retainedUnits=groups.map(n=>Math.ceil(n/(1-c.attrition)));
    const clusterCages=c.cluster?inflated.map(n=>Math.max(2,Math.ceil(n/(1-c.attrition)/c.cluster.animalsPerCage))):null;
    const animals=c.cluster?clusterCages.map(n=>n*c.cluster.animalsPerCage):retainedUnits.map(n=>n*c.animalsPerUnit);
    if(animals.some(n=>!Number.isSafeInteger(n)||n>1e9))return {...base,status:'limit',errors:['Adjusted animal counts exceed the supported planning limit.']};
    return {...base,status:'ok',errors:[],method:method(c),approximate:c.variance==='welch'||Boolean(c.cluster),n1,n2,
      achieved_power:result.power,df:result.df,critical:result.critical,noncentrality:result.ncp,standard_error:result.standard_error,
      previous_power:n1>minimum?at(n1-1).power:null,alpha:c.alpha,target_power:c.power,effect:c.effect,sd_difference:c.design==='paired'?c.sdDifference:null,
      allocation:{rule:c.design==='paired'?'complete_pairs':'n2 = ceil(allocationRatio × n1)',requested_ratio:c.allocationRatio,actual_ratio:n2===null?1:n2/n1},
      adjustment:{analyzed_units_per_group:groups,independent_equivalent_units_per_group:groups,experimental_unit:c.cluster?'cage':c.experimentalUnit,
        recruited_units_per_group:c.cluster?clusterCages:retainedUnits,animals_per_group:animals,total_animals:animals.reduce((a,b)=>a+b,0),
        animals_per_unit:c.cluster?c.cluster.animalsPerCage:c.animalsPerUnit,technical_replicates:c.technicalReplicates,
        measurement_count:(c.cluster?animals:retainedUnits).reduce((a,b)=>a+b,0)*c.technicalReplicates*(c.design==='paired'?2:1),
        attrition:c.attrition,attrition_basis:c.design==='paired'?'complete_pairs':'individual_units',design_effect:designEffect,
        cluster:c.cluster?{...c.cluster,cages_per_group:clusterCages,approximate:true,power_recomputed:false,attrition_basis:'individual_animals',whole_cage_loss_modeled:false}:null},
      inputs:{...c},references:IACUC_PLANNING_REFERENCES};
  } catch(error){return {...base,status:'numerical_error',errors:[error.message]};}
}

/** Exact binomial tail under independent offspring with a fixed usable probability. */
export function breedingYieldProbability(total,target,probability) {
  if(!int(total,0,MAX_OFFSPRING)||!int(target,0,MAX_OFFSPRING)||!finite(probability)||probability<0||probability>1)return null;
  if(target===0)return 1;if(target>total||probability===0)return 0;if(probability===1)return 1;
  try{return regularizedBeta(probability,target,total-target+1);}catch{return null;}
}

export function planBreedingYield(input) {
  const base={errors:[],warnings:[],status:'invalid',usable_probability:null,expected_offspring:null,confidence_offspring:null,achieved_probability:null,expected_litters:null,confidence_litters:null,expected_pairs:null,confidence_pairs:null};
  if(!object(input))return {...base,errors:['A breeding planning object is required.']};
  const c={confidence:.95,maxOffspring:MAX_OFFSPRING,...input};
  if(!int(c.target,0,MAX_OFFSPRING))base.errors.push(`Target usable offspring must be an integer from 0 to ${MAX_OFFSPRING}.`);
  for(const [key,label] of [['genotypeProbability','Genotype probability'],['sexProbability','Sex probability'],['survivalProbability','Survival/suitability probability']])if(!finite(c[key])||c[key]<0||c[key]>1)base.errors.push(`${label} must be supplied as a fraction from 0 to 1.`);
  if(!finite(c.confidence)||c.confidence<=0||c.confidence>=1)base.errors.push('Planning confidence must be greater than 0 and less than 1.');
  if(!int(c.maxOffspring,1,MAX_OFFSPRING))base.errors.push(`Offspring limit must be an integer from 1 to ${MAX_OFFSPRING}.`);
  if(present(c.litterSize)&&(!finite(c.litterSize)||c.litterSize<=0||c.litterSize>100))base.errors.push('Mean litter size must be greater than 0 and at most 100.');
  if(present(c.littersPerPair)&&(!finite(c.littersPerPair)||c.littersPerPair<=0||c.littersPerPair>100))base.errors.push('Mean litters per pair must be greater than 0 and at most 100.');
  if(present(c.littersPerPair)&&!present(c.litterSize))base.errors.push('Litter size is required to convert litters per pair into pair counts.');
  if(base.errors.length)return base;
  const p=c.genotypeProbability*c.sexProbability*c.survivalProbability;
  base.usable_probability=p;
  base.assumptions=[
    'Usable probability = P(target genotype) × P(target sex | genotype) × P(survives and is suitable | genotype and sex). If marginal probabilities are entered, independence is assumed.',
    'Binomial confidence is conditional on a fixed number of born offspring with independent, identical usable probabilities. Shared litter effects and uncertainty in probabilities are not included.',
    'Expected offspring is target divided by usable probability, not a guarantee. A confidence birth count does not guarantee pregnancy, births, usable offspring or completion by a date.',
    'Litter and pair counts use supplied mean productivity. Rounding a confidence birth count into litters or pairs does not confer that confidence on breeding productivity.',
    'Survival and attrition must describe distinct stages; do not count the same expected loss in both experimental recruitment and breeding suitability.',
  ];
  base.references=IACUC_PLANNING_REFERENCES.filter(r=>['r-binomial','nc3rs-sample-size'].includes(r.id));
  if(p===0&&c.target>0)return {...base,status:'unattainable',errors:['No usable offspring are possible under the supplied zero probability.']};
  const expected=c.target===0?0:c.target/p;
  const probability=n=>{const result=breedingYieldProbability(n,c.target,p);if(result===null)throw new Error('Binomial probability calculation did not converge.');return result;};
  try {
    let lo=c.target-1,hi=Math.min(c.maxOffspring,Math.max(c.target,Math.ceil(expected)));
    if(c.target>c.maxOffspring)return {...base,status:'limit',expected_offspring:expected,errors:['Target exceeds the offspring search limit.']};
    while(probability(hi)<c.confidence&&hi<c.maxOffspring){lo=hi;hi=Math.min(c.maxOffspring,Math.max(hi+1,hi*2));}
    if(probability(hi)<c.confidence)return {...base,status:'limit',expected_offspring:expected,maximum_checked:{offspring:hi,probability:probability(hi)},errors:['Requested confidence was not reached within the offspring search limit.']};
    while(hi-lo>1){const mid=Math.floor((hi+lo)/2);if(probability(mid)>=c.confidence)hi=mid;else lo=mid;}
    return {...base,status:'ok',expected_offspring:expected,expected_offspring_rounded:Math.ceil(expected),confidence_offspring:hi,achieved_probability:probability(hi),previous_probability:hi>0?probability(hi-1):null,
      expected_litters:present(c.litterSize)?expected/c.litterSize:null,confidence_litters:present(c.litterSize)?Math.ceil(hi/c.litterSize):null,
      expected_pairs:present(c.littersPerPair)?expected/(c.litterSize*c.littersPerPair):null,confidence_pairs:present(c.littersPerPair)?Math.ceil(hi/(c.litterSize*c.littersPerPair)):null,
      expected_unusable_at_confidence_count:hi*(1-p),breeder_animals:null,
      warnings:['The confidence label applies to usable offspring among the planned number of births, not to the number of litters or breeding pairs.'],inputs:{...c}};
  }catch(error){return {...base,status:'numerical_error',errors:[error.message]};}
}
