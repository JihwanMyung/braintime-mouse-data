import test from 'node:test';
import assert from 'node:assert/strict';
import {sortRooms,roomOrderRank} from '../web/room-order.js';
import {projectAnimalSheet} from '../web/animal-sheet-export.js';
import {renderHousing} from '../web/husbandry.js';
import {renderLocobox} from '../web/locobox.js';
const rooms=[{room_id:'OTHER',name:'A room'},{room_id:'SPF',name:'SPF room'},{room_id:'CLEAN',name:'Clean room'},{room_id:'RAT',name:'Rat room'},{room_id:'BEH',name:'AniBeh'}];
test('room presentation order recognizes established names and keeps new rooms without mutation',()=>{
 const before=structuredClone(rooms);assert.deepEqual(sortRooms(rooms).map(r=>r.room_id),['BEH','RAT','CLEAN','SPF','OTHER']);assert.deepEqual(rooms,before);
 for(const name of ['Ani Beh','Animal Beh','SH Animal Behaviour'])assert.equal(roomOrderRank(name),0);
 for(const name of ['Conventional room','SHLAC-Conventional, Mouse Room #2','SH LAC Conventional'])assert.equal(roomOrderRank(name),2);
 for(const name of ['SHLAC Rat room','SH LAC Rat room','SHLAC-Rat room'])assert.equal(roomOrderRank(name),1);
 for(const name of ['SHLAC SPF','SH LAC SPF','SHLAC-SPF, Room 6'])assert.equal(roomOrderRank(name),3);
 assert.equal(roomOrderRank({room_id:'room_sheet_beh',name:'Behavior room'}),0);assert.equal(roomOrderRank('Operating room'),4);
});
test('current SHLAC labels retain Ani Beh, Rat, Conventional and SPF presentation order',()=>{
 const current=[{room_id:'spf-original-id',name:'SHLAC SPF'},{room_id:'clean-original-id',name:'SHLAC Conventional'},{room_id:'rat-original-id',name:'SHLAC Rat room'},{room_id:'beh-original-id',name:'Ani Beh'}],before=structuredClone(current);
 assert.deepEqual(sortRooms(current).map(room=>room.name),['Ani Beh','SHLAC Rat room','SHLAC Conventional','SHLAC SPF']);assert.deepEqual(current,before);
});
test('Animal Sheet and housing/Locobox choices share room order without renumbering rack positions',()=>{
 const dataset={tables:{rooms,racks:rooms.map(r=>({rack_id:'K'+r.room_id,room_id:r.room_id,name:'Rack 1'})),locations:rooms.flatMap(r=>[2,1].map(column=>({location_id:r.room_id+column,room_id:r.room_id,rack_id:'K'+r.room_id,label:'Slot '+column,row:1,column,record_origin:'app_created'}))),mice:[],cages:[],light_events:[],husbandry_events:[]}},before=structuredClone(dataset);
 const p=projectAnimalSheet(dataset,{capturedAt:'2026-10-15T01:00:00Z'});assert.deepEqual(p.groups.map(g=>g.roomId),['BEH','RAT','CLEAN','SPF','OTHER']);assert.deepEqual(p.groups[0].items.map(i=>i.column),[1,2]);
 const housing={innerHTML:''};renderHousing(housing,dataset,{canEdit:()=>false});const select=housing.innerHTML.match(/<select id="housing-room">([\s\S]*?)<\/select>/)[1];assert(select.indexOf('BEH')<select.indexOf('RAT'));assert(select.indexOf('CLEAN')<select.indexOf('SPF'));
 const locobox={innerHTML:''};renderLocobox(locobox,dataset,{canEdit:()=>false});const positions=locobox.innerHTML.match(/<select id="loco-filter_position"[\s\S]*?<\/select>/)[0];assert(positions.indexOf('BEH1')<positions.indexOf('BEH2'));assert(positions.indexOf('BEH2')<positions.indexOf('RAT1'));assert(positions.indexOf('RAT2')<positions.indexOf('CLEAN1'));assert(positions.indexOf('SPF2')<positions.indexOf('OTHER1'));assert.deepEqual(dataset,before);
});
