import test from 'node:test';
import assert from 'node:assert/strict';
import {PUBLIC_CONFIG, backupViewerLinkHTML} from '../web/config.js';

test('backup remains disabled until an independent HTTPS viewer is configured', () => {
  assert.equal(typeof PUBLIC_CONFIG.backupViewerUrl, 'string');
  for (const backupViewerUrl of ['', '  ', null, '/backup', 'http://backup.example/', 'javascript:alert(1)', 'https://user:password@backup.example/', 'https://backup.example/?access_token=secret', 'https://backup.example/#access_token=secret']) {
    assert.equal(backupViewerLinkHTML({backupViewerUrl}), '', String(backupViewerUrl));
  }
});

test('backup navigation is an isolated normal link without session or app state', () => {
  const config = {backupViewerUrl:'https://backup.example/viewer/', url:'https://app.example/#access_token=private', session:'private', email:'private@example.test'};
  const html = backupViewerLinkHTML(config);
  assert.match(html, /href="https:\/\/backup\.example\/viewer\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Read-only backup/);
  assert.match(html, /Tailscale and NAS sign-in required\. Owner-only for now\./);
  assert.doesNotMatch(html, /private|access_token|onclick|data-action|form|iframe/);
  assert.equal(config.backupViewerUrl, 'https://backup.example/viewer/');
});
