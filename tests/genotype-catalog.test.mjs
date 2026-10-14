import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {discoverGenotypes,sourceProfile} from '../web/genotype-catalog.js';

const dataset=(genotypes,extra={})=>({tables:{mice:genotypes.map((genotype,index)=>({mouse_sid:`SYN-${index}`,genotype,source_filename:'synthetic.xlsx',source_sheet:'Mice',source_row:index+2})),mouse_genes:[],historical_observations:[],locations:[],...extra}});
const locus=(name,kind='other',alleles=['+',name])=>({id:name,name,kind,chromosome:'unknown',alleles,sourceLabels:[name]});

test('runtime catalog discovers names and exact source provenance without treating WT as a locus',()=>{
  const d=dataset(['PER2::LUC(+/-), Bmal1(fl/fl), WT'],{mouse_genes:[{mouse_sid:'SYN-0',gene_value:'Novel-Cre(+/-)',source_column:'K',source_record_id:'synthetic-record'}],historical_observations:[{raw_text:'Legend: GAD67-tTA and Ai32',source_title:'Synthetic archive',source_sheet:'Legend',source_cell:'B2',source_url:'https://example.test/archive#range=B2'}],locations:[{source_block_text:'Ai96 (+/-); Bmal1-ELuc',source_title:'Synthetic archive',source_sheet:'Rack',source_cell:'A1'}]});
  const original=JSON.stringify(d),found=discoverGenotypes(d);
  assert.equal(JSON.stringify(d),original);
  assert.deepEqual(found.map(item=>item.name).sort(),['Bmal1','Bmal1-ELuc','GAD67-tTA','Gt(ROSA)26Sor','Novel-Cre','PER2::LUC'].sort());
  assert.deepEqual(found.find(item=>item.name==='Bmal1').alleles,['+','fl']);
  const cre=found.find(item=>item.name==='Novel-Cre');assert.equal(cre.chromosome,'unknown');assert.equal(cre.sources[0].cell,'K2');
  const rosa=found.find(item=>item.id==='rosa26');assert.equal(rosa.chromosome,'6');assert.deepEqual(rosa.alleles,['+','Ai32','Ai96']);assert(rosa.sourceLabels.includes('Ai32'));assert(rosa.sourceLabels.includes('Ai96'));assert.equal(rosa.sources.length,2);
});

test('optional full-cell legend supplies provenance and repeated source cells are counted once',()=>{
  const url='https://example.test/archive',d=dataset([],{historical_observations:[{raw_text:'Ai32',source_title:'Synthetic archive',source_sheet:'Legend',source_cell:'B2',source_url:url+'#gid=7&range=B2'}]});
  const index={sources:[{title:'Synthetic archive',url}],sheets:[{title:'Legend',source_index:0,sheet_id:7}],cells:[[0,'B2','Ai32','Ai32',null,null,'Ai96'],[0,'C2','Avp-CreERT2',null,null,null,null]]};
  const catalog=discoverGenotypes(d,index),rosa=catalog.find(item=>item.id==='rosa26');
  assert.equal(rosa.occurrences,1);assert.equal(rosa.sources[0].url,url+'#gid=7&range=B2');
  assert(catalog.some(item=>item.name==='Avp-CreERT2'));
  assert(!catalog.some(item=>item.name==='Avp-Cre'));
});

test('explicit construct and floxed pairs remain inferred, with gene WT distinct from construct positive',()=>{
  const d=dataset(['PER2::LUC(+/-), Avp-Cre(+/+), Bmal1(+/+), Meis1(fl/fl), Bmal1-ELuc(+/-)']);
  const loci=discoverGenotypes(d),profile=sourceProfile(d.tables.mice[0],loci,d);
  assert.deepEqual(profile.calls['per2-luc'],{alleles:['PER2::LUC','+'],evidence:'inferred'});
  assert.deepEqual(profile.calls['avp-cre'].alleles,['Avp-Cre','Avp-Cre']);
  assert.deepEqual(profile.calls.bmal1.alleles,['+','+']);
  assert.deepEqual(profile.calls.meis1.alleles,['fl','fl']);
  assert.deepEqual(profile.calls['bmal1-eluc'].alleles,['Bmal1-ELuc','+']);
  assert(profile.warnings.some(value=>value.includes('not assay-verified')));
  const wt=sourceProfile({genotype:'Avp-Cre(WT/WT)'},[locus('Avp-Cre','cre')],{});
  assert.deepEqual(wt.calls['Avp-Cre'].alleles,['+','+']);
});

test('unknown, bare presence, shorthand and ambiguous gene calls never acquire WT or copy defaults',()=>{
  const loci=[locus('Bmal1','flox',['+','fl']),locus('Vip-Cre','cre'),locus('APP/PS1'),locus('PER2::LUC','reporter')];
  for(const genotype of [null,'Vip-Cre+; APP/PS1','Bmal1(+/-), Vip-Cre(WT)','Bmal1(-/-), APP/PS1(+/-)']) {
    const result=sourceProfile({genotype},loci,{});assert.deepEqual(result.calls,{});assert(result.warnings.length>0);
  }
  const unusual=sourceProfile({genotype:'Avp-Cre(fl/fl), Bmal1-ELuc(fl/fl)'},[locus('Avp-Cre','cre'),locus('Bmal1-ELuc','reporter')],{});
  assert.deepEqual(unusual.calls,{});assert.match(unusual.warnings.join(' '),/incompatible/);
});

test('both Rosa26 reporter labels require reconciliation, including impossible two homozygotes',()=>{
  const d=dataset(['Ai32(+/-), Ai96(+/-)','Ai32(+/+), Ai96(+/+)','Ai32(+/-)']),loci=discoverGenotypes(d);
  assert.equal(loci.length,1);
  for(const mouse of d.tables.mice.slice(0,2)){const result=sourceProfile(mouse,loci,d);assert.deepEqual(result.calls,{});assert.match(result.warnings.join(' '),/Rosa26/);}
  assert.deepEqual(sourceProfile(d.tables.mice[2],loci,d).calls.rosa26.alleles,['Ai32','+']);
});

test('contradictory source rows do not choose a parent call; other animals and archive prose cannot supply one',()=>{
  const d=dataset(['Vip-Cre(+/-)'],{mouse_genes:[{mouse_sid:'SYN-0',gene_value:'Vip-Cre(+/+)'},{mouse_sid:'OTHER',gene_value:'Bmal1(fl/fl)'}],historical_observations:[{raw_text:'Bmal1(fl/fl)',mouse_sids:['SYN-0']}]});
  const result=sourceProfile(d.tables.mice[0],[locus('Vip-Cre','cre'),locus('Bmal1','flox',['+','fl'])],d);
  assert.deepEqual(result.calls,{});assert.match(result.warnings.join(' '),/conflicting/);assert(!result.sourceText.includes('Bmal1'));
});

test('aliases and nearby construct names neither double count nor collide',()=>{
  const d=dataset(['PER2:LUC(+/-), Bmal1-ELuc(+/-), Bmal1(fl/+)']);
  const catalog=discoverGenotypes(d),profile=sourceProfile(d.tables.mice[0],catalog,d);
  assert.equal(catalog.find(item=>item.name==='PER2::LUC').occurrences,1);
  assert.deepEqual(profile.calls['per2-luc'].alleles,['PER2::LUC','+']);assert.deepEqual(profile.calls.bmal1.alleles,['fl','+']);
  assert.deepEqual(profile.calls['bmal1-eluc'].alleles,['Bmal1-ELuc','+']);
  const spaced=dataset(['PER2: LUC(+/-)']),spacedLoci=discoverGenotypes(spaced);
  assert.deepEqual(sourceProfile(spaced.tables.mice[0],spacedLoci,spaced).calls['per2-luc'].alleles,['PER2::LUC','+']);
});

test('catalog ignores script URLs and does not mine arbitrary source prose for animal genotypes',()=>{
  const d=dataset([],{historical_observations:[{raw_text:'Review Vip-Cre(+/-), note some mice are not tested.',source_url:'javascript:alert(1)',source_cell:'C3'}]});
  const loci=discoverGenotypes(d);assert.equal(loci[0].sources[0].url,'');assert.deepEqual(sourceProfile({mouse_sid:'SYN-0'},loci,d).calls,{});
});

test('spreadsheet AI coordinates are not reporter labels; named header columns resolve to A1 cells',()=>{
  const d=dataset(['Ai32(+/-)'],{mouse_genes:[{mouse_sid:'SYN-0',gene_value:'Ai32(+/-)',source_column:'1st Gene'}],locations:[{source_block_text:'AI13: 4\nAI32: 0\nMove from AI15 to AI17\nAI16: =IF(Ai7,"Unknown-Cre(+/-)",0)'}]});
  d.sources=[{source_filename:'synthetic.xlsx',sheet:'Mice',headers:['Mouse SID','1st Gene']}];
  const found=discoverGenotypes(d);assert.deepEqual(found.map(item=>item.name),['Gt(ROSA)26Sor']);assert(found[0].sources.some(source=>source.cell==='B2'));
  assert.deepEqual(sourceProfile({genotype:'=IF(A1,"Ai32(+/-)","")'},found,{}).calls,{});
});

test('generic gene notation is not a named transgene and canonical label IDs cannot collide',()=>{
  const d=dataset(['Vgat(+/+), Meis1(+/-), Gene.A(+/-), Gene/A(+/-)']),catalog=discoverGenotypes(d);
  const result=sourceProfile(d.tables.mice[0],catalog,d);assert.deepEqual(result.calls,{});assert.match(result.warnings.join(' '),/semantics are ambiguous/);
  const a=catalog.find(item=>item.name==='Gene.A'),b=catalog.find(item=>item.name==='Gene/A');assert.notEqual(a.id,b.id);
  assert.equal(discoverGenotypes(dataset(['Gene.A(+/-)']))[0].id,a.id);
});

test('sheet excerpts require a complete tagged mouse ID and remain separate from calls',()=>{
  const d=dataset([],{historical_observations:[
    {raw_text:"PB'-M007; Bmal1(fl/fl)",source_title:'Synthetic source',source_sheet:'Rack',source_cell:'B2',source_url:'https://example.test/source'},
    {raw_text:"PB'-M0071; Ai32(+/+)",source_cell:'B3'},
    {raw_text:'007 or cage 007; Vip-Cre(+/+)',source_cell:'B4'},
    {raw_text:'M7; Meis1(fl/fl)',source_cell:'B5'}
  ],locations:[{source_block_text:'AB6: F007 is here',source_title:'Synthetic source',source_sheet:'Rack',source_cell:'AB6',source_url:'javascript:bad()'}]});
  const mouse={mouse_sid:'007',physical_tag:"PB'-M"},result=sourceProfile(mouse,[locus('Bmal1','flox',['+','fl'])],d);
  assert.deepEqual(result.calls,{});assert.equal(result.sheetEvidence.length,2);assert.equal(result.sheetEvidence[1].url,'');assert.match(result.warnings.join(' '),/no genotype calls were inferred/);
  assert(!result.sheetEvidence.some(row=>row.text.includes('M0071')));
  d.tables.locations=[...d.tables.locations,{source_block_text:'ALT-007',source_cell:'Z1'}];
  assert.equal(sourceProfile({...mouse,physical_tag:'ALT-'},[],d).sheetEvidence.length,3);
});

test('private imported data discovers requested labels and preserves source text without writes',async context=>{
  let d;try{d=JSON.parse(await readFile(new URL('../../outputs/reconstruction_2026-10-14/dataset_augmented.json',import.meta.url),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;context.skip('Private source fixture is not part of the public repository.');return;}
  const catalog=discoverGenotypes(d),names=new Set(catalog.flatMap(item=>item.sourceLabels.map(label=>label.toLowerCase())));
  for(const name of ['PER2::LUC','Bmal1-ELuc','Avp-Cre','Vip-Cre','FoxJ1-Cre','Bmal1','Ai32','Ai96','Vgat','GAD67-tTA','Meis1','APP/PS1'])assert(names.has(name.toLowerCase()),`Expected runtime label ${name}`);
  assert.equal(catalog.filter(item=>item.name==='Gt(ROSA)26Sor').length,1);
  for(const mouse of d.tables.mice.slice(0,30))assert.equal(typeof sourceProfile(mouse,catalog,d).sourceText,'string');
});
