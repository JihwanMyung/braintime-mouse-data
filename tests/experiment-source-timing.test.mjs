import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceTimingEvidence} from '../web/experiment-source-timing.js';

test('separate source timings remain exact and never populate managed fields',()=>{
  const source={raw_values:{sample:{'Decapitation time':'12:12:00','Prep at':'14:55:00','-70ºC sampling time':'15:10:00','Actual ZT (CSF ZT)':2.7,'Brain out (ZT)':2.4},preparation:{'B · Date (prep)':'2021-10-22T00:00:00'}}},before=structuredClone(source),result=sourceTimingEvidence(source);
  assert.equal(result.rows.length,6);assert.match(result.rows[0].label,/Decapitation/);assert.match(result.rows[1].label,/Preparation/);assert.equal(result.rows[2].value,'15:10:00');assert.equal(result.rows[3].value,'2.7');assert.equal(result.rows[4].value,'2.4');assert.deepEqual(source,before);assert.deepEqual(Object.keys(result),['rows','warnings']);
});
test('spreadsheet column CT is not misread as circadian time',()=>{
  assert.deepEqual(sourceTimingEvidence({raw_values:{A:'note',B:'animal',CT:'4'}}),{rows:[],warnings:[]});
  assert.equal(sourceTimingEvidence({raw_values:{'Animal ID':'P1',ZT:3}}).rows[0].value,'3');
});
test('maternal, co-culture, culture removal and corrected times require context',()=>{
  for(const note of ['Decap time is the mother mouse time','Decap time is the time the samples were taken out from lumicycle','*notebook incorrectly logged decap time as 14:07']){
    const result=sourceTimingEvidence({raw_values:{sample:{'Decap time':'16:51 (JM)',Comments:note,'Co-Culture decap time':'10:01'}}});
    assert.ok(result.rows.some(row=>row.value===note));assert.ok(result.warnings.some(value=>value.includes('qualify or correct')));assert.ok(result.warnings.some(value=>value.includes('another donor')));
  }
});
test('a date-only decap field and ambiguous phase never create clock or phase values',()=>{
  const result=sourceTimingEvidence({raw_values:{'A · Date\n(decap hour)':'2025-01-01T00:00:00','I · Hour-7\n(ZT)':60.16666667,'V · Note':'CT mod 24:'}});
  assert.equal(result.rows.length,3);assert.ok(result.warnings.some(value=>value.includes('midnight')));assert.ok(result.warnings.some(value=>value.includes('modulo 24')));
});
test('entrainment and durations stay literal, including numbered groups',()=>{
  const result=sourceTimingEvidence({raw_values:{sample:{Condition:'LP1(30)',Notes:'*58 days in this LP1 cycle.'},preparation:{Comments:'entrained in LP2 from 2025/2/24','J · Schedule':'LD/SD (1): 1st week (entrainment from 6/5)','C · Dur. (days)':9}}});
  assert.equal(result.rows.length,4);assert.ok(result.rows.some(row=>row.value==='LP1(30)'));assert.ok(result.warnings.some(value=>value.includes('counts or duration')));assert.equal(result.rows.some(row=>row.value==='9'),false);
});
test('ranges, schedules and HTML are returned as inert unmodified text',()=>{
  const result=sourceTimingEvidence({raw_values:{'H · Sampling hour':'24h sampling (08:00, 11:00)','RNA sampling time 1':'<b>14:30-16:30</b>'}});
  assert.equal(result.rows[1].value,'<b>14:30-16:30</b>');assert.equal(result.rows[0].value,'24h sampling (08:00, 11:00)');
});
