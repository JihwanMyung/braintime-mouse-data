// Source labels are evidence, not normalized events. In particular, preparation,
// in-dish explant, removal from culture, maternal and donor decapitation are distinct.
const text=value=>typeof value==='string'?value:JSON.stringify(value);
const labelText=value=>String(value).replace(/^[A-Z]{1,3}\s*·\s*/,'').replace(/\s+/g,' ').trim();
const scheme=/\b(?:LP[12]?|SP[12]?|DD|LL|LD\s*\d*\s*:\s*\d+|long photoperiod|short photoperiod|entrain(?:ed|ment)?)\b/i;
const timingNote=/\b(?:decap(?:itation)?|in[- ]dish|sampling (?:hour|time)|RNA sampling time|CT mod 24)\b/i;
function* leaves(value,path=[]) {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const entries=Object.entries(value);
  // Animal Sheet raw maps use spreadsheet column letters, including CT and ZT.
  if(entries.length&&entries.every(([key])=>/^[A-Z]{1,3}\d*$/.test(key)))return;
  for(const [key,item] of entries) {
    if(item&&typeof item==='object'&&!Array.isArray(item))yield* leaves(item,[...path,key]);
    else if(item!==null&&item!==undefined&&item!==''&&typeof item!=='boolean')yield {key,value:text(item),path};
  }
}
/** Present exact source values without populating clock, phase or duration fields. */
export function sourceTimingEvidence(source) {
  const rows=[],warnings=new Set(),seen=new Set();
  for(const item of leaves(source?.raw_values)) {
    const label=labelText(item.key),value=item.value,phase=/\b(?:ZT|CT)\b/i.test(label);
    let kind=null;
    if(/co[ -]?culture/i.test(label)&&/decap/i.test(label))kind='Co-culture donor timing';
    else if(/decap/i.test(label))kind=/\bdate\b/i.test(label)?'Date field mentioning decapitation':'Decapitation label';
    else if(phase)kind='Circadian timing label';
    else if(/\bhour\s*-\s*7\b/i.test(label))kind='Historical derived time label';
    else if(source?.kind==='csf_sample'&&/^actual time$/i.test(label))kind='CSF actual-time label';
    else if(source?.kind==='assay_run'&&/^\/?\s*hour$/i.test(label))kind='Assay hour label';
    else if(source?.kind==='assay_run'&&/^running time\s*\/\s*date$/i.test(label))kind='Assay run date label';
    else if(/^samplig time$/i.test(label))kind='Sampling timing (source spelling)';
    else if(/\bin[- ]dish\s+explant\s+(?:time|hour|date)\b/i.test(label))kind='In-dish explant timing';
    else if(/sampl(?:ing|e).*\b(?:time|hour|date|duration)\b|RNA sampling time/i.test(label))kind='Sampling timing';
    else if(/post[ -]?hoc sampling/i.test(label))kind='Post-hoc sampling';
    else if(/\b(?:time|date)\b.*prep|\b(?:prep\.?|prepare)\s*(?:time|at)\b/i.test(label))kind='Preparation timing';
    else if(/\b(?:time|date)\b.*record|recording date/i.test(label))kind='Recording timing';
    else if(/entrain|photoperiod|light (?:cycle|schedule)|entrainment duration/i.test(label))kind='Entrainment label';
    else if(timingNote.test(value))kind='Timing note';
    else if(scheme.test(value)&&(/note|comment|condition|schedule|animal|treatment/i.test(label)||/\bdays?\b|entrain/i.test(value)))kind='Entrainment note';
    if(!kind)continue;
    const display=`${kind} · ${[...item.path,item.key].join(' / ')}`,signature=display+'\0'+value;
    if(!seen.has(signature)){rows.push({label:display,value});seen.add(signature)}
    if(/date.*decap/i.test(label))warnings.add('A date field mentioning decapitation does not establish an exact decapitation time; midnight may be date formatting.');
    if(/co[ -]?culture/i.test(label))warnings.add('Co-culture timing may refer to another donor. Keep donor events separate.');
    if(/mother|\bmom\b|taken out from lumicycle|end of s[aq]mpling from lumicycle|sampling hour is in|incorrectly logged/i.test(value))warnings.add('Source notes qualify or correct the timing label. Review the original context before assigning an animal event.');
    if(/hour\s*-\s*7|converted|mod\s*24/i.test(label+' '+value))warnings.add('Derived or historical phase labels require context. Do not infer ZT/CT basis, apply modulo 24, or convert clock time automatically.');
    if(/entrainment/i.test(kind)&&/\(\s*\d+(?:\.\d+)?\s*\)/.test(value))warnings.add('Parenthesized numbers are preserved as written; the source may use them for groups, counts or duration.');
  }
  if(rows.length)warnings.add('These are source labels and values. Preparation, decapitation, in-dish explant, sampling and circadian phase remain separate until reviewed.');
  return {rows,warnings:[...warnings]};
}
