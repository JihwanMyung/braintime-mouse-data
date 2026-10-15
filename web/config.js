/* Public deployment defaults only. Never put service-role keys, passwords or tokens here. */
export const PUBLIC_CONFIG = Object.freeze({
  url: 'https://njhetwortngnniyrhcfk.supabase.co',
  anonKey: 'sb_publishable_N4Idpp9aFTcv9JjTMyiPWA_iFWh0RHj',
  // Public anon JWT used only by the protected username-login gateway.
  usernameAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qaGV0d29ydG5nbm5peXJoY2ZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5MTcyNzcsImV4cCI6MjEwNzQ5MzI3N30.UxkxmrZH3wuYZDC-7FVH1BLbiOwgy_tbyTuW-rbQVHQ',
  colonyId: '57a26815-ca94-413b-891a-e0e85ff59d69',
  // Enable only after the independent NAS viewer has been verified.
  backupViewerUrl: 'https://braintimedisk.tail933238.ts.net/'
});

/** Explicit navigation only. Never append app URLs, sessions or credentials. */
export function backupViewerLinkHTML(config = PUBLIC_CONFIG) {
  if (typeof config?.backupViewerUrl !== 'string' || !config.backupViewerUrl.trim()) return '';
  let url;
  try { url = new URL(config.backupViewerUrl); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
  const href = url.href.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  return `<div class="backup-viewer-link"><p><a href="${href}" target="_blank" rel="noopener noreferrer" aria-label="Read-only backup (opens in a new tab)">Read-only backup ↗</a></p><p class="small muted">Tailscale and NAS sign-in required. Owner-only for now.</p></div>`;
}
