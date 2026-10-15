import {explicitCreName,legacyVgatCreName} from './strain-registry.js?v=36';
import { getBreedingOptions } from './breeding-options.js?v=24';
import { mouseLineAssignments } from './mouse-summary.js?v=39';
import { validateGeneticProfile } from './genotype-schema.js';

const text=value=>typeof value==='string'?value:'';
const rows=value=>Array.isArray(value)?value:[];
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const aliases=[
  ['P',/^PER2\s*:{1,2}\s*LUC$/i],['E',/^Bmal1-ELuc$/i],
  ['B',/^Bmal1(?:[- ]flox(?:ed)?)?$/i],['F',/^FoxJ(?:1)?-Cre$/i],
  ['V',/^Vip-Cre$/i],['AD',/^APP\s*\/\s*PS1$/i],['A',/^Avp-Cre$/i],
  ['32',/^Ai32$/i],['96',/^Ai96$/i],['Vg',/^Vgat(?:[- ]flox(?:ed)?)?$/i],
  ['Gt',/^GAD67-tTA(?:2)?$/i],['Meis1',/^Meis1(?:[- ]flox(?:ed)?)?$/i],
];
const sourceLabel=/^(PER2\s*:{1,2}\s*LUC|Bmal1-ELuc|Bmal1(?:[- ]flox(?:ed)?)?|FoxJ(?:1)?-Cre|Vip-Cre|APP\s*\/\s*PS1|Avp-Cre|Ai32|Ai96|Vgat(?:-Cre|[- ]flox(?:ed)?)?|GAD67-tTA(?:2)?|Meis1(?:[- ]flox(?:ed)?)?|WT)(?=$|[\s(])\s*(.*)$/i;
const keyFor=value=>aliases.find(([,pattern])=>pattern.test(text(value).trim()))?.[0];
const profileKey=value=>['P','E','B','F','V','AD','A','32','96','Vg','Gt'].includes(text(value).trim())?text(value).trim():keyFor(value);
const genericKey=value=>`locus:${text(value).trim().toLowerCase()}`;
const pairKey=alleles=>[...alleles].sort().join('/');
const isRosa26=locus=>/^(?:Gt\(ROSA\)26Sor|rosa26)$/i.test(locus.name)||/^rosa26$/i.test(locus.id);
const compactToken=/AD|Vg|Gt|WT|32|96|[PEBFVA]/y;

// Clear lab shorthand is a recorded genotype for this count. An unprimed
// token does not invent an allele pair or heterozygous transmission model.
function compactResults(value,isTag=false) {
  let input=text(value).trim().replace(/[‘’′]/g,"'");
  if(!input||/^\d+$/.test(input)&&(isTag||!['32','96'].includes(input)))return null;
  if(isTag)input=input.replace(/^[MF]\d+-/,'').replace(/(?:-[MF]\d*|[MF]\d+)$/,'');
  input=input.replace(/\s+/g,'');
  const entries=[];let at=0,valid=true;
  function sequence(inGroup=false) {
    while(at<input.length) {
      if(/\s/.test(input[at])){at++;continue;}
      if(input[at]===')'){if(!inGroup){valid=false;return;}at++;return;}
      if(input[at]==='('){at++;const start=entries.length;sequence(true);if(entries.length===start){valid=false;return;}for(const entry of entries.slice(start))entry.uncertain=true;continue;}
      compactToken.lastIndex=at;const match=compactToken.exec(input);
      if(!match){valid=false;return;}at+=match[0].length;
      let uncertain=false,prime=false;
      const pending=input.slice(at).match(/^\(\s*'+\s*\)/);
      if(pending){uncertain=true;at+=pending[0].length;}
      else if(input[at]==="'"){prime=true;at++;}
      if(input[at]==='?'){uncertain=true;at++;}
      entries.push({key:match[0],uncertain,result:match[0]==='WT'?'wild/wild':prime?'variant/variant':'positive'});
    }
    if(inGroup)valid=false;
  }
  sequence();return valid&&entries.length&&at===input.length?entries:null;
}

function completeCalls(calls) {
  if(!calls?.size)return false;
  const pairs=[...calls].filter(call=>call!=='positive');
  return pairs.length<=1&&!(calls.has('positive')&&calls.has('wild/wild'));
}

function localDate() {
  const now=new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

function calendarDay(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const stamp=Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?stamp/86400000:null;
}

function sourcePair(key,body) {
  const normalized=text(body).trim().toLowerCase();
  if(/^(?:negative|neg|absent|wt|wild[- ]?type)$/.test(normalized))return 'wild/wild';
  const pair=normalized.split('/').map(value=>value.trim());
  if(pair.length!==2)return null;
  if(key==='B'||key==='Vg'||key==='Meis1') {
    // A gene-only +/- result does not identify a floxed allele.
    if(!pair.every(value=>['fl','f','flox','floxed','+','wt'].includes(value)))return null;
    return pairKey(pair.map(value=>['fl','f','flox','floxed'].includes(value)?'variant':'wild'));
  }
  if(key==='WT')return pair.every(value=>value==='+'||value==='wt')?'wild/wild':null;
  if(!pair.every(value=>['+','-','wt'].includes(value)))return null;
  return pairKey(pair.map(value=>value==='+'?'variant':'wild'));
}

function sourceResults(values) {
  const required=new Set(),calls=new Map(),unresolved=new Set();let invalid=false;
  for(const value of values)for(const piece of text(value).split(/[,;\n]/)) {
    const entry=piece.trim();
    if(!entry||/^(?:none|n\/a|null)$/i.test(entry))continue;
    const match=entry.match(sourceLabel);
    if(!match) {
      const compact=compactResults(entry);
      if(compact) {
        for(const {key,uncertain,result} of compact) {
          required.add(key);
          if(uncertain){unresolved.add(key);continue;}
          if(!calls.has(key))calls.set(key,new Set());calls.get(key).add(result);
        }
        continue;
      }
      const shortCall=entry.match(/^(AD|Vg|Gt|32|96|[PEBFVA])(?:\s*\(([^()]*)\)|\s+(.+))$/);
      if(shortCall) {
        const key=shortCall[1],result=sourcePair(key,shortCall[2]??shortCall[3]);required.add(key);
        if(!result){unresolved.add(key);continue;}
        if(!calls.has(key))calls.set(key,new Set());calls.get(key).add(result);continue;
      }
      const generic=entry.match(/^([A-Za-z][A-Za-z0-9_.:-]{1,60})(?:\s*\([^()]*\))?$/);
      if(generic){required.add(genericKey(generic[1]));continue;}
      invalid=true;continue;
    }
    const key=legacyVgatCreName(match[1])?'Vg':keyFor(match[1])||'WT';required.add(key);
    const suffix=match[2].trim();
    if(!suffix)continue; // A name is a target, never an assay result.
    const parenthesized=suffix.match(/^\(([^()]*)\)$/);
    const body=parenthesized?parenthesized[1]:suffix;
    const result=legacyVgatCreName(match[1])&&!/(?:^|\/)\s*fl\s*(?:\/|$)/i.test(body)?null:sourcePair(key,body);
    if(!result){unresolved.add(key);continue;}
    if(!calls.has(key))calls.set(key,new Set());calls.get(key).add(result);
  }
  return {required,calls,unresolved,invalid};
}

function profileKeys(locus) {
  const named=profileKey(locus.name)||(explicitCreName(locus.name)?null:profileKey(locus.id));
  if(named)return [named];
  if(isRosa26(locus)) {
    return [...new Set(locus.alleles.map(profileKey).filter(key=>key==='32'||key==='96'))];
  }
  return [genericKey(locus.name)];
}

/** Complete recorded genotyping, not independent verification of an assay.
 * A reviewed profile requires confirmed two-allele calls at every declared
 * locus. Otherwise explicit compatible current calls or clear lab shorthand
 * qualify, with current genotype calls taking precedence over physical tags.
 * Every strain indicated by current tags/line labels must be covered, including
 * negative results. Broad strain names, inferred parentage and archive prose do
 * not establish genotyping. A reviewed call supersedes older source text for that
 * target; it does not silently resolve additional untyped targets.
 */
export function isMouseGenotyped(mouse,geneRows=[]) {
  if(!mouse||typeof mouse!=='object')return false;
  const genes=rows(geneRows).filter(row=>row&&mouse.mouse_sid!==undefined&&String(row.mouse_sid)===String(mouse.mouse_sid)&&!archived(row));
  const values=[mouse.genotype,...genes.map(row=>row.gene_value)];
  const source=sourceResults(values),required=new Set(source.required),reviewed=new Set();let reviewedRosa26=false;
  const tag=sourceResults([]);
  for(const entry of compactResults(mouse.physical_tag,true)||[]) {
    required.add(entry.key);
    if(entry.uncertain){tag.unresolved.add(entry.key);continue;}
    if(!tag.calls.has(entry.key))tag.calls.set(entry.key,new Set());tag.calls.get(entry.key).add(entry.result);
  }
  // A broad line label is not a genotype call, but explicit uncertainty in it
  // must not be silently resolved by a clear physical tag alone.
  for(const key of sourceResults([mouse.mouseline]).unresolved)tag.unresolved.add(key);
  // Inspect labels separately so a negative assay cannot erase an untyped
  // additional target from the required set.
  for(const field of ['physical_tag','mouseline'])for(const key of Object.keys(mouseLineAssignments({[field]:mouse[field]})))required.add(key);
  for(const label of text(mouse.mouseline).split(/[,;\n]/)) {
    const match=label.trim().match(sourceLabel),key=match&&keyFor(match[1]);
    if(key)required.add(key);
  }
  for(const value of values)for(const key of Object.keys(mouseLineAssignments({genotype:value})))required.add(key);
  const profile=mouse.genetic_profile;
  if(profile!==undefined&&profile!==null) {
    if(validateGeneticProfile(profile).length)return false;
    for(const locus of profile.loci) {
      const call=profile.calls[locus.id];
      if(call.evidence!=='confirmed'||call.alleles.length!==2)return false;
      const keys=profileKeys(locus);
      // Distinct record IDs cannot make the same biological target independent.
      if(keys.some(key=>reviewed.has(key)))return false;
      if(isRosa26(locus)&&keys.includes('32')&&keys.includes('96'))reviewedRosa26=true;
      for(const key of keys){required.add(key);reviewed.add(key);}
    }
  }
  // Unrecognized prose or malformed source notation cannot be silently
  // declared complete, even alongside a partially reviewed profile.
  if(source.invalid)return false;
  if(!required.size)return false;
  // Ai32 and Ai96 share Rosa26. Separate source pairs cannot establish a
  // complete two-copy genotype; require one reviewed Rosa26 allele pair.
  if(required.has('32')&&required.has('96')&&!reviewedRosa26)return false;
  for(const key of required) {
    if(reviewed.has(key))continue;
    if(source.unresolved.has(key))return false;
    if(source.calls.has(key)){if(!completeCalls(source.calls.get(key)))return false;continue;}
    if(tag.unresolved.has(key)||!completeCalls(tag.calls.get(key)))return false;
  }
  return true;
}

const recordId=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
const sexKey=value=>/^(?:male|m)$/i.test(text(value).trim())?'male':/^(?:female|f)$/i.test(text(value).trim())?'female':null;
function recordIndex(records,key,signature){const map=new Map();for(const record of rows(records)){if(!record||typeof record!=='object')continue;const id=recordId(record[key]);if(!id)continue;const value=signature(record),old=map.get(id);if(!old)map.set(id,{record,signature:value,ambiguous:false});else if(old.signature!==value)old.ambiguous=true;}return map;}
/** Literal M/F-number suffixes in the animal column only. A strain token F or
 * a note elsewhere in the block does not establish the animal's sex. */
export function classifyAnimalSheetBreedingBlock(position={}){
 const header=text(position.source_cell).match(/^([A-Z]+)(\d+)$/),evidence=[],unresolved=[],seen=new Set();if(!header)return {male:0,female:0,mixed:false,evidence,unresolved};
 for(const line of text(position.source_block_text).split('\n')){
  const cell=line.match(/^([A-Z]+)(\d+):\s*(.*)$/);if(!cell||cell[1]!==header[1]||Number(cell[2])<=Number(header[2])||Number(cell[2])>Number(header[2])+7)continue;
  const raw=cell[3].trim(),comment=text(position.source_block_text).split('\n').find(x=>x.startsWith(cell[1]+cell[2]+' comment:'))||'',value=raw.replace(/^\([MF]\d+\)\s*/,'').replace(/[‘’′]/g,"'");if(!raw||raw.startsWith('='))continue;if(/\b(?:dead|died|ended|sacrificed|removed|euthanized|transfer(?:red)?)\b/i.test(raw+' '+comment)){unresolved.push({cell:cell[1]+cell[2],raw,reason:'lifecycle_annotation_requires_review'});continue;}
  const match=value.match(/^(.*?)(?:\s+|-)([MF])\s*-?\s*(\d+)$/),prefix=match?.[1]?.trim();
  if(!match||!(compactResults(prefix)||keyFor(prefix)||/^(?:C57BL\/?6J?|WT)$/i.test(prefix||''))){if(/\b[MF]\s*-?\s*\d+\b/.test(raw))unresolved.push({cell:cell[1]+cell[2],raw,reason:'ambiguous_animal_tag'});continue;}
  const canonical=value.replace(/\s+/g,'');if(seen.has(canonical))continue;seen.add(canonical);evidence.push({cell:cell[1]+cell[2],raw,tag:raw,canonical_tag:canonical,source_animal_number:match[3],sex:match[2]==='M'?'Male':'Female',identity_confirmed:false});
 }
 const male=evidence.filter(x=>x.sex==='Male').length,female=evidence.filter(x=>x.sex==='Female').length;
 return {male,female,mixed:male>0&&female>0,evidence,unresolved};
}

// Shared with cage estimates: unresolved current source evidence cannot establish occupancy.
export function sourceChangeBlocks(position,events,asOf) {
  const seenAt=Date.parse(position.source_last_seen_at),changes=[];
  for(const event of events) {
    const change=event.animal_sheet_change;
    if(archived(event)||event.event_type!=='animal_sheet_source_change'||change?.schema_version!==1||change.entity_type!=='locations'||recordId(change.entity_id)!==recordId(position.location_id))continue;
    if(position.source_file_id&&event.source_file_id!==position.source_file_id)continue;
    const date=calendarDay(change.observation_date)!==null?change.observation_date:event.event_date;
    if(calendarDay(date)===null||date>asOf||date<position.source_snapshot_date)continue;
    const capture=Date.parse(event.source_capture_at);
    if(Number.isFinite(seenAt)&&Number.isFinite(capture)&&capture<seenAt)continue;
    if(!['added','updated','conflict','withdrawn'].includes(change.action))continue;
    changes.push({date,capture:Number.isFinite(capture)?capture:0,blocked:['conflict','withdrawn'].includes(change.action)});
  }
  // A tied unresolved observation wins; a later successful import can clear it.
  changes.sort((a,b)=>b.date.localeCompare(a.date)||b.capture-a.capture||Number(b.blocked)-Number(a.blocked));
  return changes[0]?.blocked===true;
}

/** User's operational rule: known male and female currently sharing a cage
 * are a breeding group. This is a housing estimate, not proof of fertility.
 * Source-only positions remain distinct from individually linked animals. */
export function estimateBreedingGroups(dataset,{asOf=localDate()}={}){
 const day=calendarDay(asOf);if(day===null)throw new TypeError('Breeding estimate needs a valid YYYY-MM-DD date.');
 const t=dataset?.tables||{},issues=[],cages=recordIndex(t.cages,'cage_sid',r=>JSON.stringify([archived(r),text(r.state).toLowerCase(),r.location_id,r.cage_tag])),mice=recordIndex(t.mice,'mouse_sid',r=>JSON.stringify([archived(r),r.state,sexKey(r.sex),recordId(r.cage_sid),r.date_of_birth,r.end_date])),byCage=new Map(),registered=[],seenMatings=new Set();
 for(const [sid,entry] of mice){const m=entry.record;if(m.state!=='Stock'||archived(m))continue;const born=calendarDay(m.date_of_birth),end=calendarDay(m.end_date);if(entry.ambiguous||born!==null&&born>day||end!==null&&end<=day){issues.push({kind:'ambiguous_or_not_current_mouse',mouse_sid:sid});continue;}const cageSid=recordId(m.cage_sid),c=cages.get(cageSid);if(!cageSid||!c||c.ambiguous||archived(c.record)||/^(?:inactive|ended|closed)$/i.test(text(c.record.state))){issues.push({kind:'unresolved_current_cage',mouse_sid:sid,cage_sid:cageSid||null});continue;}if(!byCage.has(cageSid))byCage.set(cageSid,{male:[],female:[],unknown:[]});byCage.get(cageSid)[sexKey(m.sex)||'unknown'].push(sid);}
 const groups=[...byCage].filter(([,x])=>x.male.length&&x.female.length).map(([sid,x])=>({group_id:'cage:'+sid,cage_sid:sid,cage_tag:text(cages.get(sid).record.cage_tag)||sid,location_id:recordId(cages.get(sid).record.location_id)||null,male_sids:x.male,female_sids:x.female,unknown_sids:x.unknown,registered_mating_sids:[],basis:'current_mixed_sex_cage',fertility_confirmed:false}));
 for(const [index,m] of rows(t.matings).entries()){
  if(!m||m.state!=='Active'||archived(m))continue;const setup=calendarDay(m.set_up_date),end=calendarDay(m.disbanded_date);if(setup!==null&&setup>day||end!==null&&end<=day)continue;const sid=recordId(m.mating_sid)||'anonymous:'+index;if(seenMatings.has(sid))continue;seenMatings.add(sid);
  const signature=r=>JSON.stringify([r.state,archived(r),r.set_up_date,r.disbanded_date,...['male_sids','female_sids'].map(k=>[...new Set(rows(r[k]).map(recordId))].sort())]);
  const ambiguous=recordId(m.mating_sid)&&rows(t.matings).some(other=>recordId(other?.mating_sid)===sid&&signature(other)!==signature(m));
  const invalidDates=['set_up_date','disbanded_date'].some(k=>m[k]&&calendarDay(m[k])===null),members=new Set([...rows(m.male_sids),...rows(m.female_sids)].map(recordId));const matches=invalidDates||ambiguous?[]:groups.filter(g=>g.male_sids.some(x=>members.has(x))&&g.female_sids.some(x=>members.has(x)));
  const unresolvedMembers=['male','female'].some(role=>!rows(m[role+'_sids']).length||rows(m[role+'_sids']).some(member=>!matches.some(g=>g[role+'_sids'].includes(recordId(member)))));
  for(const g of matches)g.registered_mating_sids.push(sid);registered.push({mating_sid:sid,cage_sids:matches.map(g=>g.cage_sid),resolved:matches.length>0&&!unresolvedMembers,reason:ambiguous?'conflicting_registered_group':invalidDates?'invalid_mating_dates':!matches.length?'no_confirmed_current_mixed_sex_cage':unresolvedMembers?'some_registered_members_not_confirmed_current':'current_mixed_sex_members'});
 }
 const sourceGroups=[],sourceOverlaps=[],sourceConflicts=[],sourceChanges=new Map(),sourceTagPositions=new Map(),sourceTagKey=e=>Number(e.source_animal_number)>=1000?'number:'+e.source_animal_number:'tag:'+e.canonical_tag,positionIndex=recordIndex(t.locations,'location_id',p=>JSON.stringify([archived(p),p.source_current,p.record_origin,p.source_snapshot_date,p.source_block_text,p.source_last_seen_at,p.source_file_id,p.source_historical,p.history_read_only,p.source_label_conflict,p.source_import_conflict]));
 for(const event of rows(t.husbandry_events)){const change=event?.animal_sheet_change;if(event?.event_type!=='animal_sheet_source_change'||change?.schema_version!==1||change.entity_type!=='locations')continue;const positionId=recordId(change.entity_id),events=sourceChanges.get(positionId)||[];events.push(event);sourceChanges.set(positionId,events);}
 for(const [positionId,entry] of positionIndex){const pos=entry.record;if(entry.ambiguous){issues.push({kind:'conflicting_source_position',location_id:positionId});continue;}
  if(!pos||archived(pos)||pos.source_current!==true||pos.record_origin!=='current_google_sheet_map'||pos.source_historical||pos.history_read_only||pos.source_label_conflict||pos.source_import_conflict)continue;const sourceDay=calendarDay(pos.source_snapshot_date);if(sourceDay===null||sourceDay>day)continue;
  if(sourceChangeBlocks(pos,sourceChanges.get(positionId)||[],asOf)){issues.push({kind:'source_conflict_or_withdrawal',location_id:positionId});continue;}
  const observed=classifyAnimalSheetBreedingBlock(pos),locationId=recordId(pos.location_id);if(!locationId)continue;
  // A duplicate in a single-sex position is still contradictory housing evidence.
  for(const e of observed.evidence){const ids=sourceTagPositions.get(sourceTagKey(e))||new Set();ids.add(locationId);sourceTagPositions.set(sourceTagKey(e),ids);}
  if(!observed.mixed)continue;
  const associated=[...cages].filter(([,c])=>!c.ambiguous&&!archived(c.record)&&recordId(c.record.location_id)===locationId&&byCage.has(recordId(c.record.cage_sid))).map(([id])=>id);
  const item={group_id:'source:'+locationId,location_id:locationId,label:text(pos.label)||text(pos.source_label)||locationId,male_count:observed.male,female_count:observed.female,evidence:observed.evidence,unresolved:observed.unresolved,source_url:text(pos.source_url),source_cell:text(pos.source_cell),source_snapshot_date:pos.source_snapshot_date,source_age_days:day-sourceDay,basis:'current_animal_sheet_position',identity_confirmed:false,fertility_confirmed:false};
  const labelMatches=groups.filter(g=>text(g.cage_tag).replace(/\s+/g,'')===text(pos.label||pos.source_label).replace(/\s+/g,'')),candidateMatches=groups.filter(g=>[...g.male_sids,...g.female_sids].some(sid=>observed.evidence.some(e=>e.source_animal_number===sid)));const overlaps=groups.filter(g=>g.location_id===locationId);if(overlaps.length){sourceOverlaps.push({...item,cage_sids:overlaps.map(g=>g.cage_sid)});continue;}
  if(labelMatches.length||candidateMatches.length){sourceConflicts.push({...item,cage_sids:[...new Set([...labelMatches,...candidateMatches].map(g=>g.cage_sid))],reason:'source_label_or_animal_number_overlaps_current_cage_without_confirmed_location'});continue;}
  if(associated.length){sourceConflicts.push({...item,cage_sids:associated,reason:'source_mixed_sex_disagrees_with_linked_current_residents'});continue;}
  if(!sourceGroups.some(g=>g.location_id===locationId))sourceGroups.push(item);
 }
 for(let i=sourceGroups.length-1;i>=0;i--){const source=sourceGroups[i];if(source.evidence.some(e=>sourceTagPositions.get(sourceTagKey(e)).size>1)){sourceConflicts.push({...source,reason:'same_animal_tag_or_number_in_multiple_current_positions'});sourceGroups.splice(i,1);}}
 const unresolvedRegisteredGroups=registered.filter(r=>!r.resolved),activeMouseSids=[...new Set(groups.flatMap(g=>[...g.male_sids,...g.female_sids,...g.unknown_sids]))];
 return {asOf,groups,currentCageCount:groups.length,inferredOnlyGroups:groups.filter(g=>!g.registered_mating_sids.length).length,registeredCount:registered.length,resolvedRegisteredCount:registered.filter(r=>r.resolved).length,unresolvedRegisteredGroups,sourceGroups,sourceOverlaps,sourceConflicts,sourceEstimatedCount:sourceGroups.length,totalGroups:groups.length+sourceGroups.length,activeMouseSids,issues};
}

/** Counts always use one coherent cohort, independent of table filters. */
export function summarizeBreeding(dataset,{asOf=localDate(),scope='living'}={}) {
  const day=calendarDay(asOf);
  if(day===null)throw new TypeError('Breeding summary needs a valid YYYY-MM-DD date.');
  if(!['living','active'].includes(scope))throw new TypeError('Breeding summary scope must be living or active.');
  const options=getBreedingOptions(dataset),tables=dataset?.tables||{},activeIds=new Set(),seenGroups=new Set();let activeGroups=0;
  for(const mating of rows(tables.matings)) {
    if(!mating||mating.state!=='Active'||archived(mating))continue;
    const setup=calendarDay(mating.set_up_date),disbanded=calendarDay(mating.disbanded_date);
    if((setup!==null&&setup>day)||(disbanded!==null&&disbanded<=day))continue;
    const sid=mating.mating_sid===undefined?null:String(mating.mating_sid);
    if(sid!==null&&seenGroups.has(sid))continue;if(sid!==null)seenGroups.add(sid);
    activeGroups++;
    for(const id of [...rows(mating.male_sids),...rows(mating.female_sids)])activeIds.add(String(id));
  }
  const groupEstimate=estimateBreedingGroups(dataset,{asOf});
  const summary={total:0,male:0,female:0,unknownSex:0,maleFertile:0,femaleFertile:0,unknownMaleAge:0,unknownFemaleAge:0,genotyped:0,activeGroups,scope,asOf,groupEstimate};
  // A registry row alone does not establish current cohabitation. Source-only
  // position counts cannot supply individual mouse identities to this cohort.
  if(scope==='active'){activeIds.clear();for(const sid of groupEstimate.activeMouseSids)activeIds.add(sid);}
  const genes=new Map(),seen=new Set();
  for(const row of rows(tables.mouse_genes)) {
    if(!row||row.mouse_sid===undefined)continue;const sid=String(row.mouse_sid);
    if(!genes.has(sid))genes.set(sid,[]);genes.get(sid).push(row);
  }
  for(const mouse of rows(tables.mice)) {
    if(!mouse||mouse.state!=='Stock'||archived(mouse))continue;
    const sid=mouse.mouse_sid===undefined?null:String(mouse.mouse_sid);
    if(scope==='active'&&(sid===null||!activeIds.has(sid)))continue;
    if(sid!==null&&seen.has(sid))continue;if(sid!==null)seen.add(sid);
    summary.total++;
    const sex=text(mouse.sex).trim().toLowerCase(),key=['male','m'].includes(sex)?'male':['female','f'].includes(sex)?'female':null;
    if(key) {
      summary[key]++;
      const born=calendarDay(mouse.date_of_birth),age=born===null?null:day-born;
      if(age===null||age<0)summary[key==='male'?'unknownMaleAge':'unknownFemaleAge']++;
      else if(age>=options[`${key}_min_weeks`]*7&&age<=options[`${key}_max_weeks`]*7)summary[`${key}Fertile`]++;
    } else summary.unknownSex++;
    if(isMouseGenotyped(mouse,genes.get(sid)||[]))summary.genotyped++;
  }
  return summary;
}
