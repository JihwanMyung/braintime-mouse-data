import assert from 'node:assert/strict';
import {validateHistoryIndex, searchHistoryIndex} from '../web/history-index.js';
const index={sources:[{title:'Synthetic colony sheet',url:'https://docs.google.com/spreadsheets/d/synthetic',snapshot_date:'2025-04-01'}],sheets:[{source_index:0,title:'Light records',export_title:'Light records',sheet_id:7}],cells:[[0,'A1','T23',null,null,'General'],[0,'B1','=1+1',2,'=1+1','0'],[0,'C1',false,null,null,'General'],[0,'D1',0,null,null,'0','Synthetic cell comment']]};
assert.equal(validateHistoryIndex(index),index);
assert.equal(searchHistoryIndex(index,'t23 2025').total,1);
assert.equal(searchHistoryIndex(index,'1+1').rows[0].formula,'=1+1');
assert.equal(searchHistoryIndex(index,'false').total,1);
assert.equal(searchHistoryIndex(index,'',2,1).rows[0].raw_value,false);
assert.equal(searchHistoryIndex(index,'').rows[3].raw_value,0);
assert.equal(searchHistoryIndex(index,'cell comment').rows[0].comment,'Synthetic cell comment');
assert.equal(searchHistoryIndex(index,'t23').rows[0].source_url,'https://docs.google.com/spreadsheets/d/synthetic#gid=7&range=A1');
assert.throws(()=>validateHistoryIndex({...index,cells:[[9,'A1','bad']]}));
assert.throws(()=>validateHistoryIndex({...index,sheets:[{source_index:5}]}));
console.log('PASS: full-cell validation, multi-token searches, formula/raw/cached preservation, false/zero values, exact source-cell links and bad references.');

const {saveHistoryIndex,loadHistoryIndex}=await import('../web/history-index.js');
let persisted,phase='safe',allowed=true;
const originalIndexedDB=globalThis.indexedDB;
globalThis.indexedDB={open(){
 const open={result:{close(){},transaction(){
  let request,proposed,aborted=false;
  const tx={objectStore(){return {put(value){proposed=value;request={};queueMicrotask(()=>{
   if(phase==='request')allowed=false;request.onsuccess?.();
   queueMicrotask(()=>{if(aborted)return;persisted=proposed;if(phase==='complete')allowed=false;tx.oncomplete?.();});
  });return request;}};},abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());}};
  return tx;
 }}};
 queueMicrotask(()=>{if(phase==='open')allowed=false;open.onsuccess?.();});return open;
}};
const check=()=>{if(!allowed)throw new Error('Account changed');};
try{
 const original=await saveHistoryIndex(index,'original.json',{check});assert.equal(await loadHistoryIndex(),original);
 for(const stage of ['open','request']){
  phase=stage;allowed=true;await assert.rejects(saveHistoryIndex(index,'blocked.json',{check}),/Account changed/);
  assert.equal(persisted.filename,'original.json');assert.equal(await loadHistoryIndex(),original);
 }
 phase='complete';allowed=true;await assert.rejects(saveHistoryIndex(index,'old-account.json',{check}),/Account changed/);
 assert.equal(await loadHistoryIndex(),original,'failed post-commit guard never adopts stale data in memory');
 // A late failure never issues a cleanup deletion that could erase a newer account's cache.
 assert.equal(persisted.filename,'old-account.json');
}finally{globalThis.indexedDB=originalIndexedDB;}
console.log('PASS: guarded history writes reject account changes before open, during request and before memory adoption.');
