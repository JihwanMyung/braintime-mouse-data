import test from 'node:test';
import assert from 'node:assert/strict';
import {continuousPower,planContinuousSampleSize,planBreedingYield,breedingYieldProbability,IACUC_PLANNING_REFERENCES} from '../web/iacuc-planning.js';

const close=(actual,expected,tolerance=2e-8)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);
const basic={design:'independent',effect:.5,sd:1,alpha:.05,power:.8};

// Independently generated in R 4.6.1 with pt(-qt(1-alpha/2,df),df,ncp) +
// pt(qt(1-alpha/2,df),df,ncp,lower.tail=FALSE), matching strict=TRUE in
// stats::power.t.test. Welch fixtures validate the declared approximation only.
const referenceCases=[
  [{effect:.5,sd:1,n1:2,n2:2},.061507856556577645],
  [{effect:1,sd:1,n1:3,n2:3},.15879087000612446],
  [{effect:1.2,sd:1,n1:8,n2:8,alpha:.01},.32461085775625742],
  [{effect:0,sd:1,n1:20,n2:20},.05],
  [{effect:.5,sd:1,n1:64,n2:64},.80145955792228418],
  [{effect:.7,sd:1,n1:12,n2:27},.50210399730301303],
  [{effect:.1,sd:1,n1:1500,n2:2200},.84748770589848499],
  [{effect:.01,sd:1,n1:100000,n2:200000},.73303732623388318],
  [{design:'paired',effect:.5,sdDifference:1,n1:2},.061948606687284635],
  [{design:'paired',effect:1,sdDifference:1,n1:3,alpha:.0001},.00039991001566908047],
  [{design:'paired',effect:.5,sdDifference:1,n1:34},.80777750127944015],
  [{design:'paired',effect:-.8,sdDifference:1,n1:19,alpha:.01},.72134608160797542],
  [{variance:'welch',effect:.7,sd1:1,sd2:2,n1:8,n2:12},.16434630434520481],
  [{variance:'welch',effect:1,sd1:1,sd2:2,n1:41,n2:41},.80415685140466542],
  [{variance:'welch',effect:1.5,sd1:.8,sd2:3,n1:17,n2:33,alpha:.01},.50194595239892714],
];
test('strict two-sided noncentral-t powers agree with independent R reference values',()=>{
  for(const [input,expected] of referenceCases){const result=continuousPower(input);assert.deepEqual(result.errors,[]);close(result.power,expected);}
});

test('extreme cutoffs cannot hide narrow integration mass and high df does not lose density precision',()=>{
  close(continuousPower({design:'paired',effect:.5,sdDifference:1,n1:2,alpha:1e-6}).power,.0000012400735991402456,2e-11);
  close(continuousPower({design:'paired',effect:.01,sdDifference:1,n1:1000000,alpha:1e-6}).power,.9999998374663452,2e-8);
  // R explicitly limits noncentral-t accuracy to |ncp|<=37.62. These large-ncp
  // fixtures instead use independent scipy.integrate.quad of the defining
  // conditional-normal integral, split at ncp*sqrt(df)/critical.
  close(continuousPower({design:'paired',effect:1000,sdDifference:1,n1:2,alpha:1e-6}).power,.001772452393121006,2e-10);
  close(continuousPower({design:'paired',effect:1000,sdDifference:1,n1:3,alpha:1e-6}).power,.9502129067386204,2e-10);
});

test('returns the smallest qualifying equal-allocation size and preserves input',()=>{
  const input=structuredClone(basic),result=planContinuousSampleSize(input);
  assert.deepEqual(input,basic);assert.deepEqual(result.errors,[]);
  assert.equal(result.status,'ok');assert.equal(result.n1,64);assert.equal(result.n2,64);
  assert.ok(result.previous_power<.8);assert.ok(result.achieved_power>=.8);
  assert.equal(result.adjustment.total_animals,128);
  assert.match(result.assumptions.join(' '),/not a global.*optimum/);
});

test('unequal allocation uses the explicit rounded ratio rather than doubling a single-group result',()=>{
  const result=planContinuousSampleSize({...basic,allocationRatio:2});
  assert.equal(result.n1,48);assert.equal(result.n2,96);assert.equal(result.allocation.actual_ratio,2);
  assert.ok(continuousPower({...basic,n1:47,n2:94}).power<.8);
  const reversed=planContinuousSampleSize({...basic,allocationRatio:.5});
  assert.equal(reversed.n2,Math.ceil(reversed.n1*.5));assert.ok(reversed.previous_power<.8);
});

test('means and explicitly signed differences represent the same two-sided contrast',()=>{
  const a=planContinuousSampleSize({mean1:10,mean2:12,sd:4});
  const b=planContinuousSampleSize({effect:-2,sd:4});
  assert.equal(a.n1,b.n1);close(a.achieved_power,b.achieved_power);
  assert.ok(planContinuousSampleSize({mean1:10,mean2:12,effect:3,sd:4}).errors.some(e=>e.includes('agree')));
});

test('paired planning needs explicit difference variance and counts each unit once',()=>{
  const direct=planContinuousSampleSize({design:'paired',effect:.5,sdDifference:1});
  const fromCorrelation=planContinuousSampleSize({design:'paired',effect:.5,sd1:1,sd2:1,correlation:.5});
  assert.equal(direct.n1,34);assert.equal(direct.n2,null);assert.equal(direct.adjustment.total_animals,34);
  assert.equal(fromCorrelation.sd_difference,1);assert.equal(fromCorrelation.n1,direct.n1);
  assert.equal(direct.adjustment.attrition_basis,'complete_pairs');
  assert.ok(planContinuousSampleSize({design:'paired',effect:.5,sd:1}).errors.length);
  assert.ok(planContinuousSampleSize({design:'paired',effect:.5,sd1:1,sd2:1}).errors.length);
  assert.ok(planContinuousSampleSize({design:'paired',effect:.5,sd1:1,sd2:1,correlation:1}).errors.some(e=>e.includes('zero')));
  assert.ok(planContinuousSampleSize({design:'paired',effect:.5,sdDifference:1,correlation:.5}).errors.length);
});

test('Welch calculation is labeled approximate, handles low fractional df and preserves separate SDs',()=>{
  const result=planContinuousSampleSize({variance:'welch',effect:1,sd1:1,sd2:2});
  assert.deepEqual(result.errors,[]);assert.equal(result.n1,41);assert.equal(result.n2,41);
  assert.equal(result.approximate,true);assert.match(result.method,/welch/);assert.match(result.warnings.join(' '),/not the exact power/);
  const low=continuousPower({variance:'welch',effect:.5,sd1:1,sd2:10,n1:2,n2:2});
  assert.deepEqual(low.errors,[]);assert.ok(low.df>1&&low.df<2);
});

test('technical repeats never reduce biological N; whole-unit attrition rounds conservatively',()=>{
  const result=planContinuousSampleSize({...basic,technicalReplicates:5,attrition:.1});
  assert.equal(result.n1,64);assert.deepEqual(result.adjustment.recruited_units_per_group,[72,72]);
  assert.equal(result.adjustment.total_animals,144);assert.match(result.warnings.join(' '),/subsamples/);
  const unit=planContinuousSampleSize({...basic,experimentalUnit:'cage',animalsPerUnit:4,attrition:.1});
  assert.equal(unit.n1,64);assert.equal(unit.adjustment.total_animals,576);
  assert.equal(unit.adjustment.measurement_count,144);
  assert.match(unit.warnings.join(' '),/cage means/);
  assert.ok(planContinuousSampleSize({...basic,experimentalUnit:'cage'}).errors.length);
});

test('cluster inflation is separate from exact individual-unit power and rounds to cages',()=>{
  const result=planContinuousSampleSize({...basic,cluster:{animalsPerCage:4,icc:.2},attrition:.1});
  close(result.adjustment.design_effect,1.6);
  assert.deepEqual(result.adjustment.cluster.cages_per_group,[29,29]);
  assert.deepEqual(result.adjustment.animals_per_group,[116,116]);
  assert.equal(result.adjustment.cluster.power_recomputed,false);
  assert.equal(result.adjustment.cluster.whole_cage_loss_modeled,false);
  assert.equal(result.adjustment.experimental_unit,'cage');
  assert.equal(result.approximate,true);
  assert.ok(planContinuousSampleSize({...basic,experimentalUnit:'cage',animalsPerUnit:4,cluster:{animalsPerCage:4,icc:.2}}).errors.length);
});

test('zero effect, infeasible limits and malformed numbers return explicit failures',()=>{
  assert.equal(planContinuousSampleSize({...basic,effect:0}).status,'unattainable');
  const limit=planContinuousSampleSize({...basic,maxUnitsPerGroup:10});
  assert.equal(limit.status,'limit');assert.equal(limit.n1,null);assert.ok(limit.maximum_checked.power<.8);
  for(const changed of [{sd:0},{sd:-1},{effect:NaN},{alpha:0},{alpha:'0.05'},{power:1},{power:.04},{attrition:1},{allocationRatio:0},{technicalReplicates:1.5},{sidedness:'one-sided'},{cluster:{animalsPerCage:4,icc:1.1}}])assert.ok(planContinuousSampleSize({...basic,...changed}).errors.length,JSON.stringify(changed));
  assert.ok(continuousPower({...basic,n1:1,n2:20}).errors.length);
  assert.ok(continuousPower({...basic,n1:20,n2:2.5}).errors.length);
});

test('stronger effects lower required N while higher power or alpha correction increase it',()=>{
  const normal=planContinuousSampleSize(basic);
  assert.ok(planContinuousSampleSize({...basic,effect:1}).n1<normal.n1);
  assert.ok(planContinuousSampleSize({...basic,power:.9}).n1>normal.n1);
  assert.ok(planContinuousSampleSize({...basic,alpha:.01}).n1>normal.n1);
});

test('binomial tails agree with independent R pbinom references, including large counts',()=>{
  for(const [n,k,p,expected] of [[137,10,.1125,.95235041334442661],[136,10,.1125,.94950882275225523],[100,2,.001,.0046380683904241847],[1000,500,.5,.51261250908918043],[1000000,1000,.001,.50421155516699234],[100,99,.99,.73576197892295625]])close(breedingYieldProbability(n,k,p),expected);
  assert.equal(breedingYieldProbability(0,0,0),1);assert.equal(breedingYieldProbability(10,11,.9),0);
  assert.equal(breedingYieldProbability(10,10,1),1);assert.equal(breedingYieldProbability(10,1,0),0);
  assert.equal(breedingYieldProbability(3.5,2,.5),null);
});

test('breeding confidence finds the minimum birth count and does not equate expected yield to confidence',()=>{
  const input={target:10,genotypeProbability:.25,sexProbability:.5,survivalProbability:.9,litterSize:6,littersPerPair:3},before=structuredClone(input);
  const result=planBreedingYield(input);
  assert.deepEqual(input,before);assert.equal(result.status,'ok');close(result.usable_probability,.1125);
  close(result.expected_offspring,88.88888888888889);assert.equal(result.expected_offspring_rounded,89);
  assert.equal(result.confidence_offspring,137);assert.ok(result.achieved_probability>=.95);assert.ok(result.previous_probability<.95);
  assert.equal(result.confidence_litters,23);assert.equal(result.confidence_pairs,8);assert.equal(result.breeder_animals,null);
  assert.match(result.warnings.join(' '),/not to the number of litters/);
  assert.match(result.assumptions.join(' '),/conditional/);assert.match(result.assumptions.join(' '),/same expected loss/);
});

test('breeding p=0, p=1, target=0, missing factors and search limits are unambiguous',()=>{
  const one={target:5,genotypeProbability:1,sexProbability:1,survivalProbability:1};
  assert.equal(planBreedingYield(one).confidence_offspring,5);
  assert.equal(planBreedingYield({...one,genotypeProbability:0}).status,'unattainable');
  assert.equal(planBreedingYield({...one,target:0,genotypeProbability:0}).confidence_offspring,0);
  assert.ok(planBreedingYield({target:5,genotypeProbability:.5}).errors.length);
  assert.equal(planBreedingYield({...one,maxOffspring:4}).status,'limit');
  assert.equal(planBreedingYield({...one,survivalProbability:.001,maxOffspring:100}).status,'limit');
  for(const changed of [{target:-1},{target:1.5},{confidence:1},{sexProbability:NaN},{litterSize:0},{littersPerPair:2}])assert.ok(planBreedingYield({...one,...changed}).errors.length);
});

test('reference list links primary guidelines and statistical implementations',()=>{
  assert.ok(IACUC_PLANNING_REFERENCES.some(r=>r.url.includes('nc3rs.org.uk')));
  assert.ok(IACUC_PLANNING_REFERENCES.some(r=>r.url.includes('arriveguidelines.org')));
  assert.ok(IACUC_PLANNING_REFERENCES.some(r=>r.id==='r-power'));
  assert.ok(IACUC_PLANNING_REFERENCES.every(r=>new URL(r.url).protocol==='https:'));
});
