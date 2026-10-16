import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),cid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const names=['owner','manager','low','high','max','highViewer','disabled','outside'];
const ids=Object.fromEntries(names.map((name,i)=>[name,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id text,bucket_id text,name text);alter table storage.objects enable row level security;
grant usage on schema storage to authenticated,anon;grant select,insert on storage.objects to authenticated;
create policy broad_fixture_storage_read on storage.objects for select to authenticated using(true);
create policy broad_fixture_storage_insert on storage.objects for insert to authenticated with check(true);`);
for(const file of ['schema.sql','history-storage.sql','export-permissions.sql','manager-permissions.sql','iacuc.sql','locobox.sql','ear-marks.sql','cage-position-guard.sql','brainbot.sql','animal-sheet-import.sql','lac-fee-visibility.sql','cage-observations.sql','local-backup.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);
await db.query('insert into colonies(id,name,created_by)values($1,$2,$3),($4,$5,$6)',[cid,'Access fixture',ids.owner,other,'Other',ids.outside]);
for(const name of names.filter(n=>n!=='outside'))await db.query('insert into memberships(colony_id,user_id,role,export_level,active)values($1,$2,$3,$4,$5)',[cid,ids[name],name==='owner'?'owner':name==='manager'?'manager':name==='highViewer'?'viewer':'editor',name==='low'?'low':name==='high'||name==='highViewer'?'high':'max',name!=='disabled']);
await db.query("insert into memberships(colony_id,user_id,role,export_level)values($1,$2,'owner','max')",[other,ids.outside]);
const rpc=async(name,args)=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
async function as(name,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);try{return await fn();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
const denied=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true;});
const save=async(type,id,p,version=0)=>(await db.query('select * from public.save_record($1,$2,$3,$4,$5)',[cid,type,id,p,version])).rows[0];
const location={location_id:'P',label:'L7',manager:'Current manager',source_block_text:'ARCHIVE_ONLY location block'};
const rawEvent={event_id:'snapshot',event_type:'animal_sheet_cage_snapshot',event_date:'2026-01-01',source_cage_snapshot:{body:'ARCHIVE_ONLY whole source'}};
const changeEvent={event_id:'change',event_type:'animal_sheet_source_change',event_date:'2026-01-01',animal_sheet_change:{before:{source_block_text:'ARCHIVE_ONLY old source'}}};
const fee={event_id:'fee',event_type:'lac_fee_month',event_date:'2026-01-01',source_raw:'ARCHIVE_ONLY fee source',lac_fee_month:{schema_version:1,month:'2026-01',currency:'TWD',actual_total:42,actual_date:'2026-02-01',invoice_reference:'ARCHIVE_ONLY invoice reference',notes:'ARCHIVE_ONLY invoice note',revision:1,lines:[{group_key:'clean_room',quantity:3,quantity_unit:'cage_day',evidence_kind:'billed_quantity',evidence_start:'2026-01-01',evidence_end:'2026-01-31',evidence_reference:'ARCHIVE_ONLY quantity reference',quantity_note:'ARCHIVE_ONLY quantity note',actual_amount:42}]}};
await as('owner',async()=>{await save('locations','P',location);await save('mice','M',{mouse_sid:'M',state:'Stock',ear_mark:'L0R1'});await save('cages','C',{cage_sid:'C',state:'Active',cage_tag:'L7'});await save('archive','reconstruction',{tables:{raw:'ARCHIVE_ONLY archive'}});await save('husbandry_events','snapshot',rawEvent);await save('husbandry_events','change',changeEvent);await save('husbandry_events','spoof',{...changeEvent,event_id:'spoof',event_type:'cage_assignment'});await save('husbandry_events','fee',fee);});
const storageName=cid+'/history/'+ 'a'.repeat(64)+'.json';await db.query('insert into storage.objects values($1,$2,$3)',['history','colony-history',storageName]);
await db.query("insert into colony_private.animal_sheet_import_snapshots(colony_id,source_spreadsheet_id,captured_at,raw_hash,content_hash,raw_workbook)values($1,'source',now(),'raw','content',$2)",[cid,{raw:'ARCHIVE_ONLY workbook'}]);
const snapshotId=(await db.query('select snapshot_id from colony_private.animal_sheet_import_snapshots')).rows[0].snapshot_id;
await db.query("insert into colony_private.animal_sheet_import_jobs(colony_id,trigger_kind,status,finished_at,conflicts)values($1,'manual','conflicts',now(),$2)",[cid,[{entity_type:'locations',entity_id:'P',kind:'source_changed',expected_version:1,current_payload:{source_block_text:'ARCHIVE_ONLY conflict'}}]]);
await db.query('insert into colony_private.brainbot_settings(colony_id)values($1)',[cid]);
const principal=(await db.query('select principal_id from colony_private.brainbot_settings')).rows[0].principal_id;
await db.query("insert into colony_private.brainbot_runs(colony_id,principal_id,trigger,status,settings_version,changes)values($1,$2,'manual','completed',1,$3)",[cid,principal,[{entity_type:'cages',entity_id:'C',fields:['room_id'],before_version:1,after_version:2,before:{cage_sid:'C',source_raw:'ARCHIVE_ONLY before'},after:{cage_sid:'C',room_id:'R',source_raw:'ARCHIVE_ONLY after'}}]]);
const run=(await db.query('select run_id from colony_private.brainbot_runs')).rows[0].run_id;
await db.query("insert into colony_private.brainbot_issues(colony_id,code,entity_type,entity_id,title,details,last_run_id)values($1,'fixture','cages','C','Review cage','{}',$2)",[cid,run]);
const issue=(await db.query('select issue_id from colony_private.brainbot_issues')).rows[0].issue_id;
const beforeControls=(await db.query("select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('save_brainbot_settings','run_brainbot','review_brainbot_issue') order by proname")).rows;
await db.query("insert into audit_log(colony_id,entity_type,entity_id,operation,actor_id,after_record)values($1,'husbandry_events','legacy-flat-snapshot','INSERT',$2,$3)",[cid,ids.owner,rawEvent]);
const migration=await readFile(new URL('../monitoring-archive-access.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);

await test('BB read access follows active High/Max or Manager/Owner while controls remain owner-only',async()=>{
 for(const name of ['owner','manager','high','max','highViewer'])await as(name,async()=>{const result=await rpc('get_brainbot_status',[cid]);assert.equal(result.principal.name,'Braintime Bot');assert.equal(result.can_manage,name==='owner');assert.equal(result.runs.length,1);assert.equal(result.issues.length,1);assert.equal(JSON.stringify(result).includes('ARCHIVE_ONLY'),['owner','manager'].includes(name));});
 for(const name of ['low','disabled','outside'])await as(name,()=>denied(()=>rpc('get_brainbot_status',[cid])));
 await as(null,()=>denied(()=>rpc('get_brainbot_status',[cid])),'anon');
 for(const name of ['manager','high','max','highViewer'])await as(name,async()=>{await denied(()=>rpc('save_brainbot_settings',[cid,{}]));await denied(()=>rpc('run_brainbot',[cid]));await denied(()=>rpc('review_brainbot_issue',[cid,issue,1,'resolved','No']));await denied(()=>db.query('select * from colony_private.brainbot_runs'));});
 assert.deepEqual((await db.query("select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('save_brainbot_settings','run_brainbot','review_brainbot_issue') order by proname")).rows,beforeControls);
});
await test('below-Manager members cannot retrieve archive chunks, raw locations/events, their audit snapshots or history objects',async()=>{
 for(const name of ['low','high','max','highViewer'])await as(name,async()=>{
  const rows=(await db.query('select * from public.entity_records')).rows;assert.deepEqual(rows.map(r=>r.entity_id).sort(),['C','M']);assert(!JSON.stringify(rows).includes('ARCHIVE_ONLY'));
  assert(!JSON.stringify((await db.query('select * from public.audit_log')).rows).includes('ARCHIVE_ONLY'));
  assert.deepEqual((await db.query('select * from storage.objects')).rows,[]);await denied(()=>db.query('insert into storage.objects values($1,$2,$3)',['forbidden','colony-history',cid+'/history/'+ 'b'.repeat(64)+'.json']));
  const policy=await rpc('get_lac_fee_visibility',[cid]);assert.equal(policy.estimate,true);assert.equal(policy.actual,true);assert.equal(policy.source_archive_allowed,false);
  assert.equal((await db.query('select colony_private.fee_full_access($1) v',[cid])).rows[0].v,true);
 });
 for(const name of ['owner','manager'])await as(name,async()=>{assert((await db.query('select * from public.entity_records')).rows.some(r=>r.entity_type==='archive'));assert.equal((await db.query('select * from storage.objects')).rows.length,1);});
});
await test('raw export and snapshot RPCs require Manager even at Max; safe current data and bounded/full managed exports remain readable',async()=>{
 for(const name of ['low','high','max','highViewer'])await as(name,async()=>{await denied(()=>rpc('assert_full_export_permission',[cid]));await denied(()=>rpc('get_animal_sheet_import_snapshot',[cid,snapshotId]));const locations=await rpc('get_managed_locations',[cid,0,250]);assert.equal(locations.rows[0].payload.label,'L7');assert(!JSON.stringify(locations).includes('ARCHIVE_ONLY'));const fees=await rpc('get_lac_fee_records',[cid,0,250]);assert.equal(fees.rows.find(r=>r.entity_id==='fee').payload.lac_fee_month.actual_total,42);assert(!JSON.stringify(fees).includes('ARCHIVE_ONLY'));const conflicts=await rpc('get_animal_sheet_import_conflicts',[cid,0,100]);assert.equal(conflicts.total,1);assert(!JSON.stringify(conflicts).includes('ARCHIVE_ONLY'));const result=await rpc('export_records',[cid,'current_housing',null,null,['mice','locations'],0,250]);assert(result.rows.some(r=>r.entity_id==='M'));assert(!JSON.stringify(result).includes('ARCHIVE_ONLY'));assert.equal((await rpc('get_export_permission',[cid])).level,name==='low'?'low':name==='max'?'max':'high');});
 for(const name of ['owner','manager'])await as(name,async()=>{assert.equal((await rpc('assert_full_export_permission',[cid])).level,'max');assert(JSON.stringify(await rpc('get_animal_sheet_import_snapshot',[cid,snapshotId])).includes('ARCHIVE_ONLY'));assert(JSON.stringify(await rpc('get_animal_sheet_import_conflicts',[cid,0,100])).includes('ARCHIVE_ONLY'));});
});
await test('security-definer saves cannot bypass archive reads; managed location edits preserve hidden raw source',async()=>{
 for(const name of ['low','high','max'])await as(name,async()=>{await denied(()=>save('archive','reconstruction',{tables:{raw:'ARCHIVE_ONLY archive'}},1));await denied(()=>save('husbandry_events','snapshot',rawEvent,1));await denied(()=>save('husbandry_events','change',changeEvent,1));await denied(()=>save('husbandry_events','spoof',{...changeEvent,event_id:'spoof',event_type:'cage_assignment'},1));await denied(()=>save('locations','P',location,1));await denied(()=>db.query('select * from colony_private.save_record_before_source_archive_access($1,$2,$3,$4,1)',[cid,'locations','P',location]));});
 let p=await as('high',()=>rpc('get_managed_locations',[cid,0,250]));const row=p.rows[0];const saved=await as('high',()=>save('locations','P',{...row.payload,manager:'Updated manager'},row.version));assert.equal(saved.payload.manager,'Updated manager');assert(!JSON.stringify(saved).includes('ARCHIVE_ONLY'));
 assert.equal((await db.query("select payload->>'source_block_text' raw from entity_records where entity_id='P'")).rows[0].raw,location.source_block_text);
 await as('high',()=>save('mice','M',{mouse_sid:'M',state:'Stock',ear_mark:'L1R1'},1));
});
await test('fee amounts remain readable and writable without revealing source references through raw, no-op or batch returns',async()=>{
 const current=(await as('high',()=>rpc('get_lac_fee_records',[cid,0,250]))).rows.find(r=>r.entity_id==='fee');
 assert.equal(current.payload.lac_fee_month.actual_total,42);assert.equal(current.payload.lac_fee_month.invoice_reference,'Source reference withheld');
 for(const name of ['low','high','max'])await as(name,async()=>{
  await denied(()=>save('husbandry_events','fee',fee,current.version),'22023');
  const result=await save('husbandry_events','fee',current.payload,current.version);assert.equal(result.version,current.version);assert(!JSON.stringify(result).includes('ARCHIVE_ONLY'));
  const batch=await rpc('save_records',[cid,[{entity_type:'husbandry_events',entity_id:'fee',payload:current.payload,expected_version:current.version}]]);assert(!JSON.stringify(batch).includes('ARCHIVE_ONLY'));
  await denied(()=>db.query('select colony_private.managed_fee_write($1,$2)',[fee,fee]));
 });
 const next={event_id:'fee2',event_type:'lac_fee_month',event_date:'2026-01-01',record_origin:'app_created',app_created_at:'2026-10-16T00:00:00Z',app_modified_at:'2026-10-16T00:00:00Z',lac_fee_month:{...current.payload.lac_fee_month,actual_total:43,revision:2,supersedes_event_id:'fee',notes:null}};
 const saved=await as('high',()=>save('husbandry_events','fee2',next));assert.equal(saved.payload.lac_fee_month.actual_total,43);assert(!JSON.stringify(saved).includes('ARCHIVE_ONLY'));
 const stored=(await db.query("select payload from entity_records where colony_id=$1 and entity_id='fee2'",[cid])).rows[0].payload;
 assert.equal(stored.lac_fee_month.invoice_reference,fee.lac_fee_month.invoice_reference);assert.equal(stored.lac_fee_month.notes,fee.lac_fee_month.notes);
 assert.equal(stored.lac_fee_month.lines[0].evidence_reference,fee.lac_fee_month.lines[0].evidence_reference);assert.equal(stored.lac_fee_month.lines[0].quantity_note,fee.lac_fee_month.lines[0].quantity_note);
 assert.deepEqual((await db.query("select payload from entity_records where colony_id=$1 and entity_id='fee'",[cid])).rows[0].payload,fee);
 await as('high',async()=>{assert.equal((await db.query("select * from entity_records where entity_id in ('fee','fee2')")).rows.length,0);assert(!JSON.stringify((await db.query('select * from audit_log')).rows).includes('ARCHIVE_ONLY'));});
 await as('owner',async()=>{assert(JSON.stringify((await db.query("select * from entity_records where entity_id='fee2'")).rows).includes('ARCHIVE_ONLY'));});
 const fresh={event_id:'new-fee',event_type:'lac_fee_month',event_date:'2026-02-01',lac_fee_month:{schema_version:1,month:'2026-02',currency:'TWD',actual_total:44,actual_date:'2026-03-01',invoice_reference:'New explicit reference',notes:'New explicit note',revision:0,supersedes_event_id:null,lines:[]}};
 const created=await as('low',()=>save('husbandry_events','new-fee',fresh));assert.equal(created.payload.lac_fee_month.actual_total,44);assert(!JSON.stringify(created).includes('New explicit'));
 await as('highViewer',()=>denied(()=>save('husbandry_events','viewer-fee',{...fresh,event_id:'viewer-fee'})));
});
await test('managed fee writes reject raw fields, ambiguous inherited references, wrong predecessor and stale versions',async()=>{
 const current=(await as('high',()=>rpc('get_lac_fee_records',[cid,0,250]))).rows.find(r=>r.entity_id==='fee');
 await as('high',()=>denied(()=>save('husbandry_events','fee',current.payload,current.version+1),'40001'));
 const base={event_id:'invalid-fee',event_type:'lac_fee_month',event_date:'2026-01-01',lac_fee_month:{...current.payload.lac_fee_month,revision:2,supersedes_event_id:'fee'}};
 for(const p of [{...base,source_raw:'forbidden'},{...base,lac_fee_month:{...base.lac_fee_month,raw:'forbidden'}},{...base,lac_fee_month:{...base.lac_fee_month,lines:[{...base.lac_fee_month.lines[0],raw:'forbidden'}]}}])await as('high',()=>denied(()=>save('husbandry_events','invalid-fee',p)));
 for(const nested of [{...base.lac_fee_month,supersedes_event_id:'snapshot'},{...base.lac_fee_month,month:'2026-02'},{...base.lac_fee_month,revision:99},{...base.lac_fee_month,supersedes_event_id:null},{...base.lac_fee_month,lines:[{...base.lac_fee_month.lines[0],evidence_start:'2026-01-02'}]}])await as('high',()=>denied(()=>save('husbandry_events','invalid-fee',{...base,lac_fee_month:nested}),'22023'));
 const rawLegacy={event_id:'legacy-fee',event_type:'billing_import',billing:{source:'ARCHIVE_ONLY legacy fee'}};await as('owner',()=>save('husbandry_events','legacy-fee',rawLegacy));
 await as('max',async()=>{assert.equal((await db.query("select * from entity_records where entity_id='legacy-fee'")).rows.length,0);await denied(()=>save('husbandry_events','legacy-fee',rawLegacy,1));assert(!JSON.stringify(await rpc('get_lac_fee_records',[cid,0,250])).includes('ARCHIVE_ONLY'));});
});
await test('billing option revisions retain hidden rate references while all responses remain projected',async()=>{
 const options={event_id:'options',event_type:'lac_fee_options',event_date:'2026-01-01',source_raw:'ARCHIVE_ONLY options',lac_fee_options:{schema_version:1,effective_from:'2026-01-01',currency:'TWD',revision:0,groups:[{key:'clean_room',unit:'cage',room_ids:[],rack_ids:[],rate:1,rate_period:'day',rate_reference:'ARCHIVE_ONLY rate'}],notes:'ARCHIVE_ONLY options note'}};
 await as('owner',()=>save('husbandry_events','options',options));
 const row=(await as('high',()=>rpc('get_lac_fee_records',[cid,0,250]))).rows.find(r=>r.entity_id==='options');
 const revised={event_id:'options2',event_type:'lac_fee_options',event_date:'2026-02-01',lac_fee_options:{...row.payload.lac_fee_options,effective_from:'2026-02-01',revision:1,supersedes_event_id:'options',groups:row.payload.lac_fee_options.groups.map(g=>({...g,rate:2})),notes:null}};
 const result=await as('high',()=>save('husbandry_events','options2',revised));assert.equal(result.payload.lac_fee_options.groups[0].rate,2);assert(!JSON.stringify(result).includes('ARCHIVE_ONLY'));
 const raw=(await db.query("select payload from entity_records where colony_id=$1 and entity_id='options2'",[cid])).rows[0].payload;assert.equal(raw.lac_fee_options.groups[0].rate_reference,'ARCHIVE_ONLY rate');assert.equal(raw.lac_fee_options.notes,'ARCHIVE_ONLY options note');
});
await test('batch and unchanged-dependency responses stay projected and a forbidden source write rolls back the whole save',async()=>{
 const current=(await db.query("select * from entity_records where colony_id=$1 and entity_id='M'",[cid])).rows[0],page=await as('max',()=>rpc('get_managed_locations',[cid,0,250])),locationRow=page.rows[0];
 const changes=[{entity_type:'mice',entity_id:'M',payload:{...current.payload,comment:'Must roll back'},expected_version:current.version},{entity_type:'archive',entity_id:'reconstruction',payload:{tables:{raw:'ARCHIVE_ONLY archive'}},expected_version:1}];
 await as('max',()=>denied(()=>rpc('save_records',[cid,changes])));
 assert.deepEqual((await db.query("select payload from entity_records where colony_id=$1 and entity_id='M'",[cid])).rows[0].payload,current.payload);
 const result=await as('max',()=>rpc('save_records',[cid,[{entity_type:'locations',entity_id:'P',payload:locationRow.payload,expected_version:locationRow.version}]]));
 assert(!JSON.stringify(result).includes('ARCHIVE_ONLY'));assert.equal((await db.query("select version from entity_records where colony_id=$1 and entity_id='P'",[cid])).rows[0].version,locationRow.version);
 await db.exec('begin');try{await db.query("update memberships set export_level='low' where colony_id=$1 and user_id=$2",[cid,ids.manager]);const status=await as('manager',()=>rpc('get_brainbot_status',[cid]));assert.equal(status.can_manage,false);assert.equal((await as('manager',()=>rpc('get_lac_fee_visibility',[cid]))).source_archive_allowed,true);}finally{await db.exec('rollback');}
});
await test('fee restrictions still apply independently, and partial-fee users keep safe location editing',async()=>{
 const levels={low:{estimate:true,actual:true},high:{estimate:true,actual:false},max:{estimate:false,actual:true}};await as('owner',()=>rpc('save_lac_fee_visibility',[cid,0,levels]));
 for(const name of ['high','max','manager'])await as(name,async()=>{assert.equal((await rpc('get_lac_fee_visibility',[cid])).source_archive_allowed,false);assert(!JSON.stringify(await rpc('get_brainbot_status',[cid])).includes('ARCHIVE_ONLY'));assert.equal((await db.query("select * from entity_records where entity_type='archive'")).rows.length,0);await denied(()=>rpc('assert_full_export_permission',[cid]));});
 const page=await as('high',()=>rpc('get_managed_locations',[cid,0,250]));const row=page.rows[0],saved=await as('high',()=>save('locations','P',{...row.payload,notes:'Safe animal note'},row.version));assert.equal(saved.payload.notes,'Safe animal note');assert(!JSON.stringify(saved).includes('ARCHIVE_ONLY'));
 assert.equal((await db.query("select payload->>'source_block_text' raw from entity_records where entity_id='P'")).rows[0].raw,location.source_block_text);
});
await test('applying the final guard after maintained fee migration remains idempotent without save-wrapper recursion',async()=>{
 const base=(await db.query("select pg_get_functiondef('colony_private.save_record_before_source_archive_access(uuid,text,text,jsonb,integer,boolean)'::regprocedure) body")).rows[0].body;
 await db.exec(await readFile(new URL('../lac-fee-visibility.sql',import.meta.url),'utf8'));await db.exec(migration);await db.exec(migration);
 assert.equal((await db.query("select pg_get_functiondef('colony_private.save_record_before_source_archive_access(uuid,text,text,jsonb,integer,boolean)'::regprocedure) body")).rows[0].body,base);
 const row=(await as('high',()=>rpc('get_managed_locations',[cid,0,250]))).rows[0];const result=await as('high',()=>save('locations','P',{...row.payload,manager:'After final guard'},row.version));assert.equal(result.payload.manager,'After final guard');assert(!JSON.stringify(result).includes('ARCHIVE_ONLY'));
 await as('max',()=>denied(()=>rpc('assert_full_export_permission',[cid])));
});
await test('revocation and cross-colony denial apply immediately, with no new credentials, membership grants or bot writes',async()=>{
 const count=async table=>(await db.query('select count(*) n from '+table)).rows[0].n;const before=await Promise.all(['auth.users','memberships','colony_private.brainbot_runs','colony_private.brainbot_audit'].map(count));
 await db.query('update memberships set active=false where colony_id=$1 and user_id=$2',[cid,ids.high]);await as('high',async()=>{await denied(()=>rpc('get_brainbot_status',[cid]));await denied(()=>rpc('get_managed_locations',[cid,0,250]));assert.equal((await db.query('select * from entity_records')).rows.length,0);});
 await as('outside',async()=>{await denied(()=>rpc('get_managed_locations',[cid,0,250]));assert.equal((await db.query('select * from entity_records')).rows.length,0);assert.equal((await db.query('select * from storage.objects')).rows.length,0);});
 assert.deepEqual(await Promise.all(['auth.users','memberships','colony_private.brainbot_runs','colony_private.brainbot_audit'].map(count)),before);
});
await db.close();
