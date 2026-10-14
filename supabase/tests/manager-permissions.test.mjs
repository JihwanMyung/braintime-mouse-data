import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const ids={owner:'11111111-1111-4111-8111-111111111111',manager:'22222222-2222-4222-8222-222222222222',editor:'33333333-3333-4333-8333-333333333333',viewer:'44444444-4444-4444-8444-444444444444',outside:'55555555-5555-4555-8555-555555555555',colony:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
const keys=['mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees','iacuc'];
const flags=extra=>({...Object.fromEntries(keys.map(k=>[k,true])),...extra});
const fixture=async()=>{
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`);
 for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
 for(const key of ['owner','manager','editor','viewer','outside'])await db.query('insert into auth.users values($1)',[ids[key]]);
 await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3)',[ids.colony,'Lab',ids.owner]);
 for(const role of ['owner','manager','editor','viewer'])await db.query('insert into public.memberships(colony_id,user_id,role) values($1,$2,$3)',[ids.colony,ids[role],role]);
 const as=async(user,fn,role='authenticated')=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[user]??'']);try{return await fn();}finally{await db.exec('reset role')}};
 const save=(type,id,p={},version=0,archived=false)=>db.query('select * from public.save_record($1,$2,$3,$4,$5,$6)',[ids.colony,type,id,JSON.stringify({[{mice:'mouse_sid',matings:'mating_sid',litters:'litter_sid',cages:'cage_sid',rooms:'room_id',racks:'rack_id',locations:'location_id',light_events:'event_id',husbandry_events:'event_id',archive:'archive_id'}[type]]:id,...p}),version,archived]);
 const allow=async(extra)=>as('owner',()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,null,$5)',[ids.colony,ids.manager,'manager','update',JSON.stringify(flags(extra))]));
 return{db,as,save,allow};
};
const denied=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true});

test('manager migration is idempotent and only owner can set flags or roles',async()=>{
 const {db,as,allow}=await fixture();try{
  await db.exec(await readFile(new URL('../manager-permissions.sql',import.meta.url),'utf8'));
  const row=(await allow({experiments:false})).rows[0];assert.deepEqual(row.permissions,flags({experiments:false}));
  await as('manager',async()=>{
   await denied(()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,null,$5)',[ids.colony,ids.manager,'manager','update',JSON.stringify(flags())]));
   await denied(()=>db.query('select * from public.set_member_role($1,$2,$3,true)',[ids.colony,ids.owner,'viewer']));
   await denied(()=>db.query('update public.memberships set permissions=$1',[JSON.stringify(flags())]));
   assert.equal((await db.query('select * from public.memberships')).rows.length,1);
  });
  await as('owner',async()=>{
   for(const input of [{unknown:true},{mice:'true'},[],null])if(input!==null)await denied(()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,null,$5)',[ids.colony,ids.manager,'manager','update',JSON.stringify(input)]),'22023');
   await denied(()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4)',[ids.colony,ids.owner,'viewer','update']));
   await denied(()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4)',[ids.colony,ids.manager,'owner','update']),'22023');
   const retained=(await db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,$5)',[ids.colony,ids.manager,'manager','update','max'])).rows[0];
   assert.equal(retained.export_level,'max');assert.equal(retained.permissions.experiments,false);
  });
  await as('manager',async()=>assert.equal((await db.query('select public.get_export_permission($1) p',[ids.colony])).rows[0].p.full_history,true));
 }finally{await db.close()}
});

test('all operational sections are enforced on saves and old/new event markers cannot bypass restrictions',async()=>{
 const {db,as,save,allow}=await fixture();try{
  const cases=[['mice','mice',{}],['breeding','matings',{}],['housing','cages',{}],['experiments','husbandry_events',{event_type:'experiment',experiment:{title:'Test'}}],['cryo','husbandry_events',{event_type:'cryopreservation_lot',cryopreservation:{}}],['genetics','husbandry_events',{event_type:'strain_definition',strain_definition:{}}],['fees','husbandry_events',{event_type:'lac_fee_month',lac_fee_month:{}}]];
  for(const [permission,type,p]of cases){
   await allow();await as('manager',()=>save(type,permission,p));
   await allow({[permission]:false});
   await as('manager',async()=>{
    await denied(()=>save(type,permission+'new',p));
    await denied(()=>save(type,permission,{...p,notes:'changed'},1));
    if(type==='husbandry_events')await denied(()=>save(type,permission,{event_type:'cage_assignment'},1));
   });
  }
  await allow({experiments:false});
  await as('manager',()=>denied(()=>save('husbandry_events','nested',{event_type:'cage_assignment',experiment_sample:{}})));
  await allow({genetics:false});
  await as('manager',()=>denied(()=>save('husbandry_events','plan',{event_type:'breeding_plan',breeding_plan:{}})));
  await allow({breeding:false});
  await as('manager',()=>denied(()=>save('husbandry_events','options',{event_type:'breeding_options',breeding_options:{}})));
  await allow({fees:false});
  for(const key of ['lac_fee_options','lac_fee_month'])await as('manager',()=>denied(()=>save('husbandry_events','hidden-'+key,{event_type:'cage_assignment',[key]:{}})));
 }finally{await db.close()}
});

test('archive/restore and bulk imports need their explicit permissions, while source review stays possible',async()=>{
 const {db,as,save,allow}=await fixture();try{
  await allow({archive:false,imports:false});
  await as('manager',async()=>{
   await save('mice','normal',{record_origin:'app_created',app_archived_at:null});
   await denied(()=>save('mice','normal',{record_origin:'app_created',app_archived_at:null},1,true));
   await denied(()=>save('mice','normal',{record_origin:'app_created',app_archived_at:'2026-10-14'},1));
   await denied(()=>save('mice','imported',{record_origin:'softmouse_export'}));
   await save('husbandry_events','reviewed',{event_type:'experiment',record_origin:'app_created',source_id:'a',experiment:{title:'Reviewed source'}});
  });
  await allow();await as('manager',()=>save('mice','normal',{record_origin:'app_created',app_archived_at:'2026-10-14'},1,true));
  await allow({archive:false});await as('manager',()=>denied(()=>save('mice','normal',{record_origin:'app_created',app_archived_at:null},2,false)));
  await allow({experiments:false});
  await as('manager',()=>denied(()=>save('archive','reconstruction',{format:'braintime-colony-archive-manifest-v1',tables:{}})));
 }finally{await db.close()}
});

test('batch denial is atomic, viewers stay read-only, inactive managers fail and aliases are owner-only',async()=>{
 const {db,as,save,allow}=await fixture();try{
  await allow({experiments:false});
  const changes=[{entity_type:'mice',entity_id:'batch',payload:{mouse_sid:'batch'},expected_version:0},{entity_type:'husbandry_events',entity_id:'exp',payload:{event_id:'exp',event_type:'experiment',experiment:{}},expected_version:0}];
  await as('manager',()=>denied(()=>db.query('select * from public.save_records($1,$2)',[ids.colony,JSON.stringify(changes)])));
  assert.equal((await db.query("select * from entity_records where entity_id='batch'")).rows.length,0);
  for(const role of ['manager','editor'])await as(role,()=>denied(()=>save('husbandry_events','alias-'+role,{event_type:'user_acronym_definition',user_acronym:{code:'XX',name:'Example'}})));
  await as('owner',()=>save('husbandry_events','alias-owner',{event_type:'user_acronym_definition',user_acronym:{code:'XX',name:'Example'}}));
  await as('viewer',()=>denied(()=>save('mice','viewer')));
  await as('outside',()=>denied(()=>save('mice','outsider')));
  await as('editor',()=>save('mice','editor'));
  await db.query('update memberships set active=false where user_id=$1',[ids.manager]);
  await as('manager',()=>denied(()=>save('mice','inactive')));
  await as(null,()=>denied(()=>save('mice','anon')),'anon');
 }finally{await db.close()}
});

test('mouse and breeder fields cannot bypass housing, genetics or parentage restrictions',async()=>{
 const {db,as,save,allow}=await fixture();try{
  const p={genotype:'P',genetic_profile:{loci:[]},mouseline:'PER2',cage_sid:'C1',cage_tag:'Cage1',sire_sids:['S1'],dam_sids:[],litter_sid:'L1'};
  await as('owner',()=>save('mice','linked',p));
  for(const [permission,changes]of [['housing',{cage_sid:'C2',cage_tag:'Cage2'}],['genetics',{genotype:'B',genetic_profile:{other:true},mouseline:'Bmal1'}],['breeding',{sire_sids:['S2'],dam_sids:['D1'],litter_sid:'L2'}]]){
   await allow({[permission]:false});
   for(const [key,value]of Object.entries(changes))await as('manager',async()=>{
    await denied(()=>save('mice','linked',{...p,[key]:value},1));
    await denied(()=>save('mice','new-'+key,{[key]:value}));
    const removed={...p};delete removed[key];
    // Removing an existing non-empty cross-domain field is also a change.
    if(p[key]!==undefined)await denied(()=>save('mice','linked',removed,1));
   });
  }
  await allow({housing:false});
  await as('manager',()=>denied(()=>save('matings','mating-cage',{cage_sid:'C2'})));
  await allow({housing:false,genetics:false,breeding:false});
  await as('manager',()=>save('mice','unassigned',{genotype:null,cage_sid:null,sire_sids:[],dam_sids:[]}));
  await as('manager',()=>save('mice','linked',{...p,notes:'Ordinary mouse note'},1));
 }finally{await db.close()}
});

test('maintained fee patch includes exact classifier/projector and two private IACUC helpers',async()=>{
 const {db,as,save,allow}=await fixture();try{
  const patch=await readFile(new URL('../fees-hardening.sql',import.meta.url),'utf8'),manager=await readFile(new URL('../manager-permissions.sql',import.meta.url),'utf8'),report=await readFile(new URL('../export-permissions.sql',import.meta.url),'utf8');
  const classifier=source=>source.match(/create or replace function colony_private\.record_permissions\(kind text,p jsonb\)[\s\S]*?revoke all on function colony_private\.record_permissions\(text,jsonb\) from public,anon,authenticated;/)?.[0];
  const projector=source=>source.match(/create or replace function colony_private\.export_payload\(kind text,p jsonb\)[\s\S]*?revoke all on function colony_private\.export_payload\(text,jsonb\) from public,anon,authenticated;/)?.[0];
  assert.equal(classifier(patch),classifier(manager));assert.equal(projector(patch),projector(report));assert.equal((patch.match(/create or replace function/g)||[]).length,4);assert(!/alter table|insert into|update public|delete from/i.test(patch));
  await db.exec(patch);await db.exec(patch);await allow({fees:false});await as('manager',()=>denied(()=>save('husbandry_events','hidden-fees',{event_type:'cage_note',lac_fee_options:{rate:12}})));
 }finally{await db.close()}
});
