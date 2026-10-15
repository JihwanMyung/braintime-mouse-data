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


test('in-dish explant time is a separate literal source event, not sampling or inferred phase',()=>{
  const source={date:'2026-10-02',raw_values:{sample:{'Decapitation time':'11:25','In-dish explant time':'11:34','Sampling time':'11:30'},preparation:{'H · In dish explant hour':'11:34 (operator note)'}}},before=structuredClone(source),result=sourceTimingEvidence(source);
  assert.deepEqual(result.rows.map(row=>row.value),['11:25','11:34','11:30','11:34 (operator note)']);
  assert.match(result.rows[0].label,/^Decapitation label/);assert.match(result.rows[1].label,/^In-dish explant timing · sample \/ In-dish explant time$/);assert.match(result.rows[2].label,/^Sampling timing/);assert.match(result.rows[3].label,/^In-dish explant timing/);
  assert.equal(result.rows.some(row=>/Circadian timing/.test(row.label)),false);assert.deepEqual(Object.keys(result),['rows','warnings']);assert.deepEqual(source,before);
  const phase=sourceTimingEvidence({raw_values:{'In-dish explant time (ZT)':'4.5'}});assert.match(phase.rows[0].label,/^Circadian timing label/);assert.equal(phase.rows[0].value,'4.5');
});


test('CSF actual time and misspelled sampling labels stay source values without inferred clock events',()=>{
  const csf={kind:'csf_sample',raw_values:{'Actual time':'13:43:00','Decapitation time':'13:35:00','Actual ZT (CSF ZT)':6.7}},before=structuredClone(csf),result=sourceTimingEvidence(csf);
  assert.match(result.rows[0].label,/^CSF actual-time label/);assert.equal(result.rows[0].value,'13:43:00');assert.match(result.rows[1].label,/^Decapitation label/);assert.match(result.rows[2].label,/^Circadian timing label/);assert.deepEqual(csf,before);assert.deepEqual(Object.keys(result),['rows','warnings']);
  const typo=sourceTimingEvidence({kind:'instrument_channel',raw_values:{sample:{'Samplig time':'prep 2/27, record 3/3-'}}});assert.match(typo.rows[0].label,/^Sampling timing \(source spelling\) · sample \/ Samplig time$/);assert.equal(typo.rows[0].value,'prep 2/27, record 3/3-');
  assert.equal(sourceTimingEvidence({kind:'source_matrix_review',raw_values:{'Actual time':'13:43:00'}}).rows.length,0);
});

test('assay hours and run dates are distinct from animal decapitation and sampling',()=>{
  const result=sourceTimingEvidence({kind:'assay_run',raw_values:{'A · Running time / Date':'2019-08-27T00:00:00','B · / Hour':'14:00:00','C · Sampling time':'11:15:00'}});
  assert.equal(result.rows.length,3);assert.match(result.rows[0].label,/^Assay run date label/);assert.equal(result.rows[0].value,'2019-08-27T00:00:00');assert.match(result.rows[1].label,/^Assay hour label/);assert.equal(result.rows[1].value,'14:00:00');assert.match(result.rows[2].label,/^Sampling timing/);
  assert.equal(sourceTimingEvidence({kind:'source_matrix_review',raw_values:{'/ Hour':'14:00:00'}}).rows.length,0);
});

test('Hour-7 decimal values remain historical derived labels and never become validated ZT',()=>{
  const source={kind:'tissue_sampling',raw_values:{'I · Hour-7 (decimal)':2.066666667,'Brain time DIsk':'Analysis','Circadian Power':31.75412}},before=structuredClone(source),result=sourceTimingEvidence(source);
  assert.equal(result.rows.length,1);assert.match(result.rows[0].label,/^Historical derived time label/);assert.equal(result.rows[0].value,'2.066666667');assert.doesNotMatch(result.rows[0].label,/Circadian timing label/);assert.ok(result.warnings.some(w=>w.includes('Do not infer ZT/CT basis')));assert.deepEqual(source,before);assert.deepEqual(Object.keys(result),['rows','warnings']);
});
