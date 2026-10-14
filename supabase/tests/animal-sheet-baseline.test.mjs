import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {baselineSQL} from '../../scripts/prepare-animal-sheet-baseline.mjs';
const colony='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='11111111-1111-4111-8111-111111111111',source='SYNTHETIC_ANIMAL_SOURCE_0000000000000001';
const baseline={schema_version:1,source_id:source,entries:[{entity_type:'locations',entity_id:'L1',source_present:true,payload:{location_id:'L1',source_file_id:source,record_origin:'current_google_sheet_map',label:'Position1',source_observed_tags:['P1','P2']}}]};
const sql=baselineSQL(baseline,{colonyId:colony,sha256:'a'.repeat(64)}),db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.role() returns text language sql as $$select 'service_role'::text$$;`);
for(const file of ['schema.sql','export-permissions.sql','manager-permissions.sql','lab-members.sql','animal-sheet-import.sql'])await db.exec(await readFile(new URL('../'+file,import.meta.url),'utf8'));
await db.query('insert into auth.users(id,email_confirmed_at) values($1,now())',[owner]);await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3)',[colony,'Synthetic',owner]);await db.query("insert into public.memberships(colony_id,user_id,role) values($1,$2,'owner')",[colony,owner]);await db.query("insert into colony_private.animal_sheet_import_settings(colony_id,function_url,responsible_user_id,source_spreadsheet_id) values($1,'https://test.supabase.co/functions/v1/import-animal-sheet',$2,$3)",[colony,owner,source]);
const original={...baseline.entries[0].payload,manager:'APP MANAGER',app_modified_at:'2026-10-15'};
await db.query("insert into public.entity_records(colony_id,entity_type,entity_id,payload,created_by,updated_by) values($1,'locations','L1',$2,$3,$3)",[colony,original,owner]);
await test('bootstrap compares exact source values, preserves extra app fields and is idempotent',async()=>{
 const before=(await db.query('select * from public.entity_records')).rows,audit=(await db.query('select * from public.audit_log')).rows;await db.exec(sql);await db.exec(sql);assert.deepEqual((await db.query('select * from public.entity_records')).rows,before);assert.deepEqual((await db.query('select * from public.audit_log')).rows,audit);
 const state=(await db.query('select * from colony_private.animal_sheet_import_state')).rows[0];assert.equal(state.baseline_revision,1);assert.deepEqual(state.baseline.entries,baseline.entries);assert(!JSON.stringify(state.baseline).includes('APP MANAGER'));
});
await test('bootstrap refuses changed source fields, array reordering, existing import state and authenticated impersonation',async()=>{
 await db.exec("update colony_private.animal_sheet_import_state set baseline_revision=0,baseline='{}'");
 for(const payload of [{...original,label:'App edited'},{...original,source_observed_tags:['P2','P1']},{...original,source_observed_tags:['P1']}]){await db.query("update public.entity_records set payload=$1 where entity_id='L1'",[payload]);await assert.rejects(()=>db.exec(sql),/Original source baseline differs/);await db.exec('rollback');assert.equal((await db.query('select baseline_revision from colony_private.animal_sheet_import_state')).rows[0].baseline_revision,0);}
 await db.query("update public.entity_records set payload=$1 where entity_id='L1'",[original]);await db.exec("update colony_private.animal_sheet_import_state set last_success_at=now()");await assert.rejects(()=>db.exec(sql),/already committed/);await db.exec('rollback');await db.exec('update colony_private.animal_sheet_import_state set last_success_at=null');
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await assert.rejects(()=>db.exec(sql),/authorized admin/);await db.exec('rollback');await db.exec("select set_config('request.jwt.claim.sub','',false)");
});
await test('generator rejects wrong-source, duplicate and unsupported baseline entries before SQL creation',()=>{
 for(const bad of [{...baseline,source_id:'other'},{...baseline,entries:[...baseline.entries,...baseline.entries]},{...baseline,entries:[{...baseline.entries[0],entity_type:'mice'}]}])assert.throws(()=>baselineSQL(bad,{colonyId:colony,sha256:'a'.repeat(64)}));
});
await db.close();
