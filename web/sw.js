/* Only the public app shell is cached. No API response or imported data is cached. */
const CACHE = 'colony-shell-v9';
const SHELL = ['./','./index.html','./styles.css','./styles.css?v=9','./app.js','./app.js?v=9','./model.js','./model.js?v=9','./config.js','./data-store.js','./data-store.js?v=9','./archive-format.js','./husbandry.js','./husbandry.js?v=9','./history-index.js','./user-management.js','./manifest.webmanifest','./icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png','./icons/braintime-mark.png','./icons/apple-touch-icon.png','./icons/icon-maskable-512.png'];
const allowed = new Set(SHELL.map(path => new URL(path,self.registration.scope).href));
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('colony-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||!allowed.has(event.request.url))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok&&response.type==='basic'){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
    return response;
  }).catch(()=>caches.match(event.request).then(cached=>cached||Response.error())));
});
