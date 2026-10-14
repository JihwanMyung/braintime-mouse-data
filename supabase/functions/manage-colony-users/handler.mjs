// Native-fetch handler. Admin credentials stay inside the Edge runtime.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPORT_LEVELS = ['low', 'high', 'max'];
const PERMISSIONS = ['mice', 'breeding', 'housing', 'experiments', 'cryo', 'genetics', 'imports', 'archive', 'fees', 'iacuc'];
const validPermissions = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.entries(value).every(([key, allowed]) => PERMISSIONS.includes(key) && typeof allowed === 'boolean');
const normalizedPermissions = value => Object.fromEntries(PERMISSIONS.map(key => [key, Object.hasOwn(value || {}, key) ? value[key] === true : true]));
const emailValue = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => value.length <= 254 && /^[^\s<>\x00-\x1f@]+@[^\s<>\x00-\x1f@]+\.[^\s<>\x00-\x1f@]+$/.test(value);
class Failure extends Error {
  constructor(status, code, message, extra = {}) { super(message); Object.assign(this, {status, code, extra}); }
}
const fail = (status, code, message, extra) => { throw new Failure(status, code, message, extra); };

function configuration(env) {
  const read = name => { const value = env.get(name)?.trim(); if (!value) throw new Error('Missing configuration'); return value; };
  const base = new URL(read('SUPABASE_URL'));
  const app = new URL(read('USER_MANAGEMENT_APP_URL'));
  const colonyId = read('USER_MANAGEMENT_COLONY_ID');
  const ownerEmail = emailValue(read('USER_MANAGEMENT_OWNER_EMAIL'));
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname) ||
      app.protocol !== 'https:' || app.username || app.password || app.search || app.hash ||
      !UUID.test(colonyId) || !validEmail(ownerEmail)) throw new Error('Invalid configuration');
  return {base: base.origin, appUrl: app.href, origin: app.origin, colonyId, ownerEmail,
    publicKey: read('SUPABASE_ANON_KEY'), serviceKey: read('SUPABASE_SERVICE_ROLE_KEY')};
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'json_required', 'Send a JSON request.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_request', 'A request body is required.');
  let size = 0; const chunks = [];
  while (true) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); fail(413, 'request_too_large', 'The request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const value = JSON.parse(new TextDecoder().decode(bytes)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { fail(400, 'invalid_request', 'The request must be a JSON object.'); }
}

function validate(body, config) {
  const fields = {list: [], invite: ['email', 'role', 'export_level', 'permissions'], invite_preregistered: ['person_id', 'version'], update_access: ['user_id', 'role', 'active', 'export_level', 'permissions']};
  if (!Object.hasOwn(fields, body.action)) fail(400, 'invalid_action', 'Choose list, invite, invite_preregistered, or update_access.');
  const allowed = new Set(['action', 'colony_id', ...fields[body.action]]);
  if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'invalid_request', 'The request contains unsupported fields.');
  if (body.colony_id !== config.colonyId) fail(403, 'wrong_colony', 'This endpoint manages only its configured colony.');
  if (['invite', 'update_access'].includes(body.action) && !['viewer', 'editor', 'manager'].includes(body.role)) fail(400, 'invalid_role', 'Access must be viewer, editor, or manager.');
  if (body.export_level !== undefined && !EXPORT_LEVELS.includes(body.export_level)) fail(400, 'invalid_export_level', 'Export permission must be low, high, or max.');
  if (body.permissions !== undefined && !validPermissions(body.permissions)) fail(400, 'invalid_permissions', 'Manager permissions must contain only known boolean flags.');
  if (body.action === 'invite') {
    body.email = emailValue(body.email);
    if (!validEmail(body.email)) fail(400, 'invalid_email', 'Enter a valid email address.');
    if (body.email === config.ownerEmail) fail(403, 'owner_protected', 'The original owner account is protected.');
  }
  if (body.action === 'update_access' && (!UUID.test(body.user_id || '') || typeof body.active !== 'boolean')) fail(400, 'invalid_request', 'A user ID, access role, and active flag are required.');
  if (body.action === 'invite_preregistered' && (!UUID.test(body.person_id || '') || !Number.isInteger(body.version) || body.version < 1 || body.version > 2147483647)) fail(400, 'invalid_request', 'A preregistered person ID and current record version are required.');
}

export function createHandler({env, fetchImpl = fetch}) {
  return async request => {
    let config;
    try { config = configuration(env); }
    catch { return Response.json({code: 'not_configured', message: 'User management is not configured on the server.'}, {status: 503, headers: {'Cache-Control': 'no-store'}}); }
    const origin = request.headers.get('origin');
    const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin'};
    if (origin === config.origin) Object.assign(headers, {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info'});
    const reply = (body, status = 200) => Response.json(body, {status, headers});
    if (origin && origin !== config.origin) return reply({code: 'origin_denied', message: 'Open user management from the configured application.'}, 403);
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
    if (request.method !== 'POST') return reply({code: 'method_not_allowed', message: 'Use POST.'}, 405);

    try {
      const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') || '')?.[1];
      if (!token || token.length > 16000 || token === config.serviceKey) fail(401, 'sign_in_required', 'Sign in with your owner account.');
      const body = await readBody(request); validate(body, config);
      const call = async (path, {admin = false, method = 'GET', payload} = {}) => {
        const key = admin ? config.serviceKey : config.publicKey;
        let response;
        try {
          response = await fetchImpl(config.base + path, {method, headers: {apikey: key, Authorization: 'Bearer ' + (admin ? key : token), 'Content-Type': 'application/json'},
            ...(payload === undefined ? {} : {body: JSON.stringify(payload)}), signal: AbortSignal.timeout(15000)});
        } catch { fail(502, 'upstream_unavailable', 'The authentication or membership service could not be reached. Reload the user list before trying again.'); }
        let data = null; try { data = await response.json(); } catch { /* Do not expose upstream response bodies. */ }
        return {ok: response.ok, status: response.status, data};
      };
      const identity = await call('/auth/v1/user');
      const actor = identity.data;
      if (!identity.ok || !UUID.test(actor?.id || '') || actor?.is_anonymous || !actor?.email_confirmed_at || emailValue(actor?.email) !== config.ownerEmail) fail(403, 'owner_required', 'Only the configured owner can manage colony users.');
      const membershipPath = '/rest/v1/memberships?select=colony_id,user_id,role,active,export_level,permissions&colony_id=eq.' + config.colonyId;
      const assertOwner = async () => {
        const result = await call(membershipPath + '&user_id=eq.' + actor.id);
        if (!result.ok) fail(result.status === 401 ? 401 : 503, 'membership_check_failed', 'Owner access could not be verified. Sign in again and retry.');
        if (!Array.isArray(result.data) || result.data.length !== 1 || result.data[0].colony_id !== config.colonyId || result.data[0].user_id !== actor.id || result.data[0].role !== 'owner' || result.data[0].active !== true) fail(403, 'owner_required', 'An active owner membership is required.');
      };
      await assertOwner();
      const member = async id => {
        const result = await call(membershipPath + '&user_id=eq.' + id);
        if (!result.ok || !Array.isArray(result.data) || result.data.length > 1) fail(503, 'membership_read_failed', 'The colony member could not be read.');
        const row = result.data[0] || null;
        if (row && (row.user_id !== id || row.colony_id !== config.colonyId)) fail(503, 'membership_read_failed', 'The colony member could not be verified.');
        return row;
      };
      const profile = async id => {
        const result = await call('/auth/v1/admin/users/' + id, {admin: true});
        if (result.status === 404) return null;
        if (!result.ok || result.data?.id !== id) fail(503, 'profile_read_failed', 'Account details could not be loaded.');
        return result.data;
      };
      const publicUser = (row, user) => ({user_id: row.user_id, email: user?.email || null,
        name: typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name.slice(0, 200) : null,
        role: row.role, active: row.active, export_level: row.role === 'owner' ? 'max' : EXPORT_LEVELS.includes(row.export_level) ? row.export_level : 'low',
        permissions: normalizedPermissions(row.permissions),
        status: !user ? 'unavailable' : !row.active ? 'disabled' : !user.email_confirmed_at && user.invited_at ? 'invited' : 'active'});
      const protect = (id, row) => {
        if (id === actor.id || row?.role === 'owner') fail(403, 'owner_protected', 'Owner accounts are read-only in user management.');
      };
      const findAccount = async email => {
        for (let page = 1; ; page++) {
          if (page > 50) fail(503, 'directory_limit', 'The authentication directory exceeds the safe lookup limit. No invitation was sent.');
          const result = await call('/auth/v1/admin/users?page=' + page + '&per_page=200', {admin: true});
          if (!result.ok || !Array.isArray(result.data?.users)) fail(503, 'directory_read_failed', 'Existing accounts could not be checked. No invitation was sent.');
          const found = result.data.users.find(item => emailValue(item.email) === email);
          if (found) return found;
          if (result.data.users.length < 200) return null;
        }
      };
      const save = async (user, action, role, active, emailSent = false) => {
        let result; const exportLevel = body.export_level ?? (action === 'add' ? 'low' : null);
        try { result = await call('/rest/v1/rpc/manage_colony_member', {method: 'POST', payload: {p_colony_id: config.colonyId, p_user_id: user.id, p_role: role, p_active: active, p_action: action, p_export_level: exportLevel, p_permissions: body.permissions ?? null}}); }
        catch (error) {
          if (emailSent) fail(502, 'membership_outcome_unknown', 'The invitation was sent, but access could not be confirmed. Reload the user list before trying again.', {invitation_sent: true});
          throw error;
        }
        if (!result.ok) {
          const code = result.data?.code;
          const status = code === '42501' ? 403 : ['23505', 'P0002'].includes(code) ? 409 : 503;
          fail(status, emailSent ? 'invitation_sent_access_failed' : 'access_update_failed', emailSent ?
            'The invitation was sent, but colony access was not granted. Reload the user list, then retry adding this email if it is absent.' :
            'Access could not be updated. Reload the user list and verify that the account is not an owner.', {invitation_sent: emailSent});
        }
        const row = result.data?.[0];
        if (!Array.isArray(result.data) || result.data.length !== 1 || row?.colony_id !== config.colonyId || row?.user_id !== user.id || row?.role !== role || row?.active !== active || !EXPORT_LEVELS.includes(row?.export_level) || exportLevel !== null && row.export_level !== exportLevel) fail(502, 'membership_outcome_unknown', 'Access could not be confirmed. Reload the user list before trying again.', {invitation_sent: emailSent});
        if (role === 'manager' && (!validPermissions(row.permissions) || PERMISSIONS.some(key => !Object.hasOwn(row.permissions, key))) || body.permissions !== undefined && PERMISSIONS.some(key => row.permissions?.[key] !== normalizedPermissions(body.permissions)[key])) fail(502, 'membership_outcome_unknown', 'Manager permissions could not be confirmed. Reload the user list before trying again.', {invitation_sent: emailSent});
        return publicUser(row, user);
      };

      if (body.action === 'list') {
        const rows = [];
        for (let offset = 0; ; offset += 500) {
          if (offset >= 5000) fail(503, 'member_limit', 'This colony exceeds the account-management list limit.');
          const result = await call(membershipPath + '&order=user_id&limit=500&offset=' + offset);
          if (!result.ok || !Array.isArray(result.data) || result.data.some(row => row.colony_id !== config.colonyId || !UUID.test(row.user_id))) fail(503, 'membership_read_failed', 'Colony users could not be loaded.');
          rows.push(...result.data); if (result.data.length < 500) break;
        }
        const users = [];
        for (let i = 0; i < rows.length; i += 5) users.push(...await Promise.all(rows.slice(i, i + 5).map(async row => publicUser(row, await profile(row.user_id)))));
        return reply({colony_id: config.colonyId, users});
      }
      if (body.action === 'update_access') {
        const row = await member(body.user_id); protect(body.user_id, row);
        if (!row) fail(404, 'member_not_found', 'This account is not a member of the configured colony.');
        const user = await profile(body.user_id);
        if (!user) fail(409, 'account_unavailable', 'This authentication account is unavailable.');
        const saved = await save(user, 'update', body.role, body.active);
        return reply({user: saved, message: body.active ? 'Colony access updated.' : 'Colony access disabled. The authentication account has been retained.'});
      }

      if (body.action === 'invite_preregistered') {
        const preregistration = async () => {
          // The owner JWT and roster RPC are authoritative. The browser supplies no recipient or privileges.
          const result = await call('/rest/v1/rpc/list_lab_members', {method: 'POST', payload: {p_colony_id: config.colonyId}});
          if (!result.ok || !Array.isArray(result.data?.members)) fail(503, 'roster_read_failed', 'Preregistered members could not be verified. Reload Members before sending an invitation.');
          const rows = result.data.members.filter(row => row.person_id === body.person_id && row.colony_id === config.colonyId);
          if (rows.length !== 1) fail(404, 'preregistration_not_found', 'This preregistered member was not found. Reload Members.');
          const person = rows[0];
          if (person.version !== body.version) fail(409, 'preregistration_changed', 'This member record changed. Reload Members and review it before sending.');
          if (person.status !== 'current' || person.archived !== false) fail(409, 'preregistration_inactive', 'Only current, unarchived members can receive a registration invitation.');
          if (person.linked_user_id !== null || person.username !== null) fail(409, 'registration_complete', 'This member has already registered. They can sign in or use Forgot password.');
          const email = emailValue(person.email);
          if (!validEmail(email)) fail(409, 'registration_email_required', 'Add a valid email address to this member before inviting them.');
          if (email === config.ownerEmail || person.effective_role === 'owner') fail(403, 'owner_protected', 'The original owner account is protected.');
          return {...person, email};
        };
        const person = await preregistration();
        let account = await findAccount(person.email);
        if (account) {
          if (!UUID.test(account.id || '')) fail(503, 'account_unavailable', 'The existing account could not be verified.');
          account = await profile(account.id);
          if (!account || emailValue(account.email) !== person.email || account.is_anonymous) fail(409, 'account_changed', 'The account changed while preparing the invitation. Reload Members and retry.');
          const row = await member(account.id); protect(account.id, row);
          if (row) fail(409, 'already_member', 'This account already has colony access settings. Use its existing sign-in or Forgot password; invitation will not change access.');
          if (account.banned_until && Date.parse(account.banned_until) > Date.now()) fail(409, 'account_disabled', 'This authentication account is disabled. An invitation cannot enable it.');
          const lastSent = Math.max(...['invited_at', 'confirmation_sent_at', 'recovery_sent_at'].map(key => Date.parse(account[key]) || 0));
          const seconds = Math.ceil((lastSent + 60000 - Date.now()) / 1000);
          if (seconds > 0) fail(429, 'email_rate_limit', 'An account email was recently requested. Wait before sending another invitation.', {retry_after_seconds: Math.min(seconds, 60)});
        }
        await assertOwner();
        const current = await preregistration();
        if (current.email !== person.email) fail(409, 'preregistration_changed', 'This member record changed. Reload Members and review it before sending.');
        const existingConfirmed = !!account?.email_confirmed_at;
        let invitation;
        try {
          invitation = await call('/auth/v1/' + (existingConfirmed ? 'otp' : 'invite') + '?redirect_to=' + encodeURIComponent(config.appUrl), {
            admin: true, method: 'POST', payload: {email: person.email, ...(existingConfirmed ? {create_user: false} : {})}
          });
        } catch { fail(502, 'invitation_outcome_unknown', 'The email service did not confirm the result. An email may already have been sent. Wait and reload Members before retrying.'); }
        if (!invitation.ok) {
          const code = invitation.data?.code || invitation.data?.error_code;
          if (code === 'email_address_not_authorized') fail(503, 'email_delivery_not_configured', 'Supabase email delivery is restricted to project-team addresses. Configure custom SMTP before inviting lab members.');
          if (invitation.status === 429) fail(429, 'email_rate_limit', 'The email service rate limit was reached. Wait before sending another invitation.');
          if (['email_exists', 'user_already_exists', 'otp_disabled'].includes(code)) fail(409, 'account_changed', 'The account changed while preparing the invitation. Reload Members and retry.');
          if (invitation.status >= 500) fail(502, 'invitation_outcome_unknown', 'The email service returned an error without confirming delivery. An email may already have been sent. Wait and reload Members before retrying.');
          fail(502, 'invitation_failed', 'The registration email could not be sent. Check the server email configuration before retrying.');
        }
        if (!existingConfirmed && (!UUID.test(invitation.data?.id || '') || emailValue(invitation.data?.email) !== person.email || account && invitation.data.id !== account.id)) fail(502, 'invitation_outcome_unknown', 'The invitation returned an unexpected account. An email may have been sent. Reload Members before retrying.');
        try { await preregistration(); }
        catch { fail(409, 'invitation_sent_registration_unconfirmed', 'The email service accepted the invitation, but the member registration could not be reconfirmed. Reload Members. Access still requires a current preregistration and completed account setup.', {invitation_sent: true}); }
        return reply({person_id: person.person_id, email_sent: true, email_kind: existingConfirmed ? 'sign_in_link' : 'invitation',
          message: 'Registration email accepted by the email service. The member can open the link and choose their own ID and password. Their saved access level applies after setup.'});
      }

      let user = await findAccount(body.email);
      if (user) {
        if (!UUID.test(user.id || '')) fail(503, 'account_unavailable', 'The existing account could not be verified.');
        const row = await member(user.id); protect(user.id, row);
        if (row) fail(409, 'already_member', 'This account already belongs to the colony. Change its access in the user list.');
        const saved = await save(user, 'add', body.role, true);
        return reply({user: saved, email_sent: false, message: 'Existing account added to the colony. No new invitation email was sent; the user can sign in through the app.'});
      }
      await assertOwner(); // Recheck immediately before the external email side effect.
      let invitation;
      try { invitation = await call('/auth/v1/invite?redirect_to=' + encodeURIComponent(config.appUrl), {admin: true, method: 'POST', payload: {email: body.email}}); }
      catch { fail(502, 'invitation_outcome_unknown', 'The invitation service did not confirm the result. Check the user list before retrying; an email may already have been sent.'); }
      if (!invitation.ok) {
        const code = invitation.data?.code || invitation.data?.error_code;
        if (code === 'email_address_not_authorized') fail(503, 'email_delivery_not_configured', 'Supabase email delivery is restricted to project-team addresses. Configure custom SMTP before inviting lab members.');
        if (invitation.status === 429) fail(429, 'email_rate_limit', 'The email service rate limit was reached. Wait before sending another invitation.');
        if (['email_exists', 'user_already_exists'].includes(code)) fail(409, 'account_created_concurrently', 'This account already exists. Retry to add the existing account without sending another invitation.');
        if (invitation.status >= 500) fail(502, 'invitation_outcome_unknown', 'The invitation service returned an error without confirming delivery. Check the user list before retrying; an email may already have been sent.');
        fail(502, 'invitation_failed', 'The email invitation could not be sent. Check the server email configuration before retrying.');
      }
      user = invitation.data;
      if (!UUID.test(user?.id || '') || emailValue(user.email) !== body.email) fail(502, 'invitation_outcome_unknown', 'The invitation returned an unexpected account. Check the user list before retrying.');
      protect(user.id, null);
      const saved = await save(user, 'add', body.role, true, true);
      return reply({user: saved, email_sent: true, message: 'Invitation email sent and colony access granted.'});
    } catch (error) {
      if (error instanceof Failure) return reply({code: error.code, message: error.message, ...error.extra}, error.status);
      return reply({code: 'management_failed', message: 'User management could not complete. Reload the user list before trying again.'}, 500);
    }
  };
}
