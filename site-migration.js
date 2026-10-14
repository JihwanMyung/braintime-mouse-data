// Migration links are fixed destinations: never copy an auth fragment, query,
// record identifier, session, or local dataset to another origin.
export const CURRENT_APP_URL='https://braintimelab.github.io/mouse-data/';
export const LAB_TOOLS_URL='https://braintimelab.github.io/internal/';

export function isLegacySite(location=globalThis.location){
  return location?.origin==='https://jihwanmyung.github.io'&&
    ['/braintime-mouse-data','/braintime-mouse-data/','/braintime-mouse-data/index.html'].includes(location.pathname);
}

export function migrationNoticeHTML({recovering=false}={}){
  return `<div><strong>Braintime Mouse Data has moved</strong><p>${recovering?'Finish this password reset here, then sign in at the new address.':'Open the new lab address for shared work. This browser’s existing local workspace is still available here. Export any local work before clearing this site’s browser data.'}</p></div><a class="button primary" href="${CURRENT_APP_URL}" rel="noopener noreferrer">Open new Mouse Data</a>`;
}

export function movedAccountHTML(){
  return `<p class="subtle">Sign in, request a password reset, and manage lab accounts at the new lab address.</p><a class="button primary" href="${CURRENT_APP_URL}" rel="noopener noreferrer">Open new Mouse Data</a><p class="small muted">Existing email verification and password reset links can still finish here. Install the app again from the new address to update your home-screen shortcut.</p>`;
}
