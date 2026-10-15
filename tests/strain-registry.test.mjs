import test from 'node:test';
import assert from 'node:assert/strict';
import { STRAIN_ACRONYMS, INSERTION_TYPES, getStrainRegistry, validateStrainDefinition, buildStrainDefinition, canonicalStrainName, strainNamingHelpHTML } from '../web/strain-registry.js';

const empty=()=>({tables:{mice:[{mouse_sid:'SYNTHETIC-1'}],husbandry_events:[]}});
const input=(code='P',extra={})=>({code,insertion_type:'knock_in',stock_reference:'Synthetic stock',notes:'Reviewed synthetic definition',...extra});
const clock={now:'2025-03-05T09:00:00Z',eventDate:'2025-03-05'};
const make=(code='P',extra={},dataset=empty())=>buildStrainDefinition(dataset,input(code,extra),clock);

test('strain guide documents corrected names without inventing a Meis1 acronym or modifying Cre variants',()=>{
  for(const gene of ['Bmal1','Meis1','Vgat'])assert.equal(canonicalStrainName(gene),gene+'-flox');
  assert.equal(canonicalStrainName('FoxJ-Cre'),'FoxJ1-Cre');assert.equal(canonicalStrainName('Vgat-Cre'),'Vgat-flox');assert.equal(canonicalStrainName('FoxJ-CreERT2'),'FoxJ-CreERT2');
  assert.equal(STRAIN_ACRONYMS.some(row=>row.key==='M'||row.name==='Meis1-flox'),false);assert.match(strainNamingHelpHTML(),/Meis1-flox has no confirmed shorthand/);assert.match(strainNamingHelpHTML(),/Vgat-CRE is a legacy lab name/);
  const old=make('F').record;old.strain_definition.name='Foxj1-Cre';assert.deepEqual(validateStrainDefinition(old),[]);assert.equal(getStrainRegistry({tables:{husbandry_events:[old]}}).find(row=>row.key==='F').name,'FoxJ1-Cre');
});

test('registry preserves confirmed acronyms and separates unknown insertion types',()=>{
  const rows=getStrainRegistry(empty()),byCode=Object.fromEntries(rows.map(row=>[row.key,row]));
  assert.deepEqual(rows.map(row=>row.key),['P','E','B','F','V','AD','A','32','Vg','Gt','96']);
  assert.equal(byCode.P.name,'PER2::LUC');assert.equal(byCode.E.name,'Bmal1-ELuc');
  assert.equal(byCode.E.insertionType,'transgenic');
  for(const code of ['P','B','F','V'])assert.equal(byCode[code].insertionType,'knock_in');
  for(const code of ['A','32','Vg','Gt','96'])assert.equal(byCode[code].insertionType,'unknown');
  assert.equal(byCode.AD.insertionType,'transgenic');assert.match(byCode.AD.stockReference,/005864.*85Dbo/);assert.match(byCode.AD.notes,/MGI:3524957/);
  assert.deepEqual(INSERTION_TYPES.map(row=>row.value),['unknown','transgenic','knock_in']);
  rows[0].name='Changed locally';assert.equal(STRAIN_ACRONYMS[0].name,'PER2::LUC');assert.equal(getStrainRegistry(empty())[0].name,'PER2::LUC');
});

test('definition upsert is immutable, keeps stable ID and creation time, and preserves unrelated data',()=>{
  const original=empty(),before=structuredClone(original),first=make('P',{},original);
  assert.deepEqual(original,before);assert.deepEqual(first.dataset.tables.mice,before.tables.mice);
  assert.equal(first.record.event_id,'STRAIN-P');assert.equal(first.record.event_type,'strain_definition');assert.equal(first.record.event_date,'2025-03-05');
  assert.equal(first.record.app_created_at,clock.now.replace('Z','.000Z'));
  const second=buildStrainDefinition(first.dataset,input('P',{insertion_type:'unknown',notes:'Recheck local stock'}),{now:'2025-03-06T02:00:00Z',eventDate:'2025-03-06'});
  assert.equal(second.dataset.tables.husbandry_events.length,1);assert.equal(second.record.app_created_at,first.record.app_created_at);assert.notEqual(second.record.app_modified_at,first.record.app_modified_at);
  assert.equal(first.record.strain_definition.insertion_type,'knock_in');
  const row=getStrainRegistry(second.dataset)[0];assert.equal(row.insertionType,'unknown');assert.equal(row.notes,'Recheck local stock');assert.equal(row.stockReference,'Synthetic stock');assert.equal(row.origin,'Colony strain registry');
});

test('invalid and archived definitions cannot silently override verified defaults',()=>{
  const record=make('P',{insertion_type:'transgenic'}).record;
  for(const changed of [
    {...record,event_id:'OTHER'},
    {...record,event_date:'2025-02-31'},
    {...record,strain_definition:{...record.strain_definition,insertion_type:'anything'}},
    {...record,strain_definition:{...record.strain_definition,name:'Wrong name'}},
    {...record,strain_definition:{...record.strain_definition,schema_version:2}},
    {...record,app_archived_at:'2025-03-10T00:00:00Z'},
    {...record,archived:true}
  ])assert.equal(getStrainRegistry({tables:{husbandry_events:[changed]}})[0].insertionType,'knock_in');
  assert.equal(getStrainRegistry({tables:{husbandry_events:[record]}})[0].insertionType,'transgenic');
});

test('validation covers type retention, known codes, ID stability and malformed metadata',()=>{
  const old=make().record;
  assert.deepEqual(validateStrainDefinition({event_type:'unrelated'}),[]);
  assert.match(validateStrainDefinition({...old,event_type:'note'},old).join(' '),/retain/);
  assert.match(validateStrainDefinition({...old,strain_definition:null}).join(' '),/required/);
  for(const value of [null,42,{},'x'.repeat(501)])assert.throws(()=>make('P',{stock_reference:value}),/Stock reference/);
  for(const value of [null,42,{},'x'.repeat(2001)])assert.throws(()=>make('P',{notes:value}),/Strain notes/);
  assert.throws(()=>make('M'),/Animal Sheet legend/);
  assert.throws(()=>make('P',{insertion_type:'__proto__'}),/Unknown, Transgenic or Knock-in/);
  assert.match(validateStrainDefinition(make('E',{insertion_type:'transgenic'}).record,old).join(' '),/saved strain code cannot change/);
  assert.throws(()=>buildStrainDefinition(empty(),input(),{eventDate:'2025-02-29'}),/valid strain-definition date/);
  assert.throws(()=>buildStrainDefinition(empty(),input(),{now:'invalid'}),/valid modification time/);
});

test('upsert does not overwrite collisions, duplicates or archived records',()=>{
  const record=make().record;
  for(const [rows,pattern] of [
    [[{event_id:'STRAIN-P',event_type:'other'}],/already used/],
    [[record,structuredClone(record)],/Duplicate/],
    [[{...record,app_archived_at:'2025-04-01'}],/archived/]
  ])assert.throws(()=>make('P',{}, {tables:{husbandry_events:rows}}),pattern);
});
