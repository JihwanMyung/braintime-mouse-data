/* Current recorded line counts, not assay confirmation or allele dosage.
 * Animal Sheet abbreviations are interpreted only in the animal's own fields.
 */
export const MOUSE_LINE_GROUPS = Object.freeze([
  {key:'P',name:'PER2::LUC'},
  {key:'E',name:'Bmal1-ELuc'},
  {key:'B',name:'Bmal1-flox'},
  {key:'F',name:'Foxj1-Cre'},
  {key:'V',name:'Vip-Cre'},
  {key:'AD',name:'APP/PS1'},
].map(Object.freeze));

const keys=MOUSE_LINE_GROUPS.map(group=>group.key);
const assignmentKeys=[...keys,'A','32','Vg','Gt','96'];
const zero=()=>Object.fromEntries(keys.map(key=>[key,0]));
const text=value=>typeof value==='string'?value:'';
const patterns={P:/PER2\s*:{1,2}\s*LUC/gi,E:/Bmal1-ELuc/gi,B:/Bmal1(?:[-\s]+flox(?:ed)?)?/gi,F:/FoxJ1-Cre/gi,V:/Vip-Cre/gi,AD:/APP\s*\/\s*PS1/gi,A:/Avp-Cre/gi,'32':/Ai32/gi,Vg:/Vgat(?:[-\s]+flox(?:ed)?)?/gi,Gt:/GAD67-tTA(?:2)?/gi,'96':/Ai96/gi};
const tokenPattern=/AD|Vg|Gt|WT|32|96|[PEBFVA]/y;
const target=key=>assignmentKeys.includes(key);
const floxed=key=>key==='B'||key==='Vg';
const negative=value=>/^(?:-|\+|wt|wild[- ]?type|negative|neg|absent)$/i.test(value.trim());
const flox=value=>/^(?:fl|f|flox|floxed|(?:Bmal1|Vgat)[- ]flox)$/i.test(value.trim());

function groupForName(value) {
  const name=text(value).trim();
  if(/^per2(?:\s*:{1,2}\s*|-)luc$/i.test(name))return 'P';
  if(/^bmal1-eluc$/i.test(name))return 'E';
  if(/^bmal1(?:[- ]flox(?:ed)?)?$/i.test(name))return 'B';
  if(/^foxj1-cre$/i.test(name))return 'F';
  if(/^vip-cre$/i.test(name))return 'V';
  if(/^APP\s*\/\s*PS1$/i.test(name))return 'AD';
  if(/^avp-cre$/i.test(name))return 'A';
  if(/^ai32$/i.test(name))return '32';
  if(/^vgat(?:[- ]flox(?:ed)?)?$/i.test(name))return 'Vg';
  if(/^gad67-tta(?:2)?$/i.test(name))return 'Gt';
  if(/^ai96$/i.test(name))return '96';
  return null;
}

function compactAlternative(value,isTag=false) {
  // A terminal M/F belongs to sex, never Foxj1; a leading M12- is a tag ID.
  let input=value.trim().replace(/[‘’′]/g,"'");
  // A bare numeric physical tag is an identifier, not evidence of Ai32/Ai96.
  if(/^\d+$/.test(input)&&(isTag||!['32','96'].includes(input)))return null;
  if(isTag)input=input.replace(/^[MF]\d+-/,'').replace(/(?:-[MF]\d*|[MF]\d+)$/,'');
  if(!input)return new Map();
  const result=new Map();let at=0,valid=true;
  function sequence(inGroup=false) {
    const entries=[];
    while(at<input.length) {
      const ch=input[at];
      if(ch===')'){if(!inGroup){valid=false;return entries;}at++;return entries;}
      if(/[\s']/.test(ch)){at++;continue;}
      if(ch==='('){at++;const nested=sequence(true);entries.push(...nested.map(entry=>({...entry,uncertain:true})));continue;}
      tokenPattern.lastIndex=at;const match=tokenPattern.exec(input);
      if(!match){valid=false;return entries;}
      at+=match[0].length;let uncertain=false;
      // P(') records uncertain dosage, but the P line itself is explicit.
      const dosage=input.slice(at).match(/^\(\s*'+\s*\)/);
      if(dosage)at+=dosage[0].length;
      while(input[at]==="'")at++;
      if(input[at]==='?'){uncertain=true;at++;}
      entries.push({key:match[0],uncertain});
    }
    if(inGroup)valid=false;
    return entries;
  }
  const entries=sequence();
  if(!valid||at!==input.length)return null;
  for(const entry of entries)if(target(entry.key))result.set(entry.key,result.get(entry.key)==='uncertain'||entry.uncertain?'uncertain':'present');
  return result;
}

function compactLines(value,isTag=false) {
  if(!text(value).trim())return new Map();
  const alternatives=value.split(/\s+or\s+/i).map(value=>compactAlternative(value,isTag));
  if(alternatives.some(item=>item===null))return new Map();
  const result=new Map();
  for(const key of assignmentKeys) {
    if(alternatives.every(item=>item.get(key)==='present'))result.set(key,'present');
    else if(alternatives.some(item=>item.has(key)))result.set(key,'uncertain');
  }
  return result;
}

function namedLines(value) {
  const result=new Map();
  if(!text(value).trim()||/^\s*=/.test(value))return result;
  const add=(key,status)=>{if(!result.has(key))result.set(key,new Set());result.get(key).add(status);};
  for(const key of assignmentKeys)for(const match of value.matchAll(patterns[key])) {
    const start=match.index,end=start+match[0].length,before=value[start-1]||'',after=value[end]||'';
    if(/[A-Za-z0-9_:-]/.test(before)||/[A-Za-z0-9_:]/.test(after)||(after==='-'&&!/^-(?:\s*\/\s*[+-]|\s*(?:$|[,;]))/.test(value.slice(end))))continue;
    const tail=value.slice(end),prefix=value.slice(0,start);
    if(/\b(?:no|not)\s*$/i.test(prefix)){add(key,'absent');continue;}
    const callMatch=tail.match(/^\s*\(([^()]*)\)/)??tail.match(/^\s*([+?-](?:\s*\/\s*[+?-])?|(?:fl|f|WT)\s*\/\s*(?:fl|f|WT|[+-])|(?:negative|neg|absent|unknown|untested)\b)/i);
    const suffix=callMatch?.[1];
    if(callMatch&&/^\s*\?/.test(tail.slice(callMatch[0].length))){add(key,'uncertain');continue;}
    if(suffix!==undefined) {
      const tokens=suffix.trim().split('/').map(item=>item.trim());
      if(tokens.some(item=>/\?|unknown|untested/i.test(item))){add(key,'uncertain');continue;}
      if(floxed(key)) {
        if(tokens.some(flox))add(key,'present');
        else if(tokens.every(negative))add(key,'absent');
        else add(key,'uncertain');
      } else if(tokens.every(item=>/^(?:-|WT|wild[- ]?type|negative|neg|absent)$/i.test(item)))add(key,'absent');
      else if(tokens.every(item=>/^(?:[+-]|WT|wild[- ]?type)$/i.test(item))&&tokens.includes('+'))add(key,'present');
      else add(key,'uncertain');
    } else if(/^\s*\?/.test(tail)||(before==='('&&after===')'))add(key,'uncertain');
    else if(floxed(key))add(key,/flox/i.test(match[0])?'mentioned':'untyped');
    else add(key,'mentioned');
  }
  return result;
}

function profileLines(profile) {
  const result=new Map();
  if(profile?.schema_version!==1||!Array.isArray(profile.loci)||!profile.calls||typeof profile.calls!=='object')return result;
  for(const locus of profile.loci) {
    if(!locus||typeof locus!=='object')continue;
    const namedKey=groupForName(locus.name)||groupForName(locus.id);
    const rosa26=/^(?:Gt\(ROSA\)26Sor|rosa26)$/i.test(text(locus.name))||/^rosa26$/i.test(text(locus.id));
    const locusKeys=namedKey?[namedKey]:rosa26?[...new Set((Array.isArray(locus.alleles)?locus.alleles:[]).map(groupForName).filter(key=>key==='32'||key==='96'))]:[];
    for(const key of locusKeys) {
      const call=profile.calls[locus.id];let status='uncertain';
      if(['confirmed','inferred'].includes(call?.evidence)&&Array.isArray(call.alleles)&&call.alleles.length===2&&Array.isArray(locus.alleles)&&call.alleles.every(allele=>typeof allele==='string'&&locus.alleles.includes(allele))) {
        if(floxed(key))status=call.alleles.some(flox)?'present':call.alleles.every(negative)?'absent':'uncertain';
        else status=call.alleles.some(allele=>groupForName(allele)===key)?'present':call.alleles.every(allele=>negative(allele)||(rosa26&&['32','96'].includes(groupForName(allele))))?'absent':'uncertain';
      }
      const priority=call?.evidence==='confirmed'?2:1,previous=result.get(key);
      if(!previous||priority>previous.priority)result.set(key,{status,priority});
      else if(priority===previous.priority&&status!==previous.status)result.set(key,{status:'uncertain',priority});
    }
  }
  return result;
}

function recordedLines(mouse,genes) {
  const compact=compactLines(text(mouse.physical_tag),true),raw=new Map();
  for(const value of [text(mouse.genotype),text(mouse.mouseline),...genes]) {
    for(const [key,statuses] of namedLines(value)){if(!raw.has(key))raw.set(key,new Set());for(const status of statuses)raw.get(key).add(status);}
    for(const [key,status] of compactLines(value))compact.set(key,compact.get(key)==='uncertain'||status==='uncertain'?'uncertain':'present');
  }
  const reviewed=profileLines(mouse.genetic_profile),result=new Map();
  for(const key of assignmentKeys) {
    const statuses=raw.get(key)||new Set();
    if(reviewed.has(key)) {
      const annotation=reviewed.get(key);
      const conflicts=annotation.priority<2&&(statuses.has('uncertain')||(annotation.status==='present'&&statuses.has('absent'))||(annotation.status==='absent'&&statuses.has('present')));
      result.set(key,conflicts?'uncertain':annotation.status);continue;
    }
    if(statuses.has('absent'))result.set(key,statuses.has('present')||statuses.has('uncertain')?'uncertain':'absent');
    else if(statuses.has('present'))result.set(key,statuses.has('uncertain')?'uncertain':'present');
    else if(statuses.has('uncertain'))result.set(key,'uncertain');
    else if(compact.has(key))result.set(key,compact.get(key));
    else if(statuses.has('mentioned'))result.set(key,'present');
    else if(statuses.has('untyped'))result.set(key,'uncertain');
  }
  return result;
}

/** Returns only present/uncertain line keys. Negative or unrecorded lines are
 * omitted. Mouse genes must belong to this mouse; source records are untouched.
 */
export function mouseLineAssignments(mouse,geneRows=[]) {
  if(!mouse||typeof mouse!=='object')return {};
  const values=geneRows.filter(row=>row&&mouse.mouse_sid!==undefined&&String(row.mouse_sid)===String(mouse.mouse_sid)).map(row=>text(row.gene_value));
  return Object.fromEntries([...recordedLines(mouse,values)].filter(([,status])=>status!=='absent').map(([key,status])=>[key,status==='present'?'recorded':'uncertain']));
}

export function summarizeMice(dataset) {
  const summary={alive:0,male:0,female:0,unknownSex:0,lines:zero(),uncertainLines:zero()},genes=new Map();
  for(const row of dataset?.tables?.mouse_genes||[]) {
    if(row?.mouse_sid===undefined)continue;const sid=String(row.mouse_sid);
    if(!genes.has(sid))genes.set(sid,[]);genes.get(sid).push(text(row.gene_value));
  }
  const seen=new Set();
  for(const mouse of dataset?.tables?.mice||[]) {
    if(!mouse||mouse.state!=='Stock'||mouse.app_archived_at||mouse.archived===true)continue;
    const sid=mouse.mouse_sid===undefined?null:String(mouse.mouse_sid);if(sid!==null&&seen.has(sid))continue;if(sid!==null)seen.add(sid);
    summary.alive++;const sex=text(mouse.sex).trim().toLowerCase();
    if(['male','m'].includes(sex))summary.male++;else if(['female','f'].includes(sex))summary.female++;else summary.unknownSex++;
    for(const [key,status] of recordedLines(mouse,genes.get(sid)||[])) {
      if(!keys.includes(key))continue;
      if(status==='present')summary.lines[key]++;else if(status==='uncertain')summary.uncertainLines[key]++;
    }
  }
  return summary;
}
