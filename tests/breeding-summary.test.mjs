import test from 'node:test';

test('corrected names retain flox assay semantics and exact FoxJ-Cre alias',()=>{
  for(const genotype of ['Meis1-flox(fl/+)','Vgat-flox(fl/fl)','Bmal1-flox(+/+)','FoxJ-Cre(+/-)'])assert.equal(isMouseGenotyped({genotype}),true,genotype);
  for(const genotype of ['Meis1-flox(+/-)','Vgat-Cre(+/-)','FoxJ-CreERT2(+/-)'])assert.equal(isMouseGenotyped({genotype}),false,genotype);
});
import assert from 'node:assert/strict';
import { summarizeBreeding, isMouseGenotyped, estimateBreedingGroups, classifyAnimalSheetBreedingBlock } from '../web/breeding-summary.js';
import { buildBreedingOptions, DEFAULT_BREEDING_OPTIONS } from '../web/breeding-options.js';

const asOf='2026-10-14';
const born=days=>new Date(Date.parse(`${asOf}T00:00:00Z`)-days*86400000).toISOString().slice(0,10);
const dataset=(mice,extra={})=>({tables:{mice:mice.map((mouse,index)=>({mouse_sid:`SYN-${index}`,state:'Stock',...mouse})),mouse_genes:[],matings:[],husbandry_events:[],...extra}});
const summarize=(data,scope='living')=>summarizeBreeding(data,{asOf,scope});
function cohouse(data,ids,cage='C1'){data.tables.cages??=[];data.tables.cages.push({cage_sid:cage,state:'Active'});for(const mouse of data.tables.mice)if(ids.includes(mouse.mouse_sid))mouse.cage_sid=cage;return data;}
const locus=(id,name,alleles=['+',name])=>({id,name,kind:'other',chromosome:'unknown',alleles});
const profile=(loci,calls)=>({schema_version:1,loci,calls});
const call=(alleles,evidence='confirmed')=>({alleles,evidence});
const pProfile=()=>profile([locus('per2','PER2::LUC')],{per2:call(['PER2::LUC','+'])});

test('living summary deduplicates Stock animals and excludes ended and archived records',()=>{
  const data=dataset([{sex:'Male',date_of_birth:born(70),genotype:'PER2::LUC(+/-)'},{sex:'Female',date_of_birth:born(70)},{sex:'unknown'},{state:'Ended',sex:'Male'},{archived:true},{app_archived_at:asOf},{state:'Unknown'}]);
  data.tables.mice.push({...data.tables.mice[0]});
  const {groupEstimate,...result}=summarize(data);assert.equal(groupEstimate.totalGroups,0);assert.deepEqual(result,{total:3,male:1,female:1,unknownSex:1,maleFertile:1,femaleFertile:1,unknownMaleAge:0,unknownFemaleAge:0,genotyped:1,activeGroups:0,scope:'living',asOf});
});

test('age windows use exact calendar days including both endpoints',()=>{
  const data=dataset(['male','female'].flatMap(sex=>{
    const min=DEFAULT_BREEDING_OPTIONS[`${sex}_min_weeks`]*7,max=DEFAULT_BREEDING_OPTIONS[`${sex}_max_weeks`]*7;
    return [min-1,min,max,max+1].map(age=>({sex,date_of_birth:born(age)}));
  }));
  const result=summarize(data);assert.equal(result.male,4);assert.equal(result.female,4);assert.equal(result.maleFertile,2);assert.equal(result.femaleFertile,2);
});

test('missing, malformed, impossible and future DOBs are unknown age, never fertile',()=>{
  const invalid=[undefined,null,'','2026-02-30','2026-1-01','not-a-date','2026-10-15','2026-08-01T00:00:00Z',42];
  const data=dataset(invalid.flatMap(date_of_birth=>[{sex:'M',date_of_birth},{sex:'F',date_of_birth}]));
  const result=summarize(data);assert.equal(result.maleFertile,0);assert.equal(result.femaleFertile,0);assert.equal(result.unknownMaleAge,invalid.length);assert.equal(result.unknownFemaleAge,invalid.length);
});

test('custom ranges apply independently by sex and change the next summary without mutating animals',()=>{
  const original=dataset([{sex:'Male',date_of_birth:born(100)},{sex:'Female',date_of_birth:born(100)}]);
  const changed=buildBreedingOptions(original,{male_min_weeks:15,male_max_weeks:20,female_min_weeks:14,female_max_weeks:14.5},{now:'2026-10-14T00:00:00Z',eventDate:asOf}).dataset;
  const before=structuredClone(changed),result=summarize(changed);
  assert.equal(result.maleFertile,0);assert.equal(result.femaleFertile,1);assert.deepEqual(changed,before);assert.equal(original.tables.husbandry_events.length,0);
});

test('active scope counts distinct living breeders, not memberships or inferred sex roles',()=>{
  const data=dataset([{sex:'Male'},{sex:'Female'},{sex:'Unknown'},{sex:'Male',state:'Ended'},{sex:'Female'},{sex:'Female',archived:true}],{matings:[
    {mating_sid:'SYN-M1',state:'Active',male_sids:['SYN-0','SYN-2'],female_sids:['SYN-1','SYN-3','SYN-5'],set_up_date:'2026-10-01'},
    {mating_sid:'SYN-M2',state:'Active',male_sids:['SYN-0'],female_sids:['SYN-1']},
    {mating_sid:'SYN-M3',state:'Inactive',female_sids:['SYN-4']},
  ]});
  data.tables.matings.push({...data.tables.matings[0]});cohouse(data,['SYN-0','SYN-1','SYN-2']);
  const result=summarize(data,'active');assert.equal(result.activeGroups,2);assert.equal(result.total,3);assert.equal(result.male,1);assert.equal(result.female,1);assert.equal(result.unknownSex,1);assert.equal(summarize(data).total,4);
});

test('active groups exclude archived, future setup and already disbanded matings',()=>{
  const data=dataset([{sex:'Male'}],{matings:[
    {state:'Active',male_sids:['SYN-0'],set_up_date:'2026-10-14',disbanded_date:'2026-10-15'},
    {state:'Active',male_sids:['SYN-0'],set_up_date:'2026-10-15'},
    {state:'Active',male_sids:['SYN-0'],disbanded_date:'2026-10-14'},
    {state:'Active',male_sids:['SYN-0'],disbanded_date:'2026-10-13'},
    {state:'Active',male_sids:['SYN-0'],app_archived_at:asOf},
    {state:'Active',male_sids:['SYN-0'],archived:true},
  ]});
  assert.equal(summarize(data,'active').activeGroups,1);assert.equal(summarize(data,'active').total,0);assert.equal(summarize(data).groupEstimate.totalGroups,0);
});

test('empty data is safe and invalid summary date or scope is explicit',()=>{
  const result=summarize(null);assert.equal(result.total,0);assert.equal(result.activeGroups,0);
  for(const value of ['2026-02-30','2026-1-01',null,123])assert.throws(()=>summarizeBreeding(null,{asOf:value}),/valid YYYY-MM-DD/);
  assert.throws(()=>summarizeBreeding(null,{asOf,scope:'all'}),/living or active/);
});

test('complete explicit imported positive and negative genotypes count once per animal',()=>{
  for(const genotype of ['PER2::LUC(+/-)','PER2::LUC(-/-)','Vip-Cre(WT)','Vip-Cre(negative)','Bmal1(+/+)','Bmal1(fl/+)','WT(+/+)','APP/PS1(+/-)','Bmal1(fl/fl); Bmal1-ELuc(+/-); FoxJ1-Cre(+/+)'])assert.equal(isMouseGenotyped({genotype}),true,genotype);
  assert.equal(isMouseGenotyped({physical_tag:'PB-M12',genotype:'PER2::LUC(-/-); Bmal1(fl/fl)'}),true);
});

test('broad names, unresolved notation and parentage alone do not establish genotyping',()=>{
  for(const genotype of ['',null,'PER2::LUC','Bmal1','WT','(P)',"P(')",'APP/PS1','PER2::LUC(?)','PER2::LUC unknown','PER2::LUC(+/-)?','PER2::LUC(+)','Bmal1(+/-)','Bmal1-ELuc(fl/fl)'])assert.equal(isMouseGenotyped({genotype}),false,String(genotype));
  assert.equal(isMouseGenotyped({sire_sids:['SYN-P'],dam_sids:['SYN-P']}),false);
  for(const mouseline of ['P',"PB'",'PER2::LUC','APP/PS1'])assert.equal(isMouseGenotyped({mouseline}),false,mouseline);
});

test('clear recorded shorthand counts without inventing a dosage or changing source data',()=>{
  for(const genotype of ['P',"P'",'P′',"PB'","P'B'",'AD','P AD','Vg','Gt',"P E B' F V",'32']) {
    const mouse={genotype},before=structuredClone(mouse);assert.equal(isMouseGenotyped(mouse),true,genotype);assert.deepEqual(mouse,before);
  }
  for(const physical_tag of ['P','P-M12',"P'B'-M12",'PB′-F7','M12-P','AD-M9','PF7'])assert.equal(isMouseGenotyped({physical_tag}),true,physical_tag);
  for(const physical_tag of ['32','96','1234','M12','F7'])assert.equal(isMouseGenotyped({physical_tag}),false,physical_tag);
  assert.equal(isMouseGenotyped({mouse_sid:'SYN-A'},[{mouse_sid:'SYN-A',gene_value:"PB'"}]),true);
});

test('every parenthesized or unknown shorthand component blocks completion until resolved',()=>{
  for(const genotype of ['(P)',"P(')",'P(′)',"P (' )",'P(B)',"P'(B')",'(PB)',"(P)B'",'P?','PB?',"P; P(')",'P or B','P; unknown','P()',"P''",'P)'])assert.equal(isMouseGenotyped({genotype}),false,genotype);
  for(const physical_tag of ['(P)-M12',"P(')-M12",'P(B)-F7','PB?-M12'])assert.equal(isMouseGenotyped({physical_tag}),false,physical_tag);
  assert.equal(isMouseGenotyped({physical_tag:'(P)(B)-M12',genotype:"PB'"}),true);
  assert.equal(isMouseGenotyped({physical_tag:'P-M12',genotype:'P(?)'}),false);
  assert.equal(isMouseGenotyped({physical_tag:'PB-M12',genotype:'P; B unknown'}),false);
  assert.equal(isMouseGenotyped({physical_tag:'PB-M12',mouseline:'P(B)'}),false);
  assert.equal(isMouseGenotyped({physical_tag:'PB-M12',mouseline:'P(B)',genotype:"PB'"}),true);
});

test('explicit source and reviewed calls retain precedence over tag shorthand',()=>{
  assert.equal(isMouseGenotyped({physical_tag:"P'B'-M12",genotype:'PER2::LUC(-/-); Bmal1(+/+)'}),true);
  assert.equal(isMouseGenotyped({physical_tag:"P(')-M12",genotype:'P(-/-)'}),true);
  assert.equal(isMouseGenotyped({genotype:'P negative; B(+/+)'}),true);
  for(const genotype of ['P; PER2::LUC(-/-)',"P'; PER2::LUC(+/-)",'P; P(?)'])assert.equal(isMouseGenotyped({genotype}),false,genotype);
  assert.equal(isMouseGenotyped({genotype:'P; PER2::LUC(+/-)'}),true);
  assert.equal(isMouseGenotyped({genotype:"P(')",genetic_profile:pProfile()}),true);
});

test('every current indicated target needs a clear recorded result; negative tests resolve uncertain labels',()=>{
  assert.equal(isMouseGenotyped({physical_tag:'P(B)-M12',genotype:'PER2::LUC(+/-)'}),false);
  assert.equal(isMouseGenotyped({physical_tag:'PB-M12',genotype:'PER2::LUC(+/-)'}),true);
  assert.equal(isMouseGenotyped({physical_tag:'(P)(B)-M12',genotype:'PER2::LUC(-/-); Bmal1(+/+)'}),true);
  assert.equal(isMouseGenotyped({mouseline:'FoxJ1-Cre',genotype:'PER2::LUC(+/-)'}),false);
  assert.equal(isMouseGenotyped({genotype:'PER2::LUC(+/-), APP/PS1'}),false);
});

test('scoped linked genes can complete a mouse genotype; foreign or archived genes cannot',()=>{
  const mouse={mouse_sid:'SYN-A',physical_tag:'P(B)-M12',genotype:'PER2::LUC(+/-)'};
  assert.equal(isMouseGenotyped(mouse,[{mouse_sid:'OTHER',gene_value:'Bmal1(fl/fl)'}]),false);
  assert.equal(isMouseGenotyped(mouse,[{mouse_sid:'SYN-A',gene_value:'Bmal1(fl/fl)',archived:true}]),false);
  assert.equal(isMouseGenotyped(mouse,[{mouse_sid:'SYN-A',gene_value:'Bmal1(fl/fl)'},{mouse_sid:'SYN-A',gene_value:'Bmal1(fl/fl)'}]),true);
});

test('conflicting allele pairs and uncertain current calls are not complete',()=>{
  for(const genotype of ['PER2::LUC(+/-); PER2::LUC(-/-)','PER2::LUC(+/-); PER2::LUC(+/+)','Bmal1(fl/+); Bmal1(fl/fl)','PER2::LUC(+/-); PER2::LUC(?)','PER2::LUC(+/-); unknown'])assert.equal(isMouseGenotyped({genotype}),false,genotype);
  assert.equal(isMouseGenotyped({genotype:'PER2::LUC(+/-); PER2::LUC(-/+)'}),true);
});

test('malformed or historical prose cannot be parsed opportunistically as complete current evidence',()=>{
  for(const genotype of ['Previously PER2::LUC(+/-)','PER2::LUC(+/-) or WT','PER2::LUC((+/-))','=IF(A1,"PER2::LUC(+/-)","")','PER2::LUC(+/-); Novel-Cre'])assert.equal(isMouseGenotyped({genotype}),false,genotype);
  assert.equal(isMouseGenotyped({comment:'PER2::LUC(+/-)'}),false);
});

test('reviewed profiles require valid complete confirmed calls, including wild-type alleles',()=>{
  const valid=pProfile();assert.equal(isMouseGenotyped({genetic_profile:valid}),true);
  valid.calls.per2.alleles=['+','+'];assert.equal(isMouseGenotyped({genetic_profile:valid}),true);
  for(const evidence of ['unknown','inferred']) {
    const incomplete=pProfile();incomplete.calls.per2.evidence=evidence;
    assert.equal(isMouseGenotyped({genetic_profile:incomplete,genotype:'PER2::LUC(+/-)'}),false);
  }
  for(const changed of [null,{},[],{schema_version:1,loci:[],calls:{}},{...pProfile(),calls:{}},{...pProfile(),schema_version:2}])assert.equal(isMouseGenotyped({genetic_profile:changed}),false);
});

test('a partial reviewed profile cannot hide additional indicated strains or declared loci',()=>{
  assert.equal(isMouseGenotyped({physical_tag:'P(B)-M12',genetic_profile:pProfile()}),false);
  assert.equal(isMouseGenotyped({physical_tag:'P(B)-M12',genetic_profile:pProfile(),genotype:'Bmal1(fl/fl)'}),true);
  const incomplete=pProfile();incomplete.loci.push(locus('bmal','Bmal1',['+','fl']));incomplete.calls.bmal=call([],'unknown');
  assert.equal(isMouseGenotyped({genetic_profile:incomplete}),false);
  assert.equal(isMouseGenotyped({mouseline:'Meis1',genetic_profile:pProfile()}),false);
});

test('reviewed profile names accept exact lab strain acronyms',()=>{
  const abbreviated=profile([locus('p','P')],{p:call(['P','+'])});
  assert.equal(isMouseGenotyped({physical_tag:'P-M12',genetic_profile:abbreviated}),true);
  assert.equal(isMouseGenotyped({physical_tag:'P(B)-M12',genetic_profile:abbreviated}),false);
  assert.equal(isMouseGenotyped({physical_tag:'PB-M12',genetic_profile:abbreviated}),true);
});

test('reviewed calls supersede stale source calls for only the reviewed targets',()=>{
  assert.equal(isMouseGenotyped({physical_tag:'P-M12',genotype:'PER2::LUC(-/-); PER2::LUC(?)',genetic_profile:pProfile()}),true);
  assert.equal(isMouseGenotyped({genotype:'PER2::LUC(+/-); Bmal1(?)',genetic_profile:pProfile()}),false);
  assert.equal(isMouseGenotyped({genotype:'PER2::LUC(+/-); Novel-Cre(+/-)',genetic_profile:pProfile()}),false);
  assert.equal(isMouseGenotyped({genotype:"P'",genetic_profile:pProfile()}),true);
});

test('reviewed Rosa26 and custom loci are supported without inventing independent reporter loci',()=>{
  const rosa=profile([locus('rosa26','Gt(ROSA)26Sor',['+','Ai32','Ai96'])],{rosa26:call(['Ai32','Ai96'])});
  assert.equal(isMouseGenotyped({physical_tag:'3296-M12',genetic_profile:rosa}),true);
  const custom=profile([locus('novel','Novel-Cre')],{novel:call(['Novel-Cre','+'])});
  assert.equal(isMouseGenotyped({genotype:'Novel-Cre',genetic_profile:custom}),true);
});

test('two reporter source pairs require one reviewed Rosa26 call, including conflicting homozygotes',()=>{
  for(const genotype of ['Ai32(+/+); Ai96(+/+)','Ai32(+/-); Ai96(+/-)','Ai32(-/-); Ai96(+/+)'])assert.equal(isMouseGenotyped({genotype}),false,genotype);
  const separate=profile([locus('ai32','Ai32'),locus('ai96','Ai96')],{ai32:call(['Ai32','+']),ai96:call(['Ai96','+'])});
  assert.equal(isMouseGenotyped({genetic_profile:separate}),false);
  const reviewed=profile([locus('rosa26','Gt(ROSA)26Sor',['+','Ai32','Ai96'])],{rosa26:call(['Ai32','Ai96'])});
  assert.equal(isMouseGenotyped({genotype:'Ai32(+/+); Ai96(+/+)',genetic_profile:reviewed}),true);
});

test('duplicate named profile targets are rejected even when record IDs differ',()=>{
  const duplicate=pProfile();duplicate.loci.push(locus('per2-again','PER2::LUC'));duplicate.calls['per2-again']=call(['+','+']);
  assert.equal(isMouseGenotyped({genetic_profile:duplicate}),false);
});

test('genotyped numerator uses the same selected cohort as denominator and source is immutable',()=>{
  const data=dataset([{sex:'Male',genotype:'PER2::LUC(+/-)'},{sex:'Female',genotype:'PER2::LUC(-/-)'},{sex:'Female',genotype:'PER2::LUC'}],{matings:[{state:'Active',male_sids:['SYN-0'],female_sids:['SYN-2']}]});
  cohouse(data,['SYN-0','SYN-2']);const before=structuredClone(data);assert.equal(summarize(data).genotyped,2);assert.equal(summarize(data,'active').genotyped,1);assert.equal(summarize(data,'active').total,2);assert.deepEqual(data,before);
});

test('shorthand numerator includes clear animals and excludes unresolved or ended animals in either scope',()=>{
  const data=dataset([{genotype:'P'},{physical_tag:"PB'-F7"},{genotype:'P(B)'},{genotype:'AD',state:'Ended'}],{matings:[{state:'Active',male_sids:['SYN-0'],female_sids:['SYN-2']}]});
  cohouse(data,['SYN-0','SYN-2']);data.tables.mice[0].sex='Male';data.tables.mice[2].sex='Female';const before=structuredClone(data);assert.equal(summarize(data).genotyped,2);assert.equal(summarize(data).total,3);assert.equal(summarize(data,'active').genotyped,1);assert.equal(summarize(data,'active').total,2);assert.deepEqual(data,before);
});

const sourcePosition=(id='L1',extra={})=>({location_id:id,label:'Synthetic '+id,record_origin:'current_google_sheet_map',source_current:true,source_snapshot_date:asOf,source_cell:'T7',source_block_text:"T7: B1\nT8: P' M101\nU8: 2026-08-01\nT9: (P) F102\nU9: 2026-08-01",...extra});
test('known male and female sharing a current cage count as breeding without a registered mating or fertility claim',()=>{
 const data=cohouse(dataset([{sex:'Male',date_of_birth:born(10)},{sex:'Female',date_of_birth:born(10)},{sex:'Unknown'}]),['SYN-0','SYN-1','SYN-2']),before=structuredClone(data),out=estimateBreedingGroups(data,{asOf});assert.equal(out.totalGroups,1);assert.equal(out.inferredOnlyGroups,1);assert.equal(out.registeredCount,0);assert.deepEqual(out.activeMouseSids,['SYN-0','SYN-1','SYN-2']);assert.equal(out.groups[0].fertility_confirmed,false);assert.equal(summarize(data,'active').total,3);assert.equal(summarize(data,'active').femaleFertile,0);assert.deepEqual(data,before);
});
test('registered rows match current cohabitation once, while separated and missing members do not inflate estimates',()=>{
 const data=cohouse(dataset([{sex:'Male'},{sex:'Female'},{sex:'Male'}],{matings:[{mating_sid:'R1',state:'Active',male_sids:['SYN-0'],female_sids:['SYN-1']},{mating_sid:'R2',state:'Active',male_sids:['SYN-0'],female_sids:['SYN-1']},{mating_sid:'STALE',state:'Active',male_sids:['SYN-2'],female_sids:['missing']}]}),['SYN-0','SYN-1']);const out=estimateBreedingGroups(data,{asOf});assert.equal(out.totalGroups,1);assert.equal(out.registeredCount,3);assert.equal(out.resolvedRegisteredCount,2);assert.deepEqual(out.groups[0].registered_mating_sids,['R1','R2']);assert.equal(out.unresolvedRegisteredGroups[0].mating_sid,'STALE');assert.equal(out.inferredOnlyGroups,0);assert.equal(summarize(data,'active').total,2);
});
test('ended, conflicting, archived, future-born and unassigned animals cannot establish current cohabitation',()=>{
 for(const change of [d=>d.tables.mice[1].state='Ended',d=>d.tables.mice[1].archived=true,d=>d.tables.mice[1].date_of_birth='2026-10-15',d=>d.tables.mice[1].end_date=asOf,d=>d.tables.mice[1].cage_sid=null,d=>d.tables.mice.push({...d.tables.mice[1],sex:'Male'}),d=>d.tables.cages[0].state='Inactive',d=>d.tables.cages[0].archived=true]){const d=cohouse(dataset([{sex:'Male'},{sex:'Female'}]),['SYN-0','SYN-1']);change(d);assert.equal(estimateBreedingGroups(d,{asOf}).totalGroups,0);}
});
test('Animal Sheet parser uses explicit animal-column sex suffixes, not Cre genotype F or unrelated comments',()=>{
 const good=classifyAnimalSheetBreedingBlock(sourcePosition());assert.equal(good.male,1);assert.equal(good.female,1);assert.equal(good.mixed,true);assert.ok(good.evidence.every(e=>!e.identity_confirmed));const bad=sourcePosition('L1',{source_block_text:"T7: B1\nT8: F\nT9: P\nU8: P M101\nU9: P F102\nT10: P F\nT11: sample from F3"});assert.equal(classifyAnimalSheetBreedingBlock(bad).mixed,false);const ended=sourcePosition();ended.source_block_text+='\nT8 comment: died';assert.equal(classifyAnimalSheetBreedingBlock(ended).male,0);
});

test('Animal Sheet animal suffixes accept the sex-number hyphen used in CAR-A1',()=>{
 const position={source_cell:'AW7',source_block_text:"AW7: CAR-A1\nAW8: B′ M-3107\nAW9: FPB′ M-3108\nAW10: B′ M-3109\nAX8: P F-9999\nAW11 comment: P F-9998"};
 const before=structuredClone(position),result=classifyAnimalSheetBreedingBlock(position);
 assert.equal(result.male,3);assert.equal(result.female,0);assert.equal(result.mixed,false);
 assert.deepEqual(result.evidence.map(row=>row.source_animal_number),['3107','3108','3109']);
 assert.ok(result.evidence.every(row=>row.identity_confirmed===false));assert.deepEqual(position,before);
 const pair=classifyAnimalSheetBreedingBlock({...position,source_block_text:"AW7: CAR-A1\nAW8: ADB′-M-1001\nAW9: ADFB′ F-1002\nAW10: sample F-1003"});
 assert.equal(pair.male,1);assert.equal(pair.female,1);assert.equal(pair.mixed,true);assert.equal(pair.unresolved.length,1);
});
test('current source-only positions count separately, historical or future maps do not count as current',()=>{
 const data=dataset([],{locations:[sourcePosition(),sourcePosition('OLD',{source_current:false}),sourcePosition('ARCHIVE',{record_origin:'source_layout'}),sourcePosition('FUTURE',{source_snapshot_date:'2026-10-15'})]});const out=estimateBreedingGroups(data,{asOf});assert.equal(out.totalGroups,1);assert.equal(out.currentCageCount,0);assert.equal(out.sourceEstimatedCount,1);assert.equal(out.activeMouseSids.length,0);assert.equal(out.sourceGroups[0].source_snapshot_date,asOf);
});
test('overlapping source positions and contradictory source occupants cannot double count linked cages',()=>{
 const data=cohouse(dataset([{sex:'Male'},{sex:'Female'}],{locations:[sourcePosition()]}),['SYN-0','SYN-1']);data.tables.cages[0].location_id='L1';let out=estimateBreedingGroups(data,{asOf});assert.equal(out.totalGroups,1);assert.equal(out.sourceOverlaps.length,1);assert.equal(out.sourceEstimatedCount,0);data.tables.mice[1].sex='Male';out=estimateBreedingGroups(data,{asOf});assert.equal(out.totalGroups,0);assert.equal(out.sourceConflicts.length,1);assert.equal(out.sourceEstimatedCount,0);
});
test('repeated animal tags across source positions and conflicting duplicate position records stay unresolved',()=>{
 const data=dataset([],{locations:[sourcePosition('L1'),sourcePosition('L2')]});let out=estimateBreedingGroups(data,{asOf});assert.equal(out.totalGroups,0);assert.equal(out.sourceConflicts.length,2);data.tables.locations=[sourcePosition('L1'),sourcePosition('L1',{source_block_text:'T8: P M5'})];out=estimateBreedingGroups(data,{asOf});assert.equal(out.totalGroups,0);assert.match(out.issues[0].kind,/conflicting_source_position/);
});
test('unconfirmed matching cage labels or animal numbers cannot add another current group',()=>{
 for(const source of [sourcePosition('L1',{label:'Current cage'}),sourcePosition('L1',{source_block_text:"T8: P' M1001\nT9: P F9000"})]){
  const data=dataset([{mouse_sid:'1001',sex:'Male'},{mouse_sid:'1002',sex:'Female'}],{locations:[source]});cohouse(data,['1001','1002']);data.tables.cages[0].cage_tag='Current cage';const out=estimateBreedingGroups(data,{asOf});assert.equal(out.totalGroups,1);assert.equal(out.sourceEstimatedCount,0);assert.equal(out.sourceConflicts.length,1);assert.equal(out.sourceConflicts[0].identity_confirmed,false);
 }
 const data=dataset([],{locations:[sourcePosition('L1',{source_block_text:"T8: P M1001\nT9: P F1002"}),sourcePosition('L2',{source_block_text:"T8: P' M1001\nT9: P F1003"})]});assert.equal(estimateBreedingGroups(data,{asOf}).totalGroups,0);
});
