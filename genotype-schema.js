/* Structured genotype annotations are separate from imported genotype text. */
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const label=value=>typeof value==='string'&&value.trim()&&value.length<=160;
const chromosome=value=>typeof value==='string'&&(value==='unknown'||value==='X'||value==='Y'||/^(?:[1-9]|1[0-9])$/.test(value));

export function validateGeneticProfile(profile) {
  const errors=[];
  if(!object(profile)||profile.schema_version!==1)return ['Genetic profile must use schema version 1.'];
  if(!Array.isArray(profile.loci)||!profile.loci.length||profile.loci.length>64)return ['A genetic profile needs 1–64 named loci.'];
  if(!object(profile.calls))return ['Genetic profile calls must be an object keyed by locus.'];
  const ids=new Set();
  for(const locus of profile.loci){
    if(!object(locus)||!label(locus.id)||!label(locus.name)){errors.push('Each locus needs an ID and a name.');continue;}
    if(['__proto__','prototype','constructor'].includes(locus.id)||ids.has(locus.id))errors.push('Locus IDs must be unique and cannot use reserved object names.');
    ids.add(locus.id);
    if(!['cre','flox','reporter','other'].includes(locus.kind))errors.push(`${locus.name}: choose a locus type.`);
    if(!chromosome(locus.chromosome))errors.push(`${locus.name}: choose a chromosome or unknown.`);
    if(!Array.isArray(locus.alleles)||!locus.alleles.length||locus.alleles.length>6||locus.alleles.some(a=>!label(a))||new Set(locus.alleles).size!==locus.alleles.length){errors.push(`${locus.name}: record 1–6 distinct allele labels.`);continue;}
    const call=profile.calls[locus.id];
    if(!object(call)||!['confirmed','inferred','unknown'].includes(call.evidence)){errors.push(`${locus.name}: record the genotype evidence.`);continue;}
    if(!Array.isArray(call.alleles)||![0,2].includes(call.alleles.length)||call.alleles.some(a=>typeof a!=='string'||a.length>160)){errors.push(`${locus.name}: use two allele labels, or leave an unknown genotype blank.`);continue;}
    if(call.evidence!=='unknown'&&(call.alleles.length!==2||call.alleles.some(a=>!locus.alleles.includes(a))))errors.push(`${locus.name}: confirmed or inferred calls need two declared alleles.`);
  }
  if(Object.keys(profile.calls).some(id=>!ids.has(id)))errors.push('Every genotype call needs a matching locus definition.');
  if(profile.notes!=null&&(typeof profile.notes!=='string'||profile.notes.length>4000))errors.push('Genotype notes must be text of at most 4,000 characters.');
  return [...new Set(errors)];
}
