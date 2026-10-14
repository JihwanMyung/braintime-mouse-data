import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStrainManagement } from '../web/strain-management.js';
import { buildStrainDefinition, getStrainRegistry } from '../web/strain-registry.js';

const empty=()=>({tables:{mice:[{mouse_sid:'SYNTHETIC-1'}],husbandry_events:[]}});
function harness(overrides={}) {
  const container={innerHTML:''},saves=[],messages=[];let dataset=empty();
  const hooks={canEdit:()=>true,saveDataset:async next=>{saves.push(structuredClone(next));dataset=next},reloadDataset:async()=>dataset,toast:(message,error=false)=>messages.push({message,error}),...overrides};
  renderStrainManagement(container,dataset,hooks);
  return {container,hooks,saves,messages,get dataset(){return dataset},
    field(code,field,value){container.oninput({target:{value,dataset:{strainCode:code,strainField:field}}})},
    async save(code){await container.onclick({target:{closest:()=>({disabled:false,dataset:{strainAction:'save',strainCode:code}})}})},
    render(next=dataset){dataset=next;renderStrainManagement(container,dataset,hooks)}
  };
}

test('edit persists through dataset reload and preserves other colony records',async()=>{
  const h=harness();assert.match(h.container.innerHTML,/Strain registry/);assert.match(h.container.innerHTML,/Save P/);
  h.field('P','insertion_type','unknown');h.field('P','stock_reference','Synthetic recheck');h.field('P','notes','Need confirmation');await h.save('P');
  assert.equal(h.saves.length,1);assert.deepEqual(h.dataset.tables.mice,[{mouse_sid:'SYNTHETIC-1'}]);
  assert.equal(getStrainRegistry(h.dataset)[0].insertionType,'unknown');assert.match(h.container.innerHTML,/P strain definition saved/);
  const reopened={innerHTML:''};renderStrainManagement(reopened,structuredClone(h.dataset),h.hooks);assert.match(reopened.innerHTML,/Synthetic recheck/);assert.match(reopened.innerHTML,/Need confirmation/);
});

test('read-only controls and forged save events cannot change the registry',async()=>{
  const h=harness({canEdit:()=>false});assert.match(h.container.innerHTML,/Read only/);assert.doesNotMatch(h.container.innerHTML,/<input|<textarea|<select|data-strain-action="save"/);
  h.field('P','notes','Unauthorized');await h.save('P');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Edit access is required/);
});

test('permission revocation during refresh blocks a save',async()=>{
  let editable=true;const h=harness({canEdit:()=>editable,reloadDataset:async()=>{editable=false;return empty()}});
  h.field('P','notes','Draft');await h.save('P');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Edit access is required/);
});

test('concurrent strain edits are rejected, while unrelated new data is retained',async()=>{
  const h=harness();h.field('P','notes','Local draft');
  const concurrent=buildStrainDefinition(empty(),{code:'P',insertion_type:'knock_in',stock_reference:'Concurrent stock',notes:'External edit'}).dataset;
  h.hooks.reloadDataset=async()=>concurrent;await h.save('P');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/changed while you were editing/);assert.match(h.container.innerHTML,/Local draft/);
  const other=harness();other.field('P','notes','Safe draft');other.hooks.reloadDataset=async()=>({tables:{mice:[{mouse_sid:'SYNTHETIC-2'}],husbandry_events:[]}});await other.save('P');assert.equal(other.saves.length,1);assert.equal(other.saves[0].tables.mice[0].mouse_sid,'SYNTHETIC-2');
});

test('failed saves preserve drafts and escape untrusted stock and note text',async()=>{
  const h=harness({saveDataset:async()=>{throw new Error('<script>Network failed</script>')}});
  h.field('P','stock_reference','" onfocus="alert(1)');h.field('P','notes','</textarea><script>bad</script>');await h.save('P');
  assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/&lt;script&gt;Network failed&lt;\/script&gt;/);assert.match(h.container.innerHTML,/&lt;\/textarea&gt;&lt;script&gt;bad&lt;\/script&gt;/);assert.match(h.container.innerHTML,/&quot; onfocus=&quot;alert\(1\)/);assert.doesNotMatch(h.container.innerHTML,/<script>|aria-busy="true"/);
});

test('unknown fields cannot alter codes or canonical names and invalid insertion type is rejected',async()=>{
  const h=harness();h.field('P','name','Wrong');h.field('P','code','E');h.field('P','insertion_type','bogus');await h.save('P');assert.equal(h.saves.length,0);assert.match(h.container.innerHTML,/Choose Unknown, Transgenic or Knock-in/);
  h.field('P','insertion_type','knock_in');await h.save('P');assert.equal(h.saves.length,1);assert.equal(h.saves[0].tables.husbandry_events[0].strain_definition.name,'PER2::LUC');
});
