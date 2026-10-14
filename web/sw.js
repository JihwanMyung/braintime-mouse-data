/* Only the public app shell is cached. No API response or imported data is cached. */
const CACHE = 'colony-shell-v16';
const SHELL = ['./cage-summary.js','./cage-summary.js?v=16','./cage-summary-options.js','./cage-summary-options.js?v=16','./breeding-options.js','./breeding-options.js?v=16','./breeding-summary.js','./breeding-summary.js?v=16','./strain-registry.js','./strain-registry.js?v=16','./strain-management.js','./strain-management.js?v=16','./mouse-summary.js','./mouse-summary.js?v=16','./export-center.js','./export-center.js?v=16','./animal-sheet-export.js','./animal-sheet-export.js?v=16','./workbook-export.js','./workbook-export.js?v=16','./cryo-sources.js','./cryo-sources.js?v=16','./cryopreservation-model.js','./cryopreservation-model.js?v=16','./cryopreservation.js','./cryopreservation.js?v=16','./genetics.js','./genetics.js?v=16','./genotype-schema.js','./genotype-schema.js?v=16','./genotype-catalog.js','./genotype-catalog.js?v=16','./breeding-planner.js','./breeding-planner.js?v=16','./','./index.html','./styles.css','./styles.css?v=16','./app.js','./app.js?v=16','./model.js','./model.js?v=16','./config.js','./data-store.js','./data-store.js?v=16','./archive-format.js','./husbandry.js','./husbandry.js?v=16','./history-index.js','./user-management.js','./manifest.webmanifest','./icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png','./icons/braintime-mark.png','./icons/apple-touch-icon.png','./icons/icon-maskable-512.png'];
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
