/* Only the public app shell is cached. No API response or imported data is cached. */
const CACHE = 'colony-shell-v12';
const SHELL = ['./export-center.js','./export-center.js?v=12','./animal-sheet-export.js','./animal-sheet-export.js?v=12','./workbook-export.js','./workbook-export.js?v=12','./cryo-sources.js','./cryo-sources.js?v=12','./cryopreservation-model.js','./cryopreservation-model.js?v=12','./cryopreservation.js','./cryopreservation.js?v=12','./genetics.js','./genetics.js?v=12','./genotype-schema.js','./genotype-schema.js?v=12','./genotype-catalog.js','./genotype-catalog.js?v=12','./breeding-planner.js','./breeding-planner.js?v=12','./','./index.html','./styles.css','./styles.css?v=12','./app.js','./app.js?v=12','./model.js','./model.js?v=12','./config.js','./data-store.js','./data-store.js?v=12','./archive-format.js','./husbandry.js','./husbandry.js?v=12','./history-index.js','./user-management.js','./manifest.webmanifest','./icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png','./icons/braintime-mark.png','./icons/apple-touch-icon.png','./icons/icon-maskable-512.png'];
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
