import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite(),colony='57a26815-ca94-413b-891a-e0e85ff59d69',foreign='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const names=['owner','editor','viewer','manager','inactive','unverified','anonymous','banned','deleted','outsider','foreignOwner'];
const ids=Object.fromEntries(names.map((name,i)=>[name,`${String(i+1).padStart(8,'0')}-3333-4333-8333-333333333333`]));
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,invited_at timestamptz,raw_user_meta_data jsonb default '{}',is_anonymous boolean default false,banned_until timestamptz,deleted_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
for(const name of names)await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password,is_anonymous,banned_until,deleted_at) values($1,$2,$3,$4,$5,$6,$7)',[ids[name],name+'@example.org',name==='unverified'?null:'2026-01-01','synthetic-password',name==='anonymous',name==='banned'?'2099-01-01':null,name==='deleted'?'2026-01-01':null]);
for(const file of ['schema.sql','functions/manage-colony-users/membership.sql','export-permissions.sql','manager-permissions.sql','lab-members.sql','account-acronym.sql','account-profile.sql','member-email-approval.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3),($4,$5,$6)',[colony,'Cage managers',ids.owner,foreign,'Other colony',ids.foreignOwner]);
for(const name of names.filter(x=>x!=='outsider'))await db.query('insert into public.memberships(colony_id,user_id,role,active,updated_by) values($1,$2,$3,$4,$5)',[name==='foreignOwner'?foreign:colony,ids[name],name==='owner'||name==='foreignOwner'?'owner':name==='viewer'?'viewer':name==='manager'?'manager':'editor',name!=='inactive',name==='foreignOwner'?ids.foreignOwner:ids.owner]);
await db.exec(await readFile(new URL('../account-profile.sql',import.meta.url),'utf8'));
async function as(name,fn,role='authenticated'){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[name?ids[name]:'']);try{return await fn();}finally{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',false)");}}
const rpc=async(name,args)=>{const params=args.map((_,i)=>'$'+(i+1)).join(',');return(await db.query(`select public.${name}(${params}) result`,args)).rows[0].result;};
const save=(person,actor='owner',lab=colony)=>as(actor,()=>rpc('save_lab_member',[lab,person]));
const directory=(actor='editor',lab=colony)=>as(actor,()=>rpc('list_cage_managers',[lab]));
const denied=(fn,code='42501')=>assert.rejects(fn,error=>error.code===code);
const memberships=()=>db.query('select * from public.memberships order by colony_id,user_id').then(x=>x.rows);
const migration=await readFile(new URL('../cage-managers.sql',import.meta.url),'utf8');
const oldRow=await save({version:0,name:'Existing current member',email:'old-row@example.org',status:'current'});
await db.exec('alter table public.lab_members drop column cage_manager_eligible');
await db.exec(migration);

await test('upgrade initializes existing members to false without changing access and reruns preserve owner choices',async()=>{
 const old=(await db.query('select cage_manager_eligible from public.lab_members where person_id=$1',[oldRow.member.person_id])).rows[0];assert.equal(old.cage_manager_eligible,false);
 const selected=await save({version:0,name:'Selected former member',email:'selected@example.org',status:'historical',cage_manager_eligible:true,notes:'PRIVATE OWNER NOTE',phone:'PRIVATE PHONE',provenance:{nickname:' Cherry ',source:'PRIVATE SOURCE'}});
 const before=(await db.query('select * from public.lab_members order by person_id')).rows,access=await memberships(),audit=(await db.query('select count(*) n from public.lab_member_audit')).rows[0].n;
 await db.exec(migration);assert.deepEqual((await db.query('select * from public.lab_members order by person_id')).rows,before);assert.deepEqual(await memberships(),access);assert.equal((await db.query('select count(*) n from public.lab_member_audit')).rows[0].n,audit);assert.equal(selected.member.cage_manager_eligible,true);
});

await test('directory includes Current and selected Historical only, with no private contacts or roster metadata',async()=>{
 await save({version:0,name:'alpha Current',status:'current',acronym:'AC',provenance:{nickname:{private:'not text'}}});
 await save({version:0,name:'Zeta Current',status:'current',cage_manager_eligible:false});
 await save({version:0,name:'Hidden former',status:'historical'});
 await save({version:0,name:'Hidden Review',status:'review',cage_manager_eligible:true});
 await save({version:0,name:'Hidden archived',status:'current',archived:true,cage_manager_eligible:true});
 await save({version:0,name:'Foreign Current',status:'current'},'foreignOwner',foreign);
 for(const [label,provenance] of [['service',{service_account:true}],['service-flag',{is_service_account:true}],['bot',{is_bot:true}],['type',{account_type:'service'}]])await save({version:0,name:'Hidden '+label,status:'current',provenance});
 await save({version:0,name:'Braintime Bot',acronym:'BB',status:'current'});
 const result=await directory();assert.deepEqual(result.managers.map(x=>x.name),['alpha Current','Existing current member','Zeta Current','Selected former member']);
 assert.equal(result.managers.at(-1).nickname,'Cherry');assert.equal(result.managers[0].nickname,null);
 for(const person of result.managers)assert.deepEqual(Object.keys(person).sort(),['person_id','name','acronym','nickname','status'].sort());
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|example\.org|email|phone|provenance|notes|export_level|permissions|created_by/);
 const other=await directory('foreignOwner',foreign);assert.deepEqual(other.managers.map(x=>x.name),['Foreign Current']);
});

await test('only enabled verified active colony members can read and no directory read mutates records',async()=>{
 const before=(await db.query('select count(*) n from public.lab_member_audit')).rows[0].n;
 for(const role of ['owner','editor','viewer','manager'])assert.ok((await directory(role)).managers.length>0);
 for(const name of ['inactive','unverified','anonymous','banned','deleted','outsider','foreignOwner'])await denied(()=>directory(name));
 await denied(()=>as(null,()=>rpc('list_cage_managers',[colony]),'anon'));
 await denied(()=>directory('owner',foreign));
 assert.equal((await db.query('select count(*) n from public.lab_member_audit')).rows[0].n,before);
 await as('editor',async()=>{assert.equal((await db.query('select * from public.lab_members')).rows.length,0);assert.equal((await db.query('select * from public.lab_member_audit')).rows.length,0);});
});

await test('eligibility is owner-only strictly boolean, versioned, and preserved by partial status/profile changes',async()=>{
 let target=await save({version:0,name:'Owner selected former',status:'historical'});assert.equal(target.member.cage_manager_eligible,false);
 for(const value of [null,'true','false',0,1,{},[]])await denied(()=>save({person_id:target.member.person_id,version:target.member.version,cage_manager_eligible:value}),'22023');
 for(const value of [null,'true',1,{}])await denied(()=>save({version:0,name:'Invalid new',cage_manager_eligible:value}),'22023');
 for(const name of ['editor','viewer','manager','inactive','outsider','foreignOwner'])await denied(()=>save({person_id:target.member.person_id,version:target.member.version,cage_manager_eligible:true},name));
 const stale=target;target=await save({person_id:target.member.person_id,version:target.member.version,cage_manager_eligible:true});assert.equal(target.member.cage_manager_eligible,true);assert.equal(target.member.version,stale.member.version+1);
 await denied(()=>save({person_id:target.member.person_id,version:stale.member.version,cage_manager_eligible:false}),'40001');
 target=await save({person_id:target.member.person_id,version:target.member.version,status:'current'});assert.equal(target.member.cage_manager_eligible,true);
 target=await save({person_id:target.member.person_id,version:target.member.version,phone:'123'});assert.equal(target.member.cage_manager_eligible,true);
 target=await save({person_id:target.member.person_id,version:target.member.version,status:'historical'});assert.ok((await directory()).managers.some(x=>x.person_id===target.member.person_id));
 target=await save({person_id:target.member.person_id,version:target.member.version,cage_manager_eligible:false});assert.ok(!(await directory()).managers.some(x=>x.person_id===target.member.person_id));
});

await test('changing historical selection never enables accounts or changes assigned rights and self profiles cannot edit it',async()=>{
 let target=await save({version:0,name:'Inactive former account',email:'inactive@example.org',status:'historical',intended_role:'editor',export_level:'low'});
 await db.query('update public.lab_members set linked_user_id=$1,username=$2 where person_id=$3',[ids.inactive,'inactive.former',target.member.person_id]);
 const before=await memberships();target=await save({person_id:target.member.person_id,version:target.member.version,cage_manager_eligible:true});assert.deepEqual(await memberships(),before);
 target=await save({person_id:target.member.person_id,version:target.member.version,cage_manager_eligible:false});assert.deepEqual(await memberships(),before);
 const requester=await as('outsider',()=>rpc('submit_my_lab_profile',[colony,{name:'Self requester'},0]));
 await denied(()=>as('outsider',()=>rpc('submit_my_lab_profile',[colony,{cage_manager_eligible:true},requester.member.version])),'22023');
});

await test('migration contains canonical guarded owner save and retains email approval protection',async()=>{
 const source=await readFile(new URL('../lab-members.sql',import.meta.url),'utf8'),start=source.indexOf('create or replace function public.save_lab_member('),end=source.indexOf('grant execute on function public.save_lab_member(uuid,jsonb) to authenticated;',start)+'grant execute on function public.save_lab_member(uuid,jsonb) to authenticated;'.length;
 assert.ok(migration.includes(source.slice(start,end)));
 await denied(()=>save({version:0,name:'Forged',provenance:{email_approval:{registered_user_id:ids.editor,approved_by:ids.owner}}}),'22023');
});

await db.close();
