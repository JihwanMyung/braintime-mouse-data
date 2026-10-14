import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BREEDING_OPTIONS, getBreedingOptions, getBreedingOptionsStatus, validateBreedingOptions, buildBreedingOptions, renderBreedingOptions } from '../web/breeding-options.js';

const empty=()=>({tables:{mice:[{mouse_sid:'SYNTHETIC-1'}],husbandry_events:[{event_id:'OTHER',event_type:'note',notes:'Keep me'}]}});
const clock={now:'2025-03-05T09:00:00Z',eventDate:'2025-03-05'};
const make=(extra={},dataset=empty())=>buildBreedingOptions(dataset,{...DEFAULT_BREEDING_OPTIONS,...extra},clock);

test('age windows default independently by sex and cannot mutate shared defaults',()=>{
  assert.deepEqual(getBreedingOptions(empty()),{schema_version:1,male_min_weeks:8,male_max_weeks:52,female_min_weeks:8,female_max_weeks:32});
  assert.equal(getBreedingOptionsStatus(empty()),'default');assert.equal(getBreedingOptionsStatus(null),'default');
  const options=getBreedingOptions(null);options.male_min_weeks=10;
  assert.equal(getBreedingOptions(empty()).male_min_weeks,8);assert.equal(DEFAULT_BREEDING_OPTIONS.male_min_weeks,8);
});

test('upsert is immutable, preserves metadata and unrelated data, and persists independent windows',()=>{
  const original=empty(),before=structuredClone(original),first=make({male_min_weeks:9.5,female_max_weeks:40},original);
  assert.deepEqual(original,before);assert.deepEqual(first.dataset.tables.mice,before.tables.mice);
  assert.deepEqual(first.dataset.tables.husbandry_events[0],before.tables.husbandry_events[0]);
  assert.equal(first.record.event_id,'BREEDING-OPTIONS');assert.equal(first.record.event_type,'breeding_options');assert.equal(first.record.event_date,clock.eventDate);
  first.record.source_file='preserve provenance';first.record.breeding_options.extra_metadata='keep';
  const second=buildBreedingOptions(first.dataset,{...getBreedingOptions(first.dataset),male_max_weeks:55},{now:'2025-03-06T09:00:00Z',eventDate:'2025-03-06'});
  assert.equal(second.dataset.tables.husbandry_events.length,2);assert.equal(second.record.app_created_at,first.record.app_created_at);assert.notEqual(second.record.app_modified_at,first.record.app_modified_at);
  assert.equal(second.record.source_file,'preserve provenance');assert.equal(second.record.breeding_options.extra_metadata,'keep');
  assert.equal(first.record.breeding_options.male_max_weeks,52);
  assert.deepEqual(getBreedingOptions(second.dataset),{schema_version:1,male_min_weeks:9.5,male_max_weeks:55,female_min_weeks:8,female_max_weeks:40});
});

test('range validation rejects missing, nonnumeric, zero, negative, reversed and excessive limits',()=>{
  for(const field of ['male_min_weeks','male_max_weeks','female_min_weeks','female_max_weeks']) {
    for(const value of [undefined,null,'8',NaN,Infinity,-1,0,261])assert.throws(()=>make({[field]:value}),/ages must be numbers/);
  }
  assert.throws(()=>make({male_min_weeks:53}),/Male minimum age/);
  assert.throws(()=>make({female_min_weeks:33}),/Female minimum age/);
  assert.equal(make({male_min_weeks:52}).record.breeding_options.male_min_weeks,52);
  assert.equal(make({female_max_weeks:260}).record.breeding_options.female_max_weeks,260);
});

test('validation retains event identity and rejects malformed schema and dates',()=>{
  const old=make().record;
  assert.deepEqual(validateBreedingOptions({event_type:'unrelated'}),[]);
  assert.match(validateBreedingOptions({...old,event_type:'note'},old).join(' '),/retain/);
  assert.match(validateBreedingOptions({...old,event_id:'OTHER'},old).join(' '),/stable.*ID.*cannot change/);
  assert.match(validateBreedingOptions({...old,breeding_options:null}).join(' '),/required/);
  assert.match(validateBreedingOptions({...old,breeding_options:{...old.breeding_options,schema_version:2}}).join(' '),/version/);
  assert.throws(()=>buildBreedingOptions(empty(),DEFAULT_BREEDING_OPTIONS,{eventDate:'2025-02-29'}),/valid breeding-options date/);
  assert.throws(()=>buildBreedingOptions(empty(),DEFAULT_BREEDING_OPTIONS,{now:'invalid'}),/valid modification time/);
});

test('invalid, duplicate and archived records fall back safely and cannot be silently overwritten',()=>{
  const saved=make({male_max_weeks:60}).record;
  for(const [rows,pattern] of [
    [[{event_id:'BREEDING-OPTIONS',event_type:'note'}],/already used/],
    [[saved,structuredClone(saved)],/Duplicate/],
    [[{...saved,event_id:'OTHER'}],/stable BREEDING-OPTIONS ID/],
    [[{...saved,app_archived_at:'2025-03-06'}],/archived/],
    [[{...saved,archived:true}],/archived/]
  ]){
    const dataset={tables:{husbandry_events:rows}};
    assert.deepEqual(getBreedingOptions(dataset),DEFAULT_BREEDING_OPTIONS);
    assert.equal(getBreedingOptionsStatus(dataset),'invalid');
    assert.throws(()=>make({},dataset),pattern);
  }
  assert.equal(getBreedingOptions({tables:{husbandry_events:[saved]}}).male_max_weeks,60);
  assert.equal(getBreedingOptionsStatus({tables:{husbandry_events:[saved]}}),'saved');
  assert.deepEqual(getBreedingOptions({tables:{husbandry_events:[{...saved,event_date:'2025-02-31'}]}}),DEFAULT_BREEDING_OPTIONS);
});

test('saved option status flags malformed dates, schemas and ranges rather than treating them as absent',()=>{
  const saved=make().record;
  for(const changed of [
    {...saved,event_date:'2025-02-31'},
    {...saved,breeding_options:null},
    {...saved,breeding_options:{...saved.breeding_options,schema_version:2}},
    {...saved,breeding_options:{...saved.breeding_options,male_min_weeks:53}}
  ])assert.equal(getBreedingOptionsStatus({tables:{husbandry_events:[changed]}}),'invalid');
});

function harness(overrides={},initial=empty()) {
  const container={innerHTML:''},saves=[],messages=[];let dataset=initial;
  const hooks={canEdit:()=>true,saveDataset:async next=>{saves.push(structuredClone(next));dataset=next},reloadDataset:async()=>dataset,toast:(message,error=false)=>messages.push({message,error}),...overrides};
  renderBreedingOptions(container,dataset,hooks);
  return {container,hooks,saves,messages,get dataset(){return dataset},
    field(field,value){container.oninput({target:{value,dataset:{breedingOption:field}}})},
    async save(){let prevented=false;await container.onsubmit({target:{matches:selector=>selector==='[data-breeding-options-form]'},preventDefault(){prevented=true}});assert.ok(prevented)},
    defaults(){container.onclick({target:{closest:()=>({disabled:false,dataset:{breedingOptionsAction:'defaults'}})}})},
    render(next=dataset){dataset=next;renderBreedingOptions(container,dataset,hooks)}
  };
}

test('form submission saves options through the shared dataset and survives reopening',async()=>{
  const h=harness();assert.match(h.container.innerHTML,/data-breeding-options-form novalidate/);assert.match(h.container.innerHTML,/type="submit"/);
  assert.match(h.container.innerHTML,/type="submit" class="button primary"/);
  h.field('male_min_weeks','10');h.field('female_max_weeks','36');await h.save();
  assert.equal(h.saves.length,1);assert.deepEqual(h.dataset.tables.mice,[{mouse_sid:'SYNTHETIC-1'}]);assert.equal(h.dataset.tables.husbandry_events[0].notes,'Keep me');
  assert.equal(getBreedingOptions(h.dataset).male_min_weeks,10);assert.equal(getBreedingOptions(h.dataset).female_max_weeks,36);assert.match(h.container.innerHTML,/Breeding age options saved/);
  const reopened={innerHTML:''};renderBreedingOptions(reopened,structuredClone(h.dataset),h.hooks);
  assert.match(reopened.innerHTML,/name="male_min_weeks" value="10"/);assert.match(reopened.innerHTML,/name="female_max_weeks" value="36"/);
});

test('invalid saved options show a visible fallback alert for editors and read-only users',()=>{
  const saved=make().record;
  for(const rows of [[saved,saved],[{...saved,archived:true}],[{event_id:'BREEDING-OPTIONS',event_type:'note'}]]) {
    const dataset={tables:{husbandry_events:rows}};
    for(const editable of [true,false]){
      const h=harness({canEdit:()=>editable},dataset);
      assert.match(h.container.innerHTML,/role="alert">Saved age options could not be used\. Default ranges are shown\./);
    }
  }
  for(const dataset of [empty(),make().dataset])assert.doesNotMatch(harness({},dataset).container.innerHTML,/Saved age options could not be used/);
});

test('restore defaults changes the form only until Save is submitted',async()=>{
  const h=harness({},make({male_max_weeks:60,female_min_weeks:10}).dataset);
  h.defaults();assert.equal(h.saves.length,0);assert.equal(getBreedingOptions(h.dataset).male_max_weeks,60);assert.match(h.container.innerHTML,/value="52"/);assert.match(h.container.innerHTML,/Save options to apply/);
  await h.save();assert.equal(h.saves.length,1);assert.deepEqual(getBreedingOptions(h.dataset),DEFAULT_BREEDING_OPTIONS);
});

test('read-only users cannot edit or forge a submission and permission revocation blocks saves',async()=>{
  const readonly=harness({canEdit:()=>false});assert.match(readonly.container.innerHTML,/Read only/);assert.doesNotMatch(readonly.container.innerHTML,/<input|<form|Restore defaults/);
  readonly.field('male_min_weeks','10');readonly.defaults();await readonly.save();assert.equal(readonly.saves.length,0);assert.match(readonly.container.innerHTML,/Edit access is required/);
  let editable=true;const revoked=harness({canEdit:()=>editable,reloadDataset:async()=>{editable=false;return empty()}});
  revoked.field('male_max_weeks','60');await revoked.save();assert.equal(revoked.saves.length,0);assert.match(revoked.container.innerHTML,/Edit access is required/);
});

test('stale options are rejected, while unrelated concurrent data remains in the save',async()=>{
  const h=harness();h.field('male_max_weeks','60');h.hooks.reloadDataset=async()=>make({female_max_weeks:36}).dataset;
  await h.save();assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/changed while you were editing/);assert.match(h.container.innerHTML,/name="male_max_weeks" value="60"/);
  const safe=harness();safe.field('male_min_weeks','10');const latest=empty();latest.tables.mice.push({mouse_sid:'SYNTHETIC-2'});safe.hooks.reloadDataset=async()=>latest;
  await safe.save();assert.equal(safe.saves.length,1);assert.equal(safe.saves[0].tables.mice.length,2);
});

test('invalid input and network failures retain drafts and escape error content',async()=>{
  let reloads=0;const h=harness({reloadDataset:async()=>{reloads++;return empty()}});
  h.field('male_min_weeks','');await h.save();assert.equal(h.saves.length,0);assert.equal(reloads,0);assert.match(h.container.innerHTML,/Male ages must be numbers/);
  h.field('male_min_weeks','9');h.hooks.saveDataset=async()=>{throw new Error('<script>Network failed</script>')};await h.save();
  assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/name="male_min_weeks" value="9"/);assert.match(h.container.innerHTML,/&lt;script&gt;Network failed&lt;\/script&gt;/);assert.doesNotMatch(h.container.innerHTML,/<script>|aria-busy="true"/);
});

test('a pending submission prevents duplicate saves and ignores edits until completion',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve});let saves=0;
  const h=harness({saveDataset:async()=>{saves++;await pending}});h.field('male_min_weeks','10');const saving=h.save();
  await new Promise(resolve=>setImmediate(resolve));assert.match(h.container.innerHTML,/aria-busy="true"/);await h.save();h.field('male_min_weeks','11');h.defaults();
  finish();await saving;assert.equal(saves,1);assert.match(h.container.innerHTML,/name="male_min_weeks" value="10"/);
});
