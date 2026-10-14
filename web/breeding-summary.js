import { getBreedingOptions } from './breeding-options.js?v=22';
import { mouseLineAssignments } from './mouse-summary.js?v=22';
import { validateGeneticProfile } from './genotype-schema.js';

const text=value=>typeof value==='string'?value:'';
const rows=value=>Array.isArray(value)?value:[];
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const aliases=[
  ['P',/^PER2\s*:{1,2}\s*LUC$/i],['E',/^Bmal1-ELuc$/i],
  ['B',/^Bmal1(?:[- ]flox(?:ed)?)?$/i],['F',/^FoxJ1-Cre$/i],
  ['V',/^Vip-Cre$/i],['AD',/^APP\s*\/\s*PS1$/i],['A',/^Avp-Cre$/i],
  ['32',/^Ai32$/i],['96',/^Ai96$/i],['Vg',/^Vgat(?:[- ]flox(?:ed)?)?$/i],
  ['Gt',/^GAD67-tTA(?:2)?$/i],['Meis1',/^Meis1$/i],
];
const sourceLabel=/^(PER2\s*:{1,2}\s*LUC|Bmal1-ELuc|Bmal1(?:[- ]flox(?:ed)?)?|FoxJ1-Cre|Vip-Cre|APP\s*\/\s*PS1|Avp-Cre|Ai32|Ai96|Vgat(?:[- ]flox(?:ed)?)?|GAD67-tTA(?:2)?|Meis1|WT)(?=$|[\s(])\s*(.*)$/i;
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
    const key=keyFor(match[1])||'WT';required.add(key);
    const suffix=match[2].trim();
    if(!suffix)continue; // A name is a target, never an assay result.
    const parenthesized=suffix.match(/^\(([^()]*)\)$/);
    const result=sourcePair(key,parenthesized?parenthesized[1]:suffix);
    if(!result){unresolved.add(key);continue;}
    if(!calls.has(key))calls.set(key,new Set());calls.get(key).add(result);
  }
  return {required,calls,unresolved,invalid};
}

function profileKeys(locus) {
  const named=profileKey(locus.name)||profileKey(locus.id);
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
  const summary={total:0,male:0,female:0,unknownSex:0,maleFertile:0,femaleFertile:0,unknownMaleAge:0,unknownFemaleAge:0,genotyped:0,activeGroups,scope,asOf};
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
