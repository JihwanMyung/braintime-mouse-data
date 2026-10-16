import test from 'node:test';
import assert from 'node:assert/strict';
import {MANAGER_PERMISSION_LABELS,defaultManagerPermissions,normalizeManagerPermissions,validateManagerPermissions,canViewBrainbot,canViewSourceArchive,canManageBrainbot,visibleRoleLabel} from '../web/permissions.js';

test('manager defaults cover only approved record capabilities, including fees',()=>{
 assert.deepEqual(Object.keys(MANAGER_PERMISSION_LABELS),['mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees','iacuc']);const first=defaultManagerPermissions(),second=defaultManagerPermissions();first.fees=false;assert.equal(second.fees,true);assert(Object.values(second).every(v=>v===true));for(const ownerOnly of ['users','permissions','roster','settings'])assert.equal(Object.hasOwn(second,ownerOnly),false);
});

test('normalization preserves explicit denials, fills legacy defaults, and never treats strings as grants',()=>{
 const p=normalizeManagerPermissions({mice:false,experiments:true,fees:'true',owner:true});assert.equal(p.mice,false);assert.equal(p.experiments,true);assert.equal(p.fees,false);assert.equal(p.housing,true);assert.equal(Object.hasOwn(p,'owner'),false);assert.deepEqual(normalizeManagerPermissions(null),defaultManagerPermissions());assert.equal(validateManagerPermissions({mice:false,fees:true}).length,0);assert.equal(validateManagerPermissions({owner:true}).length,1);assert.equal(validateManagerPermissions({fees:'yes'}).length,1);assert.equal(validateManagerPermissions([]).length,1);
});

test('monitoring and source archive visibility keep role and export permissions distinct',()=>{
 for(const role of ['owner','manager','editor','viewer'])for(const exportLevel of ['low','high','max',null]){
  const s={mode:'cloud',signedIn:true,passwordRecovery:false,setupRequired:false,role,exportLevel};
  assert.equal(canViewBrainbot(s),['owner','manager'].includes(role)||['high','max'].includes(exportLevel),`${role}/${exportLevel} bot`);
  assert.equal(canViewSourceArchive(s),['owner','manager'].includes(role),`${role}/${exportLevel} archive`);
  assert.equal(canManageBrainbot(s),role==='owner',`${role}/${exportLevel} actions`);
 }
});

test('local, unsigned, recovery, pending or malformed access status never opens protected tools',()=>{
 const base={mode:'cloud',signedIn:true,passwordRecovery:false,setupRequired:false,role:'owner',exportLevel:'max'};
 for(const patch of [{mode:'local'},{mode:'backup'},{mode:undefined},{signedIn:false},{signedIn:'true'},{passwordRecovery:true},{passwordRecovery:'false'},{setupRequired:true},{setupRequired:'false'},{role:'pending'},{role:'unknown'},{role:null}])for(const check of [canViewBrainbot,canViewSourceArchive,canManageBrainbot])assert.equal(check({...base,...patch}),false,JSON.stringify(patch));
 for(const s of [null,undefined,{},false])for(const check of [canViewBrainbot,canViewSourceArchive,canManageBrainbot])assert.equal(check(s),false);
 assert.equal(canViewBrainbot({...base,role:'viewer',exportLevel:'HIGH'}),false);
});

test('visible roles show only Owner and Manager, never internal history levels',()=>{
 assert.equal(visibleRoleLabel('owner'),'Owner');assert.equal(visibleRoleLabel('manager'),'Manager');
 for(const role of ['editor','viewer','pending','high','low','max',null,undefined,'Owner'])assert.equal(visibleRoleLabel(role),'');
});
