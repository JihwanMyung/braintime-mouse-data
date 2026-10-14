/* Cryopreservation is case/batch evidence plus explicitly reviewed inventory.
 * Historical reported counts never establish a current balance automatically.
 * Lot and activity must be saved together through the versioned atomic store. */
export const CRYO_MATERIALS=Object.freeze(['unknown','sperm','embryo','other']);
export const CRYO_STATUSES=Object.freeze(['unreviewed','stored','depleted','transferred','closed']);
export const CRYO_UNITS=Object.freeze(['straws','vials','embryos','aliquots','other']);
export const CRYO_ACTIVITIES=Object.freeze(['stocktake','deposit','use','discard','transfer_out','transfer_in','recovery','relocation','status_change','note']);
const RECOVERY_STATUSES=['not_recorded','attempted','recovered','not_recovered'];
const LOT='cryopreservation_lot',ACTIVITY='cryopreservation_event';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=x=>structuredClone(x);
const present=x=>x!==null&&x!==undefined&&x!=='';
const text=x=>typeof x==='string'&&x.trim().length>0;
const archived=x=>Boolean(x?.app_archived_at)||x?.archived===true;
const rows=dataset=>Array.isArray(dataset?.tables?.husbandry_events)?dataset.tables.husbandry_events:[];
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const count=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
const snapshotKeys=['quantity','quantity_unit','quantity_as_of_date','status','manager','storage_location'];
const protectedKeys=['quantity','quantity_unit','quantity_as_of_date','status','manager','storage_location','activity_revision','last_activity_id'];
const snapshot=p=>Object.fromEntries(snapshotKeys.map(k=>[k,copy(p[k]??null)]));
const revision=p=>p?.activity_revision??0;

export function cryoSourceLotId(sourceCaseKey) {
  if(!text(sourceCaseKey)||sourceCaseKey.length>1000)throw new Error('A stable source case key is required.');
  const id='CRYO-SOURCE-'+encodeURIComponent(sourceCaseKey);
  if(id.length>200)throw new Error('This source case key exceeds the cloud identifier limit. Use a shorter stable source key before review.');
  return id;
}
export function cryoLots(dataset,{includeArchived=false}={}) {
  return rows(dataset).filter(row=>row.event_type===LOT&&(includeArchived||!archived(row)));
}
export function cryoActivities(dataset,lotId,{includeArchived=true}={}) {
  return rows(dataset).filter(row=>row.event_type===ACTIVITY&&row.cryopreservation_event?.lot_id===lotId&&(includeArchived||!archived(row)))
    .sort((a,b)=>(a.cryopreservation_event.revision_after??0)-(b.cryopreservation_event.revision_after??0)||String(a.event_id).localeCompare(String(b.event_id)));
}
export function cryoInventory(lot) {
  const p=lot?.cryopreservation;
  return {quantity:count(p?.quantity)?p.quantity:null,unit:CRYO_UNITS.includes(p?.quantity_unit)?p.quantity_unit:null,
    asOfDate:date(p?.quantity_as_of_date)?p.quantity_as_of_date:null,status:CRYO_STATUSES.includes(p?.status)?p.status:'unreviewed',
    known:count(p?.quantity),reportedQuantity:count(lot?.source_reported_quantity)?lot.source_reported_quantity:null,
    reportedUnit:typeof lot?.source_reported_unit==='string'?lot.source_reported_unit:null};
}

function validRefs(value,dataset,label,errors) {
  if(!Array.isArray(value)||value.some(id=>!text(id))||new Set(value).size!==value.length){errors.push(`${label} must be distinct mouse identifiers.`);return;}
  const mice=new Set((dataset?.tables?.mice||[]).map(row=>row.mouse_sid));
  for(const id of value)if(!mice.has(id))errors.push(`${label}: mouse ${id} does not exist. Keep unmatched source references in source notes.`);
}
function validStorage(value,errors) {
  if(value===null||value===undefined)return;
  if(!obj(value)){errors.push('Storage location must contain facility, tank, canister and position fields.');return;}
  for(const [k,v]of Object.entries(value))if(!['facility','tank','canister','position'].includes(k)||v!==null&&(typeof v!=='string'||v.length>160))errors.push('Storage fields must be text of at most 160 characters or blank.');
}
function lotErrors(p,dataset) {
  const errors=[];
  if(!obj(p)||p.schema_version!==1)return ['Cryopreservation lot must use schema version 1.'];
  if(!text(p.label)||p.label.length>160)errors.push('Enter a lot label of 1–160 characters.');
  for(const k of ['case_id','strain','background','modification_method','gene','zygosity','origin','manager'])if(p[k]!=null&&(typeof p[k]!=='string'||p[k].length>1000))errors.push(`${k} must be text of at most 1,000 characters or blank.`);
  if(!Array.isArray(p.batch_ids)||p.batch_ids.some(x=>!text(x)||x.length>160)||new Set(p.batch_ids).size!==p.batch_ids.length)errors.push('Batch IDs must be distinct text labels. Keep an aggregate source count with its complete batch list.');
  if(!CRYO_MATERIALS.includes(p.material))errors.push('Select a material, or leave material unknown.');
  if(!CRYO_STATUSES.includes(p.status))errors.push('Select a valid cryopreservation status.');
  validStorage(p.storage_location,errors);
  if(p.donor_mouse_sids!==undefined)validRefs(p.donor_mouse_sids,dataset,'Donor references',errors);
  for(const k of ['frozen_date','quantity_as_of_date'])if(p[k]!=null&&!date(p[k]))errors.push(`${k} must be a valid YYYY-MM-DD date or blank.`);
  if(p.quantity!==null&&p.quantity!==undefined&&!count(p.quantity))errors.push('Current quantity must be a nonnegative whole number or unknown.');
  if(p.quantity_unit!=null&&!CRYO_UNITS.includes(p.quantity_unit))errors.push('Select a supported quantity unit.');
  if(count(p.quantity)&&(!CRYO_UNITS.includes(p.quantity_unit)||!date(p.quantity_as_of_date)))errors.push('A known current quantity needs its unit and stock date.');
  if(date(p.frozen_date)&&date(p.quantity_as_of_date)&&p.quantity_as_of_date<p.frozen_date)errors.push('The current stock date cannot precede the freezing date.');
  if(!count(p.activity_revision))errors.push('Activity revision must be a nonnegative whole number.');
  if(p.last_activity_id!=null&&!text(p.last_activity_id))errors.push('The last activity identifier must be text or blank.');
  if(p.activity_revision===0&&p.last_activity_id!=null||p.activity_revision>0&&!text(p.last_activity_id))errors.push('Activity revision and last activity must agree.');
  if(p.status==='depleted'&&p.quantity!==0)errors.push('Depleted status requires an explicitly recorded zero balance.');
  if(p.status==='stored'&&p.quantity===0)errors.push('A zero current balance should be marked depleted, not stored.');
  if(p.status==='stored'&&!text(p.manager))errors.push('Assign a manager before marking a lot stored.');
  if(p.status==='stored'&&!Object.values(p.storage_location||{}).some(text))errors.push('Record a storage location before marking a lot stored.');
  if(p.notes!=null&&(typeof p.notes!=='string'||p.notes.length>4000))errors.push('Lot notes must be text of at most 4,000 characters.');
  return errors;
}

function activityMath(a,effectiveDate,errors) {
  if(!obj(a.before)||!obj(a.after))return;
  let quantity=a.before.quantity??null,unit=a.before.quantity_unit??null,asOf=a.before.quantity_as_of_date??null;
  if(quantity!==null&&!count(quantity)){errors.push('The captured opening stock must be a whole number or unknown.');return;}
  if(a.activity_type==='stocktake'&&count(a.quantity)){quantity=a.quantity;unit=a.quantity_unit;asOf=effectiveDate;}
  else if(a.quantity!=null&&count(a.quantity)) {
    if(unit!==null&&unit!==a.quantity_unit)errors.push('Activity units differ from the opening stock; no conversion is inferred.');
    if(quantity!==null){quantity+=(['deposit','transfer_in'].includes(a.activity_type)?1:-1)*a.quantity;asOf=effectiveDate;if(quantity<0)errors.push('The activity exceeds the captured opening stock.');}
    else asOf=null;
    unit=a.quantity_unit;
  }
  if(a.after.quantity!==quantity||a.after.quantity_unit!==unit||a.after.quantity_as_of_date!==asOf)errors.push('Activity before/after balances do not match its quantity and unit.');
}

/** The enclosing model also validates identifiers, dates and all source fields. */
export function validateCryoRecord(draft,dataset,old=null) {
  const errors=[],warnings=[];
  if(!obj(draft))return {errors:['A cryopreservation record is required.'],warnings};
  const relevant=[LOT,ACTIVITY].includes(draft.event_type)||[LOT,ACTIVITY].includes(old?.event_type)||draft.cryopreservation||draft.cryopreservation_event;
  if(!relevant)return {errors,warnings};
  if(old&&[LOT,ACTIVITY].includes(old.event_type)&&draft.event_type!==old.event_type)errors.push('A cryopreservation record must retain its record type.');
  if(![LOT,ACTIVITY].includes(draft.event_type))errors.push('Cryopreservation payloads require their matching record type.');
  if(old)for(const k of new Set([...Object.keys(old),...Object.keys(draft)]))if((k.startsWith('source')||k==='record_origin')&&!same(old[k],draft[k]))errors.push(`Imported provenance ${k} cannot be changed.`);
  if(draft.event_type===LOT) {
    const p=draft.cryopreservation,prior=old?.cryopreservation;
    const issues=lotErrors(p,dataset),unchanged=old&&same(p,prior);
    (unchanged?warnings:errors).push(...issues.map(x=>unchanged?'Existing lot issue retained: '+x:x));
    if(!obj(p))return {errors,warnings};
    if(draft.cryopreservation_event!=null)errors.push('A lot cannot also contain an activity payload.');
    if(draft.source_case_key!=null) {
      if(!text(draft.source_case_key))errors.push('Source case key must be nonempty text.');
      else {
        try{if(draft.event_id!==cryoSourceLotId(draft.source_case_key))errors.push('Source-derived lots must use their deterministic source identifier.');}catch(error){errors.push(error.message);}
        if(cryoLots(dataset,{includeArchived:true}).some(r=>r.event_id!==draft.event_id&&r.source_case_key===draft.source_case_key))errors.push('This source case already has a lot. Reopen that lot rather than creating another inventory.');
      }
    }
    if(archived(draft)&&!archived(old)&&p.quantity!==0)errors.push('Record a verified zero balance before archiving a lot. Archiving does not consume or transfer stock.');
    const inventoryChanged=prior?protectedKeys.some(k=>!same(p[k],prior[k])):p.quantity!=null||p.activity_revision>0;
    if(inventoryChanged) {
      const activity=rows(dataset).find(r=>r.event_id===p.last_activity_id&&r.event_type===ACTIVITY),a=activity?.cryopreservation_event;
      if(!a||a.lot_id!==draft.event_id||a.revision_before!==revision(prior)||a.revision_after!==revision(prior)+1||p.activity_revision!==a.revision_after||!same(a.after,snapshot(p))||prior&&!same(a.before,snapshot(prior)))errors.push('Change inventory through a dated activity saved atomically with this lot.');
    }
    if(p.quantity==null)warnings.push('Current stock is unknown. Historical reported counts are not a current balance.');
    if(p.material==='unknown')warnings.push('Material remains unknown; source codes are not interpreted as sperm or embryos.');
  } else if(draft.event_type===ACTIVITY) {
    const a=draft.cryopreservation_event;
    if(!obj(a)||a.schema_version!==1)return {errors:[...errors,'Cryopreservation activity must use schema version 1.'],warnings};
    if(draft.cryopreservation!=null)errors.push('An activity cannot also contain a lot payload.');
    if(old) {
      if(!same(a,old.cryopreservation_event)||draft.event_date!==old.event_date)errors.push('Recorded activity facts and dates are immutable. Add a corrective activity instead.');
      if(archived(draft)!==archived(old))errors.push('Activity history cannot be hidden or restored to alter stock. Add a corrective activity instead.');
    }
    if(!old&&archived(draft))errors.push('A new activity cannot be archived.');
    if(!date(draft.event_date))errors.push('Every activity needs a valid effective date.');
    if(!CRYO_ACTIVITIES.includes(a.activity_type))errors.push('Select a valid cryopreservation activity.');
    if(!text(a.lot_id))errors.push('An activity needs a lot identifier.');
    const lot=cryoLots(dataset,{includeArchived:true}).find(r=>r.event_id===a.lot_id);
    if(!lot)errors.push('The activity lot does not exist.');
    if(!old&&lot&&archived(lot))errors.push('Restore the lot before recording activity.');
    if(!count(a.revision_before)||!count(a.revision_after)||a.revision_after!==a.revision_before+1)errors.push('Activity revisions must advance by one.');
    if(!obj(a.before)||!obj(a.after))errors.push('Activity needs captured before and after inventory.');
    if(a.quantity!=null&&!count(a.quantity))errors.push('Activity quantity must be a nonnegative whole number or blank.');
    if(a.quantity!=null&&!CRYO_UNITS.includes(a.quantity_unit))errors.push('A numeric activity needs a supported unit.');
    if(a.activity_type==='stocktake'&&!count(a.quantity))errors.push('A stocktake requires an explicit total, including zero.');
    if(['deposit','use','discard','transfer_in','transfer_out'].includes(a.activity_type)&&(!count(a.quantity)||a.quantity===0))errors.push('This activity requires a positive quantity.');
    if(['relocation','status_change','note'].includes(a.activity_type)&&a.quantity!=null)errors.push('Use a stock activity to change quantity.');
    if(a.recovery_status!=null&&!RECOVERY_STATUSES.includes(a.recovery_status))errors.push('Select a recorded recovery outcome or not recorded.');
    validRefs(a.recovered_mouse_sids??[],dataset,'Recovered mouse references',errors);
    if(a.activity_type!=='recovery'&&(a.recovered_mouse_sids?.length||present(a.recovery_status)&&a.recovery_status!=='not_recorded'))errors.push('Recovery results belong on recovery activities.');
    if(a.recovered_mouse_sids?.length&&a.recovery_status!=='recovered')errors.push('Linked recovered mice require a recorded recovered outcome.');
    activityMath(a,draft.event_date,errors);
    if(!old&&lot&&(lot.cryopreservation?.last_activity_id!==draft.event_id||lot.cryopreservation?.activity_revision!==a.revision_after||!same(snapshot(lot.cryopreservation),a.after)))errors.push('Save the activity with its updated lot in the same transaction.');
    if(draft.notes!=null&&(typeof draft.notes!=='string'||draft.notes.length>4000))errors.push('Activity notes must be text of at most 4,000 characters.');
  }
  return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}

/** Builds a pair, never writes. Caller replaces the lot and appends the event
 * in ONE saveDataset call. The changed anchor provides the concurrency fence. */
export function buildCryoActivity(lot,input,dataset) {
  if(!obj(lot?.cryopreservation)||lot.event_type!==LOT)throw new Error('Choose a cryopreservation lot.');
  if(archived(lot))throw new Error('Restore the lot before recording activity.');
  const existing=cryoLots(dataset,{includeArchived:true}).find(row=>row.event_id===lot.event_id);
  if(!existing||!same(existing.cryopreservation,lot.cryopreservation))throw new Error('The lot changed or is unavailable. Reload it before recording activity.');
  if(!obj(input)||!CRYO_ACTIVITIES.includes(input.activity_type)||!date(input.event_date))throw new Error('Choose an activity and a valid effective date.');
  const prior=lot.cryopreservation,p=copy(prior),kind=input.activity_type;
  const latest=cryoActivities(dataset,lot.event_id).at(-1);
  if(date(latest?.event_date)&&input.event_date<latest.event_date)throw new Error('Activity date precedes the latest recorded activity. Add a corrective activity on or after that date and retain earlier observations in its notes.');
  if(date(p.frozen_date)&&input.event_date<p.frozen_date)throw new Error('Activity date cannot precede freezing.');
  let quantity=input.quantity===''||input.quantity===undefined?null:input.quantity;
  if(quantity!==null&&!count(quantity))throw new Error('Enter a whole-number quantity or leave it unknown.');
  const unit=input.quantity_unit??p.quantity_unit??null;
  if(quantity!==null&&!CRYO_UNITS.includes(unit))throw new Error('Choose the quantity unit.');
  if(['deposit','use','discard','transfer_in','transfer_out'].includes(kind)&&(!count(quantity)||quantity===0))throw new Error('This activity requires a positive quantity.');
  if(['relocation','status_change','note'].includes(kind)&&quantity!==null)throw new Error('Use a stock activity to change quantity.');
  if(kind==='stocktake') {
    if(!count(quantity))throw new Error('A stocktake requires an explicit total, including zero.');
    p.quantity=quantity;p.quantity_unit=unit;p.quantity_as_of_date=input.event_date;
  } else if(quantity!==null) {
    if(p.quantity_unit!=null&&unit!==p.quantity_unit)throw new Error('Units differ. Record an explicit stocktake in the new unit; no conversion is inferred.');
    const sign=['deposit','transfer_in'].includes(kind)?1:-1;
    if(count(p.quantity)){p.quantity+=sign*quantity;if(p.quantity<0)throw new Error('The activity exceeds the recorded current stock.');p.quantity_as_of_date=input.event_date;}
    else {p.quantity=null;p.quantity_as_of_date=null;}
    p.quantity_unit=unit;
  }
  for(const k of ['status','manager','storage_location'])if(Object.hasOwn(input,k))p[k]=copy(input[k]);
  if(kind==='relocation'&&same(p.storage_location,prior.storage_location)&&same(p.manager,prior.manager))throw new Error('Record a changed storage location or manager for relocation.');
  if(kind==='status_change'&&same(p.status,prior.status))throw new Error('Choose a changed status.');
  const now=new Date().toISOString(),eventId='CRYOEV-'+crypto.randomUUID();
  p.activity_revision=revision(prior)+1;p.last_activity_id=eventId;
  const nextLot={...copy(lot),cryopreservation:p,app_modified_at:now};
  const event={event_id:eventId,event_type:ACTIVITY,event_date:input.event_date,record_origin:'app_created',notes:input.notes??null,
    app_created_at:now,app_modified_at:now,cryopreservation_event:{schema_version:1,lot_id:lot.event_id,activity_type:kind,quantity,quantity_unit:quantity===null?null:unit,
      recovery_status:input.recovery_status??'not_recorded',recovered_mouse_sids:copy(input.recovered_mouse_sids??[]),
      revision_before:revision(prior),revision_after:p.activity_revision,before:snapshot(prior),after:snapshot(p)}};
  const next=copy(dataset);next.tables??={};next.tables.husbandry_events=rows(dataset).filter(r=>r.event_id!==lot.event_id).map(copy);next.tables.husbandry_events.push(nextLot,event);
  const errors=[...validateCryoRecord(nextLot,next,lot).errors,...validateCryoRecord(event,next).errors];
  if(errors.length)throw new Error([...new Set(errors)].join(' '));
  return {lot:nextLot,event};
}
