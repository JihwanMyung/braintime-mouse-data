import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const ids={owner:'11111111-1111-4111-8111-111111111111',low:'22222222-2222-4222-8222-222222222222',high:'33333333-3333-4333-8333-333333333333',max:'44444444-4444-4444-8444-444444444444',outsider:'55555555-5555-4555-8555-555555555555',colony:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',foreign:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
for(const file of ['schema.sql','functions/manage-colony-users/membership.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
for(const id of ['owner','low','high','max','outsider'])await db.query('insert into auth.users values($1)',[ids[id]]);
await db.query('insert into public.colonies(id,name,created_by)values($1,$2,$3),($4,$5,$6)',[ids.colony,'Synthetic lab',ids.owner,ids.foreign,'Other lab',ids.outsider]);
for(const [who,role]of [['owner','owner'],['low','viewer'],['high','editor'],['max','viewer']])await db.query('insert into public.memberships(colony_id,user_id,role)values($1,$2,$3)',[ids.colony,ids[who],role]);
const migration=await readFile(new URL('../export-permissions.sql',import.meta.url),'utf8');await db.exec(migration);
const as=async(who,fn,role='authenticated')=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[who]||'']);try{return await fn();}finally{await db.exec('reset role');}};
const permission=(colony=ids.colony)=>db.query('select public.get_export_permission($1) p',[colony]).then(r=>r.rows[0].p);
const full=()=>db.query('select public.assert_full_export_permission($1) p',[ids.colony]).then(r=>r.rows[0].p);
const exportRows=(o={})=>db.query('select public.export_records($1,$2,$3,$4,$5,$6,$7) p',[o.colony||ids.colony,o.scope||'history',o.from??null,o.to??null,o.types??null,o.offset??0,o.limit??250]).then(r=>r.rows[0].p);
const dates=(await db.query("select to_char((current_timestamp at time zone 'Asia/Taipei')::date,'YYYY-MM-DD') today,to_char(((current_timestamp at time zone 'Asia/Taipei')::date-interval '3 years')::date,'YYYY-MM-DD') low,to_char(((current_timestamp at time zone 'Asia/Taipei')::date-interval '6 years')::date,'YYYY-MM-DD') high,to_char(((current_timestamp at time zone 'Asia/Taipei')::date-interval '4 years')::date,'YYYY-MM-DD') older,to_char(((current_timestamp at time zone 'Asia/Taipei')::date-interval '10 years')::date,'YYYY-MM-DD') old")).rows[0];
const fields={mice:'mouse_sid',matings:'mating_sid',litters:'litter_sid',cages:'cage_sid',rooms:'room_id',racks:'rack_id',locations:'location_id',light_events:'event_id',husbandry_events:'event_id'};
const insert=async(type,id,payload={},colony=ids.colony)=>db.query('insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by)values($1,$2,$3,$4,$5,$5)',[colony,type,id,{[fields[type]]:id,...payload},ids.owner]);
await insert('mice','OLD-STOCK',{state:'Stock',date_of_birth:dates.old,cage_sid:'C-OLD',genotype:'Example +/-',source_history:['SECRET'],comment:'SECRET',genetic_profile:{notes:'SECRET'}});
await insert('mice','OLD-ENDED',{state:'Ended',date_of_birth:dates.old,end_date:dates.old,app_modified_at:dates.today,source_snapshot_date:dates.today});
await insert('mice','RECENT-END',{state:'Ended',date_of_birth:dates.old,end_date:dates.today});
await insert('cages','C-OLD',{state:'Inactive',room_id:'R',rack_id:'RK',location_id:'P',source_block_text:'SECRET'});
await insert('rooms','R',{name:'Current room',source_notes:'SECRET'});await insert('racks','RK',{room_id:'R',name:'Current rack'});await insert('locations','P',{room_id:'R',rack_id:'RK',label:'Position1'});
await insert('husbandry_events','OLD-EVENT',{event_type:'Observation',event_date:dates.old,source_snapshot_date:dates.today,app_created_at:dates.today,notes:'SECRET'});
await insert('husbandry_events','HIGH-EVENT',{event_type:'Observation',event_date:dates.older});
await insert('husbandry_events','LOW-BOUNDARY',{event_type:'Observation',event_date:dates.low});
await insert('husbandry_events','UNDATED',{event_type:'Observation',app_created_at:dates.today,source_snapshot_date:dates.today});
await insert('husbandry_events','RECENT-EVENT',{event_type:'cryopreservation_event',event_date:dates.today,notes:'SECRET',cryopreservation_event:{lot_id:'LOT',activity_type:'use',quantity:2,quantity_unit:'straws',before:{source_snapshots:'SECRET'},notes:'SECRET'}});
await insert('husbandry_events','OLD-CRYO-REVIEW',{event_type:'cryopreservation_lot',event_date:dates.today,cryopreservation:{frozen_date:dates.old,quantity:null,source_notes:'SECRET'}});
await insert('light_events','CURRENT-LIGHT',{start_date:dates.old,end_date:null,protocol:'LD',source_history:'SECRET'});
await insert('light_events','UNKNOWN-LIGHT',{start_date:null,protocol:'LD',source_snapshot_date:dates.today});
await insert('mice','FOREIGN',{state:'Stock',date_of_birth:dates.today},ids.foreign);

await test('migration defaults nonowners Low, owners Max, and safely reruns',async()=>{
  const rows=(await db.query('select role,export_level from public.memberships order by user_id')).rows;
  assert.equal(rows[0].export_level,'max');assert(rows.slice(1).every(r=>r.export_level==='low'));
  await db.exec(migration);
  await as('owner',async()=>{for(const [who,level]of [['high','high'],['max','max']])await db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,$5)',[ids.colony,ids[who],who==='high'?'editor':'viewer','update',level]);});
  assert.equal((await as('low',()=>permission())).cutoff_date,dates.low);assert.equal((await as('high',()=>permission())).cutoff_date,dates.high);assert.equal((await as('owner',()=>permission())).level,'max');
  await as('owner',async()=>{const row=(await db.query('select * from public.manage_colony_member($1,$2,$3,true,$4)',[ids.colony,ids.high,'viewer','update'])).rows[0];assert.equal(row.export_level,'high');assert.equal(row.role,'viewer');});
});
await test('anonymous, outsider, inactive membership and profile spoofing do not bypass permission',async()=>{
  await as('',()=>assert.rejects(()=>permission(),e=>e.code==='42501'),'anon');await as('outsider',()=>assert.rejects(()=>permission(),e=>e.code==='42501'));
  await as('low',async()=>{await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({user_metadata:{export_level:'max',role:'owner'}})]);assert.equal((await permission()).level,'low');await assert.rejects(()=>full(),e=>e.code==='42501');await assert.rejects(()=>exportRows({colony:ids.foreign}),e=>e.code==='42501');});
  await db.query('update public.memberships set active=false where user_id=$1',[ids.low]);await as('low',()=>assert.rejects(()=>exportRows(),e=>e.code==='42501'));await db.query('update public.memberships set active=true where user_id=$1',[ids.low]);
});
await test('calendar cutoffs are inclusive and cannot be replaced by import/update/source dates',async()=>{
  const low=await as('low',()=>exportRows());const names=low.rows.map(r=>r.entity_id);
  assert(names.includes('LOW-BOUNDARY'));assert(names.includes('RECENT-END'));assert(names.includes('RECENT-EVENT'));
  for(const id of ['OLD-ENDED','OLD-EVENT','HIGH-EVENT','OLD-CRYO-REVIEW','UNDATED'])assert(!names.includes(id),id);
  assert(low.excluded_undated>=4);assert(!JSON.stringify(low).includes('SECRET'));
  await as('low',()=>assert.rejects(()=>exportRows({from:dates.older}),e=>e.code==='42501'));
  const high=await as('high',()=>exportRows());assert(high.rows.some(r=>r.entity_id==='HIGH-EVENT'));
  assert.equal((await db.query("select ('2024-02-29'::date-interval '3 years')::date::text d")).rows[0].d,'2021-02-28');
});
await test('current housing includes old-born Stock mice and their inactive referenced cage without old history',async()=>{
  await insert('cages','C-PLACED',{state:'Inactive',location_id:'P'});
  await insert('locations','P-NEW',{room_id:'R',rack_id:'RK',label:'Empty position',record_origin:'app_created'});
  await insert('locations','P-ARCHIVED',{label:'Archived position',app_archived_at:dates.today+'T00:00:00Z'});
  await insert('cages','C-ARCHIVED-POSITION',{state:'Inactive',location_id:'P-ARCHIVED'});
  const page=await as('low',()=>exportRows({scope:'current_housing'})),names=page.rows.map(r=>r.entity_id);
  for(const id of ['OLD-STOCK','C-OLD','C-PLACED','R','RK','P','P-NEW','CURRENT-LIGHT'])assert(names.includes(id),id);
  for(const id of ['OLD-ENDED','OLD-EVENT','RECENT-EVENT','UNKNOWN-LIGHT','FOREIGN','P-ARCHIVED','C-ARCHIVED-POSITION'])assert(!names.includes(id),id);
  assert.equal(page.rows.find(r=>r.entity_id==='P-NEW').payload.record_origin,'app_created');
  assert.equal(page.rows.find(r=>r.entity_id==='P').payload.record_origin,'source_recorded');
  assert(!JSON.stringify(page).includes('SECRET'));assert(!page.rows.find(r=>r.entity_id==='OLD-STOCK').payload.genetic_profile);
  await as('low',()=>assert.rejects(()=>exportRows({scope:'current_housing',from:dates.low}),e=>e.code==='22023'));
});
await test('current light intervals respect exclusive ends and valid event timezones, with archive-flag defense',async()=>{
  const local=(await db.query("select to_char((current_timestamp at time zone 'Pacific/Honolulu')::date,'YYYY-MM-DD') d")).rows[0].d;
  await insert('light_events','EXCLUSIVE-LIGHT',{start_date:dates.old,end_date:dates.today,interval_semantics:'end exclusive: next phase start',timezone:'Asia/Taipei'});
  await insert('light_events','INCLUSIVE-LIGHT',{start_date:dates.old,end_date:dates.today,timezone:'invalid timezone',actual_exposure_verified:false,interval_semantics:'inclusive'});
  await insert('light_events','LOCAL-LIGHT',{start_date:local,end_date:local,timezone:'Pacific/Honolulu',interval_semantics:'inclusive'});
  await insert('mice','PAYLOAD-ARCHIVED',{state:'Stock',date_of_birth:dates.today,app_archived_at:dates.today+'T00:00:00Z'});
  const page=await as('low',()=>exportRows({scope:'current_housing'})),names=page.rows.map(r=>r.entity_id);
  assert(!names.includes('EXCLUSIVE-LIGHT'));assert(!names.includes('PAYLOAD-ARCHIVED'));assert(names.includes('INCLUSIVE-LIGHT'));assert(names.includes('LOCAL-LIGHT'));
  const light=page.rows.find(r=>r.entity_id==='INCLUSIVE-LIGHT').payload;assert.equal(light.actual_exposure_verified,false);assert.equal(light.interval_semantics,'inclusive');
  assert(Number.isFinite(Date.parse(page.captured_at)));assert(Number.isFinite(Date.parse((await as('low',()=>permission())).captured_at)));
});
await test('Max permits full-backup authorization and undated managed history, but still sanitizes report payloads',async()=>{
  assert.equal((await as('max',()=>full())).full_history,true);
  const all=await as('max',()=>exportRows({to:dates.today}));assert(all.rows.some(r=>r.entity_id==='UNDATED'&&r.record_date===null));assert.equal(all.excluded_undated,0);assert(!JSON.stringify(all).includes('SECRET'));
  const dated=await as('max',()=>exportRows({from:dates.old,to:dates.today}));assert(!dated.rows.some(r=>r.entity_id==='UNDATED'));
  await as('max',()=>assert.rejects(()=>exportRows({types:['archive']}),e=>e.code==='22023'));
});
await test('permission is freshly enforced after downgrade; nonowners cannot grant themselves exports',async()=>{
  await as('low',()=>assert.rejects(()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,$5)',[ids.colony,ids.low,'viewer','update','max']),e=>e.code==='42501'));
  await as('owner',()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,$5)',[ids.colony,ids.max,'viewer','update','low']));
  await as('max',()=>assert.rejects(()=>full(),e=>e.code==='42501'));await as('max',()=>assert.rejects(()=>exportRows({from:dates.old}),e=>e.code==='42501'));
  await as('owner',()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,$5)',[ids.colony,ids.max,'viewer','update','max']));
});
await test('pages have deterministic offsets and a revision that changes after committed edits',async()=>{
  const first=await as('max',()=>exportRows({limit:2})),second=await as('max',()=>exportRows({limit:2,offset:first.next_offset}));
  assert.equal(first.next_offset,2);assert.equal(first.snapshot_revision,second.snapshot_revision);assert(!first.rows.some(a=>second.rows.some(b=>a.entity_id===b.entity_id&&a.entity_type===b.entity_type)));
  await insert('husbandry_events','NEW-REVISION',{event_date:dates.today});const changed=await as('max',()=>exportRows({limit:2}));assert.notEqual(changed.snapshot_revision,first.snapshot_revision);
  assert.equal(changed.as_of_date,dates.today);
});
await test('report page bytes are bounded and primitive allowlists reject nested raw-field substitution',async()=>{
  for(let i=0;i<70;i++)await insert('mice','BIG-'+String(i).padStart(3,'0'),{state:'Stock',date_of_birth:dates.today,sire_sids:Array.from({length:100},(_,i)=>String(i)+'x'.repeat(198)),genotype:'G'.repeat(4000),physical_tag:{secret:'SECRET'}});
  const page=await as('low',()=>exportRows({scope:'current_housing',types:['mice']}));
  assert(Buffer.byteLength(JSON.stringify(page))<850000);assert(page.rows.length>0&&page.rows.length<70);assert.equal(page.next_offset,page.rows.length);
  assert(page.rows.every(r=>r.payload.physical_tag===undefined));assert(page.rows.every(r=>!r.payload.genotype||r.payload.genotype.length<=2048));
});
await test('direct permissions and helper ACLs remain closed while everyday member reads are unchanged',async()=>{
  await as('low',async()=>{await assert.rejects(()=>db.query("update public.memberships set export_level='max'"),e=>e.code==='42501');await assert.rejects(()=>db.query("select colony_private.export_payload('mice','{}')"),e=>e.code==='42501');assert((await db.query('select count(*) from public.entity_records where colony_id=$1',[ids.colony])).rows[0].count>0);});
});
await db.close();
