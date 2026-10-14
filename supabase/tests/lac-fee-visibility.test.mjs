import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
import {blankLacFeeOptions,blankLacFeeMonth,calculateLacFeeMonth} from '../../web/lac-fee-model.js';
const db=new PGlite(),cid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ids=Object.fromEntries(['owner','low','high','max','outside'].map((k,i)=>[k,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
create schema storage;create table storage.objects(id text,bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant select,insert on storage.objects to authenticated;create policy fixture_insert on storage.objects for insert to authenticated with check(true);create policy fixture_read on storage.objects for select to authenticated using(true);`);
for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql','iacuc.sql','locobox.sql','ear-marks.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.exec(`create function colony_private.history_path_colony(n text) returns uuid language sql immutable as $$select split_part(n,'/',1)::uuid$$;grant execute on function colony_private.history_path_colony(text) to authenticated;`);
for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);
await db.query('insert into colonies(id,name,created_by) values($1,$2,$3)',[cid,'Test',ids.owner]);
for(const k of ['owner','low','high','max'])await db.query('insert into memberships(colony_id,user_id,role,export_level) values($1,$2,$3,$4)',[cid,ids[k],k==='owner'?'owner':'editor',k==='owner'?'max':k]);
await db.exec(`create function public.get_animal_sheet_import_conflicts(p_colony_id uuid,p_offset integer default 0,p_limit integer default 100) returns jsonb language sql security definer set search_path='' as $$select '{"job_id":"synthetic-job","total":1,"next_offset":null,"conflicts":[{"kind":"source_changed","entity_type":"locations","entity_id":"position-synthetic","expected_version":2,"source_payload":{"source_block_text":"PRIVATE fee 2468"},"current_payload":{"source_block_text":"PRIVATE fee 2468"},"message":"PRIVATE detail"}]}'::jsonb$$;grant execute on function public.get_animal_sheet_import_conflicts(uuid,integer,integer) to authenticated;`);
const migration=await readFile(new URL('../lac-fee-visibility.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
async function as(k,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[k]??'']);try{return await fn();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
const rpc=async(n,args)=> (await db.query(`select public.${n}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
const denied=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true});
const all={low:{estimate:true,actual:true},high:{estimate:true,actual:true},max:{estimate:true,actual:true}};
const payload={event_id:'fee',event_type:'lac_fee_month',event_date:'2026-01-01',source_values:'PRIVATE raw financial',notes:'PRIVATE notes',lac_fee_month:{month:'2026-01',currency:'TWD',actual_total:2468,actual_date:'2026-10-14',actual_basis:'confirmed_paid',paid_date:'2026-02-01',invoice_reference:'PRIVATE invoice',revision:1,lines:[{group_key:'clean_room',quantity:301,quantity_unit:'cage_day',quantity_note:'PRIVATE paid 2468',evidence_reference:'PRIVATE receipt',actual_amount:7500}]}};
const save=(id,p=payload,version=0)=>db.query('select * from public.save_record($1,$2,$3,$4,$5)',[cid,'husbandry_events',id,{...p,event_id:id},version]);
await as('owner',()=>save('fee'));
await as('owner',()=>save('old',{...payload,event_date:'2000-01-01'}));
await as('owner',()=>save('spoof',{...payload,event_type:'cage_assignment'}));
const snapshot={event_id:'snapshot',event_type:'animal_sheet_cage_snapshot',event_date:'2026-01-01',notes:'PRIVATE source notes',source_cage_snapshot:{snapshot_date:'2026-01-01',body:[{raw:'PRIVATE animal note 2468'}],source_cells:[{raw:'PRIVATE fee 2468'}]}};
await as('owner',()=>save('snapshot',snapshot));
const sourceChange={event_id:'source-change',event_type:'animal_sheet_source_change',event_date:'2026-01-01',animal_sheet_change:{entity_type:'locations',entity_id:'position-synthetic',before:{source_block_text:'PRIVATE old fee 2468'},after:{source_block_text:'PRIVATE new fee 2468'}}};
await as('owner',()=>save('source-change',sourceChange));
await as('owner',()=>save('source-change-spoof',{...sourceChange,event_type:'cage_assignment'}));
await as('owner',()=>db.query('select * from save_record($1,$2,$3,$4,0)',[cid,'archive','reconstruction',{tables:{raw:'PRIVATE source'}}]));
await as('owner',()=>db.query('select * from save_record($1,$2,$3,$4,0)',[cid,'mice','M',{mouse_sid:'M',state:'Stock',ear_mark:'L0R1'}]));
const location={location_id:'position-synthetic',label:'L1',manager:'Synthetic manager',notes:'Managed animal note',record_origin:'current_google_sheet_map',source_current:true,source_snapshot_date:'2026-01-01',source_observed_mouse_sids:['M'],source_block_text:'PRIVATE source fee 2468',source_manager_evidence_refs:[{raw:'PRIVATE source financial note'}],manager_source:{raw:'PRIVATE fee 2468'}};
await as('owner',()=>db.query('select * from save_record($1,$2,$3,$4,0)',[cid,'locations','position-synthetic',location]));
await db.query('insert into storage.objects values($1,$2,$3)',['s','colony-history',cid+'/history/x.json']);
await test('default access is unchanged, owner controls exact matrices with CAS and a private audit',async()=>{
 await as('low',async()=>{const p=await rpc('get_lac_fee_visibility',[cid]);assert.equal(p.estimate,true);assert.equal(p.actual,true);assert(!p.levels);assert.equal((await db.query('select * from entity_records')).rows.length,9);await denied(()=>rpc('save_lac_fee_visibility',[cid,0,all]));});
 await as('outside',()=>denied(()=>rpc('get_lac_fee_visibility',[cid])));await as(null,()=>denied(()=>rpc('get_lac_fee_visibility',[cid])),'anon');
 await as('owner',async()=>{await denied(()=>rpc('save_lac_fee_visibility',[cid,0,{...all,low:{estimate:'true',actual:true}}]),'22023');let p=await rpc('save_lac_fee_visibility',[cid,0,{low:{estimate:true,actual:false},high:{estimate:false,actual:true},max:{estimate:false,actual:false}}]);assert.equal(p.version,1);assert.equal(p.owner,true);assert.equal(p.source_archive_allowed,true);await denied(()=>rpc('save_lac_fee_visibility',[cid,0,all]),'40001');});
 assert.equal((await db.query('select count(*) n from colony_private.lac_fee_visibility_audit')).rows[0].n,1);
});
await test('partial visibility blocks direct raw fee, source archive, raw audit and storage reads',async()=>{
 for(const k of ['low','high','max'])await as(k,async()=>{assert.deepEqual((await db.query('select entity_id from entity_records')).rows,[{entity_id:'M'}]);assert.equal((await db.query('select * from audit_log')).rows.length,0);assert.equal((await db.query('select * from storage.objects')).rows.length,0);await denied(()=>db.query('insert into storage.objects values($1,$2,$3)',['denied','colony-history',cid+'/history/new.json']));assert.equal((await rpc('export_records',[cid,'current_housing',null,null,['mice'],0,250])).rows[0].payload.ear_mark,'L0R1');await denied(()=>db.query('select * from colony_private.lac_fee_visibility'));await denied(()=>rpc('assert_full_export_permission',[cid]));});
 await as('owner',async()=>{assert.equal((await db.query('select * from entity_records')).rows.length,9);assert.equal((await db.query('select * from storage.objects')).rows.length,1);assert.equal((await rpc('assert_full_export_permission',[cid])).level,'max');});
});
await test('sanitized fee pages contain only allowed amounts with no free-text/raw provenance leak',async()=>{
 for(const k of ['low','high','max'])await as(k,async()=>{const result=await rpc('get_lac_fee_records',[cid,0,250]),row=result.rows.find(r=>r.entity_id==='fee'),p=row.payload.lac_fee_month;assert.equal(row.version,1);assert(!JSON.stringify(result).includes('PRIVATE'));assert.equal(Object.hasOwn(p,'actual_total'),k==='high');assert.equal(Object.hasOwn(p.lines[0],'quantity'),k==='low');assert.equal(Object.hasOwn(p.lines[0],'actual_amount'),k==='high');assert.equal(Object.hasOwn(p,'paid_date'),k==='high');assert(!result.visibility.levels);const source=result.rows.find(r=>r.entity_id==='snapshot');assert(source);assert(!source.payload.source_cage_snapshot);assert.equal(source.payload.event_type,'animal_sheet_cage_snapshot');for(const id of ['source-change','source-change-spoof']){const changed=result.rows.find(r=>r.entity_id===id);assert(changed);assert(!changed.payload.animal_sheet_change);}});
 await as('owner',async()=>assert((await rpc('get_lac_fee_records',[cid,0,250])).rows.some(r=>JSON.stringify(r).includes('PRIVATE'))));
});
await test('bounded export preserves calendar windows and financial restrictions; hidden nested aliases do not bypass it',async()=>{
 for(const k of ['low','high','max'])await as(k,async()=>{const report=await rpc('export_records',[cid,'history',null,null,['husbandry_events'],0,250]);assert(!JSON.stringify(report).includes('PRIVATE'));const p=report.rows.find(r=>r.entity_id==='fee').payload.lac_fee_month;assert.equal(Object.hasOwn(p,'actual_total'),k==='high');assert.equal(Object.hasOwn(p.lines[0],'quantity'),k==='low');assert.equal(report.rows.some(r=>r.entity_id==='old'),k==='max');assert(!report.rows.find(r=>r.entity_id==='spoof').payload.lac_fee_month);assert(!report.rows.find(r=>r.entity_id==='snapshot').payload.source_cage_snapshot);for(const id of ['source-change','source-change-spoof'])assert(!report.rows.find(r=>r.entity_id===id).payload.animal_sheet_change);await denied(()=>db.query('select colony_private.export_records_before_fee_visibility($1)',[cid]));});
});
await test('hidden financial writes and no-op saves are denied atomically while ordinary animal edits remain possible',async()=>{
 await as('low',async()=>{await denied(()=>save('fee',payload,1));await denied(()=>save('new'));await denied(()=>save('new-spoof',{...payload,event_type:'cage_assignment'}));await denied(()=>save('snapshot',snapshot,1));await denied(()=>save('snapshot-disguised',{...snapshot,event_type:'cage_assignment'}));await denied(()=>save('source-change',sourceChange,1));await denied(()=>save('source-change-disguised',{...sourceChange,event_type:'cage_assignment'}));await db.query('select * from save_record($1,$2,$3,$4,1)',[cid,'mice','M',{mouse_sid:'M',state:'Stock',notes:'new'}]);await denied(()=>db.query('select * from save_records($1,$2)',[cid,[{entity_type:'mice',entity_id:'M',payload:{mouse_sid:'M',state:'Stock',notes:'atomic'},expected_version:2},{entity_type:'husbandry_events',entity_id:'bad',payload:{...payload,event_id:'bad'},expected_version:0}]]));});
 assert.equal((await db.query("select payload->>'notes' note from entity_records where entity_id='M'")).rows[0].note,'new');
 await as('owner',async()=>{await denied(()=>save('bad-basis',{...payload,lac_fee_month:{actual_basis:'paid probably'}}),'22023');await denied(()=>save('bad-date',{...payload,lac_fee_month:{paid_date:'2026-02-31'}}),'22023');await rpc('save_lac_fee_visibility',[cid,1,all]);});
 await as('max',async()=>{assert.equal((await rpc('assert_full_export_permission',[cid])).level,'max');assert.equal((await db.query('select * from entity_records')).rows.length,9);});
});
await test('partial fee access retains editable projected positions and never returns or overwrites hidden source fields',async()=>{
 await as('owner',()=>rpc('save_lac_fee_visibility',[cid,2,{...all,low:{estimate:true,actual:false}}]));
 await as('outside',()=>denied(()=>rpc('get_managed_locations',[cid,0,250])));await as(null,()=>denied(()=>rpc('get_managed_locations',[cid,0,250])),'anon');
 await as('low',async()=>{
  await denied(()=>rpc('get_managed_locations',[cid,-1,250]),'22023');
  await denied(()=>db.query('select colony_private.save_record_before_location_visibility($1,$2,$3,$4,1,false)',[cid,'locations','position-synthetic',location]));
  assert.equal((await db.query("select count(*) n from entity_records where entity_type='locations'")).rows[0].n,0);
  const result=await rpc('get_managed_locations',[cid,0,250]);assert.equal(result.rows.length,1);assert.equal(result.next_offset,null);assert(!JSON.stringify(result).includes('PRIVATE'));
  const record=result.rows[0],p=record.payload;assert.equal(p.label,'L1');assert.deepEqual(p.source_observed_mouse_sids,['M']);assert.equal(p.notes,'Managed animal note');assert.equal(record.version,1);
  assert(!JSON.stringify(await rpc('export_records',[cid,'current_housing',null,null,['locations'],0,250])).includes('PRIVATE'));
  const saveLocation=(payload,version)=>db.query('select * from save_record($1,$2,$3,$4,$5)',[cid,'locations','position-synthetic',payload,version]);
  await denied(()=>saveLocation({...p,source_block_text:'attempt'},1));
  await denied(()=>saveLocation({...p,manager_source:{}},1));
  await denied(()=>saveLocation({...p,source_snapshot_date:'2026-01-02'},1),'22023');
  const saved=(await saveLocation({...p,manager:'New manager',notes:'Updated managed note'},1)).rows[0];assert.equal(saved.version,2);assert.equal(saved.payload.manager,'New manager');assert(!JSON.stringify(saved).includes('PRIVATE'));
  const noop=(await saveLocation(saved.payload,2)).rows[0];assert.equal(noop.version,2);assert(!JSON.stringify(noop).includes('PRIVATE'));
  await denied(()=>saveLocation({...saved.payload,label:'stale'},1),'40001');
  const batch=(await db.query('select * from save_records($1,$2)',[cid,[{entity_type:'locations',entity_id:'position-synthetic',payload:{...saved.payload,notes:'Batch update'},expected_version:2}]])).rows;assert.equal(batch[0].version,3);assert(!JSON.stringify(batch).includes('PRIVATE'));
 });
 const raw=(await db.query("select payload from entity_records where entity_type='locations' and entity_id='position-synthetic'")).rows[0].payload;assert.equal(raw.source_block_text,location.source_block_text);assert.deepEqual(raw.source_manager_evidence_refs,location.source_manager_evidence_refs);assert.deepEqual(raw.manager_source,location.manager_source);assert.equal(raw.notes,'Batch update');
 await as('owner',()=>rpc('save_lac_fee_visibility',[cid,3,all]));
});
await test('import conflict metadata stays available without leaking private source blocks',async()=>{
 await as('owner',()=>rpc('save_lac_fee_visibility',[cid,4,{...all,low:{estimate:true,actual:false}}]));
 await as('low',async()=>{const p=await rpc('get_animal_sheet_import_conflicts',[cid,0,100]);assert.equal(p.total,1);assert.equal(p.source_details_withheld,true);assert.equal(p.conflicts[0].entity_id,'position-synthetic');assert.equal(p.conflicts[0].expected_version,2);assert(!JSON.stringify(p).includes('PRIVATE'));await denied(()=>db.query('select colony_private.get_animal_sheet_import_conflicts_before_fee_visibility($1,0,100)',[cid]));});
 await as('outside',()=>denied(()=>rpc('get_animal_sheet_import_conflicts',[cid,0,100])));
 await as('owner',async()=>{assert(JSON.stringify(await rpc('get_animal_sheet_import_conflicts',[cid,0,100])).includes('PRIVATE'));await rpc('save_lac_fee_visibility',[cid,5,all]);});
});
await test('real projected fee payloads retain usable permitted estimates and actual totals without source text',async()=>{
 const options=blankLacFeeOptions('2026-01-01');options.revision=1;options.groups.forEach((g,i)=>{g.rate=10*(i+1);g.rate_reference='PRIVATE rate reference';});
 const month=blankLacFeeMonth('2026-01');month.revision=1;month.actual_total=300;month.actual_date='2026-02-01';month.invoice_reference='PRIVATE grant';month.lines.forEach((l,i)=>{l.quantity=i+3;l.evidence_start='2026-01-01';l.evidence_end='2026-01-31';l.evidence_reference='PRIVATE receipt';});
 const rows=[{event_id:'rates',event_type:'lac_fee_options',event_date:'2026-01-01',lac_fee_options:options},{event_id:'month',event_type:'lac_fee_month',event_date:'2026-01-01',lac_fee_month:month}];
 for(const [estimate,actual]of [[true,false],[false,true]]){
  const projected=[];for(const row of rows)projected.push((await db.query('select colony_private.fee_payload($1,$2,$3,true) p',[row,estimate,actual])).rows[0].p);
  assert(!JSON.stringify(projected).includes('PRIVATE'));const result=calculateLacFeeMonth({tables:{husbandry_events:projected}},'2026-01',{nowDate:'2026-10-15'});
  assert.equal(result.estimate,estimate?260:null);assert.equal(result.actual,actual?300:null);
 }
});
await test('reapplying domain migrations then this final guard captures their latest implementation without dropping visibility',async()=>{
 for(const file of ['export-permissions.sql','manager-permissions.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
 await db.exec(migration);await db.exec(migration);
 await as('owner',()=>rpc('save_lac_fee_visibility',[cid,6,{...all,low:{estimate:false,actual:false}}]));
 await as('low',async()=>{await denied(()=>save('fee',payload,1));assert.equal((await db.query('select entity_id from entity_records')).rows.length,1);assert(!JSON.stringify(await rpc('export_records',[cid,'history',null,null,['husbandry_events'],0,250])).includes('2468'));const page=await rpc('get_managed_locations',[cid,0,250]);assert(!JSON.stringify(page).includes('PRIVATE'));const saved=(await db.query('select * from save_record($1,$2,$3,$4,$5)',[cid,'locations','position-synthetic',page.rows[0].payload,3])).rows[0];assert(!JSON.stringify(saved).includes('PRIVATE'));});
});
await db.close();
