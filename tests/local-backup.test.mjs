import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {datasetFromLocalBackup} from '../web/local-backup.js';
const data=()=>({tables:{mice:[{mouse_sid:'001',state:'Stock'}]},source_meta:{title:'Synthetic source'}});
function envelope(){const body={kind:'braintime-local-backup',schema_version:1,application:'mouse-data',full_workspace:true,restore_mode:'workspace',permission:{level:'max',cutoff_date:null,as_of_date:'2026-10-15'},sections:{workspace:data()}};return {...body,integrity:{algorithm:'SHA-256',encoding:'JSON.stringify of envelope without integrity',value:createHash('sha256').update(JSON.stringify(body)).digest('hex')}};}
test('verified Max envelope unwraps without mutating the file; older reconstructed JSON stays compatible',async()=>{
 const backup=envelope(),before=structuredClone(backup);assert.deepEqual(await datasetFromLocalBackup(JSON.parse(JSON.stringify(backup))),data());assert.deepEqual(backup,before);
 const legacy=data();assert.equal(await datasetFromLocalBackup(legacy),legacy);
});
test('partial backups cannot replace a whole workspace, even with an added tables field',async()=>{
 const partial=envelope();partial.full_workspace=false;partial.permission.level='high';partial.permission.cutoff_date='2020-10-15';partial.tables=data().tables;
 await assert.rejects(datasetFromLocalBackup(partial),/partial backup.*cannot replace/);
});
test('tampered, redacted, unsupported and malformed full envelopes fail before import',async()=>{
 const cases=[b=>b.sections.workspace.tables.mice[0].mouse_sid='changed',b=>delete b.integrity,b=>b.integrity.value='0'.repeat(64),b=>b.sections.workspace.source_archive_restricted=true,b=>b.sections.extra=data(),b=>b.restore_mode='reviewed_merge_only',b=>b.application='other',b=>b.schema_version=2,b=>b.permission.cutoff_date='2020-10-15',b=>b.permission.as_of_date='2026-02-30',b=>b.sections.workspace.tables.mice={}];
 for(const change of cases){const b=envelope();change(b);await assert.rejects(datasetFromLocalBackup(b),/could not be verified|integrity check/);}
 for(const bad of [null,[],{}, {tables:[]}])await assert.rejects(datasetFromLocalBackup(bad),/Expected a reconstructed JSON/);
});
