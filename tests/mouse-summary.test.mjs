import test from 'node:test';
import assert from 'node:assert/strict';
import {MOUSE_LINE_GROUPS,summarizeMice,mouseLineAssignments} from '../web/mouse-summary.js';

const dataset=(mice,genes=[])=>({tables:{mice:mice.map((mouse,index)=>({mouse_sid:`SYN-${index}`,state:'Stock',...mouse})),mouse_genes:genes}});
const profile=(name,alleles,evidence='confirmed')=>({schema_version:1,loci:[{id:'synthetic-locus',name,kind:'other',alleles:['+','fl',name]}],calls:{'synthetic-locus':{alleles,evidence}}});

test('alive totals use all current nonarchived Stock records and explicit sex',()=>{
  const d=dataset([{sex:'Male'},{sex:'Female'},{sex:'Unknown'},{sex:'M'},{sex:'F'},{state:'Ended',sex:'Male'},{state:'Unknown'},{app_archived_at:'2026-10-14'},{archived:true},{archived:false}]);
  const s=summarizeMice(d);assert.equal(s.alive,6);assert.equal(s.male,2);assert.equal(s.female,2);assert.equal(s.unknownSex,2);
  d.tables.mice.push(d.tables.mice[0]);assert.equal(summarizeMice(d).alive,6);
  assert.deepEqual(MOUSE_LINE_GROUPS.map(group=>group.key),['P','E','B','F','V','AD']);
});

test('compact line tags overlap once per animal without counting sex suffixes or other genes',()=>{
  const s=summarizeMice(dataset([{physical_tag:"PB'-F001"},{physical_tag:"M2-PB'"},{physical_tag:"EB'-M002"},{physical_tag:"Vg'GtP'-F003"},{physical_tag:'WT-F004'},{physical_tag:'F-M005'},{physical_tag:'VIP experimental notes'}]));
  assert.deepEqual(s.lines,{P:3,E:1,B:3,F:1,V:0,AD:0});assert.deepEqual(s.uncertainLines,{P:0,E:0,B:0,F:0,V:0,AD:0});
});

test('bare F line codes are retained while explicit tag sex suffixes are excluded',()=>{
  const s=summarizeMice(dataset([{genotype:'F'},{genotype:'PF'},{physical_tag:'PF-M12'},{physical_tag:'F'},{physical_tag:'P-F'},{mouseline:'F'},{mouseline:'Vip-Cre'},{mouseline:'B6'}]));
  assert.deepEqual(s.lines,{P:3,E:0,B:0,F:5,V:1,AD:0});
});

test('whole-line parentheses and question marks stay uncertain, primes do not establish absence',()=>{
  const s=summarizeMice(dataset([{physical_tag:"P(')B'"},{physical_tag:"(V('))(P('))B'-M001"},{physical_tag:"(E)B'-F002"},{physical_tag:"(AD)(F)(P)B'"},{physical_tag:'P?B-M003'},{physical_tag:"EB' or PB'"}]));
  assert.deepEqual(s.lines,{P:1,E:0,B:6,F:0,V:0,AD:0});assert.deepEqual(s.uncertainLines,{P:4,E:2,B:0,F:1,V:1,AD:1});
});

test('explicit source calls and names match exact lines, and negative calls override tags',()=>{
  const s=summarizeMice(dataset([
    {physical_tag:'PBEFV-M001',genotype:'PER2::LUC(-/-); Bmal1(+/+); Bmal1-ELuc(WT/WT); FoxJ1-Cre(negative); Vip-Cre-/-'},
    {genotype:'PER2:LUC(+/-); Bmal1(fl/fl); Bmal1-ELuc(+/-); Foxj1-Cre(+/+); VIP-Cre(+/-)'},
    {genotype:'Bmal1-ELuc; Bmal1; PER2::LUC'},
    {genotype:'Bmal1-flox/flox'},
  ]));
  assert.deepEqual(s.lines,{P:2,E:2,B:2,F:1,V:1,AD:0});assert.equal(s.uncertainLines.B,1);
});

test('linked mouse genes are animal-specific and duplicated evidence counts only once',()=>{
  const s=summarizeMice(dataset([{mouse_sid:'SYN-A',genotype:'PER2::LUC',physical_tag:'PB-M001'},{mouse_sid:'SYN-B'}],[{mouse_sid:'SYN-A',gene_value:'PER2::LUC'},{mouse_sid:'SYN-A',gene_value:'Vip-Cre'},{mouse_sid:'OTHER',gene_value:'FoxJ1-Cre'}]));
  assert.deepEqual(s.lines,{P:1,E:0,B:1,F:0,V:1,AD:0});
});

test('confirmed structured genotypes override imported text and unknown evidence blocks fallback',()=>{
  const s=summarizeMice(dataset([
    {genotype:'PER2::LUC',physical_tag:'P-M001',genetic_profile:profile('PER2::LUC',['+','+'])},
    {genotype:'Bmal1(+/+)',genetic_profile:profile('Bmal1',['fl','+'])},
    {genotype:'Vip-Cre',physical_tag:'V-M002',genetic_profile:profile('Vip-Cre',['Vip-Cre','+'],'unknown')},
    {genotype:'FoxJ1-Cre',genetic_profile:profile('FoxJ1-Cre',['FoxJ1-Cre','+'],'inferred')},
    {genetic_profile:profile('Bmal1-ELuc',['Bmal1-ELuc','+'])},
  ]));
  assert.deepEqual(s.lines,{P:0,E:1,B:1,F:1,V:0,AD:0});assert.equal(s.uncertainLines.V,1);
});

test('inferred profile calls cannot resolve conflicting explicit source evidence',()=>{
  const s=summarizeMice(dataset([{genotype:'FoxJ1-Cre(-/-)',genetic_profile:profile('FoxJ1-Cre',['FoxJ1-Cre','+'],'inferred')} ]));
  assert.equal(s.lines.F,0);assert.equal(s.uncertainLines.F,1);
});

test('reusable assignments preserve the confirmed prime and parenthesis meanings',()=>{
  assert.deepEqual(mouseLineAssignments({mouse_sid:'SYN-A',physical_tag:"P(')(V)B'"},[{mouse_sid:'SYN-A',gene_value:'Bmal1-ELuc'},{mouse_sid:'OTHER',gene_value:'FoxJ1-Cre'}]),{P:'recorded',E:'recorded',B:'recorded',V:'uncertain'});
  assert.deepEqual(mouseLineAssignments({physical_tag:"(P')B'"}),{P:'uncertain',B:'recorded'});
  assert.deepEqual(mouseLineAssignments({physical_tag:"P'B'",genotype:'PER2::LUC(-/-)'}),{B:'recorded'});
});

test('contradictory explicit calls remain uncertain and arbitrary historical prose is ignored',()=>{
  const d=dataset([{genotype:'PER2::LUC(+/-); PER2::LUC(-/-)',physical_tag:'P-M001'},{comment:'Vip-Cre',sire_sids:['F001']},{genotype:'=IF(A1,"Vip-Cre","")'}]);
  d.tables.historical_observations=[{mouse_sids:['SYN-1'],raw_text:'FoxJ1-Cre(+/+)'}];
  const s=summarizeMice(d);assert.deepEqual(s.lines,{P:0,E:0,B:0,F:0,V:0,AD:0});assert.equal(s.uncertainLines.P,1);
});

test('summaries preserve source records and recalculate after edits',()=>{
  const d=dataset([{physical_tag:'PB-M001'}]),before=structuredClone(d);assert.equal(summarizeMice(d).lines.P,1);assert.deepEqual(d,before);
  d.tables.mice[0].state='Ended';assert.equal(summarizeMice(d).alive,0);assert.equal(summarizeMice(d).lines.P,0);
  assert.deepEqual(summarizeMice(null),{alive:0,male:0,female:0,unknownSex:0,lines:{P:0,E:0,B:0,F:0,V:0,AD:0},uncertainLines:{P:0,E:0,B:0,F:0,V:0,AD:0}});
});

test('all eleven confirmed strain codes are reusable assignments while summary includes six lines',()=>{
  const mouse={physical_tag:"P'E'B'F'V'AD'A'32'Vg'Gt'96'-M12"};
  const codes=['P','E','B','F','V','AD','A','32','Vg','Gt','96'];
  assert.deepEqual(mouseLineAssignments(mouse),Object.fromEntries(codes.map(code=>[code,'recorded'])));
  const summary=summarizeMice(dataset([mouse]));
  assert.deepEqual(summary.lines,{P:1,E:1,B:1,F:1,V:1,AD:1});assert.deepEqual(Object.keys(summary.lines),['P','E','B','F','V','AD']);
});

test('multi-letter codes and named floxed alleles preserve distinct line identities',()=>{
  assert.deepEqual(mouseLineAssignments({genotype:'AD'}),{AD:'recorded'});
  assert.deepEqual(mouseLineAssignments({genotype:'Vg'}),{Vg:'recorded'});
  assert.deepEqual(mouseLineAssignments({genotype:'Vgat'}),{Vg:'uncertain'});
  assert.deepEqual(mouseLineAssignments({genotype:'Vgat(fl/+)'}),{Vg:'recorded'});
  assert.deepEqual(mouseLineAssignments({physical_tag:'Vg-M12',genotype:'Vgat(+/+)'}),{});
  assert.deepEqual(mouseLineAssignments({genotype:'APP/PS1; Avp-Cre(+/-); GAD67-tTA(+/+)'}),{AD:'recorded',A:'recorded',Gt:'recorded'});
  assert.deepEqual(mouseLineAssignments({physical_tag:"(AD)(Vg)Gt(')-F12"}),{AD:'uncertain',Vg:'uncertain',Gt:'recorded'});
});

test('numeric reporter codes require explicit genotype values or genuine tag prefixes',()=>{
  for(const value of ['32','96','3296','0032','10096'])assert.deepEqual(mouseLineAssignments({physical_tag:value}),{});
  assert.deepEqual(mouseLineAssignments({genotype:'32'}),{'32':'recorded'});
  assert.deepEqual(mouseLineAssignments({genotype:'96'}),{'96':'recorded'});
  assert.deepEqual(mouseLineAssignments({physical_tag:'32-M96'}),{'32':'recorded'});
  assert.deepEqual(mouseLineAssignments({physical_tag:'P96-F32'}),{P:'recorded','96':'recorded'});
  assert.deepEqual(mouseLineAssignments({genotype:'Ai320; source row 96; sample 32'}),{});
  assert.deepEqual(mouseLineAssignments({physical_tag:'P96-M12',genotype:'Ai96(-/-)'}),{P:'recorded'});
});

test('Rosa26 structured profiles identify reporter allele presence without independent-locus assumptions',()=>{
  const mouse={physical_tag:'32P96-M12',genetic_profile:{schema_version:1,loci:[{id:'rosa26',name:'Gt(ROSA)26Sor',alleles:['+','Ai32','Ai96']}],calls:{rosa26:{alleles:['Ai32','+'],evidence:'confirmed'}}}};
  assert.deepEqual(mouseLineAssignments(mouse),{P:'recorded','32':'recorded'});
  mouse.genetic_profile.calls.rosa26.alleles=['Ai32','Ai96'];assert.deepEqual(mouseLineAssignments(mouse),{P:'recorded','32':'recorded','96':'recorded'});
  mouse.genetic_profile.calls.rosa26.evidence='unknown';assert.deepEqual(mouseLineAssignments(mouse),{P:'recorded','32':'uncertain','96':'uncertain'});
});

test('nonregistered M is never inferred as a strain code',()=>{
  assert.deepEqual(mouseLineAssignments({genotype:'M',mouseline:'Meis1',physical_tag:'M123'}),{});
  assert.deepEqual(mouseLineAssignments({genotype:'AM'}),{});
});

test('undetermined tags cannot be resolved by bare genotype or mouseline names',()=>{
  const mouse={mouse_sid:'SYN-A',physical_tag:'(P)(V)B-M001',genotype:'PER2::LUC',mouseline:'Vip-Cre'};
  const genes=[{mouse_sid:'SYN-A',gene_value:'PER2::LUC'},{mouse_sid:'SYN-A',gene_value:'Bmal1'}];
  assert.deepEqual(mouseLineAssignments(mouse,genes),{P:'uncertain',B:'recorded',V:'uncertain'});
  mouse.genotype='PER2::LUC(+/-)';assert.equal(mouseLineAssignments(mouse,genes).P,'recorded');
  mouse.genotype='PER2::LUC(-/-)';assert.equal(mouseLineAssignments(mouse,genes).P,undefined);
  mouse.genotype='PER2::LUC';mouse.genetic_profile=profile('PER2::LUC',['PER2::LUC','+']);assert.equal(mouseLineAssignments(mouse,genes).P,'recorded');
});

test('explicit unknown calls take precedence over simple compact line labels',()=>{
  for(const genotype of ['PER2::LUC(?)','PER2::LUC unknown','PER2::LUC(+/-)?','(P)','P?'])assert.deepEqual(mouseLineAssignments({physical_tag:'P-M001',genotype}),{P:'uncertain'},genotype);
  assert.deepEqual(mouseLineAssignments({physical_tag:'B-M001',genotype:'Bmal1'}),{B:'recorded'});
  assert.deepEqual(mouseLineAssignments({physical_tag:'B-M001',genotype:'Bmal1(?)'}),{B:'uncertain'});
  assert.deepEqual(mouseLineAssignments({physical_tag:'Vg-M001',genotype:'Vgat'}),{Vg:'recorded'});
  assert.deepEqual(mouseLineAssignments({physical_tag:'Vg-M001',genotype:'Vgat unknown'}),{Vg:'uncertain'});
});

test('bare named evidence cannot resolve parenthesized additional strain codes',()=>{
  assert.deepEqual(mouseLineAssignments({physical_tag:'(AD)(A)(32)(Vg)(Gt)(96)-F001',genotype:'APP/PS1; Avp-Cre; Ai32; Vgat-flox; GAD67-tTA; Ai96'}),{AD:'uncertain',A:'uncertain','32':'uncertain',Vg:'uncertain',Gt:'uncertain','96':'uncertain'});
});

 test('AD summaries distinguish APP/PS1 evidence, negative results and undetermined tags',()=>{
 const summary=summarizeMice(dataset([{physical_tag:'ADP-M1'},{genotype:'APP/PS1(+/-)'},{physical_tag:'(AD)-F2'},{physical_tag:'AD-M3',genotype:'APP/PS1(-/-)'},{genotype:'AD',state:'Ended'}]));
 assert.equal(summary.lines.AD,2);assert.equal(summary.uncertainLines.AD,1);
 });
