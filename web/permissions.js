/* Owner-configured manager capabilities. Export history remains independent. */
export const MANAGER_PERMISSION_LABELS=Object.freeze({mice:'Mice',breeding:'Breeding & litters',housing:'Rooms, racks & cages',experiments:'Experiments & samples',cryo:'Cryopreservation',genetics:'Genotypes & breeding design',imports:'Import data',archive:'Archive records',fees:'Fees & billing',iacuc:'IACUC protocols & animal use'});
export function defaultManagerPermissions(){return Object.fromEntries(Object.keys(MANAGER_PERMISSION_LABELS).map(key=>[key,true]))}
export function normalizeManagerPermissions(value){const supplied=value!==null&&typeof value==='object'&&!Array.isArray(value)?value:{};return Object.fromEntries(Object.keys(MANAGER_PERMISSION_LABELS).map(key=>[key,Object.hasOwn(supplied,key)?supplied[key]===true:true]))}
export function validateManagerPermissions(value){if(value===null||typeof value!=='object'||Array.isArray(value))return ['Manager permissions must be an object.'];const errors=[];for(const [key,allowed] of Object.entries(value)){if(!Object.hasOwn(MANAGER_PERMISSION_LABELS,key))errors.push('Unknown manager permission: '+key);else if(typeof allowed!=='boolean')errors.push('Manager permission '+key+' must be true or false.')}return errors}
const verifiedCloud=status=>status?.mode==='cloud'&&status.signedIn===true&&['owner','manager','editor','viewer'].includes(status.role)&&[undefined,false].includes(status.passwordRecovery)&&[undefined,false].includes(status.setupRequired);
export function canViewBrainbot(status){return verifiedCloud(status)&&(['owner','manager'].includes(status.role)||['high','max'].includes(status.exportLevel));}
export function canViewSourceArchive(status){return verifiedCloud(status)&&['owner','manager'].includes(status.role);}
export function canManageBrainbot(status){return verifiedCloud(status)&&status.role==='owner';}
export function visibleRoleLabel(role){return role==='owner'?'Owner':role==='manager'?'Manager':'';}
