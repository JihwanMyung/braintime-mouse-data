import test from 'node:test';
import assert from 'node:assert/strict';
import {lightClock} from '../web/husbandry.js';
test('LD default is explicit and does not overwrite source values',()=>{
 const raw={protocol:'LD',timezone:'Asia/Taipei'},before=structuredClone(raw);
 assert.deepEqual(lightClock(raw),{label:'On 07:00 · Off 19:00',zone:'Asia/Taipei',defaulted:true});assert.deepEqual(raw,before);
 assert.deepEqual(lightClock({protocol:'LD',lights_on:'08:30',lights_off:'20:30'}),{label:'On 08:30 · Off 20:30',zone:'Asia/Taipei',defaulted:false});
 assert.equal(lightClock({protocol:'LD',lights_on:'08:30'}).label,'On 08:30 · Off ?');
});
test('continuous and nonstandard schedules do not inherit LD clock defaults',()=>{
 assert.equal(lightClock({protocol:'DD',lights_on:'07:00',lights_off:'19:00'}).label,'Dark all day');
 assert.equal(lightClock({protocol:'LL'}).label,'Light all day');
 for(const e of [{protocol:'T-cycle',cycle_hours:23},{protocol:'LP1'},{protocol:'LD',cycle_hours:24,light_hours:16},{}])assert.equal(lightClock(e).label,'Clock times unknown');
 assert.equal(lightClock({protocol:'LD',timezone:'America/New_York'}).zone,'America/New_York');
});
