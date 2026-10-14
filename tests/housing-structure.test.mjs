import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDataset,validateRecord} from '../web/model.js?v=7';

let instance=0;
const decode=value=>String(value??'').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const attribute=(text,key)=>decode(text.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1]??'');

async function harness(t,tables={},overrides={}) {
  const previous={document:globalThis.document,FormData:globalThis.FormData};
  const elements=new Map();
  function element(id='') {
    if(id&&elements.has(id))return elements.get(id);
    const value={id,value:'',textContent:'',open:false,hidden:false,disabled:false,_html:'',focus(){},setSelectionRange(){},showModal(){this.open=true},close(){this.open=false}};
    Object.defineProperty(value,'innerHTML',{get(){return this._html},set(html){
      this._html=html;
      for(const match of html.matchAll(/<(input|select|textarea|form|button|div)\b([^>]*\bid="[^"]+"[^>]*)>/g)){
        const [,tag,attrs]=match,node=element(attribute(attrs,'id'));node.name=attribute(attrs,'name');
        if(tag==='input')node.value=attribute(attrs,'value');
        if(tag==='select'){
          const content=html.slice(match.index+match[0].length).split('</select>')[0];node._html=content;
          const options=[...content.matchAll(/<option\b([^>]*)>/g)],chosen=options.find(option=>/\bselected\b/.test(option[1]))||options[0];node.value=chosen?attribute(chosen[1],'value'):'';
        }
        if(tag==='textarea')node.value=decode(html.slice(match.index+match[0].length).split('</textarea>')[0]);
      }
    }});
    if(id)elements.set(id,value);return value;
  }
  globalThis.document={getElementById:id=>elements.get(id)||null,createElement:()=>element(),body:{appendChild:node=>elements.set(node.id,node)}};
  globalThis.FormData=class {
    constructor(){this.values=new Map();const html=element('housing-dialog').innerHTML;for(const match of html.matchAll(/<(?:input|select|textarea)\b([^>]*\bname="[^"]+"[^>]*)>/g)){const attrs=match[1];this.values.set(attribute(attrs,'name'),element(attribute(attrs,'id')).value)}}
    get(name){return this.values.get(name)??null}
  };
  t.after(()=>{globalThis.document=previous.document;globalThis.FormData=previous.FormData});
  const {renderHousing}=await import(`../web/husbandry.js?structure-test=${++instance}`);
  const container=element('main'),saved=[],messages=[];
  let dataset=normalizeDataset({tables});
  const hooks={canEdit:()=>true,isCloud:()=>false,validate:validateRecord,confirm:async()=>true,toast:(message,error)=>messages.push({message,error}),save:async next=>{dataset=structuredClone(next);saved.push(dataset);renderHousing(container,dataset,hooks)},...overrides};
  renderHousing(container,dataset,hooks);
  const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve))};
  return {container,element,saved,messages,hooks,get dataset(){return dataset},
    async click(dataset){container.onclick({target:{closest:()=>({dataset})}});await settle()},
    change(id,value){const target=element(id);target.value=value;container.onchange({target})},
    async search(value){const target=element('housing-search');target.value=value;target.selectionStart=value.length;container.oninput({target});await new Promise(resolve=>setTimeout(resolve,220))},
    setField(name,value){element('housing-field-'+name).value=value},
    changeField(name,value){const target=element('housing-field-'+name);target.value=value;element('housing-form').onchange({target})},
    async submit(){element('housing-form').onsubmit({preventDefault(){}});await settle()},
    async archive(){element('housing-archive').onclick();await settle()}
  };
}
const room=(id,name)=>({room_id:id,name,record_origin:'app_created'});
const rack=(id,parent,name)=>({rack_id:id,room_id:parent,name,record_origin:'app_created'});
const sections=html=>[...html.matchAll(/<section class="panel housing-group"([^>]*)>([\s\S]*?)<\/section>/g)].map(match=>({room:attribute(match[1],'data-housing-room'),rack:attribute(match[1],'data-housing-rack'),html:match[2]}));

test('empty active rooms and racks are visible, filterable and searchable before cages exist',async t=>{
  const h=await harness(t,{rooms:[room('R1','North room'),room('R2','South room'),{...room('R3','Archived room'),app_archived_at:'2026-01-01'}],racks:[rack('K1','R1','Blue rack')]});
  assert.deepEqual(sections(h.container.innerHTML).map(s=>[s.room,s.rack]),[['R1','K1'],['R2','']]);
  assert.match(h.container.innerHTML,/No positions or cages in this rack/);
  assert.match(h.container.innerHTML,/No racks or positions yet/);
  h.change('housing-room','R2');assert.deepEqual(sections(h.container.innerHTML).map(s=>s.room),['R2']);
  h.change('housing-room','');h.change('housing-rack','K1');assert.deepEqual(sections(h.container.innerHTML).map(s=>s.rack),['K1']);
  h.change('housing-rack','');await h.search('south room');assert.deepEqual(sections(h.container.innerHTML).map(s=>s.room),['R2']);
  await h.search('blue rack');assert.deepEqual(sections(h.container.innerHTML).map(s=>s.rack),['K1']);
  await h.search('absent');assert.equal(sections(h.container.innerHTML).length,0);assert.match(h.container.innerHTML,/No rooms, racks or cages match/);
});

test('contextual room to rack to position creation keeps generated IDs and creates available empty positions',async t=>{
  const h=await harness(t);
  await h.click({housingAction:'new',type:'rooms'});
  const roomID=h.element('housing-field-room_id').value;
  assert(roomID);assert.match(h.element('housing-dialog').innerHTML,/id="housing-field-room_id" readonly/);
  assert(h.element('housing-dialog').innerHTML.indexOf('housing-field-name')<h.element('housing-dialog').innerHTML.indexOf('<summary>Record ID</summary>'));
  h.setField('name','New room');await h.submit();
  assert.equal(h.saved.length,1);assert.equal(h.dataset.tables.rooms[0].room_id,roomID);
  assert.deepEqual(sections(h.container.innerHTML).map(s=>s.room),[roomID]);
  await h.click({housingAction:'new',type:'racks',room:roomID});
  assert.equal(h.element('housing-field-room_id').value,roomID);
  const rackID=h.element('housing-field-rack_id').value;h.setField('name','New rack');await h.submit();
  assert.equal(h.saved.length,2);assert.equal(h.dataset.tables.racks[0].rack_id,rackID);
  assert.deepEqual(sections(h.container.innerHTML).map(s=>[s.room,s.rack]),[[roomID,rackID]]);
  await h.click({housingAction:'new',type:'locations',room:roomID,rack:rackID});
  assert.equal(h.element('housing-field-room_id').value,roomID);assert.equal(h.element('housing-field-rack_id').value,rackID);
  const positionID=h.element('housing-field-location_id').value;h.setField('label','A1');await h.submit();
  assert.equal(h.saved.length,3);assert.equal(h.dataset.tables.locations[0].location_id,positionID);
  assert.match(h.container.innerHTML,/>Empty<\/span>/);assert.match(h.container.innerHTML,/Available for a cage/);
  assert.doesNotMatch(h.container.innerHTML,/Source-listed animals|>Unlinked<\/span>/);
  assert.equal(h.element('housing-dialog').open,false);
});

test('selected parents prefill new records and room changes clear incompatible rack choices',async t=>{
  const h=await harness(t,{rooms:[room('R1','First room'),room('R2','Second room')],racks:[rack('K1','R1','First rack'),rack('K2','R2','Second rack')]});
  h.change('housing-room','R1');h.change('housing-rack','K1');
  await h.click({housingAction:'new',type:'locations'});
  assert.equal(h.element('housing-field-room_id').value,'R1');assert.equal(h.element('housing-field-rack_id').value,'K1');
  assert.match(h.element('housing-field-rack_id').innerHTML,/First rack/);assert.doesNotMatch(h.element('housing-field-rack_id').innerHTML,/Second rack/);
  h.changeField('room_id','R2');
  assert.equal(h.element('housing-field-rack_id').value,'');assert.match(h.element('housing-field-rack_id').innerHTML,/Second rack/);assert.doesNotMatch(h.element('housing-field-rack_id').innerHTML,/First rack/);
  h.changeField('room_id','');assert.equal(h.element('housing-field-rack_id').value,'');assert.match(h.element('housing-field-rack_id').innerHTML,/Choose a room first/);
});

test('editing imported positions retains source evidence and does not label them as new empty space',async t=>{
  const source={location_id:'P-SOURCE',room_id:'R1',rack_id:'K1',label:'Source A1',record_origin:'source_layout',source_block_text:'A1: M12',source_title:'Synthetic historical map',source_cell:'A1'};
  const h=await harness(t,{rooms:[room('R1','Room')],racks:[rack('K1','R1','Rack')],locations:[source]});
  assert.match(h.container.innerHTML,/>Unlinked<\/span>/);assert.match(h.container.innerHTML,/Source-listed animals/);assert.match(h.container.innerHTML,/Synthetic historical map/);
  await h.click({housingEdit:'P-SOURCE',type:'locations'});h.setField('label','Reviewed A1');await h.submit();
  assert.equal(h.saved.length,1);const result=h.dataset.tables.locations[0];
  for(const key of ['location_id','record_origin','source_block_text','source_title','source_cell'])assert.equal(result[key],source[key]);
  assert.match(h.container.innerHTML,/>Unlinked<\/span>/);assert.doesNotMatch(h.container.innerHTML,/Available for a cage/);
});

test('room archival validates dependencies before saving and keeps the editor open on rejection',async t=>{
  const checked=[];
  const h=await harness(t,{rooms:[room('R1','Referenced room')],racks:[rack('K1','R1','Active rack')]},{validate:(type,record,dataset,id)=>{checked.push({type,record,id});return {errors:record.app_archived_at?['Move or archive active dependents first.']:[],warnings:[]}}});
  await h.click({housingEdit:'R1',type:'rooms'});await h.archive();
  assert.equal(checked.length,1);assert.equal(checked[0].type,'rooms');assert.equal(checked[0].id,'R1');assert(checked[0].record.app_archived_at);
  assert.equal(h.saved.length,0);assert.equal(h.element('housing-dialog').open,true);assert.match(h.element('housing-errors').textContent,/active dependents/);
});

test('read-only empty hierarchy groups retain context but never offer contextual creation',async t=>{
  const h=await harness(t,{rooms:[room('R1','Read room'),room('R2','Empty room')],racks:[rack('K1','R1','Read rack')]},{canEdit:()=>false});
  assert.equal(sections(h.container.innerHTML).length,2);assert.doesNotMatch(h.container.innerHTML,/Add rack here|data-housing-action="new"|Add position/);
});

test('linking a cage saves dated From and To snapshots in the same update and displays them in history',async t=>{
  const h=await harness(t,{
    rooms:[room('R1','North room'),room('R2','South room')],racks:[rack('K1','R1','Rack A'),rack('K2','R2','Rack B')],
    locations:[{location_id:'P1',room_id:'R1',rack_id:'K1',label:'A1',record_origin:'app_created'},{location_id:'P2',room_id:'R2',rack_id:'K2',label:'B1',record_origin:'app_created'}],
    cages:[{cage_sid:'C1',cage_tag:'Test cage',manager:'Synthetic caretaker',state:'Active',room_id:'R1',rack_id:'K1',location_id:'P1'}]
  });
  h.hooks.confirm=async(title,html)=>{
    h.element('confirmation').innerHTML=html;
    h.element('link-position-cage').value='C1';h.element('link-position-date').value='2026-10-14';h.element('link-position-notes').value='Scheduled cage relocation';return true;
  };
  await h.click({housingLinkPosition:'P2'});
  assert.equal(h.saved.length,1);assert.equal(h.dataset.tables.cages[0].location_id,'P2');
  const event=h.dataset.tables.husbandry_events[0];
  assert.equal(event.event_type,'cage_location_assignment');assert.equal(event.event_date,'2026-10-14');
  assert.equal(event.old_location_label,'North room / Rack A / A1');assert.equal(event.location_label,'South room / Rack B / B1');
  h.dataset.tables.rooms[0].name='Renamed current room';
  await h.click({housingTab:'husbandry_events'});
  assert.match(h.container.innerHTML,/>From<\/th>/);assert.match(h.container.innerHTML,/>To<\/th>/);
  assert.match(h.container.innerHTML,/North room \/ Rack A \/ A1/);assert.match(h.container.innerHTML,/South room \/ Rack B \/ B1/);
  assert.doesNotMatch(h.container.innerHTML,/Renamed current room/,'history shows saved labels, not current names');
});

test('positions linked to inactive empty cages remain visible without being called available',async t=>{
  const h=await harness(t,{
    rooms:[room('R1','North room')],racks:[rack('K1','R1','Rack A')],
    locations:[{location_id:'P1',room_id:'R1',rack_id:'K1',label:'Distinct position',record_origin:'app_created'}],
    cages:[{cage_sid:'C1',cage_tag:'Inactive recorded cage',state:'Inactive',location_id:'P1'}]
  });
  const placeholder=h.container.innerHTML.match(/<article class="cage-card inactive-position-card">([\s\S]*?)<\/article>/)?.[1];
  assert(placeholder);assert.match(placeholder,/Distinct position/);assert.match(placeholder,/>Inactive cage<\/span>/);assert.match(placeholder,/data-housing-cage="C1"/);
  assert.doesNotMatch(placeholder,/Available for a cage|>Empty<|>Unlinked<|data-housing-link-position/);
  assert.doesNotMatch(h.container.innerHTML,/No positions or cages in this rack/);
  await h.search('Distinct position');assert.match(h.container.innerHTML,/inactive-position-card/);
  h.container.onchange({target:{id:'housing-active',checked:false}});
  assert.doesNotMatch(h.container.innerHTML,/inactive-position-card/);assert.match(h.container.innerHTML,/data-housing-cage="C1"/);
});

test('assignment history allows date and notes correction without altering its saved housing snapshot',async t=>{
  const original={event_id:'E1',record_origin:'app_created',event_type:'cage_location_assignment',cage_sid:'C1',location_id:'P1',room_id:'R1',rack_id:'K1',location_label:'North room / Rack A / A1',old_location_label:'Previous room / Previous rack / A2',old_room_id:null,old_rack_id:null,old_location_id:null,event_date:'2026-10-01',notes:'Original note'};
  const h=await harness(t,{
    rooms:[room('R1','North room')],racks:[rack('K1','R1','Rack A')],
    locations:[{location_id:'P1',room_id:'R1',rack_id:'K1',label:'A1',record_origin:'app_created'}],
    cages:[{cage_sid:'C1',state:'Active'}],husbandry_events:[original]
  });
  await h.click({housingEdit:'E1',type:'husbandry_events'});
  const html=h.element('housing-dialog').innerHTML;
  for(const field of ['cage_sid','location_id','event_type'])assert.match(html,new RegExp(`id="housing-field-${field}" readonly`));
  assert.doesNotMatch(html,/<select[^>]*id="housing-field-location_id"/);
  h.setField('event_date','2026-10-02');h.setField('notes','Corrected note');h.setField('location_id','FORGED');h.setField('event_type','FORGED');
  await h.submit();assert.equal(h.saved.length,1);
  const result=h.dataset.tables.husbandry_events[0];
  assert.equal(result.event_date,'2026-10-02');assert.equal(result.notes,'Corrected note');
  for(const field of ['cage_sid','location_id','event_type','location_label','old_location_label'])assert.equal(result[field],original[field]);
});

test('legacy archived flags exclude hierarchy choices while existing historical references remain selected',async t=>{
  const h=await harness(t,{
    rooms:[room('R1','Active room'),{...room('R2','Archived room'),archived:true}],
    racks:[{...rack('K2','R2','Archived rack'),archived:true}],
    locations:[{location_id:'P2',room_id:'R2',rack_id:'K2',label:'Archived position',record_origin:'source_layout',archived:true}]
  });
  assert.deepEqual(sections(h.container.innerHTML).map(s=>[s.room,s.rack]),[['R1','']]);
  assert.doesNotMatch(h.element('housing-room').innerHTML,/Archived room/);
  await h.click({housingEdit:'P2',type:'locations'});
  assert.equal(h.element('housing-field-room_id').value,'R2');assert.equal(h.element('housing-field-rack_id').value,'K2');
  assert.equal(h.dataset.tables.locations[0].archived,true);
});
