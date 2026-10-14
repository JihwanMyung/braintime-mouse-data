// Presentation order only; names, assignments and rack coordinates are unchanged.
const text=value=>typeof value==='string'?value.trim():'';
const label=room=>typeof room==='string'?room:text(room?.name)||text(room?.label)||text(room?.roomName)||text(room?.room_id)||text(room?.roomId);
export function roomOrderRank(room){
 const id=text(room?.room_id||room?.roomId).toLowerCase(),name=label(room).toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');
 if(id==='room_sheet_beh'||/\b(?:ani\s?beh|animal beh(?:aviour|avior)?|animal behaviou?r)\b/.test(name))return 0;
 if(id==='room_sheet_rat'||/\brat(?:\s+room)?\b/.test(name))return 1;
 if(id==='room_sheet_conventional'||/\b(?:clean\s*room|conventional(?:\s+room)?)\b/.test(name))return 2;
 if(id==='room_sheet_spf'||/\bspf\b/.test(name))return 3;
 return 4;
}
export function compareRooms(a,b){return roomOrderRank(a)-roomOrderRank(b)||label(a).localeCompare(label(b),undefined,{numeric:true,sensitivity:'base'})||text(a?.room_id||a?.roomId).localeCompare(text(b?.room_id||b?.roomId));}
export function sortRooms(rooms=[]){return [...rooms].sort(compareRooms);}
