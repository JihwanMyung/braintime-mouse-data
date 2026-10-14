import {PGlite} from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {projectRecords} from '../functions/sync-animal-sheet/projection.mjs';

const db=new PGlite();
const colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const source=await readFile(new URL('../sheet-sync.sql',import.meta.url),'utf8');
// The private deployment artifact is available locally; public checkouts exercise
// the same CREATE OR REPLACE definition from the canonical source instead.
let migration;
try{migration=await readFile(new URL('../../../work/deployment/sheet-sync/04-optimize-snapshot.sql',import.meta.url),'utf8');}
catch(error){if(error.code!=='ENOENT')throw error;migration=source;}
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table public.colonies(id uuid primary key);
create table public.entity_records(colony_id uuid,entity_type text,entity_id text,payload jsonb,version integer default 1,archived boolean default false,primary key(colony_id,entity_type,entity_id));`);
await db.query('insert into public.colonies values($1),($2)',[colony,other]);
await db.exec(source);
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const records=(type,items,id)=>items.map(payload=>({entity_type:type,entity_id:payload[id],payload,version:1,archived:false}));
async function insert(rows,id=colony){
  await db.query(`insert into public.entity_records select $1,x.* from jsonb_to_recordset($2::jsonb)
    as x(entity_type text,entity_id text,payload jsonb,version integer,archived boolean)`,[id,JSON.stringify(rows)]);
}
async function as(role,fn){await db.exec(`set role ${role}`);try{return await fn();}finally{await db.exec('reset role');}}
const claim=async()=> (await db.query('select public.claim_sheet_sync($1) token',[colony])).rows[0].token;
const compact=async token=>(await db.query('select public.sheet_sync_snapshot($1,$2) data',[colony,token])).rows[0].data;
// Exact former aggregate, used as the output-equivalence baseline.
const full=async()=> (await db.query(`select coalesce(jsonb_agg(jsonb_build_object('entity_type',entity_type,'entity_id',entity_id,
  'payload',payload,'version',version,'archived',archived) order by entity_type,entity_id),'[]'::jsonb) records
  from public.entity_records where colony_id=$1 and entity_type<>'archive'`,[colony])).rows[0].records;
let token=await claim();

await test('SQL replacement preserves held lock, function definition and service-only access',async()=>{
  const definition=async()=>(await db.query("select pg_get_functiondef('public.sheet_sync_snapshot(uuid,uuid)'::regprocedure) definition")).rows[0].definition;
  const before=await definition();await db.exec(migration);assert.equal(await definition(),before);
  assert.equal((await db.query('select lock_token from public.sheet_sync_state where colony_id=$1',[colony])).rows[0].lock_token,token);
  for(const role of ['anon','authenticated'])await as(role,()=>assert.rejects(compact(token),error=>error.code==='42501'));
  assert.equal(await as('service_role',()=>compact(other)),null);
  const empty=await as('service_role',()=>compact(token));assert.deepEqual(empty.records,[]);assert(empty.captured_at);
});

await test('Projection fields, archival rules, date boundaries and more than 1000 rows remain equivalent',async()=>{
  const shared={source_url:'https://example.test/source',source_file:'file.xlsx',source_filename:'fallback.xlsx',unused_history:{large:'unneeded'.repeat(1000)}};
  const mice=records('mice',Array.from({length:1101},(_,i)=>({...shared,mouse_sid:String(i+1).padStart(5,'0'),state:'Stock',physical_tag:'=literal tag',sex:'F',genotype:null,date_of_birth:'2026-01-01',cage_sid:'C1',cage_tag:'mouse fallback',status:'Available',sire_sids:['00000'],dam_sids:['D1','D2'],protocol:'P1',comment:'Original'})),'mouse_sid');
  mice.push(...records('mice',[{...mice[0].payload,mouse_sid:'ENDED',state:'Ended'},{...mice[0].payload,mouse_sid:'APP-ARCHIVED',app_archived_at:'2026-10-01T00:00:00Z'}],'mouse_sid'));
  mice.push({...mice[0],entity_id:'ARCHIVED',payload:{...mice[0].payload,mouse_sid:'ARCHIVED'},archived:true});
  await insert([...mice,
    ...records('rooms',[{...shared,room_id:'R1',name:'Room name',label:'Room label'},{room_id:'R2',label:'Fallback room'}],'room_id'),
    ...records('racks',[{rack_id:'K1',room_id:'R1',name:'Rack name',label:'Rack label'},{rack_id:'K2',room_id:'R2',label:'Fallback rack'}],'rack_id'),
    ...records('locations',[{...shared,location_id:'L1',room_id:'R1',rack_id:'K1',label:'Position',source_label:'Source position',row:1,column:2,source_observed_mouse_sids:['00001'],source_candidate_mouse_sids:['00404'],source_observed_tags:['source tag'],source_observed_cage_sids:['C1'],source_candidate_cage_sids:['C404'],evidence_status:'uncertain',notes:'Position notes',source_block_text:'Original block',source_snapshot_date:'2026-10-01'},{location_id:'L2',rack_id:'K2',source_label:'Fallback position',source_file:'map.xlsx'}],'location_id'),
    ...records('cages',[{...shared,cage_sid:'C1',cage_tag:'tag',state:'Ended',room_id:'R1',rack_id:'K1',location_id:'L1',room:'Legacy room',rack:'Legacy rack',location:'Legacy position',cage_type:'Breeding',capacity:5,comment:'Cage note'},{cage_sid:'C2',state:'Active',room:'Fallback room',rack:'Fallback rack',location:'Fallback position',source_filename:'cages.xlsx'},{cage_sid:'C3',state:'Ended',location_id:'L2'}],'cage_sid'),
    ...records('light_events',[{...shared,event_id:'E1',location_id:'L1',start_date:'2026-10-01',end_date:'2026-10-14',protocol:'LD',cycle_hours:24,light_hours:12,lights_on:'06:00',lights_off:'18:00',transition_minutes:30,intensity_lux:100,timezone:'Asia/Taipei',evidence_status:'recorded',actual_exposure_verified:true,notes:'Light note',interval_semantics:'end exclusive: next phase start'},{event_id:'E2',room_id:'R1',start_date:'2026-10-14',protocol:'DD',light_hours:0,cycle_hours:24,source_file:'light.xlsx'},{event_id:'E3',cage_sid:'C3',protocol:'Undated cage observation',notes:'Unknown start'},{event_id:'E4',location_id:'L2',start_date:'2026-12-01',protocol:'Future'}],'event_id'),
    {entity_type:'matings',entity_id:'M1',payload:{mating_sid:'M1'},version:1,archived:false},
    {entity_type:'litters',entity_id:'T1',payload:{litter_sid:'T1'},version:1,archived:false},
    {entity_type:'husbandry_events',entity_id:'H1',payload:{event_id:'H1'},version:1,archived:false},
    {entity_type:'archive',entity_id:'reconstruction',payload:{preserved:true},version:1,archived:false}
  ]);
  await insert(records('mice',[{mouse_sid:'OTHER',state:'Stock'}],'mouse_sid'),other);
  const baseline=await full(),snapshot=await compact(token);
  assert(snapshot.records.length>1000);assert(!snapshot.records.some(r=>r.entity_id==='ENDED'||r.entity_id==='OTHER'||r.payload.unused_history));
  assert.equal(snapshot.records.find(r=>r.entity_id==='00001').payload.mouse_sid,'00001');
  for(const date of ['2026-10-13T14:00:00Z','2026-10-13T16:00:00Z','2026-12-01T00:00:00Z'])assert.deepEqual(projectRecords(snapshot.records,date),projectRecords(baseline,date));
  const original=(await db.query("select payload from public.entity_records where colony_id=$1 and entity_type='mice' and entity_id='00001'",[colony])).rows[0].payload;
  await db.query("update public.entity_records set payload=jsonb_set(payload,'{comment}',to_jsonb('Administrative sync verification'::text)),version=2 where colony_id=$1 and entity_type='mice' and entity_id='00001'",[colony]);
  const after=await compact(token);assert.equal(after.records.find(r=>r.entity_id==='00001').version,2);
  assert.deepEqual(projectRecords(after.records,'2026-10-14'),projectRecords(await full(),'2026-10-14'));
  const saved=(await db.query("select payload from public.entity_records where colony_id=$1 and entity_type='mice' and entity_id='00001'",[colony])).rows[0].payload;
  assert.deepEqual({...saved,comment:original.comment},original);
});

await test('Final private reconstruction produces identical five grids with a bounded snapshot',async t=>{
  let dataset;try{dataset=JSON.parse(await readFile(new URL('../../../outputs/reconstruction_2026-10-14/dataset_augmented.json',import.meta.url),'utf8'));}catch(error){if(error.code==='ENOENT'){t.skip('Private reconstruction fixture is absent');return;}throw error;}
  await db.query('delete from public.entity_records where colony_id=$1',[colony]);
  const ids={mice:'mouse_sid',matings:'mating_sid',litters:'litter_sid',cages:'cage_sid',rooms:'room_id',racks:'rack_id',locations:'location_id',light_events:'event_id',husbandry_events:'event_id'};
  await insert(Object.entries(ids).flatMap(([type,id])=>records(type,dataset.tables[type]||[],id)));
  const fullStarted=performance.now(),baseline=await full(),fullMs=performance.now()-fullStarted;
  const compactStarted=performance.now(),snapshot=await compact(token),compactMs=performance.now()-compactStarted;
  assert.equal(baseline.length,8540);assert.equal(snapshot.records.length,4805);
  for(const date of ['2026-10-14T00:00:00Z','2027-01-01T00:00:00Z'])assert.deepEqual(projectRecords(snapshot.records,date),projectRecords(baseline,date));
  assert(bytes(snapshot.records)<2_500_000);assert(bytes(snapshot.records)<bytes(baseline)*0.25);
  console.log(JSON.stringify({fixture:'final augmented reconstruction',fullRows:baseline.length,fullBytes:bytes(baseline),compactRows:snapshot.records.length,compactBytes:bytes(snapshot.records),fullMs:Math.round(fullMs),compactMs:Math.round(compactMs),projectionEquivalent:true,timingScope:'local PGlite, not a hosted latency guarantee'}));
});
await db.close();
