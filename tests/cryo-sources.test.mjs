import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {discoverCryoSources} from '../web/cryo-sources.js';

const headers=['案件編號','品系','遺傳背景','基改方式','基因名稱','合子型','來源','麥管批號','冷凍日期','結餘管數','製表人 / 發行人','實驗鼠種原庫服務'];
function fixture(snapshots) {
  const sources=[],sheets=[],cells=[];
  snapshots.forEach((snapshot,index)=>{
    sources.push({file_id:`synthetic-${index}`,title:`Synthetic snapshot ${index}`,url:`https://example.test/archive-${index}`,snapshot_date:snapshot.date,snapshot_date_basis:snapshot.basis||'date_in_title'});
    sheets.push({source_index:index,title:'Cryopreservation',sheet_id:9});
    const rows={1:['Cryopreservation information'],2:headers,3:['CASE-A','Synthetic reporter line','Synthetic background','Knock-in','Reporter: heterozygous','raw zygosity','Synthetic origin','BATCH-1, BATCH-2','2022-01-01',10,'Synthetic preparer','0000123'],5:['Strains to transfer'],6:[1,'Synthetic planned line','TAG','M & F'],...snapshot.rows};
    for(const [number,values] of Object.entries(rows))values.forEach((value,column)=>{if(value!==null&&value!==undefined)cells.push([index,`${String.fromCharCode(65+column)}${number}`,value,value,null,'General',null]);});
  });
  return {sources,sheets,cells};
}
const empty={tables:{historical_observations:[]}};

test('repeated snapshots yield one case aggregate and a separate transfer plan',()=>{
  const index=fixture([{date:'2023-01-01'},{date:'2024-01-01'}]),before=JSON.stringify(index),found=discoverCryoSources(empty,index);
  assert.equal(JSON.stringify(index),before);assert.equal(found.groups.length,1);assert.equal(found.plans.length,1);
  const group=found.groups[0];assert.equal(group.reported_remaining,10);assert.deepEqual(group.batch_ids,['BATCH-1','BATCH-2']);assert.equal(group.quantity,undefined);assert.equal(group.material,null);assert.equal(group.storage_location,null);assert.equal(group.source_snapshots.length,2);assert.equal(group.service_reference,'0000123');
  assert.equal(group.source_snapshot_date,'2024-01-01');assert.equal(group.reported_quantity_source.snapshot_date,'2024-01-01');
  assert.equal(group.sources[0].cell,'A3:L3');assert.match(group.sources[0].url,/#gid=9&range=A3%3AL3$/);
  assert.equal(found.plans[0].status,'planned_transfer');assert.equal(found.plans[0].source_snapshots.length,2);
  assert.equal(found.coverage.source_sheet_count,2);assert.equal(found.coverage.distinct_content_versions,1);assert.equal(found.coverage.case_observation_count,2);
});

test('blank balance is unknown, zero is preserved and material cannot be inferred from a batch prefix',()=>{
  const index=fixture([{date:'2024-01-01',rows:{3:['CASE-A','Synthetic line',null,null,null,null,null,'SP-ONE','2023-10-19',null],4:['CASE-B','Other synthetic line',null,null,null,null,null,'SP-TWO','2023-10-19',0]}}]);
  const {groups}=discoverCryoSources(empty,index);assert.equal(groups[0].reported_remaining,null);assert.equal(groups[1].reported_remaining,0);assert.equal(groups[0].material,null);assert.deepEqual(groups[0].reported_quantity_candidates,[]);
  assert.match(groups[0].warnings.join(' '),/blank is not zero/);
});

test('full batch list participates in identity; differing lists are flagged without allocating counts',()=>{
  const index=fixture([{date:'2023-01-01'},{date:'2024-01-01',rows:{3:['CASE-A','Synthetic line',null,null,null,null,null,'BATCH-1','2022-01-01',4]}}]);
  const found=discoverCryoSources(empty,index);assert.equal(found.groups.length,2);assert.equal(found.coverage.unique_case_count,1);assert(found.groups.every(group=>group.warnings.some(message=>message.includes('different full batch lists'))));
  const same=fixture([{date:'2023-01-01'},{date:'2024-01-01',rows:{3:['CASE-A','Synthetic line',null,null,null,null,null,'BATCH-2; BATCH-1','2022-01-01',8]}}]);
  const merged=discoverCryoSources(empty,same);assert.equal(merged.groups.length,1);assert.equal(merged.groups[0].reported_remaining,8);assert.match(merged.groups[0].warnings.join(' '),/not interpreted as usage/);
});

test('a later blank does not fabricate a new count; equally dated conflicting quantities stay unresolved',()=>{
  const old=fixture([{date:'2023-01-01'},{date:'2024-01-01',rows:{3:['CASE-A','Synthetic line',null,null,null,null,null,'BATCH-1, BATCH-2','2022-01-01',null]}}]);
  const group=discoverCryoSources(empty,old).groups[0];assert.equal(group.reported_remaining,10);assert.equal(group.reported_quantity_source.snapshot_date,'2023-01-01');assert.equal(group.source_snapshot_date,'2024-01-01');
  const conflict=fixture([{date:'2024-01-01'},{date:'2024-01-01',rows:{3:['CASE-A','Synthetic line',null,null,null,null,null,'BATCH-1, BATCH-2','2022-01-01',7]}}]);
  const disputed=discoverCryoSources(empty,conflict).groups[0];assert.equal(disputed.reported_remaining,null);assert.deepEqual([...disputed.reported_quantity_candidates].sort(),[10,7]);assert.match(disputed.warnings.join(' '),/Equally dated/);
  conflict.sources[1]={...conflict.sources[0]};
  const sameFile=discoverCryoSources(empty,conflict).groups[0];assert.equal(sameFile.source_snapshots.length,2);assert.equal(sameFile.reported_remaining,null);
});

test('raw allele and zygosity strings are retained even when inconsistent; invalid dates/counts are not repaired',()=>{
  const index=fixture([{date:'2024-01-01',rows:{3:['CASE-A','Line (DONOR-M1/M2)',null,null,'Reporter: heterozygous','homozygote',null,null,'2023-02-30',-1]}}]);
  const group=discoverCryoSources(empty,index).groups[0];assert.equal(group.gene,'Reporter: heterozygous');assert.equal(group.zygosity,'homozygote');assert.equal(group.frozen_date,null);assert.equal(group.reported_remaining,null);assert.equal(group.donor_mouse_sids,undefined);assert.equal(group.raw_cells,undefined);assert.equal(group.source_snapshots[0].raw_cells.find(cell=>cell.cell==='J3').raw_value,-1);
});

test('historical excerpts stay partial; they cannot fabricate case IDs, donors or quantities',()=>{
  const d={tables:{historical_observations:[{source_title:'Synthetic source',source_file_id:'synthetic-0',source_sheet:'Cryopreservation',source_cell:'B3',raw_text:'Line M1/M2',mouse_sids:['SYN-1'],source_snapshot_date:'2024-01-01',source_url:'javascript:bad()'}]}};
  const found=discoverCryoSources(d);assert.equal(found.groups.length,0);assert.equal(found.plans.length,0);assert.equal(found.partials.length,1);assert.equal(found.partials[0].case_id,null);assert.equal(found.partials[0].reported_remaining,null);assert.equal(found.partials[0].url,'');assert.equal(found.partials[0].mouse_sids,undefined);assert.match(found.warnings.join(' '),/Load the full-cell archive/);
  assert.equal(discoverCryoSources(d,fixture([{date:'2024-01-01'}])).partials.length,0);
});

test('source dates and counts use valid cached values without executing formulas',()=>{
  const index=fixture([{date:'2024-01-01'}]),count=index.cells.find(cell=>cell[1]==='J3');count[2]='=SUM(X1:X9)';count[3]=6;count[4]='=SUM(X1:X9)';
  const group=discoverCryoSources(empty,index).groups[0];assert.equal(group.reported_remaining,6);assert.equal(group.source_snapshots[0].raw_cells.find(cell=>cell.cell==='J3').formula,'=SUM(X1:X9)');
  assert.deepEqual(discoverCryoSources(empty).coverage,{source_sheet_count:0,distinct_content_versions:0,case_observation_count:0,unique_case_count:0,group_count:0,plan_observation_count:0,unique_plan_count:0,partial_record_count:0,full_index_available:false});
});

test('private archive reconstructs seven cases and six plans from repeated source snapshots',async context=>{
  let d,h;try{[d,h]=await Promise.all(['dataset_augmented.json','history_cells.json'].map(async name=>JSON.parse(await readFile(new URL(`../../outputs/reconstruction_2026-10-14/${name}`,import.meta.url),'utf8'))));}catch(error){if(error.code!=='ENOENT')throw error;context.skip('Private source fixtures are not part of the public repository.');return;}
  const found=discoverCryoSources(d,h);assert.deepEqual(found.coverage,{source_sheet_count:7,distinct_content_versions:2,case_observation_count:41,unique_case_count:7,group_count:7,plan_observation_count:42,unique_plan_count:6,partial_record_count:0,full_index_available:true});
  assert.equal(found.groups.filter(group=>group.reported_remaining===10).length,3);assert.equal(found.groups.filter(group=>group.reported_remaining===null).length,4);assert(found.groups.every(group=>group.material===null&&group.storage_location===null));
  const fallback=discoverCryoSources(d);assert.equal(fallback.groups.length,0);assert.equal(fallback.partials.length,62);
});
