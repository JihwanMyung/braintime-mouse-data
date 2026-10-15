import test from 'node:test';
import assert from 'node:assert/strict';
import {experimentSources,hydrateExperimentSource,sourceAnimalCandidates,sourceParticipants,sourceProvenance,reviewedSourceMap} from '../web/experiment-sources.js';

const fixture=()=>({tables:{mice:[{mouse_sid:'SID-1',physical_tag:"P'12",alternate_id:'Old P1'},{mouse_sid:'SID-2',physical_tag:"P'12"},{mouse_sid:'SID-3',physical_tag:'P12'}],experiment_sources:[{source_id:'S1',raw_identifiers:['P′12','Missing tag','P′12'],raw_values:{A2:'original'},provenance:[{sheet_name:'LumiCycle',range:'A2'}]}],husbandry_events:[]}});
test('only explicit recovered source observations are listed',()=>{
  const d=fixture();d.tables.experiment_sources.push(null,{source_id:42});assert.equal(experimentSources(d).length,1);assert.deepEqual(experimentSources({tables:{}}),[]);
});
test('exact candidate matching preserves prime modifiers and multiple matches',()=>{
  const d=fixture();assert.deepEqual(sourceAnimalCandidates(' P′12 ',d).map(m=>m.mouse_sid),['SID-1','SID-2']);assert.deepEqual(sourceAnimalCandidates('P12',d).map(m=>m.mouse_sid),['SID-3']);assert.deepEqual(sourceAnimalCandidates('Old P1',d).map(m=>m.mouse_sid),['SID-1']);assert.deepEqual(sourceAnimalCandidates('P1',d),[]);
});
test('bare numeric source labels cannot match internal SIDs but explicit external aliases remain eligible',()=>{
 const d={tables:{mice:[{mouse_sid:'37',physical_tag:'F-OTHER',sex:'F'},{mouse_sid:'TAG-37',physical_tag:'37',sex:'M'},{mouse_sid:'ALT-37',alternate_id:'３７'},{mouse_sid:'00038',physical_tag:'DIFFERENT'},{mouse_sid:'SID-39',physical_tag:'P39'}]}};
 const before=structuredClone(d);
 for(const raw of ['37',' 37 ','３７'])assert.deepEqual(sourceAnimalCandidates(raw,d).map(m=>m.mouse_sid),['TAG-37','ALT-37']);
 assert.deepEqual(sourceAnimalCandidates('00038',d),[]);assert.deepEqual(sourceAnimalCandidates('SID-39',d).map(m=>m.mouse_sid),['SID-39']);
 const refs=sourceParticipants({raw_identifiers:['37','00038','SID-39']},d);assert.deepEqual(refs.map(r=>r.candidate_sids),[['TAG-37','ALT-37'],[],['SID-39']]);assert(refs.every(r=>r.link_status==='unresolved'&&r.mouse_sid===null));assert.deepEqual(d,before);
});
test('even a single exact candidate remains unresolved until user review',()=>{
  const d=fixture(),refs=sourceParticipants({raw_identifiers:['SID-1','Unknown']},d);assert.equal(refs[0].mouse_sid,null);assert.equal(refs[0].link_status,'unresolved');assert.deepEqual(refs[0].candidate_sids,['SID-1']);assert.deepEqual(refs[1].candidate_sids,[]);
  assert.equal(sourceParticipants(d.tables.experiment_sources[0],d).length,2);
});

test('explicit sample labels never become proposed animal participants even when a tag matches',()=>{
  const d=fixture();assert.deepEqual(sourceParticipants({identifier_kind:'sample_label',raw_identifiers:['SID-1',"P'12"]},d),[]);
  assert.equal(sourceParticipants({raw_identifiers:['SID-1']},d).length,1);
});
test('provenance copies exact source observations without changing input',()=>{
  const source={...fixture().tables.experiment_sources[0],workbook_title:'Experiment Sheet',sheet_name:'IMG',range:'A2:H2',source_url:'https://example.test/source',content_hash:'digest',snapshot_date:'2024-06-01'},before=structuredClone(source),p=sourceProvenance(source);
  assert.equal(p.source_id,'S1');assert.equal(p.source_title,'Experiment Sheet');assert.equal(p.source_sha256,'digest');assert.deepEqual(p.source_refs,source.provenance);assert.deepEqual(p.source_raw_values,source.raw_values);
  p.source_raw_values.A2='changed';p.source_refs[0].range='A4';assert.deepEqual(source,before);
});
test('archival does not make a previously reviewed source eligible for duplicate import',()=>{
  const d=fixture();d.tables.husbandry_events=[{event_id:'E1',event_type:'experiment',source_id:'S1',archived:true},{event_id:'E2',event_type:'experiment',source_id:'S2',app_archived_at:'2026-10-14T00:00:00Z'},{event_id:'SAMPLE',event_type:'experiment_sample',source_id:'S3'}];const map=reviewedSourceMap(d);assert.equal(map.get('S1').event_id,'E1');assert.equal(map.get('S2').event_id,'E2');assert.equal(map.has('S3'),false);
});

test('candidate index scans mouse identifiers once per immutable dataset rather than once per observation',()=>{
  let reads=0;const mice=Array.from({length:3280},(_,i)=>({mouse_sid:`SID-${i}`,get physical_tag(){reads++;return `TAG-${i}`}})),d={tables:{mice}};
  for(let i=0;i<1000;i++)assert.equal(sourceAnimalCandidates(`TAG-${i%3280}`,d)[0].mouse_sid,`SID-${i%3280}`);
  assert.equal(reads,3280);
  const result=sourceAnimalCandidates('TAG-0',d);result.pop();assert.equal(sourceAnimalCandidates('TAG-0',d).length,1);
  d.tables.mice=[{mouse_sid:'NEW',physical_tag:'TAG-0'}];assert.equal(sourceAnimalCandidates('TAG-0',d)[0].mouse_sid,'NEW');
  d.tables.mice.push({mouse_sid:'SECOND',physical_tag:'TAG-0'});assert.equal(sourceAnimalCandidates('TAG-0',d).length,2);
  assert.equal(sourceAnimalCandidates('TAG-0',{tables:{mice:[{mouse_sid:'OTHER',physical_tag:'TAG-0'}]}})[0].mouse_sid,'OTHER');
});

test('compact primary rows are cached while all references and shared preparation expand only on demand',()=>{
  const d={tables:{experiment_sources:[{source_id:'S1',kind:'instrument_channel',workbook_id:'BOOK_A',sheet_id:9,sheet_name:'LumiCycle',range:'A2:C2',context_id:'CTX',raw_values:{sample:{animal:'P1'}},provenance_refs:[[0,9,'LumiCycle','A2:C2'],[1,11,'Old LumiCycle','B4:D4']]}],experiment_source_catalog:[{file_id:'BOOK_A',title:'Experiment Sheet',snapshot_date:'2026-01-01',archive_sha256:'hash-A'},{file_id:'BOOK_B',title:'Experiment Sheet backup',snapshot_date:'2025-01-01',archive_sha256:'hash-B'}],experiment_source_contexts:[{context_id:'CTX',values:{condition:'LD12:12',comments:'Original preparation'}}]}};
  const rows=experimentSources(d);assert.strictEqual(experimentSources(d),rows);assert.equal(rows[0].workbook_title,'Experiment Sheet');assert.equal(rows[0].raw_values.preparation,undefined);assert.equal(rows[0].provenance,undefined);
  const full=hydrateExperimentSource(rows[0],d);assert.equal(full.provenance.length,2);assert.equal(full.provenance[1].workbook_title,'Experiment Sheet backup');assert.equal(full.provenance[1].archive_sha256,'hash-B');assert.match(full.provenance[1].source_url,/BOOK_B\/edit\?gid=11#gid=11&range=B4%3AD4/);assert.equal(full.raw_values.preparation.condition,'LD12:12');
  const preserved=sourceProvenance(rows[0],d);assert.equal(preserved.source_refs.length,2);assert.equal(preserved.source_raw_values.preparation.comments,'Original preparation');assert.deepEqual(preserved.source_observation.provenance_refs,d.tables.experiment_sources[0].provenance_refs);
  d.tables.experiment_source_catalog=[{file_id:'BOOK_A',title:'Updated catalog'}];assert.notStrictEqual(experimentSources(d),rows);assert.equal(experimentSources(d)[0].workbook_title,'Updated catalog');
});

test('source links reject executable schemes and encode observed Google cell ranges safely',()=>{
  const d={tables:{experiment_sources:[{source_id:'BAD',source_url:'javascript:alert(1)',provenance:[{source_url:'data:text/html,bad'}]}]}};
  assert.equal(experimentSources(d)[0].source_url,null);assert.equal(hydrateExperimentSource(experimentSources(d)[0],d).provenance[0].source_url,null);
  d.tables.experiment_sources=[{source_id:'SAFE',workbook_id:'ABC_123',sheet_id:12,range:'A1:B2&x=<script>'}];assert.equal(experimentSources(d)[0].source_url,'https://docs.google.com/spreadsheets/d/ABC_123/edit?gid=12#gid=12&range=A1%3AB2%26x%3D%3Cscript%3E');
});
