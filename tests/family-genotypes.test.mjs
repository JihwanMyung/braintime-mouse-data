import test from 'node:test';

test('canonical flox names and exact FoxJ alias retain separate custom Cre evidence',()=>{
  const meis=animal({genotype:'Meis1(fl/+)'});assert.equal(meis.traits[0].name,'Meis1-flox');assert.equal(meis.traits[0].code,'locus:meis1');assert.equal(meis.traits[0].presence,'present');
  assert.equal(trait({genotype:'FoxJ-Cre(+/-)'},'F').presence,'present');
  const weird=animal({genetic_profile:{schema_version:1,loci:[{id:'vgat',name:'Vgat-Cre',kind:'cre',chromosome:'unknown',alleles:['+','Vgat-Cre']}],calls:{vgat:{alleles:['fl','+'],evidence:'confirmed'}}}});
  assert.equal(weird.traits.some(row=>row.code==='Vg'),false);assert.equal(weird.traits[0].name,'Vgat-Cre');assert.match(weird.warnings.join(' '),/Saved Vgat Cre model needs review/);
});
import assert from 'node:assert/strict';
import {buildFamilyGenotypes,filterFamilyAnimals} from '../web/family-genotypes.js';
const dataset=(mice,genes=[],extra={})=>({tables:{mice:mice.map((mouse,index)=>({mouse_sid:`SYN-${index}`,state:'Stock',...mouse})),mouse_genes:genes,...extra}});
const animal=(mouse,genes=[])=>buildFamilyGenotypes(dataset([mouse],genes)).animals[0];
const trait=(mouse,code)=>animal(mouse).traits.find(item=>item.code===code);
const locus=(id,name,alleles=['+',name])=>({id,name,kind:'other',chromosome:'unknown',alleles});
const profile=(loci,calls)=>({schema_version:1,loci,calls});
const call=(alleles,evidence='confirmed')=>({alleles,evidence});
const pProfile=(pair,evidence='confirmed',id='per2')=>profile([locus(id,'PER2::LUC')],{[id]:call(pair,evidence)});

test('current population deduplicates IDs and excludes ended, archive and missing-ID rows',()=>{
  const data=dataset([{sex:'Male'},{sex:'Female'},{state:'Ended'},{state:'Unknown'},{archived:true},{app_archived_at:'2026-01-01'}]);
  data.tables.mice.push({...data.tables.mice[0]}, {state:'Stock'});
  assert.equal(buildFamilyGenotypes(data).total,2);
  assert.equal(buildFamilyGenotypes(data,{scope:'all'}).total,4);
  assert.equal(buildFamilyGenotypes(data,{scope:'all',includeArchived:true}).total,6);
  assert.throws(()=>buildFamilyGenotypes(data,{scope:'past'}),/current or all/);
  assert.equal(buildFamilyGenotypes(null).total,0);
});

test('all registry shorthand codes are returned even with zero animals',()=>{
  assert.deepEqual(buildFamilyGenotypes(null).traits.map(row=>row.code),['P','E','B','F','V','AD','A','32','Vg','Gt','96']);
});

test('prime dosage and parenthesis uncertainty stay distinct from confirmed assays',()=>{
  assert.equal(trait({genotype:'P'},'P').dosage,'unknown');
  assert.equal(trait({genotype:"P'"},'P').dosage,'homozygous');
  assert.equal(trait({genotype:"P'"},'P').evidence,'recorded');
  assert.equal(animal({genotype:"P'"}).confirmed,false);
  assert.equal(trait({genotype:'(P)'},'P').presence,'uncertain');
  assert.equal(animal({genotype:"(P')"}).shorthand,'(P′)');
  const pending=trait({genotype:"P(')"},'P');assert.equal(pending.presence,'present');assert.equal(pending.dosage,'unknown');assert.equal(pending.shorthand,'P(′)');
  assert.equal(trait({physical_tag:'P-F12'},'F'),undefined);
  assert.equal(animal({physical_tag:'32'}).unclassified,true);
});

test('combined groups are order independent and retain absent versus omitted loci',()=>{
  const data=buildFamilyGenotypes(dataset([{physical_tag:"VB'P-M12"},{physical_tag:"PB'V-F13"},{genotype:'PER2::LUC(+/-)'},{genotype:'PER2::LUC(+/-); Bmal1(+/+)'}]));
  assert.equal(data.animals[0].combinationKey,data.animals[1].combinationKey);
  assert.notEqual(data.animals[2].combinationKey,data.animals[3].combinationKey);
  assert.equal(data.combinations.find(row=>row.count===2).male,0); // No sex is inferred from a tag.
  assert.equal(data.animals[3].traits.find(row=>row.code==='B').presence,'absent');
});

test('AD combinations partition living mice once and retain prime and parenthesis distinctions',()=>{
 const source=dataset([
  {physical_tag:"ADB′",sex:'Male'},
  {physical_tag:"B'AD-F001",sex:'Female'},
  {physical_tag:"ADFB'-M002",sex:'Male'},
  {physical_tag:"(AD)FB'-F003",sex:'Female'},
  {physical_tag:"AD(F)B'-M004",sex:'Male'},
  {physical_tag:"AD(')FB'-F005",sex:'Female'},
  {physical_tag:'unclassified identifier'},
  {physical_tag:"ADFB'",state:'Ended'},
  {physical_tag:"ADFB'",archived:true}
 ]);
 source.tables.mice.push({...source.tables.mice[0]});
 source.tables.locations=[{source_current:true,source_observed_tags:["ADFB'-M9999"]}];
 const before=structuredClone(source),result=buildFamilyGenotypes(source,{scope:'current'});
 assert.equal(result.total,7);assert.equal(result.combinations.reduce((sum,row)=>sum+row.count,0),7);
 assert.equal(new Set(result.combinations.flatMap(row=>row.animalIds)).size,7);
 assert.equal(result.combinations.length,6);assert.equal(result.unclassified,1);
 const pair=result.combinations.find(row=>row.count===2);assert.equal(pair.label,'B′ · AD');assert.equal(pair.male,1);assert.equal(pair.female,1);
 assert.equal(result.animals[2].traits.find(row=>row.code==='B').dosage,'homozygous');
 assert.equal(result.animals[3].traits.find(row=>row.code==='AD').presence,'uncertain');
 assert.equal(result.animals[4].traits.find(row=>row.code==='F').presence,'uncertain');
 assert.equal(result.animals[5].traits.find(row=>row.code==='AD').dosageUncertain,true);
 assert.equal(result.animals.some(row=>row.traits.some(trait=>trait.code==='A')),false);
 assert.deepEqual(source,before);
});

test('Family and Mice use identical compound parsing for identifier wrappers and sex suffixes',()=>{
 for(const physical_tag of ["(M005) ADFB'-M001","ADFB'-F-002"]){
  const result=animal({physical_tag});assert.equal(result.shorthand,'B′ · F · AD');assert.equal(result.traits.find(row=>row.code==='B').dosage,'homozygous');
 }
 for(const genotype of ['AD x B','AD × B'])assert.equal(animal({genotype}).unclassified,true,'parent crosses are not an animal genotype');
});

test('source pairs are inferred and raw shorthand calls use the same semantics',()=>{
  const a=animal({genotype:'PER2::LUC(+/-); Bmal1(fl/fl)'}),b=animal({genotype:'P(+/-)+B(fl/fl)'});
  assert.equal(a.shorthand,'P/+ · B′');assert.equal(a.combinationKey,b.combinationKey);
  assert.equal(a.traits.every(row=>row.evidence==='inferred'),true);assert.equal(a.confirmed,false);
  assert.equal(trait({genotype:'Bmal1(+/+) '},'B').presence,'absent');
  assert.equal(trait({genotype:'Vip-Cre(negative)'},'V').presence,'absent');
});

test('unknown raw and incompatible source notation remain unresolved',()=>{
  for(const genotype of ['PER2::LUC(?)','Bmal1(+/-)','Bmal1-ELuc(fl/fl)','Avp-Cre(fl/fl)','Meis1(+/-)'])assert.equal(animal({genotype}).unresolved,true,genotype);
  assert.equal(trait({physical_tag:'P-M12',genotype:'PER2::LUC(-/-)'},'P').presence,'absent');
  assert.equal(trait({genotype:'PER2::LUC(+/-); PER2::LUC(-/-)'},'P').presence,'uncertain');
  assert.equal(trait({physical_tag:'(P)-M12',genotype:'PER2::LUC'},'P').presence,'uncertain');
});

test('reviewed confirmed calls override source disagreement but inferred calls cannot',()=>{
  const confirmed=animal({genotype:'PER2::LUC(-/-)',genetic_profile:pProfile(['PER2::LUC','+'])});
  assert.equal(confirmed.confirmed,true);assert.equal(confirmed.traits[0].presence,'present');
  const inferred=trait({genotype:'PER2::LUC(-/-)',genetic_profile:pProfile(['PER2::LUC','+'],'inferred')},'P');
  assert.equal(inferred.presence,'uncertain');assert.equal(inferred.evidence,'uncertain');
  assert.equal(trait({genotype:'PER2::LUC(+/-)',genetic_profile:pProfile([],'unknown')},'P').presence,'uncertain');
});

test('equivalent allele combinations aggregate evidence without losing confirmation counts',()=>{
  const data=buildFamilyGenotypes(dataset([{genotype:"P'"},{genotype:'PER2::LUC(+/+)'},{genetic_profile:pProfile(['PER2::LUC','PER2::LUC'])}]));
  assert.equal(new Set(data.animals.map(row=>row.shorthand)).size,1);
  assert.equal(data.combinations.length,1);assert.equal(data.combinations[0].confirmed,1);assert.equal(data.combinations[0].evidenceLabel,'Mixed evidence');assert.equal(data.confirmed,1);
});

test('current owned gene records count, foreign, archived and historical prose do not',()=>{
  const data=dataset([{mouse_sid:'SYN-A'}],[{mouse_sid:'SYN-A',gene_value:'PER2::LUC(+/-)'},{mouse_sid:'OTHER',gene_value:'Vip-Cre(+/+)'},{mouse_sid:'SYN-A',gene_value:'Bmal1(fl/fl)',archived:true}],{historical_observations:[{raw_text:'SYN-A Foxj1-Cre(+/+)'}],locations:[{source_block_text:'SYN-A Ai32(+/+)'}]});
  const a=buildFamilyGenotypes(data).animals[0];assert.deepEqual(a.traits.map(row=>row.code),['P']);assert.equal(a.shorthand,'P/+');
});

test('custom structured allele identities and named source ambiguity are retained',()=>{
  const custom=locus('custom-dose','My custom allele',['+','variant-A','variant-B']);
  const a=animal({genetic_profile:profile([custom],{'custom-dose':call(['variant-A','variant-B'])})});
  assert.equal(a.traits[0].code,'locus:custom-dose');assert.deepEqual(a.traits[0].locus,custom);assert.equal(a.shorthand,'My custom allele[variant-A/variant-B]');assert.equal(a.confirmed,true);
  const summary=buildFamilyGenotypes(dataset([a.mouse]));assert.deepEqual(summary.traits.find(row=>row.code==='locus:custom-dose').declaredAlleles,['+','variant-A','variant-B']);
  const ambiguous=animal({genotype:'Meis1(+/-)'});assert.equal(ambiguous.traits[0].name,'Meis1-flox');assert.equal(ambiguous.traits[0].presence,'uncertain');
});

test('Rosa26 pairs classify allele presence once without inventing independent reporter loci',()=>{
  const rosa=locus('rosa26','Gt(ROSA)26Sor',['+','Ai32','Ai96']);
  const a=animal({genetic_profile:profile([rosa],{rosa26:call(['Ai32','Ai96'])})});
  assert.equal(a.confirmed,true);assert.equal(a.shorthand,'32/96');
  assert.deepEqual(a.traits.map(row=>row.alleles),[['Ai32','Ai96'],['Ai32','Ai96']]);
  const b=animal({genetic_profile:profile([rosa],{rosa26:call(['Ai32','+'])})});
  assert.equal(b.traits.find(row=>row.code==='96').presence,'absent');
  const raw=animal({genotype:'Ai32(+/-); Ai96(+/-)'});assert.equal(raw.confirmed,false);assert.equal(raw.unresolved,true);assert.equal(raw.traits.every(row=>row.dosage==='unknown'),true);assert.ok(raw.warnings.some(text=>text.includes('Rosa26')));
});

test('separate positive reporter profiles cannot create a false compound genotype',()=>{
  const a=animal({genetic_profile:profile([locus('a32','Ai32'),locus('a96','Ai96')],{a32:call(['Ai32','+']),a96:call(['Ai96','+'])})});
  assert.equal(a.confirmed,false);assert.equal(a.traits.every(row=>row.presence==='uncertain'),true);assert.ok(a.warnings.length);
});

test('WT annotations remain recorded and never expand to all-locus negatives',()=>{
  for(const genotype of ['WT','WT(+/+)']){const a=animal({genotype});assert.equal(a.shorthand,'WT');assert.equal(a.traits.length,1);assert.equal(a.confirmed,false);}
  assert.equal(animal({genotype:''}).shorthand,'Unclassified');assert.equal(animal({genotype:'unrecognized notes'}).unclassified,true);
});

test('alternatives retain shared alleles but do not resolve alternative line identities',()=>{
  const a=animal({genotype:"PB' or EB'"});assert.equal(a.traits.find(row=>row.code==='B').dosage,'homozygous');assert.equal(a.traits.find(row=>row.code==='P').presence,'uncertain');assert.equal(a.traits.find(row=>row.code==='E').presence,'uncertain');
});

test('filters combine line intersection/union, uncertain opt-in, exact groups, sex and search',()=>{
  const result=buildFamilyGenotypes(dataset([{sex:'Male',genotype:"PB'"},{sex:'Female',genotype:'(P)'},{sex:'Female',genetic_profile:pProfile(['PER2::LUC','+'])},{genotype:'PER2::LUC(-/-)'}]));
  assert.equal(filterFamilyAnimals(result.animals,{codes:['P']}).length,3);
  assert.equal(filterFamilyAnimals(result.animals,{codes:['P'],includeUncertain:false}).length,2);
  assert.equal(filterFamilyAnimals(result.animals,{codes:['P','B']}).length,1);
  assert.equal(filterFamilyAnimals(result.animals,{codes:['P','B'],match:'any'}).length,3);
  assert.equal(filterFamilyAnimals(result.animals,{sex:'female',evidence:'confirmed'}).length,1);
  assert.equal(filterFamilyAnimals(result.animals,{evidence:'unresolved'}).length,2);
  assert.equal(filterFamilyAnimals(result.animals,{combinationKey:result.animals[0].combinationKey}).length,1);
  assert.equal(filterFamilyAnimals(result.animals,{search:'per2::luc'}).length,4);
});

test('summary numbers reconcile and classification never changes imported records',()=>{
  const data=dataset([{sex:'Male',genotype:'P'},{sex:'Female',genotype:'(P)'},{sex:'Female',genetic_profile:pProfile(['PER2::LUC','+'])},{genotype:'PER2::LUC(-/-)'}]);
  const before=structuredClone(data),result=buildFamilyGenotypes(data),p=result.traits.find(row=>row.code==='P');
  assert.deepEqual({present:p.present,absent:p.absent,uncertain:p.uncertain,male:p.male,female:p.female,confirmed:p.confirmed},{present:2,absent:1,uncertain:1,male:1,female:1,confirmed:1});
  assert.equal(result.combinations.reduce((n,row)=>n+row.count,0),result.total);assert.deepEqual(data,before);
});


test('malformed imported profile declarations cannot crash classification',()=>{
  const a=animal({genetic_profile:{schema_version:1,loci:[{id:'broken',name:'Bad locus',alleles:{bad:true}}],calls:{}}});
  assert.equal(a.confirmed,false);assert.equal(a.unresolved,true);assert.equal(a.traits[0].presence,'uncertain');
});

test('registered shorthand alleles match reviewed full-name loci and equivalent IDs aggregate',()=>{
  const data=buildFamilyGenotypes(dataset([
    {genetic_profile:profile([locus('lab-per2','PER2::LUC',['WT','P'])],{'lab-per2':call(['WT','P'])})},
    {genetic_profile:pProfile(['PER2::LUC','+'],'confirmed','alternate-per2-id')},
  ]));
  assert.equal(data.animals.every(a=>a.confirmed),true);assert.equal(data.combinations.length,1);assert.equal(data.combinations[0].confirmed,2);
});

test('a reviewed custom locus resolves its matching raw named source without duplication',()=>{
  const a=animal({genotype:'Meis1(+/-)',genetic_profile:profile([locus('lab-meis1','Meis1',['+','fl'])],{'lab-meis1':call(['fl','+'])})});
  assert.equal(a.confirmed,true);assert.equal(a.traits.length,1);assert.equal(a.traits[0].code,'locus:lab-meis1');
});

test('parenthesized WT stays uncertain and broad WT contradictions require review',()=>{
  assert.equal(animal({genotype:'(WT)'}).shorthand,'(WT)');
  const a=animal({physical_tag:'WT-M12',genotype:'PER2::LUC(+/-)'});assert.equal(a.unresolved,true);assert.equal(a.traits.find(row=>row.code==='WT').presence,'uncertain');assert.ok(a.warnings.length);
});

test('filters match unknown sex and cages without inferring sex from the physical tag',()=>{
  const result=buildFamilyGenotypes(dataset([{physical_tag:'P-M12',cage_sid:'TEST-CAGE',cage_tag:'Blue cage'},{sex:'Female',physical_tag:'P-F13'}]));
  assert.equal(filterFamilyAnimals(result.animals,{sex:'Unknown'}).length,1);assert.equal(filterFamilyAnimals(result.animals,{search:'blue cage'}).length,1);assert.equal(filterFamilyAnimals(result.animals,{search:'test-cage'}).length,1);
  assert.equal(animal({genotype:''}).unresolved,true);
});


test('invalid metadata and uncertainty placeholders cannot become confirmed genotypes',()=>{
  const bad={...locus('p','PER2::LUC'),kind:'invalid',chromosome:{bad:true}};
  const invalid=animal({genetic_profile:profile([bad],{p:call(['PER2::LUC','+'])})});
  assert.equal(invalid.confirmed,false);assert.equal(invalid.unresolved,true);
  for(const unknown of ['?','unknown','undetermined','not tested','untested']) {
    const a=animal({genetic_profile:profile([locus('custom','Custom assay',['+',unknown])],{custom:call(['+',unknown])})});
    assert.equal(a.confirmed,false,unknown);assert.equal(a.unresolved,true,unknown);
  }
});


test('spreadsheet formulas and contextual genotype prose never become current allele calls',()=>{
  const a=animal({genotype:'=IF(A1,"PER2::LUC(-/-)","")'});assert.equal(a.unclassified,true);
  const b=animal({genotype:'Previously PER2::LUC(+/-)'});assert.equal(b.traits[0].presence,'uncertain');assert.equal(b.traits[0].alleles,undefined);assert.equal(b.unresolved,true);
});


test('explicitly unresolved dosage cannot be resolved by an old prime label',()=>{
  const p=trait({physical_tag:"P'-M12",genotype:"P(')"},'P');assert.equal(p.dosage,'unknown');assert.equal(p.shorthand,'P(′)');
});


test('gene-only minus calls do not establish floxed-allele absence',()=>{
  for(const [genotype,code] of [['Bmal1(-/-)','B'],['Vgat(-/-)','Vg'],['Bmal1(+/-)','B'],['Vgat(+/-)','Vg']]) {
    const a=animal({genotype}),t=a.traits.find(row=>row.code===code);
    assert.equal(t.presence,'uncertain',genotype);assert.equal(t.evidence,'uncertain',genotype);assert.equal(a.unresolved,true,genotype);
  }
  for(const [genotype,code] of [['Bmal1(+/+)','B'],['Vgat(+/+)','Vg'],['Vip-Cre(-/-)','V']]) {
    const a=animal({genotype}),t=a.traits.find(row=>row.code===code);
    assert.equal(t.presence,'absent',genotype);assert.equal(a.unresolved,false,genotype);
  }
});

test('V compound groups partition current mice while preserving pending presence, dosage and Vg identity',()=>{
 const source=dataset(["VPB'-M1","VPB'-F2","VB'-M3","(V)PB'-F4","VgPB'-M5","V(')PB'-F6"].map(physical_tag=>({physical_tag})));
 const before=structuredClone(source),result=buildFamilyGenotypes(source);
 assert.equal(result.total,6);assert.equal(result.combinations.reduce((n,g)=>n+g.count,0),6);assert.equal(result.combinations.length,5);
 assert.equal(result.combinations.filter(g=>g.count===2).length,1);
 assert.equal(result.animals[3].traits.find(t=>t.code==='V').presence,'uncertain');
 assert.equal(result.animals[4].traits.some(t=>t.code==='V'),false);assert.equal(result.animals[4].traits.find(t=>t.code==='Vg').presence,'present');
 assert.equal(result.animals[5].traits.find(t=>t.code==='V').dosage,'unknown');assert.deepEqual(source,before);
});
