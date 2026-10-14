/* Animal Sheet strain codes. These labels describe lines, not individual genotype calls. */
export const INSERTION_TYPES=Object.freeze([
  Object.freeze({value:'unknown',label:'Unknown'}),
  Object.freeze({value:'transgenic',label:'Transgenic (random insertion)'}),
  Object.freeze({value:'knock_in',label:'Knock-in'})
]);
const insertionTypes=new Set(INSERTION_TYPES.map(row=>row.value));
const definition=(key,name,insertionType='unknown',notes='',origin='Animal Sheet legend',stockReference='')=>Object.freeze({key,name,insertionType,notes,origin,stockReference});
export const STRAIN_ACRONYMS=Object.freeze([
  definition('P','PER2::LUC','knock_in','','Animal Sheet legend; laboratory confirmation'),
  definition('E','Bmal1-ELuc','transgenic','','Animal Sheet legend; laboratory confirmation'),
  definition('B','Bmal1-flox','knock_in','','Animal Sheet legend; laboratory confirmation'),
  definition('F','Foxj1-Cre','knock_in','','Animal Sheet legend; laboratory confirmation'),
  definition('V','Vip-Cre','knock_in','','Animal Sheet legend; laboratory confirmation'),
  definition('AD','APP/PS1','transgenic','APPswe and PSEN1dE9 transgenes share a chromosome 9 insertion site (MGI:3524957).','Animal Sheet stock reference and MGI','JAX 005864; Tg(APPswe,PSEN1dE9)85Dbo'),
  definition('A','Avp-Cre'),
  definition('32','Ai32'),
  definition('Vg','Vgat-flox'),
  definition('Gt','GAD67-tTA'),
  definition('96','Ai96')
]);
const defaults=new Map(STRAIN_ACRONYMS.map(row=>[row.key,row]));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const eventId=code=>'STRAIN-'+code;
const archived=record=>Boolean(record?.app_archived_at)||record?.archived===true;
const eventDate=now=>`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const dateValid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

export function validateStrainDefinition(record,old=null) {
  const relevant=record?.event_type==='strain_definition'||record?.strain_definition!==undefined||old?.event_type==='strain_definition'||old?.strain_definition!==undefined;
  if(!relevant)return [];
  const errors=[];
  if(record?.event_type!=='strain_definition')errors.push('A strain definition must retain its strain_definition event type.');
  const value=record?.strain_definition;
  if(!object(value))return [...errors,'A strain definition is required.'];
  if(value.schema_version!==1)errors.push('Unsupported strain definition version.');
  const reference=defaults.get(value.code);
  if(!reference)errors.push('Choose a strain code from the Animal Sheet legend.');
  if(reference&&value.name!==reference.name)errors.push('The strain name must match its Animal Sheet code.');
  if(record.event_id!==eventId(value.code))errors.push('A strain definition must use its stable strain ID.');
  if(old?.strain_definition?.code&&old.strain_definition.code!==value.code)errors.push('A saved strain code cannot change.');
  if(old?.event_id&&old.event_id!==record.event_id)errors.push('A saved strain definition ID cannot change.');
  if(!insertionTypes.has(value.insertion_type))errors.push('Choose Unknown, Transgenic or Knock-in.');
  if(typeof value.stock_reference!=='string'||value.stock_reference.length>500)errors.push('Stock reference must be text of at most 500 characters.');
  if(typeof value.notes!=='string'||value.notes.length>2000)errors.push('Strain notes must be text of at most 2000 characters.');
  if(!dateValid(record.event_date))errors.push('A valid strain-definition date is required.');
  return errors;
}

export function getStrainRegistry(dataset) {
  const saved=new Map();
  for(const record of dataset?.tables?.husbandry_events||[]) {
    if(record?.event_type!=='strain_definition'||archived(record)||validateStrainDefinition(record).length)continue;
    const previous=saved.get(record.strain_definition.code);
    if(!previous||String(record.app_modified_at||record.event_date)>String(previous.app_modified_at||previous.event_date))saved.set(record.strain_definition.code,record);
  }
  return STRAIN_ACRONYMS.map(reference=>{
    const record=saved.get(reference.key),value=record?.strain_definition;
    return value?{...reference,insertionType:value.insertion_type,stockReference:value.stock_reference,notes:value.notes,origin:'Colony strain registry',eventId:record.event_id}:{...reference};
  });
}

export function buildStrainDefinition(dataset,input,options={}) {
  const code=input?.code,reference=defaults.get(code);
  if(!reference)throw new Error('Choose a strain code from the Animal Sheet legend.');
  const next=structuredClone(dataset||{tables:{}});
  next.tables??={};next.tables.husbandry_events??=[];
  const matches=next.tables.husbandry_events.filter(row=>row.event_id===eventId(code));
  if(matches.length>1)throw new Error('Duplicate strain definitions must be resolved before editing.');
  const original=matches[0];
  if(original&&original.event_type!=='strain_definition')throw new Error('The strain ID is already used by another record.');
  if(original&&archived(original))throw new Error('This strain definition is archived. Restore it before editing.');
  const clock=options.now===undefined?new Date():new Date(options.now);
  if(Number.isNaN(clock.getTime()))throw new Error('A valid modification time is required.');
  const record={...original,event_id:eventId(code),event_type:'strain_definition',event_date:options.eventDate??eventDate(clock),record_origin:original?.record_origin||'app_created',app_created_at:original?.app_created_at||clock.toISOString(),app_modified_at:clock.toISOString(),strain_definition:{schema_version:1,code,name:reference.name,insertion_type:input.insertion_type,stock_reference:typeof input.stock_reference==='string'?input.stock_reference.trim():input.stock_reference,notes:typeof input.notes==='string'?input.notes.trim():input.notes}};
  const errors=validateStrainDefinition(record,original);
  if(errors.length)throw new Error(errors.join(' '));
  const index=next.tables.husbandry_events.findIndex(row=>row.event_id===record.event_id);
  if(index<0)next.tables.husbandry_events.push(record);else next.tables.husbandry_events[index]=record;
  return {record,dataset:next};
}
