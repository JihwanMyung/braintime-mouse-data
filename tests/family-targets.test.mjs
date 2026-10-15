import test from 'node:test';
import assert from 'node:assert/strict';
import { familyTargetDraft, familyTargetOptions, createFamilyTargetResolver, validateFamilyTargetDraft } from '../web/family-targets.js';

const dataset=(loci=[],calls={})=>({tables:{mice:loci.length?[{mouse_sid:'TEST',genetic_profile:{schema_version:1,loci,calls}}]:[],mouse_genes:[]}});
const locus=(extras={})=>({id:'per2-luc',name:'PER2::LUC',kind:'reporter',chromosome:'unknown',alleles:['+','PER2::LUC'],...extras});
const choice=(code,mode='carrier',extras={})=>({code,mode,...extras});

test('registry defaults preserve requested dosage, leave unselected strains unconstrained and create no parental calls',()=>{
  const source=dataset(),before=structuredClone(source),draft=familyTargetDraft([choice('P'),choice('B','homozygous'),choice('V','absent'),choice('F','any')],source);
  assert.deepEqual(draft.errors,[]);assert.equal(draft.loci.length,3);
  assert.deepEqual(draft.targets['per2-luc'],{mode:'carrier',allele:'PER2::LUC'});
  assert.deepEqual(draft.targets.bmal1,{mode:'exact',alleles:['fl','fl']});
  assert.deepEqual(draft.targets['vip-cre'],{mode:'exact',alleles:['+','+']});
  assert.equal(draft.sire,undefined);assert.equal(draft.dam,undefined);assert.deepEqual(source,before);
  assert(draft.loci.every(row=>row.chromosome==='unknown'));
});

test('all configured shorthand codes resolve or explicitly require a single AD insertion definition',()=>{
  for(const code of ['P','E','B','F','V','A','32','Vg','Gt','96']){
    const draft=familyTargetDraft([choice(code)],dataset());assert.deepEqual(draft.errors,[],code);assert.equal(draft.loci.length,1,code);
  }
  const ad=familyTargetDraft([choice('AD')],dataset());assert.match(ad.errors.join(' '),/explicit inherited insertion locus/);assert.equal(ad.loci.length,0);
});

test('biallelic heterozygous and negative targets remain exact, not generic carriers',()=>{
  const draft=familyTargetDraft([choice('P','heterozygous'),choice('E','absent')],dataset());assert.deepEqual(draft.errors,[]);
  assert.deepEqual(draft.targets['per2-luc'],{mode:'exact',alleles:['+','PER2::LUC']});
  assert.deepEqual(draft.targets['bmal1-eluc'],{mode:'exact',alleles:['+','+']});
});

test('Rosa26 target requests combine on one locus, including deliberately requested compound heterozygosity',()=>{
  for(const mode of ['carrier','heterozygous']){
    const draft=familyTargetDraft([choice('32',mode),choice('96',mode)],dataset());assert.deepEqual(draft.errors,[]);assert.equal(draft.loci.length,1);
    assert.deepEqual(draft.targets.rosa26,{mode:'exact',alleles:['Ai32','Ai96']});
  }
  const negative=familyTargetDraft([choice('32','absent'),choice('96','absent')],dataset());assert.deepEqual(negative.errors,[]);assert.deepEqual(negative.targets.rosa26,{mode:'exact',alleles:['+','+']});
});

test('Rosa26 cannot exceed two copies and partial multiallelic constraints are never silently relaxed',()=>{
  for(const selections of [[choice('32','homozygous'),choice('96')],[choice('32'),choice('32','absent')]])assert.match(familyTargetDraft(selections,dataset()).errors.join(' '),/two-copy locus/);
  for(const mode of ['heterozygous','absent'])assert.match(familyTargetDraft([choice('32',mode)],dataset()).errors.join(' '),/exact pair/);
  const exact=familyTargetDraft([choice('32','exact',{pair:['+','Ai32']})],dataset());assert.deepEqual(exact.errors,[]);assert.deepEqual(exact.targets.rosa26,{mode:'exact',alleles:['+','Ai32']});
});

test('saved locus IDs, names, alleles and chromosomes are retained exactly for reviewed-parent reuse',()=>{
  const saved=locus({id:'lab-per2',name:'PER2::LUC',chromosome:'1',alleles:['WT','P']});
  const source=dataset([saved],{'lab-per2':{alleles:['P','WT'],evidence:'confirmed'}});
  const draft=familyTargetDraft([choice('P','heterozygous')],source);assert.deepEqual(draft.errors,[]);assert.deepEqual(draft.loci,[saved]);
  assert.deepEqual(draft.targets['lab-per2'],{mode:'exact',alleles:['WT','P']});
  draft.loci[0].alleles.push('changed');assert.deepEqual(source.tables.mice[0].genetic_profile.loci,[saved]);
});

test('distinct confirmed definitions require an explicit selection, while unconfirmed alternatives do not replace a confirmed definition',()=>{
  const a=locus(),b=locus({id:'other-per2'});
  const source=dataset([a,b],{[a.id]:{alleles:['+','PER2::LUC'],evidence:'confirmed'},[b.id]:{alleles:['+','PER2::LUC'],evidence:'confirmed'}});
  assert.match(familyTargetDraft([choice('P')],source).errors.join(' '),/definitions disagree/);
  const chosen=familyTargetDraft([choice('P','carrier',{locus:b})],source);assert.deepEqual(chosen.errors,[]);assert.deepEqual(chosen.loci,[b]);
  source.tables.mice[0].genetic_profile.calls[b.id].evidence='inferred';
  const preferred=familyTargetDraft([choice('P')],source);assert.deepEqual(preferred.errors,[]);assert.equal(preferred.loci[0].id,a.id);assert.match(preferred.notice,/incompatible profiles need review/);
});

test('existing explicit APP/PS1 insertion model is usable without inferring it from source text',()=>{
  const ad={id:'ad-insertion',name:'APP/PS1',kind:'other',chromosome:'9',alleles:['WT','APP/PS1']};
  const source=dataset([ad],{[ad.id]:{alleles:['WT','APP/PS1'],evidence:'confirmed'}});
  const draft=familyTargetDraft([choice('AD')],source);assert.deepEqual(draft.errors,[]);assert.deepEqual(draft.loci,[ad]);assert.deepEqual(draft.targets[ad.id],{mode:'carrier',allele:'APP/PS1'});
  assert.match(familyTargetDraft([choice('AD')],{tables:{mice:[{genotype:'APP/PS1(+/-)'}]}}).errors.join(' '),/explicit inherited insertion/);
});

test('custom loci require exact allele choice when several variants are declared',()=>{
  const custom={id:'custom',name:'Custom assay',kind:'other',chromosome:'unknown',alleles:['WT','variant-a','variant-b']};
  const source=dataset([custom],{custom:{alleles:['WT','variant-a'],evidence:'confirmed'}});
  assert.match(familyTargetDraft([choice('locus:custom')],source).errors.join(' '),/exact target allele/);
  const draft=familyTargetDraft([choice('locus:custom','carrier',{allele:'variant-b'})],source);assert.deepEqual(draft.errors,[]);assert.deepEqual(draft.targets.custom,{mode:'carrier',allele:'variant-b'});
  const exact=familyTargetDraft([choice('locus:custom','exact',{locus:custom,pair:['variant-a','variant-b']})],source);assert.deepEqual(exact.errors,[]);assert.deepEqual(exact.targets.custom,{mode:'exact',alleles:['variant-a','variant-b']});
});

test('source-discovered allele definitions match the existing catalogue instead of inventing parallel IDs',()=>{
  const source={tables:{mice:[{mouse_sid:'1',genotype:'Bmal1(fl/+); PER2::LUC(+/-)'}]}};
  const draft=familyTargetDraft([choice('B'),choice('P')],source);assert.deepEqual(draft.errors,[]);
  assert.deepEqual(draft.loci.map(row=>row.id),['bmal1','per2-luc']);assert.deepEqual(draft.loci[0].alleles,['+','fl']);
});

test('incompatible metadata, duplicate Rosa26 loci and unsupported inheritance are rejected',()=>{
  const rosa32={id:'ai32',name:'Ai32',kind:'reporter',chromosome:'unknown',alleles:['+','Ai32']};
  const rosa96={id:'ai96',name:'Ai96',kind:'reporter',chromosome:'unknown',alleles:['+','Ai96']};
  const source=dataset([rosa32,rosa96],{});
  assert.match(familyTargetDraft([choice('32'),choice('96')],source).errors.join(' '),/one Rosa26 locus/);
  const conflict=familyTargetDraft([choice('P','carrier',{locus:locus()}),choice('P','homozygous',{locus:locus({chromosome:'1'})})],dataset());assert.match(conflict.errors.join(' '),/incompatible definitions/);
  assert.match(familyTargetDraft([choice('P','carrier',{locus:locus({chromosome:'X'})})],dataset()).errors.join(' '),/only autosomes/);
});

test('targets cannot silently ignore linked loci, excessive locus counts, invalid labels or prototype keys',()=>{
  const selections=Array.from({length:7},(_,i)=>choice('locus:c'+i,'carrier',{locus:locus({id:'c'+i,name:'Custom '+i}),allele:'PER2::LUC'}));
  assert.match(familyTargetDraft(selections,dataset()).errors.join(' '),/at most six loci/);
  const linked=selections.slice(0,2).map(row=>({...row,locus:{...row.locus,chromosome:'1'}}));assert.match(familyTargetDraft(linked,dataset()).errors.join(' '),/Linkage is unsupported/);
  for(const code of ['__proto__','constructor','missing'])assert(familyTargetDraft([choice(code)],dataset()).errors.length);
  assert(familyTargetDraft([choice('P','carrier',{allele:'not declared'})],dataset()).errors.length);
  assert(familyTargetDraft([choice('P','exact',{pair:['+']})],dataset()).errors.length);
  assert(familyTargetDraft([choice('P','invalid')],dataset()).errors.length);
});

test('target hook validation rejects malformed and error-bearing drafts before any planner state change',()=>{
  for(const draft of [null,{}, {loci:[],targets:{}}, {loci:[locus()],targets:{}}, {loci:[locus()],targets:{'per2-luc':{mode:'exact',alleles:['bad','bad']}}}])assert(validateFamilyTargetDraft(draft).length);
  const draft=familyTargetDraft([choice('P')],dataset());assert.deepEqual(validateFamilyTargetDraft(draft),[]);
  assert.deepEqual(validateFamilyTargetDraft({...draft,errors:['Review first.']}),['Review first.']);
  assert(familyTargetDraft([],dataset()).errors.length);assert(familyTargetDraft([choice('P','any')],dataset()).errors.length);
});

test('target options expose exact shared-locus pairs and the same saved definition used by drafting',()=>{
  const options=familyTargetOptions('32',dataset());assert.deepEqual(options.alleles,['+','Ai32','Ai96']);assert.equal(options.allele,'Ai32');assert.equal(options.locus.id,'rosa26');
  const saved=locus({id:'saved',alleles:['WT','PER2::LUC']});const source=dataset([saved],{saved:{alleles:['WT','PER2::LUC'],evidence:'confirmed'}});
  const target=familyTargetOptions('P',source);assert.deepEqual(target.locus,saved);assert.deepEqual(familyTargetDraft([choice('P')],source).loci,[target.locus]);
  assert.match(familyTargetOptions('AD',dataset()).error,/explicit inherited insertion/);assert.equal(familyTargetOptions('',dataset()).locus,null);
});

test('custom same-ID definitions cannot silently select a preferred profile',()=>{
  const a=locus({id:'custom',name:'Custom'}),b={...a,alleles:['+','variant']};
  const source={tables:{mice:[...dataset([a],{custom:{alleles:['+','PER2::LUC'],evidence:'confirmed'}}).tables.mice,...dataset([b],{custom:{alleles:['+','variant'],evidence:'inferred'}}).tables.mice]}};
  assert.match(familyTargetOptions('locus:custom',source).error,/definitions disagree/);
  assert.match(familyTargetDraft([choice('locus:custom')],source).errors.join(' '),/definitions disagree/);
});

test('named short-code profiles match exactly but generic positive/negative allele names need explicit review',()=>{
  const saved=locus({id:'short',name:'P',alleles:['WT','P']});
  const draft=familyTargetDraft([choice('P')],dataset([saved],{short:{alleles:['WT','P'],evidence:'confirmed'}}));assert.deepEqual(draft.errors,[]);assert.equal(draft.loci[0].id,'short');
  const ambiguous=locus({alleles:['+','-']});assert.match(familyTargetDraft([choice('P')],dataset([ambiguous],{})).errors.join(' '),/exact target allele/);
});

test('one target resolver snapshots discovery and returns independently editable options',()=>{
  const source=dataset([locus()],{'per2-luc':{alleles:['+','PER2::LUC'],evidence:'confirmed'}}),resolve=createFamilyTargetResolver(source);
  source.tables.mice[0].genetic_profile.loci[0].chromosome='2';
  const first=resolve('P');first.locus.name='Changed';first.alleles.push('Changed');
  assert.equal(resolve('P').locus.name,'PER2::LUC');assert.equal(resolve('P').locus.chromosome,'unknown');assert.deepEqual(resolve('P').alleles,['+','PER2::LUC']);
  source.tables.mice[0].genetic_profile.loci[0].chromosome='unknown';
  assert.deepEqual(resolve('P'),familyTargetOptions('P',source));assert.deepEqual(resolve('32').alleles,['+','Ai32','Ai96']);
});

test('malformed selection and non-record source containers return review errors without crashing',()=>{
  const bad={tables:{mice:{},mouse_genes:[null,42],locations:'invalid'},sources:{}};
  for(const selected of [null,{},[null],['P'],[{code:{}}],[choice('P','exact',{pair:{}})]])assert(familyTargetDraft(selected,bad).errors.length);
  for(const code of [null,{},'',42])assert(familyTargetOptions(code,bad).error);
  assert.deepEqual(familyTargetDraft([choice('P')],bad).errors,[]);
  assert.deepEqual(familyTargetDraft([choice('P')],null).errors,[]);
});


test('family targets canonicalize names without replacing saved flox IDs or adopting Cre model aliases',()=>{
  const source=dataset([{id:'bmal1',name:'Bmal1',kind:'flox',chromosome:'unknown',alleles:['+','fl']}],{bmal1:{alleles:['fl','+'],evidence:'confirmed'}}),before=structuredClone(source);
  const draft=familyTargetDraft([choice('B')],source);assert.deepEqual(draft.errors,[]);assert.equal(draft.loci[0].id,'bmal1');assert.equal(draft.loci[0].name,'Bmal1-flox');assert.deepEqual(source,before);
  const conflicting=dataset([{id:'vgat',name:'Vgat-CRE',kind:'cre',chromosome:'unknown',alleles:['+','Vgat-CRE']}],{vgat:{alleles:['Vgat-CRE','+'],evidence:'confirmed'}});
  const vgat=familyTargetDraft([choice('Vg')],conflicting);assert(vgat.loci.every(row=>row.kind==='flox'));assert(vgat.loci.every(row=>!row.alleles.includes('Vgat-CRE')));
  const fox=familyTargetDraft([choice('F')],{tables:{mice:[{mouse_sid:'SYN',genotype:'FoxJ-Cre(+/-); FoxJ1-Cre(+/-)'}]}});assert.deepEqual(fox.errors,[]);assert.equal(fox.loci.length,1);assert.equal(fox.loci[0].id,'foxj1-cre');assert.equal(fox.loci[0].name,'FoxJ1-Cre');
});
