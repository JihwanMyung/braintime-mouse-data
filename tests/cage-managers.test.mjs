import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCageManagerChoices,cageManagerShortName,cageManagerValue,matchCageManager} from '../web/cage-managers.js';

const person=(id,name,extra={})=>({person_id:id,name,acronym:id,nickname:null,status:'current',...extra});
const people=()=>[person('XC','Xinyue Chen',{nickname:'Cherry'}),person('VN','Vuong Nguyen'),person('JM','Jihwan Myung'),person('HC','陳小華')];

test('short labels prefer an explicit nickname and save the canonical roster name',()=>{
 const rows=people(),choices=buildCageManagerChoices(rows,'Cherry');
 assert.deepEqual(choices,[['','—',false],['Xinyue Chen','Cherry',false],['Jihwan Myung','Jihwan',false],['Vuong Nguyen','Vuong',false],['陳小華','陳小華',false]]);
 assert.equal(cageManagerValue(rows,'Cherry'),'Xinyue Chen');
 assert.equal(cageManagerShortName(rows,'Xinyue Chen'),'Cherry');
 assert.equal(cageManagerShortName(rows,'VN'),'Vuong');
 assert.equal(cageManagerShortName(rows,'陳小華'),'陳小華');
});

test('unambiguous full names, nicknames, acronyms and Latin first names match without case sensitivity',()=>{
 const rows=[...people(),person('HV','Hélène Vitet')];
 for(const value of ['Xinyue Chen',' xinyue   chen ','cherry','xc','Xinyue'])assert.equal(matchCageManager(rows,value)?.person_id,'XC',value);
 assert.equal(cageManagerValue(rows,'hélène'),'Hélène Vitet');
 assert.equal(cageManagerValue(rows,'Hélène'.normalize('NFD')),'Hélène Vitet');
 assert.equal(matchCageManager(rows,'陳'),null);
 assert.equal(matchCageManager(rows,'Helene'),null,'Accents are not discarded to invent an identity');
 assert.equal(matchCageManager(rows,'Vuo'),null,'Partial name prefixes are not matches');
});

test('duplicate short names use distinct acronyms and ambiguous input remains a disabled legacy assignment',()=>{
 const rows=[person('AC','Alex Chen'),person('AL','Alex Lee')];
 assert.deepEqual(buildCageManagerChoices(rows,'Alex'),[['','—',false],['Alex','Alex',true],['Alex Chen','Alex (AC)',false],['Alex Lee','Alex (AL)',false]]);
 assert.equal(matchCageManager(rows,'Alex'),null);assert.equal(cageManagerValue(rows,'Alex'),'Alex');
 assert.equal(cageManagerShortName(rows,'Alex Chen'),'Alex (AC)');
 assert.equal(cageManagerValue(rows,'AC'),'Alex Chen');
});

test('duplicate acronyms or absent acronyms fall back to full names',()=>{
 const rows=[person('1','Alex Chen',{acronym:'A'}),person('2','Alex Lee',{acronym:'A'}),person('3','Alex Brown',{acronym:''})];
 assert.deepEqual(buildCageManagerChoices(rows),[['','—',false],['Alex Brown','Alex Brown',false],['Alex Chen','Alex Chen',false],['Alex Lee','Alex Lee',false]]);
 assert.equal(matchCageManager(rows,'A'),null);
});

test('alias collisions across acronym, nickname and first name do not resolve a different person',()=>{
 const rows=[person('JN','Jules North',{acronym:'Cherry'}),person('XC','Xinyue Chen',{nickname:'Cherry'})];
 assert.equal(matchCageManager(rows,'Cherry'),null);assert.equal(cageManagerShortName(rows,'Cherry'),'Cherry');
 assert.deepEqual(buildCageManagerChoices(rows,'Cherry')[1],['Cherry','Cherry',true]);
 assert.equal(cageManagerValue(rows,'Xinyue Chen'),'Xinyue Chen');
});

test('exact canonical names take priority over another person’s short alias',()=>{
 const rows=[person('1','Alex'),person('2','Alex Lee')];
 assert.equal(matchCageManager(rows,'Alex')?.person_id,'1');
 assert.equal(cageManagerValue(rows,'Alex'),'Alex');
});

test('Current and server-selected Historical directory records are included, Review and archived are not',()=>{
 const rows=[person('CUR','Current Person',{cage_manager_eligible:false}),person('HIST','Historical Person',{status:'historical'}),person('YES','Selected Person',{status:'historical',cage_manager_eligible:true}),person('NO','Excluded Person',{status:'historical',cage_manager_eligible:false}),person('REVIEW','Review Person',{status:'review',cage_manager_eligible:true}),person('OLD','Archived Person',{archived:true,cage_manager_eligible:true})];
 assert.deepEqual(buildCageManagerChoices(rows).slice(1).map(row=>row[0]),['Current Person','Historical Person','Selected Person']);
 assert.equal(matchCageManager(rows,'Review Person'),null);
 assert.deepEqual(buildCageManagerChoices(rows,'Archived Person')[1],['Archived Person','Archived Person',true]);
});

test('duplicate canonical names cannot be assigned ambiguously through the name-string model',()=>{
 const rows=[person('A1','Alex Chen'),person('A2','alex chen')];
 assert.deepEqual(buildCageManagerChoices(rows),[['','—',false]]);
 assert.equal(matchCageManager(rows,'Alex Chen'),null);assert.equal(matchCageManager(rows,'A1'),null);
 assert.deepEqual(buildCageManagerChoices(rows,'Alex Chen'),[['','—',false],['Alex Chen','Alex Chen',true]]);
});

test('empty and invalid input remains safe and unmatched assignments are retained verbatim',()=>{
 assert.deepEqual(buildCageManagerChoices(null),[['','—',false]]);
 assert.equal(cageManagerShortName(null,''),'—');assert.equal(cageManagerValue(null,null),'');
 const malformed=[null,{},person('A',''),person('B','Wrong Status',{status:'review'}),person('C','Missing Status',{status:undefined}),person('D','Invalid Flag',{status:'historical',cage_manager_eligible:'true'})];
 assert.deepEqual(buildCageManagerChoices(malformed,'Previous person'),[['','—',false],['Previous person','Previous person',true]]);
 assert.equal(cageManagerShortName(people(),'Previous person'),'Previous person');
});

test('helper keeps source data unchanged and deduplicates repeated directory rows',()=>{
 const rows=people(),before=structuredClone(rows);Object.freeze(rows);rows.forEach(Object.freeze);
 buildCageManagerChoices(rows,'JM');cageManagerShortName(rows,'JM');assert.deepEqual(rows,before);
 assert.equal(buildCageManagerChoices([...rows,rows[0]]).length,rows.length+1);
 const conflicting=[person('SAME','First Person'),person('SAME','Different Person')];
 assert.deepEqual(buildCageManagerChoices(conflicting),[['','—',false]]);
});

test('acronym-decorated short labels do not collide with an explicit nickname',()=>{
 const rows=[person('AC','Alex Chen'),person('AL','Alex Lee'),person('TS','Taylor Sample',{nickname:'Alex (AC)'})];
 const choices=buildCageManagerChoices(rows);
 assert.equal(choices.find(row=>row[0]==='Alex Chen')[1],'Alex Chen');
 assert.equal(choices.find(row=>row[0]==='Taylor Sample')[1],'Taylor Sample');
 assert.equal(new Set(choices.map(row=>row[1])).size,choices.length);
});
