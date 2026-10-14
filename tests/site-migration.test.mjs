import test from 'node:test';
import assert from 'node:assert/strict';
import {CURRENT_APP_URL,LAB_TOOLS_URL,isLegacySite,migrationNoticeHTML,movedAccountHTML} from '../web/site-migration.js';

test('only the previous app entry is treated as a migrated site',()=>{
  for(const path of ['/braintime-mouse-data','/braintime-mouse-data/','/braintime-mouse-data/index.html'])assert(isLegacySite(new URL('https://jihwanmyung.github.io'+path)));
  for(const address of [CURRENT_APP_URL,'https://jihwanmyung.github.io/other/','https://jihwanmyung.github.io.evil.example/braintime-mouse-data/','http://jihwanmyung.github.io/braintime-mouse-data/'])assert.equal(isLegacySite(new URL(address)),false);
  assert.equal(isLegacySite({protocol:'file:'}),false);
});

test('migration links never carry recovery credentials, query strings or record routes',()=>{
  const previous=new URL('https://jihwanmyung.github.io/braintime-mouse-data/?next=https://evil.example/#access_token=PRIVATE_ACCESS&refresh_token=PRIVATE_REFRESH&type=recovery');
  assert(isLegacySite(previous));
  for(const html of [migrationNoticeHTML({recovering:true,location:previous}),migrationNoticeHTML({location:previous}),movedAccountHTML(previous)]){
    const links=[...html.matchAll(/href="([^"]+)"/g)].map(match=>match[1]);
    assert.deepEqual(links,[CURRENT_APP_URL]);
    assert(!/PRIVATE_|access_token|refresh_token|evil\.example/.test(html));
  }
  assert.equal(new URL(CURRENT_APP_URL).search,'');assert.equal(new URL(CURRENT_APP_URL).hash,'');
  assert.equal(LAB_TOOLS_URL,'https://braintimelab.github.io/internal/');
});

test('recovery notice keeps the reset at its current origin',()=>{
  assert.match(migrationNoticeHTML({recovering:true}),/Finish this password reset here/);
  assert.match(migrationNoticeHTML(),/existing local workspace is still available here/);
});
