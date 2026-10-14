import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids=Object.fromEntries(['owner','editor','manager','viewer','outside'].map((name,i)=>[name,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;`);
for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3)',[colony,'IACUC test',ids.owner]);
for(const name of ['owner','editor','manager','viewer'])await db.query('insert into public.memberships(colony_id,user_id,role) values($1,$2,$3)',[colony,ids[name],name]);
// Simulate the already-deployed legacy nine-flag records before the additive patch.
await db.exec("alter table public.memberships drop constraint memberships_permissions_check;update public.memberships set permissions=permissions-'iacuc'");
const migration=await readFile(new URL('../iacuc.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
async function as(name,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids[name]||'']);try{return await fn()}finally{await db.exec('reset role');await db.exec("select set_config('request.jwt.claim.sub','',false)")}}
const denied=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true});
const save=(p,version=0,archived=false,kind='husbandry_events')=>db.query('select * from public.save_record($1,$2,$3,$4,$5,$6)',[colony,kind,p.event_id,p,version,archived]);
const record=(type,id,body,date='2026-10-15')=>({event_id:id,event_type:type,event_date:date,record_origin:'app_created',[type]:{schema_version:1,protocol_id:'P1',...body}});
const protocol=(id='P1',extra={})=>record('iacuc_protocol',id,{protocol_id:id,number:'SYNTHETIC-01',aliases:['OLD-01'],title:'Synthetic protocol',status:'approved',start_date:'2026-01-01',end_date:'2027-01-01',approved_animals:100,allocations:[{id:'A1',species:'Mouse',strain:'Synthetic',approved:100,portal_used:10,portal_pending:3,portal_remaining:87}],document:{filename:'protocol.pdf',sha256:'a'.repeat(64),text:'PRIVATE DOCUMENT',source_url:'https://example.org/private'},sections:{aims:'PRIVATE AIMS',personnel:'PRIVATE PERSONNEL'},notes:'PRIVATE NOTES',...extra});
const usage=(id='U1',extra={})=>record('iacuc_usage',id,{category:'used',mouse_sids:['M1','M2'],unregistered_count:2,event_date:'2026-10-15',evidence_status:'confirmed',...extra});
const setFlag=value=>as('owner',()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,null,$5)',[colony,ids.manager,'manager','update',{iacuc:value}]));
await test('additive migration fills only missing IACUC flag and preserves explicit denials',async()=>{
 assert((await db.query('select permissions from public.memberships')).rows.every(r=>r.permissions.iacuc===true));await setFlag(false);await db.exec(migration);assert.equal((await db.query('select permissions from public.memberships where user_id=$1',[ids.manager])).rows[0].permissions.iacuc,false);
 await as('manager',()=>denied(()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,null,$5)',[colony,ids.manager,'manager','update',{iacuc:true}])));
});
await test('IACUC permissions cover new edits, nested disguise, retyping and full imports',async()=>{
 await as('owner',()=>save(protocol()));await as('editor',()=>save(usage()));
 await as('manager',async()=>{await denied(()=>save(protocol('P2')));await denied(()=>save({...protocol(),notes:'changed'},1));await denied(()=>save({event_id:'HIDDEN',event_type:'cage_note',iacuc_usage:{} }));await denied(()=>save({event_id:'P1',event_type:'cage_note'},1));await denied(()=>save({event_id:'reconstruction',format:'braintime-colony-archive-manifest-v1',tables:{}},0,false,'archive'));});
 for(const who of ['viewer','outside'])await as(who,()=>denied(()=>save(protocol('P-'+who))));await as(null,()=>denied(()=>save(protocol('P-anon'))),'anon');
 await setFlag(true);await as('manager',()=>save(record('iacuc_assignment','A1',{entity_type:'mice',entity_id:'M1',purpose:'experiment',valid_from:'2026-01-01',valid_to:null,evidence_status:'source',source_refs:[]})));
 await as('owner',()=>denied(()=>save({event_id:'P1',event_type:'cage_note'},1),'22023'));
 await as('viewer',async()=>assert((await db.query("select * from public.entity_records where entity_id='P1'")).rows[0].payload.iacuc_protocol.document.text==='PRIVATE DOCUMENT'));
 await as('outside',async()=>assert.equal((await db.query('select * from public.entity_records')).rows.length,0));
});
await test('legacy protocol references on mouse/cage/breeding and experiment forms require IACUC permission',async()=>{
 await setFlag(false);
 const cases=[['mice','mouse_sid',{protocol:'P1'}],['cages','cage_sid',{cage_protocol:'P1'}],['cages','cage_sid',{protocol:'P1'}],['matings','mating_sid',{protocol:'P1'}],['litters','litter_sid',{protocol:'P1'}],['husbandry_events','event_id',{event_type:'experiment',experiment:{protocol:'P1'}}],['husbandry_events','event_id',{event_type:'experiment_sample',experiment_sample:{protocol:'P1'}}]];
 for(const [i,[kind,key,fields]] of cases.entries()){
  const id='REF'+i,p={event_id:id,[key]:id,...fields};await as('owner',()=>save(p,0,false,kind));
  await as('manager',async()=>{await denied(()=>save({...p,event_id:'NEW'+i,[key]:'NEW'+i},0,false,kind));await denied(()=>save({event_id:id,[key]:id},1,false,kind));await save({...p,notes:'Ordinary edit with unchanged protocol'},1,false,kind);});
 }
 await setFlag(true);
});
await test('typed validation rejects invalid identifiers, amounts, dates, documents and duplicate counted mice',async()=>{
 const cases=[protocol('BAD-URL',{source_url:'javascript:alert(1)'}),protocol('BAD-DOC-URL',{document:{source_url:'https://user:pass@example.org'}}),protocol('BAD-ID',{protocol_id:'different'}),protocol('BAD-COUNT',{approved_animals:-1}),protocol('BAD-FRACTION',{approved_animals:1.5}),protocol('BAD-DATE',{start_date:'2026-02-30'}),protocol('BAD-END',{end_date:'2025-01-01'}),protocol('BAD-STATUS',{status:'renewed'}),protocol('BAD-ALLOC',{allocations:[{id:'A',approved:2},{id:'A',approved:4}]}),protocol('BAD-HASH',{document:{sha256:'bad',text:'hello'}}),protocol('BAD-LENGTH',{document:{text:'x'.repeat(300001)}}),protocol('BAD-SECTIONS',{sections:{aims:{nested:'not text'}}}),usage('DUP',{mouse_sids:['M1','M1']}),usage('DATE',{event_date:'2026-10-14'}),usage('NEGATIVE',{unregistered_count:-1}),usage('BAD-SIDS',{mouse_sids:[3]}),record('iacuc_assignment','BAD-TARGET',{entity_type:'users',entity_id:'u',purpose:'experiment',evidence_status:'confirmed'}),record('iacuc_design','BAD-DESIGN',{inputs:[],results:{}})];
 for(const p of cases)await as('owner',()=>denied(()=>save(p),'22023'));
 const p={mouse_sid:'HIDDEN',event_id:'HIDDEN',event_type:'normal',iacuc_protocol:{}};await as('owner',()=>denied(()=>save(p,0,false,'mice'),'22023'));
 await as('owner',()=>save(protocol('OVER',{allocations:[{id:'A',approved:10,portal_used:12,portal_remaining:-2}]})));
});
await test('CAS and batch validation preserve atomicity and original records',async()=>{
 await as('owner',()=>denied(()=>save({...protocol(),notes:'stale'},0),'40001'));
 const changes=[{entity_type:'husbandry_events',entity_id:'BATCH-GOOD',payload:protocol('BATCH-GOOD'),expected_version:0},{entity_type:'husbandry_events',entity_id:'BATCH-BAD',payload:usage('BATCH-BAD',{mouse_sids:['M','M']}),expected_version:0}];
 await as('owner',()=>denied(()=>db.query('select * from public.save_records($1,$2)',[colony,changes]),'22023'));assert.equal((await db.query("select * from public.entity_records where entity_id like 'BATCH-%'")).rows.length,0);
});
await test('bounded protocol/usage/design reports omit source narratives and retain safe counts with truncation flags',async()=>{
 const safe=(await db.query('select colony_private.export_payload($1,$2) p',['husbandry_events',protocol()])).rows[0].p;assert(!JSON.stringify(safe).includes('PRIVATE'));assert(!safe.iacuc_protocol.document);assert(!safe.iacuc_protocol.sections);assert.equal(safe.iacuc_protocol.allocations[0].portal_remaining,87);assert.equal(safe.iacuc_protocol.allocation_count,1);
 const many=usage('MANY',{mouse_sids:Array.from({length:105},(_,i)=>'M'+i)}),out=(await db.query('select colony_private.export_payload($1,$2) p',['husbandry_events',many])).rows[0].p.iacuc_usage;assert.equal(out.mouse_count,105);assert.equal(out.mouse_sids.length,100);assert.equal(out.mouse_sids_truncated,true);assert.equal(out.unregistered_count,2);
 const design=record('iacuc_design','DESIGN',{label:'Test design',title:'Study',method:'pooled_noncentral_t',breeding_inputs:{target:20,genotypeProbability:.25,notes:'PRIVATE'},breeding_results:{confidence_offspring:100,achieved_probability:.95,notes:'PRIVATE'},inputs:{design:'independent',effect:1,sd:2,notes:'PRIVATE',cluster:{animalsPerCage:4,icc:.1,source:'PRIVATE'}},results:{status:'ok',n1:10,n2:10,notes:'PRIVATE',warnings:['Approximate'],adjustment:{animals_per_group:[12,12],total_animals:24,source:'PRIVATE',cluster:{cages_per_group:[3,3],icc:.1,extra:'PRIVATE'}}}});await as('editor',()=>save(design));const projected=(await db.query('select colony_private.export_payload($1,$2) p',['husbandry_events',design])).rows[0].p;assert(!JSON.stringify(projected).includes('PRIVATE'));assert.deepEqual(projected.iacuc_design.results.adjustment.animals_per_group,[12,12]);assert.deepEqual(projected.iacuc_design.results.adjustment.cluster.cages_per_group,[3,3]);assert.equal(projected.iacuc_design.inputs.effect,1);assert.equal(projected.iacuc_design.title,'Study');assert.equal(projected.iacuc_design.breeding_inputs.genotypeProbability,.25);assert.equal(projected.iacuc_design.breeding_results.confidence_offspring,100);
});
await test('history cutoffs use biological protocol/usage dates, never access or edit timestamps',async()=>{
 const date=(await db.query("select to_char(current_date-interval '4 years','YYYY-MM-DD') d")).rows[0].d;
 const old=record('iacuc_usage','OLD',{category:'used',mouse_sids:['M-OLD'],unregistered_count:0,event_date:date,evidence_status:'source',source_accessed_at:new Date().toISOString()},date);await as('owner',()=>save(old));
 const undated=record('iacuc_usage','UNDATED',{category:'used',mouse_sids:['M-UNKNOWN'],unregistered_count:0,event_date:null,evidence_status:'unresolved'},null);await as('owner',()=>save(undated));
 const report=()=>db.query("select public.export_records($1,'history',null,null,array['husbandry_events'],0,250) p",[colony]).then(r=>r.rows[0].p);
 const low=await as('viewer',report);assert(!low.rows.some(r=>['OLD','UNDATED'].includes(r.entity_id)));await as('owner',()=>db.query('select * from public.manage_colony_member($1,$2,$3,true,$4,$5)',[colony,ids.viewer,'viewer','update','high']));const high=await as('viewer',report);assert(high.rows.some(r=>r.entity_id==='OLD'));assert(!high.rows.some(r=>r.entity_id==='UNDATED'));const max=await as('owner',report);assert(max.rows.some(r=>r.entity_id==='UNDATED'));assert(!JSON.stringify(max).includes('PRIVATE DOCUMENT'));
});
await test('housing report preserves withdrawal and resolved manager state without raw source blocks',async()=>{
 const location={location_id:'L',source_current:false,source_last_seen_at:'2026-10-14',source_manager_name:'Example User',source_manager_acronym:'EX',source_manager_status:'resolved',source_manager_raw:'RAW PRIVATE',source_block_text:'RAW PRIVATE'};const result=(await db.query("select colony_private.export_payload('locations',$1) p",[location])).rows[0].p;assert.equal(result.source_current,false);assert.equal(result.source_manager_acronym,'EX');assert.equal(result.source_manager_status,'resolved');assert.equal(result.source_last_seen_at,'2026-10-14');assert(!JSON.stringify(result).includes('RAW PRIVATE'));
});
await db.close();
