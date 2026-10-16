/* Cage assignments store the canonical roster name, not an account role.
 * The directory RPC includes only Current and owner-selected Historical people. */
const text=value=>typeof value==='string'?value.trim():'';
const key=value=>text(value).normalize('NFKC').replace(/\s+/gu,' ').toLocaleLowerCase('en');
const firstName=name=>{const first=text(name).split(/\s+/u)[0]||'';return /^[\p{Script=Latin}\p{M}][\p{Script=Latin}\p{M}.'’\-]*$/u.test(first)?first:text(name);};
const shortName=person=>text(person.nickname)||firstName(person.name);

function directory(managers){
 const rows=(Array.isArray(managers)?managers:[]).filter(person=>person&&text(person.person_id)&&text(person.name)&&['current','historical'].includes(person.status)&&person.archived!==true&&(person.status!=='historical'||!Object.hasOwn(person,'cage_manager_eligible')||person.cage_manager_eligible===true));
 // A duplicated response is harmless only if it describes the same person and name.
 const identities=new Map();
 for(const person of rows){const id=text(person.person_id),old=identities.get(id);if(old===null)continue;if(old&&key(old.name)!==key(person.name)){identities.set(id,null);continue;}if(!old)identities.set(id,{...person,name:text(person.name),nickname:text(person.nickname),acronym:text(person.acronym)});}
 return [...identities.values()].filter(Boolean);
}
function find(rows,value){
 const wanted=key(value);if(!wanted)return null;
 const exact=rows.filter(person=>key(person.name)===wanted);if(exact.length)return exact.length===1?exact[0]:null;
 const aliases=rows.filter(person=>[person.nickname,person.acronym,firstName(person.name)].some(alias=>key(alias)===wanted));
 return aliases.length===1&&rows.filter(person=>key(person.name)===key(aliases[0].name)).length===1?aliases[0]:null;
}
function labels(rows){
 const named=rows.map(person=>({person,label:shortName(person)}));
 for(const item of named){const peers=named.filter(other=>key(shortName(other.person))===key(shortName(item.person)));if(peers.length>1){const acronym=text(item.person.acronym),unique=acronym&&peers.filter(other=>key(other.person.acronym)===key(acronym)).length===1;item.label=unique?`${shortName(item.person)} (${acronym})`:item.person.name;}}
 // An acronym-decorated label can itself collide with an explicit nickname.
 const duplicates=new Set(named.filter(item=>named.filter(other=>key(other.label)===key(item.label)).length>1).map(item=>item.person.person_id));
 for(const item of named)if(duplicates.has(item.person.person_id))item.label=item.person.name;
 return new Map(named.map(item=>[item.person.person_id,item.label]));
}

export function matchCageManager(managers,value){return find(directory(managers),value);}
export function cageManagerValue(managers,value){return matchCageManager(managers,value)?.name||text(value);}
export function cageManagerShortName(managers,value){const rows=directory(managers),person=find(rows,value);return person?labels(rows).get(person.person_id):text(value)||'—';}
export function buildCageManagerChoices(managers,currentValue=''){
 const rows=directory(managers),names=labels(rows),choices=rows.filter(person=>rows.filter(other=>key(other.name)===key(person.name)).length===1).map(person=>[person.name,names.get(person.person_id),false]).sort((a,b)=>a[1].localeCompare(b[1],'en')||a[0].localeCompare(b[0],'en'));
 const current=text(currentValue);
 if(current&&!find(rows,current))choices.unshift([current,current,true]);
 return [['','—',false],...choices];
}
