import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../functions/manage-colony-users/handler.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const personId = '44444444-4444-4444-8444-444444444444';
const colony = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const values = {SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public-key', SUPABASE_SERVICE_ROLE_KEY: 'server-secret',
  USER_MANAGEMENT_COLONY_ID: colony, USER_MANAGEMENT_OWNER_EMAIL: 'owner@example.org', USER_MANAGEMENT_APP_URL: 'https://example.org/app/'};
const user = (id, email, extra = {}) => ({id, email, email_confirmed_at: '2026-01-01', user_metadata: {full_name: 'Member', private_field: 'PRIVATE'}, ...extra});
const membership = (id = target, extra = {}) => ({colony_id: colony, user_id: id, role: id === owner ? 'owner' : 'viewer', active: true, export_level: id === owner ? 'max' : 'low', ...extra});
const json = (body, status = 200) => Response.json(body, {status});
const preregistered = (extra = {}) => ({person_id: personId, colony_id: colony, version: 4, name: 'New Member', email: 'new@example.org', status: 'current', archived: false,
  linked_user_id: null, username: null, intended_role: 'editor', export_level: 'high', ...extra});
function fixture(options = {}) {
  const calls = [];
  const members = options.members || [membership(owner), membership()];
  const accounts = options.accounts || [user(owner, 'owner@example.org'), user(target, 'member@example.org')];
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw), path = url.pathname, body = init.body ? JSON.parse(init.body) : null;
    calls.push({url, init, body});
    const overridden = await options.intercept?.({url, init, body, calls});
    if (overridden) return overridden;
    if (path === '/auth/v1/user') return options.identity || json(user(owner, 'owner@example.org'));
    if (path === '/rest/v1/memberships' && url.searchParams.get('select') === 'user_id') {
      assert.equal(init.headers.apikey, values.SUPABASE_SERVICE_ROLE_KEY);assert.equal(init.headers.Authorization, 'Bearer ' + values.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(url.searchParams.get('limit'),'1');const id=url.searchParams.get('user_id')?.slice(3);return json(members.filter(row=>row.user_id===id).slice(0,1).map(row=>({user_id:row.user_id})));
    }
    if (path === '/auth/v1/admin/generate_link') {
      assert.equal(init.headers.apikey, values.SUPABASE_SERVICE_ROLE_KEY);assert.equal(init.headers.Authorization, 'Bearer ' + values.SUPABASE_SERVICE_ROLE_KEY);
      assert.deepEqual(body,{type:'invite',email:'new@example.org',redirect_to:values.USER_MANAGEMENT_APP_URL});assert.equal(url.searchParams.get('redirect_to'),values.USER_MANAGEMENT_APP_URL);
      let account=accounts.find(row=>row.email===body.email);if(!account){account=user(other,body.email,{email_confirmed_at:null});accounts.push(account);}
      return json({...account,action_link:values.SUPABASE_URL+'/auth/v1/verify?token='+('a'.repeat(64))+'&type=invite&redirect_to='+encodeURIComponent(values.USER_MANAGEMENT_APP_URL),hashed_token:'a'.repeat(64),email_otp:'123456',verification_type:'invite',redirect_to:values.USER_MANAGEMENT_APP_URL});
    }
    if (path === '/rest/v1/memberships') {
      assert.equal(init.headers.apikey, values.SUPABASE_ANON_KEY);
      assert.equal(init.headers.Authorization, 'Bearer owner-token');
      assert.equal(url.searchParams.get('colony_id'), 'eq.' + colony);
      const id = url.searchParams.get('user_id')?.slice(3);
      return json(id ? members.filter(row => row.user_id === id && row.colony_id === colony) : members.slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + 500));
    }
    if (path === '/rest/v1/rpc/list_lab_members') {
      assert.equal(init.headers.apikey, values.SUPABASE_ANON_KEY);
      assert.equal(init.headers.Authorization, 'Bearer owner-token');
      assert.deepEqual(body, {p_colony_id: colony});
      return json({members: options.roster || [preregistered()]});
    }
    if (path === '/auth/v1/otp') {
      assert.equal(init.headers.apikey, values.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(init.headers.Authorization, 'Bearer ' + values.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(url.searchParams.get('redirect_to'), values.USER_MANAGEMENT_APP_URL);
      assert.deepEqual(body, {email: 'new@example.org', create_user: false});
      return json({});
    }
    if (path.startsWith('/auth/v1/admin/') || path === '/auth/v1/invite') {
      assert.equal(init.headers.apikey, values.SUPABASE_SERVICE_ROLE_KEY);
      assert.equal(init.headers.Authorization, 'Bearer ' + values.SUPABASE_SERVICE_ROLE_KEY);
      if (path === '/auth/v1/admin/users') {
        const offset = (Number(url.searchParams.get('page')) - 1) * 200;
        return json({users: accounts.slice(offset, offset + 200)});
      }
      if (path.startsWith('/auth/v1/admin/users/')) {
        const account = accounts.find(row => row.id === path.split('/').at(-1));
        return account ? json(account) : json({message: 'missing'}, 404);
      }
      assert.equal(url.searchParams.get('redirect_to'), values.USER_MANAGEMENT_APP_URL);
      assert.deepEqual(body, {email: 'new@example.org'});
      return json(user(other, body.email, {email_confirmed_at: null, invited_at: '2026-01-02'}));
    }
    if (path === '/rest/v1/rpc/manage_colony_member') {
      assert.equal(init.headers.apikey, values.SUPABASE_ANON_KEY);
      assert.equal(init.headers.Authorization, 'Bearer owner-token');
      return json([membership(body.p_user_id, {role: body.p_role, active: body.p_active, export_level:body.p_export_level??members.find(row=>row.user_id===body.p_user_id)?.export_level??'low', permissions:{...Object.fromEntries(['mice','breeding','housing','experiments','cryo','genetics','imports','archive','fees','iacuc'].map(key=>[key,true])),...(body.p_permissions??members.find(row=>row.user_id===body.p_user_id)?.permissions??{})}})]);
    }
    throw new Error('Unexpected route: ' + path);
  };
  const handler = createHandler({env: {get: key => ({...values, ...options.env})[key]}, fetchImpl});
  const request = async (body, headers = {}, method = 'POST') => {
    const response = await handler(new Request('https://example.supabase.co/functions/v1/manage-colony-users', {method,
      headers: {Authorization: 'Bearer owner-token', Origin: 'https://example.org', 'Content-Type': 'application/json', ...headers},
      ...(method === 'OPTIONS' ? {} : {body: typeof body === 'string' ? body : JSON.stringify({colony_id: colony, ...body})})}));
    return {response, data: response.status === 204 ? null : await response.json()};
  };
  return {calls, request};
}
const adminCalls = calls => calls.filter(call => call.url.pathname.includes('/admin/') || /\/(invite|otp)$/.test(call.url.pathname));
const mutations = calls => calls.filter(call => call.init.method === 'POST');
const registrationRequest = {action: 'invite_preregistered', person_id: personId, version: 4};
const emailCalls = calls => calls.filter(call => /\/(invite|otp)$/.test(call.url.pathname));

test('missing/invalid user credentials never reach admin APIs', async () => {
  const a = fixture(); assert.equal((await a.request({action: 'list'}, {Authorization: ''})).response.status, 401); assert.equal(a.calls.length, 0);
  const b = fixture({identity: json({message: 'expired'}, 401)}); assert.equal((await b.request({action: 'list'})).response.status, 403); assert.equal(adminCalls(b.calls).length, 0);
  const c = fixture(); assert.equal((await c.request({action: 'list'}, {Authorization: 'Bearer server-secret'})).response.status, 401); assert.equal(c.calls.length, 0);
});
test('editor, viewer, disabled owner, unknown owner email and unconfirmed account are rejected', async () => {
  for (const row of [membership(owner, {role: 'editor'}), membership(owner, {role: 'manager'}), membership(owner, {role: 'viewer'}), membership(owner, {active: false})]) {
    const f = fixture({members: [row]}); assert.equal((await f.request({action: 'list'})).response.status, 403); assert.equal(adminCalls(f.calls).length, 0);
  }
  for (const identity of [user(owner, 'other@example.org'), user(owner, 'owner@example.org', {email_confirmed_at: null}), user(owner, 'owner@example.org', {is_anonymous: true})]) {
    const f = fixture({identity: json(identity)}); assert.equal((await f.request({action: 'list'})).response.status, 403); assert.equal(adminCalls(f.calls).length, 0);
  }
});
test('cross-colony, redirect injection, owner grants, malformed inputs and cross-origin requests fail closed', async () => {
  const cases = [
    {action: 'list', colony_id: foreign}, {action: 'invite', email: 'new@example.org', role: 'owner'},
    {action: 'invite', email: 'new@example.org', role: 'viewer', redirect: 'https://attacker.example'},
    {action: 'invite', email: 'bad\n@example.org', role: 'viewer'}, {action: 'update_access', user_id: target, role: 'viewer', active: 'true'},
  ];
  for (const body of cases) { const f = fixture(); assert.ok((await f.request(body)).response.status >= 400); assert.equal(f.calls.length, 0); }
  const f = fixture(); const result = await f.request({action: 'list'}, {Origin: 'https://attacker.example'});
  assert.equal(result.response.status, 403); assert.equal(result.response.headers.get('Access-Control-Allow-Origin'), null); assert.equal(f.calls.length, 0);
  const large = fixture(); assert.equal((await large.request(' '.repeat(8193))).response.status, 413); assert.equal(large.calls.length, 0);
});
test('list returns only colony members and allowlisted profile fields with invitation/disabled status', async () => {
  const f = fixture({members: [membership(owner), membership(target, {active: false}), membership(other)], accounts: [user(owner, 'owner@example.org'), user(target, 'member@example.org'), user(other, 'new@example.org', {email_confirmed_at: null, invited_at: '2026-01-02'}), user('44444444-4444-4444-8444-444444444444', 'foreign@example.org')]});
  const {response, data} = await f.request({action: 'list'});
  assert.equal(response.status, 200); assert.equal(data.users.length, 3); assert.equal(data.users[1].status, 'disabled'); assert.equal(data.users[2].status, 'invited');
  assert.deepEqual(Object.keys(data.users[0]).sort(), ['active', 'email', 'export_level', 'name', 'permissions', 'role', 'status', 'user_id']);
  assert.ok(!JSON.stringify(data).includes('PRIVATE')); assert.ok(!JSON.stringify(data).includes('foreign@example.org'));
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://example.org');
});
test('list paginates memberships and preserves unavailable authentication accounts', async () => {
  const members = [membership(owner), ...Array.from({length: 500}, (_, i) => membership(`22222222-2222-4222-8222-${String(i).padStart(12, '0')}`))];
  const f = fixture({members, accounts: [user(owner, 'owner@example.org')]});
  const {data} = await f.request({action: 'list'}); assert.equal(data.users.length, 501); assert.equal(data.users[500].status, 'unavailable');
  assert.ok(f.calls.some(call => call.url.searchParams.get('offset') === '500'));
});
test('all owner rows and self are protected; foreign target cannot gain membership through update', async () => {
  for (const id of [owner, target]) {
    const f = fixture({members: [membership(owner), membership(target, {role: 'owner'})]});
    assert.equal((await f.request({action: 'update_access', user_id: id, role: 'viewer', active: false})).response.status, 403); assert.equal(mutations(f.calls).length, 0);
  }
  const f = fixture(); assert.equal((await f.request({action: 'update_access', user_id: other, role: 'editor', active: true})).response.status, 404); assert.equal(mutations(f.calls).length, 0);
});
test('valid access update uses caller JWT, configured colony and atomic guarded RPC', async () => {
  const f = fixture(); const {data, response} = await f.request({action: 'update_access', user_id: target, role: 'editor', active: false});
  assert.equal(response.status, 200); assert.equal(data.user.role, 'editor'); assert.equal(data.user.active, false);
  assert.deepEqual(mutations(f.calls)[0].body, {p_colony_id: colony, p_user_id: target, p_role: 'editor', p_active: false, p_action: 'update',p_export_level:null,p_permissions:null});
});
test('owner can assign manager flags and Max export independently, and the response verifies each flag', async () => {
  const f = fixture();
  const {data,response}=await f.request({action:'update_access',user_id:target,role:'manager',active:true,export_level:'max',permissions:{experiments:false,fees:false}});
  assert.equal(response.status,200); assert.equal(data.user.role,'manager'); assert.equal(data.user.export_level,'max');
  assert.equal(data.user.permissions.experiments,false); assert.equal(data.user.permissions.fees,false); assert.equal(data.user.permissions.mice,true);
  assert.deepEqual(mutations(f.calls)[0].body.p_permissions,{experiments:false,fees:false});
  const bad=fixture({intercept:({url})=>url.pathname==='/rest/v1/rpc/manage_colony_member'?json([membership(target,{role:'manager',permissions:{mice:true}})]):null});
  assert.equal((await bad.request({action:'update_access',user_id:target,role:'manager',active:true})).response.status,502);
});
test('invalid or privileged manager flags are rejected before any external request',async()=>{
  for(const permissions of [null,[],{owner:true},{accounts:true},{mice:'false'},{mice:null}]){
    const f=fixture(); assert.equal((await f.request({action:'update_access',user_id:target,role:'manager',active:true,permissions})).response.status,400); assert.equal(f.calls.length,0);
  }
});
test('existing Auth account is found beyond first page and added without another invitation email', async () => {
  const accounts = [...Array.from({length: 200}, (_, i) => user(target, `person${i}@example.org`)), user(other, 'new@example.org')];
  const f = fixture({accounts}); const {data, response} = await f.request({action: 'invite', email: ' NEW@example.org ', role: 'viewer'});
  assert.equal(response.status, 200); assert.equal(data.email_sent, false); assert.equal(data.user.user_id, other);
  assert.ok(f.calls.some(call => call.url.searchParams.get('page') === '2')); assert.ok(!f.calls.some(call => call.url.pathname === '/auth/v1/invite'));
});
test('existing member access is never silently changed by invite', async () => {
  const f = fixture(); const {response, data} = await f.request({action: 'invite', email: 'member@example.org', role: 'editor'});
  assert.equal(response.status, 409); assert.equal(data.code, 'already_member'); assert.equal(mutations(f.calls).length, 0);
});
test('new invitation uses configured redirect and service key, then grants membership as caller', async () => {
  const f = fixture(); const {data, response} = await f.request({action: 'invite', email: 'new@example.org', role: 'editor'});
  assert.equal(response.status, 200); assert.equal(data.email_sent, true); assert.equal(data.user.status, 'invited');
  assert.equal(mutations(f.calls).length, 2); assert.equal(mutations(f.calls)[0].url.pathname, '/auth/v1/invite');
  assert.equal(f.calls.filter(call => call.url.pathname === '/rest/v1/memberships' && call.url.searchParams.get('user_id') === 'eq.' + owner).length, 2);
});
test('owner revocation before invitation prevents the email side effect', async () => {
  let checks = 0;
  const f = fixture({intercept: ({url}) => { if (url.pathname === '/rest/v1/memberships' && url.searchParams.get('user_id') === 'eq.' + owner && ++checks === 2) return json([membership(owner, {active: false})]); }});
  assert.equal((await f.request({action: 'invite', email: 'new@example.org', role: 'viewer'})).response.status, 403); assert.equal(mutations(f.calls).length, 0);
});
test('SMTP restriction, rate limits and failures never grant membership or expose upstream content', async () => {
  for (const [status, upstreamCode, expected] of [[400, 'email_address_not_authorized', 'email_delivery_not_configured'], [429, 'over_email_send_rate_limit', 'email_rate_limit'], [400, 'invalid_email', 'invitation_failed'], [500, 'unexpected_failure', 'invitation_outcome_unknown']]) {
    const f = fixture({intercept: ({url}) => url.pathname === '/auth/v1/invite' ? json({code: upstreamCode, message: 'server-secret PRIVATE'}, status) : null});
    const {data} = await f.request({action: 'invite', email: 'new@example.org', role: 'viewer'});
    assert.equal(data.code, expected); assert.equal(mutations(f.calls).length, 1); assert.ok(!JSON.stringify(data).includes('PRIVATE')); assert.ok(!JSON.stringify(data).includes('server-secret'));
  }
});
test('membership rejection after invitation explicitly reports partial success without deleting account', async () => {
  const f = fixture({intercept: ({url}) => url.pathname.endsWith('/manage_colony_member') ? json({code: '42501', message: 'PRIVATE'}, 403) : null});
  const {data, response} = await f.request({action: 'invite', email: 'new@example.org', role: 'viewer'});
  assert.equal(response.status, 403); assert.equal(data.invitation_sent, true); assert.equal(data.code, 'invitation_sent_access_failed'); assert.equal(f.calls.filter(call => call.init.method === 'DELETE').length, 0);
});
test('uncertain invitation outcome is not automatically retried', async () => {
  const f = fixture({intercept: ({url}) => { if (url.pathname === '/auth/v1/invite') throw new Error('timeout SECRET'); }});
  const {data} = await f.request({action: 'invite', email: 'new@example.org', role: 'viewer'});
  assert.equal(data.code, 'invitation_outcome_unknown'); assert.equal(mutations(f.calls).length, 1); assert.ok(!JSON.stringify(data).includes('SECRET'));
});
test('invalid server configuration is closed and normal preflight never touches Auth', async () => {
  const f = fixture({env: {USER_MANAGEMENT_APP_URL: 'https://example.org/app/?next=evil'}});
  assert.equal((await f.request({action: 'list'})).response.status, 503); assert.equal(f.calls.length, 0);
  const g = fixture(); assert.equal((await g.request({}, {}, 'OPTIONS')).response.status, 204); assert.equal(g.calls.length, 0);
});

test('preregistered invitation accepts only person identity and expected version, never browser recipient or privileges', async () => {
  for (const extra of [{email:'attacker@example.org'}, {role:'manager'}, {export_level:'max'}, {permissions:{fees:true}}, {redirect:'https://attacker.example'}, {version:0}, {version:'4'}, {version:1.5}, {person_id:'invalid'}]) {
    const f=fixture(); const result=await f.request({...registrationRequest,...extra});
    assert.equal(result.response.status,400); assert.equal(f.calls.length,0);
  }
  const wrongColony=fixture(); assert.equal((await wrongColony.request({...registrationRequest,colony_id:foreign})).response.status,403); assert.equal(wrongColony.calls.length,0);
});
test('only the verified configured active owner can send preregistration invitations', async () => {
  for (const role of ['viewer','editor','manager']) {
    const f=fixture({members:[membership(owner,{role})]}); assert.equal((await f.request(registrationRequest)).response.status,403); assert.equal(adminCalls(f.calls).length,0);
  }
  for (const identity of [user(owner,'someone@example.org'),user(owner,'owner@example.org',{email_confirmed_at:null})]) {
    const f=fixture({identity:json(identity)}); assert.equal((await f.request(registrationRequest)).response.status,403); assert.equal(adminCalls(f.calls).length,0);
  }
});
test('current eligible preregistration sends one invite without granting membership or changing the roster', async () => {
  const f=fixture(); const {data,response}=await f.request(registrationRequest);
  assert.equal(response.status,200); assert.equal(data.person_id,personId); assert.equal(data.email_sent,true); assert.equal(data.email_kind,'invitation');
  assert.match(data.message,/Email request accepted/); assert.equal(emailCalls(f.calls).length,1);
  assert.equal(f.calls.filter(c=>c.url.pathname.endsWith('/list_lab_members')).length,3);
  assert.equal(f.calls.filter(c=>c.url.pathname==='/rest/v1/memberships'&&c.url.searchParams.get('user_id')==='eq.'+owner).length,2);
  assert(!f.calls.some(c=>/manage_colony_member|save_lab_member|complete_lab_member_setup/.test(c.url.pathname)));
  assert.deepEqual(Object.keys(data).sort(),['delivery_confirmed','delivery_status','email_kind','email_sent','message','person_id','registration_status']);assert.equal(data.delivery_status,'accepted');assert.equal(data.delivery_confirmed,false);assert.equal(data.registration_status,'verified');
});
test('unclaimed unconfirmed accounts receive a repeat invite, while confirmed accounts receive an existing-only setup link', async () => {
  for(const confirmed of [false,true]) {
    const f=fixture({accounts:[user(owner,'owner@example.org'),user(other,'new@example.org',{email_confirmed_at:confirmed?'2026-01-01':null,invited_at:'2026-01-02'})]});
    const {data,response}=await f.request(registrationRequest); assert.equal(response.status,200); assert.equal(data.email_sent,true);
    assert.equal(data.email_kind,confirmed?'sign_in_link':'invitation'); assert.equal(emailCalls(f.calls)[0].url.pathname,confirmed?'/auth/v1/otp':'/auth/v1/invite');
    assert(!f.calls.some(c=>c.url.pathname.endsWith('/manage_colony_member')));
  }
});
test('preregistration must be current, nonarchived, unclaimed, version-matched, in-colony and have a valid nonowner email', async () => {
  for(const [change,code] of [[{status:'historical'},'preregistration_inactive'],[{status:'review'},'preregistration_inactive'],[{archived:true},'preregistration_inactive'],[{linked_user_id:other,username:'member'},'registration_complete'],[{version:5},'preregistration_changed'],[{email:null},'registration_email_required'],[{email:'bad@example'},'registration_email_required'],[{email:'owner@example.org'},'owner_protected'],[{effective_role:'owner'},'owner_protected'],[{colony_id:foreign},'preregistration_not_found']]) {
    const f=fixture({roster:[preregistered(change)]}); const {data,response}=await f.request(registrationRequest);
    assert(response.status>=400); assert.equal(data.code,code); assert.equal(adminCalls(f.calls).length,0);
  }
});
test('registered, disabled, banned and recently invited accounts are not enabled or emailed by preregistration', async () => {
  for(const active of [false,true]) {
    const f=fixture({members:[membership(owner),membership(other,{active})],accounts:[user(other,'new@example.org')]});
    assert.equal((await f.request(registrationRequest)).data.code,'already_member'); assert.equal(emailCalls(f.calls).length,0);
  }
  const banned=fixture({accounts:[user(other,'new@example.org',{banned_until:'2999-01-01'})]}); assert.equal((await banned.request(registrationRequest)).data.code,'account_disabled'); assert.equal(emailCalls(banned.calls).length,0);
  for(const field of ['invited_at','confirmation_sent_at','recovery_sent_at']) {
    const f=fixture({accounts:[user(other,'new@example.org',{[field]:new Date().toISOString()})]});
    const {response,data}=await f.request(registrationRequest); assert.equal(response.status,429); assert.equal(data.code,'email_rate_limit'); assert(data.retry_after_seconds>0&&data.retry_after_seconds<=60); assert.equal(emailCalls(f.calls).length,0);
  }
});
test('owner or roster change before send prevents sending; post-send roster failure reports accepted email without falsely granting access', async () => {
  let ownerChecks=0;
  const revoked=fixture({intercept:({url})=>url.pathname==='/rest/v1/memberships'&&url.searchParams.get('user_id')==='eq.'+owner&&++ownerChecks===2?json([membership(owner,{active:false})]):null});
  assert.equal((await revoked.request(registrationRequest)).data.code,'owner_required'); assert.equal(emailCalls(revoked.calls).length,0);
  for(const when of [2,3]) {
    let rosterChecks=0;
    const f=fixture({intercept:({url})=>url.pathname.endsWith('/list_lab_members')&&++rosterChecks===when?json({members:[preregistered({version:5,status:'historical'})]}):null});
    const {data}=await f.request(registrationRequest); assert.equal(emailCalls(f.calls).length,when===3?1:0);
    assert.equal(data.code,when===3?undefined:'preregistration_changed');
    if(when===3){assert.equal(data.delivery_status,'accepted');assert.equal(data.delivery_confirmed,false);assert.equal(data.registration_status,'changed');assert.match(data.warning,/Refresh Members/);}else assert.equal(data.invitation_sent,undefined); assert(!f.calls.some(c=>c.url.pathname.endsWith('/manage_colony_member')));
  }
});
test('registration email errors, timeouts and malformed successes are truthful, sanitized and never retried', async () => {
  for(const [status,code,expected] of [[400,'email_address_not_authorized','email_delivery_not_configured'],[429,'over_email_send_rate_limit','email_rate_limit'],[422,'email_exists','account_changed'],[400,'invalid_email','invitation_failed'],[500,'unexpected_failure','invitation_outcome_unknown'],[200,'bad','invitation_outcome_unknown']]) {
    const f=fixture({intercept:({url})=>url.pathname==='/auth/v1/invite'?json({code,message:'server-secret PRIVATE'},status):null});
    const {data}=await f.request(registrationRequest); assert.equal(data.code,expected); assert.equal(emailCalls(f.calls).length,1); assert(!JSON.stringify(data).includes('PRIVATE')); assert(!JSON.stringify(data).includes('server-secret'));
  }
  const timeout=fixture({intercept:({url})=>{if(url.pathname==='/auth/v1/invite')throw new Error('SECRET');}});
  const result=await timeout.request(registrationRequest); assert.equal(result.data.code,'invitation_outcome_unknown'); assert.equal(emailCalls(timeout.calls).length,1); assert(!JSON.stringify(result.data).includes('SECRET'));
});

test('export level is independent of read/write access, defaults low for invitations and is verified',async()=>{
  const f=fixture({members:[membership(owner),membership(target,{export_level:'high'})]});
  const preserved=await f.request({action:'update_access',user_id:target,role:'viewer',active:false});assert.equal(preserved.data.user.export_level,'high');
  const changed=await f.request({action:'update_access',user_id:target,role:'editor',active:true,export_level:'max'});assert.equal(changed.data.user.export_level,'max');
  const invite=fixture();assert.equal((await invite.request({action:'invite',email:'new@example.org',role:'editor'})).data.user.export_level,'low');
  assert.equal(mutations(invite.calls).at(-1).body.p_export_level,'low');
  for(const invalid of [null,'owner','all',true,{},1]){const bad=fixture();assert.equal((await bad.request({action:'update_access',user_id:target,role:'viewer',active:true,export_level:invalid})).response.status,400);assert.equal(bad.calls.length,0);}
  const mismatch=fixture({intercept:({url})=>url.pathname.endsWith('/manage_colony_member')?json([membership(target,{export_level:'low'})]):null});
  assert.equal((await mismatch.request({action:'update_access',user_id:target,role:'viewer',active:true,export_level:'high'})).data.code,'membership_outcome_unknown');
});

test('SQL enforces role/colony/owner protections atomically and retains audit actor', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;`);
    await db.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../functions/manage-colony-users/membership.sql', import.meta.url), 'utf8'));
    for (const id of [owner, target, other]) await db.query('insert into auth.users values($1)', [id]);
    await db.query('insert into public.colonies(id,name,created_by) values($1,$2,$3),($4,$5,$6)', [colony, 'Lab', owner, foreign, 'Other lab', other]);
    for (const [c, id, role] of [[colony, owner, 'owner'], [colony, target, 'viewer'], [foreign, other, 'owner']]) await db.query('insert into public.memberships(colony_id,user_id,role) values($1,$2,$3)', [c, id, role]);
    const as = async (id, fn, role = 'authenticated') => { await db.exec('set role ' + role); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); try { return await fn(); } finally { await db.exec('reset role'); } };
    const save = (id, role = 'editor', active = true, action = 'update', c = colony) => db.query('select * from public.manage_colony_member($1,$2,$3,$4,$5)', [c, id, role, active, action]);
    const denied = (fn, code) => assert.rejects(fn, error => error.code === code);
    await as('', () => denied(() => save(target), '42501'), 'anon');
    await as(target, () => denied(() => save(target), '42501'));
    await as(other, () => denied(() => save(target), '42501'));
    await as(owner, async () => {
      await denied(() => save(owner, 'viewer', false), '42501');
      await denied(() => save(target, 'owner'), '22023');
      await denied(() => save(other), 'P0002');
      await denied(() => save(target, 'editor', true, 'add'), '23505');
      assert.equal((await save(target)).rows[0].role, 'editor');
      assert.equal((await save(other, 'viewer', true, 'add')).rows[0].role, 'viewer');
    });
    // A target promoted after the Edge precheck remains protected at mutation time,
    // even when the colony has another owner (the legacy last-owner guard alone is insufficient).
    await db.query("update public.memberships set role='owner' where colony_id=$1 and user_id=$2", [colony, other]);
    await as(owner, () => denied(() => save(other, 'viewer', false), '42501'));
    await db.query('update public.memberships set active=false where colony_id=$1 and user_id=$2', [colony, owner]);
    await as(owner, () => denied(() => save(target), '42501'));
    const audits = (await db.query("select actor_id from public.audit_log where entity_type='membership'")).rows;
    assert.equal(audits.length, 2); assert.ok(audits.every(row => row.actor_id === owner));
    assert.equal((await db.query('select role from public.memberships where colony_id=$1 and user_id=$2', [foreign, other])).rows[0].role, 'owner');
    const acl = (await db.query("select prosecdef,proconfig from pg_proc where proname='manage_colony_member'")).rows[0];
    assert.equal(acl.prosecdef, true); assert.ok(acl.proconfig.some(value => value.startsWith('search_path=')));
  } finally { await db.close(); }
});


const manualRequest={action:'create_preregistered_link',person_id:personId,version:4};
const generateCalls=calls=>calls.filter(call=>call.url.pathname==='/auth/v1/admin/generate_link');
const validGenerated=(change={})=>({...user(other,'new@example.org',{email_confirmed_at:null}),action_link:values.SUPABASE_URL+'/auth/v1/verify?token='+('a'.repeat(64))+'&type=invite&redirect_to='+encodeURIComponent(values.USER_MANAGEMENT_APP_URL),hashed_token:'a'.repeat(64),email_otp:'123456',verification_type:'invite',redirect_to:values.USER_MANAGEMENT_APP_URL,...change});

test('manual setup links generate invite only, send no email, change no privileges and return no unrelated secrets',async()=>{
 for(const existing of [false,true]){
  const f=fixture({accounts:[user(owner,'owner@example.org'),...(existing?[user(other,'new@example.org',{email_confirmed_at:null,invited_at:new Date().toISOString()})]:[])]});const {response,data}=await f.request(manualRequest);
  assert.equal(response.status,200);assert.equal(data.person_id,personId);assert.equal(data.link_kind,'invitation');assert.equal(data.expires_at,null);assert.equal(data.email_sent,false);assert.equal(data.delivery_status,'not_sent');assert.equal(data.delivery_confirmed,false);assert.equal(new URL(data.invitation_link).searchParams.get('type'),'invite');assert.equal(new URL(data.invitation_link).searchParams.get('redirect_to'),values.USER_MANAGEMENT_APP_URL);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(generateCalls(f.calls).length,1);assert.equal(emailCalls(f.calls).length,0);assert(!f.calls.some(c=>/manage_colony_member|save_lab_member|complete_lab_member_setup/.test(c.url.pathname)));assert(!JSON.stringify(data).includes('PRIVATE'));assert(!JSON.stringify(data).includes('123456'));assert(!JSON.stringify(data).includes('server-secret'));assert(!Object.hasOwn(data,'user'));assert(!Object.hasOwn(data,'hashed_token'));
 }
});

test('manual link action rejects target/redirect/role tampering, nonowners and ineligible existing accounts before minting',async()=>{
 for(const change of [{email:'other@example.org'},{redirect_to:'https://evil.example'},{role:'manager'},{password:'No'},{version:3},{version:0},{person_id:'bad'}]){const f=fixture();const r=await f.request({...manualRequest,...change});assert(r.response.status>=400);assert.equal(generateCalls(f.calls).length,0);}
 for(const role of ['manager','editor','viewer']){const f=fixture({members:[membership(owner,{role})]});assert.equal((await f.request(manualRequest)).response.status,403);assert.equal(generateCalls(f.calls).length,0);}
 for(const change of [{email_confirmed_at:'2026-01-01'},{email_confirmed_at:null,is_sso_user:true},{email_confirmed_at:null,banned_until:'2999-01-01'}]){const f=fixture({accounts:[user(other,'new@example.org',change)]});const r=await f.request(manualRequest);assert.equal(r.response.status,409);assert.equal(generateCalls(f.calls).length,0);assert.equal(emailCalls(f.calls).length,0);assert.equal(r.data.invitation_link,undefined);}
 for(const row of [membership(other),membership(other,{active:false}),membership(other,{colony_id:foreign})]){const f=fixture({members:[membership(owner),row],accounts:[user(other,'new@example.org',{email_confirmed_at:null})]});assert.equal((await f.request(manualRequest)).response.status,409);assert.equal(generateCalls(f.calls).length,0);}
 for(const change of [{status:'historical'},{archived:true},{linked_user_id:other,username:'claimed'},{email:'owner@example.org'}]){const f=fixture({roster:[preregistered(change)]});assert((await f.request(manualRequest)).response.status>=400);assert.equal(generateCalls(f.calls).length,0);}
});

test('manual links reject every untrusted URL shape, mismatched identity/type/token and malformed success without exposing link or OTP',async()=>{
 const valid=validGenerated();
 const cases=[{action_link:valid.action_link.replace('example.supabase.co','evil.example')},{action_link:valid.action_link.replace('/auth/v1/verify','/x/../auth/v1/verify')},{action_link:valid.action_link.replace('https:','http:')},{action_link:valid.action_link+'#secret'},{action_link:valid.action_link+'&extra=1'},{action_link:valid.action_link+'&token='+('b'.repeat(64))},{action_link:valid.action_link.replace('type=invite','type=magiclink')},{action_link:valid.action_link.replace(encodeURIComponent(values.USER_MANAGEMENT_APP_URL),encodeURIComponent('https://evil.example/'))},{action_link:valid.action_link.replace('token='+('a'.repeat(64)),'token=short')},{hashed_token:'b'.repeat(64)},{verification_type:'magiclink'},{redirect_to:'https://evil.example/'},{email:'other@example.org'},{id:owner},{action_link:null}];
 for(const change of cases){const f=fixture({accounts:[user(other,'new@example.org',{email_confirmed_at:null})],intercept:({url})=>url.pathname==='/auth/v1/admin/generate_link'?json(validGenerated(change)):null});const {response,data}=await f.request(manualRequest);assert(response.status>=400);assert.equal(data.invitation_link,undefined);assert.equal(data.email_sent,false);assert(!JSON.stringify(data).includes('123456'));assert(!JSON.stringify(data).includes('a'.repeat(64)));assert.equal(generateCalls(f.calls).length,1);assert.equal(emailCalls(f.calls).length,0);}
});

test('manual links fail closed when owner, roster, target account or any-colony membership changes after generation',async()=>{
 for(const kind of ['owner','roster','profile','membership','identity']){
  let generated=false;const f=fixture({accounts:[user(owner,'owner@example.org'),user(other,'new@example.org',{email_confirmed_at:null})],intercept:({url})=>{
   if(url.pathname==='/auth/v1/admin/generate_link'){generated=true;return json(validGenerated());}
   if(!generated)return null;
   if(kind==='owner'&&url.pathname==='/rest/v1/memberships'&&url.searchParams.get('user_id')==='eq.'+owner)return json([membership(owner,{active:false})]);
   if(kind==='roster'&&url.pathname.endsWith('/list_lab_members'))return json({members:[preregistered({version:5,status:'historical'})]});
   if(kind==='profile'&&url.pathname==='/auth/v1/admin/users/'+other)return json(user(other,'new@example.org',{email_confirmed_at:null,banned_until:'2999-01-01'}));
   if(kind==='membership'&&url.pathname==='/rest/v1/memberships'&&url.searchParams.get('select')==='user_id')return json([{user_id:other}]);
   if(kind==='identity'&&url.pathname==='/auth/v1/user')return json(user(owner,'changed@example.org'));
   return null;
  }});const r=await f.request(manualRequest);assert(r.response.status>=400,kind);assert.equal(r.data.invitation_link,undefined);assert(!JSON.stringify(r.data).includes('a'.repeat(64)));assert.equal(generateCalls(f.calls).length,1);assert.equal(emailCalls(f.calls).length,0);
 }
});

test('accepted email remains accepted after a transient roster recheck, while timeout remains unknown',async()=>{
 let count=0;const f=fixture({intercept:({url})=>url.pathname.endsWith('/list_lab_members')&&++count===3?json({message:'PRIVATE'},503):null});const r=await f.request(registrationRequest);assert.equal(r.response.status,200);assert.equal(r.data.delivery_status,'accepted');assert.equal(r.data.delivery_confirmed,false);assert.equal(r.data.registration_status,'unverified');assert.match(r.data.warning,/Refresh Members/);assert.equal(emailCalls(f.calls).length,1);
 const g=fixture({intercept:({url})=>{if(url.pathname==='/auth/v1/invite')throw Error('PRIVATE');}}),unknown=await g.request(registrationRequest);assert.equal(unknown.data.delivery_status,'unknown');assert.equal(unknown.data.delivery_confirmed,false);assert.equal(emailCalls(g.calls).length,1);
 const h=fixture({intercept:({url})=>{if(url.pathname==='/auth/v1/admin/generate_link')throw Error('PRIVATE');}}),manual=await h.request(manualRequest);assert.equal(manual.data.delivery_status,'not_sent');assert.equal(manual.data.email_sent,false);assert.equal(manual.data.invitation_link,undefined);assert.equal(generateCalls(h.calls).length,1);assert.equal(emailCalls(h.calls).length,0);
});

test('post-send authorization denial preserves acceptance but explicitly tells the client to clear private state',async()=>{
  for(const status of [401,403]) {
    let reads=0;
    const f=fixture({intercept:({url})=>url.pathname==='/rest/v1/rpc/list_lab_members'&&++reads===3?json({code:'42501'},status):null});
    const {response,data}=await f.request(registrationRequest);
    assert.equal(response.status,200);assert.equal(data.delivery_status,'accepted');assert.equal(data.delivery_confirmed,false);assert.equal(data.access_revoked,true);assert.equal(data.registration_status,'unverified');assert.match(data.warning,/Sign in again/);assert.equal(emailCalls(f.calls).length,1);
  }
  let reads=0;
  const changed=fixture({intercept:({url})=>url.pathname==='/rest/v1/rpc/list_lab_members'&&++reads===3?json({members:[preregistered({effective_role:'owner'})]}):null});
  const {data}=await changed.request(registrationRequest);assert.equal(data.registration_status,'changed');assert.equal(data.access_revoked,undefined);
  const denied=fixture({intercept:({url})=>url.pathname==='/rest/v1/rpc/list_lab_members'?json({code:'42501'},403):null});
  assert.equal((await denied.request(registrationRequest)).response.status,403);assert.equal(emailCalls(denied.calls).length,0);
});
