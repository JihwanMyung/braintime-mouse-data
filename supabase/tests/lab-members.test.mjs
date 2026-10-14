import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ids=Object.fromEntries(['owner','editor','viewer','pending','unverified','passwordless','historical','review','disabled','ownerB','second','manager'].map((name,i)=>[name,`${String(i+1).padStart(8,'0')}-1111-4111-8111-111111111111`]));
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
for(const name of Object.keys(ids))await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1,$2,$3,$4)',[ids[name],name+'@example.org',name==='unverified'?null:'2026-01-01T00:00:00Z',name==='passwordless'?'':'synthetic-hash-placeholder']);
await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../functions/manage-colony-users/membership.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../export-permissions.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../manager-permissions.sql',import.meta.url),'utf8')); 
await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3),($4,$5,$6)',[colony,'Roster test',ids.owner,other,'Other lab',ids.ownerB]);
for(const [name,role,lab,active]of [['owner','owner',colony,true],['editor','editor',colony,true],['viewer','viewer',colony,true],['disabled','editor',colony,false],['ownerB','owner',other,true]])await db.query('insert into public.memberships(colony_id,user_id,role,active,updated_by) values($1,$2,$3,$4,$5)',[lab,ids[name],role,active,ids.owner]);
const migration=await readFile(new URL('../lab-members.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
const acronymMigration=await readFile(new URL('../account-acronym.sql',import.meta.url),'utf8');await db.exec(acronymMigration);await db.exec(acronymMigration);
async function as(name,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[name?ids[name]:'']);try{return await fn();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
const rpc=async(name,args=[])=>{const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');return(await db.query(`select public.${name}(${placeholders}) result`,args)).rows[0].result;};
const save=(person,lab=colony)=>rpc('save_lab_member',[lab,person]);
const get=(lab=colony)=>rpc('get_my_lab_member',[lab]);
const complete=(username,lab=colony)=>rpc('complete_lab_member_setup',[lab,username]);
const ownerSave=person=>as('owner',()=>save(person));
const denied=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code);return true;});
let pending;
await test('owner-only roster and private audit reject anonymous, nonowners, inactive and cross-colony access',async()=>{
  const accounts=(await db.query('select count(*) n from auth.users')).rows[0].n,members=(await db.query('select count(*) n from public.memberships')).rows[0].n;
  pending=(await ownerSave({person_id:null,version:0,name:'Pending Scientist',email:' Pending@example.org ',phone:'+886 12345',acronym:'ab',category:'postdoc',status:'current',intended_role:'editor',export_level:'high',notes:'PRIVATE CONTACT NOTE',provenance:{source:'PRIVATE SOURCE'}})).member;
  assert.equal(pending.email,'pending@example.org');assert.equal(pending.acronym,'AB');assert.equal(pending.version,1);assert.equal(pending.linked_user_id,null);
  assert.equal((await db.query('select count(*) n from auth.users')).rows[0].n,accounts);assert.equal((await db.query('select count(*) n from public.memberships')).rows[0].n,members);
  for(const user of ['editor','viewer','pending','disabled','ownerB'])await as(user,async()=>{assert.equal((await db.query('select * from public.lab_members')).rows.length,0);assert.equal((await db.query('select * from public.lab_member_audit')).rows.length,0);await denied(()=>rpc('list_lab_members',[colony]));await denied(()=>save({version:0,name:'No'}));});
  await as(null,async()=>{await denied(()=>db.query('select * from public.lab_members'));await denied(()=>rpc('list_lab_members',[colony]));await denied(()=>get());await denied(()=>complete('nope'));},'anon');
  await as('owner',()=>denied(()=>rpc('list_lab_members',[other])));
  const list=await as('owner',()=>rpc('list_lab_members',[colony]));assert.equal(list.members.length,1);assert.equal(list.members[0].phone,'+886 12345');
  const shared=(await db.query('select before_record,after_record from public.audit_log')).rows;assert(!JSON.stringify(shared).includes('PRIVATE'));assert(!JSON.stringify(shared).includes('+886'));
});
await test('version CAS, partial updates, missing contacts, enum and field validation are enforced',async()=>{
  const row=(await ownerSave({person_id:pending.person_id,version:pending.version,name:'Revised Scientist'})).member;assert.deepEqual(row.provenance,pending.provenance);assert.equal(row.email,pending.email);assert.equal(row.version,2);
  await denied(()=>ownerSave({person_id:pending.person_id,version:1,name:'Stale'}),'40001');pending=row;
  const unknown=(await ownerSave({version:0,name:'Unknown historical member',status:'historical'})).member;assert.equal(unknown.email,null);assert.equal(unknown.category,'unknown');assert.equal(unknown.intended_role,'editor');assert.equal(unknown.export_level,'low');
  for(const input of [{version:0,name:'Bad',intended_role:'owner'},{version:0,name:'Bad',status:'active'},{version:0,name:'Bad',category:'staff'},{version:0,name:'Bad',provenance:[]},{version:0,name:'Bad',linked_user_id:ids.pending},{version:0,name:'Bad',username:'forged'},{version:0,name:'Bad',email:'bad'},{version:0,name:'Bad',archived:'true'},{version:0,name:null}])await denied(()=>ownerSave(input),'22023');
  await denied(()=>ownerSave({version:0,name:'Duplicate',email:'PENDING@example.org'}),'23505');
  await denied(()=>ownerSave({version:0,name:'Duplicate acronym',acronym:'AB',status:'current'}),'23505');
  await as('owner',()=>denied(()=>db.query('update public.lab_members set name=$1 where person_id=$2',['Bypass',pending.person_id])));
});
await test('self lookup exposes only own current preregistration and hides provenance and historical rows',async()=>{
  for(const name of ['historical','review','unverified','passwordless','disabled','second','manager'])await ownerSave({version:0,name,email:name+'@example.org',acronym:name==='manager'?'MG':null,status:['historical','review'].includes(name)?name:'current',intended_role:name==='manager'?'manager':'editor',export_level:name==='manager'?'max':'low',provenance:{secret:'PRIVATE'}});
  const own=await as('pending',()=>get());assert.equal(own.eligible,true);assert.equal(own.setup_required,true);assert.equal(own.reason,'username_required');assert.equal(own.member.email,'pending@example.org');assert.equal(own.member.provenance,undefined);assert.equal(own.member.notes,undefined);
  for(const name of ['historical','review'])assert.deepEqual(await as(name,()=>get()),{member:null,eligible:false,setup_required:false,reason:'not_registered'});
  assert.equal((await as('unverified',()=>get())).reason,'email_unverified');assert.equal((await as('passwordless',()=>get())).reason,'password_required');assert.equal((await as('disabled',()=>get())).reason,'access_disabled');
  assert.equal((await as('pending',()=>get(other))).member,null);
  await db.query("update auth.users set raw_user_meta_data='{"+'"email":"pending@example.org","role":"owner","export_level":"max"'+"}' where id=$1",[ids.review]);
  assert.equal((await as('review',()=>get())).eligible,false);
});
await test('setup requires verified email, a stored Auth password, a current record and enabled access',async()=>{
  for(const name of ['unverified','passwordless','historical','review','disabled'])await as(name,()=>denied(()=>complete('attempt_'+name)));
  await as('pending',()=>denied(()=>complete('9invalid'),'22023'));
});
await test('setup atomically creates membership from roster access and records genuine actor without leaking contacts',async()=>{
  const result=await as('pending',()=>complete('Lab.User'));assert.equal(result.member.username,'lab.user');assert.equal(result.member.effective_role,'editor');assert.equal(result.member.effective_export_level,'high');assert.equal(result.setup_required,false);
  const member=(await db.query('select * from public.memberships where colony_id=$1 and user_id=$2',[colony,ids.pending])).rows[0];assert.equal(member.role,'editor');assert.equal(member.export_level,'high');assert.equal(member.active,true);assert.equal(member.updated_by,ids.pending);
  const privateAudit=(await db.query('select * from public.lab_member_audit where actor_id=$1',[ids.pending])).rows;assert.equal(privateAudit.length,1);
  const publicAudit=(await db.query('select * from public.audit_log where actor_id=$1',[ids.pending])).rows;assert(publicAudit.length);assert(!JSON.stringify(publicAudit).includes('PRIVATE'));assert(!JSON.stringify(publicAudit).includes('pending@example.org'));
  await as('pending',async()=>{assert.equal((await db.query('select * from public.lab_members')).rows.length,0);await denied(()=>save({person_id:pending.person_id,version:3,export_level:'max'}));});
  const count=(await db.query('select count(*) n from public.lab_member_audit')).rows[0].n;await as('pending',()=>complete('lab.user'));assert.equal((await db.query('select count(*) n from public.lab_member_audit')).rows[0].n,count);
});
await test('unique usernames, account binding, and invalid changes cannot cause partial claims',async()=>{
  await as('second',()=>denied(()=>complete('lab.user'),'23505'));
  assert.equal((await db.query('select linked_user_id from public.lab_members where email=$1',['second@example.org'])).rows[0].linked_user_id,null);assert.equal((await db.query('select * from public.memberships where user_id=$1',[ids.second])).rows.length,0);
  await as('pending',()=>denied(()=>complete('another.name'),'22023'));
  const row=(await as('owner',()=>rpc('list_lab_members',[colony]))).members.find(r=>r.email==='pending@example.org');await denied(()=>ownerSave({person_id:row.person_id,version:row.version,email:'different@example.org'}),'22023');
  await as('second',()=>complete('second.user'));
});
await test('owner edits synchronize linked permissions and deactivate history, but no setup or roster restoration reactivates disabled access',async()=>{
  let row=(await as('owner',()=>rpc('list_lab_members',[colony]))).members.find(r=>r.email==='pending@example.org');
  row=(await ownerSave({person_id:row.person_id,version:row.version,intended_role:'viewer',export_level:'low'})).member;assert.equal(row.effective_role,'viewer');assert.equal(row.effective_export_level,'low');
  row=(await ownerSave({person_id:row.person_id,version:row.version,status:'historical'})).member;assert.equal(row.membership_active,false);await as('pending',()=>denied(()=>complete('lab.user')));
  row=(await ownerSave({person_id:row.person_id,version:row.version,status:'current',intended_role:'editor',export_level:'max'})).member;assert.equal(row.membership_active,false);await as('pending',()=>denied(()=>complete('lab.user')));assert.equal((await as('pending',()=>get())).reason,'access_disabled');
  await as('owner',()=>rpc('manage_colony_member',[colony,ids.second,'editor',false,'update','low']));await as('second',()=>denied(()=>complete('second.user')));
});
await test('owner self setup preserves owner and Max; manager access only comes from owner roster',async()=>{
  const person=(await ownerSave({version:0,name:'Principal Investigator',email:'owner@example.org',status:'current',category:'principal_investigator',acronym:'PI',intended_role:'viewer',export_level:'low'})).member;
  assert.equal(person.linked_user_id,null);assert.equal(person.username,null);assert.equal(person.effective_role,'owner');assert.equal(person.effective_export_level,'max');assert.equal(person.membership_active,true);
  await denied(()=>ownerSave({person_id:person.person_id,version:person.version,status:'historical'}));
  const acronym=await as('owner',()=>rpc('update_my_lab_acronym',[colony,' jm ',person.version]));assert.equal(acronym.member.acronym,'JM');assert.equal(acronym.member.username,null);assert.equal(acronym.setup_required,true);assert.equal(acronym.member.effective_role,'owner');assert.equal(acronym.member.effective_export_level,'max');
  const result=await as('owner',()=>complete('principal'));assert.equal(result.member.effective_role,'owner');assert.equal(result.member.effective_export_level,'max');
  let row=(await as('owner',()=>rpc('list_lab_members',[colony]))).members.find(r=>r.person_id===person.person_id);assert.equal(row.effective_export_level,'max');await denied(()=>ownerSave({person_id:row.person_id,version:row.version,archived:true}));
  const manager=await as('manager',()=>complete('manager.user'));assert.equal(manager.member.effective_role,'manager');assert.equal(manager.member.effective_export_level,'max');await as('manager',()=>denied(()=>rpc('list_lab_members',[colony])));await as('manager',()=>denied(()=>save({version:0,name:'Unauthorized'})));
});
await test('shared directory only includes current names and acronyms; service resolver alone can read roster privately',async()=>{
  await ownerSave({version:0,name:'Current preregistration',acronym:'CP',email:'new@example.org',phone:'PRIVATE PHONE',status:'current',notes:'PRIVATE NOTES'});
  await ownerSave({version:0,name:'Historical scientist',acronym:'HX',status:'historical'});
  const result=await as('editor',()=>rpc('get_lab_user_directory',[colony]));assert(result.users.some(r=>r.code==='CP'));assert(!result.users.some(r=>r.code==='HX'));assert(result.users.every(r=>Object.keys(r).sort().join(',')==='code,name'));assert(!JSON.stringify(result).includes('PRIVATE'));
  await as('review',()=>denied(()=>rpc('get_lab_user_directory',[colony])));await as('ownerB',()=>denied(()=>rpc('get_lab_user_directory',[colony])));
  await as(null,async()=>{assert((await db.query('select email,linked_user_id from public.lab_members where username=$1',['principal'])).rows.length===1);await denied(()=>db.query('select * from public.lab_member_audit'));},'service_role');
});
await test('self acronym edits require verified current own access, enforce CAS and collisions, and alter no historical logs or permissions',async()=>{
  const beforeMembers=(await db.query('select * from public.memberships order by colony_id,user_id')).rows,beforeAccounts=(await db.query('select * from auth.users order by id')).rows,beforeLogs=(await db.query('select * from public.audit_log order by audit_id')).rows;
  const current=await as('manager',()=>get()),version=current.member.version;
  const changed=await as('manager',()=>rpc('update_my_lab_acronym',[colony,' m-g_2 ',version]));assert.equal(changed.member.acronym,'M-G_2');assert.equal(changed.member.version,version+1);assert.equal(changed.member.effective_role,'manager');assert.equal(changed.member.effective_export_level,'max');assert.equal(changed.member.email,'manager@example.org');
  await as('manager',()=>denied(()=>rpc('update_my_lab_acronym',[colony,'NEW',version]),'40001'));
  await as('manager',()=>denied(()=>rpc('update_my_lab_acronym',[colony,'JM',version+1]),'23505'));
  for(const code of ['',null,'1BAD','TOO_LONG_ACRONYM','A B','<svg>'])await as('manager',()=>denied(()=>rpc('update_my_lab_acronym',[colony,code,version+1]),'22023'));
  for(const user of ['historical','review','unverified','disabled','pending','second','ownerB'])await as(user,()=>denied(()=>rpc('update_my_lab_acronym',[colony,'NO',1])));
  await as(null,()=>denied(()=>rpc('update_my_lab_acronym',[colony,'NO',1])),'anon');
  const privateCount=(await db.query('select count(*) n from public.lab_member_audit')).rows[0].n;await as('manager',()=>rpc('update_my_lab_acronym',[colony,'M-G_2',version+1]));assert.equal((await db.query('select count(*) n from public.lab_member_audit')).rows[0].n,privateCount);
  const audit=(await db.query('select before_record,after_record,actor_id from public.lab_member_audit where actor_id=$1 order by audit_id desc limit 1',[ids.manager])).rows[0];assert.equal(audit.actor_id,ids.manager);assert.equal(audit.before_record.acronym,'MG');assert.equal(audit.after_record.acronym,'M-G_2');
  assert.deepEqual((await db.query('select * from public.memberships order by colony_id,user_id')).rows,beforeMembers);assert.deepEqual((await db.query('select * from auth.users order by id')).rows,beforeAccounts);assert.deepEqual((await db.query('select * from public.audit_log order by audit_id')).rows,beforeLogs);
  const directory=await as('editor',()=>rpc('get_lab_user_directory',[colony]));assert(directory.users.some(r=>r.code==='M-G_2'));assert(!directory.users.some(r=>r.code==='MG'));
});
await db.close();
