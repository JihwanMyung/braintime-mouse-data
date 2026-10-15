import test from 'node:test';
import assert from 'node:assert/strict';
import {renderAnimalSheetImport} from '../web/animal-sheet-import.js';
async function harness(status,can=true,overrides={}){const container={innerHTML:'',isConnected:true};let started=0;const cleanup=await renderAnimalSheetImport(container,{canImport:()=>can,getStatus:async()=>status,start:async()=>{started++;return {job_id:'J',status:'completed'}},...overrides});return {container,cleanup,get started(){return started},async click(action){await container.onclick({preventDefault(){},target:{closest:()=>({dataset:{sheetImport:action}})}})}}}
test('manual readiness is distinct from an active daily schedule',async()=>{for(const [enabled,scheduled,label] of [[false,false,'Import not active'],[true,false,'Manual import ready'],[true,true,'Daily · 02:00 Taipei']]){const h=await harness({configured:true,enabled,schedule_active:scheduled});assert(h.container.innerHTML.includes(label));await h.click('start');assert.equal(h.started,enabled?1:0);h.cleanup();}});
test('permission denial blocks crafted refresh starts, errors and conflicts are escaped',async()=>{const h=await harness({configured:true,enabled:true,conflict_count:1},false,{getConflicts:async()=>({total:1,conflicts:[{entity_type:'<img>',reason:'<script>'}]})});await h.click('start');assert.equal(h.started,0);await h.click('conflicts');assert.match(h.container.innerHTML,/&lt;img&gt;/);assert.doesNotMatch(h.container.innerHTML,/<script>/);h.cleanup();});
test('a completed requested job reloads the shared data once',async()=>{let requested=false,completed=0;const h=await harness({},true,{getStatus:async()=>({configured:true,enabled:true,job:requested?{job_id:'J',status:'conflicts'}:null}),start:async()=>{requested=true;return {job_id:'J',status:'queued'}},onComplete:async()=>completed++});await h.click('start');assert.equal(completed,1);await h.click('refresh');assert.equal(completed,1);h.cleanup();});

test('restricted conflict metadata explains withheld source details',async()=>{const h=await harness({configured:true,enabled:true,conflict_count:1},false,{getConflicts:async()=>({total:1,source_details_withheld:true,conflicts:[{entity_type:'locations',entity_id:'SYN-A1',source_details_withheld:true}]})});await h.click('conflicts');assert.match(h.container.innerHTML,/Source details are restricted/);assert.match(h.container.innerHTML,/SYN-A1/);h.cleanup();});


test('stalled queued and running jobs allow an explicit retry at the server fifteen-minute boundary',async()=>{
 const realNow=Date.now;let now=Date.parse('2026-10-15T04:00:00Z');Date.now=()=>now;
 try{for(const status of ['queued','running']){
  const job={job_id:'old',status,queued_at:'2026-10-15T03:45:00Z'};if(status==='running')job.started_at='2026-10-15T03:45:00Z';
  const h=await harness({configured:true,enabled:true,job});
  assert.match(h.container.innerHTML,/Retry update/);assert.match(h.container.innerHTML,/not finished after 15 minutes/);assert.equal(h.started,0);
  await h.click('start');assert.equal(h.started,1);h.cleanup();
 }}finally{Date.now=realNow;}
});
test('fresh starts, future or missing timestamps stay blocked; expired jobs still require import rights',async()=>{
 const realNow=Date.now;Date.now=()=>Date.parse('2026-10-15T04:00:00Z');
 try{
  for(const timestamps of [{},{queued_at:'invalid'},{queued_at:'2026-10-15T04:01:00Z'},{queued_at:'2026-10-15T03:45:01Z'},{queued_at:'2026-10-15T03:00:00Z',started_at:'2026-10-15T03:59:00Z'},{queued_at:'2026-10-15T03:00:00Z',started_at:'invalid'}]){
   const h=await harness({configured:true,enabled:true,job:{status:'running',...timestamps}});assert.match(h.container.innerHTML,/Update in progress/);await h.click('start');assert.equal(h.started,0);h.cleanup();
  }
  const h=await harness({configured:true,enabled:true,job:{status:'running',queued_at:'2026-10-15T03:00:00Z'}},false);await h.click('start');assert.equal(h.started,0);h.cleanup();
 }finally{Date.now=realNow;}
});

test('reopening a running job resumes watching and retries a failed data reload without another import',async()=>{
 let job={job_id:'existing',status:'running',started_at:new Date().toISOString()},loads=0;
 const h=await harness(null,true,{getStatus:async()=>({configured:true,enabled:true,job}),onComplete:async()=>{loads++;if(loads===1)throw new Error('Connection interrupted');}});
 try{assert.match(h.container.innerHTML,/Update in progress/);assert.equal(h.started,0);
  job={...job,status:'completed'};await h.click('refresh');assert.match(h.container.innerHTML,/Connection interrupted/);assert.equal(loads,1);
  await h.click('refresh');assert.equal(loads,2);assert.doesNotMatch(h.container.innerHTML,/Connection interrupted/);
  await h.click('refresh');assert.equal(loads,2);assert.equal(h.started,0);
 }finally{h.cleanup();}
});

 test('concurrent refreshes share one completion reload',async()=>{
  let job={job_id:'one-job',status:'running',started_at:new Date().toISOString()},release,loads=0;
  const h=await harness(null,true,{getStatus:async()=>({configured:true,enabled:true,job}),onComplete:async()=>{loads++;await new Promise(resolve=>release=resolve);}});
  try{job={...job,status:'completed'};const first=h.click('refresh'),second=h.click('refresh');await new Promise(resolve=>setImmediate(resolve));assert.equal(loads,1);release();await Promise.all([first,second]);await h.click('refresh');assert.equal(loads,1);}finally{h.cleanup();}
 });

test('a status refresh blocks an overlapping new import request',async()=>{
 let release,hold=false;
 const ready={configured:true,enabled:true,job:null};
 const h=await harness(ready,true,{getStatus:async()=>hold?new Promise(resolve=>release=resolve):ready});
 try{hold=true;const refreshing=h.click('refresh');await h.click('start');assert.equal(h.started,0);release(ready);await refreshing;hold=false;await h.click('start');assert.equal(h.started,1);}finally{h.cleanup();}
});
