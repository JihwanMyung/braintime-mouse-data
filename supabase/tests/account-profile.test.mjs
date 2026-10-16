import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite(),colony='57a26815-ca94-413b-891a-e0e85ff59d69',foreign='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const names=['owner','new','current','review','historical','archived','disabled','unverified','anonymous','banned','deleted','linked','other','emailchanged','foreignOwner','directHigh','directManager','directViewer','selfInvited','selfComplete','ownerReview','grantedThenDisabled','closedInvited','closedFresh','selfReReviewed','selfReviewKept'];
const ids=Object.fromEntries(names.map((name,i)=>[name,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_user_meta_data jsonb default '{}',is_anonymous boolean default false,banned_until timestamptz,deleted_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
for(const name of names)await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password,is_anonymous,banned_until,deleted_at) values($1,$2,$3,$4,$5,$6,$7)',[ids[name],name.toLowerCase()+'@example.org',name==='unverified'?null:'2026-01-01T00:00:00Z','synthetic-hash',name==='anonymous',name==='banned'?'2099-01-01T00:00:00Z':null,name==='deleted'?'2026-01-01T00:00:00Z':null]);
for(const path of ['schema.sql','functions/manage-colony-users/membership.sql','export-permissions.sql','manager-permissions.sql','lab-members.sql','account-acronym.sql'])await db.exec(await readFile(new URL('../'+path,import.meta.url),'utf8'));
await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3),($4,$5,$6)',[colony,'Profile test',ids.owner,foreign,'Other lab',ids.foreignOwner]);
for(const [name,role,active,lab] of [['owner','owner',true,colony],['disabled','editor',false,colony],['linked','editor',true,colony],['emailchanged','viewer',true,colony],['foreignOwner','owner',true,foreign]])await db.query('insert into public.memberships(colony_id,user_id,role,active,updated_by) values($1,$2,$3,$4,$5)',[lab,ids[name],role,active,ids.owner]);
async function as(name,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[name?ids[name]:'']);try{return await fn();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
const rpc=async(name,args)=>{const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');return(await db.query(`select public.${name}(${placeholders}) result`,args)).rows[0].result;};
const get=(lab=colony)=>rpc('get_my_lab_member',[lab]);
const submit=(data,version,lab=colony)=>rpc('submit_my_lab_profile',[lab,data,version]);
const ownerSave=data=>as('owner',()=>rpc('save_lab_member',[colony,data]));
const denied=(fn,code='42501')=>assert.rejects(fn,error=>error.code===code);
const migration=await readFile(new URL('../account-profile.sql',import.meta.url),'utf8');
for(const name of ['current','review','historical','archived','disabled','unverified','anonymous','banned','deleted','linked','emailchanged'])await ownerSave({version:0,name:'Recorded '+name,email:name+'@example.org',status:['review','historical'].includes(name)?name:'current',archived:name==='archived',intended_role:name==='current'?'manager':'editor',export_level:name==='current'?'max':'low',notes:'PRIVATE OWNER NOTE',provenance:{private:'PRIVATE SOURCE'}});
await db.query('update public.lab_members set username=$1,linked_user_id=$2 where colony_id=$3 and email=$4',['linked.user',ids.linked,colony,'linked@example.org']);
await db.query('update public.lab_members set username=$1,linked_user_id=$2 where colony_id=$3 and email=$4',['old.email',ids.emailchanged,colony,'emailchanged@example.org']);
await db.query('update auth.users set email=$1 where id=$2',['new-email@example.org',ids.emailchanged]);
await db.exec(migration);await db.exec(migration);

await test('migration is rerunnable, private allowlist defaults closed and self reads have no writes',async()=>{
 const settings=(await db.query('select * from colony_private.account_profile_registration')).rows;assert.deepEqual(settings,[{colony_id:colony,enabled:true}]);
 const before=(await db.query('select count(*) n from public.lab_member_audit')).rows[0].n;
 const result=await as('new',()=>get());assert.equal(result.eligible,false);assert.equal(result.registration_allowed,true);assert.equal(result.setup_required,false);assert.equal(result.reason,'profile_required');assert.equal(result.member.version,0);assert.equal(result.member.email,'new@example.org');assert.equal(result.member.name,'');assert.equal(result.member.effective_role,null);
 assert.equal((await db.query('select count(*) n from public.lab_member_audit')).rows[0].n,before);
 await as('new',async()=>{assert.equal((await get(foreign)).registration_allowed,false);await denied(()=>submit({name:'No'},0,foreign));await denied(()=>db.query('select * from colony_private.account_profile_registration'));assert.equal((await db.query('select * from public.lab_members')).rows.length,0);assert.equal((await db.query('select * from public.lab_member_audit')).rows.length,0);});
 await as(null,()=>denied(()=>get()),'anon');await as(null,()=>denied(()=>submit({name:'No'},0)),'anon');
});

await test('verified new person submits Review profile only, with server email and private actor audit',async()=>{
 const memberships=(await db.query('select * from public.memberships order by colony_id,user_id')).rows,accounts=(await db.query('select * from auth.users order by id')).rows;
 const result=await as('new',()=>submit({name:' New Scientist ',phone:' +886 12345 ',acronym:'ns',category:'phd'},0));
 assert.equal(result.eligible,false);assert.equal(result.setup_required,false);assert.equal(result.registration_allowed,true);assert.equal(result.reason,'approval_pending');assert.equal(result.member.status,'review');assert.equal(result.member.version,1);assert.equal(result.member.name,'New Scientist');assert.equal(result.member.phone,'+886 12345');assert.equal(result.member.acronym,'NS');assert.equal(result.member.email,'new@example.org');assert.equal(result.member.effective_role,null);assert.equal(result.member.effective_export_level,null);
 const saved=(await db.query('select * from public.lab_members where person_id=$1',[result.member.person_id])).rows[0];assert.equal(saved.linked_user_id,null);assert.equal(saved.username,null);assert.equal(saved.intended_role,'editor');assert.equal(saved.export_level,'low');assert.equal(saved.created_by,ids.new);
 assert.deepEqual((await db.query('select * from public.memberships order by colony_id,user_id')).rows,memberships);assert.deepEqual((await db.query('select * from auth.users order by id')).rows,accounts);
 const audit=(await db.query('select * from public.lab_member_audit where person_id=$1 order by audit_id desc limit 1',[saved.person_id])).rows[0];assert.equal(audit.actor_id,ids.new);assert.equal(audit.operation,'INSERT');
 await as('new',()=>denied(()=>rpc('complete_lab_member_setup',[colony,'new.scientist'])));
});

await test('self updates use CAS, omit sensitive owner fields and preserve roles, status, provenance and audit on no-op',async()=>{
 const original=await as('current',()=>get());assert.equal(original.eligible,true);assert.equal(original.member.effective_role,'manager');assert.equal(original.member.effective_export_level,'max');assert.equal(original.member.notes,undefined);assert.equal(original.member.provenance,undefined);
 const saved=await as('current',()=>submit({name:'Current Scientist',phone:'123',acronym:'CS',category:'postdoc'},original.member.version));assert.equal(saved.member.version,original.member.version+1);assert.equal(saved.member.effective_role,'manager');assert.equal(saved.member.effective_export_level,'max');assert.equal(saved.member.status,'current');
 const raw=(await db.query('select * from public.lab_members where person_id=$1',[saved.member.person_id])).rows[0];assert.equal(raw.notes,'PRIVATE OWNER NOTE');assert.deepEqual(raw.provenance,{private:'PRIVATE SOURCE'});assert.equal(raw.linked_user_id,null);
 await as('current',()=>denied(()=>submit({phone:'stale'},original.member.version),'40001'));
 const count=(await db.query('select count(*) n from public.lab_member_audit')).rows[0].n;
 assert.deepEqual(await as('current',()=>submit({phone:'123'},saved.member.version)),saved);assert.equal((await db.query('select count(*) n from public.lab_member_audit')).rows[0].n,count);
 const linked=await as('linked',()=>get());assert.equal(linked.eligible,true);assert.equal(linked.setup_required,false);assert.equal(linked.registration_allowed,true);const updated=await as('linked',()=>submit({phone:'555'},linked.member.version));assert.equal(updated.member.username,'linked.user');assert.equal(updated.member.effective_role,'editor');
});

await test('unknown, privileged, malformed or oversized fields cannot change a self profile',async()=>{
 const profile=await as('review',()=>get());
 for(const data of [{email:'other@example.org'},{person_id:profile.member.person_id},{username:'admin'},{status:'current'},{intended_role:'owner'},{export_level:'max'},{linked_user_id:ids.owner},{archived:false},{provenance:{}},{notes:'private'},{name:null},{name:''},{name:'x'.repeat(201)},{name:'Line\nName'},{phone:123},{phone:'x'.repeat(81)},{phone:'123\n456'},{acronym:'1BAD'},{acronym:'A'.repeat(13)},{category:'staff'},[],null])await as('review',()=>denied(()=>submit(data,profile.member.version),'22023'));
 await as('review',()=>denied(()=>submit({name:'Okay'},-1),'22023'));
 assert.deepEqual(await as('review',()=>get()),profile);
});

await test('historical, archived, disabled, unverified, anonymous, banned and deleted accounts cannot request or revive access',async()=>{
 for(const name of ['historical','archived','disabled','unverified','anonymous','banned','deleted'])await as(name,async()=>{const result=await get();assert.equal(result.eligible,false,name);assert.equal(result.registration_allowed,false,name);assert.equal(result.member,null,name);await denied(()=>submit({name:'Attempt'},0));await denied(()=>rpc('complete_lab_member_setup',[colony,'no.access']));});
});

await test('changed Auth email or a roster linked to another identity cannot create a second request or edit another person',async()=>{
 await as('emailchanged',async()=>{assert.equal((await get()).reason,'account_conflict');await denied(()=>submit({name:'Attempt'},0));});
 const other=await ownerSave({version:0,name:'Other account',email:'other@example.org',status:'current'});
 await db.query('update public.lab_members set username=$1,linked_user_id=$2 where person_id=$3',['foreign.link',ids.banned,other.member.person_id]);
 await as('other',async()=>{assert.equal((await get()).reason,'account_conflict');await denied(()=>submit({name:'Attempt'},other.member.version));});
});

await test('only owner approval permits Review to complete normal setup, preserving intended role and Max limits',async()=>{
 const pending=await as('new',()=>get());const approved=await ownerSave({person_id:pending.member.person_id,version:pending.member.version,status:'current',intended_role:'manager',export_level:'max'});
 const fresh=await as('new',()=>get());assert.equal(fresh.eligible,true);assert.equal(fresh.setup_required,true);assert.equal(fresh.member.version,approved.member.version);
 await as('new',()=>denied(()=>submit({name:'Old draft'},pending.member.version),'40001'));
 const completed=await as('new',()=>rpc('complete_lab_member_setup',[colony,'new.scientist']));assert.equal(completed.eligible,true);assert.equal(completed.setup_required,false);assert.equal(completed.member.effective_role,'manager');assert.equal(completed.member.effective_export_level,'max');
 const membership=(await db.query('select * from public.memberships where colony_id=$1 and user_id=$2',[colony,ids.new])).rows[0];assert.equal(membership.role,'manager');assert.equal(membership.active,true);
 const historical=await ownerSave({person_id:completed.member.person_id,version:completed.member.version,status:'historical'});assert.equal(historical.member.membership_active,false);
 await as('new',async()=>{assert.equal((await get()).registration_allowed,false);await denied(()=>submit({name:'Revive'},historical.member.version));await denied(()=>rpc('complete_lab_member_setup',[colony,'new.scientist']));});
});

const grantAccess=(name,role='editor',level='high',permissions=null)=>as('owner',()=>rpc('manage_colony_member',[colony,ids[name],role,true,'add',level,permissions]));
const membership=name=>db.query('select * from public.memberships where colony_id=$1 and user_id=$2',[colony,ids[name]]).then(result=>result.rows[0]);
await test('direct owner invitations count as approval and profile/setup preserve exact granted access',async()=>{
 for(const [name,role,level,permissions] of [['directHigh','editor','high',null],['directManager','manager','max',{imports:false,archive:false}],['directViewer','viewer','low',null]]){
  await grantAccess(name,role,level,permissions);const assigned=await membership(name),auditBefore=(await db.query('select count(*) n from public.audit_log')).rows[0].n;
  const first=await as(name,()=>get());assert.equal(first.eligible,true);assert.equal(first.setup_required,true);assert.equal(first.reason,'profile_required');assert.equal(first.member.version,0);assert.equal(first.member.status,'current');assert.equal(first.member.effective_role,role);assert.equal(first.member.effective_export_level,level);
  // Missing personal details are collected rather than fabricated from the email.
  await as(name,()=>denied(()=>rpc('complete_lab_member_setup',[colony,name.toLowerCase()])));
  const saved=await as(name,()=>submit({name:'Invited '+name,phone:'123',category:'phd'},0));assert.equal(saved.member.status,'current');assert.equal(saved.eligible,true);assert.equal(saved.member.effective_role,role);assert.equal(saved.member.effective_export_level,level);
  const completed=await as(name,()=>rpc('complete_lab_member_setup',[colony,name.toLowerCase()]));assert.equal(completed.eligible,true);assert.equal(completed.setup_required,false);assert.equal(completed.member.effective_role,role);assert.equal(completed.member.effective_export_level,level);
  assert.deepEqual(await membership(name),assigned);assert.equal((await db.query('select count(*) n from public.audit_log')).rows[0].n,auditBefore);
  const roster=(await db.query('select * from public.lab_members where person_id=$1',[completed.member.person_id])).rows[0];assert.equal(roster.intended_role,role);assert.equal(roster.export_level,level);assert.equal(roster.linked_user_id,ids[name]);
  await as(name,()=>rpc('complete_lab_member_setup',[colony,name.toLowerCase()]));assert.deepEqual(await membership(name),assigned);
 }
});

await test('existing self-request Review is reconciled after owner grants membership, but owner Review is not bypassed',async()=>{
 for(const name of ['selfInvited','selfComplete']){
  const waiting=await as(name,()=>submit({name:'Requested '+name,category:'postdoc'},0));assert.equal(waiting.reason,'approval_pending');assert.equal(waiting.eligible,false);assert.equal(await membership(name),undefined);
  await grantAccess(name,'manager','max',{fees:false});const assigned=await membership(name);
  const approved=await as(name,()=>get());assert.equal(approved.eligible,true);assert.equal(approved.setup_required,true);assert.equal(approved.member.effective_role,'manager');assert.equal(approved.member.effective_export_level,'max');
  if(name==='selfInvited'){
   const saved=await as(name,()=>submit({name:waiting.member.name},waiting.member.version));assert.equal(saved.member.status,'current');assert.equal(saved.member.version,waiting.member.version+1);
  }
  const done=await as(name,()=>rpc('complete_lab_member_setup',[colony,name.toLowerCase()]));assert.equal(done.member.status,'current');assert.equal(done.setup_required,false);assert.deepEqual(await membership(name),assigned);
  const roster=(await db.query('select intended_role,export_level from public.lab_members where person_id=$1',[done.member.person_id])).rows[0];assert.deepEqual(roster,{intended_role:'manager',export_level:'max'});
 }
 await ownerSave({version:0,name:'Owner review',email:'ownerreview@example.org',status:'review'});await grantAccess('ownerReview');
 const review=await as('ownerReview',()=>get());assert.equal(review.reason,'approval_pending');assert.equal(review.eligible,false);await as('ownerReview',()=>denied(()=>rpc('complete_lab_member_setup',[colony,'owner.review'])));
 // Legacy rows without a recorded creation method return false, never SQL NULL.
 await db.query("update public.lab_members set created_by=$2,provenance='{}'::jsonb where person_id=$1",[review.member.person_id,ids.ownerReview]);
 const legacy=await as('ownerReview',()=>get());assert.equal(legacy.eligible,false);assert.equal(legacy.setup_required,false);assert.equal(legacy.reason,'approval_pending');
});

await test('current lower roster defaults cannot downgrade existing assigned membership during claim',async()=>{
 const person=await ownerSave({version:0,name:'Current invited manager',email:'closedinvited@example.org',status:'current',intended_role:'viewer',export_level:'low'});
 await grantAccess('closedInvited','manager','max',{mice:false,imports:false});const assigned=await membership('closedInvited');
 const done=await as('closedInvited',()=>rpc('complete_lab_member_setup',[colony,'current.invited']));assert.equal(done.member.effective_role,'manager');assert.equal(done.member.effective_export_level,'max');assert.deepEqual(await membership('closedInvited'),assigned);
 const raw=(await db.query('select intended_role,export_level from public.lab_members where person_id=$1',[person.member.person_id])).rows[0];assert.deepEqual(raw,{intended_role:'manager',export_level:'max'});
});

await test('owner returning or keeping a self-request in Review cannot be bypassed by membership or later profile edits',async()=>{
 for(const name of ['selfReReviewed','selfReviewKept']){
  let profile=await as(name,()=>submit({name:'Requested '+name},0));
  await grantAccess(name,'manager','max',{imports:false});const assigned=await membership(name);
  if(name==='selfReReviewed')profile=await ownerSave({person_id:profile.member.person_id,version:profile.member.version,status:'current'});
  const reviewed=await ownerSave({person_id:profile.member.person_id,version:profile.member.version,status:'review'});
  assert.deepEqual(await membership(name),assigned); // Unclaimed roster edits do not revoke its separate membership.
  const deniedProfile=await as(name,()=>get());assert.equal(deniedProfile.eligible,false);assert.equal(deniedProfile.setup_required,false);assert.equal(deniedProfile.reason,'approval_pending');
  await as(name,()=>denied(()=>rpc('complete_lab_member_setup',[colony,name.toLowerCase()])));
  const edited=await as(name,()=>submit({phone:'555'},reviewed.member.version));assert.equal(edited.member.status,'review');assert.equal(edited.eligible,false);assert.equal(edited.reason,'approval_pending');
  const raw=(await db.query('select updated_by from public.lab_members where person_id=$1',[edited.member.person_id])).rows[0];assert.equal(raw.updated_by,ids[name]);
  await as(name,()=>denied(()=>rpc('complete_lab_member_setup',[colony,name.toLowerCase()])));assert.deepEqual(await membership(name),assigned);
  const approved=await ownerSave({person_id:edited.member.person_id,version:edited.member.version,status:'current'});assert.equal(approved.member.status,'current');
  const done=await as(name,()=>rpc('complete_lab_member_setup',[colony,name.toLowerCase()]));assert.equal(done.eligible,true);assert.equal(done.setup_required,false);assert.deepEqual(await membership(name),assigned);
 }
});

await test('direct access cannot revive blocked identities or override historic and archived roster decisions',async()=>{
 for(const name of ['historical','archived','unverified','anonymous','banned','deleted']){
  await grantAccess(name);await as(name,async()=>{const result=await get();assert.equal(result.eligible,false,name);assert.equal(result.registration_allowed,false,name);await denied(()=>submit({name:'Revive'},0));await denied(()=>rpc('complete_lab_member_setup',[colony,'revive.'+name]));});
 }
 await grantAccess('grantedThenDisabled');const eligible=await as('grantedThenDisabled',()=>get());assert.equal(eligible.eligible,true);
 await as('owner',()=>rpc('manage_colony_member',[colony,ids.grantedThenDisabled,'editor',false,'update','high']));
 await as('grantedThenDisabled',async()=>{assert.equal((await get()).reason,'access_disabled');await denied(()=>submit({name:'Late profile'},0));await denied(()=>rpc('complete_lab_member_setup',[colony,'late.profile']));});
});

await test('explicit disable persists across migration rerun, while existing Current profile access stays available',async()=>{
 await db.query('update colony_private.account_profile_registration set enabled=false where colony_id=$1',[colony]);await db.exec(migration);
 assert.equal((await as('review',()=>get())).registration_allowed,false);assert.equal((await as('current',()=>get())).registration_allowed,true);
 const legacy=await as('ownerReview',()=>get());assert.equal(legacy.eligible,false);assert.equal(legacy.registration_allowed,false);assert.equal(legacy.reason,'not_registered');
 await as('review',()=>denied(()=>submit({name:'No'},1)));
 // Closing unsolicited registration does not revoke previously approved access.
 const granted=await as('directHigh',()=>get());assert.equal(granted.eligible,true);assert.equal(granted.member.effective_export_level,'high');
 await grantAccess('closedFresh');const fresh=await as('closedFresh',()=>get());assert.equal(fresh.eligible,true);assert.equal(fresh.setup_required,true);assert.equal(fresh.registration_allowed,true);
 const saved=await as('closedFresh',()=>submit({name:'Previously approved member'},0));assert.equal(saved.member.status,'current');assert.equal(saved.member.effective_export_level,'high');
});

await test('migration and representative self reads can run inside a rollback verification transaction',async()=>{
 const before=(await db.query('select count(*) n from public.lab_member_audit')).rows[0].n;
 await db.exec('begin');try{await db.exec(migration.replace(/^begin;$/m,'').replace(/^commit;$/m,''));const result=await as('current',()=>get());assert.equal(result.eligible,true);await db.exec('rollback');}catch(error){await db.exec('rollback');throw error;}
 assert.equal((await db.query('select count(*) n from public.lab_member_audit')).rows[0].n,before);
});

await db.close();
