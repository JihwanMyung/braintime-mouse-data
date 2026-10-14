import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../functions/manage-colony-users/handler.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const colony = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const values = {SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public-key', SUPABASE_SERVICE_ROLE_KEY: 'server-secret',
  USER_MANAGEMENT_COLONY_ID: colony, USER_MANAGEMENT_OWNER_EMAIL: 'owner@example.org', USER_MANAGEMENT_APP_URL: 'https://example.org/app/'};
const user = (id, email, extra = {}) => ({id, email, email_confirmed_at: '2026-01-01', user_metadata: {full_name: 'Member', private_field: 'PRIVATE'}, ...extra});
const membership = (id = target, extra = {}) => ({colony_id: colony, user_id: id, role: id === owner ? 'owner' : 'viewer', active: true, export_level: id === owner ? 'max' : 'low', ...extra});
const json = (body, status = 200) => Response.json(body, {status});
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
    if (path === '/rest/v1/memberships') {
      assert.equal(init.headers.apikey, values.SUPABASE_ANON_KEY);
      assert.equal(init.headers.Authorization, 'Bearer owner-token');
      assert.equal(url.searchParams.get('colony_id'), 'eq.' + colony);
      const id = url.searchParams.get('user_id')?.slice(3);
      return json(id ? members.filter(row => row.user_id === id) : members.slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + 500));
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
      return json([membership(body.p_user_id, {role: body.p_role, active: body.p_active, export_level:body.p_export_level??members.find(row=>row.user_id===body.p_user_id)?.export_level??'low'})]);
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
const adminCalls = calls => calls.filter(call => call.url.pathname.includes('/admin/') || call.url.pathname.endsWith('/invite'));
const mutations = calls => calls.filter(call => call.init.method === 'POST');

test('missing/invalid user credentials never reach admin APIs', async () => {
  const a = fixture(); assert.equal((await a.request({action: 'list'}, {Authorization: ''})).response.status, 401); assert.equal(a.calls.length, 0);
  const b = fixture({identity: json({message: 'expired'}, 401)}); assert.equal((await b.request({action: 'list'})).response.status, 403); assert.equal(adminCalls(b.calls).length, 0);
  const c = fixture(); assert.equal((await c.request({action: 'list'}, {Authorization: 'Bearer server-secret'})).response.status, 401); assert.equal(c.calls.length, 0);
});
test('editor, viewer, disabled owner, unknown owner email and unconfirmed account are rejected', async () => {
  for (const row of [membership(owner, {role: 'editor'}), membership(owner, {role: 'viewer'}), membership(owner, {active: false})]) {
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
  assert.deepEqual(Object.keys(data.users[0]).sort(), ['active', 'email', 'export_level', 'name', 'role', 'status', 'user_id']);
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
  assert.deepEqual(mutations(f.calls)[0].body, {p_colony_id: colony, p_user_id: target, p_role: 'editor', p_active: false, p_action: 'update',p_export_level:null});
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
