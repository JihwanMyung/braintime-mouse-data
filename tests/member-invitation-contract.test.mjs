import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../supabase/functions/manage-colony-users/handler.mjs';
import * as store from '../web/data-store.js';
import {renderLabMembers,clearLabMembers} from '../web/lab-members.js';

class Storage {
  values=new Map();
  getItem(key){return this.values.get(key)??null;}
  setItem(key,value){this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
}
const origin='https://test.supabase.co',redirect='https://braintimelab.github.io/mouse-data/';
const owner='11111111-1111-4111-8111-111111111111',colony='22222222-2222-4222-8222-222222222222';
const personId='33333333-3333-4333-8333-333333333333',recipient='44444444-4444-4444-8444-444444444444';
const token='a'.repeat(64),url=`${origin}/auth/v1/verify?token=${token}&type=invite&redirect_to=${encodeURIComponent(redirect)}`;
const person={person_id:personId,colony_id:colony,version:4,name:'Synthetic invitee',email:'recipient@example.invalid',status:'current',category:'phd',archived:false,username:null,linked_user_id:null,intended_role:'editor',export_level:'high'};
const account={id:owner,email:'owner@example.invalid',email_confirmed_at:'2026-01-01'};
const membership={colony_id:colony,user_id:owner,role:'owner',active:true,export_level:'max'};

async function fixture({confirmed=false,revokeAfterSend=false}={}){
  globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
  const anon='x.'+btoa(JSON.stringify({role:'anon'}))+'.x';
  const config={SUPABASE_URL:origin,SUPABASE_ANON_KEY:anon,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',USER_MANAGEMENT_COLONY_ID:colony,USER_MANAGEMENT_OWNER_EMAIL:account.email,USER_MANAGEMENT_APP_URL:redirect};
  const accounts=[account,...(confirmed?[{id:recipient,email:person.email,email_confirmed_at:'2026-01-01'}]:[])],calls=[];
  let revoked=false;
  const upstream=async(raw,init={})=>{
    const u=new URL(raw),body=init.body?JSON.parse(init.body):null;calls.push({path:u.pathname,body});
    if(u.pathname==='/auth/v1/user')return Response.json(account);
    if(u.pathname==='/rest/v1/memberships')return Response.json(u.searchParams.get('user_id')==='eq.'+recipient?[]:[membership]);
    if(u.pathname==='/rest/v1/rpc/list_lab_members')return revoked?Response.json({code:'42501'},{status:403}):Response.json({members:[person]});
    if(u.pathname==='/auth/v1/admin/users')return Response.json({users:accounts});
    if(u.pathname.startsWith('/auth/v1/admin/users/'))return Response.json(accounts.find(row=>row.id===u.pathname.split('/').at(-1)));
    if(u.pathname==='/auth/v1/admin/generate_link'){
      assert.deepEqual(body,{type:'invite',email:person.email,redirect_to:redirect});
      const created={id:recipient,email:person.email,email_confirmed_at:null};accounts.push(created);
      return Response.json({...created,action_link:url,hashed_token:token,email_otp:'123456',verification_type:'invite',redirect_to:redirect});
    }
    if(u.pathname==='/auth/v1/invite'){
      revoked=revokeAfterSend;
      return Response.json({id:recipient,email:person.email,email_confirmed_at:null});
    }
    throw Error('Unexpected upstream route '+u.pathname);
  };
  const handler=createHandler({env:{get:key=>config[key]},fetchImpl:upstream});
  globalThis.fetch=async(raw,init={})=>{
    const u=new URL(raw);
    if(u.pathname==='/auth/v1/token')return Response.json({access_token:'synthetic-owner',refresh_token:'synthetic-refresh',expires_in:3600,user:account});
    if(u.pathname==='/rest/v1/memberships')return Response.json([membership]);
    if(u.pathname==='/functions/v1/manage-colony-users')return handler(new Request(raw,{...init,headers:{...init.headers,Origin:'https://braintimelab.github.io'}}));
    throw Error('Unexpected browser route '+u.pathname);
  };
  store.configureCloud({url:origin,anonKey:anon,colonyId:colony});
  await store.signIn(account.email,'synthetic-password');
  const container={innerHTML:''};
  await renderLabMembers(container,{listMembers:async()=>({members:[person]}),inviteMember:store.inviteLabMember,createInvitationLink:store.createLabMemberInvitationLink,invitationLinkOrigin:origin,invitationRedirectUrl:redirect});
  const click=async action=>container.onclick({target:{closest:()=>({dataset:{memberAction:action,memberId:personId}})},preventDefault(){}});
  return {container,calls,click};
}

test('real handler response passes store and UI manual invite contract without email or token persistence',async()=>{
  const f=await fixture();await f.click('create-link');
  assert.match(f.container.innerHTML,/Open account setup/);
  assert(f.container.innerHTML.includes(token));
  assert.match(f.container.innerHTML,/No email was sent/);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/generate_link')).length,1);
  assert(!f.calls.some(call=>/\/(invite|otp)$|manage_colony_member|save_lab_member/.test(call.path)));
  assert(!JSON.stringify([...localStorage.values,...sessionStorage.values]).includes(token));
  await f.click('close-link');assert(!f.container.innerHTML.includes(token));clearLabMembers(f.container);
});

test('confirmed existing account denial propagates through store and UI without creating bearer access',async()=>{
  const f=await fixture({confirmed:true});await f.click('create-link');
  assert.match(f.container.innerHTML,/already has a verified account/);
  assert.doesNotMatch(f.container.innerHTML,/Open account setup/);
  assert(!f.calls.some(call=>/generate_link|\/(invite|otp)$/.test(call.path)));
  clearLabMembers(f.container);
});

test('email accepted before owner revocation retains acceptance but removes private roster and actions across all layers',async()=>{
  const f=await fixture({revokeAfterSend:true});await f.click('invite');await f.click('confirm-invitation');
  assert.match(f.container.innerHTML,/Email request accepted/);
  assert.match(f.container.innerHTML,/Delivery is not confirmed/);
  assert.doesNotMatch(f.container.innerHTML,/Synthetic invitee|recipient@example.invalid|data-member-action="create-link"/);
  assert.equal(f.calls.filter(call=>call.path==='/auth/v1/invite').length,1);
  clearLabMembers(f.container);
});
