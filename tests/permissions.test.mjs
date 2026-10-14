import test from 'node:test';
import assert from 'node:assert/strict';
import {MANAGER_PERMISSION_LABELS,defaultManagerPermissions,normalizeManagerPermissions,validateManagerPermissions} from '../web/permissions.js';

test('manager defaults cover only approved record capabilities, including fees',()=>{
 assert.deepEqual(Object.keys(MANAGER_PERMISSION_LABELS),['mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees']);const first=defaultManagerPermissions(),second=defaultManagerPermissions();first.fees=false;assert.equal(second.fees,true);assert(Object.values(second).every(v=>v===true));for(const ownerOnly of ['users','permissions','roster','settings'])assert.equal(Object.hasOwn(second,ownerOnly),false);
});

test('normalization preserves explicit denials, fills legacy defaults, and never treats strings as grants',()=>{
 const p=normalizeManagerPermissions({mice:false,experiments:true,fees:'true',owner:true});assert.equal(p.mice,false);assert.equal(p.experiments,true);assert.equal(p.fees,false);assert.equal(p.housing,true);assert.equal(Object.hasOwn(p,'owner'),false);assert.deepEqual(normalizeManagerPermissions(null),defaultManagerPermissions());assert.equal(validateManagerPermissions({mice:false,fees:true}).length,0);assert.equal(validateManagerPermissions({owner:true}).length,1);assert.equal(validateManagerPermissions({fees:'yes'}).length,1);assert.equal(validateManagerPermissions([]).length,1);
});
