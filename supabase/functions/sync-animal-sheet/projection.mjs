export const MANAGED_TABS = Object.freeze([
  {id:1900000001,title:'Database status'},
  {id:1900000002,title:'Current animals'},
  {id:1900000003,title:'Current cages'},
  {id:1900000004,title:'Light history'},
  {id:1900000005,title:'Room/rack map'},
]);
const val = v => v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v==='object' ? JSON.stringify(v) : v;
const cell = v => typeof v==='number' && Number.isFinite(v) ? {userEnteredValue:{numberValue:v}} : {userEnteredValue:{stringValue:String(val(v))}};
const alive = r => !r.archived && !r.payload.app_archived_at;
const dateOnly=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const list=value=>Array.isArray(value)?value:value==null||value===''?[]:[value];
const sourceOf=r=>r.source_url||r.source_file||r.source_filename||'';
function snapshotDate(capturedAt,timeZone='Asia/Taipei'){
  if(dateOnly(capturedAt))return capturedAt;
  const time=new Date(capturedAt);if(Number.isNaN(time.getTime()))return null;
  try{return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(time);}catch{return null;}
}
export function scheduleApplies(event,capturedAt){
  const today=snapshotDate(capturedAt,event.timezone||'Asia/Taipei');
  if(!today||!dateOnly(event.start_date)||event.start_date>today)return false;
  if(!event.end_date)return true;
  if(!dateOnly(event.end_date))return false;
  const exclusive=/next phase start|exclusive/i.test(event.interval_semantics||'');
  return exclusive?today<event.end_date:today<=event.end_date;
}
function scheduleText(event,scope){
  const has=v=>v!==null&&v!==undefined&&v!=='';
  const quantities=[['cycle_hours','cycle','h'],['light_hours','light','h'],['lights_on','on',''],['lights_off','off',''],['transition_minutes','transition','min'],['intensity_lux','intensity','lux']].filter(([k])=>has(event[k])).map(([k,label,unit])=>`${label} ${event[k]}${unit?' '+unit:''}`);
  return [`${event.event_id}: ${event.protocol||'protocol unknown'} (${scope})`,`${event.start_date||'start unknown'} to ${event.end_date||'end unknown'}`,...quantities,event.timezone?`time zone: ${event.timezone}`:null,`evidence: ${event.evidence_status||'unknown'}`,`actual exposure: ${event.actual_exposure_verified===true?'verified':'unverified'}`,event.notes].filter(Boolean).join('; ');
}
function roomRackGrid(records,capturedAt){
  const active=type=>records.filter(r=>r.entity_type===type&&alive(r)).map(r=>r.payload);
  const rooms=new Map(active('rooms').map(r=>[r.room_id,r])),racks=new Map(active('racks').map(r=>[r.rack_id,r]));
  const cages=active('cages'),mice=active('mice'),lights=active('light_events');
  const locations=active('locations').sort((a,b)=>String(a.room_id||'').localeCompare(String(b.room_id||''))||String(a.rack_id||'').localeCompare(String(b.rack_id||''))||Number(a.row||0)-Number(b.row||0)||Number(a.column||0)-Number(b.column||0)||String(a.label||a.location_id).localeCompare(String(b.label||b.location_id),undefined,{numeric:true}));
  const asOf=snapshotDate(capturedAt)||'date unavailable';
  const headers=['Room','Rack','Position','Position ID','Map row','Map column','Linked cage SIDs','Linked cage tags','Stock mouse SIDs in linked cages','Source-listed mouse SIDs','Source candidate mouse SIDs','Source tags / notes','Source-listed cage SIDs','Source candidate cage SIDs','Link evidence',`Date-applicable schedules (${asOf}, Taipei)`,'Undated schedule observations','Source position notes','Source snapshot date','Source','Source current','Source last seen','Manager','Manager acronym'];
  return [headers,...locations.map(location=>{
    const rack=racks.get(location.rack_id)||{},roomId=location.room_id||rack.room_id,room=rooms.get(roomId)||{};
    const linked=cages.filter(c=>c.location_id===location.location_id),cageIds=new Set(linked.map(c=>c.cage_sid));
    const scoped=lights.flatMap(event=>{
      if(event.location_id===location.location_id)return [{event,scope:'position'}];
      if(event.cage_sid&&cageIds.has(event.cage_sid))return [{event,scope:'linked cage'}];
      if(!event.location_id&&!event.cage_sid&&event.rack_id===location.rack_id&&(!event.room_id||event.room_id===roomId))return [{event,scope:'rack'}];
      if(!event.location_id&&!event.cage_sid&&!event.rack_id&&event.room_id&&event.room_id===roomId)return [{event,scope:'room'}];
      return [];
    });
    const applicable=scoped.filter(({event})=>scheduleApplies(event,capturedAt));
    const undated=scoped.filter(({event})=>!dateOnly(event.start_date)||Boolean(event.end_date&&!dateOnly(event.end_date)));
    return [room.name||room.label||roomId,rack.name||rack.label||location.rack_id,location.label||location.source_label,location.location_id,location.row,location.column,
      linked.map(c=>c.cage_sid),linked.map(c=>c.cage_tag).filter(Boolean),mice.filter(m=>m.state==='Stock'&&cageIds.has(m.cage_sid)).map(m=>m.mouse_sid),
      location.source_observed_mouse_sids,location.source_candidate_mouse_sids,list(location.source_observed_tags).join(', '),location.source_observed_cage_sids,location.source_candidate_cage_sids,
      location.source_current===false?'withdrawn source position (historical evidence)':location.evidence_status||(linked.length?'explicit cage location link':'unlinked position'),
      applicable.map(({event,scope})=>scheduleText(event,scope)).join('\n')||'No date-applicable schedule recorded',
      undated.map(({event,scope})=>scheduleText(event,scope)).join('\n'),
      [location.notes,location.source_block_text].filter(Boolean).join('\n'),location.source_snapshot_date,sourceOf(location),location.source_current===false?'No':'Yes',location.source_last_seen_at||'',location.manager||location.source_manager_name||'',location.manager_acronym||location.source_manager_acronym||''];
  })];
}
export function projectRecords(records, capturedAt, status='Database snapshot; automatic sync pending setup') {
  const rows = type => records.filter(r=>r.entity_type===type&&alive(r)).map(r=>r.payload);
  const mice=rows('mice'), cages=rows('cages'), lights=rows('light_events');
  const rooms=new Map(rows('rooms').map(r=>[r.room_id,r.name]));
  const racks=new Map(rows('racks').map(r=>[r.rack_id,r.name]));
  const locations=new Map(rows('locations').map(r=>[r.location_id,r]));
  const cmap=new Map(cages.map(r=>[r.cage_sid,r]));
  const housing=c=>{const l=locations.get(c.location_id)||{};return [rooms.get(c.room_id||l.room_id)||c.room||'',racks.get(c.rack_id||l.rack_id)||c.rack||'',l.label||c.location||''];};
  const source=r=>r.source_url||r.source_file||r.source_filename||'';
  return [
    [['Field','Value'],['Status',status],['Database snapshot at',capturedAt],['Direction','Database → this workbook'],['Editing','Edit records in the Colony app. Managed tabs are replaced on refresh.'],['Reference tabs','Copied Animal Sheet tabs are preserved reference snapshots.'],['Current animal rule','Stock mice, excluding app-archived records.'],['Identity','Unresolved historical IDs remain in the source archive, without invented links.'],['Light history','Recorded protocols, including uncertain source observations; does not prove biological entrainment.'],['Stock mice',mice.filter(m=>m.state==='Stock').length],['Active cages',cages.filter(c=>c.state==='Active').length]],
    [['Mouse SID','Physical tag','Ear marking','Sex','Genotype','Born','Cage SID','Cage tag','Room','Rack','Position','Status','Recorded sire IDs','Candidate dam IDs','Protocol','Comment','Source'],...mice.filter(m=>m.state==='Stock').map(m=>{const c=cmap.get(m.cage_sid)||{};return [m.mouse_sid,m.physical_tag,m.ear_mark,m.sex,m.genotype,m.date_of_birth,m.cage_sid,c.cage_tag||m.cage_tag,...housing(c),m.status,m.sire_sids,m.dam_sids,m.protocol,m.comment,source(m)];})],
    [['Cage SID','Cage tag','State','Room','Rack','Position','Type','Stock mice','Mouse SIDs','Capacity','Comment','Source'],...cages.filter(c=>c.state==='Active'||mice.some(m=>m.state==='Stock'&&m.cage_sid===c.cage_sid)).map(c=>{const members=mice.filter(m=>m.state==='Stock'&&m.cage_sid===c.cage_sid);return[c.cage_sid,c.cage_tag,c.state,...housing(c),c.cage_type,members.length,members.map(m=>m.mouse_sid),c.capacity,c.comment,source(c)];})],
    [['Event ID','Cage SID','Position ID','Position','Start','End','Protocol','Cycle hours','Light hours','Lights on','Lights off','Transition minutes','Lux','Time zone','Evidence','Notes','Source'],...lights.sort((a,b)=>String(a.start_date||'').localeCompare(String(b.start_date||''))).map(e=>[e.event_id,e.cage_sid,e.location_id,locations.get(e.location_id)?.label,e.start_date,e.end_date,e.protocol,e.cycle_hours,e.light_hours,e.lights_on,e.lights_off,e.transition_minutes,e.intensity_lux,e.timezone,e.evidence_status,e.notes,source(e)])],
    roomRackGrid(records,capturedAt)
  ];
}
export function projectionRequests(grids, existingSheets=[]) {
  const requests=[];
  MANAGED_TABS.forEach((tab,i)=>{
    const grid=grids[i],existing=existingSheets.find(s=>s.properties.sheetId===tab.id);
    if(existing&&existing.properties.title!==tab.title)throw new Error('Managed sheet ID belongs to an unexpected tab.');
    if(!existing&&existingSheets.some(s=>s.properties.title===tab.title))throw new Error('Managed tab title has an unexpected ID.');
    const rowCount=Math.max(grid.length+20,100),columnCount=grid[0].length;
    const frozenColumnCount=i===4?3:0;
    if(!existing)requests.push({addSheet:{properties:{sheetId:tab.id,title:tab.title,gridProperties:{rowCount,columnCount,frozenRowCount:1,frozenColumnCount}}}});
    else requests.push({updateSheetProperties:{properties:{sheetId:tab.id,gridProperties:{rowCount:Math.max(rowCount,existing.properties.gridProperties?.rowCount||0),columnCount:Math.max(columnCount,existing.properties.gridProperties?.columnCount||0),frozenRowCount:1,frozenColumnCount}},fields:'gridProperties'}});
    const usedRange={sheetId:tab.id,startRowIndex:0,endRowIndex:grid.length,startColumnIndex:0,endColumnIndex:columnCount};
    // Clear trailing values only inside dedicated managed tabs, then write an
    // exact rectangle. Explicit stringValue prevents formula injection.
    requests.push({repeatCell:{range:{sheetId:tab.id},cell:{},fields:'userEnteredValue'}});
    requests.push({updateCells:{range:usedRange,rows:grid.map(r=>({values:r.map(cell)})),fields:'userEnteredValue'}});
    requests.push({repeatCell:{range:usedRange,cell:{userEnteredFormat:{textFormat:{fontFamily:'Arial',fontSize:10},verticalAlignment:'TOP',wrapStrategy:'WRAP'}},fields:'userEnteredFormat'}});
    requests.push({repeatCell:{range:{...usedRange,endRowIndex:1},cell:{userEnteredFormat:{backgroundColor:{red:0.92,green:0.93,blue:0.94},textFormat:{foregroundColor:{red:0,green:0,blue:0},bold:true,fontSize:10},wrapStrategy:'WRAP'}},fields:'userEnteredFormat'}});
    requests.push({updateDimensionProperties:{range:{sheetId:tab.id,dimension:'COLUMNS',startIndex:0,endIndex:columnCount},properties:{pixelSize:i===0?260:145},fields:'pixelSize'}});
    if(i===4)for(const [startIndex,endIndex,pixelSize] of [[0,1,240],[3,4,260],[14,15,220],[15,18,600],[19,20,320]])requests.push({updateDimensionProperties:{range:{sheetId:tab.id,dimension:'COLUMNS',startIndex,endIndex},properties:{pixelSize},fields:'pixelSize'}});
    requests.push({setBasicFilter:{filter:{range:{sheetId:tab.id,startRowIndex:0,endRowIndex:grid.length,startColumnIndex:0,endColumnIndex:columnCount}}}});
  });
  return requests;
}
