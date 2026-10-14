import test from 'node:test';
import assert from 'node:assert/strict';
import {validateScenario,predictCross,rankPairs} from '../web/genetics.js';

const locus=(id='gene',extra={})=>({id,name:id,kind:'other',chromosome:'unknown',alleles:['+','fl'],...extra});
const call=(a,b,evidence='confirmed')=>({alleles:[a,b],evidence});
function scenario(overrides={}) {
  return {loci:[locus()],sire:{id:'S1',sex:'Male',calls:{gene:call('+','fl')}},dam:{id:'D1',sex:'Female',calls:{gene:call('+','fl')}},targets:{gene:{mode:'exact',alleles:['fl','fl']}},sex:'Any',independentAssortment:false,desiredCount:1,confidence:0.95,litterSize:6,...overrides};
}
const near=(actual,expected,tolerance=1e-12)=>assert(Math.abs(actual-expected)<tolerance,`${actual} should be near ${expected}`);
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;};
function referenceTail(n,k,p) {
  if(n<k)return 0;if(p===1)return 1;
  let term=(1-p)**n,lower=term;
  for(let i=1;i<k;i++){term*=((n-i+1)/i)*(p/(1-p));lower+=term;}
  return 1-lower;
}

test('heterozygote cross combines unordered calls into 1:2:1 and predicts a one-quarter homozygote target',()=>{
  const s=scenario(),p=predictCross(s);
  assert.deepEqual(p.errors,[]);assert.equal(p.targetProbability,0.25);assert.equal(p.outcomeCount,3);
  assert.deepEqual(p.outcomes.map(o=>[o.calls.gene,o.probability,o.meetsTarget]),[[['+','+'],0.25,false],[['+','fl'],0.5,false],[['fl','fl'],0.25,true]]);
  assert.equal(p.expectedPups,4);assert.equal(p.confidencePups,11);near(p.expectedLitters,2/3);assert.equal(p.confidenceLitters,2);
  assert.equal(p.outcomes.reduce((sum,o)=>sum+o.probability,0),1);
});

test('three independent loci produce the requested one-eighth genotype without inferred expression',()=>{
  const loci=[locus('cre',{kind:'cre',chromosome:'1',alleles:['+','Cre']}),locus('flox',{kind:'flox',chromosome:'2'}),locus('reporter',{kind:'reporter',chromosome:'6',alleles:['+','LSL-tdTomato']})];
  const sire={sex:'Male',calls:{cre:call('+','Cre'),flox:call('+','fl'),reporter:call('+','LSL-tdTomato')}},dam={sex:'Female',calls:{cre:call('+','+'),flox:call('+','+'),reporter:call('+','+')}};
  const targets={cre:{mode:'carrier',allele:'Cre'},flox:{mode:'carrier',allele:'fl'},reporter:{mode:'carrier',allele:'LSL-tdTomato'}};
  const p=predictCross(scenario({loci,sire,dam,targets,independentAssortment:true}));
  assert.deepEqual(p.errors,[]);assert.equal(p.targetProbability,0.125);assert.equal(p.outcomeCount,8);assert.equal(p.expectedPups,8);
  assert.equal(p.outcomes.filter(o=>o.meetsTarget).length,1);assert.match(p.assumptions.join(' '),/does not establish recombination/);
});

test('same-locus alternative reporter alleles are compound genotypes, not independent reporter loci',()=>{
  const loci=[locus('Rosa26',{name:'Rosa26 reporters',kind:'reporter',chromosome:'6',alleles:['+','LSL-tdTomato','LSL-eYFP']})];
  const s=scenario({loci,sire:{sex:'Male',calls:{Rosa26:call('+','LSL-tdTomato')}},dam:{sex:'Female',calls:{Rosa26:call('+','LSL-eYFP')}},targets:{Rosa26:{mode:'exact',alleles:['LSL-eYFP','LSL-tdTomato']}}});
  const p=predictCross(s);assert.deepEqual(p.errors,[]);assert.equal(p.targetProbability,0.25);assert.equal(p.outcomeCount,4);
  assert.deepEqual(p.outcomes.find(o=>o.meetsTarget).calls.Rosa26,['LSL-tdTomato','LSL-eYFP']);
  s.sire.calls.Rosa26=call('LSL-tdTomato','LSL-eYFP');s.dam.calls.Rosa26=call('LSL-eYFP','LSL-tdTomato');
  assert.equal(predictCross(s).targetProbability,0.5);
});

test('carrier includes either one or two copies, exact is unordered, and absent targets mean any',()=>{
  assert.equal(predictCross(scenario({targets:{gene:{mode:'carrier',allele:'fl'}}})).targetProbability,0.75);
  assert.equal(predictCross(scenario({targets:{gene:{mode:'exact',alleles:['fl','+']}}})).targetProbability,0.5);
  assert.equal(predictCross(scenario({targets:{gene:{mode:'any'}}})).targetProbability,1);
  assert.equal(predictCross(scenario({targets:{}})).targetProbability,1);
  const s=scenario();delete s.targets;assert.equal(predictCross(s).targetProbability,1);
});

test('sex selection halves the total probability while the genotype table stays normalized',()=>{
  for(const sex of ['Male','Female']){
    const p=predictCross(scenario({sex}));assert.equal(p.genotypeTargetProbability,0.25);assert.equal(p.sexProbability,0.5);assert.equal(p.targetProbability,0.125);
    assert.equal(p.outcomes.reduce((sum,o)=>sum+o.probability,0),1);assert.equal(p.outcomes.filter(o=>o.meetsTarget).reduce((sum,o)=>sum+o.probability,0),0.25);
  }
});

test('impossible target returns explicit zero and null count estimates without an infinity',()=>{
  const p=predictCross(scenario({sire:{sex:'Male',calls:{gene:call('+','+')}},dam:{sex:'Female',calls:{gene:call('+','+')}}}));
  assert.deepEqual(p.errors,[]);assert.equal(p.targetProbability,0);
  for(const field of ['expectedPups','confidencePups','expectedLitters','confidenceLitters'])assert.equal(p[field],null);
  assert.match(p.warnings.join(' '),/cannot be produced/);assert.equal(p.outcomeCount,1);
});

test('fixed homozygous parents make required count exact, with nominal fractional litter sizes supported',()=>{
  const p=predictCross(scenario({sire:{sex:'Male',calls:{gene:call('fl','fl')}},dam:{sex:'Female',calls:{gene:call('fl','fl')}},desiredCount:7,confidence:0.99,litterSize:3.5}));
  assert.equal(p.targetProbability,1);assert.equal(p.expectedPups,7);assert.equal(p.confidencePups,7);assert.equal(p.expectedLitters,2);assert.equal(p.confidenceLitters,2);
});

test('binomial confidence is the smallest integer meeting the requested tail probability',()=>{
  for(const desiredCount of [1,2,5,20,100])for(const confidence of [0.8,0.9,0.95,0.99])for(const mode of ['exact','carrier']){
    const p=predictCross(scenario({desiredCount,confidence,targets:{gene:mode==='exact'?{mode,alleles:['fl','fl']}:{mode,allele:'fl'}}}));
    assert(referenceTail(p.confidencePups,desiredCount,p.targetProbability)>=confidence-1e-12);
    assert(referenceTail(p.confidencePups-1,desiredCount,p.targetProbability)<confidence);
  }
  const p=predictCross(scenario({targets:{gene:{mode:'exact',alleles:['+','fl']}},desiredCount:2}));
  assert.equal(p.confidencePups,8);assert.equal(p.expectedPups,4);
});

test('six-locus rare targets enumerate at most 4096 genotypes and retain stable large count estimates',()=>{
  const loci=Array.from({length:6},(_,i)=>locus(`L${i}`,{chromosome:String(i+1),alleles:['a','b','c','d']}));
  const sire={sex:'Male',calls:Object.fromEntries(loci.map(l=>[l.id,call('a','b')]))},dam={sex:'Female',calls:Object.fromEntries(loci.map(l=>[l.id,call('c','d')]))};
  const targets=Object.fromEntries(loci.map(l=>[l.id,{mode:'exact',alleles:['a','c']}]));
  const p=predictCross(scenario({loci,sire,dam,targets,sex:'Female',independentAssortment:true,desiredCount:100,confidence:0.99}));
  assert.deepEqual(p.errors,[]);assert.equal(p.targetProbability,1/8192);assert.equal(p.outcomeCount,4096);assert.equal(p.outcomes.length,4096);assert.equal(p.expectedPups,819200);
  assert.equal(p.outcomes.reduce((sum,o)=>sum+o.probability,0),1);
  assert(referenceTail(p.confidencePups,100,p.targetProbability)>=0.99-1e-12);assert(referenceTail(p.confidencePups-1,100,p.targetProbability)<0.99);
});

test('unknown, missing and undeclared alleles refuse prediction instead of defaulting to wild type',()=>{
  for(const replacement of [undefined,null,call('+','fl','unknown'),call('?', 'fl'),call('+','absent'),{alleles:['fl'],evidence:'confirmed'},{alleles:['+','fl']}]){
    const s=scenario();s.sire.calls.gene=replacement;
    const p=predictCross(s);assert(p.errors.length);assert.equal(p.targetProbability,null);assert.deepEqual(p.outcomes,[]);
  }
  const s=scenario();delete s.sire.calls;assert.match(validateScenario(s).errors.join(' '),/calls are missing/);
  s.loci[0].alleles=['+','unknown'];assert.match(validateScenario(s).errors.join(' '),/unknown states are not alleles/);
});

test('inferred parents calculate only conditionally and report which call is unconfirmed',()=>{
  const s=scenario();s.sire.calls.gene.evidence='inferred';
  const p=predictCross(s);assert.deepEqual(p.errors,[]);assert.equal(p.targetProbability,0.25);assert.match(p.warnings.join(' '),/Sire, gene.*inferred/);
});

test('duplicate loci, same known chromosome, sex chromosomes and missing independence are rejected',()=>{
  for(const chromosome of ['X','Y','MT',0,1,'20','']){
    const s=scenario();s.loci[0].chromosome=chromosome;assert.match(validateScenario(s).errors.join(' '),/only autosomes/);
  }
  const s=scenario({independentAssortment:true});s.loci=[locus('gene',{chromosome:'6'}),locus('reporter',{chromosome:'6'})];
  assert.match(validateScenario(s).errors.join(' '),/Linkage is unsupported/);
  s.loci[1].id='gene';assert.match(validateScenario(s).errors.join(' '),/duplicated/);
  s.loci[1]=locus('second');s.independentAssortment=false;assert.match(validateScenario(s).errors.join(' '),/Explicitly confirm independent/);
  s.independentAssortment=true;assert.match(validateScenario(s).warnings.join(' '),/unknown.*planning assumption/);
});

test('invalid ranges, target definitions, parent sexes and self-pairs are rejected without throwing',()=>{
  for(const patch of [{loci:[]},{loci:Array.from({length:7},(_,i)=>locus(String(i)))},{desiredCount:0},{desiredCount:1.5},{desiredCount:101},{confidence:0.5},{litterSize:0},{litterSize:21},{litterSize:NaN},{litterSize:'6'},{sex:'Unknown'},{targets:[]},{targets:{other:{mode:'any'}}},{targets:{gene:{mode:'carrier',allele:'missing'}}},{targets:{gene:{mode:'exact',alleles:['fl']}}},{targets:{gene:{mode:'invalid'}}}])assert(predictCross(scenario(patch)).errors.length);
  const s=scenario();s.sire.sex='Female';s.dam.id='S1';assert.match(validateScenario(s).errors.join(' '),/Sire sex must be Male/);assert.match(validateScenario(s).errors.join(' '),/same animal ID/);
  for(const bad of [null,[],{},'invalid',{loci:[null]}])assert.doesNotThrow(()=>assert(predictCross(bad).errors.length));
  for(const field of ['id','name','chromosome','kind','alleles'])for(const malformed of [null,42,[],{toString:null},'']){
    const invalid=scenario();invalid.loci[0][field]=malformed;
    assert.doesNotThrow(()=>assert(predictCross(invalid).errors.length),`${field}: ${JSON.stringify(malformed)}`);
  }
});

test('arbitrary declared alleles stay literal while reserved IDs and overlong labels are rejected',()=>{
  const id='Rosa26',loci=[locus(id,{alleles:['+','LSL-tdTomato','CreERT2','flox exon 2','Δ','-']})];
  const s=scenario({loci,sire:{sex:'Male',calls:Object.fromEntries([[id,call('LSL-tdTomato','Δ')]])},dam:{sex:'Female',calls:Object.fromEntries([[id,call('+','-')]])},targets:Object.fromEntries([[id,{mode:'carrier',allele:'Δ'}]])});
  const p=predictCross(s);assert.deepEqual(p.errors,[]);assert.equal(p.targetProbability,0.5);assert(Object.hasOwn(p.outcomes[0].calls,id));assert.equal(Object.getPrototypeOf(p.outcomes[0].calls),Object.prototype);
  s.loci[0].alleles.push('seventh');assert.match(validateScenario(s).errors.join(' '),/1–6 distinct/);
  for(const id of ['__proto__','constructor','prototype']){const invalid=scenario();invalid.loci[0].id=id;assert.match(validateScenario(invalid).errors.join(' '),/reserved object names/);}
  for(const field of ['id','name','alleles']){const invalid=scenario();invalid.loci[0][field]=field==='alleles'?['+','x'.repeat(161)]:'x'.repeat(161);assert.match(validateScenario(invalid).errors.join(' '),/160 characters/);}
});

test('candidate ranking uses confirmed evidence, returns deterministic compact summaries and explains exclusions',()=>{
  const s=scenario(),candidates=[
    {id:'S-het',sex:'Male',calls:{gene:call('+','fl')}},{id:'S-wt',sex:'Male',calls:{gene:call('+','+')}},{id:'S-fixed',sex:'Male',calls:{gene:call('fl','fl')}},
    {id:'D-fixed',sex:'Female',calls:{gene:call('fl','fl')}},{id:'D-fixed2',sex:'Female',calls:{gene:call('fl','fl')}},
    {id:'inferred',sex:'Male',calls:{gene:call('fl','fl','inferred')}},{id:'unknown',sex:'Male',calls:{gene:call('fl','fl','unknown')}},
    {id:'missing',sex:'Female',calls:{}},{id:'sex',sex:'Unknown',calls:{gene:call('fl','fl')}},
    {id:'archived',sex:'Male',calls:{gene:call('fl','fl')},record:{app_archived_at:'2026-10-14'}},{id:'ended',sex:'Female',calls:{gene:call('fl','fl')},record:{state:'Ended'}}
  ];
  const r=rankPairs(s,candidates);assert.deepEqual(r.errors,[]);assert.equal(r.pairs.length,6);assert.equal(r.excluded.length,6);
  assert.deepEqual(r.pairs.map(p=>[p.sireId,p.damId,p.targetProbability]),[['S-fixed','D-fixed',1],['S-fixed','D-fixed2',1],['S-het','D-fixed',0.5],['S-het','D-fixed2',0.5],['S-wt','D-fixed',0],['S-wt','D-fixed2',0]]);
  assert.equal(r.pairs[0].outcomes,undefined);assert.equal(r.pairs[0].confidencePups,1);
  assert.match(r.excluded.find(r=>r.id==='inferred').reason,/confirmed evidence is required/);assert.match(r.excluded.find(r=>r.id==='missing').reason,/missing/);
  assert.match(r.assumptions.join(' '),/only the supplied eligible candidates/);
});

test('pair ranking limits evaluation to 2500 without returning a misleading partial ranking',()=>{
  const make=(n,sex)=>Array.from({length:n},(_,i)=>({id:`${sex}-${i}`,sex,calls:{gene:call('+','fl')}}));
  const accepted=rankPairs(scenario(),[...make(50,'Male'),...make(50,'Female')]);assert.deepEqual(accepted.errors,[]);assert.equal(accepted.pairs.length,2500);
  const rejected=rankPairs(scenario(),[...make(51,'Male'),...make(50,'Female')]);assert.match(rejected.errors.join(' '),/2550.*2500-pair limit/);assert.deepEqual(rejected.pairs,[]);
});

test('duplicate or ineligible candidates never create an ambiguous or invented pair',()=>{
  const s=scenario(),same=[{id:'same',sex:'Male',calls:s.sire.calls},{id:'same',sex:'Female',calls:s.dam.calls}];
  assert.match(rankPairs(s,same).errors.join(' '),/duplicated/);assert.deepEqual(rankPairs(s,same).pairs,[]);
  assert.match(rankPairs(s,[]).warnings.join(' '),/No eligible/);assert(rankPairs(s,null).errors.length);
  const r=rankPairs(s,[null,{id:'unknown',sex:'Unknown',calls:{}}]);assert.equal(r.excluded.length,2);assert.deepEqual(r.pairs,[]);
});

test('prediction and ranking do not mutate scenarios, target allele order, candidate profiles or source records',()=>{
  const s=freeze(scenario({targets:{gene:{mode:'exact',alleles:['fl','+']}}})),before=JSON.stringify(s);
  const candidates=freeze([{...s.sire,record:{source_record_id:'source:1'}},{...s.dam,record:{source_record_id:'source:2'}}]);
  assert.doesNotThrow(()=>predictCross(s));assert.doesNotThrow(()=>rankPairs(s,candidates));assert.equal(JSON.stringify(s),before);
});
