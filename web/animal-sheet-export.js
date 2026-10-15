import {compareRooms} from './room-order.js?v=24';
import { lightClock } from './husbandry.js?v=36';
import {mouseManager,cageManager} from './model.js?v=36';
import {createWorkbookXlsx,columnName} from './workbook-export.js?v=24';
export {createWorkbookXlsx} from './workbook-export.js?v=24';

const present=v=>v!==null&&v!==undefined&&v!=='';
const id=v=>present(v)?String(v):'';
const text=v=>v==null?'':Array.isArray(v)?v.join(', '):typeof v==='object'?JSON.stringify(v):String(v);
const alive=r=>!r.app_archived_at&&r.archived!==true;
const list=v=>Array.isArray(v)?v:[];
const dateOnly=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const coordinate=v=>typeof v==='number'&&Number.isInteger(v)&&v>=0;
const name=(record,fallback)=>text(record?.name||record?.label||fallback);
const compare=(a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true});
const source=r=>text(r.source_url||r.source_filename||r.source_file||r.source_title);
const managerText=m=>m.name|| (m.conflict?`Conflict: ${m.candidates.join(', ')}`:m.incomplete?`Needs review (${m.candidates.join(', ')||'unassigned'}; some residents unassigned)`:'Unassigned');
const byId=(records,field)=>new Map(records.map(r=>[id(r[field]),r]));
function localDate(stamp,zone='Asia/Taipei') {
  if(dateOnly(stamp))return stamp;
  try{return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(stamp));}
  catch{return zone!=='Asia/Taipei'?localDate(stamp,'Asia/Taipei'):null;}
}
function validZone(zone){try{new Intl.DateTimeFormat('en-CA',{timeZone:zone||'Asia/Taipei'});return true;}catch{return false;}}
function applies(event,stamp) {
  const today=localDate(stamp,event.timezone||'Asia/Taipei');
  if(!today||!dateOnly(event.start_date)||event.start_date>today)return false;
  if(!event.end_date)return true;
  return dateOnly(event.end_date)&&(/next phase start|exclusive/i.test(event.interval_semantics||'')?today<event.end_date:today<=event.end_date);
}
function lightText(e) {
  return [e.protocol||'Protocol unknown',lightClock(e).label+(lightClock(e).defaulted?' (default LD)':''),
    present(e.cycle_hours)?`cycle ${e.cycle_hours} h`:null,present(e.light_hours)?`light ${e.light_hours} h`:null,
    present(e.intensity_lux)?`${e.intensity_lux} lux`:null,validZone(e.timezone)?e.timezone||'Asia/Taipei':`Invalid zone ${e.timezone}; date interpreted in Asia/Taipei`,
    /planned/i.test(e.evidence_status||'')?'Planned':e.actual_exposure_verified===true?'Exposure recorded as verified':'Exposure unverified'].filter(Boolean).join(' · ');
}

/** Current assignments, never a reconstruction of past occupancy. Date filters affect supporting tables only. */
export function projectAnimalSheet(dataset,options={}) {
  const tables=dataset?.tables||{},get=type=>list(tables[type]);
  const capturedAt=options.capturedAt||new Date().toISOString();
  if(Number.isNaN(new Date(capturedAt).getTime()))throw new Error('Choose a valid export capture time.');
  const dateFrom=options.dateFrom||'',dateTo=options.dateTo||'';
  if((dateFrom&&!dateOnly(dateFrom))||(dateTo&&!dateOnly(dateTo))||(dateFrom&&dateTo&&dateFrom>dateTo))throw new Error('Choose a valid, ordered export date range.');
  const roomId=id(options.roomId),rackId=id(options.rackId),cageIds=new Set(list(options.cageIds).map(id)),mouseIds=new Set(list(options.mouseIds).map(id));
  const rooms=byId(get('rooms'),'room_id'),racks=byId(get('racks'),'rack_id'),positions=byId(get('locations'),'location_id');
  const stock=get('mice').filter(m=>alive(m)&&m.state==='Stock'),selectedStock=stock.filter(m=>!mouseIds.size||mouseIds.has(id(m.mouse_sid)));
  const residents=new Map(),selectedResidents=new Map();
  for(const [mice,map] of [[stock,residents],[selectedStock,selectedResidents]])for(const mouse of mice){const key=id(mouse.cage_sid);if(!map.has(key))map.set(key,[]);map.get(key).push(mouse);}
  const allCages=byId(get('cages'),'cage_sid');
  for(const [sid,mice] of residents)if(sid&&!allCages.has(sid))allCages.set(sid,{cage_sid:sid,cage_tag:[...new Set(mice.map(m=>m.cage_tag).filter(Boolean))].join(' / '),_derived:true});
  const lights=get('light_events').filter(alive),rows=[],groupMap=new Map();
  function references(cage={},positionOverride=null) {
    const position=positionOverride||positions.get(id(cage.location_id)),rid=id(cage.rack_id||position?.rack_id),rack=racks.get(rid),rmid=id(cage.room_id||position?.room_id||rack?.room_id),room=rooms.get(rmid);
    const roomName=name(room,rmid||cage.room||'Room unassigned'),rackName=name(rack,rid||cage.rack||'Rack unassigned');
    return {position,room,rack,roomId:rmid,rackId:rid,locationId:id(cage.location_id||position?.location_id),roomName,rackName,positionName:name(position,cage.location_id||cage.location||'Position unassigned')};
  }
  const inScope=ref=>(!roomId||ref.roomId===roomId)&&(!rackId||ref.rackId===rackId);
  function groupFor(ref) {
    const key=JSON.stringify([ref.roomId,ref.rackId,ref.roomName,ref.rackName]);
    if(!groupMap.has(key))groupMap.set(key,{key,roomId:ref.roomId,rackId:ref.rackId,roomName:ref.roomName,rackName:ref.rackName,items:[]});
    return groupMap.get(key);
  }
  if(!cageIds.size&&!mouseIds.size){
    for(const rack of get('racks').filter(alive)){const ref=references({rack_id:rack.rack_id});if(inScope(ref))groupFor(ref);}
    for(const room of get('rooms').filter(alive))if(!get('racks').some(r=>alive(r)&&r.room_id===room.room_id)){const ref=references({room_id:room.room_id});if(inScope(ref))groupFor(ref);}
  }
  const usedPositions=new Set();
  function add(cage,position,kind='cage',mice=[]) {
    const ref=references(cage||{},position),warnings=[];
    if(!inScope(ref))return;
    for(const [field,record,label] of [['roomId',ref.room,'room'],['rackId',ref.rack,'rack'],['locationId',ref.position,'position']]){
      if(ref[field]&&!record)warnings.push(`Unknown ${label} reference: ${ref[field]}`);
      else if(record&&!alive(record))warnings.push(`Referenced ${label} is archived`);
    }
    if(cage?.room_id&&ref.position?.room_id&&cage.room_id!==ref.position.room_id)warnings.push('Cage and position room references disagree');
    if(cage?.rack_id&&ref.position?.rack_id&&cage.rack_id!==ref.position.rack_id)warnings.push('Cage and position rack references disagree');
    if(ref.roomId&&ref.rack?.room_id&&ref.roomId!==ref.rack.room_id)warnings.push('Rack and room references disagree');
    if(cage&&!alive(cage))warnings.push('Stock mice reference an archived cage');
    if(cage&&mice.length&&/^(Ended|Inactive)$/i.test(cage.state||''))warnings.push(`Stock mice reference a ${cage.state.toLowerCase()} cage`);
    if(cage?._derived)warnings.push('Cage derived from current mouse references; no cage record in this export');
    if(dataset.history_projection?.read_only===true&&cage?.history_occupancy_unknown===true)warnings.push('Historical cage assignment is recorded; animal occupancy is unknown.');
    const related=lights.filter(e=>(ref.locationId&&id(e.location_id)===ref.locationId)||(cage&&id(e.cage_sid)===id(cage.cage_sid))||(!e.location_id&&!e.cage_sid&&(e.rack_id?id(e.rack_id)===ref.rackId&&(!e.room_id||id(e.room_id)===ref.roomId):e.room_id&&id(e.room_id)===ref.roomId)));
    const applicableLights=related.filter(e=>applies(e,capturedAt)),undatedLights=related.filter(e=>!dateOnly(e.start_date)||(e.end_date&&!dateOnly(e.end_date)));
    if(applicableLights.length>1)warnings.push('Overlapping date-applicable light records');
    if(related.some(e=>!validZone(e.timezone)))warnings.push('Invalid light-record time zone; date applicability uses Asia/Taipei');
    if(undatedLights.length)warnings.push(`${undatedLights.length} undated light record(s), excluded from current schedule`);
    const row={...ref,kind,cage:cage||null,position:ref.position||null,cageId:id(cage?.cage_sid),cageTag:text(cage?.cage_tag),row:ref.position?.row??null,column:ref.position?.column??null,
      mice:[...mice].sort((a,b)=>compare(a.mouse_sid,b.mouse_sid)),totalStockCount:cage?(residents.get(id(cage.cage_sid))||[]).length:mice.length,
      manager:cageManager(cage,cage?(residents.get(id(cage.cage_sid))||[]):mice),applicableLights,undatedLights,warnings,
      state:kind==='unassigned'?'Cage unassigned':cage?(!alive(cage)?'Archived cage':cage.state||'State unknown'):ref.position?.source_current===false?'Withdrawn source position':ref.position?.record_origin==='app_created'?'Empty position':'Unlinked source position'};
    rows.push(row);groupFor(ref).items.push(row);if(ref.locationId)usedPositions.add(ref.locationId);
  }
  for(const cage of allCages.values()){
    const sid=id(cage.cage_sid),mice=selectedResidents.get(sid)||[],position=positions.get(id(cage.location_id));
    if(!sid)continue;
    if(cageIds.size&&!cageIds.has(sid))continue;
    if(mouseIds.size&&!mice.length)continue;
    const hasCurrent=(residents.get(sid)||[]).length>0;
    const historicalAssignment=dataset.history_projection?.read_only===true&&cage.history_read_only===true&&cage.history_evidence_kind==='last_recorded_assignment';
    if(!hasCurrent&&(!alive(cage)||(!historicalAssignment&&!/^(Active|Occupied)$/i.test(cage.state||'')&&!(position&&alive(position)))))continue;
    add(cage,null,'cage',mice);
  }
  if(!cageIds.size&&!mouseIds.size)for(const position of get('locations').filter(alive))if(!usedPositions.has(id(position.location_id)))add(null,position,'position');
  if(!roomId&&!rackId&&!cageIds.size&&(selectedResidents.get('')||[]).length)add(null,null,'unassigned',selectedResidents.get(''));
  for(const positionId of usedPositions){const linked=rows.filter(r=>r.locationId===positionId&&r.cage);if(linked.length>1)for(const row of linked)row.warnings.push('Multiple cages share this position; occupancy requires review');}
  const groups=[...groupMap.values()].sort((a,b)=>compareRooms(a,b)||compare(a.rackName,b.rackName));
  for(const group of groups)group.items.sort((a,b)=>(coordinate(a.row)?a.row:Infinity)-(coordinate(b.row)?b.row:Infinity)||(coordinate(a.column)?a.column:Infinity)-(coordinate(b.column)?b.column:Infinity)||compare(a.cageId||a.locationId,b.cageId||b.locationId));
  const warnings=[...new Set(rows.flatMap(r=>r.warnings))];
  if(mouseIds.size)warnings.push('Selected-mouse export: other current residents are omitted; total resident counts remain shown.');
  if(dateFrom||dateTo)warnings.push('Date range applies to supporting data; the housing map shows current assignments, not past occupancy.');
  const projection={title:'Current Animal Sheet',capturedAt,groups,rows,warnings,scope:{roomId,rackId,cageIds:[...cageIds],mouseIds:[...mouseIds],dateFrom,dateTo},
    counts:{rooms:new Set(groups.map(g=>g.roomId).filter(Boolean)).size,racks:new Set(groups.map(g=>g.rackId).filter(Boolean)).size,groups:groups.length,positions:new Set(rows.map(r=>r.locationId).filter(Boolean)).size,cages:rows.filter(r=>r.cage).length,mice:rows.reduce((n,r)=>n+r.mice.length,0)}};
  projection.sheets=buildSheets(projection,tables,options.entityTypes??['mice','cages','locations','light_events']);
  return projection;
}

function panels(group) {
  const located=group.items.filter(item=>coordinate(item.row)&&coordinate(item.column));
  const columns=[...new Set(located.map(item=>item.column))].sort((a,b)=>a-b),bands=[...new Set(located.map(item=>item.row))].sort((a,b)=>a-b),result=[];
  for(let start=0;start<columns.length;start+=2){const cols=columns.slice(start,start+2);result.push({label:`Recorded columns ${cols.join(' / ')}`,bands:bands.map(row=>({row,slots:cols.map(column=>({column,items:located.filter(item=>item.row===row&&item.column===column)}))}))});}
  const unplaced=group.items.filter(item=>!coordinate(item.row)||!coordinate(item.column));
  if(unplaced.length)result.push({label:'No complete rack coordinates recorded',bands:Array.from({length:Math.ceil(unplaced.length/2)},(_,i)=>({row:null,slots:unplaced.slice(i*2,i*2+2).map(item=>({column:null,items:[item]}))}))});
  return result;
}
function cardLines(item) {
  if(!item)return [['No position record','','','','','']];
  const selected=item.mice.length!==item.totalStockCount?`${item.mice.length} selected / ${item.totalStockCount} total Stock`:`${item.mice.length} Stock`;
  return [
    [`${item.positionName}${item.cage?` · Cage ${item.cageTag||item.cageId} (SID ${item.cageId})`:''}`],
    [`${item.state} · ${selected} · Manager: ${managerText(item.manager)}`],
    [item.applicableLights.map(lightText).join('\n')||'No date-applicable light schedule recorded'],
    ['Mouse SID','Tag / Ear marking','Sex','Born','Genotype','Manager'],
    ...item.mice.map(m=>[id(m.mouse_sid),[m.physical_tag,m.ear_mark?`Ear: ${m.ear_mark}`:null].filter(Boolean).join('\n'),m.sex,m.date_of_birth,m.genotype,managerText(mouseManager(m))]),
    [item.warnings.join('; ')||(!item.cage&&item.kind==='position'&&item.position?.record_origin!=='app_created'?'Source-listed animals are historical evidence, not assigned residents.':'')]
  ];
}
function mapSheet(projection) {
  const sheet={name:'Animal Sheet',rows:[],widths:Array(2).fill([12,17,10,13,24,20]).flat(),merges:[],rowHeights:[],cellStyles:{},frozenRows:0,autoFilter:false};
  function full(value,style=2,height=25){const r=sheet.rows.length;sheet.rows.push([value,...Array(11).fill('')]);sheet.merges.push(`A${r+1}:L${r+1}`);sheet.cellStyles[`A${r+1}`]=style;sheet.rowHeights[r]=height;}
  full('Braintime · Current Animal Sheet',4,30);full(`Captured ${projection.capturedAt} · ${projection.counts.mice} Stock mice · ${projection.counts.cages} cages`,3);
  full('Current Stock assignments only. Coordinates preserve recorded rack order; missing slots have no position record. Lighting is a record, not proof of exposure.',3,32);
  for(const group of projection.groups){
    full(`${group.roomName} / ${group.rackName}`,1);
    if(!group.items.length){full('No positions or cages recorded.',3);continue;}
    for(const panel of panels(group)){
      full(panel.label,2);
      for(const band of panel.bands){
        full(band.row===null?'Unpositioned records':`Recorded row ${band.row}`,3);
        const stacks=band.slots.map(slot=>slot.items.length?slot.items:[null]),depth=Math.max(...stacks.map(items=>items.length));
        for(let n=0;n<depth;n++){
          const cards=stacks.map(items=>cardLines(items[n])),height=Math.max(...cards.map(lines=>lines.length)),base=sheet.rows.length;
          for(let r=0;r<height;r++){
            const cells=Array(12).fill('');sheet.rows.push(cells);
            for(let c=0;c<cards.length;c++){
              const line=cards[c][r];if(!line)continue;
              for(let i=0;i<line.length;i++)cells[c*6+i]=line[i]??'';
              if(line.length===1){sheet.merges.push(`${columnName(c*6)}${base+r+1}:${columnName(c*6+5)}${base+r+1}`);sheet.cellStyles[`${columnName(c*6)}${base+r+1}`]=r===0?2:r===1?3:r===2?3:5;}
              else if(r===3)for(let i=0;i<6;i++)sheet.cellStyles[`${columnName(c*6+i)}${base+r+1}`]=1;
            }
            sheet.rowHeights[base+r]=r===0?28:r===1?32:r===2?Math.min(220,Math.max(42,...cards.map(lines=>(String(lines[r]?.[0]||'').length/90)*13))):r===3?22:30;
          }
          sheet.rows.push(Array(12).fill(''));sheet.rowHeights.push(8);
        }
      }
    }
  }
  return sheet;
}

const columns={
  mice:['mouse_sid','physical_tag','ear_mark','sex','date_of_birth','genotype','genotype_status','mouseline','strain','state','status','cage_sid','cage_tag','manager','manager_status','manager_basis','sire_sids','dam_sids','litter_sid','mating_sids','protocol','comment','source'],
  cages:['cage_sid','cage_tag','state','room_id','room','rack_id','rack','location_id','position','current_stock_count','selected_stock_count','manager','manager_status','manager_basis','derived','capacity','cage_type','comment','source'],
  locations:['location_id','label','room_id','rack_id','locobox_id','row','column','record_origin','source_snapshot_date','source_current','source_last_seen_at','manager','manager_acronym','source_manager_name','source_manager_acronym','source_observed_mouse_sids','source_candidate_mouse_sids','source_observed_tags','source_observed_cage_sids','source_candidate_cage_sids','evidence_status','notes','source'],
  rooms:['room_id','name','label','notes','source'],racks:['rack_id','room_id','name','label','notes','source'],
  light_events:['event_id','room_id','rack_id','location_id','cage_sid','start_date','end_date','interval_semantics','protocol','cycle_hours','light_hours','lights_on','lights_off','transition_minutes','intensity_lux','timezone','evidence_status','actual_exposure_verified','notes','source'],
  husbandry_events:['event_id','event_type','event_date','mouse_sid','cage_sid','location_id','old_location_label','location_label','notes','source'],
  matings:['mating_sid','mating_tag','state','set_up_date','disbanded_date','cage_sid','male_sids','female_sids','linked_litter_sids','comment','source'],
  litters:['litter_sid','litter_tag','state','date_of_birth','wean_date','mating_sid','cage_sid','size_reported','sire_sids','dam_sids','listed_pup_sids','comment','source']
};
function buildSheets(p,tables,selectedTypes) {
  if(!Array.isArray(selectedTypes)||selectedTypes.some(type=>!Object.hasOwn(columns,type)))throw new Error('Choose supported entity tables for this export.');
  const summary={name:'Export details',rows:[['Field','Value'],['Title',p.title],['Captured at',p.capturedAt],['Scope',JSON.stringify(p.scope)],['Current Stock mice',p.counts.mice],['Cages',p.counts.cages],['Positions',p.counts.positions],['Current assignment rule','Stock mice excluding archived records. Source-listed animals never establish occupancy.'],['Date filters','Supporting data only; this map does not reconstruct historical occupancy.'],['Lighting','Applicable in each event time zone; missing dates excluded. Overlaps and unverified exposure are retained.'],...p.warnings.map(w=>['Review note',w])],widths:[30,120]};
  const mice=p.rows.flatMap(r=>r.mice),cages=p.rows.filter(r=>r.cage),mouseSet=new Set(mice.map(m=>id(m.mouse_sid))),cageSet=new Set(cages.map(r=>r.cageId)),positionSet=new Set(p.rows.map(r=>r.locationId).filter(Boolean)),roomSet=new Set(p.groups.map(g=>g.roomId).filter(Boolean)),rackSet=new Set(p.groups.map(g=>g.rackId).filter(Boolean));
  const litterSet=new Set(mice.map(m=>id(m.litter_sid)).filter(Boolean)),matingSet=new Set(mice.flatMap(m=>list(m.mating_sids)).map(id));
  for(const litter of list(tables.litters))if(litterSet.has(id(litter.litter_sid))&&litter.mating_sid)matingSet.add(id(litter.mating_sid));
  const {dateFrom:from,dateTo:to}=p.scope,range=(record,type)=>{
    if(!from&&!to)return true;
    if(['rooms','racks','locations'].includes(type))return true;
    const candidates=type==='mice'?[record.end_date,record.date_of_birth]:type==='matings'?[record.disbanded_date,record.set_up_date]:type==='litters'?[record.end_date,record.wean_date,record.date_of_birth]:type==='cages'?[record.end_date,record.set_up_date]:type==='light_events'?[record.end_date,record.start_date]:[record.event_date];
    const date=[record.export_record_date,...candidates].find(dateOnly);
    return !!date&&(!to||date<=to)&&(!from||date>=from);
  };
  const scopedEvent=e=>(e.mouse_sid&&mouseSet.has(id(e.mouse_sid)))||(e.cage_sid&&cageSet.has(id(e.cage_sid)))||(e.location_id&&positionSet.has(id(e.location_id)))||(!e.mouse_sid&&!e.cage_sid&&!e.location_id&&(e.rack_id?rackSet.has(id(e.rack_id))&&(!e.room_id||roomSet.has(id(e.room_id))):e.room_id&&roomSet.has(id(e.room_id))));
  const resolved={
    mice:mice.map(m=>{const manager=mouseManager(m);return {...m,manager:managerText(manager),manager_status:manager.status,manager_basis:manager.source};}),
    cages:cages.map(r=>({...r.cage,room_id:r.roomId,room:r.roomName,rack_id:r.rackId,rack:r.rackName,location_id:r.locationId,position:r.positionName,current_stock_count:r.totalStockCount,selected_stock_count:r.mice.length,manager:managerText(r.manager),manager_status:r.manager.status,manager_basis:r.manager.source,derived:!!r.cage._derived})),
    locations:list(tables.locations).filter(r=>positionSet.has(id(r.location_id))),rooms:list(tables.rooms).filter(r=>roomSet.has(id(r.room_id))).sort(compareRooms),racks:list(tables.racks).filter(r=>rackSet.has(id(r.rack_id))),
    light_events:list(tables.light_events).filter(e=>alive(e)&&scopedEvent(e)&&((from||to)||applies(e,p.capturedAt))),
    husbandry_events:list(tables.husbandry_events).filter(e=>alive(e)&&scopedEvent(e)),
    matings:list(tables.matings).filter(m=>alive(m)&&(matingSet.has(id(m.mating_sid))||cageSet.has(id(m.cage_sid)))),
    litters:list(tables.litters).filter(l=>alive(l)&&(litterSet.has(id(l.litter_sid))||cageSet.has(id(l.cage_sid))))
  };
  return [summary,mapSheet(p),...[...new Set(selectedTypes)].map(type=>({name:type.replaceAll('_',' '),rows:[columns[type],...resolved[type].filter(record=>range(record,type)).map(r=>columns[type].map(field=>field==='source'?source(r):r[field]??''))],widths:columns[type].map(field=>/notes|comment|source|genotype/.test(field)?40:20)}))];
}

export function createAnimalSheetXlsx(projection) {return createWorkbookXlsx(projection);}

const esc=v=>text(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function safeLogo(value) {
  try{const url=new URL(value||'./icons/braintime-mark.png',import.meta.url);return /^(https?:|file:)$/.test(url.protocol)?url.href:'';}catch{return '';}
}
function printCard(item) {
  if(!item)return '<article class="missing">No position record</article>';
  const mice=item.mice,parts=[];
  for(let start=0;start<Math.max(1,mice.length);start+=8){const part=mice.slice(start,start+8);
    parts.push(`<article class="cage"><h4>${esc(item.positionName)}${item.cage?` · Cage ${esc(item.cageTag||item.cageId)} <small>SID ${esc(item.cageId)}</small>`:''}${start?' (continued)':''}</h4><p>${esc(item.state)} · ${mice.length!==item.totalStockCount?`${mice.length} selected / ${item.totalStockCount} total`:mice.length} Stock · <b>Manager:</b> ${esc(managerText(item.manager))}</p>${!start?`<p class="light">${item.applicableLights.length?item.applicableLights.map(e=>esc(lightText(e))).join('<br>'):'No date-applicable light schedule recorded'}</p>`:''}<table><thead><tr><th>SID / Tag</th><th>Sex / Born</th><th>Genotype</th><th>Manager</th></tr></thead><tbody>${part.length?part.map(m=>`<tr><td><b>${esc(m.mouse_sid)}</b><br>${esc(m.physical_tag)}${m.ear_mark?`<br>Ear: ${esc(m.ear_mark)}`:''}</td><td>${esc(m.sex)}<br>${esc(m.date_of_birth)}</td><td>${esc(m.genotype||'Unknown')}</td><td>${esc(managerText(mouseManager(m)))}</td></tr>`).join(''):`<tr><td colspan="4">${item.kind==='position'&&item.position?.record_origin!=='app_created'?'Unlinked source position. Source-listed animals are not current assignments.':'No Stock mice assigned.'}</td></tr>`}</tbody></table>${item.warnings.length?`<p class="warning">${esc(item.warnings.join('; '))}</p>`:''}</article>`);
  }
  return parts.join('');
}

/** Print preview HTML; the browser's Print / Save as PDF action creates the PDF. */
export function animalSheetPrintHTML(projection,{logoUrl,title}={}) {
  const heading=title||projection.title||'Braintime Mouse Data',logo=safeLogo(logoUrl);
  let body='';
  if(Array.isArray(projection.groups))body=projection.groups.map(group=>`<section class="rack"><h2>${esc(group.roomName)} / ${esc(group.rackName)}</h2>${group.items.length?panels(group).map(panel=>`<h3>${esc(panel.label)}</h3>${panel.bands.map(band=>`<div class="band"><div class="coordinate">${band.row===null?'Coordinates unrecorded':`Recorded row ${esc(band.row)}`}</div><div class="grid">${band.slots.map(slot=>`<div class="slot"><div class="coordinate">${slot.column===null?'':`Recorded column ${esc(slot.column)}`}</div>${slot.items.length?slot.items.map(printCard).join(''):printCard(null)}</div>`).join('')}</div></div>`).join('')}`).join(''):'<p>No positions or cages recorded.</p>'}</section>`).join('');
  else body=list(projection.sheets).map(sheet=>`<section><h2>${esc(sheet.name)}</h2><table><thead><tr>${list(sheet.rows?.[0]).map(v=>`<th>${esc(v)}</th>`).join('')}</tr></thead><tbody>${list(sheet.rows).slice(1).map(row=>`<tr>${row.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title><style>
    :root{font-family:Arial,Helvetica,sans-serif;color:#303438;background:#f7f4e7;font-size:12px}body{margin:20px}header{display:flex;gap:16px;align-items:center;border-bottom:3px solid #1f4c7d;padding-bottom:12px}header img{width:48px;height:auto}h1{font-size:24px;color:#1f4c7d;margin:0}h2{background:#1f4c7d;color:#fff;padding:9px;font-size:17px;margin:24px 0 12px}h3{font-size:12px;margin:14px 0 4px;color:#1f4c7d}h4{font-size:12px;margin:0;background:#f7f4e7;padding:7px;color:#1f4c7d}p{margin:6px 0;line-height:1.4}.intro{font-size:10px;color:#5e6265}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.coordinate{font-size:10px;color:#5e6265;margin:4px 0}.cage{background:white;border:1px solid #b9c3cc;padding:5px;margin-bottom:10px;break-inside:avoid}.cage p{font-size:10px}.light{color:#4b5662}.warning{background:#fff0d1;padding:4px}.missing{border:1px dashed #b9c3cc;color:#5e6265;padding:12px}table{width:100%;border-collapse:collapse;table-layout:fixed;background:#fff}th,td{text-align:left;vertical-align:top;border:1px solid #d5d8db;padding:5px;overflow-wrap:anywhere;white-space:pre-wrap}th{font-size:10px;background:#edf2f7}td{font-size:10px}small{font-weight:normal}thead{display:table-header-group}.rack{break-before:page}.rack:first-of-type{break-before:auto}@page{size:A4 landscape;margin:10mm}@media print{body{margin:0;background:white}.no-print{display:none}h2,h3,.coordinate{break-after:avoid}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}.grid{align-items:start}}
    </style></head><body><header>${logo?`<img src="${esc(logo)}" alt="Braintime logo">`:''}<div><h1>${esc(heading)}</h1><p>Captured ${esc(projection.capturedAt||'')}</p></div></header><p class="no-print">Use Print → Save as PDF to save this document.</p><p class="intro">${projection.groups?'Current Stock assignments only. Recorded row and column coordinates preserve the source map order. Source-listed animals do not establish current occupancy. Light schedules retain uncertainty and do not prove exposure.':'Exported records, retaining text IDs and source uncertainty.'}</p>${list(projection.warnings).map(w=>`<p class="warning">${esc(w)}</p>`).join('')}${body}</body></html>`;
}
