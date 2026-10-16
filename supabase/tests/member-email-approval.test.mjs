import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite(),colony='57a26815-ca94-413b-891a-e0e85ff59d69',foreign='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let serial=0;const uuid=()=>`${String(++serial).padStart(8,'0')}-2222-4222-8222-222222222222`;
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,invited_at timestamptz,email_change text default '',raw_user_meta_data jsonb default '{}',is_anonymous boolean default false,banned_until timestamptz,deleted_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
const account=async(email,verified=true,invited=false)=>{const id=uuid();await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password,invited_at) values($1,$2,$3,$4,$5)',[id,email,verified?'2026-01-01T00:00:00Z':null,'synthetic-hash',invited?'2026-01-01T00:00:00Z':null]);return id;};
const owner=await account('owner@example.org'),outsider=await account('outsider@example.org'),manager=await account('manager@example.org');
for(const file of ['schema.sql','functions/manage-colony-users/membership.sql','export-permissions.sql','manager-permissions.sql','lab-members.sql','account-acronym.sql','account-profile.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3),($4,$5,$3)',[colony,'Email approval test',owner,foreign,'Other colony']);
await db.query('insert into public.memberships(colony_id,user_id,role,active,export_level,updated_by) values($1,$2,$3,true,$4,$2),($1,$5,$6,true,$4,$2)',[colony,owner,'owner','max',manager,'manager']);
// account-profile was installed before the test colony existed.
await db.exec(await readFile(new URL('../account-profile.sql',import.meta.url),'utf8'));
const migration=await readFile(new URL('../member-email-approval.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
async function as(id,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);try{return await fn();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
const rpc=async(name,args)=>{const params=args.map((_,i)=>'$'+(i+1)).join(',');return(await db.query(`select public.${name}(${params}) result`,args)).rows[0].result;};
const roster=id=>db.query('select * from public.lab_members where person_id=$1',[id]).then(x=>x.rows[0]);
const membership=id=>db.query('select * from public.memberships where colony_id=$1 and user_id=$2',[colony,id]).then(x=>x.rows[0]);
const grant=(id,role='editor',level='high',permissions=null,lab=colony)=>as(owner,()=>rpc('manage_colony_member',[lab,id,role,true,'add',level,permissions]));
async function pair(label,{role='editor',level='high',oldAuth=true,oldMember=false,permissions=null}={}){
 const email=label+'@registered.example.org',oldEmail=label+'@invited.example.org',user=await account(email),original=oldAuth?await account(oldEmail,false,true):null;
 const request=await as(user,()=>rpc('submit_my_lab_profile',[colony,{name:'Requested '+label,phone:'555',category:'phd'},0]));
 const target=await as(owner,()=>rpc('save_lab_member',[colony,{version:0,name:'Current '+label,email:oldEmail,status:'current',intended_role:role,export_level:level,notes:'Owner-only note',provenance:{source:'Original roster'}}]));
 if(oldMember)await grant(original,role,level,permissions);
 return{email,oldEmail,user,original,request:request.member,target:target.member};
}
async function registeredPair(label,{role='editor',level='high',permissions=null}={}){
 const p=await pair(label,{role,level});
 await db.query('update auth.users set email_confirmed_at=now() where id=$1',[p.original]);
 await grant(p.original,role,level,permissions);
 const complete=await as(p.original,()=>rpc('complete_lab_member_setup',[colony,'registered.'+label]));
 return {...p,target:complete.member};
}
async function approve(p,id=owner){const req=await roster(p.request.person_id),dst=await roster(p.target.person_id);return as(id,()=>rpc('approve_lab_member_email',[colony,req.person_id,req.version,dst.person_id,dst.version]));}
async function snapshot(){return JSON.stringify(await Promise.all(['auth.users','public.lab_members','public.memberships','public.lab_member_audit','public.audit_log'].map(async table=>(await db.query(`select to_jsonb(t) row from ${table} t order by to_jsonb(t)::text`)).rows)));}
async function denied(fn,code='42501'){const before=await snapshot();await assert.rejects(fn,e=>e.code===code);assert.equal(await snapshot(),before);}

await test('approval preserves original identity, retains former email only as contact, and permits normal setup',async()=>{
 const p=await pair('success'),before=await roster(p.target.person_id),authBefore=(await db.query('select * from auth.users order by id')).rows;
 const result=await approve(p);assert.equal(result.member.person_id,before.person_id);assert.equal(result.member.name,before.name);assert.equal(result.member.email,p.email);assert.deepEqual(result.member.secondary_emails,[p.oldEmail]);assert.equal(result.member.intended_role,'editor');assert.equal(result.member.export_level,'high');assert.equal(result.member.notes,before.notes);assert.equal(result.member.provenance.source,'Original roster');assert.equal(result.member.version,before.version+1);assert.equal(result.member.linked_user_id,null);assert.equal(result.setup_required,true);assert.equal(result.approval_kind,'login_email');assert.equal(result.approved_email,p.email);
 const archived=await roster(p.request.person_id);assert.equal(archived.archived,true);assert.equal(archived.email,null);assert.equal(archived.name,p.request.name);assert.equal(archived.phone,'555');assert.equal(archived.provenance.email_approval.merged_into_person_id,before.person_id);assert.equal(archived.provenance.email_approval.approved_email,p.email);assert.deepEqual(result.merged_request,{person_id:archived.person_id,version:archived.version,archived:true});
 const assigned=await membership(p.user);assert.equal(assigned.role,'editor');assert.equal(assigned.export_level,'high');assert.equal(assigned.active,true);
 const profile=await as(p.user,()=>rpc('get_my_lab_member',[colony]));assert.equal(profile.eligible,true);assert.equal(profile.setup_required,true);assert.equal(profile.member.person_id,before.person_id);
 const done=await as(p.user,()=>rpc('complete_lab_member_setup',[colony,'approved.success']));assert.equal(done.setup_required,false);assert.equal(done.member.effective_export_level,'high');assert.deepEqual(await membership(p.user),assigned);
 assert.deepEqual((await db.query('select * from auth.users order by id')).rows,authBefore);
 const old=await as(p.original,()=>rpc('get_my_lab_member',[colony]));assert.equal(old.eligible,false);assert.equal(old.member,null);
 await db.query('update auth.users set email_confirmed_at=now() where id=$1',[p.original]);const confirmedOld=await as(p.original,()=>rpc('get_my_lab_member',[colony]));assert.equal(confirmedOld.eligible,false);assert.equal(confirmedOld.reason,'profile_required');await denied(()=>as(p.original,()=>rpc('complete_lab_member_setup',[colony,'old.invitation'])));
 const audits=(await db.query('select actor_id from public.lab_member_audit where person_id in ($1,$2) and after_record->\'provenance\' ? \'email_approval\' order by audit_id',[p.request.person_id,p.target.person_id])).rows;assert.ok(audits.length>=2);assert.deepEqual(audits.slice(0,2).map(x=>x.actor_id),[owner,owner]);
});

await test('registered member approval adds a contact and preserves the working account and all existing identity fields',async()=>{
 const p=await registeredPair('contact',{role:'manager',level:'max',permissions:{imports:false,fees:false}});
 const provenance={source:'Original roster',email_approval:{registered_user_id:p.original,approved_email:p.oldEmail,approved_by:owner}};
 await db.query('update public.lab_members set secondary_emails=$2,provenance=$3 where person_id=$1',[p.target.person_id,['existing@example.org',p.oldEmail,p.email],provenance]);
 const before=await roster(p.target.person_id),membersBefore=(await db.query('select * from public.memberships order by colony_id,user_id')).rows,authBefore=(await db.query('select * from auth.users order by id')).rows,auditBefore=(await db.query('select * from public.audit_log order by audit_id')).rows;
 const result=await approve(p),after=await roster(p.target.person_id);
 assert.equal(result.approval_kind,'secondary_contact');assert.equal(result.approved_email,p.email);assert.equal(result.setup_required,false);
 assert.equal(result.member.email,p.oldEmail);assert.equal(result.member.linked_user_id,p.original);assert.equal(result.member.username,'registered.contact');
 assert.deepEqual(result.member.secondary_emails,['existing@example.org',p.email].sort());assert.deepEqual(result.member.provenance,provenance);
 const excluded=new Set(['secondary_emails','version','updated_at','updated_by']);
 assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([k])=>!excluded.has(k))),Object.fromEntries(Object.entries(before).filter(([k])=>!excluded.has(k))));
 assert.equal(after.version,before.version+1);assert.equal(after.updated_by,owner);
 assert.deepEqual((await db.query('select * from public.memberships order by colony_id,user_id')).rows,membersBefore);
 assert.deepEqual((await db.query('select * from auth.users order by id')).rows,authBefore);assert.deepEqual((await db.query('select * from public.audit_log order by audit_id')).rows,auditBefore);
 const archived=await roster(p.request.person_id);assert.equal(archived.archived,true);assert.equal(archived.email,null);assert.equal(archived.provenance.email_approval.approval_kind,'secondary_contact');assert.equal(archived.provenance.email_approval.merged_into_person_id,p.target.person_id);assert.equal(archived.provenance.email_approval.approved_email,p.email);
 const primary=await as(p.original,()=>rpc('get_my_lab_member',[colony]));assert.equal(primary.eligible,true);assert.equal(primary.setup_required,false);assert.equal(primary.member.username,'registered.contact');
 const alternate=await as(p.user,()=>rpc('get_my_lab_member',[colony]));assert.equal(alternate.eligible,false);assert.equal(alternate.setup_required,false);assert.equal(alternate.registration_allowed,false);assert.equal(alternate.reason,'secondary_contact_only');assert.equal(alternate.member,null);assert.equal(await membership(p.user),undefined);
 await denied(()=>as(p.user,()=>rpc('submit_my_lab_profile',[colony,{name:'Duplicate contact request'},0])));
 await denied(()=>as(p.user,()=>rpc('complete_lab_member_setup',[colony,'contact.not.login'])));
 const audits=(await db.query("select actor_id from public.lab_member_audit where person_id in ($1,$2) and operation='UPDATE' order by audit_id desc limit 2",[p.request.person_id,p.target.person_id])).rows;assert.deepEqual(audits.map(x=>x.actor_id),[owner,owner]);
 await denied(()=>as(owner,()=>rpc('approve_lab_member_email',[colony,p.request.person_id,p.request.version,p.target.person_id,p.target.version])),'40001');
});

await test('resolved contact request stays closed after roster transitions, contact edits or Auth email changes',async()=>{
 const p=await registeredPair('resolved');const result=await approve(p);
 await as(owner,()=>rpc('save_lab_member',[colony,{person_id:p.target.person_id,version:result.member.version,status:'historical'}]));
 await db.query('update public.lab_members set secondary_emails=$2 where person_id=$1',[p.target.person_id,[]]);
 await db.query("update public.lab_members set provenance='{}' where person_id=$1",[p.request.person_id]);
 await db.query('update auth.users set email=$2 where id=$1',[p.user,'resolved-new@example.org']);
 const profile=await as(p.user,()=>rpc('get_my_lab_member',[colony]));assert.equal(profile.reason,'secondary_contact_only');assert.equal(profile.registration_allowed,false);assert.equal(profile.eligible,false);assert.equal(profile.member,null);
 await denied(()=>as(p.user,()=>rpc('submit_my_lab_profile',[colony,{name:'New identity'},0])));
 await denied(()=>as(p.user,()=>rpc('complete_lab_member_setup',[colony,'resolved.new'])));
});

await test('editable contact-approval-looking provenance alone cannot block another account registration',async()=>{
 const p=await registeredPair('forged-contact');
 await db.query("update public.lab_members set provenance=provenance||jsonb_build_object('email_approval',jsonb_build_object('registered_user_id',$2::text,'approved_by',$3::text,'approved_email',email,'approval_kind','secondary_contact','merged_into_person_id',$4::text)),email=null,archived=true where person_id=$1",[p.request.person_id,p.user,owner,p.target.person_id]);
 const profile=await as(p.user,()=>rpc('get_my_lab_member',[colony]));assert.equal(profile.reason,'profile_required');assert.equal(profile.registration_allowed,true);
});

await test('registered contact approval rejects unverifiable primary identities and inactive or conflicting access without changes',async()=>{
 for(const [label,expression] of [['unverified','email_confirmed_at=null'],['changed',"email='new-registered@example.org'"],['pending',"email_change='pending@example.org'"],['anonymous','is_anonymous=true'],['banned',"banned_until='2099-01-01'"],['deleted','deleted_at=now()']]){
  const p=await registeredPair('r-'+label);await db.query('update auth.users set '+expression+' where id=$1',[p.original]);await denied(()=>approve(p));
 }
 for(const [label,expression,code] of [['inactive','active=false','42501'],['owner',"role='owner'",'42501'],['role',"role='viewer'",'40001'],['level',"export_level='low'",'40001']]){
  const p=await registeredPair('m-'+label);await db.query('update public.memberships set '+expression+' where colony_id=$1 and user_id=$2',[colony,p.original]);await denied(()=>approve(p),code);
 }
 const missing=await registeredPair('missing');await db.query('delete from public.memberships where colony_id=$1 and user_id=$2',[colony,missing.original]);await denied(()=>approve(missing));
 const duplicate=await registeredPair('duplicate');await account(duplicate.oldEmail.toUpperCase());await denied(()=>approve(duplicate));
 const conflict=await registeredPair('contact-conflict');const other=await pair('other-contact');await db.query('update public.lab_members set secondary_emails=$2 where person_id=$1',[other.target.person_id,[conflict.email]]);await denied(()=>approve(conflict));
});

await test('registered contact approval remains owner-only and does not reactivate a previously disabled alternate',async()=>{
 const p=await registeredPair('permission');for(const id of [outsider,manager,p.original,p.user])await denied(()=>approve(p,id));
 await db.query('insert into public.memberships(colony_id,user_id,role,active,export_level,updated_by) values($1,$2,$3,false,$4,$5)',[colony,p.user,'editor','high',owner]);
 await denied(()=>approve(p));
});

await test('original invited membership custom flags transfer, old access stops, and secondary emails are deduplicated',async()=>{
 const p=await pair('manager',{role:'manager',level:'max',oldMember:true,permissions:{imports:false,archive:false,fees:false}}),old=await membership(p.original);
 await db.query('update public.lab_members set secondary_emails=$2 where person_id=$1',[p.target.person_id,[p.oldEmail,'other@example.org',p.email]]);
 const result=await approve(p),assigned=await membership(p.user),disabled=await membership(p.original);
 assert.deepEqual(assigned.permissions,old.permissions);assert.equal(assigned.role,old.role);assert.equal(assigned.export_level,old.export_level);assert.equal(disabled.active,false);assert.equal(disabled.role,old.role);assert.deepEqual(disabled.permissions,old.permissions);assert.deepEqual(result.member.secondary_emails,[p.oldEmail,'other@example.org'].sort());
 const oldAudit=(await db.query("select * from public.audit_log where entity_type='membership' and entity_id=$1 and operation='UPDATE' order by audit_id desc limit 1",[p.original])).rows[0];assert.equal(oldAudit.actor_id,owner);assert.equal(oldAudit.before_record.active,true);assert.equal(oldAudit.after_record.active,false);
 await db.query('update auth.users set email_confirmed_at=now() where id=$1',[p.original]);const oldProfile=await as(p.original,()=>rpc('get_my_lab_member',[colony]));assert.equal(oldProfile.reason,'access_disabled');assert.equal(oldProfile.eligible,false);
});

await test('an original email without an Auth account is eligible and rerunning migration changes no records',async()=>{
 const p=await pair('no-auth',{oldAuth:false,role:'viewer',level:'low'});const result=await approve(p);assert.equal(result.member.email,p.email);assert.equal((await membership(p.user)).role,'viewer');
 const before=await snapshot();await db.exec(migration);assert.equal(await snapshot(),before);
 await denied(()=>as(owner,()=>rpc('approve_lab_member_email',[colony,p.request.person_id,p.request.version,p.target.person_id,p.target.version])),'40001');
});

await test('only verified active owner can approve, with exact colony and CAS versions',async()=>{
 const p=await pair('authority');
 for(const id of [outsider,manager])await denied(()=>approve(p,id));
 await denied(()=>as(null,()=>rpc('approve_lab_member_email',[colony,p.request.person_id,p.request.version,p.target.person_id,p.target.version]),'anon'));
 await denied(()=>as(owner,()=>rpc('approve_lab_member_email',[foreign,p.request.person_id,p.request.version,p.target.person_id,p.target.version])));
 for(const offset of [[1,0],[0,1]])await denied(()=>as(owner,()=>rpc('approve_lab_member_email',[colony,p.request.person_id,p.request.version+offset[0],p.target.person_id,p.target.version+offset[1]])),'40001');
 await denied(()=>as(owner,()=>rpc('approve_lab_member_email',[colony,p.request.person_id,p.request.version,p.request.person_id,p.request.version])),'22023');
 for(const expression of ["email_confirmed_at=null","banned_until='2099-01-01'","deleted_at=now()","is_anonymous=true"]){try{await db.query('update auth.users set '+expression+' where id=$1',[owner]);await denied(()=>approve(p));}finally{await db.query("update auth.users set email_confirmed_at='2026-01-01',banned_until=null,deleted_at=null,is_anonymous=false where id=$1",[owner]);}}
 try{await db.query('update public.memberships set active=false where colony_id=$1 and user_id=$2',[colony,owner]);await denied(()=>approve(p));}finally{await db.query('update public.memberships set active=true where colony_id=$1 and user_id=$2',[colony,owner]);}
});

await test('historical, archived, wrongly linked and non-self-review rows are never merged',async()=>{
 for(const [label,table,expression] of [['target-historical','target',"status='historical'"],['target-archived','target','archived=true'],['target-review','target',"status='review'"],['target-claimed','target',`username='claimed.user',linked_user_id='${outsider}'`],['request-current','request',"status='current'"],['request-archived','request','archived=true'],['request-claimed','request',`username='claimed.req',linked_user_id='${manager}'`],['request-owner-created','request',`created_by='${owner}'`],['request-provenance','request',"provenance='{}'"]]){
  const p=await pair(label);await db.query('update public.lab_members set '+expression+' where person_id=$1',[p[table].person_id]);await denied(()=>approve(p));
 }
});

await test('request Auth changes and any existing membership fail closed without reactivating access',async()=>{
 for(const [label,expression] of [['unverified','email_confirmed_at=null'],['anonymous','is_anonymous=true'],['banned',"banned_until='2099-01-01'"],['deleted','deleted_at=now()'],['changed-email',"email='changed@example.org'"],['pending-email',"email_change='pending@example.org'"]]){const p=await pair('request-'+label);await db.query('update auth.users set '+expression+' where id=$1',[p.user]);await denied(()=>approve(p));}
 for(const [label,role,active,lab] of [['active','editor',true,colony],['disabled','editor',false,colony],['owner','owner',true,colony],['foreign','editor',true,foreign]]){const p=await pair('request-'+label+'-member');await db.query('insert into public.memberships(colony_id,user_id,role,active,updated_by) values($1,$2,$3,$4,$5)',[lab,p.user,role,active,owner]);await denied(()=>approve(p));}
});

await test('original Auth must remain an enabled unverified invitation, never an existing or protected account',async()=>{
 for(const [label,expression] of [['verified','email_confirmed_at=now()'],['not-invited','invited_at=null'],['anonymous','is_anonymous=true'],['banned',"banned_until='2099-01-01'"],['deleted','deleted_at=now()'],['pending-email',"email_change='pending@example.org'"]]){const p=await pair('original-'+label);await db.query('update auth.users set '+expression+' where id=$1',[p.original]);await denied(()=>approve(p));}
 for(const [label,role,active,lab] of [['disabled','editor',false,colony],['owner','owner',true,colony],['foreign','editor',true,foreign]]){const p=await pair('original-'+label+'-member');await db.query('insert into public.memberships(colony_id,user_id,role,active,updated_by) values($1,$2,$3,$4,$5)',[lab,p.original,role,active,owner]);await denied(()=>approve(p));}
});

await test('rights that differ from the displayed target and conflicting account linkage require review',async()=>{
 for(const [label,role,level] of [['role','manager','high'],['export','editor','max']]){const p=await pair('rights-'+label);await grant(p.original,role,level);await denied(()=>approve(p),'40001');}
 const p=await pair('linked-account');await db.query('update public.lab_members set linked_user_id=$1,username=$2 where person_id=$3',[p.user,'elsewhere.user',p.target.person_id]);await denied(()=>approve(p));
});

await test('duplicate normalized Auth identities and fabricated self-request provenance cannot establish a merge',async()=>{
 for(const which of ['user','original']){const p=await pair('duplicate-'+which);await account((which==='user'?p.email:p.oldEmail).toUpperCase());await denied(()=>approve(p));}
 const p=await pair('fake-request');
 const fake=await as(owner,()=>rpc('save_lab_member',[colony,{version:0,name:'Owner-created request',email:'fake-request-copy@example.org',status:'review'}]));
 await db.query('update public.lab_members set email=null where person_id=$1',[p.request.person_id]);
 await db.query("update public.lab_members set email=$2,created_by=$3,provenance=jsonb_build_object('registration_method','verified_self_request') where person_id=$1",[fake.member.person_id,p.email,p.user]);
 await denied(()=>approve({...p,request:fake.member}));
});

await test('pending approved access follows owner revocation before setup, including after an Auth email change',async()=>{
 for(const [label,change,authChanged] of [['historical',{status:'historical'},false],['review',{status:'review'},false],['archived',{archived:true},false],['email-changed',{status:'historical'},true]]){
  const p=await pair('lifecycle-'+label,{role:'manager',level:'max',oldMember:true,permissions:{imports:false,fees:false}});const approved=await approve(p),assigned=await membership(p.user);
  await denied(()=>as(owner,()=>rpc('save_lab_member',[colony,{person_id:p.target.person_id,version:approved.member.version,email:'replace-'+label+'@example.org'}])),'22023');
  if(authChanged){
   await db.query('update auth.users set email=$2 where id=$1',[p.user,'changed-'+label+'@example.org']);
   const mismatch=await as(p.user,()=>rpc('get_my_lab_member',[colony]));assert.equal(mismatch.reason,'account_conflict');assert.equal(mismatch.eligible,false);assert.equal(mismatch.registration_allowed,false);assert.equal(mismatch.member,null);
   await denied(()=>as(p.user,()=>rpc('submit_my_lab_profile',[colony,{name:'Duplicate Current'},0])));
   await denied(()=>as(p.user,()=>rpc('complete_lab_member_setup',[colony,'changed.before.setup'])));
  }
  const revoked=await as(owner,()=>rpc('save_lab_member',[colony,{person_id:p.target.person_id,version:approved.member.version,...change}]));
  const disabled=await membership(p.user);assert.equal(disabled.active,false);assert.equal(disabled.role,assigned.role);assert.equal(disabled.export_level,assigned.export_level);assert.deepEqual(disabled.permissions,assigned.permissions);
  await as(owner,()=>rpc('save_lab_member',[colony,{person_id:p.target.person_id,version:revoked.member.version,status:'current',archived:false}]));assert.equal((await membership(p.user)).active,false);
  await denied(()=>as(p.user,()=>rpc('complete_lab_member_setup',[colony,'revived.'+label])));
 }
});

await test('editable approval-looking provenance cannot bind an unrelated account without an immutable owner approval',async()=>{
 const p=await pair('spoof-binding');const before=await membership(manager);
 await db.query("update public.lab_members set provenance=jsonb_build_object('email_approval',jsonb_build_object('registered_user_id',$2::text,'approved_by',$3::text,'approved_email',email)) where person_id=$1",[p.target.person_id,manager,owner]);
 const current=await roster(p.target.person_id);await as(owner,()=>rpc('save_lab_member',[colony,{person_id:current.person_id,version:current.version,status:'historical'}]));
 assert.deepEqual(await membership(manager),before);
});

await test('ordinary owner RPC cannot manufacture, replace or remove the reserved approval binding',async()=>{
 const p=await pair('owner-spoof'),forged={email_approval:{registered_user_id:manager,approved_by:owner,approved_email:p.oldEmail}},before=await membership(manager);
 await denied(()=>as(owner,()=>rpc('save_lab_member',[colony,{version:0,name:'Forged new',email:'forged-new@example.org',status:'current',provenance:forged}])),'22023');
 await denied(()=>as(owner,()=>rpc('save_lab_member',[colony,{person_id:p.target.person_id,version:p.target.version,provenance:forged}])),'22023');
 await as(owner,()=>rpc('save_lab_member',[colony,{person_id:p.target.person_id,version:p.target.version,status:'historical'}]));assert.deepEqual(await membership(manager),before);
 const genuine=await pair('binding-protected'),approved=await approve(genuine),current=await roster(genuine.target.person_id);
 for(const provenance of [{},{email_approval:null},{...current.provenance,email_approval:{...current.provenance.email_approval,registered_user_id:manager}}])await denied(()=>as(owner,()=>rpc('save_lab_member',[colony,{person_id:current.person_id,version:current.version,provenance}])),'22023');
 const edited=await as(owner,()=>rpc('save_lab_member',[colony,{person_id:current.person_id,version:current.version,phone:'456',provenance:current.provenance}]));assert.equal(edited.member.phone,'456');assert.deepEqual(edited.member.provenance.email_approval,approved.member.provenance.email_approval);assert.equal((await membership(genuine.user)).active,true);
});

await test('self-contained upgrade includes exactly the canonical owner lifecycle function',async()=>{
 const canonical=await readFile(new URL('../lab-members.sql',import.meta.url),'utf8'),start=canonical.indexOf('create or replace function public.save_lab_member('),end=canonical.indexOf('grant execute on function public.save_lab_member(uuid,jsonb) to authenticated;',start)+'grant execute on function public.save_lab_member(uuid,jsonb) to authenticated;'.length;
 assert.ok(migration.includes(canonical.slice(start,end)));
 const profiles=await readFile(new URL('../account-profile.sql',import.meta.url),'utf8'),profileStart=profiles.indexOf('create or replace function public.get_my_lab_member('),profileEnd=profiles.indexOf('grant execute on function public.get_my_lab_member(uuid) to authenticated;',profileStart)+'grant execute on function public.get_my_lab_member(uuid) to authenticated;'.length;
 assert.ok(migration.includes(profiles.slice(profileStart,profileEnd)));
});

await db.close();
